import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDb, disconnectDb } from '../server/src/config/db.js';
import { loadEnvFile, readEnv } from '../server/src/config/env.js';
import Setting from '../server/src/models/Setting.js';
import User from '../server/src/models/User.js';
import { writeAudit } from '../server/src/services/audit/auditLogger.js';
import { importCustomersCsv, importInvoicesCsv } from '../server/src/services/imports/csvImport.js';
import { hashPassword } from '../server/src/utils/password.js';

const samplesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../samples/erp-exports');

const testUsers = [
  { name: 'Sari Staff', email: 'staff@example.com', role: 'staff', envName: 'SEED_STAFF_PASSWORD' },
  { name: 'Budi Accountant', email: 'accountant@example.com', role: 'accountant', envName: 'SEED_ACCOUNTANT_PASSWORD' },
  { name: 'Agus Admin', email: 'admin@example.com', role: 'admin', envName: 'SEED_ADMIN_PASSWORD' },
];

function passwordFor(envName) {
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.trim()) {
    return { password: fromEnv, generated: false };
  }
  return { password: randomBytes(9).toString('base64url'), generated: true };
}

async function seedUsers() {
  for (const spec of testUsers) {
    const existing = await User.findOne({ email: spec.email });
    if (existing) {
      console.log(`${spec.email} already exists.`);
      continue;
    }
    const { password, generated } = passwordFor(spec.envName);
    const user = await User.create({
      name: spec.name,
      email: spec.email,
      role: spec.role,
      active: true,
      passwordHash: await hashPassword(password),
    });
    await writeAudit({
      userId: user._id,
      action: 'create',
      entity: 'users',
      entityId: user._id,
      after: { email: user.email, role: user.role, active: true },
    });
    if (generated) {
      console.log(`Created ${spec.email} (${spec.role}). Password: ${password}`);
    } else {
      console.log(`Created ${spec.email} (${spec.role}). Password taken from ${spec.envName}.`);
    }
  }
}

async function seedSettings() {
  const existing = await Setting.findOne();
  if (existing) {
    console.log('Settings document already exists. erpFeaturesEnabled left unchanged.');
    return;
  }
  const settings = await Setting.create({
    erpFeaturesEnabled: false,
    confidenceThresholds: { warn: 90, bad: 70 },
    duplicateWindowDays: 7,
  });
  await writeAudit({
    action: 'create',
    entity: 'settings',
    entityId: settings._id,
    after: {
      erpFeaturesEnabled: false,
      confidenceThresholds: { warn: 90, bad: 70 },
      duplicateWindowDays: 7,
    },
  });
  console.log('Settings created with erpFeaturesEnabled false.');
}

async function seedCustomersAndInvoices() {
  const customersPath = path.join(samplesDir, 'customers.csv');
  const invoicesPath = path.join(samplesDir, 'invoices.csv');
  if (!fs.existsSync(customersPath) || !fs.existsSync(invoicesPath)) {
    console.log('Sample customer/invoice CSVs were not found. Skipping.');
    return;
  }
  const customers = await importCustomersCsv(fs.readFileSync(customersPath, 'utf8'));
  const invoices = await importInvoicesCsv(fs.readFileSync(invoicesPath, 'utf8'));
  console.log(`Customers: ${customers.created} created, ${customers.updated} updated.`);
  console.log(`Invoices: ${invoices.created} created, ${invoices.updated} updated.`);
}

async function main() {
  loadEnvFile();
  const env = readEnv();
  await connectDb(env.mongodbUri);
  await seedUsers();
  await seedSettings();
  await seedCustomersAndInvoices();
}

try {
  await main();
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  try {
    await disconnectDb();
  } catch {
    // The connection was never opened.
  }
}
