import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { fetchFollowUpInvoicePdf, fetchFollowUpToday } from '../../api/followUp.js';
import ReceivableSummary from './ReceivableSummary.jsx';
import { formatRupiah } from '../../utils/formatRupiah.js';

function displayDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return iso || '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** WhatsApp Web in the browser — avoids opening the native WhatsApp app. */
function whatsappUrl(phone, text) {
  const digits = String(phone || '').replace(/\D/g, '');
  const q = encodeURIComponent(text || '');
  if (digits) return `https://web.whatsapp.com/send?phone=${digits}&text=${q}`;
  return `https://web.whatsapp.com/send?text=${q}`;
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

function oldestDueFirst(a, b) {
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  return String(a.invoiceNumber || '').localeCompare(String(b.invoiceNumber || ''));
}

/** Same layout as the server's combined draft, for any ticked subset. */
function combinedMessage(rows, text) {
  if (!text) return '';
  const sorted = [...rows].sort(oldestDueFirst);
  if (sorted.length === 1) return sorted[0].messageDraft || '';
  const total = sorted.reduce((sum, row) => sum + row.balance, 0);
  const lines = sorted
    .map((row) => `- ${row.invoiceNumber || row.invoiceId} (due ${displayDate(row.dueDate)}): ${formatRupiah(row.balance)}`)
    .join('\n');
  return (
    `${text.opening}\n\n`
    + `A kind reminder that payment for these ${sorted.length} invoices is due:\n${lines}\n\n`
    + `Total: ${formatRupiah(total)}\n\n`
    + 'Please feel free to transfer the total in one payment at your convenience using the details below.\n\n'
    + `${text.bank}\n\n`
    + text.closing
  );
}

function noteIsBad(note) {
  return /failed|could not/i.test(note || '');
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
      {note && <p className={`message ${noteIsBad(note) ? 'message-bad' : 'message-ok'}`}>{note}</p>}
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

function CombinedPanel({
  customer,
  rows,
  message,
  note,
  sharing,
  onMessageChange,
  onCopy,
  onShare,
  onDownloadAll,
  onOpenPdf,
  onClose,
}) {
  const total = rows.reduce((sum, row) => sum + row.balance, 0);
  return (
    <div className="followup-panel">
      <div className="title-row followup-panel-head">
        <h3>Reminder for {rows.length} invoice{rows.length === 1 ? '' : 's'}</h3>
        <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
      </div>
      <p className="hint">
        {customer.customerName || 'Customer'} · total {formatRupiah(total)}
        {customer.customerPhone ? ` · ${customer.customerPhone}` : ''}
      </p>
      <ul className="followup-combined-list">
        {rows.map((row) => (
          <li key={row.invoiceId}>
            <span>
              <strong>{row.invoiceNumber || row.invoiceId}</strong>
              {' · due '}{displayDate(row.dueDate)} · {formatRupiah(row.balance)}
            </span>
            <button type="button" className="btn btn-secondary" disabled={sharing} onClick={() => onOpenPdf(row)}>
              Open PDF
            </button>
          </li>
        ))}
      </ul>

      <label className="field">
        <span className="field-label">WhatsApp message</span>
        <textarea
          rows={10}
          value={message}
          onChange={(event) => onMessageChange(event.target.value)}
        />
      </label>
      <p className="hint">
        All {rows.length} invoice PDFs are attached when your phone allows it. The message is also copied, so paste it if WhatsApp drops the text.
      </p>
      {note && <p className={`message ${noteIsBad(note) ? 'message-bad' : 'message-ok'}`}>{note}</p>}
      <div className="actions">
        <button type="button" className="btn btn-secondary" onClick={onCopy} disabled={sharing}>Copy text</button>
        <button type="button" className="btn btn-secondary" onClick={onDownloadAll} disabled={sharing}>
          {sharing ? 'Getting PDFs…' : `Download ${rows.length} PDF${rows.length === 1 ? '' : 's'}`}
        </button>
        <button type="button" className="btn btn-primary" onClick={onShare} disabled={sharing}>
          {sharing ? 'Preparing…' : 'Share on WhatsApp'}
        </button>
      </div>
    </div>
  );
}

function Pager({ info, busy, onPage }) {
  if (!info || info.pageCount <= 1) return null;
  const unit = info.unit === 'customers' ? 'customers' : 'invoices';
  return (
    <nav className="followup-pager" aria-label="Pages">
      <button
        type="button"
        className="btn btn-secondary"
        disabled={busy || info.page <= 1}
        onClick={() => onPage(info.page - 1)}
      >
        ‹ Previous
      </button>
      <span className="hint">
        {unit} {info.from.toLocaleString('id-ID')}–{info.to.toLocaleString('id-ID')} of {info.total.toLocaleString('id-ID')}
        {' · page '}{info.page} of {info.pageCount}
      </span>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={busy || info.page >= info.pageCount}
        onClick={() => onPage(info.page + 1)}
      >
        Next ›
      </button>
    </nav>
  );
}

export default function FollowUp() {
  const [invoices, setInvoices] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [reminderText, setReminderText] = useState(null);
  const [asOf, setAsOf] = useState('');
  const [view, setView] = useState('due');
  // "inv:<invoiceId>" for one invoice, "cust:<key>" for a combined reminder.
  const [openKey, setOpenKey] = useState('');
  const [openIds, setOpenIds] = useState([]);
  const [picked, setPicked] = useState(() => new Set());
  const [message, setMessage] = useState('');
  const [messageEdited, setMessageEdited] = useState(false);
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
  const [searchText, setSearchText] = useState('');
  const [page, setPage] = useState(1);
  const [pageInfo, setPageInfo] = useState(null);
  const [totals, setTotals] = useState(null);
  const [reloadTick, setReloadTick] = useState(0);
  const refreshNext = useRef(false);
  const pdfCache = useRef(new Map());
  const previewUrlRef = useRef('');

  const selectedId = openKey.startsWith('inv:') ? openKey.slice(4) : '';

  async function loadInvoiceFile(invoice) {
    const cached = pdfCache.current.get(invoice.invoiceId);
    if (cached) return cached;
    const { blob } = await fetchFollowUpInvoicePdf(invoice.invoiceId);
    const fileName = safeFileName(`${invoice.invoiceNumber || invoice.invoiceId}.pdf`);
    const file = new File([blob], fileName, { type: 'application/pdf' });
    pdfCache.current.set(invoice.invoiceId, file);
    return file;
  }

  /** A few PDFs at a time so Zoho is not hit with a burst. */
  async function loadInvoiceFiles(rows) {
    const files = new Array(rows.length);
    let next = 0;
    async function worker() {
      while (next < rows.length) {
        const index = next;
        next += 1;
        files[index] = await loadInvoiceFile(rows[index]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, rows.length) }, worker));
    return files;
  }

  // Search runs on the server across every overdue invoice, so wait for typing to pause.
  useEffect(() => {
    const timer = setTimeout(() => setSearchText(q.trim()), 300);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    setPage(1);
  }, [view, searchText, dueFrom, dueTo]);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError('');
    const request = fetchFollowUpToday({
      view,
      page,
      q: searchText,
      dueFrom,
      dueTo,
      refresh: refreshNext.current ? '1' : '',
    });
    refreshNext.current = false;
    request
      .then((body) => {
        if (cancelled) return;
        setInvoices(body.invoices || []);
        setCustomers(body.customers || []);
        setReminderText(body.reminderText || null);
        setAsOf(body.asOf || '');
        setPageInfo(body.page || null);
        setTotals({
          totalOverdue: body.totalOverdue ?? 0,
          totalMatching: body.totalMatching ?? 0,
          zohoRows: body.zohoRows ?? 0,
          truncated: body.truncated === true,
        });
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => { cancelled = true; };
  }, [view, page, searchText, dueFrom, dueTo, reloadTick]);

  function goToPage(next) {
    closePanel();
    setPage(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

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

  // The server already filtered and paged; this is the current page only.
  const filtered = invoices;
  const byId = useMemo(() => new Map(invoices.map((row) => [row.invoiceId, row])), [invoices]);
  const customerGroups = useMemo(() => customers
    .map((group) => {
      const all = group.invoiceIds.map((invoiceId) => byId.get(invoiceId)).filter(Boolean);
      return { ...group, all, visible: all };
    })
    .filter((group) => group.visible.length > 0), [customers, byId]);
  const selected = filtered.find((item) => item.invoiceId === selectedId) || null;
  const dueGroups = groupByDueDate(filtered);
  const openCustomer = openKey.startsWith('cust:')
    ? customerGroups.find((group) => `cust:${group.key}` === openKey) || null
    : null;
  const openRows = openIds.map((invoiceId) => byId.get(invoiceId)).filter(Boolean);

  useEffect(() => {
    if (selectedId && !filtered.some((item) => item.invoiceId === selectedId)) closePanel();
  }, [filtered, selectedId]);

  function closePanel() {
    setOpenKey('');
    setOpenIds([]);
    setMessage('');
    setMessageEdited(false);
    setNote('');
  }

  function pick(invoice) {
    if (selectedId === invoice.invoiceId) {
      closePanel();
      return;
    }
    setOpenKey(`inv:${invoice.invoiceId}`);
    setOpenIds([invoice.invoiceId]);
    setMessage(invoice.messageDraft || '');
    setMessageEdited(false);
    setNote('');
  }

  function openCombined(group, rows) {
    const ids = rows.map((row) => row.invoiceId);
    const isFull = ids.length === group.all.length;
    setOpenKey(`cust:${group.key}`);
    setOpenIds(ids);
    setMessage(isFull ? group.fullMessageDraft : combinedMessage(rows, reminderText));
    setMessageEdited(false);
    setNote('');
  }

  function togglePick(invoiceId) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(invoiceId)) next.delete(invoiceId);
      else next.add(invoiceId);
      return next;
    });
  }

  function toggleCustomer(group) {
    setPicked((prev) => {
      const next = new Set(prev);
      const allPicked = group.visible.every((row) => next.has(row.invoiceId));
      for (const row of group.visible) {
        if (allPicked) next.delete(row.invoiceId);
        else next.add(row.invoiceId);
      }
      return next;
    });
  }

  // An open "selected" reminder follows the ticks until the text is edited by hand.
  useEffect(() => {
    if (!openCustomer || messageEdited) return;
    const ticked = openCustomer.all.filter((row) => picked.has(row.invoiceId));
    const current = openIds.join(',');
    const isFullPanel = openIds.length === openCustomer.all.length;
    if (isFullPanel || !ticked.length) return;
    const ids = ticked.map((row) => row.invoiceId);
    if (ids.join(',') === current) return;
    setOpenIds(ids);
    setMessage(combinedMessage(ticked, reminderText));
  }, [picked]);

  function editMessage(value) {
    setMessage(value);
    setMessageEdited(true);
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

  async function shareFiles(files, phone) {
    // Always WhatsApp Web — navigator.share opens the native app on many machines.
    files.forEach(triggerDownload);
    window.open(whatsappUrl(phone, message), '_blank', 'noopener,noreferrer');
    return files.length > 1
      ? `${files.length} PDFs downloaded. Attach them in WhatsApp Web after the chat opens.`
      : 'PDF downloaded. Attach that file in WhatsApp Web after the chat opens.';
  }

  async function shareOnWhatsApp() {
    if (!selected) return;
    setNote('');
    setSharing(true);
    try {
      const file = await loadInvoiceFile(selected);
      setNote(await shareFiles([file], selected.customerPhone));
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

  async function shareCombined() {
    if (!openCustomer || !openRows.length) return;
    setNote('');
    setSharing(true);
    // Some phones drop the text when several files are shared; keep it on the clipboard.
    navigator.clipboard?.writeText(message).catch(() => {});
    try {
      const files = await loadInvoiceFiles(openRows);
      setNote(await shareFiles(files, openCustomer.customerPhone));
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

  async function downloadCombined() {
    if (!openRows.length) return;
    setNote('');
    setSharing(true);
    try {
      const files = await loadInvoiceFiles(openRows);
      files.forEach(triggerDownload);
      setNote(`${files.length} invoice PDF${files.length === 1 ? '' : 's'} downloaded.`);
    } catch (err) {
      setNote(err.message || 'Download failed.');
    } finally {
      setSharing(false);
    }
  }

  async function openPdf(row) {
    setNote('');
    // Open the tab first so the browser does not block it as a pop-up.
    const tab = window.open('', '_blank');
    try {
      const file = await loadInvoiceFile(row);
      const url = URL.createObjectURL(file);
      if (tab) tab.location.href = url;
      else window.open(url, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      tab?.close();
      setNote(err.message || 'Download failed.');
    }
  }

  const panelProps = {
    message,
    note,
    sharing,
    previewUrl,
    previewBusy,
    previewError,
    onMessageChange: editMessage,
    onCopy: copyMessage,
    onShareWhatsApp: shareOnWhatsApp,
    onDownloadPdf: downloadPdf,
    onClose: closePanel,
  };

  const combinedProps = {
    message,
    note,
    sharing,
    onMessageChange: editMessage,
    onCopy: copyMessage,
    onShare: shareCombined,
    onDownloadAll: downloadCombined,
    onOpenPdf: openPdf,
    onClose: closePanel,
  };

  function invoiceRow(invoice, { withPick }) {
    const open = invoice.invoiceId === selectedId;
    const cols = 6;
    return (
      <Fragment key={invoice.invoiceId}>
        <tr className={open || (withPick && picked.has(invoice.invoiceId)) ? 'row-selected' : undefined}>
          {withPick && (
            <td className="followup-pick-cell">
              <input
                type="checkbox"
                aria-label={`Select ${invoice.invoiceNumber || invoice.invoiceId}`}
                checked={picked.has(invoice.invoiceId)}
                onChange={() => togglePick(invoice.invoiceId)}
              />
            </td>
          )}
          <td>{withPick ? (invoice.invoiceNumber || '—') : (invoice.customerName || '—')}</td>
          <td>{withPick ? displayDate(invoice.dueDate) : (invoice.invoiceNumber || '—')}</td>
          {!withPick && <td className="followup-due-cell">{displayDate(invoice.dueDate)}</td>}
          <td className="num">{invoice.daysOverdue}</td>
          <td className="num">{formatRupiah(invoice.balance)}</td>
          <td>
            <button type="button" className="btn btn-secondary" onClick={() => pick(invoice)}>
              {open ? 'Close' : 'Message'}
            </button>
          </td>
        </tr>
        {open && (
          <tr className="followup-detail-row">
            <td colSpan={cols}>
              <FollowUpPanel {...panelProps} selected={invoice} />
            </td>
          </tr>
        )}
      </Fragment>
    );
  }

  return (
    <>
      <h1>Follow-up</h1>
      <p className="hint">
        Overdue invoices from Zoho Books, grouped by due date (oldest due first). Switch to By customer to tick invoices or send the full amount in one message with all PDFs.
        Read only — nothing is written back to Zoho.
        {asOf ? ` As of ${displayDate(asOf)}.` : ''}
      </p>
      {error && <p className="message message-bad">{error}</p>}
      {busy && !totals && <p className="muted">Loading overdue invoices from Zoho… the first load can take a little while.</p>}
      {!busy && !error && totals && totals.totalOverdue === 0 && (
        <p className="card">No overdue invoices to remind today.</p>
      )}
      {totals && totals.totalOverdue > 0 && (
        <section className="card">
          <div className="title-row followup-head">
            <h2>Who to remind</h2>
            <div className="actions followup-view-toggle" role="group" aria-label="Group by">
              <button
                type="button"
                className={`btn ${view === 'due' ? 'btn-primary' : 'btn-secondary'}`}
                aria-pressed={view === 'due'}
                onClick={() => { setView('due'); closePanel(); }}
              >
                By due date
              </button>
              <button
                type="button"
                className={`btn ${view === 'customer' ? 'btn-primary' : 'btn-secondary'}`}
                aria-pressed={view === 'customer'}
                onClick={() => { setView('customer'); closePanel(); }}
              >
                By customer
              </button>
            </div>
          </div>
          <div className="filters">
            <input
              aria-label="Search customer or invoice"
              placeholder="Customer, invoice, phone"
              value={q}
              onChange={(event) => setQ(event.target.value)}
            />
            <label className="filter-field">
              <span className="field-label">Due from</span>
              <input
                type="date"
                value={dueFrom}
                onChange={(event) => setDueFrom(event.target.value)}
              />
            </label>
            <label className="filter-field">
              <span className="field-label">Due to</span>
              <input
                type="date"
                value={dueTo}
                onChange={(event) => setDueTo(event.target.value)}
              />
            </label>
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
          <div className="title-row followup-count-row">
            <p className="hint">
              {totals.totalMatching === totals.totalOverdue
                ? `${totals.totalOverdue.toLocaleString('id-ID')} overdue invoice${totals.totalOverdue === 1 ? '' : 's'}`
                : `${totals.totalMatching.toLocaleString('id-ID')} of ${totals.totalOverdue.toLocaleString('id-ID')} overdue invoices match`}
              {busy ? ' · loading…' : ''}
            </p>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => {
                closePanel();
                refreshNext.current = true;
                setReloadTick((n) => n + 1);
              }}
            >
              Refresh from Zoho
            </button>
          </div>
          {totals.zohoRows > totals.totalOverdue && (
            <p className="hint">
              Zoho sent {totals.zohoRows.toLocaleString('id-ID')} rows;
              {' '}{(totals.zohoRows - totals.totalOverdue).toLocaleString('id-ID')} left out
              (not yet due, nothing left to pay, not in rupiah, or listed twice).
            </p>
          )}
          {totals.truncated && (
            <p className="message message-warn">
              Zoho has more overdue invoices than the app reads at once. Use the search or due-date filters to narrow the list.
            </p>
          )}
          <Pager info={pageInfo} busy={busy} onPage={goToPage} />
          {filtered.length === 0 ? (
            <p className="muted">No invoices match these filters.</p>
          ) : view === 'customer' ? (
            <div className="table-wrap followup-list">
              <table>
                <thead>
                  <tr>
                    <th aria-label="Select" />
                    <th>Invoice</th>
                    <th>Due</th>
                    <th className="num">Days</th>
                    <th className="num">Balance</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {customerGroups.map((group) => {
                    const tickedRows = group.all.filter((row) => picked.has(row.invoiceId));
                    const allTicked = group.visible.every((row) => picked.has(row.invoiceId));
                    const someTicked = tickedRows.length > 0 && !allTicked;
                    const tickedTotal = tickedRows.reduce((sum, row) => sum + row.balance, 0);
                    const panelOpen = openKey === `cust:${group.key}`;
                    return (
                      <Fragment key={group.key}>
                        <tr className="followup-group-row followup-customer-row">
                          <td className="followup-pick-cell">
                            <input
                              type="checkbox"
                              aria-label={`Select all invoices for ${group.customerName}`}
                              checked={allTicked}
                              ref={(el) => { if (el) el.indeterminate = someTicked; }}
                              onChange={() => toggleCustomer(group)}
                            />
                          </td>
                          <td colSpan={5}>
                            <div className="followup-customer-head">
                              <div>
                                <strong className="followup-customer-name">{group.customerName || '—'}</strong>
                                <span className="followup-customer-meta">
                                  {group.all.length} invoice{group.all.length === 1 ? '' : 's'}
                                  {' · oldest '}{group.maxDaysOverdue}d overdue
                                  {' · total '}<strong>{formatRupiah(group.total)}</strong>
                                </span>
                              </div>
                              <div className="actions followup-customer-actions">
                                {tickedRows.length > 0 && tickedRows.length < group.all.length && (
                                  <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={() => openCombined(group, tickedRows)}
                                  >
                                    Send selected ({tickedRows.length}) · {formatRupiah(tickedTotal)}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="btn btn-primary followup-full-btn"
                                  onClick={() => openCombined(group, group.all)}
                                >
                                  Send full amount · {formatRupiah(group.total)}
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                        {panelOpen && (
                          <tr className="followup-detail-row">
                            <td colSpan={6}>
                              <CombinedPanel {...combinedProps} customer={group} rows={openRows} />
                            </td>
                          </tr>
                        )}
                        {group.visible.map((invoice) => invoiceRow(invoice, { withPick: true }))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
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
                      {group.invoices.map((invoice) => invoiceRow(invoice, { withPick: false }))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {filtered.length > 0 && <Pager info={pageInfo} busy={busy} onPage={goToPage} />}
        </section>
      )}
      <ReceivableSummary />
    </>
  );
}
