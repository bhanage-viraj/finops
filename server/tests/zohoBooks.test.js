import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  assertAllowedUrl, authorizationUrl, clearZohoTokenCache, createCustomerPayment, createExpense,
  createOauthState, exchangeAuthCode, getInvoicePdf, listInvoicePages, listOverdueInvoices, listUnpaidInvoicesInRange,
  mapOverdueInvoice, mapReceivableInvoice, mapStoredInvoice, mapUnpaidInvoiceForMatching, missingZohoConfig,
  receiptExtension, verifyOauthState, zohoTimeMs, zohoTimeParam,
  ZOHO_CUSTOMER_PAYMENT_SCOPE, ZOHO_OAUTH_SCOPE,
} from '../src/integrations/erp/zohoBooks.js';
import { receiptForZoho } from '../src/services/documents/zohoExpense.js';

const zoho = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  dc: 'in',
  organizationId: '10234695',
  expenseAccountId: '982000000561057',
  paidThroughAccountId: '982000000567250',
  redirectUri: 'http://localhost:4000/auth/zoho/callback',
  refreshToken: 'refresh-token',
};

const expense = {
  accountId: '982000000561057',
  paidThroughAccountId: '982000000567250',
  date: '2026-10-09',
  amount: 100310,
  description: 'SPBU Maju · Fuel receipt',
  referenceNumber: 'SLIP-1',
};

function tokenResponse() {
  return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'access-1', expires_in: 3600 }) };
}

test('the connect URL asks for expense create, invoice read, and customer payment create', () => {
  const url = new URL(authorizationUrl(zoho, createOauthState('test-secret')));
  assert.equal(url.host, 'accounts.zoho.in');
  assert.equal(url.pathname, '/oauth/v2/auth');
  assert.equal(url.searchParams.get('scope'), ZOHO_OAUTH_SCOPE);
  assert.equal(url.searchParams.get('scope').includes('ZohoBooks.expenses.CREATE'), true);
  assert.equal(url.searchParams.get('scope').includes('ZohoBooks.invoices.READ'), true);
  assert.equal(url.searchParams.get('scope').includes(ZOHO_CUSTOMER_PAYMENT_SCOPE), true);
  assert.equal(url.searchParams.get('scope').includes('UPDATE'), false);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('redirect_uri'), zoho.redirectUri);
});

test('Zoho URLs allow expense, invoice list/PDF, and customer payment POST', () => {
  assert.doesNotThrow(() => assertAllowedUrl('https://www.zohoapis.in/books/v3/expenses', 'in', 'POST'));
  assert.doesNotThrow(() => assertAllowedUrl('https://www.zohoapis.in/books/v3/invoices?status=overdue', 'in', 'GET'));
  assert.doesNotThrow(() => assertAllowedUrl('https://www.zohoapis.in/books/v3/invoices?last_modified_time=2026-10-19T02:00:00%2B0000&customer_id=1', 'in', 'GET'));
  assert.doesNotThrow(() => assertAllowedUrl('https://www.zohoapis.in/books/v3/invoices/982000000561001?organization_id=1&accept=pdf', 'in', 'GET'));
  assert.doesNotThrow(() => assertAllowedUrl('https://www.zohoapis.in/books/v3/customerpayments', 'in', 'POST'));
  assert.throws(() => assertAllowedUrl('https://www.zohoapis.in/books/v3/invoices/982000000561001?organization_id=1', 'in', 'GET'), /customer payment|invoice PDF/);
  assert.throws(() => assertAllowedUrl('https://www.zohoapis.in/books/v3/invoices', 'in', 'POST'), /customer payment|invoice PDF/);
  assert.throws(() => assertAllowedUrl('https://www.zohoapis.in/books/v3/bills', 'in', 'GET'), /customer payment|invoice PDF/);
});

