import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** The only Zoho Books call this app makes is POST /books/v3/expenses. */
export const ZOHO_EXPENSE_SCOPE = 'ZohoBooks.expenses.CREATE';

const DATA_CENTERS = {
  com: { accounts: 'https://accounts.zoho.com', api: 'https://www.zohoapis.com' },
  in: { accounts: 'https://accounts.zoho.in', api: 'https://www.zohoapis.in' },
  eu: { accounts: 'https://accounts.zoho.eu', api: 'https://www.zohoapis.eu' },
  au: { accounts: 'https://accounts.zoho.com.au', api: 'https://www.zohoapis.com.au' },
  jp: { accounts: 'https://accounts.zoho.jp', api: 'https://www.zohoapis.jp' },
  ca: { accounts: 'https://accounts.zoho.ca', api: 'https://www.zohoapis.ca' },
  sa: { accounts: 'https://accounts.zoho.sa', api: 'https://www.zohoapis.sa' },
  ae: { accounts: 'https://accounts.zoho.ae', api: 'https://www.zohoapis.ae' },
};

const RECEIPT_EXTENSIONS = new Set(['gif', 'png', 'jpeg', 'jpg', 'bmp', 'pdf']);

let tokenCache = { key: '', token: '', expiresAt: 0 };

export function clearZohoTokenCache() {
  tokenCache = { key: '', token: '', expiresAt: 0 };
}

export function zohoHosts(dc) {
  const hosts = DATA_CENTERS[String(dc || '').toLowerCase()];
  if (!hosts) {
    const error = new Error('ZOHO_DC must be com, in, eu, au, jp, ca, sa, or ae.');
    error.status = 400;
    throw error;
  }
  return hosts;
}

export function missingZohoConfig(zoho, { refreshToken = '', purpose = 'expense' } = {}) {
  const missing = [];
  if (!zoho?.clientId) missing.push('ZOHO_CLIENT_ID');
  if (!zoho?.clientSecret) missing.push('ZOHO_CLIENT_SECRET');
  if (!DATA_CENTERS[zoho?.dc]) missing.push('ZOHO_DC');
  if (purpose === 'connect') return missing;
  if (!/^\d+$/.test(String(zoho?.organizationId || ''))) missing.push('ZOHO_ORGANIZATION_ID');
  if (!refreshToken && !zoho?.refreshToken) missing.push('ZOHO_REFRESH_TOKEN');
  return missing;
}

export function receiptExtension(mimeType, originalName) {
  const fromMime = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'application/pdf': 'pdf',
  }[mimeType];
  if (fromMime) return fromMime;
  if (mimeType) return '';
  const fromName = String(originalName || '').split('.').pop().toLowerCase();
  return RECEIPT_EXTENSIONS.has(fromName) ? fromName : '';
}

