import PDFDocument from 'pdfkit';
import Setting from '../../models/Setting.js';
import {
  getInvoiceJson, invoiceQtyAndDelivery, listInvoicesInDateRange, missingZohoConfig,
} from '../../integrations/erp/zohoBooks.js';
import { ensureInvoiceStore, unpaidInvoicesInRange } from '../zohoInvoices/invoiceStore.js';
import { writeAudit } from '../audit/auditLogger.js';
import { formatDueDateId } from './rank.js';
import { httpError } from '../../utils/http.js';

export const SUMMARY_STATUS_OPTIONS = ['overdue', 'paid', 'draft'];
const DETAIL_MAX = 40;
const DETAIL_CONCURRENCY = 4;

export function parseSummaryStatuses(raw) {
  const selected = [];
  for (const part of String(raw || '').split(/[,\s]+/)) {
    const status = part.trim().toLowerCase();
    if (SUMMARY_STATUS_OPTIONS.includes(status) && !selected.includes(status)) selected.push(status);
  }
  return selected;
}

function cleanDay(value) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function customerMatches(name, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  return String(name || '').toLowerCase().includes(needle);
}

/** Helvetica only covers WinAnsi. Drop other characters so one name cannot fail the file. */
function pdfPlain(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
}

function pdfSafe(value) {
  return pdfPlain(value) || 'Customer';
}

function statusLabel(status) {
  const text = String(status || '').toLowerCase();
  if (text === 'partially_paid') return 'Partially Paid';
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function invoiceAllowed(invoice, statuses, today) {
  if (!invoice) return false;
  if (invoice.currency && invoice.currency !== 'IDR') return false;
  const status = String(invoice.status || '').toLowerCase();
  if (status === 'void') return false;
  if (!statuses.length) {
    return Number.isInteger(invoice.balance) && invoice.balance > 0 && !['paid', 'draft'].includes(status);
  }
  if (statuses.includes('paid') && status === 'paid') {
    return Number.isInteger(invoice.invoiceTotal) || Number.isInteger(invoice.balance);
  }
  if (statuses.includes('draft') && status === 'draft') {
    return Number.isInteger(invoice.invoiceTotal) || Number.isInteger(invoice.balance);
  }
  if (statuses.includes('overdue')) {
    if (!Number.isInteger(invoice.balance) || invoice.balance <= 0) return false;
    if (status === 'overdue') return true;
    if (['sent', 'viewed', 'partially_paid'].includes(status)) {
      const due = invoice.dueDate || '';
      return /^\d{4}-\d{2}-\d{2}$/.test(due) && due < today;
    }
  }
  return false;
}

function lineAmount(invoice) {
  const status = String(invoice.status || '').toLowerCase();
  if (status === 'paid' || status === 'draft') {
    return Number.isInteger(invoice.invoiceTotal) ? invoice.invoiceTotal : (invoice.balance || 0);
  }
  return invoice.balance;
}

/**
 * Invoice rows for the receivable summary, plus one outstanding total per customer
 * so WhatsApp still sends a single balance.
 */
export function buildReceivableSummary(invoices, { from = '', to = '', customer = '', statuses = [] } = {}) {
  const groups = new Map();
  const lines = [];
  const today = todayIso();
  for (const invoice of invoices || []) {
    if (!invoiceAllowed(invoice, statuses, today)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(invoice.date || '')) continue;
    if (from && invoice.date < from) continue;
    if (to && invoice.date > to) continue;
    if (!customerMatches(invoice.customerName, customer)) continue;
    const invoiceTotal = Number.isInteger(invoice.invoiceTotal) ? invoice.invoiceTotal : (invoice.balance || 0);
    const amount = lineAmount(invoice);
    const key = invoice.customerId
      ? `id:${invoice.customerId}`
      : `name:${String(invoice.customerName || '').trim().toLowerCase() || 'unknown'}`;
    if (!groups.has(key)) {
      groups.set(key, {
        customerName: invoice.customerName || 'Unknown customer',
        customerPhone: invoice.customerPhone || '',
        total: 0,
      });
    }
    const group = groups.get(key);
    group.total += amount;
    if (!group.customerPhone && invoice.customerPhone) group.customerPhone = invoice.customerPhone;
    lines.push({
      invoiceId: invoice.invoiceId || '',
      createdTime: invoice.createdTime || '',
      customerName: invoice.customerName || 'Unknown customer',
      date: invoice.date,
      invoiceNumber: invoice.invoiceNumber || '',
      referenceNumber: invoice.referenceNumber || '',
      status: statusLabel(String(invoice.status || '').toLowerCase()),
      transactionType: 'Invoice',
      invoiceTotal,
      quantity: Number.isInteger(invoice.quantity) ? invoice.quantity : null,
      deliveryFee: Number.isInteger(invoice.deliveryFee) ? invoice.deliveryFee : null,
      balance: Number.isInteger(invoice.balance) ? invoice.balance : 0,
    });
  }
  lines.sort((a, b) => {
    const name = a.customerName.localeCompare(b.customerName);
    if (name !== 0) return name;
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return String(a.invoiceNumber).localeCompare(String(b.invoiceNumber));
  });
  const customers = [...groups.values()].sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.customerName.localeCompare(b.customerName);
  });
  const grandTotal = customers.reduce((sum, row) => sum + row.total, 0);
  return { customers, lines, grandTotal, invoiceCount: lines.length };
}