test('unpaid invoice mapper keeps customer id and balance for matching', () => {
  const mapped = mapUnpaidInvoiceForMatching({
    invoice_id: '9820000000000000009',
    customer_id: '9820000000000000011',
    invoice_number: 'INV-9',
    customer_name: 'Toko Contoh',
    due_date: '2026-09-01',
    date: '2026-08-01',
    status: 'overdue',
    balance: 150000,
    currency_code: 'IDR',
  });
  assert.equal(mapped.invoiceId, '9820000000000000009');
  assert.equal(mapped.customerId, '9820000000000000011');
  assert.equal(mapped.remaining, 150000);
  assert.equal(mapUnpaidInvoiceForMatching({
    invoice_id: '1', customer_id: '2', invoice_number: 'X', customer_name: 'A',
    due_date: '2026-09-01', status: 'paid', balance: 1000, currency_code: 'IDR',
  }), null);
});

test('customer payment posts only to customerpayments', async () => {
  clearZohoTokenCache();
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method, body: options.body });
    if (String(url).includes('/oauth/v2/token')) return tokenResponse();
    return {
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ code: 0, payment: { payment_id: '982000000999' } }),
    };
  };
  const result = await createCustomerPayment({
    zoho,
    refreshToken: 'refresh-token',
    payment: {
      customerId: '982000000001',
      invoiceId: '982000000002',
      amount: 28000,
      amountApplied: 28000,
      date: '2026-09-30',
      accountId: '982000000567250',
      referenceNumber: 'REF-1',
      description: 'FinOps test',
    },
    fetchImpl,
  });
  assert.equal(result.paymentId, '982000000999');
  const paymentCall = calls.find((c) => c.url.includes('/customerpayments'));
  assert.ok(paymentCall);
  assert.equal(paymentCall.method, 'POST');
  const body = JSON.parse(paymentCall.body);
  assert.equal(body.customer_id, '982000000001');
  assert.equal(body.invoices[0].invoice_id, '982000000002');
  assert.equal(body.amount_applied ?? body.invoices[0].amount_applied, 28000);
  assert.equal(body.payment_mode, 'Bank Transfer');
});

test('createCustomerPayment sends an explicit payment mode label', async () => {
  const zoho = {
    dc: 'com',
    clientId: 'cid',
    clientSecret: 'secret',
    organizationId: '60000000001',
  };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method, body: options.body });
    if (String(url).includes('/oauth/v2/token')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'token', expires_in: 3600 }),
      };
    }
    return {
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ code: 0, payment: { payment_id: '982000000999' } }),
    };
  };
  await createCustomerPayment({
    zoho,
    refreshToken: 'refresh-token',
    payment: {
      customerId: '982000000001',
      invoiceId: '982000000002',
      amount: 28000,
      amountApplied: 28000,
      date: '2026-09-30',
      accountId: '982000000567250',
      paymentMode: 'Bank Transfer',
      referenceNumber: 'REF-1',
      description: 'FinOps test',
    },
    fetchImpl,
  });
  const paymentCall = calls.find((c) => c.url.includes('/customerpayments'));
  assert.equal(JSON.parse(paymentCall.body).payment_mode, 'Bank Transfer');
});

test('receivable invoice mapper keeps the date, phone and integer balance', () => {
  const mapped = mapReceivableInvoice({
    invoice_id: '9820000000000000009',
    customer_id: '9820000000000000011',
    invoice_number: 'INV-9',
    customer_name: 'Toko Contoh',
    customer_phone: '+62 812-000',
    date: '2026-10-02',
    due_date: '2026-10-09',
    created_time: '2026-09-13T17:29:00+0800',
    reference_number: 'PO-1',
    status: 'sent',
    total: 200000,
    balance: 150000,
    currency_code: 'IDR',
  });
  assert.equal(mapped.balance, 150000);
  assert.equal(mapped.invoiceTotal, 200000);
  assert.equal(mapped.referenceNumber, 'PO-1');
  assert.equal(mapped.createdTime, '13/09/2026 05:29 PM');
  assert.equal(mapped.date, '2026-10-02');
  assert.equal(mapped.customerPhone, '62812000');
  assert.equal(mapReceivableInvoice({
    invoice_id: '1', customer_id: '2', invoice_number: 'X', customer_name: 'A',
    date: '2026-10-02', status: 'paid', balance: 1000, currency_code: 'IDR',
  }), null);
  assert.equal(mapReceivableInvoice({
    invoice_id: '1', customer_id: '2', invoice_number: 'X', customer_name: 'A',
    date: '2026-10-02', status: 'sent', balance: 10.5, currency_code: 'IDR',
  }), null);
  assert.equal(mapReceivableInvoice({
    invoice_id: '1', customer_id: '2', invoice_number: 'X', customer_name: 'A',
    date: '2026-10-02', status: 'sent', balance: 1000, currency_code: 'USD',
  }), null);
});

