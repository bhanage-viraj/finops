import { CLASSIFIER_TYPES, DOCUMENT_TYPES } from '../documents/fieldCatalog.js';

export const PROMPT_VERSION = '2026-10-10.1';

const STRING_OR_NULL = { type: 'string', nullable: true };

export const classificationSchema = {
  type: 'object',
  properties: {
    documentType: { type: 'string', enum: CLASSIFIER_TYPES },
    confidence: { type: 'number' },
    evidence: { type: 'string' },
    needsReview: { type: 'boolean' },
  },
  required: ['documentType', 'confidence', 'evidence', 'needsReview'],
};

const fieldKeys = [
  'date', 'time', 'supplier', 'location', 'documentNumber', 'fuelType',
  'quantity', 'quantityUnit', 'unitPrice', 'total', 'currency', 'paymentMethod',
  'vehicle', 'workerName', 'workerRole', 'phone', 'workDate', 'startTime',
  'endTime', 'workLocation', 'description', 'agreedAmount', 'approvalNote',
  'subtotal', 'tax', 'discount', 'paymentTerms', 'dueDate', 'notes',
];

const extractionFieldProperties = Object.fromEntries(fieldKeys.map((key) => [key, STRING_OR_NULL]));

export const extractionSchema = {
  type: 'object',
  properties: {
    fields: { type: 'object', properties: extractionFieldProperties },
    lineItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: STRING_OR_NULL,
          quantity: STRING_OR_NULL,
          unit: STRING_OR_NULL,
          unitPrice: STRING_OR_NULL,
          lineTotal: STRING_OR_NULL,
        },
      },
    },
    fieldConfidence: { type: 'object' },
    fieldBoxes: { type: 'object' },
  },
  required: ['fields'],
};

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function box(value) {
  if (!value || typeof value !== 'object') return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const width = Number(value.width);
  const height = Number(value.height);
  if (![x, y, width, height].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) return null;
  return { x, y, width, height };
}

export function assertClassification(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('The model did not return a classification object.');
  }
  const documentType = CLASSIFIER_TYPES.includes(value.documentType) ? value.documentType : 'unknown';
  const confidence = clampScore(value.confidence);
  if (confidence == null) throw new Error('The model did not return a classification score.');
  return {
    documentType,
    confidence,
    evidence: typeof value.evidence === 'string' ? value.evidence.slice(0, 400) : '',
    needsReview: value.needsReview === true || documentType === 'unknown' || confidence < 70,
  };
}

export function assertExtraction(value) {
  if (!value || typeof value !== 'object' || !value.fields || typeof value.fields !== 'object') {
    throw new Error('The model did not return extraction fields.');
  }
  const fields = {};
  for (const key of fieldKeys) {
    const raw = value.fields[key];
    fields[key] = raw == null || raw === '' ? null : String(raw).slice(0, 500);
  }
  const lineItems = Array.isArray(value.lineItems) ? value.lineItems.slice(0, 40).map((item) => ({
    description: item?.description == null ? null : String(item.description).slice(0, 300),
    quantity: item?.quantity == null ? null : String(item.quantity).slice(0, 40),
    unit: item?.unit == null ? null : String(item.unit).slice(0, 20),
    unitPrice: item?.unitPrice == null ? null : String(item.unitPrice).slice(0, 40),
    lineTotal: item?.lineTotal == null ? null : String(item.lineTotal).slice(0, 40),
  })) : [];
  const fieldConfidence = {};
  if (value.fieldConfidence && typeof value.fieldConfidence === 'object') {
    for (const [key, score] of Object.entries(value.fieldConfidence)) {
      const clamped = clampScore(score);
      if (clamped != null && fieldKeys.includes(key)) fieldConfidence[key] = clamped;
    }
  }
  const fieldBoxes = {};
  if (value.fieldBoxes && typeof value.fieldBoxes === 'object') {
    for (const [key, valueBox] of Object.entries(value.fieldBoxes)) {
      const parsed = box(valueBox);
      if (parsed && fieldKeys.includes(key)) fieldBoxes[key] = parsed;
    }
  }
  return { fields, lineItems, fieldConfidence, fieldBoxes };
}

export function knownDocumentType(type) {
  return DOCUMENT_TYPES.includes(type);
}

export const paymentExtractionSchema = {
  type: 'object',
  properties: {
    sender: STRING_OR_NULL,
    recipient: STRING_OR_NULL,
    amount: STRING_OR_NULL,
    paidAt: STRING_OR_NULL,
    reference: STRING_OR_NULL,
    transferMethod: STRING_OR_NULL,
    confidence: { type: 'number', nullable: true },
  },
  required: ['sender', 'amount', 'paidAt', 'reference', 'confidence'],
};

function parsePaymentDate(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const text = String(raw).trim();
  const months = {
    january: 0, februari: 1, february: 1, march: 2, maret: 2, april: 3,
    mei: 4, may: 4, juni: 5, june: 5, juli: 6, july: 6, agustus: 7, august: 7,
    september: 8, oktober: 9, october: 9, november: 10, desember: 11, december: 11,
  };
  // Prefer an explicit day-month-year parse so local timezone does not shift the day.
  const m = text.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})(?:,?\s*(\d{1,2}):(\d{2}))?/);
  if (m) {
    const month = months[m[2].toLowerCase()];
    if (month == null) return null;
    const hour = m[4] != null ? Number(m[4]) : 0;
    const minute = m[5] != null ? Number(m[5]) : 0;
    return new Date(Date.UTC(Number(m[3]), month, Number(m[1]), hour, minute, 0));
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const iso = Date.parse(text);
    if (Number.isFinite(iso)) return new Date(iso);
  }
  return null;
}

function parsePaymentAmount(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  let text = String(raw).trim()
    .replace(/rp\.?|idr|rupiah/gi, '')
    .replace(/\s/g, '');
  if (text.includes(',') && text.includes('.')) {
    // Rp28.000,00 → drop decimal part after comma
    text = text.split(',')[0].replace(/\./g, '');
  } else if (text.includes(',')) {
    const parts = text.split(',');
    text = parts.slice(1).every((p) => /^\d{3}$/.test(p))
      ? parts.join('')
      : parts[0].replace(/\./g, '');
  } else if (text.includes('.')) {
    const parts = text.split('.');
    text = parts.slice(1).every((p) => /^\d{3}$/.test(p))
      ? parts.join('')
      : parts[0];
  }
  text = text.replace(/[^\d]/g, '');
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

export function assertPaymentExtraction(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('The model did not return a payment object.');
  }
  const amount = parsePaymentAmount(value.amount);
  const paidAt = parsePaymentDate(value.paidAt);
  const confidence = clampScore(value.confidence);
  return {
    sender: value.sender == null || value.sender === '' ? null : String(value.sender).slice(0, 200),
    recipient: value.recipient == null || value.recipient === '' ? null : String(value.recipient).slice(0, 200),
    amount,
    paidAt,
    reference: value.reference == null || value.reference === '' ? null : String(value.reference).slice(0, 120),
    transferMethod: value.transferMethod == null || value.transferMethod === ''
      ? null
      : String(value.transferMethod).slice(0, 80),
    confidence,
  };
}

export { parsePaymentAmount, parsePaymentDate };
