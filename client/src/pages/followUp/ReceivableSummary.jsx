import { useEffect, useRef, useState } from 'react';
import { fetchFollowUpCustomers, fetchReceivableSummaryPdf } from '../../api/followUp.js';
import { formatRupiah } from '../../utils/formatRupiah.js';
import { PDF_TAB, WHATSAPP_TAB, clipboardPlan, whatsappOpener } from './whatsappTab.js';

const STATUS_OPTIONS = [
  { id: 'overdue', label: 'Overdue' },
  { id: 'paid', label: 'Paid' },
  { id: 'draft', label: 'Draft' },
];

function displayDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return iso || '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
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
  return /failed|could not|blocked|more than one|no outstanding|choose a start/i.test(note || '');
}

function summaryShareNote(result, name, copied) {
  const who = String(name || '').trim() || 'this customer';
  if (result.status === 'blocked') {
    return 'The browser blocked WhatsApp. Allow pop-ups and send again. The PDF is downloaded.';
  }
  if (result.status === 'same') {
    if (copied === 'number') {
      return `Number copied for ${who}. In the WhatsApp tab, paste it into search, open the chat, then paste the message. The PDF is downloaded.`;
    }
    return `Message copied for ${who}. Paste it in the WhatsApp tab. The PDF is downloaded.`;
  }
  const again = result.first ? ' Further sends stay in that tab.' : '';
  return `WhatsApp is open for ${who}. The PDF is downloaded. Attach it there.${again}`;
}

