import assert from 'node:assert/strict';
import test from 'node:test';
import BankPayment from '../src/models/BankPayment.js';
import { classifyAmountFit, matchPayment } from '../src/services/matching/matcher.js';
import { nameSimilarity } from '../src/services/matching/normalizeName.js';
import { STRONG_NAME } from '../src/services/matching/rules.js';
import { assertPaymentExtraction } from '../src/services/ai/schemas.js';
import { resolveCaptionDate, splitCaption } from '../src/services/payments/captionHints.js';
import {
  MULTI_CUSTOMER_EXCESS, customerSearchRank, groupNameRank, parseInvoiceNumbers, planZohoPayments, selectOpenInvoices,
} from '../src/services/payments/paymentService.js';

function noDuplicates(t) {
  const original = BankPayment.find;
  BankPayment.find = () => ({ select: () => ({ lean: async () => [] }) });
  t.after(() => { BankPayment.find = original; });
}

// Mirrors the Zoho "Unpaid Invoices" list for one shop: five invoices share Rp480.000.
function sariBogaInvoices() {
  const rows = [
    ['1001', 'INV-076716', '2026-09-18', '2026-09-22', 1230000],
    ['1002', 'INV-077657', '2026-09-21', '2026-09-29', 480000],
    ['1003', 'INV-079837', '2026-09-29', '2026-10-07', 480000],
    ['1004', 'INV-079955', '2026-09-29', '2026-10-08', 480000],
    ['1005', 'INV-080207', '2026-09-30', '2026-10-09', 480000],
    ['1006', 'INV-081117', '2026-10-03', '2026-10-14', 480000],
    ['1007', 'INV-082317', '2026-10-14', '2026-10-18', 540000],
  ];
  return rows.map(([invoiceId, invoiceNo, date, dueDate, remaining]) => ({
    invoiceId,
    invoiceNo,
    customerId: 'c-sariboga',
    customerName: 'Toko Sari Boga',
    aliases: [],
    remaining,
    date,
    dueDate,
    status: 'sent',
  }));
}

const PAID_AT = new Date('2026-09-29T14:28:56Z');

test('WhatsApp spelling and Zoho spelling of the same shop score as a strong match', () => {
  assert.ok(nameSimilarity('Toko Sariboga', 'Toko Sari Boga') >= STRONG_NAME);
  assert.ok(nameSimilarity('Sariboga', 'TOKO SARI BOGA') >= STRONG_NAME);
  assert.ok(nameSimilarity('Toko Sariboga', 'Toko Sari Rasa') < STRONG_NAME);
  assert.ok(nameSimilarity('Toko Sariboga', 'Warung Sari Boga Jaya') < STRONG_NAME);
});

test('a small amount above the balance is a bank fee, a large one is an overpayment', () => {
  assert.deepEqual(classifyAmountFit(482500, 480000), { amountType: 'exact', fit: 'fee', bankFee: 2500 });
  assert.equal(classifyAmountFit(490000, 480000).fit, 'over');
  assert.equal(classifyAmountFit(482500, 480000, { allowFee: false }).fit, 'over');
  assert.equal(classifyAmountFit(477500, 480000).fit, 'partial');
});

test('caption date picks the 29/09 invoices and the oldest of the tie, never high', async (t) => {
  noDuplicates(t);
  const result = await matchPayment({
    sender: 'DEWA KETUT WISMAJA PUTRA',
    customerName: 'Toko Sariboga',
    invoiceDateHint: '2026-09-29',
    amount: 480000,
    paidAt: PAID_AT,
    invoices: sariBogaInvoices(),
  });
  assert.equal(result.matchedInvoiceId, '1003');
  assert.equal(result.matchConfidence, 'medium');
  assert.equal(result.bankFee, 0);
  // All the shop's open invoices come back oldest first for a one-tap switch.
  assert.deepEqual(result.candidates.map((c) => c.invoiceNo), [
    'INV-076716', 'INV-077657', 'INV-079837', 'INV-079955', 'INV-080207', 'INV-081117', 'INV-082317',
  ]);
});

test('without a caption date the oldest same-amount invoice is suggested at medium', async (t) => {
  noDuplicates(t);
  const result = await matchPayment({
    customerName: 'Toko Sariboga',
    amount: 480000,
    paidAt: PAID_AT,
    invoices: sariBogaInvoices(),
  });
  assert.equal(result.matchedInvoiceId, '1002');
  assert.equal(result.matchConfidence, 'medium');
});

test('a caption date that leaves one invoice is high', async (t) => {
  noDuplicates(t);
  const result = await matchPayment({
    customerName: 'Toko Sariboga',
    invoiceDateHint: '2026-09-30',
    amount: 480000,
    paidAt: PAID_AT,
    invoices: sariBogaInvoices(),
  });
  assert.equal(result.matchedInvoiceId, '1005');
  assert.equal(result.matchConfidence, 'high');
});

