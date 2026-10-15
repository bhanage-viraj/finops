import assert from 'node:assert/strict';
import test from 'node:test';
import {
  draftCombinedWhatsAppMessage, draftWhatsAppMessage, groupOverdueByCustomer, groupOverdueByDueDate, rankOverdueInvoices,
} from '../src/services/followUp/rank.js';

test('overdue invoices group per customer with a total, most overdue customer first', () => {
  const groups = groupOverdueByCustomer([
    { invoiceId: '1', invoiceNumber: 'A1', customerId: '10', customerName: 'Toko A', daysOverdue: 3, balance: 480000, dueDate: '2026-10-12' },
    { invoiceId: '2', invoiceNumber: 'B1', customerId: '20', customerName: 'Toko B', daysOverdue: 20, balance: 100000, dueDate: '2026-09-25' },
    { invoiceId: '3', invoiceNumber: 'A2', customerId: '10', customerName: 'Toko A', daysOverdue: 10, balance: 480000, dueDate: '2026-10-05' },
  ]);
  assert.deepEqual(groups.map((g) => g.customerName), ['Toko B', 'Toko A']);
  assert.equal(groups[1].total, 960000);
  assert.deepEqual(groups[1].invoices.map((row) => row.invoiceId), ['3', '1']);
});

test('the combined reminder lists each invoice, the total and the bank details', () => {
  const text = draftCombinedWhatsAppMessage([
    { invoiceId: '1', invoiceNumber: 'INV-2', balance: 480000, dueDate: '2026-10-07' },
    { invoiceId: '2', invoiceNumber: 'INV-1', balance: 1230000, dueDate: '2026-09-22' },
  ]);
  assert.match(text, /these 2 invoices/);
  assert.match(text, /- INV-1 \(due 22\/09\/2026\): Rp 1\.230\.000\n- INV-2 \(due 07\/10\/2026\): Rp 480\.000/);
  assert.match(text, /Total: Rp 1\.710\.000/);
  assert.match(text, /7228-0000-0522/);
  // One invoice falls back to the normal single reminder.
  assert.match(draftCombinedWhatsAppMessage([{ invoiceId: '1', balance: 1, dueDate: '2026-09-15' }]), /due invoice on 15\/09\/2026/);
});

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

test('the WhatsApp draft uses the English reminder with due date and bank details', () => {
  const text = draftWhatsAppMessage({
    customerName: 'Budi',
    invoiceNumber: 'INV-22',
    balance: 250000,
    dueDate: '2026-09-15',
  });
  assert.match(text, /^Hi, Mr\.\/Mrs,/);
  assert.doesNotMatch(text, /Mr\.\/Mrs Budi/);
  assert.match(text, /enjoying your water/);
  assert.match(text, /due invoice on 15\/09\/2026/);
  assert.match(text, /PT Tigris Inovatif Solusi/);
  assert.match(text, /7228-0000-0522/);
  assert.match(text, /OCBC NISP/);
});

test('follow-up pages walk through every overdue invoice without gaps or repeats', async () => {
  const { pageOf } = await import('../src/services/followUp/today.js');
  const rows = Array.from({ length: 4012 }, (_, i) => ({ invoiceId: String(i + 1) }));
  const seen = [];
  let page = 1;
  let info;
  do {
    info = pageOf(rows, page, 100);
    seen.push(...info.rows.map((row) => row.invoiceId));
    page += 1;
  } while (page <= info.pageCount);
  assert.equal(info.pageCount, 41);
  assert.equal(seen.length, 4012);
  assert.equal(new Set(seen).size, 4012);
  const second = pageOf(rows, 2, 100);
  assert.equal(second.from, 101);
  assert.equal(second.to, 200);
  // A page past the end shows the last page instead of nothing.
  assert.equal(pageOf(rows, 99, 100).page, 41);
  assert.equal(pageOf([], 1, 100).from, 0);
});

test('follow-up search and due-date filters cover the whole list', async () => {
  const { filterOverdue } = await import('../src/services/followUp/today.js');
  const rows = [
    { invoiceId: '1', invoiceNumber: 'INV-1', customerName: 'Toko Satu', dueDate: '2026-09-01' },
    { invoiceId: '2', invoiceNumber: 'INV-2', customerName: 'Warung Dua', dueDate: '2026-09-15' },
    { invoiceId: '3', invoiceNumber: 'INV-3', customerName: 'Toko Tiga', dueDate: '2026-10-01' },
  ];
  assert.deepEqual(filterOverdue(rows, { q: 'toko' }).map((r) => r.invoiceId), ['1', '3']);
  assert.deepEqual(filterOverdue(rows, { dueFrom: '2026-09-10', dueTo: '2026-09-30' }).map((r) => r.invoiceId), ['2']);
  assert.equal(filterOverdue(rows, { dueFrom: 'not-a-date' }).length, 3);
});
