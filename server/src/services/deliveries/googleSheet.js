import { httpError } from '../../utils/http.js';
import { parseDeliveryDate } from './sheetParse.js';
import { areaFromTabTitle } from './areaCatalog.js';

const MAX_HTML = 2_000_000;
const MAX_XLSX = 8_000_000;
const MAX_CSV = 1_000_000;

export function spreadsheetIdFromUrl(input) {
  const text = String(input || '').trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw httpError(400, 'Paste a public Google Sheets link.');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com') {
    throw httpError(400, 'Paste a public Google Sheets link.');
  }
  const match = url.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match || match[1] === 'e') throw httpError(400, 'Paste a public Google Sheets link.');
  return match[1];
}

export function sheetTabsFromHtml(html) {
  const tabs = [];
  const re = /\{name:\s*"([^"]*)"[\s\S]*?gid:\s*"(-?\d+)"/g;
  let match;
  while ((match = re.exec(String(html || '')))) {
    const name = match[1].replace(/\\(.)/g, (_, ch) => (ch === '/' ? '/' : ch)).trim();
    if (name) tabs.push({ name, gid: match[2] });
  }
  return tabs;
}

/** Keep the tabs whose title is already that delivery date. Copies are not a second fleet. */
export function selectTabsForDate(tabs, date) {
  return (tabs || [])
    .filter((tab) => !/^copy of\b/i.test(String(tab.name || '').trim()))
    .filter((tab) => parseDeliveryDate(tab.name) === date)
    .sort((a, b) => {
      const an = areaFromTabTitle(a.name).number || 0;
      const bn = areaFromTabTitle(b.name).number || 0;
      if (an !== bn) return an - bn;
      return a.name.localeCompare(b.name);
    });
}

export function shiftIsoDate(iso, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!match) return null;
  const dt = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return dt.toISOString().slice(0, 10);
}

/**
 * Tabs named for this date, plus yesterday's tabs.
 * Yesterday is included because a list is sometimes renamed on the sheet
 * (22 OKTOBER) before the tab title (21 OCT) is renamed.
 */
export function tabsForDeliveryDate(tabs, date) {
  const named = selectTabsForDate(tabs, date).map((tab) => ({ ...tab, namedForDate: true }));
  const previous = shiftIsoDate(date, -1);
  const carried = previous
    ? selectTabsForDate(tabs, previous).map((tab) => ({ ...tab, namedForDate: false }))
    : [];
  return [...named, ...carried];
}

/**
 * A tab already named for the delivery date is that day's list, even when
 * the heading printed on it still says yesterday. Yesterday's tab is kept
 * only when that heading was already changed to the delivery date.
 */
export function tabBelongsToDeliveryDate(tab, parsed, dayDate) {
  if (tab?.namedForDate) return true;
  const listDate = parsed?.headerDate || parsed?.date || null;
  return !listDate || listDate === dayDate;
}

function cleanCsvCell(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^true$/i.test(text)) return true;
  if (/^false$/i.test(text)) return false;
  return text;
}

/** Google's public CSV export. Quoted notes can contain commas and line breaks. */
export function csvToRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ',') {
      row.push(cleanCsvCell(cell));
      cell = '';
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cleanCsvCell(cell));
      if (row.some((value) => value != null)) rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cleanCsvCell(cell));
    if (row.some((value) => value != null)) rows.push(row);
  }
  return rows;
}

async function readLimited(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > maxBytes) throw httpError(400, 'That sheet is too large.');
    return buf;
  }
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw httpError(400, 'That sheet is too large.');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function fetchGoogle(url, maxBytes) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FinOps)' },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) {
        lastError = httpError(400, 'That Google Sheet could not be opened. Share it so anyone with the link can view.');
        continue;
      }
      return await readLimited(response, maxBytes);
    } catch (err) {
      lastError = err;
    }
  }
  console.error('Google Sheet fetch failed', lastError?.message || lastError);
  throw httpError(400, 'The Google Sheet did not respond. Try again.');
}

export async function fetchPublicSheetTabs(sheetUrl) {
  const id = spreadsheetIdFromUrl(sheetUrl);
  const html = (await fetchGoogle(`https://docs.google.com/spreadsheets/d/${id}/htmlview`, MAX_HTML)).toString('utf8');
  const tabs = sheetTabsFromHtml(html);
  if (!tabs.length) {
    throw httpError(400, 'That Google Sheet is not public. Share it so anyone with the link can view.');
  }
  return { id, tabs };
}

export async function fetchPublicSheetTab(id, gid) {
  if (!/^-?\d+$/.test(String(gid))) throw httpError(400, 'That sheet tab could not be read.');
  return fetchGoogle(
    `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx&gid=${gid}`,
    MAX_XLSX,
  );
}

/** One tab as CSV. The full xlsx export of this yearly file is too slow to load a day. */
export async function fetchPublicSheetCsv(id, gid) {
  if (!/^-?\d+$/.test(String(gid))) throw httpError(400, 'That sheet tab could not be read.');
  const text = (await fetchGoogle(
    `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&gid=${encodeURIComponent(gid)}`,
    MAX_CSV,
  )).toString('utf8');
  if (/<!doctype html/i.test(text.slice(0, 300)) || text.includes('accounts.google.com')) {
    throw httpError(400, 'That Google Sheet is not public. Share it so anyone with the link can view.');
  }
  return text;
}
