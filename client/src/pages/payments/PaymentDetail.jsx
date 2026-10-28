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
import { formatAmountInput, formatRupiah, parseRupiahInput } from '../../utils/formatRupiah.js';

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

function monthBounds(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  const iso = (day) => {
    const month = String(day.getMonth() + 1).padStart(2, '0');
    const datePart = String(day.getDate()).padStart(2, '0');
    return `${day.getFullYear()}-${month}-${datePart}`;
  };
  return { from: iso(start), to: iso(end) };
}

/** null means all dates. Custom is ignored until both ends are in order. */
function selectedRange(mode, from, to) {
  if (mode === 'month') return monthBounds();
  if (mode === 'custom' && from && to && from <= to) return { from, to };
  return null;
}

function invoiceDay(row) {
  const day = String(row.date || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '';
}

function inSelectedRange(row, range) {
  if (!range) return true;
  const day = invoiceDay(row);
  if (!day) return true;
  return day >= range.from && day <= range.to;
}

function villaKey(row) {
  return String(row.erpCustomerId || row.customerId || row.customerName || '');
}

const MAX_TICKS = 40;
const MULTI_VILLA_EXCESS = 'This transfer is more than the ticked invoices. Extra can stay as credit for one villa only — tick more invoices, or clear the other villas.';

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
  const [proofMime, setProofMime] = useState('');
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [suggesting, setSuggesting] = useState(false);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [dateMode, setDateMode] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const suggestSeq = useRef(0);
  const dateTouched = useRef(false);
  const startedAt = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [customerInvoices, setCustomerInvoices] = useState([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [ticked, setTicked] = useState(() => new Set());
  const [editingAmount, setEditingAmount] = useState(false);
  const [amountDraft, setAmountDraft] = useState('');
  const [recording, setRecording] = useState(false);

  async function load({ withFile = true } = {}) {
    const body = await fetchPayment(id);
    const row = body.payment;
    setPayment(row);
    setQuery((prev) => prev || row.confirmed?.customerName || row.invoice?.customer?.name || '');
    if (!withFile) return;
    const file = await fetchPaymentFile(id);
    setProofMime(file.mimeType || row.mimeType || '');
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
    dateTouched.current = false;
    setDateMode('all');
    setFrom('');
    setTo('');
    setEditingAmount(false);
    setAmountDraft('');
  }, [id]);

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

  const rangeFrom = payment?.invoiceDateRange?.from || '';
  const rangeTo = payment?.invoiceDateRange?.to || '';
  useEffect(() => {
    if (dateTouched.current || !payment || String(payment.id) !== String(id)) return;
    if (!rangeFrom || !rangeTo) return;
    setDateMode('custom');
    setFrom(rangeFrom);
    setTo(rangeTo);
  }, [id, payment, rangeFrom, rangeTo]);

  useEffect(() => {
    if (!canReview || payment?.status === 'approved') return undefined;
    const q = query.trim();
    if (q.length < 2) {
      setSuggestions([]);
      setSuggesting(false);
      setSearchTruncated(false);
      return undefined;
    }
    if (dateMode === 'custom' && from && to && from > to) return undefined;
    const range = selectedRange(dateMode, from, to);
    const seq = ++suggestSeq.current;
    setSuggesting(true);
    const timer = setTimeout(() => {
      fetchOpenInvoices(q, '', range || {})
        .then((body) => {
          if (seq !== suggestSeq.current) return;
          setSuggestions(body.invoices || []);
          setSearchTruncated(Boolean(body.truncated));
        })
        .catch(() => {
          if (seq !== suggestSeq.current) return;
          setSuggestions([]);
          setSearchTruncated(false);
        })
        .finally(() => {
          if (seq === suggestSeq.current) setSuggesting(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [query, canReview, payment?.status, dateMode, from, to]);

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
    if (ticked.size > MAX_TICKS) {
      setError(`One transfer can record ${MAX_TICKS} invoices. Shorten the dates or untick some.`);
      return;
    }
    const count = ticked.size;
    await run(async () => {
      await matchPayment(id, { invoiceIds: [...ticked], customerName: query.trim() });
      setMessage(count > 1 ? `${count} invoices linked to this transfer.` : 'Invoice changed.');
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

  function startAmountEdit() {
    const current = payment?.amountReceived ?? payment?.ai?.amount;
    setAmountDraft(formatAmountInput(current));
    setEditingAmount(true);
    setError('');
    setMessage('');
  }

  async function saveAmount(event) {
    event.preventDefault();
    const parsed = parseRupiahInput(amountDraft);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      setError('Enter the amount in whole rupiah, for example 6.700.000.');
      setMessage('');
      return;
    }
    await run(async () => {
      await updatePaymentHints(id, { amount: parsed });
      setEditingAmount(false);
      setMessage('Transfer amount updated.');
    });
  }

  async function useScreenshotAmount() {
    await run(async () => {
      await updatePaymentHints(id, { amount: null });
      setEditingAmount(false);
      setMessage('Using the amount read from the screenshot.');
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
  const canDelete = !reading && !payment.zohoPaymentId && !(payment.zohoPayments || []).length;
  const amount = payment.amountReceived ?? payment.ai?.amount;
  const hasAmount = amount != null;
  const canEditAmount = canReview && !['approved', 'rejected'].includes(payment.status);
  const amountCorrected = Number.isInteger(payment.confirmed?.amount);
  const screenshotAmount = Number.isInteger(payment.ai?.amount) ? payment.ai.amount : null;
  const adminFee = payment.ai?.adminFee || payment.bankFee || 0;
  const allocations = payment.allocations || [];
  const appliedById = new Map(allocations.map((row) => [String(row.invoiceId), row.applied]));
  // Customer invoices stay listed until a group search replaces them.
  // A name like AN Balinest returns every villa; ticks stay visible if the date filter hides them.
  const savedRows = mergeOpenInvoiceRows(
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
      customerId: row.customerId,
      customerName: row.customerName,
    })),
  );
  const searching = query.trim().length >= 2;
  const suggestionCustomers = new Set(suggestions.map((row) => villaKey(row)).filter(Boolean));
  // Group search lists every matching villa. Invoices already loaded for those villas stay,
  // so a date filter does not drop the matched customer's rows that the search capped out.
  const pickRows = searching && suggestions.length
    ? mergeOpenInvoiceRows(
      suggestions,
      savedRows.filter((row) => suggestionCustomers.has(villaKey(row)) || ticked.has(String(row.id))),
    )
    : savedRows;
  const range = canFindCustomer ? selectedRange(dateMode, from, to) : null;
  const rangeError = dateMode === 'custom' && from && to && from > to
    ? 'The start date must be on or before the end date.'
    : '';
  const inRangeRows = rangeError ? [] : pickRows.filter((row) => inSelectedRange(row, range));
  const visibleRows = mergeOpenInvoiceRows(
    inRangeRows,
    pickRows.filter((row) => ticked.has(String(row.id)) && !inSelectedRange(row, range)),
  );
  const villaGroups = [];
  const villaIndex = new Map();
  for (const row of visibleRows) {
    const key = villaKey(row) || row.customerName || 'Customer';
    if (!villaIndex.has(key)) {
      const group = { key, name: row.customerName || 'Customer', rows: [] };
      villaIndex.set(key, group);
      villaGroups.push(group);
    }
    villaIndex.get(key).rows.push(row);
  }
  const inRangeVillas = new Set(inRangeRows.map((row) => villaKey(row)).filter(Boolean)).size;
  const tickedRows = pickRows.filter((row) => ticked.has(String(row.id)));
  const tickedVillas = new Set(tickedRows.map((row) => villaKey(row)).filter(Boolean)).size;
  const tickedTotal = tickedRows.reduce((total, row) => total + row.remaining, 0);
  const pickGap = hasAmount ? amount - tickedTotal : 0;
  const multiVillaExcess = tickedVillas > 1 && pickGap > MAX_BANK_FEE;
  let pickSumClass = 'message-warn';
  let pickSumText = 'Tick the invoices this transfer pays.';
  if (hasAmount && ticked.size) {
    if (pickGap === 0) {
      pickSumClass = 'message-ok';
      pickSumText = 'Exact match.';
    } else if (pickGap > 0 && pickGap <= MAX_BANK_FEE) {
      pickSumClass = 'message-ok';
      pickSumText = `Match · ${formatRupiah(pickGap)} bank fee not recorded.`;
    } else if (pickGap > 0 && tickedVillas > 1) {
      pickSumText = MULTI_VILLA_EXCESS;
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
          {imageUrl && /pdf/i.test(proofMime) ? (
            <iframe className="payment-shot" title="Payment proof" src={imageUrl} />
          ) : imageUrl ? (
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
              <dd className={!hasAmount && reading && !editingAmount ? 'payment-pulse-text' : undefined}>
                {editingAmount ? (
                  <form className="payment-amount-edit" onSubmit={saveAmount}>
                    <label>
                      <span className="hint">Customer transfer amount</span>
                      <input
                        value={amountDraft}
                        onChange={(event) => setAmountDraft(event.target.value)}
                        inputMode="decimal"
                        autoComplete="off"
                        autoFocus
                        aria-label="Customer transfer amount"
                        placeholder="6.700.000"
                        disabled={busy}
                      />
                    </label>
                    <p className="hint">
                      Whole rupiah. This amount is matched and recorded. Leave out the sender&apos;s bank fee. The screenshot reading is kept.
                    </p>
                    <div className="payment-amount-actions">
                      <button type="submit" className="btn btn-primary" disabled={busy}>
                        {busy ? 'Saving…' : 'Save amount'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={busy}
                        onClick={() => setEditingAmount(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="payment-amount-shown">
                    <span>{hasAmount ? formatRupiah(amount) : (reading ? 'Reading…' : '—')}</span>
                    {canEditAmount && (
                      <button type="button" className="btn btn-secondary" disabled={busy} onClick={startAmountEdit}>
                        {hasAmount ? 'Edit amount' : 'Enter amount'}
                      </button>
                    )}
                    {canEditAmount && amountCorrected && screenshotAmount != null && (
                      <button type="button" className="btn btn-secondary" disabled={busy} onClick={useScreenshotAmount}>
                        Use screenshot amount
                      </button>
                    )}
                  </div>
                )}
                {!editingAmount && amountCorrected && screenshotAmount != null && screenshotAmount !== amount && (
                  <p className="hint payment-amount-note">Screenshot read {formatRupiah(screenshotAmount)}.</p>
                )}
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
                <dd>
                  {formatRupiah(payment.ai.total)}
                  {canEditAmount && (
                    <span className="hint"> · screenshot reading. Edit the received amount if this is wrong.</span>
                  )}
                </dd>
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
              <div>
                <dt>Customer</dt>
                <dd>
                  {invoice.customer?.name || '—'}
                  {inRangeVillas > 1 ? ` · ${inRangeVillas} villas in this list` : ''}
                </dd>
              </div>
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
                      <span className="hint">
                        {row.customerName ? `${row.customerName} · ` : ''}
                        {row.date ? formatDay(row.date) : ''}
                      </span>
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

          {canFindCustomer && !closed && (
            <>
              <div className="filters payment-date-filters">
                <label className="filter-field">
                  <span className="field-label">Date range</span>
                  <select
                    value={dateMode}
                    onChange={(event) => {
                      dateTouched.current = true;
                      setDateMode(event.target.value);
                    }}
                  >
                    <option value="all">All dates</option>
                    <option value="month">This month</option>
                    <option value="custom">Custom</option>
                  </select>
                </label>
                {dateMode === 'custom' && (
                  <>
                    <label className="filter-field">
                      <span className="field-label">From</span>
                      <input
                        type="date"
                        value={from}
                        onChange={(event) => {
                          dateTouched.current = true;
                          setFrom(event.target.value);
                        }}
                      />
                    </label>
                    <label className="filter-field">
                      <span className="field-label">To</span>
                      <input
                        type="date"
                        value={to}
                        onChange={(event) => {
                          dateTouched.current = true;
                          setTo(event.target.value);
                        }}
                      />
                    </label>
                  </>
                )}
              </div>
              {rangeError && <p className="message message-bad">{rangeError}</p>}
              <label className="field">
                <span className="field-label">Customer or invoice numbers</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="AN Balinest, or INV-079837"
                  autoComplete="off"
                />
              </label>
              <p className="hint">
                Type a group name such as AN Balinest. Every villa whose name contains it is listed.
                Set the dates, Select all, then use those invoices. You do not search each villa.
              </p>
            </>
          )}

          {!closed && (visibleRows.length > 0 || canFindCustomer) && (
            <div className="payment-invoice-pick">
              <div className="title-row">
                <p className="field-label">Unpaid invoices — tick the ones this transfer pays</p>
                {canFindCustomer && inRangeRows.length > 0 && (
                  <div className="actions payment-tick-tools">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy || Boolean(rangeError)}
                      onClick={() => setTicked(new Set(inRangeRows.map((row) => String(row.id))))}
                    >
                      {range ? 'Select all in range' : 'Select all'}
                    </button>
                    <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setTicked(new Set())}>
                      Clear
                    </button>
                  </div>
                )}
              </div>
              {loadingInvoices && !searching && <p className="hint">Loading unpaid invoices…</p>}
              {suggesting && <p className="hint">Searching…</p>}
              {searching && !suggesting && suggestions.length === 0 && (
                <p className="message message-warn">
                  No unpaid invoice matches that name. Showing the invoices already on this payment.
                </p>
              )}
              {payment.customerOpenInvoicesError && !customerInvoices.length && !searching && (
                <p className="message message-warn">{payment.customerOpenInvoicesError}</p>
              )}
              {searchTruncated && (
                <p className="message message-warn">Too many invoices match. Narrow the date range.</p>
              )}
              {inRangeRows.length > MAX_TICKS && (
                <p className="message message-warn">
                  This range has {inRangeRows.length} invoices. One transfer can record {MAX_TICKS}. Shorten the dates.
                </p>
              )}
              <p className="hint">
                {inRangeRows.length === 0 && !suggesting
                  ? 'No unpaid invoices in this date range.'
                  : `Showing ${inRangeRows.length} unpaid invoice${inRangeRows.length === 1 ? '' : 's'}${inRangeVillas > 1 ? ` across ${inRangeVillas} villas` : ''}`}
                {ticked.size ? ` · ${ticked.size} ticked` : ''}
              </p>
              {villaGroups.map((group) => (
                <div key={group.key}>
                  {villaGroups.length > 1 && (
                    <p className="pay-villa-label">
                      <strong>{group.name}</strong>
                      <span className="hint">
                        {' '}· {formatRupiah(group.rows.reduce((total, row) => total + row.remaining, 0))}
                      </span>
                    </p>
                  )}
                  <ul className="pay-pick-list">
                    {group.rows.map((row) => {
                      const key = String(row.id);
                      const isTicked = ticked.has(key);
                      const outside = Boolean(range) && !inSelectedRange(row, range);
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
                              <span className="hint">
                                {villaGroups.length === 1 && row.customerName ? `${row.customerName} · ` : ''}
                                {formatDay(row.date)}
                                {outside ? ' · outside this date range' : ''}
                              </span>
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
                </div>
              ))}
              {hasAmount && ticked.size > 0 && (
                <p className={`message pay-pick-sum ${pickSumClass}`}>
                  <span>Ticked {ticked.size} · <strong>{formatRupiah(tickedTotal)}</strong></span>
                  <span>Received <strong>{formatRupiah(amount)}</strong></span>
                  <span>{pickSumText}</span>
                </p>
              )}
              {canFindCustomer && tickChanged && (
                <button
                  type="button"
                  className="btn btn-primary pay-pick-apply"
                  disabled={busy || multiVillaExcess || ticked.size > MAX_TICKS}
                  onClick={applyTicked}
                >
                  {busy ? 'Saving…' : `Use these ${ticked.size} invoice${ticked.size === 1 ? '' : 's'}`}
                </button>
              )}
            </div>
          )}

          {canRecord && (
            <div className="stack-form">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || recording || !payment.matchedInvoiceId || !hasAmount || (!tickChanged && multiVillaExcess)}
                onClick={() => {
                  setRecording(true);
                  run(async () => {
                    if (!payment.matchedInvoiceId) throw new Error('Pick a customer first.');
                    if (!hasAmount) throw new Error('Wait for the amount to finish reading.');
                    if (!payment.statementVerified) await verifyPayment(id);
                    await approvePayment(id, {});
                    const villas = new Set((payment.allocations || []).map((row) => row.customerId).filter(Boolean)).size;
                    setMessage(villas > 1
                      ? `Recorded in Zoho as ${villas} Bank Transfers, one per villa.`
                      : 'Recorded in Zoho as Bank Transfer.');
                  }).finally(() => setRecording(false));
                }}
              >
                {recording
                  ? 'Recording…'
                  : (hasAmount ? `Record ${formatRupiah(amount)} Bank Transfer in Zoho` : 'Record Bank Transfer in Zoho')}
              </button>
              {!hasAmount && (
                <p className="hint">Record unlocks when the amount is read from the screenshot.</p>
              )}
            </div>
          )}

          {(payment.zohoPayments || []).length > 0 && payment.status !== 'approved' && (
            <p className="message message-warn">
              {payment.zohoPayments.length} villa payment{payment.zohoPayments.length === 1 ? '' : 's'} already recorded in Zoho.
              Record again to finish the rest.
            </p>
          )}

          {payment.status === 'approved' && (
            <p className="message message-ok">
              {(payment.zohoPayments || []).length > 1
                ? `Saved in Zoho as ${payment.zohoPayments.length} Bank Transfers, one per villa.`
                : 'Saved in Zoho as Bank Transfer.'}
            </p>
          )}
        </section>
      </div>
    </>
  );
}
