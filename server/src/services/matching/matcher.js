import BankPayment from '../../models/BankPayment.js';
import { bestCustomerNameScore } from './normalizeName.js';
import {
  DATE_WINDOW_DAYS, DUPLICATE_WINDOW_MS, STRONG_NAME, WEAK_NAME,
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

function classifyAmount(paymentAmount, remaining) {
  if (paymentAmount === remaining) return 'exact';
  if (paymentAmount < remaining) return 'partial';
  return 'over';
}

/**
 * Suggest an invoice match from AI fields against an invoice list (usually Zoho unpaid).
 * Never auto-approves or marks paid — returns a suggestion only.
 *
 * Each invoice: { invoiceId, invoiceNo, customerId, customerName, aliases?, remaining, dueDate?, date? }
 */
export async function matchPayment({
  sender, amount, paidAt, invoices = [], excludePaymentId = null,
}) {
  const reasons = [];
  const flags = [];

  if (amount == null || !Number.isInteger(amount) || amount < 0) {
    return {
      matchedInvoiceId: null,
      matchedCustomerId: null,
      matchType: 'none',
      matchConfidence: 'low',
      matchReasons: ['Amount could not be read as integer rupiah.'],
      flags: ['unidentified'],
      candidates: [],
      matched: null,
    };
  }

  const openInvoices = (invoices || []).filter((inv) => Number(inv.remaining) > 0);
  const scoredCustomers = openInvoices
    .map((inv) => ({
      name: inv.customerName,
      aliases: inv.aliases || [],
      score: bestCustomerNameScore(sender, { name: inv.customerName, aliases: inv.aliases || [] }),
    }))
    .filter((row) => row.score >= WEAK_NAME);

  const candidates = [];
  for (const invoice of openInvoices) {
    const customer = { name: invoice.customerName, aliases: invoice.aliases || [] };
    const nameScore = bestCustomerNameScore(sender, customer);
    const remaining = Number(invoice.remaining);
    const amountType = classifyAmount(amount, remaining);
    const dateOk = withinDateWindow(invoice, paidAt);
    candidates.push({
      invoiceId: invoice.invoiceId,
      invoiceNo: invoice.invoiceNo || invoice.invoiceNumber,
      customerId: invoice.customerId,
      customerName: invoice.customerName,
      remaining,
      amountType,
      nameScore,
      dateOk,
      dueDate: invoice.dueDate || null,
      status: invoice.status || '',
    });
  }

  candidates.sort((a, b) => {
    if (b.nameScore !== a.nameScore) return b.nameScore - a.nameScore;
    const aExact = a.amountType === 'exact' ? 1 : 0;
    const bExact = b.amountType === 'exact' ? 1 : 0;
    if (bExact !== aExact) return bExact - aExact;
    return a.remaining - b.remaining;
  });

  let matched = null;
  let matchConfidence = 'low';
  let matchType = 'none';

  const strongExact = candidates.filter(
    (c) => c.nameScore >= STRONG_NAME && c.amountType === 'exact' && c.dateOk,
  );
  if (strongExact.length === 1) {
    matched = strongExact[0];
    matchConfidence = 'high';
    matchType = 'exact';
    reasons.push('Strong sender name match and exact remaining balance.');
  } else if (strongExact.length > 1) {
    matchConfidence = 'medium';
    matchType = 'exact';
    reasons.push('Several invoices share the same strong name and exact amount — pick one.');
    flags.push('unidentified');
  } else {
    const strongPartial = candidates.find(
      (c) => c.nameScore >= STRONG_NAME && c.amountType !== 'exact' && c.dateOk,
    );
    const weakExact = candidates.filter(
      (c) => c.nameScore >= WEAK_NAME && c.nameScore < STRONG_NAME && c.amountType === 'exact' && c.dateOk,
    );
    if (strongPartial) {
      matched = strongPartial;
      matchConfidence = 'medium';
      matchType = strongPartial.amountType;
      reasons.push(`Strong name match with ${strongPartial.amountType} payment vs remaining balance.`);
    } else if (weakExact.length === 1) {
      matched = weakExact[0];
      matchConfidence = 'medium';
      matchType = 'exact';
      reasons.push('Exact amount with a weak sender name match.');
    } else if (weakExact.length > 1) {
      matchConfidence = 'low';
      matchType = 'exact';
      reasons.push('Exact amount matches more than one invoice with weak names.');
      flags.push('unidentified');
    } else {
      const amountOnly = candidates.filter((c) => c.amountType === 'exact' && c.dateOk);
      if (amountOnly.length === 1 && (!sender || scoredCustomers.length === 0)) {
        matched = amountOnly[0];
        matchConfidence = 'low';
        matchType = 'exact';
        reasons.push('Only amount matched; sender name was weak or missing. Not auto-linked as high.');
        flags.push('unidentified');
      } else {
        reasons.push('No confident customer and amount match.');
        flags.push('unidentified');
      }
    }
  }

  const autoLink = matchConfidence === 'high' || matchConfidence === 'medium';
  if (!autoLink) {
    matched = null;
  }

  if (paidAt && sender) {
    const from = new Date(new Date(paidAt).getTime() - DUPLICATE_WINDOW_MS);
    const to = new Date(new Date(paidAt).getTime() + DUPLICATE_WINDOW_MS);
    const dupQuery = {
      'ai.amount': amount,
      'ai.paidAt': { $gte: from, $lte: to },
      status: { $nin: ['rejected', 'failed'] },
    };
    if (excludePaymentId) dupQuery._id = { $ne: excludePaymentId };
    const near = await BankPayment.find(dupQuery).select('ai.sender').lean();
    const normalizedSender = String(sender || '').trim().toUpperCase();
    const duplicate = near.some((row) => String(row.ai?.sender || '').trim().toUpperCase() === normalizedSender);
    if (duplicate) {
      flags.push('possibleDuplicate');
      reasons.push('Another payment with the same sender and amount is within 30 minutes.');
      if (matchConfidence === 'high') matchConfidence = 'medium';
    }
  }

  return {
    matchedInvoiceId: matched?.invoiceId || null,
    matchedCustomerId: matched?.customerId || null,
    matchType: matched ? matchType : 'none',
    matchConfidence: matched ? matchConfidence : (flags.includes('unidentified') ? 'low' : matchConfidence),
    matchReasons: reasons,
    flags: [...new Set(flags)],
    matched: matched || null,
    candidates: candidates.slice(0, 8).map((c) => ({
      invoiceId: c.invoiceId,
      invoiceNo: c.invoiceNo,
      customerId: c.customerId,
      customerName: c.customerName,
      remaining: c.remaining,
      amountType: c.amountType,
      nameScore: Math.round(c.nameScore * 100) / 100,
      dueDate: c.dueDate,
      status: c.status,
    })),
  };
}
