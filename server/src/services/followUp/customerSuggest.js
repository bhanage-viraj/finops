import Setting from '../../models/Setting.js';
import ZohoInvoice from '../../models/ZohoInvoice.js';
import { httpError } from '../../utils/http.js';

const LIMIT = 12;

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Names from the invoice copy, so the accountant can pick the right customer. */
export async function suggestCustomers(user, env, q, deps = {}) {
  if (user.role !== 'accountant' && user.role !== 'admin') {
    throw httpError(403, 'Only an accountant or admin can open follow-up.');
  }
  const loadSettings = deps.loadSettings
    || (() => Setting.findOne().select('erpFeaturesEnabled').lean());
  const settings = await loadSettings();
  if (settings?.erpFeaturesEnabled !== true) {
    throw httpError(403, 'Zoho export is turned off. An admin can enable it on the overview.');
  }
  const needle = String(q || '').trim().slice(0, 80);
  if (needle.length < 1) return { customers: [] };
  const search = deps.search || ((pattern) => ZohoInvoice.aggregate([
    { $match: { customerName: { $regex: pattern, $options: 'i' } } },
    {
      $group: {
        _id: { $ifNull: ['$customerId', '$customerName'] },
        customerName: { $first: '$customerName' },
        customerId: { $first: '$customerId' },
      },
    },
    { $sort: { customerName: 1 } },
    { $limit: LIMIT },
    { $project: { _id: 0, customerId: 1, customerName: 1 } },
  ]));
  const rows = await search(escapeRegex(needle));
  return {
    customers: (rows || [])
      .map((row) => ({
        customerId: String(row.customerId || ''),
        customerName: String(row.customerName || '').slice(0, 120),
      }))
      .filter((row) => row.customerName),
  };
}
