import { createHmac, timingSafeEqual } from 'node:crypto';

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sign(data, secret) {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function createToken(payload, secret, ttlSeconds = 8 * 60 * 60) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const data = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(body)}`;
  return `${data}.${sign(data, secret)}`;
}

export function readToken(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const data = `${header}.${body}`;
  const expected = sign(data, secret);
  const actualBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
