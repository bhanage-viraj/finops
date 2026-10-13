import mongoose from 'mongoose';
import { integerRupiahField } from '../utils/integerRupiah.js';

const { Schema } = mongoose;

const invoiceSchema = new Schema({
  invoiceNo: { type: String, required: true, unique: true, trim: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  erpCustomerId: { type: String, default: '', trim: true },
  amount: { ...integerRupiahField(), required: true },
  paidAmount: { ...integerRupiahField(), default: 0 },
  issueDate: { type: Date, required: true },
  dueDate: { type: Date, required: true },
  status: {
    type: String,
    required: true,
    enum: ['open', 'partial', 'paid'],
    default: 'open',
  },
  importedAt: { type: Date, default: Date.now },
}, { timestamps: true, collection: 'invoices' });

invoiceSchema.index({ status: 1 });
invoiceSchema.index({ customerId: 1, status: 1 });
invoiceSchema.index({ erpCustomerId: 1 });

export function remainingBalance(invoice) {
  const amount = Number(invoice.amount) || 0;
  const paid = Number(invoice.paidAmount) || 0;
  return Math.max(0, amount - paid);
}

export default mongoose.model('Invoice', invoiceSchema);
