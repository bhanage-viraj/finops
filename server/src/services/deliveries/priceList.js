import { repairSheetUnitPrice } from './money.js';

/**
 * Standard bottle prices from the delivery price sheet (integer rupiah).
 * HARGA B2B NORMAL is the default. Amed uses its own column when that area
 * has a price. Named-customer columns are not copied here: a wrong name match
 * would show the wrong amount, and those prices already live on the order line.
 */

const B2B_NORMAL = {
  'glass:11': 50000,
  'still:330': 12000,
  'still:750': 16000,
  'sparkling:330': 13000,
  'sparkling:750': 18000,
  'flask:330': 10000,
  'can-still:250': 9000,
  'can-still:330': 11000,
  'can-still:500': 14000,
  'can-sparkling:250': 10000,
  'can-sparkling:330': 12000,
  'can-sparkling:500': 15000,
  'ice-tube:5': 8000,
  'ice-cube:5': 8000,
};

const B2B_AMED = {
  'still:330': 12000,
  'still:750': 16000,
  'sparkling:330': 13000,
  'sparkling:750': 18000,
};

function productKey(productName, packType) {
  const text = `${productName || ''} ${packType || ''}`.toLowerCase();
  if (/galon\s*kaca|glass\s*gallon|kaca\s*11/.test(text)) return { key: 'glass', size: 11 };
  if (/ice\s*tube|es\s*tube/.test(text)) return { key: 'ice-tube', size: kgSize(text) };
  if (/ice\s*cube|es\s*batu/.test(text)) return { key: 'ice-cube', size: kgSize(text) };

  const size = mlSize(text);
  if (/flask/.test(text)) return { key: 'flask', size };
  const can = /can|kaleng/.test(text);
  const sparkling = /spark/.test(text);
  if (can && sparkling) return { key: 'can-sparkling', size };
  if (can) return { key: 'can-still', size };
  if (sparkling) return { key: 'sparkling', size };
  if (/still/.test(text)) return { key: 'still', size };
  return { key: null, size: null };
}

function mlSize(text) {
  const match = text.match(/\b(250|330|500|750)\b/);
  return match ? Number(match[1]) : null;
}

function kgSize(text) {
  const match = text.match(/\b(\d+)\s*kg\b/);
  return match ? Number(match[1]) : 5;
}

/** Integer rupiah, or null when this product is not on the standard list. */
export function lookupUnitPrice(productName, { areaName = '', packType = '' } = {}) {
  const { key, size } = productKey(productName, packType);
  if (!key || size == null) return null;
  const id = `${key}:${size}`;
  if (/amed/i.test(String(areaName || '')) && Number.isInteger(B2B_AMED[id])) {
    return B2B_AMED[id];
  }
  return Number.isInteger(B2B_NORMAL[id]) ? B2B_NORMAL[id] : null;
}

/** Keep a harga already on the line. Fill only a blank price from the list. */
export function applyListPrices(items, areaName) {
  return (items || []).map((item) => {
    const repaired = repairSheetUnitPrice(item.unitPrice);
    if (Number.isInteger(repaired)) {
      return repaired === item.unitPrice ? item : { ...item, unitPrice: repaired };
    }
    const price = lookupUnitPrice(item.productName, { areaName, packType: item.packType });
    if (!Number.isInteger(price)) return item;
    return { ...item, unitPrice: price };
  });
}
