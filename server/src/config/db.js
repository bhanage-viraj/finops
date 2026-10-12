import mongoose from 'mongoose';
import '../models/User.js';
import '../models/AuditLog.js';
import '../models/Setting.js';
import '../models/Document.js';

export async function connectDb(uri) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  // Models imported above register their indexes. Wait so a short script cannot exit first.
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}

export function databaseStatus() {
  return mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
}
