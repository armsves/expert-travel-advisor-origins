import { defineChannel, GET, POST } from 'eve/channels';
import { handleMipRequest } from '../mip003.mjs';

async function respond(request: Request, args: { waitUntil: (task: Promise<unknown>) => void }) {
  let body: unknown;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    body = await request.json().catch(() => null);
  }
  const url = new URL(request.url);
  const outcome = await handleMipRequest({
    method: request.method,
    path: url.pathname,
    query: url.searchParams,
    body,
    env: process.env,
    waitUntil: args.waitUntil,
  });
  return Response.json(outcome.body, { status: outcome.status });
}

export default defineChannel({
  routes: [
    GET('/availability', respond),
    GET('/input_schema', respond),
    GET('/status', respond),
    GET('/demo', respond),
    POST('/start_job', respond),
    POST('/provide_input', respond),
  ],
});
