import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { fetchFollowUpInvoicePdf, fetchFollowUpToday } from '../../api/followUp.js';
import { formatRupiah } from '../../utils/formatRupiah.js';

function matchesFollowUpFilters(invoice, { q, dueFrom, dueTo }) {
  if (dueFrom && String(invoice.dueDate || '') < dueFrom) return false;
  if (dueTo && String(invoice.dueDate || '') > dueTo) return false;
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return true;
  const hay = [
    invoice.customerName,
    invoice.invoiceNumber,
    invoice.invoiceId,
    invoice.customerPhone,
  ].join(' ').toLowerCase();
  return hay.includes(needle);
}

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

/** API already ranks by due date; chunk consecutive same-day rows for section headers. */
function groupByDueDate(list) {
  const groups = [];
  for (const invoice of list || []) {
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

function FollowUpPanel({
  selected,
  message,
  note,
  sharing,
  previewUrl,
  previewBusy,
  previewError,
  onMessageChange,
  onCopy,
  onShareWhatsApp,
  onDownloadPdf,
  onClose,
}) {
  return (
    <div className="followup-panel">
      <div className="title-row followup-panel-head">
        <h3>Reminder</h3>
        {onClose && (
          <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
        )}
      </div>
      <p className="hint">
        {selected.customerName || 'Customer'} · {selected.invoiceNumber || '—'} · {formatRupiah(selected.balance)}
        {' · due '}{displayDate(selected.dueDate)} ({selected.daysOverdue}d overdue)
      </p>

      <div className="followup-preview">
        <div className="title-row followup-preview-head">
          <strong>Invoice</strong>
          {previewUrl && (
            <a className="btn btn-secondary" href={previewUrl} target="_blank" rel="noreferrer">
              Open full size
            </a>
          )}
        </div>
        {previewBusy && <p className="muted">Loading invoice PDF…</p>}
        {previewError && <p className="message message-bad">{previewError}</p>}
        {previewUrl && !previewBusy && (
          <div className="viewer-scroll followup-preview-frame">
            <div className="viewer-stage">
              <iframe title={`Invoice ${selected.invoiceNumber || selected.invoiceId}`} src={`${previewUrl}#view=FitH`} />
            </div>
          </div>
        )}
      </div>

      <label className="field">
        <span className="field-label">WhatsApp message</span>
        <textarea
          rows={6}
          value={message}
          onChange={(event) => onMessageChange(event.target.value)}
        />
      </label>
      <p className="hint">Edit if needed, then share. The invoice PDF is attached when your phone allows it.</p>
      {note && (
        <p className={`message ${note.startsWith('Share failed') || note.startsWith('Download failed') || note.startsWith('Copy failed') ? 'message-bad' : 'message-ok'}`}>
          {note}
        </p>
      )}
      <div className="actions">
        <button type="button" className="btn btn-secondary" onClick={onCopy} disabled={sharing}>Copy text</button>
        <button type="button" className="btn btn-secondary" onClick={onDownloadPdf} disabled={sharing || previewBusy}>
          {sharing ? 'Getting PDF…' : 'Download PDF'}
        </button>
        <button type="button" className="btn btn-primary" onClick={onShareWhatsApp} disabled={sharing || previewBusy}>
          {sharing ? 'Preparing…' : 'Share on WhatsApp'}
        </button>
      </div>
    </div>
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
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [q, setQ] = useState('');
  const [dueFrom, setDueFrom] = useState('');
  const [dueTo, setDueTo] = useState('');
  const pdfCache = useRef(new Map());
  const previewUrlRef = useRef('');

  async function loadInvoiceFile(invoice) {
    const cached = pdfCache.current.get(invoice.invoiceId);
    if (cached) return cached;
    const { blob } = await fetchFollowUpInvoicePdf(invoice.invoiceId);
    const fileName = safeFileName(`${invoice.invoiceNumber || invoice.invoiceId}.pdf`);
    const file = new File([blob], fileName, { type: 'application/pdf' });
    pdfCache.current.set(invoice.invoiceId, file);
    return file;
  }

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

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  useEffect(() => {
    if (!selectedId) {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = '';
      }
      setPreviewUrl('');
      setPreviewError('');
      setPreviewBusy(false);
      return undefined;
    }

    let cancelled = false;
    const invoice = invoices.find((item) => item.invoiceId === selectedId);
    if (!invoice) return undefined;

    setPreviewBusy(true);
    setPreviewError('');
    loadInvoiceFile(invoice)
      .then((file) => {
        if (cancelled) return;
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        const url = URL.createObjectURL(file);
        previewUrlRef.current = url;
        setPreviewUrl(url);
      })
      .catch((err) => {
        if (cancelled) return;
        if (previewUrlRef.current) {
          URL.revokeObjectURL(previewUrlRef.current);
          previewUrlRef.current = '';
        }
        setPreviewUrl('');
        setPreviewError(err.message || 'Invoice preview could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setPreviewBusy(false);
      });

    return () => { cancelled = true; };
  }, [selectedId, invoices]);

  const filtered = useMemo(
    () => invoices.filter((invoice) => matchesFollowUpFilters(invoice, { q, dueFrom, dueTo })),
    [invoices, q, dueFrom, dueTo],
  );
  const selected = filtered.find((item) => item.invoiceId === selectedId) || null;
  const dueGroups = groupByDueDate(filtered);

  useEffect(() => {
    if (selectedId && !filtered.some((item) => item.invoiceId === selectedId)) {
      setSelectedId('');
      setMessage('');
      setNote('');
    }
  }, [filtered, selectedId]);

  function pick(invoice) {
    if (selectedId === invoice.invoiceId) {
      setSelectedId('');
      setMessage('');
      setNote('');
      return;
    }
    setSelectedId(invoice.invoiceId);
    setMessage(invoice.messageDraft || '');
    setNote('');
  }

  function closePanel() {
    setSelectedId('');
    setMessage('');
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

  const panelProps = {
    message,
    note,
    sharing,
    previewUrl,
    previewBusy,
    previewError,
    onMessageChange: setMessage,
    onCopy: copyMessage,
    onShareWhatsApp: shareOnWhatsApp,
    onDownloadPdf: downloadPdf,
    onClose: closePanel,
  };

  return (
    <>
      <h1>Follow-up</h1>
      <p className="hint">
        Overdue invoices from Zoho Books, grouped by due date (oldest due first). Tap Message to open the invoice, reminder text, and WhatsApp actions in place. Read only — nothing is written back to Zoho.
        {asOf ? ` As of ${displayDate(asOf)}.` : ''}
      </p>
      {error && <p className="message message-bad">{error}</p>}
      {busy && <p className="muted">Loading overdue invoices…</p>}
      {!busy && !error && invoices.length === 0 && (
        <p className="card">No overdue invoices to remind today.</p>
      )}
      {invoices.length > 0 && (
        <section className="card">
          <h2>Who to remind</h2>
          <div className="filters">
            <input
              aria-label="Search customer or invoice"
              placeholder="Customer, invoice, phone"
              value={q}
              onChange={(event) => setQ(event.target.value)}
            />
            <input
              aria-label="Due from"
              type="date"
              value={dueFrom}
              onChange={(event) => setDueFrom(event.target.value)}
            />
            <input
              aria-label="Due to"
              type="date"
              value={dueTo}
              onChange={(event) => setDueTo(event.target.value)}
            />
            {(q || dueFrom || dueTo) && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => { setQ(''); setDueFrom(''); setDueTo(''); }}
              >
                Clear
              </button>
            )}
          </div>
          <p className="hint">
            Showing {filtered.length} of {invoices.length} overdue invoice{invoices.length === 1 ? '' : 's'}.
          </p>
          {filtered.length === 0 ? (
            <p className="muted">No invoices match these filters.</p>
          ) : (
            <div className="table-wrap followup-list">
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
                  {dueGroups.map((group) => (
                    <Fragment key={group.dueDate}>
                      <tr className="followup-group-row">
                        <td colSpan={6}>
                          <strong>Due {displayDate(group.dueDate)}</strong>
                          {' · '}
                          {group.daysOverdue}d overdue
                          {' · '}
                          {group.invoices.length} invoice{group.invoices.length === 1 ? '' : 's'}
                        </td>
                      </tr>
                      {group.invoices.map((invoice) => {
                        const open = invoice.invoiceId === selectedId;
                        return (
                          <Fragment key={invoice.invoiceId}>
                            <tr className={open ? 'row-selected' : undefined}>
                              <td>{invoice.customerName || '—'}</td>
                              <td>{invoice.invoiceNumber || '—'}</td>
                              <td className="followup-due-cell">{displayDate(invoice.dueDate)}</td>
                              <td className="num">{invoice.daysOverdue}</td>
                              <td className="num">{formatRupiah(invoice.balance)}</td>
                              <td>
                                <button
                                  type="button"
                                  className="btn btn-secondary"
                                  onClick={() => pick(invoice)}
                                >
                                  {open ? 'Close' : 'Message'}
                                </button>
                              </td>
                            </tr>
                            {open && (
                              <tr className="followup-detail-row">
                                <td colSpan={6}>
                                  <FollowUpPanel {...panelProps} selected={invoice} />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}
