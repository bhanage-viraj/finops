const PAID_THROUGH_TYPES = new Set(['cash', 'bank']);
const EXPENSE_TYPES = new Set(['expense', 'other_expense']);

function cleanName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

// Petrol and fuel accounts are the only ones a fuel receipt may use.
// Parent groups are skipped because each car or bill has its own account.
export function isFuelAccount(account) {
  const parent = cleanName(account?.parent_account_name).toLowerCase();
  const name = cleanName(account?.account_name).toLowerCase();
  return parent === 'petrol' || name.includes('petrol') || name.includes('fuel');
}

export function rulesFromChart(accounts) {
  if (!Array.isArray(accounts)) {
    const error = new Error('Chart of accounts must be a list.');
    error.status = 400;
    throw error;
  }
  const rules = [];
  for (const account of accounts) {
    if (!account || account.is_active === false || account.is_child_present === true) continue;
    const accountId = String(account.account_id || '').trim();
    const label = cleanName(account.account_name);
    if (!/^\d{1,30}$/.test(accountId) || !label) continue;
    const accountType = String(account.account_type || '');
    if (PAID_THROUGH_TYPES.has(accountType)) {
      rules.push({ kind: 'paid_through', key: label, accountId, label });
      continue;
    }
    if (!EXPENSE_TYPES.has(accountType)) continue;
    rules.push({
      kind: 'expense',
      documentType: isFuelAccount(account) ? 'fuel_receipt' : 'expense_receipt',
      key: label,
      accountId,
      label,
    });
  }
  return rules;
}
