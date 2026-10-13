import Setting from '../../models/Setting.js';
import { getInvoicePdf, missingZohoConfig } from '../../integrations/erp/zohoBooks.js';
import { httpError } from '../../utils/http.js';

export async function followUpInvoicePdf(user, env, invoiceId, deps = {}) {
  if (user.role !== 'accountant' && user.role !== 'admin') {
    throw httpError(403, 'Only an accountant or admin can open follow-up.');
  }
  const settings = await Setting.findOne().select('erpFeaturesEnabled zohoRefreshToken').lean();
  if (settings?.erpFeaturesEnabled !== true) {
    throw httpError(403, 'Zoho export is turned off. An admin can enable it on the overview.');
  }
  const refreshToken = env.zoho?.refreshToken || settings?.zohoRefreshToken || '';
  const missing = missingZohoConfig(env.zoho || {}, { refreshToken });
  if (missing.length) {
    throw httpError(400, `Zoho is not configured. Set ${missing.join(', ')}. Connect Zoho again if the token is missing.`);
  }
  if (!/^\d+$/.test(String(invoiceId || ''))) {
    throw httpError(400, 'The invoice id must be numeric.');
  }
  const load = deps.getInvoicePdf || getInvoicePdf;
  try {
    return await load({
      zoho: env.zoho,
      refreshToken,
      invoiceId: String(invoiceId),
      invoiceNumber: String(deps.invoiceNumber || ''),
    });
  } catch (error) {
    if (error.status) throw error;
    throw httpError(422, error.message || 'The invoice PDF could not be downloaded.');
  }
}
