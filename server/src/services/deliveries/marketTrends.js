import mongoose from 'mongoose';
import MarketDay from '../../models/MarketDay.js';
import { csvToRows, fetchPublicSheetCsv, fetchPublicSheetTabs } from './googleSheet.js';
import { parseRouteSheetRows } from './sheetParse.js';

/** The public driver list. Each tab is one area for one day. */
export const MARKET_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1llG2YXO0zXdKj5-T0bEr88gTtNg7-lRAagQ_b8sSQls/edit?usp=sharing';

const CACHE_MS = 10 * 60 * 1000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

let cache = null;

/** Home, hotel, restaurant, or depo. Villa and resort sit with hotel. */
export function demandChannel(customerName, areaName = '') {
  const area = String(areaName || '');
  if (/\bdepos?\b|\bdepots?\b/i.test(area)) return 'depo';
  const text = `${customerName || ''} ${area}`;
  if (/\bdepos?\b|\bdepots?\b/i.test(text)) return 'depo';
  if (/\b(hotel|villa|resort|homestay|guesthouse|guest\s*house|hostel|penginapan)\b/i.test(text)) return 'hotel';
  if (/\b(resto|restaurant|rumah\s*makan|cafe|café|warung|bistro|kedai|bar)\b/i.test(text)) return 'restaurant';
  return 'home';
}

export function markedNewCustomer(name) {
  return /\b(baru|new)\b/i.test(String(name || ''));
}

/** Sheet title rows are not customers. */
function isMetaStop(name) {
  return /^(armada|driver|customer)\b/i.test(String(name || '').trim());
}

function materialKind(item) {
  const name = String(item?.productName || '');
  if (/ice|es\s*(tube|batu|cube)/i.test(name)) return 'ice';
  return item?.kind || 'other';
}

function wholeQty(item) {
  const raw = item?.qty != null ? item.qty : item?.packQty;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

function addQty(map, key, qty) {
  map.set(key, (map.get(key) || 0) + qty);
}

function monthKey(iso) {
  return String(iso || '').slice(0, 7);
}

function monthLabel(key) {
  const [year, month] = String(key || '').split('-');
  const name = MONTHS[Number(month) - 1];
  if (!name || !year) return key;
  return `${name} ${year}`;
}

/**
 * Turn parsed LIST DRIVER tabs into the demand the production team needs.
 * Gallons to prepare ignore pickups, exchanges, and samples.
 */
export function summarizeMarket(parsedTabs, { sheetUrl = MARKET_SHEET_URL, readAt = new Date().toISOString() } = {}) {
  const days = new Map();

  for (const parsed of parsedTabs || []) {
    const date = parsed?.date;
    if (!date) continue;
    const areaName = parsed.area?.name || parsed.sheetName || 'Unassigned';
    let day = days.get(date);
    if (!day) {
      day = {
        date,
        gallons: 0,
        stops: 0,
        qtyMissing: 0,
        areas: new Map(),
        channels: {
          home: { stops: 0, gallons: 0 },
          hotel: { stops: 0, gallons: 0 },
          restaurant: { stops: 0, gallons: 0 },
          depo: { stops: 0, gallons: 0 },
        },
        products: new Map(),
        kinds: new Map(),
        newCustomers: [],
      };
      days.set(date, day);
    }

    for (const stop of parsed.stops || []) {
      if (isMetaStop(stop.customerName)) continue;
      const channel = demandChannel(stop.customerName, areaName);
      day.stops += 1;
      day.channels[channel].stops += 1;

      let area = day.areas.get(areaName);
      if (!area) {
        area = {
          name: areaName,
          gallons: 0,
          stops: 0,
          qtyMissing: 0,
          depo: /\bdepos?\b/i.test(areaName),
        };
        day.areas.set(areaName, area);
      }
      area.stops += 1;

      let stopGallons = 0;
      for (const item of stop.plannedItems || []) {
        const kind = materialKind(item);
        const skip = kind === 'pickup' || kind === 'sample'
          || stop.type === 'pickup' || stop.type === 'exchange' || stop.type === 'sample';
        if (skip) continue;
        const qty = wholeQty(item);
        if (!qty) {
          if (kind === 'gallon' || kind === 'glass') {
            day.qtyMissing += 1;
            area.qtyMissing += 1;
          }
          continue;
        }
        addQty(day.products, item.productName || 'Unknown', qty);
        addQty(day.kinds, kind, qty);
        if (kind === 'gallon' || kind === 'glass') stopGallons += qty;
      }
      day.gallons += stopGallons;
      day.channels[channel].gallons += stopGallons;
      area.gallons += stopGallons;

      if (markedNewCustomer(stop.customerName) && day.newCustomers.length < 40) {
        day.newCustomers.push({
          name: stop.customerName,
          channel,
          area: areaName,
          gallons: stopGallons,
        });
      }
    }
  }

  const snapshots = [...days.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(snapshotDay);
  const view = presentMarket(snapshots, { sheetUrl, readAt });
  view.snapshots = snapshots;
  return view;
}

function snapshotDay(day) {
  return {
    date: day.date,
    gallons: day.gallons,
    stops: day.stops,
    qtyMissing: day.qtyMissing,
    channels: day.channels,
    products: [...day.products.entries()]
      .map(([name, qty]) => ({ name, qty }))
      .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name))
      .slice(0, 30),
    prepare: ['gallon', 'glass', 'bottle', 'can', 'ice']
      .map((kind) => ({ kind, qty: day.kinds.get(kind) || 0 }))
      .filter((row) => row.qty > 0),
    newCustomers: day.newCustomers.length,
  };
}

