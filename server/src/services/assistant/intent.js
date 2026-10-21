import { MAX_ALLOCATIONS } from '../matching/allocate.js';
import { MAX_BANK_FEE } from '../matching/rules.js';
import { MULTI_CUSTOMER_EXCESS } from '../payments/paymentService.js';

export const INTENTS = ['answer', 'list_payments', 'find_invoices', 'link_invoices', 'record_payment'];
const WRITE_INTENTS = new Set(['link_invoices', 'record_payment']);

export function isWriteIntent(intent) {
  return WRITE_INTENTS.has(intent);
}

function monthBounds(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  const iso = (day) => {
    const month = String(day.getMonth() + 1).padStart(2, '0');
    const datePart = String(day.getDate()).padStart(2, '0');
    return `${day.getFullYear()}-${month}-${datePart}`;
  };
  return { from: iso(start), to: iso(end) };
}

/** "this month" / "bulan ini" when the model left the dates blank. */
export function datesFromMessage(text, today = new Date()) {
  const source = String(text || '').toLowerCase();
  if (/this month|bulan ini/.test(source)) return monthBounds(today);
  return { from: '', to: '' };
}

function isoOrEmpty(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

/**
 * Model JSON → one intent. Unknown tools become an answer.
 * Payment ids that are not 24 hex characters are dropped so the model cannot point at a guess.
 */
export function normalizeIntent(raw = {}, message = '', today = new Date()) {
  const intent = INTENTS.includes(raw.intent) ? raw.intent : 'answer';
  let from = isoOrEmpty(raw.from);
  let to = isoOrEmpty(raw.to);
  if (!from && !to) {
    const guessed = datesFromMessage(message, today);
    from = guessed.from;
    to = guessed.to;
  }
  if (from && to && from > to) {
    from = '';
    to = '';
  }
  const paymentId = /^[a-f0-9]{24}$/i.test(String(raw.paymentId || '').trim())
    ? String(raw.paymentId).trim()
    : '';
  return {
    intent,
    customerName: String(raw.customerName || '').trim().slice(0, 200),
    from,
    to,
    paymentId,
    reply: String(raw.reply || '').trim().slice(0, 1500),
  };
}

/**
 * The invoices a confirmed link would use. Built from the books, not from the model's numbers.
 * Extra money can stay as credit for one villa only.
 */
export function planInvoiceLink({ invoices, paymentAmount }) {
  const rows = Array.isArray(invoices) ? invoices : [];
  if (!rows.length) {
    return { ok: false, error: 'No unpaid invoices matched that customer in this date range.' };
  }
  if (rows.length > MAX_ALLOCATIONS) {
    return {
      ok: false,
      error: `This range has ${rows.length} invoices. One transfer can record ${MAX_ALLOCATIONS}. Narrow the dates.`,
    };
  }
  if (rows.some((row) => !Number.isInteger(row.remaining) || row.remaining <= 0)) {
    return { ok: false, error: 'An invoice amount is missing. Ask again after the invoice list reloads.' };
  }
  const total = rows.reduce((sum, row) => sum + row.remaining, 0);
  const customers = new Set(rows.map((row) => String(row.erpCustomerId || row.customerId || row.customerName || '')));
  const excess = Number.isInteger(paymentAmount) ? paymentAmount - total : null;
  if (customers.size > 1 && excess != null && excess > MAX_BANK_FEE) {
    return { ok: false, error: MULTI_CUSTOMER_EXCESS, total };
  }
  return {
    ok: true,
    total,
    excess,
    customerCount: customers.size,
    invoiceIds: rows.map((row) => String(row.id)),
  };
}
