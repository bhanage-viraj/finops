import assert from 'node:assert/strict';
import test from 'node:test';
import BankPayment from '../src/models/BankPayment.js';
import { clearZohoTokenCache, createCustomerPayment } from '../src/integrations/erp/zohoBooks.js';
import { allocateOldestFirst, findExactSet } from '../src/services/matching/allocate.js';
import { matchPayment } from '../src/services/matching/matcher.js';
import { resolveDateRange } from '../src/services/payments/captionHints.js';
import { applyCorrectedAmount, splitOver } from '../src/services/payments/paymentService.js';

function noDuplicates(t) {
  const original = BankPayment.find;
  BankPayment.find = () => ({ select: () => ({ lean: async () => [] }) });
  t.after(() => { BankPayment.find = original; });
}

// Fake shop with one delivery invoice per day; 28–30 Sept add up to Rp9.438.800.
function fishMarketInvoices() {
  const rows = [
    ['2001', 'INV-090001', '2026-09-26', 3000000],
    ['2002', 'INV-090002', '2026-09-27', 2950000],
    ['2003', 'INV-090003', '2026-09-28', 3146000],
    ['2004', 'INV-090004', '2026-09-29', 3146400],
    ['2005', 'INV-090005', '2026-09-30', 3146400],
    ['2006', 'INV-090006', '2026-10-01', 2500000],
  ];
  return rows.map(([invoiceId, invoiceNo, date, remaining]) => ({
    invoiceId,
    invoiceNo,
    customerId: 'c-fish',
    customerName: 'Contoh Fish Market',
    aliases: [],
    remaining,
    date,
    dueDate: date,
    status: 'overdue',
  }));
}

const PAID_AT = new Date('2026-10-01T22:04:43Z');

test('the transfer remark range picks every invoice in it when the total matches', async (t) => {
  noDuplicates(t);
  const range = resolveDateRange('Jaan Mineral Water - Sept 28-30', PAID_AT);
  const result = await matchPayment({
    sender: 'CONTOH IKAN SEGAR',
    customerName: 'contoh fish market',
    invoiceDateRange: range,
    amount: 9438800,
    paidAt: PAID_AT,
    invoices: fishMarketInvoices(),
  });
  assert.equal(result.matchConfidence, 'high');
  assert.equal(result.matchType, 'exact');
  assert.deepEqual(result.allocations.map((row) => row.invoiceNo), ['INV-090003', 'INV-090004', 'INV-090005']);
  assert.deepEqual(result.allocations.map((row) => row.applied), [3146000, 3146400, 3146400]);
  assert.equal(result.matchedInvoiceId, '2003');
});

test('without dates, a transfer that clears everything due by the transfer day is high', async (t) => {
  noDuplicates(t);
  const invoices = fishMarketInvoices();
  const total = invoices.reduce((sum, inv) => sum + inv.remaining, 0);
  const result = await matchPayment({
    customerName: 'Contoh Fish Market',
    amount: total,
    paidAt: PAID_AT,
    invoices,
  });
  assert.equal(result.matchConfidence, 'high');
  assert.equal(result.allocations.length, 6);
  assert.equal(result.matchType, 'exact');
});

test('an exact total of only the oldest invoices is suggested at medium', async (t) => {
  noDuplicates(t);
  const result = await matchPayment({
    customerName: 'Contoh Fish Market',
    amount: 3000000 + 2950000,
    paidAt: PAID_AT,
    invoices: fishMarketInvoices(),
  });
  assert.equal(result.matchConfidence, 'medium');
  assert.deepEqual(result.allocations.map((row) => row.invoiceNo), ['INV-090001', 'INV-090002']);
});

test('a total that matches no set pays oldest first and the last one partly', async (t) => {
  noDuplicates(t);
  const result = await matchPayment({
    customerName: 'Contoh Fish Market',
    amount: 7000000,
    paidAt: PAID_AT,
    invoices: fishMarketInvoices(),
  });
  assert.equal(result.matchConfidence, 'medium');
  assert.equal(result.matchType, 'partial');
  assert.deepEqual(result.allocations.map((row) => [row.invoiceNo, row.applied]), [
    ['INV-090001', 3000000],
    ['INV-090002', 2950000],
    ['INV-090003', 1050000],
  ]);
  const applied = result.allocations.reduce((sum, row) => sum + row.applied, 0);
  assert.equal(applied, 7000000);
});

