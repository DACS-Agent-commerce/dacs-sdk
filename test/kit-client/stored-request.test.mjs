// P13b1b test 19 runs here because the kit's operation guard is admitted only by the kit-client runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { storedWorld, PATHS, nonce, sameBodies } from '../../packages/dacs-client/test/helpers/stored-request-fixture.mjs';
import { JOB, sellerTransportPair } from './fixtures.mjs';

test("a retry after a lost response re-signs the stored bytes with a fresh nonce and expiry, accepts the seller's completed answer, and the seller performs one effect", async (t) => {
  const s = await storedWorld(t), { store } = await sellerTransportPair(t);
  let effects = 0, lost = true;
  const respond = async (init) => {
    // The real kit's durable reservation store is the idempotent effect boundary.
    const reserved = store.reserve(nonce(init), JSON.parse(init.body));
    if (reserved.disposition === 'perform') { effects++; store.finish(reserved, 200, JSON.stringify({ status: 'complete' })); }
    if (lost) { lost = false; throw new Error('TEST-lost-answer'); }
    return s.reply(init);
  };
  await s.client({ respond }).propose({ jobId: JOB });
  sameBodies(s.fetches);
  assert.equal(effects, 1);
  assert.ok(nonce(s.fetches[1]).expiresAt > nonce(s.fetches[0]).expiresAt);
  assert.equal(s.record(PATHS.proposals).lastClass, 'result');
});
