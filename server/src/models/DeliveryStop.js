import mongoose from 'mongoose';
import { integerRupiahField } from '../utils/integerRupiah.js';

const { Schema } = mongoose;

const plannedItemSchema = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: 'Product', default: null },
  productName: { type: String, required: true },
  packType: { type: String, default: '' },
  packQty: { type: Number, default: null },
  qty: { type: Number, default: null },
  unitPrice: integerRupiahField(),
  qtyMissing: { type: Boolean, default: false },
}, { _id: false });

const locationSnapshotSchema = new Schema({
  lat: { type: Number, default: null },
  lng: { type: Number, default: null },
  source: { type: String, default: 'address' },
  mapsUrl: { type: String, default: '' },
  placeName: { type: String, default: '' },
  address: { type: String, default: '' },
  confidence: { type: String, enum: ['high', 'medium', 'low', 'none'], default: 'none' },
  needsPin: { type: Boolean, default: false },
}, { _id: false });

const statusHistorySchema = new Schema({
  status: { type: String, required: true },
  source: { type: String, enum: ['import', 'cartrack', 'gps', 'admin', 'nota', 'system'], default: 'system' },
  userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  at: { type: Date, default: Date.now },
  note: { type: String, default: '' },
}, { _id: false });

const deliveryStopSchema = new Schema({
  dayId: { type: Schema.Types.ObjectId, ref: 'DeliveryDay', required: true, index: true },
  routeId: { type: Schema.Types.ObjectId, ref: 'DeliveryRoute', default: null, index: true },
  deliveryCustomerId: { type: Schema.Types.ObjectId, ref: 'DeliveryCustomer', required: true },
  customerName: { type: String, required: true },
  sourceRow: { type: String, default: '' },
  sourceSheet: { type: String, default: '' },
  type: {
    type: String,
    enum: ['deliver', 'pickup', 'exchange', 'sample', 'other'],
    default: 'deliver',
  },
  plannedItems: { type: [plannedItemSchema], default: [] },
  note: { type: String, default: '' },
  timeTags: { type: [String], default: [] },
  isNewCustomer: { type: Boolean, default: false },
  isPriority: { type: Boolean, default: false },
  location: { type: locationSnapshotSchema, default: () => ({}) },
  sortIndex: { type: Number, default: 0 },
  status: {
    type: String,
    enum: [
      'planned',
      'map_sent',
      'otw',
      'arrived',
      'delivered',
      'nota_checked',
      'failed',
      'second_delivery',
    ],
    default: 'planned',
  },
  statusHistory: { type: [statusHistorySchema], default: [] },
  cartrackJobId: { type: String, default: '' },
  delivered: {
    items: { type: [plannedItemSchema], default: [] },
    emptiesReturned: { type: Number, default: null },
    notaNo: { type: String, default: '' },
    notaFileKey: { type: String, default: '' },
    paymentNote: { type: String, default: '' },
    total: integerRupiahField(),
  },
  ai: { type: Schema.Types.Mixed, default: null },
  confirmed: { type: Schema.Types.Mixed, default: null },
  mismatchFlags: { type: [String], default: [] },
}, { timestamps: true, collection: 'deliveryStops' });

deliveryStopSchema.index({ dayId: 1, status: 1 });
deliveryStopSchema.index({ 'delivered.notaNo': 1 });

export default mongoose.model('DeliveryStop', deliveryStopSchema);
