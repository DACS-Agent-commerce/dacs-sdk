import test from 'node:test';
import assert from 'node:assert/strict';
import { storedWorld, PATHS, bodyFor, sameBodies } from './helpers/stored-request-fixture.mjs';

test('a seller client without a wire authentication is refused at construction and sends nothing', async t => {
  const s = await storedWorld(t);
  assert.throws(() => s.client({ authentication: undefined }), { name: 'TypeError', message: /wire authentication/ });
  assert.equal(s.fetches.length, 0);
});

test('authenticated callers without request records send once', async t => {
  const s = await storedWorld(t);
  await assert.rejects(s.client({ requestRecords: null, respond: init => s.reply(init, 503, { error: 'seller_effect_pending' }) }).propose(bodyFor(PATHS.proposals)));
  assert.equal(s.fetches.length, 1); assert.deepEqual(s.delays, []);
});

test('authenticated stored requests retry twice with identical bytes and fresh nonces', async t => {
  const s = await storedWorld(t);
  await assert.rejects(s.client({ respond: init => s.reply(init, 503, { error: 'seller_effect_pending' }) }).propose(bodyFor(PATHS.proposals)));
  assert.equal(s.fetches.length, 3); assert.deepEqual(s.delays, [5000, 5000]); sameBodies(s.fetches);
});
