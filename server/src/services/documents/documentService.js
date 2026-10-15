import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import AuditLog from '../../models/AuditLog.js';
import Document from '../../models/Document.js';
import User from '../../models/User.js';
import { writeAudit } from '../audit/auditLogger.js';
import { createFileStorage, extensionFor } from '../storage/fileStorage.js';
import Setting from '../../models/Setting.js';
import { describeZohoPlan } from './zohoAccounts.js';
import { DOCUMENT_TYPES, TYPE_LABELS, fieldsFor } from './fieldCatalog.js';
import { normalizeEdits, searchFields } from './normalize.js';
import { processDocument } from './pipeline.js';
import { displayFileName, inspectUpload, pdfPageCount, prepareStoredBytes } from './uploads.js';
import { validateDocument } from './validateDocument.js';
import { httpError } from '../../utils/http.js';

function isReviewer(user) {
  return user.role === 'accountant' || user.role === 'admin';
}

function canRead(user, doc) {
  return isReviewer(user) || String(doc.uploadedBy) === String(user.id);
}

async function loadDocument(id, user) {
  const doc = await Document.findById(id);
  if (!doc) throw httpError(404, 'Document not found.');
  if (!canRead(user, doc)) throw httpError(403, 'You cannot open this document.');
  return doc;
}

function currentValidation(doc) {
  const duplicate = doc.duplicateOf
    ? { message: 'Another saved document looks like this one. This is a warning, not a rejection.' }
    : null;
  return validateDocument(doc.confirmed || { documentType: doc.documentType, fields: {}, lineItems: [] }, { duplicate });
}

export function toDto(doc, history = []) {
  const aiFields = {};
  const extraction = doc.ai?.extraction;
  const confirmed = doc.confirmed || { fields: {}, lineItems: [] };
  const type = doc.documentType || 'unknown';
  if (extraction?.fields) {
    const normalizedAi = doc.ai?.normalizedFields;
    Object.assign(aiFields, normalizedAi || {});
  }
  const form = fieldsFor(type).map((field) => {
    const current = confirmed.fields?.[field.key];
    const aiOriginal = extraction?.fields?.[field.key] ?? null;
    const value = current?.original ?? '';
    return {
      key: field.key,
      label: field.label,
      kind: field.kind,
      value: value || '',
      normalized: current?.normalized ?? null,
      aiValue: aiOriginal,
      changed: Boolean(aiOriginal) && aiOriginal !== (value || null),
      confidence: extraction?.fieldConfidence?.[field.key] ?? null,
      box: extraction?.fieldBoxes?.[field.key] ?? null,
    };
  });
  return {
    id: doc._id,
    originalName: displayFileName(doc.originalName),
    mimeType: doc.mimeType,
    size: doc.size,
    pageCount: doc.pageCount,
    status: doc.status,
    documentType: type,
    typeLabel: TYPE_LABELS[type] || type,
    classification: doc.ai?.classification || null,
    model: doc.ai?.model || null,
    promptVersion: doc.ai?.promptVersion || null,
    readAt: doc.ai?.readAt || null,
    form,
    lineItems: (confirmed.lineItems || []).map((item, index) => ({
      description: item.description?.original || '',
      quantity: item.quantity?.original || '',
      unit: item.quantity?.unit || '',
      unitPrice: item.unitPrice?.original || '',
      lineTotal: item.lineTotal?.original || '',
      aiDescription: extraction?.lineItems?.[index]?.description || null,
    })),
    validation: doc.validation,
    duplicateOf: doc.duplicateOf,
    failureMessage: doc.failureMessage,
    rejectReason: doc.rejectReason,
    preprocessNote: doc.preprocessNote,
    attempts: (doc.processingAttempts || []).map((attempt) => ({
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      ok: attempt.ok,
      error: attempt.error || '',
      stages: attempt.stages || [],
    })),
    zohoExpense: {
      expenseId: doc.zohoExpense?.expenseId || '',
      sentAt: doc.zohoExpense?.sentAt || null,
      receiptAttached: doc.zohoExpense?.receiptAttached === true,
      receiptNote: doc.zohoExpense?.receiptNote || '',
      lastError: doc.zohoExpense?.lastError || '',
      accountId: doc.zohoExpense?.accountId || '',
      paidThroughAccountId: doc.zohoExpense?.paidThroughAccountId || '',
    },
    searchParty: doc.searchParty,
    searchDate: doc.searchDate,
    searchTotal: doc.searchTotal,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    history,
  };
}

