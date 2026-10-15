import Setting from '../../models/Setting.js';
import { listOverdueInvoices, missingZohoConfig } from '../../integrations/erp/zohoBooks.js';
import { httpError } from '../../utils/http.js';
import {
  REMINDER_TEXT, draftCombinedWhatsAppMessage, draftWhatsAppMessage, groupOverdueByCustomer, rankOverdueInvoices,
} from './rank.js';

export async function todayFollowUp(user, env, deps = {}) {
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
  const list = deps.listOverdueInvoices || listOverdueInvoices;
  const raw = await list({ zoho: env.zoho, refreshToken });
  const invoices = rankOverdueInvoices(raw).map((invoice) => ({
    ...invoice,
    messageDraft: draftWhatsAppMessage(invoice),
  }));
  const customers = groupOverdueByCustomer(invoices).map((group) => ({
    key: group.key,
    customerId: group.customerId,
    customerName: group.customerName,
    customerPhone: group.customerPhone,
    invoiceIds: group.invoices.map((invoice) => invoice.invoiceId),
    total: group.total,
    maxDaysOverdue: group.maxDaysOverdue,
    fullMessageDraft: draftCombinedWhatsAppMessage(group.invoices),
  }));
  return {
    asOf: new Date().toISOString().slice(0, 10),
    invoices,
    customers,
    // Lets the screen rebuild a combined message for any ticked subset.
    reminderText: REMINDER_TEXT,
  };
}
