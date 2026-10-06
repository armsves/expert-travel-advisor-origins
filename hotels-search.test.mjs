import assert from 'node:assert/strict';
import test from 'node:test';
import { briefFromText, renderResult } from './agent/hotels-search.mjs';

test('reads a Manila booking request', () => {
  const brief = briefFromText('Book Manila hotel stay\nPrepare a stay for Manila from 2026-10-18 to 2026-10-22 for 2 adults.');
  assert.equal(brief.destination, 'Manila');
  assert.equal(brief.check_in, '2026-10-18');
  assert.equal(brief.check_out, '2026-10-22');
  assert.equal(brief.adults, '2');
  assert.equal(brief.action, 'checkout');
  assert.equal(brief.payment_type, 'PAY_LATER');
});

test('renders returned stays without adding a hotel', () => {
  const text = renderResult({
    status: 'completed',
    action: 'search',
    destination: 'Manila',
    check_in: '2026-10-18',
    check_out: '2026-10-22',
    payment_type: 'PAY_LATER',
    stays: [{ name: 'Example Hotel', property_id: '1', price: '$100', free_cancellation: true }],
  });
  assert.match(text, /Example Hotel/);
  assert.match(text, /Search only/);
});
