import { nameKey } from './names.js';

/** Classify a product name from the sheet into a kind and stop type. */

export function classifyProduct(productName, packType = '') {
  const key = nameKey(productName);
  const pack = nameKey(packType);
  const joined = `${key} ${pack}`.trim();

  if (/ambil\s*kosong|ambil\s*krat|ambil\s*galon\s*isi|ambil\s*isi/.test(joined)) {
    return { kind: 'pickup', stopType: 'pickup', unitsPerPack: 1 };
  }
  if (/tukar/.test(joined)) {
    return { kind: 'other', stopType: 'exchange', unitsPerPack: 1 };
  }
  if (/sample|hadiah/.test(joined)) {
    return { kind: 'other', stopType: 'sample', unitsPerPack: 1 };
  }
  if (/ice\s*tube|es\s*tube/.test(joined)) {
    return { kind: 'ice', stopType: 'deliver', unitsPerPack: 1 };
  }
  if (/galon\s*kaca|kaca\s*11/.test(joined)) {
    return { kind: 'glass', stopType: 'deliver', unitsPerPack: 1 };
  }
  if (/gallon|galon/.test(joined)) {
    return { kind: 'gallon', stopType: 'deliver', unitsPerPack: 1 };
  }
  if (/kaleng|can/.test(joined)) {
    return { kind: 'can', stopType: 'deliver', unitsPerPack: 24 };
  }
  if (/still|sparkling|botol|flask/.test(joined)) {
    const perPack = /krat\s*kayu|krat\s*plastik/.test(pack) ? 12 : /box|kardus/.test(pack) ? 12 : 1;
    return { kind: 'bottle', stopType: 'deliver', unitsPerPack: perPack };
  }
  return { kind: 'other', stopType: 'deliver', unitsPerPack: 1 };
}
