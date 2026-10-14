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
  const [suggestions, setSuggestions] = useState([]);
  const [suggesting, setSuggesting] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [siteNote, setSiteNote] = useState('');
  const [invoiceHint, setInvoiceHint] = useState('');
  const [paidAt, setPaidAt] = useState('');
  const [amount, setAmount] = useState('');
  const [overReason, setOverReason] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [statementChecked, setStatementChecked] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const suggestSeq = useRef(0);

  async function load() {
    const body = await fetchPayment(id);
    const row = body.payment;
    setPayment(row);
    setOverReason(row.overpaymentReason || '');
    setStatementChecked(Boolean(row.statementVerified));
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
    return () => {
      setImageUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return '';
      });
    };
  }, [id]);

  // Keyword → unpaid Zoho invoices whose customer name (or invoice #) contains it.
  useEffect(() => {
    if (!canReview) return undefined;
    const q = customerName.trim();
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
  }, [customerName, canReview]);

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
    setCustomerName(row.customerName || '');
    setInvoiceHint(row.invoiceNo || '');
    setShowSuggestions(false);
    setSuggestions([]);
    await run(async () => {
      await updatePaymentHints(id, {
        customerName: row.customerName || '',
        siteNote,
        invoiceHint: row.invoiceNo || '',
        paidAt: paidAt || undefined,
        amount: amount || undefined,
      });
      await matchPayment(id, { invoiceId: row.id });
      setMessage(`Linked ${row.invoiceNo} · ${row.customerName}. Check the bank statement, then Record Payment.`);
    });
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
              <div className="name-suggest">
                <label>
                  Customer name (from caption)
                  <input
                    value={customerName}
                    onChange={(event) => {
                      setCustomerName(event.target.value);
                      setShowSuggestions(true);
                    }}
                    onFocus={() => setShowSuggestions(true)}
                    onBlur={() => {
                      // Allow click on a suggestion before closing.
                      setTimeout(() => setShowSuggestions(false), 150);
                    }}
                    placeholder="Type a keyword, e.g. form"
                    autoComplete="off"
                  />
                </label>
                {showSuggestions && customerName.trim().length >= 2 && (
                  <div>
                    {suggesting && <p className="hint">Searching unpaid invoices…</p>}
                    {!suggesting && suggestions.length === 0 && (
                      <p className="hint">No unpaid customer or invoice matches that keyword.</p>
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
                                {row.invoiceNo} · {formatRupiah(row.remaining)} due
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
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
            <p className="hint">No invoice linked yet. Type a customer keyword above to pick an unpaid invoice.</p>
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
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={statementChecked}
                  disabled={busy || !payment.matchedInvoiceId}
                  onChange={(event) => setStatementChecked(event.target.checked)}
                />
                I checked this transfer on the bank statement
              </label>
              {!payment.matchedInvoiceId && (
                <p className="hint">Link an unpaid invoice (type a customer keyword above) before recording.</p>
              )}

              {(payment.matchType === 'over' || amountExcess > 0) && (
                <label>
                  Excess / overpayment reason (required — payment is larger than amount due)
                  <input
                    value={overReason}
                    onChange={(event) => setOverReason(event.target.value)}
                    placeholder="Why is the transfer larger than the invoice?"
                  />
                </label>
              )}

              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !payment.matchedInvoiceId}
                onClick={() => run(async () => {
                  if (!payment.matchedInvoiceId) {
                    throw new Error('Link an unpaid Zoho invoice first.');
                  }
                  if (!statementChecked) {
                    throw new Error('Tick “I checked this transfer on the bank statement” before recording.');
                  }
                  const isOver = payment.matchType === 'over' || amountExcess > 0;
                  if (isOver && !String(overReason || '').trim()) {
                    throw new Error('This payment is over the invoice balance — enter an excess reason.');
                  }
                  if (!payment.statementVerified) {
                    await verifyPayment(id);
                  }
                  await approvePayment(id, { overpaymentReason: overReason });
                  setMessage('Recorded in Zoho Payments Received. Invoice marked paid or partial.');
                })}
              >
                Record Payment in Zoho
              </button>
              <p className="hint">
                Creates a Payments Received entry and marks the invoice paid or partial. Screenshot alone is not enough — confirm the statement checkbox.
              </p>

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
