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

test('glass gallon refill is Rp 50.000 when the sheet harga is blank', () => {
  assert.equal(lookupUnitPrice('Galon Kaca 11L'), 50000);
  assert.equal(lookupUnitPrice('glass gallon refill'), 50000);
});

test('a sheet price read as Rp50,000.00 is shown as Rp 50.000', () => {
  const text = buildRouteWhatsAppMessage(
    { areaName: 'Ungasan', dateLabel: '23/10/2026' },
    [{
      customerName: 'Putu Eka',
      isNewCustomer: true,
      plannedItems: [{ productName: 'Galon Kaca 11L', qty: 1, unitPrice: 5000000 }],
      location: { lat: -8.8291, lng: 115.1634 },
    }],
  );
  assert.match(text, /Galon Kaca 11L x1 Rp 50\.000/);
  assert.doesNotMatch(text, /5\.000\.000/);
  assert.doesNotMatch(text, /Route part|Full route|\*Route map\*/);
  assert.match(text, /^https:\/\/maps\.google\.com\/\?q=-8\.8291%2C115\.1634$/m);
  assert.doesNotMatch(text, /%20/);
  assert.doesNotMatch(text, /🆕/);
  assert.match(text, /NEW/);
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
