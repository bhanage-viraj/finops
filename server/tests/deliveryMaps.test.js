import assert from 'node:assert/strict';
import test from 'node:test';
import { extraFleetName, fleetMapsAfterMove, plannedLines, stopsKeptOnSheet } from '../src/services/deliveries/mapsFreshness.js';

const sent = { _id: 'fleet-a', mapSentAt: new Date(), mapsFlag: true };
const fresh = { _id: 'fleet-b', mapSentAt: null, mapsFlag: false };

test('moving cargo off a sent map marks that fleet stale and drops the sent status', () => {
  const result = fleetMapsAfterMove([sent, fresh], { sameFleet: false, stopStatus: 'map_sent' });
  assert.equal(result.mapsStale, true);
  assert.deepEqual(result.staleRouteIds, ['fleet-a']);
  assert.equal(result.stopStatus, 'planned');
});

test('a move before any map is sent leaves the stop as planned', () => {
  const result = fleetMapsAfterMove([fresh, { _id: 'fleet-c' }], { sameFleet: false, stopStatus: 'planned' });
  assert.equal(result.mapsStale, false);
  assert.deepEqual(result.staleRouteIds, []);
  assert.equal(result.stopStatus, 'planned');
});

test('reordering inside the same fleet does not throw away a sent map', () => {
  const result = fleetMapsAfterMove([sent], { sameFleet: true, stopStatus: 'map_sent' });
  assert.equal(result.mapsStale, false);
  assert.equal(result.stopStatus, 'map_sent');
});

test('an extra fleet is numbered after the fleets already on the day', () => {
  assert.deepEqual(extraFleetName([{ number: 2 }, { number: 7 }]), { number: 8, areaName: 'Extra fleet 8' });
  assert.deepEqual(extraFleetName([]), { number: 1, areaName: 'Extra fleet 1' });
});

test('delivered stops stay on the sheet', () => {
  const kept = stopsKeptOnSheet([
    { status: 'planned', customerName: 'A' },
    { status: 'delivered', customerName: 'B' },
    { status: 'nota_checked', customerName: 'C' },
    { status: 'map_sent', customerName: 'D' },
  ]);
  assert.deepEqual(kept.map((stop) => stop.customerName), ['B', 'C']);
});

test('a stop already on the road stays delivered when its fleet map goes stale', () => {
  const result = fleetMapsAfterMove([sent, fresh], { sameFleet: false, stopStatus: 'delivered' });
  assert.equal(result.mapsStale, true);
  assert.equal(result.stopStatus, 'delivered');
});

test('editing a delivery keeps the price already on that product', () => {
  const lines = plannedLines(
    [{ productName: 'Still 330', packType: 'carton', qty: '4' }, { productName: '', qty: 9 }],
    [{ productName: 'Still 330', packType: 'carton', unitPrice: 12000, productId: 'p1', packQty: 12 }],
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0].qty, 4);
  assert.equal(lines[0].unitPrice, 12000);
  assert.equal(lines[0].productId, 'p1');
  assert.equal(lines[0].packQty, 12);
  assert.equal(lines[0].qtyMissing, false);
});

test('a blank quantity stays blank and a new product has no invented price', () => {
  const lines = plannedLines([{ productName: 'Galon', qty: '' }], []);
  assert.equal(lines[0].qty, null);
  assert.equal(lines[0].unitPrice, null);
  assert.equal(lines[0].qtyMissing, true);
});

test('a delivery needs a whole quantity and at least one product', () => {
  assert.throws(() => plannedLines([{ productName: 'Galon', qty: 1.5 }], []), /whole number/);
  assert.throws(() => plannedLines([{ productName: '  ' }], []), /at least one product/);
  assert.throws(() => plannedLines(Array.from({ length: 31 }, (_, i) => ({ productName: `P${i}`, qty: 1 }))), /30 products/);
});
