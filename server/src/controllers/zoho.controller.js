import Setting from '../models/Setting.js';
import { writeAudit } from '../services/audit/auditLogger.js';
import {
  authorizationUrl, clearZohoTokenCache, createOauthState, exchangeAuthCode, missingZohoConfig, verifyOauthState,
} from '../integrations/erp/zohoBooks.js';
import { asyncHandler, httpError } from '../utils/http.js';

function page(message, clientUrl) {
  const safe = String(message).replace(/[&<>"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[char]));
  const back = /^https?:\/\//.test(String(clientUrl || '')) ? String(clientUrl).replace(/"/g, '') : '/';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Zoho</title></head><body><p>${safe}</p><p><a href="${back}">Back to FinOps</a></p></body></html>`;
}

export function zohoStart(env) {
  return asyncHandler(async (req, res) => {
    const missing = missingZohoConfig(env.zoho, { purpose: 'connect' });
    if (missing.length) {
      throw httpError(400, `Zoho is not configured. Set ${missing.join(', ')} in .env. Nothing was sent.`);
    }
    const state = createOauthState(env.jwtSecret);
    res.json({ url: authorizationUrl(env.zoho, state) });
  });
}

export function zohoCallback(env) {
  return async (req, res) => {
    try {
      if (!verifyOauthState(req.query.state, env.jwtSecret)) {
        throw httpError(400, 'This Zoho connection link is no longer valid. Start again from the overview.');
      }
      const code = String(req.query.code || '');
      if (!code) throw httpError(400, 'Zoho did not return a connection code. Start again from the overview.');
      const missing = missingZohoConfig(env.zoho, { purpose: 'connect' });
      if (missing.length) throw httpError(400, `Zoho is not configured. Set ${missing.join(', ')} in .env.`);
      const refreshToken = await exchangeAuthCode(env.zoho, code);
      let settings = await Setting.findOne();
      if (!settings) settings = new Setting({ erpFeaturesEnabled: false });
      settings.zohoRefreshToken = refreshToken;
      await settings.save();
      clearZohoTokenCache();
      await writeAudit({
        userId: null,
        action: 'zoho.connect',
        entity: 'settings',
        entityId: settings._id,
        after: { connected: true },
      });
      res.type('html').send(page('Zoho Books is connected for expense creation. Expense export stays off until you turn it on from the overview.', env.clientUrl));
    } catch (err) {
      const status = err.status && err.status < 500 ? err.status : 400;
      res.status(status).type('html').send(page(err.message || 'Zoho did not connect.', env.clientUrl));
    }
  };
}
