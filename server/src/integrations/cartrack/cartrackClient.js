import { httpError } from '../../utils/http.js';

/**
 * Single Cartrack Fleet API caller for Indonesia.
 * Basic auth. Max ~60 calls/min for status endpoints.
 */
export function createCartrackClient(env, { fetchImpl = fetch } = {}) {
  const base = String(env.cartrack?.baseUrl || 'https://fleetapi-id.cartrack.com/rest').replace(/\/$/, '');
  const username = env.cartrack?.username || '';
  const apiKey = env.cartrack?.apiKey || '';

  function configured() {
    return Boolean(username && apiKey);
  }

  async function request(method, path, { query, body } = {}) {
    if (!configured()) {
      throw httpError(503, 'Cartrack is not configured. Set CARTRACK_USERNAME and CARTRACK_API_KEY.');
    }
    const url = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v != null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    const auth = Buffer.from(`${username}:${apiKey}`).toString('base64');
    const res = await fetchImpl(url.toString(), {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${auth}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const message = data?.error?.message || data?.message || `Cartrack request failed (${res.status}).`;
      throw httpError(res.status === 401 || res.status === 403 ? 403 : 502, message);
    }
    return data;
  }

  return {
    configured,
    listVehicles: () => request('GET', '/vehicles'),
    vehiclesStatus: () => request('GET', '/vehicles/status'),
    listDeliveryDrivers: (query) => request('GET', '/delivery/drivers', { query }),
    listJobs: (query) => request('GET', '/delivery/jobs', { query }),
    getJob: (jobId) => request('GET', `/delivery/jobs/${jobId}`),
    createJob: (body) => request('POST', '/delivery/jobs', { body }),
    bulkUploadJobs: (body) => request('POST', '/delivery/jobs/bulk', { body }),
    completeJob: (jobId) => request('PUT', `/delivery/jobs/${jobId}/complete`),
    // Test helper
    _request: request,
  };
}
