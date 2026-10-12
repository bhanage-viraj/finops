import { readFile } from 'node:fs/promises';
import { loadEnvFile, readEnv } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/config/db.js';
import User from '../src/models/User.js';
import Setting from '../src/models/Setting.js';
import { setZohoAccountRules } from '../src/services/admin/erpSettings.js';
import { rulesFromChart } from '../src/services/admin/zohoChart.js';
import { describeZohoPlan } from '../src/services/documents/zohoAccounts.js';

loadEnvFile();
const env = readEnv();
const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/importZohoChart.js /path/to/chart.json');
  process.exit(1);
}

const raw = JSON.parse(await readFile(file, 'utf8'));
const accounts = Array.isArray(raw) ? raw : raw.chartofaccounts;
const rules = rulesFromChart(accounts);
const fuel = rules.filter((rule) => rule.documentType === 'fuel_receipt');
const other = rules.filter((rule) => rule.documentType === 'expense_receipt');
const paid = rules.filter((rule) => rule.kind === 'paid_through');

const platePattern = /DK\s*\d{3,4}\s*[A-Z]{1,3}/gi;
const plates = new Set();
for (const rule of fuel) {
  for (const match of String(rule.label).toUpperCase().matchAll(platePattern)) {
    plates.add(match[0].replace(/\s+/g, ' ').trim());
  }
}
const blockedFuel = [];
const exactFuel = [];
for (const plate of plates) {
  const needle = plate.replace(/[^A-Z0-9]/g, '');
  const names = fuel
    .filter((rule) => rule.label.toUpperCase().replace(/[^A-Z0-9]/g, '').includes(needle))
    .map((rule) => rule.label);
  if (names.length < 2) continue;
  const plan = describeZohoPlan({
    documentType: 'fuel_receipt',
    confirmed: { fields: { vehicle: { normalized: plate }, paymentMethod: { normalized: 'petty cash' } } },
    zohoExpense: {},
  }, rules);
  if (/More than one Zoho account/.test(plan.message)) blockedFuel.push({ plate, names });
  else if (plan.expenseLabel) exactFuel.push({ plate, used: plan.expenseLabel, names });
}

await connectDb(env.mongodbUri);
try {
  const before = await Setting.findOne().select('erpFeaturesEnabled').lean();
  const admin = await User.findOne({ role: 'admin' }).select('_id').lean();
  if (!admin) throw new Error('No admin user is available to audit the account save.');
  await setZohoAccountRules({ id: admin._id }, rules, env);
  const after = await Setting.findOne().select('erpFeaturesEnabled zohoAccountRules').lean();
  console.log(JSON.stringify({
    fuel: fuel.length,
    other: other.length,
    paidThrough: paid.map((rule) => rule.label),
    saved: after?.zohoAccountRules?.length || 0,
    exportEnabled: after?.erpFeaturesEnabled === true,
    exportWas: before?.erpFeaturesEnabled === true,
    blockedFuel,
    exactFuel,
  }));
} finally {
  await disconnectDb();
}
