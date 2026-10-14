import assert from 'node:assert/strict';
import test from 'node:test';
import { bestCustomerNameScore, normalizeName, nameSimilarity } from '../src/services/matching/normalizeName.js';
import { matchPayment } from '../src/services/matching/matcher.js';
import BankPayment from '../src/models/BankPayment.js';

test('normalizeName strips titles and punctuation', () => {
  assert.equal(normalizeName('Pt. Tigris Inovatif Solusi'), 'TIGRIS INOVATIF SOLUSI');
  assert.equal(normalizeName('UD Galon Barokah'), 'GALON BAROKAH');
});

test('nameSimilarity scores exact and alias-like names high', () => {
  assert.equal(nameSimilarity('Budi Santoso', 'Budi Santoso'), 1);
  assert.ok(nameSimilarity('Pak Budi', 'Budi Santoso') >= 0.3);
  assert.ok(bestCustomerNameScore('Pak Budi', {
    name: 'Budi Santoso',
    aliases: ['Pak Budi', 'Budi'],
  }) >= 0.82);
});

test('matcher returns high only for strong name and exact remaining amount', async (t) => {
  const originalPaymentFind = BankPayment.find;
  BankPayment.find = () => ({
    select: () => ({
      lean: async () => [],
    }),
  });
  t.after(() => { BankPayment.find = originalPaymentFind; });

  const invoices = [
    {
      invoiceId: 'inv1',
      invoiceNo: 'INV-2026-2010',
      customerId: 'c1',
      customerName: 'Budi Santoso',
      aliases: ['Pak Budi'],
      remaining: 28000,
      dueDate: '2026-09-30',
      date: '2026-09-01',
      status: 'overdue',
    },
    {
      invoiceId: 'inv2',
      invoiceNo: 'INV-OTHER',
      customerId: 'c2',
      customerName: 'Toko Lain',
      aliases: [],
      remaining: 28000,
      dueDate: '2026-09-30',
      date: '2026-09-01',
      status: 'overdue',
    },
  ];

  const high = await matchPayment({
    sender: 'Budi Santoso',
    amount: 28000,
    paidAt: new Date('2026-09-30T07:36:00Z'),
    invoices,
  });
  assert.equal(high.matchConfidence, 'high');
  assert.equal(high.matchType, 'exact');
  assert.equal(String(high.matchedInvoiceId), 'inv1');

  const wrongName = await matchPayment({
    sender: 'Orang Tidak Dikenal',
    amount: 28000,
    paidAt: new Date('2026-09-30T07:36:00Z'),
    invoices,
  });
  assert.notEqual(wrongName.matchConfidence, 'high');
  assert.equal(wrongName.matchedInvoiceId, null);
});

test('partial payment is medium and never high when amount is below remaining', async (t) => {
  const originalPaymentFind = BankPayment.find;
  BankPayment.find = () => ({ select: () => ({ lean: async () => [] }) });
  t.after(() => { BankPayment.find = originalPaymentFind; });

  const result = await matchPayment({
    sender: 'Budi Santoso',
    amount: 40000,
    paidAt: new Date('2026-09-20T10:00:00Z'),
    invoices: [{
      invoiceId: 'inv-partial',
      invoiceNo: 'INV-P',
      customerId: 'c1',
      customerName: 'Budi Santoso',
      aliases: [],
      remaining: 100000,
      dueDate: '2026-09-25',
      date: '2026-09-10',
      status: 'partially_paid',
    }],
  });
  assert.equal(result.matchType, 'partial');
  assert.equal(result.matchConfidence, 'medium');
  assert.equal(String(result.matchedInvoiceId), 'inv-partial');
});
