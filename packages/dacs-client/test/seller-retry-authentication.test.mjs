import test from 'node:test';
import { DACS_SELLER_HTTP_HEADER } from '@kynesyslabs/dacs/wire';
import assert from 'node:assert/strict';
import { storedWorld, PATHS, bodyFor, sameBodies } from './helpers/stored-request-fixture.mjs';

for (const path of [PATHS.proposals, PATHS.commitmentSignature, PATHS.state]) {
  test(`unauthenticated ${path} sends once per explicit call even with real purchase records`, async t => {
    const s = await storedWorld(t);
    const client = s.client({ authentication: undefined, respond: init => {
      assert.equal(init.headers[DACS_SELLER_HTTP_HEADER], undefined);
      return new Response('{"error":"operation_uncertain"}', { status: 503, headers: { 'content-type': 'application/json' } });
    } });
    await assert.rejects(client.request(path, bodyFor(path)), e => e.answerClass === 'unknown');
    assert.equal(s.fetches.length, 1);
    assert.deepEqual(s.delays, []);
    await assert.rejects(client.request(path, bodyFor(path)));
    assert.equal(s.fetches.length, 2);
    if (path !== PATHS.state) assert.equal(s.record(path).attempts, 2);
  });
}

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
