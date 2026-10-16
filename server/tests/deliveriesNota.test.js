import test from 'node:test';
import assert from 'node:assert/strict';
import { compareNota, assertNotaExtraction } from '../src/services/deliveries/notaCompare.js';
import { emptiesBalance } from '../src/services/deliveries/notaReader.js';

test('nota compare flags qty more/less, price, missing, returns, total', () => {
  const stop = {
    plannedItems: [
      { productName: 'JAAN 19L', qty: 5, unitPrice: 22000 },
    ],
  };
  const nota = assertNotaExtraction({
    notaNo: 'NPR/JAAN/129942',
    customerName: 'Cathy Yin',
    items: [{ productName: 'JAAN 19L', qty: 6, unitPrice: 22000, total: 132000 }],
    returns: [{ productName: 'GK', qty: 5 }],
    total: 110000,
    paymentNote: 'TF',
  });
  const flags = compareNota(stop, nota);
  assert.ok(flags.includes('qty_more'));
  assert.ok(flags.includes('has_returns'));
  assert.ok(flags.includes('total_mismatch'));
});

test('nota compare flags swapped product', () => {
  const stop = {
    plannedItems: [{ productName: 'Gallon Refill', qty: 10, unitPrice: 12000 }],
  };
  const nota = {
    items: [{ productName: 'Still 750 ml', qty: 12, unitPrice: 16000, total: 192000 }],
    total: 192000,
  };
  const flags = compareNota(stop, nota);
  assert.ok(flags.includes('product_extra'));
  assert.ok(flags.includes('product_missing'));
});

test('assertNotaExtraction forces integer money', () => {
  const nota = assertNotaExtraction({
    items: [{ productName: 'X', qty: 2, unitPrice: '22.000', total: '44.000' }],
    total: '44.000',
  });
  assert.equal(nota.items[0].unitPrice, 22000);
  assert.equal(nota.total, 44000);
});

test('empties balance sums planned gallons vs returns', () => {
  const bal = emptiesBalance([
    {
      plannedItems: [{ productName: 'Gallon Refill', qty: 10 }],
      delivered: { emptiesReturned: 8 },
      ai: { returns: [] },
    },
    {
      plannedItems: [{ productName: 'Gallon New', qty: 2 }],
      confirmed: { returns: [{ productName: 'GK', qty: 2 }] },
    },
  ]);
  assert.equal(bal.plannedGallons, 12);
  assert.equal(bal.emptiesReturned, 10);
  assert.equal(bal.difference, 2);
});
