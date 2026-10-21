import assert from 'node:assert/strict';
import test from 'node:test';
import { extraFleetName, fleetMapsAfterMove, stopsKeptOnSheet } from '../src/services/deliveries/mapsFreshness.js';

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

test('delivered stops stay when the rest of a fleet is deleted', () => {
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
