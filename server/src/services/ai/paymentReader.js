import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { completeVision } from './visionClient.js';
import { assertPaymentExtraction, paymentExtractionSchema } from './schemas.js';

const promptDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../prompts');
const paymentPrompt = fs.readFileSync(path.join(promptDir, 'payment.prompt.txt'), 'utf8');

const FALLBACK_MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite'];

function quotaBlocked(error) {
  return /quota|rate limit|rate-limit/i.test(error.message || '');
}

function modelUnavailable(error) {
  return /no longer available|not found|is not supported|does not exist/i.test(error.message || '');
}

function overloaded(error) {
  return /high demand|unavailable|try again later/i.test(error.message || '');
}

function tryNextModel(error) {
  return quotaBlocked(error) || modelUnavailable(error) || overloaded(error) || error.code === 'TIMEOUT';
}

function retryable(error) {
  if (tryNextModel(error)) return false;
  if (error.code === 'INVALID_JSON') return true;
  return error.statusCode === 429 || error.statusCode === 503;
}

function modelsFor(primary) {
  return [...new Set([primary, ...FALLBACK_MODELS].filter(Boolean))];
}

async function once(request) {
  let last;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      last = error;
      if (!retryable(error) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw last;
}

async function completeWithFallback(env, file, complete) {
  let last;
  for (const model of modelsFor(env.ai.model)) {
    try {
      return await once(() => complete({
        provider: env.ai.provider,
        apiKey: env.ai.apiKey,
        model,
        timeoutMs: env.ai.timeoutMs,
        rates: env.ai,
        prompt: paymentPrompt,
        mimeType: file.mimeType,
        bytes: file.bytes,
        schema: paymentExtractionSchema,
      }));
    } catch (error) {
      last = error;
      if (!tryNextModel(error)) throw error;
    }
  }
  throw last;
}

/** Reads a bank screenshot. Returns validated AI fields only — never marks anything paid. */
export async function readPaymentScreenshot(env, file, complete = completeVision) {
  const result = await completeWithFallback(env, file, complete);
  const extracted = assertPaymentExtraction(result.json);
  return {
    ...extracted,
    model: result.model,
    readAt: new Date(),
    raw: result.json,
    latencyMs: result.latencyMs,
    usage: result.usage,
    approxCostUsd: result.approxCostUsd,
  };
}