test('more than everything due leaves the extra as credit, never applied', async (t) => {
  noDuplicates(t);
  const invoices = fishMarketInvoices();
  const total = invoices.reduce((sum, inv) => sum + inv.remaining, 0);
  const result = await matchPayment({
    customerName: 'Contoh Fish Market',
    amount: total + 1000000,
    paidAt: PAID_AT,
    invoices,
  });
  assert.equal(result.matchType, 'over');
  assert.notEqual(result.matchConfidence, 'high');
  const applied = result.allocations.reduce((sum, row) => sum + row.applied, 0);
  assert.equal(applied, total);
});

test('invoices dated after the transfer are not used for an oldest-first split', async (t) => {
  noDuplicates(t);
  const invoices = [...fishMarketInvoices(), {
    ...fishMarketInvoices()[0], invoiceId: '2099', invoiceNo: 'INV-090099', date: '2026-10-05', dueDate: '2026-10-05',
  }];
  const result = await matchPayment({
    customerName: 'Contoh Fish Market',
    amount: 100000000,
    paidAt: PAID_AT,
    invoices,
  });
  assert.ok(!result.allocations.some((row) => row.invoiceNo === 'INV-090099'));
});

test('a near-identical second customer keeps a multi-invoice match below high', async (t) => {
  noDuplicates(t);
  const twin = fishMarketInvoices().map((inv) => ({
    ...inv, invoiceId: `9${inv.invoiceId}`, customerId: 'c-fish-2', customerName: 'Contoh Fish Market.',
  }));
  const result = await matchPayment({
    customerName: 'Contoh Fish Market',
    invoiceDateRange: { from: '2026-09-28', to: '2026-09-30' },
    amount: 9438800,
    paidAt: PAID_AT,
    invoices: [...fishMarketInvoices(), ...twin],
  });
  assert.equal(result.matchConfidence, 'medium');
});

test('allocation never applies more than the transfer or more than a balance', () => {
  const { allocations, applied, excess } = allocateOldestFirst(5000000, fishMarketInvoices());
  assert.equal(applied + excess, 5000000);
  for (const row of allocations) assert.ok(row.applied <= row.remaining);
  assert.equal(findExactSet(1, fishMarketInvoices()), null);
  // A non-adjacent pair still adds up.
  const pair = findExactSet(3000000 + 2500000, fishMarketInvoices());
  assert.deepEqual(pair.invoices.map((row) => row.invoiceNo), ['INV-090001', 'INV-090006']);
  assert.equal(pair.prefix, false);
});

test('recording splits ticked invoices: full total pays all, a short total stays partial', () => {
  const rows = fishMarketInvoices().slice(2, 5).map(({ invoiceId, invoiceNo, remaining, date, dueDate }) => ({
    invoiceId, invoiceNo, remaining, date, dueDate,
  }));
  const full = splitOver({ ai: { amount: 9438800 }, confirmed: {} }, rows);
  assert.equal(full.matchType, 'exact');
  assert.deepEqual(full.allocations.map((row) => row.applied), [3146000, 3146400, 3146400]);

  const withFee = splitOver({ ai: { amount: 9441300 }, confirmed: {} }, rows);
  assert.equal(withFee.bankFee, 2500);
  assert.equal(withFee.matchType, 'exact');

  const short = splitOver({ ai: { amount: 4000000 }, confirmed: {} }, rows);
  assert.equal(short.matchType, 'partial');
  assert.deepEqual(short.allocations.map((row) => row.applied), [3146000, 854000, 0]);

  // A typed amount is the person's value: no fee is guessed from it.
  const typed = splitOver({ ai: { amount: 1 }, confirmed: { amount: 9441300 } }, rows);
  assert.equal(typed.bankFee, 0);
  assert.equal(typed.matchType, 'over');
});