function emptyChannels() {
  return {
    home: { stops: 0, gallons: 0 },
    hotel: { stops: 0, gallons: 0 },
    restaurant: { stops: 0, gallons: 0 },
    depo: { stops: 0, gallons: 0 },
  };
}

/** Older saved days stay. A fresh read of the same date replaces that day. */
export function mergeDayRecords(stored, fresh) {
  const byDate = new Map();
  for (const day of stored || []) {
    if (day?.date) byDate.set(day.date, day);
  }
  for (const day of fresh || []) {
    if (day?.date) byDate.set(day.date, day);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Overall demand by month. Areas are not the cut. */
export function buildMonths(days) {
  const groups = new Map();
  for (const day of days || []) {
    if (!day?.date) continue;
    const key = monthKey(day.date);
    let month = groups.get(key);
    if (!month) {
      month = {
        month: key,
        label: monthLabel(key),
        gallons: 0,
        stops: 0,
        qtyMissing: 0,
        newCustomers: 0,
        dayCount: 0,
        channels: emptyChannels(),
        products: new Map(),
        kinds: new Map(),
        byDay: [],
      };
      groups.set(key, month);
    }
    month.gallons += day.gallons || 0;
    month.stops += day.stops || 0;
    month.qtyMissing += day.qtyMissing || 0;
    month.newCustomers += Number(day.newCustomers) || 0;
    month.dayCount += 1;
    month.byDay.push({ date: day.date, gallons: day.gallons || 0, stops: day.stops || 0 });
    for (const channel of Object.keys(month.channels)) {
      month.channels[channel].stops += day.channels?.[channel]?.stops || 0;
      month.channels[channel].gallons += day.channels?.[channel]?.gallons || 0;
    }
    for (const row of day.prepare || []) {
      month.kinds.set(row.kind, (month.kinds.get(row.kind) || 0) + (row.qty || 0));
    }
    for (const row of day.products || []) {
      if (!row?.name) continue;
      month.products.set(row.name, (month.products.get(row.name) || 0) + (row.qty || 0));
    }
  }

  return [...groups.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((month) => ({
      month: month.month,
      label: month.label,
      gallons: month.gallons,
      stops: month.stops,
      qtyMissing: month.qtyMissing,
      newCustomers: month.newCustomers,
      dayCount: month.dayCount,
      dailyAverage: month.dayCount ? Math.round(month.gallons / month.dayCount) : 0,
      channels: month.channels,
      byDay: month.byDay.sort((a, b) => a.date.localeCompare(b.date)),
      products: [...month.products.entries()]
        .map(([name, qty]) => ({ name, qty }))
        .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name))
        .slice(0, 30),
      prepare: ['gallon', 'glass', 'bottle', 'can', 'ice']
        .map((kind) => ({ kind, qty: month.kinds.get(kind) || 0 }))
        .filter((row) => row.qty > 0),
    }));
}

export function presentMarket(days, { sheetUrl = MARKET_SHEET_URL, readAt = new Date().toISOString() } = {}) {
  const ordered = [...(days || [])].filter((day) => day?.date).sort((a, b) => a.date.localeCompare(b.date));
  const months = buildMonths(ordered);
  const ranked = [...months].sort((a, b) => b.gallons - a.gallons || a.month.localeCompare(b.month));
  const ready = months.length >= 2;
  return {
    sourceName: 'LIST DRIVER 2026',
    sheetUrl,
    readAt,
    months,
    latestMonth: months[months.length - 1] || null,
    days: ordered.map((day) => ({ date: day.date, gallons: day.gallons || 0, stops: day.stops || 0 })),
    season: {
      ready,
      high: ready ? { month: ranked[0].month, label: ranked[0].label, gallons: ranked[0].gallons } : null,
      low: ready ? { month: ranked[ranked.length - 1].month, label: ranked[ranked.length - 1].label, gallons: ranked[ranked.length - 1].gallons } : null,
      note: ready
        ? 'High season is the month with the most galon. Low season is the month with the least.'
        : 'High and low season show once at least two months are saved. The driver sheet only keeps the current lists, so each day opened here is kept.',
    },
  };
}

async function readTabs(sheetUrl) {
  const { id, tabs } = await fetchPublicSheetTabs(sheetUrl);
  const chosen = (tabs || []).filter((tab) => !/^copy of\b/i.test(String(tab.name || '').trim()));
  const queue = chosen.slice();
  const parsed = [];
  const skipped = [];

  async function worker() {
    while (queue.length) {
      const tab = queue.shift();
      try {
        const csv = await fetchPublicSheetCsv(id, tab.gid);
        const rows = parseRouteSheetRows(csvToRows(csv), { sheetName: tab.name });
        if (rows.stops?.length) parsed.push(rows);
      } catch (error) {
        skipped.push(tab.name);
        console.error('Market tab skipped', tab.name, error.message);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, chosen.length) }, () => worker()));
  return { parsed, skipped };
}

