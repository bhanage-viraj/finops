import { driverMapUrl, needsLocationCheck } from './mapsLink.js';
import { applyListPrices } from './priceList.js';

/** * _ ~ are WhatsApp formatting. A stray one swallows the map link so it cannot be tapped. */
function waText(value) {
  return String(value || '').replace(/[*_~]/g, '');
}

function itemLine(item) {
  const bits = [waText(item.productName)];
  if (item.qty != null) bits.push(`x${item.qty}`);
  else if (item.packQty != null) bits.push(`${item.packQty} pack`);
  if (item.packType) bits.push(`(${waText(item.packType)})`);
  if (Number.isInteger(item.unitPrice)) bits.push(`Rp ${item.unitPrice.toLocaleString('id-ID')}`);
  return bits.join(' ');
}

/**
 * Build a WhatsApp-ready message for one route.
 */
export function buildRouteWhatsAppMessage(route, stops) {
  const dateLabel = route.dateLabel || route.date || '';
  const lines = [];
  lines.push(`*JAAN Delivery* ${waText(dateLabel)}`.trim());
  lines.push(`Area: *${waText(route.areaName) || 'Unassigned'}*`);
  if (route.vehicleLabel) lines.push(`Armada: ${waText(route.vehicleLabel)}`);
  if (route.driverNames?.length) lines.push(`Driver: ${route.driverNames.map(waText).join(' & ')}`);
  lines.push('');

  lines.push(`*Stops (${stops.length})*`);
  stops.forEach((stop, i) => {
    const flag = needsLocationCheck(stop) ? ' ⚠️ CEK LOKASI' : '';
    const priority = stop.isNewCustomer || stop.isPriority ? ' NEW' : '';
    lines.push(`${i + 1}. *${waText(stop.customerName)}*${priority}${flag}`);
    for (const item of applyListPrices(stop.plannedItems, route?.areaName)) {
      lines.push(`   - ${itemLine(item)}`);
    }
    if (stop.note) {
      const note = waText(stop.note).replace(/\s+/g, ' ').trim().slice(0, 120);
      lines.push(`   Note: ${note}`);
    }
    const url = driverMapUrl(stop);
    if (url) lines.push(url);
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
