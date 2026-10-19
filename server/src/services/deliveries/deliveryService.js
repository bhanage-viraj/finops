import DeliveryDay from '../../models/DeliveryDay.js';
import DeliveryRoute from '../../models/DeliveryRoute.js';
import DeliveryStop from '../../models/DeliveryStop.js';
import DeliveryCustomer from '../../models/DeliveryCustomer.js';
import Area from '../../models/Area.js';
import Driver from '../../models/Driver.js';
import Vehicle from '../../models/Vehicle.js';
import Setting from '../../models/Setting.js';
import { writeAudit } from '../audit/auditLogger.js';
import { httpError } from '../../utils/http.js';
import { orderStops } from './stopOrder.js';
import { loadingTotalsObject } from './loadingList.js';
import { buildRouteWhatsAppMessage, whatsappUrl } from './whatsappMessage.js';
import { applyListPrices } from './priceList.js';
import { mapsSearchUrl } from './mapsLink.js';
import { coordsFromMapsUrl, parseDms, parsePlusCode, parseDecimalCoords } from './locationResolver.js';
import { expandMapsLink } from './expandMapsLink.js';
import { createFileStorage, extensionFor } from '../storage/fileStorage.js';

const DELIVERY_ROLES = ['delivery', 'accountant', 'admin'];

export function assertDeliveryRole(user) {
  if (!user || !DELIVERY_ROLES.includes(user.role)) {
    throw httpError(403, 'You do not have access to deliveries.');
  }
}

export async function listDays() {
  return DeliveryDay.find().sort({ date: -1 }).limit(60).lean();
}

export async function getDayDetail(dayId) {
  const day = await DeliveryDay.findById(dayId).lean();
  if (!day) throw httpError(404, 'Delivery day not found.');
  const routes = await DeliveryRoute.find({ dayId }).sort({ number: 1, areaName: 1 }).lean();
  const areaByRoute = new Map(routes.map((route) => [String(route._id), route.areaName]));
  const stops = (await DeliveryStop.find({ dayId }).sort({ sortIndex: 1 }).lean()).map((stop) => ({
    ...stop,
    plannedItems: applyListPrices(stop.plannedItems, areaByRoute.get(String(stop.routeId))),
  }));
  return { day, routes, stops };
}

export async function listStopsNeedingLocation(dayId) {
  const stops = await DeliveryStop.find({
    dayId,
    $or: [
      { 'location.needsPin': true },
      { 'location.confidence': { $in: ['none', 'low'] } },
      { 'location.lat': null },
    ],
  }).lean();
  return stops;
}

export async function setStopLocation(stopId, user, body) {
  const stop = await DeliveryStop.findById(stopId);
  if (!stop) throw httpError(404, 'Stop not found.');

  let lat = body.lat != null ? Number(body.lat) : null;
  let lng = body.lng != null ? Number(body.lng) : null;
  let mapsUrl = String(body.mapsUrl || '').trim();
  let source = 'manual';

  if ((lat == null || lng == null) && mapsUrl) {
    const fromUrl = coordsFromMapsUrl(mapsUrl) || await expandMapsLink(mapsUrl);
    if (fromUrl) {
      lat = fromUrl.lat;
      lng = fromUrl.lng;
      mapsUrl = fromUrl.finalUrl || mapsUrl;
      source = 'maps_link';
    }
  }
  if ((lat == null || lng == null) && body.text) {
    const text = String(body.text);
    const dms = parseDms(text);
    const plus = parsePlusCode(text);
    const dec = parseDecimalCoords(text);
    const hit = dms || plus || dec;
    if (hit) {
      lat = hit.lat;
      lng = hit.lng;
      source = dms ? 'dms' : plus ? 'plus_code' : 'decimal';
    }
    const link = text.match(/https?:\/\/\S+/);
    if (link) mapsUrl = mapsUrl || link[0];
  }

  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw httpError(400, 'Provide coordinates, a Google Maps link, or GPS / plus-code text.');
  }

  const before = { location: stop.location };
  stop.location = {
    lat,
    lng,
    source,
    mapsUrl: mapsUrl || mapsSearchUrl({ location: { lat, lng } }),
    placeName: body.placeName || stop.location?.placeName || '',
    address: body.address || stop.location?.address || '',
    confidence: 'high',
    needsPin: false,
  };
  await stop.save();

  const customer = await DeliveryCustomer.findById(stop.deliveryCustomerId);
  if (customer) {
    customer.location = {
      lat,
      lng,
      source,
      mapsUrl: stop.location.mapsUrl,
      placeName: stop.location.placeName,
      address: stop.location.address,
      confirmedBy: user._id,
      confirmedAt: new Date(),
    };
    await customer.save();
  }

  await writeAudit({
    userId: user._id,
    action: 'set_location',
    entity: 'deliveryStops',
    entityId: stop._id,
    before,
    after: { location: stop.location },
  });

  return stop.toObject();
}