test('receivable summary lists unpaid invoices on the existing invoices URL', async () => {
  clearZohoTokenCache();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET' });
    if (String(url).includes('/oauth/v2/token')) return tokenResponse();
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        invoices: [{
          invoice_id: '982000000561001',
          customer_id: '982000000561099',
          invoice_number: 'INV-1',
          customer_name: 'Toko A',
          date: '2026-10-03',
          due_date: '2026-10-10',
          status: 'overdue',
          balance: 250000,
          currency_code: 'IDR',
        }],
        page_context: { has_more_page: false },
      }),
    };
  };
  const result = await listUnpaidInvoicesInRange({
    zoho, refreshToken: zoho.refreshToken, fromDate: '2026-10-01', toDate: '2026-10-31', fetchImpl,
  });
  assert.equal(result.truncated, false);
  assert.equal(result.invoices.length, 1);
  assert.equal(result.invoices[0].balance, 250000);
  const listCall = calls.find((call) => call.url.includes('/books/v3/invoices?'));
  const listed = new URL(listCall.url);
  assert.equal(listed.pathname, '/books/v3/invoices');
  assert.equal(listed.searchParams.get('status'), 'unpaid');
  assert.equal(listed.searchParams.get('date_start'), '2026-10-01');
  assert.equal(listed.searchParams.get('date_end'), '2026-10-31');
  assert.equal(calls.some((call) => call.url.includes('/books/v3/reports')), false);
});

test('overdue invoice rows keep string ids and integer rupiah', () => {
  const today = new Date('2026-10-13T00:00:00.000Z');
  const mapped = mapOverdueInvoice({
    invoice_id: '9820000000000000009',
    invoice_number: 'INV-9',
    customer_name: 'Toko Contoh',
    due_date: '2026-09-01',
    status: 'overdue',
    balance: 150000,
    currency_code: 'IDR',
  }, today);
  assert.equal(mapped.invoiceId, '9820000000000000009');
  assert.equal(mapped.balance, 150000);
  assert.equal(mapped.daysOverdue, 42);
  assert.equal(mapOverdueInvoice({
    invoice_id: '1', invoice_number: 'X', customer_name: 'A', due_date: '2026-09-01',
    status: 'paid', balance: 1000, currency_code: 'IDR',
  }, today), null);
});

test('invoice PDF download calls only that invoice URL', async () => {
  clearZohoTokenCache();
  const calls = [];
  const pdfBytes = Buffer.from('%PDF-1.4 invoice');
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET', headers: init?.headers || {} });
    if (String(url).includes('/oauth/v2/token')) return tokenResponse();
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          if (String(name).toLowerCase() === 'content-type') return 'application/pdf';
          if (String(name).toLowerCase() === 'content-disposition') return 'attachment; filename="INV-1.pdf"';
          return null;
        },
      },
      arrayBuffer: async () => pdfBytes,
      text: async () => '',
    };
  };
  const file = await getInvoicePdf({
    zoho,
    refreshToken: zoho.refreshToken,
    invoiceId: '982000000561001',
    invoiceNumber: 'INV-1',
    fetchImpl,
  });
  assert.equal(file.fileName, 'INV-1.pdf');
  assert.equal(file.contentType, 'application/pdf');
  assert.equal(Buffer.compare(file.bytes, pdfBytes), 0);
  assert.equal(calls.some((call) => /\/books\/v3\/invoices\/982000000561001\?/.test(call.url) && call.url.includes('accept=pdf')), true);
  assert.equal(calls.some((call) => call.url.includes('/books/v3/expenses')), false);
});

