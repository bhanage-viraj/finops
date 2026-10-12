import Document from '../../models/Document.js';
import Setting from '../../models/Setting.js';
import { writeAudit } from '../audit/auditLogger.js';
import { createExpense, missingZohoConfig, receiptExtension } from '../../integrations/erp/zohoBooks.js';
import { createFileStorage } from '../storage/fileStorage.js';
import { httpError } from '../../utils/http.js';
import { TYPE_LABELS } from './fieldCatalog.js';
import { amountFieldKey, dateFieldKey, describeZohoPlan, expenseRulesFor, ZOHO_EXPENSE_TYPES } from './zohoAccounts.js';
import { getDocument } from './documentService.js';

export { ZOHO_EXPENSE_TYPES };

const SWITCH_OFF = 'Zoho export is turned off. An admin can enable it on the overview.';

function reviewer(user) {
  return user?.role === 'accountant' || user?.role === 'admin';
}

export function buildExpensePayload(doc, plan) {
  const amount = doc.confirmed?.fields?.[amountFieldKey(doc.documentType)]?.normalized;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw httpError(400, 'The confirmed total must be a whole number of rupiah before this can be sent.');
  }
  const date = doc.confirmed?.fields?.[dateFieldKey(doc.documentType)]?.normalized;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw httpError(400, 'The confirmed date must be set before this can be sent.');
  }
  if (!plan?.ready) throw httpError(400, plan?.message || 'No Zoho account is saved for this receipt.');
  const supplier = String(doc.confirmed?.fields?.supplier?.normalized || doc.searchParty || 'Expense').trim() || 'Expense';
  const label = TYPE_LABELS[doc.documentType] || 'Expense';
  const number = String(doc.confirmed?.fields?.documentNumber?.normalized || doc._id || '').trim();
  return {
    accountId: String(plan.expenseAccountId),
    paidThroughAccountId: String(plan.paidThroughAccountId),
    date,
    amount,
    description: `${supplier} · ${label}`.slice(0, 100),
    referenceNumber: number.slice(0, 100),
  };
}

export async function receiptForZoho({ bytes, mimeType, name }) {
  const ext = receiptExtension(mimeType, name);
  if (ext) return { bytes, mimeType, name: name || `receipt.${ext}` };
  try {
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp(bytes, { failOn: 'none', limitInputPixels: 40_000_000 }).rotate().jpeg({ quality: 85 }).toBuffer();
    if (!jpeg?.length) throw new Error('empty');
    return { bytes: jpeg, mimeType: 'image/jpeg', name: 'receipt.jpg' };
  } catch {
    throw httpError(400, 'This photo could not be prepared for Zoho Books, so nothing was sent.');
  }
}

async function loadReceipt(doc, env) {
  let bytes;
  try {
    bytes = await createFileStorage(env.upload.dir).read(doc.originalFileKey);
  } catch {
    throw httpError(400, 'The original file could not be read, so nothing was sent.');
  }
  const file = await receiptForZoho({ bytes, mimeType: doc.mimeType, name: doc.originalName });
  return { file, note: '' };
}

async function rememberExpense(id, expenseId, user, receiptAttached, receiptNote, plan) {
  await Document.updateOne(
    { _id: id },
    {
      $set: {
        'zohoExpense.expenseId': expenseId,
        'zohoExpense.sentAt': new Date(),
        'zohoExpense.sentBy': user.id,
        'zohoExpense.sending': false,
        'zohoExpense.lastError': '',
        'zohoExpense.receiptAttached': receiptAttached,
        'zohoExpense.receiptNote': receiptNote,
        'zohoExpense.accountId': plan?.expenseAccountId || '',
        'zohoExpense.paidThroughAccountId': plan?.paidThroughAccountId || '',
      },
    },
  );
}

const PREPARED = ['needs_review', 'submitted', 'approved'];

function selectionBody(input) {
  if (input && typeof input === 'object') return input;
  return { accountId: input };
}

