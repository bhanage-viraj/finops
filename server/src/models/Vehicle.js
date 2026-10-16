import mongoose from 'mongoose';

const vehicleSchema = new mongoose.Schema({
  plate: { type: String, required: true, trim: true, uppercase: true, unique: true },
  label: { type: String, default: '', trim: true },
  type: {
    type: String,
    enum: ['ELF', 'BOX', 'MOTOR', 'SEWA', 'OTHER'],
    default: 'OTHER',
  },
  cartrackVehicleId: { type: String, default: '' },
  active: { type: Boolean, default: true },
}, { timestamps: true, collection: 'vehicles' });

export default mongoose.model('Vehicle', vehicleSchema);
