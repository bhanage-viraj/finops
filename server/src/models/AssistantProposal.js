import mongoose from 'mongoose';

const { Schema } = mongoose;

// A chat request that will change a payment. Nothing runs until the same person confirms.
const assistantProposalSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'cancelled', 'failed'],
    default: 'pending',
  },
  tool: { type: String, required: true, enum: ['link_invoices', 'record_payment'] },
  summary: { type: String, required: true },
  args: { type: Schema.Types.Mixed, required: true },
  expiresAt: { type: Date, required: true },
  resultMessage: { type: String, default: '' },
}, { timestamps: true, collection: 'assistantProposals' });

assistantProposalSchema.index({ userId: 1, status: 1 });
assistantProposalSchema.index({ expiresAt: 1 });

export default mongoose.model('AssistantProposal', assistantProposalSchema);
