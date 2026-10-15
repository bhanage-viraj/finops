import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  approvePayment,
  fetchOpenInvoices,
  fetchPayment,
  fetchPaymentFile,
  matchPayment,
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

function isReading(status) {
  return status === 'uploaded' || status === 'processing';
}

function ReadSteps({ status, hasMatch, hasAmount }) {
  const step = status === 'failed' ? 0
    : status === 'uploaded' ? 1
      : status === 'processing' ? 2
        : hasAmount || hasMatch ? 3 : 2;
  const items = [
    { n: 1, label: 'Saved' },
    { n: 2, label: 'Reading screenshot' },
    { n: 3, label: 'Ready to record' },
  ];
  return (
    <ol className="payment-steps" aria-label="Payment progress">
      {items.map((item) => {
        const done = step > item.n || (step === item.n && item.n === 3);
        const active = step === item.n && item.n < 3;
        return (
          <li
            key={item.n}
            className={`payment-step${done ? ' is-done' : ''}${active ? ' is-active' : ''}`}
          >
            <span className="payment-step-mark" aria-hidden="true">{done ? '✓' : item.n}</span>
            <span>{item.label}{active ? '…' : ''}</span>
          </li>
        );
      })}
    </ol>
  );
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
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const suggestSeq = useRef(0);
  const startedAt = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);

  async function load({ withFile = true } = {}) {
    const body = await fetchPayment(id);
    const row = body.payment;
    setPayment(row);
    setQuery((prev) => prev || row.confirmed?.customerName || row.invoice?.customer?.name || '');
    if (!withFile) return;
    const file = await fetchPaymentFile(id);
    setImageUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file.blob);
    });
  }

  useEffect(() => {
    startedAt.current = Date.now();
    load().catch((err) => setError(err.message));
    return () => {
      setImageUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return '';
      });
    };
  }, [id]);

  useEffect(() => {
    if (!payment || !isReading(payment.status)) return undefined;
    const timer = setInterval(() => {
      fetchPayment(id)
        .then((body) => {
          setPayment(body.payment);
          if (body.payment.confirmed?.customerName) {
            setQuery((prev) => prev || body.payment.confirmed.customerName);
          }
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [id, payment?.status]);

  useEffect(() => {
    if (!payment || !isReading(payment.status)) {
      setElapsed(0);
      return undefined;
    }
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [payment?.status]);

  useEffect(() => {
    if (!canReview || payment?.status === 'approved') return undefined;
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
  }, [query, canReview, payment?.status]);

  async function run(action) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
      await load({ withFile: false });
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
      setMessage(isReading(payment?.status)
        ? 'Customer saved. Amount will fill in when reading finishes.'
        : 'Customer matched.');
    });
  }

  if (!payment && !error) return <p className="hint">Loading…</p>;
  if (!payment) return <p className="message message-bad">{error}</p>;

  const invoice = payment.invoice;
  const reading = isReading(payment.status);
  const canFindCustomer = canReview && !['approved', 'rejected', 'failed'].includes(payment.status);
  const canRecord = canReview
    && !reading
    && !['approved', 'rejected', 'failed'].includes(payment.status)
    && Boolean(payment.matchedInvoiceId);
  const amount = payment.amountReceived ?? payment.ai?.amount;
  const hasAmount = amount != null;

  return (
    <>
      <p><Link to="/payments">← Payments</Link></p>
      <div className="page-head">
        <h1>Payment</h1>
        <StatusBadge status={payment.status} />
      </div>

      {error && <p className="message message-bad">{error}</p>}
      {message && <p className="message message-ok">{message}</p>}
      {payment.status === 'failed' && payment.failureMessage && (
        <p className="message message-bad">{payment.failureMessage}</p>
      )}

      {(reading || payment.status === 'read' || payment.status === 'matched') && (
        <section className="card payment-progress-card">
          <ReadSteps
            status={payment.status}
            hasMatch={Boolean(payment.matchedInvoiceId)}
            hasAmount={hasAmount}
          />
          {reading && (
            <p className="hint">
              AI is reading the bank screenshot{elapsed > 0 ? ` (${elapsed}s)` : ''}.
              Find the customer below now — do not wait for the amount.
            </p>
          )}
          {!reading && payment.matchedInvoiceId && hasAmount && (
            <p className="hint">Ready. Check the amount, then record in Zoho.</p>
          )}
        </section>
      )}

      <div className="review-grid payment-match-grid">
        <section className="card">
          {imageUrl ? (
            <img className="payment-shot" src={imageUrl} alt="Bank transfer screenshot" />
          ) : (
            <div className="payment-shot-skeleton" aria-hidden="true" />
          )}
          <dl className="field-list">
            <div>
              <dt>From bank</dt>
              <dd className={!payment.ai?.sender && reading ? 'payment-pulse-text' : undefined}>
                {payment.ai?.sender || (reading ? 'Reading…' : '—')}
              </dd>
            </div>
            <div>
              <dt>Amount</dt>
              <dd className={!hasAmount && reading ? 'payment-pulse-text' : undefined}>
                {hasAmount ? formatRupiah(amount) : (reading ? 'Reading…' : '—')}
              </dd>
            </div>
            <div>
              <dt>Time</dt>
              <dd className={!payment.ai?.paidAt && reading ? 'payment-pulse-text' : undefined}>
                {payment.ai?.paidAt ? formatWhen(payment.ai.paidAt) : (reading ? 'Reading…' : '—')}
              </dd>
            </div>
          </dl>
        </section>

        <section className="card">
          {canFindCustomer && (
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
                  placeholder="Type a name while it reads…"
                  autoComplete="off"
                  autoFocus={reading}
                />
              </label>
              {reading && (
                <p className="hint">You can pick the customer before the AI finishes.</p>
              )}
              {showSuggestions && query.trim().length >= 2 && (
                <div>
                  {suggesting && <p className="hint">Searching…</p>}
                  {!suggesting && suggestions.length === 0 && <p className="hint">No match</p>}
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
          )}

          {invoice ? (
            <dl className="field-list">
              <div><dt>Invoice</dt><dd>{invoice.invoiceNo}</dd></div>
              <div><dt>Customer</dt><dd>{invoice.customer?.name || '—'}</dd></div>
              <div><dt>Due</dt><dd>{formatRupiah(invoice.remaining)}</dd></div>
            </dl>
          ) : canFindCustomer ? (
            <p className="hint">{reading ? 'Pick a customer now.' : 'Pick a customer.'}</p>
          ) : null}

          {canRecord && (
            <div className="stack-form">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !payment.matchedInvoiceId || !hasAmount}
                onClick={() => run(async () => {
                  if (!payment.matchedInvoiceId) throw new Error('Pick a customer first.');
                  if (!hasAmount) throw new Error('Wait for the amount to finish reading.');
                  if (!payment.statementVerified) await verifyPayment(id);
                  await approvePayment(id, {});
                  setMessage('Recorded in Zoho.');
                })}
              >
                {busy ? 'Recording…' : 'Record in Zoho'}
              </button>
              {!hasAmount && (
                <p className="hint">Record unlocks when the amount is read.</p>
              )}
            </div>
          )}

          {reading && payment.matchedInvoiceId && (
            <p className="message message-ok">
              Customer ready. Record unlocks when the amount appears.
            </p>
          )}

          {payment.status === 'approved' && (
            <p className="message message-ok">Saved in Zoho.</p>
          )}
        </section>
      </div>
    </>
  );
}
