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

function canReview(user) {
  return user.role === 'accountant' || user.role === 'admin';
}

function serializePayment(doc) {
  const payment = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const snap = payment.matchedInvoice || {};
  const hasMatch = Boolean(payment.zohoInvoiceId);
  return {
    id: String(payment._id),
    status: payment.status,
    originalName: payment.originalName,
    mimeType: payment.mimeType,
    size: payment.size,
    ai: payment.ai,
    confirmed: payment.confirmed,
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

export async function createPayments({ user, files, env }) {
  const storage = createFileStorage(env.upload.dir);
  const created = [];
  const rejected = [];

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
      uploadedBy: user._id,
      originalName: filename,
      mimeType,
      size: bytes.length,
      imageKey,
      status: 'read',
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
          amount: extraction.amount,
          paidAt: extraction.paidAt,
          invoices: zohoInvoices,
          excludePaymentId: payment._id,
        });
        applyMatchResult(payment, match);
      }

      await payment.save();
      await writeAudit({
        userId: user._id,
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
        userId: user._id,
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
  if (user.role === 'staff') filter.uploadedBy = user._id;

  const rows = await BankPayment.find(filter).sort({ createdAt: -1 }).limit(200);
  return rows.map(serializePayment);
}

export async function getPayment(id, user) {
  const payment = await BankPayment.findById(id);
  if (!payment) throw httpError(404, 'Payment not found.');
  if (user.role === 'staff' && String(payment.uploadedBy) !== String(user._id)) {
    throw httpError(403, 'You do not have access to this payment.');
  }
  return serializePayment(payment);
}

export async function loadPayment(id, user) {
  const payment = await BankPayment.findById(id);
  if (!payment) throw httpError(404, 'Payment not found.');
  if (user.role === 'staff' && String(payment.uploadedBy) !== String(user._id)) {
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

  const amount = payment.confirmed?.amount ?? payment.ai?.amount;
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
    userId: user._id,
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
  payment.verifiedBy = user._id;
  payment.verifiedAt = new Date();
  payment.status = 'verified';
  await payment.save();
  await writeAudit({
    userId: user._id,
    action: 'verify',
    entity: 'bankPayments',
    entityId: payment._id,
    after: { statementVerified: true, status: 'verified' },
  });
  return serializePayment(payment);
}

/**
 * After statement verify: record customer payment in Zoho (marks invoice paid/partial there).
 * Independent of Documents and Follow-up.
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
    throw httpError(400, 'Match a Zoho invoice before approving.');
  }

  const amount = payment.confirmed?.amount ?? payment.ai?.amount;
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
  const paidAt = payment.confirmed?.paidAt || payment.ai?.paidAt || new Date();
  const dateIso = new Date(paidAt).toISOString().slice(0, 10);

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
        description: `FinOps bank screenshot · ${payment.ai?.sender || ''}`.slice(0, 200),
      },
    });
  } catch (error) {
    throw httpError(error.status || 422, error.message || 'Zoho did not accept the payment.');
  }

  payment.zohoPaymentId = zohoResult.paymentId;
  payment.status = 'approved';
  payment.approvedBy = user._id;
  payment.approvedAt = new Date();
  await payment.save();

  await writeAudit({
    userId: user._id,
    action: 'approve',
    entity: 'bankPayments',
    entityId: payment._id,
    after: {
      status: 'approved',
      zohoInvoiceId: payment.zohoInvoiceId,
      zohoPaymentId: payment.zohoPaymentId,
      applied,
      amount,
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
  payment.rejectedBy = user._id;
  payment.rejectedAt = new Date();
  await payment.save();
  await writeAudit({
    userId: user._id,
    action: 'reject',
    entity: 'bankPayments',
    entityId: payment._id,
    after: { status: 'rejected', rejectReason: payment.rejectReason },
  });
  return serializePayment(payment);
}

export async function listOpenInvoices(env, search = '') {
  const invoices = await loadZohoInvoices(env);
  const q = String(search || '').trim().toLowerCase();
  return invoices
    .filter((invoice) => {
      if (!q) return true;
      const hay = [invoice.invoiceNo, invoice.invoiceNumber, invoice.customerName, invoice.customerId]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    })
    .map((invoice) => ({
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
}

export function fileKeyFor(payment) {
  return { key: payment.imageKey, mimeType: payment.mimeType };
}
