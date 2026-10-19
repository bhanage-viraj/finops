import { suggestCustomers } from '../services/followUp/customerSuggest.js';
import { followUpInvoicePdf } from '../services/followUp/invoicePdf.js';
import { receivableSummaryPdf } from '../services/followUp/receivableSummaryPdf.js';
import { todayFollowUp } from '../services/followUp/today.js';
import { asyncHandler } from '../utils/http.js';

export function today(env) {
  return asyncHandler(async (req, res) => {
    const {
      page, view, q, dueFrom, dueTo, refresh,
    } = req.query;
    res.json(await todayFollowUp(req.user, env, {
      page: String(page || ''),
      view: view === 'customer' ? 'customer' : 'due',
      q: String(q || ''),
      dueFrom: String(dueFrom || ''),
      dueTo: String(dueTo || ''),
      refresh: refresh === '1' ? '1' : '',
    }));
  });
}

export function invoicePdf(env) {
  return asyncHandler(async (req, res) => {
    const file = await followUpInvoicePdf(req.user, env, req.params.invoiceId);
    res.set('Content-Type', file.contentType || 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${file.fileName || 'invoice.pdf'}"`);
    res.set('Cache-Control', 'private, max-age=60');
    res.send(file.bytes);
  });
}

export function customers(env) {
  return asyncHandler(async (req, res) => {
    res.json(await suggestCustomers(req.user, env, String(req.query.q || '')));
  });
}

export function receivableSummary(env) {
  return asyncHandler(async (req, res) => {
    const preview = req.query.preview === '1';
    const file = await receivableSummaryPdf(req.user, env, {
      from: String(req.query.from || ''),
      to: String(req.query.to || ''),
      customer: String(req.query.customer || ''),
      fileName: String(req.query.fileName || ''),
      status: String(req.query.status || ''),
      preview,
    });
    res.set('Content-Type', file.contentType || 'application/pdf');
    res.set('Content-Disposition', `${preview ? 'inline' : 'attachment'}; filename="${file.fileName || 'Receivable-Summary.pdf'}"`);
    res.set('X-Summary-Customers', String(file.customerCount));
    res.set('X-Summary-Invoices', String(file.invoiceCount || 0));
    res.set('X-Summary-Total', String(file.total));
    res.set('X-Summary-Phone', file.phone || '');
    res.set('X-Summary-Name', encodeURIComponent(file.customerName || ''));
    res.set('Cache-Control', 'private, no-store');
    res.send(file.bytes);
  });
}
