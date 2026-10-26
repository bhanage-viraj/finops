export function formatRupiah(value) {
  if (value == null || value === '') return '—';
  const amount = Number(value);
  if (!Number.isInteger(amount)) return String(value);
  return `Rp ${amount.toLocaleString('id-ID')}`;
}

/** Digits for an amount field: 6700000 → "6.700.000". */
export function formatAmountInput(value) {
  if (!Number.isInteger(value)) return '';
  return value.toLocaleString('id-ID');
}

/**
 * Same rules as the server payment parser.
 * "Rp 6.700.000", "6700000" and "6,700,000.00" all become 6700000.
 */
export function parseRupiahInput(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  let text = String(raw).trim()
    .replace(/rp\.?|idr|rupiah/gi, '')
    .replace(/\s/g, '');
  const last = Math.max(text.lastIndexOf(','), text.lastIndexOf('.'));
  if (last >= 0 && /^\d{1,2}$/.test(text.slice(last + 1))) {
    text = text.slice(0, last);
  }
  text = text.replace(/[^\d]/g, '');
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}
