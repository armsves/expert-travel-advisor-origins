import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eveAddress, eveBinary } from './start.mjs';

test('Eve rejects a mismatched port or exposed listener', () => {
  assert.throws(() => eveAddress({ EVE_PORT: '21951', EVE_URL: 'http://127.0.0.1:21950' }), /must match/);
  assert.throws(() => eveAddress({ EVE_URL: 'http://0.0.0.0:21951' }), /must match/);
  assert.throws(() => eveAddress({ EVE_PORT: '0' }), /integer/);
  assert.deepEqual(eveAddress({ EVE_URL: 'http://127.0.0.1:21951' }), {
    port: 21951,
    url: 'http://127.0.0.1:21951',
  });
});

test('Eve executable resolves through Node package lookup', () => {
  assert.match(eveBinary(), /node_modules\/eve\/bin\/eve\.js$/);
});
