import assert from 'node:assert/strict';
import test from 'node:test';
import { handleHotelRequest } from './agent/hotels-http.mjs';

test('hotel search returns the stays the agency reads', async () => {
  const outcome = await handleHotelRequest({
    method: 'POST',
    path: '/hotels/search',
    body: { destination: 'Manila', check_in: '2026-10-18', check_out: '2026-10-22', adults: 2 },
    search: async (input) => {
      assert.equal(input.action, 'search');
      assert.equal(input.destination, 'Manila');
      return { stays: [{ property_id: '1', name: 'Sulit Hotel Manila', price: '$62', free_cancellation: true, url: 'https://www.hotels.com/example' }] };
    },
  });
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.stays[0].name, 'Sulit Hotel Manila');
});

test('hotel book asks for the checkout of one property', async () => {
  const outcome = await handleHotelRequest({
    method: 'POST',
    path: '/hotels/book',
    body: { destination: 'Manila', property_id: '113111873' },
    search: async (input) => {
      assert.equal(input.action, 'checkout');
      assert.equal(input.property_id, '113111873');
      return { checkout: { checkout_url: 'https://www.hotels.com/checkout' } };
    },
  });
  assert.equal(outcome.body.checkout.checkout_url, 'https://www.hotels.com/checkout');
});

test('a bad hotel request names the problem', async () => {
  const { HotelsError } = await import('./agent/hotels-api.mjs');
  const outcome = await handleHotelRequest({
    method: 'POST',
    path: '/hotels/search',
    body: {},
    search: async () => { throw new HotelsError('check_in must be YYYY-MM-DD'); },
  });
  assert.equal(outcome.status, 400);
  assert.equal(outcome.body.detail, 'check_in must be YYYY-MM-DD');
});
