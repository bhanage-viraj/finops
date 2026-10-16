import mongoose from 'mongoose';

const driverSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  nameKey: { type: String, required: true, unique: true, trim: true, lowercase: true },
  phone: { type: String, default: '' },
  cartrackDriverId: { type: String, default: '' },
  active: { type: Boolean, default: true },
}, { timestamps: true, collection: 'drivers' });

export default mongoose.model('Driver', driverSchema);
