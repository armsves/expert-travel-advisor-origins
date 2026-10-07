import { defineChannel, GET, POST } from 'eve/channels';
import { handleHotelRequest } from '../hotels-http.mjs';
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

async function hotels(request: Request) {
  const body = await request.json().catch(() => null);
  const url = new URL(request.url);
  const outcome = await handleHotelRequest({ method: request.method, path: url.pathname, body });
  return Response.json(outcome?.body ?? { detail: 'Not found' }, { status: outcome?.status ?? 404 });
}

export default defineChannel({
  routes: [
    POST('/hotels/search', hotels),
    POST('/hotels/book', hotels),
    GET('/availability', respond),
    GET('/input_schema', respond),
    GET('/status', respond),
    GET('/demo', respond),
    POST('/start_job', respond),
    POST('/provide_input', respond),
  ],
});
