import { Router } from 'express';
import {
  approve, detail, file, list, match, openInvoices, reject, uploadPayments, verify,
} from '../controllers/payments.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { documentUpload } from '../middleware/upload.js';

export function createPaymentsRouter(env) {
  const router = Router();
  router.use(requireAuth(env));
  const upload = documentUpload(env.upload.maxBytes);
  const staff = requireRole('staff', 'accountant', 'admin');
  const accountant = requireRole('accountant', 'admin');

  router.get('/invoices/open', accountant, openInvoices());
  router.get('/', list());
  router.post('/', staff, upload, uploadPayments(env));
  router.get('/:id/file', file(env));
  router.get('/:id', detail());
  router.patch('/:id/match', accountant, match());
  router.post('/:id/verify', accountant, verify());
  router.post('/:id/approve', accountant, approve());
  router.post('/:id/reject', accountant, reject());
  return router;
}
