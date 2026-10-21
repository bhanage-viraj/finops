import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmAssistantProposal, handleAssistantMessage } from '../src/services/assistant/assistantService.js';
import { datesFromMessage, normalizeIntent, planInvoiceLink } from '../src/services/assistant/intent.js';
import { MULTI_CUSTOMER_EXCESS } from '../src/services/payments/paymentService.js';

const TODAY = new Date(2026, 9, 21);
const PAYMENT_ID = '64b7f3c2a1b2c3d4e5f60719';
const PROPOSAL_ID = '64b7f3c2a1b2c3d4e5f60718';

test('this month and bulan ini fill the current calendar month', () => {
  assert.deepEqual(datesFromMessage('AN Balinest this month', TODAY), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(datesFromMessage('AN Balinest bulan ini', TODAY), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(datesFromMessage('AN Balinest', TODAY), { from: '', to: '' });
});

test('a guessed payment id is dropped and an unknown intent becomes an answer', () => {
  const intent = normalizeIntent({
    intent: 'delete_everything',
    paymentId: 'not-an-id',
    from: '2026-10-31',
    to: '2026-10-01',
    customerName: 'AN Balinest',
    reply: 'Deleted.',
  }, 'delete everything', TODAY);
  assert.equal(intent.intent, 'answer');
  assert.equal(intent.paymentId, '');
  assert.equal(intent.from, '');
  assert.equal(intent.to, '');
});

test('linking invoices across villas keeps the books total and blocks leftover money', () => {
  const rows = [
    { id: '11', remaining: 100000, customerName: 'Balinest Villa Kristi', erpCustomerId: '1' },
    { id: '22', remaining: 200000, customerName: 'Balinest Villa Ubud', erpCustomerId: '2' },
  ];
  const exact = planInvoiceLink({ invoices: rows, paymentAmount: 300000 });
  assert.equal(exact.ok, true);
  assert.deepEqual(exact.invoiceIds, ['11', '22']);
  assert.equal(exact.customerCount, 2);
  const extra = planInvoiceLink({ invoices: rows, paymentAmount: 900000 });
  assert.equal(extra.ok, false);
  assert.equal(extra.error, MULTI_CUSTOMER_EXCESS);
});

test('a group request prepares a confirm step and does not save yet', async () => {
  const created = [];
  let queried = null;
  const result = await handleAssistantMessage({
    user: { id: 'acct1', role: 'accountant' },
    env: {},
    body: { message: 'link AN Balinest this month', path: `/payments/${PAYMENT_ID}` },
    today: TODAY,
  }, {
    parseIntent: async () => ({
      intent: 'link_invoices',
      customerName: 'AN Balinest',
      from: '',
      to: '',
      paymentId: '',
      reply: '',
    }),
    listPayments: async () => [{
      id: PAYMENT_ID,
      status: 'matched',
      amountReceived: 300000,
      confirmed: { customerName: 'AN Balinest' },
      matchedInvoiceId: null,
    }],
    listOpenInvoices: async (_env, _name, options) => {
      queried = options;
      return {
        truncated: false,
        invoices: [
          { id: '11', invoiceNo: 'INV-1', remaining: 100000, date: '2026-10-02', customerName: 'Balinest Villa Kristi', erpCustomerId: '1' },
          { id: '22', invoiceNo: 'INV-2', remaining: 200000, date: '2026-10-03', customerName: 'Balinest Villa Ubud', erpCustomerId: '2' },
        ],
      };
    },
    Proposal: {
      create: async (doc) => {
        created.push(doc);
        return { ...doc, _id: PROPOSAL_ID };
      },
    },
  });
  assert.equal(queried.fromDate, '2026-10-01');
  assert.equal(queried.toDate, '2026-10-31');
  assert.deepEqual(created[0].args.invoiceIds, ['11', '22']);
  assert.equal(created[0].args.linked, false);
  assert.equal(result.proposal.id, PROPOSAL_ID);
  assert.match(result.reply, /2 invoices/);
  assert.match(result.reply, /bank statement/i);
});

test('staff cannot prepare a payment change from chat', async () => {
  const result = await handleAssistantMessage({
    user: { id: 'staff1', role: 'staff' },
    env: {},
    body: { message: 'link AN Balinest' },
  }, {
    parseIntent: async () => ({
      intent: 'link_invoices', customerName: 'AN Balinest', from: '', to: '', paymentId: '', reply: '',
    }),
  });
  assert.equal(result.proposal, null);
  assert.match(result.reply, /accountant/i);
});

test('confirm uses the stored invoices and ignores ids in the request', async () => {
  const seen = [];
  const proposal = {
    _id: PROPOSAL_ID,
    userId: 'acct1',
    status: 'pending',
    tool: 'link_invoices',
    summary: 'Link them',
    args: {
      paymentId: PAYMENT_ID,
      invoiceIds: ['11', '22'],
      customerName: 'AN Balinest',
      linked: false,
    },
    expiresAt: new Date(Date.now() + 60_000),
    resultMessage: '',
    save: async () => proposal,
    markModified() {},
  };
  const result = await confirmAssistantProposal(PROPOSAL_ID, { id: 'acct1', role: 'accountant' }, {
    statementChecked: false,
    invoiceIds: ['99'],
  }, {}, {
    Proposal: { findById: async () => proposal },
    setPaymentMatch: async (_id, _user, body) => { seen.push(body.invoiceIds); },
    writeAudit: async () => {},
  });
  assert.deepEqual(seen, [['11', '22']]);
  assert.equal(proposal.status, 'confirmed');
  assert.match(result.reply, /linked/i);
});

test('recording without the bank statement tick is refused', async () => {
  const proposal = {
    _id: PROPOSAL_ID,
    userId: 'acct1',
    status: 'pending',
    tool: 'record_payment',
    args: { paymentId: PAYMENT_ID },
    expiresAt: new Date(Date.now() + 60_000),
    resultMessage: '',
    save: async () => proposal,
    markModified() {},
  };
  await assert.rejects(
    () => confirmAssistantProposal(PROPOSAL_ID, { id: 'acct1', role: 'accountant' }, {
      statementChecked: false,
    }, {}, {
      Proposal: { findById: async () => proposal },
      verifyPayment: async () => { throw new Error('should not verify'); },
      writeAudit: async () => {},
    }),
    /bank statement/i,
  );
  assert.equal(proposal.status, 'pending');
});