export async function selectZohoAccount(id, user, input) {
  if (!reviewer(user)) throw httpError(403, 'You do not have access to this action.');
  const doc = await Document.findById(id);
  if (!doc) throw httpError(404, 'Document not found.');
  if (doc.zohoExpense?.expenseId) throw httpError(400, 'This expense was already sent.');
  if (!PREPARED.includes(doc.status) || !ZOHO_EXPENSE_TYPES.includes(doc.documentType)) {
    throw httpError(400, 'Choose a Zoho account on a fuel receipt, supplier receipt, supplier invoice, or expense receipt.');
  }
  const body = selectionBody(input);
  const settings = await Setting.findOne().select('zohoAccountRules');
  const rules = settings?.zohoAccountRules || [];
  const current = doc.zohoExpense?.toObject ? doc.zohoExpense.toObject() : (doc.zohoExpense || {});
  let selectedAccountId = current.selectedAccountId || '';
  let selectedAccountLabel = current.selectedAccountLabel || '';
  let selectedPaidThroughAccountId = current.selectedPaidThroughAccountId || '';
  let selectedPaidThroughLabel = current.selectedPaidThroughLabel || '';
  const after = {};
  if (Object.prototype.hasOwnProperty.call(body, 'accountId')) {
    const wanted = String(body.accountId || '').trim();
    const rule = expenseRulesFor(doc, rules).find((item) => item.accountId === wanted);
    if (wanted && !rule) throw httpError(400, 'That account is not saved for this kind of receipt.');
    selectedAccountId = rule?.accountId || '';
    selectedAccountLabel = rule?.label || rule?.key || '';
    after.accountId = selectedAccountId;
    after.label = selectedAccountLabel;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'paidThroughAccountId')) {
    const wanted = String(body.paidThroughAccountId || '').trim();
    const rule = rules.find((item) => item.kind === 'paid_through' && item.accountId === wanted);
    if (wanted && !rule) throw httpError(400, 'That cash or bank account is not saved.');
    selectedPaidThroughAccountId = rule?.accountId || '';
    selectedPaidThroughLabel = rule?.label || rule?.key || '';
    after.paidThroughAccountId = selectedPaidThroughAccountId;
    after.paidThroughLabel = selectedPaidThroughLabel;
  }
  doc.zohoExpense = {
    ...current,
    selectedAccountId,
    selectedAccountLabel,
    selectedPaidThroughAccountId,
    selectedPaidThroughLabel,
  };
  doc.markModified('zohoExpense');
  await doc.save();
  await writeAudit({
    userId: user.id,
    action: 'zoho.account.select',
    entity: 'documents',
    entityId: doc._id,
    after,
  });
  return getDocument(id, user);
}

export async function previewZohoExpense(id, user, env) {
  if (!reviewer(user)) throw httpError(403, 'You do not have access to this action.');
  const doc = await Document.findById(id);
  if (!doc) throw httpError(404, 'Document not found.');
  if (doc.zohoExpense?.expenseId) throw httpError(400, 'This expense was already sent.');
  if (!PREPARED.includes(doc.status) || !ZOHO_EXPENSE_TYPES.includes(doc.documentType)) {
    throw httpError(400, 'Test a fuel receipt, supplier receipt, supplier invoice, or expense receipt.');
  }
  const settings = await Setting.findOne().select('zohoAccountRules erpFeaturesEnabled zohoRefreshToken');
  const plan = describeZohoPlan(doc, settings?.zohoAccountRules || []);
  const expense = buildExpensePayload(doc, plan);
  const ext = receiptExtension(doc.mimeType, doc.originalName);
  const refreshToken = env?.zoho?.refreshToken || settings?.zohoRefreshToken || '';
  const draft = {
    ...expense,
    expenseLabel: plan.expenseLabel,
    paidThroughLabel: plan.paidThroughLabel,
    receiptWillAttach: Boolean(ext),
    exportEnabled: settings?.erpFeaturesEnabled === true,
    zohoConnected: Boolean(refreshToken),
    sent: false,
  };
  await writeAudit({
    userId: user.id,
    action: 'zoho.expense.test',
    entity: 'documents',
    entityId: doc._id,
    after: {
      accountId: draft.accountId,
      paidThroughAccountId: draft.paidThroughAccountId,
      amount: draft.amount,
      date: draft.date,
      sent: false,
    },
  });
  return draft;
}

