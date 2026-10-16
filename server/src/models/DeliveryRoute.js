import mongoose from 'mongoose';

const { Schema } = mongoose;

const deliveryRouteSchema = new Schema({
  dayId: { type: Schema.Types.ObjectId, ref: 'DeliveryDay', required: true, index: true },
  areaId: { type: Schema.Types.ObjectId, ref: 'Area', default: null },
  areaName: { type: String, default: 'Unassigned' },
  number: { type: Number, default: null },
  vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', default: null },
  vehicleLabel: { type: String, default: '' },
  driverIds: { type: [{ type: Schema.Types.ObjectId, ref: 'Driver' }], default: [] },
  driverNames: { type: [String], default: [] },
  stopOrder: { type: [{ type: Schema.Types.ObjectId, ref: 'DeliveryStop' }], default: [] },
  mapSentAt: { type: Date, default: null },
  mapsFlag: { type: Boolean, default: false },
  otwFlag: { type: Boolean, default: false },
  doneFlag: { type: Boolean, default: false },
  loadingTotals: { type: Schema.Types.Mixed, default: {} },
}, { timestamps: true, collection: 'deliveryRoutes' });

deliveryRouteSchema.index({ dayId: 1, areaName: 1 });

export default mongoose.model('DeliveryRoute', deliveryRouteSchema);
