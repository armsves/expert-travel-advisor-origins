import { HotelsError, runHotelRequest } from './hotels-api.mjs';

export async function handleHotelRequest({ method, path, body, search = runHotelRequest }) {
  if (method !== 'POST' || (path !== '/hotels/search' && path !== '/hotels/book')) return null;
  const input = body && typeof body === 'object' ? body : {};
  try {
    const result = await search({
      ...input,
      action: path === '/hotels/book' ? 'checkout' : 'search',
      property_id: input.property_id || '',
    });
    return { status: 200, body: result };
  } catch (error) {
    const message = error instanceof HotelsError ? error.message : 'Hotels.com search failed';
    return { status: 400, body: { detail: message } };
  }
}
