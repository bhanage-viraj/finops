import mongoose from 'mongoose';

const { Schema } = mongoose;

const channelSchema = new Schema({
  stops: { type: Number, default: 0 },
  gallons: { type: Number, default: 0 },
}, { _id: false });

const qtySchema = new Schema({
  name: { type: String, default: '' },
  kind: { type: String, default: '' },
  qty: { type: Number, default: 0 },
}, { _id: false });

// One day's overall demand. The driver sheet only keeps the current lists,
// so this is what lets the month trend survive the next day's tabs.
const marketDaySchema = new Schema({
  date: { type: String, required: true, unique: true },
  gallons: { type: Number, default: 0 },
  stops: { type: Number, default: 0 },
  qtyMissing: { type: Number, default: 0 },
  newCustomers: { type: Number, default: 0 },
  channels: {
    home: { type: channelSchema, default: () => ({}) },
    hotel: { type: channelSchema, default: () => ({}) },
    restaurant: { type: channelSchema, default: () => ({}) },
    depo: { type: channelSchema, default: () => ({}) },
  },
  products: { type: [qtySchema], default: [] },
  prepare: { type: [qtySchema], default: [] },
}, { timestamps: true, collection: 'marketDays' });

export default mongoose.model('MarketDay', marketDaySchema);