test('a corrected transfer amount keeps the screenshot reading and resplits the chosen invoices', () => {
  const rows = fishMarketInvoices().slice(2, 5);
  const payment = {
    ai: { amount: 9441300, adminFee: 2500, total: 9441300 },
    confirmed: { amount: 4000000 },
    bankFee: 2500,
    status: 'verified',
    statementVerified: true,
    zohoInvoiceId: '2003',
    matchReasons: ['Old match.'],
    allocations: rows.map((row) => ({
      invoiceId: row.invoiceId,
      invoiceNumber: row.invoiceNo,
      remaining: row.remaining,
      applied: row.remaining,
      date: row.date,
      dueDate: row.dueDate,
      customerId: 'c-fish',
      customerName: 'Contoh Fish Market',
    })),
  };

  assert.equal(applyCorrectedAmount(payment), true);
  assert.equal(payment.ai.amount, 9441300);
  assert.equal(payment.ai.adminFee, 2500);
  assert.equal(payment.ai.total, 9441300);
  assert.equal(payment.confirmed.amount, 4000000);
  assert.equal(payment.bankFee, 0);
  assert.equal(payment.matchType, 'partial');
  assert.equal(payment.status, 'verified');
  const applied = payment.allocations.reduce((sum, row) => sum + row.applied, 0);
  assert.equal(applied, 4000000);
  assert.equal(payment.matchReasons[0].replace(/\D/g, ''), '4000000');
  assert.equal(payment.matchReasons[1], 'Old match.');

  payment.confirmed.amount = null;
  assert.equal(applyCorrectedAmount(payment), true);
  assert.equal(payment.ai.amount, 9441300);
  assert.equal(payment.bankFee, 2500);
  assert.equal(payment.matchType, 'exact');
  const restored = payment.allocations.reduce((sum, row) => sum + row.applied, 0);
  assert.equal(restored, 9438800);
  assert.match(payment.matchReasons[0], /^Amount set back/);

  const empty = { ai: { amount: 1000 }, confirmed: { amount: 2000 }, allocations: [] };
  assert.equal(applyCorrectedAmount(empty), false);
  assert.equal(empty.ai.amount, 1000);
  assert.equal(empty.confirmed.amount, 2000);
});

test('one Zoho customer payment carries every invoice line and refuses bad totals', async () => {
  clearZohoTokenCache();
  const zoho = {
    clientId: 'client-id', clientSecret: 'client-secret', dc: 'in', organizationId: '10234695', refreshToken: 'r',
  };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body });
    if (String(url).includes('/oauth/v2/token')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'a', expires_in: 3600 }) };
    }
    return { ok: true, status: 201, text: async () => JSON.stringify({ code: 0, payment: { payment_id: '982000000999' } }) };
  };
  const base = {
    customerId: '982000000001', date: '2026-10-01', accountId: '982000000567250', paymentMode: 'Bank Transfer',
  };
  await createCustomerPayment({
    zoho,
    refreshToken: 'r',
    fetchImpl,
    payment: {
      ...base,
      amount: 9438800,
      invoices: [
        { invoiceId: '982000000003', amountApplied: 3146000 },
        { invoiceId: '982000000004', amountApplied: 3146400 },
        { invoiceId: '982000000005', amountApplied: 3146400 },
      ],
    },
  });
  const body = JSON.parse(calls.find((c) => c.url.includes('/customerpayments')).body);
  assert.equal(body.amount, 9438800);
  assert.deepEqual(body.invoices.map((line) => line.amount_applied), [3146000, 3146400, 3146400]);

  await assert.rejects(() => createCustomerPayment({
    zoho, refreshToken: 'r', fetchImpl,
    payment: { ...base, amount: 100, invoices: [{ invoiceId: '1', amountApplied: 60 }, { invoiceId: '2', amountApplied: 60 }] },
  }), /cannot exceed/);
  await assert.rejects(() => createCustomerPayment({
    zoho, refreshToken: 'r', fetchImpl,
    payment: { ...base, amount: 100, invoices: [{ invoiceId: '1', amountApplied: 50 }, { invoiceId: '1', amountApplied: 50 }] },
  }), /twice/);
});