test('list overdue invoices calls only the invoices URL', async () => {
  clearZohoTokenCache();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET' });
    if (String(url).includes('/oauth/v2/token')) return tokenResponse();
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        invoices: [{
          invoice_id: '982000000561001',
          invoice_number: 'INV-1',
          customer_name: 'Pelanggan Satu',
          due_date: '2026-09-10',
          status: 'overdue',
          balance: 75000,
          currency_code: 'IDR',
        }],
        page_context: { has_more_page: false },
      }),
    };
  };
  const rows = await listOverdueInvoices({
    zoho,
    refreshToken: zoho.refreshToken,
    fetchImpl,
    today: new Date('2026-10-13T00:00:00.000Z'),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].invoiceNumber, 'INV-1');
  assert.equal(calls.some((call) => call.url.includes('/books/v3/invoices') && call.method === 'GET'), true);
  assert.equal(calls.some((call) => call.url.includes('/books/v3/bills')), false);
});

test('overdue list also reads part-paid invoices and drops duplicates', async () => {
  clearZohoTokenCache();
  const statuses = [];
  const row = (id, status) => ({
    invoice_id: id, invoice_number: `INV-${id}`, customer_name: 'Pelanggan Satu',
    due_date: '2026-09-10', status, balance: 75000, currency_code: 'IDR',
  });
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/oauth/v2/token')) return tokenResponse();
    assert.equal(init?.method || 'GET', 'GET');
    const status = new URL(String(url)).searchParams.get('status');
    statuses.push(status);
    const invoices = status === 'overdue'
      ? [row('982000000561001', 'overdue')]
      : [row('982000000561001', 'overdue'), row('982000000561002', 'partially_paid'), {
        ...row('982000000561003', 'partially_paid'), due_date: '2026-12-01',
      }];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, invoices, page_context: { has_more_page: false } }),
    };
  };
  const stats = {};
  const rows = await listOverdueInvoices({
    zoho, refreshToken: zoho.refreshToken, fetchImpl, today: new Date('2026-10-13T00:00:00.000Z'), stats,
  });
  assert.deepEqual(statuses, ['overdue', 'partially_paid']);
  assert.deepEqual(rows.map((r) => r.invoiceNumber), ['INV-982000000561001', 'INV-982000000561002']);
  assert.deepEqual(stats, { zohoRows: 4, kept: 2, truncated: false });
});

test('oauth state expires and rejects a changed signature', () => {
  const secret = 'test-secret';
  assert.equal(verifyOauthState(createOauthState(secret), secret), true);
  const payload = `${Date.now() - 11 * 60 * 1000}.abcdabcdabcdabcd`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  assert.equal(verifyOauthState(`${payload}.${sig}`, secret), false);
  assert.equal(verifyOauthState(`${payload}.${sig.slice(0, -1)}a`, secret), false);
});

test('missing Zoho settings are named and account ids are not invented', () => {
  const missing = missingZohoConfig({ dc: 'books' }).sort();
  assert.deepEqual(missing, [
    'ZOHO_CLIENT_ID',
    'ZOHO_CLIENT_SECRET',
    'ZOHO_DC',
    'ZOHO_ORGANIZATION_ID',
    'ZOHO_REFRESH_TOKEN',
  ].sort());
});

test('Zoho accepts jpeg, png and pdf receipts, and not webp by itself', () => {
  assert.equal(receiptExtension('image/webp', 'slip.webp'), '');
  assert.equal(receiptExtension('image/png', 'slip.png'), 'png');
  assert.equal(receiptExtension('application/pdf', 'slip.pdf'), 'pdf');
});

