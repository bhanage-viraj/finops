import assert from 'node:assert/strict';
import test from 'node:test';
import Document from '../src/models/Document.js';
import { deleteDocument, replaceDocumentPhoto } from '../src/services/documents/documentService.js';

function staff() {
  return { id: '507f1f77bcf86cd799439011', role: 'staff' };
}

test('delete refuses a receipt already sent to Zoho', async (t) => {
  const doc = {
    _id: '507f1f77bcf86cd799439012',
    uploadedBy: staff().id,
    status: 'approved',
    originalFileKey: 'a.jpg',
    preprocessedFileKey: '',
    originalName: 'a.jpg',
    zohoExpense: { expenseId: '123' },
  };
  const original = Document.findById;
  Document.findById = async () => doc;
  t.after(() => { Document.findById = original; });

  await assert.rejects(
    () => deleteDocument(doc._id, staff(), { upload: { dir: '/tmp' } }),
    /already sent to Zoho/i,
  );
});

test('replace refuses while processing', async (t) => {
  const doc = {
    _id: '507f1f77bcf86cd799439013',
    uploadedBy: staff().id,
    status: 'processing',
    originalFileKey: 'a.jpg',
    preprocessedFileKey: '',
    zohoExpense: {},
  };
  const original = Document.findById;
  Document.findById = async () => doc;
  t.after(() => { Document.findById = original; });

  await assert.rejects(
    () => replaceDocumentPhoto(doc._id, staff(), { buffer: Buffer.from([0xff, 0xd8, 0xff]), originalname: 'x.jpg' }, {
      upload: { dir: '/tmp', maxBytes: 1_000_000 },
    }),
    /still being read/i,
  );
});
