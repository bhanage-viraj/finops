import Setting from '../../models/Setting.js';
import ZohoInvoice from '../../models/ZohoInvoice.js';
import ZohoSyncState from '../../models/ZohoSyncState.js';
import {
  listInvoicePages, mapOverdueInvoice, mapReceivableInvoice, missingZohoConfig, OPEN_INVOICE_STATUSES,
  zohoTimeMs, zohoTimeParam,
} from '../../integrations/erp/zohoBooks.js';
import { writeAudit } from '../audit/auditLogger.js';
import { httpError } from '../../utils/http.js';

let Invoice = ZohoInvoice;
let SyncState = ZohoSyncState;
let Settings = Setting;

const STATE_KEY = 'invoices';
const LOCK_MS = 20 * 60 * 1000;
const PAGE_PAUSE_MS = 700;
// Re-read a little before the last change time so an edit on the boundary is not missed.
const CHANGES_OVERLAP_MS = 5 * 60 * 1000;
const CHANGES_MAX_PAGES = 15;
const RECENT_DAYS = 14;
const RECENT_MAX_PAGES = 30;
const CUSTOMER_MAX_PAGES = 50;
const CUSTOMER_REFRESH_MS = 2 * 60 * 1000;
// After a full read, invoices no longer returned are checked per customer before they are closed.
const VERIFY_CUSTOMER_LIMIT = 100;
const OPEN_CACHE_MS = 5 * 60 * 1000;
const WITA_OFFSET_MS = 8 * 60 * 60 * 1000;

let version = 0;
let openCache = null;
let currentJob = null;
const customerRefreshedAt = new Map();
const customerInFlight = new Map();

function bumpVersion() {
  version += 1;
  openCache = null;
}

/** Bali (WITA, UTC+8) calendar day for a moment, as YYYY-MM-DD. */
export function witaDay(date) {
  return new Date(new Date(date).getTime() + WITA_OFFSET_MS).toISOString().slice(0, 10);
}

export async function zohoConnection(env) {
  const settings = await Settings.findOne().select('erpFeaturesEnabled zohoRefreshToken').lean();
  if (settings?.erpFeaturesEnabled !== true) {
    return { ready: false, status: 403, reason: 'Zoho export is turned off. An admin can enable it on the overview.' };
  }
  const refreshToken = settings?.zohoRefreshToken || env.zoho?.refreshToken || '';
  const missing = missingZohoConfig(env.zoho || {}, { refreshToken });
  if (missing.length) {
    return { ready: false, status: 422, reason: `Zoho is not connected (${missing.join(', ')}). Connect Zoho from the overview.` };
  }
  return { ready: true, refreshToken };
}

export async function loadSyncState() {
  return SyncState.findOne({ key: STATE_KEY }).lean();
}

async function setState(fields) {
  await SyncState.updateOne({ key: STATE_KEY }, { $set: fields }, { upsert: true });
}

/** Open rows are upserted. Closed rows only update a copy we already have. */
async function saveInvoices(invoices) {
  const seenAt = new Date();
  const ops = invoices.map((invoice) => ({
    updateOne: {
      filter: { invoiceId: invoice.invoiceId },
      update: { $set: { ...invoice, lastSeenAt: seenAt } },
      upsert: invoice.open,
    },
  }));
  for (let i = 0; i < ops.length; i += 500) {
    await Invoice.bulkWrite(ops.slice(i, i + 500), { ordered: false });
  }
  if (ops.length) bumpVersion();
  return ops.length;
}

async function closeUnseen(filter) {
  const result = await Invoice.updateMany({ open: true, ...filter }, { $set: { open: false } });
  if (result.modifiedCount) bumpVersion();
  return result.modifiedCount || 0;
}

function listArgs(env, conn, deps, extra) {
  return {
    zoho: env.zoho,
    refreshToken: conn.refreshToken,
    fetchImpl: deps.fetchImpl,
    sleep: deps.sleep,
    pauseMs: deps.pauseMs ?? PAGE_PAUSE_MS,
    ...extra,
  };
}

function openSnapshot(rows) {
  return rows.map((row) => `${row.invoiceId}:${row.balance}`).sort().join(',');
}

