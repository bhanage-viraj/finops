import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  approvePayment,
  fetchOpenInvoices,
  fetchPayment,
  fetchPaymentFile,
  matchPayment,
  rejectPayment,
  verifyPayment,
} from '../../api/payments.js';
import StatusBadge from '../../components/StatusBadge.jsx';
import { useAuth } from '../../auth/AuthContext.jsx';
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

export default function PaymentDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const canReview = user?.role === 'accountant' || user?.role === 'admin';
  const [payment, setPayment] = useState(null);
  const [imageUrl, setImageUrl] = useState('');
  const [invoices, setInvoices] = useState([]);
  const [invoiceId, setInvoiceId] = useState('');
  const [overReason, setOverReason] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    const body = await fetchPayment(id);
    setPayment(body.payment);
    setInvoiceId(body.payment.matchedInvoiceId || '');
    setOverReason(body.payment.overpaymentReason || '');
    const file = await fetchPaymentFile(id);
    setImageUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file.blob);
    });
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
    if (canReview) {
      fetchOpenInvoices().then((body) => setInvoices(body.invoices || [])).catch(() => {});
    }
    return () => {
      setImageUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return '';
      });
    };
  }, [id, canReview]);

  async function run(action) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!payment && !error) return <p className="hint">Loading…</p>;
  if (!payment) return <p className="message message-bad">{error}</p>;

  const invoice = payment.invoice;

  return (
    <>
      <p><Link to="/payments">← Payments</Link></p>
      <div className="page-head">
        <div>
          <h1>Payment match</h1>
          <p className="hint">Screenshot and Zoho invoice side by side. Approve records the payment in Zoho after the statement check.</p>
        </div>
        <StatusBadge status={payment.status} />
      </div>

      {error && <p className="message message-bad">{error}</p>}
      {message && <p className="message message-ok">{message}</p>}

      <div className="review-grid payment-match-grid">
        <section className="card">
          <h2>Screenshot</h2>
          {imageUrl ? (
            <img className="payment-shot" src={imageUrl} alt="Bank transfer screenshot" />
          ) : (
            <p className="hint">Loading image…</p>
          )}
          <dl className="field-list">
            <div><dt>Sender</dt><dd>{payment.ai?.sender || '—'}</dd></div>
            <div><dt>Amount</dt><dd>{formatRupiah(payment.ai?.amount)}</dd></div>
            <div><dt>Time</dt><dd>{formatWhen(payment.ai?.paidAt)}</dd></div>
            <div><dt>Reference</dt><dd>{payment.ai?.reference || '—'}</dd></div>
            <div><dt>Recipient</dt><dd>{payment.ai?.recipient || '—'}</dd></div>
            <div><dt>Method</dt><dd>{payment.ai?.transferMethod || '—'}</dd></div>
          </dl>
        </section>

        <section className="card">
          <h2>Matched invoice</h2>
          {invoice ? (
            <dl className="field-list">
              <div><dt>Invoice</dt><dd>{invoice.invoiceNo}</dd></div>
              <div><dt>Customer</dt><dd>{invoice.customer?.name || '—'}</dd></div>
              <div><dt>Invoice total</dt><dd>{formatRupiah(invoice.amount)}</dd></div>
              <div><dt>Already paid</dt><dd>{formatRupiah(invoice.paidAmount)}</dd></div>
              <div><dt>Remaining</dt><dd>{formatRupiah(invoice.remaining)}</dd></div>
              <div><dt>Status</dt><dd><StatusBadge status={invoice.status === 'paid' ? 'confirmed' : invoice.status} /></dd></div>
              <div><dt>Due</dt><dd>{formatWhen(invoice.dueDate)}</dd></div>
            </dl>
          ) : (
            <p className="hint">No invoice linked yet. Pick one below if you can identify the payer.</p>
          )}

          <div className="match-meta">
            <StatusBadge status={payment.matchConfidence || 'unmatched'} />
            <StatusBadge status={payment.matchType || 'none'} />
            {payment.statementVerified && <StatusBadge status="verified" />}
          </div>
          {(payment.matchReasons || []).map((reason) => (
            <p key={reason} className="hint">{reason}</p>
          ))}
          {(payment.flags || []).includes('possibleDuplicate') && (
            <p className="message message-warn">Possible duplicate of another recent transfer.</p>
          )}

          {canReview && payment.status !== 'approved' && payment.status !== 'rejected' && (
            <div className="stack-form">
              <label>
                Link invoice
                <select value={invoiceId} onChange={(event) => setInvoiceId(event.target.value)}>
                  <option value="">Choose open invoice…</option>
                  {invoices.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.invoiceNo} · {row.customerName} · {formatRupiah(row.remaining)} left
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy || !invoiceId}
                onClick={() => run(async () => {
                  await matchPayment(id, { invoiceId });
                  setMessage('Zoho invoice linked. Check the bank statement, then approve to mark paid in Zoho.');
                })}
              >
                Save match
              </button>

              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy || !payment.matchedInvoiceId || payment.statementVerified}
                onClick={() => run(async () => {
                  await verifyPayment(id);
                  setMessage('Statement checked. Approve to record the payment in Zoho.');
                })}
              >
                Tick bank statement checked
              </button>

              {payment.matchType === 'over' && (
                <label>
                  Overpayment reason
                  <input value={overReason} onChange={(event) => setOverReason(event.target.value)} />
                </label>
              )}

              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || payment.status !== 'verified'}
                onClick={() => run(async () => {
                  await approvePayment(id, { overpaymentReason: overReason });
                  setMessage('Approved. Payment recorded in Zoho Books.');
                })}
              >
                Approve and mark paid in Zoho
              </button>

              <label>
                Reject reason
                <input value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} />
              </label>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy || !rejectReason.trim()}
                onClick={() => run(async () => {
                  await rejectPayment(id, rejectReason);
                  setMessage('Payment rejected.');
                })}
              >
                Reject
              </button>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
