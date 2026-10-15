import BankPayment from '../../models/BankPayment.js';
import { bestCustomerNameScore, compactName } from './normalizeName.js';
import {
  DATE_WINDOW_DAYS, DUPLICATE_WINDOW_MS, MAX_BANK_FEE, STRONG_NAME, WEAK_NAME,
} from './rules.js';

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

function noAmountResult() {
  return {
    matchedInvoiceId: null,
    matchedCustomerId: null,
    matchType: 'none',
    matchConfidence: 'low',
    matchReasons: ['Amount could not be read as integer rupiah.'],
    flags: ['unidentified'],
    candidates: [],
    matched: null,
    bankFee: 0,
  };
}

function rupiah(value) {
  return `Rp${Number(value).toLocaleString('id-ID')}`;
}

/**
 * Suggest an invoice match from AI fields against an invoice list (usually Zoho unpaid).
 * Never auto-approves or marks paid — returns a suggestion only.
 *
 * Prefer caption customerName over bank sender when both exist.
 * High confidence only when exactly one invoice fits; ties are medium and pick the oldest.
 *
 * Each invoice: { invoiceId, invoiceNo, customerId, customerName, aliases?, remaining, dueDate?, date? }
 */
export async function matchPayment({
  sender,
  customerName = null,
  invoiceNumberHint = null,
  invoiceDateHint = null,
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

  if (amount == null || !Number.isInteger(amount) || amount < 0) return noAmountResult();

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
    return {
      invoiceId: invoice.invoiceId,
      invoiceNo: invoice.invoiceNo || invoice.invoiceNumber,
      customerId: invoice.customerId,
      customerName: invoice.customerName,
      remaining,
      ...fit,
      nameScore: scoreFor(invoice),
      dateOk: withinDateWindow(invoice, paidAt),
      dateHit: Boolean(invoiceDateHint && invoice.date === invoiceDateHint),
      date: invoice.date || null,
      dueDate: invoice.dueDate || null,
      status: invoice.status || '',
    };
  });
  candidates.sort(compareCandidates);

  let matched = null;
  let matchConfidence = 'low';

  const hint = normalizeInvoiceNo(invoiceNumberHint);
  const byNumber = hint
    ? candidates.filter((c) => normalizeInvoiceNo(c.invoiceNo) === hint)
    : [];
  if (hint && byNumber.length === 1) {
    matched = byNumber[0];
    matchConfidence = 'high';
    reasons.push('Invoice number from the payment caption matched exactly.');
  } else if (hint) {
    reasons.push(byNumber.length > 1
      ? 'Invoice number hint matched more than one unpaid invoice — pick one.'
      : 'Invoice number hint did not match an unpaid Zoho invoice.');
  }

  if (!matched) {
    const fits = (c) => (c.fit === 'exact' || c.fit === 'fee') && c.dateOk;
    const strong = candidates.filter((c) => c.nameScore >= STRONG_NAME && fits(c));
    // An exact balance beats a fee-sized gap for the same customer.
    const strongExact = strong.filter((c) => c.fit === 'exact');
    let group = strongExact.length ? strongExact : strong;
    const hinted = group.filter((c) => c.dateHit);
    if (hinted.length) group = hinted;

    if (group.length === 1) {
      matched = group[0];
      const feeExplained = matched.fit !== 'fee' || (adminFee != null && adminFee === matched.bankFee);
      matchConfidence = feeExplained ? 'high' : 'medium';
      reasons.push(hinted.length
        ? 'Customer name, amount and the caption date match one invoice.'
        : (customerName
          ? 'Caption customer name and amount match one unpaid invoice.'
          : 'Bank sender name and amount match one unpaid invoice.'));
    } else if (group.length > 1) {
      matched = group[0];
      matchConfidence = 'medium';
      reasons.push(`${group.length} unpaid invoices for ${rupiah(matched.remaining)} — picked the oldest (${matched.invoiceNo}). Tap another below if wrong.`);
    } else {
      const strongPartial = candidates.find(
        (c) => c.nameScore >= STRONG_NAME && (c.fit === 'partial' || c.fit === 'over') && c.dateOk,
      );
      const weakFits = candidates.filter(
        (c) => c.nameScore >= WEAK_NAME && c.nameScore < STRONG_NAME && fits(c),
      );
      const weakCustomers = new Set(weakFits.map((c) => c.customerId));
      if (strongPartial) {
        matched = strongPartial;
        matchConfidence = 'medium';
        reasons.push(strongPartial.fit === 'partial'
          ? `Customer found; transfer is ${rupiah(strongPartial.remaining - amount)} less than the oldest invoice.`
          : `Customer found; transfer is ${rupiah(amount - strongPartial.remaining)} more than the oldest invoice.`);
      } else if (weakFits.length >= 1 && weakCustomers.size === 1) {
        matched = weakFits[0];
        matchConfidence = 'medium';
        reasons.push('Amount fits and the customer name is close. Check the customer.');
      } else if (weakCustomers.size > 1) {
        reasons.push('Amount fits invoices of several similar customers — pick one.');
        flags.push('unidentified');
      } else {
        reasons.push('No confident customer and amount match.');
        flags.push('unidentified');
      }
    }
  }

  if (matched?.fit === 'fee') {
    reasons.push(`${rupiah(matched.bankFee)} above the invoice is treated as the bank admin fee and not recorded.`);
  }

  if (paidAt && matchName && matched) {
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

  // When a customer is known, show all their open invoices (oldest first) for a one-tap switch.
  const shown = matched
    ? candidates
      .filter((c) => c.customerId === matched.customerId)
      .sort((a, b) => String(a.date || a.dueDate || '').localeCompare(String(b.date || b.dueDate || '')))
      .slice(0, 12)
    : candidates.slice(0, 8);

  return {
    matchedInvoiceId: matched?.invoiceId || null,
    matchedCustomerId: matched?.customerId || null,
    matchType: matched ? matched.amountType : 'none',
    matchConfidence: matched ? matchConfidence : 'low',
    matchReasons: reasons,
    flags: [...new Set(flags)],
    matched: matched ? publicCandidate(matched) : null,
    bankFee: matched?.bankFee || 0,
    candidates: shown.map(publicCandidate),
  };
}
