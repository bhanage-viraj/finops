import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  authorizationUrl, clearZohoTokenCache, createExpense, createOauthState, exchangeAuthCode,
  missingZohoConfig, receiptExtension, verifyOauthState, ZOHO_EXPENSE_SCOPE,
} from '../src/integrations/erp/zohoBooks.js';

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

test('the connect URL asks only for expense creation', () => {
  const url = new URL(authorizationUrl(zoho, createOauthState('test-secret')));
  assert.equal(url.host, 'accounts.zoho.in');
  assert.equal(url.pathname, '/oauth/v2/auth');
  assert.equal(url.searchParams.get('scope'), ZOHO_EXPENSE_SCOPE);
  assert.equal(url.searchParams.get('scope').includes('invoices'), false);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('redirect_uri'), zoho.redirectUri);
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

test('WebP cannot be attached to a Zoho expense', () => {
  assert.equal(receiptExtension('image/webp', 'slip.png'), '');
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
