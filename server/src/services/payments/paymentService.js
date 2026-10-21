import BankPayment from '../../models/BankPayment.js';
import Setting from '../../models/Setting.js';
import { createCustomerPayment, missingZohoConfig } from '../../integrations/erp/zohoBooks.js';
import {
  ensureInvoiceStore, openInvoicesForCustomer, openInvoicesForMatching, refreshCustomerInvoices,
} from '../zohoInvoices/invoiceStore.js';
import { readPaymentScreenshot } from '../ai/paymentReader.js';
import { writeAudit } from '../audit/auditLogger.js';
import { classifyAmountFit, matchPayment } from '../matching/matcher.js';
import {
  MAX_ALLOCATIONS, allocateOldestFirst, sortOldestFirst, sumRemaining,
} from '../matching/allocate.js';
import { compactName, nameSimilarity, nameTokens, normalizeName } from '../matching/normalizeName.js';
import { WEAK_NAME } from '../matching/rules.js';
import { createFileStorage, extensionFor } from '../storage/fileStorage.js';
import { displayFileName, inspectUpload, prepareStoredBytes } from '../documents/uploads.js';
import { httpError } from '../../utils/http.js';
import { parsePaymentAmount, parsePaymentDate } from '../ai/schemas.js';
import { parseDate } from '../documents/numbers.js';
import { resolveDateRange, splitCaption } from './captionHints.js';

function canReview(user) {
  return user.role === 'accountant' || user.role === 'admin';
}

