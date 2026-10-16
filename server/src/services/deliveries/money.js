/** Parse sheet money into integer rupiah. Never invents 0 from a blank cell. */

export function parseRupiah(value) {
  if (value == null || value === '') return { amount: null, missing: true };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { amount: null, missing: true };
    return { amount: Math.round(value), missing: false };
  }
  const text = String(value).trim();
  if (!text) return { amount: null, missing: true };
  const cleaned = text
    .replace(/rp\.?/gi, '')
    .replace(/\s/g, '')
    .replace(/\./g, '')
    .replace(/,/g, '');
  if (!cleaned || cleaned === '-') return { amount: null, missing: true };
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { amount: null, missing: true };
  return { amount: Math.round(n), missing: false };
}

export function parseQty(value) {
  if (value == null || value === '') return { qty: null, missing: true };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { qty: null, missing: true };
    return { qty: value, missing: false };
  }
  const text = String(value).trim().replace(/,/g, '');
  if (!text) return { qty: null, missing: true };
  const n = Number(text);
  if (!Number.isFinite(n)) return { qty: null, missing: true };
  return { qty: n, missing: false };
}
