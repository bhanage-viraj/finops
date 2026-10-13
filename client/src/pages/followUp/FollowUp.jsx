import { useEffect, useState } from 'react';
import { fetchFollowUpToday } from '../../api/followUp.js';
import { formatRupiah } from '../../utils/formatRupiah.js';

function displayDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return iso || '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function whatsappUrl(phone, text) {
  const digits = String(phone || '').replace(/\D/g, '');
  const q = encodeURIComponent(text || '');
  if (digits) return `https://wa.me/${digits}?text=${q}`;
  return `https://wa.me/?text=${q}`;
}

export default function FollowUp() {
  const [invoices, setInvoices] = useState([]);
  const [asOf, setAsOf] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    fetchFollowUpToday()
      .then((body) => {
        if (cancelled) return;
        const list = body.invoices || [];
        setInvoices(list);
        setAsOf(body.asOf || '');
        if (list[0]) {
          setSelectedId(list[0].invoiceId);
          setMessage(list[0].messageDraft || '');
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => { cancelled = true; };
  }, []);

  const selected = invoices.find((item) => item.invoiceId === selectedId) || null;

  function pick(invoice) {
    setSelectedId(invoice.invoiceId);
    setMessage(invoice.messageDraft || '');
    setNote('');
  }

  async function copyMessage() {
    setNote('');
    try {
      await navigator.clipboard.writeText(message);
      setNote('Message copied.');
    } catch {
      setNote('Copy failed. Select the text and copy it manually.');
    }
  }

  return (
    <>
      <h1>Follow-up</h1>
      <p className="hint">
        Overdue invoices from Zoho Books, most urgent first. Read only — nothing is written back to Zoho.
        {asOf ? ` As of ${displayDate(asOf)}.` : ''}
      </p>
      {error && <p className="message message-bad">{error}</p>}
      {busy && <p className="muted">Loading overdue invoices…</p>}
      {!busy && !error && invoices.length === 0 && (
        <p className="card">No overdue invoices to remind today.</p>
      )}
      {invoices.length > 0 && (
        <div className="review-grid">
          <section className="card">
            <h2>Who to remind</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Invoice</th>
                    <th>Due</th>
                    <th className="num">Days</th>
                    <th className="num">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((invoice) => (
                    <tr
                      key={invoice.invoiceId}
                      className={invoice.invoiceId === selectedId ? 'row-selected' : undefined}
                      onClick={() => pick(invoice)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          pick(invoice);
                        }
                      }}
                      tabIndex={0}
                      role="button"
                      aria-pressed={invoice.invoiceId === selectedId}
                    >
                      <td>{invoice.customerName || '—'}</td>
                      <td>{invoice.invoiceNumber || '—'}</td>
                      <td>{displayDate(invoice.dueDate)}</td>
                      <td className="num">{invoice.daysOverdue}</td>
                      <td className="num">{formatRupiah(invoice.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="doc-cards">
              {invoices.map((invoice) => (
                <button
                  key={invoice.invoiceId}
                  type="button"
                  className={`card doc-card${invoice.invoiceId === selectedId ? ' row-selected' : ''}`}
                  onClick={() => pick(invoice)}
                >
                  <div className="title-row">
                    <strong>{invoice.customerName || 'Customer'}</strong>
                    <span className="badge badge-bad">{invoice.daysOverdue}d</span>
                  </div>
                  <p>{invoice.invoiceNumber || '—'} · due {displayDate(invoice.dueDate)}</p>
                  <p className="subtext">{formatRupiah(invoice.balance)}</p>
                </button>
              ))}
            </div>
          </section>
          <section className="card">
            <h2>WhatsApp message</h2>
            {selected ? (
              <>
                <p className="hint">
                  {selected.customerName || 'Customer'} · {selected.invoiceNumber || '—'} · {formatRupiah(selected.balance)}
                </p>
                <label className="field">
                  <span className="field-label">Custom message</span>
                  <textarea
                    rows={10}
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                  />
                </label>
                <p className="hint">Draft only. Send from WhatsApp yourself.</p>
                {note && <p className="message message-ok">{note}</p>}
                <div className="actions">
                  <button type="button" className="btn btn-secondary" onClick={copyMessage}>Copy</button>
                  <a
                    className="btn btn-primary"
                    href={whatsappUrl(selected.customerPhone, message)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open WhatsApp
                  </a>
                </div>
              </>
            ) : (
              <p className="muted">Select a customer from the list.</p>
            )}
          </section>
        </div>
      )}
    </>
  );
}
