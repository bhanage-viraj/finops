import Setting from '../../models/Setting.js';
import { missingZohoConfig } from '../../integrations/erp/zohoBooks.js';
import { httpError } from '../../utils/http.js';
import {
  ensureInvoiceStore, overdueInvoicesFromStore, syncInvoiceChanges,
} from '../zohoInvoices/invoiceStore.js';
import {
  REMINDER_TEXT, draftCombinedWhatsAppMessage, draftWhatsAppMessage, groupOverdueByCustomer, rankOverdueInvoices,
} from './rank.js';

export const INVOICES_PER_PAGE = 100;
export const CUSTOMERS_PER_PAGE = 50;
// Reading every overdue invoice takes many Zoho pages; reuse it while the accountant pages through.
const CACHE_MS = 3 * 60 * 1000;
let cache = null;

export function clearFollowUpCache() {
  cache = null;
}

async function loadOverdue(env, refreshToken, list, fresh) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache;
  const stats = {};
  const raw = await list({ zoho: env.zoho, refreshToken, stats });
  cache = {
    at: Date.now(),
    asOf: new Date().toISOString().slice(0, 10),
    invoices: rankOverdueInvoices(raw),
    stats: {
      zohoRows: Number.isInteger(stats.zohoRows) ? stats.zohoRows : raw.length,
      truncated: stats.truncated === true,
    },
  };
  return cache;
}

/** Reads the MongoDB copy of Zoho (every page), in the shape the live Zoho list returned. */
function storeOverdueList(env, fresh) {
  return async ({ stats }) => {
    await ensureInvoiceStore(env);
    if (fresh) await syncInvoiceChanges(env);
    const result = await overdueInvoicesFromStore(new Date());
    Object.assign(stats, { zohoRows: result.zohoRows, truncated: result.truncated });
    return result.invoices;
  };
}

function cleanDay(value) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function pageNumber(value) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

export function filterOverdue(invoices, { q = '', dueFrom = '', dueTo = '' } = {}) {
  const from = cleanDay(dueFrom);
  const to = cleanDay(dueTo);
  const needle = String(q || '').trim().toLowerCase().slice(0, 100);
  return invoices.filter((invoice) => {
    if (from && invoice.dueDate < from) return false;
    if (to && invoice.dueDate > to) return false;
    if (!needle) return true;
    const hay = [invoice.customerName, invoice.invoiceNumber, invoice.invoiceId, invoice.customerPhone]
      .join(' ')
      .toLowerCase();
    return hay.includes(needle);
  });
}

/** One page of rows plus where it sits in the whole list. */
export function pageOf(rows, page, perPage) {
  const pageCount = Math.max(1, Math.ceil(rows.length / perPage));
  const current = Math.min(page, pageCount);
  const start = (current - 1) * perPage;
  return {
    rows: rows.slice(start, start + perPage),
    page: current,
    pageCount,
    perPage,
    from: rows.length ? start + 1 : 0,
    to: Math.min(start + perPage, rows.length),
    total: rows.length,
  };
}

export async function todayFollowUp(user, env, query = {}, deps = {}) {
  if (user.role !== 'accountant' && user.role !== 'admin') {
    throw httpError(403, 'Only an accountant or admin can open follow-up.');
  }
  const settings = await Setting.findOne().select('erpFeaturesEnabled zohoRefreshToken').lean();
  if (settings?.erpFeaturesEnabled !== true) {
    throw httpError(403, 'Zoho export is turned off. An admin can enable it on the overview.');
  }
  const refreshToken = env.zoho?.refreshToken || settings?.zohoRefreshToken || '';
  const missing = missingZohoConfig(env.zoho || {}, { refreshToken });
  if (missing.length) {
    throw httpError(400, `Zoho is not configured. Set ${missing.join(', ')}. Connect Zoho again if the token is missing.`);
  }
  const fresh = query.refresh === '1';
  const list = deps.listOverdueInvoices || storeOverdueList(env, fresh);
  const data = await loadOverdue(env, refreshToken, list, fresh);
  const filtered = filterOverdue(data.invoices, query);
  const page = pageNumber(query.page);
  const base = {
    asOf: data.asOf,
    totalOverdue: data.invoices.length,
    totalMatching: filtered.length,
    zohoRows: data.stats.zohoRows,
    truncated: data.stats.truncated,
    // Lets the screen rebuild a combined message for any ticked subset.
    reminderText: REMINDER_TEXT,
  };

  if (query.view === 'customer') {
    const groups = groupOverdueByCustomer(filtered);
    const { rows, ...pageInfo } = pageOf(groups, page, CUSTOMERS_PER_PAGE);
    const invoices = rows.flatMap((group) => group.invoices)
      .map((invoice) => ({ ...invoice, messageDraft: draftWhatsAppMessage(invoice) }));
    return {
      ...base,
      view: 'customer',
      page: { ...pageInfo, unit: 'customers' },
      invoices,
      customers: rows.map((group) => ({
        key: group.key,
        customerId: group.customerId,
        customerName: group.customerName,
        customerPhone: group.customerPhone,
        invoiceIds: group.invoices.map((invoice) => invoice.invoiceId),
        total: group.total,
        maxDaysOverdue: group.maxDaysOverdue,
        fullMessageDraft: draftCombinedWhatsAppMessage(group.invoices),
      })),
    };
  }

  const { rows, ...pageInfo } = pageOf(filtered, page, INVOICES_PER_PAGE);
  return {
    ...base,
    view: 'due',
    page: { ...pageInfo, unit: 'invoices' },
    invoices: rows.map((invoice) => ({ ...invoice, messageDraft: draftWhatsAppMessage(invoice) })),
    customers: [],
  };
}
