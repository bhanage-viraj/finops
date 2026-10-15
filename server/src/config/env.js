import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let loaded = false;

// Load the repo-root .env once. Missing file is fine; readEnv reports missing values.
export function loadEnvFile() {
  if (loaded) return;
  dotenv.config({ path: path.join(rootDir, '.env'), quiet: true });
  loaded = true;
}

const requiredKeys = ['MONGODB_URI', 'JWT_SECRET', 'CLIENT_URL'];

function required(source, key) {
  const value = source[key];
  if (value == null || String(value).trim() === '') return null;
  return String(value).trim();
}

/**
 * Reads configuration. Storage and AI keys are optional until those features exist.
 * Throws a clear Error listing every missing required variable.
 */
export function readEnv(source = process.env) {
  const missing = requiredKeys.filter((key) => !required(source, key));
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. Copy .env.example to .env in the project root and set them.`,
    );
  }

  const portRaw = required(source, 'PORT') ?? '4000';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('PORT must be a positive integer.');
  }

  const mongodbUri = required(source, 'MONGODB_URI');
  if (!/^mongodb(\+srv)?:\/\//.test(mongodbUri)) {
    throw new Error('MONGODB_URI must start with mongodb:// or mongodb+srv://');
  }

  const clientUrl = required(source, 'CLIENT_URL');
  let parsedClient;
  try {
    parsedClient = new URL(clientUrl);
  } catch {
    parsedClient = null;
  }
  if (!parsedClient || (parsedClient.protocol !== 'http:' && parsedClient.protocol !== 'https:')) {
    throw new Error('CLIENT_URL must be an absolute http(s) URL, for example http://localhost:5173');
  }

  return {
    port,
    mongodbUri,
    jwtSecret: required(source, 'JWT_SECRET'),
    clientUrl,
    storage: {
      endpoint: source.STORAGE_ENDPOINT || '',
      bucket: source.STORAGE_BUCKET || '',
      accessKey: source.STORAGE_ACCESS_KEY || '',
      secretKey: source.STORAGE_SECRET_KEY || '',
    },
    ai: {
      provider: required(source, 'AI_PROVIDER') || 'gemini',
      apiKey: source.AI_API_KEY || '',
      model: required(source, 'AI_MODEL') || 'gemini-3.5-flash',
      timeoutMs: positiveInt(source.AI_TIMEOUT_MS, 45000),
      inputUsdPerMillion: optionalNumber(source.AI_INPUT_USD_PER_MILLION),
      outputUsdPerMillion: optionalNumber(source.AI_OUTPUT_USD_PER_MILLION),
    },
    upload: {
      maxBytes: positiveInt(source.MAX_UPLOAD_BYTES, 8 * 1024 * 1024),
      dir: path.resolve(rootDir, source.UPLOAD_DIR || 'uploads'),
    },
    zoho: {
      clientId: source.ZOHO_CLIENT_ID || '',
      clientSecret: source.ZOHO_CLIENT_SECRET || '',
      dc: String(source.ZOHO_DC || '').trim().toLowerCase(),
      organizationId: source.ZOHO_ORGANIZATION_ID || '',
      expenseAccountId: source.ZOHO_EXPENSE_ACCOUNT_ID || '',
      paidThroughAccountId: source.ZOHO_PAID_THROUGH_ACCOUNT_ID || '',
      // Bank account in Zoho that receives customer transfer deposits (Payments).
      paymentDepositAccountId: source.ZOHO_PAYMENT_DEPOSIT_ACCOUNT_ID || '5802591000000144205',
      // Must match a Zoho payment mode label exactly (this org uses "Bank Transfer").
      paymentMode: String(source.ZOHO_PAYMENT_MODE || 'Bank Transfer').trim() || 'Bank Transfer',
      redirectUri: source.ZOHO_REDIRECT_URI || 'http://localhost:4000/auth/zoho/callback',
      refreshToken: source.ZOHO_REFRESH_TOKEN || '',
    },
  };
}

function positiveInt(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error('Numeric settings such as AI_TIMEOUT_MS and MAX_UPLOAD_BYTES must be positive integers.');
  }
  return number;
}

function optionalNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return number;
}