function plainDay(day) {
  return {
    date: day.date,
    gallons: day.gallons || 0,
    stops: day.stops || 0,
    qtyMissing: day.qtyMissing || 0,
    newCustomers: Number(day.newCustomers) || 0,
    channels: day.channels || emptyChannels(),
    products: day.products || [],
    prepare: day.prepare || [],
  };
}

async function rememberDays(days) {
  if (mongoose.connection.readyState !== 1 || !days?.length) return;
  await MarketDay.bulkWrite(days.map((day) => ({
    updateOne: {
      filter: { date: day.date },
      update: { $set: plainDay(day) },
      upsert: true,
    },
  })));
}

async function storedDays() {
  if (mongoose.connection.readyState !== 1) return [];
  const rows = await MarketDay.find().sort({ date: 1 }).lean();
  return rows.map(plainDay);
}

export async function loadMarketTrends({ refresh = false, sheetUrl = MARKET_SHEET_URL } = {}) {
  if (!refresh && cache && cache.sheetUrl === sheetUrl && Date.now() - cache.at < CACHE_MS) {
    return cache.payload;
  }
  const { parsed, skipped } = await readTabs(sheetUrl);
  const fresh = summarizeMarket(parsed, { sheetUrl });
  await rememberDays(fresh.snapshots);
  const payload = presentMarket(mergeDayRecords(await storedDays(), fresh.snapshots), { sheetUrl });
  payload.skippedTabs = skipped;
  cache = { at: Date.now(), sheetUrl, payload };
  return payload;
}