/** Read one customer's unpaid invoices from Zoho and make the copy match. */
async function refreshCustomerNow(env, conn, customerId, deps = {}) {
  const startedAt = new Date();
  const before = await Invoice.find({ open: true, customerId }).select('invoiceId balance').lean();
  let filterIgnored = false;
  const result = await listInvoicePages(listArgs(env, conn, deps, {
    filters: { status: 'unpaid', customer_id: customerId },
    maxPages: CUSTOMER_MAX_PAGES,
    // Zoho ignoring customer_id would return everyone; stop instead of closing the wrong rows.
    stopWhen: (rows) => {
      filterIgnored = rows.some((row) => row.customerId && row.customerId !== customerId);
      return filterIgnored;
    },
  }));
  if (filterIgnored) throw new Error('Zoho ignored the customer filter.');
  await saveInvoices(result.invoices.filter((row) => row.open && row.customerId === customerId));
  if (!result.truncated) await closeUnseen({ customerId, lastSeenAt: { $lt: startedAt } });
  customerRefreshedAt.set(customerId, Date.now());
  const after = await Invoice.find({ open: true, customerId }).select('invoiceId balance').lean();
  return { changed: openSnapshot(before) !== openSnapshot(after), openCount: after.length };
}

/**
 * Bring one customer's invoices up to date (at most every 2 minutes unless forced).
 * Never throws: on a Zoho error the copy is used as it is.
 */
export async function refreshCustomerInvoices(env, customerId, { force = false, deps = {} } = {}) {
  const id = String(customerId || '').trim();
  if (!/^\d+$/.test(id)) return null;
  if (!force && Date.now() - (customerRefreshedAt.get(id) || 0) < CUSTOMER_REFRESH_MS) return null;
  if (customerInFlight.has(id)) return customerInFlight.get(id);
  const work = (async () => {
    try {
      const conn = await zohoConnection(env);
      if (!conn.ready) return null;
      return await refreshCustomerNow(env, conn, id, deps);
    } catch (error) {
      console.error('Zoho customer invoice refresh failed', error.message);
      return null;
    } finally {
      customerInFlight.delete(id);
    }
  })();
  customerInFlight.set(id, work);
  return work;
}

function mergeInvoices(lists) {
  const byId = new Map();
  for (const row of lists.flat()) {
    if (row?.invoiceId) byId.set(row.invoiceId, row);
  }
  return [...byId.values()];
}

/** Every unpaid invoice Zoho will list. Splits by status, then by year, if one list is too long. */
async function listAllUnpaid(env, conn, deps) {
  const unpaid = await listInvoicePages(listArgs(env, conn, deps, { filters: { status: 'unpaid' } }));
  if (!unpaid.truncated) return unpaid;

  console.warn('Zoho unpaid list was truncated; reading each open status.');
  const parts = [];
  let truncated = false;
  for (const status of OPEN_INVOICE_STATUSES) {
    const part = await listInvoicePages(listArgs(env, conn, deps, { filters: { status } }));
    parts.push(part.invoices);
    truncated = truncated || part.truncated;
  }
  if (!truncated) return { invoices: mergeInvoices(parts), truncated: false };

  console.warn('Zoho status lists were truncated; reading unpaid invoices by year.');
  truncated = false;
  const thisYear = Number(witaDay(new Date()).slice(0, 4));
  const yearly = [];
  for (let year = thisYear; year >= thisYear - 15; year -= 1) {
    const part = await listInvoicePages(listArgs(env, conn, deps, {
      filters: { status: 'unpaid', date_start: `${year}-01-01`, date_end: `${year}-12-31` },
    }));
    yearly.push(part.invoices);
    truncated = truncated || part.truncated;
  }
  return { invoices: mergeInvoices([...parts, ...yearly]), truncated };
}

async function runFullSync(env, conn, deps) {
  const startedAt = new Date();
  await setState({ lastFullStartedAt: startedAt });
  const result = await listAllUnpaid(env, conn, deps);
  const open = result.invoices.filter((row) => row.open);
  await saveInvoices(open);
  let closed = 0;
  if (!result.truncated) {
    // A row can drop out of a page while Zoho shifts pages during the read. Check those customers once.
    const unseen = await Invoice.find({ open: true, lastSeenAt: { $lt: startedAt } }).select('customerId').lean();
    const customers = [...new Set(unseen.map((row) => row.customerId).filter(Boolean))];
    if (customers.length > VERIFY_CUSTOMER_LIMIT) {
      // Closing them would drop invoices that only missed a page. Keep them until the next full read.
      console.warn(`Full sync left ${customers.length} customers unchecked; not closing unseen invoices.`);
    } else {
      for (const customerId of customers) {
        await refreshCustomerNow(env, conn, customerId, deps).catch((error) => {
          console.error('Zoho customer check after full sync failed', error.message);
        });
      }
      closed = await closeUnseen({ lastSeenAt: { $lt: startedAt } });
    }
  }
  await setState({
    lastFullOkAt: new Date(),
    lastFullCount: open.length,
    lastFullTruncated: result.truncated,
    // Edits made while this read ran are picked up by the next changes read.
    lastChangesAt: startedAt,
    needsFull: false,
    lastError: '',
    lastErrorAt: null,
  });
  console.log(`Zoho invoice store full: ${open.length} open, ${closed} closed, truncated=${result.truncated}`);
  return { kind: 'full', open: open.length, closed, truncated: result.truncated };
}

