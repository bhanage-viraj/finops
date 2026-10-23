/** Parse sheet money into integer rupiah. Never invents 0 from a blank cell. */

export function parseRupiah(value) {
  if (value == null || value === '') return { amount: null, missing: true };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { amount: null, missing: true };
    return { amount: Math.round(value), missing: false };
  }
  let text = String(value).trim();
  if (!text || text === '-') return { amount: null, missing: true };
  // Sheets exports "Rp50,000.00": comma groups thousands, the dot is sen.
  text = text.replace(/rp\.?|idr|rupiah/gi, '').replace(/\s/g, '');
  if (!text || text === '-') return { amount: null, missing: true };
  const amount = integerFromSeparators(text);
  if (amount == null) return { amount: null, missing: true };
  return { amount, missing: false };
}

/**
 * "Rp22,000.00" used to be stored as 2200000. A real unit price on these
 * lists is under Rp 100.000, so a stored value of Rp 500.000 or more is that
 * mis-read. New imports are already correct and stay under the cutoff.
 */
export function repairSheetUnitPrice(amount) {
  if (!Number.isInteger(amount) || amount < 500_000 || amount % 100 !== 0) return amount;
  const repaired = amount / 100;
  if (repaired < 1_000 || repaired > 100_000) return amount;
  return repaired;
}

function integerFromSeparators(text) {
  let whole = text;
  let frac = '';
  if (text.includes(',') && text.includes('.')) {
    const decimalSep = text.lastIndexOf(',') > text.lastIndexOf('.') ? ',' : '.';
    const at = text.lastIndexOf(decimalSep);
    whole = text.slice(0, at);
    frac = text.slice(at + 1);
  } else if (text.includes(',')) {
    const parts = text.split(',');
    if (parts.slice(1).every((part) => /^\d{3}$/.test(part))) {
      whole = parts.join('');
    } else {
      whole = parts.slice(0, -1).join('');
      frac = parts[parts.length - 1];
    }
  } else if (text.includes('.')) {
    const parts = text.split('.');
    if (parts.slice(1).every((part) => /^\d{3}$/.test(part))) {
      whole = parts.join('');
    } else {
      whole = parts[0];
      frac = parts.slice(1).join('');
    }
  }
  whole = whole.replace(/[.,]/g, '').replace(/[^\d]/g, '');
  if (!/^\d+$/.test(whole)) return null;
  if (frac && !/^\d+$/.test(frac)) return null;
  if (frac && /[1-9]/.test(frac)) {
    const n = Number(`${whole}.${frac}`);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  return Number(whole);
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
