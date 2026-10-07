import assert from 'node:assert/strict';
import test from 'node:test';
import { DEPLOYMENT_ORIGIN, deploymentHost } from './client.mjs';

test('the worker host is the new deployment', () => {
  assert.equal(deploymentHost({ EVE_REMOTE_URL: DEPLOYMENT_ORIGIN }), DEPLOYMENT_ORIGIN);
  assert.throws(() => deploymentHost({ EVE_REMOTE_URL: 'https://expert-travel-advisor.vercel.app' }), /expert-travel-advisor-eve/);
  assert.throws(() => deploymentHost({ EVE_REMOTE_URL: 'http://127.0.0.1:21951' }), /expert-travel-advisor-eve/);
  assert.throws(() => deploymentHost({}), /expert-travel-advisor-eve/);
});
