import Area from '../../models/Area.js';
import Driver from '../../models/Driver.js';
import Product from '../../models/Product.js';
import Vehicle from '../../models/Vehicle.js';
import DeliveryCustomer from '../../models/DeliveryCustomer.js';
import { AREA_DEFS } from './areaCatalog.js';
import { nameKey, plateKey, formatPlate } from './names.js';
import { classifyProduct } from './productKind.js';

export async function ensureSeedAreas() {
  for (const def of AREA_DEFS) {
    const key = nameKey(def.name);
    await Area.updateOne(
      { nameKey: key },
      {
        $setOnInsert: {
          name: def.name,
          nameKey: key,
          number: def.number,
          aliases: def.aliases,
          keywords: def.keywords,
          centre: def.centre,
          isCustom: false,
          active: true,
        },
      },
      { upsert: true },
    );
  }
}

export async function ensureArea(name, { number = null, isCustom = false, aliases = [] } = {}) {
  const key = nameKey(name);
  if (!key) return null;
  let area = await Area.findOne({ nameKey: key });
  if (area) {
    if (number != null && area.number == null) {
      area.number = number;
      await area.save();
    }
    return area;
  }
  // Match by alias
  area = await Area.findOne({ aliases: name.toLowerCase() });
  if (area) return area;
  return Area.create({
    name: String(name).trim(),
    nameKey: key,
    number,
    aliases: aliases.map((a) => String(a).toLowerCase()),
    keywords: [],
    isCustom,
    active: true,
  });
}

export async function ensureVehicle({ plate, label = '', type = 'OTHER' } = {}) {
  const p = formatPlate(plate);
  if (!p) return null;
  const key = plateKey(p);
  let vehicle = await Vehicle.findOne({ plate: new RegExp(`^${p.replace(/\s+/g, '\\s*')}$`, 'i') });
  if (vehicle) return vehicle;
  // Also try compact plate
  const all = await Vehicle.find({ active: true }).lean();
  vehicle = all.find((v) => plateKey(v.plate) === key);
  if (vehicle) return Vehicle.findById(vehicle._id);
  let inferred = type;
  if (/ELF/i.test(label)) inferred = 'ELF';
  else if (/BOX/i.test(label)) inferred = 'BOX';
  else if (/MOTOR/i.test(label)) inferred = 'MOTOR';
  else if (/SEWA/i.test(label)) inferred = 'SEWA';
  return Vehicle.create({
    plate: p,
    label: label || p,
    type: inferred,
    active: true,
  });
}

export async function ensureDriver(name, phone = '') {
  const key = nameKey(name);
  if (!key) return null;
  let driver = await Driver.findOne({ nameKey: key });
  if (driver) return driver;
  return Driver.create({
    name: String(name).trim(),
    nameKey: key,
    phone,
    active: true,
  });
}

export async function ensureProduct(productName, packType = '') {
  const key = nameKey(productName);
  if (!key) return null;
  let product = await Product.findOne({ nameKey: key });
  if (product) return product;
  const classif = classifyProduct(productName, packType);
  return Product.create({
    name: String(productName).trim(),
    nameKey: key,
    size: '',
    packType: packType || '',
    unitsPerPack: classif.unitsPerPack,
    kind: classif.kind,
    active: true,
  });
}

export async function ensureDeliveryCustomer(name, { location = null, note = '' } = {}) {
  const key = nameKey(name);
  if (!key) return null;
  let customer = await DeliveryCustomer.findOne({ nameKey: key });
  if (customer) {
    let dirty = false;
    if (note && !customer.standingNotes) {
      customer.standingNotes = note;
      dirty = true;
    }
    if (location?.lat != null && location?.lng != null
      && (customer.location?.lat == null || !customer.location?.confirmedAt)
      && ['dms', 'plus_code', 'maps_link', 'decimal'].includes(location.source)
      && location.confidence === 'high') {
      customer.location = {
        ...customer.location?.toObject?.() || customer.location || {},
        lat: location.lat,
        lng: location.lng,
        source: location.source,
        mapsUrl: location.mapsUrl || customer.location?.mapsUrl || '',
        placeName: location.placeName || customer.location?.placeName || '',
        address: location.address || customer.location?.address || '',
      };
      dirty = true;
    }
    if (dirty) await customer.save();
    return customer;
  }
  return DeliveryCustomer.create({
    name: String(name).trim(),
    nameKey: key,
    aliases: [],
    location: location?.lat != null ? {
      lat: location.lat,
      lng: location.lng,
      source: location.source,
      mapsUrl: location.mapsUrl || '',
      placeName: location.placeName || '',
      address: location.address || '',
    } : {
      placeName: location?.placeName || '',
      address: location?.address || '',
      source: 'address',
    },
    standingNotes: note || '',
    firstSeenAt: new Date(),
  });
}

export async function recordAreaHistory(customerId, area) {
  if (!customerId || !area) return;
  const customer = await DeliveryCustomer.findById(customerId);
  if (!customer) return;
  const key = String(area._id);
  const existing = customer.areaHistory.find((h) => String(h.areaId) === key);
  if (existing) {
    existing.count += 1;
    existing.lastSeenAt = new Date();
    existing.areaName = area.name;
  } else {
    customer.areaHistory.push({
      areaId: area._id,
      areaName: area.name,
      count: 1,
      lastSeenAt: new Date(),
    });
  }
  // Prefer most frequent as default
  const top = [...customer.areaHistory].sort((a, b) => b.count - a.count)[0];
  if (top) customer.defaultAreaId = top.areaId;
  await customer.save();
}
