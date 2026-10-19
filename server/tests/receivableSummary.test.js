import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildReceivableSummary, parseSummaryStatuses, receivableSummaryPdf, renderReceivableSummaryPdf,
  sanitizeSummaryFileName, summaryFileName,
} from '../src/services/followUp/receivableSummaryPdf.js';
import { suggestCustomers } from '../src/services/followUp/customerSuggest.js';

const range = { from: '2026-10-01', to: '2026-10-31' };

function invoice(overrides) {
  return {
    invoiceId: '1',
    invoiceNumber: 'INV-SECRET-99',
    customerId: '10',
    customerName: 'Toko Alpha',
    customerPhone: '62812000',
    date: '2026-10-05',
    status: 'sent',
    balance: 1200000,
    currency: 'IDR',
    ...overrides,
  };
}

test('one outstanding total per customer, and one line per invoice', () => {
  const summary = buildReceivableSummary([
    invoice({ invoiceId: '1', customerId: '10', customerName: 'Toko Alpha', balance: 1200000, date: '2026-10-08', invoiceNumber: 'INV-2' }),
    invoice({ invoiceId: '2', customerId: '10', customerName: 'Toko Alpha', balance: 300000, invoiceNumber: 'INV-OTHER', date: '2026-10-02' }),
    invoice({ invoiceId: '3', customerId: '20', customerName: 'Toko Beta', balance: 2000000, invoiceNumber: 'INV-BETA' }),
    invoice({ invoiceId: '4', date: '2026-09-30', customerId: '30', customerName: 'Too Early', balance: 999 }),
    invoice({ invoiceId: '5', date: '2026-11-01', customerId: '31', customerName: 'Too Late', balance: 999 }),
    invoice({ invoiceId: '6', customerId: '32', customerName: 'Toko Zero', balance: 0 }),
    invoice({ invoiceId: '7', customerId: '33', customerName: 'Toko Paid', status: 'paid', balance: 5000 }),
    invoice({ invoiceId: '8', customerId: '34', customerName: 'Toko Draft', status: 'draft', balance: 5000 }),
    invoice({ invoiceId: '9', customerId: '35', customerName: 'Toko USD', currency: 'USD', balance: 5000 }),
    invoice({ invoiceId: '10', customerId: '36', customerName: 'Toko Float', balance: 10.5 }),
  ], range);
  assert.deepEqual(summary.customers.map((row) => row.customerName), ['Toko Beta', 'Toko Alpha']);
  assert.equal(summary.customers[1].total, 1500000);
  assert.equal(summary.grandTotal, 3500000);
  assert.equal(summary.invoiceCount, 3);
  assert.deepEqual(summary.lines.map((line) => line.invoiceNumber), ['INV-OTHER', 'INV-2', 'INV-BETA']);
  assert.equal(summary.lines[0].transactionType, 'Invoice');
});

test('a customer name keeps only that customer', () => {
  const summary = buildReceivableSummary([
    invoice({ customerId: '10', customerName: 'Alit Coppenhagen', balance: 480000 }),
    invoice({ invoiceId: '2', customerId: '20', customerName: 'CMNI Gym', balance: 900000 }),
  ], { ...range, customer: 'coppenhagen' });
  assert.equal(summary.customers.length, 1);
  assert.equal(summary.customers[0].total, 480000);
  assert.equal(summary.grandTotal, 480000);
  assert.equal(summaryFileName(summary.customers, 'coppenhagen'), 'Receivable-Summary-Alit-Coppenhagen.pdf');
  assert.equal(summaryFileName(summary.customers, ''), 'Receivable-Summary.pdf');
});

