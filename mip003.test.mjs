import assert from 'node:assert/strict';
import test from 'node:test';
import { handleMipRequest, inputHash, paymentRequestBody, schemaHash, stayRequest } from './agent/mip003.mjs';

function memoryStore() {
  const jobs = new Map();
  return {
    async get(id) { return jobs.get(id) || null; },
    async put(job) { jobs.set(job.id, job); },
  };
}

const env = {
  AGENT_IDENTIFIER: 'agent-1',
  PAYMENT_SERVICE_URL: 'https://payment.example',
  PAYMENT_API_KEY: 'test-key',
  NETWORK: 'Preprod',
  SELLER_VKEY: 'addr1seller',
};

function payment() {
  return {
    async create() {
      return {
        data: {
          blockchainIdentifier: 'block-1',
          payByTime: 1721480200,
          submitResultTime: 1717171717,
          unlockTime: 1717172717,
          externalDisputeUnlockTime: 1717173717,
          agentIdentifier: 'agent-1',
          sellerVKey: 'addr1seller',
        },
      };
    },
    async isPaid() { return false; },
  };
}

test('registers a Preprod V2 payment for one test USDM', () => {
  const body = paymentRequestBody({
    agentIdentifier: 'agent-1',
    network: 'Preprod',
    identifierFromPurchaser: 'ab'.repeat(8),
    inputHash: 'cd'.repeat(32),
    now: () => Date.parse('2026-10-07T00:00:00.000Z'),
    env: { SUPPORTED_PAYMENT_SOURCE_INDEX: '0' },
  });
  assert.equal(body.paymentSourceType, 'Web3CardanoV2');
  assert.equal(body.supportedPaymentSourceIndex, 0);
  assert.equal(body.RequestedFunds[0].amount, '1000000');
  assert.equal(body.payByTime, '2026-10-07T00:30:00.000Z');
  assert.equal(body.paymentType, undefined);
});

test('publishes availability, the input schema, and demo data', async () => {
  const availability = await handleMipRequest({ method: 'GET', path: '/availability' });
  assert.equal(availability.body.status, 'available');
  assert.equal(availability.body.type, 'masumi-agent');
  const schema = await handleMipRequest({ method: 'GET', path: '/input_schema' });
  assert.equal(schema.body.input_data[0].id, 'request');
  const demo = await handleMipRequest({ method: 'GET', path: '/demo' });
  assert.equal(typeof demo.body.output.result, 'string');
});

test('turns a paid agency search into a stay request for Hotel book expert', () => {
  const request = stayRequest({
    trip_request_json: JSON.stringify({
      stays: {
        check_in_date: '2026-10-18',
        check_out_date: '2026-10-22',
        rooms: [{ adults: 2 }],
        location: { city: 'Manila', country_code: 'PH' },
      },
    }),
  });
  assert.match(request, /in Manila from 2026-10-18 to 2026-10-22 for 2 adults/);
  assert.match(request, /Return the hotel list/);
});

test('starts a job only from the published schema and keeps it awaiting payment', async () => {
  const store = memoryStore();
  const missing = await handleMipRequest({
    method: 'POST',
    path: '/start_job',
    body: { input_data: { request: 'Manila' } },
    env,
    store,
    payment: payment(),
  });
  assert.equal(missing.status, 400);
  const started = await handleMipRequest({
    method: 'POST',
    path: '/start_job',
    body: { identifier_from_purchaser: 'trip-1', input_data: { request: 'Manila from 2026-10-18 to 2026-10-21 for 2 adults' } },
    env,
    store,
    payment: payment(),
  });
  assert.equal(started.status, 200);
  assert.equal(started.body.blockchainIdentifier, 'block-1');
  assert.equal(started.body.input_hash, inputHash(started.body.identifierFromPurchaser ? { request: 'Manila from 2026-10-18 to 2026-10-21 for 2 adults' } : {}, 'trip-1'));
  const status = await handleMipRequest({
    method: 'GET',
    path: '/status',
    query: new URLSearchParams({ job_id: started.body.id }),
    env,
    store,
    payment: payment(),
  });
  assert.equal(status.body.status, 'awaiting_payment');
  const absent = await handleMipRequest({
    method: 'GET',
    path: '/status',
    query: new URLSearchParams({ job_id: 'missing' }),
    store,
  });
  assert.equal(absent.status, 404);
});

test('checks the follow-up schema hash before accepting input', async () => {
  const schema = { input_data: [{ id: 'stay', type: 'string', name: 'Stay', validations: [{ validation: 'min', value: '1' }] }] };
  const store = memoryStore();
  await store.put({
    id: 'job-1',
    status: 'awaiting_input',
    identifierFromPurchaser: 'trip-1',
    inputSchema: schema,
  });
  const rejected = await handleMipRequest({
    method: 'POST',
    path: '/provide_input',
    body: { job_id: 'job-1', input_schema_hash: 'nope', input_data: { stay: '1' } },
    store,
  });
  assert.equal(rejected.status, 400);
  const accepted = await handleMipRequest({
    method: 'POST',
    path: '/provide_input',
    body: { job_id: 'job-1', input_schema_hash: schemaHash(schema), input_data: { stay: '1' } },
    store,
    waitUntil() {},
    advance: async () => ({ status: 'completed', result: 'quoted only', inputSchema: null }),
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.input_hash.length, 64);
  assert.equal(accepted.body.signature, '');
});
