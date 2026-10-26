import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPEED_LIMIT_KMH,
  plateFromLabel,
  pointsFromEvents,
  burstsAbove,
  chartPoints,
  downsampleSpeed,
  formatWitaHm,
  parseCartrackTimestamp,
  buildSpeedReport,
  collectFleetPages,
} from '../src/services/deliveries/speedTrace.js';

const morning = new Date('2026-10-26T01:14:00.000Z');

test('plate comes out of a fleet label', () => {
  assert.equal(plateFromLabel('ELF ( DK 8619 HJ )'), 'DK8619HJ');
  assert.equal(plateFromLabel('DK8157HJ'), 'DK8157HJ');
  assert.equal(plateFromLabel('BOX'), '');
});

test('a missing Cartrack offset is Bali time, and UTC is converted', () => {
  const local = parseCartrackTimestamp('2026-10-26 07:10:00');
  assert.equal(formatWitaHm(local), '07:10');
  const utc = parseCartrackTimestamp('2026-10-26 07:10:00+00:00');
  assert.equal(formatWitaHm(utc), '15:10');
});

test('speed at 30 does not alert, and 31 does', () => {
  const points = pointsFromEvents([
    { event_ts: '2026-10-26 07:00:00+08:00', speed: 30 },
    { event_ts: '2026-10-26 07:05:00+08:00', speed: 31 },
    { event_ts: '2026-10-26 07:06:00+08:00', speed: 29 },
  ]);
  const bursts = burstsAbove(points, SPEED_LIMIT_KMH);
  assert.equal(bursts.length, 1);
  assert.equal(bursts[0].peak, 31);
  assert.equal(pointsFromEvents([{ event_ts: '2026-10-26 07:00:00+08:00', speed: 30 }]).length, 1);
  assert.equal(burstsAbove(pointsFromEvents([
    { event_ts: '2026-10-26 07:00:00+08:00', speed: 30 },
  ])).length, 0);
});

test('a gap longer than 3 minutes starts a new stretch above 30', () => {
  const points = pointsFromEvents([
    { event_ts: '2026-10-26 07:00:00+08:00', speed: 40 },
    { event_ts: '2026-10-26 07:02:00+08:00', speed: 36 },
    { event_ts: '2026-10-26 07:12:00+08:00', speed: 33 },
  ]);
  const bursts = burstsAbove(points);
  assert.equal(bursts.length, 2);
  assert.equal(bursts[0].peak, 40);
  assert.equal(bursts[1].peak, 33);
});

test('the same timestamp keeps the higher speed', () => {
  const points = pointsFromEvents([
    { event_ts: '2026-10-26 07:00:00+08:00', speed: 10 },
    { event_ts: '2026-10-26 07:00:00+08:00', speed: 42 },
  ]);
  assert.equal(points.length, 1);
  assert.equal(points[0].speed, 42);
});

test('the graph keeps the trip and drops a long park afterwards', () => {
  const points = pointsFromEvents([
    { event_ts: '2026-10-26 05:00:00+08:00', speed: 0 },
    { event_ts: '2026-10-26 07:00:00+08:00', speed: 28 },
    { event_ts: '2026-10-26 07:10:00+08:00', speed: 0 },
    { event_ts: '2026-10-26 09:00:00+08:00', speed: 0 },
  ]);
  const chart = chartPoints(points);
  assert.equal(chart[0].speed, 28);
  assert.equal(chart.at(-1).speed, 0);
  assert.equal(chart.length, 2);
});

test('downsampling keeps a short spike', () => {
  const rows = [];
  for (let i = 0; i < 1000; i += 1) {
    const minute = String(Math.floor(i / 60)).padStart(2, '0');
    const second = String(i % 60).padStart(2, '0');
    rows.push({
      event_ts: `2026-10-26 07:${minute}:${second}+08:00`,
      speed: i === 500 ? 80 : 12,
    });
  }
  const sampled = downsampleSpeed(pointsFromEvents(rows), 400);
  assert.ok(sampled.some((point) => point.speed === 80));
  assert.ok(sampled.length < 1000);
});

