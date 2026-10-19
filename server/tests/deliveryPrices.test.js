import test from 'node:test';
import assert from 'node:assert/strict';
import { applyListPrices, lookupUnitPrice } from '../src/services/deliveries/priceList.js';
import { buildRouteWhatsAppMessage } from '../src/services/deliveries/whatsappMessage.js';

test('standard B2B prices match the delivery price sheet', () => {
  assert.equal(lookupUnitPrice('STILL 330 mL'), 12000);
  assert.equal(lookupUnitPrice('STILL 750'), 16000);
  assert.equal(lookupUnitPrice('SPARKLING 330'), 13000);
  assert.equal(lookupUnitPrice('SPARKLING 750 mL'), 18000);
  assert.equal(lookupUnitPrice('FLASK 330'), 10000);
  assert.equal(lookupUnitPrice('CANS STILL 250'), 9000);
  assert.equal(lookupUnitPrice('CANS-STILL 330'), 11000);
  assert.equal(lookupUnitPrice('CANS STILL 500'), 14000);
  assert.equal(lookupUnitPrice('CANS SPARKLING 250'), 10000);
  assert.equal(lookupUnitPrice('CANS-SPARKLING 330'), 12000);
  assert.equal(lookupUnitPrice('CANS SPARKLING 500'), 15000);
  assert.equal(lookupUnitPrice('Ice Tube 5 Kg'), 8000);
  assert.equal(lookupUnitPrice('Ice Cube 5 Kg'), 8000);
});

test('a harga already on the line is kept', () => {
  const [item] = applyListPrices([{ productName: 'STILL 330', qty: 2, unitPrice: 9000 }]);
  assert.equal(item.unitPrice, 9000);
});

test('a blank harga is filled from the list, and unknown products stay blank', () => {
  const [still, gallon] = applyListPrices([
    { productName: 'STILL 330', qty: 1, unitPrice: null },
    { productName: 'Gallon Refill', qty: 1, unitPrice: null },
  ]);
  assert.equal(still.unitPrice, 12000);
  assert.equal(gallon.unitPrice, null);
});

test('driver WhatsApp line includes the price', () => {
  const text = buildRouteWhatsAppMessage(
    { areaName: 'Canggu', dateLabel: '16/10/2026' },
    [{
      customerName: 'Sample Villa',
      plannedItems: [{ productName: 'STILL 750', qty: 2, unitPrice: null }],
      location: {},
    }],
  );
  assert.match(text, /STILL 750 x2 Rp 16\.000/);
});
