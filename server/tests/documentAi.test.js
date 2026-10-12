import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyDocument } from '../src/services/ai/documentAi.js';

const env = {
  ai: { provider: 'gemini', apiKey: 'test', model: 'gemini-2.5-flash', timeoutMs: 1000 },
};

const file = { mimeType: 'image/jpeg', bytes: Buffer.from('x') };

function quotaError() {
  const error = new Error('You exceeded your current quota, please check your plan and billing details.');
  error.statusCode = 429;
  return error;
}

test('a used-up model quota tries the next model once', async () => {
  const seen = [];
  const complete = async (request) => {
    seen.push(request.model);
    if (request.model === 'gemini-2.5-flash') throw quotaError();
    return {
      json: { documentType: 'fuel_receipt', confidence: 90, evidence: 'Pertamina', needsReview: false },
      model: request.model,
      latencyMs: 1,
      usage: null,
      approxCostUsd: null,
    };
  };
  const result = await classifyDocument(env, file, complete);
  assert.equal(result.classification.documentType, 'fuel_receipt');
  assert.equal(result.model, 'gemini-3.5-flash');
  assert.deepEqual(seen, ['gemini-2.5-flash', 'gemini-3.5-flash']);
});

test('a model that does not answer in time is skipped', async () => {
  const seen = [];
  const complete = async (request) => {
    seen.push(request.model);
    if (request.model === 'gemini-2.5-flash') {
      const error = new Error('The model took too long to respond.');
      error.code = 'TIMEOUT';
      throw error;
    }
    return {
      json: { documentType: 'fuel_receipt', confidence: 90, evidence: 'Pertamina', needsReview: false },
      model: request.model,
      latencyMs: 1,
      usage: null,
      approxCostUsd: null,
    };
  };
  const result = await classifyDocument(env, file, complete);
  assert.equal(result.model, 'gemini-3.5-flash');
  assert.deepEqual(seen, ['gemini-2.5-flash', 'gemini-3.5-flash']);
});

test('a busy model is skipped for the next one', async () => {
  const seen = [];
  const complete = async (request) => {
    seen.push(request.model);
    if (request.model === 'gemini-2.5-flash') {
      throw new Error('This model is currently experiencing high demand. Please try again later.');
    }
    return {
      json: { documentType: 'fuel_receipt', confidence: 90, evidence: 'Pertamina', needsReview: false },
      model: request.model,
      latencyMs: 1,
      usage: null,
      approxCostUsd: null,
    };
  };
  const result = await classifyDocument(env, file, complete);
  assert.equal(result.model, 'gemini-3.5-flash');
  assert.deepEqual(seen, ['gemini-2.5-flash', 'gemini-3.5-flash']);
});

test('a retired model is skipped for the next one', async () => {
  const seen = [];
  const complete = async (request) => {
    seen.push(request.model);
    if (request.model === 'gemini-2.5-flash') throw quotaError();
    if (request.model === 'gemini-3.5-flash') {
      const error = new Error('This model is no longer available to new users.');
      error.statusCode = 404;
      throw error;
    }
    return {
      json: { documentType: 'fuel_receipt', confidence: 90, evidence: 'Pertamina', needsReview: false },
      model: request.model,
      latencyMs: 1,
      usage: null,
      approxCostUsd: null,
    };
  };
  const result = await classifyDocument(env, file, complete);
  assert.equal(result.model, 'gemini-3.5-flash-lite');
  assert.deepEqual(seen, ['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite']);
});
