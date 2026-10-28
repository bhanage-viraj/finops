import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  fetchInvoiceSync, fetchOpenInvoices, fetchPayments, startInvoiceSync, uploadPayments,
} from '../../api/payments.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';
import { compressImage } from '../../utils/compressImage.js';
import { formatRupiah } from '../../utils/formatRupiah.js';

function formatWhen(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('id-ID', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(value);
  }
}

function isReading(status) {
  return status === 'uploaded' || status === 'processing';
}

/** WhatsApp caption → customer name (+ optional trailing site/code like 29.9). */
function parseCaption(raw) {
  const text = String(raw || '').trim().slice(0, 200);
  if (!text) return { customerName: '', siteNote: '' };
  const match = text.match(/^(.*?)(?:\s+(\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?|\d+[./]\d+))\s*$/);
  if (match && match[1].trim().length >= 2) {
    return { customerName: match[1].trim(), siteNote: match[2].trim() };
  }
  return { customerName: text, siteNote: '' };
}

function invoiceLabel(payment) {
  const paid = (payment.allocations || []).filter((row) => row.applied > 0);
  if (paid.length > 1) return `${paid[0].invoiceNo} +${paid.length - 1}`;
  return payment.invoice?.invoiceNo || '—';
}

function syncLabel(sync) {
  if (!sync) return 'Copying unpaid invoices from Zoho into the app.';
  if (sync.running && !sync.lastFullOkAt) return 'Loading unpaid invoices from Zoho into the app…';
  const count = Number.isInteger(sync.openCount) ? sync.openCount.toLocaleString('id-ID') : '0';
  const when = formatWhen(sync.lastChangesRunAt || sync.lastFullOkAt);
  if (sync.running) return `${count} unpaid invoices stored. Reading Zoho again…`;
  if (sync.lastError) return `Unpaid invoice copy failed (${sync.lastError}). Last ok: ${when}.`;
  if (sync.lastFullOkAt) return `${count} unpaid invoices stored. Last update ${when}.`;
  return 'Unpaid invoices have not been copied from Zoho yet.';
}

