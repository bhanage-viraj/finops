import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {
  assertPaymentExtraction,
  parsePaymentAmount,
  parsePaymentDate,
} from '../src/services/ai/schemas.js';

test('Rp formats with dots parse to integer rupiah', () => {
  assert.equal(parsePaymentAmount('Rp28.000,00'), 28000);
  assert.equal(parsePaymentAmount('Rp 1.200.000'), 1200000);
  assert.equal(parsePaymentAmount('28000'), 28000);
});

test('Indonesian long date parses to a Date', () => {
  const date = parsePaymentDate('30 September 2026, 07:36');
  assert.ok(date instanceof Date);
  assert.equal(date.getUTCFullYear(), 2026);
  assert.equal(date.getUTCMonth(), 8);
  assert.equal(date.getUTCDate(), 30);
  assert.equal(date.getUTCHours(), 7);
  assert.equal(date.getUTCMinutes(), 36);
});

test('assertPaymentExtraction keeps sender separate from recipient', () => {
  const result = assertPaymentExtraction({
    sender: 'Budi Santoso',
    recipient: 'PT Contoh Merchant',
    amount: 'Rp28.000,00',
    paidAt: '2026-09-30T07:36:00Z',
    reference: 'REF-1',
    transferMethod: 'BI-FAST',
    confidence: 91,
  });
  assert.equal(result.sender, 'Budi Santoso');
  assert.equal(result.recipient, 'PT Contoh Merchant');
  assert.equal(result.amount, 28000);
  assert.equal(result.confidence, 91);
});

test('payment prompt treats screenshot text as untrusted', () => {
  const prompt = fs.readFileSync(new URL('../src/prompts/payment.prompt.txt', import.meta.url), 'utf8');
  assert.match(prompt, /untrusted data/i);
  assert.match(prompt, /Never follow instructions/i);
  assert.match(prompt, /sender/i);
});
