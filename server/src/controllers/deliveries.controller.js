import { asyncHandler } from '../utils/http.js';
import {
  importOrderWorkbook,
  importHistoryWorkbook,
  deleteDeliveryDay,
} from '../services/deliveries/dayImport.js';
import {
  listDays,
  getDayDetail,
  listStopsNeedingLocation,
  setStopLocation,
  updateRoute,
  moveStop,
  moveStopsToFleet,
  deleteStops,
  deleteFleet,
  clearRouteMaps,
  setStopStatus,
  getRouteMessage,
  markMapSent,
  listMeta,
  atRiskStops,
  dayReport,
  closeDay,
  dispatchDay,
  getCartrackEnabled,
  setCartrackEnabled,
  reorderRouteNearest,
  depotFromEnv,
} from '../services/deliveries/deliveryService.js';
import { exportDayWorkbook } from '../services/deliveries/sheetExport.js';
import {
  sendRouteJobs,
  syncDayFromCartrack,
  suggestArrivalsFromGps,
  linkVehiclesFromCartrack,
} from '../services/deliveries/cartrackSync.js';
import { attachNotaToStop, confirmNota, emptiesBalance } from '../services/deliveries/notaReader.js';
import DeliveryStop from '../models/DeliveryStop.js';
import { createFileStorage } from '../services/storage/fileStorage.js';

export function list(env) {
  return asyncHandler(async (req, res) => {
    res.json({ days: await listDays(), cartrackEnabled: await getCartrackEnabled(), depot: depotFromEnv(env) });
  });
}

export function meta() {
  return asyncHandler(async (req, res) => {
    res.json(await listMeta());
  });
}

export function detail() {
  return asyncHandler(async (req, res) => {
    res.json(await getDayDetail(req.params.dayId));
  });
}

export function importDay(env) {
  return asyncHandler(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'Upload an .xlsx delivery list.' });
      return;
    }
    const result = await importOrderWorkbook({
      buffer: req.file.buffer,
      fileName: req.file.originalname,
      user: req.user,
      env,
      dateOverride: req.body?.date || null,
      depot: depotFromEnv(env),
    });
    res.status(201).json(result);
  });
}

export function importHistory() {
  return asyncHandler(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'Upload a historical LIST DRIVER .xlsx.' });
      return;
    }
    const result = await importHistoryWorkbook({
      buffer: req.file.buffer,
      fileName: req.file.originalname,
      user: req.user,
    });
    res.status(201).json(result);
  });
}

export function removeDay(env) {
  return asyncHandler(async (req, res) => {
    res.json(await deleteDeliveryDay(req.params.dayId, req.user, env));
  });
}

export function needsLocation() {
  return asyncHandler(async (req, res) => {
    res.json({ stops: await listStopsNeedingLocation(req.params.dayId) });
  });
}

export function setLocation() {
  return asyncHandler(async (req, res) => {
    res.json({ stop: await setStopLocation(req.params.stopId, req.user, req.body || {}) });
  });
}

export function patchRoute() {
  return asyncHandler(async (req, res) => {
    res.json({ route: await updateRoute(req.params.routeId, req.user, req.body || {}) });
  });
}

export function move() {
  return asyncHandler(async (req, res) => {
    res.json(await moveStop(req.params.stopId, req.user, req.body || {}));
  });
}

export function moveMany() {
  return asyncHandler(async (req, res) => {
    res.json(await moveStopsToFleet(req.params.dayId, req.user, {
      stopIds: req.body?.stopIds,
      routeId: req.body?.routeId,
    }));
  });
}

export function removeStops() {
  return asyncHandler(async (req, res) => {
    res.json(await deleteStops(req.params.dayId, req.user, { stopIds: req.body?.stopIds }));
  });
}

export function removeFleet() {
  return asyncHandler(async (req, res) => {
    res.json(await deleteFleet(req.params.routeId, req.user, { alsoStops: req.body?.alsoStops === true }));
  });
}

