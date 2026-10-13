const TITLES = /\b(PT\.?|P\.?T\.?|UD\.?|CV\.?|TBK\.?|TOKO|DEPOT|UD|CV|PAK|BU|IBU|BAPAK|SDR\.?|SDRI\.?)\b/gi;

/** Uppercase, strip titles and punctuation for fuzzy customer matching. */
export function normalizeName(value) {
  if (value == null) return '';
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(TITLES, ' ')
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function nameTokens(value) {
  return normalizeName(value).split(' ').filter(Boolean);
}

/**
 * 0..1 similarity. Exact normalized match = 1.
 * Token overlap Jaccard for partial names.
 */
export function nameSimilarity(a, b) {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) {
    const shorter = Math.min(left.length, right.length);
    const longer = Math.max(left.length, right.length);
    return shorter / longer;
  }
  const aTokens = new Set(nameTokens(left));
  const bTokens = new Set(nameTokens(right));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1;
  }
  const union = new Set([...aTokens, ...bTokens]).size;
  return intersection / union;
}

export function bestCustomerNameScore(sender, customer) {
  if (!customer) return 0;
  const names = [customer.name, ...(customer.aliases || [])];
  let best = 0;
  for (const name of names) {
    best = Math.max(best, nameSimilarity(sender, name));
  }
  return best;
}
