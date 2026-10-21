import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AssistantProposal from '../../models/AssistantProposal.js';
import { completeText } from '../ai/visionClient.js';
import {
  approvePayment, customerSearchRank, groupNameRank, listOpenInvoices, listPayments,
  setPaymentMatch, verifyPayment,
} from '../payments/paymentService.js';
import { writeAudit } from '../audit/auditLogger.js';
import { httpError } from '../../utils/http.js';
import { isWriteIntent, planInvoiceLink, normalizeIntent } from './intent.js';

const promptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../prompts/assistant.prompt.txt',
);
const promptTemplate = fs.readFileSync(promptPath, 'utf8');

const PROPOSAL_MS = 30 * 60 * 1000;
const HELP = 'I can list payments, list a customer’s unpaid invoices for a date range (a group name such as AN Balinest includes every matching villa), link those invoices to a transfer, or record that transfer after you tick the bank statement check.';

const assistantIntentSchema = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: ['answer', 'list_payments', 'find_invoices', 'link_invoices', 'record_payment'],
    },
    customerName: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    paymentId: { type: 'string' },
    reply: { type: 'string' },
  },
  required: ['intent', 'customerName', 'from', 'to', 'paymentId', 'reply'],
};

function canReview(user) {
  return user?.role === 'accountant' || user?.role === 'admin';
}

function rupiah(value) {
  return `Rp ${Number(value).toLocaleString('id-ID')}`;
}

function formatDay(iso) {
  const match = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
}

function pagePaymentId(page) {
  const match = String(page || '').match(/^\/payments\/([a-f0-9]{24})$/i);
  return match ? match[1] : '';
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-8).map((row) => ({
    role: row?.role === 'assistant' ? 'assistant' : 'user',
    text: String(row?.text || '').trim().slice(0, 500),
  })).filter((row) => row.text);
}

function nameHits(query, payment) {
  const name = payment.confirmed?.customerName || payment.ai?.sender || '';
  if (!query || !name) return false;
  return groupNameRank(query, name) != null || customerSearchRank(query, name) != null;
}

function rangeLabel(from, to) {
  if (from && to) return `${formatDay(from)} to ${formatDay(to)}`;
  return 'all dates';
}

function invoiceSummary(rows) {
  const groups = [];
  const index = new Map();
  for (const row of rows) {
    const name = row.customerName || 'Customer';
    if (!index.has(name)) {
      const group = { name, rows: [] };
      index.set(name, group);
      groups.push(group);
    }
    index.get(name).rows.push(row);
  }
  const lines = [];
  let shown = 0;
  for (const group of groups) {
    if (shown >= 12) break;
    lines.push(group.name);
    for (const row of group.rows) {
      if (shown >= 12) break;
      lines.push(`- ${row.invoiceNo} · ${formatDay(row.date) || 'no date'} · ${rupiah(row.remaining)}`);
      shown += 1;
    }
  }
  if (rows.length > shown) lines.push(`and ${rows.length - shown} more`);
  return lines.join('\n');
}

function fitLine(amount, plan) {
  if (!Number.isInteger(amount) || plan.excess == null) return 'The transfer amount is not read yet.';
  if (plan.excess === 0) return 'The ticked total matches the transfer.';
  if (plan.excess > 0) return `${rupiah(plan.excess)} above the invoices stays as customer credit, or is the bank fee when it is small.`;
  return `${rupiah(-plan.excess)} short · oldest invoices are paid first.`;
}

async function defaultParseIntent({ env, user, message, history, page, today }) {
  const prompt = promptTemplate
    .replace('{{today}}', today.toISOString().slice(0, 10))
    .replace('{{role}}', user.role || '')
    .replace('{{page}}', page || '/')
    .replace('{{history}}', history.map((row) => `${row.role}: ${row.text}`).join('\n') || '(none)')
    .replace('{{message}}', message);
  const result = await completeText({
    provider: env.ai?.provider,
    apiKey: env.ai?.apiKey,
    model: env.ai?.model,
    timeoutMs: env.ai?.timeoutMs,
    rates: {
      inputUsdPerMillion: env.ai?.inputUsdPerMillion,
      outputUsdPerMillion: env.ai?.outputUsdPerMillion,
    },
    prompt,
    schema: assistantIntentSchema,
  });
  return normalizeIntent(result.json, message, today);
}

