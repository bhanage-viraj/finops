import test from 'node:test';
import assert from 'node:assert/strict';
import { spreadsheetIdFromUrl, sheetTabsFromHtml, selectTabsForDate } from '../src/services/deliveries/googleSheet.js';
import { areaFromTabTitle, fleetNameFromTab } from '../src/services/deliveries/areaCatalog.js';

const HTML = `
items.push({name: "22 OCT - 1.SEMINYAK ", pageUrl: "gid=1", gid: "11"});
items.push({name: "21 OCT - 2.CANGGU", pageUrl: "gid=2", gid: "22"});
items.push({name: "22 OCT - 15.UBUD MOTOR", pageUrl: "gid=3", gid: "33"});
items.push({name: "22 OCT - 10.UBUD", pageUrl: "gid=4", gid: "44"});
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

test('a longer tab name is not folded into a shorter area', () => {
  assert.equal(fleetNameFromTab(areaFromTabTitle('22 OCT - 1.SEMINYAK')), 'Seminyak');
  assert.equal(fleetNameFromTab(areaFromTabTitle('22 OCT - 15.UBUD MOTOR')), 'UBUD MOTOR');
  assert.equal(fleetNameFromTab(areaFromTabTitle('22 OCT - 10.UBUD')), 'Ubud');
});
