import assert from 'node:assert/strict';
import test from 'node:test';
import {
  draftWhatsAppMessage, groupOverdueByDueDate, rankOverdueInvoices,
} from '../src/services/followUp/rank.js';

test('invoices with the same due date stay together, oldest due date first', () => {
  const ranked = rankOverdueInvoices([
    { invoiceId: '1', invoiceNumber: 'B', daysOverdue: 5, balance: 200000, dueDate: '2026-10-01' },
    { invoiceId: '2', invoiceNumber: 'A', daysOverdue: 30, balance: 100000, dueDate: '2026-09-01' },
    { invoiceId: '3', invoiceNumber: 'C', daysOverdue: 5, balance: 900000, dueDate: '2026-10-01' },
    { invoiceId: '4', invoiceNumber: 'D', daysOverdue: 4, balance: 50000, dueDate: '2026-10-02' },
  ]);
  assert.deepEqual(ranked.map((row) => row.invoiceId), ['2', '3', '1', '4']);
});

test('due date groups keep same-day invoices together', () => {
  const groups = groupOverdueByDueDate([
    { invoiceId: '1', invoiceNumber: 'B', daysOverdue: 5, balance: 200000, dueDate: '2026-10-01' },
    { invoiceId: '2', invoiceNumber: 'A', daysOverdue: 30, balance: 100000, dueDate: '2026-09-01' },
    { invoiceId: '3', invoiceNumber: 'C', daysOverdue: 5, balance: 900000, dueDate: '2026-10-01' },
  ]);
  assert.deepEqual(groups.map((group) => group.dueDate), ['2026-09-01', '2026-10-01']);
  assert.deepEqual(groups[1].invoices.map((row) => row.invoiceId), ['3', '1']);
});

test('the WhatsApp draft includes invoice and amount', () => {
  const text = draftWhatsAppMessage({
    customerName: 'Budi',
    invoiceNumber: 'INV-22',
    balance: 250000,
    dueDate: '2026-09-15',
  });
  assert.match(text, /Budi/);
  assert.match(text, /INV-22/);
  assert.match(text, /250\.000/);
  assert.match(text, /15\/09\/2026/);
  assert.match(text, /Invoice PDF terlampir/);
});

test('the WhatsApp draft includes the Zoho invoice link when present', () => {
  const text = draftWhatsAppMessage({
    customerName: 'Budi',
    invoiceNumber: 'INV-22',
    balance: 250000,
    dueDate: '2026-09-15',
    invoiceUrl: 'https://books.zoho.com/portal/x/invoice/abc',
  });
  assert.match(text, /https:\/\/books\.zoho\.com\/portal\/x\/invoice\/abc/);
  assert.doesNotMatch(text, /Invoice PDF terlampir/);
});
