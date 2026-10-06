import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const INPUT_SCHEMA = {
  input_data: [
    {
      id: 'request',
      type: 'string',
      name: 'Stay request',
      data: {
        description: 'City and dates. Example: Manila from 2026-10-18 to 2026-10-21 for 2 adults, pay later, free cancellation.',
      },
      validations: [{ validation: 'min', value: '1' }],
    },
  ],
};

export const DEMO = {
  input: {
    request: 'Manila from 2026-10-18 to 2026-10-21 for 2 adults, pay later, free cancellation.',
  },
  output: {
    result: 'A pay-later, free-cancellation stay with a Hotels.com gift card quote. The gift card is not purchased.',
  },
};

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function inputHash(inputData, identifier) {
  return createHash('sha256').update(`${identifier};${canonicalJson(inputData ?? {})}`).digest('hex');
}

export function schemaHash(schema) {
  return createHash('sha256').update(canonicalJson(schema)).digest('hex');
}

export async function handleMipRequest({ method, path, query, body, env = process.env, store, payment, now = () => Date.now(), waitUntil = () => {}, advance }) {
  const cleanPath = String(path || '').replace(/\/+$/, '') || '/';
  const known = ['/availability', '/input_schema', '/status', '/demo', '/start_job', '/provide_input'];
  const route = known.find((item) => cleanPath === item || cleanPath.endsWith(item)) || cleanPath;
  try {
    if (method === 'GET' && route === '/availability') {
      return json(200, {
        status: 'available',
        type: 'masumi-agent',
        message: 'Expert Travel Advisor is ready to accept jobs',
      });
    }
    if (method === 'GET' && route === '/input_schema') return json(200, INPUT_SCHEMA);
    if (method === 'GET' && route === '/demo') return json(200, DEMO);
    if (method === 'GET' && route === '/status') {
      return statusResponse(query?.get?.('job_id') || query?.get?.('jobId') || '', await jobs(store), payment, env, waitUntil, advance);
    }
    if (method === 'POST' && route === '/start_job') {
      return startJob(body, env, await jobs(store), payment, now);
    }
    if (method === 'POST' && route === '/provide_input') {
      return provideInput(body, await jobs(store), waitUntil, advance);
    }
    return json(404, { detail: 'Not found' });
  } catch (error) {
    return json(500, { detail: error instanceof Error ? error.message : 'Internal server error' });
  }
}

async function startJob(body, env, store, payment, now) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { detail: 'identifier_from_purchaser is required' });
  const identifier = String(body.identifier_from_purchaser || '').trim();
  if (!identifier) return json(400, { detail: 'identifier_from_purchaser is required' });
  const inputData = body.input_data && typeof body.input_data === 'object' && !Array.isArray(body.input_data) ? body.input_data : null;
  if (!inputData) return json(400, { detail: 'input_data must match the input schema' });
  const errors = validateInput(inputData, INPUT_SCHEMA);
  if (errors) return json(400, { detail: errors });

  const agentIdentifier = String(env.AGENT_IDENTIFIER || '').trim();
  const paymentUrl = String(env.PAYMENT_SERVICE_URL || '').trim();
  const paymentKey = String(env.PAYMENT_API_KEY || '').trim();
  const missing = [
    ['AGENT_IDENTIFIER', agentIdentifier],
    ['PAYMENT_SERVICE_URL', paymentUrl],
    ['PAYMENT_API_KEY', paymentKey],
  ].filter(([, present]) => !present).map(([name]) => name);
  if (missing.length) return json(500, { detail: `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required before a job can start` });
  const hash = inputHash(inputData, identifier);
  const created = await (payment || defaultPayment(env, now)).create({
    agentIdentifier,
    network: env.NETWORK || 'Preprod',
    identifierFromPurchaser: identifier,
    inputHash: hash,
  });
  const data = created.data || created;
  const job = {
    id: randomUUID(),
    status: 'awaiting_payment',
    identifierFromPurchaser: identifier,
    inputData,
    inputHash: hash,
    blockchainIdentifier: String(data.blockchainIdentifier || ''),
    payByTime: unixTime(data.payByTime),
    submitResultTime: unixTime(data.submitResultTime),
    unlockTime: unixTime(data.unlockTime),
    externalDisputeUnlockTime: unixTime(data.externalDisputeUnlockTime),
    agentIdentifier: String(data.agentIdentifier || agentIdentifier),
    sellerVKey: String(data.sellerVKey || env.SELLER_VKEY || ''),
    result: null,
    inputSchema: null,
  };
  if (!job.blockchainIdentifier) return json(500, { detail: 'The payment service did not return a blockchain identifier' });
  await store.put(job);
  return json(200, {
    id: job.id,
    blockchainIdentifier: job.blockchainIdentifier,
    payByTime: job.payByTime,
    submitResultTime: job.submitResultTime,
    unlockTime: job.unlockTime,
    externalDisputeUnlockTime: job.externalDisputeUnlockTime,
    agentIdentifier: job.agentIdentifier,
    sellerVKey: job.sellerVKey,
    identifierFromPurchaser: job.identifierFromPurchaser,
    input_hash: job.inputHash,
    inputHash: job.inputHash,
  });
}

async function statusResponse(jobId, store, payment, env, waitUntil, advance) {
  if (!jobId) return json(400, { detail: 'job_id is required' });
  let job = await store.get(jobId);
  if (!job) return json(404, { detail: 'Job not found' });
  if (job.status === 'awaiting_payment') {
    const paid = await (payment || defaultPayment(env)).isPaid(job.blockchainIdentifier);
    if (paid) {
      job = { ...job, status: 'running' };
      await store.put(job);
      waitUntil(settleJob(job, store, advance));
    }
  }
  const body = { status: job.status };
  if (job.status === 'awaiting_input' && job.inputSchema) body.input_schema = job.inputSchema;
  if (typeof job.result === 'string') body.result = job.result;
  return json(200, body);
}

