import mongoose from 'mongoose';

const settingSchema = new mongoose.Schema({
  erpFeaturesEnabled: { type: Boolean, default: false },
  cartrackEnabled: { type: Boolean, default: false },
  zohoRefreshToken: { type: String, default: '' },
  zohoAccountRules: {
    type: [{
      kind: { type: String, enum: ['expense', 'paid_through'] },
      documentType: { type: String, default: '' },
      key: { type: String },
      accountId: { type: String },
      label: { type: String, default: '' },
    }],
    default: [],
  },
  confidenceThresholds: {
    warn: { type: Number, default: 90 },
    bad: { type: Number, default: 70 },
  },
  duplicateWindowDays: { type: Number, default: 7 },
}, { timestamps: true, collection: 'settings' });

export default mongoose.model('Setting', settingSchema);
