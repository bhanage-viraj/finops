import mongoose from 'mongoose';

const { Schema } = mongoose;

const auditLogSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  action: { type: String, required: true },
  entity: { type: String, required: true },
  entityId: { type: Schema.Types.ObjectId, default: null },
  before: { type: Schema.Types.Mixed, default: null },
  after: { type: Schema.Types.Mixed, default: null },
  at: { type: Date, required: true, default: Date.now },
}, { timestamps: true, collection: 'auditLogs' });

auditLogSchema.index({ entity: 1, entityId: 1 });
auditLogSchema.index({ at: 1 });

export default mongoose.model('AuditLog', auditLogSchema);