function InvoiceSyncLine() {
  const [sync, setSync] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function load() {
    fetchInvoiceSync()
      .then((body) => {
        setSync(body.sync || null);
        setError('');
      })
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    load();
    const timer = setInterval(load, sync?.running ? 4000 : 30000);
    return () => clearInterval(timer);
  }, [sync?.running]);

  async function onSync() {
    setBusy(true);
    setError('');
    try {
      const body = await startInvoiceSync();
      setSync(body.sync || null);
    } catch (err) {
      setError(err.message || 'Could not start a Zoho invoice sync.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="invoice-sync">
      <p className="hint">{syncLabel(sync)}</p>
      {sync?.lastFullTruncated && (
        <p className="message message-warn">Zoho has more unpaid invoices than the last full copy held.</p>
      )}
      {error && <p className="message message-bad">{error}</p>}
      <button type="button" className="btn btn-secondary" disabled={busy || sync?.running} onClick={onSync}>
        {busy || sync?.running ? 'Syncing…' : 'Sync now'}
      </button>
    </div>
  );
}

function rowLabel(payment) {
  return payment.confirmed?.customerName
    || payment.invoice?.customer?.name
    || payment.ai?.sender
    || payment.originalName
    || 'Screenshot';
}

function isPdfFile(file) {
  const type = String(file?.type || '').toLowerCase();
  const name = String(file?.name || '').toLowerCase();
  return type === 'application/pdf' || name.endsWith('.pdf');
}

function isPaymentProof(file) {
  const type = String(file?.type || '').toLowerCase();
  return type.startsWith('image/') || isPdfFile(file);
}

export default function Payments() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canWarm = user?.role === 'accountant' || user?.role === 'admin';
  const [payments, setPayments] = useState([]);
  const [caption, setCaption] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState([]);
  const [pendingPreview, setPendingPreview] = useState('');
  const [dragging, setDragging] = useState(false);
  const captionRef = useRef(null);

  function load() {
    fetchPayments()
      .then((body) => setPayments(body.payments || []))
      .catch((err) => setError(err.message));
  }

  const readingCount = payments.filter((p) => isReading(p.status)).length;

  useEffect(() => {
    load();
    const timer = setInterval(load, readingCount > 0 ? 2000 : 8000);
    return () => clearInterval(timer);
  }, [readingCount > 0]);

  // Kick the stored copy (do not wait on every unpaid invoice) so matching can use it.
  useEffect(() => {
    if (canWarm) fetchInvoiceSync().catch(() => {});
  }, [canWarm]);

  // Warm Zoho unpaid list while they paste the caption (faster match after upload).
  useEffect(() => {
    if (!canWarm) return undefined;
    const name = parseCaption(caption).customerName;
    if (name.length < 3) return undefined;
    const timer = setTimeout(() => {
      fetchOpenInvoices(name).catch(() => {});
    }, 350);
    return () => clearTimeout(timer);
  }, [caption, canWarm]);

  // Screenshots waiting for a customer name (pasted or dropped before typing it).
  useEffect(() => {
    if (!pending.length) {
      setPendingPreview('');
      return undefined;
    }
    const url = URL.createObjectURL(pending[0]);
    setPendingPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [pending]);

  function addFiles(list) {
    const files = [...(list || [])].filter(isPaymentProof);
    if (!files.length) {
      setError('Add a JPEG, PNG, WebP, or PDF payment proof.');
      return;
    }
    if (busy) return;
    setError('');
    if (parseCaption(caption).customerName.length >= 2) {
      uploadFiles(files);
      return;
    }
    setPending(files);
    setMessage('');
    captionRef.current?.focus();
  }

  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;

  // Ctrl/Cmd+V anywhere on the page takes a copied screenshot (e.g. from WhatsApp Web).
  useEffect(() => {
    function onPaste(event) {
      const items = [...(event.clipboardData?.items || [])];
      const images = items
        .filter((item) => item.kind === 'file' && (item.type.startsWith('image/') || item.type === 'application/pdf'))
        .map((item) => item.getAsFile())
        .filter(Boolean);
      if (!images.length) return;
      // Let pasted caption text still land in the input when both are copied.
      if (!event.clipboardData.getData('text/plain')) event.preventDefault();
      addFilesRef.current(images);
    }
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  function onPick(event) {
    const files = event.target.files;
    event.target.value = '';
    addFiles(files);
  }

  function onDragOver(event) {
    if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
    event.preventDefault();
    setDragging(true);
  }

  function onDragLeave(event) {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setDragging(false);
  }

  function onDrop(event) {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer?.files);
  }

  function onCaptionKey(event) {
    if (event.key === 'Enter' && pending.length && captionReady) {
      event.preventDefault();
      uploadFiles(pending);
    }
  }

  async function uploadFiles(files) {
    if (!files.length || busy) return;

    const { customerName, siteNote } = parseCaption(caption);
    if (!customerName) {
      setError('Add the WhatsApp customer name first.');
      return;
    }

    setBusy(true);
    setError('');
    setMessage('Saving…');
    try {
      const prepared = [];
      for (const file of files) prepared.push(await compressImage(file));
      const result = await uploadPayments(prepared, {
        customerName,
        ...(siteNote ? { siteNote } : {}),
      });
      const saved = result.payments || [];
      const rejected = result.rejected?.length || 0;
      setCaption('');
      setPending([]);
      if (saved.length === 1 && rejected === 0) {
        setMessage('Saved. Matching from the WhatsApp name…');
        navigate(`/payments/${saved[0].id}`);
        return;
      }
      setMessage(rejected
        ? `${saved.length} saved. ${rejected} failed: ${result.rejected.map((r) => r.error).join(' ')}`
        : `${saved.length} saved. Reading in the background.`);
      load();
    } catch (err) {
      setError(err.message || 'Upload failed.');
      setMessage('');
    } finally {
      setBusy(false);
    }
  }

  const open = payments.filter((p) => p.status !== 'approved' && p.status !== 'rejected');
  const done = payments.filter((p) => p.status === 'approved' || p.status === 'rejected');
  const captionReady = parseCaption(caption).customerName.length >= 2;

  return (
    <>
      <div className="page-head">
        <h1>Payments</h1>
        {canWarm && <InvoiceSyncLine />}
      </div>

      <section
        className={`card payment-capture${dragging ? ' is-dragging' : ''}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <h2>From WhatsApp</h2>
        <p className="hint">
          Type the customer name from the chat (example: AN Balinest, or Toko Sariboga 29.9), then add the bank transfer screenshot or PDF:
          paste it (Ctrl/Cmd+V), drag it here, or choose a file. On the payment, set the date range and Select all to take every matching villa at once.
          Zoho records one Bank Transfer per villa.
        </p>
        <label className="field">
          <span className="field-label">WhatsApp customer name</span>
          <input
            ref={captionRef}
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            onKeyDown={onCaptionKey}
            placeholder="AN Balinest"
            autoComplete="off"
            disabled={busy}
          />
        </label>

        {pending.length > 0 ? (
          <div className="payment-pending">
            {pendingPreview && (isPdfFile(pending[0]) ? (
              <iframe className="payment-shot" title="PDF waiting to upload" src={pendingPreview} />
            ) : (
              <img src={pendingPreview} alt="Screenshot waiting to upload" />
            ))}
            <div>
              <p className="hint">
                {pending.length === 1
                  ? (isPdfFile(pending[0]) ? 'PDF ready.' : 'Screenshot ready.')
                  : `${pending.length} files ready.`}
                {captionReady ? ' Press Upload or Enter.' : ' Type the customer name, then press Upload.'}
              </p>
              <div className="actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || !captionReady}
                  onClick={() => uploadFiles(pending)}
                >
                  {busy ? 'Saving…' : 'Upload'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => setPending([])}
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="payment-drop">
            <p className="hint">
              {dragging ? 'Drop the payment proof here' : 'Paste or drop the bank screenshot or PDF here'}
            </p>
            <label className={`btn btn-primary${busy ? ' is-disabled' : ''}`}>
              {busy ? 'Saving…' : 'Choose screenshot or PDF'}
              <input
                type="file"
                accept="image/*,application/pdf,.pdf"
                multiple
                disabled={busy}
                onChange={onPick}
              />
            </label>
          </div>
        )}
      </section>

      {error && <p className="message message-bad">{error}</p>}
      {message && <p className="message message-ok">{message}</p>}
      {readingCount > 0 && (
        <p className="message message-warn">
          {readingCount} reading amount from screenshot…
        </p>
      )}

      {open.length === 0 ? (
        <p className="hint">No open payments.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Amount</th>
                <th>Invoice</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {open.map((payment) => (
                <tr key={payment.id} className={isReading(payment.status) ? 'payment-reading-row' : undefined}>
                  <td>
                    <Link to={`/payments/${payment.id}`}>{rowLabel(payment)}</Link>
                    <div className="hint">
                      {isReading(payment.status)
                        ? 'Reading screenshot…'
                        : (payment.ai?.sender && payment.ai.sender !== rowLabel(payment)
                          ? `Bank: ${payment.ai.sender}`
                          : formatWhen(payment.ai?.paidAt))}
                    </div>
                  </td>
                  <td>
                    {isReading(payment.status) && payment.amountReceived == null
                      ? <span className="payment-pulse-text">…</span>
                      : formatRupiah(payment.amountReceived ?? payment.ai?.amount)}
                  </td>
                  <td>{invoiceLabel(payment)}</td>
                  <td><StatusBadge status={payment.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {done.length > 0 && (
        <>
          <h2>Done</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Amount</th>
                  <th>Invoice</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {done.map((payment) => (
                  <tr key={payment.id}>
                    <td>
                      <Link to={`/payments/${payment.id}`}>
                        {payment.confirmed?.customerName || payment.ai?.sender || '—'}
                      </Link>
                    </td>
                    <td>{formatRupiah(payment.amountReceived ?? payment.ai?.amount)}</td>
                    <td>{invoiceLabel(payment)}</td>
                    <td><StatusBadge status={payment.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
