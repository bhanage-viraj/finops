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

function normalizeInvoiceNo(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

/**
 * Suggest an invoice match from AI fields against an invoice list (usually Zoho unpaid).
 * Never auto-approves or marks paid — returns a suggestion only.
 *
 * Prefer caption customerName over bank sender when both exist.
 * Exact invoiceNumberHint → high confidence when unique.
 *
 * Each invoice: { invoiceId, invoiceNo, customerId, customerName, aliases?, remaining, dueDate?, date? }
 */
export async function matchPayment({
  sender,
  customerName = null,
  invoiceNumberHint = null,
  amount,
  paidAt,
  invoices = [],
  excludePaymentId = null,
}) {
  const reasons = [];
  const flags = [];
  // Caption / Zoho customer name beats bank account holder on the screenshot.
  const matchName = String(customerName || sender || '').trim() || null;

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

  const hint = normalizeInvoiceNo(invoiceNumberHint);
  if (hint) {
    const byNumber = openInvoices.filter(
      (inv) => normalizeInvoiceNo(inv.invoiceNo || inv.invoiceNumber) === hint,
    );
    if (byNumber.length === 1) {
      const invoice = byNumber[0];
      const remaining = Number(invoice.remaining);
      const amountType = classifyAmount(amount, remaining);
      return {
        matchedInvoiceId: invoice.invoiceId,
        matchedCustomerId: invoice.customerId,
        matchType: amountType,
        matchConfidence: 'high',
        matchReasons: ['Invoice number from the payment caption matched exactly.'],
        flags: [],
        matched: {
          invoiceId: invoice.invoiceId,
          invoiceNo: invoice.invoiceNo || invoice.invoiceNumber,
          customerId: invoice.customerId,
          customerName: invoice.customerName,
          remaining,
          amountType,
          nameScore: 1,
          dateOk: true,
          dueDate: invoice.dueDate || null,
          status: invoice.status || '',
        },
        candidates: [{
          invoiceId: invoice.invoiceId,
          invoiceNo: invoice.invoiceNo || invoice.invoiceNumber,
          customerId: invoice.customerId,
          customerName: invoice.customerName,
          remaining,
          amountType,
          nameScore: 1,
          dueDate: invoice.dueDate || null,
          status: invoice.status || '',
        }],
      };
    }
    if (byNumber.length > 1) {
      reasons.push('Invoice number hint matched more than one unpaid invoice — pick one.');
      flags.push('unidentified');
    } else {
      reasons.push('Invoice number hint did not match an unpaid Zoho invoice.');
    }
  }
  const scoredCustomers = openInvoices
    .map((inv) => ({
      name: inv.customerName,
      aliases: inv.aliases || [],
      score: bestCustomerNameScore(matchName, { name: inv.customerName, aliases: inv.aliases || [] }),
    }))
    .filter((row) => row.score >= WEAK_NAME);

  const candidates = [];
  for (const invoice of openInvoices) {
    const customer = { name: invoice.customerName, aliases: invoice.aliases || [] };
    const nameScore = bestCustomerNameScore(matchName, customer);
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
    reasons.push(customerName
      ? 'Strong caption customer name match and exact remaining balance.'
      : 'Strong sender name match and exact remaining balance.');
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
      reasons.push('Exact amount with a weak name match.');
    } else if (weakExact.length > 1) {
      matchConfidence = 'low';
      matchType = 'exact';
      reasons.push('Exact amount matches more than one invoice with weak names.');
      flags.push('unidentified');
    } else {
      const amountOnly = candidates.filter((c) => c.amountType === 'exact' && c.dateOk);
      if (amountOnly.length === 1 && (!matchName || scoredCustomers.length === 0)) {
        matched = amountOnly[0];
        matchConfidence = 'low';
        matchType = 'exact';
        reasons.push('Only amount matched; customer name was weak or missing. Not auto-linked as high.');
        flags.push('unidentified');
      } else if (!reasons.length) {
        reasons.push('No confident customer and amount match.');
        flags.push('unidentified');
      } else {
        flags.push('unidentified');
      }
    }
  }

  const autoLink = matchConfidence === 'high' || matchConfidence === 'medium';
  if (!autoLink) {
    matched = null;
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
    const normalizedSender = matchName.toUpperCase();
    const duplicate = near.some((row) => {
      const name = row.confirmed?.customerName || row.confirmed?.sender || row.ai?.sender || '';
      return String(name).trim().toUpperCase() === normalizedSender;
    });
    if (duplicate) {
      flags.push('possibleDuplicate');
      reasons.push('Another payment with the same customer and amount is within 30 minutes.');
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
