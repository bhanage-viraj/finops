import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeExtraction } from '../src/services/documents/normalize.js';
import { duplicateWarning, validateDocument } from '../src/services/documents/validateDocument.js';

test('fuel arithmetic that matches does not invent a new total', () => {
  const confirmed = normalizeExtraction('fuel_receipt', {
    fields: {
      date: '09/10/2026',
      supplier: 'SPBU Maju Lancar',
      quantity: '10.031',
      quantityUnit: 'L',
      unitPrice: 'Rp 10.000',
      total: 'Rp 100.310',
    },
    lineItems: [],
  });
  const result = validateDocument(confirmed);
  assert.equal(result.canApprove, true);
  assert.equal(confirmed.fields.total.normalized, 100310);
});

test('a large line mismatch is critical and leaves the total untouched', () => {
  const confirmed = normalizeExtraction('supplier_receipt', {
    fields: { date: '02/10/2026', supplier: 'Toko Surya', total: 'Rp 50.000' },
    lineItems: [{ description: 'Galon', quantity: '2', unit: 'pcs', unitPrice: 'Rp 20.000', lineTotal: 'Rp 50.000' }],
  });
  const result = validateDocument(confirmed);
  assert.equal(result.canApprove, false);
  assert.equal(result.critical.some((item) => item.code === 'arithmetic'), true);
  assert.equal(confirmed.fields.total.normalized, 50000);
});

test('unknown type blocks approval', () => {
  const result = validateDocument({ documentType: 'unknown', fields: {}, lineItems: [] });
  assert.equal(result.canApprove, false);
});

test('a similar document is a warning, not a rejection', () => {
  const warning = duplicateWarning({ fieldMatches: ['abc'] });
  const result = validateDocument({
    documentType: 'expense_receipt',
    fields: {
      date: { normalized: '2026-10-09' },
      supplier: { normalized: 'Toko Surya' },
      total: { normalized: 50000 },
    },
    lineItems: [],
  }, { duplicate: warning });
  assert.equal(result.canApprove, true);
  assert.equal(result.warnings.some((item) => item.code === 'possible_duplicate'), true);
});

test('a work-order phone number is not accepted as the agreed amount', () => {
  const confirmed = normalizeExtraction('work_order', {
    fields: {
      workDate: '09/10/2026',
      workerName: 'Sari Staff',
      phone: '081234567890',
      agreedAmount: '081234567890',
    },
    lineItems: [],
  });
  const result = validateDocument(confirmed);
  assert.equal(confirmed.fields.agreedAmount.normalized, null);
  assert.equal(result.canApprove, false);
});