function fakeClient(eventsFor) {
  const calls = [];
  return {
    calls,
    configured: () => true,
    listVehicles: async () => ({ data: [{ registration: 'DK 8157 HJ', vehicle_id: 9, speed: 1 }] }),
    vehiclesStatus: async () => ({ data: [{ registration: 'DK8157HJ', vehicle_id: 9, speed: 34 }] }),
    vehicleEvents: async (registration, query) => {
      calls.push({ registration, query });
      return eventsFor(registration, query);
    },
  };
}

test('a live speed above 30 alerts and uses the Cartrack registration', async () => {
  const client = fakeClient(async () => ({
    data: [
      { event_ts: '2026-10-26 07:00:00+08:00', speed: 20 },
      { event_ts: '2026-10-26 07:10:00+08:00', speed: 31 },
      { event_ts: '2026-10-26 07:12:00+08:00', speed: 30 },
    ],
    meta: { last_page: 1 },
  }));
  const report = await buildSpeedReport({
    date: '2026-10-26',
    now: morning,
    targets: [{ plate: 'DK8157HJ', areaName: 'Seminyak', cartrackVehicleId: '9' }],
    client,
  });
  assert.equal(client.calls[0].registration, 'DK 8157 HJ');
  assert.equal(client.calls[0].query['filter[terminal_event_type_id]'], 2);
  assert.deepEqual(report.alertPlates, ['DK8157HJ']);
  assert.equal(report.vehicles[0].currentSpeed, 34);
  assert.equal(report.vehicles[0].overLimit, true);
  assert.equal(report.vehicles[0].maxSpeed, 34);
  assert.equal(report.vehicles[0].bursts[0].label, '07:10 peak 31');
  assert.equal(report.refresh, true);
  assert.equal(report.from, '05:00');
  assert.equal(report.to, '09:14');
  assert.equal(report.limitKmh, 30);
});

test('speed events are read page by page and the peak is kept', async () => {
  const client = fakeClient(async (_registration, query) => {
    if (Number(query.page) === 1) {
      return {
        data: [{ event_ts: '2026-10-26 07:00:00+08:00', speed: 10 }],
        meta: { last_page: 2 },
      };
    }
    return {
      data: [{ event_ts: '2026-10-26 07:20:00+08:00', speed: 44 }],
      meta: { last_page: 2 },
    };
  });
  const report = await buildSpeedReport({
    date: '2026-10-26',
    now: morning,
    targets: [{ plate: 'DK8157HJ', areaName: '', cartrackVehicleId: '' }],
    client,
  });
  assert.equal(client.calls.length, 2);
  assert.equal(report.vehicles[0].maxSpeed, 44);
  assert.ok(report.vehicles[0].points.some((point) => point.speed === 44));
});

test('one vehicle failing still leaves the other graph', async () => {
  const client = fakeClient(async (registration) => {
    if (String(registration).replace(/\s+/g, '').includes('8157')) {
      const error = new Error('Cartrack request failed (500).');
      error.status = 502;
      throw error;
    }
    return {
      data: [{ event_ts: '2026-10-26 08:00:00+08:00', speed: 18 }],
      meta: { last_page: 1 },
    };
  });
  client.vehiclesStatus = async () => ({ data: [] });
  const report = await buildSpeedReport({
    date: '2026-10-26',
    now: morning,
    targets: [
      { plate: 'DK8157HJ', areaName: 'A', cartrackVehicleId: '' },
      { plate: 'DK8159HI', areaName: 'B', cartrackVehicleId: '' },
    ],
    client,
  });
  const failed = report.vehicles.find((vehicle) => vehicle.plate === 'DK8157HJ');
  const ok = report.vehicles.find((vehicle) => vehicle.plate === 'DK8159HI');
  assert.match(failed.error, /did not return speed/i);
  assert.equal(ok.maxSpeed, 18);
  assert.equal(ok.overLimit, false);
});

