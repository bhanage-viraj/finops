import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createApp } from '../src/app.js';

const env = {
  clientUrl: 'http://localhost:5173',
  jwtSecret: 'test-secret',
  upload: { dir: '/tmp', maxBytes: 1_000_000 },
  ai: { provider: 'gemini', apiKey: '', model: 'x', timeoutMs: 1000 },
  zoho: { dc: 'com', clientId: '', clientSecret: '', organizationId: '', redirectUri: 'http://localhost/auth/zoho/callback' },
};

function request(server, { path, accept }) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http.get({
      hostname: '127.0.0.1',
      port,
      path,
      headers: { Accept: accept },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        type: res.headers['content-type'] || '',
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    }).on('error', reject);
  });
}

test('refreshing a document page serves the website, not the API sign-in JSON', async () => {
  const app = createApp(env);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const page = await request(server, {
      path: '/documents/6acd9247b6c5432d880ddc88',
      accept: 'text/html,application/xhtml+xml',
    });
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.match(page.body, /FinOps|root/i);
    assert.equal(page.body.includes('Sign in required'), false);

    const api = await request(server, {
      path: '/documents/6acd9247b6c5432d880ddc88',
      accept: 'application/json',
    });
    assert.equal(api.status, 401);
    assert.match(api.body, /Sign in required/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
