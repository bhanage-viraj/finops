import mongoose from 'mongoose';

// The document stores only the key. The bytes live here so a host restart
// does not make an uploaded receipt impossible to open.
const storedFileSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  data: { type: Buffer, required: true },
}, { collection: 'storedFiles' });

export default mongoose.model('StoredFile', storedFileSchema);
