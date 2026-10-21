import { api } from './client.js';

export function sendAssistantMessage(payload) {
  return api('/assistant/messages', { method: 'POST', json: payload });
}

export function confirmAssistantProposal(id, payload = {}) {
  return api(`/assistant/proposals/${id}/confirm`, { method: 'POST', json: payload });
}

export function cancelAssistantProposal(id) {
  return api(`/assistant/proposals/${id}/cancel`, { method: 'POST', json: {} });
}
