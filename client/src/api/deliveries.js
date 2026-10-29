import { api, apiFile, getToken } from './client.js';

export function fetchDeliveryDays() {
  return api('/deliveries');
}

export function fetchMarketTrends(refresh = false) {
  const suffix = refresh ? '?refresh=1' : '';
  return api(`/deliveries/market${suffix}`);
}

export function fetchSales(refresh = false) {
  const suffix = refresh ? '?refresh=1' : '';
  return api(`/deliveries/sales${suffix}`);
}

export function fetchDeliveryMeta() {
  return api('/deliveries/meta');
}

export function fetchDeliveryDay(dayId) {
  return api(`/deliveries/${dayId}`);
}

export function fetchNeedsLocation(dayId) {
  return api(`/deliveries/${dayId}/needs-location`);
}

export function fetchDayReport(dayId) {
  return api(`/deliveries/${dayId}/report`);
}

export function fetchAtRisk(dayId) {
  return api(`/deliveries/${dayId}/at-risk`);
}

export function importDeliverySheet(url, date) {
  return api('/deliveries/import-sheet', { method: 'POST', json: { url, date } });
}

export async function importDeliveryDay(file, date) {
  const body = new FormData();
  body.append('file', file);
  if (date) body.append('date', date);
  return api('/deliveries/import', { method: 'POST', body });
}

export async function importDeliveryHistory(file) {
  const body = new FormData();
  body.append('file', file);
  return api('/deliveries/import-history', { method: 'POST', body });
}

export function deleteDeliveryDay(dayId) {
  return api(`/deliveries/${dayId}`, { method: 'DELETE' });
}

export function setStopLocation(stopId, payload) {
  return api(`/deliveries/stops/${stopId}/location`, { method: 'PATCH', json: payload });
}

export function setStopStatus(stopId, payload) {
  return api(`/deliveries/stops/${stopId}/status`, { method: 'POST', json: payload });
}

export function moveStop(stopId, payload) {
  return api(`/deliveries/stops/${stopId}/move`, { method: 'PATCH', json: payload });
}

export function moveStops(dayId, payload) {
  return api(`/deliveries/${dayId}/moves`, { method: 'POST', json: payload });
}

export function deleteStops(dayId, payload) {
  return api(`/deliveries/${dayId}/stops/delete`, { method: 'POST', json: payload });
}

export function clearStopMaps(dayId, payload) {
  return api(`/deliveries/${dayId}/maps/delete`, { method: 'POST', json: payload });
}

export function updateStop(stopId, payload) {
  return api(`/deliveries/stops/${stopId}`, { method: 'PATCH', json: payload });
}

export function updateRoute(routeId, payload) {
  return api(`/deliveries/routes/${routeId}`, { method: 'PATCH', json: payload });
}

export function fetchRouteMessage(routeId) {
  return api(`/deliveries/routes/${routeId}/message`);
}

export function markMapSent(routeId) {
  return api(`/deliveries/routes/${routeId}/map-sent`, { method: 'POST' });
}

export function clearRouteMaps(routeId) {
  return api(`/deliveries/routes/${routeId}/maps`, { method: 'DELETE' });
}

export function reorderRoute(routeId) {
  return api(`/deliveries/routes/${routeId}/reorder`, { method: 'POST' });
}

export function dispatchDay(dayId) {
  return api(`/deliveries/${dayId}/dispatch`, { method: 'POST' });
}

export function closeDay(dayId) {
  return api(`/deliveries/${dayId}/close`, { method: 'POST' });
}

export function setCartrackEnabled(enabled) {
  return api('/deliveries/settings/cartrack', { method: 'POST', json: { enabled } });
}

export function sendCartrackJobs(routeId) {
  return api(`/deliveries/routes/${routeId}/cartrack/send`, { method: 'POST' });
}

export function syncCartrack(dayId) {
  return api(`/deliveries/${dayId}/cartrack/sync`, { method: 'POST' });
}

export function fetchGpsSuggestions(dayId) {
  return api(`/deliveries/${dayId}/cartrack/gps-suggestions`);
}

export function fetchDaySpeed(dayId) {
  return api(`/deliveries/${dayId}/speed`);
}

export function fetchFleetSpeed() {
  return api('/deliveries/speed');
}

export async function uploadNota(stopId, file, confirm = false) {
  const body = new FormData();
  body.append('file', file);
  if (confirm) body.append('confirm', 'true');
  return api(`/deliveries/stops/${stopId}/nota`, { method: 'POST', body });
}

export function confirmNota(stopId, payload) {
  return api(`/deliveries/stops/${stopId}/nota/confirm`, { method: 'POST', json: payload });
}

export function fetchEmpties(routeId) {
  return api(`/deliveries/routes/${routeId}/empties`);
}

export async function downloadDayExport(dayId) {
  const token = getToken();
  const response = await fetch(`/deliveries/${dayId}/export`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    const text = await response.text();
    let message = 'Export failed.';
    try { message = JSON.parse(text).error || message; } catch { /* ignore */ }
    throw new Error(message);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const named = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') || '');
  a.href = url;
  a.download = named?.[1] || `jaan-delivery-${dayId}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

export function fetchNotaFile(stopId) {
  return apiFile(`/deliveries/stops/${stopId}/nota/file`);
}
