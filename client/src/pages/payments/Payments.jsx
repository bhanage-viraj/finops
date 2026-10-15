import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchPayments, uploadPayments } from '../../api/payments.js';
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

function rowLabel(payment) {
  return payment.confirmed?.customerName || payment.ai?.sender || payment.originalName || 'Screenshot';
}

export default function Payments() {
  const navigate = useNavigate();
  const [payments, setPayments] = useState([]);
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

  async function onUpload(event) {
    const files = [...(event.target.files || [])];
    event.target.value = '';
    if (!files.length || busy) return;
    setBusy(true);
    setError('');
    setMessage('Saving…');
    try {
      const prepared = [];
      for (const file of files) prepared.push(await compressImage(file));
      const result = await uploadPayments(prepared);
      const saved = result.payments || [];
      const rejected = result.rejected?.length || 0;
      if (saved.length === 1 && rejected === 0) {
        setMessage('Saved. Opening so you can find the customer while it reads…');
        navigate(`/payments/${saved[0].id}`);
        return;
      }
      setMessage(rejected
        ? `${saved.length} saved. ${rejected} failed: ${result.rejected.map((r) => r.error).join(' ')}`
        : `${saved.length} saved. Open one to find the customer while AI reads.`);
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

  return (
    <>
      <div className="page-head">
        <h1>Payments</h1>
      </div>

      <section className="card capture-card">
        <label className="btn btn-primary">
          {busy ? 'Saving…' : 'Upload screenshot'}
          <input type="file" accept="image/*" multiple disabled={busy} onChange={onUpload} />
        </label>
        <p className="hint">
          Upload is quick. While AI reads the bank screenshot, open the payment and type the customer name — you do not need to wait.
        </p>
      </section>

      {error && <p className="message message-bad">{error}</p>}
      {message && <p className="message message-ok">{message}</p>}
      {readingCount > 0 && (
        <p className="message message-warn">
          {readingCount} screenshot{readingCount === 1 ? '' : 's'} reading in the background. You can open and match customers now.
        </p>
      )}

      {open.length === 0 ? (
        <p className="hint">No open payments.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Customer / sender</th>
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
                        ? 'Tap to find customer while it reads'
                        : formatWhen(payment.ai?.paidAt)}
                    </div>
                  </td>
                  <td>
                    {isReading(payment.status) && payment.amountReceived == null
                      ? <span className="payment-pulse-text">Reading…</span>
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
                  <th>Customer / sender</th>
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
