import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Expense create, invoice read, and customer payment create (Payments feature). */
export const ZOHO_EXPENSE_SCOPE = 'ZohoBooks.expenses.CREATE';
export const ZOHO_INVOICE_READ_SCOPE = 'ZohoBooks.invoices.READ';
export const ZOHO_CUSTOMER_PAYMENT_SCOPE = 'ZohoBooks.customerpayments.CREATE';
export const ZOHO_OAUTH_SCOPE = `${ZOHO_EXPENSE_SCOPE},${ZOHO_INVOICE_READ_SCOPE},${ZOHO_CUSTOMER_PAYMENT_SCOPE}`;

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
    scope: ZOHO_OAUTH_SCOPE,
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

export function assertAllowedUrl(url, dc, method) {
  const hosts = zohoHosts(dc);
  const parsed = new URL(url);
  const accountsHost = new URL(hosts.accounts).host;
  const apiHost = new URL(hosts.api).host;
  const tokenCall = method === 'POST'
    && parsed.host === accountsHost
    && parsed.pathname === '/oauth/v2/token';
  const expenseCall = method === 'POST'
    && parsed.host === apiHost
    && parsed.pathname === '/books/v3/expenses';
  const invoiceList = method === 'GET'
    && parsed.host === apiHost
    && parsed.pathname === '/books/v3/invoices';
  const invoiceOne = method === 'GET'
    && parsed.host === apiHost
    && /^\/books\/v3\/invoices\/\d+$/.test(parsed.pathname);
  const customerPayment = method === 'POST'
    && parsed.host === apiHost
    && parsed.pathname === '/books/v3/customerpayments';
  if (!tokenCall && !expenseCall && !invoiceList && !invoiceOne && !customerPayment) {
    throw zohoFailure('This Zoho integration can only create an expense, list invoices, read an invoice, or record a customer payment.');
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

function zohoMessage(text, status, kind = 'expense') {
  const match = text.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/);
  const message = match ? match[1].replace(/\\"/g, '"').slice(0, 300) : '';
  if (message && !/token|secret|refresh/i.test(message)) return message;
  if (kind === 'invoice') return `Zoho Books refused the invoice list (HTTP ${status}).`;
  if (kind === 'invoice-pdf') return `Zoho Books refused the invoice PDF (HTTP ${status}).`;
  if (kind === 'payment') return `Zoho Books refused the customer payment (HTTP ${status}).`;
  return `Zoho Books refused the expense (HTTP ${status}).`;
}

function invoiceIdFrom(raw) {
  const text = raw == null ? '' : String(raw);
  return /^\d+$/.test(text) ? text : '';
}

/**
 * Zoho sometimes sends 19-digit ids as JSON numbers. JSON.parse would round them.
 * Quote invoice_id and customer_id before parse so matching can find every invoice.
 */
export function parseInvoiceListBody(text) {
  const quoted = String(text || '').replace(
    /"(invoice_id|customer_id)"\s*:\s*(\d+)/g,
    '"$1":"$2"',
  );
  try { return JSON.parse(quoted); } catch { return {}; }
}

/** Map one Zoho invoice row. Skip rows that are not overdue rupiah balances. */
export function mapOverdueInvoice(row, today = new Date()) {
  if (!row || typeof row !== 'object') return null;
  const invoiceId = invoiceIdFrom(row.invoice_id);
  if (!invoiceId) return null;
  const status = String(row.status || '').toLowerCase();
  const dueDate = String(row.due_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return null;
  const todayIso = today.toISOString().slice(0, 10);
  const overdueByStatus = status === 'overdue';
  const overdueByDate = dueDate < todayIso && !['paid', 'void', 'draft'].includes(status);
  if (!overdueByStatus && !overdueByDate) return null;
  const currency = String(row.currency_code || row.currency_symbol || 'IDR').toUpperCase();
  if (currency && currency !== 'IDR' && currency !== 'RP') return null;
  const balanceRaw = row.balance ?? row.total;
  const balanceNum = Number(balanceRaw);
  if (!Number.isFinite(balanceNum) || balanceNum <= 0) return null;
  const balance = Math.round(balanceNum);
  if (Math.abs(balanceNum - balance) > 0.01) return null;
  const due = Date.UTC(
    Number(dueDate.slice(0, 4)),
    Number(dueDate.slice(5, 7)) - 1,
    Number(dueDate.slice(8, 10)),
  );
  const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const daysOverdue = Math.max(0, Math.floor((now - due) / 86_400_000));
  const phone = String(row.customer_phone || row.phone || '').replace(/\D/g, '');
  const invoiceUrl = String(row.invoice_url || '').trim();
  const safeUrl = /^https:\/\//i.test(invoiceUrl) ? invoiceUrl.slice(0, 500) : '';
  return {
    invoiceId,
    invoiceNumber: String(row.invoice_number || '').slice(0, 80),
    customerId: customerIdFrom(row.customer_id),
    customerName: String(row.customer_name || '').slice(0, 120),
    customerPhone: phone.slice(0, 20),
    dueDate,
    daysOverdue,
    balance,
    currency: 'IDR',
    invoiceUrl: safeUrl,
  };
}

function receiptFileName(originalName, ext) {
  const base = String(originalName || 'receipt').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80);
  if (base.toLowerCase().endsWith(`.${ext}`)) return base || `receipt.${ext}`;
  return `${base || 'receipt'}.${ext}`;
}

function customerIdFrom(raw) {
  const text = raw == null ? '' : String(raw);
  return /^\d+$/.test(text) ? text : '';
}

function paymentIdFrom(text) {
  const quoted = text.match(/"payment_id"\s*:\s*"(\d+)"/);
  if (quoted) return quoted[1];
  const bare = text.match(/"payment_id"\s*:\s*(\d+)/);
  return bare ? bare[1] : '';
}

/**
 * Unpaid Zoho invoice for payment matching (not the Follow-up overdue-only mapper).
 * Includes overdue and partially paid balances.
 */
export function mapUnpaidInvoiceForMatching(row) {
  if (!row || typeof row !== 'object') return null;
  const invoiceId = invoiceIdFrom(row.invoice_id);
  const customerId = customerIdFrom(row.customer_id);
  if (!invoiceId || !customerId) return null;
  const status = String(row.status || '').toLowerCase();
  if (['paid', 'void', 'draft'].includes(status)) return null;
  const currency = String(row.currency_code || row.currency_symbol || 'IDR').toUpperCase();
  if (currency && currency !== 'IDR' && currency !== 'RP') return null;
  const balanceRaw = row.balance ?? row.total;
  const balanceNum = Number(balanceRaw);
  if (!Number.isFinite(balanceNum) || balanceNum <= 0) return null;
  const balance = Math.round(balanceNum);
  if (Math.abs(balanceNum - balance) > 0.01) return null;
  const dueDate = String(row.due_date || '');
  const date = String(row.date || '');
  return {
    invoiceId,
    invoiceNo: String(row.invoice_number || '').slice(0, 80),
    invoiceNumber: String(row.invoice_number || '').slice(0, 80),
    customerId,
    customerName: String(row.customer_name || '').slice(0, 120),
    aliases: [],
    remaining: balance,
    balance,
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    status,
    currency: 'IDR',
  };
}

function integerMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const rounded = Math.round(amount);
  if (Math.abs(amount - rounded) > 0.01) return null;
  return rounded;
}

/** Zoho created_time is an ISO stamp. Show the clock time already in that stamp. */
function formatCreatedTime(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!match) return '';
  const [, year, month, day, hourText, minute] = match;
  let hour = Number(hourText);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour %= 12;
  if (hour === 0) hour = 12;
  return `${day}/${month}/${year} ${String(hour).padStart(2, '0')}:${minute} ${suffix}`;
}