test('create expense posts only to the expense URL and keeps a long id as text', async () => {
  clearZohoTokenCache();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (String(url).includes('/oauth/v2/token')) return tokenResponse();
    return {
      ok: true,
      status: 201,
      text: async () => '{"code":0,"message":"The expense has been created.","expense":{"expense_id":9820000000000000001}}',
    };
  };
  const result = await createExpense({
    zoho, refreshToken: zoho.refreshToken, expense, file: null, fetchImpl,
  });
  assert.equal(result.expenseId, '9820000000000000001');
  assert.notEqual(String(Number(result.expenseId)), result.expenseId);
  assert.equal(calls.length, 2);
  const paths = calls.map((call) => new URL(call.url).pathname);
  assert.deepEqual(paths, ['/oauth/v2/token', '/books/v3/expenses']);
  assert.equal(calls[1].init.headers.Authorization, 'Zoho-oauthtoken access-1');
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.amount, 100310);
  assert.equal(typeof body.account_id, 'string');
  assert.equal(body.account_id, '982000000561057');
  assert.equal(typeof body.paid_through_account_id, 'string');
  assert.equal(body.date, '2026-10-09');
  assert.equal(new URL(calls[1].url).searchParams.get('organization_id'), '10234695');
});

test('a receipt is attached on the same create request', async () => {
  clearZohoTokenCache();
  let form;
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/oauth/v2/token')) return tokenResponse();
    form = init.body;
    return {
      ok: true,
      status: 201,
      text: async () => '{"code":0,"expense":{"expense_id":"982000000561099"}}',
    };
  };
  const result = await createExpense({
    zoho,
    refreshToken: zoho.refreshToken,
    expense,
    file: { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mimeType: 'image/png', name: 'fuel.png' },
    fetchImpl,
  });
  assert.equal(result.receiptAttached, true);
  assert.equal(result.expenseId, '982000000561099');
  const payload = JSON.parse(form.get('JSONString'));
  assert.equal(payload.amount, 100310);
  assert.equal(typeof payload.account_id, 'string');
  assert.equal(form.get('receipt').name, 'fuel.png');
});

test('a Zoho refusal does not return an expense id', async () => {
  clearZohoTokenCache();
  const fetchImpl = async (url) => {
    if (String(url).includes('/oauth/v2/token')) return tokenResponse();
    return { ok: false, status: 400, text: async () => '{"code":4,"message":"Invalid value passed for amount."}' };
  };
  await assert.rejects(
    () => createExpense({ zoho, refreshToken: zoho.refreshToken, expense, fetchImpl }),
    /Invalid value passed for amount/,
  );
});

test('a token error is not passed through', async () => {
  clearZohoTokenCache();
  const fetchImpl = async (url) => {
    if (String(url).includes('/oauth/v2/token')) return tokenResponse();
    return { ok: false, status: 401, text: async () => '{"code":57,"message":"Invalid token secret"}' };
  };
  await assert.rejects(
    () => createExpense({ zoho, refreshToken: zoho.refreshToken, expense, fetchImpl }),
    (err) => {
      assert.equal(err.message.includes('secret'), false);
      assert.match(err.message, /refused the expense/);
      return true;
    },
  );
});

test('a non-numeric account id is refused before any request', async () => {
  let called = false;
  await assert.rejects(
    () => createExpense({
      zoho,
      refreshToken: zoho.refreshToken,
      expense: { ...expense, accountId: 'fuel' },
      fetchImpl: () => { called = true; },
    }),
    /account ids/,
  );
  assert.equal(called, false);
});

test('a WebP photo is converted to JPEG before it is sent to Zoho Books', async () => {
  const sharp = (await import('sharp')).default;
  const webp = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 10, b: 10 } },
  }).webp().toBuffer();
  const file = await receiptForZoho({ bytes: webp, mimeType: 'image/webp', name: 'slip.webp' });
  assert.equal(file.mimeType, 'image/jpeg');
  assert.equal(file.name, 'receipt.jpg');
  assert.equal(file.bytes[0], 0xff);
  assert.equal(file.bytes[1], 0xd8);
});

