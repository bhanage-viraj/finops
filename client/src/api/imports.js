import { api } from './client.js';

export function importCustomersCsv(file) {
  const body = new FormData();
  body.append('file', file);
  return api('/imports/customers', { method: 'POST', body });
}

export function importInvoicesCsv(file) {
  const body = new FormData();
  body.append('file', file);
  return api('/imports/invoices', { method: 'POST', body });
}
