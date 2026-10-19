import PDFDocument from 'pdfkit';
import Setting from '../../models/Setting.js';
import { listUnpaidInvoicesInRange, missingZohoConfig } from '../../integrations/erp/zohoBooks.js';
import { writeAudit } from '../audit/auditLogger.js';
import { formatDueDateId, formatRupiahText } from './rank.js';
import { httpError } from '../../utils/http.js';

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
function pdfSafe(value) {
  const text = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
  return text || 'Customer';
}

/**
 * One row per customer: outstanding total only. Invoice lines stay out of the result.
 */
export function buildReceivableSummary(invoices, { from = '', to = '', customer = '' } = {}) {
  const groups = new Map();
  let invoiceCount = 0;
  for (const invoice of invoices || []) {
    if (!invoice || !Number.isInteger(invoice.balance) || invoice.balance <= 0) continue;
    if (invoice.currency && invoice.currency !== 'IDR') continue;
    const status = String(invoice.status || '').toLowerCase();
    if (['paid', 'void', 'draft'].includes(status)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(invoice.date || '')) continue;
    if (from && invoice.date < from) continue;
    if (to && invoice.date > to) continue;
    if (!customerMatches(invoice.customerName, customer)) continue;
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
    group.total += invoice.balance;
    if (!group.customerPhone && invoice.customerPhone) group.customerPhone = invoice.customerPhone;
    invoiceCount += 1;
  }
  const customers = [...groups.values()].sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.customerName.localeCompare(b.customerName);
  });
  const grandTotal = customers.reduce((sum, row) => sum + row.total, 0);
  return { customers, grandTotal, invoiceCount };
}

export function summaryFileName(customers, customerQuery) {
  if (String(customerQuery || '').trim() && customers.length === 1) {
    const slug = customers[0].customerName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    if (slug) return `Receivable-Summary-${slug}.pdf`;
  }
  return 'Receivable-Summary.pdf';
}

function drawRow(doc, nameX, amountX, nameWidth, amountWidth, name, amount, bold) {
  const y = doc.y;
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor('#16201D');
  const nameHeight = doc.heightOfString(name, { width: nameWidth });
  const amountHeight = doc.heightOfString(amount, { width: amountWidth });
  doc.text(name, nameX, y, { width: nameWidth, height: nameHeight });
  doc.text(amount, amountX, y, { width: amountWidth, align: 'right', height: amountHeight });
  doc.y = y + Math.max(nameHeight, amountHeight) + 6;
}

/** pdfkit is the server's PDF writer. Zoho does not return this report. */
export function renderReceivableSummaryPdf(summary, { compress = true } = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 48, compress });
  const done = new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const nameX = doc.page.margins.left;
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const amountWidth = 140;
  const nameWidth = pageWidth - amountWidth - 12;
  const amountX = nameX + pageWidth - amountWidth;

  doc.font('Helvetica-Bold').fontSize(16).fillColor('#16201D').text('Receivable Summary');
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(10).fillColor('#4F5B57');
  doc.text(`From ${formatDueDateId(summary.from)} to ${formatDueDateId(summary.to)}`);
  doc.text(`As of ${formatDueDateId(summary.asOf)}`);
  doc.text('Grouped by customer. Each row is the total still to pay. Invoice lines and credit notes are not included.');
  doc.moveDown(0.8);

  function header() {
    drawRow(doc, nameX, amountX, nameWidth, amountWidth, 'Customer', 'Outstanding', true);
    doc.moveTo(nameX, doc.y).lineTo(nameX + pageWidth, doc.y).strokeColor('#E1E5E3').stroke();
    doc.moveDown(0.4);
  }
  header();

  if (!summary.customers.length) {
    doc.font('Helvetica').fontSize(10).fillColor('#16201D').text('No outstanding balances in this range.');
    doc.moveDown(0.4);
  }
  for (const row of summary.customers) {
    if (doc.y > doc.page.height - 90) {
      doc.addPage();
      header();
    }
    drawRow(
      doc,
      nameX,
      amountX,
      nameWidth,
      amountWidth,
      pdfSafe(row.customerName),
      formatRupiahText(row.total),
      false,
    );
  }
  doc.moveDown(0.2);
  doc.moveTo(nameX, doc.y).lineTo(nameX + pageWidth, doc.y).strokeColor('#E1E5E3').stroke();
  doc.moveDown(0.4);
  drawRow(doc, nameX, amountX, nameWidth, amountWidth, 'Total', formatRupiahText(summary.grandTotal), true);
  doc.end();
  return done;
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
  const refreshToken = env.zoho?.refreshToken || settings?.zohoRefreshToken || '';
  const missing = missingZohoConfig(env.zoho || {}, { refreshToken });
  if (missing.length) {
    throw httpError(400, `Zoho is not configured. Set ${missing.join(', ')}. Connect Zoho again if the token is missing.`);
  }
  const list = deps.listUnpaidInvoicesInRange || listUnpaidInvoicesInRange;
  const result = await list({
    zoho: env.zoho,
    refreshToken,
    fromDate: from,
    toDate: to,
  });
  if (result?.truncated) {
    throw httpError(422, 'Zoho has more unpaid invoices than this report can read. Narrow the date range.');
  }
  const summary = buildReceivableSummary(result?.invoices || [], { from, to, customer });
  const asOf = new Date().toISOString().slice(0, 10);
  const bytes = await renderReceivableSummaryPdf({ ...summary, from, to, asOf });
  const phone = summary.customers.length === 1 ? (summary.customers[0].customerPhone || '') : '';
  const customerName = summary.customers.length === 1 ? summary.customers[0].customerName : '';
  const audit = deps.writeAudit || writeAudit;
  await audit({
    userId: user.id,
    action: 'followUp.receivableSummary',
    entity: 'followUp',
    after: {
      fromDate: from,
      toDate: to,
      customer,
      invoiceCount: summary.invoiceCount,
      customerCount: summary.customers.length,
      total: summary.grandTotal,
    },
  });
  return {
    bytes,
    fileName: summaryFileName(summary.customers, customer),
    contentType: 'application/pdf',
    customerCount: summary.customers.length,
    total: summary.grandTotal,
    phone,
    customerName,
  };
}
