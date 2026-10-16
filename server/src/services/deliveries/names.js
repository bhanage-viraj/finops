/** Normalize a customer or area name for matching. */

export function nameKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function plateKey(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .trim();
}

export function formatPlate(value) {
  const raw = String(value || '').toUpperCase().replace(/\s+/g, ' ').trim();
  return raw;
}
