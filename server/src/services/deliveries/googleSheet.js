import { httpError } from '../../utils/http.js';
import { parseDeliveryDate } from './sheetParse.js';
import { areaFromTabTitle } from './areaCatalog.js';

const MAX_HTML = 2_000_000;
const MAX_XLSX = 8_000_000;

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

/** Keep the tabs whose title is already that delivery date. Do not invent new groups. */
export function selectTabsForDate(tabs, date) {
  return (tabs || [])
    .filter((tab) => parseDeliveryDate(tab.name) === date)
    .sort((a, b) => {
      const an = areaFromTabTitle(a.name).number || 0;
      const bn = areaFromTabTitle(b.name).number || 0;
      if (an !== bn) return an - bn;
      return a.name.localeCompare(b.name);
    });
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
  let response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'FinOps' },
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw httpError(400, 'The Google Sheet did not respond. Try again.');
  }
  if (!response.ok) {
    throw httpError(400, 'That Google Sheet could not be opened. Share it so anyone with the link can view.');
  }
  return readLimited(response, maxBytes);
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
