// The only module that talks to an AI provider.

function usageFrom(body) {
  const usage = body?.usageMetadata;
  if (!usage) return null;
  return {
    promptTokens: usage.promptTokenCount ?? null,
    outputTokens: usage.candidatesTokenCount ?? null,
    totalTokens: usage.totalTokenCount ?? null,
  };
}

function approxCost(usage, rates) {
  if (!usage || rates.inputUsdPerMillion == null || rates.outputUsdPerMillion == null) return null;
  const input = ((usage.promptTokens || 0) / 1_000_000) * rates.inputUsdPerMillion;
  const output = ((usage.outputTokens || 0) / 1_000_000) * rates.outputUsdPerMillion;
  return Math.round((input + output) * 1_000_000) / 1_000_000;
}

async function geminiComplete({
  apiKey, model, timeoutMs, prompt, mimeType, bytes, schema, fetchImpl, rates,
}) {
  if (!apiKey) {
    const error = new Error('AI_API_KEY is not set. The file is saved and can be read after the key is added.');
    error.code = 'AI_NOT_CONFIGURED';
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: prompt },
              { inlineData: { mimeType, data: Buffer.from(bytes).toString('base64') } },
            ],
          }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseSchema: schema,
          },
        }),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = body?.error?.message || `The model request failed (${response.status}).`;
      const error = new Error(message);
      error.statusCode = response.status;
      throw error;
    }
    if (body.promptFeedback?.blockReason) {
      throw new Error('The model declined to read this document.');
    }
    const text = (body.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('');
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      const error = new Error('The model did not return valid JSON.');
      error.code = 'INVALID_JSON';
      throw error;
    }
    const usage = usageFrom(body);
    return {
      json,
      model,
      latencyMs: Date.now() - started,
      usage,
      approxCostUsd: approxCost(usage, rates),
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeout = new Error('The model took too long to respond.');
      timeout.code = 'TIMEOUT';
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const providers = { gemini: geminiComplete };

export async function completeVision(request) {
  const provider = providers[request.provider || 'gemini'];
  if (!provider) {
    throw new Error(`The AI provider "${request.provider}" is not available.`);
  }
  return provider({ fetchImpl: globalThis.fetch, ...request });
}
