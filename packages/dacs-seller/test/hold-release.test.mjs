import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '@kynesyslabs/dacs';
import { completeWireEffect } from '@kynesyslabs/dacs/wire';
import { sellerStoreInternals } from '../src/dacs/seller-transport-auth.mjs';
import { accountingFixture, T0, JOB } from './helpers/reservation-accounting-fixture.mjs';
import { FIXTURE_PROFILE } from './helpers/wire-authority-fixture.mjs';
import { holdReleaseProbes } from './helpers/hold-release-probes.mjs';

holdReleaseProbes({ accountingFixture, completeWireEffect });

test('a retired paid job refuses an old-path proposal with another Agreement after restart', async t => {
  let session = null;
  const f = await accountingFixture(t, { contextSessionState: () => session });
  const input = await f.payment();
  const outcome = { status: 200, text: '{"status":"paid"}' };
  completeWireEffect(f.journal, await f.reserve(input), outcome);
  session = 'finalised'; f.setTime(T0 + 7200000);
  const store = sellerStoreInternals(f.store());
  store.transaction(() => store.retireSlotsWithin(f.now(), JOB));
  assert.equal(f.db.prepare('SELECT job_retired FROM kit_slot_retirements WHERE job = ?').get(JOB).job_retired, 1);
  assert.equal(f.jobRows().length, 0); assert.equal(f.tuples(), 0);
  session = null; f.reopen();
  const snapshot = () => ({ rows: f.rows(), holds: f.holds(), jobs: f.jobRows(), payments: f.payments(), files: f.files() });
  const before = snapshot();
  const proposal = f.payload({ listingPin: input.payload.listingPin, agreementHash: sha256Hex('another Agreement') });
  assert.throws(() => f.store().reserve(proposal, {}, { keepProfile: FIXTURE_PROFILE }), { code: 'context_session_terminal', status: 409 });
  assert.deepEqual(snapshot(), before);
  const retry = await f.reserve(await f.payment());
  assert.equal(retry.state, 'completed'); assert.deepEqual(retry.outcome, outcome);
  assert.deepEqual(f.payments(), before.payments); assert.deepEqual(f.holds(), before.holds);
  assert.equal(f.jobRows().length, 0);
});
