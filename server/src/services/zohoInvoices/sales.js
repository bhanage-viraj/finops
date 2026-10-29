import { listInvoicePages } from '../../integrations/erp/zohoBooks.js';
import { httpError } from '../../utils/http.js';
import { demandChannel } from '../deliveries/marketTrends.js';
import { zohoConnection } from './invoiceStore.js';

const CACHE_MS = 15 * 60 * 1000;
const SALE_STATUSES = ['paid', 'unpaid'];
const CHANNELS = ['home', 'hotel', 'restaurant', 'depo'];

let cache = null;
let inflight = null;

function emptyChannels() {
  return {
    home: { count: 0, total: 0 },
    hotel: { count: 0, total: 0 },
    restaurant: { count: 0, total: 0 },
    depo: { count: 0, total: 0 },
  };
}

/** A sale is an issued invoice with a rupiah total. Drafts and voids are not sales. */
export function isSale(invoice) {
  const status = String(invoice?.status || '').toLowerCase();
  if (!invoice?.invoiceId || !/^\d{4}-\d{2}-\d{2}$/.test(invoice.date || '')) return false;
  if (!status || status === 'void' || status === 'draft') return false;
  if (!Number.isInteger(invoice.total) || invoice.total <= 0) return false;
  return true;
}

export function uniqueSales(invoices) {
  const seen = new Set();
  const sales = [];
  for (const invoice of invoices || []) {
    if (!isSale(invoice) || seen.has(invoice.invoiceId)) continue;
    seen.add(invoice.invoiceId);
    sales.push(invoice);
  }
  return sales;
}

function monthLabel(key) {
  const [year, month] = String(key || '').split('-');
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const name = names[Number(month) - 1];
  return name && year ? `${name} ${year}` : key;
}

/** Month totals for the whole company. One invoice counts once. */
export function summarizeSales(invoices, { truncated = false, readAt = new Date().toISOString() } = {}) {
  const sales = uniqueSales(invoices);
  const groups = new Map();
  let total = 0;
  for (const invoice of sales) {
    const key = invoice.date.slice(0, 7);
    let month = groups.get(key);
    if (!month) {
      month = {
        month: key,
        label: monthLabel(key),
        total: 0,
        count: 0,
        paid: 0,
        open: 0,
        days: new Set(),
        channels: emptyChannels(),
      };
      groups.set(key, month);
    }
    const channel = CHANNELS.includes(demandChannel(invoice.customerName))
      ? demandChannel(invoice.customerName)
      : 'home';
    month.total += invoice.total;
    month.count += 1;
    month.days.add(invoice.date);
    month.channels[channel].count += 1;
    month.channels[channel].total += invoice.total;
    if (invoice.status === 'paid' || invoice.balance === 0) month.paid += invoice.total;
    else month.open += invoice.total;
    total += invoice.total;
  }

  const months = [...groups.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((month) => ({
      month: month.month,
      label: month.label,
      total: month.total,
      count: month.count,
      paid: month.paid,
      open: month.open,
      dayCount: month.days.size,
      dailyAverage: month.days.size ? Math.round(month.total / month.days.size) : 0,
      channels: month.channels,
    }));

  const ranked = months.filter((month) => month.dayCount >= 20).sort((a, b) => b.total - a.total);
  const ready = ranked.length >= 2;
  return {
    sourceName: 'Zoho Books',
    readAt,
    truncated,
    invoiceCount: sales.length,
    total,
    months,
    latestMonth: months[months.length - 1] || null,
    season: {
      ready,
      high: ready ? { month: ranked[0].month, label: ranked[0].label, total: ranked[0].total } : null,
      low: ready ? { month: ranked[ranked.length - 1].month, label: ranked[ranked.length - 1].label, total: ranked[ranked.length - 1].total } : null,
      note: ready
        ? 'High season is the month with the most sales. Low season is the month with the least. A month needs 20 selling days before it counts.'
        : 'High and low season show once Zoho has two months with at least 20 selling days.',
    },
  };
}

async function invoicesForStatus(env, refreshToken, status) {
  const base = { zoho: env.zoho, refreshToken, pauseMs: 650, maxPages: 60 };
  const all = await listInvoicePages({ ...base, filters: { status } });
  if (!all.truncated) return { invoices: all.invoices, truncated: false };
  const year = new Date().getFullYear();
  const invoices = [];
  let truncated = false;
  for (let y = year; y >= year - 5; y -= 1) {
    const part = await listInvoicePages({
      ...base,
      maxPages: 40,
      filters: { status, date_start: `${y}-01-01`, date_end: `${y}-12-31` },
    });
    invoices.push(...part.invoices);
    truncated = truncated || part.truncated;
  }
  return { invoices, truncated };
}

async function fetchSales(env) {
  const conn = await zohoConnection(env);
  if (!conn.ready) throw httpError(conn.status, conn.reason);
  const batches = [];
  let truncated = false;
  for (const status of SALE_STATUSES) {
    const part = await invoicesForStatus(env, conn.refreshToken, status);
    batches.push(...part.invoices);
    truncated = truncated || part.truncated;
  }
  return summarizeSales(batches, { truncated });
}

export async function loadZohoSales(env, { refresh = false } = {}) {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return cache.payload;
  if (!refresh && inflight) return inflight;
  const job = fetchSales(env).then((payload) => {
    cache = { at: Date.now(), payload };
    return payload;
  });
  if (!refresh) inflight = job.finally(() => { inflight = null; });
  return job;
}
