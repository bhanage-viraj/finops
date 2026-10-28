import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMonths, demandChannel, markedNewCustomer, mergeDayRecords, summarizeMarket,
} from '../src/services/deliveries/marketTrends.js';

function stop(customerName, items, type = 'deliver') {
  return { customerName, type, plannedItems: items };
}

function item(productName, qty, kind) {
  return { productName, qty, kind, qtyMissing: false };
}

function tab(date, areaName, stops) {
  return { date, sheetName: areaName, area: { name: areaName }, stops };
}

test('a customer name lands in home, hotel, restaurant, or depo', () => {
  assert.equal(demandChannel('Ibu Made', 'Seminyak'), 'home');
  assert.equal(demandChannel('Villa Ombak', 'Canggu'), 'hotel');
  assert.equal(demandChannel('Hotel Taman', 'Ubud'), 'hotel');
  assert.equal(demandChannel('Warung Sari', 'Ubud'), 'restaurant');
  assert.equal(demandChannel('Cafe Luna', 'Seminyak'), 'restaurant');
  assert.equal(demandChannel('Toko Budi', 'Depo Negara'), 'depo');
});

test('a month sums every day and the per-day number is the average', () => {
  const summary = summarizeMarket([
    tab('2026-10-28', 'Seminyak', [
      stop('Villa Ombak', [item('Galon', 4, 'gallon'), item('Ambil kosong', 2, 'pickup')]),
    ]),
    tab('2026-10-29', 'Seminyak', [
      stop('Ibu Made', [item('Galon', 10, 'gallon')]),
      stop('Warung Sari', [item('Galon', 3, 'gallon'), item('Galon kaca', 1, 'glass')]),
    ]),
    tab('2026-10-29', 'Depo Negara', [
      stop('Toko Budi', [item('Galon', 20, 'gallon')]),
    ]),
    tab('2026-10-29', 'Canggu', [
      stop('Baru Hotel Senja', [item('Galon', 6, 'gallon')]),
    ]),
  ]);

  const october = summary.months.find((month) => month.month === '2026-10');
  assert.equal(october.gallons, 44);
  assert.equal(october.dayCount, 2);
  assert.equal(october.dailyAverage, 22);
  assert.equal(october.channels.home.gallons, 10);
  assert.equal(october.channels.hotel.gallons, 10);
  assert.equal(october.channels.restaurant.gallons, 4);
  assert.equal(october.channels.depo.gallons, 20);
  assert.equal(october.prepare.find((row) => row.kind === 'gallon').qty, 43);
  assert.equal(october.prepare.find((row) => row.kind === 'glass').qty, 1);
  assert.equal(october.newCustomers, 1);
  assert.equal(summary.latestMonth.month, '2026-10');
  assert.equal(summary.season.ready, false);
  assert.equal(markedNewCustomer('Baru Hotel Senja'), true);
  assert.equal(markedNewCustomer('Ibu Made'), false);
});

test('a title row is not a customer and a blank galon quantity is reported missing', () => {
  const summary = summarizeMarket([
    tab('2026-10-29', 'Sari Asih', [
      stop('ARMADA:', [item('Unknown', 1, 'other')]),
      stop('PT Sari', [{ productName: 'Gallon Refill', qty: null, kind: 'gallon', qtyMissing: true }]),
    ]),
  ]);
  assert.equal(summary.latestMonth.stops, 1);
  assert.equal(summary.latestMonth.gallons, 0);
  assert.equal(summary.latestMonth.qtyMissing, 1);
});

test('high season is the fullest month and low season is the lightest', () => {
  const summary = summarizeMarket([
    tab('2026-02-02', 'Seminyak', [stop('Ibu Made', [item('Galon', 5, 'gallon')])]),
    tab('2026-07-02', 'Seminyak', [stop('Villa Ombak', [item('Galon', 30, 'gallon')])]),
    tab('2026-07-03', 'Canggu', [stop('Hotel Taman', [item('Galon', 12, 'gallon')])]),
  ]);

  assert.equal(summary.season.ready, true);
  assert.equal(summary.season.high.month, '2026-07');
  assert.equal(summary.season.high.gallons, 42);
  assert.equal(summary.season.low.month, '2026-02');
  assert.equal(summary.season.low.gallons, 5);
  const july = summary.months.find((month) => month.month === '2026-07');
  assert.equal(july.dayCount, 2);
  assert.equal(july.dailyAverage, 21);
  assert.equal(summary.latestMonth.month, '2026-07');
});

test('a saved month stays in the overall trend after the sheet moves on', () => {
  const saved = [{
    date: '2026-02-02',
    gallons: 100,
    stops: 10,
    qtyMissing: 0,
    newCustomers: 1,
    channels: {
      home: { stops: 10, gallons: 100 },
      hotel: { stops: 0, gallons: 0 },
      restaurant: { stops: 0, gallons: 0 },
      depo: { stops: 0, gallons: 0 },
    },
    products: [],
    prepare: [{ kind: 'gallon', qty: 100 }],
  }];
  const today = [{
    date: '2026-10-29',
    gallons: 40,
    stops: 4,
    qtyMissing: 0,
    newCustomers: 0,
    channels: {
      home: { stops: 4, gallons: 40 },
      hotel: { stops: 0, gallons: 0 },
      restaurant: { stops: 0, gallons: 0 },
      depo: { stops: 0, gallons: 0 },
    },
    products: [],
    prepare: [{ kind: 'gallon', qty: 40 }],
  }];
  const months = buildMonths(mergeDayRecords(saved, today));
  assert.deepEqual(months.map((month) => month.month), ['2026-02', '2026-10']);
  assert.equal(months[0].gallons, 100);
  assert.equal(months[1].dailyAverage, 40);
});
