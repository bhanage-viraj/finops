import test from 'node:test';
import assert from 'node:assert/strict';
import { spreadsheetIdFromUrl, sheetTabsFromHtml, selectTabsForDate, csvToRows, tabsForDeliveryDate, tabBelongsToDeliveryDate } from '../src/services/deliveries/googleSheet.js';
import { areaFromTabTitle, fleetNameFromTab } from '../src/services/deliveries/areaCatalog.js';
import { parseRouteSheetRows } from '../src/services/deliveries/sheetParse.js';

const HTML = `
items.push({name: "22 OCT - 1.SEMINYAK ", pageUrl: "gid=1", gid: "11"});
items.push({name: "21 OCT - 2.CANGGU", pageUrl: "gid=2", gid: "22"});
items.push({name: "22 OCT - 15.UBUD MOTOR", pageUrl: "gid=3", gid: "33"});
items.push({name: "22 OCT - 10.UBUD", pageUrl: "gid=4", gid: "44"});
items.push({name: "Copy of 22 OCT - 1.SEMINYAK", pageUrl: "gid=5", gid: "55"});
`;

test('a sharing link yields the spreadsheet id', () => {
  const id = spreadsheetIdFromUrl('https://docs.google.com/spreadsheets/d/1llG2YXO0zXdKj5-T0bEr88gTtNg7-lRAagQ_b8sSQls/edit?usp=sharing');
  assert.equal(id, '1llG2YXO0zXdKj5-T0bEr88gTtNg7-lRAagQ_b8sSQls');
  assert.throws(() => spreadsheetIdFromUrl('https://example.com/spreadsheets/d/abc'), /Google Sheets/);
});

test('only the chosen date is kept, in her tab order', () => {
  const tabs = selectTabsForDate(sheetTabsFromHtml(HTML), '2026-10-22');
  assert.deepEqual(tabs.map((tab) => tab.name), [
    '22 OCT - 1.SEMINYAK',
    '22 OCT - 10.UBUD',
    '22 OCT - 15.UBUD MOTOR',
  ]);
});

test('a copied tab is not a second list for that date', () => {
  const tabs = selectTabsForDate(sheetTabsFromHtml(HTML), '2026-10-21');
  assert.deepEqual(tabs.map((tab) => tab.name), ['21 OCT - 2.CANGGU']);
});

test('a tab named for the day is kept when the printed heading still says yesterday', () => {
  const named = { name: '24 OCT - 1. SEMINYAK', namedForDate: true };
  const yesterday = { name: '23 OCT - 1. SEMINYAK', namedForDate: false };
  const staleHeading = { headerDate: '2026-10-23', date: '2026-10-24' };
  assert.equal(tabBelongsToDeliveryDate(named, staleHeading, '2026-10-24'), true);
  assert.equal(tabBelongsToDeliveryDate(yesterday, staleHeading, '2026-10-24'), false);
  assert.equal(tabBelongsToDeliveryDate(yesterday, { headerDate: '2026-10-24' }, '2026-10-24'), true);
});

test('yesterday is checked so a renamed heading still lands on the printed date', () => {
  const tabs = tabsForDeliveryDate(sheetTabsFromHtml(HTML), '2026-10-22');
  assert.deepEqual(tabs.map((tab) => [tab.name, tab.namedForDate]), [
    ['22 OCT - 1.SEMINYAK', true],
    ['22 OCT - 10.UBUD', true],
    ['22 OCT - 15.UBUD MOTOR', true],
    ['21 OCT - 2.CANGGU', false],
  ]);
});

test('csv keeps a quoted note on the right columns', () => {
  const rows = csvToRows('"LIST PENJUALAN HARIAN - 21 OKTOBER 2026"\n"NO","CUSTOMER","QTY PACK","PESANAN","NOTE"\n"1","Cafe, Bali","2","Gallon","call, then leave"\n');
  assert.equal(rows[0][0], 'LIST PENJUALAN HARIAN - 21 OKTOBER 2026');
  assert.equal(rows[2][1], 'Cafe, Bali');
  assert.equal(rows[2][4], 'call, then leave');
});

test('the printed sheet date is kept apart from the tab name', () => {
  const parsed = parseRouteSheetRows([
    ['LIST PENJUALAN HARIAN - 22 OKTOBER 2026'],
    [null, 'ARMADA: ELF ( DK 8496 HI )'],
    ['NO', 'CUSTOMER', 'QTY PACK', 'PESANAN', 'NOTE'],
    [1, 'Villa One', null, 'Gallon Refill', null],
  ], { sheetName: '21 OCT - 19.PECATU1' });
  assert.equal(parsed.date, '2026-10-21');
  assert.equal(parsed.headerDate, '2026-10-22');
});

test('a longer tab name is not folded into a shorter area', () => {
  assert.equal(fleetNameFromTab(areaFromTabTitle('22 OCT - 1.SEMINYAK')), 'Seminyak');
  assert.equal(fleetNameFromTab(areaFromTabTitle('22 OCT - 15.UBUD MOTOR')), 'UBUD MOTOR');
  assert.equal(fleetNameFromTab(areaFromTabTitle('22 OCT - 10.UBUD')), 'Ubud');
});
