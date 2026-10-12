import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import mongoose from 'mongoose';
import Document from '../src/models/Document.js';
import User from '../src/models/User.js';
import { approveDocument } from '../src/services/documents/documentService.js';
import { processDocument } from '../src/services/documents/pipeline.js';
import { createFileStorage } from '../src/services/storage/fileStorage.js';
import { hashPassword } from '../src/utils/password.js';

const uri = 'mongodb://127.0.0.1:27017/finops_test';

function fakeAi() {
  return {
    classifyDocument: async () => ({
      classification: {
        documentType: 'fuel_receipt', confidence: 92, evidence: 'Pertalite 10.031 L', needsReview: false,
      },
      model: 'fake', latencyMs: 5, usage: { promptTokens: 10, outputTokens: 20, totalTokens: 30 },
      approxCostUsd: null, promptVersion: 'test',
    }),
    extractDocument: async () => ({
      extraction: {
        fields: {
          date: '09/10/2026', supplier: 'SPBU Maju Lancar', total: 'Rp 100.310',
          quantity: '10.031', quantityUnit: 'L', unitPrice: 'Rp 10.000', fuelType: 'Pertalite',
        },
        lineItems: [],
        fieldConfidence: { total: 90 },
        fieldBoxes: { total: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 } },
      },
      model: 'fake', latencyMs: 5, usage: null, approxCostUsd: null, promptVersion: 'test',
    }),
    preprocessImage: async (bytes) => ({ bytes, mimeType: 'image/png', note: 'test copy' }),
  };
}

test('processing, approval and retry stay on one saved document', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finops-docs-'));
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  await mongoose.connection.dropDatabase();
  t.after(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const staff = await User.create({
    name: 'Test Staff', email: 'staff-test@example.com', role: 'staff',
    passwordHash: await hashPassword('staff-secret'), active: true,
  });
  const accountant = await User.create({
    name: 'Test Accountant', email: 'accountant-test@example.com', role: 'accountant',
    passwordHash: await hashPassword('accountant-secret'), active: true,
  });
  const storage = createFileStorage(dir);
  const key = await storage.save(Buffer.from('original-file'), '.png');
  await fs.rm(path.join(dir, key));
  assert.equal((await storage.read(key)).toString(), 'original-file');
  const created = await Document.create({
    uploadedBy: staff._id,
    originalFileKey: key,
    originalName: 'fuel.png',
    mimeType: 'image/png',
    size: 13,
    sha256: 'abc',
    status: 'uploaded',
    documentType: 'unknown',
  });
  const env = { upload: { dir, maxBytes: 1_000_000 }, ai: { timeoutMs: 1000 } };
  const deps = { ...fakeAi(), storage };

  await processDocument(created._id, env, deps);
  await processDocument(created._id, env, deps);
  assert.equal(await Document.countDocuments(), 1);
  const read = await Document.findById(created._id);
  assert.equal(read.status, 'needs_review');
  assert.equal(read.confirmed.fields.total.normalized, 100310);
  assert.equal(read.confirmed.fields.quantity.normalized, '10.031');
  assert.equal(read.ai.extraction.fields.total, 'Rp 100.310');
  const original = await storage.read(read.originalFileKey);
  assert.equal(original.toString(), 'original-file');

  const staffUser = { id: staff._id, role: 'staff' };
  await assert.rejects(() => approveDocument(created._id, staffUser), /accountant/);

  read.confirmed.fields.supplier = { original: null, normalized: null };
  read.markModified('confirmed');
  await read.save();
  const accountantUser = { id: accountant._id, role: 'accountant' };
  await assert.rejects(() => approveDocument(created._id, accountantUser), /blocked/);

  read.confirmed.fields.supplier = { original: 'SPBU Maju Lancar', normalized: 'SPBU Maju Lancar' };
  read.markModified('confirmed');
  await read.save();
  const approved = await approveDocument(created._id, accountantUser);
  const again = await approveDocument(created._id, accountantUser);
  assert.equal(approved.status, 'approved');
  assert.equal(again.status, 'approved');
  assert.equal(await Document.countDocuments({ status: 'approved' }), 1);

  const failed = await Document.create({
    uploadedBy: staff._id,
    originalFileKey: key,
    originalName: 'broken.pdf',
    mimeType: 'application/pdf',
    size: 13,
    sha256: 'def',
    status: 'uploaded',
    documentType: 'unknown',
  });
  await processDocument(failed._id, env, {
    ...deps,
    classifyDocument: async () => { throw new Error('timeout'); },
  });
  const broken = await Document.findById(failed._id);
  assert.equal(broken.status, 'failed');
  assert.equal((await storage.read(broken.originalFileKey)).toString(), 'original-file');
  assert.equal(await Document.countDocuments(), 2);
});
