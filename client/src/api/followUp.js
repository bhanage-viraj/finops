import { api, apiFile } from './client.js';

export function fetchFollowUpToday(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== '' && value != null) query.set(key, String(value));
  }
  const text = query.toString();
  return api(`/follow-up/today${text ? `?${text}` : ''}`);
}

export function fetchFollowUpInvoicePdf(invoiceId) {
  return apiFile(`/follow-up/invoices/${encodeURIComponent(invoiceId)}/pdf`);
}
