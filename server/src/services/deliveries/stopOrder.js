import { haversineKm } from './areaCatalog.js';
import { timePriority } from './timeTags.js';

/**
 * Order stops: time-tagged first (by priority), then nearest-neighbour from depot.
 */
export function orderStops(stops, { depot = null } = {}) {
  const list = (stops || []).map((s, i) => ({ ...s, _i: i }));
  const morning = list
    .filter((s) => timePriority(s.timeTags) < 40)
    .sort((a, b) => timePriority(a.timeTags) - timePriority(b.timeTags) || a._i - b._i);
  const rest = list.filter((s) => timePriority(s.timeTags) >= 40);

  const ordered = [];
  const used = new Set();

  for (const s of morning) {
    ordered.push(s);
    used.add(s._i);
  }

  let current = depot;
  if (!current && ordered.length && ordered[ordered.length - 1].location?.lat != null) {
    current = ordered[ordered.length - 1].location;
  }

  const remaining = rest.filter((s) => !used.has(s._i));
  while (remaining.length) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const loc = remaining[i].location;
      const d = current && loc?.lat != null ? haversineKm(current, loc) : remaining[i]._i;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    ordered.push(next);
    if (next.location?.lat != null) current = next.location;
  }

  return ordered.map((s, idx) => {
    const { _i, ...restStop } = s;
    return { ...restStop, sortIndex: idx };
  });
}
