import { Router } from 'express';
import { invoicePdf, today } from '../controllers/followUp.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { killSwitch } from '../middleware/killSwitch.js';
import { requireRole } from '../middleware/requireRole.js';

export function createFollowUpRouter(env) {
  const router = Router();
  router.use(requireAuth(env));
  router.get('/today', requireRole('accountant', 'admin'), killSwitch, today(env));
  router.get('/invoices/:invoiceId/pdf', requireRole('accountant', 'admin'), killSwitch, invoicePdf(env));
  return router;
}
