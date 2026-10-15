import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchOpenInvoices, fetchPayments, uploadPayments } from '../../api/payments.js';
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

function rowLabel(payment) {
  return payment.confirmed?.customerName
    || payment.invoice?.customer?.name
    || payment.ai?.sender
    || payment.originalName
    || 'Screenshot';
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

  async function onUpload(event) {
    const files = [...(event.target.files || [])];
    event.target.value = '';
    if (!files.length || busy) return;

    const { customerName, siteNote } = parseCaption(caption);
    if (!customerName) {
      setError('Paste the WhatsApp customer name first, then choose the bank screenshot.');
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
      </div>

      <section className="card payment-capture">
        <h2>From WhatsApp</h2>
        <p className="hint">
          Paste the customer name from the chat (example: Toko Sariboga 29.9), then upload the bank transfer screenshot.
          Zoho records use payment mode Bank Transfer.
        </p>
        <label className="field">
          <span className="field-label">WhatsApp customer name</span>
          <input
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            placeholder="Toko Sariboga 29.9"
            autoComplete="off"
            disabled={busy}
          />
        </label>
        <div className="actions">
          <label className={`btn btn-primary${!captionReady || busy ? ' is-disabled' : ''}`}>
            {busy ? 'Saving…' : 'Upload bank screenshot'}
            <input
              type="file"
              accept="image/*"
              multiple
              disabled={busy || !captionReady}
              onChange={onUpload}
            />
          </label>
        </div>
        {!captionReady && (
          <p className="hint">Customer name is required so we can match Zoho without typing again later.</p>
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
                  <td>{payment.invoice?.invoiceNo || '—'}</td>
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
                    <td>{payment.invoice?.invoiceNo || '—'}</td>
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