const DELIVERY_LINE = /delivery|shipping|ongkir|antar|freight|biaya kirim/;

/** Bottles on product lines, plus shipping_charge and delivery line totals. */
export function invoiceQtyAndDelivery(invoice) {
  if (!invoice || typeof invoice !== 'object') return { quantity: null, deliveryFee: null };
  const shipping = integerMoney(invoice.shipping_charge);
  let deliveryFee = Number.isInteger(shipping) ? shipping : 0;
  let quantity = 0;
  let hasQty = false;
  const items = Array.isArray(invoice.line_items) ? invoice.line_items : [];
  for (const item of items) {
    const name = `${item?.name || ''} ${item?.description || ''}`.toLowerCase();
    if (DELIVERY_LINE.test(name)) {
      const lineTotal = integerMoney(item?.item_total);
      if (Number.isInteger(lineTotal)) deliveryFee += lineTotal;
      continue;
    }
    const qty = Number(item?.quantity);
    if (!Number.isFinite(qty) || qty < 0) continue;
    quantity += qty;
    hasQty = true;
  }
  const rounded = Math.round(quantity);
  const whole = hasQty && Math.abs(quantity - rounded) < 0.01;
  return {
    quantity: whole ? rounded : null,
    deliveryFee: deliveryFee > 0 ? deliveryFee : (Number.isInteger(shipping) ? shipping : null),
  };
}