export async function sendZohoExpense(id, user, env, deps = {}) {
  if (!reviewer(user)) throw httpError(403, 'You do not have access to this action.');
  const settings = await Setting.findOne();
  if (settings?.erpFeaturesEnabled !== true) throw httpError(403, SWITCH_OFF);

  const doc = await Document.findById(id);
  if (!doc) throw httpError(404, 'Document not found.');
  if (doc.zohoExpense?.expenseId) return getDocument(id, user);
  if (doc.status !== 'approved' || !ZOHO_EXPENSE_TYPES.includes(doc.documentType)) {
    throw httpError(400, 'Only an approved receipt can be sent.');
  }

  const plan = describeZohoPlan(doc, settings.zohoAccountRules || []);
  const expense = buildExpensePayload(doc, plan);
  const refreshToken = env.zoho?.refreshToken || settings.zohoRefreshToken || '';
  const missing = missingZohoConfig(env.zoho || {}, { refreshToken });
  if (missing.length) {
    let message = `Zoho is not configured. Set ${missing.join(', ')} before sending. Nothing was sent.`;
    if (missing.includes('ZOHO_DC')) {
      message += ' ZOHO_DC must match the Zoho data center: com, in, eu, au, jp, ca, sa, or ae.';
    }
    throw httpError(400, message);
  }

  const claimed = await Document.findOneAndUpdate(
    {
      _id: doc._id,
      status: 'approved',
      'zohoExpense.sending': { $ne: true },
      $or: [
        { 'zohoExpense.expenseId': { $exists: false } },
        { 'zohoExpense.expenseId': null },
        { 'zohoExpense.expenseId': '' },
      ],
    },
    { $set: { 'zohoExpense.sending': true, 'zohoExpense.lastError': '' } },
    { returnDocument: 'after' },
  );
  if (!claimed) {
    const current = await Document.findById(id);
    if (current?.zohoExpense?.expenseId) return getDocument(id, user);
    throw httpError(409, 'This expense is already being sent. Wait and open the document again.');
  }

  let createdId = '';
  try {
    const attachment = await loadReceipt(claimed, env);
    const create = deps.createExpense || createExpense;
    const result = await create({
      zoho: env.zoho,
      refreshToken,
      expense,
      file: attachment.file,
      fetchImpl: deps.fetchImpl,
    });
    createdId = result.expenseId;
    await rememberExpense(claimed._id, createdId, user, result.receiptAttached === true, attachment.note, plan);
    await writeAudit({
      userId: user.id,
      action: 'zoho.expense.create',
      entity: 'documents',
      entityId: claimed._id,
      after: {
        expenseId: createdId,
        receiptAttached: result.receiptAttached === true,
        accountId: plan.expenseAccountId,
        paidThroughAccountId: plan.paidThroughAccountId,
      },
    });
    return getDocument(id, user);
  } catch (err) {
    if (createdId) {
      await rememberExpense(claimed._id, createdId, user, false, '', plan);
      return getDocument(id, user);
    }
    await Document.updateOne(
      {
        _id: claimed._id,
        $or: [
          { 'zohoExpense.expenseId': { $exists: false } },
          { 'zohoExpense.expenseId': null },
          { 'zohoExpense.expenseId': '' },
        ],
      },
      { $set: { 'zohoExpense.sending': false, 'zohoExpense.lastError': err.message || 'Zoho Books refused the expense.' } },
    );
    if (err.status) throw err;
    throw httpError(422, err.message || 'Zoho Books refused the expense.');
  }
}