export function summaryFileName(customers, customerQuery) {
  if (String(customerQuery || '').trim() && customers.length === 1) {
    const slug = customers[0].customerName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    if (slug) return `Receivable-Summary-${slug}.pdf`;
  }
  return 'Receivable-Summary.pdf';
}

/** Accountant-chosen download name. Path characters are stripped so it cannot leave the download. */
export function sanitizeSummaryFileName(raw, fallback = 'Receivable-Summary.pdf') {
  const withoutExt = String(raw || '').replace(/\.pdf$/i, '');
  const slug = withoutExt
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/[^A-Za-z0-9._ -]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .trim()
    .replace(/^[-. ]+|[-. ]+$/g, '')
    .slice(0, 80);
  const base = slug || String(fallback || '').replace(/\.pdf$/i, '').slice(0, 80) || 'Receivable-Summary';
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}

/** Same money text as the Zoho receivable summary: IDR765,000.00 */
function formatIdr(amount) {
  if (!Number.isInteger(amount)) return '';
  return `IDR${amount.toLocaleString('en-US')}.00`;
}

const COLUMNS = [
  { key: 'createdTime', title: 'Created Time', width: 70 },
  { key: 'customerName', title: 'Customer Name', width: 76 },
  { key: 'date', title: 'Date', width: 46 },
  { key: 'invoiceNumber', title: 'Transaction#', width: 54 },
  { key: 'referenceNumber', title: 'Reference#', width: 44 },
  { key: 'status', title: 'Status', width: 48 },
  { key: 'transactionType', title: 'Transaction Type', width: 52 },
  { key: 'invoiceTotal', title: 'Total (BCY)', width: 60, money: true },
  { key: 'quantity', title: 'Quantity', width: 44, number: true },
  { key: 'balance', title: 'Balance (BCY)', width: 62, money: true },
  { key: 'deliveryFee', title: 'Delivery Fee', width: 62, money: true },
  { key: 'balance', title: 'Total', width: 60, money: true },
];

function cellText(line, column) {
  if (column.money) return formatIdr(line[column.key]);
  if (column.key === 'quantity') return Number.isInteger(line.quantity) ? String(line.quantity) : '';
  if (column.key === 'date') return formatDueDateId(line.date);
  if (column.key === 'customerName') return pdfSafe(line.customerName);
  return pdfPlain(line[column.key] || '');
}

function drawCells(doc, y, left, values, bold) {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7).fillColor('#16201D');
  let height = 9;
  values.forEach((value, index) => {
    height = Math.max(height, doc.heightOfString(value, { width: COLUMNS[index].width - 4 }));
  });
  let x = left;
  values.forEach((value, index) => {
    const column = COLUMNS[index];
    doc.text(value, x + 2, y, {
      width: column.width - 4,
      height,
      align: (column.money || column.number) ? 'right' : 'left',
    });
    x += column.width;
  });
  return y + height + 3;
}