function downloadName(value, fallback) {
  const slug = String(value || fallback || 'Receivable-Summary')
    .replace(/\.pdf$/i, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .trim()
    .slice(0, 80) || 'Receivable-Summary';
  return /\.pdf$/i.test(slug) ? slug : `${slug}.pdf`;
}

function rangeKey(range, customer, statuses) {
  return `${range.from}|${range.to}|${String(customer || '').trim().toLowerCase()}|${(statuses || []).join(',')}`;
}

/** Added beside the reminder list. Does not read or change that list. */
export default function ReceivableSummary() {
  const [mode, setMode] = useState('month');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [customer, setCustomer] = useState('');
  const [fileName, setFileName] = useState('');
  const [statuses, setStatuses] = useState(['overdue']);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [chatLink, setChatLink] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewMeta, setPreviewMeta] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const previewUrlRef = useRef('');
  const previewFileRef = useRef(null);
  const previewKeyRef = useRef('');
  const suggestSeq = useRef(0);

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  useEffect(() => {
    const needle = customer.trim();
    if (!showSuggestions || needle.length < 1) {
      setSuggestions([]);
      setSuggesting(false);
      return undefined;
    }
    const seq = ++suggestSeq.current;
    setSuggesting(true);
    const timer = setTimeout(() => {
      fetchFollowUpCustomers(needle)
        .then((data) => {
          if (seq !== suggestSeq.current) return;
          setSuggestions(data.customers || []);
        })
        .catch(() => {
          if (seq !== suggestSeq.current) return;
          setSuggestions([]);
        })
        .finally(() => {
          if (seq === suggestSeq.current) setSuggesting(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [customer, showSuggestions]);

  function toggleStatus(id) {
    setStatuses((prev) => {
      const next = prev.includes(id) ? prev.filter((status) => status !== id) : [...prev, id];
      return next.length ? next : ['overdue'];
    });
  }

  function currentRange() {
    return mode === 'month' ? monthBounds() : { from, to };
  }

  function validateRange(range) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}-\d{2}$/.test(range.to)) {
      return 'Choose a start and end date.';
    }
    if (range.from > range.to) return 'The start date must be on or before the end date.';
    return '';
  }

  function triggerDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  }

  function showPreview(file) {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const url = URL.createObjectURL(file.blob);
    previewUrlRef.current = url;
    previewFileRef.current = file;
    setPreviewUrl(url);
    setPreviewMeta({
      invoiceCount: file.invoiceCount,
      customerCount: file.customerCount,
      total: file.total,
    });
    if (!String(fileName || '').trim() && file.fileName) {
      setFileName(String(file.fileName).replace(/\.pdf$/i, ''));
    }
  }

  async function loadPdf(range, { preview }) {
    return fetchReceivableSummaryPdf({
      ...range,
      customer,
      fileName,
      status: statuses.join(','),
      preview,
    });
  }

  async function onPreview() {
    setNote('');
    const range = currentRange();
    const error = validateRange(range);
    if (error) {
      setNote(error);
      return;
    }
    setBusy(true);
    try {
      const file = await loadPdf(range, { preview: true });
      previewKeyRef.current = rangeKey(range, customer, statuses);
      showPreview(file);
      const invoices = file.invoiceCount || 0;
      const customers = file.customerCount || 0;
      setNote(invoices
        ? `Preview ready. ${invoices.toLocaleString('id-ID')} invoice${invoices === 1 ? '' : 's'} · ${customers.toLocaleString('id-ID')} customer${customers === 1 ? '' : 's'}.`
        : 'Preview ready. No outstanding invoices in this range.');
    } catch (err) {
      setNote(err.message || 'The summary could not be previewed.');
    } finally {
      setBusy(false);
    }
  }

  async function run(send) {
    setNote('');
    setChatLink('');
    const range = currentRange();
    const error = validateRange(range);
    if (error) {
      setNote(error);
      return;
    }
    // Reserve the tab during the click. The phone number arrives with the PDF.
    const begun = send ? whatsappOpener.begin() : null;
    setBusy(true);
    try {
      const file = await loadPdf(range, { preview: false });
      previewKeyRef.current = rangeKey(range, customer, statuses);
      showPreview(file);
      const name = downloadName(fileName, file.fileName);
      const pdf = new File([file.blob], name, { type: 'application/pdf' });
      triggerDownload(pdf, name);
      if (!send) {
        setNote(`Receivable summary downloaded as ${name}.`);
        return;
      }
      if (file.customerCount !== 1) {
        whatsappOpener.cancel(begun);
        setNote(file.customerCount === 0
          ? 'No outstanding balance for that customer in this range.'
          : 'More than one customer matches. Type more of the name so the PDF is for one customer.');
        return;
      }
      const text = summaryMessage(file.total, range.from, range.to);
      const result = whatsappOpener.finish(begun, file.phone, text);
      const plan = clipboardPlan(result, file.phone, text);
      let copied = 'none';
      try {
        if (plan.text) {
          await navigator.clipboard.writeText(plan.text);
          copied = plan.kind;
        }
      } catch {
        copied = 'none';
      }
      setNote(summaryShareNote(result, customer, copied));
      setChatLink(result.status === 'opened' ? '' : result.url);
    } catch (err) {
      whatsappOpener.cancel(begun);
      setNote(err.message || 'The summary could not be downloaded.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card followup-summary">
      <h2>Receivable summary</h2>
      <p className="hint">
        Separate from the reminder list. Filter by status, pick a customer, preview, then download.
        Quantity and delivery fee come from each invoice and are remembered for the next preview.
        Credit notes are not included.
      </p>
      <div className="chips followup-summary-statuses" role="group" aria-label="Invoice status">
        {STATUS_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={statuses.includes(option.id) ? 'chip chip-active' : 'chip'}
            aria-pressed={statuses.includes(option.id)}
            onClick={() => toggleStatus(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
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
        <label className="filter-field followup-summary-customer">
          <span className="field-label">Customer</span>
          <div className="name-suggest">
            <input
              aria-label="Customer for the summary"
              placeholder="Type a name"
              value={customer}
              onChange={(event) => {
                setCustomer(event.target.value);
                setShowSuggestions(true);
              }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              autoComplete="off"
            />
            {showSuggestions && customer.trim() && (
              <ul className="name-suggest-list" role="listbox">
                {suggesting && <li><p className="hint">Searching…</p></li>}
                {!suggesting && suggestions.length === 0 && (
                  <li><p className="hint">No matching customer</p></li>
                )}
                {suggestions.map((row) => (
                  <li key={row.customerId || row.customerName}>
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setCustomer(row.customerName);
                        setShowSuggestions(false);
                      }}
                    >
                      <strong>{row.customerName}</strong>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </label>
        <label className="filter-field followup-summary-name">
          <span className="field-label">File name</span>
          <input
            aria-label="Receivable summary file name"
            placeholder="Receivable-Summary"
            value={fileName}
            onChange={(event) => setFileName(event.target.value)}
            autoComplete="off"
          />
        </label>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onPreview}>
          {busy ? 'Loading…' : 'Preview'}
        </button>
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
      {previewUrl && (
        <div className="followup-preview followup-summary-preview">
          <div className="title-row followup-preview-head">
            <p className="hint">
              {previewMeta?.invoiceCount
                ? `${previewMeta.invoiceCount.toLocaleString('id-ID')} invoice${previewMeta.invoiceCount === 1 ? '' : 's'} · ${formatRupiah(previewMeta.total)}`
                : 'PDF preview'}
            </p>
            <a className="btn btn-secondary" href={previewUrl} target={PDF_TAB} rel="opener">
              Open preview
            </a>
          </div>
          <div className="viewer-scroll followup-preview-frame followup-summary-frame">
            <div className="viewer-stage">
              <iframe title="Receivable summary preview" src={`${previewUrl}#view=FitH`} />
            </div>
          </div>
        </div>
      )}
      {note && <p className={noteIsBad(note) ? 'message message-bad' : 'hint'}>{note}</p>}
      {chatLink && (
        <p className="hint">
          <a href={chatLink} target={WHATSAPP_TAB} rel="opener">Open WhatsApp</a>
          {' '}if that tab was closed.
        </p>
      )}
    </section>
  );
}