async function runRecentWindow(env, conn, deps, runAt) {
  const start = witaDay(runAt.getTime() - RECENT_DAYS * 86_400_000);
  const result = await listInvoicePages(listArgs(env, conn, deps, {
    filters: { status: 'unpaid', date_start: start },
    maxPages: RECENT_MAX_PAGES,
  }));
  await saveInvoices(result.invoices.filter((row) => row.open));
  if (!result.truncated) await closeUnseen({ date: { $gte: start }, lastSeenAt: { $lt: runAt } });
  await setState({ lastChangesAt: runAt, lastChangesRunAt: runAt, lastError: '', lastErrorAt: null });
  return { kind: 'recent', changed: result.invoices.length, truncated: result.truncated };
}

async function runChangesSync(env, conn, deps) {
  const runAt = new Date();
  const state = await loadSyncState();
  if (state?.changesFilterWorks === false) return runRecentWindow(env, conn, deps, runAt);
  const base = state?.lastChangesAt || state?.lastFullStartedAt || runAt;
  const since = new Date(new Date(base).getTime() - CHANGES_OVERLAP_MS);
  let ignored = false;
  const result = await listInvoicePages(listArgs(env, conn, deps, {
    filters: { last_modified_time: zohoTimeParam(since) },
    maxPages: CHANGES_MAX_PAGES,
    // A row changed long before the filter time means Zoho ignored it.
    stopWhen: (rows) => {
      ignored = rows.some((row) => {
        const ms = zohoTimeMs(row.lastModifiedTime);
        return ms != null && ms < since.getTime() - 60_000;
      });
      return ignored;
    },
  }));
  if (ignored) {
    console.warn('Zoho ignored last_modified_time; using the last 14 days of unpaid invoices instead.');
    await setState({ changesFilterWorks: false });
    return runRecentWindow(env, conn, deps, runAt);
  }
  await saveInvoices(result.invoices);
  await setState({
    lastChangesAt: result.truncated ? base : runAt,
    lastChangesRunAt: runAt,
    needsFull: result.truncated,
    lastError: '',
    lastErrorAt: null,
  });
  console.log(`Zoho invoice store changes: ${result.invoices.length} rows, truncated=${result.truncated}`);
  return { kind: 'changes', changed: result.invoices.length, truncated: result.truncated };
}

