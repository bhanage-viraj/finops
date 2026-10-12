import { readErpSettings, setErpFeaturesEnabled, setZohoAccountRules } from '../services/admin/erpSettings.js';
import { asyncHandler } from '../utils/http.js';

export function getSettings(env) {
  return asyncHandler(async (req, res) => {
    res.json(await readErpSettings(env));
  });
}

export function updateSettings(env) {
  return asyncHandler(async (req, res) => {
    res.json(await setErpFeaturesEnabled(req.user, req.body?.erpFeaturesEnabled, env));
  });
}

export function updateAccounts(env) {
  return asyncHandler(async (req, res) => {
    res.json(await setZohoAccountRules(req.user, req.body?.rules, env));
  });
}
