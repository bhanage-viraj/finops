import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  approvePayment,
  deletePayment,
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

/** Zoho invoice date "2026-09-29" → "29/09/2026". */
function formatDay(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '—';
}

function oldestFirst(a, b) {
  const byDay = String(a.date || a.dueDate || '').localeCompare(String(b.date || b.dueDate || ''));
  return byDay || String(a.invoiceNo || '').localeCompare(String(b.invoiceNo || ''));
}

function ReadSteps({ status, hasMatch, hasAmount }) {
  const step = status === 'failed' ? 0
    : status === 'uploaded' ? 1
      : status === 'processing' ? 2
        : hasAmount || hasMatch ? 3 : 2;
  const items = [
    { n: 1, label: 'Saved' },
    { n: 2, label: 'Reading amount' },
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
  const navigate = useNavigate();
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
  const [customerInvoices, setCustomerInvoices] = useState([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [ticked, setTicked] = useState(() => new Set());

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

  function seedQuery(row) {
    // WhatsApp caption first — bank sender is often a different person.
    const name = row.confirmed?.customerName
      || row.invoice?.customer?.name
      || row.ai?.sender
      || '';
    if (name) setQuery((prev) => prev || name);
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
          seedQuery(body.payment);
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [id, payment?.status]);

  useEffect(() => {
    if (!payment || isReading(payment.status)) return;
    seedQuery(payment);
  }, [payment?.status, payment?.ai?.sender, payment?.confirmed?.customerName, payment?.matchedInvoiceId]);

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
          if (!payment?.matchedInvoiceId && (body.invoices || []).length > 0) {
            setShowSuggestions(true);
          }
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
  }, [query, canReview, payment?.status, payment?.matchedInvoiceId]);

  const matchedCustomerId = payment?.matchedCustomerId || '';
  const matchedCustomerName = payment?.invoice?.customer?.name || '';
  const allocationKey = (payment?.allocations || []).map((row) => row.invoiceId).join(',');

  // All unpaid invoices of the matched customer, oldest first, for the tick list.
  useEffect(() => {
    if (!canReview || !matchedCustomerId || !matchedCustomerName) {
      setCustomerInvoices([]);
      return undefined;
    }
    let cancelled = false;
    setLoadingInvoices(true);
    fetchOpenInvoices(matchedCustomerName)
      .then((body) => {
        if (cancelled) return;
        const rows = (body.invoices || [])
          .filter((row) => String(row.erpCustomerId) === String(matchedCustomerId))
          .sort(oldestFirst);
        setCustomerInvoices(rows);
      })
      .catch(() => {
        if (!cancelled) setCustomerInvoices([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingInvoices(false);
      });
    return () => { cancelled = true; };
  }, [canReview, matchedCustomerId, matchedCustomerName, payment?.status === 'approved']);

  // Ticks follow the saved split whenever it changes on the server.
  useEffect(() => {
    setTicked(new Set(allocationKey ? allocationKey.split(',') : []));
  }, [allocationKey]);

  function toggleTick(invoiceId) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(invoiceId)) next.delete(invoiceId);
      else next.add(invoiceId);
      return next;
    });
  }

  async function applyTicked() {
    if (!ticked.size) return;
    await run(async () => {
      await matchPayment(id, { invoiceIds: [...ticked] });
      setMessage(ticked.size > 1 ? `${ticked.size} invoices linked to this transfer.` : 'Invoice changed.');
    });
  }

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
      setMessage('Customer matched.');
    });
  }

  async function onDelete() {
    if (!window.confirm('Delete this payment and its screenshot? This cannot be undone.')) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await deletePayment(id);
      navigate('/payments');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  if (!payment && !error) return <p className="hint">Loading…</p>;
  if (!payment) return <p className="message message-bad">{error}</p>;

  const invoice = payment.invoice;
  const reading = isReading(payment.status);
  const whatsappName = payment.confirmed?.customerName || '';
  const bankSender = payment.ai?.sender || '';
  const namesDiffer = Boolean(
    whatsappName
    && bankSender
    && whatsappName.trim().toLowerCase() !== bankSender.trim().toLowerCase(),
  );
  const canFindCustomer = canReview && !['approved', 'rejected', 'failed'].includes(payment.status);
  const canRecord = canReview
    && !reading
    && !['approved', 'rejected', 'failed'].includes(payment.status)
    && Boolean(payment.matchedInvoiceId);
  const canDelete = !reading && !payment.zohoPaymentId;
  const amount = payment.amountReceived ?? payment.ai?.amount;
  const hasAmount = amount != null;
  const adminFee = payment.ai?.adminFee || payment.bankFee || 0;
  const allocations = payment.allocations || [];
  const appliedById = new Map(allocations.map((row) => [String(row.invoiceId), row.applied]));
  const shortBy = allocations.reduce((total, row) => total + Math.max(0, row.remaining - row.applied), 0);
  const tickedRows = customerInvoices.filter((row) => ticked.has(String(row.id)));
  const tickedTotal = tickedRows.reduce((total, row) => total + row.remaining, 0);
  const currentIds = allocations.map((row) => String(row.invoiceId)).sort().join(',');
  const tickedIds = [...ticked].sort().join(',');
  const tickChanged = ticked.size > 0 && tickedIds !== currentIds;
  const matchNote = (payment.matchReasons || [])[0] || '';

  return (
    <>
      <p><Link to="/payments">← Payments</Link></p>
      <div className="page-head">
        <div className="title-row">
          <h1>Payment</h1>
          <StatusBadge status={payment.status} />
        </div>
        {canDelete && (
          <div className="page-actions">
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={onDelete}>
              Delete
            </button>
          </div>
        )}
      </div>

      {error && <p className="message message-bad">{error}</p>}
      {message && <p className="message message-ok">{message}</p>}
      {payment.status === 'failed' && payment.failureMessage && (
        <p className="message message-bad">{payment.failureMessage}</p>
      )}

      {reading && (
        <section className="card payment-progress-card">
          <ReadSteps
            status={payment.status}
            hasMatch={Boolean(payment.matchedInvoiceId)}
            hasAmount={hasAmount}
          />
          <p className="hint">
            {whatsappName
              ? `Matching “${whatsappName}” in Zoho while reading the screenshot`
              : 'Reading screenshot'}
            {elapsed > 0 ? ` (${elapsed}s)` : ''}…
          </p>
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
              <dt>WhatsApp name</dt>
              <dd>{whatsappName || '—'}</dd>
            </div>
            <div>
              <dt>Bank sender</dt>
              <dd className={!bankSender && reading ? 'payment-pulse-text' : undefined}>
                {bankSender || (reading ? 'Reading…' : '—')}
              </dd>
            </div>
            {namesDiffer && (
              <div>
                <dt />
                <dd className="hint payment-name-note">
                  Bank sender can differ from the shop name — Zoho match uses the WhatsApp name.
                </dd>
              </div>
            )}
            <div>
              <dt>Received</dt>
              <dd className={!hasAmount && reading ? 'payment-pulse-text' : undefined}>
                {hasAmount ? formatRupiah(amount) : (reading ? 'Reading…' : '—')}
              </dd>
            </div>
            {adminFee > 0 && (
              <div>
                <dt>Bank fee</dt>
                <dd>
                  {formatRupiah(adminFee)}
                  <span className="hint"> · paid by sender, not recorded</span>
                </dd>
              </div>
            )}
            {payment.ai?.total != null && payment.ai.total !== amount && (
              <div>
                <dt>Total transfer</dt>
                <dd>{formatRupiah(payment.ai.total)}</dd>
              </div>
            )}
            <div>
              <dt>Time</dt>
              <dd className={!payment.ai?.paidAt && reading ? 'payment-pulse-text' : undefined}>
                {payment.ai?.paidAt ? formatWhen(payment.ai.paidAt) : (reading ? 'Reading…' : '—')}
              </dd>
            </div>
            {payment.ai?.transferMethod && (
              <div>
                <dt>Method</dt>
                <dd>{payment.ai.transferMethod}</dd>
              </div>
            )}
            {payment.ai?.reference && (
              <div>
                <dt>Ref</dt>
                <dd>{payment.ai.reference}</dd>
              </div>
            )}
            {payment.ai?.note && (
              <div>
                <dt>Remark</dt>
                <dd>{payment.ai.note}</dd>
              </div>
            )}
          </dl>
        </section>

        <section className="card">
          {invoice && (
            <dl className="field-list">
              <div><dt>Customer</dt><dd>{invoice.customer?.name || '—'}</dd></div>
              <div>
                <dt>Paying</dt>
                <dd>
                  {allocations.length > 1 ? `${allocations.filter((row) => row.applied > 0).length} invoices` : invoice.invoiceNo}
                  {payment.amountApplied != null ? ` · ${formatRupiah(payment.amountApplied)}` : ''}
                </dd>
              </div>
              <div><dt>Zoho mode</dt><dd>Bank Transfer</dd></div>
            </dl>
          )}

          {invoice && matchNote && <p className="hint payment-match-note">{matchNote}</p>}
          {invoice && hasAmount && shortBy > 0 && (
            <p className="message message-warn">
              {formatRupiah(shortBy)} still unpaid on the ticked invoices — Zoho keeps that part open.
            </p>
          )}
          {invoice && payment.amountExcess > 0 && (
            <p className="message message-warn">
              {formatRupiah(payment.amountExcess)} more than the ticked invoices — Zoho keeps it as customer credit.
            </p>
          )}

          {invoice && (customerInvoices.length > 0 || allocations.length > 0) && (
            <div className="payment-invoice-pick">
              <div className="title-row">
                <p className="field-label">Tick the invoices this transfer pays</p>
                {canFindCustomer && customerInvoices.length > 1 && (
                  <div className="actions payment-tick-tools">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => setTicked(new Set(customerInvoices.map((row) => String(row.id))))}
                    >
                      Select all
                    </button>
                    <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setTicked(new Set())}>
                      Clear
                    </button>
                  </div>
                )}
              </div>
              {loadingInvoices && <p className="hint">Loading this customer&apos;s unpaid invoices…</p>}
              <div className="table-wrap">
                <table className="payment-alloc-table">
                  <thead>
                    <tr>
                      <th aria-label="Pay" />
                      <th>Invoice</th>
                      <th>Date</th>
                      <th className="num">Balance</th>
                      <th className="num">Paying</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(customerInvoices.length ? customerInvoices : allocations.map((row) => ({
                      id: row.invoiceId, invoiceNo: row.invoiceNo, date: row.date, remaining: row.remaining,
                    }))).map((row) => {
                      const key = String(row.id);
                      const applied = appliedById.get(key);
                      return (
                        <tr key={key} className={ticked.has(key) ? 'row-selected' : undefined}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`Pay ${row.invoiceNo}`}
                              checked={ticked.has(key)}
                              disabled={busy || !canFindCustomer}
                              onChange={() => toggleTick(key)}
                            />
                          </td>
                          <td>{row.invoiceNo}</td>
                          <td>{formatDay(row.date)}</td>
                          <td className="num">{formatRupiah(row.remaining)}</td>
                          <td className="num">
                            {applied == null || tickChanged ? '—' : (
                              applied >= row.remaining ? formatRupiah(applied)
                                : (applied > 0 ? `${formatRupiah(applied)} (part)` : 'Not reached')
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="hint">
                Ticked {ticked.size} · {formatRupiah(tickedTotal)}
                {hasAmount ? ` · received ${formatRupiah(amount)}` : ''}
                {hasAmount && tickedTotal && tickedTotal !== amount
                  ? (tickedTotal > amount
                    ? ` · ${formatRupiah(tickedTotal - amount)} short, oldest paid first`
                    : ` · ${formatRupiah(amount - tickedTotal)} extra stays as credit`)
                  : ''}
              </p>
              {canFindCustomer && tickChanged && (
                <button type="button" className="btn btn-primary" disabled={busy} onClick={applyTicked}>
                  {busy ? 'Saving…' : `Use ${ticked.size} ticked invoice${ticked.size === 1 ? '' : 's'}`}
                </button>
              )}
            </div>
          )}

          {canFindCustomer && !invoice && (
            <div className="name-suggest">
              <label>
                Find customer in Zoho
                <input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setShowSuggestions(true);
                  }}
                  onFocus={() => setShowSuggestions(true)}
                  onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                  placeholder="Customer name from WhatsApp"
                  autoComplete="off"
                />
              </label>
              {showSuggestions && query.trim().length >= 2 && (
                <div>
                  {suggesting && <p className="hint">Searching…</p>}
                  {!suggesting && suggestions.length === 0 && <p className="hint">No unpaid invoice match</p>}
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

          {canFindCustomer && invoice && (
            <details className="payment-change-customer">
              <summary>Wrong customer? Change</summary>
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
                    placeholder="Customer name"
                    autoComplete="off"
                  />
                </label>
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
            </details>
          )}

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
                  setMessage('Recorded in Zoho as Bank Transfer.');
                })}
              >
                {busy
                  ? 'Recording…'
                  : (hasAmount ? `Record ${formatRupiah(amount)} Bank Transfer in Zoho` : 'Record Bank Transfer in Zoho')}
              </button>
              {!hasAmount && (
                <p className="hint">Record unlocks when the amount is read from the screenshot.</p>
              )}
            </div>
          )}

          {payment.status === 'approved' && (
            <p className="message message-ok">Saved in Zoho as Bank Transfer.</p>
          )}
        </section>
      </div>
    </>
  );
}
