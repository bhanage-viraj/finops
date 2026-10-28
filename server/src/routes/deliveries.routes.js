import { Router } from 'express';
import {
  list,
  market,
  meta,
  detail,
  importDay,
  importSheet,
  importHistory,
  removeDay,
  needsLocation,
  setLocation,
  patchRoute,
  move,
  moveMany,
  removeStops,
  removeStopMaps,
  patchStop,
  clearMaps,
  status,
  routeMessage,
  mapSent,
  reorder,
  exportXlsx,
  report,
  atRisk,
  close,
  dispatch,
  cartrackSetting,
  sendCartrack,
  syncCartrack,
  gpsSuggestions,
  daySpeed,
  fleetSpeed,
  linkVehicles,
  uploadNota,
  confirmNotaCtrl,
  empties,
  notaFile,
} from '../controllers/deliveries.controller.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { cartrackKillSwitch } from '../middleware/cartrackKillSwitch.js';
import { documentUploadSingle } from '../middleware/upload.js';

export function createDeliveriesRouter(env) {
  const router = Router();
  router.use(requireAuth(env));
  const ops = requireRole('delivery', 'accountant', 'admin');
  const readers = requireRole('staff', 'delivery', 'accountant', 'admin');
  const admin = requireRole('admin');
  const upload = documentUploadSingle(env.upload.maxBytes);

  router.get('/', ops, list(env));
  router.get('/market', readers, market());
  router.get('/meta', ops, meta());
  router.get('/settings/cartrack', ops, cartrackSetting());
  router.post('/settings/cartrack', admin, cartrackSetting());

  router.post('/import', ops, upload, importDay(env));
  router.post('/import-sheet', ops, importSheet(env));
  router.post('/import-history', ops, upload, importHistory());
  // Read-only Cartrack: link ids + status sync. Job create stays blocked in the client.
  router.post('/cartrack/link-vehicles', admin, linkVehicles(env));
  router.get('/speed', ops, fleetSpeed(env));

  router.get('/:dayId', ops, detail());
  router.delete('/:dayId', ops, removeDay(env));
  router.get('/:dayId/needs-location', ops, needsLocation());
  router.get('/:dayId/report', ops, report());
  router.get('/:dayId/at-risk', ops, atRisk());
  router.get('/:dayId/export', ops, exportXlsx());
  router.post('/:dayId/dispatch', ops, dispatch());
  router.post('/:dayId/close', ops, close());
  router.post('/:dayId/moves', ops, moveMany());
  router.post('/:dayId/stops/delete', ops, removeStops());
  router.post('/:dayId/maps/delete', ops, removeStopMaps());
  router.post('/:dayId/cartrack/sync', ops, syncCartrack(env));
  router.get('/:dayId/cartrack/gps-suggestions', ops, gpsSuggestions(env));
  router.get('/:dayId/speed', ops, daySpeed(env));

  router.patch('/stops/:stopId', ops, patchStop());
  router.patch('/stops/:stopId/location', ops, setLocation());
  router.patch('/stops/:stopId/move', ops, move());
  router.post('/stops/:stopId/status', ops, status());
  router.post('/stops/:stopId/nota', ops, upload, uploadNota(env));
  router.post('/stops/:stopId/nota/confirm', ops, confirmNotaCtrl());
  router.get('/stops/:stopId/nota/file', ops, notaFile(env));

  router.patch('/routes/:routeId', ops, patchRoute());
  router.get('/routes/:routeId/message', ops, routeMessage(env));
  router.post('/routes/:routeId/map-sent', ops, mapSent());
  router.delete('/routes/:routeId/maps', ops, clearMaps());
  router.post('/routes/:routeId/reorder', ops, reorder(env));
  // Kept for old clients; always returns 403 (Cartrack read-only).
  router.post('/routes/:routeId/cartrack/send', ops, cartrackKillSwitch, sendCartrack(env));
  router.get('/routes/:routeId/empties', ops, empties());

  return router;
}
