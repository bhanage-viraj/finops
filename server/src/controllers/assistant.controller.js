import { asyncHandler } from '../utils/http.js';
import {
  cancelAssistantProposal, confirmAssistantProposal, handleAssistantMessage,
} from '../services/assistant/assistantService.js';

export function sendMessage(env) {
  return asyncHandler(async (req, res) => {
    res.json(await handleAssistantMessage({ user: req.user, env, body: req.body || {} }));
  });
}

export function confirmProposal(env) {
  return asyncHandler(async (req, res) => {
    res.json(await confirmAssistantProposal(req.params.id, req.user, req.body || {}, env));
  });
}

export function cancelProposal() {
  return asyncHandler(async (req, res) => {
    res.json(await cancelAssistantProposal(req.params.id, req.user));
  });
}
