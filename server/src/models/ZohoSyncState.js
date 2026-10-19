import mongoose from 'mongoose';

const zohoSyncStateSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  // One sync at a time, also across a restart in the middle of a run.
  lockedUntil: { type: Date, default: null },
  lastFullStartedAt: { type: Date, default: null },
  lastFullOkAt: { type: Date, default: null },
  lastFullCount: { type: Number, default: 0 },
  lastFullTruncated: { type: Boolean, default: false },
  // Changes made in Zoho after this time are not in the copy yet.
  lastChangesAt: { type: Date, default: null },
  lastChangesRunAt: { type: Date, default: null },
  changesFilterWorks: { type: Boolean, default: true },
  needsFull: { type: Boolean, default: false },
  lastError: { type: String, default: '' },
  lastErrorAt: { type: Date, default: null },
}, { timestamps: true, collection: 'zohoSyncState' });

export default mongoose.model('ZohoSyncState', zohoSyncStateSchema);