export async function updateRoute(routeId, user, body) {
  const route = await DeliveryRoute.findById(routeId);
  if (!route) throw httpError(404, 'Route not found.');
  const before = route.toObject();

  if (body.vehicleId !== undefined) {
    route.vehicleId = body.vehicleId || null;
    if (body.vehicleLabel) route.vehicleLabel = body.vehicleLabel;
    else if (body.vehicleId) {
      const v = await Vehicle.findById(body.vehicleId).lean();
      route.vehicleLabel = v ? `${v.type} ${v.plate}` : '';
    }
  }
  if (body.driverIds) {
    route.driverIds = body.driverIds;
    const drivers = await Driver.find({ _id: { $in: body.driverIds } }).lean();
    route.driverNames = drivers.map((d) => d.name);
  }
  if (body.areaName) route.areaName = body.areaName;
  if (body.areaId !== undefined) route.areaId = body.areaId || null;
  if (Array.isArray(body.stopOrder)) {
    route.stopOrder = body.stopOrder;
    for (let i = 0; i < body.stopOrder.length; i += 1) {
      await DeliveryStop.updateOne(
        { _id: body.stopOrder[i], dayId: route.dayId },
        { $set: { routeId: route._id, sortIndex: i } },
      );
    }
    const stops = await DeliveryStop.find({ _id: { $in: body.stopOrder } });
    route.loadingTotals = loadingTotalsObject(stops);
  }
  if (body.mapsFlag != null) route.mapsFlag = Boolean(body.mapsFlag);
  if (body.otwFlag != null) route.otwFlag = Boolean(body.otwFlag);
  if (body.doneFlag != null) route.doneFlag = Boolean(body.doneFlag);

  await route.save();
  await writeAudit({
    userId: user._id,
    action: 'update',
    entity: 'deliveryRoutes',
    entityId: route._id,
    before,
    after: route.toObject(),
  });
  return route.toObject();
}

export async function moveStop(stopId, user, { routeId, sortIndex }) {
  const stop = await DeliveryStop.findById(stopId);
  if (!stop) throw httpError(404, 'Stop not found.');
  const beforeRoute = stop.routeId;
  stop.routeId = routeId || null;
  if (sortIndex != null) stop.sortIndex = sortIndex;
  await stop.save();

  // Refresh both routes' stopOrder and loading totals
  for (const rid of [beforeRoute, routeId].filter(Boolean)) {
    const stops = await DeliveryStop.find({ routeId: rid }).sort({ sortIndex: 1 });
    await DeliveryRoute.updateOne(
      { _id: rid },
      {
        $set: {
          stopOrder: stops.map((s) => s._id),
          loadingTotals: loadingTotalsObject(stops),
        },
      },
    );
  }

  await writeAudit({
    userId: user._id,
    action: 'move_stop',
    entity: 'deliveryStops',
    entityId: stop._id,
    before: { routeId: beforeRoute },
    after: { routeId: stop.routeId, sortIndex: stop.sortIndex },
  });
  return stop.toObject();
}

