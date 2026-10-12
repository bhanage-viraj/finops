import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { login, me } from '../controllers/auth.controller.js';
import { zohoCallback, zohoStart } from '../controllers/zoho.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';

export function createAuthRouter(env) {
  const router = Router();
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
  });
  router.post('/login', loginLimiter, login(env));
  router.get('/me', requireAuth(env), me());
  router.get('/zoho/start', requireAuth(env), requireRole('admin'), zohoStart(env));
  router.get('/zoho/callback', zohoCallback(env));
  return router;
}
