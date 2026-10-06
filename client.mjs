import { Client } from 'eve/client';
import { writeFileSync } from 'node:fs';

const username = process.env.EVE_AUTH_USERNAME?.trim();
const password = process.env.EVE_AUTH_PASSWORD;
const auth = username && password ? { basic: { username, password } } : undefined;
const host = process.env.EVE_REMOTE_URL?.trim() || process.env.EVE_URL;

export const client = new Client({ host, auth });

export async function answer(input, journal) {
  if (typeof input !== 'string' || !input.trim() || input.length > 16000) {
    throw new Error('Input must contain 1 to 16000 characters');
  }
  const { session } = await client.sessions.create();
  writeFileSync(journal, JSON.stringify({ sessionId: session.state.sessionId, phase: 'sending' }), { mode: 0o600 });
  const result = await (await session.send(input)).result();
  if (result.status === 'failed' || result.inputRequests.length || !result.message?.trim()) {
    const failed = result.events?.find((event) => event.type === 'step.failed' || event.type === 'turn.failed');
    const detail = failed?.data?.message || failed?.data?.error;
    throw new Error(typeof detail === 'string' && detail.trim() ? detail.trim() : 'Turn did not return a final answer');
  }
  writeFileSync(
    journal,
    JSON.stringify({ sessionId: session.state.sessionId, phase: 'answered', result: result.message }),
    { mode: 0o600 },
  );
  return result.message;
}
