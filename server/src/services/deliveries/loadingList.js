/** Aggregate planned quantities for a route or day. */

export function buildLoadingList(stops) {
  const byProduct = new Map();
  for (const stop of stops || []) {
    for (const item of stop.plannedItems || []) {
      const key = `${item.productName}||${item.packType || ''}`;
      const prev = byProduct.get(key) || {
        productName: item.productName,
        packType: item.packType || '',
        qty: 0,
        packQty: 0,
        lines: 0,
        qtyMissing: 0,
      };
      if (item.qty != null) prev.qty += Number(item.qty);
      else prev.qtyMissing += 1;
      if (item.packQty != null) prev.packQty += Number(item.packQty);
      prev.lines += 1;
      byProduct.set(key, prev);
    }
  }
  return [...byProduct.values()].sort((a, b) => a.productName.localeCompare(b.productName));
}

export function loadingTotalsObject(stops) {
  const list = buildLoadingList(stops);
  const out = {};
  for (const row of list) {
    out[row.productName] = {
      qty: row.qty,
      packQty: row.packQty,
      packType: row.packType,
      qtyMissing: row.qtyMissing,
    };
  }
  return out;
}
