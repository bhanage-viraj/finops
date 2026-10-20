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

// Same limit the server uses to treat a small surplus as the sender's bank fee.
const MAX_BANK_FEE = 6500;

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

function parseInvoiceNumbers(text) {
  const found = [];
  for (const match of String(text || '').matchAll(/\bINV[-\s]?(\d{3,})\b/gi)) {
    const no = `INV-${match[1]}`;
    if (!found.includes(no)) found.push(no);
  }
  return found;
}

/** Merge open-invoice lists by id. First source wins for each invoice. */
function mergeOpenInvoiceRows(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const row of list || []) {
      const id = String(row.id || row.invoiceId || '').trim();
      if (!id || byId.has(id)) continue;
      const remaining = Number(row.remaining);
      if (!Number.isFinite(remaining) || remaining <= 0) continue;
      byId.set(id, {
        id,
        invoiceNo: row.invoiceNo || row.invoiceNumber || '',
        date: row.date || null,
        dueDate: row.dueDate || null,
        remaining,
        erpCustomerId: row.erpCustomerId || row.customerId || '',
        customerName: row.customerName || '',
      });
    }
  }
  return [...byId.values()].sort(oldestFirst);
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
  const allocationKey = (payment?.allocations || []).map((row) => row.invoiceId).join(',');
  const openInvoiceKey = (payment?.customerOpenInvoices || []).map((row) => row.id).join(',');
  const candidateKey = (payment?.candidates || []).map((row) => row.invoiceId).join(',');
  const closed = ['approved', 'rejected'].includes(payment?.status);

  // Prefer the full unpaid list embedded on the payment detail (live Zoho).
  // Fall back to matcher candidates, then a customerId refresh — never amount-only allocations.
  useEffect(() => {
    if (!canReview || closed || !matchedCustomerId) {
      setCustomerInvoices([]);
      setLoadingInvoices(false);
      return undefined;
    }

    const fromDetail = (payment?.customerOpenInvoices || [])
      .filter((row) => Number(row.remaining) > 0)
      .sort(oldestFirst);
    if (fromDetail.length) {
      setCustomerInvoices(fromDetail);
      setLoadingInvoices(false);
      return undefined;
    }

    const seeded = (payment?.candidates || [])
      .filter((row) => !row.customerId || String(row.customerId) === String(matchedCustomerId))
      .map((row) => ({
        id: row.invoiceId,
        invoiceNo: row.invoiceNo,
        date: row.date || null,
        dueDate: row.dueDate || null,
        remaining: row.remaining,
        erpCustomerId: row.customerId || matchedCustomerId,
        customerName: row.customerName || '',
      }))
      .sort(oldestFirst);
    if (seeded.length) {
      setCustomerInvoices(seeded);
      setLoadingInvoices(false);
      return undefined;
    }

    let cancelled = false;
    setLoadingInvoices(true);
    fetchOpenInvoices('', matchedCustomerId)
      .then((body) => {
        if (cancelled) return;
        const rows = (body.invoices || [])
          .filter((row) => Number(row.remaining) > 0)
          .sort(oldestFirst);
        if (rows.length) setCustomerInvoices(rows);
      })
      .catch(() => {
        // Keep the list already on screen so the accountant still sees outstanding invoices.
      })
      .finally(() => {
        if (!cancelled) setLoadingInvoices(false);
      });
    return () => { cancelled = true; };
  }, [canReview, closed, matchedCustomerId, openInvoiceKey, candidateKey]);

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
    const numbers = parseInvoiceNumbers(query);
    const sameCustomer = suggestions.filter((item) => (
      String(item.erpCustomerId || item.customerId || '') === String(row.erpCustomerId || row.customerId || '')
    ));
    const wanted = numbers.length > 1
      ? sameCustomer.filter((item) => numbers.includes(String(item.invoiceNo || '').toUpperCase()))
      : [row];
    const picked = wanted.length ? wanted : [row];
    const ids = [...new Set(picked.map((item) => String(item.id || item.invoiceId)))];
    setQuery(row.customerName || query);
    setShowSuggestions(false);
    setSuggestions([]);
    await run(async () => {
      await updatePaymentHints(id, { customerName: row.customerName || '' });
      await matchPayment(id, ids.length > 1 ? { invoiceIds: ids } : { invoiceId: ids[0] });
      setMessage(ids.length > 1
        ? `${ids.length} invoices linked from the numbers you typed.`
        : 'Invoice matched.');
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
  // Always show every unpaid invoice we know about for this customer.
  // AI may pre-tick the amount fit — that must not hide the rest of the list.
  const pickRows = mergeOpenInvoiceRows(
    payment.customerOpenInvoices,
    customerInvoices,
    (payment.candidates || []).map((row) => ({
      id: row.invoiceId,
      invoiceNo: row.invoiceNo,
      date: row.date,
      remaining: row.remaining,
      customerId: row.customerId,
      customerName: row.customerName,
    })),
    allocations.map((row) => ({
      id: row.invoiceId,
      invoiceNo: row.invoiceNo,
      date: row.date,
      remaining: row.remaining,
    })),
  );
  const tickedTotal = pickRows
    .filter((row) => ticked.has(String(row.id)))
    .reduce((total, row) => total + row.remaining, 0);
  const pickGap = hasAmount ? amount - tickedTotal : 0;
  let pickSumClass = 'message-warn';
  let pickSumText = 'Tick the invoices this transfer pays.';
  if (hasAmount && ticked.size) {
    if (pickGap === 0) {
      pickSumClass = 'message-ok';
      pickSumText = 'Exact match.';
    } else if (pickGap > 0 && pickGap <= MAX_BANK_FEE) {
      pickSumClass = 'message-ok';
      pickSumText = `Match · ${formatRupiah(pickGap)} bank fee not recorded.`;
    } else if (pickGap > 0) {
      pickSumText = `${formatRupiah(pickGap)} extra stays as customer credit.`;
    } else {
      pickSumText = `${formatRupiah(-pickGap)} short · oldest invoices paid first, last one partly.`;
    }
  }
  const currentIds = allocations.map((row) => String(row.invoiceId)).sort().join(',');
  const tickedIds = [...ticked].sort().join(',');
  const tickChanged = ticked.size > 0 && tickedIds !== currentIds;
  const matchNote = (payment.matchReasons || [])[0] || '';
  // Older payments were saved before splits existed: show the single matched invoice.
  const recordedRows = allocations.some((row) => row.applied > 0)
    ? allocations.filter((row) => row.applied > 0)
    : (invoice && payment.amountApplied != null ? [{
      invoiceId: invoice.id,
      invoiceNo: invoice.invoiceNo,
      date: null,
      remaining: invoice.remaining,
      applied: payment.amountApplied,
    }] : []);

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
              <div><dt>Zoho mode</dt><dd>Bank Transfer</dd></div>
            </dl>
          )}

          {invoice && matchNote && <p className="hint payment-match-note">{matchNote}</p>}
          {invoice && closed && recordedRows.length > 0 && (
            <div className="payment-invoice-pick">
              <p className="field-label">
                {payment.status === 'approved' ? 'Recorded in Zoho' : 'Invoices on this payment'}
              </p>
              <ul className="pay-pick-list">
                {recordedRows.map((row) => (
                  <li key={String(row.invoiceId)} className="pay-pick-row is-static">
                    <span className="pay-pick-main">
                      <strong>{row.invoiceNo || '—'}</strong>
                      <span className="hint">{row.date ? formatDay(row.date) : ''}</span>
                    </span>
                    <span className="pay-pick-amount">
                      <strong>{formatRupiah(row.applied)}</strong>
                      {row.remaining != null && row.applied < row.remaining && (
                        <span className="hint">part of {formatRupiah(row.remaining)}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              {payment.amountExcess > 0 && (
                <p className="message message-warn">
                  {formatRupiah(payment.amountExcess)} kept as customer credit in Zoho.
                </p>
              )}
            </div>
          )}

          {invoice && !closed && pickRows.length > 0 && (
            <div className="payment-invoice-pick">
              <div className="title-row">
                <p className="field-label">Unpaid invoices — tick the ones this transfer pays</p>
                {canFindCustomer && pickRows.length > 1 && (
                  <div className="actions payment-tick-tools">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => setTicked(new Set(pickRows.map((row) => String(row.id))))}
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
              {payment.customerOpenInvoicesError && !customerInvoices.length && (
                <p className="message message-warn">{payment.customerOpenInvoicesError}</p>
              )}
              <p className="hint">
                Showing all {pickRows.length} unpaid invoice{pickRows.length === 1 ? '' : 's'}
                {ticked.size ? ` · AI ticked ${ticked.size} for this amount — change ticks if wrong` : ''}
              </p>
              <ul className="pay-pick-list">
                {pickRows.map((row) => {
                  const key = String(row.id);
                  const isTicked = ticked.has(key);
                  const applied = tickChanged ? null : appliedById.get(key);
                  let payingNote = '';
                  if (isTicked && applied != null) {
                    if (applied >= row.remaining) payingNote = 'Paid in full';
                    else if (applied > 0) payingNote = `Pays ${formatRupiah(applied)} (part)`;
                    else payingNote = 'Not reached by this amount';
                  }
                  return (
                    <li key={key}>
                      <label className={`pay-pick-row${isTicked ? ' is-ticked' : ''}${canFindCustomer ? '' : ' is-locked'}`}>
                        <input
                          type="checkbox"
                          checked={isTicked}
                          disabled={busy || !canFindCustomer}
                          onChange={() => toggleTick(key)}
                        />
                        <span className="pay-pick-main">
                          <strong>{row.invoiceNo}</strong>
                          <span className="hint">{formatDay(row.date)}</span>
                        </span>
                        <span className="pay-pick-amount">
                          <strong>{formatRupiah(row.remaining)}</strong>
                          {payingNote && <span className="hint">{payingNote}</span>}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              {hasAmount && (
                <p className={`message pay-pick-sum ${pickSumClass}`}>
                  <span>Ticked {ticked.size} · <strong>{formatRupiah(tickedTotal)}</strong></span>
                  <span>Received <strong>{formatRupiah(amount)}</strong></span>
                  <span>{pickSumText}</span>
                </p>
              )}
              {canFindCustomer && tickChanged && (
                <button type="button" className="btn btn-primary pay-pick-apply" disabled={busy} onClick={applyTicked}>
                  {busy ? 'Saving…' : `Use these ${ticked.size} invoice${ticked.size === 1 ? '' : 's'}`}
                </button>
              )}
            </div>
          )}

          {canFindCustomer && (
            <div className="name-suggest">
              <label>
                Find by invoice number
                <input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setShowSuggestions(true);
                  }}
                  onFocus={() => setShowSuggestions(true)}
                  onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                  placeholder="INV-079837, or a customer name"
                  autoComplete="off"
                />
              </label>
              <p className="hint">
                Paste the invoice numbers you sent. For a group like Balinest, pick those invoices —
                you do not need each villa name.
              </p>
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
                            <strong>{row.invoiceNo || '—'}</strong>
                            <span className="hint">
                              {row.customerName || '—'} · {formatRupiah(row.remaining)}
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
