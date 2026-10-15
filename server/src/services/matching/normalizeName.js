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

/** Normalized name with spaces removed: "Sari Boga" and "Sariboga" both become SARIBOGA. */
export function compactName(value) {
  return normalizeName(value).replace(/\s+/g, '');
}

function bigrams(text) {
  const grams = new Map();
  for (let i = 0; i < text.length - 1; i += 1) {
    const gram = text.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) || 0) + 1);
  }
  return grams;
}

/** Dice coefficient on character pairs. Catches typos like SARIBOGA vs SARIBOGAA. */
function diceSimilarity(left, right) {
  if (left.length < 2 || right.length < 2) return 0;
  const a = bigrams(left);
  const b = bigrams(right);
  let overlap = 0;
  for (const [gram, count] of a) {
    overlap += Math.min(count, b.get(gram) || 0);
  }
  return (2 * overlap) / (left.length - 1 + right.length - 1);
}

function tokenJaccard(left, right) {
  const aTokens = new Set(left.split(' ').filter(Boolean));
  const bTokens = new Set(right.split(' ').filter(Boolean));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1;
  }
  const union = new Set([...aTokens, ...bTokens]).size;
  return intersection / union;
}

/**
 * 0..1 similarity. Exact normalized match = 1.
 * WhatsApp and Zoho often differ only in spacing, so the space-free form is compared too.
 */
export function nameSimilarity(a, b) {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftCompact = left.replace(/\s+/g, '');
  const rightCompact = right.replace(/\s+/g, '');
  if (leftCompact === rightCompact) return 0.98;

  let best = tokenJaccard(left, right);
  if (leftCompact.includes(rightCompact) || rightCompact.includes(leftCompact)) {
    const shorter = Math.min(leftCompact.length, rightCompact.length);
    const longer = Math.max(leftCompact.length, rightCompact.length);
    best = Math.max(best, shorter / longer);
  }
  // Typo tolerance only for names long enough that pair overlap means something.
  if (Math.min(leftCompact.length, rightCompact.length) >= 5) {
    best = Math.max(best, diceSimilarity(leftCompact, rightCompact));
  }
  return best;
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
