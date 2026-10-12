import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import mongoose from 'mongoose';
import AuditLog from '../src/models/AuditLog.js';
import Document from '../src/models/Document.js';
import Setting from '../src/models/Setting.js';
import User from '../src/models/User.js';
import { readErpSettings } from '../src/services/admin/erpSettings.js';
import { sendZohoExpense } from '../src/services/documents/zohoExpense.js';
import { createFileStorage } from '../src/services/storage/fileStorage.js';
import { hashPassword } from '../src/utils/password.js';

const uri = 'mongodb://127.0.0.1:27017/finops_zoho_test';
const zoho = {
  clientId: 'client-id',
  clientSecret: 'client-secret-value',
  dc: 'in',
  organizationId: '10234695',
  expenseAccountId: '999',
  paidThroughAccountId: '888',
  redirectUri: 'http://localhost:4000/auth/zoho/callback',
  refreshToken: 'refresh-token-value',
};

let dir;
let storage;
let staff;
let accountant;
let env;

function confirmed(total = 100310, payment = '') {
  const fields = {
    date: { original: '09/10/2026', normalized: '2026-10-09' },
    supplier: { original: 'SPBU Maju', normalized: 'SPBU Maju' },
    total: { original: 'Rp 100.310', normalized: total },
    documentNumber: { original: 'SLIP-1', normalized: 'SLIP-1' },
    vehicle: { original: 'B 1001 K', normalized: 'B 1001 K' },
  };
  if (payment) fields.paymentMethod = { original: payment, normalized: payment };
  return { documentType: 'fuel_receipt', fields, lineItems: [] };
}

async function makeDoc(overrides = {}) {
  const key = await storage.save(Buffer.from([0x89, 0x50, 0x4e, 0x47]), '.png');
  return Document.create({
    uploadedBy: staff._id,
    originalFileKey: key,
    originalName: 'fuel.png',
    mimeType: 'image/png',
    size: 4,
    sha256: `${Date.now()}-${Math.random()}`,
    status: 'approved',
    documentType: 'fuel_receipt',
    confirmed: confirmed(),
    ai: { extraction: { fields: { total: 'Rp 100.310' } } },
    ...overrides,
  });
}

test.before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finops-zoho-'));
  storage = createFileStorage(dir);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  await mongoose.connection.dropDatabase();
  staff = await User.create({
    name: 'Test Staff', email: 'zoho-staff@example.com', role: 'staff',
    passwordHash: await hashPassword('staff-secret'), active: true,
  });
  accountant = await User.create({
    name: 'Test Accountant', email: 'zoho-accountant@example.com', role: 'accountant',
    passwordHash: await hashPassword('accountant-secret'), active: true,
  });
  await Setting.create({
    erpFeaturesEnabled: false,
    zohoRefreshToken: 'stored-refresh-token',
    zohoAccountRules: [
      { kind: 'expense', documentType: 'fuel_receipt', key: 'B 1001 K', accountId: '982000000561057', label: 'Fuel' },
      { kind: 'expense', documentType: 'supplier_receipt', key: 'SPBU Maju', accountId: '982000000561058', label: 'Supplies' },
      { kind: 'paid_through', key: 'tunai', accountId: '982000000567251', label: 'Cash' },
      { kind: 'paid_through', key: 'default', accountId: '982000000567250', label: 'Bank' },
      { kind: 'paid_through', key: 'petty cash 2', accountId: '982000000567252', label: 'Petty Cash 2' },
      { kind: 'paid_through', key: 'petty cash ice', accountId: '982000000567253', label: 'Petty Cash Ice' },
    ],
  });
  env = { upload: { dir }, zoho, jwtSecret: 'test-secret' };
});

test.after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await fs.rm(dir, { recursive: true, force: true });
});

test('export stays off until the switch is enabled', async () => {
  await Setting.updateOne({}, { erpFeaturesEnabled: false });
  const doc = await makeDoc();
  let calls = 0;
  await assert.rejects(
    () => sendZohoExpense(doc._id, { id: accountant._id, role: 'accountant' }, env, {
      createExpense: async () => { calls += 1; },
    }),
    /turned off/,
  );
  assert.equal(calls, 0);
});