async function provideInput(body, store, waitUntil, advance) {
  const jobId = String(body?.job_id || '').trim();
  const suppliedHash = String(body?.input_schema_hash || '').trim();
  const inputData = body?.input_data;
  if (!jobId || !inputData || typeof inputData !== 'object' || Array.isArray(inputData)) {
    return json(400, { detail: 'job_id and input_data are required' });
  }
  const job = await store.get(jobId);
  if (!job) return json(404, { detail: 'Job not found' });
  if (job.status !== 'awaiting_input' || !job.inputSchema) return json(400, { detail: 'This job is not awaiting input' });
  if (suppliedHash !== schemaHash(job.inputSchema)) return json(400, { detail: 'input_schema_hash does not match the requested input' });
  const errors = validateInput(inputData, job.inputSchema);
  if (errors) return json(400, { detail: errors });
  const next = { ...job, status: 'running', pendingInput: inputData, inputSchema: null };
  await store.put(next);
  waitUntil(settleJob(next, store, advance));
  return json(200, {
    input_hash: inputHash(inputData, job.identifierFromPurchaser),
    signature: '',
  });
}

async function settleJob(job, store, advance) {
  const current = await store.get(job.id);
  if (!current || current.status === 'completed' || current.status === 'failed') return;
  try {
    const step = await (advance || defaultAdvance)(current);
    await store.put({ ...current, ...step, pendingInput: null });
  } catch (error) {
    await store.put({
      ...current,
      status: 'failed',
      result: error instanceof Error ? error.message : 'The job failed',
      pendingInput: null,
      inputSchema: null,
    });
  }
}

export function validateInput(inputData, schema) {
  const fields = fieldsOf(schema);
  const known = new Set(fields.map((field) => field.id));
  for (const key of Object.keys(inputData)) {
    if (!known.has(key)) return `Unknown input ${key}`;
  }
  for (const field of fields) {
    const value = inputData[field.id];
    if (value == null || value === '') return `${field.name || field.id} is required`;
    if (field.type === 'string' && typeof value !== 'string') return `${field.id} must be a string`;
    if (field.type === 'boolean' && typeof value !== 'boolean') return `${field.id} must be a boolean`;
    if (field.type === 'option') {
      const values = field.data?.values || [];
      if (!values.includes(String(value))) return `${field.id} is not one of the offered values`;
    }
    const minimum = (field.validations || []).find((rule) => rule.validation === 'min');
    if (minimum && typeof value === 'string' && value.trim().length < Number(minimum.value)) {
      return `${field.id} is too short`;
    }
  }
  return null;
}

function fieldsOf(schema) {
  if (Array.isArray(schema?.input_data)) return schema.input_data;
  return (schema?.input_groups || []).flatMap((group) => group.input_data || []);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
    return sorted;
  }
  return value;
}

function unixTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(String(value || ''));
  if (Number.isNaN(parsed)) throw new Error('The payment service returned an unreadable time');
  return Math.trunc(parsed / 1000);
}

function json(status, body) {
  return { status, body };
}

async function jobs(store) {
  return store || (process.env.BLOB_READ_WRITE_TOKEN ? blobStore() : fileStore());
}

function fileStore(file = '.local/mip003-jobs.json') {
  return {
    async get(id) {
      return readAll(file)[id] || null;
    },
    async put(job) {
      const all = readAll(file);
      all[job.id] = job;
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify(all), { mode: 0o600 });
    },
  };
}

function readAll(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

async function blobStore() {
  const { get, put } = await import('@vercel/blob');
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  return {
    async get(id) {
      try {
        const result = await get(`jobs/${id}.json`, { access: 'private', token, useCache: false });
        if (!result?.stream) return null;
        return JSON.parse(await new Response(result.stream).text());
      } catch (error) {
        if (error && typeof error === 'object' && 'status' in error && error.status === 404) return null;
        throw error;
      }
    },
    async put(job) {
      await put(`jobs/${job.id}.json`, JSON.stringify(job), {
        access: 'private',
        token,
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
      });
    },
  };
}

function defaultPayment(env, now = () => Date.now()) {
  const base = String(env.PAYMENT_SERVICE_URL || '').replace(/\/$/, '');
  const headers = { token: env.PAYMENT_API_KEY, 'content-type': 'application/json' };
  return {
    async create({ agentIdentifier, network, identifierFromPurchaser, inputHash: hash }) {
      const payBy = new Date(now() + 12 * 60 * 60 * 1000).toISOString();
      const submitBy = new Date(now() + 24 * 60 * 60 * 1000).toISOString();
      const response = await fetch(`${base}/payment/`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          agentIdentifier,
          network: network || 'Preprod',
          paymentType: 'Web3CardanoV1',
          payByTime: payBy,
          submitResultTime: submitBy,
          identifierFromPurchaser,
          inputHash: hash,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = payload?.error?.message || payload?.message || `Payment request failed with HTTP ${response.status}`;
        throw new Error(message);
      }
      return payload;
    },
    async isPaid(blockchainIdentifier) {
      if (String(blockchainIdentifier).startsWith('FREE-')) return true;
      const response = await fetch(`${base}/payment/resolve-blockchain-identifier`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ network: env.NETWORK || 'Preprod', blockchainIdentifier, includeHistory: 'false' }),
      });
      if (!response.ok) return false;
      const payload = await response.json().catch(() => ({}));
      return payload?.data?.onChainState === 'FundsLocked';
    },
  };
}

async function defaultAdvance(job) {
  const { advanceTravelJob } = await import('./mip003-travel.mjs');
  return advanceTravelJob(job);
}
