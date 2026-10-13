import { Router } from 'express';
import multer from 'multer';
import { importCustomers, importInvoices } from '../controllers/imports.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { killSwitch } from '../middleware/killSwitch.js';
import { requireRole } from '../middleware/requireRole.js';

export function createImportsRouter(env) {
  const router = Router();
  router.use(requireAuth(env));
  router.use(requireRole('accountant', 'admin'));
  router.use(killSwitch);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: Math.min(env.upload?.maxBytes || 5_000_000, 2_000_000), files: 1 },
  });

  function singleCsv(req, res, next) {
    upload.single('file')(req, res, (error) => {
      if (!error) {
        next();
        return;
      }
      error.status = 400;
      if (error.code === 'LIMIT_FILE_SIZE') error.message = 'That CSV is too large.';
      else error.message = 'The CSV could not be read.';
      next(error);
    });
  }

  router.post('/customers', singleCsv, importCustomers());
  router.post('/invoices', singleCsv, importInvoices());
  return router;
}
