import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildReceivableSummary, receivableSummaryPdf, renderReceivableSummaryPdf, sanitizeSummaryFileName,
  summaryFileName,
} from '../src/services/followUp/receivableSummaryPdf.js';

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
