import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  approvePayment,
  fetchOpenInvoices,
  fetchPayment,
  fetchPaymentFile,
  matchPayment,
  rejectPayment,
  updatePaymentHints,
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

function dateInputValue(value) {
  if (!value) return '';
  try {
    return new Date(value).toISOString().slice(0, 10);
  } catch {
    return '';
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
  const [customerName, setCustomerName] = useState('');
  const [siteNote, setSiteNote] = useState('');
  const [invoiceHint, setInvoiceHint] = useState('');
  const [paidAt, setPaidAt] = useState('');
  const [amount, setAmount] = useState('');
  const [overReason, setOverReason] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    const body = await fetchPayment(id);
    const row = body.payment;
    setPayment(row);
    setInvoiceId(row.matchedInvoiceId || '');
    setOverReason(row.overpaymentReason || '');
    setCustomerName(row.confirmed?.customerName || '');
    setSiteNote(row.confirmed?.siteNote || '');
    setInvoiceHint(row.confirmed?.invoiceHint || '');
    setPaidAt(dateInputValue(row.confirmed?.paidAt || row.ai?.paidAt));
    setAmount(row.confirmed?.amount != null ? String(row.confirmed.amount) : (row.ai?.amount != null ? String(row.ai.amount) : ''));
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
  const amountReceived = payment.amountReceived ?? payment.ai?.amount;
  const amountApplied = payment.amountApplied;
  const amountExcess = payment.amountExcess || 0;
  const editable = canReview && payment.status !== 'approved' && payment.status !== 'rejected';

  return (
    <>
      <p><Link to="/payments">← Payments</Link></p>
      <div className="page-head">
        <div>
          <h1>Record Payment</h1>
          <p className="hint">
            Match the unpaid Zoho invoice from the WhatsApp caption, check the bank statement, then Record Payment under Payments Received (marks the invoice paid or partial).
          </p>
        </div>
        <StatusBadge status={payment.status} />
      </div>

      {error && <p className="message message-bad">{error}</p>}
      {message && <p className="message message-ok">{message}</p>}

      <div className="review-grid payment-match-grid">
        <section className="card">
          <h2>Screenshot proof</h2>
          {imageUrl ? (
            <img className="payment-shot" src={imageUrl} alt="Bank transfer screenshot" />
          ) : (
            <p className="hint">Loading image…</p>
          )}
          <dl className="field-list">
            <div><dt>Bank sender (AI)</dt><dd>{payment.ai?.sender || '—'}</dd></div>
            <div><dt>Amount (AI)</dt><dd>{formatRupiah(payment.ai?.amount)}</dd></div>
            <div><dt>Time</dt><dd>{formatWhen(payment.ai?.paidAt)}</dd></div>
            <div><dt>Reference</dt><dd>{payment.ai?.reference || '—'}</dd></div>
            <div><dt>Recipient</dt><dd>{payment.ai?.recipient || '—'}</dd></div>
            <div><dt>Method</dt><dd>{payment.ai?.transferMethod || '—'}</dd></div>
          </dl>
        </section>

        <section className="card">
          <h2>Payments Received</h2>

          {editable && (
            <div className="stack-form">
              <label>
                Customer name (from caption)
                <input
                  value={customerName}
                  onChange={(event) => setCustomerName(event.target.value)}
                  placeholder="e.g. Yurike cindy"
                />
              </label>
              <label>
                Site / note (optional)
                <input
                  value={siteNote}
                  onChange={(event) => setSiteNote(event.target.value)}
                  placeholder="e.g. villa sudhamsu"
                />
              </label>
              <label>
                Invoice # hint (optional)
                <input
                  value={invoiceHint}
                  onChange={(event) => setInvoiceHint(event.target.value)}
                  placeholder="e.g. INV-065044"
                />
              </label>
              <label>
                Payment date
                <input type="date" value={paidAt} onChange={(event) => setPaidAt(event.target.value)} />
              </label>
              <label>
                Amount received (rupiah)
                <input
                  inputMode="numeric"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => run(async () => {
                  await updatePaymentHints(id, {
                    customerName,
                    siteNote,
                    invoiceHint,
                    paidAt: paidAt || undefined,
                    amount: amount || undefined,
                  });
                  setMessage('Hints saved. Match updated against Zoho unpaid invoices.');
                })}
              >
                Save caption & re-match
              </button>
            </div>
          )}

          <dl className="field-list">
            <div><dt>Customer (caption)</dt><dd>{payment.confirmed?.customerName || '—'}</dd></div>
            <div><dt>Amount received</dt><dd>{formatRupiah(amountReceived)}</dd></div>
            <div><dt>Applied to invoice</dt><dd>{formatRupiah(amountApplied)}</dd></div>
            <div><dt>Amount in excess</dt><dd>{formatRupiah(amountExcess)}</dd></div>
            <div><dt>Deposit to</dt><dd>OCBC PT TIGRIS (Zoho deposit account)</dd></div>
            <div><dt>Payment mode</dt><dd>Bank Transfer</dd></div>
          </dl>

          <h3>Matched invoice</h3>
          {invoice ? (
            <dl className="field-list">
              <div><dt>Invoice</dt><dd>{invoice.invoiceNo}</dd></div>
              <div><dt>Customer</dt><dd>{invoice.customer?.name || '—'}</dd></div>
              <div><dt>Amount due</dt><dd>{formatRupiah(invoice.remaining)}</dd></div>
              <div><dt>Status</dt><dd><StatusBadge status={invoice.status === 'paid' ? 'confirmed' : invoice.status} /></dd></div>
              <div><dt>Due</dt><dd>{formatWhen(invoice.dueDate)}</dd></div>
            </dl>
          ) : (
            <p className="hint">No invoice linked yet. Paste the caption customer name or pick an unpaid invoice.</p>
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

          {editable && (
            <div className="stack-form">
              <label>
                Link unpaid invoice
                <select value={invoiceId} onChange={(event) => setInvoiceId(event.target.value)}>
                  <option value="">Choose open invoice…</option>
                  {invoices.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.invoiceNo} · {row.customerName} · {formatRupiah(row.remaining)} due
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
                  setMessage('Zoho invoice linked. Check the bank statement, then Record Payment.');
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
                  setMessage('Statement checked. Record Payment to write Payments Received in Zoho.');
                })}
              >
                Check bank statement
              </button>

              {(payment.matchType === 'over' || amountExcess > 0) && (
                <label>
                  Excess / overpayment reason
                  <input value={overReason} onChange={(event) => setOverReason(event.target.value)} />
                </label>
              )}

              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || payment.status !== 'verified'}
                onClick={() => run(async () => {
                  await approvePayment(id, { overpaymentReason: overReason });
                  setMessage('Recorded in Zoho Payments Received. Invoice marked paid or partial.');
                })}
              >
                Record Payment in Zoho
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

          {payment.status === 'approved' && payment.zohoPaymentId && (
            <p className="message message-ok">
              Zoho payment id {payment.zohoPaymentId}. Appears under Sales → Payments Received.
            </p>
          )}
        </section>
      </div>
    </>
  );
}