export function assertStatusTransition(status, source) {
  const allowed = [
    'planned', 'map_sent', 'otw', 'arrived', 'delivered',
    'nota_checked', 'failed', 'second_delivery',
  ];
  if (!allowed.includes(status)) throw httpError(400, 'Unknown status.');
  if (status === 'delivered' && source === 'gps') {
    throw httpError(400, 'Delivered cannot come from GPS alone. A person must confirm.');
  }
}

export async function setStopStatus(stopId, user, { status, source = 'admin', note = '' }) {
  assertStatusTransition(status, source);

  const stop = await DeliveryStop.findById(stopId);
  if (!stop) throw httpError(404, 'Stop not found.');
  const before = stop.status;
  stop.status = status;
  stop.statusHistory.push({
    status,
    source,
    userId: user?._id || null,
    at: new Date(),
    note,
  });
  await stop.save();

  await refreshDaySummary(stop.dayId);
  await writeAudit({
    userId: user?._id,
    action: 'status',
    entity: 'deliveryStops',
    entityId: stop._id,
    before: { status: before },
    after: { status, source },
  });
  return stop.toObject();
}

async function refreshDaySummary(dayId) {
  const stops = await DeliveryStop.find({ dayId }).lean();
  const day = await DeliveryDay.findById(dayId);
  if (!day) return;
  day.summary = {
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

export async function getRouteMessage(routeId, env) {
  const route = await DeliveryRoute.findById(routeId).lean();
  if (!route) throw httpError(404, 'Route not found.');
  const day = await DeliveryDay.findById(route.dayId).lean();
  const stops = await DeliveryStop.find({ routeId: route._id }).sort({ sortIndex: 1 }).lean();
  const depot = depotFromEnv(env);
  const text = buildRouteWhatsAppMessage(
    { ...route, date: day?.date, dateLabel: day?.date },
    stops,
    { depot },
  );
  const phone = route.driverIds?.length
    ? (await Driver.findById(route.driverIds[0]).lean())?.phone
    : '';
  return {
    text,
    whatsappUrl: whatsappUrl(phone, text),
    stopCount: stops.length,
    needsCheck: stops.filter((s) => s.location?.needsPin).length,
  };
}

export async function markMapSent(routeId, user) {
  const route = await DeliveryRoute.findById(routeId);
  if (!route) throw httpError(404, 'Route not found.');
  route.mapSentAt = new Date();
  route.mapsFlag = true;
  await route.save();
  await DeliveryStop.updateMany(
    { routeId: route._id, status: 'planned' },
    {
      $set: { status: 'map_sent' },
      $push: {
        statusHistory: {
          status: 'map_sent',
          source: 'admin',
          userId: user._id,
          at: new Date(),
        },
      },
    },
  );
  return route.toObject();
}

export function depotFromEnv(env) {
  const lat = env?.deliveries?.depotLat;
  const lng = env?.deliveries?.depotLng;
  if (lat == null || lng == null) return null;
  return { lat, lng };
}

export async function listMeta() {
  const [areas, vehicles, drivers] = await Promise.all([
    Area.find({ active: true }).sort({ number: 1, name: 1 }).lean(),
    Vehicle.find({ active: true }).sort({ plate: 1 }).lean(),
    Driver.find({ active: true }).sort({ name: 1 }).lean(),
  ]);
  return { areas, vehicles, drivers };
}

export async function atRiskStops(dayId, { afterHour = 15, afterMinute = 30 } = {}) {
  const day = await DeliveryDay.findById(dayId).lean();
  if (!day) throw httpError(404, 'Delivery day not found.');
  const now = new Date();
  // Use Asia/Makassar wall clock roughly via UTC+8
  const localMinutes = ((now.getUTCHours() + 8) % 24) * 60 + now.getUTCMinutes();
  const threshold = afterHour * 60 + afterMinute;
  if (localMinutes < threshold) {
    return { atRisk: false, stops: [], localMinutes, threshold };
  }
  const open = await DeliveryStop.find({
    dayId,
    status: { $nin: ['delivered', 'nota_checked', 'failed'] },
  }).sort({ sortIndex: 1 }).lean();
  return { atRisk: open.length > 0, stops: open, localMinutes, threshold };
}

export async function dayReport(dayId) {
  const { day, routes, stops } = await getDayDetail(dayId);
  const byStatus = {};
  for (const s of stops) byStatus[s.status] = (byStatus[s.status] || 0) + 1;
  const mismatches = stops.filter((s) => (s.mismatchFlags || []).length > 0);
  const newCustomers = stops.filter((s) => s.isNewCustomer);
  const pending = stops.filter((s) => !['delivered', 'nota_checked', 'failed'].includes(s.status));
  return {
    day,
    routes: routes.map((r) => ({
      ...r,
      stopCount: stops.filter((s) => String(s.routeId) === String(r._id)).length,
      delivered: stops.filter((s) => String(s.routeId) === String(r._id) && ['delivered', 'nota_checked'].includes(s.status)).length,
    })),
    byStatus,
    mismatches,
    newCustomers,
    pending,
    handover: {
      pendingCount: pending.length,
      mismatchCount: mismatches.length,
      newCustomerCount: newCustomers.length,
      notes: pending.slice(0, 20).map((s) => `${s.customerName} (${s.status})`).join('; '),
    },
  };
}

export async function closeDay(dayId, user) {
  const day = await DeliveryDay.findById(dayId);
  if (!day) throw httpError(404, 'Delivery day not found.');
  day.status = 'closed';
  day.closedAt = new Date();
  day.closedBy = user._id;
  await day.save();
  await writeAudit({
    userId: user._id,
    action: 'close',
    entity: 'deliveryDays',
    entityId: day._id,
    after: { status: 'closed' },
  });
  return day.toObject();
}

export async function dispatchDay(dayId, user) {
  const day = await DeliveryDay.findById(dayId);
  if (!day) throw httpError(404, 'Delivery day not found.');
  day.status = 'dispatched';
  await day.save();
  await writeAudit({
    userId: user._id,
    action: 'dispatch',
    entity: 'deliveryDays',
    entityId: day._id,
    after: { status: 'dispatched' },
  });
  return day.toObject();
}

export async function getCartrackEnabled() {
  const settings = await Setting.findOne().select('cartrackEnabled').lean();
  return settings?.cartrackEnabled === true;
}

export async function setCartrackEnabled(value, user) {
  let settings = await Setting.findOne();
  if (!settings) settings = await Setting.create({});
  const before = settings.cartrackEnabled;
  settings.cartrackEnabled = Boolean(value);
  await settings.save();
  await writeAudit({
    userId: user._id,
    action: 'setting_change',
    entity: 'settings',
    entityId: settings._id,
    before: { cartrackEnabled: before },
    after: { cartrackEnabled: settings.cartrackEnabled },
  });
  return settings.toObject();
}

export async function reorderRouteNearest(routeId, env) {
  const route = await DeliveryRoute.findById(routeId);
  if (!route) throw httpError(404, 'Route not found.');
  const stops = await DeliveryStop.find({ routeId: route._id });
  const ordered = orderStops(stops.map((s) => s.toObject()), { depot: depotFromEnv(env) });
  for (let i = 0; i < ordered.length; i += 1) {
    await DeliveryStop.updateOne({ _id: ordered[i]._id }, { $set: { sortIndex: i } });
  }
  route.stopOrder = ordered.map((s) => s._id);
  route.loadingTotals = loadingTotalsObject(ordered);
  await route.save();
  return route.toObject();
}

export { extensionFor, createFileStorage };
