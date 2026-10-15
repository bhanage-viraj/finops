import { followUpInvoicePdf } from '../services/followUp/invoicePdf.js';
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