/**
 * Invoice row for the receivable summary. Unpaid by default; paid and draft
 * only when those statuses are explicitly allowed.
 */
export function mapReceivableInvoice(row, options = {}) {
  if (!row || typeof row !== 'object') return null;
  const invoiceId = invoiceIdFrom(row.invoice_id);
  if (!invoiceId) return null;
  const status = String(row.status || '').toLowerCase();
  const allow = options.allowStatuses instanceof Set ? options.allowStatuses : null;
  if (!allow) {
    if (['paid', 'void', 'draft'].includes(status)) return null;
  } else if (!allow.has(status) || status === 'void') {
    return null;
  }
  const currency = String(row.currency_code || row.currency_symbol || 'IDR').toUpperCase();
  if (currency && currency !== 'IDR' && currency !== 'RP') return null;
  const balance = integerMoney(row.balance ?? row.total);
  const invoiceTotal = integerMoney(row.total);
  const paidOrDraft = status === 'paid' || status === 'draft';
  if (paidOrDraft && allow) {
    if (!Number.isInteger(invoiceTotal) && !Number.isInteger(balance)) return null;
  } else if (!Number.isInteger(balance) || balance <= 0) {
    return null;
  }
  const date = String(row.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const dueDate = String(row.due_date || '');
  const phone = String(row.customer_phone || row.phone || '').replace(/\D/g, '');
  const extras = invoiceQtyAndDelivery(row);
  return {
    invoiceId,
    invoiceNumber: String(row.invoice_number || '').slice(0, 80),
    referenceNumber: String(row.reference_number || '').trim().slice(0, 80),
    customerId: customerIdFrom(row.customer_id),
    customerName: String(row.customer_name || '').trim().slice(0, 120),
    customerPhone: phone.slice(0, 20),
    date,
    createdTime: formatCreatedTime(row.created_time),
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : '',
    status,
    invoiceTotal: Number.isInteger(invoiceTotal) ? invoiceTotal : (balance || 0),
    balance: Number.isInteger(balance) ? balance : 0,
    quantity: extras.quantity,
    deliveryFee: extras.deliveryFee,
    currency: 'IDR',
  };
}

/** List unpaid Zoho invoices for Payments matching. Separate from Follow-up overdue list. */
export async function listUnpaidInvoicesForMatching({ zoho, refreshToken, fetchImpl = fetch }) {
  const hosts = zohoHosts(zoho.dc);
  const organizationId = String(zoho.organizationId || '');
  if (!/^\d+$/.test(organizationId)) throw zohoFailure('ZOHO_ORGANIZATION_ID must be the numeric id from Zoho.');
  const token = await accessToken(zoho, refreshToken, fetchImpl);
  const invoices = [];
  let page = 1;
  let hasMore = true;
  while (hasMore && page <= 20) {
    const url = `${hosts.api}/books/v3/invoices?organization_id=${organizationId}&status=unpaid&page=${page}&per_page=200`;
    assertAllowedUrl(url, zoho.dc, 'GET');
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    const text = await response.text();
    const codeMatch = text.match(/"code"\s*:\s*(-?\d+)/);
    const code = codeMatch ? Number(codeMatch[1]) : null;
    if (!response.ok || (code !== null && code !== 0)) {
      throw zohoFailure(zohoMessage(text, response.status, 'invoice'));
    }
    const data = parseInvoiceListBody(text);
    const rows = Array.isArray(data.invoices) ? data.invoices : [];
    for (const row of rows) {
      const mapped = mapUnpaidInvoiceForMatching(row);
      if (mapped) invoices.push(mapped);
    }
    const pageContext = data.page_context || {};
    hasMore = pageContext.has_more_page === true || pageContext.has_more_page === 'true';
    page += 1;
    if (rows.length === 0) hasMore = false;
  }
  return invoices;
}

const SUMMARY_MAX_PAGES = 20;

/**
 * Unpaid invoices whose invoice date falls in the range. Same invoices URL as
 * payment matching, with date_start and date_end. Read only.
 */
const SUMMARY_LIST_STATUSES = new Set(['unpaid', 'overdue', 'paid', 'draft']);

export async function listUnpaidInvoicesInRange(args) {
  return listInvoicesInDateRange({ ...args, status: 'unpaid' });
}

/**
 * Invoices in a date range for one Zoho status. Paid and draft are read live
 * because the Mongo copy only keeps unpaid rows open.
 */
export async function listInvoicesInDateRange({
  zoho, refreshToken, fromDate, toDate, status = 'unpaid', fetchImpl = fetch,
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fromDate || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(toDate || ''))) {
    throw zohoFailure('The date range must be ISO dates.');
  }
  const listStatus = String(status || 'unpaid').toLowerCase();
  if (!SUMMARY_LIST_STATUSES.has(listStatus)) throw zohoFailure('That invoice status cannot be listed.');
  const hosts = zohoHosts(zoho.dc);
  const organizationId = String(zoho.organizationId || '');
  if (!/^\d+$/.test(organizationId)) throw zohoFailure('ZOHO_ORGANIZATION_ID must be the numeric id from Zoho.');
  const token = await accessToken(zoho, refreshToken, fetchImpl);
  const invoices = [];
  const seen = new Set();
  let page = 1;
  let hasMore = true;
  const allowStatuses = ['paid', 'draft'].includes(listStatus) ? new Set([listStatus]) : null;
  while (hasMore && page <= SUMMARY_MAX_PAGES) {
    const params = new URLSearchParams({
      organization_id: organizationId,
      status: listStatus,
      date_start: fromDate,
      date_end: toDate,
      page: String(page),
      per_page: '200',
    });
    const url = `${hosts.api}/books/v3/invoices?${params}`;
    assertAllowedUrl(url, zoho.dc, 'GET');
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    const text = await response.text();
    const codeMatch = text.match(/"code"\s*:\s*(-?\d+)/);
    const code = codeMatch ? Number(codeMatch[1]) : null;
    if (!response.ok || (code !== null && code !== 0)) {
      throw zohoFailure(zohoMessage(text, response.status, 'invoice'));
    }
    const data = parseInvoiceListBody(text);
    const rows = Array.isArray(data.invoices) ? data.invoices : [];
    for (const row of rows) {
      const mapped = mapReceivableInvoice(row, allowStatuses ? { allowStatuses } : {});
      if (!mapped || seen.has(mapped.invoiceId)) continue;
      seen.add(mapped.invoiceId);
      invoices.push(mapped);
    }
    const pageContext = data.page_context || {};
    hasMore = pageContext.has_more_page === true || pageContext.has_more_page === 'true';
    page += 1;
    if (rows.length === 0) hasMore = false;
  }
  return { invoices, truncated: hasMore };
}