/** Calendar day for Zoho Payments Received (no timezone day-shift). */
function zohoPaymentDateIso(paidAt) {
  if (!paidAt) return new Date().toISOString().slice(0, 10);
  if (typeof paidAt === 'string') {
    const parsed = parseDate(paidAt);
    if (parsed.normalized) return parsed.normalized;
    if (/^\d{4}-\d{2}-\d{2}/.test(paidAt)) return paidAt.slice(0, 10);
  }
  const d = paidAt instanceof Date ? paidAt : new Date(paidAt);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function humanAmount(payment) {
  const confirmed = payment.confirmed?.amount;
  return confirmed != null && Number.isInteger(confirmed) ? confirmed : null;
}

/** Transfer amount used for matching: the person's value, else the AI Nominal. */
function effectiveAmount(payment) {
  return humanAmount(payment) ?? payment.ai?.amount ?? null;
}

/** Amount to record in Zoho: the transfer minus any bank fee found by matching. */
function receivedAmount(payment) {
  const typed = humanAmount(payment);
  if (typed != null) return typed;
  const amount = payment.ai?.amount;
  if (amount == null) return null;
  const fee = Number.isInteger(payment.bankFee) && payment.bankFee > 0 ? payment.bankFee : 0;
  return amount - fee;
}

/** Invoices this payment is linked to, as plain rows (older records only have one). */
function allocationRows(payment) {
  if (payment.allocations?.length) {
    return payment.allocations.map((row) => ({
      invoiceId: row.invoiceId,
      invoiceNo: row.invoiceNumber,
      remaining: row.remaining,
      date: row.date || null,
      dueDate: row.dueDate || null,
      customerId: row.customerId || '',
      customerName: row.customerName || '',
    }));
  }
  if (payment.zohoInvoiceId && Number.isInteger(payment.matchedInvoice?.remaining)) {
    return [{
      invoiceId: payment.zohoInvoiceId,
      invoiceNo: payment.matchedInvoice.invoiceNumber,
      remaining: payment.matchedInvoice.remaining,
      date: null,
      dueDate: payment.matchedInvoice.dueDate || null,
      customerId: payment.zohoCustomerId || '',
      customerName: payment.matchedInvoice.customerName || '',
    }];
  }
  return [];
}

/**
 * Split the transfer over the chosen invoices.
 * If it equals their total (a bank fee on top allowed) all are paid in full; otherwise oldest first.
 * Invoices the money does not reach stay listed with applied 0 so the choice is not lost.
 * A typed amount is taken as-is (no fee guess).
 */
export function splitOver(payment, rows) {
  const sorted = sortOldestFirst(rows);
  const amount = effectiveAmount(payment);
  if (amount == null) {
    return { allocations: sorted.map((row) => ({ ...row, applied: 0 })), bankFee: 0, matchType: 'exact' };
  }
  const fit = classifyAmountFit(amount, sumRemaining(sorted), { allowFee: humanAmount(payment) == null });
  const bankFee = fit.fit === 'fee' ? fit.bankFee : 0;
  const spread = allocateOldestFirst(amount - bankFee, sorted);
  const reached = new Set(spread.allocations.map((row) => String(row.invoiceId)));
  const allocations = [
    ...spread.allocations,
    ...sorted.filter((row) => !reached.has(String(row.invoiceId))).map((row) => ({ ...row, applied: 0 })),
  ];
  let matchType = 'exact';
  if (spread.excess > 0) matchType = 'over';
  else if (allocations.some((row) => row.applied < row.remaining)) matchType = 'partial';
  return { allocations, bankFee, matchType };
}

/** Extra on a transfer can stay as Zoho credit for one customer only. */
export const MULTI_CUSTOMER_EXCESS = 'This transfer is more than the ticked invoices. Extra can stay as credit for one villa only — tick more invoices, or clear the other villas.';

/**
 * One Zoho customer payment per villa. A single customer may keep unused money as credit.
 * Several villas must add up to the received amount (bank fee already taken off).
 */
export function planZohoPayments(parts, { received, fallbackCustomerId = '' } = {}) {
  if (!Number.isInteger(received) || received <= 0) {
    return { error: 'Payment amount is missing or invalid.' };
  }
  const groups = new Map();
  for (const row of parts) {
    const customerId = String(row.customerId || fallbackCustomerId || '').trim();
    if (!customerId) {
      return { error: 'A ticked invoice has no Zoho customer. Search again and tick the invoices.' };
    }
    if (!groups.has(customerId)) groups.set(customerId, []);
    groups.get(customerId).push(row);
  }
  const applied = parts.reduce((total, row) => total + row.applied, 0);
  if (applied > received) {
    return { error: 'Applied amount is larger than the payment. Re-match the invoices.' };
  }
  const excess = received - applied;
  const list = [...groups.entries()].map(([customerId, rows]) => ({
    customerId,
    invoices: rows.map((row) => ({ invoiceId: row.invoiceId, amountApplied: row.applied })),
    applied: rows.reduce((total, row) => total + row.applied, 0),
  }));
  if (list.length > 1 && excess > 0) return { error: MULTI_CUSTOMER_EXCESS };
  return {
    groups: list.map((group) => ({
      customerId: group.customerId,
      invoices: group.invoices,
      amount: list.length === 1 ? received : group.applied,
    })),
  };
}

function storeAllocations(payment, allocations) {
  payment.allocations = allocations.map((row) => ({
    invoiceId: String(row.invoiceId),
    invoiceNumber: row.invoiceNo || row.invoiceNumber || '',
    remaining: row.remaining,
    applied: row.applied ?? 0,
    date: row.date || '',
    dueDate: row.dueDate || '',
    customerId: String(row.customerId || ''),
    customerName: row.customerName || '',
  }));
}

function appliedTotal(payment) {
  if (!payment.allocations?.length) return null;
  return payment.allocations.reduce((total, row) => total + (row.applied || 0), 0);
}

function effectivePaidAt(payment) {
  return payment.confirmed?.paidAt || payment.ai?.paidAt || null;
}

function paymentNotes(payment) {
  const customer = payment.confirmed?.customerName || '';
  const site = payment.confirmed?.siteNote || '';
  const bankSender = payment.ai?.sender || '';
  const parts = [
    customer ? `Customer: ${customer}` : '',
    site ? `Note: ${site}` : '',
    bankSender && bankSender !== customer ? `Bank sender: ${bankSender}` : '',
    'FinOps screenshot proof (stored in FinOps)',
  ].filter(Boolean);
  return parts.join(' · ').slice(0, 200);
}

function captionDateRange(payment) {
  const reference = payment.ai?.paidAt || payment.createdAt || new Date();
  return resolveDateRange(payment.confirmed?.siteNote, reference)
    || resolveDateRange(payment.ai?.note, reference)
    || null;
}

/** Zoho customer ids this payment already covers (numeric ids only). */
function paymentCustomerIds(payment) {
  const ids = [
    payment.zohoCustomerId,
    ...(payment.allocations || []).map((row) => row.customerId),
  ];
  return [...new Set(ids.map((id) => String(id || '').trim()).filter((id) => /^\d+$/.test(id)))];
}

function paymentReference(base, count, index) {
  const ref = String(base || '').trim();
  if (!ref || count < 2) return ref.slice(0, 100);
  const suffix = `-${index + 1}`;
  return `${ref.slice(0, Math.max(0, 100 - suffix.length))}${suffix}`;
}

function serializePayment(doc) {
  const payment = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const snap = payment.matchedInvoice || {};
  const hasMatch = Boolean(payment.zohoInvoiceId);
  const amountReceived = receivedAmount(payment);
  const remaining = snap.remaining ?? null;
  const multi = appliedTotal(payment);
  let amountApplied = null;
  if (multi != null && amountReceived != null) amountApplied = multi;
  else if (amountReceived != null && remaining != null) amountApplied = Math.min(amountReceived, remaining);
  const amountExcess = amountReceived != null && amountApplied != null && amountReceived > amountApplied
    ? amountReceived - amountApplied
    : 0;
  return {
    id: String(payment._id),
    status: payment.status,
    originalName: payment.originalName,
    mimeType: payment.mimeType,
    size: payment.size,
    ai: payment.ai,
    confirmed: payment.confirmed,
    amountReceived,
    amountApplied,
    amountExcess,
    bankFee: payment.bankFee || 0,
    allocations: (payment.allocations || []).map((row) => ({
      invoiceId: row.invoiceId,
      invoiceNo: row.invoiceNumber,
      remaining: row.remaining,
      applied: row.applied,
      date: row.date || null,
      dueDate: row.dueDate || null,
      customerId: row.customerId || '',
      customerName: row.customerName || '',
    })),
    matchedInvoiceId: payment.zohoInvoiceId || null,
    matchedCustomerId: payment.zohoCustomerId || null,
    zohoInvoiceId: payment.zohoInvoiceId || '',
    zohoCustomerId: payment.zohoCustomerId || '',
    zohoPaymentId: payment.zohoPaymentId || '',
    zohoPayments: (payment.zohoPayments || []).map((row) => ({
      customerId: row.customerId,
      paymentId: row.paymentId,
      amount: row.amount,
    })),
    invoiceDateRange: captionDateRange(payment),
    matchType: payment.matchType,
    matchConfidence: payment.matchConfidence,
    matchReasons: payment.matchReasons || [],
    candidates: payment.matchCandidates || [],
    flags: payment.flags || [],
    failureMessage: payment.failureMessage || '',
    statementVerified: Boolean(payment.statementVerified),
    verifiedAt: payment.verifiedAt,
    approvedAt: payment.approvedAt,
    rejectedAt: payment.rejectedAt,
    rejectReason: payment.rejectReason || '',
    overpaymentReason: payment.overpaymentReason || '',
    createdAt: payment.createdAt,
    invoice: hasMatch ? {
      id: payment.zohoInvoiceId,
      invoiceNo: snap.invoiceNumber || '',
      amount: null,
      paidAmount: null,
      remaining: snap.remaining ?? null,
      status: snap.status || '',
      issueDate: null,
      dueDate: snap.dueDate || null,
      customer: {
        id: payment.zohoCustomerId || '',
        name: snap.customerName || '',
        aliases: [],
        erpCustomerId: payment.zohoCustomerId || '',
        phone: '',
      },
    } : null,
  };
}

async function requireZohoReady(env) {
  const settings = await Setting.findOne().select('erpFeaturesEnabled zohoRefreshToken').lean();
  if (settings?.erpFeaturesEnabled !== true) {
    throw httpError(403, 'Zoho export is turned off. An admin can enable it on the overview.');
  }
  const refreshToken = settings?.zohoRefreshToken || env.zoho.refreshToken || '';
  const missing = missingZohoConfig(env.zoho, { refreshToken });
  if (missing.length) {
    throw httpError(422, `Zoho is not connected (${missing.join(', ')}). Connect Zoho from the overview.`);
  }
  if (!/^\d+$/.test(String(env.zoho.paymentDepositAccountId || ''))) {
    throw httpError(422, 'Set ZOHO_PAYMENT_DEPOSIT_ACCOUNT_ID to the Zoho bank account that receives customer transfers.');
  }
  return { refreshToken, settings };
}

/**
 * Every unpaid invoice from the MongoDB copy of Zoho (all pages, not a capped slice).
 * Safe if a balance is a few minutes old: Zoho refuses a payment larger than the real balance.
 */
async function loadZohoInvoices(env) {
  await requireZohoReady(env);
  await ensureInvoiceStore(env);
  return openInvoicesForMatching();
}

/** Match, then re-read the matched customer from Zoho and match again if their invoices changed. */
async function matchWithFreshCustomer(payment, invoices, env) {
  const match = await matchPayment({ ...matchInputs(payment), invoices });
  const customerId = match.matchedCustomerId ? String(match.matchedCustomerId) : '';
  if (!customerId) return match;
  const fresh = await refreshCustomerInvoices(env, customerId);
  if (!fresh?.changed) return match;
  return matchPayment({ ...matchInputs(payment), invoices: await openInvoicesForMatching() });
}

function applyMatchResult(payment, match) {
  payment.zohoInvoiceId = match.matchedInvoiceId ? String(match.matchedInvoiceId) : '';
  payment.zohoCustomerId = match.matchedCustomerId ? String(match.matchedCustomerId) : '';
  payment.matchType = match.matchType;
  payment.matchConfidence = match.matchConfidence;
  payment.matchReasons = match.matchReasons;
  payment.flags = match.flags;
  payment.matchCandidates = match.candidates || [];
  payment.bankFee = match.matched ? (match.bankFee || 0) : 0;
  storeAllocations(payment, match.matched ? (match.allocations || []) : []);
  if (match.matched) {
    payment.matchedInvoice = {
      invoiceNumber: match.matched.invoiceNo || '',
      customerName: match.matched.customerName || '',
      remaining: match.matched.remaining,
      dueDate: match.matched.dueDate || '',
      status: match.matched.status || '',
    };
    payment.status = 'matched';
    // Prefill caption so the list/detail show the Zoho customer without retyping.
    if (!payment.confirmed) payment.confirmed = {};
    if (!payment.confirmed.customerName && match.matched.customerName) {
      payment.confirmed.customerName = match.matched.customerName;
    }
  } else {
    payment.matchedInvoice = {
      invoiceNumber: '',
      customerName: '',
      remaining: null,
      dueDate: '',
      status: '',
    };
    payment.status = 'read';
  }
}

function parseHintsFromBody(body = {}) {
  // A pasted caption may still carry "29.9" or "INV-079837" after the name.
  const caption = splitCaption(body.customerName);
  const customerName = caption.name.slice(0, 200) || null;
  const siteNote = String(body.siteNote || caption.dateText || '').trim().slice(0, 120) || null;
  const invoiceHint = String(body.invoiceHint || body.invoiceNumberHint || caption.invoiceNo || '')
    .trim().slice(0, 80) || null;
  let amount = null;
  if (body.amount != null && String(body.amount).trim() !== '') {
    amount = Number.isInteger(body.amount) ? body.amount : parsePaymentAmount(body.amount);
    if (amount == null || !Number.isInteger(amount) || amount <= 0) {
      throw httpError(400, 'Amount must be a whole number of rupiah.');
    }
  }
  let paidAt = null;
  if (body.paidAt != null && String(body.paidAt).trim() !== '') {
    const asDate = parsePaymentDate(body.paidAt) || (() => {
      const iso = parseDate(body.paidAt).normalized;
      return iso ? new Date(`${iso}T00:00:00.000Z`) : null;
    })();
    if (!asDate) throw httpError(400, 'Payment date must be a valid day/month/year or ISO date.');
    paidAt = asDate;
  }
  return { customerName, siteNote, invoiceHint, amount, paidAt };
}

/** Everything the matcher needs from a payment: caption first, then AI fields. */
function matchInputs(payment) {
  const paidAt = effectivePaidAt(payment);
  const reference = paidAt ? new Date(paidAt) : (payment.createdAt || new Date());
  // Caption dates first ("29.9"), then the sender's transfer remark ("Sept 28-30").
  const invoiceDateRange = resolveDateRange(payment.confirmed?.siteNote, reference)
    || resolveDateRange(payment.ai?.note, reference);
  return {
    sender: payment.ai?.sender || null,
    customerName: payment.confirmed?.customerName || null,
    invoiceNumberHint: payment.confirmed?.invoiceHint || null,
    invoiceDateRange,
    amount: effectiveAmount(payment),
    adminFee: payment.ai?.adminFee ?? null,
    allowFee: humanAmount(payment) == null,
    paidAt,
    excludePaymentId: payment._id,
  };
}

async function rematchPaymentDoc(payment, env) {
  let zohoInvoices = [];
  try {
    zohoInvoices = await loadZohoInvoices(env);
  } catch (error) {
    payment.matchReasons = [error.message || 'Zoho invoices could not be loaded.'];
    payment.flags = ['unidentified'];
    payment.matchConfidence = 'low';
    payment.matchType = 'none';
    payment.zohoInvoiceId = '';
    payment.zohoCustomerId = '';
    payment.bankFee = 0;
    payment.allocations = [];
    payment.matchedInvoice = {
      invoiceNumber: '', customerName: '', remaining: null, dueDate: '', status: '',
    };
    payment.status = payment.statementVerified ? 'verified' : 'read';
    return;
  }
  const match = await matchWithFreshCustomer(payment, zohoInvoices, env);
  applyMatchResult(payment, match);
  if (payment.statementVerified && payment.zohoInvoiceId) {
    payment.status = 'verified';
  }
}

// Read a few screenshots at once; more would hit the free-tier AI rate limit.
const PAYMENT_READ_CONCURRENCY = 3;
const paymentReadWaiting = [];
let paymentReadsRunning = 0;

function drainPaymentReads() {
  while (paymentReadsRunning < PAYMENT_READ_CONCURRENCY && paymentReadWaiting.length) {
    const { id, env } = paymentReadWaiting.shift();
    paymentReadsRunning += 1;
    processPayment(id, env)
      .catch((error) => {
        console.error('Payment processing failed', error.message);
      })
      .finally(() => {
        paymentReadsRunning -= 1;
        drainPaymentReads();
      });
  }
}

function queuePaymentRead(id, env) {
  paymentReadWaiting.push({ id, env });
  drainPaymentReads();
}

/** AI read + Zoho match. Runs in the background after upload returns. */
export async function processPayment(id, env) {
  const payment = await BankPayment.findById(id);
  if (!payment) return null;
  if (!['uploaded', 'processing', 'failed'].includes(payment.status)) return payment;

  payment.status = 'processing';
  payment.failureMessage = '';
  await payment.save();

  const storage = createFileStorage(env.upload.dir);
  let bytes;
  try {
    bytes = await storage.read(payment.imageKey);
  } catch (error) {
    payment.status = 'failed';
    payment.failureMessage = 'This screenshot is no longer stored. Upload it again.';
    await payment.save();
    return payment;
  }

  try {
    // AI read and Zoho unpaid list in parallel — caption already has the customer name.
    const [visionOutcome, zohoOutcome] = await Promise.allSettled([
      readPaymentScreenshot(env, { mimeType: payment.mimeType, bytes }),
      loadZohoInvoices(env),
    ]);
    if (visionOutcome.status !== 'fulfilled') throw visionOutcome.reason;
    const extraction = visionOutcome.value;

    // Reload so a customer pick made while AI ran is not overwritten.
    const latest = await BankPayment.findById(id);
    if (!latest) return null;
    latest.ai = {
      sender: extraction.sender,
      amount: extraction.amount,
      adminFee: extraction.adminFee,
      total: extraction.total,
      note: extraction.note,
      paidAt: extraction.paidAt,
      reference: extraction.reference,
      recipient: extraction.recipient,
      transferMethod: extraction.transferMethod,
      confidence: extraction.confidence,
      model: extraction.model,
      readAt: extraction.readAt,
      raw: extraction.raw,
    };

    if (latest.zohoInvoiceId) {
      // Accountant already picked invoices; now that the amount is known, split it over them.
      const split = splitOver(latest, allocationRows(latest));
      storeAllocations(latest, split.allocations);
      latest.bankFee = split.bankFee;
      latest.matchType = split.matchType;
      // Still load every unpaid invoice for this customer for the tick list.
      if (zohoOutcome.status === 'fulfilled' && paymentCustomerIds(latest).length) {
        const ids = paymentCustomerIds(latest);
        await refreshCustomerInvoices(env, ids[0]);
        const lists = await Promise.all(ids.map((cid) => openInvoicesForCustomer(cid)));
        const rows = lists.flat();
        latest.matchCandidates = sortOldestFirst(
          rows.filter((row) => Number(row.remaining) > 0),
        ).map((row) => ({
          invoiceId: row.invoiceId,
          invoiceNo: row.invoiceNo || row.invoiceNumber,
          customerId: row.customerId,
          customerName: row.customerName,
          remaining: row.remaining,
          date: row.date || null,
          dueDate: row.dueDate || null,
          status: row.status || '',
        }));
      }
      if (!['matched', 'verified', 'approved'].includes(latest.status)) {
        latest.status = latest.statementVerified ? 'verified' : 'matched';
      }
    } else {
      let zohoInvoices = [];
      let zohoError = '';
      if (zohoOutcome.status === 'fulfilled') {
        zohoInvoices = zohoOutcome.value;
      } else {
        zohoError = zohoOutcome.reason?.message || 'Zoho invoices could not be loaded.';
      }

      if (zohoError) {
        latest.matchReasons = [zohoError];
        latest.flags = ['unidentified'];
        latest.matchConfidence = 'low';
        latest.matchType = 'none';
        latest.status = 'read';
      } else {
        // WhatsApp caption (confirmed.customerName) beats bank sender name.
        const match = await matchWithFreshCustomer(latest, zohoInvoices, env);
        applyMatchResult(latest, match);
      }
    }

    await latest.save();
    await writeAudit({
      userId: latest.uploadedBy,
      action: 'read',
      entity: 'bankPayments',
      entityId: latest._id,
      after: {
        status: latest.status,
        amount: latest.ai.amount,
        matchType: latest.matchType,
        zohoInvoiceId: latest.zohoInvoiceId,
      },
    });
    return latest;
  } catch (error) {
    const failed = await BankPayment.findById(id);
    if (!failed) return null;
    // Keep a manual match if the accountant already picked an invoice during the wait.
    if (failed.zohoInvoiceId) {
      failed.failureMessage = error.message || 'The screenshot could not be read. Enter the amount by hand if needed.';
      failed.status = failed.statementVerified ? 'verified' : 'matched';
      await failed.save();
      return failed;
    }
    failed.status = 'failed';
    failed.failureMessage = error.code === 'AI_NOT_CONFIGURED'
      ? error.message
      : (error.message || 'The screenshot could not be read.');
    await failed.save();
    await writeAudit({
      userId: failed.uploadedBy,
      action: 'read_failed',
      entity: 'bankPayments',
      entityId: failed._id,
      after: { status: 'failed', failureMessage: failed.failureMessage },
    });
    return failed;
  }
}

export async function createPayments({ user, files, env, hints = {} }) {
  const storage = createFileStorage(env.upload.dir);
  const created = [];
  const rejected = [];
  const parsedHints = parseHintsFromBody(hints);

  for (const file of files || []) {
    const filename = displayFileName(file.originalname);
    const inspected = inspectUpload({
      filename,
      bytes: file.buffer,
      maxBytes: env.upload.maxBytes,
    });
    if (!inspected.ok) {
      rejected.push({ name: filename, error: inspected.error });
      continue;
    }
    if (inspected.mime === 'application/pdf') {
      rejected.push({ name: filename, error: 'Upload a screenshot image (JPEG, PNG or WebP), not a PDF.' });
      continue;
    }

    let bytes;
    try {
      bytes = await prepareStoredBytes(file.buffer);
    } catch (error) {
      rejected.push({ name: filename, error: error.message });
      continue;
    }
    const mimeType = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : inspected.mime;
    const imageKey = await storage.save(bytes, extensionFor(mimeType));

    const payment = await BankPayment.create({
      uploadedBy: user.id,
      originalName: filename,
      mimeType,
      size: bytes.length,
      imageKey,
      status: 'uploaded',
      confirmed: {
        customerName: parsedHints.customerName,
        siteNote: parsedHints.siteNote,
        invoiceHint: parsedHints.invoiceHint,
        amount: parsedHints.amount,
        paidAt: parsedHints.paidAt,
        sender: null,
      },
    });

    await writeAudit({
      userId: user.id,
      action: 'create',
      entity: 'bankPayments',
      entityId: payment._id,
      after: { status: 'uploaded', name: payment.originalName },
    });
    created.push(serializePayment(payment));
    queuePaymentRead(payment._id, env);
  }

  return { created, rejected };
}

export async function listPayments(user, query = {}) {
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.exception === '1') {
    filter.$or = [
      { matchConfidence: { $in: ['low', null] } },
      { matchType: { $in: ['partial', 'over', 'none'] } },
      { flags: { $in: ['possibleDuplicate', 'unidentified'] } },
      { status: 'failed' },
      { zohoInvoiceId: { $in: ['', null] }, status: { $nin: ['approved', 'rejected'] } },
    ];
  }
  if (user.role === 'staff') filter.uploadedBy = user.id;

  const rows = await BankPayment.find(filter).sort({ createdAt: -1 }).limit(200);
  return rows.map(serializePayment);
}