test('a chosen file name is cleaned and a preview does not write an audit entry', async () => {
  assert.equal(sanitizeSummaryFileName('OMNI Gym Oct 2026'), 'OMNI Gym Oct 2026.pdf');
  assert.equal(sanitizeSummaryFileName('../secret.pdf'), 'secret.pdf');
  assert.equal(sanitizeSummaryFileName('   '), 'Receivable-Summary.pdf');
  const audits = [];
  const preview = await receivableSummaryPdf(
    { role: 'admin', id: 'user-1' },
    env,
    { ...range, customer: 'alpha', fileName: 'Toko Alpha Oct', preview: '1' },
    {
      loadSettings: enabled,
      writeAudit: async (entry) => { audits.push(entry); },
      listUnpaidInvoicesInRange: async () => ({
        truncated: false,
        invoices: [invoice({ balance: 1200000 })],
      }),
    },
  );
  assert.equal(preview.fileName, 'Toko Alpha Oct.pdf');
  assert.equal(preview.preview, true);
  assert.equal(audits.length, 0);
  const downloaded = await receivableSummaryPdf(
    { role: 'admin', id: 'user-1' },
    env,
    { ...range, customer: 'alpha', fileName: 'Toko Alpha Oct' },
    {
      loadSettings: enabled,
      writeAudit: async (entry) => { audits.push(entry); },
      listUnpaidInvoicesInRange: async () => ({
        truncated: false,
        invoices: [invoice({ balance: 1200000 })],
      }),
    },
  );
  assert.equal(downloaded.fileName, 'Toko Alpha Oct.pdf');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].after.fileName, 'Toko Alpha Oct.pdf');
});

function pdfWords(bytes) {
  const parts = [];
  for (const match of bytes.toString('latin1').matchAll(/<([0-9A-Fa-f]+)>/g)) {
    if (match[1].length % 2 === 0) parts.push(Buffer.from(match[1], 'hex').toString('latin1'));
  }
  return parts.join('');
}

test('the PDF lists each invoice in the Zoho receivable summary columns', async () => {
  const summary = buildReceivableSummary([
    invoice({
      balance: 765000,
      invoiceTotal: 765000,
      invoiceNumber: 'INV-075660',
      date: '2026-09-02',
      createdTime: '13/09/2026 05:29 PM',
      status: 'overdue',
      customerName: 'OMNI Gym',
    }),
    invoice({ invoiceId: '2', balance: 300000, invoiceNumber: 'INV-OTHER', date: '2026-09-04' }),
  ], { from: '2026-09-01', to: '2026-09-30' });
  const bytes = await renderReceivableSummaryPdf({
    ...summary, from: '2026-09-01', to: '2026-09-30',
  }, { compress: false });
  const text = pdfWords(bytes);
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.match(text, /Jaan Water/);
  assert.match(text, /Receivable Summary/);
  assert.match(text, /From 01\/09\/2026 To 30\/09\/2026/);
  assert.match(text, /Transaction#/);
  assert.match(text, /Balance \(BCY\)/);
  assert.match(text, /INV-075660/);
  assert.match(text, /Overdue/);
  assert.match(text, /IDR765,000\.00/);
  assert.match(text, /IDR1,065,000\.00/);
});

const env = {
  zoho: {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    dc: 'in',
    organizationId: '10234695',
    refreshToken: 'refresh-token',
  },
};

const enabled = async () => ({ erpFeaturesEnabled: true, zohoRefreshToken: 'refresh-token' });

test('only an accountant or admin can download the summary, and the kill switch blocks it', async () => {
  await assert.rejects(
    () => receivableSummaryPdf({ role: 'delivery', id: '1' }, env, range, { loadSettings: enabled }),
    /accountant or admin/,
  );
  await assert.rejects(
    () => receivableSummaryPdf(
      { role: 'accountant', id: '1' },
      env,
      range,
      { loadSettings: async () => ({ erpFeaturesEnabled: false }) },
    ),
    /turned off/,
  );
});

test('downloading the summary audits the date range, count and integer total', async () => {
  const audits = [];
  const file = await receivableSummaryPdf(
    { role: 'admin', id: 'user-1' },
    env,
    { ...range, customer: 'alpha' },
    {
      loadSettings: enabled,
      writeAudit: async (entry) => { audits.push(entry); },
      listUnpaidInvoicesInRange: async () => ({
        truncated: false,
        invoices: [
          invoice({ balance: 1200000 }),
          invoice({ invoiceId: '2', balance: 300000 }),
          invoice({ invoiceId: '3', customerId: '20', customerName: 'Other Shop', balance: 900000 }),
        ],
      }),
    },
  );
  assert.equal(file.bytes.subarray(0, 5).toString(), '%PDF-');
  assert.equal(file.customerCount, 1);
  assert.equal(file.total, 1500000);
  assert.equal(file.phone, '62812000');
  assert.equal(file.fileName, 'Receivable-Summary-Toko-Alpha.pdf');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'followUp.receivableSummary');
  assert.equal(audits[0].after.invoiceCount, 2);
  assert.equal(audits[0].after.customerCount, 1);
  assert.equal(audits[0].after.total, 1500000);
  assert.equal(audits[0].after.fromDate, '2026-10-01');
  assert.equal(audits[0].after.customer, 'alpha');
});

