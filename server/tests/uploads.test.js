import assert from 'node:assert/strict';
import test from 'node:test';
import { displayFileName, inspectUpload, isHeic, pdfPageCount, prepareStoredBytes } from '../src/services/documents/uploads.js';

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

test('a WhatsApp file name with encoded spaces is shown with spaces', () => {
  assert.equal(
    displayFileName('WhatsApp%20Image%202026-10-10%20at%2019.29.23.jpeg'),
    'WhatsApp Image 2026-10-10 at 19.29.23.jpeg',
  );
});

test('an iPhone HEIC photo is stored as a JPEG', async () => {
  const sharp = (await import('sharp')).default;
  const heic = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 20, g: 40, b: 200 } },
  }).heif({ compression: 'av1' }).toBuffer();
  assert.equal(isHeic(heic), true);
  const jpeg = await prepareStoredBytes(heic);
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
  assert.equal(isHeic(jpeg), false);
});

test('a JPEG is not rewritten before it is checked', async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const stored = await prepareStoredBytes(bytes);
  assert.equal(stored, bytes);
});

test('rejects an empty upload', () => {
  const result = inspectUpload({ filename: 'empty.jpg', bytes: Buffer.alloc(0), maxBytes: 1000 });
  assert.equal(result.ok, false);
});