function pickPayment(payments, { paymentId, customerName, pageId }) {
  const open = (payments || []).filter((row) => !['approved', 'rejected'].includes(row.status));
  const wanted = paymentId || pageId;
  if (wanted) {
    const found = open.find((row) => String(row.id) === wanted);
    return found || { error: 'That payment is not open.' };
  }
  if (!customerName) return { error: 'Say which customer the transfer is for.' };
  const named = open.filter((row) => nameHits(customerName, row));
  if (named.length === 1) return named[0];
  if (named.length === 0) return { error: `No open payment matches ${customerName}.` };
  const choices = named.slice(0, 5).map((row) => row.confirmed?.customerName || row.id).join(', ');
  return { error: `Several open payments match. Open the right one, then ask again. Matches: ${choices}.` };
}

async function rememberProposal(Proposal, doc) {
  const row = await Proposal.create(doc);
  return {
    id: String(row._id || row.id),
    tool: row.tool,
    needsStatement: true,
  };
}

/**
 * One chat turn. Reads run now. Writes are stored and wait for confirmAssistantProposal.
 * Invoice ids in a proposal come from the books, never from the model's reply.
 */
export async function handleAssistantMessage({ user, env, body = {}, today = new Date() }, deps = {}) {
  const message = String(body.message || '').trim().slice(0, 2000);
  if (!message) throw httpError(400, 'Write what you want done.');
  const history = normalizeHistory(body.history);
  const page = String(body.path || '').slice(0, 200);
  const parseIntent = deps.parseIntent || defaultParseIntent;
  const payments = deps.listPayments || listPayments;
  const invoices = deps.listOpenInvoices || listOpenInvoices;
  const Proposal = deps.Proposal || AssistantProposal;

  let intent;
  try {
    intent = await parseIntent({ env, user, message, history, page, today });
  } catch (error) {
    if (error.code === 'AI_NOT_CONFIGURED') {
      throw httpError(503, 'The assistant is not configured yet. Add AI_API_KEY on the server.');
    }
    throw httpError(422, error.message || 'The assistant could not read that request.');
  }
  intent = normalizeIntent(intent, message, today);

  if (intent.intent === 'list_payments') {
    const rows = await payments(user);
    const open = rows.filter((row) => !['approved', 'rejected'].includes(row.status));
    if (!open.length) return { reply: 'No open payments.', proposal: null };
    const lines = open.slice(0, 15).map((row) => {
      const name = row.confirmed?.customerName || row.ai?.sender || 'Screenshot';
      const amount = row.amountReceived != null ? rupiah(row.amountReceived) : 'amount not read';
      return `- ${name} · ${amount} · ${row.status}`;
    });
    if (open.length > 15) lines.push(`and ${open.length - 15} more`);
    return { reply: `Open payments:\n${lines.join('\n')}`, proposal: null };
  }

  if (intent.intent === 'find_invoices' || intent.intent === 'link_invoices') {
    if (!canReview(user)) {
      return { reply: 'Only an accountant can look up or change invoices from chat.', proposal: null };
    }
    if (intent.customerName.length < 2 && intent.intent === 'find_invoices') {
      return { reply: 'Which customer? A group name such as AN Balinest lists every matching villa.', proposal: null };
    }
  }

  if (intent.intent === 'find_invoices') {
    const pageResult = await invoices(env, intent.customerName, { fromDate: intent.from, toDate: intent.to });
    const rows = pageResult.invoices || [];
    if (!rows.length) {
      return { reply: `No unpaid invoices for ${intent.customerName} in ${rangeLabel(intent.from, intent.to)}.`, proposal: null };
    }
    const total = rows.reduce((sum, row) => sum + (Number.isInteger(row.remaining) ? row.remaining : 0), 0);
    const villas = new Set(rows.map((row) => row.customerName).filter(Boolean)).size;
    const tail = pageResult.truncated ? '\nToo many invoices match. Narrow the dates.' : '';
    return {
      reply: `${rows.length} unpaid invoice${rows.length === 1 ? '' : 's'} · ${villas} villa${villas === 1 ? '' : 's'} · ${rupiah(total)} · ${rangeLabel(intent.from, intent.to)}.\n${invoiceSummary(rows)}${tail}`,
      proposal: null,
    };
  }

  if (intent.intent === 'link_invoices') {
    if (intent.customerName.length < 2 && !intent.paymentId && !pagePaymentId(page)) {
      return { reply: 'Which customer should I link? For example AN Balinest, and the dates.', proposal: null };
    }
    const openPayments = await payments(user);
    const payment = pickPayment(openPayments, {
      paymentId: intent.paymentId,
      customerName: intent.customerName,
      pageId: pagePaymentId(page),
    });
    if (payment.error) return { reply: payment.error, proposal: null };
    const pageResult = await invoices(env, intent.customerName || payment.confirmed?.customerName || '', {
      fromDate: intent.from,
      toDate: intent.to,
    });
    if (pageResult.truncated) {
      return { reply: 'Too many invoices match. Narrow the date range, then ask again.', proposal: null };
    }
    const plan = planInvoiceLink({
      invoices: pageResult.invoices || [],
      paymentAmount: payment.amountReceived,
    });
    if (!plan.ok) return { reply: plan.error, proposal: null };
    const name = intent.customerName || payment.confirmed?.customerName || 'this customer';
    const summary = [
      `Link ${plan.invoiceIds.length} invoice${plan.invoiceIds.length === 1 ? '' : 's'} (${plan.customerCount} villa${plan.customerCount === 1 ? '' : 's'}) for ${name}, ${rangeLabel(intent.from, intent.to)}.`,
      `Total ${rupiah(plan.total)}. ${fitLine(payment.amountReceived, plan)}`,
      invoiceSummary(pageResult.invoices || []),
      'Confirm to link them to this transfer. Tick the bank statement check as well if it should be recorded in Zoho now. A screenshot alone is not proof.',
    ].join('\n');
    const proposal = await rememberProposal(Proposal, {
      userId: user.id,
      tool: 'link_invoices',
      summary,
      args: {
        paymentId: String(payment.id),
        customerName: name,
        invoiceIds: plan.invoiceIds,
        from: intent.from,
        to: intent.to,
        linked: false,
      },
      expiresAt: new Date(today.getTime() + PROPOSAL_MS),
    });
    return { reply: summary, proposal };
  }

  if (intent.intent === 'record_payment') {
    if (!canReview(user)) return { reply: 'Only an accountant can record a payment.', proposal: null };
    const openPayments = await payments(user);
    const payment = pickPayment(openPayments, {
      paymentId: intent.paymentId,
      customerName: intent.customerName,
      pageId: pagePaymentId(page),
    });
    if (payment.error) return { reply: payment.error, proposal: null };
    if (!payment.matchedInvoiceId) {
      return { reply: 'Link the invoices first. Say the customer and the dates, for example AN Balinest this month.', proposal: null };
    }
    const amount = payment.amountReceived != null ? rupiah(payment.amountReceived) : 'the transfer';
    const summary = `Record ${amount} in Zoho for ${payment.confirmed?.customerName || 'this payment'}. Tick the bank statement check, then confirm. A screenshot alone is not proof.`;
    const proposal = await rememberProposal(Proposal, {
      userId: user.id,
      tool: 'record_payment',
      summary,
      args: { paymentId: String(payment.id) },
      expiresAt: new Date(today.getTime() + PROPOSAL_MS),
    });
    return { reply: summary, proposal };
  }

  return { reply: intent.reply || HELP, proposal: null };
}