/**
 * Payment detail for the review screen.
 * When a customer is matched, attach every unpaid Zoho invoice for that customer
 * (not only the amount-matched allocation) so the tick list does not need a second request.
 */
export async function getPayment(id, user, env = null) {
  const payment = await loadPayment(id, user);
  const dto = serializePayment(payment);
  const customerIds = paymentCustomerIds(payment);
  const closed = ['approved', 'rejected'].includes(payment.status);
  if (!env || !customerIds.length || closed) return dto;

  try {
    await ensureInvoiceStore(env);
    const lists = await Promise.all(customerIds.map((cid) => openInvoicesForCustomer(cid)));
    dto.customerOpenInvoices = lists.flat().map(mapOpenInvoiceRow);
    // Refresh in the background so opening a payment is not blocked on Zoho.
    refreshCustomerInvoices(env, customerIds[0]).catch(() => {});
  } catch (error) {
    // Fall back to matcher candidates; the UI still prefers those over amount-only allocations.
    dto.customerOpenInvoices = null;
    dto.customerOpenInvoicesError = error.message || 'Could not refresh unpaid invoices from Zoho.';
  }
  return dto;
}

export async function loadPayment(id, user) {
  const payment = await BankPayment.findById(id);
  if (!payment) throw httpError(404, 'Payment not found.');
  if (user.role === 'staff' && String(payment.uploadedBy) !== String(user.id)) {
    throw httpError(403, 'You do not have access to this payment.');
  }
  return payment;
}