/** Zoho stamps look like 2026-10-19T10:15:00+0800. Returns epoch ms, or null. */
export function zohoTimeMs(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})([+-])(\d{2}):?(\d{2})$/);
  const ms = Date.parse(match ? `${match[1]}T${match[2]}${match[3]}${match[4]}:${match[5]}` : text);
  return Number.isNaN(ms) ? null : ms;
}

/** Value for the last_modified_time filter, in UTC. */
export function zohoTimeParam(date) {
  return `${new Date(date).toISOString().slice(0, 19)}+0000`;
}

/**
 * One invoice row for the stored copy in MongoDB. Paid, void and draft rows
 * are kept with open = false so a changed invoice can be closed in the copy.
 */
export function mapStoredInvoice(row) {
  if (!row || typeof row !== 'object') return null;
  const invoiceId = invoiceIdFrom(row.invoice_id);
  if (!invoiceId) return null;
  const currency = String(row.currency_code || row.currency_symbol || 'IDR').toUpperCase();
  if (currency && currency !== 'IDR' && currency !== 'RP') return null;
  const balance = integerMoney(row.balance ?? row.total);
  if (!Number.isInteger(balance)) return null;
  const total = integerMoney(row.total);
  const status = String(row.status || '').toLowerCase();
  const date = String(row.date || '');
  const dueDate = String(row.due_date || '');
  const invoiceUrl = String(row.invoice_url || '').trim();
  return {
    invoiceId,
    invoiceNumber: String(row.invoice_number || '').slice(0, 80),
    referenceNumber: String(row.reference_number || '').trim().slice(0, 80),
    customerId: customerIdFrom(row.customer_id),
    customerName: String(row.customer_name || '').trim().slice(0, 120),
    customerPhone: String(row.customer_phone || row.phone || '').replace(/\D/g, '').slice(0, 20),
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : '',
    status,
    total: Number.isInteger(total) ? total : balance,
    balance,
    invoiceUrl: /^https:\/\//i.test(invoiceUrl) ? invoiceUrl.slice(0, 500) : '',
    createdTime: String(row.created_time || '').slice(0, 40),
    lastModifiedTime: String(row.last_modified_time || '').slice(0, 40),
    open: balance > 0 && !['paid', 'void', 'draft'].includes(status),
  };
}

