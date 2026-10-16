import mongoose from 'mongoose';

const { Schema } = mongoose;

const deliveryDaySchema = new Schema({
  date: { type: String, required: true, unique: true }, // YYYY-MM-DD (UTC date of delivery)
  label: { type: String, default: '' },
  sourceFileKey: { type: String, default: '' },
  sourceFileName: { type: String, default: '' },
  status: {
    type: String,
    enum: ['draft', 'dispatched', 'closed'],
    default: 'draft',
  },
  summary: {
    stopCount: { type: Number, default: 0 },
    exactLocations: { type: Number, default: 0 },
    needsLocation: { type: Number, default: 0 },
    newCustomers: { type: Number, default: 0 },
    unassigned: { type: Number, default: 0 },
    delivered: { type: Number, default: 0 },
    mismatches: { type: Number, default: 0 },
  },
  importedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  closedAt: { type: Date, default: null },
  closedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true, collection: 'deliveryDays' });

export default mongoose.model('DeliveryDay', deliveryDaySchema);
