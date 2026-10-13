import BankPayment from '../../models/BankPayment.js';
import Customer from '../../models/Customer.js';
import Invoice, { remainingBalance } from '../../models/Invoice.js';
import { readPaymentScreenshot } from '../ai/paymentReader.js';
import { writeAudit } from '../audit/auditLogger.js';
import { matchPayment } from '../matching/matcher.js';
import { createFileStorage, extensionFor } from '../storage/fileStorage.js';
import { displayFileName, inspectUpload, prepareStoredBytes } from '../documents/uploads.js';
import { httpError } from '../../utils/http.js';

function canReview(user) {
  return user.role === 'accountant' || user.role === 'admin';
}

function populateInvoice(query) {
  return query
    .populate({
      path: 'matchedInvoiceId',
      populate: { path: 'customerId', select: 'name aliases erpCustomerId phone' },
    })
    .populate('matchedCustomerId', 'name aliases erpCustomerId phone')
    .populate('confirmed.invoiceId', 'invoiceNo amount paidAmount status dueDate issueDate customerId');
}

function serializePayment(doc) {
  const payment = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const invoice = payment.matchedInvoiceId && typeof payment.matchedInvoiceId === 'object'
    ? payment.matchedInvoiceId
    : null;
  const customer = payment.matchedCustomerId && typeof payment.matchedCustomerId === 'object'
    ? payment.matchedCustomerId
    : invoice?.customerId && typeof invoice.customerId === 'object'
      ? invoice.customerId
      : null;

  return {
    id: String(payment._id),
    status: payment.status,
    originalName: payment.originalName,
    mimeType: payment.mimeType,
    size: payment.size,
    ai: payment.ai,
    confirmed: payment.confirmed,
    matchedInvoiceId: invoice ? String(invoice._id) : (payment.matchedInvoiceId ? String(payment.matchedInvoiceId) : null),
    matchedCustomerId: customer ? String(customer._id) : (payment.matchedCustomerId ? String(payment.matchedCustomerId) : null),
    matchType: payment.matchType,
    matchConfidence: payment.matchConfidence,
    matchReasons: payment.matchReasons || [],
    flags: payment.flags || [],
    failureMessage: payment.failureMessage || '',
    statementVerified: Boolean(payment.statementVerified),
    verifiedAt: payment.verifiedAt,
    approvedAt: payment.approvedAt,
    rejectedAt: payment.rejectedAt,
    rejectReason: payment.rejectReason || '',
    overpaymentReason: payment.overpaymentReason || '',
    createdAt: payment.createdAt,
    invoice: invoice ? {
      id: String(invoice._id),
      invoiceNo: invoice.invoiceNo,
      amount: invoice.amount,
      paidAmount: invoice.paidAmount,
      remaining: remainingBalance(invoice),
      status: invoice.status,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      customer: customer ? {
        id: String(customer._id),
        name: customer.name,
        aliases: customer.aliases || [],
        erpCustomerId: customer.erpCustomerId,
        phone: customer.phone || '',
      } : null,
    } : null,
  };
}

async function applyMatch(payment, extraction) {
  const match = await matchPayment({
    sender: extraction.sender,
    amount: extraction.amount,
    paidAt: extraction.paidAt,
    excludePaymentId: payment._id,
  });
  payment.matchedInvoiceId = match.matchedInvoiceId;
  payment.matchedCustomerId = match.matchedCustomerId;
  payment.matchType = match.matchType;
  payment.matchConfidence = match.matchConfidence;
  payment.matchReasons = match.matchReasons;
  payment.flags = match.flags;
  payment.status = match.matchedInvoiceId ? 'matched' : 'read';
  payment.candidates = match.candidates;
  return match;
}

export async function createPayments({ user, files, env }) {
  const storage = createFileStorage(env.upload.dir);
  const created = [];
  const rejected = [];

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
      const match = await applyMatch(payment, extraction);
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
          matchedInvoiceId: payment.matchedInvoiceId,
        },
      });
      const serialized = serializePayment(await populateInvoice(BankPayment.findById(payment._id)));
      serialized.candidates = match.candidates;
      created.push(serialized);
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
      { matchedInvoiceId: null, status: { $nin: ['approved', 'rejected'] } },
    ];
  }
  if (user.role === 'staff') filter.uploadedBy = user._id;

  const rows = await populateInvoice(
    BankPayment.find(filter).sort({ createdAt: -1 }).limit(200),
  );
  return rows.map(serializePayment);
}

