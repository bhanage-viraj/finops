import assert from 'node:assert/strict';
import test from 'node:test';
import BankPayment from '../src/models/BankPayment.js';
import { remainingBalance } from '../src/models/Invoice.js';
import { approvePayment } from '../src/services/payments/paymentService.js';

function accountant() {
  return { _id: 'acct1', role: 'accountant' };
}

test('approve refuses when statement is not verified', async (t) => {
  const payment = {
    _id: 'p1',
    status: 'matched',
    statementVerified: false,
    matchedInvoiceId: 'inv1',
    ai: { amount: 28000 },
    confirmed: {},
    uploadedBy: 'staff1',
    save: async () => payment,
  };
  const original = BankPayment.findById;
  BankPayment.findById = async () => payment;
  t.after(() => { BankPayment.findById = original; });

  await assert.rejects(
    () => approvePayment('p1', accountant()),
    /statement check|screenshot alone/i,
  );
});

test('remaining balance drives exact vs partial vs over', () => {
  assert.equal(remainingBalance({ amount: 28000, paidAmount: 0 }), 28000);
  assert.equal(remainingBalance({ amount: 150000, paidAmount: 50000 }), 100000);
  assert.equal(remainingBalance({ amount: 100, paidAmount: 100 }), 0);
});

test('staff cannot approve', async (t) => {
  const payment = {
    _id: 'p1',
    status: 'verified',
    statementVerified: true,
    matchedInvoiceId: 'inv1',
    ai: { amount: 28000 },
    confirmed: {},
    uploadedBy: 'staff1',
    save: async () => payment,
  };
  const original = BankPayment.findById;
  BankPayment.findById = async () => payment;
  t.after(() => { BankPayment.findById = original; });

  await assert.rejects(
    () => approvePayment('p1', { _id: 'staff1', role: 'staff' }),
    /accountant/i,
  );
});
