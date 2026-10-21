/**
 * A fleet map is the route link already sent to a driver.
 * Moving cargo after that send makes the old link wrong.
 * The customer's own map pin is separate and is not cleared here.
 */
import { parseQty } from './money.js';

const KEPT_ON_SHEET = new Set(['delivered', 'nota_checked']);

/** Delivered stops stay on the sheet. */
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

/**
 * One delivery's product lines.
 * A blank price stays blank so the price list can fill it on read.
 * A price already stored on the same product is kept. Never invents 0.
 */
export function plannedLines(items, previous = []) {
  if (!Array.isArray(items)) throw new Error('Add the products for this delivery.');
  const lines = [];
  for (const raw of items) {
    const productName = String(raw?.productName || '').trim().slice(0, 80);
    if (!productName) continue;
    if (lines.length >= 30) throw new Error('A delivery can have up to 30 products.');
    const packType = String(raw?.packType || '').trim().slice(0, 40);
    const parsed = parseQty(raw?.qty);
    if (!parsed.missing && (!Number.isInteger(parsed.qty) || parsed.qty < 0)) {
      throw new Error(`${productName} needs a whole number.`);
    }
    const prev = (previous || []).find((row) => (
      row?.productName === productName && String(row?.packType || '') === packType
    ));
    lines.push({
      productId: prev?.productId || null,
      productName,
      packType,
      packQty: prev?.packQty == null || !Number.isFinite(Number(prev.packQty)) ? null : prev.packQty,
      qty: parsed.missing ? null : parsed.qty,
      unitPrice: Number.isInteger(prev?.unitPrice) ? prev.unitPrice : null,
      qtyMissing: parsed.missing,
    });
  }
  if (!lines.length) throw new Error('Add at least one product.');
  return lines;
}
