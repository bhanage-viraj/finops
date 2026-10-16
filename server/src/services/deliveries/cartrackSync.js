import DeliveryDay from '../../models/DeliveryDay.js';
import DeliveryRoute from '../../models/DeliveryRoute.js';
import DeliveryStop from '../../models/DeliveryStop.js';
import Vehicle from '../../models/Vehicle.js';
import { createCartrackClient } from '../../integrations/cartrack/cartrackClient.js';
import { httpError } from '../../utils/http.js';
import { setStopStatus } from './deliveryService.js';
import { haversineKm } from './areaCatalog.js';
import { plateKey } from './names.js';

function jobStatusToLocal(status) {
  const s = String(status || '').toLowerCase();
  if (/(complete|delivered|done|finished)/.test(s)) return 'delivered';
  if (/(arriv|on.?site|at.?stop)/.test(s)) return 'arrived';
  if (/(progress|otw|en.?route|started|assigned)/.test(s)) return 'otw';
  return null;
}

/** Writes to Cartrack (create/complete jobs) are permanently disabled. */
export async function assertCartrackWriteAllowed() {
  throw httpError(403, 'Cartrack is read-only in FinOps. Creating or completing jobs is disabled.');
}

export async function sendRouteJobs() {
  await assertCartrackWriteAllowed();
}

export async function syncDayFromCartrack(dayId, user, env) {
  const client = createCartrackClient(env);
  if (!client.configured()) throw httpError(503, 'Cartrack is not configured.');

  const day = await DeliveryDay.findById(dayId).lean();
  if (!day) throw httpError(404, 'Delivery day not found.');
  const stops = await DeliveryStop.find({ dayId, cartrackJobId: { $ne: '' } });

  const updates = [];
  for (const stop of stops) {
    try {
      const job = await client.getJob(stop.cartrackJobId);
      const statusRaw = job?.status || job?.job_status || job?.data?.status;
      const local = jobStatusToLocal(statusRaw);
      if (local && local !== stop.status) {
        // Delivered from Cartrack means the driver completed the job (a person).
        await setStopStatus(stop._id, user, { status: local, source: 'cartrack' });
        updates.push({ stopId: stop._id, status: local });
      }
    } catch (err) {
      updates.push({ stopId: stop._id, error: err.message });
    }
  }
  return { updates };
}

export async function suggestArrivalsFromGps(dayId, env) {
  const client = createCartrackClient(env);
  if (!client.configured()) return { suggestions: [] };

  const routes = await DeliveryRoute.find({ dayId }).lean();
  const vehicles = await Vehicle.find({ active: true }).lean();
  let statusList = [];
  try {
    const raw = await client.vehiclesStatus();
    statusList = Array.isArray(raw) ? raw : (raw?.data || raw?.vehicles || []);
  } catch {
    return { suggestions: [] };
  }

  const suggestions = [];
  for (const route of routes) {
    const vehicle = vehicles.find((v) => String(v._id) === String(route.vehicleId))
      || vehicles.find((v) => plateKey(v.plate) === plateKey(route.vehicleLabel));
    if (!vehicle) continue;

    const live = statusList.find((s) => {
      const id = String(s.vehicle_id || s.id || '');
      const plate = plateKey(s.registration || s.plate || s.vehicle_registration || '');
      return (vehicle.cartrackVehicleId && id === String(vehicle.cartrackVehicleId))
        || (plate && plate === plateKey(vehicle.plate));
    });
    if (!live) continue;
    const lat = Number(live.latitude ?? live.lat ?? live.position?.latitude);
    const lng = Number(live.longitude ?? live.lng ?? live.position?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const stops = await DeliveryStop.find({
      routeId: route._id,
      status: { $in: ['planned', 'map_sent', 'otw'] },
      'location.lat': { $ne: null },
    }).lean();

    for (const stop of stops) {
      const km = haversineKm({ lat, lng }, stop.location);
      if (km * 1000 <= 150) {
        suggestions.push({
          stopId: stop._id,
          customerName: stop.customerName,
          routeId: route._id,
          distanceM: Math.round(km * 1000),
          vehiclePlate: vehicle.plate,
          suggestedStatus: 'arrived',
          source: 'gps',
          note: 'Suggestion only. Not marked delivered.',
        });
      }
    }
  }
  return { suggestions, vehiclesLive: statusList.length };
}

/** Read vehicles from Cartrack and store ids on FinOps vehicles (no Cartrack write). */
export async function linkVehiclesFromCartrack(env) {
  const client = createCartrackClient(env);
  if (!client.configured()) throw httpError(503, 'Cartrack is not configured.');
  const raw = await client.listVehicles();
  const list = Array.isArray(raw) ? raw : (raw?.data || raw?.vehicles || []);
  let linked = 0;
  for (const item of list) {
    const plate = item.registration || item.plate || item.vehicle_registration;
    if (!plate) continue;
    const vehicle = await Vehicle.findOne({
      $expr: {
        $eq: [
          { $replaceAll: { input: { $toUpper: '$plate' }, find: ' ', replacement: '' } },
          plateKey(plate),
        ],
      },
    });
    // Fallback simpler match
    const all = vehicle ? [vehicle] : await Vehicle.find({ active: true });
    const match = vehicle || all.find((v) => plateKey(v.plate) === plateKey(plate));
    if (match && !match.cartrackVehicleId) {
      match.cartrackVehicleId = String(item.vehicle_id || item.id || '');
      await match.save();
      linked += 1;
    }
  }
  return { linked, seen: list.length };
}
