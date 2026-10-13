import { importCustomersCsv, importInvoicesCsv } from '../services/imports/csvImport.js';
import { asyncHandler, httpError } from '../utils/http.js';

function csvTextFromRequest(req) {
  const file = req.file;
  if (!file?.buffer?.length) {
    throw httpError(400, 'Upload one CSV file in the "file" field.');
  }
  return file.buffer.toString('utf8');
}

export function importCustomers() {
  return asyncHandler(async (req, res) => {
    const result = await importCustomersCsv(csvTextFromRequest(req), req.user._id);
    res.json({ ok: true, ...result });
  });
}

export function importInvoices() {
  return asyncHandler(async (req, res) => {
    const result = await importInvoicesCsv(csvTextFromRequest(req), req.user._id);
    res.json({ ok: true, ...result });
  });
}
