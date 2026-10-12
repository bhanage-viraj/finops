import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { completeVision } from './visionClient.js';
import {
  PROMPT_VERSION, assertClassification, assertExtraction, classificationSchema, extractionSchema,
} from './schemas.js';

const promptDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../prompts');
const classifyPrompt = fs.readFileSync(path.join(promptDir, 'classify.prompt.txt'), 'utf8');
const extractPrompt = fs.readFileSync(path.join(promptDir, 'extract.prompt.txt'), 'utf8');

// The configured model is tried first. These are used when it times out, its quota is gone, or it is retired.
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

async function completeWithFallback(env, file, prompt, schema, complete) {
  let last;
  for (const model of modelsFor(env.ai.model)) {
    try {
      return await once(() => complete({
        provider: env.ai.provider,
        apiKey: env.ai.apiKey,
        model,
        timeoutMs: env.ai.timeoutMs,
        rates: env.ai,
        prompt,
        mimeType: file.mimeType,
        bytes: file.bytes,
        schema,
      }));
    } catch (error) {
      last = error;
      if (!tryNextModel(error)) throw error;
    }
  }
  throw last;
}

export async function classifyDocument(env, file, complete = completeVision) {
  const result = await completeWithFallback(env, file, classifyPrompt, classificationSchema, complete);
  return {
    classification: assertClassification(result.json),
    model: result.model,
    latencyMs: result.latencyMs,
    usage: result.usage,
    approxCostUsd: result.approxCostUsd,
    promptVersion: PROMPT_VERSION,
  };
}

export async function extractDocument(env, file, documentType, complete = completeVision) {
  const prompt = `${extractPrompt}\n\nPreferred document type: ${documentType}.`;
  const result = await completeWithFallback(env, file, prompt, extractionSchema, complete);
  return {
    extraction: assertExtraction(result.json),
    model: result.model,
    latencyMs: result.latencyMs,
    usage: result.usage,
    approxCostUsd: result.approxCostUsd,
    promptVersion: PROMPT_VERSION,
  };
}
