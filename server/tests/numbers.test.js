import assert from 'node:assert/strict';
import test from 'node:test';
import { expectedLineTotal, parseDate, parseMoney, parseQuantity } from '../src/services/documents/numbers.js';

test('rupiah with dot thousands becomes an integer', () => {
  assert.equal(parseMoney('Rp 160.000').normalized, 160000);
  assert.equal(parseMoney('Rp 1.200.000').normalized, 1200000);
  assert.equal(parseMoney('Rp 100.310').normalized, 100310);
});

test('a comma thousands amount on a fuel slip stays whole rupiah', () => {
  assert.equal(parseMoney('Rp. 150,000').normalized, 150000);
  assert.equal(parseMoney('Rp. 150,000').fractional, false);
  assert.equal(parseMoney('Rp. 6,800').normalized, 6800);
});

test('a fractional rupiah amount is flagged and not stored as a float', () => {
  const money = parseMoney('Rp 10.500,50');
  assert.equal(money.normalized, 10500);
  assert.equal(money.fractional, true);
  assert.equal(Number.isInteger(money.normalized), true);
});

test('10.031 litres stays 10.031 litres', () => {
  const quantity = parseQuantity('10.031 L', 'L');
  assert.equal(quantity.normalized, '10.031');
  assert.equal(quantity.milli, 10031);
  assert.equal(expectedLineTotal(quantity, parseMoney('Rp 10.000')), 100310);
  assert.equal(parseMoney('Rp 10.000 / L').normalized, 10000);
  assert.equal(expectedLineTotal(quantity, parseMoney('Rp 10.000 / L')), 100310);
});

test('a phone number is not parsed as money', () => {
  const money = parseMoney('081234567890');
  assert.equal(money.normalized, null);
  assert.equal(money.rejectedAsPhone, true);
});

test('09/10/2026 is day month year', () => {
  assert.equal(parseDate('09/10/2026').normalized, '2026-10-09');
  assert.equal(parseDate('17-9-26').normalized, '2026-09-17');
});
