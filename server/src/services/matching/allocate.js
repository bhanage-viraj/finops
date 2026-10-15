import { MAX_BANK_FEE } from './rules.js';

/** Most invoices one transfer may settle; keeps the subset search small. */
export const MAX_ALLOCATIONS = 40;
const MAX_SUBSET_STATES = 20000;

function dayOf(invoice) {
  return String(invoice.date || invoice.dueDate || '9999-12-31');
}

/** Oldest invoice first, the order the office settles by hand. */
export function sortOldestFirst(invoices) {
  return [...(invoices || [])].sort((a, b) => {
    const byDay = dayOf(a).localeCompare(dayOf(b));
    if (byDay) return byDay;
    return String(a.invoiceNo || a.invoiceNumber || '').localeCompare(String(b.invoiceNo || b.invoiceNumber || ''));
  });
}

function sumRemaining(invoices) {
  return invoices.reduce((total, inv) => total + Number(inv.remaining), 0);
}

/** Gap between transfer and invoices that counts as an exact fit (0, or a bank fee). */
function feeGap(amount, total, allowFee) {
  const gap = amount - total;
  if (gap === 0) return 0;
  if (allowFee && gap > 0 && gap <= MAX_BANK_FEE) return gap;
  return null;
}

/**
 * Spread a received amount over invoices, oldest first.
 * The last touched invoice may be partly paid; money left after all of them is excess (Zoho credit).
 */
export function allocateOldestFirst(amount, invoices) {
  let left = Number.isInteger(amount) && amount > 0 ? amount : 0;
  const allocations = [];
  for (const invoice of sortOldestFirst(invoices).slice(0, MAX_ALLOCATIONS)) {
    if (left <= 0) break;
    const remaining = Number(invoice.remaining);
    if (!Number.isInteger(remaining) || remaining <= 0) continue;
    const applied = Math.min(left, remaining);
    allocations.push({ ...invoice, applied });
    left -= applied;
  }
  const applied = allocations.reduce((total, row) => total + row.applied, 0);
  return { allocations, applied, excess: left };
}

/**
 * Invoices whose balances add up to the transfer (allowing a bank fee).
 * Prefers the oldest run of invoices; otherwise any combination, older ones first.
 * Returns { invoices, bankFee, prefix } or null.
 */
export function findExactSet(amount, invoices, { allowFee = true } = {}) {
  if (!Number.isInteger(amount) || amount <= 0) return null;
  const sorted = sortOldestFirst(invoices)
    .filter((inv) => Number.isInteger(Number(inv.remaining)) && Number(inv.remaining) > 0)
    .slice(0, MAX_ALLOCATIONS);

  let running = 0;
  let feeMatch = null;
  for (let i = 0; i < sorted.length; i += 1) {
    running += Number(sorted[i].remaining);
    const gap = feeGap(amount, running, allowFee);
    if (gap === 0) return { invoices: sorted.slice(0, i + 1), bankFee: 0, prefix: true };
    if (gap != null && !feeMatch) feeMatch = { invoices: sorted.slice(0, i + 1), bankFee: gap, prefix: true };
    if (running > amount) break;
  }
  if (feeMatch) return feeMatch;

  // Reachable sums → first (oldest-leaning) index list that makes them.
  const reach = new Map([[0, []]]);
  for (let i = 0; i < sorted.length; i += 1) {
    const value = Number(sorted[i].remaining);
    for (const [sum, picks] of [...reach]) {
      const next = sum + value;
      if (next > amount || reach.has(next)) continue;
      reach.set(next, [...picks, i]);
      if (reach.size >= MAX_SUBSET_STATES) break;
    }
    if (reach.has(amount) || reach.size >= MAX_SUBSET_STATES) break;
  }
  let best = null;
  for (const [sum, picks] of reach) {
    if (picks.length === 0) continue;
    const gap = feeGap(amount, sum, allowFee);
    if (gap == null) continue;
    if (!best || gap < best.gap) best = { gap, picks };
  }
  if (!best) return null;
  return {
    invoices: best.picks.map((i) => sorted[i]),
    bankFee: best.gap,
    prefix: false,
  };
}

export { sumRemaining };