test('total read with the admin fee still matches and records only the invoice amount', async (t) => {
  noDuplicates(t);
  const invoices = sariBogaInvoices().filter((inv) => inv.invoiceNo === 'INV-080207');
  const explained = await matchPayment({
    customerName: 'Toko Sariboga',
    amount: 482500,
    adminFee: 2500,
    paidAt: PAID_AT,
    invoices,
  });
  assert.equal(explained.matchedInvoiceId, '1005');
  assert.equal(explained.matchType, 'exact');
  assert.equal(explained.bankFee, 2500);
  assert.equal(explained.matchConfidence, 'high');

  const unexplained = await matchPayment({
    customerName: 'Toko Sariboga',
    amount: 482500,
    paidAt: PAID_AT,
    invoices,
  });
  assert.equal(unexplained.bankFee, 2500);
  assert.equal(unexplained.matchConfidence, 'medium');
});

test('an exact balance beats a fee-sized gap for the same customer', async (t) => {
  noDuplicates(t);
  const invoices = [
    { ...sariBogaInvoices()[1], invoiceId: 'a', remaining: 480000 },
    { ...sariBogaInvoices()[2], invoiceId: 'b', remaining: 482500 },
  ];
  const result = await matchPayment({
    customerName: 'Toko Sariboga',
    amount: 482500,
    paidAt: PAID_AT,
    invoices,
  });
  assert.equal(result.matchedInvoiceId, 'b');
  assert.equal(result.bankFee, 0);
});

test('a different shop with the same amount is never returned as high', async (t) => {
  noDuplicates(t);
  const result = await matchPayment({
    customerName: 'Toko Sariboga',
    amount: 480000,
    paidAt: PAID_AT,
    invoices: [{
      invoiceId: 'x1',
      invoiceNo: 'INV-1',
      customerId: 'c-other',
      customerName: 'Toko Sari Rasa',
      remaining: 480000,
      date: '2026-09-29',
      dueDate: '2026-10-07',
    }],
  });
  assert.notEqual(result.matchConfidence, 'high');
});

test('AI extraction uses Nominal, and takes the admin fee off when only the total was read', () => {
  const nominal = assertPaymentExtraction({
    sender: 'DEWA', amount: 'Rp480.000', adminFee: 'Rp2.500', total: 'Rp482.500', paidAt: null, reference: null, confidence: 90,
  });
  assert.equal(nominal.amount, 480000);
  assert.equal(nominal.adminFee, 2500);
  assert.equal(nominal.total, 482500);

  const totalOnly = assertPaymentExtraction({
    sender: 'DEWA', amount: null, adminFee: 'Rp2.500', total: 'Rp482.500', paidAt: null, reference: null, confidence: 90,
  });
  assert.equal(totalOnly.amount, 480000);

  const totalAsAmount = assertPaymentExtraction({
    sender: 'DEWA', amount: 'Rp482.500', adminFee: 'Rp2.500', total: 'Rp482.500', paidAt: null, reference: null, confidence: 90,
  });
  assert.equal(totalAsAmount.amount, 480000);
});

test('WhatsApp caption splits into name, day/month and invoice number', () => {
  assert.deepEqual(splitCaption('Toko Sariboga 29.9'), { name: 'Toko Sariboga', dateText: '29.9', invoiceNo: null });
  assert.deepEqual(splitCaption('Toko Sariboga INV 079837'), { name: 'Toko Sariboga', dateText: null, invoiceNo: 'INV-079837' });
  assert.equal(splitCaption('2Moods Resto').name, '2Moods Resto');
});

test('caption day/month resolves to a date near the transfer', () => {
  assert.equal(resolveCaptionDate('29.9', PAID_AT), '2026-09-29');
  assert.equal(resolveCaptionDate('21/09', PAID_AT), '2026-09-21');
  assert.equal(resolveCaptionDate('2.10', PAID_AT), '2026-10-02');
  assert.equal(resolveCaptionDate('31.12', new Date('2026-01-02T00:00:00Z')), '2025-12-31');
  assert.equal(resolveCaptionDate('31.2', PAID_AT), null);
  assert.equal(resolveCaptionDate('', PAID_AT), null);
});

test('invoice search finds Zoho spelling from the WhatsApp spelling', () => {
  assert.equal(customerSearchRank('Toko Sariboga', 'Toko Sari Boga'), 0);
  assert.equal(customerSearchRank('sari', 'Toko Sari Boga'), 0);
  assert.equal(customerSearchRank('boga', 'Toko Sari Boga'), 1);
  assert.equal(customerSearchRank('toko', 'Toko Sari Boga'), 0);
  assert.equal(customerSearchRank('Budi', 'Toko Sari Boga'), null);
});