export async function setPaymentMatch(id, user, body = {}, env) {
  if (!canReview(user)) throw httpError(403, 'Only an accountant can change the match.');
  const payment = await loadPayment(id, user);
  if (payment.status === 'approved') throw httpError(400, 'This payment is already approved.');
  if (payment.status === 'rejected') throw httpError(400, 'This payment was rejected.');

  // One invoice ({ invoiceId }) or several, including villas that are different Zoho customers.
  const requested = Array.isArray(body.invoiceIds) ? body.invoiceIds : [body.invoiceId];
  const invoiceIds = [...new Set(requested.map((value) => String(value ?? '').trim()))];
  if (!invoiceIds.length || invoiceIds.some((value) => !/^\d+$/.test(value))) {
    throw httpError(400, 'Choose at least one Zoho invoice.');
  }
  if (invoiceIds.length > MAX_ALLOCATIONS) {
    throw httpError(400, `Choose at most ${MAX_ALLOCATIONS} invoices for one payment.`);
  }

  const invoices = await loadZohoInvoices(env);
  const picked = invoiceIds.map((value) => invoices.find((row) => String(row.invoiceId) === value));
  if (picked.some((row) => !row)) throw httpError(404, 'An unpaid Zoho invoice was not found. Reload and try again.');
  const customerIds = new Set(picked.map((row) => String(row.customerId || '')));
  if ([...customerIds].some((cid) => !cid)) {
    throw httpError(400, 'A chosen invoice has no Zoho customer. Reload and try again.');
  }

  const before = {
    zohoInvoiceId: payment.zohoInvoiceId,
    invoiceIds: (payment.allocations || []).map((row) => row.invoiceId),
    matchType: payment.matchType,
    matchConfidence: payment.matchConfidence,
  };

  const split = splitOver(payment, picked.map((row) => ({
    invoiceId: row.invoiceId,
    invoiceNo: row.invoiceNo || row.invoiceNumber,
    remaining: row.remaining,
    date: row.date || null,
    dueDate: row.dueDate || null,
    customerId: row.customerId,
    customerName: row.customerName || '',
  })));
  if (customerIds.size > 1 && split.matchType === 'over') {
    throw httpError(400, MULTI_CUSTOMER_EXCESS);
  }
  const matchType = split.matchType;
  payment.bankFee = split.bankFee;
  storeAllocations(payment, split.allocations);
  const invoice = picked.find((row) => String(row.invoiceId) === split.allocations[0].invoiceId) || picked[0];
  const villaNames = [...new Set(picked.map((row) => row.customerName).filter(Boolean))];
  const typedName = splitCaption(String(body.customerName || '')).name;

  payment.zohoInvoiceId = invoice.invoiceId;
  payment.zohoCustomerId = invoice.customerId;
  payment.matchedInvoice = {
    invoiceNumber: invoice.invoiceNo || invoice.invoiceNumber,
    customerName: villaNames.length > 1 ? (typedName || invoice.customerName) : invoice.customerName,
    remaining: invoice.remaining,
    dueDate: invoice.dueDate || '',
    status: invoice.status || '',
  };
  payment.matchType = matchType;
  payment.matchConfidence = 'high';
  payment.matchReasons = [villaNames.length > 1
    ? `${picked.length} invoices across ${villaNames.length} villas chosen by an accountant.`
    : (picked.length > 1
      ? `${picked.length} invoices chosen by an accountant.`
      : 'Matched manually by an accountant.')];
  payment.flags = (payment.flags || []).filter((f) => f !== 'unidentified');
  // Keep every unpaid invoice for the chosen villas so the tick list is not only the amount fit.
  payment.matchCandidates = sortOldestFirst(
    invoices.filter((row) => customerIds.has(String(row.customerId)) && Number(row.remaining) > 0),
  ).map((row) => ({
    invoiceId: row.invoiceId,
    invoiceNo: row.invoiceNo || row.invoiceNumber,
    customerId: row.customerId,
    customerName: row.customerName,
    remaining: row.remaining,
    amountType: null,
    fit: null,
    bankFee: 0,
    nameScore: 1,
    date: row.date || null,
    dueDate: row.dueDate || null,
    status: row.status || '',
  }));
  // Keep "processing" so the UI still shows AI progress; finish when AI completes.
  if (!['uploaded', 'processing'].includes(payment.status)) {
    payment.status = payment.statementVerified ? 'verified' : 'matched';
  }
  if (!payment.confirmed) payment.confirmed = {};
  if (villaNames.length > 1 && typedName) payment.confirmed.customerName = typedName;
  else if (villaNames.length === 1) payment.confirmed.customerName = villaNames[0];
  await payment.save();

  await writeAudit({
    userId: user.id,
    action: 'match',
    entity: 'bankPayments',
    entityId: payment._id,
    before,
    after: {
      zohoInvoiceId: payment.zohoInvoiceId,
      invoiceIds: payment.allocations.map((row) => row.invoiceId),
      matchType: payment.matchType,
      matchConfidence: payment.matchConfidence,
    },
  });
  return serializePayment(payment);
}

