import { TYPE_LABELS } from './fieldCatalog.js';

export const ZOHO_EXPENSE_TYPES = [
  'fuel_receipt',
  'work_order',
  'supplier_receipt',
  'supplier_invoice',
  'expense_receipt',
  'other',
  'unknown',
];

export function dateFieldKey(type) {
  return type === 'work_order' ? 'workDate' : 'date';
}

export function amountFieldKey(type) {
  return type === 'work_order' ? 'agreedAmount' : 'total';
}

export function paymentKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function compactKey(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function fieldText(doc, key) {
  const field = doc.confirmed?.fields?.[key];
  return String(field?.normalized || field?.original || '').trim();
}

export function receiptMatchText(doc) {
  if (doc.documentType === 'fuel_receipt') return fieldText(doc, 'vehicle');
  if (doc.documentType === 'expense_receipt') return fieldText(doc, 'supplier') || fieldText(doc, 'description');
  return fieldText(doc, 'supplier') || fieldText(doc, 'notes');
}

function fieldsForMatch(doc) {
  const values = receiptParts(doc).map((value) => value.trim()).filter((value) => value.length >= 3);
  return [...new Set([...values, ...platesIn(values.join(' '))])];
}

// Fuel stays on the petrol accounts. Supplier bills use the same named accounts as expense receipts.
export function expenseRulesFor(doc, rules) {
  const list = (Array.isArray(rules) ? rules : []).filter((rule) => rule.kind === 'expense');
  if (doc.documentType === 'fuel_receipt') {
    return list.filter((rule) => rule.documentType === 'fuel_receipt');
  }
  return list.filter((rule) => rule.documentType !== 'fuel_receipt');
}

function receiptParts(doc) {
  const parts = Object.values(doc.confirmed?.fields || {}).flatMap((field) => [field?.normalized, field?.original]);
  for (const item of doc.confirmed?.lineItems || []) parts.push(item?.description);
  parts.push(doc.ai?.classification?.evidence, doc.classification?.evidence);
  return parts.filter(Boolean).map((value) => String(value));
}

function receiptText(doc) {
  return compactKey(receiptParts(doc).join(' '));
}

function platesIn(text) {
  const found = new Set();
  const source = String(text || '').toUpperCase();
  const re = /([A-Z]{1,2})\s*([0-9]{3,4})\s*([A-Z]{1,3})/g;
  let match = re.exec(source);
  while (match) {
    const plate = `${match[1]}${match[2]}${match[3]}`;
    if (plate.length >= 6) found.add(plate);
    match = re.exec(source);
  }
  return [...found];
}

const GENERIC_WORDS = new Set(['PETROL', 'FUEL', 'SERVICE', 'BANK', 'NEW', 'WORKER', 'ACCOUNT', 'EXPENSE']);

function wordsOf(value) {
  return String(value || '').toUpperCase().split(/[^A-Z0-9]+/).filter((word) => word.length >= 4 && !GENERIC_WORDS.has(word));
}

function wordsOverlap(left, right) {
  if (left === right) return true;
  if (left.length < 4 || right.length < 4) return false;
  return left.includes(right) || right.includes(left);
}

// Score how much of this saved account name is present in the receipt. No account is named in code.
function scoreAccount(parts, rule) {
  const names = [rule.label, rule.key].map((value) => String(value || '').trim()).filter((value) => value && paymentKey(value) !== 'default');
  const receiptCompact = compactKey(parts.join(' '));
  const receiptWords = parts.flatMap(wordsOf);
  let best = 0;
  for (const name of names) {
    const compact = compactKey(name);
    if (compact.length >= 3 && parts.some((part) => compactKey(part) === compact)) {
      best = Math.max(best, 1000 + compact.length);
      continue;
    }
    if (compact.length >= 4 && receiptCompact.includes(compact)) {
      best = Math.max(best, 500 + compact.length);
      continue;
    }
    const words = wordsOf(name);
    const hits = words.map((word) => receiptWords.reduce((longest, receiptWord) => (
      wordsOverlap(receiptWord, word) ? Math.max(longest, Math.min(word.length, receiptWord.length)) : longest
    ), 0));
    // Forklift Rental must not win on the word rental alone. Every distinctive word has to be on the page.
    let score = hits.length > 0 && hits.every((hit) => hit > 0) ? Math.max(...hits) : 0;
    for (const plate of platesIn(name)) {
      if (receiptCompact.includes(plate)) score += plate.length + 20;
    }
    best = Math.max(best, score);
  }
  return best;
}

const ICE_TRUCK_PLATES = ['DK8973HI', 'DK8858HI'];

function isIceTruck(doc, expense) {
  const text = compactKey([...receiptParts(doc), expense?.label, expense?.key].filter(Boolean).join(' '));
  if (text.includes('ESTRUCK')) return true;
  return ICE_TRUCK_PLATES.some((plate) => text.includes(plate));
}

function accountNamed(rules, name) {
  const wanted = paymentKey(name);
  return rules.find((rule) => paymentKey(rule.label) === wanted || paymentKey(rule.key) === wanted);
}

function bestAccounts(rules, parts) {
  const scored = rules
    .map((rule) => ({ rule, score: scoreAccount(parts, rule) }))
    .filter((item) => item.score > 0);
  const best = scored.reduce((max, item) => Math.max(max, item.score), 0);
  return scored.filter((item) => item.score === best).map((item) => item.rule);
}

function accountChoice(rule) {
  return {
    accountId: rule.accountId,
    label: rule.label || rule.key,
    key: rule.key,
  };
}

export function describeZohoPlan(doc, rules) {
  const list = Array.isArray(rules) ? rules : [];
  const expenseRules = expenseRulesFor(doc, list);
  const text = receiptMatchText(doc);
  const fields = fieldsForMatch(doc);
  const typeLabel = TYPE_LABELS[doc.documentType] || 'this document';
  const matched = bestAccounts(expenseRules, fields);
  const selected = expenseRules.find((rule) => rule.accountId && rule.accountId === doc.zohoExpense?.selectedAccountId);
  let expense = selected || null;
  const problems = [];
  if (!expense) {
    if (matched.length === 1) expense = matched[0];
    else if (matched.length > 1) problems.push(`More than one Zoho account matches ${text}. Choose the account on this receipt.`);
    else if (!text && expenseRules.length === 1) expense = expenseRules[0];
    else if (!text && doc.documentType === 'fuel_receipt') problems.push('This fuel receipt has no vehicle, so the petrol account cannot be chosen.');
    else if (!text) problems.push(`This ${typeLabel.toLowerCase()} has no name to match to a Zoho account.`);
    else if (doc.documentType === 'fuel_receipt') problems.push(`No petrol account is saved for ${text}.`);
    else problems.push(`No expense account is saved for ${text}.`);
  }

  const method = paymentKey(
    doc.confirmed?.fields?.paymentMethod?.normalized
    || doc.confirmed?.fields?.paymentMethod?.original
    || '',
  );
  const paidRules = list.filter((rule) => rule.kind === 'paid_through');
  const selectedPaid = paidRules.find((rule) => rule.accountId && rule.accountId === doc.zohoExpense?.selectedPaidThroughAccountId);
  let paid = null;
  if (selectedPaid) paid = selectedPaid;
  else if (isIceTruck(doc, expense)) {
    paid = accountNamed(paidRules, 'petty cash ice') || null;
    if (!paid) problems.push('No Petty Cash Ice account is saved.');
  } else {
    paid = accountNamed(paidRules, 'petty cash 2') || null;
    if (!paid) problems.push('No Petty Cash 2 account is saved.');
  }

  return {
    expenseAccountId: expense?.accountId || '',
    expenseLabel: expense?.label || expense?.key || '',
    matchText: text,
    choices: expenseRules.map(accountChoice),
    paidThroughAccountId: paid?.accountId || '',
    paidThroughLabel: paid?.label || '',
    paidChoices: paidRules.map(accountChoice),
    paymentMethod: method,
    date: String(doc.confirmed?.fields?.[dateFieldKey(doc.documentType)]?.normalized || ''),
    amount: Number.isInteger(doc.confirmed?.fields?.[amountFieldKey(doc.documentType)]?.normalized)
      ? doc.confirmed.fields[amountFieldKey(doc.documentType)].normalized
      : null,
    ready: Boolean(expense?.accountId) && Boolean(paid?.accountId) && problems.length === 0,
    message: problems.join(' '),
  };
}
