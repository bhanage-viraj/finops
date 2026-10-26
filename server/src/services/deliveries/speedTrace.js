import DeliveryDay from '../../models/DeliveryDay.js';
import DeliveryRoute from '../../models/DeliveryRoute.js';
import Vehicle from '../../models/Vehicle.js';
import { createCartrackClient } from '../../integrations/cartrack/cartrackClient.js';
import { httpError } from '../../utils/http.js';
import { plateKey } from './names.js';

/** Alert when speed is above this. 30 km/h is the line on the morning graphs. */
export const SPEED_LIMIT_KMH = 30;

const WITA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_START = '05:00:00';
const DAY_END = '21:00:00';
const BURST_GAP_MS = 3 * 60 * 1000;
const CHART_TAIL_MS = 10 * 60 * 1000;
const MAX_EVENT_PAGES = 6;
const PAGE_SIZE = 1000;
const MAX_CHART_POINTS = 400;

function asList(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.data)) return raw.data;
  if (Array.isArray(raw?.vehicles)) return raw.vehicles;
  return [];
}

/** Bali wall clock (WITA, UTC+8) as YYYY-MM-DD. */
export function witaDateString(date) {
  return new Date(date.getTime() + WITA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Bali wall clock as HH:mm. */
export function formatWitaHm(date) {
  const local = new Date(date.getTime() + WITA_OFFSET_MS);
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mm = String(local.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function witaStamp(date) {
  const local = new Date(date.getTime() + WITA_OFFSET_MS);
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mm = String(local.getUTCMinutes()).padStart(2, '0');
  const ss = String(local.getUTCSeconds()).padStart(2, '0');
  return `${witaDateString(date)} ${hh}:${mm}:${ss}`;
}

/**
 * Cartrack sends "YYYY-MM-DD hh:mm:ss" with an optional offset.
 * A missing offset is Bali time, which is how the request window is sent.
 */
export function parseCartrackTimestamp(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(.*)$/);
  if (!match) return null;
  let zone = match[3].trim();
  if (!zone) zone = '+08:00';
  else if (/^[+-]\d{2}$/.test(zone)) zone = `${zone}:00`;
  else if (/^[+-]\d{4}$/.test(zone)) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
  else if (!/^[+-]\d{2}:\d{2}$/.test(zone)) return null;
  const date = new Date(`${match[1]}T${match[2]}${zone}`);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

/** Morning-to-afternoon window for one delivery date. Past days stop at 18:00. */
export function speedWindow(dateYmd, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateYmd || ''))) return null;
  const today = witaDateString(now);
  if (dateYmd > today) return null;
  const start = `${dateYmd} ${DAY_START}`;
  const endCap = `${dateYmd} ${DAY_END}`;
  if (dateYmd < today) return { start, end: endCap, refresh: false, pending: false };
  const end = witaStamp(now);
  if (end <= start) return { start, end: start, refresh: false, pending: true };
  const capped = end < endCap ? end : endCap;
  return { start, end: capped, refresh: capped < endCap, pending: false };
}

/** Pull a Bali plate out of a fleet label such as "ELF ( DK 8619 HJ )". */
export function plateFromLabel(label) {
  const text = String(label || '').toUpperCase();
  const match = text.match(/\b([A-Z]{1,2}\s*\d{1,4}\s*[A-Z]{1,3})\b/);
  if (!match) return '';
  const key = plateKey(match[1]);
  return key.length >= 5 ? key : '';
}

function readSpeed(value) {
  if (value == null || value === '') return null;
  const speed = Math.round(Number(value));
  if (!Number.isFinite(speed) || speed < 0 || speed > 300) return null;
  return speed;
}

/** One point per timestamp. A later duplicate keeps the higher speed so a spike is not lost. */
export function pointsFromEvents(rows) {
  const byTime = new Map();
  for (const row of rows || []) {
    const at = parseCartrackTimestamp(row?.event_ts || row?.eventTs || row?.timestamp);
    const speed = readSpeed(row?.speed);
    if (!at || speed == null) continue;
    const iso = at.toISOString();
    const prev = byTime.get(iso);
    if (prev == null || speed > prev) byTime.set(iso, speed);
  }
  return [...byTime.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([at, speed]) => ({ at, speed }));
}

export function mergePoints(groups) {
  const byTime = new Map();
  for (const point of groups.flat()) {
    const speed = readSpeed(point?.speed);
    if (!point?.at || speed == null) continue;
    const prev = byTime.get(point.at);
    if (prev == null || speed > prev) byTime.set(point.at, speed);
  }
  return [...byTime.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([at, speed]) => ({ at, speed }));
}

/** Stretches of speed above the limit. A gap longer than 3 minutes starts a new stretch. */
export function burstsAbove(points, limit = SPEED_LIMIT_KMH) {
  const bursts = [];
  let open = null;
  let prevAt = null;
  for (const point of points) {
    const atMs = new Date(point.at).getTime();
    const over = point.speed > limit;
    const gap = prevAt != null && atMs - prevAt > BURST_GAP_MS;
    if (over && open && !gap) {
      open.to = point.at;
      open.peak = Math.max(open.peak, point.speed);
    } else if (over) {
      if (open) bursts.push(open);
      open = { from: point.at, to: point.at, peak: point.speed };
    } else if (open) {
      bursts.push(open);
      open = null;
    }
    prevAt = atMs;
  }
  if (open) bursts.push(open);
  return bursts;
}

/** Drop the long parked stretch before the first move and after the last one. */
export function chartPoints(points) {
  let first = -1;
  let lastMove = -1;
  for (let i = 0; i < points.length; i += 1) {
    if (points[i].speed > 0) {
      if (first < 0) first = i;
      lastMove = i;
    }
  }
  if (first < 0) return [];
  let last = lastMove;
  const lastMoveMs = new Date(points[lastMove].at).getTime();
  for (let i = lastMove + 1; i < points.length; i += 1) {
    if (new Date(points[i].at).getTime() - lastMoveMs > CHART_TAIL_MS) break;
    last = i;
  }
  return points.slice(first, last + 1);
}

/** Keep the fastest sample in each bucket so a short spike still shows on the graph. */
export function downsampleSpeed(points, maxPoints = MAX_CHART_POINTS) {
  if (points.length <= maxPoints) return points.slice();
  const bucket = Math.ceil(points.length / maxPoints);
  const out = [];
  for (let i = 0; i < points.length; i += bucket) {
    const slice = points.slice(i, i + bucket);
    let slow = slice[0];
    let fast = slice[0];
    for (const point of slice) {
      if (point.speed < slow.speed) slow = point;
      if (point.speed > fast.speed) fast = point;
    }
    const pair = slow.at <= fast.at ? [slow, fast] : [fast, slow];
    for (const point of pair) {
      if (!out.length || out[out.length - 1].at !== point.at) out.push(point);
    }
  }
  return out;
}

function burstView(burst) {
  const from = formatWitaHm(new Date(burst.from));
  const to = formatWitaHm(new Date(burst.to));
  const when = from === to ? from : `${from}–${to}`;
  return { from, to, peak: burst.peak, label: `${when} peak ${burst.peak}` };
}

function blankVehicle(target, error = '') {
  return {
    plate: plateKey(target.plate) || String(target.plate || ''),
    areaName: target.areaName || '',
    points: [],
    bursts: [],
    burstCount: 0,
    maxSpeed: null,
    currentSpeed: null,
    overLimit: false,
    truncated: false,
    error,
  };
}

function cartrackRegistration(target, list) {
  const key = plateKey(target.plate);
  const hit = list.find((item) => {
    const id = String(item.vehicle_id || item.id || '');
    const reg = plateKey(item.registration || item.plate || item.vehicle_registration || '');
    return (target.cartrackVehicleId && id && id === String(target.cartrackVehicleId))
      || (reg && reg === key);
  });
  return String(hit?.registration || hit?.plate || target.plate || '').trim();
}

function liveSpeed(target, registration, statusList) {
  const key = plateKey(target.plate);
  const regKey = plateKey(registration);
  const hit = statusList.find((row) => {
    const id = String(row.vehicle_id || row.id || '');
    const plate = plateKey(row.registration || row.plate || row.vehicle_registration || '');
    return (target.cartrackVehicleId && id && id === String(target.cartrackVehicleId))
      || (plate && (plate === key || plate === regKey));
  });
  return readSpeed(hit?.speed);
}

async function collectEvents(client, registration, window, periodic) {
  const pages = [];
  let page = 1;
  let truncated = false;
  while (page <= MAX_EVENT_PAGES) {
    const query = {
      start_timestamp: window.start,
      end_timestamp: window.end,
      page,
      limit: PAGE_SIZE,
    };
    if (periodic) query['filter[terminal_event_type_id]'] = 2;
    const raw = await client.vehicleEvents(registration, query);
    const rows = asList(raw);
    pages.push(pointsFromEvents(rows));
    const last = Number(raw?.meta?.last_page);
    const more = Number.isFinite(last) && last >= 1 ? page < last : rows.length >= PAGE_SIZE;
    if (!more) break;
    if (page === MAX_EVENT_PAGES) {
      truncated = true;
      break;
    }
    page += 1;
  }
  return { points: mergePoints(pages), truncated };
}

async function readTrace(client, registration, window) {
  try {
    const packed = await collectEvents(client, registration, window, true);
    if (packed.points.length || packed.truncated) return packed;
  } catch (err) {
    if (err.status !== 400 && err.status !== 422) throw err;
  }
  return collectEvents(client, registration, window, false);
}

function summarize(target, points, { currentSpeed, showLive, truncated }) {
  const bursts = burstsAbove(points, SPEED_LIMIT_KMH);
  const speeds = points.map((point) => point.speed);
  if (currentSpeed != null) speeds.push(currentSpeed);
  const maxSpeed = speeds.length ? Math.max(...speeds) : null;
  const liveOver = showLive && currentSpeed != null && currentSpeed > SPEED_LIMIT_KMH;
  const traced = chartPoints(points);
  const chart = downsampleSpeed(traced.length ? traced : points);
  return {
    plate: plateKey(target.plate) || target.plate,
    areaName: target.areaName || '',
    points: chart.map((point) => ({ at: point.at, speed: point.speed })),
    bursts: bursts.slice(0, 8).map(burstView),
    burstCount: bursts.length,
    maxSpeed,
    currentSpeed: showLive ? currentSpeed : null,
    overLimit: bursts.length > 0 || liveOver,
    truncated,
    error: '',
  };
}

async function eachLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function rank(vehicle) {
  if (vehicle.currentSpeed != null && vehicle.currentSpeed > SPEED_LIMIT_KMH) return 0;
  if (vehicle.overLimit) return 1;
  if (vehicle.areaName) return 2;
  return 3;
}

/** Every other Cartrack car, whether or not it is on a delivery. */
export function otherVehicleTargets(rows, known) {
  const extras = [];
  const seen = known instanceof Set ? known : new Set(known || []);
  for (const item of rows || []) {
    const registration = String(
      item?.registration || item?.plate || item?.vehicle_registration || item?.license_plate || '',
    ).trim();
    const plate = plateKey(registration);
    if (!plate || seen.has(plate)) continue;
    seen.add(plate);
    extras.push({
      plate,
      areaName: '',
      cartrackVehicleId: String(item?.vehicle_id || item?.id || ''),
    });
  }
  return extras;
}

/** Cartrack list endpoints default to a short page, so follow every page. */
export async function collectFleetPages(fetchPage) {
  const rows = [];
  let page = 1;
  const limit = 1000;
  while (page <= 20) {
    const raw = await fetchPage({ page, limit });
    const list = asList(raw);
    rows.push(...list);
    const last = Number(raw?.meta?.last_page);
    const more = Number.isFinite(last) && last >= 1 ? page < last : list.length >= limit;
    if (!more) break;
    page += 1;
  }
  return rows;
}

async function collectFleet(fetchPage) {
  try {
    return await collectFleetPages(fetchPage);
  } catch (err) {
    if (err.status !== 400 && err.status !== 422) throw err;
    return asList(await fetchPage({}));
  }
}

/**
 * Speed graphs for every Cartrack car. A delivery only adds the area name.
 * Cartrack is read-only: vehicle list, live status, and historical events.
 */
export async function buildSpeedReport({ date, targets, client, now = new Date() }) {
  const window = speedWindow(date, now);
  const base = {
    limitKmh: SPEED_LIMIT_KMH,
    date,
    from: '05:00',
    to: window ? formatWitaHm(parseCartrackTimestamp(window.end) || now) : '',
    refresh: Boolean(window?.refresh),
    alertPlates: [],
    vehicles: [],
    note: '',
  };
  if (!window || window.pending) {
    return {
      ...base,
      to: window?.pending ? '05:00' : '',
      vehicles: (targets || []).map((target) => blankVehicle(target)),
      note: window?.pending
        ? 'Speed for this day starts at 05:00.'
        : 'That day has not started.',
    };
  }
  if (!client?.configured?.()) {
    if (!targets?.length) return { ...base, note: 'No cars from Cartrack.' };
    throw httpError(503, 'Cartrack is not configured. Set CARTRACK_USERNAME and CARTRACK_API_KEY.');
  }

  let registrations = [];
  try {
    registrations = await collectFleet((query) => client.listVehicles(query));
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw err;
    registrations = [];
  }
  let statusList = [];
  try {
    statusList = await collectFleet((query) => client.vehiclesStatus(query));
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw err;
    statusList = [];
  }

  const known = new Set((targets || []).map((target) => plateKey(target.plate)));
  const allTargets = [
    ...(targets || []),
    ...otherVehicleTargets(registrations, known),
    ...otherVehicleTargets(statusList, known),
  ];
  if (!allTargets.length) {
    return { ...base, note: 'No cars from Cartrack.' };
  }

  const vehicles = await eachLimited(allTargets, 3, async (target) => {
    const registration = cartrackRegistration(target, registrations);
    const currentSpeed = liveSpeed(target, registration, statusList);
    if (!registration) return blankVehicle(target, 'No Cartrack registration for this vehicle.');
    try {
      const packed = await readTrace(client, registration, window);
      const showLive = witaDateString(now) === date;
      const withNow = showLive && currentSpeed != null
        ? mergePoints([packed.points, [{ at: now.toISOString(), speed: currentSpeed }]])
        : packed.points;
      return summarize(target, withNow, {
        currentSpeed,
        showLive,
        truncated: packed.truncated,
      });
    } catch (err) {
      console.error('speed trace', plateKey(target.plate), err.message);
      const message = err.status === 403 || err.status === 401 || err.status === 422
        ? err.message
        : 'Cartrack did not return speed for this vehicle.';
      const row = blankVehicle(target, message);
      if (witaDateString(now) === date && currentSpeed != null) {
        row.currentSpeed = currentSpeed;
        row.maxSpeed = currentSpeed;
        row.overLimit = currentSpeed > SPEED_LIMIT_KMH;
      }
      return row;
    }
  });

  vehicles.sort((a, b) => rank(a) - rank(b) || a.plate.localeCompare(b.plate));
  const alertPlates = vehicles
    .filter((vehicle) => vehicle.currentSpeed != null && vehicle.currentSpeed > SPEED_LIMIT_KMH)
    .map((vehicle) => vehicle.plate);
  const note = vehicles.length && vehicles.every((vehicle) => vehicle.error)
    ? vehicles[0].error
    : '';
  const endAt = parseCartrackTimestamp(window.end) || now;
  return {
    ...base,
    to: formatWitaHm(endAt),
    refresh: window.refresh,
    alertPlates,
    vehicles,
    note,
  };
}

export async function speedForDay(dayId, env, now = new Date()) {
  const day = await DeliveryDay.findById(dayId).lean();
  if (!day) throw httpError(404, 'Delivery day not found.');
  const routes = await DeliveryRoute.find({ dayId }).sort({ number: 1, areaName: 1 }).lean();
  const stored = await Vehicle.find({ active: true }).lean();
  const byId = new Map(stored.map((item) => [String(item._id), item]));
  const byPlate = new Map();
  function remember(plate, area, cartrackVehicleId) {
    const key = plateKey(plate);
    if (!key) return;
    const existing = byPlate.get(key);
    if (existing) {
      if (area && !existing.areas.includes(area)) existing.areas.push(area);
      if (!existing.cartrackVehicleId && cartrackVehicleId) {
        existing.cartrackVehicleId = String(cartrackVehicleId);
      }
      return;
    }
    byPlate.set(key, {
      plate: key,
      areas: area ? [area] : [],
      cartrackVehicleId: cartrackVehicleId ? String(cartrackVehicleId) : '',
    });
  }
  for (const route of routes) {
    const vehicle = byId.get(String(route.vehicleId));
    remember(
      plateKey(vehicle?.plate) || plateFromLabel(route.vehicleLabel),
      String(route.areaName || '').trim(),
      vehicle?.cartrackVehicleId,
    );
  }
  for (const vehicle of stored) remember(vehicle.plate, '', vehicle.cartrackVehicleId);
  const targets = [...byPlate.values()].map((target) => ({
    plate: target.plate,
    areaName: target.areas.join(' · '),
    cartrackVehicleId: target.cartrackVehicleId,
  }));
  return speedForFleet(env, { date: day.date, now, targets });
}

/** Every car Cartrack has for this date. targets only add area names from a delivery. */
export async function speedForFleet(env, { date, now = new Date(), targets = [] } = {}) {
  const day = date || witaDateString(now);
  const window = speedWindow(day, now);
  const client = window && !window.pending ? createCartrackClient(env) : null;
  return buildSpeedReport({ date: day, targets, client, now });
}
