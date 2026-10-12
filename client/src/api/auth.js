import { api } from './client.js';

export function login(email, password) {
  return api('/auth/login', { method: 'POST', json: { email, password } });
}

export function currentUser() {
  return api('/auth/me');
}
