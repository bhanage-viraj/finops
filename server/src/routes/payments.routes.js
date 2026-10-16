import { Router } from 'express';
import {
  approve, detail, file, hints, list, match, openInvoices, reject, remove, uploadPayments, verify,
} from '../controllers/payments.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { killSwitch } from '../middleware/killSwitch.js';
import { requireRole } from '../middleware/requireRole.js';
import { documentUpload } from '../middleware/upload.js';

export function createPaymentsRouter(env) {
  const router = Router();
  router.use(requireAuth(env));
  const upload = documentUpload(env.upload.maxBytes);
  const staff = requireRole('staff', 'accountant', 'admin');
  const accountant = requireRole('accountant', 'admin');

  // Zoho invoice list and Payments Received create require the kill switch.
  // Documents (expenses) and Follow-up are separate routers — untouched here.
  router.get('/invoices/open', accountant, killSwitch, openInvoices(env));
  router.get('/', list());
  router.post('/', staff, upload, uploadPayments(env));
  router.get('/:id/file', file(env));
  router.get('/:id', detail(env));
  router.delete('/:id', staff, remove(env));
  router.patch('/:id/hints', accountant, killSwitch, hints(env));
  router.patch('/:id/match', accountant, killSwitch, match(env));
  router.post('/:id/verify', accountant, verify());
  router.post('/:id/approve', accountant, killSwitch, approve(env));
  router.post('/:id/reject', accountant, reject());
  return router;
}