async function historyFor(id) {
  const rows = await AuditLog.find({ entity: 'documents', entityId: id }).sort({ at: -1 }).limit(40).lean();
  const users = await User.find({ _id: { $in: rows.map((row) => row.userId).filter(Boolean) } }).select('name email').lean();
  const byId = new Map(users.map((user) => [String(user._id), user]));
  return rows.map((row) => ({
    action: row.action,
    at: row.at,
    after: row.after,
    user: row.userId ? byId.get(String(row.userId)) || null : null,
  }));
}

export async function createDocuments({ user, files, idempotencyKey, env }) {
  const storage = createFileStorage(env.upload.dir);
  const created = [];
  const rejected = [];
  for (const file of files || []) {
    const name = displayFileName(file.originalname);
    let bytes = file.buffer;
    try {
      bytes = await prepareStoredBytes(bytes);
    } catch {
      rejected.push({ name, error: 'This photo could not be prepared. Save it as a JPEG and try again.' });
      continue;
    }
    const check = inspectUpload({
      filename: name,
      bytes,
      maxBytes: env.upload.maxBytes,
    });
    if (!check.ok) {
      rejected.push({ name, error: check.error });
      continue;
    }
    if (idempotencyKey && files.length === 1) {
      const existing = await Document.findOne({ uploadedBy: user.id, idempotencyKey });
      if (existing) {
        created.push(existing);
        continue;
      }
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const key = await storage.save(bytes, extensionFor(check.mime));
    const doc = await Document.create({
      uploadedBy: user.id,
      originalFileKey: key,
      originalName: name,
      mimeType: check.mime,
      size: bytes.length,
      sha256,
      pageCount: check.mime === 'application/pdf' ? pdfPageCount(file.buffer) : 1,
      status: 'uploaded',
      documentType: 'unknown',
      ...(idempotencyKey && files.length === 1 ? { idempotencyKey } : {}),
    });
    await writeAudit({
      userId: user.id,
      action: 'create',
      entity: 'documents',
      entityId: doc._id,
      after: { name: doc.originalName, mimeType: doc.mimeType },
    });
    created.push(doc);
    queueDocumentRead(doc._id, env);
  }
  return { created, rejected };
}

export async function listDocuments(user, query) {
  const filter = {};
  if (!isReviewer(user)) filter.uploadedBy = user.id;
  if (query.status) filter.status = query.status;
  if (query.type) filter.documentType = query.type;
  if (query.needsReview === '1') filter.status = { $in: ['needs_review', 'submitted'] };
  if (query.from || query.to) {
    filter.searchDate = {};
    if (query.from) filter.searchDate.$gte = query.from;
    if (query.to) filter.searchDate.$lte = query.to;
  }
  if (query.q) {
    const safe = String(query.q).slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.searchParty = new RegExp(safe, 'i');
  }
  // Date filter: oldest expense date first. Otherwise newest upload first.
  const sort = (query.from || query.to)
    ? { searchDate: 1, createdAt: 1 }
    : { createdAt: -1 };
  const docs = await Document.find(filter).sort(sort).limit(100);
  return docs.map((doc) => toDto(doc));
}

export async function documentStats(user) {
  const match = isReviewer(user) ? {} : { uploadedBy: new mongoose.Types.ObjectId(user.id) };
  const rows = await Document.aggregate([
    { $match: match },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const counts = Object.fromEntries(rows.map((row) => [row._id, row.count]));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return {
    total,
    awaiting: counts.uploaded || 0,
    processing: counts.processing || 0,
    review: (counts.needs_review || 0) + (counts.submitted || 0),
    approved: counts.approved || 0,
    failed: counts.failed || 0,
    rejected: counts.rejected || 0,
  };
}

async function withZohoPlan(dto, doc) {
  if (!['needs_review', 'submitted', 'approved'].includes(dto.status)) return dto;
  const settings = await Setting.findOne().select('zohoAccountRules').lean();
  return { ...dto, zohoPlan: describeZohoPlan(doc, settings?.zohoAccountRules || []) };
}

export async function getDocument(id, user) {
  const doc = await loadDocument(id, user);
  return withZohoPlan(toDto(doc, await historyFor(doc._id)), doc);
}

export function fileKeyFor(doc, which) {
  if (which === 'preprocessed' && doc.preprocessedFileKey) {
    return { key: doc.preprocessedFileKey, mimeType: 'image/jpeg' };
  }
  return { key: doc.originalFileKey, mimeType: doc.mimeType };
}

export async function updateDocument(id, user, body) {
  const doc = await loadDocument(id, user);
  if (['approved', 'rejected', 'processing'].includes(doc.status)) {
    throw httpError(400, 'This document can no longer be edited.');
  }
  const type = DOCUMENT_TYPES.includes(body.documentType) ? body.documentType : (doc.documentType || 'unknown');
  const beforeType = doc.documentType;
  const confirmed = normalizeEdits(type, body);
  doc.confirmed = confirmed;
  doc.documentType = type;
  doc.confirmedType = type;
  doc.validation = currentValidation(doc);
  Object.assign(doc, searchFields(confirmed));
  doc.markModified('confirmed');
  doc.markModified('validation');
  await doc.save();
  await writeAudit({
    userId: user.id,
    action: beforeType !== type ? 'reclassify' : 'edit',
    entity: 'documents',
    entityId: doc._id,
    before: { documentType: beforeType },
    after: { documentType: type },
  });
  return withZohoPlan(toDto(doc, await historyFor(doc._id)), doc);
}

export async function submitDocument(id, user) {
  const doc = await loadDocument(id, user);
  if (doc.status === 'submitted') return withZohoPlan(toDto(doc, await historyFor(doc._id)), doc);
  if (doc.status !== 'needs_review') throw httpError(400, 'Only a reviewed draft can be submitted.');
  doc.validation = currentValidation(doc);
  if (!doc.validation.canApprove) {
    throw httpError(400, doc.validation.critical.map((item) => item.message).join(' '));
  }
  doc.status = 'submitted';
  doc.submittedBy = user.id;
  doc.submittedAt = new Date();
  doc.markModified('validation');
  await doc.save();
  await writeAudit({
    userId: user.id, action: 'submit', entity: 'documents', entityId: doc._id, after: { status: 'submitted' },
  });
  return withZohoPlan(toDto(doc, await historyFor(doc._id)), doc);
}

export async function approveDocument(id, user) {
  if (!isReviewer(user)) throw httpError(403, 'Only an accountant or admin can approve.');
  const doc = await loadDocument(id, user);
  if (doc.status === 'approved') return withZohoPlan(toDto(doc, await historyFor(doc._id)), doc);
  if (!['needs_review', 'submitted'].includes(doc.status)) {
    throw httpError(400, 'This document is not ready to approve.');
  }
  doc.validation = currentValidation(doc);
  if (!doc.validation.canApprove) {
    const detail = doc.validation.critical.map((item) => item.message).filter(Boolean).join(' ');
    const error = httpError(400, detail || 'Approval is blocked until the required fields and critical checks are resolved.');
    error.issues = doc.validation.critical;
    throw error;
  }
  doc.status = 'approved';
  doc.approvedBy = user.id;
  doc.approvedAt = new Date();
  doc.markModified('validation');
  await doc.save();
  await writeAudit({
    userId: user.id, action: 'approve', entity: 'documents', entityId: doc._id, after: { status: 'approved' },
  });
  return withZohoPlan(toDto(doc, await historyFor(doc._id)), doc);
}

export async function rejectDocument(id, user, reason) {
  if (!isReviewer(user)) throw httpError(403, 'Only an accountant or admin can reject.');
  const text = String(reason || '').trim();
  if (!text) throw httpError(400, 'A rejection reason is required.');
  const doc = await loadDocument(id, user);
  if (doc.status === 'approved') throw httpError(400, 'An approved document cannot be rejected here.');
  doc.status = 'rejected';
  doc.rejectReason = text.slice(0, 500);
  doc.rejectedBy = user.id;
  doc.rejectedAt = new Date();
  await doc.save();
  await writeAudit({
    userId: user.id, action: 'reject', entity: 'documents', entityId: doc._id, after: { reason: doc.rejectReason },
  });
  return toDto(doc, await historyFor(doc._id));
}

let readQueue = Promise.resolve();

function queueDocumentRead(id, env) {
  readQueue = readQueue
    .then(() => processDocument(id, env))
    .catch((error) => {
      console.error('Document processing failed', error.message);
    });
}

export async function retryDocument(id, user, env) {
  const doc = await loadDocument(id, user);
  if (doc.status === 'processing') {
    throw httpError(400, 'This receipt is still being read. Wait a moment and refresh.');
  }
  if (!['failed', 'uploaded'].includes(doc.status)) {
    throw httpError(400, 'Only a failed or waiting document can be read again.');
  }
  const updated = await processDocument(doc._id, env);
  return toDto(updated, await historyFor(updated._id));
}

function assertCanRemoveOrReplace(doc) {
  if (doc.status === 'processing') {
    throw httpError(400, 'This receipt is still being read. Wait a moment, then try again.');
  }
  if (doc.zohoExpense?.expenseId) {
    throw httpError(400, 'This receipt was already sent to Zoho. Delete or reverse it there first.');
  }
}

async function removeStoredKeys(env, keys) {
  const storage = createFileStorage(env.upload.dir);
  for (const key of keys.filter(Boolean)) {
    await storage.remove(key).catch((error) => {
      console.error('Could not remove stored file', key, error.message);
    });
  }
}

export async function deleteDocument(id, user, env) {
  const doc = await loadDocument(id, user);
  assertCanRemoveOrReplace(doc);
  const keys = [doc.originalFileKey, doc.preprocessedFileKey];
  await writeAudit({
    userId: user.id,
    action: 'delete',
    entity: 'documents',
    entityId: doc._id,
    before: { status: doc.status, originalName: doc.originalName },
  });
  await Document.deleteOne({ _id: doc._id });
  await removeStoredKeys(env, keys);
  return { id: String(id), deleted: true };
}

export async function replaceDocumentPhoto(id, user, file, env) {
  const doc = await loadDocument(id, user);
  assertCanRemoveOrReplace(doc);
  if (!file?.buffer) throw httpError(400, 'Choose a photo or PDF to replace this receipt.');

  const name = displayFileName(file.originalname);
  let bytes = file.buffer;
  try {
    bytes = await prepareStoredBytes(bytes);
  } catch {
    throw httpError(400, 'This photo could not be prepared. Save it as a JPEG and try again.');
  }
  const check = inspectUpload({
    filename: name,
    bytes,
    maxBytes: env.upload.maxBytes,
  });
  if (!check.ok) throw httpError(400, check.error);

  const storage = createFileStorage(env.upload.dir);
  const oldKeys = [doc.originalFileKey, doc.preprocessedFileKey];
  const key = await storage.save(bytes, extensionFor(check.mime));

  doc.originalFileKey = key;
  doc.preprocessedFileKey = '';
  doc.preprocessNote = '';
  doc.originalName = name;
  doc.mimeType = check.mime;
  doc.size = bytes.length;
  doc.sha256 = createHash('sha256').update(bytes).digest('hex');
  doc.pageCount = check.mime === 'application/pdf' ? pdfPageCount(file.buffer) : 1;
  doc.status = 'uploaded';
  doc.documentType = 'unknown';
  doc.confirmedType = '';
  doc.ai = null;
  doc.confirmed = null;
  doc.validation = null;
  doc.duplicateOf = null;
  doc.failureMessage = '';
  doc.rejectReason = '';
  doc.processingStartedAt = null;
  doc.processingAttempts = [];
  doc.approvedBy = null;
  doc.approvedAt = null;
  doc.submittedBy = null;
  doc.submittedAt = null;
  doc.rejectedBy = null;
  doc.rejectedAt = null;
  doc.accountingPreview = null;
  doc.searchParty = '';
  doc.searchDate = null;
  doc.searchTotal = null;
  // Keep any previous Zoho account picks; expense id is already blocked above.
  doc.markModified('ai');
  doc.markModified('confirmed');
  doc.markModified('validation');
  doc.markModified('processingAttempts');
  await doc.save();

  await removeStoredKeys(env, oldKeys);
  await writeAudit({
    userId: user.id,
    action: 'replace',
    entity: 'documents',
    entityId: doc._id,
    after: { name: doc.originalName, mimeType: doc.mimeType, status: 'uploaded' },
  });
  queueDocumentRead(doc._id, env);
  return toDto(doc, await historyFor(doc._id));
}

export { loadDocument, processDocument };
