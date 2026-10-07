import { Client } from 'eve/client';
import { writeFileSync } from 'node:fs';

export const DEPLOYMENT_ORIGIN = 'https://expert-travel-advisor-eve.vercel.app';

export function deploymentHost(env = process.env) {
  const raw = env.EVE_REMOTE_URL?.trim();
  if (!raw) throw new Error(`EVE_REMOTE_URL must be ${DEPLOYMENT_ORIGIN}`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`EVE_REMOTE_URL must be ${DEPLOYMENT_ORIGIN}`);
  }
  const origin = `${url.protocol}//${url.host}`;
  if (origin !== DEPLOYMENT_ORIGIN || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error(`EVE_REMOTE_URL must be ${DEPLOYMENT_ORIGIN}`);
  }
  return origin;
}

function remoteClient(env = process.env) {
  const username = env.EVE_AUTH_USERNAME?.trim();
  const password = env.EVE_AUTH_PASSWORD;
  const auth = username && password ? { basic: { username, password } } : undefined;
  return new Client({ host: deploymentHost(env), auth });
}

export async function consult(input, journal, env = process.env) {
  if (typeof input !== 'string' || !input.trim() || input.length > 16000) {
    throw new Error('Input must contain 1 to 16000 characters');
  }
  const host = deploymentHost(env);
  const { session } = await remoteClient(env).sessions.create();
  writeFileSync(journal, JSON.stringify({ sessionId: session.state.sessionId, phase: 'sending', host }), { mode: 0o600 });
  const result = await (await session.send(input)).result();
  const question = result.inputRequests.map((request) => request.prompt?.trim()).filter(Boolean).join('\n');
  if (result.status === 'failed' || (!question && !result.message?.trim())) {
    const failed = result.events?.find((event) => event.type === 'step.failed' || event.type === 'turn.failed');
    const detail = failed?.data?.message || failed?.data?.error;
    throw new Error(typeof detail === 'string' && detail.trim() ? detail.trim() : 'Turn did not return a final answer');
  }
  writeFileSync(
    journal,
    JSON.stringify({ sessionId: session.state.sessionId, phase: question && !result.message?.trim() ? 'waiting' : 'answered', host }),
    { mode: 0o600 },
  );
  return { message: result.message?.trim() || '', question };
}

export async function answer(input, journal, env = process.env) {
  const turn = await consult(input, journal, env);
  if (turn.question || !turn.message) throw new Error(turn.question || 'Turn did not return a final answer');
  return turn.message;
}
