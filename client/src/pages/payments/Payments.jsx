import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  approvePayment,
  fetchPayments,
  uploadPayments,
  verifyPayment,
} from '../../api/payments.js';
import StatusBadge from '../../components/StatusBadge.jsx';
import { useAuth } from '../../auth/AuthContext.jsx';
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

function isException(payment) {
  if (payment.status === 'failed' || payment.status === 'rejected') return true;
  if ((payment.flags || []).includes('possibleDuplicate') || (payment.flags || []).includes('unidentified')) return true;
  if (!payment.matchedInvoiceId && payment.status !== 'approved') return true;
  if (['partial', 'over', 'none'].includes(payment.matchType)) return true;
  if (payment.matchConfidence === 'low') return true;
  return false;
}

export default function Payments() {
  const { user } = useAuth();
  const canReview = user?.role === 'accountant' || user?.role === 'admin';
  const [payments, setPayments] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [overReasons, setOverReasons] = useState({});

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

  const suggested = useMemo(
    () => payments.filter((p) => !isException(p) && p.status !== 'approved' && p.status !== 'rejected'),
    [payments],
  );
  const exceptions = useMemo(() => payments.filter(isException), [payments]);
  const approved = useMemo(() => payments.filter((p) => p.status === 'approved'), [payments]);

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function onUpload(event) {
    const files = [...(event.target.files || [])];
    event.target.value = '';
    if (!files.length || busy) return;
    setBusy(true);
    setError('');
    setMessage('Uploading screenshots…');
    try {
      const prepared = [];
      for (const file of files) prepared.push(await compressImage(file));
      const result = await uploadPayments(prepared);
      const saved = result.payments?.length || 0;
      const rejected = result.rejected?.length || 0;
      setMessage(rejected
        ? `${saved} matched. ${rejected} need attention: ${result.rejected.map((r) => r.error).join(' ')}`
        : `${saved} screenshot${saved === 1 ? '' : 's'} read and matched.`);
      load();
    } catch (err) {
      setError(err.message || 'Upload failed.');
      setMessage('');
    } finally {
      setBusy(false);
    }
  }

  async function verifySelected() {
    if (!canReview || selected.size === 0) return;
    setBusy(true);
    setError('');
    try {
      for (const id of selected) {
        await verifyPayment(id);
      }
      setMessage('Bank statement check saved. Approve to mark the invoice paid.');
      setSelected(new Set());
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function approveSelected() {
    if (!canReview || selected.size === 0) return;
    setBusy(true);
    setError('');
    try {
      for (const id of selected) {
        const payment = payments.find((p) => p.id === id);
        const payload = {};
        if (payment?.matchType === 'over') {
          payload.overpaymentReason = overReasons[id] || '';
        }
        await approvePayment(id, payload);
      }
      setMessage('Approved. Customer payment recorded in Zoho Books.');
      setSelected(new Set());
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function row(payment) {
    const checked = selected.has(payment.id);
    return (
      <tr key={payment.id} className={checked ? 'row-selected' : undefined}>
        <td>
          {canReview && payment.status !== 'approved' && payment.status !== 'rejected' && (
            <input
              type="checkbox"
              checked={checked}
              aria-label={`Select ${payment.ai?.sender || payment.originalName}`}
              onChange={() => toggle(payment.id)}
            />
          )}
        </td>
        <td>
          <Link to={`/payments/${payment.id}`}>{payment.ai?.sender || '—'}</Link>
          <div className="hint">{payment.ai?.reference || payment.originalName}</div>
        </td>
        <td>{formatRupiah(payment.ai?.amount)}</td>
        <td>{formatWhen(payment.ai?.paidAt)}</td>
        <td>
          {payment.invoice ? (
            <>
              <Link to={`/payments/${payment.id}`}>{payment.invoice.invoiceNo}</Link>
              <div className="hint">{payment.invoice.customer?.name}</div>
            </>
          ) : '—'}
        </td>
        <td><StatusBadge status={payment.matchConfidence || 'unmatched'} /></td>
        <td>
          {payment.statementVerified
            ? <StatusBadge status="verified" />
            : <span className="hint">Not checked</span>}
        </td>
        <td>
          <StatusBadge status={payment.matchType === 'partial' || payment.matchType === 'over' ? payment.matchType : payment.status} />
          {payment.matchType === 'over' && canReview && (
            <input
              className="input-compact"
              placeholder="Overpayment reason"
              value={overReasons[payment.id] || ''}
              onChange={(event) => setOverReasons((prev) => ({ ...prev, [payment.id]: event.target.value }))}
            />
          )}
        </td>
      </tr>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Payments</h1>
          <p className="hint">
            Matches unpaid Zoho invoices from bank screenshots. Nothing is marked paid in Zoho until the bank statement is checked and an accountant approves.
          </p>
        </div>
        {canReview && (
          <div className="page-actions">
            <button type="button" className="btn btn-secondary" disabled={busy || selected.size === 0} onClick={verifySelected}>
              Mark statement checked ({selected.size})
            </button>
            <button type="button" className="btn btn-primary" disabled={busy || selected.size === 0} onClick={approveSelected}>
              Approve selected ({selected.size})
            </button>
          </div>
        )}
      </div>

      <section
        className="card capture-card"
        onDragOver={(event) => event.preventDefault()}
        onDrop={async (event) => {
          event.preventDefault();
          const files = [...event.dataTransfer.files];
          if (!files.length) return;
          const fake = { target: { files, value: '' } };
          await onUpload(fake);
        }}
      >
        <h2>Bank screenshots</h2>
        <p className="hint">Paste or drop transfer screenshots. The model reads sender, amount, time and reference, then suggests an invoice.</p>
        <label className="btn btn-primary">
          {busy ? 'Working…' : 'Upload screenshots'}
          <input type="file" accept="image/*" multiple disabled={busy} onChange={onUpload} />
        </label>
      </section>

      {error && <p className="message message-bad">{error}</p>}
      {message && <p className="message message-ok">{message}</p>}

      <h2>Suggested matches</h2>
      {suggested.length === 0 ? (
        <p className="hint">No high-confidence matches waiting.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th aria-label="Select" />
                <th>From screenshot</th>
                <th>Amount</th>
                <th>Time</th>
                <th>Matched invoice</th>
                <th>Confidence</th>
                <th>Statement</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>{suggested.map(row)}</tbody>
          </table>
        </div>
      )}

      <h2>Needs your review</h2>
      {exceptions.length === 0 ? (
        <p className="hint">No exceptions right now.</p>
      ) : (
        <div className="card">
          <ul className="exception-list">
            {exceptions.map((payment) => (
              <li key={payment.id}>
                <div>
                  <strong>{payment.ai?.sender || payment.originalName || 'Unread screenshot'}</strong>
                  <div className="hint">
                    {formatRupiah(payment.ai?.amount)} · {payment.matchReasons?.[0] || payment.failureMessage || 'Needs a manual match'}
                  </div>
                </div>
                <Link className="btn btn-secondary" to={`/payments/${payment.id}`}>Open</Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {approved.length > 0 && (
        <>
          <h2>Approved (in-app)</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th aria-label="Select" />
                  <th>From screenshot</th>
                  <th>Amount</th>
                  <th>Time</th>
                  <th>Matched invoice</th>
                  <th>Confidence</th>
                  <th>Statement</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>{approved.map(row)}</tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
