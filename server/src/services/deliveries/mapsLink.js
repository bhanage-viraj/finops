/** Build keyless Google Maps URLs from stop data. */

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
