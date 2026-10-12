import assert from 'node:assert/strict';
import test from 'node:test';
import { createToken, readToken } from '../src/utils/token.js';

test('a token round-trips and an expired token is rejected', () => {
  const secret = 'test-secret';
  const token = createToken({ sub: 'user-1', role: 'staff' }, secret, 60);
  assert.equal(readToken(token, secret).sub, 'user-1');
  assert.equal(readToken(token, 'other-secret'), null);
  const expired = createToken({ sub: 'user-1' }, secret, -10);
  assert.equal(readToken(expired, secret), null);
});
