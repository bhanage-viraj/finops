import mongoose from 'mongoose';

const productSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, unique: true },
  nameKey: { type: String, required: true, unique: true, trim: true, lowercase: true },
  size: { type: String, default: '' },
  packType: { type: String, default: '' },
  unitsPerPack: { type: Number, default: 1, min: 1 },
  kind: {
    type: String,
    enum: ['gallon', 'glass', 'bottle', 'can', 'ice', 'pickup', 'other'],
    default: 'other',
  },
  active: { type: Boolean, default: true },
}, { timestamps: true, collection: 'products' });

export default mongoose.model('Product', productSchema);
