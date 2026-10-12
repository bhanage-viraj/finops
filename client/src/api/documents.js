import { api, apiFile } from './client.js';

export function fetchStats() {
  return api('/documents/stats');
}

export function fetchDocuments(params) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value) query.set(key, value);
  });
  const suffix = query.toString() ? `?${query}` : '';
  return api(`/documents${suffix}`);
}

export function fetchDocument(id) {
  return api(`/documents/${id}`);
}

export function uploadDocuments(files) {
  const body = new FormData();
  for (const file of files) body.append('files', file);
  return api('/documents', { method: 'POST', body });
}

export function saveDocument(id, payload) {
  return api(`/documents/${id}`, { method: 'PATCH', json: payload });
}

export function submitDocument(id) {
  return api(`/documents/${id}/submit`, { method: 'POST' });
}

export function approveDocument(id) {
  return api(`/documents/${id}/approve`, { method: 'POST' });
}

export function rejectDocument(id, reason) {
  return api(`/documents/${id}/reject`, { method: 'POST', json: { reason } });
}

export function retryDocument(id) {
  return api(`/documents/${id}/retry`, { method: 'POST' });
}

export function sendZohoExpense(id) {
  return api(`/documents/${id}/zoho-expense`, { method: 'POST' });
}

export function chooseZohoAccount(id, selection) {
  const json = selection && typeof selection === 'object' ? selection : { accountId: selection };
  return api(`/documents/${id}/zoho-account`, { method: 'POST', json });
}

export function testZohoExpense(id) {
  return api(`/documents/${id}/zoho-preview`, { method: 'POST' });
}

export function fetchDocumentFile(id, which) {
  const suffix = which ? `?which=${which}` : '';
  return apiFile(`/documents/${id}/file${suffix}`);
}
