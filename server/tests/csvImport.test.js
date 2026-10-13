import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCsv } from '../src/services/imports/csvImport.js';

test('parseCsv reads header and rows', () => {
  const rows = parseCsv('name,erpCustomerId\nDepot Tirta,CUST-1\nToko Air,CUST-2\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Depot Tirta');
  assert.equal(rows[0].erpCustomerId, 'CUST-1');
  assert.equal(rows[1].__line, 3);
});

test('parseCsv rejects empty sheets', () => {
  assert.throws(() => parseCsv('name,erpCustomerId\n'), /header row/i);
});
