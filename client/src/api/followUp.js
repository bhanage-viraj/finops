import { api, apiFile } from './client.js';

export function fetchFollowUpToday() {
  return api('/follow-up/today');
}

export function fetchFollowUpInvoicePdf(invoiceId) {
  return apiFile(`/follow-up/invoices/${encodeURIComponent(invoiceId)}/pdf`);
}
