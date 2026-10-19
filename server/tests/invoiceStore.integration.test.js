import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import Setting from '../src/models/Setting.js';
import ZohoInvoice from '../src/models/ZohoInvoice.js';
import ZohoSyncState from '../src/models/ZohoSyncState.js';
import { clearZohoTokenCache } from '../src/integrations/erp/zohoBooks.js';
import {
  openInvoicesForCustomer, openInvoicesForMatching, overdueInvoicesFromStore, refreshCustomerInvoices,
  resetInvoiceStoreMemory, runInvoiceSync, setInvoiceStoreModels, unpaidInvoicesInRange,
} from '../src/services/zohoInvoices/invoiceStore.js';

const uri = 'mongodb://127.0.0.1:27017/finops_zoho_invoices_test';
const zoho = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  dc: 'in',
  organizationId: '10234695',
  refreshToken: 'refresh-token',
};
const env = { zoho };

function tokenResponse() {
  return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'access-1', expires_in: 3600 }) };
}

function row(overrides = {}) {
  return {
    invoice_id: '101',
    invoice_number: 'INV-101',
    customer_id: '11',
    customer_name: 'Patrice',
    date: '2026-09-01',
    due_date: '2026-09-10',
    status: 'overdue',
    total: 300000,
    balance: 300000,
    currency_code: 'IDR',
    last_modified_time: '2026-10-19T10:15:00+0800',
    ...overrides,
  };
}

function pages(filterToRows) {
  return async (url) => {
    if (String(url).includes('/oauth/v2/token')) return tokenResponse();
    const params = new URL(String(url)).searchParams;
    const invoices = filterToRows(params);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, invoices, page_context: { has_more_page: false } }),
    };
  };
}

const deps = (fetchImpl) => ({ fetchImpl, sleep: async () => {}, pauseMs: 0 });

async function withStore(t, run) {
  const conn = await mongoose.createConnection(uri).asPromise();
  await conn.dropDatabase();
  const Invoice = conn.model('ZohoInvoice', ZohoInvoice.schema);
  const Settings = conn.model('Setting', Setting.schema);
  resetInvoiceStoreMemory();
  setInvoiceStoreModels({
    invoice: Invoice,
    syncState: conn.model('ZohoSyncState', ZohoSyncState.schema),
    setting: Settings,
  });
  t.after(async () => {
    resetInvoiceStoreMemory();
    await conn.dropDatabase();
    await conn.close();
  });
  await Settings.create({ erpFeaturesEnabled: true, zohoRefreshToken: zoho.refreshToken });
  clearZohoTokenCache();
  await run({ Invoice, conn });
}

test('full sync stores every unpaid invoice and closes ones Zoho no longer returns', async (t) => {
  await withStore(t, async ({ Invoice }) => {
    await Invoice.create({
      invoiceId: '999', invoiceNumber: 'INV-OLD', customerId: '11', customerName: 'Patrice',
      date: '2026-08-01', dueDate: '2026-08-10', status: 'overdue', total: 1000, balance: 1000, open: true,
      lastSeenAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    const fetchImpl = pages((params) => {
      assert.equal(params.get('status'), 'unpaid');
      return [
        row(),
        row({ invoice_id: '102', invoice_number: 'INV-102', balance: 150000, total: 150000 }),
        row({ invoice_id: '103', invoice_number: 'INV-103', date: '2026-10-01', due_date: '2026-10-20', status: 'sent' }),
      ];
    });
    const result = await runInvoiceSync('full', env, { refreshToken: zoho.refreshToken }, deps(fetchImpl));
    assert.equal(result.kind, 'full');
    assert.equal(result.truncated, false);
    assert.equal(result.open, 3);

    const matching = await openInvoicesForMatching();
    assert.deepEqual(matching.map((invoice) => invoice.invoiceNo).sort(), ['INV-101', 'INV-102', 'INV-103']);
    const old = await Invoice.findOne({ invoiceId: '999' }).lean();
    assert.equal(old.open, false);

    const overdue = await overdueInvoicesFromStore(new Date('2026-10-13T00:00:00.000Z'));
    assert.equal(overdue.truncated, false);
    assert.deepEqual(overdue.invoices.map((invoice) => invoice.invoiceNumber).sort(), ['INV-101', 'INV-102']);

    const range = await unpaidInvoicesInRange({ fromDate: '2026-09-01', toDate: '2026-09-30' });
    assert.deepEqual(range.invoices.map((invoice) => invoice.invoiceNumber).sort(), ['INV-101', 'INV-102']);
  });
});

test('a customer refresh adds a third unpaid invoice that the capped matcher used to miss', async (t) => {
  await withStore(t, async ({ Invoice }) => {
    await Invoice.create([
      {
        invoiceId: '201', invoiceNumber: 'INV-201', customerId: '22', customerName: 'Patrice',
        date: '2026-09-01', dueDate: '2026-09-10', status: 'overdue', total: 100000, balance: 100000, open: true,
      },
      {
        invoiceId: '202', invoiceNumber: 'INV-202', customerId: '22', customerName: 'Patrice',
        date: '2026-09-15', dueDate: '2026-09-25', status: 'overdue', total: 200000, balance: 200000, open: true,
      },
    ]);
    const fetchImpl = pages((params) => {
      assert.equal(params.get('customer_id'), '22');
      assert.equal(params.get('status'), 'unpaid');
      return [
        row({ invoice_id: '201', invoice_number: 'INV-201', customer_id: '22', balance: 100000, total: 100000 }),
        row({ invoice_id: '202', invoice_number: 'INV-202', customer_id: '22', balance: 200000, total: 200000 }),
        row({ invoice_id: '203', invoice_number: 'INV-203', customer_id: '22', balance: 50000, total: 50000, date: '2026-10-01' }),
      ];
    });
    const fresh = await refreshCustomerInvoices(env, '22', { force: true, deps: deps(fetchImpl) });
    assert.equal(fresh.changed, true);
    assert.equal(fresh.openCount, 3);
    const matching = await openInvoicesForCustomer('22');
    assert.deepEqual(
      matching.map((invoice) => invoice.invoiceNo).sort(),
      ['INV-201', 'INV-202', 'INV-203'],
    );
  });
});
