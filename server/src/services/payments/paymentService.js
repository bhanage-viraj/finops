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

async function loadZohoInvoices(env) {
  const { refreshToken } = await requireZohoReady(env);
  return listUnpaidInvoicesForMatching({ zoho: env.zoho, refreshToken });
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

export async function createPayments({ user, files, env, hints = {} }) {
  const storage = createFileStorage(env.upload.dir);
  const created = [];
  const rejected = [];
  const parsedHints = parseHintsFromBody(hints);

  let zohoInvoices = [];
  let zohoError = '';
  try {
    zohoInvoices = await loadZohoInvoices(env);
  } catch (error) {
    zohoError = error.message || 'Zoho invoices could not be loaded.';
  }

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
      status: 'read',
      confirmed: {
        customerName: parsedHints.customerName,
        siteNote: parsedHints.siteNote,
        invoiceHint: parsedHints.invoiceHint,
        amount: parsedHints.amount,
        paidAt: parsedHints.paidAt,
        sender: null,
      },
    });

    try {
      const extraction = await readPaymentScreenshot(env, { mimeType, bytes });
      payment.ai = {
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

      if (zohoError) {
        payment.matchReasons = [zohoError];
        payment.flags = ['unidentified'];
        payment.matchConfidence = 'low';
        payment.matchType = 'none';
        payment.status = 'read';
      } else {
        const match = await matchPayment({
          sender: extraction.sender,
          customerName: parsedHints.customerName || extraction.sender,
          invoiceNumberHint: parsedHints.invoiceHint,
          amount: parsedHints.amount ?? extraction.amount,
          paidAt: parsedHints.paidAt || extraction.paidAt,
          invoices: zohoInvoices,
          excludePaymentId: payment._id,
        });
        applyMatchResult(payment, match);
      }

      await payment.save();
      await writeAudit({
        userId: user.id,
        action: 'create',
        entity: 'bankPayments',
        entityId: payment._id,
        after: {
          status: payment.status,
          amount: payment.ai.amount,
          matchType: payment.matchType,
          matchConfidence: payment.matchConfidence,
          zohoInvoiceId: payment.zohoInvoiceId,
        },
      });
      created.push(serializePayment(payment));
    } catch (error) {
      payment.status = 'failed';
      payment.failureMessage = error.code === 'AI_NOT_CONFIGURED'
        ? error.message
        : (error.message || 'The screenshot could not be read.');
      await payment.save();
      await writeAudit({
        userId: user.id,
        action: 'create',
        entity: 'bankPayments',
        entityId: payment._id,
        after: { status: 'failed', failureMessage: payment.failureMessage },
      });
      rejected.push({ name: filename, error: payment.failureMessage, id: String(payment._id) });
    }
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
  payment.status = payment.statementVerified ? 'verified' : 'matched';
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

  await rematchPaymentDoc(payment, env);
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
  if (amount > remaining) {
    const reason = String(body.overpaymentReason || payment.overpaymentReason || '').trim();
    if (!reason) {
      throw httpError(400, 'Overpayments need a reason before approval.');
    }
    payment.overpaymentReason = reason;
  }

  const applied = Math.min(amount, remaining);
  const dateIso = zohoPaymentDateIso(effectivePaidAt(payment) || new Date());

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
        paymentMode: 'banktransfer',
        accountId: env.zoho.paymentDepositAccountId,
        referenceNumber: payment.ai?.reference || '',
        description: paymentNotes(payment),
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
