import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectUpload } from '../src/services/documents/uploads.js';
import { paymentUploadBlock } from '../src/services/payments/paymentService.js';

function check(filename, bytes) {
  const inspected = inspectUpload({ filename, bytes, maxBytes: 1_000_000 });
  return paymentUploadBlock(inspected, bytes);
}

test('a one-page PDF payment proof is accepted', () => {
  const bytes = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n');
  assert.equal(check('transfer.pdf', bytes), '');
});

test('a long PDF is not stored as one payment proof', () => {
  const pages = Array.from({ length: 11 }, () => '<< /Type /Page >>').join('\n');
  const bytes = Buffer.from(`%PDF-1.4\n${pages}\n`);
  const error = check('statement.pdf', bytes);
  assert.match(error, /11 pages/);
  assert.match(error, /10 pages or fewer/);
});

test('a file that is not an image or PDF is still rejected', () => {
  const error = check('note.txt', Buffer.from('hello'));
  assert.match(error, /JPEG, PNG, WebP or PDF/);
});

test('a JPEG screenshot is still accepted', () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  assert.equal(check('shot.jpg', bytes), '');
});
