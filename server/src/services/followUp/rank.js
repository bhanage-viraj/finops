/**
 * Group by due date: oldest due date first (most overdue groups at the top).
 * Within the same due date: larger balance first, then invoice number.
 */
export function rankOverdueInvoices(invoices) {
  return [...(invoices || [])].sort((a, b) => {
    if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
    if (b.balance !== a.balance) return b.balance - a.balance;
    return String(a.invoiceNumber || '').localeCompare(String(b.invoiceNumber || ''));
  });
}

/** Consecutive invoices that share a due date, preserving rankOverdueInvoices order. */
export function groupOverdueByDueDate(invoices) {
  const groups = [];
  for (const invoice of rankOverdueInvoices(invoices)) {
    const last = groups[groups.length - 1];
    if (last && last.dueDate === invoice.dueDate) {
      last.invoices.push(invoice);
      continue;
    }
    groups.push({
      dueDate: invoice.dueDate,
      daysOverdue: invoice.daysOverdue,
      invoices: [invoice],
    });
  }
  return groups;
}

export function formatRupiahText(amount) {
  if (!Number.isInteger(amount)) return String(amount ?? '');
  return `Rp ${amount.toLocaleString('id-ID')}`;
}

export function formatDueDateId(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return String(iso || '');
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** Shared reminder pieces so single and combined messages carry the same bank details. */
export const REMINDER_TEXT = {
  opening: 'Hi, Mr./Mrs,\n\nWe hope you are enjoying your water as always!',
  bank: 'Account Name: PT Tigris Inovatif Solusi\nAccount Number: 7228-0000-0522 (IDR)\nBank Name: OCBC NISP',
  closing: 'Thank you so much, we are grateful for your support.',
};

/** Editable overdue reminder. Staff send it from WhatsApp themselves. */
export function draftWhatsAppMessage(invoice) {
  const due = formatDueDateId(invoice.dueDate) || '—';
  return (
    `${REMINDER_TEXT.opening}\n\n`
    + `A kind reminder that payment for your latest delivery is due invoice on ${due}. `
    + 'Please feel free to transfer at your convenience using the details below.\n\n'
    + `${REMINDER_TEXT.bank}\n\n`
    + REMINDER_TEXT.closing
  );
}

/** One reminder listing several invoices of the same customer with the total to transfer. */
export function draftCombinedWhatsAppMessage(invoices) {
  const rows = rankOverdueInvoices(invoices);
  if (rows.length === 1) return draftWhatsAppMessage(rows[0]);
  const total = rows.reduce((sum, row) => sum + row.balance, 0);
  const lines = rows
    .map((row) => `- ${row.invoiceNumber || row.invoiceId} (due ${formatDueDateId(row.dueDate)}): ${formatRupiahText(row.balance)}`)
    .join('\n');
  return (
    `${REMINDER_TEXT.opening}\n\n`
    + `A kind reminder that payment for these ${rows.length} invoices is due:\n${lines}\n\n`
    + `Total: ${formatRupiahText(total)}\n\n`
    + 'Please feel free to transfer the total in one payment at your convenience using the details below.\n\n'
    + `${REMINDER_TEXT.bank}\n\n`
    + REMINDER_TEXT.closing
  );
}

function customerKey(invoice) {
  return invoice.customerId ? `id:${invoice.customerId}` : `name:${String(invoice.customerName || '').trim().toLowerCase()}`;
}

/**
 * Overdue invoices per customer: invoices oldest due first, customers with the
 * oldest overdue invoice first, then the larger total.
 */
export function groupOverdueByCustomer(invoices) {
  const groups = new Map();
  for (const invoice of rankOverdueInvoices(invoices)) {
    const key = customerKey(invoice);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        customerId: invoice.customerId || '',
        customerName: invoice.customerName || '',
        customerPhone: invoice.customerPhone || '',
        invoices: [],
        total: 0,
        maxDaysOverdue: 0,
      });
    }
    const group = groups.get(key);
    group.invoices.push(invoice);
    group.total += invoice.balance;
    group.maxDaysOverdue = Math.max(group.maxDaysOverdue, invoice.daysOverdue || 0);
    if (!group.customerPhone && invoice.customerPhone) group.customerPhone = invoice.customerPhone;
  }
  return [...groups.values()].sort((a, b) => {
    if (b.maxDaysOverdue !== a.maxDaysOverdue) return b.maxDaysOverdue - a.maxDaysOverdue;
    if (b.total !== a.total) return b.total - a.total;
    return a.customerName.localeCompare(b.customerName);
  });
}
