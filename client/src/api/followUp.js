import { api } from './client.js';

export function fetchFollowUpToday() {
  return api('/follow-up/today');
}
