import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseStay, confirmationQuestion, inspectRequest, replyIntent } from './agent/follow-up.mjs';

const stays = [
  { name: 'The Sentinel Residences', property_id: '49157576', price: '$77' },
  { name: 'Sulit Hotel Manila', property_id: '112593518', price: '$83' },
];

test('asks for the missing date instead of searching', () => {
  const result = inspectRequest('Book a hotel in Manila for 2 adults');
  assert.match(result.question, /check-in and check-out/);
});

test('selects a stay by number and waits for yes', () => {
  assert.equal(chooseStay('2', stays).property_id, '112593518');
  assert.equal(replyIntent('yes'), 'confirm');
  assert.equal(replyIntent('Book Manila hotel'), 'other');
  assert.match(confirmationQuestion(stays[0], { check_in: '2026-10-18', check_out: '2026-10-22', adults: '2' }, 'Gift card quote'), /pay later/);
  assert.match(confirmationQuestion(stays[0], { check_in: '2026-10-18', check_out: '2026-10-22', adults: '2' }, 'Gift card quote'), /not purchased/);
});
