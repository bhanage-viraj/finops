import assert from 'node:assert/strict';
import test from 'node:test';
import { lastNightlyMark, nextInvoiceJob } from '../src/services/zohoInvoices/syncSchedule.js';

test('the nightly mark is 02:00 Bali time on or before now', () => {
  // 02:00 WITA on 20 Oct 2026 is 18:00 UTC on 19 Oct.
  const atNight = new Date('2026-10-19T18:00:00.000Z');
  assert.equal(lastNightlyMark(atNight).toISOString(), '2026-10-19T18:00:00.000Z');
  const beforeNight = new Date('2026-10-19T17:59:00.000Z');
  assert.equal(lastNightlyMark(beforeNight).toISOString(), '2026-10-18T18:00:00.000Z');
});

test('next job is a full read until the first copy exists, then after 02:00 Bali time', () => {
  const afternoon = new Date('2026-10-19T07:00:00.000Z'); // 15:00 WITA
  assert.equal(nextInvoiceJob({}, afternoon), 'full');
  assert.equal(nextInvoiceJob({ lastFullOkAt: afternoon, lastFullStartedAt: afternoon }, afternoon), 'changes');
  const afterNight = new Date('2026-10-19T18:05:00.000Z');
  assert.equal(nextInvoiceJob({
    lastFullOkAt: afternoon,
    lastFullStartedAt: afternoon,
    lastChangesRunAt: afterNight,
  }, afterNight), 'full');
});

test('changed invoices are due every 10 minutes, and a recent error waits 10 minutes', () => {
  const now = new Date('2026-10-19T07:00:00.000Z');
  const started = new Date('2026-10-19T06:00:00.000Z');
  assert.equal(nextInvoiceJob({
    lastFullOkAt: started,
    lastFullStartedAt: started,
    lastChangesRunAt: new Date(now.getTime() - 10 * 60 * 1000),
  }, now), 'changes');
  assert.equal(nextInvoiceJob({
    lastFullOkAt: started,
    lastFullStartedAt: started,
    lastChangesRunAt: new Date(now.getTime() - 9 * 60 * 1000),
  }, now), null);
  assert.equal(nextInvoiceJob({
    lastFullOkAt: null,
    lastErrorAt: new Date(now.getTime() - 5 * 60 * 1000),
  }, now), null);
  assert.equal(nextInvoiceJob({ needsFull: true, lastFullOkAt: started, lastFullStartedAt: started }, now), 'full');
});