async function loadOwnedProposal(Proposal, id, user, now) {
  if (!/^[a-f0-9]{24}$/i.test(String(id || ''))) throw httpError(404, 'That request was not found.');
  const proposal = await Proposal.findById(id);
  if (!proposal) throw httpError(404, 'That request was not found.');
  if (String(proposal.userId) !== String(user.id)) throw httpError(403, 'That request belongs to someone else.');
  if (proposal.status === 'confirmed') return { proposal, done: true };
  if (proposal.status !== 'pending') throw httpError(400, 'That request is no longer waiting.');
  if (new Date(proposal.expiresAt).getTime() < now.getTime()) {
    proposal.status = 'cancelled';
    await proposal.save();
    throw httpError(400, 'That request expired. Ask again.');
  }
  return { proposal, done: false };
}

/** Runs the stored action. The client cannot swap the invoice ids. */
export async function confirmAssistantProposal(id, user, body = {}, env, deps = {}) {
  const Proposal = deps.Proposal || AssistantProposal;
  const now = deps.now ? deps.now() : new Date();
  const match = deps.setPaymentMatch || setPaymentMatch;
  const verify = deps.verifyPayment || verifyPayment;
  const approve = deps.approvePayment || approvePayment;
  const audit = deps.writeAudit || writeAudit;
  const { proposal, done } = await loadOwnedProposal(Proposal, id, user, now);
  if (done) return { reply: proposal.resultMessage || 'Already confirmed.', proposal: null };
  if (!canReview(user)) throw httpError(403, 'Only an accountant can confirm this.');
  if (!isWriteIntent(proposal.tool)) throw httpError(400, 'This request cannot be confirmed.');

  const statementChecked = body.statementChecked === true;
  const args = proposal.args || {};
  let recorded = false;

  if (proposal.tool === 'link_invoices' && !args.linked) {
    await match(args.paymentId, user, {
      invoiceIds: args.invoiceIds,
      customerName: args.customerName || '',
    }, env);
    args.linked = true;
    proposal.args = args;
    proposal.markModified?.('args');
    await proposal.save();
  }

  if (proposal.tool === 'record_payment' && !statementChecked) {
    throw httpError(400, 'Tick the bank statement check before recording. A screenshot alone is not proof.');
  }

  if (statementChecked && (proposal.tool === 'record_payment' || args.linked)) {
    if (proposal.tool === 'link_invoices' || proposal.tool === 'record_payment') {
      try {
        await verify(args.paymentId, user);
        await approve(args.paymentId, user, {}, env);
        recorded = true;
      } catch (error) {
        proposal.resultMessage = error.message || 'Zoho did not accept the payment.';
        await proposal.save();
        throw httpError(error.status || 422, proposal.resultMessage);
      }
    }
  }

  const reply = recorded
    ? 'Recorded in Zoho as Bank Transfer. One villa is one Zoho payment when the invoices belong to different customers.'
    : 'Invoices linked. Ask me to record it, and tick the bank statement check, when you want it in Zoho.';
  proposal.status = 'confirmed';
  proposal.resultMessage = reply;
  await proposal.save();
  await audit({
    userId: user.id,
    action: 'assistant_confirm',
    entity: 'assistantProposals',
    entityId: proposal._id,
    after: {
      tool: proposal.tool,
      paymentId: args.paymentId || '',
      invoices: Array.isArray(args.invoiceIds) ? args.invoiceIds.length : 0,
      recorded,
    },
  });
  return { reply, proposal: null };
}

export async function cancelAssistantProposal(id, user, deps = {}) {
  const Proposal = deps.Proposal || AssistantProposal;
  const now = deps.now ? deps.now() : new Date();
  const { proposal, done } = await loadOwnedProposal(Proposal, id, user, now);
  if (done) return { reply: 'Already confirmed.', proposal: null };
  proposal.status = 'cancelled';
  await proposal.save();
  return { reply: 'Cancelled. Nothing was saved.', proposal: null };
}
