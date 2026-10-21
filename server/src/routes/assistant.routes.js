import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { cancelProposal, confirmProposal, sendMessage } from '../controllers/assistant.controller.js';
import { requireAuth } from '../middleware/auth.js';

export function createAssistantRouter(env) {
  const router = Router();
  router.use(requireAuth(env));
  // Each turn can call the model. Cap it so a busy day cannot run the key without limit.
  router.use(rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many chat messages. Wait a minute and try again.' },
  }));
  router.post('/messages', sendMessage(env));
  router.post('/proposals/:id/confirm', confirmProposal(env));
  router.post('/proposals/:id/cancel', cancelProposal());
  return router;
}
