import mongoose from 'mongoose';

const { Schema } = mongoose;

const locationSchema = new Schema({
  lat: { type: Number },
  lng: { type: Number },
  source: {
    type: String,
    enum: ['book', 'dms', 'decimal', 'plus_code', 'maps_link', 'cartrack', 'manual', 'address'],
    default: 'address',
  },
  mapsUrl: { type: String, default: '' },
  placeName: { type: String, default: '' },
  address: { type: String, default: '' },
  confirmedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  confirmedAt: { type: Date, default: null },
}, { _id: false });

const deliveryCustomerSchema = new Schema({
  name: { type: String, required: true, trim: true },
  nameKey: { type: String, required: true, unique: true, trim: true, lowercase: true },
  aliases: { type: [String], default: [] },
  location: { type: locationSchema, default: () => ({}) },
  defaultAreaId: { type: Schema.Types.ObjectId, ref: 'Area', default: null },
  standingNotes: { type: String, default: '' },
  phone: { type: String, default: '' },
  firstSeenAt: { type: Date, default: Date.now },
  // Optional link to the Zoho-backed Customer model.
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
  areaHistory: {
    type: [{
      areaId: { type: Schema.Types.ObjectId, ref: 'Area' },
      areaName: { type: String, default: '' },
      count: { type: Number, default: 1, min: 0 },
      lastSeenAt: { type: Date, default: Date.now },
    }],
    default: [],
  },
}, { timestamps: true, collection: 'deliveryCustomers' });

deliveryCustomerSchema.index({ name: 1 });
deliveryCustomerSchema.index({ 'location.lat': 1, 'location.lng': 1 });

export default mongoose.model('DeliveryCustomer', deliveryCustomerSchema);
