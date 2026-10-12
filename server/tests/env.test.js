import assert from 'node:assert/strict';
import test from 'node:test';
import { readEnv } from '../src/config/env.js';

const valid = {
  MONGODB_URI: 'mongodb://localhost:27017/finops',
  JWT_SECRET: 'test-secret',
  CLIENT_URL: 'http://localhost:5173',
};

test('readEnv names every missing required variable', () => {
  assert.throws(
    () => readEnv({}),
    (err) => {
      assert.match(err.message, /MONGODB_URI/);
      assert.match(err.message, /JWT_SECRET/);
      assert.match(err.message, /CLIENT_URL/);
      assert.match(err.message, /\.env\.example/);
      return true;
    },
  );
});

test('readEnv accepts the required values and defaults PORT to 4000', () => {
  const env = readEnv(valid);
  assert.equal(env.port, 4000);
  assert.equal(env.mongodbUri, valid.MONGODB_URI);
  assert.equal(env.jwtSecret, valid.JWT_SECRET);
  assert.equal(env.clientUrl, valid.CLIENT_URL);
});
