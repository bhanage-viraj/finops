import ExcelJS from 'exceljs';
import DeliveryDay from '../../models/DeliveryDay.js';
import DeliveryRoute from '../../models/DeliveryRoute.js';
import DeliveryStop from '../../models/DeliveryStop.js';
import DeliveryCustomer from '../../models/DeliveryCustomer.js';
import Area from '../../models/Area.js';
import { writeAudit } from '../audit/auditLogger.js';
import { createFileStorage, extensionFor } from '../storage/fileStorage.js';
import { httpError } from '../../utils/http.js';
import { parseOrderListRows, parseRouteSheetRows, worksheetToRows, parseDeliveryDate } from './sheetParse.js';
import { groupStopsByArea } from './areaAssigner.js';
import { orderStops } from './stopOrder.js';
import { loadingTotalsObject } from './loadingList.js';
import { mapsSearchUrl } from './mapsLink.js';
import {
  ensureSeedAreas,
  ensureArea,
  ensureVehicle,
  ensureDriver,
  ensureProduct,
  ensureDeliveryCustomer,
  recordAreaHistory,
} from './ensureRefs.js';
import { nameKey } from './names.js';
import { AREA_DEFS, fleetNameFromTab } from './areaCatalog.js';
import { expandMapsLink } from './expandMapsLink.js';
import {
  csvToRows,
  fetchPublicSheetCsv,
  fetchPublicSheetTabs,
  tabsForDeliveryDate,
} from './googleSheet.js';

function isOrderListSheet(name) {
  return /^LIST\s/i.test(name) || /LIST\s+\d/i.test(name);
}

function isRouteSheet(name) {
  return /\d{1,2}\s*(OKT|OCT|SEP|AUG|AGU|NOV|DES|DEC|JAN|FEB|MAR|APR|MEI|MAY|JUN|JUL)/i.test(name)
    && !isOrderListSheet(name)
    && !/DELIVERY|LAPORAN|Detail Customer/i.test(name);
}

async function loadBookMap() {
  const customers = await DeliveryCustomer.find().lean();
  const map = new Map();
  for (const c of customers) map.set(c.nameKey, c);
  return map;
}

async function materializeStop(raw, { dayId, bookByName }) {
  const customer = await ensureDeliveryCustomer(raw.customerName, {
    location: raw.location,
    note: raw.note,
  });
  const plannedItems = [];
  for (const item of raw.plannedItems || []) {
    const product = await ensureProduct(item.productName, item.packType);
    plannedItems.push({
      productId: product?._id || null,
      productName: item.productName,
      packType: item.packType || '',
      packQty: item.packQty,
      qty: item.qty,
      unitPrice: item.unitPrice,
      qtyMissing: Boolean(item.qtyMissing),
    });
  }

  // Expand short maps links when we have no coords yet.
  let location = { ...raw.location };
  if (location.mapsUrl && location.lat == null) {
    const expanded = await expandMapsLink(location.mapsUrl);
    if (expanded) {
      location = {
        ...location,
        lat: expanded.lat,
        lng: expanded.lng,
        source: 'maps_link',
        confidence: 'high',
        mapsUrl: expanded.finalUrl || location.mapsUrl,
        needsPin: false,
      };
      if (customer && !customer.location?.confirmedAt) {
        customer.location = {
          ...customer.location?.toObject?.() || customer.location || {},
          lat: expanded.lat,
          lng: expanded.lng,
          source: 'maps_link',
          mapsUrl: location.mapsUrl,
        };
        await customer.save();
      }
    }
  }
  if (!location.mapsUrl) {
    location.mapsUrl = mapsSearchUrl({ location, customerName: raw.customerName });
  }

  const isNew = Boolean(raw.isNewCustomer);
  return {
    dayId,
    deliveryCustomerId: customer._id,
    customerName: customer.name,
    sourceRow: raw.sourceRow || '',
    sourceSheet: raw.sourceSheet || '',
    type: raw.type || 'deliver',
    plannedItems,
    note: raw.note || '',
    timeTags: raw.timeTags || [],
    isNewCustomer: isNew,
    isPriority: isNew || Boolean(raw.isPriority),
    location,
    status: 'planned',
    statusHistory: [{ status: 'planned', source: 'import', at: new Date() }],
  };
}

