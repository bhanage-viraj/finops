import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDms,
  parsePlusCode,
  parseDecimalCoords,
  coordsFromMapsUrl,
  resolveLocation,
  isVagueAddress,
} from '../src/services/deliveries/locationResolver.js';
import { mapsSearchUrl, driverMapUrl, routeDirectionsLinks, MAX_WAYPOINTS } from '../src/services/deliveries/mapsLink.js';
import { assignArea } from '../src/services/deliveries/areaAssigner.js';
import { areaFromTabTitle, normalizeAreaName } from '../src/services/deliveries/areaCatalog.js';

test('DMS parsing for Bali coordinates', () => {
  const hit = parseDms(`8° 38' 1.6476" S 115° 7' 36.0404" E`);
  assert.ok(hit);
  assert.ok(hit.lat < -8.6 && hit.lat > -8.7);
  assert.ok(hit.lng > 115 && hit.lng < 116);
});

test('plus code recovers near Bali', () => {
  const hit = parsePlusCode('84RM+7PH, Canggu');
  assert.ok(hit);
  assert.ok(Number.isFinite(hit.lat));
  assert.ok(Number.isFinite(hit.lng));
});

test('decimal coords and maps URL coords', () => {
  assert.deepEqual(parseDecimalCoords('-8.65, 115.14'), { lat: -8.65, lng: 115.14 });
  const fromUrl = coordsFromMapsUrl('https://www.google.com/maps/search/?api=1&query=-8.65,115.14');
  assert.deepEqual(fromUrl, { lat: -8.65, lng: 115.14 });
});

test('vague address needs pin; full address does not invent coords', () => {
  assert.equal(isVagueAddress('Denpasar'), true);
  assert.equal(isVagueAddress('Babakan'), true);
  const loc = resolveLocation({ address: 'Denpasar' });
  assert.equal(loc.needsPin, true);
  assert.equal(loc.lat, null);
  assert.equal(loc.confidence, 'none');

  const full = resolveLocation({
    address: 'Jl. Pantai Berawa No.8, Canggu, Kec. Kuta Utara, Kabupaten Badung, Bali 80361',
  });
  assert.equal(full.needsPin, false);
  assert.equal(full.source, 'address');
});

test('book location wins when confirmed', () => {
  const loc = resolveLocation({
    address: 'somewhere vague',
    book: {
      lat: -8.65,
      lng: 115.14,
      confirmedAt: new Date(),
      mapsUrl: 'https://maps.app.goo.gl/x',
    },
  });
  assert.equal(loc.source, 'book');
  assert.equal(loc.confidence, 'high');
  assert.equal(loc.lat, -8.65);
});

test('driver map link is a short tappable url, not the whole address', () => {
  const pasted = driverMapUrl({
    location: {
      mapsUrl: 'https://maps.app.goo.gl/jCdnh3kQhn7c9v6A7',
      lat: -8.6,
      lng: 115.1,
    },
  });
  assert.equal(pasted, 'https://maps.app.goo.gl/jCdnh3kQhn7c9v6A7');

  const pin = driverMapUrl({
    location: {
      lat: -8.669187500000005,
      lng: 115.15885937499999,
      mapsUrl: 'https://www.google.com/maps/search/?api=1&query=White%20Residence%2C%20Bali',
    },
  });
  assert.equal(pin, 'https://maps.google.com/?q=-8.669188%2C115.158859');

  const addressOnly = driverMapUrl({
    customerName: 'White residence',
    location: {
      placeName: 'White Residence',
      address: 'Jl. Intan Permai, Kerobokan Kelod, Kec. Kuta Utara, Kabupaten Badung, Bali',
      mapsUrl: 'https://www.google.com/maps/search/?api=1&query=White%20Residence%2C%20Jl.%20Intan%20Permai%2C%20Kerobokan',
    },
  });
  assert.equal(
    addressOnly,
    'https://maps.google.com/?q=White+Residence+Jl.+Intan+Permai+Kerobokan+Kelod+Kec.+Kuta+Utara+Kabupaten+Badung+Bali',
  );
  assert.equal(addressOnly.includes('%20'), false);
  assert.match(addressOnly, /Kabupaten\+Badung/);
});

test('mapsSearchUrl prefers coordinates and encodes special characters', () => {
  const withCoords = mapsSearchUrl({ location: { lat: -8.6338, lng: 115.1267 } });
  assert.equal(withCoords, 'https://www.google.com/maps/search/?api=1&query=-8.6338%2C115.1267');

  const withAddr = mapsSearchUrl({
    location: {
      placeName: 'Open House & Co',
      address: 'Jl. Raya Babakan #19 / Canggu',
    },
  });
  assert.ok(withAddr.includes('query='));
  assert.ok(withAddr.includes('%26') || withAddr.includes('Open'));
  assert.ok(!withAddr.includes('Jl. Raya Babakan #19 / Canggu'));
});

test('a deleted map is left out of the driver links', () => {
  const hidden = { customerName: 'Hidden', location: { lat: -8.6, lng: 115.1, hideMap: true, mapsUrl: 'https://maps.google.com/?q=1' } };
  const shown = { customerName: 'Shown', location: { lat: -8.7, lng: 115.2 } };
  assert.equal(mapsSearchUrl(hidden), '');
  const links = routeDirectionsLinks([hidden, shown]);
  assert.equal(links.length, 1);
  assert.equal(links[0].stopCount, 1);
});

test('route directions split within waypoint limit', () => {
  const stops = Array.from({ length: 25 }, (_, i) => ({
    customerName: `C${i}`,
    location: { lat: -8.65 - i * 0.001, lng: 115.14 + i * 0.001 },
  }));
  const links = routeDirectionsLinks(stops, { origin: { lat: -8.67, lng: 115.21 } });
  assert.ok(links.length >= 2);
  for (const link of links) {
    assert.ok(link.stopCount <= MAX_WAYPOINTS + 1);
    assert.ok(link.url.includes('/maps/dir/'));
  }
});

test('area aliases normalize across spellings', () => {
  assert.equal(normalizeAreaName('PECATU-2'), 'Pecatu');
  assert.equal(normalizeAreaName('PECATU 2'), 'Pecatu');
  assert.equal(normalizeAreaName('SARI ASIH'), 'Sari Asih');
  assert.equal(normalizeAreaName('SARIASIH'), 'Sari Asih');
  assert.equal(normalizeAreaName('UBUD MOTOR'), 'Ubud');
  assert.equal(normalizeAreaName('DPS'), 'Denpasar');
  assert.equal(areaFromTabTitle('16 OKT - 2.CANGGU').name, 'Canggu');
  assert.equal(areaFromTabTitle('15 OKT - 18. PAK BAS').isCustom, true);
});

test('area assigner never returns high confidence for wrong area on keyword-only mismatch', () => {
  const stop = {
    customerName: 'Unknown Villa',
    location: { address: 'somewhere random with no clue', confidence: 'none' },
    note: '',
  };
  const result = assignArea(stop, { customer: null });
  assert.equal(result.areaName, 'Unassigned');
  assert.equal(result.confidence, 'none');
});

test('history beats keywords', () => {
  const stop = {
    customerName: 'Open House Babakan',
    location: { address: 'Jl. Raya Babakan Canggu', confidence: 'none' },
  };
  const customer = {
    areaHistory: [{ areaName: 'Canggu', count: 3, lastSeenAt: new Date() }],
  };
  const result = assignArea(stop, { customer });
  assert.equal(result.areaName, 'Canggu');
  assert.equal(result.confidence, 'high');
  assert.equal(result.reason, 'history');
});