export function createOauthState(secret) {
  const payload = `${Date.now()}.${randomBytes(8).toString('hex')}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

export function verifyOauthState(state, secret) {
  const parts = String(state || '').split('.');
  if (parts.length !== 3) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  const actualBuf = Buffer.from(parts[2]);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) return false;
  const age = Date.now() - Number(parts[0]);
  return Number.isFinite(age) && age >= 0 && age < 10 * 60 * 1000;
}

export function authorizationUrl(zoho, state) {
  const hosts = zohoHosts(zoho.dc);
  const params = new URLSearchParams({
    scope: ZOHO_EXPENSE_SCOPE,
    client_id: zoho.clientId,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    redirect_uri: zoho.redirectUri,
    state,
  });
  return `${hosts.accounts}/oauth/v2/auth?${params.toString()}`;
}

function zohoFailure(message) {
  const error = new Error(message);
  error.status = 422;
  return error;
}

function assertAllowedUrl(url, dc, method) {
  const hosts = zohoHosts(dc);
  const parsed = new URL(url);
  const accountsHost = new URL(hosts.accounts).host;
  const apiHost = new URL(hosts.api).host;
  const tokenCall = parsed.host === accountsHost && parsed.pathname === '/oauth/v2/token';
  const expenseCall = parsed.host === apiHost && parsed.pathname === '/books/v3/expenses';
  if (method !== 'POST' || (!tokenCall && !expenseCall)) {
    throw zohoFailure('This Zoho integration can only create an expense.');
  }
}

async function postForm(fetchImpl, url, dc, params) {
  assertAllowedUrl(url, dc, 'POST');
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = {}; }
  if (!response.ok || data.error) {
    const reason = typeof data.error === 'string' ? data.error : `HTTP ${response.status}`;
    throw zohoFailure(`Zoho sign-in failed (${reason}). Connect Zoho again from the overview.`);
  }
  return data;
}

export async function exchangeAuthCode(zoho, code, fetchImpl = fetch) {
  const hosts = zohoHosts(zoho.dc);
  const data = await postForm(fetchImpl, `${hosts.accounts}/oauth/v2/token`, zoho.dc, {
    grant_type: 'authorization_code',
    client_id: zoho.clientId,
    client_secret: zoho.clientSecret,
    redirect_uri: zoho.redirectUri,
    code,
  });
  if (!data.refresh_token) {
    throw zohoFailure('Zoho did not return a refresh token. Connect again and accept the consent screen.');
  }
  return data.refresh_token;
}

async function accessToken(zoho, refreshToken, fetchImpl) {
  if (tokenCache.key === refreshToken && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token;
  }
  const hosts = zohoHosts(zoho.dc);
  const data = await postForm(fetchImpl, `${hosts.accounts}/oauth/v2/token`, zoho.dc, {
    grant_type: 'refresh_token',
    client_id: zoho.clientId,
    client_secret: zoho.clientSecret,
    refresh_token: refreshToken,
  });
  if (!data.access_token) throw zohoFailure('Zoho did not return an access token.');
  const seconds = Number(data.expires_in) || 3600;
  tokenCache = { key: refreshToken, token: data.access_token, expiresAt: Date.now() + seconds * 1000 };
  return data.access_token;
}

function expenseIdFrom(text) {
  const quoted = text.match(/"expense_id"\s*:\s*"(\d+)"/);
  if (quoted) return quoted[1];
  const bare = text.match(/"expense_id"\s*:\s*(\d+)/);
  return bare ? bare[1] : '';
}

function zohoMessage(text, status) {
  const match = text.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/);
  const message = match ? match[1].replace(/\\"/g, '"').slice(0, 300) : '';
  if (message && !/token|secret|refresh/i.test(message)) return message;
  return `Zoho Books refused the expense (HTTP ${status}).`;
}

function receiptFileName(originalName, ext) {
  const base = String(originalName || 'receipt').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80);
  if (base.toLowerCase().endsWith(`.${ext}`)) return base || `receipt.${ext}`;
  return `${base || 'receipt'}.${ext}`;
}

export async function createExpense({ zoho, refreshToken, expense, file, fetchImpl = fetch }) {
  if (!Number.isInteger(expense.amount) || expense.amount <= 0) {
    throw zohoFailure('The expense amount must be a whole number of rupiah.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expense.date || '')) {
    throw zohoFailure('The expense date must be an ISO date.');
  }
  const hosts = zohoHosts(zoho.dc);
  const organizationId = String(zoho.organizationId || '');
  if (!/^\d+$/.test(organizationId)) throw zohoFailure('ZOHO_ORGANIZATION_ID must be the numeric id from Zoho.');
  const payload = {
    account_id: String(expense.accountId || ''),
    paid_through_account_id: String(expense.paidThroughAccountId || ''),
    date: expense.date,
    amount: expense.amount,
    description: String(expense.description || '').slice(0, 100),
    reference_number: String(expense.referenceNumber || '').slice(0, 100),
  };
  if (!/^\d+$/.test(payload.account_id) || !/^\d+$/.test(payload.paid_through_account_id)) {
    throw zohoFailure('The Zoho account ids must be numeric ids saved as text.');
  }
  const url = `${hosts.api}/books/v3/expenses?organization_id=${organizationId}`;
  const token = await accessToken(zoho, refreshToken, fetchImpl);
  const headers = { Authorization: `Zoho-oauthtoken ${token}` };
  let body;
  if (file?.bytes?.length) {
    const form = new FormData();
    form.append('JSONString', JSON.stringify(payload));
    const ext = receiptExtension(file.mimeType, file.name) || 'jpg';
    const blob = new Blob([file.bytes], { type: file.mimeType || 'application/octet-stream' });
    form.append('receipt', blob, receiptFileName(file.name, ext));
    body = form;
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(payload);
  }
  assertAllowedUrl(url, zoho.dc, 'POST');
  const response = await fetchImpl(url, { method: 'POST', headers, body });
  const text = await response.text();
  const codeMatch = text.match(/"code"\s*:\s*(-?\d+)/);
  const code = codeMatch ? Number(codeMatch[1]) : null;
  if (!response.ok || (code !== null && code !== 0)) {
    throw zohoFailure(zohoMessage(text, response.status));
  }
  const expenseId = expenseIdFrom(text);
  if (!/^\d+$/.test(expenseId)) throw zohoFailure('Zoho Books did not return an expense id.');
  return { expenseId, receiptAttached: Boolean(file?.bytes?.length) };
}