const LIST_FILTERS = new Set(['status', 'customer_id', 'date_start', 'date_end', 'last_modified_time']);
export const OPEN_INVOICE_STATUSES = ['overdue', 'partially_paid', 'sent', 'viewed'];
const RATE_LIMIT_RETRIES = 3;
const STORE_MAX_PAGES = 400;

function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function readInvoicePage({ fetchImpl, url, token, sleep }) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    const text = await response.text();
    // Zoho allows about 100 calls a minute; wait and retry instead of losing the sync.
    if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
      await sleep(15_000 * 2 ** attempt);
      continue;
    }
    const codeMatch = text.match(/"code"\s*:\s*(-?\d+)/);
    const code = codeMatch ? Number(codeMatch[1]) : null;
    if (!response.ok || (code !== null && code !== 0)) {
      throw zohoFailure(zohoMessage(text, response.status, 'invoice'));
    }
    return parseInvoiceListBody(text);
  }
}

/**
 * Read every page of the invoice list for the stored copy. Same read-only
 * invoices URL as the other lists. stopWhen(pageInvoices) ends the read early.
 */
export async function listInvoicePages({
  zoho, refreshToken, filters = {}, maxPages = STORE_MAX_PAGES, pauseMs = 0,
  stopWhen = null, fetchImpl = fetch, sleep = defaultSleep,
}) {
  for (const key of Object.keys(filters)) {
    if (!LIST_FILTERS.has(key)) throw zohoFailure(`The invoice list filter ${key} is not allowed.`);
  }
  const hosts = zohoHosts(zoho.dc);
  const organizationId = String(zoho.organizationId || '');
  if (!/^\d+$/.test(organizationId)) throw zohoFailure('ZOHO_ORGANIZATION_ID must be the numeric id from Zoho.');
  const token = await accessToken(zoho, refreshToken, fetchImpl);
  const invoices = [];
  const seen = new Set();
  let zohoRows = 0;
  let page = 1;
  let hasMore = true;
  let stopped = false;
  while (hasMore && page <= maxPages) {
    const params = new URLSearchParams({
      organization_id: organizationId,
      ...filters,
      page: String(page),
      per_page: '200',
    });
    const url = `${hosts.api}/books/v3/invoices?${params}`;
    assertAllowedUrl(url, zoho.dc, 'GET');
    const data = await readInvoicePage({ fetchImpl, url, token, sleep });
    const rows = Array.isArray(data.invoices) ? data.invoices : [];
    zohoRows += rows.length;
    const pageInvoices = [];
    for (const row of rows) {
      const mapped = mapStoredInvoice(row);
      if (!mapped || seen.has(mapped.invoiceId)) continue;
      seen.add(mapped.invoiceId);
      pageInvoices.push(mapped);
    }
    if (stopWhen && stopWhen(pageInvoices)) {
      stopped = true;
      break;
    }
    invoices.push(...pageInvoices);
    const pageContext = data.page_context || {};
    hasMore = pageContext.has_more_page === true || pageContext.has_more_page === 'true';
    if (rows.length === 0) hasMore = false;
    page += 1;
    if (hasMore && page <= maxPages && pauseMs > 0) await sleep(pauseMs);
  }
  return { invoices, zohoRows, truncated: hasMore && !stopped, stopped };
}