/** pdfkit draws the receivable summary. Zoho does not return this report as a file. */
export function renderReceivableSummaryPdf(summary, { compress = true } = {}) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28, compress });
  const done = new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const left = doc.page.margins.left;
  const width = COLUMNS.reduce((sum, column) => sum + column.width, 0);

  function title() {
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#16201D').text('Jaan Water', left, doc.y, {
      width, align: 'center',
    });
    doc.font('Helvetica-Bold').fontSize(12).text('Receivable Summary', { width, align: 'center' });
    doc.font('Helvetica').fontSize(9).text(
      `From ${formatDueDateId(summary.from)} To ${formatDueDateId(summary.to)}`,
      { width, align: 'center' },
    );
    doc.moveDown(0.6);
  }

  function header() {
    const y = doc.y;
    doc.save();
    doc.rect(left, y - 2, width, 14).fill('#F3F4F3');
    doc.restore();
    doc.y = drawCells(doc, y, left, COLUMNS.map((column) => column.title), true);
    doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor('#D5DBD8').stroke();
    doc.y += 3;
  }

  title();
  header();
  const lines = summary.lines || [];
  if (!lines.length) {
    doc.font('Helvetica').fontSize(9).fillColor('#16201D').text(
      summary.emptyMessage || 'No invoices in this range.',
    );
  }
  for (const line of lines) {
    if (doc.y > doc.page.height - 48) {
      doc.addPage();
      header();
    }
    doc.y = drawCells(doc, doc.y, left, COLUMNS.map((column) => cellText(line, column)), false);
  }
  if (lines.length) {
    doc.moveDown(0.2);
    doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor('#D5DBD8').stroke();
    doc.moveDown(0.3);
    const totalLine = {
      createdTime: '',
      customerName: 'Total',
      date: '',
      invoiceNumber: '',
      referenceNumber: '',
      status: '',
      transactionType: '',
      invoiceTotal: lines.reduce((sum, line) => sum + (line.invoiceTotal || 0), 0),
      quantity: lines.reduce((sum, line) => sum + (Number.isInteger(line.quantity) ? line.quantity : 0), 0),
      deliveryFee: lines.reduce((sum, line) => sum + (Number.isInteger(line.deliveryFee) ? line.deliveryFee : 0), 0),
      balance: summary.grandTotal,
    };
    if (!lines.some((line) => Number.isInteger(line.quantity))) totalLine.quantity = null;
    if (!lines.some((line) => Number.isInteger(line.deliveryFee))) totalLine.deliveryFee = null;
    doc.y = drawCells(doc, doc.y, left, COLUMNS.map((column) => {
      if (column.key === 'customerName') return 'Total';
      if (column.key === 'quantity') return cellText(totalLine, column);
      if (!column.money) return '';
      return cellText(totalLine, column);
    }), true);
  }
  doc.end();
  return done;
}

async function loadSummaryInvoices({ env, refreshToken, from, to, statuses, deps }) {
  const invoices = [];
  const seen = new Set();
  let truncated = false;
  const needUnpaid = !statuses.length || statuses.includes('overdue');
  const listUnpaid = deps.listUnpaidInvoicesInRange || (async (range) => {
    await ensureInvoiceStore(env);
    return unpaidInvoicesInRange(range);
  });
  if (needUnpaid) {
    const result = await listUnpaid({
      zoho: env.zoho, refreshToken, fromDate: from, toDate: to,
    });
    truncated = truncated || result?.truncated === true;
    for (const invoice of result?.invoices || []) {
      if (!invoice?.invoiceId || seen.has(invoice.invoiceId)) continue;
      seen.add(invoice.invoiceId);
      invoices.push(invoice);
    }
  }
  const listRange = deps.listInvoicesInDateRange || listInvoicesInDateRange;
  for (const status of ['paid', 'draft']) {
    if (!statuses.includes(status)) continue;
    const result = await listRange({
      zoho: env.zoho, refreshToken, fromDate: from, toDate: to, status,
    });
    truncated = truncated || result?.truncated === true;
    for (const invoice of result?.invoices || []) {
      if (!invoice?.invoiceId || seen.has(invoice.invoiceId)) continue;
      seen.add(invoice.invoiceId);
      invoices.push(invoice);
    }
  }
  return { invoices, truncated };
}