export async function verifyPayment(id, user) {
  if (!canReview(user)) throw httpError(403, 'Only an accountant can verify a payment.');
  const payment = await loadPayment(id, user);
  if (payment.status === 'approved') throw httpError(400, 'This payment is already approved.');
  if (payment.status === 'rejected') throw httpError(400, 'This payment was rejected.');
  if (payment.status === 'failed') throw httpError(400, 'This screenshot failed to read.');
  if (!payment.zohoInvoiceId) {
    throw httpError(400, 'Match a Zoho invoice before verifying the bank statement.');
  }

  payment.statementVerified = true;
  payment.verifiedBy = user.id;
  payment.verifiedAt = new Date();
  payment.status = 'verified';
  await payment.save();
  await writeAudit({
    userId: user.id,
    action: 'verify',
    entity: 'bankPayments',
    entityId: payment._id,
    after: { statementVerified: true, status: 'verified' },
  });
  return serializePayment(payment);
}

/**
 * Save WhatsApp caption hints and re-match unpaid Zoho invoices.
 * Does not write to Zoho — only Record Payment (approve) does.
 */
export async function updatePaymentHints(id, user, body = {}, env) {
  if (!canReview(user)) throw httpError(403, 'Only an accountant can edit payment hints.');
  const payment = await loadPayment(id, user);
  if (payment.status === 'approved') throw httpError(400, 'This payment is already recorded in Zoho.');
  if (payment.status === 'rejected') throw httpError(400, 'This payment was rejected.');

  const hints = parseHintsFromBody(body);
  const caption = splitCaption(body.customerName);
  if (!payment.confirmed) payment.confirmed = {};
  if (body.customerName !== undefined) payment.confirmed.customerName = hints.customerName;
  if (body.siteNote !== undefined || caption.dateText) payment.confirmed.siteNote = hints.siteNote;
  if (body.invoiceHint !== undefined || body.invoiceNumberHint !== undefined || caption.invoiceNo) {
    payment.confirmed.invoiceHint = hints.invoiceHint;
  }
  if (body.amount !== undefined) payment.confirmed.amount = hints.amount;
  if (body.paidAt !== undefined) payment.confirmed.paidAt = hints.paidAt;

  // While AI is still reading, only save the caption — rematch after amount exists.
  const stillReading = ['uploaded', 'processing'].includes(payment.status);
  if (!stillReading) {
    await rematchPaymentDoc(payment, env);
  }
  await payment.save();
  await writeAudit({
    userId: user.id,
    action: 'match',
    entity: 'bankPayments',
    entityId: payment._id,
    after: {
      customerName: payment.confirmed.customerName,
      invoiceHint: payment.confirmed.invoiceHint,
      amount: payment.confirmed.amount,
      paidAt: payment.confirmed.paidAt,
      zohoInvoiceId: payment.zohoInvoiceId,
      matchConfidence: payment.matchConfidence,
      deferredRematch: stillReading,
    },
  });
  return serializePayment(payment);
}

