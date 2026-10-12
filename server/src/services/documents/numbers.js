// Indonesian money uses dots as thousands separators. Litres on a fuel slip
// often use a dot as the decimal point, so 10.031 L is 10.031 litres.

function validIsoDate(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function decimalString(value) {
  return value.toFixed(3).replace(/\.?0+$/, '');
}

export function parseDate(original) {
  if (original == null || String(original).trim() === '') return { original: null, normalized: null };
  const raw = String(original).trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const normalized = `${iso[1]}-${iso[2]}-${iso[3]}`;
    return validIsoDate(normalized) ? { original: raw, normalized } : { original: raw, normalized: null };
  }
  const local = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (local) {
    const yearNumber = Number(local[3]);
    const year = local[3].length === 4 ? local[3] : String(yearNumber + (yearNumber < 70 ? 2000 : 1900));
    const normalized = `${year}-${local[2].padStart(2, '0')}-${local[1].padStart(2, '0')}`;
    return validIsoDate(normalized) ? { original: raw, normalized } : { original: raw, normalized: null };
  }
  return { original: raw, normalized: null };
}

export function parseMoney(original) {
  const empty = { original: null, normalized: null, currency: 'IDR', fractional: false, rejectedAsPhone: false };
  if (original == null || String(original).trim() === '') return empty;
  const raw = String(original).trim();
  const hasCurrency = /rp|idr|rupiah/i.test(raw);
  if (!hasCurrency && /^\+?\d[\d\s().-]{8,}$/.test(raw)) {
    return { ...empty, original: raw, rejectedAsPhone: true };
  }
  let text = raw
    .replace(/rp\.?|idr|rupiah/gi, '')
    .replace(/\/.*$/i, '')
    .replace(/\bper\b.*$/i, '')
    .replace(/\s/g, '');
  if (!/\d/.test(text)) return { ...empty, original: raw };
  let fractional = false;
  let wholeText = text;
  if (text.includes(',') && text.includes('.')) {
    const lastComma = text.lastIndexOf(',');
    const lastDot = text.lastIndexOf('.');
    const decimalSep = lastComma > lastDot ? ',' : '.';
    const [whole, frac] = [text.slice(0, text.lastIndexOf(decimalSep)), text.slice(text.lastIndexOf(decimalSep) + 1)];
    fractional = /[1-9]/.test(frac);
    wholeText = whole.replace(/[.,]/g, '');
  } else if (text.includes(',')) {
    const parts = text.split(',');
    // 150,000 and 6,800 are thousands. 10,50 is a fractional rupiah amount.
    if (parts.slice(1).every((part) => /^\d{3}$/.test(part))) {
      wholeText = parts.join('');
    } else {
      fractional = /[1-9]/.test(parts[parts.length - 1]);
      wholeText = parts.slice(0, -1).join('');
    }
  } else if (text.includes('.')) {
    const parts = text.split('.');
    if (parts.slice(1).every((part) => /^\d{3}$/.test(part))) {
      wholeText = parts.join('');
    } else {
      fractional = true;
      wholeText = parts[0];
    }
  }
  wholeText = wholeText.replace(/[^\d]/g, '');
  if (!/^\d+$/.test(wholeText)) return { ...empty, original: raw, fractional };
  const normalized = Number(wholeText);
  if (!Number.isSafeInteger(normalized)) return { ...empty, original: raw, fractional };
  return { original: raw, normalized, currency: 'IDR', fractional, rejectedAsPhone: false };
}

export function parseQuantity(original, unitHint) {
  const empty = { original: null, normalized: null, milli: null, unit: unitHint || null };
  if (original == null || String(original).trim() === '') return empty;
  const raw = String(original).trim();
  const unitMatch = raw.match(/\b(litres|liters|litre|liter|ltr|ml|kg|pcs|pc|l)\b\.?$/i);
  let unit = unitHint || (unitMatch ? unitMatch[1] : null);
  if (unit && /^l(itre|iter|tr)?s?$/i.test(unit)) unit = 'L';
  else if (unit) unit = unit.toUpperCase();
  let text = raw.replace(/\b(litres|liters|litre|liter|ltr|ml|kg|pcs|pc|l)\b\.?$/i, '').replace(/\s/g, '');
  if (!/\d/.test(text)) return { ...empty, original: raw, unit };
  let value = null;
  if (text.includes(',') && text.includes('.')) {
    const comma = text.lastIndexOf(',');
    value = Number(`${text.slice(0, comma).replace(/\./g, '')}.${text.slice(comma + 1).replace(/\D/g, '')}`);
  } else if (text.includes(',')) {
    value = Number(text.replace(/\./g, '').replace(',', '.'));
  } else if ((unit === 'L' || unit === 'ML' || unit === 'KG') && /^\d+\.\d+$/.test(text)) {
    value = Number(text);
  } else if (text.includes('.')) {
    const parts = text.split('.');
    value = parts.slice(1).every((part) => /^\d{3}$/.test(part)) ? Number(parts.join('')) : Number(text);
  } else {
    value = Number(text.replace(/[^\d.]/g, ''));
  }
  if (!Number.isFinite(value) || value < 0) return { ...empty, original: raw, unit };
  const milli = unit === 'L' ? Math.round(value * 1000) : unit === 'ML' ? Math.round(value) : null;
  return { original: raw, normalized: decimalString(value), milli, unit };
}

export function expectedLineTotal(quantity, unitPrice) {
  if (unitPrice?.normalized == null || !Number.isInteger(unitPrice.normalized)) return null;
  if (quantity?.milli != null && quantity.unit === 'L') {
    return Math.round((quantity.milli * unitPrice.normalized) / 1000);
  }
  if (quantity?.normalized == null) return null;
  const qty = Number(quantity.normalized);
  if (!Number.isFinite(qty)) return null;
  return Math.round(qty * unitPrice.normalized);
}
