import { createFileStorage } from '../services/storage/fileStorage.js';
import {
  approvePayment,
  createPayments,
  deletePayment,
  fileKeyFor,
  getPayment,
  listOpenInvoices,
  listPayments,
  loadPayment,
  rejectPayment,
  setPaymentMatch,
  updatePaymentHints,
  verifyPayment,
} from '../services/payments/paymentService.js';
import { asyncHandler, httpError } from '../utils/http.js';

export function uploadPayments(env) {
  return asyncHandler(async (req, res) => {
    const { created, rejected } = await createPayments({
      user: req.user,
      files: req.files,
      env,
      hints: req.body || {},
    });
    if (created.length === 0) {
      res.status(400).json({ error: 'No screenshots were saved.', rejected });
      return;
    }
    res.status(201).json({ payments: created, rejected });
  });
}

export function list() {
  return asyncHandler(async (req, res) => {
    res.json({ payments: await listPayments(req.user, req.query) });
  });
}

export function detail() {
  return asyncHandler(async (req, res) => {
    res.json({ payment: await getPayment(req.params.id, req.user) });
  });
}

export function file(env) {
  return asyncHandler(async (req, res) => {
    const payment = await loadPayment(req.params.id, req.user);
    const { key, mimeType } = fileKeyFor(payment);
    let bytes;
    try {
      bytes = await createFileStorage(env.upload.dir).read(key);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw httpError(404, 'This screenshot is no longer stored. Upload it again.');
      }
      throw error;
    }
    res.set('Content-Type', mimeType);
    res.set('Content-Disposition', 'inline');
    res.set('Cache-Control', 'private, max-age=60');
    res.send(bytes);
  });
}

export function match(env) {
  return asyncHandler(async (req, res) => {
    res.json({ payment: await setPaymentMatch(req.params.id, req.user, req.body || {}, env) });
  });
}

export function hints(env) {
  return asyncHandler(async (req, res) => {
    res.json({ payment: await updatePaymentHints(req.params.id, req.user, req.body || {}, env) });
  });
}

export function verify() {
  return asyncHandler(async (req, res) => {
    res.json({ payment: await verifyPayment(req.params.id, req.user) });
  });
}

export function approve(env) {
  return asyncHandler(async (req, res) => {
    res.json({ payment: await approvePayment(req.params.id, req.user, req.body || {}, env) });
  });
}

export function reject() {
  return asyncHandler(async (req, res) => {
    res.json({ payment: await rejectPayment(req.params.id, req.user, req.body?.reason) });
  });
}

export function remove(env) {
  return asyncHandler(async (req, res) => {
    res.json(await deletePayment(req.params.id, req.user, env));
  });
}

export function openInvoices(env) {
  return asyncHandler(async (req, res) => {
    res.json({
      invoices: await listOpenInvoices(env, req.query.q || '', {
        customerId: req.query.customerId || '',
      }),
    });
  });
}
