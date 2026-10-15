import { monthIndex } from '../ai/schemas.js';

const INVOICE_NO = /\bINV[-\s]?(\d{3,})\b/i;
const SEP = String.raw`\s*(?:-|–|—|to|s\.?\s?d\.?|sampai|until)\s*`;
const MON = String.raw`([A-Za-z]{3,9})\.?`;
const DM = String.raw`(\d{1,2})[./](\d{1,2})`;
const D = String.raw`(\d{1,2})`;
const YEAR = String.raw`(?:[./](\d{2,4}))?`;

/**
 * Date shapes seen in WhatsApp captions and transfer remarks, most specific first.
 * Each returns { d1, m1, d2, m2, y } with months 1..12; m is null when given as a word.
 */
const SHAPES = [
  // Sep 28 - Oct 2
  { re: new RegExp(`${MON}\\s+${D}${SEP}${MON}\\s+${D}`, 'i'), pick: (m) => words(m[2], m[1], m[4], m[3]) },
  // 28 Sep - 2 Oct
  { re: new RegExp(`${D}\\s+${MON}${SEP}${D}\\s+${MON}`, 'i'), pick: (m) => words(m[1], m[2], m[3], m[4]) },
  // Sept 28-30
  { re: new RegExp(`${MON}\\s+${D}${SEP}${D}(?![./\\d])`, 'i'), pick: (m) => words(m[2], m[1], m[3], m[1]) },
  // 28-30 Sept
  { re: new RegExp(`${D}${SEP}${D}\\s+${MON}`, 'i'), pick: (m) => words(m[1], m[3], m[2], m[3]) },
  // 28.9-30.9 or 28/09/2026 - 30/09/2026
  { re: new RegExp(`${DM}${YEAR}${SEP}${DM}${YEAR}`), pick: (m) => nums(m[1], m[2], m[4], m[5], m[6] || m[3]) },
  // 28-30.9 or 28-30/09
  { re: new RegExp(`(?<![./\\d])${D}${SEP}${DM}${YEAR}`), pick: (m) => nums(m[1], m[3], m[2], m[3], m[4]) },
  // 29.9 or 29/09/2026
  { re: new RegExp(`(?<![./\\d])${DM}${YEAR}(?![./\\d])`), pick: (m) => nums(m[1], m[2], m[1], m[2], m[3]) },
  // Sept 28
  { re: new RegExp(`${MON}\\s+${D}(?![./\\d])`, 'i'), pick: (m) => words(m[2], m[1], m[2], m[1]) },
  // 28 Sept
  { re: new RegExp(`${D}\\s+${MON}`, 'i'), pick: (m) => words(m[1], m[2], m[1], m[2]) },
];

function nums(d1, m1, d2, m2, y) {
  return { d1: Number(d1), m1: Number(m1), d2: Number(d2), m2: Number(m2), y: y ? Number(y) : null };
}

function words(d1, mon1, d2, mon2) {
  const m1 = monthIndex(mon1);
  const m2 = monthIndex(mon2);
  if (m1 == null || m2 == null) return null;
  return { d1: Number(d1), m1: m1 + 1, d2: Number(d2), m2: m2 + 1, y: null };
}

/** First date or date range in free text → { text, parts } or null. */
export function findDateSpan(text) {
  const source = String(text || '');
  for (const shape of SHAPES) {
    const global = new RegExp(shape.re.source, `${shape.re.flags}g`);
    for (const match of source.matchAll(global)) {
      // "Blok 5" looks like "Sept 28" until the month word is checked.
      const parts = shape.pick(match);
      if (parts) return { text: match[0].trim(), parts };
    }
  }
  return null;
}

/**
 * WhatsApp caption like "Toko Sariboga 29.9" → name, date text, invoice number.
 * Day comes before month (Indonesian order) for numeric dates.
 */
export function splitCaption(text) {
  let rest = String(text || '').trim().slice(0, 200);
  let invoiceNo = null;
  let dateText = null;

  const inv = rest.match(INVOICE_NO);
  if (inv) {
    invoiceNo = `INV-${inv[1]}`;
    rest = rest.replace(inv[0], ' ');
  }
  const span = findDateSpan(rest);
  if (span) {
    dateText = span.text;
    rest = rest.replace(span.text, ' ');
  }
  const name = rest.replace(/[\s,;:·-]+$/g, '').replace(/^[\s,;:·-]+/g, '').replace(/\s+/g, ' ').trim();
  return { name, dateText, invoiceNo };
}

function isoDay(year, month, day) {
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  const value = new Date(Date.UTC(year, month - 1, day));
  // Reject roll-overs like 31.2.
  if (value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) return null;
  return value.toISOString().slice(0, 10);
}

function fullYear(y) {
  return y < 100 ? y + 2000 : y;
}

/** Year for a day/month near the transfer: a date more than a week after it belongs to last year. */
function yearNear(month, day, ref) {
  const year = ref.getUTCFullYear();
  return Date.UTC(year, month - 1, day) - ref.getTime() > 7 * 86_400_000 ? year - 1 : year;
}

/**
 * "Sept 28-30" or "29.9" → { from, to } ISO days around the transfer date, or null.
 */
export function resolveDateRange(text, reference = new Date()) {
  const span = findDateSpan(text);
  if (!span) return null;
  const { d1, m1, d2, m2, y } = span.parts;
  const ref = reference instanceof Date && !Number.isNaN(reference.getTime()) ? reference : new Date();
  const toYear = y ? fullYear(y) : yearNear(m2, d2, ref);
  // Dec 28 - Jan 2 crosses the year.
  const fromYear = m1 > m2 || (m1 === m2 && d1 > d2) ? toYear - 1 : toYear;
  const from = isoDay(fromYear, m1, d1);
  const to = isoDay(toYear, m2, d2);
  if (!from || !to || from > to) return null;
  return { from, to };
}

/** Single caption date: "29.9" → "2026-09-29". Kept for one-day hints. */
export function resolveCaptionDate(dateText, reference = new Date()) {
  const range = resolveDateRange(dateText, reference);
  return range && range.from === range.to ? range.from : null;
}
