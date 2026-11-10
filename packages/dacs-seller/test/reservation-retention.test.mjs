import test from 'node:test';
import assert from 'node:assert/strict';
import { SellerTransportError } from '../src/dacs/seller-transport-auth.mjs';
import { accountingFixture, T0, JOB2, nonceKey } from './helpers/reservation-accounting-fixture.mjs';
import { FIXTURE_PROFILE } from './helpers/wire-authority-fixture.mjs';

const REPLAY_WINDOW_MS = 60000;

test('cleanup preserves the route guard while an earlier reservation can still be refused', async t => {
  for (const state of ['new', 'recover', 'completed']) await t.test(state, async t => {
    const f = await accountingFixture(t);
    const [earlier, settled] = [f.payload(), f.payload()].sort((a, b) => nonceKey(a).localeCompare(nonceKey(b)));
    assert.ok(nonceKey(earlier) < nonceKey(settled));
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    const refusal = new SellerTransportError('peer_expired', 408);
    const pending = f.reserve(f.args(earlier, { checked: { reserve: async () => {
      await barrier;
      throw refusal;
    } } }));
    const refused = assert.rejects(pending, error => error === refusal);
    try {
      assert.equal(f.rows()[0].state, 'reserving');
      assert.equal((await f.reserve(f.args(settled, { checked: { reserve: async () => ({ state }) } }))).state, state);
      f.setTime(T0 + REPLAY_WINDOW_MS);
      await f.reserve(f.args(f.payload({ jobId: JOB2 })));
      const afterCleanup = f.rows().map(row => ({ key: row.key, state: row.state }));
      release();
      await refused;
      let oldReservation, oldError;
      try {
        oldReservation = f.store().reserve(f.payload(), {}, { keepProfile: FIXTURE_PROFILE });
      } catch (error) { oldError = error; }
      t.diagnostic(JSON.stringify({ settledState: state, afterCleanup,
        afterRefusal: f.rows().map(row => ({ key: row.key, state: row.state })),
        oldReserve: oldError ? { code: oldError.code, status: oldError.status } : { disposition: oldReservation.disposition } }));
      assert.equal(oldError?.code, 'peer_operation_conflict', 'the old route must keep refusing the accounted effect');
      assert.equal(oldError.status, 409);
      assert.equal(f.rows().find(row => row.key === nonceKey(settled))?.state, state);
      assert.equal(f.rows().find(row => row.key === nonceKey(earlier))?.state, 'refused');
    } finally {
      release();
      await refused;
    }
  });
});