test('the code exchange calls only the token endpoint', async () => {
  const calls = [];
  const refresh = await exchangeAuthCode(zoho, 'auth-code', async (url, init) => {
    calls.push(url);
    const params = new URLSearchParams(init.body);
    assert.equal(params.get('grant_type'), 'authorization_code');
    assert.equal(params.get('redirect_uri'), zoho.redirectUri);
    return { ok: true, status: 200, text: async () => JSON.stringify({ refresh_token: 'new-refresh', access_token: 'access-2' }) };
  });
  assert.equal(refresh, 'new-refresh');
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]).pathname, '/oauth/v2/token');
});

test('stored invoice mapper keeps open unpaid rows and closes paid ones', () => {
  const mapped = mapStoredInvoice({
    invoice_id: '9820000000000000009',
    invoice_number: 'INV-9',
    reference_number: 'PO-1',
    customer_id: '9820000000000000011',
    customer_name: 'Toko Contoh',
    customer_phone: '081234',
    date: '2026-08-01',
    due_date: '2026-09-01',
    status: 'overdue',
    total: 200000,
    balance: 150000,
    currency_code: 'IDR',
    invoice_url: 'https://books.zoho.in/app/1',
    created_time: '2026-08-01T10:00:00+0800',
    last_modified_time: '2026-10-19T10:15:00+0800',
  });
  assert.equal(mapped.invoiceId, '9820000000000000009');
  assert.equal(mapped.balance, 150000);
  assert.equal(mapped.open, true);
  assert.equal(mapStoredInvoice({
    invoice_id: '1', customer_id: '2', status: 'paid', balance: 0, total: 1000, currency_code: 'IDR',
  }).open, false);
  assert.equal(mapStoredInvoice({
    invoice_id: '1', customer_id: '2', status: 'sent', balance: 10.5, currency_code: 'IDR',
  }), null);
});

test('Zoho stamps parse to UTC milliseconds', () => {
  assert.equal(zohoTimeMs('2026-10-19T10:15:00+0800'), Date.parse('2026-10-19T10:15:00+08:00'));
  assert.equal(zohoTimeParam(new Date('2026-10-19T02:00:00.000Z')), '2026-10-19T02:00:00+0000');
  assert.equal(zohoTimeMs('not-a-date'), null);
});

test('invoice page reader refuses unknown filters, retries 429, and honours stopWhen', async () => {
  clearZohoTokenCache();
  await assert.rejects(
    () => listInvoicePages({ zoho, refreshToken: zoho.refreshToken, filters: { sort_column: 'created_time' } }),
    /sort_column is not allowed/,
  );

  const sleeps = [];
  let invoiceCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes('/oauth/v2/token')) return tokenResponse();
    invoiceCalls += 1;
    if (invoiceCalls === 1) return { ok: false, status: 429, text: async () => 'rate' };
    const page = Number(new URL(String(url)).searchParams.get('page'));
    assert.equal(new URL(String(url)).pathname, '/books/v3/invoices');
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        invoices: [{
          invoice_id: String(page),
          invoice_number: `INV-${page}`,
          customer_id: '11',
          customer_name: 'Toko',
          date: '2026-10-01',
          due_date: '2026-10-10',
          status: 'sent',
          total: 1000,
          balance: 1000,
          currency_code: 'IDR',
          last_modified_time: '2026-10-19T10:15:00+0800',
        }],
        page_context: { has_more_page: page < 3 },
      }),
    };
  };
  const first = await listInvoicePages({
    zoho, refreshToken: zoho.refreshToken, fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, pauseMs: 0,
    stopWhen: (rows) => rows.some((row) => row.invoiceId === '2'),
  });
  assert.deepEqual(sleeps, [15_000]);
  assert.equal(first.stopped, true);
  assert.equal(first.truncated, false);
  assert.deepEqual(first.invoices.map((row) => row.invoiceId), ['1']);
});
