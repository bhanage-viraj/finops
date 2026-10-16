import DeliveryDay from '../../models/DeliveryDay.js';
import DeliveryRoute from '../../models/DeliveryRoute.js';
import DeliveryStop from '../../models/DeliveryStop.js';
import Vehicle from '../../models/Vehicle.js';
import Driver from '../../models/Driver.js';
import { createCartrackClient } from '../../integrations/cartrack/cartrackClient.js';
import { writeAudit } from '../audit/auditLogger.js';
import { httpError } from '../../utils/http.js';
import { getCartrackEnabled, setStopStatus } from './deliveryService.js';
import { haversineKm } from './areaCatalog.js';
import { plateKey } from './names.js';

function jobStatusToLocal(status) {
  const s = String(status || '').toLowerCase();
  if (/(complete|delivered|done|finished)/.test(s)) return 'delivered';
  if (/(arriv|on.?site|at.?stop)/.test(s)) return 'arrived';
  if (/(progress|otw|en.?route|started|assigned)/.test(s)) return 'otw';
  return null;
}

export async function assertCartrackWriteAllowed() {
  if (!(await getCartrackEnabled())) {
    throw httpError(403, 'Cartrack is turned off. An admin can enable it in Deliveries settings.');
  }
}

export async function sendRouteJobs(routeId, user, env) {
  await assertCartrackWriteAllowed();
  const client = createCartrackClient(env);
  if (!client.configured()) throw httpError(503, 'Cartrack is not configured.');

  const route = await DeliveryRoute.findById(routeId);
  if (!route) throw httpError(404, 'Route not found.');
  const day = await DeliveryDay.findById(route.dayId).lean();
  const stops = await DeliveryStop.find({ routeId: route._id }).sort({ sortIndex: 1 });

  let driverId = '';
  if (route.driverIds?.[0]) {
    const driver = await Driver.findById(route.driverIds[0]).lean();
    driverId = driver?.cartrackDriverId || '';
  }

  const created = [];
  const failed = [];
  for (const stop of stops) {
    if (stop.cartrackJobId) {
      created.push({ stopId: stop._id, jobId: stop.cartrackJobId, skipped: true });
      continue;
    }
    const loc = stop.location || {};
    const destination = loc.lat != null
      ? { latitude: loc.lat, longitude: loc.lng, address: loc.address || stop.customerName }
      : { address: [loc.placeName, loc.address, stop.customerName].filter(Boolean).join(', ') };

    try {
      const body = {
        job_type_id: 3,
        destination,
        customer_name: stop.customerName,
        notes: stop.note || '',
        external_id: String(stop._id),
      };
      if (driverId) body.driver_id = driverId;
      if (day?.date) body.scheduled_date = day.date;

      const result = await client.createJob(body);
      const jobId = result?.job_id || result?.id || result?.data?.job_id || result?.data?.id || '';
      if (jobId) {
        stop.cartrackJobId = String(jobId);
        await stop.save();
      }
      created.push({ stopId: stop._id, jobId, raw: result });
    } catch (err) {
      failed.push({ stopId: stop._id, error: err.message });
    }
  }

  await writeAudit({
    userId: user._id,
    action: 'cartrack_send',
    entity: 'deliveryRoutes',
    entityId: route._id,
    after: { created: created.length, failed: failed.length },
  });

  return { created, failed };
}

export async function syncDayFromCartrack(dayId, user, env) {
  await assertCartrackWriteAllowed();
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

export async function linkVehiclesFromCartrack(env) {
  await assertCartrackWriteAllowed();
  const client = createCartrackClient(env);
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