test('before 05:00 the report does not call Cartrack', async () => {
  let called = false;
  const client = {
    configured: () => true,
    listVehicles: async () => { called = true; return { data: [] }; },
    vehiclesStatus: async () => ({ data: [] }),
    vehicleEvents: async () => { called = true; return { data: [] }; },
  };
  const report = await buildSpeedReport({
    date: '2026-10-26',
    now: new Date('2026-10-25T20:30:00.000Z'),
    targets: [{ plate: 'DK8157HJ', areaName: '', cartrackVehicleId: '' }],
    client,
  });
  assert.equal(called, false);
  assert.match(report.note, /05:00/);
  assert.equal(report.refresh, false);
});

test('vehicles that are not on the day are included from Cartrack', async () => {
  const client = fakeClient(async (registration) => ({
    data: [{
      event_ts: '2026-10-26 08:15:00+08:00',
      speed: String(registration).includes('8160') ? 22 : 18,
    }],
    meta: { last_page: 1 },
  }));
  client.listVehicles = async () => ({
    data: [
      { registration: 'DK 8157 HJ', vehicle_id: 9 },
      { registration: 'DK8160HJ', vehicle_id: 11 },
    ],
  });
  client.vehiclesStatus = async () => ({
    data: [{ registration: 'DK 8159 HI', vehicle_id: 10, speed: 12 }],
  });
  const report = await buildSpeedReport({
    date: '2026-10-26',
    now: morning,
    targets: [{ plate: 'DK8157HJ', areaName: 'Seminyak', cartrackVehicleId: '9' }],
    client,
  });
  const plates = report.vehicles.map((vehicle) => vehicle.plate);
  assert.deepEqual(plates.filter((plate) => plate !== 'DK8157HJ').sort(), ['DK8159HI', 'DK8160HJ']);
  assert.equal(report.vehicles.find((vehicle) => vehicle.plate === 'DK8157HJ').areaName, 'Seminyak');
  assert.equal(report.vehicles.find((vehicle) => vehicle.plate === 'DK8160HJ').maxSpeed, 22);
  assert.equal(report.vehicles.find((vehicle) => vehicle.plate === 'DK8159HI').currentSpeed, 12);
});

test('all Cartrack pages are shown when there is no delivery', async () => {
  const seenPages = [];
  const client = fakeClient(async () => ({
    data: [{ event_ts: '2026-10-26 08:00:00+08:00', speed: 16 }],
    meta: { last_page: 1 },
  }));
  client.listVehicles = async (query) => {
    seenPages.push(query.page);
    if (Number(query.page) === 1) {
      return { data: [{ registration: 'DK8157HJ', vehicle_id: 1 }], meta: { last_page: 2 } };
    }
    return { data: [{ registration: 'B1AB', vehicle_id: 2 }], meta: { last_page: 2 } };
  };
  client.vehiclesStatus = async () => ({ data: [], meta: { last_page: 1 } });
  const report = await buildSpeedReport({
    date: '2026-10-26',
    now: morning,
    targets: [],
    client,
  });
  assert.deepEqual(seenPages, [1, 2]);
  assert.deepEqual(report.vehicles.map((vehicle) => vehicle.plate).sort(), ['B1AB', 'DK8157HJ']);
  assert.equal(report.note, '');
});

test('fleet paging stops after the last page', async () => {
  const rows = await collectFleetPages(async (query) => {
    if (Number(query.page) === 1) {
      return { data: [{ registration: 'DK1111AA' }], meta: { last_page: 2 } };
    }
    return { data: [{ registration: 'DK2222BB' }], meta: { last_page: 2 } };
  });
  assert.equal(rows.length, 2);
});