test('only an approved expense document is sent, and a second click does not post', async () => {
  await Setting.updateOne({}, { erpFeaturesEnabled: true });
  const reviewer = { id: accountant._id, role: 'accountant' };
  let calls = 0;
  let seen;
  const createExpense = async (input) => {
    calls += 1;
    seen = input;
    return { expenseId: '9820000000000000001', receiptAttached: true };
  };

  const purchase = await makeDoc({ documentType: 'purchase_order' });
  await assert.rejects(() => sendZohoExpense(purchase._id, reviewer, env, { createExpense }), /approved receipt/);

  const draft = await makeDoc({ status: 'needs_review' });
  await assert.rejects(() => sendZohoExpense(draft._id, reviewer, env, { createExpense }), /approved receipt/);

  const fractional = await makeDoc({ confirmed: confirmed(100310.5) });
  await assert.rejects(() => sendZohoExpense(fractional._id, reviewer, env, { createExpense }), /whole number/);

  const staffDoc = await makeDoc();
  await assert.rejects(
    () => sendZohoExpense(staffDoc._id, { id: staff._id, role: 'staff' }, env, { createExpense }),
    /do not have access/,
  );
  assert.equal(calls, 0);

  const doc = await makeDoc();
  const first = await sendZohoExpense(doc._id, reviewer, env, { createExpense });
  const second = await sendZohoExpense(doc._id, reviewer, env, { createExpense });
  assert.equal(calls, 1);
  assert.equal(first.zohoExpense.expenseId, '9820000000000000001');
  assert.equal(second.zohoExpense.expenseId, '9820000000000000001');
  assert.equal(seen.expense.amount, 100310);
  assert.equal(seen.expense.accountId, '982000000561057');
  assert.equal(seen.expense.paidThroughAccountId, '982000000567252');
  assert.equal(seen.expense.date, '2026-10-09');
  assert.equal(seen.file.bytes.length, 4);
  const saved = await Document.findById(doc._id);
  assert.equal(saved.ai.extraction.fields.total, 'Rp 100.310');
  assert.equal(saved.zohoExpense.expenseId, '9820000000000000001');
  const audit = await AuditLog.findOne({ action: 'zoho.expense.create', entityId: doc._id }).lean();
  assert.equal(audit.after.expenseId, '9820000000000000001');
  assert.equal(JSON.stringify(audit).includes('refresh-token-value'), false);
});

test('a refused expense can be sent again, and two clicks share one post', async () => {
  await Setting.updateOne({}, { erpFeaturesEnabled: true });
  const reviewer = { id: accountant._id, role: 'accountant' };
  const doc = await makeDoc();
  let calls = 0;
  const createExpense = async () => {
    calls += 1;
    if (calls === 1) {
      const error = new Error('The expense account does not exist.');
      error.status = 422;
      throw error;
    }
    return { expenseId: '982000000561099', receiptAttached: true };
  };
  await assert.rejects(() => sendZohoExpense(doc._id, reviewer, env, { createExpense }), /does not exist/);
  const released = await Document.findById(doc._id);
  assert.equal(released.zohoExpense.sending, false);
  assert.equal(released.zohoExpense.expenseId, '');
  const sent = await sendZohoExpense(doc._id, reviewer, env, { createExpense });
  assert.equal(calls, 2);
  assert.equal(sent.zohoExpense.expenseId, '982000000561099');

  const parallel = await makeDoc();
  let started = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let parallelCalls = 0;
  const slowCreate = async () => {
    parallelCalls += 1;
    started += 1;
    await gate;
    return { expenseId: '982000000561100', receiptAttached: false };
  };
  const first = sendZohoExpense(parallel._id, reviewer, env, { createExpense: slowCreate });
  for (let i = 0; i < 50 && started === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(started, 1);
  const second = await sendZohoExpense(parallel._id, reviewer, env, { createExpense: slowCreate }).then(
    () => null,
    (err) => err,
  );
  release();
  const saved = await first;
  assert.equal(second.status, 409);
  assert.equal(parallelCalls, 1);
  assert.equal(saved.zohoExpense.expenseId, '982000000561100');
});

test('each receipt type and payment method picks its own Zoho account', async () => {
  await Setting.updateOne({}, { erpFeaturesEnabled: true });
  const reviewer = { id: accountant._id, role: 'accountant' };
  const seen = [];
  const createExpense = async (input) => {
    seen.push(input.expense);
    return { expenseId: `98200000056110${seen.length}`, receiptAttached: false };
  };
  const cash = await makeDoc({ confirmed: confirmed(100310, 'Tunai') });
  await sendZohoExpense(cash._id, reviewer, env, { createExpense });
  const supplies = await makeDoc({
    documentType: 'supplier_receipt',
    confirmed: { ...confirmed(50000, 'Transfer'), documentType: 'supplier_receipt' },
  });
  await sendZohoExpense(supplies._id, reviewer, env, { createExpense });
  assert.equal(seen[0].accountId, '982000000561057');
  assert.equal(seen[0].paidThroughAccountId, '982000000567252');
  assert.equal(seen[1].accountId, '982000000561058');
  assert.equal(seen[1].paidThroughAccountId, '982000000567252');
});

test('a receipt with no saved account is not sent to the env account', async () => {
  await Setting.updateOne({}, { erpFeaturesEnabled: true, zohoAccountRules: [] });
  const doc = await makeDoc();
  let calls = 0;
  await assert.rejects(
    () => sendZohoExpense(doc._id, { id: accountant._id, role: 'accountant' }, env, {
      createExpense: async () => { calls += 1; },
    }),
    /No petrol account is saved for B 1001 K/,
  );
  assert.equal(calls, 0);
});

test('settings returned to the admin do not include the refresh token', async () => {
  const body = await readErpSettings(env);
  const text = JSON.stringify(body);
  assert.equal(text.includes('stored-refresh-token'), false);
  assert.equal(text.includes('refresh-token-value'), false);
  assert.equal(text.includes('client-secret-value'), false);
  assert.equal(body.zohoConnected, true);
  await Setting.updateOne({}, { zohoRefreshToken: '' });
  const disconnected = await readErpSettings({ ...env, zoho: { ...zoho, refreshToken: '' } });
  assert.equal(disconnected.zohoConnected, false);
  assert.equal(disconnected.zohoMissing.includes('ZOHO_REFRESH_TOKEN'), false);
  assert.equal(disconnected.zohoMissing.includes('ZOHO_ORGANIZATION_ID'), false);
});
