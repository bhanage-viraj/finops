import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { connectDb } from './config/db.js';
import { loadEnvFile, readEnv } from './config/env.js';
import Setting from './models/Setting.js';
import User from './models/User.js';
import { writeAudit } from './services/audit/auditLogger.js';
import { hashPassword } from './utils/password.js';
import { recoverStuckDocuments } from './services/documents/pipeline.js';

loadEnvFile();

const rulesPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../samples/real/zoho-account-rules.json');

async function ensureAccounts() {
  if (!fs.existsSync(rulesPath)) return;
  const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  if (!Array.isArray(rules) || rules.length === 0) return;
  const settings = await Setting.findOne();
  if (!settings || (settings.zohoAccountRules || []).length > 0) return;
  settings.zohoAccountRules = rules;
  await settings.save();
}

async function ensureUsers() {
  const people = [
    { name: 'Sari Staff', email: 'staff@example.com', role: 'staff', envName: 'SEED_STAFF_PASSWORD' },
    { name: 'Budi Accountant', email: 'accountant@example.com', role: 'accountant', envName: 'SEED_ACCOUNTANT_PASSWORD' },
    { name: 'Agus Admin', email: 'admin@example.com', role: 'admin', envName: 'SEED_ADMIN_PASSWORD' },
  ];
  for (const person of people) {
    const password = process.env[person.envName];
    if (!password || await User.findOne({ email: person.email })) continue;
    const user = await User.create({
      name: person.name,
      email: person.email,
      role: person.role,
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
  }
  if (!await Setting.findOne()) {
    await Setting.create({ erpFeaturesEnabled: false });
  }
  await ensureAccounts();
}

let env;
try {
  env = readEnv();
} catch (error) {
  console.error(error.message);
}

let databaseReady = false;
if (env) {
  try {
    await connectDb(env.mongodbUri);
    await recoverStuckDocuments(env.ai.timeoutMs);
    await ensureUsers();
    databaseReady = true;
  } catch (error) {
    console.error(`Database connection failed: ${error.message}`);
  }
}

const app = env ? createApp(env, { requireDatabase: !databaseReady }) : null;

export default app;
