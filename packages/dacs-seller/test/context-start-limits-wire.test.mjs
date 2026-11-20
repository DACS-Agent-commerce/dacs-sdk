// The hourly unpaid-start limits on the context route: the buyer's own limit and the seller's global limit each refuse with their own code.
// The global limit is checked first, so each case sets the other limit higher than the one under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contextWireWorld } from './helpers/context-wire-world.mjs';

// `ownStart` is whether the start already counted in the hour is this buyer's or another buyer's.
const LIMITS = [
  ['per-buyer', { maxStartsPerHour: 5, maxStartsPerBuyerPerHour: 1 }, true, 'buyer_unpaid_start_limit'],
  ['global', { maxStartsPerHour: 1, maxStartsPerBuyerPerHour: 5 }, false, 'unpaid_start_limit'],
];

for (const [limit, contextStartLimits, ownStart, code] of LIMITS) {
  test(`a first admission over the ${limit} hourly start limit, with the other limit higher, is refused ${code} 429 and takes no hold`, async (t) => {
    const w = await contextWireWorld(t, { storeOptions: { contextStartLimits } });
    const request = await w.startContext();
    w.seedContextRecord(ownStart ? { buyer: w.buyer } : {});
    const answer = await w.post(request);
    assert.deepEqual([answer.status, answer.body.error], [429, code]);
    assert.equal(w.challengeOf(request.nonce).failure.code, code);
    assert.deepEqual([w.counts.holds.length, w.rowOf(), w.journalFiles(), w.counts.vetWrites], [0, null, 0, 0]);
  });
}