export async function getPayment(id, user) {
  const payment = await populateInvoice(BankPayment.findById(id));
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

export async function setPaymentMatch(id, user, body = {}) {
  if (!canReview(user)) throw httpError(403, 'Only an accountant can change the match.');
  const payment = await loadPayment(id, user);
  if (payment.status === 'approved') throw httpError(400, 'This payment is already approved.');
  if (payment.status === 'rejected') throw httpError(400, 'This payment was rejected.');

  const invoiceId = body.invoiceId;
  if (!invoiceId) throw httpError(400, 'Choose an invoice.');
  const invoice = await Invoice.findById(invoiceId).populate('customerId');
  if (!invoice) throw httpError(404, 'Invoice not found.');
  if (!['open', 'partial'].includes(invoice.status)) {
    throw httpError(400, 'That invoice is already paid.');
  }

  const before = {
    matchedInvoiceId: payment.matchedInvoiceId,
    matchType: payment.matchType,
    matchConfidence: payment.matchConfidence,
  };

  const amount = payment.confirmed?.amount ?? payment.ai?.amount;
  const remaining = remainingBalance(invoice);
  let matchType = 'exact';
  if (amount != null && Number.isInteger(amount)) {
    if (amount < remaining) matchType = 'partial';
    else if (amount > remaining) matchType = 'over';
  }

  payment.matchedInvoiceId = invoice._id;
  payment.matchedCustomerId = invoice.customerId?._id || invoice.customerId;
  payment.matchType = matchType;
  payment.matchConfidence = 'high';
  payment.matchReasons = ['Matched manually by an accountant.'];
  payment.flags = (payment.flags || []).filter((f) => f !== 'unidentified');
  payment.confirmed = {
    ...(payment.confirmed?.toObject?.() || payment.confirmed || {}),
    invoiceId: invoice._id,
  };
  payment.status = payment.statementVerified ? 'verified' : 'matched';

  if (body.saveAlias && payment.ai?.sender && invoice.customerId) {
    const customer = await Customer.findById(invoice.customerId._id || invoice.customerId);
    if (customer) {
      const alias = String(payment.ai.sender).trim();
      const exists = [customer.name, ...(customer.aliases || [])]
        .some((name) => name.toLowerCase() === alias.toLowerCase());
      if (!exists && alias) {
        customer.aliases = [...(customer.aliases || []), alias];
        await customer.save();
        await writeAudit({
          userId: user._id,
          action: 'update',
          entity: 'customers',
          entityId: customer._id,
          after: { alias },
        });
      }
    }
  }

  await payment.save();
  await writeAudit({
    userId: user._id,
    action: 'match',
    entity: 'bankPayments',
    entityId: payment._id,
    before,
    after: {
      matchedInvoiceId: payment.matchedInvoiceId,
      matchType: payment.matchType,
      matchConfidence: payment.matchConfidence,
    },
  });
  return serializePayment(await populateInvoice(BankPayment.findById(payment._id)));
}

export async function verifyPayment(id, user) {
  if (!canReview(user)) throw httpError(403, 'Only an accountant can verify a payment.');
  const payment = await loadPayment(id, user);
  if (payment.status === 'approved') throw httpError(400, 'This payment is already approved.');
  if (payment.status === 'rejected') throw httpError(400, 'This payment was rejected.');
  if (payment.status === 'failed') throw httpError(400, 'This screenshot failed to read.');
  if (!payment.matchedInvoiceId) {
    throw httpError(400, 'Match an invoice before verifying the bank statement.');
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
  return serializePayment(await populateInvoice(BankPayment.findById(payment._id)));
}

/**
 * Marks the matched invoice paid/partial in-app only after statement verify.
 * Never writes to the ERP.
 */
export async function approvePayment(id, user, body = {}) {
  if (!canReview(user)) throw httpError(403, 'Only an accountant can approve a payment.');
  const payment = await loadPayment(id, user);
  if (payment.status === 'approved') {
    return serializePayment(await populateInvoice(BankPayment.findById(payment._id)));
  }
  if (payment.status === 'rejected') throw httpError(400, 'This payment was rejected.');
  if (!payment.statementVerified || payment.status !== 'verified') {
    throw httpError(400, 'Tick the bank statement check before approving. A screenshot alone is not proof.');
  }
  if (!payment.matchedInvoiceId) throw httpError(400, 'Match an invoice before approving.');

  const invoice = await Invoice.findById(payment.matchedInvoiceId);
  if (!invoice) throw httpError(404, 'Matched invoice no longer exists.');
  if (invoice.status === 'paid') throw httpError(400, 'That invoice is already paid.');

  const amount = payment.confirmed?.amount ?? payment.ai?.amount;
  if (amount == null || !Number.isInteger(amount) || amount <= 0) {
    throw httpError(400, 'Payment amount is missing or invalid.');
  }

  const remaining = remainingBalance(invoice);
  if (amount > remaining) {
    const reason = String(body.overpaymentReason || payment.overpaymentReason || '').trim();
    if (!reason) {
      throw httpError(400, 'Overpayments need a reason before approval.');
    }
    payment.overpaymentReason = reason;
  }

  const beforeInvoice = {
    paidAmount: invoice.paidAmount,
    status: invoice.status,
  };
  const applied = Math.min(amount, remaining);
  invoice.paidAmount = (invoice.paidAmount || 0) + applied;
  if (invoice.paidAmount >= invoice.amount) invoice.status = 'paid';
  else if (invoice.paidAmount > 0) invoice.status = 'partial';
  await invoice.save();

  payment.status = 'approved';
  payment.approvedBy = user._id;
  payment.approvedAt = new Date();
  await payment.save();

  await writeAudit({
    userId: user._id,
    action: 'approve',
    entity: 'bankPayments',
    entityId: payment._id,
    before: { invoice: beforeInvoice },
    after: {
      status: 'approved',
      invoiceId: invoice._id,
      paidAmount: invoice.paidAmount,
      invoiceStatus: invoice.status,
      applied,
    },
  });

  return serializePayment(await populateInvoice(BankPayment.findById(payment._id)));
}

export async function rejectPayment(id, user, reason) {
  if (!canReview(user)) throw httpError(403, 'Only an accountant can reject a payment.');
  const text = String(reason || '').trim();
  if (!text) throw httpError(400, 'A reject reason is required.');
  const payment = await loadPayment(id, user);
  if (payment.status === 'approved') {
    throw httpError(400, 'An approved payment cannot be rejected. Fix it in the ERP by hand if needed.');
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
  return serializePayment(await populateInvoice(BankPayment.findById(payment._id)));
}

export async function listOpenInvoices(search = '') {
  const filter = { status: { $in: ['open', 'partial'] } };
  const rows = await Invoice.find(filter)
    .populate('customerId', 'name aliases erpCustomerId')
    .sort({ dueDate: 1 })
    .limit(300)
    .lean();
  const q = String(search || '').trim().toLowerCase();
  return rows
    .filter((invoice) => {
      if (!q) return true;
      const customer = invoice.customerId;
      const hay = [
        invoice.invoiceNo,
        customer?.name,
        customer?.erpCustomerId,
        ...(customer?.aliases || []),
      ].join(' ').toLowerCase();
      return hay.includes(q);
    })
    .map((invoice) => ({
      id: String(invoice._id),
      invoiceNo: invoice.invoiceNo,
      amount: invoice.amount,
      paidAmount: invoice.paidAmount,
      remaining: remainingBalance(invoice),
      status: invoice.status,
      dueDate: invoice.dueDate,
      customerName: invoice.customerId?.name || '',
      erpCustomerId: invoice.customerId?.erpCustomerId || invoice.erpCustomerId || '',
    }));
}

export function fileKeyFor(payment) {
  return { key: payment.imageKey, mimeType: payment.mimeType };
}
