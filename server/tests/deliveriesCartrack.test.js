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

test('cartrack client reads speed events with a GET', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [], meta: { last_page: 1 } }) };
  };
  const client = createCartrackClient({
    cartrack: { baseUrl: 'https://fleetapi-id.cartrack.com/rest', username: 'user', apiKey: 'secret' },
  }, { fetchImpl });
  await client.vehicleEvents('DK 8157 HJ', {
    start_timestamp: '2026-10-26 05:00:00',
    end_timestamp: '2026-10-26 09:00:00',
    'filter[terminal_event_type_id]': 2,
    limit: 1000,
  });
  assert.match(calls[0].url, /\/vehicles\/DK%208157%20HJ\/events/);
  assert.match(calls[0].url, /filter(%5B|\[)terminal_event_type_id(%5D|\])=2/);
  assert.equal(calls[0].opts.method, 'GET');
});

test('cartrack client hard-blocks writes even when credentials exist', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return { ok: true, status: 200, text: async () => '[]' };
  };
  const client = createCartrackClient({
    cartrack: { username: 'u', apiKey: 'k' },
  }, { fetchImpl });
  assert.equal(client.readOnly, true);
  await assert.rejects(() => client.createJob({}), /read-only/i);
  await assert.rejects(() => client.completeJob('1'), /read-only/i);
  await assert.rejects(() => client._request('POST', '/delivery/jobs', { body: {} }), /read-only|GET/i);
  assert.equal(called, false);
});
