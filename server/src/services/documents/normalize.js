import { fieldsFor } from './fieldCatalog.js';
import { parseDate, parseMoney, parseQuantity } from './numbers.js';

const DATE_KEYS = new Set(['date', 'workDate', 'dueDate']);
const MONEY_KEYS = new Set(['unitPrice', 'total', 'subtotal', 'tax', 'discount', 'agreedAmount', 'lineTotal']);
const QUANTITY_KEYS = new Set(['quantity']);

function blankField(kind) {
  if (kind === 'money') return { original: null, normalized: null, currency: 'IDR' };
  if (kind === 'quantity') return { original: null, normalized: null, milli: null, unit: null };
  if (kind === 'date') return { original: null, normalized: null };
  return { original: null, normalized: null };
}

function normalizeValue(key, raw, unitHint) {
  if (DATE_KEYS.has(key)) return parseDate(raw);
  if (MONEY_KEYS.has(key)) {
    const money = parseMoney(raw);
    return {
      original: money.original,
      normalized: money.normalized,
      currency: 'IDR',
      fractional: money.fractional,
      rejectedAsPhone: money.rejectedAsPhone,
    };
  }
  if (QUANTITY_KEYS.has(key)) return parseQuantity(raw, unitHint);
  if (raw == null || String(raw).trim() === '') return { original: null, normalized: null };
  const text = String(raw).trim();
  return { original: text, normalized: text };
}

export function emptyConfirmed(type) {
  const fields = {};
  for (const field of fieldsFor(type)) fields[field.key] = blankField(field.kind);
  return { documentType: type, fields, lineItems: [] };
}

export function normalizeExtraction(type, extraction) {
  const source = extraction?.fields || {};
  const unitHint = source.quantityUnit || (type === 'fuel_receipt' ? 'L' : null);
  const fields = {};
  for (const field of fieldsFor(type)) {
    fields[field.key] = normalizeValue(field.key, source[field.key], field.key === 'quantity' ? unitHint : null);
  }
  if (source.notes && !fields.notes) fields.notes = normalizeValue('notes', source.notes);
  const lineItems = Array.isArray(extraction?.lineItems) ? extraction.lineItems.map((item) => ({
    description: normalizeValue('description', item?.description),
    quantity: parseQuantity(item?.quantity, item?.unit),
    unitPrice: parseMoney(item?.unitPrice),
    lineTotal: parseMoney(item?.lineTotal),
  })) : [];
  return { documentType: type, fields, lineItems };
}

export function normalizeEdits(type, body) {
  const source = body?.fields || {};
  const unitHint = source.quantityUnit || (type === 'fuel_receipt' ? 'L' : null);
  const fields = {};
  for (const field of fieldsFor(type)) {
    fields[field.key] = normalizeValue(field.key, source[field.key], field.key === 'quantity' ? unitHint : null);
  }
  const lineItems = Array.isArray(body?.lineItems) ? body.lineItems.map((item) => ({
    description: normalizeValue('description', item?.description),
    quantity: parseQuantity(item?.quantity, item?.unit),
    unitPrice: parseMoney(item?.unitPrice),
    lineTotal: parseMoney(item?.lineTotal),
  })) : [];
  return { documentType: type, fields, lineItems };
}

export function searchFields(confirmed) {
  const fields = confirmed?.fields || {};
  const party = fields.supplier?.normalized || fields.workerName?.normalized || '';
  const date = fields.date?.normalized || fields.workDate?.normalized || null;
  const total = fields.total?.normalized ?? fields.agreedAmount?.normalized ?? null;
  return {
    searchParty: party,
    searchDate: date,
    searchTotal: Number.isInteger(total) ? total : null,
  };
}
