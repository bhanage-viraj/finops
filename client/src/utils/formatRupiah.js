export function formatRupiah(value) {
  if (value == null || value === '') return '—';
  const amount = Number(value);
  if (!Number.isInteger(amount)) return String(value);
  return `Rp ${amount.toLocaleString('id-ID')}`;
}
