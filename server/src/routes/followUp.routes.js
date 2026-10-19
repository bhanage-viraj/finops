import { Router } from 'express';
import { invoicePdf, receivableSummary, today } from '../controllers/followUp.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { killSwitch } from '../middleware/killSwitch.js';
import { requireRole } from '../middleware/requireRole.js';

export function createFollowUpRouter(env) {
  const router = Router();
  router.use(requireAuth(env));
  router.get('/today', requireRole('accountant', 'admin'), killSwitch, today(env));
  router.get('/invoices/:invoiceId/pdf', requireRole('accountant', 'admin'), killSwitch, invoicePdf(env));
  router.get('/receivable-summary.pdf', requireRole('accountant', 'admin'), killSwitch, receivableSummary(env));
  return router;
}
