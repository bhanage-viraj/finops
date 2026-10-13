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

/** Editable overdue reminder. Staff send it from WhatsApp themselves. */
export function draftWhatsAppMessage(invoice) {
  const name = invoice.customerName || 'Bapak/Ibu';
  const number = invoice.invoiceNumber || '-';
  const amount = formatRupiahText(invoice.balance);
  const due = formatDueDateId(invoice.dueDate);
  const link = String(invoice.invoiceUrl || '').trim();
  const linkLine = link ? `\n\nInvoice: ${link}` : '\n\nInvoice PDF terlampir.';
  return (
    `Halo ${name},\n\n`
    + `Kami ingin mengingatkan invoice ${number} sebesar ${amount} `
    + `yang jatuh tempo pada ${due} masih belum lunas.`
    + `${linkLine}\n\n`
    + `Mohon konfirmasi pembayarannya. Terima kasih.`
  );
}
