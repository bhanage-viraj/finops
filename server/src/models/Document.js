import mongoose from 'mongoose';

const { Schema } = mongoose;

const documentSchema = new Schema({
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  originalName: { type: String, default: '' },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true },
  sha256: { type: String, required: true },
  originalFileKey: { type: String, required: true },
  preprocessedFileKey: { type: String, default: '' },
  preprocessNote: { type: String, default: '' },
  pageCount: { type: Number, default: null },
  status: {
    type: String,
    required: true,
    enum: ['uploaded', 'processing', 'needs_review', 'submitted', 'approved', 'rejected', 'failed'],
    default: 'uploaded',
  },
  documentType: { type: String, default: 'unknown' },
  confirmedType: { type: String, default: '' },
  ai: { type: Schema.Types.Mixed, default: null },
  confirmed: { type: Schema.Types.Mixed, default: null },
  validation: { type: Schema.Types.Mixed, default: null },
  duplicateOf: { type: Schema.Types.ObjectId, ref: 'Document', default: null },
  failureMessage: { type: String, default: '' },
  rejectReason: { type: String, default: '' },
  processingStartedAt: { type: Date, default: null },
  processingAttempts: { type: [Schema.Types.Mixed], default: [] },
  approvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  approvedAt: { type: Date, default: null },
  submittedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  submittedAt: { type: Date, default: null },
  rejectedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  rejectedAt: { type: Date, default: null },
  accountingPreview: { type: Schema.Types.Mixed, default: null },
  zohoExpense: {
    expenseId: { type: String, default: '' },
    sentAt: { type: Date, default: null },
    sentBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    sending: { type: Boolean, default: false },
    lastError: { type: String, default: '' },
    receiptAttached: { type: Boolean, default: false },
    receiptNote: { type: String, default: '' },
    accountId: { type: String, default: '' },
    paidThroughAccountId: { type: String, default: '' },
    selectedAccountId: { type: String, default: '' },
    selectedAccountLabel: { type: String, default: '' },
    selectedPaidThroughAccountId: { type: String, default: '' },
    selectedPaidThroughLabel: { type: String, default: '' },
  },
  idempotencyKey: { type: String },
  payment: {
    status: { type: String, enum: ['unpaid', 'paid'], default: 'unpaid' },
    bankPaymentId: { type: Schema.Types.ObjectId, ref: 'BankPayment', default: null },
    paidAt: { type: Date, default: null },
    confirmedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  searchParty: { type: String, default: '' },
  searchDate: { type: String, default: null },
  searchTotal: { type: Number, default: null },
}, { timestamps: true, collection: 'documents' });

documentSchema.index({ status: 1 });
documentSchema.index({ documentType: 1 });
documentSchema.index({ uploadedBy: 1 });
documentSchema.index({ sha256: 1 });
documentSchema.index({ searchParty: 1, searchDate: 1, searchTotal: 1 });
documentSchema.index(
  { uploadedBy: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

export default mongoose.model('Document', documentSchema);
