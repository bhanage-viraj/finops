import { useEffect, useRef, useState } from 'react';
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

export default function PaymentDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const canReview = user?.role === 'accountant' || user?.role === 'admin';
  const [payment, setPayment] = useState(null);
  const [imageUrl, setImageUrl] = useState('');
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [suggesting, setSuggesting] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [statementChecked, setStatementChecked] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const suggestSeq = useRef(0);

  async function load() {
    const body = await fetchPayment(id);
    const row = body.payment;
    setPayment(row);
    setStatementChecked(Boolean(row.statementVerified));
    setQuery(row.confirmed?.customerName || '');
    const file = await fetchPaymentFile(id);
    setImageUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file.blob);
    });
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
    return () => {
      setImageUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return '';
      });
    };
  }, [id]);

  useEffect(() => {
    if (!canReview) return undefined;
    const q = query.trim();
    if (q.length < 2) {
      setSuggestions([]);
      setSuggesting(false);
      return undefined;
    }
    const seq = ++suggestSeq.current;
    setSuggesting(true);
    const timer = setTimeout(() => {
      fetchOpenInvoices(q)
        .then((body) => {
          if (seq !== suggestSeq.current) return;
          setSuggestions(body.invoices || []);
        })
        .catch(() => {
          if (seq !== suggestSeq.current) return;
          setSuggestions([]);
        })
        .finally(() => {
          if (seq === suggestSeq.current) setSuggesting(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [query, canReview]);

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

  async function pickSuggestion(row) {
    setQuery(row.customerName || '');
    setShowSuggestions(false);
    setSuggestions([]);
    await run(async () => {
      await updatePaymentHints(id, { customerName: row.customerName || '' });
      await matchPayment(id, { invoiceId: row.id });
      setMessage(`Linked ${row.invoiceNo}`);
    });
  }

  if (!payment && !error) return <p className="hint">Loading…</p>;
  if (!payment) return <p className="message message-bad">{error}</p>;

  const invoice = payment.invoice;
  const editable = canReview && payment.status !== 'approved' && payment.status !== 'rejected';
  const amount = payment.amountReceived ?? payment.ai?.amount;

  return (
    <>
      <p><Link to="/payments">← Payments</Link></p>
      <div className="page-head">
        <h1>Payment</h1>
        <StatusBadge status={payment.status} />
      </div>

      {error && <p className="message message-bad">{error}</p>}
      {message && <p className="message message-ok">{message}</p>}

      <div className="review-grid payment-match-grid">
        <section className="card">
          {imageUrl ? (
            <img className="payment-shot" src={imageUrl} alt="Bank transfer screenshot" />
          ) : (
            <p className="hint">Loading image…</p>
          )}
          <dl className="field-list">
            <div><dt>From bank</dt><dd>{payment.ai?.sender || '—'}</dd></div>
            <div><dt>Amount</dt><dd>{formatRupiah(amount)}</dd></div>
            <div><dt>Time</dt><dd>{formatWhen(payment.ai?.paidAt)}</dd></div>
            <div><dt>Ref</dt><dd>{payment.ai?.reference || '—'}</dd></div>
          </dl>
        </section>

        <section className="card">
          {editable && (
            <div className="stack-form" style={{ marginTop: 0, paddingTop: 0, borderTop: 0 }}>
              <div className="name-suggest">
                <label>
                  Find customer
                  <input
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setShowSuggestions(true);
                    }}
                    onFocus={() => setShowSuggestions(true)}
                    onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                    placeholder="Type a name…"
                    autoComplete="off"
                  />
                </label>
                {showSuggestions && query.trim().length >= 2 && (
                  <div>
                    {suggesting && <p className="hint">Searching…</p>}
                    {!suggesting && suggestions.length === 0 && (
                      <p className="hint">No match</p>
                    )}
                    {suggestions.length > 0 && (
                      <ul className="name-suggest-list" role="listbox">
                        {suggestions.map((row) => (
                          <li key={row.id}>
                            <button
                              type="button"
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => pickSuggestion(row)}
                            >
                              <strong>{row.customerName || '—'}</strong>
                              <span className="hint">
                                {row.invoiceNo} · {formatRupiah(row.remaining)}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {invoice ? (
            <dl className="field-list">
              <div><dt>Invoice</dt><dd>{invoice.invoiceNo}</dd></div>
              <div><dt>Customer</dt><dd>{invoice.customer?.name || '—'}</dd></div>
              <div><dt>Due</dt><dd>{formatRupiah(invoice.remaining)}</dd></div>
            </dl>
          ) : (
            <p className="hint">Pick a customer above.</p>
          )}

          {editable && (
            <div className="stack-form">
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={statementChecked}
                  disabled={busy || !payment.matchedInvoiceId}
                  onChange={(event) => setStatementChecked(event.target.checked)}
                />
                Checked on bank statement
              </label>

              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !payment.matchedInvoiceId}
                onClick={() => run(async () => {
                  if (!payment.matchedInvoiceId) throw new Error('Pick a customer first.');
                  if (!statementChecked) throw new Error('Tick the bank statement check first.');
                  if (!payment.statementVerified) await verifyPayment(id);
                  await approvePayment(id, {});
                  setMessage('Recorded in Zoho.');
                })}
              >
                Record in Zoho
              </button>

              <label>
                Reject
                <input
                  value={rejectReason}
                  onChange={(event) => setRejectReason(event.target.value)}
                  placeholder="Reason"
                />
              </label>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy || !rejectReason.trim()}
                onClick={() => run(async () => {
                  await rejectPayment(id, rejectReason);
                  setMessage('Rejected.');
                })}
              >
                Reject
              </button>
            </div>
          )}

          {payment.status === 'approved' && (
            <p className="message message-ok">Saved in Zoho Payments Received.</p>
          )}
        </section>
      </div>
    </>
  );
}
