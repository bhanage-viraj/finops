import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, required: true, enum: ['staff', 'accountant', 'admin', 'delivery'] },
  active: { type: Boolean, default: true },
}, { timestamps: true, collection: 'users' });

export default mongoose.model('User', userSchema);
