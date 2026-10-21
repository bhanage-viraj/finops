import BankPayment from '../../models/BankPayment.js';
import { bestCustomerNameScore, compactName } from './normalizeName.js';
import {
  DATE_WINDOW_DAYS, DUPLICATE_WINDOW_MS, MAX_BANK_FEE, STRONG_NAME, WEAK_NAME,
} from './rules.js';
import {
  MAX_ALLOCATIONS, allocateOldestFirst, findExactSet, sortOldestFirst, sumRemaining,
} from './allocate.js';

function daysBetween(a, b) {
  if (!a || !b) return null;
  const ms = Math.abs(new Date(a).getTime() - new Date(b).getTime());
  return ms / (24 * 60 * 60 * 1000);
}

function withinDateWindow(invoice, paidAt) {
  if (!paidAt) return true;
  const dueGap = daysBetween(invoice.dueDate, paidAt);
  const issueGap = daysBetween(invoice.issueDate || invoice.date, paidAt);
  const best = Math.min(
    dueGap == null ? Infinity : dueGap,
    issueGap == null ? Infinity : issueGap,
  );
  // If no dates on the invoice, still allow a match.
  if (!Number.isFinite(best)) return true;
  return best <= DATE_WINDOW_DAYS;
}

/**
 * How a transfer amount fits an invoice balance.
 * "fee" = a few thousand rupiah above the balance, usually the sender's bank admin fee.
 * Returns { amountType, fit, bankFee } where fit is exact | fee | partial | over.
 */
export function classifyAmountFit(amount, remaining, { allowFee = true } = {}) {
  if (amount === remaining) return { amountType: 'exact', fit: 'exact', bankFee: 0 };
  if (amount < remaining) return { amountType: 'partial', fit: 'partial', bankFee: 0 };
  const gap = amount - remaining;
  if (allowFee && gap <= MAX_BANK_FEE) return { amountType: 'exact', fit: 'fee', bankFee: gap };
  return { amountType: 'over', fit: 'over', bankFee: 0 };
}

