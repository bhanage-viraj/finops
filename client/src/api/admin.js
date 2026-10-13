import { api } from './client.js';

export function fetchSettings() {
  return api('/admin/settings');
}

export function setExpenseExport(enabled) {
  return api('/admin/settings', { method: 'PATCH', json: { erpFeaturesEnabled: enabled } });
}

export function startZohoConnect() {
  return api('/auth/zoho/start');
}

export function clearAllDocuments() {
  return api('/admin/documents/clear', { method: 'POST' });
}