/**
 * Record a customer payment against one Zoho invoice.
 * Zoho marks the invoice paid or partially paid from amount_applied.
 */
export async function createCustomerPayment({
  zoho, refreshToken, payment, fetchImpl = fetch,
}) {
  if (!Number.isInteger(payment.amount) || payment.amount <= 0) {
    throw zohoFailure('The payment amount must be a whole number of rupiah.');
  }
  // One payment may settle several invoices of the same customer.
  const lines = Array.isArray(payment.invoices)
    ? payment.invoices
    : [{ invoiceId: payment.invoiceId, amountApplied: payment.amountApplied }];
  if (!lines.length || lines.length > 50) {
    throw zohoFailure('A customer payment must cover between 1 and 50 invoices.');
  }
  const invoiceLines = lines.map((line) => ({
    invoice_id: invoiceIdFrom(line.invoiceId),
    amount_applied: line.amountApplied,
  }));
  if (invoiceLines.some((line) => !line.invoice_id)) throw zohoFailure('The Zoho invoice id must be numeric.');
  if (new Set(invoiceLines.map((line) => line.invoice_id)).size !== invoiceLines.length) {
    throw zohoFailure('The same invoice appears twice in one payment.');
  }
  if (invoiceLines.some((line) => !Number.isInteger(line.amount_applied) || line.amount_applied <= 0)) {
    throw zohoFailure('The amount applied to the invoice must be a whole number of rupiah.');
  }
  const appliedTotal = invoiceLines.reduce((total, line) => total + line.amount_applied, 0);
  if (appliedTotal > payment.amount) {
    throw zohoFailure('Amount applied cannot exceed the payment amount.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payment.date || '')) {
    throw zohoFailure('The payment date must be an ISO date.');
  }
  const customerId = customerIdFrom(payment.customerId);
  const accountId = String(payment.accountId || '');
  if (!customerId) throw zohoFailure('The Zoho customer id must be numeric.');
  if (!/^\d+$/.test(accountId)) {
    throw zohoFailure('Set ZOHO_PAYMENT_DEPOSIT_ACCOUNT_ID to the Zoho bank account that receives transfers.');
  }
  const hosts = zohoHosts(zoho.dc);
  const organizationId = String(zoho.organizationId || '');
  if (!/^\d+$/.test(organizationId)) throw zohoFailure('ZOHO_ORGANIZATION_ID must be the numeric id from Zoho.');
  const payload = {
    customer_id: customerId,
    payment_mode: String(payment.paymentMode || 'Bank Transfer').slice(0, 100),
    amount: payment.amount,
    date: payment.date,
    reference_number: String(payment.referenceNumber || '').slice(0, 100),
    description: String(payment.description || '').slice(0, 200),
    account_id: accountId,
    invoices: invoiceLines,
  };
  const url = `${hosts.api}/books/v3/customerpayments?organization_id=${organizationId}`;
  assertAllowedUrl(url, zoho.dc, 'POST');
  const token = await accessToken(zoho, refreshToken, fetchImpl);
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const codeMatch = text.match(/"code"\s*:\s*(-?\d+)/);
  const code = codeMatch ? Number(codeMatch[1]) : null;
  if (!response.ok || (code !== null && code !== 0)) {
    throw zohoFailure(zohoMessage(text, response.status, 'payment'));
  }
  const paymentId = paymentIdFrom(text);
  if (!/^\d+$/.test(paymentId)) throw zohoFailure('Zoho Books did not return a payment id.');
  return { paymentId };
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

// Zoho keeps a past-due invoice with a part payment as "partially_paid", not "overdue".
const OVERDUE_STATUSES = ['overdue', 'partially_paid'];
const OVERDUE_MAX_PAGES = 40;

export async function listOverdueInvoices({
  zoho, refreshToken, fetchImpl = fetch, today = new Date(), stats = null,
}) {
  const hosts = zohoHosts(zoho.dc);
  const organizationId = String(zoho.organizationId || '');
  if (!/^\d+$/.test(organizationId)) throw zohoFailure('ZOHO_ORGANIZATION_ID must be the numeric id from Zoho.');
  const token = await accessToken(zoho, refreshToken, fetchImpl);
  const invoices = [];
  const seen = new Set();
  let zohoRows = 0;
  let truncated = false;
  for (const status of OVERDUE_STATUSES) {
    const result = await listInvoicesByStatus({
      hosts, organizationId, token, status, fetchImpl, today, zoho,
    });
    zohoRows += result.zohoRows;
    truncated = truncated || result.truncated;
    for (const invoice of result.invoices) {
      if (seen.has(invoice.invoiceId)) continue;
      seen.add(invoice.invoiceId);
      invoices.push(invoice);
    }
  }
  if (stats) Object.assign(stats, { zohoRows, kept: invoices.length, truncated });
  return invoices;
}

async function listInvoicesByStatus({
  hosts, organizationId, token, status, fetchImpl, today, zoho,
}) {
  const invoices = [];
  let zohoRows = 0;
  let page = 1;
  let hasMore = true;
  while (hasMore && page <= OVERDUE_MAX_PAGES) {
    const url = `${hosts.api}/books/v3/invoices?organization_id=${organizationId}&status=${status}&page=${page}&per_page=200`;
    assertAllowedUrl(url, zoho.dc, 'GET');
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    const text = await response.text();
    const codeMatch = text.match(/"code"\s*:\s*(-?\d+)/);
    const code = codeMatch ? Number(codeMatch[1]) : null;
    if (!response.ok || (code !== null && code !== 0)) {
      throw zohoFailure(zohoMessage(text, response.status, 'invoice'));
    }
    const data = parseInvoiceListBody(text);
    const rows = Array.isArray(data.invoices) ? data.invoices : [];
    zohoRows += rows.length;
    for (const row of rows) {
      const mapped = mapOverdueInvoice(row, today);
      if (mapped) invoices.push(mapped);
    }
    const pageContext = data.page_context || {};
    hasMore = pageContext.has_more_page === true || pageContext.has_more_page === 'true';
    page += 1;
    if (rows.length === 0) hasMore = false;
  }
  return { invoices, zohoRows, truncated: hasMore };
}

function pdfFileName(headerValue, invoiceNumber, invoiceId) {
  const match = String(headerValue || '').match(/filename\*?=(?:UTF-8''|")?([^\";]+)/i);
  if (match) {
    const raw = decodeURIComponent(match[1].replace(/["']/g, '')).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80);
    if (raw) return raw.toLowerCase().endsWith('.pdf') ? raw : `${raw}.pdf`;
  }
  const base = String(invoiceNumber || `invoice-${invoiceId}`).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60);
  return `${base || `invoice-${invoiceId}`}.pdf`;
}

/** Read-only: download one invoice PDF from Zoho Books. */
export async function getInvoicePdf({ zoho, refreshToken, invoiceId, invoiceNumber = '', fetchImpl = fetch }) {
  const id = invoiceIdFrom(invoiceId);
  if (!id) throw zohoFailure('The invoice id must be numeric.');
  const hosts = zohoHosts(zoho.dc);
  const organizationId = String(zoho.organizationId || '');
  if (!/^\d+$/.test(organizationId)) throw zohoFailure('ZOHO_ORGANIZATION_ID must be the numeric id from Zoho.');
  const url = `${hosts.api}/books/v3/invoices/${id}?organization_id=${organizationId}&accept=pdf`;
  assertAllowedUrl(url, zoho.dc, 'GET');
  const token = await accessToken(zoho, refreshToken, fetchImpl);
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      Accept: 'application/pdf',
    },
  });
  const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
  if (!response.ok) {
    const text = await response.text();
    throw zohoFailure(zohoMessage(text, response.status, 'invoice-pdf'));
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw zohoFailure('Zoho Books returned an empty invoice PDF.');
  // Zoho sometimes returns JSON error with 200; refuse non-PDF bodies.
  if (contentType.includes('json') || (bytes[0] === 0x7b /* { */ && !contentType.includes('pdf'))) {
    const text = bytes.toString('utf8').slice(0, 400);
    throw zohoFailure(zohoMessage(text, response.status, 'invoice-pdf'));
  }
  return {
    bytes,
    fileName: pdfFileName(response.headers?.get?.('content-disposition'), invoiceNumber, id),
    contentType: contentType.includes('pdf') ? 'application/pdf' : 'application/pdf',
  };
}

/** Read-only: one invoice JSON, for quantity and delivery fee on the summary. */
export async function getInvoiceJson({ zoho, refreshToken, invoiceId, fetchImpl = fetch }) {
  const id = invoiceIdFrom(invoiceId);
  if (!id) throw zohoFailure('The invoice id must be numeric.');
  const hosts = zohoHosts(zoho.dc);
  const organizationId = String(zoho.organizationId || '');
  if (!/^\d+$/.test(organizationId)) throw zohoFailure('ZOHO_ORGANIZATION_ID must be the numeric id from Zoho.');
  const url = `${hosts.api}/books/v3/invoices/${id}?organization_id=${organizationId}`;
  assertAllowedUrl(url, zoho.dc, 'GET');
  const token = await accessToken(zoho, refreshToken, fetchImpl);
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const text = await response.text();
  const codeMatch = text.match(/"code"\s*:\s*(-?\d+)/);
  const code = codeMatch ? Number(codeMatch[1]) : null;
  if (!response.ok || (code !== null && code !== 0)) {
    throw zohoFailure(zohoMessage(text, response.status, 'invoice'));
  }
  const data = parseInvoiceListBody(text);
  const invoice = data.invoice && typeof data.invoice === 'object' ? data.invoice : null;
  if (!invoice) throw zohoFailure('Zoho Books did not return the invoice.');
  return invoice;
}
