import DeliveryDay from '../../models/DeliveryDay.js';
import DeliveryStop from '../../models/DeliveryStop.js';

export async function refreshDaySummaryAfterNota(dayId) {
  const stops = await DeliveryStop.find({ dayId }).lean();
  const day = await DeliveryDay.findById(dayId);
  if (!day) return;
  day.summary = {
    ...(day.summary?.toObject?.() || day.summary || {}),
    stopCount: stops.length,
    exactLocations: stops.filter((s) => s.location?.lat != null && s.location?.confidence === 'high').length,
    needsLocation: stops.filter((s) => s.location?.needsPin).length,
    newCustomers: stops.filter((s) => s.isNewCustomer).length,
    unassigned: stops.filter((s) => !s.routeId).length,
    delivered: stops.filter((s) => ['delivered', 'nota_checked'].includes(s.status)).length,
    mismatches: stops.filter((s) => (s.mismatchFlags || []).length > 0).length,
  };
  await day.save();
}