/**
 * After statement verify: Zoho Payments Received (customerpayments.CREATE).
 * Marks the matched invoice paid/partial. Independent of Documents and Follow-up.
 */
export async function approvePayment(id, user, body = {}, env) {
  if (!canReview(user)) throw httpError(403, 'Only an accountant can approve a payment.');
  const payment = await loadPayment(id, user);
  if (payment.status === 'approved' && payment.zohoPaymentId) {
    return serializePayment(payment);
  }
  if (payment.status === 'rejected') throw httpError(400, 'This payment was rejected.');
  if (!payment.statementVerified || payment.status !== 'verified') {
    throw httpError(400, 'Tick the bank statement check before approving. A screenshot alone is not proof.');
  }
  if (!payment.zohoInvoiceId || !payment.zohoCustomerId) {
    throw httpError(400, 'Match a Zoho invoice before recording the payment.');
  }

  const rows = allocationRows(payment);
  if (!rows.length || rows.some((row) => !Number.isInteger(row.remaining) || row.remaining <= 0)) {
    throw httpError(400, 'Matched invoice remaining balance is missing. Re-match the invoice.');
  }
  // Recompute the split now so Zoho gets exactly what the screen shows for this amount.
  const split = splitOver(payment, rows);
  storeAllocations(payment, split.allocations);
  payment.bankFee = split.bankFee;
  payment.matchType = split.matchType;

  // Bank admin fee on top of the Nominal is not money the business received.
  const amount = receivedAmount(payment);
  if (amount == null || !Number.isInteger(amount) || amount <= 0) {
    throw httpError(400, 'Payment amount is missing or invalid.');
  }
  const parts = split.allocations.filter((row) => row.applied > 0);
  if (!parts.length) throw httpError(400, 'No invoice receives any of this payment.');
  const plan = planZohoPayments(parts, { received: amount, fallbackCustomerId: payment.zohoCustomerId });
  if (plan.error) throw httpError(400, plan.error);
  const applied = parts.reduce((total, row) => total + row.applied, 0);
  const excess = amount - applied;
  const reason = String(body.overpaymentReason || payment.overpaymentReason || '').trim();
  if (excess > 0) {
    // Zoho keeps unused amount as excess on the single customer; reason is optional audit text.
    payment.overpaymentReason = reason || `Excess Rp ${excess} unused on invoice`;
  }

  const dateIso = zohoPaymentDateIso(effectivePaidAt(payment) || new Date());
  const notes = [
    paymentNotes(payment),
    parts.length > 1 ? `${parts.length} invoices` : '',
    plan.groups.length > 1 ? `${plan.groups.length} villas` : '',
    payment.bankFee > 0 ? `Bank fee Rp ${payment.bankFee} not recorded` : '',
    excess > 0 ? `Excess Rp ${excess}${reason ? ` · ${reason}` : ''}` : '',
  ].filter(Boolean).join(' · ').slice(0, 200);

  const { refreshToken } = await requireZohoReady(env);
  if (!Array.isArray(payment.zohoPayments)) payment.zohoPayments = [];
  const recorded = new Set(payment.zohoPayments.map((row) => String(row.customerId)));
  for (let index = 0; index < plan.groups.length; index += 1) {
    const group = plan.groups[index];
    if (recorded.has(group.customerId)) continue;
    let zohoResult;
    try {
      zohoResult = await createCustomerPayment({
        zoho: env.zoho,
        refreshToken,
        payment: {
          customerId: group.customerId,
          invoices: group.invoices,
          amount: group.amount,
          date: dateIso,
          paymentMode: env.zoho.paymentMode || 'Bank Transfer',
          accountId: env.zoho.paymentDepositAccountId,
          referenceNumber: paymentReference(payment.ai?.reference, plan.groups.length, index),
          description: notes,
        },
      });
    } catch (error) {
      await payment.save();
      const done = payment.zohoPayments.length;
      const detail = error.message || 'Zoho did not accept the payment.';
      throw httpError(error.status || 422, done
        ? `Recorded ${done} villa payment${done === 1 ? '' : 's'}. Zoho rejected the next one: ${detail} Record again to finish the rest.`
        : detail);
    }
    payment.zohoPayments.push({
      customerId: group.customerId,
      paymentId: zohoResult.paymentId,
      amount: group.amount,
    });
    if (!payment.zohoPaymentId) payment.zohoPaymentId = zohoResult.paymentId;
    await payment.save();
  }

  payment.status = 'approved';
  payment.approvedBy = user.id;
  payment.approvedAt = new Date();
  await payment.save();
  // The recorded payments change these balances in Zoho; read each villa again now.
  for (const group of plan.groups) {
    await refreshCustomerInvoices(env, group.customerId, { force: true }).catch((error) => {
      console.error('Could not refresh customer after payment', group.customerId, error.message);
    });
  }

  await writeAudit({
    userId: user.id,
    action: 'approve',
    entity: 'bankPayments',
    entityId: payment._id,
    after: {
      status: 'approved',
      zohoInvoiceId: payment.zohoInvoiceId,
      zohoPaymentId: payment.zohoPaymentId,
      zohoPaymentIds: payment.zohoPayments.map((row) => row.paymentId),
      invoices: parts.map((row) => ({ invoiceId: row.invoiceId, applied: row.applied, customerId: row.customerId || '' })),
      applied,
      amount,
      bankFee: payment.bankFee || 0,
      date: dateIso,
    },
  });

  return serializePayment(payment);
}