async function buildRoutesForDay(day, stopDocs, { depot = null } = {}) {
  const customers = await DeliveryCustomer.find({
    _id: { $in: stopDocs.map((s) => s.deliveryCustomerId) },
  });
  const customersById = new Map(customers.map((c) => [String(c._id), c]));
  const areas = await Area.find({ active: true }).lean();
  const areaDefs = areas.length
    ? areas.map((a) => ({
      name: a.name,
      keywords: a.keywords || [],
      centre: a.centre,
    }))
    : AREA_DEFS;

  const groups = groupStopsByArea(stopDocs.map((s) => s.toObject()), {
    customersById,
    areas: areaDefs,
  });

  const routes = [];
  let routeNumber = 1;
  for (const [areaName, groupStops] of groups) {
    const ordered = orderStops(groupStops, { depot });
    const area = areaName === 'Unassigned'
      ? null
      : await ensureArea(areaName, {
        number: AREA_DEFS.find((d) => d.name === areaName)?.number || routeNumber,
      });

    const route = await DeliveryRoute.create({
      dayId: day._id,
      areaId: area?._id || null,
      areaName,
      number: area?.number || routeNumber,
      vehicleId: area?.defaultVehicleId || null,
      driverIds: area?.defaultDriverIds || [],
      driverNames: [],
      stopOrder: [],
      loadingTotals: loadingTotalsObject(ordered),
    });

    const stopIds = [];
    for (let i = 0; i < ordered.length; i += 1) {
      const match = stopDocs.find((s) => String(s._id) === String(ordered[i]._id));
      if (!match) continue;
      match.routeId = route._id;
      match.sortIndex = i;
      await match.save();
      stopIds.push(match._id);
      if (area) await recordAreaHistory(match.deliveryCustomerId, area);
    }
    route.stopOrder = stopIds;
    await route.save();
    routes.push(route);
    routeNumber += 1;
  }
  return routes;
}

function summarize(stops) {
  return {
    stopCount: stops.length,
    exactLocations: stops.filter((s) => s.location?.lat != null && s.location?.confidence === 'high').length,
    needsLocation: stops.filter((s) => s.location?.needsPin).length,
    newCustomers: stops.filter((s) => s.isNewCustomer).length,
    unassigned: 0,
    delivered: 0,
    mismatches: 0,
  };
}

/**
 * Import a daily order workbook (.xlsx buffer).
 * Creates DeliveryDay + stops + routes. Refuses duplicate dates.
 */
export async function importOrderWorkbook({
  buffer,
  fileName,
  user,
  env,
  dateOverride = null,
  depot = null,
}) {
  await ensureSeedAreas();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const bookByName = await loadBookMap();
  let parsed = null;
  let chosenSheet = '';

  for (const sheet of workbook.worksheets) {
    if (/DELIVERY|LAPORAN|Sheet\d+/i.test(sheet.name) && !isOrderListSheet(sheet.name)) continue;
    const rows = worksheetToRows(sheet);
    if (isOrderListSheet(sheet.name) || sheet.name.toUpperCase().includes('LIST')) {
      const candidate = parseOrderListRows(rows, { sheetName: sheet.name, bookByName });
      if (candidate.stops.length > 0) {
        parsed = candidate;
        chosenSheet = sheet.name;
        break;
      }
    }
  }

  // Fallback: largest sheet by stop count
  if (!parsed) {
    let best = null;
    for (const sheet of workbook.worksheets) {
      const rows = worksheetToRows(sheet);
      const candidate = parseOrderListRows(rows, { sheetName: sheet.name, bookByName });
      if (!best || candidate.stops.length > best.stops.length) {
        best = candidate;
        chosenSheet = sheet.name;
      }
    }
    parsed = best;
  }

  if (!parsed || parsed.stops.length === 0) {
    throw httpError(400, 'No delivery stops were found in that workbook.');
  }

  const date = dateOverride || parsed.date || parseDeliveryDate(fileName);
  if (!date) {
    throw httpError(400, 'Could not read the delivery date from the sheet. Pass a date (YYYY-MM-DD).');
  }

  const existing = await DeliveryDay.findOne({ date });
  if (existing) {
    throw httpError(409, `A delivery day for ${date} already exists. Delete it first or pick another date.`);
  }

  const storage = createFileStorage(env.upload.dir);
  const key = await storage.save(buffer, extensionFor('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') === '.jpg'
    ? '.xlsx'
    : '.xlsx');

  const day = await DeliveryDay.create({
    date,
    label: chosenSheet || fileName || date,
    sourceFileKey: key,
    sourceFileName: fileName || '',
    status: 'draft',
    importedBy: user?._id || null,
    summary: { stopCount: 0 },
  });

  const stopDocs = [];
  for (const raw of parsed.stops) {
    const data = await materializeStop(raw, { dayId: day._id, bookByName });
    const doc = await DeliveryStop.create(data);
    stopDocs.push(doc);
  }

  const routes = await buildRoutesForDay(day, stopDocs, { depot });
  const unassigned = routes.find((r) => r.areaName === 'Unassigned');
  const summary = summarize(stopDocs);
  summary.unassigned = unassigned ? unassigned.stopOrder.length : 0;
  day.summary = summary;
  await day.save();

  await writeAudit({
    userId: user?._id,
    action: 'import',
    entity: 'deliveryDays',
    entityId: day._id,
    after: { date, stopCount: summary.stopCount, routes: routes.length, sheet: chosenSheet },
  });

  return {
    day: day.toObject(),
    routes: routes.map((r) => r.toObject()),
    summary,
  };
}

