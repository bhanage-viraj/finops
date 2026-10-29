import assert from 'node:assert/strict';
import test from 'node:test';
import { isSale, summarizeSales, uniqueSales } from '../src/services/zohoInvoices/sales.js';

function invoice(id, date, total, status, customerName, balance = 0) {
  return { invoiceId: id, date, total, status, customerName, balance };
}

function days(month, count, totalEach, status, name) {
  return Array.from({ length: count }, (_, index) => invoice(
    `${month}-${index}`,
    `${month}-${String(index + 1).padStart(2, '0')}`,
    totalEach,
    status,
    name,
    status === 'paid' ? 0 : totalEach,
  ));
}

test('drafts and voids are not sales, and a repeated invoice counts once', () => {
  const rows = [
    invoice('1', '2026-10-02', 100000, 'paid', 'Ibu Made'),
    invoice('1', '2026-10-02', 100000, 'paid', 'Ibu Made'),
    invoice('2', '2026-10-03', 50000, 'draft', 'Villa Ombak'),
    invoice('3', '2026-10-04', 50000, 'void', 'Warung Sari'),
    invoice('4', '2026-10-05', 0, 'paid', 'Toko Budi'),
  ];
  assert.equal(isSale(rows[2]), false);
  assert.equal(uniqueSales(rows).length, 1);
  const summary = summarizeSales(rows);
  assert.equal(summary.invoiceCount, 1);
  assert.equal(summary.total, 100000);
  assert.equal(summary.months[0].channels.home.total, 100000);
});

test('paid and unpaid invoices become one monthly sales total', () => {
  const summary = summarizeSales([
    ...days('2026-02', 20, 1000, 'paid', 'Ibu Made'),
    ...days('2026-07', 22, 5000, 'paid', 'Villa Ombak'),
    invoice('open-1', '2026-10-29', 8000, 'overdue', 'Warung Sari', 8000),
    invoice('depo-1', '2026-10-29', 2000, 'sent', 'Toko Depo Negara', 2000),
  ]);

  const july = summary.months.find((month) => month.month === '2026-07');
  const october = summary.latestMonth;
  assert.equal(july.total, 110000);
  assert.equal(july.channels.hotel.total, 110000);
  assert.equal(july.dailyAverage, 5000);
  assert.equal(october.total, 10000);
  assert.equal(october.open, 10000);
  assert.equal(october.channels.restaurant.total, 8000);
  assert.equal(october.channels.depo.total, 2000);
  assert.equal(summary.season.ready, true);
  assert.equal(summary.season.high.month, '2026-07');
  assert.equal(summary.season.low.month, '2026-02');
  assert.equal(Number.isInteger(summary.total), true);
});
