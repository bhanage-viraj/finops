import { createFileStorage } from '../services/storage/fileStorage.js';
import {
  approveDocument, createDocuments, documentStats, fileKeyFor, getDocument, listDocuments,
  loadDocument, rejectDocument, retryDocument, submitDocument, updateDocument,
} from '../services/documents/documentService.js';
import { previewZohoExpense, selectZohoAccount, sendZohoExpense } from '../services/documents/zohoExpense.js';
import { asyncHandler, httpError } from '../utils/http.js';

export function uploadDocuments(env) {
  return asyncHandler(async (req, res) => {
    const { created, rejected } = await createDocuments({
      user: req.user,
      files: req.files,
      idempotencyKey: req.get('idempotency-key') || '',
      env,
    });
    if (created.length === 0) {
      res.status(400).json({ error: 'No documents were saved.', rejected });
      return;
    }
    res.status(201).json({
      documents: created.map((doc) => ({ id: doc._id, status: doc.status, name: doc.originalName })),
      rejected,
    });
  });
}

export function list() {
  return asyncHandler(async (req, res) => {
    res.json({ documents: await listDocuments(req.user, req.query) });
  });
}

export function stats() {
  return asyncHandler(async (req, res) => {
    res.json(await documentStats(req.user));
  });
}

export function detail() {
  return asyncHandler(async (req, res) => {
    res.json({ document: await getDocument(req.params.id, req.user) });
  });
}

export function file(env) {
  return asyncHandler(async (req, res) => {
    const doc = await loadDocument(req.params.id, req.user);
    const { key, mimeType } = fileKeyFor(doc, req.query.which);
    let bytes;
    try {
      bytes = await createFileStorage(env.upload.dir).read(key);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw httpError(404, 'This photo is no longer stored. Upload the receipt again.');
      }
      throw error;
    }
    res.set('Content-Type', mimeType);
    res.set('Content-Disposition', 'inline');
    res.set('Cache-Control', 'private, max-age=60');
    res.send(bytes);
  });
}

export function update() {
  return asyncHandler(async (req, res) => {
    res.json({ document: await updateDocument(req.params.id, req.user, req.body || {}) });
  });
}

export function submit() {
  return asyncHandler(async (req, res) => {
    res.json({ document: await submitDocument(req.params.id, req.user) });
  });
}

export function approve() {
  return asyncHandler(async (req, res) => {
    res.json({ document: await approveDocument(req.params.id, req.user) });
  });
}

export function reject() {
  return asyncHandler(async (req, res) => {
    res.json({ document: await rejectDocument(req.params.id, req.user, req.body?.reason) });
  });
}

export function retry(env) {
  return asyncHandler(async (req, res) => {
    res.json({ document: await retryDocument(req.params.id, req.user, env) });
  });
}

export function chooseZohoAccount() {
  return asyncHandler(async (req, res) => {
    res.json({ document: await selectZohoAccount(req.params.id, req.user, req.body || {}) });
  });
}

export function zohoPreview(env) {
  return asyncHandler(async (req, res) => {
    res.json({ draft: await previewZohoExpense(req.params.id, req.user, env) });
  });
}

export function zohoExpense(env) {
  return asyncHandler(async (req, res) => {
    res.json({ document: await sendZohoExpense(req.params.id, req.user, env) });
  });
}
