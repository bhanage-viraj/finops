import { parseRupiah, repairSheetUnitPrice } from './money.js';
import { nameKey } from './names.js';

/**
 * Compare planned stop items with AI/confirmed nota values.
 * Returns mismatch flag strings. Never auto-approves.
 */
export function compareNota(stop, nota) {
  const flags = [];
  const planned = stop.plannedItems || [];
  const actual = nota?.items || [];

  if (!actual.length && planned.length) {
    flags.push('no_items_read');
  }

  // Match by product name key
  const plannedMap = new Map();
  for (const item of planned) {
    const key = nameKey(item.productName);
    plannedMap.set(key, item);
  }
  const used = new Set();

  for (const act of actual) {
    const key = nameKey(act.productName || act.namaBarang || '');
    const plan = plannedMap.get(key)
      || [...plannedMap.entries()].find(([k]) => k.includes(key) || key.includes(k))?.[1];
    if (!plan) {
      flags.push('product_extra');
      continue;
    }
    used.add(nameKey(plan.productName));
    if (plan.qty != null && act.qty != null && Number(plan.qty) !== Number(act.qty)) {
      if (Number(act.qty) > Number(plan.qty)) flags.push('qty_more');
      else flags.push('qty_less');
    }
    const planPrice = repairSheetUnitPrice(plan.unitPrice);
    if (planPrice != null && act.unitPrice != null && Number(planPrice) !== Number(act.unitPrice)) {
      flags.push('price_diff');
    }
  }

  for (const item of planned) {
    if (item.qty == null) continue;
    if (!used.has(nameKey(item.productName)) && !/ambil|kosong|pickup/i.test(item.productName)) {
      // Only flag missing if nota had some items
      if (actual.length) flags.push('product_missing');
    }
  }

  const returns = nota?.returns || [];
  const empties = returns.reduce((sum, r) => sum + (Number(r.qty) || 0), 0)
    + (nota?.emptiesReturned != null ? Number(nota.emptiesReturned) : 0);
  if (empties > 0) flags.push('has_returns');

  if (nota?.total != null) {
    const sumLines = actual.reduce((s, i) => {
      if (i.total != null) return s + Number(i.total);
      if (i.qty != null && i.unitPrice != null) return s + Number(i.qty) * Number(i.unitPrice);
      return s;
    }, 0);
    if (sumLines > 0 && Math.abs(sumLines - Number(nota.total)) > 1) {
      flags.push('total_mismatch');
    }
  }

  return [...new Set(flags)];
}

export function assertNotaExtraction(json) {
  if (!json || typeof json !== 'object') throw new Error('Nota JSON missing.');
  const items = Array.isArray(json.items) ? json.items.map(normalizeItem) : [];
  const returns = Array.isArray(json.returns) ? json.returns.map(normalizeItem) : [];
  const total = moneyOrNull(json.total);
  return {
    notaNo: json.notaNo == null ? null : String(json.notaNo).trim(),
    customerName: json.customerName == null ? null : String(json.customerName).trim(),
    date: json.date == null ? null : String(json.date).trim(),
    items,
    returns,
    emptiesReturned: json.emptiesReturned == null ? null : Number(json.emptiesReturned),
    total,
    discount: moneyOrNull(json.discount),
    paymentNote: json.paymentNote == null ? null : String(json.paymentNote).trim(),
    remainingBalance: moneyOrNull(json.remainingBalance),
    confidence: json.confidence && typeof json.confidence === 'object' ? json.confidence : {},
  };
}

function moneyOrNull(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  const parsed = parseRupiah(value);
  return parsed.missing ? null : parsed.amount;
}

function normalizeItem(item) {
  if (!item || typeof item !== 'object') {
    return { productName: '', qty: null, unitPrice: null, total: null };
  }
  return {
    productName: String(item.productName || item.namaBarang || '').trim(),
    qty: item.qty == null ? null : Number(item.qty),
    unitPrice: moneyOrNull(item.unitPrice ?? item.harga),
    total: moneyOrNull(item.total ?? item.jumlah),
  };
}

export const notaExtractionSchema = {
  type: 'object',
  properties: {
    notaNo: { type: 'string', nullable: true },
    customerName: { type: 'string', nullable: true },
    date: { type: 'string', nullable: true },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          productName: { type: 'string' },
          qty: { type: 'integer', nullable: true },
          unitPrice: { type: 'integer', nullable: true },
          total: { type: 'integer', nullable: true },
        },
        required: ['productName'],
      },
    },
    returns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          productName: { type: 'string' },
          qty: { type: 'integer', nullable: true },
        },
        required: ['productName'],
      },
    },
    emptiesReturned: { type: 'integer', nullable: true },
    total: { type: 'integer', nullable: true },
    discount: { type: 'integer', nullable: true },
    paymentNote: { type: 'string', nullable: true },
    remainingBalance: { type: 'integer', nullable: true },
    confidence: {
      type: 'object',
      properties: {
        notaNo: { type: 'number' },
        customerName: { type: 'number' },
        total: { type: 'number' },
        items: { type: 'number' },
      },
    },
  },
  required: ['items'],
};
