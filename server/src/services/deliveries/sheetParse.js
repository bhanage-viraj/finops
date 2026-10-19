import { parseQty, parseRupiah } from './money.js';
import { extractTimeTags } from './timeTags.js';
import { classifyProduct } from './productKind.js';
import { lookupUnitPrice } from './priceList.js';
import { resolveLocation } from './locationResolver.js';
import { areaFromTabTitle } from './areaCatalog.js';
import { nameKey, formatPlate } from './names.js';

const MONTHS = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MEI: 4, MAY: 4, JUN: 5, JUNI: 5,
  JUL: 6, JULI: 6, AGU: 7, AGUSTUS: 7, AUG: 7, SEP: 8, SEPT: 8,
  OKT: 9, OCT: 9, NOV: 10, DES: 11, DEC: 11,
};

/** Parse "16 OKT 26" / "LIST 16 OKT 26" / "LIST PENJUALAN HARIAN - 16 OKTOBER 2026" → YYYY-MM-DD. */
export function parseDeliveryDate(text, fallbackYear = new Date().getFullYear()) {
  const raw = String(text || '');
  const long = raw.match(/(\d{1,2})\s+(JANUARI|FEBRUARI|MARET|APRIL|MEI|JUNI|JULI|AGUSTUS|SEPTEMBER|OKTOBER|NOVEMBER|DESEMBER|JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+(\d{4})/i);
  if (long) {
    const monthMap = {
      januari: 0, january: 0, februari: 1, february: 1, maret: 2, march: 2,
      april: 3, mei: 4, may: 4, juni: 5, june: 5, juli: 6, july: 6,
      agustus: 7, august: 7, september: 8, oktober: 9, october: 9,
      november: 10, desember: 11, december: 11,
    };
    const m = monthMap[long[2].toLowerCase()];
    const d = Number(long[1]);
    const y = Number(long[3]);
    if (m != null) return isoDate(y, m, d);
  }
  const short = raw.match(/(\d{1,2})\s*([A-Z]{3,8})\s*['.]?\s*(\d{2,4})?/i);
  if (short) {
    const mon = MONTHS[short[2].toUpperCase().slice(0, 3)] ?? MONTHS[short[2].toUpperCase()];
    if (mon == null) return null;
    const d = Number(short[1]);
    let y = short[3] ? Number(short[3]) : fallbackYear;
    if (y < 100) y += 2000;
    return isoDate(y, mon, d);
  }
  return null;
}

function isoDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function cell(row, i) {
  if (!row || i >= row.length) return null;
  const v = row[i];
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  return v;
}

function isHeaderRow(row) {
  const a = String(cell(row, 0) || '').toUpperCase();
  const b = String(cell(row, 1) || '').toUpperCase();
  return a === 'NO' && b.includes('CUSTOMER');
}

function isEmptyRow(row) {
  if (!row) return true;
  return row.every((c) => c == null || String(c).trim() === '');
}

function isSummaryRow(row) {
  const b = String(cell(row, 1) || '');
  return /^(GALON\s*:|yang bertanggung|Produksi)/i.test(b) || /GALON\s*:/i.test(b);
}

/**
 * Parse a flat order-list sheet (List editing Driver style).
 * Columns: No, Customer, Qty Pack, Pesanan, Note, Place, Alamat, Qty, Harga
 * Blank No = continuation of previous customer (extra product line).
 */
export function parseOrderListRows(rows, { sheetName = '', bookByName = new Map() } = {}) {
  const date = parseDeliveryDate(sheetName) || parseDeliveryDate(String(cell(rows[0], 0) || ''));
  const stops = [];
  let current = null;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (isEmptyRow(row) || isHeaderRow(row) || isSummaryRow(row)) continue;

    const no = cell(row, 0);
    const customer = cell(row, 1);
    const qtyPack = cell(row, 2);
    const product = cell(row, 3);
    const note = cell(row, 4);
    const place = cell(row, 5);
    const address = cell(row, 6);
    const qty = cell(row, 7);
    const harga = cell(row, 8);

    // Glass/bottle sections sometimes shift: No, Customer, Qty Pack, Product, PackType, Note, Address
    let productName = product;
    let packType = '';
    let noteText = note == null ? '' : String(note);
    let placeName = place == null ? '' : String(place);
    let addressText = address == null ? '' : String(address);

    // Detect shifted bottle layout: col3 is size-like and col4 is pack type
    if (productName && /ml|krat|box|kardus|pack|galon kaca/i.test(String(cell(row, 4) || ''))
      && !address && cell(row, 5)) {
      // Alternate: No, Customer, QtyPack, Product, Pack, Note/Place, Address, Qty, Harga — already mapped
    }

    if (!customer && !productName) continue;
    // Blank No + same customer name (or blank customer) = extra product line.
    const sameCustomer = current
      && customer
      && nameKey(String(customer)) === nameKey(current.customerName)
      && (no == null || no === '');
    const blankContinuation = current && !customer && productName;
    if (current && productName && (sameCustomer || blankContinuation)) {
      const item = buildItem({ productName, packType, qtyPack, qty, harga });
      current.plannedItems.push(item);
      if (noteText) current.note = [current.note, noteText].filter(Boolean).join('\n');
      continue;
    }
    if (!customer) continue;

    const book = bookByName.get(nameKey(String(customer)));
    const location = resolveLocation({
      placeName,
      address: addressText,
      note: noteText,
      book: book?.location,
    });
    const item = buildItem({ productName: productName || 'Unknown', packType, qtyPack, qty, harga });
    const classif = classifyProduct(item.productName, item.packType);
    const timeTags = extractTimeTags(noteText);

    current = {
      sourceRow: no == null ? '' : String(no),
      sourceSheet: sheetName,
      customerName: String(customer).trim(),
      type: classif.stopType,
      plannedItems: [item],
      note: noteText,
      timeTags,
      location,
      isNewCustomer: !book,
      isPriority: !book,
    };
    stops.push(current);
  }

  return { date, sheetName, stops };
}

function buildItem({ productName, packType, qtyPack, qty, harga }) {
  const qPack = parseQty(qtyPack);
  const q = parseQty(qty);
  const price = parseRupiah(harga);
  const classif = classifyProduct(productName, packType);
  return {
    productName: String(productName || '').trim(),
    packType: String(packType || '').trim(),
    packQty: qPack.missing ? null : qPack.qty,
    qty: q.missing ? null : q.qty,
    unitPrice: price.missing ? lookupUnitPrice(productName, { packType }) : price.amount,
    qtyMissing: q.missing,
    kind: classif.kind,
  };
}

/**
 * Parse a route tab (LIST DRIVER style).
 * Rows 1-7: title / ARMADA / DRIVER / MAPS OTW DONE / headers
 * Then same columns as the order list.
 */
export function parseRouteSheetRows(rows, { sheetName = '' } = {}) {
  const areaInfo = areaFromTabTitle(sheetName);
  let date = parseDeliveryDate(sheetName);
  let vehicleLabel = '';
  let plate = '';
  let driverNames = [];
  let mapsFlag = false;
  let otwFlag = false;
  let doneFlag = false;
  let headerIndex = -1;

  for (let i = 0; i < Math.min(rows.length, 12); i += 1) {
    const row = rows[i];
    const joined = (row || []).map((c) => (c == null ? '' : String(c))).join(' ');
    if (!date) {
      const d = parseDeliveryDate(joined);
      if (d) date = d;
    }
    if (/ARMADA/i.test(joined)) {
      vehicleLabel = joined.replace(/ARMADA:\s*/i, '').trim();
      const plateMatch = vehicleLabel.match(/\b([A-Z]{1,2}\s*\d{1,4}\s*[A-Z]{1,3})\b/i);
      if (plateMatch) plate = formatPlate(plateMatch[1]);
      // Flags often sit on the same row: MAPS / DONE as booleans in later columns
      mapsFlag = mapsFlag || row.some((c) => c === true || String(c).toUpperCase() === 'MAPS');
      doneFlag = doneFlag || (cell(row, 8) === true);
    }
    if (/DRIVER/i.test(joined)) {
      // Prefer the DRIVER cell only so later columns (area, flags) are not swallowed.
      const driverCell = String(cell(row, 1) || '').replace(/DRIVER:\s*/i, '').trim();
      const raw = driverCell || joined.replace(/DRIVER:\s*/i, '').trim();
      driverNames = raw
        .split(/\s*[&+/]\s*|\s+DAN\s+/i)
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((s) => !/^(true|false|otw|maps|done)$/i.test(s));
      otwFlag = otwFlag || row.some((c, idx) => idx > 2 && (c === true || String(c).toUpperCase() === 'OTW'));
    }
    if (isHeaderRow(row)) {
      headerIndex = i;
      break;
    }
  }

  const body = headerIndex >= 0 ? rows.slice(headerIndex + 1) : rows;
  const { stops } = parseOrderListRows(body, { sheetName });

  return {
    date,
    sheetName,
    area: areaInfo,
    vehicleLabel,
    plate,
    driverNames,
    mapsFlag,
    otwFlag,
    doneFlag,
    stops,
  };
}

/** Collect all sheet rows as plain arrays of values (ExcelJS worksheet). */
export function worksheetToRows(worksheet) {
  const rows = [];
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    const values = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      while (values.length < colNumber - 1) values.push(null);
      let v = cell.value;
      if (v && typeof v === 'object') {
        if (v.result != null) v = v.result;
        else if (v.text != null) v = v.text;
        else if (v.richText) v = v.richText.map((t) => t.text).join('');
        else if (v.hyperlink && v.text) v = `${v.text} ${v.hyperlink}`;
        else if (v instanceof Date) v = v;
      }
      values.push(v);
    });
    rows.push(values);
  });
  return rows;
}
