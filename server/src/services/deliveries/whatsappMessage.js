import { mapsSearchUrl, needsLocationCheck, routeDirectionsLinks } from './mapsLink.js';

function itemLine(item) {
  const bits = [item.productName];
  if (item.qty != null) bits.push(`x${item.qty}`);
  else if (item.packQty != null) bits.push(`${item.packQty} pack`);
  if (item.packType) bits.push(`(${item.packType})`);
  return bits.join(' ');
}

/**
 * Build a WhatsApp-ready message for one route.
 */
export function buildRouteWhatsAppMessage(route, stops, { depot = null } = {}) {
  const dateLabel = route.dateLabel || route.date || '';
  const lines = [];
  lines.push(`*JAAN Delivery* ${dateLabel}`.trim());
  lines.push(`Area: *${route.areaName || 'Unassigned'}*`);
  if (route.vehicleLabel) lines.push(`Armada: ${route.vehicleLabel}`);
  if (route.driverNames?.length) lines.push(`Driver: ${route.driverNames.join(' & ')}`);
  lines.push('');

  const dirs = routeDirectionsLinks(stops, { origin: depot });
  if (dirs.length) {
    lines.push('*Route map*');
    for (const d of dirs) lines.push(`${d.label}: ${d.url}`);
    lines.push('');
  }

  lines.push(`*Stops (${stops.length})*`);
  stops.forEach((stop, i) => {
    const flag = needsLocationCheck(stop) ? ' ⚠️ CEK LOKASI' : '';
    const priority = stop.isNewCustomer || stop.isPriority ? ' 🆕 NEW' : '';
    lines.push(`${i + 1}. *${stop.customerName}*${priority}${flag}`);
    for (const item of stop.plannedItems || []) {
      lines.push(`   - ${itemLine(item)}`);
    }
    if (stop.note) {
      const note = String(stop.note).replace(/\s+/g, ' ').trim().slice(0, 120);
      lines.push(`   Note: ${note}`);
    }
    const url = mapsSearchUrl(stop);
    if (url) lines.push(`   Maps: ${url}`);
  });

  lines.push('');
  lines.push('Tolong update status setelah sampai. Terima kasih.');
  return lines.join('\n');
}

/** Open WhatsApp Web (browser), not the desktop/mobile app deep link. */
export function whatsappUrl(phone, text) {
  const digits = String(phone || '').replace(/\D/g, '');
  const q = encodeURIComponent(text || '');
  if (digits) return `https://web.whatsapp.com/send?phone=${digits}&text=${q}`;
  return `https://web.whatsapp.com/send?text=${q}`;
}
