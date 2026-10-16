import test from 'node:test';
import assert from 'node:assert/strict';
import { createCartrackClient } from '../src/integrations/cartrack/cartrackClient.js';
import { assertStatusTransition } from '../src/services/deliveries/deliveryService.js';

test('Delivered cannot come from GPS alone', () => {
  assert.throws(() => assertStatusTransition('delivered', 'gps'), /GPS alone/i);
  assert.doesNotThrow(() => assertStatusTransition('arrived', 'gps'));
  assert.doesNotThrow(() => assertStatusTransition('delivered', 'admin'));
  assert.doesNotThrow(() => assertStatusTransition('delivered', 'cartrack'));
});

test('cartrack client refuses when credentials missing', async () => {
  const client = createCartrackClient({ cartrack: { username: '', apiKey: '' } });
  assert.equal(client.configured(), false);
  await assert.rejects(() => client.listVehicles(), /not configured/i);
});

test('cartrack client sends basic auth and parses JSON', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{ vehicle_id: 1, registration: 'DK8619HJ' }]),
    };
  };
  const client = createCartrackClient({
    cartrack: {
      baseUrl: 'https://fleetapi-id.cartrack.com/rest',
      username: 'user',
      apiKey: 'secret',
    },
  }, { fetchImpl });
  const data = await client.listVehicles();
  assert.equal(data[0].registration, 'DK8619HJ');
  assert.ok(calls[0].opts.headers.Authorization.startsWith('Basic '));
});

test('cartrack client maps HTTP errors without stack traces to client', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    text: async () => JSON.stringify({ error: { message: 'Unauthorized for this role' } }),
  });
  const client = createCartrackClient({
    cartrack: { username: 'u', apiKey: 'k' },
  }, { fetchImpl });
  await assert.rejects(() => client.createJob({}), /Unauthorized/);
});
