const INVOICE_NO = /\bINV[-\s]?(\d{3,})\b/i;
const DAY_MONTH = /(?:^|\s)(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?(?=\s|$)/;

/**
 * WhatsApp caption like "Toko Sariboga 29.9" → name, date text, invoice number.
 * Day comes before month (Indonesian order).
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
  const date = rest.match(DAY_MONTH);
  if (date) {
    dateText = date[0].trim();
    rest = rest.replace(date[0], ' ');
  }
  const name = rest.replace(/[\s,;:·-]+$/g, '').replace(/^[\s,;:·-]+/g, '').replace(/\s+/g, ' ').trim();
  return { name, dateText, invoiceNo };
}

/**
 * "29.9" → "2026-09-29" using the transfer date for the year.
 * A caption date more than a week after the transfer belongs to the previous year.
 */
export function resolveCaptionDate(dateText, reference = new Date()) {
  const match = String(dateText || '').trim().match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;

  const ref = reference instanceof Date && !Number.isNaN(reference.getTime()) ? reference : new Date();
  let year;
  if (match[3]) {
    year = Number(match[3]);
    if (year < 100) year += 2000;
  } else {
    year = ref.getUTCFullYear();
    const guess = Date.UTC(year, month - 1, day);
    if (guess - ref.getTime() > 7 * 86_400_000) year -= 1;
  }
  const value = new Date(Date.UTC(year, month - 1, day));
  // Reject roll-overs like 31.2.
  if (value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) return null;
  return value.toISOString().slice(0, 10);
}