function normalizeInvoiceNo(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

const FIT_RANK = { exact: 0, fee: 1, partial: 2, over: 3 };

function compareCandidates(a, b) {
  if (b.nameScore !== a.nameScore) return b.nameScore - a.nameScore;
  if (FIT_RANK[a.fit] !== FIT_RANK[b.fit]) return FIT_RANK[a.fit] - FIT_RANK[b.fit];
  if (a.dateHit !== b.dateHit) return a.dateHit ? -1 : 1;
  // Oldest unpaid invoice first, the way the office settles by hand.
  const aDate = a.date || a.dueDate || '9999';
  const bDate = b.date || b.dueDate || '9999';
  if (aDate !== bDate) return aDate < bDate ? -1 : 1;
  return String(a.invoiceNo || '').localeCompare(String(b.invoiceNo || ''));
}

function publicCandidate(c) {
  return {
    invoiceId: c.invoiceId,
    invoiceNo: c.invoiceNo,
    customerId: c.customerId,
    customerName: c.customerName,
    remaining: c.remaining,
    amountType: c.amountType,
    fit: c.fit,
    bankFee: c.bankFee,
    nameScore: Math.round(c.nameScore * 100) / 100,
    date: c.date || null,
    dueDate: c.dueDate,
    status: c.status,
  };
}

function publicAllocation(row) {
  return {
    invoiceId: row.invoiceId,
    invoiceNo: row.invoiceNo,
    remaining: row.remaining,
    applied: row.applied,
    date: row.date || null,
    dueDate: row.dueDate || null,
    customerId: row.customerId || '',
    customerName: row.customerName || '',
  };
}

function rupiah(value) {
  return `Rp${Number(value).toLocaleString('id-ID')}`;
}

function shortDay(iso) {
  const m = String(iso || '').match(/^\d{4}-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[1]}` : '—';
}

function invoiceSpan(rows) {
  if (rows.length === 1) return rows[0].invoiceNo;
  return `${rows.length} invoices (${shortDay(rows[0].date)}–${shortDay(rows[rows.length - 1].date)})`;
}

function emptyResult(reasons, flags = ['unidentified']) {
  return {
    matchedInvoiceId: null,
    matchedCustomerId: null,
    matchType: 'none',
    matchConfidence: 'low',
    matchReasons: reasons,
    flags,
    candidates: [],
    matched: null,
    allocations: [],
    bankFee: 0,
  };
}

/** Paid day as YYYY-MM-DD. AI dates keep the bank's local clock in UTC fields. */
function paidDay(paidAt) {
  if (!paidAt) return null;
  const d = new Date(paidAt);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Suggest which unpaid Zoho invoices a transfer pays. Never auto-approves or marks paid.
 *
 * Caption customerName beats bank sender. One transfer may cover several invoices of
 * one customer: a date range from the caption/remark first, then an exact total of the
 * oldest invoices, then oldest-first with the last one partly paid.
 * High confidence only when the evidence points to exactly one set of invoices.
 *
 * Each invoice: { invoiceId, invoiceNo, customerId, customerName, aliases?, remaining, dueDate?, date? }
 */
export async function matchPayment({
  sender,
  customerName = null,
  invoiceNumberHint = null,
  invoiceDateHint = null,
  invoiceDateRange = null,
  amount,
  adminFee = null,
  allowFee = true,
  paidAt,
  invoices = [],
  excludePaymentId = null,
}) {
  const reasons = [];
  const flags = [];
  // Caption / Zoho customer name beats bank account holder on the screenshot.
  const matchName = String(customerName || sender || '').trim() || null;
  const range = invoiceDateRange || (invoiceDateHint ? { from: invoiceDateHint, to: invoiceDateHint } : null);

  if (amount == null || !Number.isInteger(amount) || amount < 0) {
    return emptyResult(['Amount could not be read as integer rupiah.']);
  }

  const openInvoices = (invoices || []).filter((inv) => Number(inv.remaining) > 0);

  // One name score per customer, not per invoice — customers have many open invoices.
  const nameScores = new Map();
  function scoreFor(invoice) {
    const key = `${invoice.customerId}|${invoice.customerName}`;
    if (!nameScores.has(key)) {
      nameScores.set(key, bestCustomerNameScore(matchName, {
        name: invoice.customerName,
        aliases: invoice.aliases || [],
      }));
    }
    return nameScores.get(key);
  }

  const candidates = openInvoices.map((invoice) => {
    const remaining = Number(invoice.remaining);
    const fit = classifyAmountFit(amount, remaining, { allowFee });
    const date = invoice.date || null;
    return {
      invoiceId: invoice.invoiceId,
      invoiceNo: invoice.invoiceNo || invoice.invoiceNumber,
      customerId: invoice.customerId,
      customerName: invoice.customerName,
      remaining,
      ...fit,
      nameScore: scoreFor(invoice),
      dateOk: withinDateWindow(invoice, paidAt),
      dateHit: Boolean(range && date && date >= range.from && date <= range.to),
      date,
      dueDate: invoice.dueDate || null,
      status: invoice.status || '',
    };
  });
  candidates.sort(compareCandidates);

  // Chosen invoices plus how much of the transfer goes to each.
  let chosen = null;
  let bankFee = 0;
  let matchConfidence = 'low';
  const feeExplained = (fee) => fee === 0 || (adminFee != null && adminFee === fee);

  function chooseFull(rows, fee) {
    chosen = sortOldestFirst(rows).map((row) => ({ ...row, applied: row.remaining }));
    bankFee = fee;
  }
  function chooseOldestFirst(rows) {
    chosen = allocateOldestFirst(amount, rows).allocations;
    bankFee = 0;
  }

  const hint = normalizeInvoiceNo(invoiceNumberHint);
  const byNumber = hint ? candidates.filter((c) => normalizeInvoiceNo(c.invoiceNo) === hint) : [];
  if (hint && byNumber.length === 1) {
    const only = byNumber[0];
    bankFee = only.fit === 'fee' ? only.bankFee : 0;
    chosen = [{ ...only, applied: Math.min(amount - bankFee, only.remaining) }];
    matchConfidence = 'high';
    reasons.push('Invoice number from the payment caption matched exactly.');
  } else if (hint) {
    reasons.push(byNumber.length > 1
      ? 'Invoice number hint matched more than one unpaid invoice — pick one.'
      : 'Invoice number hint did not match an unpaid Zoho invoice.');
  }

  const strong = candidates.filter((c) => c.nameScore >= STRONG_NAME);
  if (!chosen && strong.length) {
    const top = strong[0];
    const customerRows = candidates.filter((c) => c.customerId === top.customerId);
    const rival = strong.some((c) => c.customerId !== top.customerId && c.nameScore >= top.nameScore - 0.02);
    const fits = (c) => (c.fit === 'exact' || c.fit === 'fee') && c.dateOk;
    const inRange = customerRows.filter((c) => c.dateHit);
    const day = paidDay(paidAt);
    const dueByThen = day ? customerRows.filter((c) => !c.date || c.date <= day) : customerRows;

    // 1. Dates from the caption or transfer remark ("Sept 28-30").
    if (range && inRange.length) {
      const rangeTotal = sumRemaining(inRange);
      const gap = amount - rangeTotal;
      const fee = gap === 0 ? 0 : (allowFee && gap > 0 && gap <= MAX_BANK_FEE ? gap : null);
      const subset = fee == null ? findExactSet(amount, inRange, { allowFee }) : null;
      if (fee != null) {
        chooseFull(inRange, fee);
        matchConfidence = feeExplained(fee) ? 'high' : 'medium';
        reasons.push(`Transfer equals ${invoiceSpan(chosen)} dated in the caption/remark range.`);
      } else if (subset) {
        chooseFull(subset.invoices, subset.bankFee);
        matchConfidence = 'medium';
        reasons.push(`Transfer equals ${invoiceSpan(chosen)} inside the caption/remark range. Check the ticked invoices.`);
      } else {
        chooseOldestFirst(inRange);
        matchConfidence = 'medium';
        reasons.push(amount < rangeTotal
          ? `Transfer is ${rupiah(rangeTotal - amount)} less than the invoices in the caption/remark range — oldest paid first.`
          : `Transfer is ${rupiah(amount - rangeTotal)} more than the invoices in the caption/remark range — extra stays as credit.`);
      }
    }

    // 2. One invoice with the exact amount.
    if (!chosen) {
      const singles = customerRows.filter(fits);
      const exactSingles = singles.filter((c) => c.fit === 'exact');
      let group = exactSingles.length ? exactSingles : singles;
      const hinted = group.filter((c) => c.dateHit);
      if (hinted.length) group = hinted;
      if (group.length) {
        const pick = sortOldestFirst(group)[0];
        chooseFull([pick], pick.fit === 'fee' ? pick.bankFee : 0);
        if (group.length === 1) {
          matchConfidence = feeExplained(bankFee) ? 'high' : 'medium';
          reasons.push(hinted.length
            ? 'Customer name, amount and the caption date match one invoice.'
            : (customerName
              ? 'Caption customer name and amount match one unpaid invoice.'
              : 'Bank sender name and amount match one unpaid invoice.'));
        } else {
          matchConfidence = 'medium';
          reasons.push(`${group.length} unpaid invoices for ${rupiah(pick.remaining)} — picked the oldest (${pick.invoiceNo}). Tick another below if wrong.`);
        }
      }
    }

    // 3. Several invoices that add up exactly, oldest first.
    if (!chosen) {
      const exact = findExactSet(amount, dueByThen, { allowFee })
        || findExactSet(amount, customerRows, { allowFee });
      if (exact) {
        chooseFull(exact.invoices, exact.bankFee);
        const allDue = exact.prefix && exact.invoices.length === dueByThen.length;
        matchConfidence = allDue && feeExplained(exact.bankFee) ? 'high' : 'medium';
        reasons.push(allDue
          ? `Transfer clears all ${exact.invoices.length} invoices due by the transfer date.`
          : `Transfer equals ${invoiceSpan(chosen)} together. Check the ticked invoices.`);
      }
    }

    // 4. Oldest first; last invoice partly paid or extra left as credit.
    if (!chosen && customerRows.length) {
      const base = dueByThen.length ? dueByThen : customerRows;
      const baseTotal = sumRemaining(base);
      chooseOldestFirst(base);
      matchConfidence = 'medium';
      reasons.push(amount < baseTotal
        ? `Customer found; transfer covers ${invoiceSpan(chosen)} oldest first, the last one partly.`
        : `Customer found; transfer is ${rupiah(amount - baseTotal)} more than all invoices due — extra stays as credit.`);
    }

    if (chosen && rival) {
      matchConfidence = 'medium';
      reasons.push('Another customer has a very similar name. Check the customer.');
    }
  }

  // Weak names: only a single exact invoice of one customer, never high.
  if (!chosen && !strong.length) {
    const fits = (c) => (c.fit === 'exact' || c.fit === 'fee') && c.dateOk;
    const weakFits = candidates.filter((c) => c.nameScore >= WEAK_NAME && fits(c));
    const weakCustomers = new Set(weakFits.map((c) => c.customerId));
    if (weakFits.length && weakCustomers.size === 1) {
      const pick = sortOldestFirst(weakFits)[0];
      chooseFull([pick], pick.fit === 'fee' ? pick.bankFee : 0);
      matchConfidence = 'medium';
      reasons.push('Amount fits and the customer name is close. Check the customer.');
    } else if (weakCustomers.size > 1) {
      reasons.push('Amount fits invoices of several similar customers — pick one.');
      flags.push('unidentified');
    }
  }

  if (!chosen) {
    if (!reasons.length) reasons.push('No confident customer and amount match.');
    return { ...emptyResult(reasons, [...new Set([...flags, 'unidentified'])]), candidates: candidates.slice(0, 8).map(publicCandidate) };
  }

  if (bankFee > 0) {
    reasons.push(`${rupiah(bankFee)} above the invoices is treated as the bank admin fee and not recorded.`);
  }

  if (paidAt && matchName) {
    const from = new Date(new Date(paidAt).getTime() - DUPLICATE_WINDOW_MS);
    const to = new Date(new Date(paidAt).getTime() + DUPLICATE_WINDOW_MS);
    const dupQuery = {
      'ai.amount': amount,
      'ai.paidAt': { $gte: from, $lte: to },
      status: { $nin: ['rejected', 'failed'] },
    };
    if (excludePaymentId) dupQuery._id = { $ne: excludePaymentId };
    const near = await BankPayment.find(dupQuery).select('ai.sender confirmed.customerName confirmed.sender').lean();
    const target = compactName(matchName);
    const duplicate = near.some((row) => {
      const name = row.confirmed?.customerName || row.confirmed?.sender || row.ai?.sender || '';
      return compactName(name) === target;
    });
    if (duplicate) {
      flags.push('possibleDuplicate');
      reasons.push('Another payment with the same customer and amount is within 30 minutes.');
      if (matchConfidence === 'high') matchConfidence = 'medium';
    }
  }

  const first = chosen[0];
  const received = amount - bankFee;
  const applied = chosen.reduce((total, row) => total + row.applied, 0);
  let matchType = 'exact';
  if (applied < received) matchType = 'over';
  else if (chosen.some((row) => row.applied < row.remaining)) matchType = 'partial';

  // Always return EVERY open invoice for this customer (oldest first).
  // Amount matching only chooses which ones are pre-ticked — never hides the rest.
  const customerId = String(first.customerId);
  const shown = sortOldestFirst(
    candidates.filter((c) => String(c.customerId) === customerId),
  );

  return {
    matchedInvoiceId: first.invoiceId,
    matchedCustomerId: first.customerId,
    matchType,
    matchConfidence,
    matchReasons: reasons,
    flags: [...new Set(flags)],
    matched: publicCandidate(first),
    allocations: chosen.map(publicAllocation),
    bankFee,
    candidates: shown.map(publicCandidate),
  };
}
