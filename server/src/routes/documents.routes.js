import { Router } from 'express';
import {
  approve, chooseZohoAccount, detail, file, list, reject, retry, stats, submit, update, uploadDocuments, zohoExpense, zohoPreview,
} from '../controllers/documents.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { killSwitch } from '../middleware/killSwitch.js';
import { requireRole } from '../middleware/requireRole.js';
import { documentUpload } from '../middleware/upload.js';

export function createDocumentRouter(env) {
  const router = Router();
  router.use(requireAuth(env));
  const upload = documentUpload(env.upload.maxBytes);
  const staff = requireRole('staff', 'accountant', 'admin');
  router.get('/stats', stats());
  router.get('/', list());
  router.post('/', staff, upload, uploadDocuments(env));
  router.get('/:id/file', file(env));
  router.get('/:id', detail());
  router.patch('/:id', update());
  router.post('/:id/submit', submit());
  router.post('/:id/approve', approve());
  router.post('/:id/reject', reject());
  router.post('/:id/retry', retry(env));
  router.post('/:id/zoho-account', requireRole('accountant', 'admin'), chooseZohoAccount());
  router.post('/:id/zoho-preview', requireRole('accountant', 'admin'), zohoPreview(env));
  router.post('/:id/zoho-expense', requireRole('accountant', 'admin'), killSwitch, zohoExpense(env));
  return router;
}