test('a truncated Zoho list is refused so the total cannot be short', async () => {
  await assert.rejects(
    () => receivableSummaryPdf(
      { role: 'accountant', id: '1' },
      env,
      range,
      {
        loadSettings: enabled,
        listUnpaidInvoicesInRange: async () => ({ truncated: true, invoices: [] }),
        writeAudit: async () => { throw new Error('should not audit a refused summary'); },
      },
    ),
    /Narrow the date range/,
  );
});

test('paid, draft and overdue filters keep the matching invoices', () => {
  assert.deepEqual(parseSummaryStatuses('paid, overdue, secret'), ['paid', 'overdue']);
  const rows = [
    invoice({
      invoiceId: '1', status: 'overdue', dueDate: '2026-10-01', balance: 100000, invoiceNumber: 'INV-OD',
    }),
    invoice({
      invoiceId: '2', status: 'paid', balance: 0, invoiceTotal: 200000, invoiceNumber: 'INV-PAID',
    }),
    invoice({
      invoiceId: '3', status: 'draft', balance: 0, invoiceTotal: 50000, invoiceNumber: 'INV-DRAFT',
    }),
    invoice({
      invoiceId: '4', status: 'sent', dueDate: '2026-12-01', balance: 90000, invoiceNumber: 'INV-SENT',
    }),
  ];
  const overdue = buildReceivableSummary(rows, { ...range, statuses: ['overdue'] });
  assert.deepEqual(overdue.lines.map((line) => line.invoiceNumber), ['INV-OD']);
  const paid = buildReceivableSummary(rows, { ...range, statuses: ['paid'] });
  assert.equal(paid.invoiceCount, 1);
  assert.equal(paid.grandTotal, 200000);
  const mixed = buildReceivableSummary(rows, { ...range, statuses: ['paid', 'draft'] });
  assert.deepEqual(mixed.lines.map((line) => line.invoiceNumber), ['INV-DRAFT', 'INV-PAID']);
});

test('quantity and delivery fee print on the PDF', async () => {
  const summary = buildReceivableSummary([
    invoice({
      status: 'overdue',
      dueDate: '2026-10-01',
      quantity: 12,
      deliveryFee: 15000,
      balance: 144000,
      invoiceTotal: 159000,
      invoiceNumber: 'INV-QTY',
    }),
  ], { ...range, statuses: ['overdue'] });
  const bytes = await renderReceivableSummaryPdf({
    ...summary, from: range.from, to: range.to,
  }, { compress: false });
  const text = pdfWords(bytes);
  assert.match(text, /Quantity/);
  assert.match(text, /Delivery Fee/);
  assert.match(text, /INV-QTY/);
  assert.match(text, /IDR15,000\.00/);
});

test('a chosen customer fills quantity from the invoice JSON', async () => {
  let detailCalls = 0;
  const file = await receivableSummaryPdf(
    { role: 'admin', id: 'user-1' },
    env,
    { ...range, customer: 'alpha', status: 'overdue' },
    {
      loadSettings: enabled,
      writeAudit: async () => {},
      listUnpaidInvoicesInRange: async () => ({
        truncated: false,
        invoices: [invoice({
          status: 'overdue', dueDate: '2026-09-01', quantity: null, deliveryFee: null, balance: 96000,
        })],
      }),
      getInvoiceJson: async () => {
        detailCalls += 1;
        return {
          shipping_charge: 10000,
          line_items: [{ name: 'STILL 330', quantity: 8, item_total: 96000 }],
        };
      },
    },
  );
  assert.equal(detailCalls, 1);
  assert.equal(file.bytes.subarray(0, 5).toString(), '%PDF-');
});

test('customer name suggestions return matching names', async () => {
  const result = await suggestCustomers(
    { role: 'admin', id: '1' },
    env,
    'gym',
    {
      loadSettings: enabled,
      search: async () => [{ customerId: '22', customerName: 'OMNI Gym' }],
    },
  );
  assert.deepEqual(result.customers, [{ customerId: '22', customerName: 'OMNI Gym' }]);
  await assert.rejects(
    () => suggestCustomers({ role: 'staff', id: '1' }, env, 'gym', { loadSettings: enabled }),
    /accountant or admin/,
  );
});
