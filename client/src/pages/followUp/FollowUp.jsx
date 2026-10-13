import { useEffect, useState } from 'react';
import { fetchFollowUpInvoicePdf, fetchFollowUpToday } from '../../api/followUp.js';
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

function safeFileName(name, fallback) {
  const raw = String(name || fallback || 'invoice.pdf').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80);
  return raw.toLowerCase().endsWith('.pdf') ? raw : `${raw || 'invoice'}.pdf`;
}

function MessageDraft({
  selected,
  message,
  note,
  sharing,
  onMessageChange,
  onCopy,
  onShareWhatsApp,
  onDownloadPdf,
}) {
  if (!selected) {
    return <p className="muted">Select a customer from the list.</p>;
  }
  return (
    <>
      <p className="hint">
        {selected.customerName || 'Customer'} · {selected.invoiceNumber || '—'} · {formatRupiah(selected.balance)}
      </p>
      <label className="field">
        <span className="field-label">Custom message</span>
        <textarea
          rows={8}
          value={message}
          onChange={(event) => onMessageChange(event.target.value)}
        />
      </label>
      <p className="hint">
        Draft only. Share pulls the invoice PDF from Zoho and opens WhatsApp with the file when your phone allows it.
      </p>
      {note && <p className={`message ${note.startsWith('Share failed') || note.startsWith('Download failed') || note.startsWith('Copy failed') ? 'message-bad' : 'message-ok'}`}>{note}</p>}
      <div className="actions">
        <button type="button" className="btn btn-secondary" onClick={onCopy} disabled={sharing}>Copy text</button>
        <button type="button" className="btn btn-secondary" onClick={onDownloadPdf} disabled={sharing}>
          {sharing ? 'Getting PDF…' : 'Download PDF'}
        </button>
        <button type="button" className="btn btn-primary" onClick={onShareWhatsApp} disabled={sharing}>
          {sharing ? 'Preparing…' : 'Share on WhatsApp'}
        </button>
      </div>
    </>
  );
}

export default function FollowUp() {
  const [invoices, setInvoices] = useState([]);
  const [asOf, setAsOf] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(true);
  const [sharing, setSharing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    fetchFollowUpToday()
      .then((body) => {
        if (cancelled) return;
        setInvoices(body.invoices || []);
        setAsOf(body.asOf || '');
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
    window.requestAnimationFrame(() => {
      document.getElementById(`followup-inline-${invoice.invoiceId}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    });
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

  async function loadInvoiceFile(invoice) {
    const { blob } = await fetchFollowUpInvoicePdf(invoice.invoiceId);
    const fileName = safeFileName(`${invoice.invoiceNumber || invoice.invoiceId}.pdf`);
    return new File([blob], fileName, { type: 'application/pdf' });
  }

  function triggerDownload(file) {
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function downloadPdf() {
    if (!selected) return;
    setNote('');
    setSharing(true);
    try {
      const file = await loadInvoiceFile(selected);
      triggerDownload(file);
      setNote('Invoice PDF downloaded.');
    } catch (err) {
      setNote(err.message || 'Download failed.');
    } finally {
      setSharing(false);
    }
  }

  async function shareOnWhatsApp() {
    if (!selected) return;
    setNote('');
    setSharing(true);
    try {
      const file = await loadInvoiceFile(selected);
      const canShareFiles = typeof navigator.share === 'function'
        && (!navigator.canShare || navigator.canShare({ files: [file] }));
      if (canShareFiles) {
        await navigator.share({
          files: [file],
          text: message,
          title: selected.invoiceNumber || 'Invoice',
        });
        setNote('Share sheet opened. Choose WhatsApp to send the invoice PDF.');
        return;
      }
      triggerDownload(file);
      window.open(whatsappUrl(selected.customerPhone, message), '_blank', 'noopener,noreferrer');
      setNote('PDF downloaded. Attach that file in WhatsApp after the chat opens.');
    } catch (err) {
      if (err?.name === 'AbortError') {
        setNote('');
        return;
      }
      setNote(err.message || 'Share failed.');
    } finally {
      setSharing(false);
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
        <div className="review-grid followup-grid">
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
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((invoice) => (
                    <tr
                      key={invoice.invoiceId}
                      className={invoice.invoiceId === selectedId ? 'row-selected' : undefined}
                    >
                      <td>{invoice.customerName || '—'}</td>
                      <td>{invoice.invoiceNumber || '—'}</td>
                      <td>{displayDate(invoice.dueDate)}</td>
                      <td className="num">{invoice.daysOverdue}</td>
                      <td className="num">{formatRupiah(invoice.balance)}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => pick(invoice)}
                        >
                          Message
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="doc-cards">
              {invoices.map((invoice) => {
                const open = invoice.invoiceId === selectedId;
                return (
                  <div
                    key={invoice.invoiceId}
                    className={`card doc-card${open ? ' row-selected' : ''}`}
                  >
                    <div className="title-row">
                      <strong>{invoice.customerName || 'Customer'}</strong>
                      <span className="badge badge-bad">{invoice.daysOverdue}d</span>
                    </div>
                    <p>{invoice.invoiceNumber || '—'} · due {displayDate(invoice.dueDate)}</p>
                    <p className="subtext">{formatRupiah(invoice.balance)}</p>
                    <div className="actions followup-card-actions">
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => pick(invoice)}
                      >
                        Message
                      </button>
                    </div>
                    {open && (
                      <div id={`followup-inline-${invoice.invoiceId}`} className="followup-inline">
                        <h3>WhatsApp message</h3>
                        <MessageDraft
                          selected={invoice}
                          message={message}
                          note={note}
                          sharing={sharing}
                          onMessageChange={setMessage}
                          onCopy={copyMessage}
                          onShareWhatsApp={shareOnWhatsApp}
                          onDownloadPdf={downloadPdf}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
          <section className="card followup-message">
            <h2>WhatsApp message</h2>
            <MessageDraft
              selected={selected}
              message={message}
              note={note}
              sharing={sharing}
              onMessageChange={setMessage}
              onCopy={copyMessage}
              onShareWhatsApp={shareOnWhatsApp}
              onDownloadPdf={downloadPdf}
            />
          </section>
        </div>
      )}
    </>
  );
}
