import BankPayment from '../../models/BankPayment.js';
import Setting from '../../models/Setting.js';
import {
  createCustomerPayment,
  listUnpaidInvoicesForMatching,
  missingZohoConfig,
} from '../../integrations/erp/zohoBooks.js';
import { readPaymentScreenshot } from '../ai/paymentReader.js';
import { writeAudit } from '../audit/auditLogger.js';
import { matchPayment } from '../matching/matcher.js';
import { createFileStorage, extensionFor } from '../storage/fileStorage.js';
import { displayFileName, inspectUpload, prepareStoredBytes } from '../documents/uploads.js';
import { httpError } from '../../utils/http.js';
import { parsePaymentAmount, parsePaymentDate } from '../ai/schemas.js';
import { parseDate } from '../documents/numbers.js';

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

function effectiveAmount(payment) {
  const confirmed = payment.confirmed?.amount;
  if (confirmed != null && Number.isInteger(confirmed)) return confirmed;
  return payment.ai?.amount ?? null;
}

function effectivePaidAt(payment) {
  return payment.confirmed?.paidAt || payment.ai?.paidAt || null;
}

function matchCustomerName(payment) {
  return payment.confirmed?.customerName
    || payment.confirmed?.sender
    || payment.ai?.sender
    || null;
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

function serializePayment(doc) {
  const payment = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const snap = payment.matchedInvoice || {};
  const hasMatch = Boolean(payment.zohoInvoiceId);
  const amountReceived = effectiveAmount(payment);
  const remaining = snap.remaining ?? null;
  const amountApplied = amountReceived != null && remaining != null
    ? Math.min(amountReceived, remaining)
    : null;
  const amountExcess = amountReceived != null && remaining != null && amountReceived > remaining
    ? amountReceived - remaining
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
    matchedInvoiceId: payment.zohoInvoiceId || null,
    matchedCustomerId: payment.zohoCustomerId || null,
    zohoInvoiceId: payment.zohoInvoiceId || '',
    zohoCustomerId: payment.zohoCustomerId || '',
    zohoPaymentId: payment.zohoPaymentId || '',
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

const ZOHO_INVOICE_CACHE_MS = 3 * 60 * 1000;
let zohoInvoiceCache = { at: 0, orgId: '', invoices: null };

/** Short in-memory cache so upload/match/search do not re-pull Zoho every time. */
async function loadZohoInvoices(env, { force = false } = {}) {
  const { refreshToken } = await requireZohoReady(env);
  const orgId = String(env.zoho?.organizationId || '');
  const fresh = zohoInvoiceCache.invoices
    && zohoInvoiceCache.orgId === orgId
    && (Date.now() - zohoInvoiceCache.at) < ZOHO_INVOICE_CACHE_MS;
  if (!force && fresh) return zohoInvoiceCache.invoices;
  const invoices = await listUnpaidInvoicesForMatching({ zoho: env.zoho, refreshToken });
  zohoInvoiceCache = { at: Date.now(), orgId, invoices };
  return invoices;
}

export function clearZohoInvoiceCache() {
  zohoInvoiceCache = { at: 0, orgId: '', invoices: null };
}

function applyMatchResult(payment, match) {
  payment.zohoInvoiceId = match.matchedInvoiceId ? String(match.matchedInvoiceId) : '';
  payment.zohoCustomerId = match.matchedCustomerId ? String(match.matchedCustomerId) : '';
  payment.matchType = match.matchType;
  payment.matchConfidence = match.matchConfidence;
  payment.matchReasons = match.matchReasons;
  payment.flags = match.flags;
  payment.matchCandidates = match.candidates || [];
  if (match.matched) {
    payment.matchedInvoice = {
      invoiceNumber: match.matched.invoiceNo || '',
      customerName: match.matched.customerName || '',
      remaining: match.matched.remaining,
      dueDate: match.matched.dueDate || '',
      status: match.matched.status || '',
    };
    payment.status = 'matched';
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
  const customerName = String(body.customerName || '').trim().slice(0, 200) || null;
  const siteNote = String(body.siteNote || '').trim().slice(0, 120) || null;
  const invoiceHint = String(body.invoiceHint || body.invoiceNumberHint || '').trim().slice(0, 80) || null;
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

async function rematchPaymentDoc(payment, env) {
  const amount = effectiveAmount(payment);
  const paidAt = effectivePaidAt(payment);
  const customerName = matchCustomerName(payment);
  const invoiceHint = payment.confirmed?.invoiceHint || null;
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
    payment.matchedInvoice = {
      invoiceNumber: '', customerName: '', remaining: null, dueDate: '', status: '',
    };
    payment.status = payment.statementVerified ? 'verified' : 'read';
    return;
  }
  const match = await matchPayment({
    sender: payment.ai?.sender,
    customerName,
    invoiceNumberHint: invoiceHint,
    amount,
    paidAt,
    invoices: zohoInvoices,
    excludePaymentId: payment._id,
  });
  applyMatchResult(payment, match);
  if (payment.statementVerified && payment.zohoInvoiceId) {
    payment.status = 'verified';
  }
}

let paymentReadQueue = Promise.resolve();

function queuePaymentRead(id, env) {
  paymentReadQueue = paymentReadQueue
    .then(() => processPayment(id, env))
    .catch((error) => {
      console.error('Payment processing failed', error.message);
    });
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
    const extraction = await readPaymentScreenshot(env, {
      mimeType: payment.mimeType,
      bytes,
    });

    // Reload so a customer pick made while AI ran is not overwritten.
    const latest = await BankPayment.findById(id);
    if (!latest) return null;
    latest.ai = {
      sender: extraction.sender,
      amount: extraction.amount,
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
      // Accountant already matched; only refresh amount-based match type.
      const amount = effectiveAmount(latest);
      const remaining = latest.matchedInvoice?.remaining;
      if (amount != null && Number.isInteger(remaining)) {
        if (amount < remaining) latest.matchType = 'partial';
        else if (amount > remaining) latest.matchType = 'over';
        else latest.matchType = 'exact';
      }
      if (!['matched', 'verified', 'approved'].includes(latest.status)) {
        latest.status = latest.statementVerified ? 'verified' : 'matched';
      }
    } else {
      let zohoInvoices = [];
      let zohoError = '';
      try {
        zohoInvoices = await loadZohoInvoices(env);
      } catch (error) {
        zohoError = error.message || 'Zoho invoices could not be loaded.';
      }

      if (zohoError) {
        latest.matchReasons = [zohoError];
        latest.flags = ['unidentified'];
        latest.matchConfidence = 'low';
        latest.matchType = 'none';
        latest.status = 'read';
      } else {
        const match = await matchPayment({
          sender: extraction.sender,
          customerName: latest.confirmed?.customerName || extraction.sender,
          invoiceNumberHint: latest.confirmed?.invoiceHint || null,
          amount: latest.confirmed?.amount ?? extraction.amount,
          paidAt: latest.confirmed?.paidAt || extraction.paidAt,
          invoices: zohoInvoices,
          excludePaymentId: latest._id,
        });
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

export async function getPayment(id, user) {
  const payment = await BankPayment.findById(id);
  if (!payment) throw httpError(404, 'Payment not found.');
  if (user.role === 'staff' && String(payment.uploadedBy) !== String(user.id)) {
    throw httpError(403, 'You do not have access to this payment.');
  }
  return serializePayment(payment);
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

  const invoiceId = String(body.invoiceId || '').trim();
  if (!/^\d+$/.test(invoiceId)) throw httpError(400, 'Choose a Zoho invoice.');

  const invoices = await loadZohoInvoices(env);
  const invoice = invoices.find((row) => String(row.invoiceId) === invoiceId);
  if (!invoice) throw httpError(404, 'That unpaid Zoho invoice was not found.');

  const before = {
    zohoInvoiceId: payment.zohoInvoiceId,
    matchType: payment.matchType,
    matchConfidence: payment.matchConfidence,
  };

  const amount = effectiveAmount(payment);
  let matchType = 'exact';
  if (amount != null && Number.isInteger(amount)) {
    if (amount < invoice.remaining) matchType = 'partial';
    else if (amount > invoice.remaining) matchType = 'over';
  }

  payment.zohoInvoiceId = invoice.invoiceId;
  payment.zohoCustomerId = invoice.customerId;
  payment.matchedInvoice = {
    invoiceNumber: invoice.invoiceNo || invoice.invoiceNumber,
    customerName: invoice.customerName,
    remaining: invoice.remaining,
    dueDate: invoice.dueDate || '',
    status: invoice.status || '',
  };
  payment.matchType = matchType;
  payment.matchConfidence = 'high';
  payment.matchReasons = ['Matched manually by an accountant.'];
  payment.flags = (payment.flags || []).filter((f) => f !== 'unidentified');
  // Keep "processing" so the UI still shows AI progress; finish when AI completes.
  if (!['uploaded', 'processing'].includes(payment.status)) {
    payment.status = payment.statementVerified ? 'verified' : 'matched';
  }
  if (!payment.confirmed) payment.confirmed = {};
  payment.confirmed.customerName = invoice.customerName || payment.confirmed.customerName;
  await payment.save();

  await writeAudit({
    userId: user.id,
    action: 'match',
    entity: 'bankPayments',
    entityId: payment._id,
    before,
    after: {
      zohoInvoiceId: payment.zohoInvoiceId,
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
  if (!payment.confirmed) payment.confirmed = {};
  if (body.customerName !== undefined) payment.confirmed.customerName = hints.customerName;
  if (body.siteNote !== undefined) payment.confirmed.siteNote = hints.siteNote;
  if (body.invoiceHint !== undefined || body.invoiceNumberHint !== undefined) {
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

  const amount = effectiveAmount(payment);
  if (amount == null || !Number.isInteger(amount) || amount <= 0) {
    throw httpError(400, 'Payment amount is missing or invalid.');
  }

  const remaining = Number(payment.matchedInvoice?.remaining);
  if (!Number.isInteger(remaining) || remaining <= 0) {
    throw httpError(400, 'Matched invoice remaining balance is missing. Re-match the invoice.');
  }
  const applied = Math.min(amount, remaining);
  const excess = amount > remaining ? amount - remaining : 0;
  const reason = String(body.overpaymentReason || payment.overpaymentReason || '').trim();
  if (excess > 0) {
    // Zoho keeps unused amount as excess; reason is optional audit text.
    payment.overpaymentReason = reason || `Excess Rp ${excess} unused on invoice`;
  }

  const dateIso = zohoPaymentDateIso(effectivePaidAt(payment) || new Date());
  const notes = [
    paymentNotes(payment),
    excess > 0 ? `Excess Rp ${excess}${reason ? ` · ${reason}` : ''}` : '',
  ].filter(Boolean).join(' · ').slice(0, 200);

  const { refreshToken } = await requireZohoReady(env);
  let zohoResult;
  try {
    zohoResult = await createCustomerPayment({
      zoho: env.zoho,
      refreshToken,
      payment: {
        customerId: payment.zohoCustomerId,
        invoiceId: payment.zohoInvoiceId,
        amount,
        amountApplied: applied,
        date: dateIso,
        paymentMode: env.zoho.paymentMode || 'Bank Transfer',
        accountId: env.zoho.paymentDepositAccountId,
        referenceNumber: payment.ai?.reference || '',
        description: notes,
      },
    });
  } catch (error) {
    throw httpError(error.status || 422, error.message || 'Zoho did not accept the payment.');
  }

  payment.zohoPaymentId = zohoResult.paymentId;
  payment.status = 'approved';
  payment.approvedBy = user.id;
  payment.approvedAt = new Date();
  await payment.save();
  clearZohoInvoiceCache();

  await writeAudit({
    userId: user.id,
    action: 'approve',
    entity: 'bankPayments',
    entityId: payment._id,
    after: {
      status: 'approved',
      zohoInvoiceId: payment.zohoInvoiceId,
      zohoPaymentId: payment.zohoPaymentId,
      applied,
      amount,
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
 * Unpaid Zoho invoices for the Payments link UI.
 * With a keyword (e.g. "form"), return name / invoice# matches, name hits first.
 */
export async function listOpenInvoices(env, search = '') {
  const invoices = await loadZohoInvoices(env);
  const q = String(search || '').trim().toLowerCase();
  const mapped = invoices.map((invoice) => ({
    id: invoice.invoiceId,
    invoiceNo: invoice.invoiceNo || invoice.invoiceNumber,
    amount: null,
    paidAmount: null,
    remaining: invoice.remaining,
    status: invoice.status,
    dueDate: invoice.dueDate,
    customerName: invoice.customerName,
    erpCustomerId: invoice.customerId,
  }));
  if (!q) return mapped.slice(0, 100);

  const scored = [];
  for (const row of mapped) {
    const name = String(row.customerName || '').toLowerCase();
    const invoiceNo = String(row.invoiceNo || '').toLowerCase();
    const nameStarts = name.startsWith(q);
    const nameHas = name.includes(q);
    const invHas = invoiceNo.includes(q);
    if (!nameHas && !invHas) continue;
    let rank = 3;
    if (nameStarts) rank = 0;
    else if (nameHas) rank = 1;
    else rank = 2;
    scored.push({ row, rank });
  }
  scored.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return String(a.row.customerName || '').localeCompare(String(b.row.customerName || ''));
  });
  return scored.slice(0, 40).map((entry) => entry.row);
}

export function fileKeyFor(payment) {
  return { key: payment.imageKey, mimeType: payment.mimeType };
}

export async function deletePayment(id, user, env) {
  const payment = await loadPayment(id, user);
  if (payment.status === 'processing' || payment.status === 'uploaded') {
    throw httpError(400, 'This screenshot is still being read. Wait a moment, then try again.');
  }
  if (payment.zohoPaymentId) {
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
