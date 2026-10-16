import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRupiah, parseQty } from '../src/services/deliveries/money.js';
import {
  parseOrderListRows,
  parseRouteSheetRows,
  parseDeliveryDate,
} from '../src/services/deliveries/sheetParse.js';
import { extractTimeTags } from '../src/services/deliveries/timeTags.js';

test('parseRupiah handles dots and Rp prefix as integer', () => {
  assert.equal(parseRupiah('Rp 49.000').amount, 49000);
  assert.equal(parseRupiah(13200.0).amount, 13200);
  assert.equal(parseRupiah('').missing, true);
  assert.equal(parseRupiah(null).amount, null);
});

test('parseQty never invents 0 from blank', () => {
  assert.equal(parseQty('').missing, true);
  assert.equal(parseQty(null).qty, null);
  assert.equal(parseQty(5).qty, 5);
});

test('parseDeliveryDate reads Indonesian short and long forms', () => {
  assert.equal(parseDeliveryDate('LIST 16 OKT 26'), '2026-10-16');
  assert.equal(parseDeliveryDate('LIST PENJUALAN HARIAN - 16 OKTOBER 2026'), '2026-10-16');
});

test('parseOrderListRows handles blank continuation and letter IDs', () => {
  const rows = [
    ['NO', 'CUSTOMER', 'QTY PACK', 'PESANAN', 'NOTE', 'AREA', 'ALAMAT', 'QTY', 'HARGA'],
    [1, 'Sunny Apart 3', null, 'Gallon Refill', null, null, '84RM+7PH, Canggu, Bali', 7, 12000],
    [null, 'Sunny Apart 3', null, 'Gallon New', null, null, '84RM+7PH, Canggu, Bali', 1, 52000],
    ['A', 'Staff Owen', 3, 'Galon Kaca 11L', 'MINTA PAGI', null, '55W3+5FW Jimbaran', 3, 50000],
    [22, 'Revolver Canggu', null, 'Gallon Refill', null, null, 'Jl nelayan', null, 10000],
  ];
  const { stops } = parseOrderListRows(rows, { sheetName: 'LIST 16 OKT 26' });
  assert.equal(stops.length, 3);
  assert.equal(stops[0].plannedItems.length, 2);
  assert.equal(stops[0].plannedItems[1].productName, 'Gallon New');
  assert.equal(stops[0].location.source, 'plus_code');
  assert.equal(stops[0].location.confidence, 'high');
  assert.equal(stops[1].sourceRow, 'A');
  assert.ok(stops[1].timeTags.includes('kirim_pagi'));
  assert.equal(stops[2].plannedItems[0].qtyMissing, true);
  assert.equal(stops[2].plannedItems[0].qty, null);
});

test('parseRouteSheetRows reads armada drivers and area from tab', () => {
  const rows = [
    [],
    [],
    ['LIST PENJUALAN HARIAN - 16 OKTOBER 2026'],
    [],
    [null, 'ARMADA: ELF ( DK 8619 HJ )', null, null, null, null, true, null, false],
    [null, 'DRIVER: RISKI ADI & KINONG', null, null, 'CANGGU', null, false],
    [],
    ['NO', 'CUSTOMER', 'QTY PACK', 'PESANAN', 'NOTE', 'AREA', 'ALAMAT', 'QTY', 'HARGA'],
    [6, 'Sunny Apart 3', null, 'Gallon Refill', null, null, '84RM+7PH, Canggu', 7, 12000],
  ];
  const parsed = parseRouteSheetRows(rows, { sheetName: '16 OKT - 2.CANGGU' });
  assert.equal(parsed.date, '2026-10-16');
  assert.equal(parsed.area.name, 'Canggu');
  assert.equal(parsed.plate.replace(/\s+/g, ' ').trim().toUpperCase().includes('8619'), true);
  assert.deepEqual(parsed.driverNames, ['RISKI ADI', 'KINONG']);
  assert.equal(parsed.stops.length, 1);
});

test('time tags recognise morning and no-evening notes', () => {
  assert.ok(extractTimeTags('KIRIM PAGIII').includes('kirim_pagi'));
  assert.ok(extractTimeTags('JANGAN DIKIRIM MALAM').includes('jangan_malam'));
  assert.ok(extractTimeTags('PENGIRIMAN BISA DILAKUKAN MULAI JAM 2').includes('mulai_siang'));
});
