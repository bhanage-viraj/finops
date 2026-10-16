import mongoose from 'mongoose';

const { Schema } = mongoose;

const areaSchema = new Schema({
  name: { type: String, required: true, trim: true, unique: true },
  nameKey: { type: String, required: true, unique: true, trim: true, lowercase: true },
  number: { type: Number, default: null },
  aliases: { type: [String], default: [] },
  keywords: { type: [String], default: [] },
  centre: {
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
  },
  defaultVehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', default: null },
  defaultDriverIds: { type: [{ type: Schema.Types.ObjectId, ref: 'Driver' }], default: [] },
  isCustom: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
}, { timestamps: true, collection: 'areas' });

export default mongoose.model('Area', areaSchema);
