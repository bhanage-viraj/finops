import mongoose from 'mongoose';
import { integerRupiahField } from '../utils/integerRupiah.js';

const { Schema } = mongoose;

const bankPaymentSchema = new Schema({
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  originalName: { type: String, default: '' },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true },
  imageKey: { type: String, required: true },
  status: {
    type: String,
    required: true,
    enum: ['read', 'matched', 'verified', 'approved', 'rejected', 'failed'],
    default: 'read',
  },
  // AI output is never overwritten after the first successful read.
  ai: {
    sender: { type: String, default: null },
    amount: integerRupiahField(),
    paidAt: { type: Date, default: null },
    reference: { type: String, default: null },
    recipient: { type: String, default: null },
    transferMethod: { type: String, default: null },
    confidence: { type: Number, default: null },
    model: { type: String, default: '' },
    readAt: { type: Date, default: null },
    raw: { type: Schema.Types.Mixed, default: null },
  },
  confirmed: {
    sender: { type: String, default: null },
    amount: integerRupiahField(),
    paidAt: { type: Date, default: null },
  },
  // Zoho invoice match (Payments is independent of local Mongo invoices).
  zohoInvoiceId: { type: String, default: '' },
  zohoCustomerId: { type: String, default: '' },
  zohoPaymentId: { type: String, default: '' },
  matchedInvoice: {
    invoiceNumber: { type: String, default: '' },
    customerName: { type: String, default: '' },
    remaining: integerRupiahField(),
    dueDate: { type: String, default: '' },
    status: { type: String, default: '' },
  },
  matchType: {
    type: String,
    enum: ['exact', 'partial', 'over', 'none'],
    default: undefined,
  },
  matchConfidence: {
    type: String,
    enum: ['high', 'medium', 'low'],
    default: undefined,
  },
  matchReasons: { type: [String], default: [] },
  matchCandidates: { type: [Schema.Types.Mixed], default: [] },
  flags: { type: [String], default: [] },
  failureMessage: { type: String, default: '' },
  statementVerified: { type: Boolean, default: false },
  verifiedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  verifiedAt: { type: Date, default: null },
  approvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  approvedAt: { type: Date, default: null },
  rejectedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  rejectedAt: { type: Date, default: null },
  rejectReason: { type: String, default: '' },
  overpaymentReason: { type: String, default: '' },
}, { timestamps: true, collection: 'bankPayments' });

bankPaymentSchema.index({ status: 1 });
bankPaymentSchema.index({ 'ai.amount': 1, 'ai.paidAt': 1 });
bankPaymentSchema.index({ uploadedBy: 1 });
bankPaymentSchema.index({ zohoInvoiceId: 1 });

export default mongoose.model('BankPayment', bankPaymentSchema);
