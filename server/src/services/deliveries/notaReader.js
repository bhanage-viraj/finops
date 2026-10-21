import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import DeliveryStop from '../../models/DeliveryStop.js';
import { completeVision } from '../ai/visionClient.js';
import { createFileStorage, extensionFor } from '../storage/fileStorage.js';
import { writeAudit } from '../audit/auditLogger.js';
import { httpError } from '../../utils/http.js';
import { assertNotaExtraction, compareNota, notaExtractionSchema } from './notaCompare.js';
import { refreshDaySummaryAfterNota } from './notaSideEffects.js';

const promptDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../prompts');
const notaPrompt = fs.readFileSync(path.join(promptDir, 'nota.prompt.txt'), 'utf8');

export async function attachNotaToStop({
  stopId,
  user,
  env,
  file,
  confirm = false,
  confirmedOverrides = null,
}) {
  const stop = await DeliveryStop.findById(stopId);
  if (!stop) throw httpError(404, 'Stop not found.');
  if (!file?.buffer && !file?.bytes) throw httpError(400, 'Upload a receipt photo.');

  const bytes = file.buffer || file.bytes;
  const mimeType = file.mimetype || file.mimeType || 'image/jpeg';
  const storage = createFileStorage(env.upload.dir);
  const key = await storage.save(bytes, extensionFor(mimeType));

  let ai;
  try {
    const result = await completeVision({
      provider: env.ai.provider,
      apiKey: env.ai.apiKey,
      model: env.ai.model,
      timeoutMs: env.ai.timeoutMs,
      rates: env.ai,
      prompt: notaPrompt,
      mimeType,
      bytes,
      schema: notaExtractionSchema,
    });
    ai = {
      ...assertNotaExtraction(result.json),
      model: result.model,
      readAt: new Date(),
      raw: result.json,
    };
  } catch (error) {
    // Keep the photo even if AI fails so a person can enter values.
    stop.delivered = {
      ...(stop.delivered?.toObject?.() || stop.delivered || {}),
      notaFileKey: key,
    };
    stop.ai = {
      failed: true,
      error: error.message,
      readAt: new Date(),
    };
    await stop.save();
    throw httpError(422, error.message || 'The receipt could not be read.');
  }

  // Duplicate nota number check
  if (ai.notaNo) {
    const dup = await DeliveryStop.findOne({
      _id: { $ne: stop._id },
      'delivered.notaNo': ai.notaNo,
    }).lean();
    if (dup) {
      ai.duplicateOfStopId = String(dup._id);
    }
  }

  const flags = compareNota(stop.toObject(), ai);
  if (ai.duplicateOfStopId) flags.push('duplicate_nota');

  // AI is never overwritten once set (first successful read wins if already present).
  if (!stop.ai || stop.ai.failed) {
    stop.ai = ai;
  }

  stop.delivered = {
    ...(stop.delivered?.toObject?.() || stop.delivered || {}),
    notaFileKey: key,
    notaNo: ai.notaNo || stop.delivered?.notaNo || '',
    emptiesReturned: ai.emptiesReturned,
    paymentNote: ai.paymentNote || '',
    total: ai.total,
    items: (ai.items || []).map((item) => ({
      productName: item.productName,
      qty: item.qty,
      unitPrice: item.unitPrice,
      packType: '',
      packQty: null,
      qtyMissing: item.qty == null,
    })),
  };
  stop.mismatchFlags = flags;

  if (confirm) {
    stop.confirmed = confirmedOverrides || {
      notaNo: ai.notaNo,
      items: ai.items,
      returns: ai.returns,
      emptiesReturned: ai.emptiesReturned,
      total: ai.total,
      paymentNote: ai.paymentNote,
      confirmedAt: new Date(),
      confirmedBy: user._id,
    };
    stop.status = 'nota_checked';
    stop.statusHistory.push({
      status: 'nota_checked',
      source: 'nota',
      userId: user._id,
      at: new Date(),
    });
  }

  await stop.save();
  await refreshDaySummaryAfterNota(stop.dayId);
  await writeAudit({
    userId: user._id,
    action: confirm ? 'nota_confirm' : 'nota_read',
    entity: 'deliveryStops',
    entityId: stop._id,
    after: { notaNo: ai.notaNo, flags, confirm },
  });

  return stop.toObject();
}

export async function confirmNota(stopId, user, body = {}) {
  const stop = await DeliveryStop.findById(stopId);
  if (!stop) throw httpError(404, 'Stop not found.');
  if (!stop.ai || stop.ai.failed) {
    throw httpError(400, 'Read a receipt photo first.');
  }
  const confirmed = {
    notaNo: body.notaNo ?? stop.ai.notaNo,
    items: body.items ?? stop.ai.items,
    returns: body.returns ?? stop.ai.returns,
    emptiesReturned: body.emptiesReturned ?? stop.ai.emptiesReturned,
    total: body.total ?? stop.ai.total,
    paymentNote: body.paymentNote ?? stop.ai.paymentNote,
    confirmedAt: new Date(),
    confirmedBy: user._id,
  };
  const flags = compareNota(stop.toObject(), confirmed);
  stop.confirmed = confirmed;
  stop.mismatchFlags = flags;
  stop.delivered = {
    ...(stop.delivered?.toObject?.() || stop.delivered || {}),
    notaNo: confirmed.notaNo || '',
    emptiesReturned: confirmed.emptiesReturned,
    paymentNote: confirmed.paymentNote || '',
    total: confirmed.total,
    items: (confirmed.items || []).map((item) => ({
      productName: item.productName,
      qty: item.qty,
      unitPrice: item.unitPrice,
      packType: '',
      packQty: null,
      qtyMissing: item.qty == null,
    })),
  };
  if (stop.status !== 'nota_checked') {
    stop.status = 'nota_checked';
    stop.statusHistory.push({
      status: 'nota_checked',
      source: 'nota',
      userId: user._id,
      at: new Date(),
    });
  }
  await stop.save();
  await refreshDaySummaryAfterNota(stop.dayId);
  await writeAudit({
    userId: user._id,
    action: 'nota_confirm',
    entity: 'deliveryStops',
    entityId: stop._id,
    after: { confirmed, flags },
  });
  return stop.toObject();
}

export function emptiesBalance(stops) {
  let plannedGallons = 0;
  let empties = 0;
  for (const stop of stops || []) {
    for (const item of stop.plannedItems || []) {
      if (/gallon|galon/i.test(item.productName) && item.qty != null) {
        plannedGallons += Number(item.qty);
      }
    }
    if (stop.delivered?.emptiesReturned != null) empties += Number(stop.delivered.emptiesReturned);
    for (const r of stop.confirmed?.returns || stop.ai?.returns || []) {
      if (r.qty != null) empties += Number(r.qty);
    }
  }
  return {
    plannedGallons,
    emptiesReturned: empties,
    difference: plannedGallons - empties,
  };
}
