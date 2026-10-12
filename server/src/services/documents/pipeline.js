import Document from '../../models/Document.js';
import { writeAudit } from '../audit/auditLogger.js';
import { classifyDocument, extractDocument } from '../ai/documentAi.js';
import { createFileStorage } from '../storage/fileStorage.js';
import { preprocessImage } from './preprocess.js';
import { normalizeExtraction, searchFields } from './normalize.js';
import { pdfPageCount } from './uploads.js';
import { duplicateWarning, validateDocument } from './validateDocument.js';

async function lookupDuplicate(doc, confirmed) {
  const sha = await Document.find({ _id: { $ne: doc._id }, sha256: doc.sha256 }).select('_id').limit(1);
  const search = searchFields(confirmed);
  let field = [];
  if (search.searchParty && search.searchDate && Number.isInteger(search.searchTotal)) {
    field = await Document.find({
      _id: { $ne: doc._id },
      searchParty: search.searchParty,
      searchDate: search.searchDate,
      searchTotal: search.searchTotal,
      status: { $ne: 'rejected' },
    }).select('_id').limit(1);
  }
  return duplicateWarning({
    shaMatches: sha.map((item) => item._id),
    fieldMatches: field.map((item) => item._id),
  });
}

export async function processDocument(id, env, deps = {}) {
  const classify = deps.classifyDocument || classifyDocument;
  const extract = deps.extractDocument || extractDocument;
  const storage = deps.storage || createFileStorage(env.upload.dir);
  const preprocess = deps.preprocessImage || preprocessImage;

  const claimed = await Document.findOneAndUpdate(
    { _id: id, status: { $in: ['uploaded', 'failed'] } },
    { $set: { status: 'processing', processingStartedAt: new Date(), failureMessage: '' } },
    { returnDocument: 'after' },
  );
  if (!claimed) return Document.findById(id);

  const attempt = { startedAt: new Date(), stages: [], promptVersion: null };
  try {
    const original = await storage.read(claimed.originalFileKey);
    let reading = { bytes: original, mimeType: claimed.mimeType };
    if (claimed.mimeType.startsWith('image/')) {
      try {
        const processed = await preprocess(original);
        claimed.preprocessedFileKey = await storage.save(processed.bytes, '.jpg');
        claimed.preprocessNote = processed.note;
        reading = { bytes: processed.bytes, mimeType: processed.mimeType };
        attempt.stages.push({ name: 'preprocess', ok: true });
      } catch (error) {
        attempt.stages.push({ name: 'preprocess', ok: false, error: 'The reading copy could not be prepared. The original was sent instead.' });
        console.error('Preprocess failed', error.message);
      }
    } else {
      claimed.pageCount = pdfPageCount(original);
      attempt.stages.push({ name: 'preprocess', ok: true });
    }

    const classified = await classify(env, reading);
    attempt.promptVersion = classified.promptVersion;
    attempt.stages.push({
      name: 'classify', ok: true, model: classified.model, latencyMs: classified.latencyMs,
      usage: classified.usage, approxCostUsd: classified.approxCostUsd,
    });
    const extracted = await extract(env, reading, classified.classification.documentType);
    attempt.stages.push({
      name: 'extract', ok: true, model: extracted.model, latencyMs: extracted.latencyMs,
      usage: extracted.usage, approxCostUsd: extracted.approxCostUsd,
    });

    const confirmed = normalizeExtraction(classified.classification.documentType, extracted.extraction);
    const duplicate = await lookupDuplicate(claimed, confirmed);
    const validation = validateDocument(confirmed, { duplicate });
    claimed.ai = {
      classification: classified.classification,
      extraction: extracted.extraction,
      model: extracted.model,
      promptVersion: extracted.promptVersion,
      readAt: new Date(),
    };
    claimed.confirmed = confirmed;
    claimed.documentType = classified.classification.documentType;
    claimed.confirmedType = '';
    claimed.validation = validation;
    claimed.duplicateOf = duplicate?.duplicateOf || null;
    Object.assign(claimed, searchFields(confirmed));
    claimed.status = 'needs_review';
    claimed.failureMessage = '';
    attempt.ok = true;
    attempt.finishedAt = new Date();
    claimed.processingAttempts.push(attempt);
    claimed.markModified('ai');
    claimed.markModified('confirmed');
    claimed.markModified('validation');
    claimed.markModified('processingAttempts');
    await claimed.save();
    await writeAudit({
      userId: claimed.uploadedBy,
      action: 'read',
      entity: 'documents',
      entityId: claimed._id,
      after: {
        documentType: claimed.documentType,
        confidence: classified.classification.confidence,
        promptVersion: extracted.promptVersion,
      },
    });
    return claimed;
  } catch (error) {
    console.error('Document read failed', error.message);
    attempt.ok = false;
    attempt.error = error.message;
    attempt.finishedAt = new Date();
    attempt.stages.push({ name: 'failed', ok: false, error: error.message });
    claimed.status = 'failed';
    claimed.failureMessage = 'The document could not be read. The file is still saved. You can retry.';
    claimed.processingAttempts.push(attempt);
    claimed.markModified('processingAttempts');
    await claimed.save();
    await writeAudit({
      userId: claimed.uploadedBy,
      action: 'read_failed',
      entity: 'documents',
      entityId: claimed._id,
      after: { message: claimed.failureMessage },
    });
    return claimed;
  }
}

export async function recoverStuckDocuments(timeoutMs) {
  const cutoff = new Date(Date.now() - timeoutMs);
  await Document.updateMany(
    { status: 'processing', processingStartedAt: { $lt: cutoff } },
    {
      $set: {
        status: 'failed',
        failureMessage: 'Processing was interrupted. The file is still saved. You can retry.',
      },
    },
  );
}
