import { api, apiFile } from './client.js';

export function fetchPayments(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value) query.set(key, value);
  });
  const suffix = query.toString() ? `?${query}` : '';
  return api(`/payments${suffix}`);
}

export function fetchPayment(id) {
  return api(`/payments/${id}`);
}

export function uploadPayments(files, hints = {}) {
  const body = new FormData();
  for (const file of files) body.append('files', file);
  Object.entries(hints).forEach(([key, value]) => {
    if (value != null && String(value).trim() !== '') body.append(key, String(value));
  });
  return api('/payments', { method: 'POST', body });
}

export function updatePaymentHints(id, payload) {
  return api(`/payments/${id}/hints`, { method: 'PATCH', json: payload });
}

export function matchPayment(id, payload) {
  return api(`/payments/${id}/match`, { method: 'PATCH', json: payload });
}

export function verifyPayment(id) {
  return api(`/payments/${id}/verify`, { method: 'POST' });
}

export function approvePayment(id, payload = {}) {
  return api(`/payments/${id}/approve`, { method: 'POST', json: payload });
}

export function rejectPayment(id, reason) {
  return api(`/payments/${id}/reject`, { method: 'POST', json: { reason } });
}

export function deletePayment(id) {
  return api(`/payments/${id}`, { method: 'DELETE' });
}

export function fetchOpenInvoices(q = '', customerId = '') {
  const query = new URLSearchParams();
  if (q) query.set('q', q);
  if (customerId) query.set('customerId', String(customerId));
  const suffix = query.toString() ? `?${query}` : '';
  return api(`/payments/invoices/open${suffix}`);
}

export function fetchPaymentFile(id) {
  return apiFile(`/payments/${id}/file`);
}
