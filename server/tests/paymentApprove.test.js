import assert from 'node:assert/strict';
import test from 'node:test';
import BankPayment from '../src/models/BankPayment.js';
import { approvePayment } from '../src/services/payments/paymentService.js';

function accountant() {
  return { _id: 'acct1', role: 'accountant' };
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
    () => approvePayment('p1', { _id: 'staff1', role: 'staff' }, {}, { zoho: {} }),
    /accountant/i,
  );
});
