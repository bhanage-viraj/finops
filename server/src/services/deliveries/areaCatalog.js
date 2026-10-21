import { nameKey } from './names.js';

/** Known Bali delivery areas and how sheet tab names map onto them. */

export const AREA_DEFS = [
  {
    name: 'Canggu',
    number: 2,
    aliases: ['canggu', 'krat canggu'],
    keywords: ['canggu', 'batu bolong', 'berawa', 'padang linjong', 'padang lingjong'],
    centre: { lat: -8.6478, lng: 115.1385 },
  },
  {
    name: 'Tibubeneng',
    number: 3,
    aliases: ['tibubeneng'],
    keywords: ['tibubeneng', 'nelayan', 'padonan'],
    centre: { lat: -8.655, lng: 115.145 },
  },
  {
    name: 'Cemagi',
    number: 4,
    aliases: ['cemagi'],
    keywords: ['cemagi', 'seseh'],
    centre: { lat: -8.635, lng: 115.095 },
  },
  {
    name: 'Munggu',
    number: 5,
    aliases: ['munggu'],
    keywords: ['munggu', 'tanah lot'],
    centre: { lat: -8.655, lng: 115.1 },
  },
  {
    name: 'Pererenan',
    number: 6,
    aliases: ['pererenan'],
    keywords: ['pererenan', 'tumbak bayuh'],
    centre: { lat: -8.64, lng: 115.12 },
  },
  {
    name: 'Pecatu',
    number: 7,
    aliases: ['pecatu', 'pecatu 1', 'pecatu 2', 'pecatu-2'],
    keywords: ['pecatu', 'uluwatu', 'bingin', 'labuansait', 'cemongkak'],
    centre: { lat: -8.83, lng: 115.12 },
  },
  {
    name: 'Ungasan',
    number: 8,
    aliases: ['ungasan'],
    keywords: ['ungasan', 'jimbaran', 'nusa dua', 'kutuh'],
    centre: { lat: -8.8, lng: 115.16 },
  },
  {
    name: 'Kerobokan',
    number: 9,
    aliases: ['kerobokan'],
    keywords: ['kerobokan', 'kayu aya', 'seminyak', 'oberoi'],
    centre: { lat: -8.68, lng: 115.16 },
  },
  {
    name: 'Seminyak',
    number: 1,
    aliases: ['seminyak', 'jessen'],
    keywords: ['seminyak', 'legian', 'double six'],
    centre: { lat: -8.69, lng: 115.168 },
  },
  {
    name: 'Ubud',
    number: 10,
    aliases: ['ubud', 'motor ubud', 'ubud motor'],
    keywords: ['ubud', 'singakerta', 'sayan', 'peliatan', 'tegallalang', 'mas,'],
    centre: { lat: -8.5069, lng: 115.2625 },
  },
  {
    name: 'Denpasar',
    number: 11,
    aliases: ['denpasar', 'dps', 'dps 2'],
    keywords: ['denpasar', 'renon', 'sanur', 'panjer', 'dalung', 'wr supratman'],
    centre: { lat: -8.67, lng: 115.21 },
  },
  {
    name: 'Kanvasan DPS',
    number: 12,
    aliases: ['kanvasan dps', 'kanvasan'],
    keywords: ['kanvasan'],
    centre: { lat: -8.67, lng: 115.22 },
  },
  {
    name: 'Sari Asih',
    number: 13,
    aliases: ['sari asih', 'sariasih'],
    keywords: ['sari asih', 'bung tomo', 'pemecutan'],
    centre: { lat: -8.64, lng: 115.2 },
  },
  {
    name: 'Nirvana',
    number: 14,
    aliases: ['nirvana', 'nirvana ice'],
    keywords: ['nirvana'],
    centre: { lat: -8.65, lng: 115.14 },
  },
];

const CUSTOM_ROUTE_RE = /^(pak\s+\w+|titip\s+pak\s+\w+|rohman|adi\s+area|tari\s+area|putu\s+area|amed|pelem|reload|krat|ice|jessen)$/i;

export function isCustomRouteName(raw) {
  const key = nameKey(raw);
  if (!key) return false;
  if (CUSTOM_ROUTE_RE.test(key)) return true;
  // Person-like: two short tokens where first is a name prefix
  if (/^(pak|ibu|bu|mas|adek)\b/.test(key)) return true;
  return false;
}

export function normalizeAreaName(raw) {
  const key = nameKey(raw);
  if (!key) return null;
  for (const def of AREA_DEFS) {
    if (nameKey(def.name) === key) return def.name;
    if (def.aliases.some((a) => nameKey(a) === key)) return def.name;
  }
  // Partial: "15 OKT - 2. CANGGU" already stripped; try contains
  for (const def of AREA_DEFS) {
    if (key.includes(nameKey(def.name)) || def.aliases.some((a) => key.includes(nameKey(a)))) {
      return def.name;
    }
  }
  return null;
}

/** Exact area names stay canonical. A longer tab name, such as Ubud Motor, stays itself. */
export function fleetNameFromTab(area) {
  if (!area) return 'Fleet';
  if (area.isCustom) return area.name;
  if (nameKey(area.raw || '') === nameKey(area.name || '')) return area.name || 'Fleet';
  const raw = String(area.raw || '').trim();
  return raw || area.name || 'Fleet';
}

export function areaFromTabTitle(title) {
  const text = String(title || '');
  // "16 OKT - 2.CANGGU" / "15 OKT - 10. UBUD" / "14 OKT -3 CANGGU"
  const m = text.match(/^\s*(?:\d{1,2}\s*[A-Z]+|\w+)\s*-\s*(\d+)?[.,]?\s*(.+)\s*$/i);
  let raw = m ? m[2] : text;
  raw = raw.replace(/^copy of\s+/i, '').trim();
  const number = m && m[1] ? Number(m[1]) : null;
  const canonical = normalizeAreaName(raw);
  if (canonical) {
    const def = AREA_DEFS.find((d) => d.name === canonical);
    return {
      name: canonical,
      number: number || def?.number || null,
      isCustom: false,
      raw,
    };
  }
  if (isCustomRouteName(raw)) {
    return { name: raw.trim().toUpperCase(), number, isCustom: true, raw };
  }
  return { name: raw.trim() || 'Unassigned', number, isCustom: false, raw };
}

export function haversineKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return Infinity;
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
