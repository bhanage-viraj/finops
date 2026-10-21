/**
 * A fleet map is the route link already sent to a driver.
 * Moving cargo after that send makes the old link wrong.
 * The customer's own map pin is separate and is not cleared here.
 */
const KEPT_ON_SHEET = new Set(['delivered', 'nota_checked']);

/** Delivered stops stay. The rest of a fleet can be removed or moved. */
export function stopsKeptOnSheet(stops) {
  return (stops || []).filter((stop) => KEPT_ON_SHEET.has(stop.status));
}

/** Next overflow fleet when the area split is too heavy for one vehicle. */
export function extraFleetName(routes) {
  const number = (routes || []).reduce((max, route) => Math.max(max, Number(route?.number) || 0), 0) + 1;
  return { number, areaName: `Extra fleet ${number}` };
}

export function fleetMapsAfterMove(routes, { sameFleet = false, stopStatus = 'planned' } = {}) {
  if (sameFleet) {
    return { mapsStale: false, staleRouteIds: [], stopStatus };
  }
  const staleRouteIds = (routes || [])
    .filter((route) => route && (route.mapSentAt || route.mapsFlag))
    .map((route) => String(route._id));
  const mapsStale = staleRouteIds.length > 0;
  return {
    mapsStale,
    staleRouteIds,
    stopStatus: mapsStale && stopStatus === 'map_sent' ? 'planned' : stopStatus,
  };
}