/**
 * Read one day's tabs from a public Google Sheet.
 * Each tab is already one fleet. Stops stay in the sheet's order.
 */
function displayDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!match) return String(iso || '');
  return `${match[3]}/${match[2]}/${match[1]}`;
}

export async function importPublicGoogleSheet({ url, date, user, env }) {
  const dayDate = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayDate)) throw httpError(400, 'Pick the delivery date.');
  const shownDate = displayDate(dayDate);

  const existing = await DeliveryDay.findOne({ date: dayDate });
  if (existing) {
    throw httpError(409, `${shownDate} already has a delivery day. Delete that day, then use the sheet again.`);
  }

  const { id, tabs } = await fetchPublicSheetTabs(url);
  const chosen = tabsForDeliveryDate(tabs, dayDate);
  if (!chosen.some((tab) => tab.namedForDate)) {
    throw httpError(400, `No lists for ${shownDate}. The tabs are named with that date, for example 22 OCT - 1.SEMINYAK.`);
  }

  const parsedTabs = [];
  const skipped = [];
  const queue = chosen.slice();
  async function worker() {
    while (queue.length) {
      const tab = queue.shift();
      let parsed;
      try {
        const csv = await fetchPublicSheetCsv(id, tab.gid);
        parsed = parseRouteSheetRows(csvToRows(csv), { sheetName: tab.name });
      } catch (err) {
        if (err?.status) throw err;
        throw httpError(400, `Could not read ${tab.name}. Try again.`);
      }
      // The date on the form is the delivery date. A heading that says another day stays out.
      const listDate = parsed.headerDate || parsed.date;
      if (listDate && listDate !== dayDate) {
        if (tab.namedForDate) skipped.push({ name: tab.name, date: listDate });
        continue;
      }
      if (parsed.stops.length) parsedTabs.push(parsed);
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, chosen.length) }, () => worker()));
  parsedTabs.sort((a, b) => (a.area?.number || 0) - (b.area?.number || 0) || a.sheetName.localeCompare(b.sheetName));
  if (!parsedTabs.length) {
    const other = skipped[0] ? displayDate(skipped[0].date) : '';
    throw httpError(400, other
      ? `No lists for ${shownDate}. Those tabs are dated ${other} on the sheet.`
      : `No deliveries for ${shownDate} on that sheet.`);
  }

  await ensureSeedAreas();
  const bookByName = await loadBookMap();
  const day = await DeliveryDay.create({
    date: dayDate,
    label: `Google Sheet ${dayDate}`,
    sourceFileKey: '',
    sourceFileName: id,
    status: 'draft',
    importedBy: user?._id || null,
    summary: { stopCount: 0 },
  });

  const stopDocs = [];
  const routes = [];
  for (const parsed of parsedTabs) {
    const areaName = fleetNameFromTab(parsed.area);
    const area = await ensureArea(areaName, {
      number: parsed.area?.number || null,
      isCustom: Boolean(parsed.area?.isCustom) || areaName !== parsed.area?.name,
    });
    let vehicle = null;
    if (parsed.plate || parsed.vehicleLabel) {
      vehicle = await ensureVehicle({
        plate: parsed.plate || parsed.vehicleLabel.slice(0, 20),
        label: parsed.vehicleLabel,
      });
    }
    const driverIds = [];
    for (const name of parsed.driverNames || []) {
      const driver = await ensureDriver(name);
      if (driver) driverIds.push(driver._id);
    }
    const route = await DeliveryRoute.create({
      dayId: day._id,
      areaId: area?._id || null,
      areaName,
      number: parsed.area?.number || null,
      vehicleId: vehicle?._id || null,
      vehicleLabel: parsed.vehicleLabel || '',
      driverIds,
      driverNames: parsed.driverNames || [],
      stopOrder: [],
      loadingTotals: {},
      mapsFlag: Boolean(parsed.mapsFlag),
      otwFlag: Boolean(parsed.otwFlag),
      doneFlag: Boolean(parsed.doneFlag),
    });
    const stopIds = [];
    for (let i = 0; i < parsed.stops.length; i += 1) {
      const data = await materializeStop(parsed.stops[i], { dayId: day._id, bookByName });
      data.routeId = route._id;
      data.sortIndex = i;
      const doc = await DeliveryStop.create(data);
      stopIds.push(doc._id);
      stopDocs.push(doc);
      if (area) await recordAreaHistory(doc.deliveryCustomerId, area);
    }
    route.stopOrder = stopIds;
    route.loadingTotals = loadingTotalsObject(stopDocs.filter((stop) => String(stop.routeId) === String(route._id)));
    await route.save();
    routes.push(route);
  }

  const summary = summarize(stopDocs);
  summary.unassigned = 0;
  day.summary = summary;
  await day.save();

  await writeAudit({
    userId: user?._id,
    action: 'import',
    entity: 'deliveryDays',
    entityId: day._id,
    after: {
      date: dayDate,
      stopCount: summary.stopCount,
      routes: routes.length,
      source: 'google-sheet',
      assignedTabs: true,
    },
  });

  return {
    day: day.toObject(),
    routes: routes.map((route) => route.toObject()),
    summary,
    skipped,
  };
}