export async function rejectPayment(id, user, reason) {
  if (!canReview(user)) throw httpError(403, 'Only an accountant can reject a payment.');
  const text = String(reason || '').trim();
  if (!text) throw httpError(400, 'A reject reason is required.');
  const payment = await loadPayment(id, user);
  if (payment.status === 'approved') {
    throw httpError(400, 'An approved payment cannot be rejected. Reverse it in Zoho by hand if needed.');
  }
  payment.status = 'rejected';
  payment.rejectReason = text.slice(0, 500);
  payment.rejectedBy = user.id;
  payment.rejectedAt = new Date();
  await payment.save();
  await writeAudit({
    userId: user.id,
    action: 'reject',
    entity: 'bankPayments',
    entityId: payment._id,
    after: { status: 'rejected', rejectReason: payment.rejectReason },
  });
  return serializePayment(payment);
}

/**
 * Search rank for one customer name. Spacing and "Toko"/"PT" are ignored, so
 * "Toko Sariboga" finds "Toko Sari Boga". Returns null when it is not a hit.
 */
export function customerSearchRank(query, customerName) {
  const plain = String(customerName || '').toLowerCase();
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  if (plain.startsWith(q)) return 0;
  const compactQ = compactName(q);
  const compact = compactName(customerName);
  if (compactQ && compact.startsWith(compactQ)) return 0;
  if (plain.includes(q) || (compactQ && compact.includes(compactQ))) return 1;
  const score = nameSimilarity(q, customerName);
  return score >= WEAK_NAME ? 3 - score : null;
}

/**
 * Group name such as "AN Balinest" matches every villa that contains the distinctive words
 * ("Balinest Villa Kristi"), so the accountant does not search each villa.
 * Short words (AN, PT) are ignored. 0 = name starts with the word, 1 = it appears later.
 */
export function groupNameRank(query, customerName) {
  const tokens = nameTokens(query).filter((token) => token.length > 2);
  if (!tokens.length) return null;
  const spaced = normalizeName(customerName);
  const compact = compactName(customerName);
  if (!spaced || !compact) return null;
  const hit = tokens.every((token) => spaced.includes(token) || compact.includes(token));
  if (!hit) return null;
  return spaced.startsWith(tokens[0]) || compact.startsWith(tokens[0]) ? 0 : 1;
}

function bestNameRank(query, customerName) {
  const ranks = [customerSearchRank(query, customerName), groupNameRank(query, customerName)]
    .filter((rank) => rank != null);
  return ranks.length ? Math.min(...ranks) : null;
}

/** INV-079837, INV 79837, or several numbers pasted together. */
export function parseInvoiceNumbers(text) {
  const found = [];
  for (const match of String(text || '').matchAll(/\bINV[-\s]?(\d{3,})\b/gi)) {
    const no = `INV-${match[1]}`;
    if (!found.includes(no)) found.push(no);
  }
  return found;
}

