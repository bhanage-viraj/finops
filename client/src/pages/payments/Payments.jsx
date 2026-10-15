import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
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

export default function Payments() {
  const [payments, setPayments] = useState([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  function load() {
    fetchPayments()
      .then((body) => setPayments(body.payments || []))
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  async function onUpload(event) {
    const files = [...(event.target.files || [])];
    event.target.value = '';
    if (!files.length || busy) return;
    setBusy(true);
    setError('');
    setMessage('Uploading…');
    try {
      const prepared = [];
      for (const file of files) prepared.push(await compressImage(file));
      const result = await uploadPayments(prepared);
      const saved = result.payments?.length || 0;
      const rejected = result.rejected?.length || 0;
      setMessage(rejected
        ? `${saved} saved. ${rejected} failed: ${result.rejected.map((r) => r.error).join(' ')}`
        : `${saved} uploaded. Reading in the background…`);
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
          {busy ? 'Working…' : 'Upload screenshot'}
          <input type="file" accept="image/*" multiple disabled={busy} onChange={onUpload} />
        </label>
      </section>

      {error && <p className="message message-bad">{error}</p>}
      {message && <p className="message message-ok">{message}</p>}

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
                <tr key={payment.id}>
                  <td>
                    <Link to={`/payments/${payment.id}`}>
                      {payment.confirmed?.customerName || payment.ai?.sender || '—'}
                    </Link>
                    <div className="hint">{formatWhen(payment.ai?.paidAt)}</div>
                  </td>
                  <td>{formatRupiah(payment.amountReceived ?? payment.ai?.amount)}</td>
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