async function fillQuantities(lines, { customer, env, refreshToken, deps }) {
  if (!String(customer || '').trim()) return lines;
  const mockedList = Boolean(deps.listUnpaidInvoicesInRange || deps.listInvoicesInDateRange);
  const load = deps.getInvoiceJson || (mockedList ? null : getInvoiceJson);
  if (!load) return lines;
  const ids = [...new Set(lines.map((line) => line.invoiceId).filter((id) => /^\d+$/.test(id)))];
  if (!ids.length || ids.length > DETAIL_MAX) return lines;
  const extras = new Map();
  let index = 0;
  async function worker() {
    while (index < ids.length) {
      const id = ids[index];
      index += 1;
      try {
        const detail = await load({ zoho: env.zoho, refreshToken, invoiceId: id });
        extras.set(id, invoiceQtyAndDelivery(detail));
      } catch {
        // Keep the row without quantity rather than fail the whole PDF.
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(DETAIL_CONCURRENCY, ids.length) },
    () => worker(),
  ));
  return lines.map((line) => {
    const extra = extras.get(line.invoiceId);
    if (!extra) return line;
    return { ...line, quantity: extra.quantity, deliveryFee: extra.deliveryFee };
  });
}

export async function receivableSummaryPdf(user, env, query = {}, deps = {}) {
  if (user.role !== 'accountant' && user.role !== 'admin') {
    throw httpError(403, 'Only an accountant or admin can open follow-up.');
  }
  const loadSettings = deps.loadSettings
    || (() => Setting.findOne().select('erpFeaturesEnabled zohoRefreshToken').lean());
  const settings = await loadSettings();
  if (settings?.erpFeaturesEnabled !== true) {
    throw httpError(403, 'Zoho export is turned off. An admin can enable it on the overview.');
  }
  const from = cleanDay(query.from);
  const to = cleanDay(query.to);
  if (!from || !to) throw httpError(400, 'Choose a start and end date.');
  if (from > to) throw httpError(400, 'The start date must be on or before the end date.');
  const customer = String(query.customer || '').trim().slice(0, 120);
  const statuses = parseSummaryStatuses(query.status);
  const refreshToken = env.zoho?.refreshToken || settings?.zohoRefreshToken || '';
  const missing = missingZohoConfig(env.zoho || {}, { refreshToken });
  if (missing.length) {
    throw httpError(400, `Zoho is not configured. Set ${missing.join(', ')}. Connect Zoho again if the token is missing.`);
  }
  const result = await loadSummaryInvoices({
    env, refreshToken, from, to, statuses, deps,
  });
  if (result.truncated) {
    throw httpError(422, 'Zoho has more invoices than this report can read. Narrow the date range.');
  }
  const summary = buildReceivableSummary(result.invoices, { from, to, customer, statuses });
  summary.lines = await fillQuantities(summary.lines, {
    customer, env, refreshToken, deps,
  });
  const asOf = new Date().toISOString().slice(0, 10);
  const emptyMessage = statuses.length
    ? 'No invoices match these filters in this range.'
    : 'No outstanding balances in this range.';
  const bytes = await renderReceivableSummaryPdf({ ...summary, from, to, asOf, emptyMessage });
  const phone = summary.customers.length === 1 ? (summary.customers[0].customerPhone || '') : '';
  const customerName = summary.customers.length === 1 ? summary.customers[0].customerName : '';
  const defaultName = summaryFileName(summary.customers, customer);
  const fileName = sanitizeSummaryFileName(query.fileName, defaultName);
  const preview = query.preview === '1' || query.preview === true;
  if (!preview) {
    const audit = deps.writeAudit || writeAudit;
    await audit({
      userId: user.id,
      action: 'followUp.receivableSummary',
      entity: 'followUp',
      after: {
        fromDate: from,
        toDate: to,
        customer,
        fileName,
        status: statuses.join(','),
        invoiceCount: summary.invoiceCount,
        customerCount: summary.customers.length,
        total: summary.grandTotal,
      },
    });
  }
  return {
    bytes,
    fileName,
    contentType: 'application/pdf',
    customerCount: summary.customers.length,
    invoiceCount: summary.invoiceCount,
    total: summary.grandTotal,
    phone,
    customerName,
    preview,
  };
}