function invoiceNoKey(value) {
  return String(value || '').toLowerCase().replace(/[\s-]+/g, '');
}

function invoiceSearchRank(query, invoiceNo) {
  const q = invoiceNoKey(query);
  const no = invoiceNoKey(invoiceNo);
  if (!q || !no) return null;
  if (no === q || no === `inv${q}` || no.endsWith(q)) return 0;
  if (no.includes(q)) return 1;
  return null;
}

function mapOpenInvoiceRow(invoice) {
  return {
    id: invoice.invoiceId,
    invoiceNo: invoice.invoiceNo || invoice.invoiceNumber,
    amount: null,
    paidAmount: null,
    remaining: invoice.remaining,
    status: invoice.status,
    date: invoice.date || null,
    dueDate: invoice.dueDate,
    customerName: invoice.customerName,
    erpCustomerId: invoice.customerId,
  };
}

const OPEN_INVOICE_SEARCH_LIMIT = 200;

function isoDay(value, label) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw httpError(400, `${label} must be a YYYY-MM-DD date.`);
  return text;
}

/** Invoice date inside the filter. Undated rows stay, so a missing date does not hide money. */
function inInvoiceDateRange(row, fromDate, toDate) {
  if (!fromDate && !toDate) return true;
  const day = String(row.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return true;
  if (fromDate && day < fromDate) return false;
  if (toDate && day > toDate) return false;
  return true;
}

function byInvoiceDay(a, b) {
  const byDay = String(a.date || a.dueDate || '').localeCompare(String(b.date || b.dueDate || ''));
  return byDay || String(a.invoiceNo || '').localeCompare(String(b.invoiceNo || ''));
}

/**
 * Pick which open-invoice rows the Payments UI should show.
 * customerId → every unpaid invoice for that customer (not filtered by transfer amount).
 * search → name / invoice# matches, including a group name across villas.
 * fromDate/toDate limit invoice dates the way Receivable Summary does.
 * Neither search nor customer → first 100.
 * Returns every match; listOpenInvoices applies the display cap.
 */
export function selectOpenInvoices(mapped, search = '', { customerId = '', fromDate = '', toDate = '' } = {}) {
  const dated = mapped.filter((row) => inInvoiceDateRange(row, fromDate, toDate));
  const cid = String(customerId || '').trim();
  if (cid) {
    return dated
      .filter((row) => String(row.erpCustomerId) === cid && Number(row.remaining) > 0)
      .sort(byInvoiceDay);
  }

  const q = String(search || '').trim();
  if (!q) return dated.slice(0, 100);

  const numbers = parseInvoiceNumbers(q);
  if (numbers.length > 1) {
    const want = new Set(numbers.map((no) => invoiceNoKey(no)));
    return dated.filter((row) => want.has(invoiceNoKey(row.invoiceNo)));
  }

  const nameRanks = new Map();
  const scored = [];
  for (const row of dated) {
    if (!nameRanks.has(row.customerName)) {
      nameRanks.set(row.customerName, bestNameRank(q, row.customerName));
    }
    const invRank = invoiceSearchRank(numbers[0] || q, row.invoiceNo);
    const nameRank = nameRanks.get(row.customerName);
    // Invoice number first so a Balinest payment can be ticked from the INV without the villa name.
    let rank = invRank;
    if (rank == null && nameRank != null) rank = nameRank + 2;
    if (rank == null) continue;
    scored.push({ row, rank });
  }
  scored.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const byName = String(a.row.customerName || '').localeCompare(String(b.row.customerName || ''));
    if (byName) return byName;
    return byInvoiceDay(a.row, b.row);
  });
  return scored.map((entry) => entry.row);
}

/**
 * Unpaid Zoho invoices for the Payments link UI.
 * With customerId: every unpaid invoice for that customer (oldest first) — not amount-filtered.
 * With a keyword: name / invoice# matches, best name first, oldest invoice first.
 */
export async function listOpenInvoices(env, search = '', { customerId = '', fromDate = '', toDate = '' } = {}) {
  const from = isoDay(fromDate, 'From');
  const to = isoDay(toDate, 'To');
  if (from && to && from > to) throw httpError(400, 'The start date must be on or before the end date.');
  const cid = String(customerId || '').trim();
  if (cid) {
    await requireZohoReady(env);
    await ensureInvoiceStore(env);
    let invoices = await openInvoicesForCustomer(cid);
    if (!invoices.length) {
      await refreshCustomerInvoices(env, cid, { force: true });
      invoices = await openInvoicesForCustomer(cid);
    } else {
      refreshCustomerInvoices(env, cid).catch(() => {});
    }
    const rows = selectOpenInvoices(invoices.map(mapOpenInvoiceRow), '', { customerId: cid, fromDate: from, toDate: to });
    return { invoices: rows, truncated: false };
  }
  const invoices = await loadZohoInvoices(env);
  const rows = selectOpenInvoices(invoices.map(mapOpenInvoiceRow), search, { fromDate: from, toDate: to });
  const q = String(search || '').trim();
  if (!q || parseInvoiceNumbers(q).length > 1) return { invoices: rows, truncated: false };
  return {
    invoices: rows.slice(0, OPEN_INVOICE_SEARCH_LIMIT),
    truncated: rows.length > OPEN_INVOICE_SEARCH_LIMIT,
  };
}

export function fileKeyFor(payment) {
  return { key: payment.imageKey, mimeType: payment.mimeType };
}

export async function deletePayment(id, user, env) {
  const payment = await loadPayment(id, user);
  if (payment.status === 'processing' || payment.status === 'uploaded') {
    throw httpError(400, 'This screenshot is still being read. Wait a moment, then try again.');
  }
  if (payment.zohoPaymentId || (payment.zohoPayments || []).some((row) => row.paymentId)) {
    throw httpError(400, 'This payment was already recorded in Zoho. Reverse it there first.');
  }
  const key = payment.imageKey;
  await writeAudit({
    userId: user.id,
    action: 'delete',
    entity: 'bankPayments',
    entityId: payment._id,
    before: { status: payment.status, originalName: payment.originalName },
  });
  await BankPayment.deleteOne({ _id: payment._id });
  if (key) {
    await createFileStorage(env.upload.dir).remove(key).catch((error) => {
      console.error('Could not remove payment screenshot', key, error.message);
    });
  }
  return { id: String(id), deleted: true };
}
