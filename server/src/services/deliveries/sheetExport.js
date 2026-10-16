import ExcelJS from 'exceljs';
import DeliveryDay from '../../models/DeliveryDay.js';
import DeliveryRoute from '../../models/DeliveryRoute.js';
import DeliveryStop from '../../models/DeliveryStop.js';
import { httpError } from '../../utils/http.js';
import { mapsSearchUrl } from './mapsLink.js';
import { buildLoadingList } from './loadingList.js';

function formatDateLabel(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MEI', 'JUN', 'JUL', 'AGU', 'SEP', 'OKT', 'NOV', 'DES'];
  return `${d} ${months[m - 1]} ${String(y).slice(2)}`;
}

/**
 * Export a delivery day as an .xlsx workbook shaped like LIST DRIVER tabs.
 */
export async function exportDayWorkbook(dayId) {
  const day = await DeliveryDay.findById(dayId).lean();
  if (!day) throw httpError(404, 'Delivery day not found.');
  const routes = await DeliveryRoute.find({ dayId }).sort({ number: 1, areaName: 1 }).lean();
  const stops = await DeliveryStop.find({ dayId }).lean();

  const wb = new ExcelJS.Workbook();
  wb.creator = 'FinOps Deliveries';
  const dateLabel = formatDateLabel(day.date);

  for (const route of routes) {
    const routeStops = stops
      .filter((s) => String(s.routeId) === String(route._id))
      .sort((a, b) => a.sortIndex - b.sortIndex);
    const safeName = `${dateLabel} - ${route.number || ''}.${route.areaName}`
      .replace(/[\\/*?[\]:]/g, ' ')
      .slice(0, 31);
    const ws = wb.addWorksheet(safeName || route.areaName.slice(0, 31));

    ws.getCell('A3').value = `LIST PENJUALAN HARIAN - ${day.date}`;
    ws.getCell('B5').value = `ARMADA: ${route.vehicleLabel || ''}`;
    ws.getCell('F5').value = 'MAPS';
    ws.getCell('G5').value = route.mapsFlag;
    ws.getCell('H5').value = 'DONE';
    ws.getCell('I5').value = route.doneFlag;
    ws.getCell('B6').value = `DRIVER: ${(route.driverNames || []).join(' & ')}`;
    ws.getCell('E6').value = route.areaName;
    ws.getCell('G6').value = route.otwFlag;

    const header = ['NO', 'CUSTOMER', 'QTY PACK', 'PESANAN', 'NOTE', 'AREA', 'ALAMAT', 'QTY', 'HARGA', 'STATUS', 'MAPS LINK', 'QTY TERKIRIM', 'KOSONG KEMBALI', 'NOTA NO'];
    ws.addRow([]);
    ws.addRow(header);
    const headerRow = ws.lastRow.number;

    for (const stop of routeStops) {
      const first = stop.plannedItems?.[0] || {};
      ws.addRow([
        stop.sourceRow || '',
        stop.customerName,
        first.packQty ?? '',
        first.productName || '',
        stop.note || '',
        stop.location?.placeName || '',
        stop.location?.address || '',
        first.qty ?? '',
        first.unitPrice ?? '',
        stop.status,
        mapsSearchUrl(stop),
        stop.delivered?.items?.[0]?.qty ?? '',
        stop.delivered?.emptiesReturned ?? '',
        stop.delivered?.notaNo || '',
      ]);
      for (let i = 1; i < (stop.plannedItems || []).length; i += 1) {
        const item = stop.plannedItems[i];
        ws.addRow([
          '',
          stop.customerName,
          item.packQty ?? '',
          item.productName || '',
          '',
          '',
          '',
          item.qty ?? '',
          item.unitPrice ?? '',
          '',
          '',
          '',
          '',
          '',
        ]);
      }
    }

    const loading = buildLoadingList(routeStops);
    ws.addRow([]);
    for (const row of loading) {
      ws.addRow(['', `${row.productName}: ${row.qty}${row.qtyMissing ? ' (+missing)' : ''}`]);
    }

    ws.getRow(headerRow).font = { bold: true };
    ws.columns.forEach((col) => { col.width = 16; });
    ws.getColumn(2).width = 28;
    ws.getColumn(7).width = 40;
    ws.getColumn(11).width = 36;
  }

  // Summary sheet
  const summary = wb.addWorksheet('SUMMARY');
  summary.addRow(['Date', day.date]);
  summary.addRow(['Status', day.status]);
  summary.addRow(['Stops', day.summary?.stopCount || stops.length]);
  summary.addRow(['Delivered', day.summary?.delivered || 0]);
  summary.addRow(['Needs location', day.summary?.needsLocation || 0]);
  summary.addRow(['New customers', day.summary?.newCustomers || 0]);
  summary.addRow(['Mismatches', day.summary?.mismatches || 0]);

  const buffer = await wb.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(buffer),
    fileName: `jaan-delivery-${day.date}.xlsx`,
  };
}
