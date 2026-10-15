import assert from 'node:assert/strict';
import test from 'node:test';
import BankPayment from '../src/models/BankPayment.js';
import { approvePayment, deletePayment } from '../src/services/payments/paymentService.js';

function accountant() {
  return { id: 'acct1', role: 'accountant' };
}

test('approve refuses when statement is not verified', async (t) => {
  const payment = {
    _id: 'p1',
    status: 'matched',
    statementVerified: false,
    zohoInvoiceId: '982000000002',
    zohoCustomerId: '982000000001',
    ai: { amount: 28000 },
    confirmed: {},
    uploadedBy: 'staff1',
    save: async () => payment,
  };
  const original = BankPayment.findById;
  BankPayment.findById = async () => payment;
  t.after(() => { BankPayment.findById = original; });

  await assert.rejects(
    () => approvePayment('p1', accountant(), {}, { zoho: {} }),
    /statement check|screenshot alone/i,
  );
});

test('staff cannot approve', async (t) => {
  const payment = {
    _id: 'p1',
    status: 'verified',
    statementVerified: true,
    zohoInvoiceId: '982000000002',
    zohoCustomerId: '982000000001',
    ai: { amount: 28000 },
    confirmed: {},
    uploadedBy: 'staff1',
    save: async () => payment,
  };
  const original = BankPayment.findById;
  BankPayment.findById = async () => payment;
  t.after(() => { BankPayment.findById = original; });

  await assert.rejects(
    () => approvePayment('p1', { id: 'staff1', role: 'staff' }, {}, { zoho: {} }),
    /accountant/i,
  );
});

test('delete refuses a payment already recorded in Zoho', async (t) => {
  const payment = {
    _id: 'p2',
    status: 'approved',
    zohoPaymentId: '999',
    imageKey: 'shot.jpg',
    originalName: 'shot.jpg',
    uploadedBy: 'acct1',
  };
  const original = BankPayment.findById;
  BankPayment.findById = async () => payment;
  t.after(() => { BankPayment.findById = original; });

  await assert.rejects(
    () => deletePayment('p2', accountant(), { upload: { dir: '/tmp' } }),
    /already recorded in Zoho/i,
  );
});

test('delete refuses while AI is still reading', async (t) => {
  const payment = {
    _id: 'p3',
    status: 'processing',
    zohoPaymentId: '',
    imageKey: 'shot.jpg',
    originalName: 'shot.jpg',
    uploadedBy: 'acct1',
  };
  const original = BankPayment.findById;
  BankPayment.findById = async () => payment;
  t.after(() => { BankPayment.findById = original; });

  await assert.rejects(
    () => deletePayment('p3', accountant(), { upload: { dir: '/tmp' } }),
    /still being read/i,
  );
});
