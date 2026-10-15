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
    adminFee: STRING_OR_NULL,
    total: STRING_OR_NULL,
    note: STRING_OR_NULL,
    paidAt: STRING_OR_NULL,
    reference: STRING_OR_NULL,
    transferMethod: STRING_OR_NULL,
    confidence: { type: 'number', nullable: true },
  },
  required: ['sender', 'amount', 'paidAt', 'reference', 'confidence'],
};

const MONTHS = {
  jan: 0, january: 0, januari: 0,
  feb: 1, february: 1, februari: 1,
  mar: 2, march: 2, maret: 2,
  apr: 3, april: 3,
  may: 4, mei: 4,
  jun: 5, june: 5, juni: 5,
  jul: 6, july: 6, juli: 6,
  aug: 7, agu: 7, agt: 7, august: 7, agustus: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, okt: 9, october: 9, oktober: 9,
  nov: 10, november: 10, nop: 10, nopember: 10,
  dec: 11, des: 11, december: 11, desember: 11,
};

/** English or Indonesian month name / abbreviation → 0..11, else null. */
export function monthIndex(name) {
  const key = String(name || '').toLowerCase().replace(/\.$/, '');
  return Object.prototype.hasOwnProperty.call(MONTHS, key) ? MONTHS[key] : null;
}

function parsePaymentDate(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const text = String(raw).trim();
  // Prefer an explicit day-month-year parse so local timezone does not shift the day.
  const m = text.match(/^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})(?:,?\s*(\d{1,2})[:.](\d{2}))?/);
  if (m) {
    const month = monthIndex(m[2]);
    if (month == null) return null;
    const hour = m[4] != null ? Number(m[4]) : 0;
    const minute = m[5] != null ? Number(m[5]) : 0;
    return new Date(Date.UTC(Number(m[3]), month, Number(m[1]), hour, minute, 0));
  }
  // Mandiri style: "Oct 01, 2026 22:04:43 (GMT +7)".
  const us = text.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})(?:,?\s*(\d{1,2})[:.](\d{2}))?/);
  if (us) {
    const month = monthIndex(us[1]);
    if (month == null) return null;
    const hour = us[4] != null ? Number(us[4]) : 0;
    const minute = us[5] != null ? Number(us[5]) : 0;
    return new Date(Date.UTC(Number(us[3]), month, Number(us[2]), hour, minute, 0));
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
  // Rp28.000,00 (Indonesian) and IDR 9,438,800.00 (English bank apps) both occur.
  // The last separator followed by 1–2 digits is the decimal point; the rest are thousands.
  const last = Math.max(text.lastIndexOf(','), text.lastIndexOf('.'));
  if (last >= 0 && /^\d{1,2}$/.test(text.slice(last + 1))) {
    text = text.slice(0, last);
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
  const nominal = parsePaymentAmount(value.amount);
  const adminFeeRaw = parsePaymentAmount(value.adminFee);
  const total = parsePaymentAmount(value.total);
  const adminFee = adminFeeRaw != null && adminFeeRaw > 0 ? adminFeeRaw : null;
  // The business receives the Nominal. If only the total was read, take the admin fee off it.
  let amount = nominal;
  if (amount == null && total != null) {
    amount = adminFee != null && total > adminFee ? total - adminFee : total;
  } else if (amount != null && adminFee != null && total != null && amount === total && total > adminFee) {
    amount = total - adminFee;
  }
  const paidAt = parsePaymentDate(value.paidAt);
  const confidence = clampScore(value.confidence);
  return {
    sender: value.sender == null || value.sender === '' ? null : String(value.sender).slice(0, 200),
    recipient: value.recipient == null || value.recipient === '' ? null : String(value.recipient).slice(0, 200),
    amount,
    adminFee,
    total,
    note: value.note == null || value.note === '' ? null : String(value.note).slice(0, 200),
    paidAt,
    reference: value.reference == null || value.reference === '' ? null : String(value.reference).slice(0, 120),
    transferMethod: value.transferMethod == null || value.transferMethod === ''
      ? null
      : String(value.transferMethod).slice(0, 80),
    confidence,
  };
}

export { parsePaymentAmount, parsePaymentDate };
