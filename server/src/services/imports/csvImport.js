import Customer from '../../models/Customer.js';
import Invoice from '../../models/Invoice.js';
import { writeAudit } from '../audit/auditLogger.js';
import { httpError } from '../../utils/http.js';

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

export function parseCsv(text) {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    throw httpError(400, 'The CSV needs a header row and at least one data row.');
  }
  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line, index) => {
    const cells = splitCsvLine(line);
    const row = {};
    headers.forEach((header, i) => {
      row[header] = cells[i] ?? '';
    });
    row.__line = index + 2;
    return row;
  });
}

function requireFields(row, fields) {
  for (const field of fields) {
    if (!String(row[field] || '').trim()) {
      throw httpError(400, `Row ${row.__line}: missing ${field}.`);
    }
  }
}

function parseIntegerRupiah(row, field) {
  const raw = String(row[field] || '').trim().replace(/\./g, '').replace(/,/g, '');
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw httpError(400, `Row ${row.__line}: ${field} must be a non-negative integer rupiah amount.`);
  }
  return value;
}

function parseIsoDate(row, field) {
  const raw = String(row[field] || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw httpError(400, `Row ${row.__line}: ${field} must be YYYY-MM-DD.`);
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw httpError(400, `Row ${row.__line}: ${field} is not a valid date.`);
  return date;
}

function invoiceStatus(amount, paidAmount, hinted) {
  if (hinted === 'open' || hinted === 'partial' || hinted === 'paid') {
    if (hinted === 'paid' && paidAmount < amount) return 'partial';
    if (hinted === 'open' && paidAmount > 0 && paidAmount < amount) return 'partial';
    if (paidAmount >= amount && amount > 0) return 'paid';
    if (paidAmount > 0) return 'partial';
    return hinted === 'paid' ? 'paid' : hinted === 'partial' ? 'partial' : 'open';
  }
  if (paidAmount >= amount && amount > 0) return 'paid';
  if (paidAmount > 0) return 'partial';
  return 'open';
}

export async function importCustomersCsv(text, userId = null) {
  const rows = parseCsv(text);
  let created = 0;
  let updated = 0;
  for (const row of rows) {
    requireFields(row, ['name', 'erpCustomerId']);
    const aliases = String(row.aliases || '')
      .split('|')
      .map((a) => a.trim())
      .filter(Boolean);
    // Sample CSV uses a single alias without pipes; also accept comma-free single value.
    if (!aliases.length && row.aliases) aliases.push(String(row.aliases).trim());
    const payload = {
      name: String(row.name).trim(),
      aliases,
      erpCustomerId: String(row.erpCustomerId).trim(),
      paymentTermsDays: row.paymentTermsDays ? Number(row.paymentTermsDays) : 14,
      deliveryFeeRule: String(row.deliveryFeeRule || '').trim(),
      phone: String(row.phone || '').trim(),
    };
    if (!Number.isFinite(payload.paymentTermsDays) || payload.paymentTermsDays < 0) {
      throw httpError(400, `Row ${row.__line}: paymentTermsDays must be a non-negative number.`);
    }
    const existing = await Customer.findOne({ erpCustomerId: payload.erpCustomerId });
    if (existing) {
      Object.assign(existing, payload);
      await existing.save();
      updated += 1;
      await writeAudit({
        userId,
        action: 'import',
        entity: 'customers',
        entityId: existing._id,
        after: { erpCustomerId: payload.erpCustomerId, name: payload.name },
      });
    } else {
      const createdDoc = await Customer.create(payload);
      created += 1;
      await writeAudit({
        userId,
        action: 'import',
        entity: 'customers',
        entityId: createdDoc._id,
        after: { erpCustomerId: payload.erpCustomerId, name: payload.name },
      });
    }
  }
  return { created, updated, total: rows.length };
}

export async function importInvoicesCsv(text, userId = null) {
  const rows = parseCsv(text);
  let created = 0;
  let updated = 0;
  for (const row of rows) {
    requireFields(row, ['invoiceNo', 'customerErpId', 'amount', 'issueDate', 'dueDate']);
    const erpCustomerId = String(row.customerErpId).trim();
    const customer = await Customer.findOne({ erpCustomerId });
    if (!customer) {
      throw httpError(400, `Row ${row.__line}: unknown customer ${erpCustomerId}. Import customers first.`);
    }
    const amount = parseIntegerRupiah(row, 'amount');
    const paidAmount = row.paidAmount === '' || row.paidAmount == null
      ? 0
      : parseIntegerRupiah(row, 'paidAmount');
    if (paidAmount > amount) {
      throw httpError(400, `Row ${row.__line}: paidAmount cannot exceed amount.`);
    }
    const payload = {
      invoiceNo: String(row.invoiceNo).trim(),
      customerId: customer._id,
      erpCustomerId,
      amount,
      paidAmount,
      issueDate: parseIsoDate(row, 'issueDate'),
      dueDate: parseIsoDate(row, 'dueDate'),
      status: invoiceStatus(amount, paidAmount, String(row.status || '').trim().toLowerCase()),
      importedAt: new Date(),
    };
    const existing = await Invoice.findOne({ invoiceNo: payload.invoiceNo });
    if (existing) {
      Object.assign(existing, payload);
      await existing.save();
      updated += 1;
      await writeAudit({
        userId,
        action: 'import',
        entity: 'invoices',
        entityId: existing._id,
        after: { invoiceNo: payload.invoiceNo, status: payload.status },
      });
    } else {
      const createdDoc = await Invoice.create(payload);
      created += 1;
      await writeAudit({
        userId,
        action: 'import',
        entity: 'invoices',
        entityId: createdDoc._id,
        after: { invoiceNo: payload.invoiceNo, status: payload.status },
      });
    }
  }
  return { created, updated, total: rows.length };
}
