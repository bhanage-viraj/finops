import Setting from '../../models/Setting.js';
import { writeAudit } from '../audit/auditLogger.js';
import { missingZohoConfig } from '../../integrations/erp/zohoBooks.js';
import { compactKey, paymentKey, ZOHO_EXPENSE_TYPES } from '../documents/zohoAccounts.js';
import { httpError } from '../../utils/http.js';

function present(settings, env) {
  const refreshToken = env.zoho?.refreshToken || settings?.zohoRefreshToken || '';
  return {
    erpFeaturesEnabled: settings?.erpFeaturesEnabled === true,
    zohoConnected: Boolean(refreshToken),
    zohoMissing: missingZohoConfig(env.zoho || {}, { refreshToken }).filter((key) => key !== 'ZOHO_REFRESH_TOKEN'),
    zohoAccountRules: (settings?.zohoAccountRules || []).map((rule) => ({
      kind: rule.kind,
      documentType: rule.documentType || '',
      key: rule.key,
      accountId: rule.accountId,
      label: rule.label || '',
    })),
  };
}

export function normalizeAccountRules(input) {
  if (!Array.isArray(input)) throw httpError(400, 'Account rules must be a list.');
  if (input.length > 200) throw httpError(400, 'Save at most 200 Zoho accounts.');
  const seen = new Set();
  return input.map((rule) => {
    const kind = rule?.kind === 'expense' || rule?.kind === 'paid_through' ? rule.kind : '';
    if (!kind) throw httpError(400, 'Each Zoho account needs a kind.');
    const accountId = String(rule?.accountId || '').trim();
    if (!/^\d{1,30}$/.test(accountId)) {
      throw httpError(400, 'A Zoho account id must be the numeric id from the chart of accounts.');
    }
    const label = String(rule?.label || '').trim().slice(0, 80);
    if (kind === 'paid_through') {
      const key = paymentKey(rule?.key);
      if (key !== 'default' && !/^[\p{L}\p{N} ./-]{1,40}$/u.test(key)) {
        throw httpError(400, 'A paid-through account needs a payment method, or the word default.');
      }
      const id = `${kind}:${key}`;
      if (seen.has(id)) throw httpError(400, 'Each payment method can have one paid-through account.');
      seen.add(id);
      return { kind, documentType: '', key, accountId, label };
    }
    const documentType = String(rule?.documentType || '');
    if (!ZOHO_EXPENSE_TYPES.includes(documentType)) {
      throw httpError(400, 'An expense account must be tied to a fuel receipt, supplier receipt, supplier invoice, or expense receipt.');
    }
    const key = String(rule?.key || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (compactKey(key).length < 3) throw httpError(400, 'Enter the car number or the name this account is for.');
    const id = `${kind}:${documentType}:${compactKey(key)}`;
    if (seen.has(id)) throw httpError(400, 'Each car number or name can have one expense account.');
    seen.add(id);
    return { kind, documentType, key, accountId, label };
  });
}

export async function readErpSettings(env) {
  const settings = await Setting.findOne().select('erpFeaturesEnabled zohoRefreshToken zohoAccountRules').lean();
  return present(settings, env);
}

export async function setErpFeaturesEnabled(user, enabled, env) {
  if (typeof enabled !== 'boolean') throw httpError(400, 'erpFeaturesEnabled must be true or false.');
  let settings = await Setting.findOne();
  if (!settings) settings = new Setting();
  const before = settings.erpFeaturesEnabled === true;
  settings.erpFeaturesEnabled = enabled;
  await settings.save();
  await writeAudit({
    userId: user.id,
    action: 'setting.change',
    entity: 'settings',
    entityId: settings._id,
    before: { erpFeaturesEnabled: before },
    after: { erpFeaturesEnabled: enabled },
  });
  return present(settings, env);
}

export async function setZohoAccountRules(user, rules, env) {
  const next = normalizeAccountRules(rules);
  let settings = await Setting.findOne();
  if (!settings) settings = new Setting();
  const before = (settings.zohoAccountRules || []).map((rule) => ({
    kind: rule.kind, documentType: rule.documentType || '', key: rule.key, accountId: rule.accountId, label: rule.label || '',
  }));
  settings.zohoAccountRules = next;
  settings.markModified('zohoAccountRules');
  await settings.save();
  await writeAudit({
    userId: user.id,
    action: 'setting.change',
    entity: 'settings',
    entityId: settings._id,
    before: { zohoAccountRules: before },
    after: { zohoAccountRules: next },
  });
  return present(settings, env);
}
