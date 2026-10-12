import { Router } from 'express';
import { getSettings, updateAccounts, updateSettings } from '../controllers/admin.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';

export function createAdminRouter(env) {
  const router = Router();
  router.use(requireAuth(env));
  router.use(requireRole('admin'));
  router.get('/settings', getSettings(env));
  router.patch('/settings', updateSettings(env));
  router.put('/settings/accounts', updateAccounts(env));
  return router;
}
