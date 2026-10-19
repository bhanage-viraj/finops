import { api, apiFile, getToken, setToken } from './client.js';

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

export async function fetchReceivableSummaryPdf({ from, to, customer, fileName, preview }) {
  const query = new URLSearchParams({ from, to });
  if (String(customer || '').trim()) query.set('customer', String(customer).trim());
  if (String(fileName || '').trim()) query.set('fileName', String(fileName).trim());
  if (preview) query.set('preview', '1');
  const token = getToken();
  const response = await fetch(`/follow-up/receivable-summary.pdf?${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (response.status === 401) setToken('');
  if (!response.ok) {
    const text = await response.text();
    let message = 'The summary could not be downloaded.';
    try {
      message = JSON.parse(text).error || message;
    } catch {
      // The server did not return JSON.
    }
    throw new Error(message);
  }
  const disposition = response.headers.get('content-disposition') || '';
  const match = disposition.match(/filename="([^"]+)"/);
  let customerName = '';
  try {
    customerName = decodeURIComponent(response.headers.get('x-summary-name') || '');
  } catch {
    customerName = '';
  }
  const total = Number(response.headers.get('x-summary-total') || 0);
  return {
    blob: await response.blob(),
    fileName: match?.[1] || 'Receivable-Summary.pdf',
    customerCount: Number(response.headers.get('x-summary-customers') || 0),
    invoiceCount: Number(response.headers.get('x-summary-invoices') || 0),
    total: Number.isInteger(total) ? total : 0,
    phone: response.headers.get('x-summary-phone') || '',
    customerName,
  };
}