/**
 * Import historical route workbook to learn areas, vehicles, drivers, customer history.
 * Does not create a DeliveryDay.
 */
export async function importHistoryWorkbook({ buffer, fileName, user }) {
  await ensureSeedAreas();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  let routeTabs = 0;
  let customersTouched = 0;
  const areasSeen = new Set();

  for (const sheet of workbook.worksheets) {
    if (!isRouteSheet(sheet.name) && !/OKT|OCT|AGUSTUS|AUG/i.test(sheet.name)) continue;
    if (/Detail Customer|DELIVERY|LAPORAN/i.test(sheet.name)) continue;

    const rows = worksheetToRows(sheet);
    const parsed = parseRouteSheetRows(rows, { sheetName: sheet.name });
    if (!parsed.stops.length) continue;
    routeTabs += 1;

    const area = await ensureArea(parsed.area.name, {
      number: parsed.area.number,
      isCustom: parsed.area.isCustom,
    });
    areasSeen.add(area.name);

    let vehicle = null;
    if (parsed.plate || parsed.vehicleLabel) {
      vehicle = await ensureVehicle({
        plate: parsed.plate || parsed.vehicleLabel.slice(0, 20),
        label: parsed.vehicleLabel,
      });
      if (vehicle && area && !area.defaultVehicleId) {
        area.defaultVehicleId = vehicle._id;
        await area.save();
      }
    }

    const driverIds = [];
    for (const name of parsed.driverNames) {
      const driver = await ensureDriver(name);
      if (driver) driverIds.push(driver._id);
    }
    if (driverIds.length && area) {
      const merged = new Set([...(area.defaultDriverIds || []).map(String), ...driverIds.map(String)]);
      area.defaultDriverIds = [...merged];
      await area.save();
    }

    for (const raw of parsed.stops) {
      const customer = await ensureDeliveryCustomer(raw.customerName, {
        location: raw.location,
        note: raw.note,
      });
      customersTouched += 1;
      if (area) await recordAreaHistory(customer._id, area);
      for (const item of raw.plannedItems || []) {
        await ensureProduct(item.productName, item.packType);
      }
    }
  }

  await writeAudit({
    userId: user?._id,
    action: 'import_history',
    entity: 'deliveryCustomers',
    after: {
      fileName,
      routeTabs,
      customersTouched,
      areas: [...areasSeen],
    },
  });

  return { routeTabs, customersTouched, areas: [...areasSeen] };
}

export async function deleteDeliveryDay(dayId, user, env) {
  const day = await DeliveryDay.findById(dayId);
  if (!day) throw httpError(404, 'Delivery day not found.');
  await DeliveryStop.deleteMany({ dayId: day._id });
  await DeliveryRoute.deleteMany({ dayId: day._id });
  if (day.sourceFileKey) {
    try {
      await createFileStorage(env.upload.dir).remove(day.sourceFileKey);
    } catch {
      // Ignore missing file.
    }
  }
  await day.deleteOne();
  await writeAudit({
    userId: user?._id,
    action: 'delete',
    entity: 'deliveryDays',
    entityId: dayId,
    before: { date: day.date },
  });
  return { ok: true };
}