test('open-invoice list by customerId returns every unpaid invoice, not only amount matches', () => {
  const rows = [
    ...sariBogaInvoices().map((inv) => ({
      id: inv.invoiceId,
      invoiceNo: inv.invoiceNo,
      remaining: inv.remaining,
      date: inv.date,
      dueDate: inv.dueDate,
      customerName: inv.customerName,
      erpCustomerId: inv.customerId,
    })),
    {
      id: 'other',
      invoiceNo: 'INV-OTHER',
      remaining: 480000,
      date: '2026-09-21',
      dueDate: '2026-09-29',
      customerName: 'Toko Lain',
      erpCustomerId: 'c-other',
    },
  ];
  const forCustomer = selectOpenInvoices(rows, '', { customerId: 'c-sariboga' });
  assert.deepEqual(forCustomer.map((row) => row.invoiceNo), [
    'INV-076716', 'INV-077657', 'INV-079837', 'INV-079955', 'INV-080207', 'INV-081117', 'INV-082317',
  ]);
  // Same transfer amount appears on several invoices — all of them stay listed.
  assert.equal(forCustomer.filter((row) => row.remaining === 480000).length, 5);
});

test('invoice numbers find unpaid invoices without the villa customer name', () => {
  assert.deepEqual(parseInvoiceNumbers('INV-079837 INV-079955'), ['INV-079837', 'INV-079955']);
  const rows = [
    ...sariBogaInvoices().map((inv) => ({
      id: inv.invoiceId,
      invoiceNo: inv.invoiceNo,
      remaining: inv.remaining,
      date: inv.date,
      dueDate: inv.dueDate,
      customerName: inv.customerName,
      erpCustomerId: inv.customerId,
    })),
    {
      id: 'villa',
      invoiceNo: 'INV-088001',
      remaining: 200000,
      date: '2026-10-01',
      dueDate: '2026-10-08',
      customerName: 'Balinest Villa Kristi',
      erpCustomerId: 'c-kristi',
    },
  ];
  const byNumber = selectOpenInvoices(rows, 'INV-079837');
  assert.equal(byNumber[0].invoiceNo, 'INV-079837');
  const pasted = selectOpenInvoices(rows, 'INV-079837 INV-088001');
  assert.deepEqual(pasted.map((row) => row.invoiceNo).sort(), ['INV-079837', 'INV-088001']);
});

test('a group name lists every villa, and the date range drops the rest', () => {
  assert.equal(groupNameRank('AN Balinest', 'Balinest Villa Kristi'), 0);
  assert.equal(groupNameRank('AN Balinest', 'Toko Sari Boga'), null);
  const rows = [
    {
      id: '1', invoiceNo: 'INV-1', remaining: 100000, date: '2026-10-02',
      customerName: 'Balinest Villa Kristi', erpCustomerId: 'c1',
    },
    {
      id: '2', invoiceNo: 'INV-2', remaining: 200000, date: '2026-10-03',
      customerName: 'Balinest Villa Ubud', erpCustomerId: 'c2',
    },
    {
      id: '3', invoiceNo: 'INV-3', remaining: 300000, date: '2026-09-01',
      customerName: 'Balinest Villa Ubud', erpCustomerId: 'c2',
    },
    {
      id: '4', invoiceNo: 'INV-4', remaining: 400000, date: '2026-10-02',
      customerName: 'Toko Sari Boga', erpCustomerId: 'c3',
    },
  ];
  const found = selectOpenInvoices(rows, 'AN Balinest');
  assert.deepEqual(found.map((row) => row.invoiceNo).sort(), ['INV-1', 'INV-2', 'INV-3']);
  const october = selectOpenInvoices(rows, 'AN Balinest', { fromDate: '2026-10-01', toDate: '2026-10-31' });
  assert.deepEqual(october.map((row) => row.invoiceNo).sort(), ['INV-1', 'INV-2']);
  const oneVilla = selectOpenInvoices(rows, '', { customerId: 'c2', fromDate: '2026-10-01', toDate: '2026-10-31' });
  assert.deepEqual(oneVilla.map((row) => row.invoiceNo), ['INV-2']);
});

test('several villas record as one Zoho payment each, and extra cannot sit on all of them', () => {
  const exact = planZohoPayments([
    { invoiceId: '1', applied: 100000, customerId: '10' },
    { invoiceId: '2', applied: 50000, customerId: '20' },
  ], { received: 150000 });
  assert.equal(exact.error, undefined);
  assert.deepEqual(exact.groups.map((group) => [group.customerId, group.amount]), [['10', 100000], ['20', 50000]]);

  const one = planZohoPayments([
    { invoiceId: '1', applied: 100000, customerId: '' },
  ], { received: 150000, fallbackCustomerId: '55' });
  assert.equal(one.groups.length, 1);
  assert.equal(one.groups[0].customerId, '55');
  assert.equal(one.groups[0].amount, 150000);

  const extra = planZohoPayments([
    { invoiceId: '1', applied: 100000, customerId: '10' },
    { invoiceId: '2', applied: 50000, customerId: '20' },
  ], { received: 200000 });
  assert.equal(extra.error, MULTI_CUSTOMER_EXCESS);
});