export function clearMaps() {
  return asyncHandler(async (req, res) => {
    res.json({ route: await clearRouteMaps(req.params.routeId, req.user) });
  });
}

export function status() {
  return asyncHandler(async (req, res) => {
    res.json({
      stop: await setStopStatus(req.params.stopId, req.user, {
        status: req.body?.status,
        source: req.body?.source || 'admin',
        note: req.body?.note || '',
      }),
    });
  });
}

export function routeMessage(env) {
  return asyncHandler(async (req, res) => {
    res.json(await getRouteMessage(req.params.routeId, env));
  });
}

export function mapSent() {
  return asyncHandler(async (req, res) => {
    res.json({ route: await markMapSent(req.params.routeId, req.user) });
  });
}

export function reorder(env) {
  return asyncHandler(async (req, res) => {
    res.json({ route: await reorderRouteNearest(req.params.routeId, env) });
  });
}

export function exportXlsx() {
  return asyncHandler(async (req, res) => {
    const { buffer, fileName } = await exportDayWorkbook(req.params.dayId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(buffer);
  });
}

export function report() {
  return asyncHandler(async (req, res) => {
    res.json(await dayReport(req.params.dayId));
  });
}

export function atRisk() {
  return asyncHandler(async (req, res) => {
    res.json(await atRiskStops(req.params.dayId));
  });
}

export function close() {
  return asyncHandler(async (req, res) => {
    res.json({ day: await closeDay(req.params.dayId, req.user) });
  });
}

export function dispatch() {
  return asyncHandler(async (req, res) => {
    res.json({ day: await dispatchDay(req.params.dayId, req.user) });
  });
}

export function cartrackSetting() {
  return asyncHandler(async (req, res) => {
    if (req.method === 'GET') {
      res.json({ cartrackEnabled: await getCartrackEnabled() });
      return;
    }
    res.json({ cartrackEnabled: (await setCartrackEnabled(req.body?.enabled, req.user)).cartrackEnabled });
  });
}

export function sendCartrack(env) {
  return asyncHandler(async (req, res) => {
    res.json(await sendRouteJobs(req.params.routeId, req.user, env));
  });
}

export function syncCartrack(env) {
  return asyncHandler(async (req, res) => {
    res.json(await syncDayFromCartrack(req.params.dayId, req.user, env));
  });
}

export function gpsSuggestions(env) {
  return asyncHandler(async (req, res) => {
    res.json(await suggestArrivalsFromGps(req.params.dayId, env));
  });
}

export function linkVehicles(env) {
  return asyncHandler(async (req, res) => {
    res.json(await linkVehiclesFromCartrack(env));
  });
}

export function uploadNota(env) {
  return asyncHandler(async (req, res) => {
    const stop = await attachNotaToStop({
      stopId: req.params.stopId,
      user: req.user,
      env,
      file: req.file,
      confirm: req.body?.confirm === 'true' || req.body?.confirm === true,
    });
    res.status(201).json({ stop });
  });
}

export function confirmNotaCtrl() {
  return asyncHandler(async (req, res) => {
    res.json({ stop: await confirmNota(req.params.stopId, req.user, req.body || {}) });
  });
}

export function empties() {
  return asyncHandler(async (req, res) => {
    const stops = await DeliveryStop.find({ routeId: req.params.routeId }).lean();
    res.json(emptiesBalance(stops));
  });
}

export function notaFile(env) {
  return asyncHandler(async (req, res) => {
    const stop = await DeliveryStop.findById(req.params.stopId).lean();
    if (!stop?.delivered?.notaFileKey) {
      res.status(404).json({ error: 'No nota photo on this stop.' });
      return;
    }
    const bytes = await createFileStorage(env.upload.dir).read(stop.delivered.notaFileKey);
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=60');
    res.send(bytes);
  });
}
