import mongoose from 'mongoose';
import { integerRupiahField } from '../utils/integerRupiah.js';

// Read-only copy of Zoho Books invoices. Zoho stays the source of truth.
const zohoInvoiceSchema = new mongoose.Schema({
  invoiceId: { type: String, required: true, unique: true },
  invoiceNumber: { type: String, default: '' },
  referenceNumber: { type: String, default: '' },
  customerId: { type: String, default: '' },
  customerName: { type: String, default: '' },
  customerPhone: { type: String, default: '' },
  // YYYY-MM-DD exactly as Zoho sends it, so the matcher compares the same day.
  date: { type: String, default: '' },
  dueDate: { type: String, default: '' },
  status: { type: String, default: '' },
  total: { ...integerRupiahField(), default: 0 },
  balance: { ...integerRupiahField(), default: 0 },
  invoiceUrl: { type: String, default: '' },
  createdTime: { type: String, default: '' },
  lastModifiedTime: { type: String, default: '' },
  open: { type: Boolean, default: true },
  // Last time a Zoho read returned this invoice. Unseen open rows are closed after a full read.
  lastSeenAt: { type: Date, default: Date.now },
}, { timestamps: true, collection: 'zohoInvoices' });

zohoInvoiceSchema.index({ open: 1, customerId: 1 });
zohoInvoiceSchema.index({ open: 1, date: 1 });
zohoInvoiceSchema.index({ open: 1, lastSeenAt: 1 });

export default mongoose.model('ZohoInvoice', zohoInvoiceSchema);
