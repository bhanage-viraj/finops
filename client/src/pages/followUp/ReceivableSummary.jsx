import { useState } from 'react';
import { fetchReceivableSummaryPdf } from '../../api/followUp.js';
import { formatRupiah } from '../../utils/formatRupiah.js';

function displayDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return iso || '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function whatsappUrl(phone, text) {
  const digits = String(phone || '').replace(/\D/g, '');
  const q = encodeURIComponent(text || '');
  if (digits) return `https://web.whatsapp.com/send?phone=${digits}&text=${q}`;
  return `https://web.whatsapp.com/send?text=${q}`;
}

function monthBounds(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  const iso = (day) => {
    const month = String(day.getMonth() + 1).padStart(2, '0');
    const datePart = String(day.getDate()).padStart(2, '0');
    return `${day.getFullYear()}-${month}-${datePart}`;
  };
  return { from: iso(start), to: iso(end) };
}

function summaryMessage(total, from, to) {
  return (
    'Hi, Mr./Mrs,\n\nWe hope you are enjoying your water as always!\n\n'
    + `A kind reminder that the outstanding balance from ${displayDate(from)} to ${displayDate(to)} is ${formatRupiah(total)}.\n\n`
    + 'Please feel free to transfer at your convenience using the details below.\n\n'
    + 'Account Name: PT Tigris Inovatif Solusi\n'
    + 'Account Number: 7228-0000-0522 (IDR)\n'
    + 'Bank Name: OCBC NISP\n\n'
    + 'Thank you so much, we are grateful for your support.'
  );
}

function noteIsBad(note) {
  return /failed|could not|more than one|no outstanding/i.test(note || '');
}

/** Added beside the reminder list. Does not read or change that list. */
export default function ReceivableSummary() {
  const [mode, setMode] = useState('month');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [customer, setCustomer] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  function triggerDownload(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function run(send) {
    setNote('');
    const range = mode === 'month' ? monthBounds() : { from, to };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}-\d{2}$/.test(range.to)) {
      setNote('Choose a start and end date.');
      return;
    }
    if (range.from > range.to) {
      setNote('The start date must be on or before the end date.');
      return;
    }
    setBusy(true);
    try {
      const file = await fetchReceivableSummaryPdf({ ...range, customer });
      const pdf = new File([file.blob], file.fileName, { type: 'application/pdf' });
      triggerDownload(pdf, pdf.name);
      if (!send) {
        setNote('Receivable summary downloaded.');
        return;
      }
      if (file.customerCount !== 1) {
        setNote(file.customerCount === 0
          ? 'No outstanding balance for that customer in this range.'
          : 'More than one customer matches. Type more of the name so the PDF is for one customer.');
        return;
      }
      window.open(whatsappUrl(file.phone, summaryMessage(file.total, range.from, range.to)), '_blank', 'noopener,noreferrer');
      setNote('PDF downloaded. Attach that file in WhatsApp Web after the chat opens.');
    } catch (err) {
      setNote(err.message || 'The summary could not be downloaded.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card followup-summary">
      <h2>Receivable summary</h2>
      <p className="hint">
        Separate from the reminder list. One PDF of unpaid invoices, with the same columns as the Zoho receivable summary. Credit notes are not included.
      </p>
      <div className="filters">
        <label className="filter-field">
          <span className="field-label">Date range</span>
          <select value={mode} onChange={(event) => setMode(event.target.value)}>
            <option value="month">This month</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        {mode === 'custom' && (
          <>
            <label className="filter-field">
              <span className="field-label">From</span>
              <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </label>
            <label className="filter-field">
              <span className="field-label">To</span>
              <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            </label>
          </>
        )}
        <label className="filter-field">
          <span className="field-label">Customer</span>
          <input
            aria-label="Customer for the summary"
            placeholder="Optional. Needed to send"
            value={customer}
            onChange={(event) => setCustomer(event.target.value)}
          />
        </label>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => run(false)}>
          Download PDF
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !customer.trim()}
          onClick={() => run(true)}
        >
          Send on WhatsApp
        </button>
      </div>
      {note && <p className={noteIsBad(note) ? 'message message-bad' : 'hint'}>{note}</p>}
    </section>
  );
}
