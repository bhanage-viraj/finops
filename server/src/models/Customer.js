import mongoose from 'mongoose';

const { Schema } = mongoose;

const customerSchema = new Schema({
  name: { type: String, required: true, trim: true },
  aliases: { type: [String], default: [] },
  erpCustomerId: { type: String, required: true, unique: true, trim: true },
  paymentTermsDays: { type: Number, default: 14, min: 0 },
  deliveryFeeRule: { type: String, default: '' },
  phone: { type: String, default: '' },
}, { timestamps: true, collection: 'customers' });

customerSchema.index({ name: 1 });

export default mongoose.model('Customer', customerSchema);
