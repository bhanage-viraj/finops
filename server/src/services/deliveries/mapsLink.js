import { coordsFromMapsUrl } from './locationResolver.js';

/** Build keyless Google Maps URLs from stop data. */

const SHORT_LINK = /https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps)\/[\w-]+/i;

export const MAX_WAYPOINTS = 9;

function encodeQuery(value) {
  return encodeURIComponent(String(value || '').replace(/\s+/g, ' ').trim());
}

export function stopQuery(stop) {
  const loc = stop.location || {};
  if (loc.hideMap) return null;
  if (loc.lat != null && loc.lng != null && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
    return `${loc.lat},${loc.lng}`;
  }
  if (loc.mapsUrl && /maps\.app\.goo\.gl|google\.com\/maps|goo\.gl\/maps/i.test(loc.mapsUrl)) {
    return null; // caller should use the existing URL
  }
  if (loc.plusCode) {
    return `${loc.plusCode} Bali`;
  }
  const parts = [loc.placeName, loc.address, 'Bali'].filter((p) => p && String(p).trim());
  if (parts.length === 0 && stop.customerName) parts.push(stop.customerName, 'Bali');
  return parts.join(', ');
}

function roundCoord(value) {
  return String(Math.round(Number(value) * 1e6) / 1e6);
}

function coordLink(lat, lng) {
  // %2C keeps the pin one link. A raw comma is where WhatsApp stops the tap.
  return `https://maps.google.com/?q=${roundCoord(lat)}%2C${roundCoord(lng)}`;
}

/** One word at a time, joined with +. The full address stays in the link, and WhatsApp can open it. */
function plusQuery(text) {
  const cleaned = String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[,;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const query = cleaned.split(' ').map((word) => encodeURIComponent(word)).join('+');
  return `https://maps.google.com/?q=${query}`;
}

function addressQuery(stop) {
  const loc = stop.location || {};
  const place = String(loc.placeName || '').trim();
  const address = String(loc.address || '').trim();
  const bits = [];
  if (place) bits.push(place);
  if (address && address.toLowerCase() !== place.toLowerCase()) bits.push(address);
  if (!bits.length && loc.plusCode) bits.push(String(loc.plusCode));
  if (!bits.length && stop.customerName) bits.push(String(stop.customerName));
  if (bits.length && !/\bbali\b/i.test(bits.join(' '))) bits.push('Bali');
  return plusQuery(bits.join(' '));
}

function textFromGeneratedUrl(raw) {
  const match = String(raw || '').match(/[?&](?:query|q)=([^&]+)/i);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1].replace(/\+/g, ' '));
  } catch {
    return '';
  }
}

/**
 * The most accurate link a driver can tap.
 * A pasted short link wins. A saved pin is the exact coordinate.
 * Otherwise the whole address is searched, not a shortened street name.
 */
export function driverMapUrl(stop) {
  const loc = stop.location || {};
  if (loc.hideMap) return '';
  const raw = String(loc.mapsUrl || '').trim();
  const short = raw.match(SHORT_LINK);
  if (short) return short[0];

  const generated = /google\.com\/maps\/search\/\?api=1&query=/i.test(raw)
    || /maps\.google\.com\/\?q=/i.test(raw);
  if (raw && !generated && /^https?:\/\//i.test(raw) && !/\s/.test(raw)) {
    const fromPaste = coordsFromMapsUrl(raw);
    if (fromPaste) return coordLink(fromPaste.lat, fromPaste.lng);
    if (!/%20/i.test(raw)) return raw;
  }

  if (Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
    return coordLink(loc.lat, loc.lng);
  }
  const fromUrl = coordsFromMapsUrl(raw);
  if (fromUrl) return coordLink(fromUrl.lat, fromUrl.lng);

  const decoded = textFromGeneratedUrl(raw);
  const decodedCoords = decoded.match(/^(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)$/);
  if (decodedCoords) return coordLink(decodedCoords[1], decodedCoords[2]);

  const fromAddress = addressQuery(stop);
  if (fromAddress) return fromAddress;
  return plusQuery(decoded);
}

export function mapsSearchUrl(stop) {
  const loc = stop.location || {};
  if (loc.hideMap) return '';
  if (loc.mapsUrl && /maps\.app\.goo\.gl|google\.com\/maps|goo\.gl\/maps/i.test(loc.mapsUrl)) {
    return loc.mapsUrl;
  }
  const query = stopQuery(stop);
  if (!query) return '';
  return `https://www.google.com/maps/search/?api=1&query=${encodeQuery(query)}`;
}

/**
 * Split a route into Google Maps directions links.
 * Phones accept roughly origin + destination + 9 waypoints.
 */
export function routeDirectionsLinks(stops, {
  origin = null,
  maxWaypoints = MAX_WAYPOINTS,
} = {}) {
  const usable = (stops || []).filter((s) => mapsSearchUrl(s));
  if (usable.length === 0) return [];

  const chunks = [];
  let i = 0;
  while (i < usable.length) {
    const room = maxWaypoints + 1; // destination + waypoints
    const slice = usable.slice(i, i + room);
    const destination = slice[slice.length - 1];
    const waypoints = slice.slice(0, -1);
    const params = new URLSearchParams({ api: '1', travelmode: 'driving' });
    if (origin && chunks.length === 0) {
      params.set('origin', typeof origin === 'string' ? origin : `${origin.lat},${origin.lng}`);
    } else if (i > 0) {
      const prev = usable[i - 1];
      const q = stopQuery(prev);
      if (q) params.set('origin', q);
    }
    const destQ = stopQuery(destination);
    if (destQ) params.set('destination', destQ);
    if (waypoints.length) {
      params.set('waypoints', waypoints.map((s) => stopQuery(s)).filter(Boolean).join('|'));
    }
    chunks.push({
      label: chunks.length === 0 && usable.length <= room
        ? 'Full route'
        : `Route part ${chunks.length + 1} (stops ${i + 1}–${i + slice.length})`,
      url: `https://www.google.com/maps/dir/?${params.toString()}`,
      stopCount: slice.length,
    });
    i += room;
  }
  return chunks;
}

export function needsLocationCheck(stop) {
  const loc = stop.location || {};
  if (loc.needsPin) return true;
  if (loc.confidence === 'none' || loc.confidence === 'low') return true;
  return false;
}
