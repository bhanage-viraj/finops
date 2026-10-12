import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectUpload, pdfPageCount } from '../src/services/documents/uploads.js';

test('rejects a file whose bytes are not an allowed type', () => {
  const result = inspectUpload({ filename: 'note.txt', bytes: Buffer.from('hello'), maxBytes: 1000 });
  assert.equal(result.ok, false);
});

test('accepts a pdf header and counts pages', () => {
  const bytes = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n');
  const result = inspectUpload({ filename: 'bill.pdf', bytes, maxBytes: 1000 });
  assert.equal(result.ok, true);
  assert.equal(result.mime, 'application/pdf');
  assert.equal(pdfPageCount(bytes), 1);
});

test('rejects an empty upload', () => {
  const result = inspectUpload({ filename: 'empty.jpg', bytes: Buffer.alloc(0), maxBytes: 1000 });
  assert.equal(result.ok, false);
});
