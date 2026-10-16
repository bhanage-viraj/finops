import { AREA_DEFS, haversineKm, normalizeAreaName } from './areaCatalog.js';
import { nameKey } from './names.js';

/**
 * Assign a stop to an area.
 * Order: customer history → address keywords → nearest centre → Unassigned.
 * Never silently places an uncertain stop on a route (confidence low → Unassigned).
 */
export function assignArea(stop, { customer = null, areas = AREA_DEFS } = {}) {
  const history = customer?.areaHistory || [];
  if (history.length) {
    const sorted = [...history].sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0);
    });
    const top = sorted[0];
    if (top && top.count >= 1) {
      const name = top.areaName || normalizeAreaName(top.areaName);
      if (name) {
        return { areaName: name, confidence: top.count >= 2 ? 'high' : 'medium', reason: 'history' };
      }
    }
  }

  if (customer?.defaultAreaId && customer?.defaultAreaName) {
    return {
      areaName: customer.defaultAreaName,
      confidence: 'medium',
      reason: 'default',
    };
  }

  const blob = [
    stop.location?.placeName,
    stop.location?.address,
    stop.note,
    stop.customerName,
  ].filter(Boolean).join(' ').toLowerCase();

  let bestKeyword = null;
  for (const area of areas) {
    const keywords = area.keywords || [];
    for (const kw of keywords) {
      if (blob.includes(String(kw).toLowerCase())) {
        const score = String(kw).length;
        if (!bestKeyword || score > bestKeyword.score) {
          bestKeyword = { areaName: area.name, score, reason: 'keyword' };
        }
      }
    }
  }
  if (bestKeyword) {
    return { areaName: bestKeyword.areaName, confidence: 'medium', reason: 'keyword' };
  }

  const loc = stop.location;
  if (loc?.lat != null && loc?.lng != null) {
    let nearest = null;
    for (const area of areas) {
      if (!area.centre?.lat) continue;
      const km = haversineKm(loc, area.centre);
      if (!nearest || km < nearest.km) nearest = { areaName: area.name, km };
    }
    if (nearest && nearest.km <= 8) {
      return {
        areaName: nearest.areaName,
        confidence: nearest.km <= 3 ? 'medium' : 'low',
        reason: 'nearest',
        km: nearest.km,
      };
    }
  }

  return { areaName: 'Unassigned', confidence: 'none', reason: 'unassigned' };
}

export function groupStopsByArea(stops, options = {}) {
  const groups = new Map();
  for (const stop of stops) {
    const assignment = assignArea(stop, {
      customer: options.customersById?.get(String(stop.deliveryCustomerId))
        || options.customersByName?.get(nameKey(stop.customerName)),
      areas: options.areas || AREA_DEFS,
    });
    // Uncertain nearest matches stay unassigned so a person decides.
    const finalName = assignment.confidence === 'low' && assignment.reason === 'nearest'
      ? 'Unassigned'
      : assignment.areaName;
    if (!groups.has(finalName)) groups.set(finalName, []);
    groups.get(finalName).push({ ...stop, areaAssignment: { ...assignment, areaName: finalName } });
  }
  return groups;
}
