/** Recognise delivery timing notes from free text. */

const RULES = [
  { tag: 'kirim_pagi', re: /\b(kirim\s*pagi+|pagiii+|minta\s*pagi|sebelum\s*jam\s*9|sebelum\s*jam\s*8|jam\s*8\s*[-–]\s*9)/i },
  { tag: 'sebelum_jam', re: /\bsebelum\s*jam\s*\d+/i },
  { tag: 'jangan_malam', re: /\bjangan\s*(di)?kirim\s*malam|jangan\s*malam/i },
  { tag: 'mulai_siang', re: /\bmulai\s*jam\s*2|setelah\s*jam\s*1|pengiriman\s*bisa\s*dilakukan\s*mulai/i },
  { tag: 'antara_jam', re: /\bantara\s*jam\s*\d+/i },
];

export function extractTimeTags(note) {
  const text = String(note || '');
  if (!text.trim()) return [];
  const tags = [];
  for (const rule of RULES) {
    if (rule.re.test(text)) tags.push(rule.tag);
  }
  return tags;
}

export function timePriority(tags) {
  if (!tags || tags.length === 0) return 50;
  if (tags.includes('kirim_pagi') || tags.includes('sebelum_jam')) return 10;
  if (tags.includes('antara_jam')) return 20;
  if (tags.includes('mulai_siang')) return 80;
  if (tags.includes('jangan_malam')) return 30;
  return 50;
}
