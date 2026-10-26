import OpenLocationCode from 'open-location-code';
import { nameKey } from './names.js';

// Bali reference for short plus codes.
export const BALI_REF = { lat: -8.65, lng: 115.2 };

const PLUS_CODE_RE = /\b([23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3})\b/i;
const DMS_RE = /(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*([\d.]+)\s*["″]?\s*([NS])\s*[,\s]+(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*([\d.]+)\s*["″]?\s*([EW])/i;
const DECIMAL_RE = /(-?\d{1,2}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)/;
const MAPS_LINK_RE = /https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|www\.google\.com\/maps|maps\.google\.com)[^\s)"]+/i;
const VAGUE_RE = /^(denpasar|canggu|pecatu|ubud|babakan|seminyak|kerobokan|munggu|cemagi|pererenan|tibubeneng|ungasan|jimbaran|sanur|tabanan|gianyar|bali)\b/i;

function dmsToDecimal(deg, min, sec, hemi) {
  const sign = /[SW]/i.test(hemi) ? -1 : 1;
  return sign * (Number(deg) + Number(min) / 60 + Number(sec) / 3600);
}

function result({ lat, lng, source, confidence, mapsUrl = '', placeName = '', address = '', needsPin = false, plusCode = '' }) {
  return {
    lat: lat == null ? null : Number(lat),
    lng: lng == null ? null : Number(lng),
    source,
    confidence,
    mapsUrl,
    placeName,
    address,
    needsPin,
    plusCode,
  };
}

export function isVagueAddress(address) {
  const text = String(address || '').trim();
  if (!text) return true;
  if (text.length < 18) return true;
  if (VAGUE_RE.test(text) && text.length < 40 && !/\d/.test(text) && !/\+/.test(text)) return true;
  if (/rumah dekat|dekat lodge|cek room|lihat map|liat map|sesuai gmaps/i.test(text) && text.length < 60) {
    return true;
  }
  return false;
}

export function parseDms(text) {
  const m = String(text || '').match(DMS_RE);
  if (!m) return null;
  const lat = dmsToDecimal(m[1], m[2], m[3], m[4]);
  const lng = dmsToDecimal(m[5], m[6], m[7], m[8]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

export function parseDecimalCoords(text) {
  const m = String(text || '').match(DECIMAL_RE);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  // Bali-ish sanity: prefer southern hemisphere latitudes.
  if (lat > 0 && lng > 90) return { lat: -lat, lng };
  return { lat, lng };
}

export function parsePlusCode(text, ref = BALI_REF) {
  const m = String(text || '').match(PLUS_CODE_RE);
  if (!m) return null;
  const code = m[1].toUpperCase();
  try {
    const olc = new OpenLocationCode.OpenLocationCode();
    const full = olc.isFull(code) ? code : olc.recoverNearest(code, ref.lat, ref.lng);
    const area = olc.decode(full);
    return {
      lat: area.latitudeCenter,
      lng: area.longitudeCenter,
      plusCode: full,
    };
  } catch {
    return null;
  }
}

export function extractMapsLink(text) {
  const m = String(text || '').match(MAPS_LINK_RE);
  return m ? m[0] : '';
}

/**
 * Pull coordinates out of a final Google Maps URL path/query.
 * Works for /@lat,lng, /maps/search/lat,lng, ?q=lat,lng, !3dlat!4dlng.
 */
export function coordsFromMapsUrl(url) {
  const text = String(url || '');
  const patterns = [
    /[?&]q=(-?\d+\.\d+)(?:%2C|%2B|,|\+|\s)(-?\d+\.\d+)/i,
    /[?&]query=(-?\d+\.\d+)(?:%2C|%2B|,|\+)(-?\d+\.\d+)/i,
    /\/@(-?\d+\.\d+),(-?\d+\.\d+)/,
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
    /\/search\/(-?\d+\.\d+)(?:%2B|\+|,)\s*(-?\d+\.\d+)/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }
  }
  return null;
}

/**
 * Resolve a stop's location from sheet fields and an optional saved book entry.
 * Does not call the network; short-link expansion is a separate step.
 */
export function resolveLocation({
  placeName = '',
  address = '',
  note = '',
  book = null,
} = {}) {
  const blob = [placeName, address, note].filter(Boolean).join('\n');

  if (book?.lat != null && book?.lng != null && book?.confirmedAt) {
    return result({
      lat: book.lat,
      lng: book.lng,
      source: 'book',
      confidence: 'high',
      mapsUrl: book.mapsUrl || '',
      placeName: book.placeName || placeName,
      address: book.address || address,
      needsPin: false,
    });
  }

  const dms = parseDms(blob);
  if (dms) {
    return result({
      ...dms,
      source: 'dms',
      confidence: 'high',
      placeName,
      address,
      mapsUrl: extractMapsLink(blob),
    });
  }

  const plus = parsePlusCode(blob);
  if (plus) {
    return result({
      lat: plus.lat,
      lng: plus.lng,
      source: 'plus_code',
      confidence: 'high',
      placeName,
      address,
      plusCode: plus.plusCode,
      mapsUrl: extractMapsLink(blob),
    });
  }

  const mapsLink = extractMapsLink(blob);
  if (mapsLink) {
    const fromUrl = coordsFromMapsUrl(mapsLink);
    if (fromUrl) {
      return result({
        ...fromUrl,
        source: 'maps_link',
        confidence: 'high',
        mapsUrl: mapsLink,
        placeName,
        address,
      });
    }
    // Short link without expanded coords — keep the URL, mark medium until expanded.
    return result({
      lat: null,
      lng: null,
      source: 'maps_link',
      confidence: 'medium',
      mapsUrl: mapsLink,
      placeName,
      address,
      needsPin: false,
    });
  }

  const decimal = parseDecimalCoords(blob);
  if (decimal) {
    return result({
      ...decimal,
      source: 'decimal',
      confidence: 'high',
      placeName,
      address,
    });
  }

  const vague = isVagueAddress(address) && !placeName;
  return result({
    lat: book?.lat ?? null,
    lng: book?.lng ?? null,
    source: book?.lat != null ? 'book' : 'address',
    confidence: book?.lat != null ? 'medium' : 'none',
    placeName,
    address,
    mapsUrl: '',
    needsPin: vague || (book?.lat == null && isVagueAddress(address)),
  });
}

export function customerNameKey(name) {
  return nameKey(name);
}