async function withLock(work) {
  await SyncState.updateOne({ key: STATE_KEY }, { $setOnInsert: { key: STATE_KEY } }, { upsert: true });
  const now = new Date();
  const locked = await SyncState.findOneAndUpdate(
    { key: STATE_KEY, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
    { $set: { lockedUntil: new Date(now.getTime() + LOCK_MS) } },
    { returnDocument: 'after' },
  );
  if (!locked) return { skipped: true };
  try {
    return await work();
  } catch (error) {
    await setState({ lastError: String(error.message || 'Zoho sync failed.').slice(0, 300), lastErrorAt: new Date() });
    throw error;
  } finally {
    await SyncState.updateOne({ key: STATE_KEY }, { $set: { lockedUntil: null } });
  }
}

/** Run 'full' or 'changes'. The same kind already running is shared; another kind waits its turn. */
export function runInvoiceSync(kind, env, conn, deps = {}) {
  if (currentJob && currentJob.kind === kind) return currentJob.promise;
  const previous = currentJob ? currentJob.promise.catch(() => {}) : Promise.resolve();
  const job = kind === 'full' ? runFullSync : runChangesSync;
  const promise = previous.then(() => withLock(() => job(env, conn, deps)));
  const entry = { kind, promise };
  currentJob = entry;
  promise.catch(() => {}).finally(() => {
    if (currentJob === entry) currentJob = null;
  });
  return promise;
}

/** The first read fills the copy. Later calls return at once. */
export async function ensureInvoiceStore(env, deps = {}) {
  const state = await loadSyncState();
  if (state?.lastFullOkAt) return;
  const conn = await zohoConnection(env);
  if (!conn.ready) throw httpError(conn.status, conn.reason);
  const result = await runInvoiceSync('full', env, conn, deps);
  if (result?.skipped) {
    throw httpError(503, 'Zoho invoices are still loading into the app. Try again in a minute.');
  }
}

async function openRows() {
  const at = Date.now();
  if (openCache && openCache.version === version && at - openCache.at < OPEN_CACHE_MS) return openCache.rows;
  const seenVersion = version;
  const rows = await Invoice.find({ open: true }).lean();
  openCache = { version: seenVersion, at, rows };
  return rows;
}

function zohoRow(doc) {
  return {
    invoice_id: doc.invoiceId,
    invoice_number: doc.invoiceNumber,
    reference_number: doc.referenceNumber,
    customer_id: doc.customerId,
    customer_name: doc.customerName,
    customer_phone: doc.customerPhone,
    date: doc.date,
    due_date: doc.dueDate,
    created_time: doc.createdTime,
    status: doc.status,
    total: doc.total,
    balance: doc.balance,
    currency_code: 'IDR',
    invoice_url: doc.invoiceUrl,
  };
}

function toMatchingInvoice(doc) {
  return {
    invoiceId: doc.invoiceId,
    invoiceNo: doc.invoiceNumber,
    invoiceNumber: doc.invoiceNumber,
    customerId: doc.customerId,
    customerName: doc.customerName,
    aliases: [],
    remaining: doc.balance,
    balance: doc.balance,
    dueDate: doc.dueDate || null,
    date: doc.date || null,
    status: doc.status,
    currency: 'IDR',
  };
}

/** Every unpaid invoice with a customer, in the shape the payment matcher reads. */
export async function openInvoicesForMatching() {
  const rows = await openRows();
  return rows.filter((row) => row.customerId && row.balance > 0).map(toMatchingInvoice);
}

/** One customer's unpaid invoices from the copy, not a capped company-wide slice. */
export async function openInvoicesForCustomer(customerId) {
  const id = String(customerId || '').trim();
  if (!/^\d+$/.test(id)) return [];
  const rows = await Invoice.find({ open: true, customerId: id, balance: { $gt: 0 } }).lean();
  return rows.map(toMatchingInvoice);
}

/** Overdue invoices for Follow-up, through the same rules as the live Zoho list. */
export async function overdueInvoicesFromStore(today = new Date()) {
  const rows = await openRows();
  const state = await loadSyncState();
  return {
    invoices: rows.map((row) => mapOverdueInvoice(zohoRow(row), today)).filter(Boolean),
    // Same count the live list reported: rows Zoho files as overdue or part paid.
    zohoRows: rows.filter((row) => ['overdue', 'partially_paid'].includes(row.status)).length,
    truncated: state?.lastFullTruncated === true,
  };
}

/** Pick up recent Zoho edits now. Skipped while another read is running. Never throws. */
export async function syncInvoiceChanges(env) {
  if (currentJob) return null;
  try {
    const conn = await zohoConnection(env);
    if (!conn.ready) return null;
    return await runInvoiceSync('changes', env, conn);
  } catch (error) {
    console.error('Zoho invoice changes read failed', error.message);
    return null;
  }
}

/** Unpaid invoices dated inside the range, for the receivable summary PDF. */
export async function unpaidInvoicesInRange({ fromDate, toDate }) {
  const rows = await Invoice.find({ open: true, date: { $gte: fromDate, $lte: toDate } }).lean();
  const state = await loadSyncState();
  return {
    invoices: rows.map((row) => mapReceivableInvoice(zohoRow(row))).filter(Boolean),
    truncated: state?.lastFullTruncated === true,
  };
}

export async function invoiceStoreStatus() {
  const [state, openCount] = await Promise.all([
    loadSyncState(),
    Invoice.countDocuments({ open: true }),
  ]);
  return {
    openCount,
    running: Boolean(currentJob) || Boolean(state?.lockedUntil && new Date(state.lockedUntil) > new Date()),
    lastFullOkAt: state?.lastFullOkAt || null,
    lastFullStartedAt: state?.lastFullStartedAt || null,
    lastFullTruncated: state?.lastFullTruncated === true,
    lastChangesRunAt: state?.lastChangesRunAt || null,
    lastError: state?.lastError || '',
    lastErrorAt: state?.lastErrorAt || null,
  };
}

/** Accountant asked for a full read now. Runs in the background. */
export async function requestFullInvoiceSync(user, env) {
  const conn = await zohoConnection(env);
  if (!conn.ready) throw httpError(conn.status, conn.reason);
  runInvoiceSync('full', env, conn).catch((error) => {
    console.error('Zoho full invoice sync failed', error.message);
  });
  await writeAudit({
    userId: user.id,
    action: 'zohoInvoices.sync',
    entity: 'zohoInvoices',
    after: { kind: 'full' },
  });
  return invoiceStoreStatus();
}

export function resetInvoiceStoreMemory() {
  bumpVersion();
  currentJob = null;
  customerRefreshedAt.clear();
  customerInFlight.clear();
  Invoice = ZohoInvoice;
  SyncState = ZohoSyncState;
  Settings = Setting;
}

/** Tests can point the store at a private Mongo connection. */
export function setInvoiceStoreModels({ invoice, syncState, setting } = {}) {
  if (invoice) Invoice = invoice;
  if (syncState) SyncState = syncState;
  if (setting) Settings = setting;
}
