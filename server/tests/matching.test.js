import assert from 'node:assert/strict';
import test from 'node:test';
import { bestCustomerNameScore, normalizeName, nameSimilarity } from '../src/services/matching/normalizeName.js';
import { matchPayment } from '../src/services/matching/matcher.js';
import Customer from '../src/models/Customer.js';
import Invoice from '../src/models/Invoice.js';
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
  const originalCustomerFind = Customer.find;
  const originalInvoiceFind = Invoice.find;
  const originalPaymentFind = BankPayment.find;

  const customer = {
    _id: 'c1',
    name: 'Budi Santoso',
    aliases: ['Pak Budi'],
  };
  const invoice = {
    _id: 'inv1',
    invoiceNo: 'INV-2026-2010',
    amount: 28000,
    paidAmount: 0,
    status: 'open',
    issueDate: new Date('2026-09-01T00:00:00Z'),
    dueDate: new Date('2026-09-30T00:00:00Z'),
    customerId: customer,
  };
  const other = {
    _id: 'inv2',
    invoiceNo: 'INV-OTHER',
    amount: 28000,
    paidAmount: 0,
    status: 'open',
    issueDate: new Date('2026-09-01T00:00:00Z'),
    dueDate: new Date('2026-09-30T00:00:00Z'),
    customerId: { _id: 'c2', name: 'Toko Lain', aliases: [] },
  };

  Customer.find = () => ({
    lean: async () => [customer, other.customerId],
  });
  Invoice.find = () => ({
    populate: () => ({
      lean: async () => [invoice, other],
    }),
  });
  BankPayment.find = () => ({
    select: () => ({
      lean: async () => [],
    }),
  });

  t.after(() => {
    Customer.find = originalCustomerFind;
    Invoice.find = originalInvoiceFind;
    BankPayment.find = originalPaymentFind;
  });

  const high = await matchPayment({
    sender: 'Budi Santoso',
    amount: 28000,
    paidAt: new Date('2026-09-30T07:36:00Z'),
  });
  assert.equal(high.matchConfidence, 'high');
  assert.equal(high.matchType, 'exact');
  assert.equal(String(high.matchedInvoiceId), 'inv1');

  const wrongName = await matchPayment({
    sender: 'Orang Tidak Dikenal',
    amount: 28000,
    paidAt: new Date('2026-09-30T07:36:00Z'),
  });
  assert.notEqual(wrongName.matchConfidence, 'high');
  assert.equal(wrongName.matchedInvoiceId, null);
});

test('partial payment is medium and never high when amount is below remaining', async (t) => {
  const originalCustomerFind = Customer.find;
  const originalInvoiceFind = Invoice.find;
  const originalPaymentFind = BankPayment.find;

  const customer = { _id: 'c1', name: 'Budi Santoso', aliases: [] };
  const invoice = {
    _id: 'inv-partial',
    invoiceNo: 'INV-P',
    amount: 150000,
    paidAmount: 50000,
    status: 'partial',
    issueDate: new Date('2026-09-10T00:00:00Z'),
    dueDate: new Date('2026-09-25T00:00:00Z'),
    customerId: customer,
  };

  Customer.find = () => ({ lean: async () => [customer] });
  Invoice.find = () => ({ populate: () => ({ lean: async () => [invoice] }) });
  BankPayment.find = () => ({ select: () => ({ lean: async () => [] }) });
  t.after(() => {
    Customer.find = originalCustomerFind;
    Invoice.find = originalInvoiceFind;
    BankPayment.find = originalPaymentFind;
  });

  const result = await matchPayment({
    sender: 'Budi Santoso',
    amount: 40000,
    paidAt: new Date('2026-09-20T10:00:00Z'),
  });
  assert.equal(result.matchType, 'partial');
  assert.equal(result.matchConfidence, 'medium');
  assert.equal(String(result.matchedInvoiceId), 'inv-partial');
});
