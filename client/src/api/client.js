const TOKEN_KEY = 'finops.token';

export function getToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}

export async function api(path, { method = 'GET', json, body, headers } = {}) {
  const finalHeaders = new Headers(headers || {});
  const token = getToken();
  if (token) finalHeaders.set('Authorization', `Bearer ${token}`);
  let payload = body;
  if (json !== undefined) {
    finalHeaders.set('Content-Type', 'application/json');
    payload = JSON.stringify(json);
  }
  const response = await fetch(path, { method, headers: finalHeaders, body: payload });
  const text = await response.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { error: 'The server sent an unexpected response.' }; }
  }
  if (response.status === 401 && !path.startsWith('/auth/login')) setToken('');
  if (!response.ok) {
    const error = new Error(data.error || 'The request failed.');
    error.status = response.status;
    error.issues = data.issues || [];
    throw error;
  }
  return data;
}

export async function apiFile(path) {
  const token = getToken();
  const response = await fetch(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error('The file could not be opened.');
  return { blob: await response.blob(), mimeType: response.headers.get('content-type') || '' };
}
