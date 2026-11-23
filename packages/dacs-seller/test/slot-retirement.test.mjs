import test from 'node:test';
import assert from 'node:assert/strict';
import { completeWireEffect } from '@kynesyslabs/dacs/wire';
import { sellerStoreInternals } from '../src/dacs/seller-transport-auth.mjs';
import { accountingFixture, JOB, JOB2, T0 } from './helpers/reservation-accounting-fixture.mjs';

const HOUR = 3600000;
const NEXT_JOB = '01' + 'Z'.repeat(24);

for (const context of [false, true]) for (const restart of [false, true]) test(`a retired job refuses recovery of an ended ${context ? 'context' : 'proposal'} operation${restart ? ' after restart' : ''}`, async t => {
  let session = null;
  const f = await accountingFixture(t, { maxJobs: 1, maxContextRecords: 1,
    contextSessionState: ({ jobId }) => jobId === JOB ? session : null });
  if (context) completeWireEffect(f.journal, await f.reserve(await f.admit()), { status: 200, text: '{}' });
  completeWireEffect(f.journal, await f.reserve(context ? await f.admitContext() : await f.admit()), null);
  session = 'finalised'; f.setTime(T0 + 2 * HOUR);
  let port = sellerStoreInternals(f.store());
  port.transaction(() => port.retireSlotsWithin(f.now(), JOB));
  assert.equal(f.db.prepare('SELECT job_retired FROM kit_slot_retirements WHERE job = ?').get(JOB).job_retired, 1);
  if (restart) { session = null; f.reopen(); port = sellerStoreInternals(f.store()); }
  const retry = context ? await f.admitContext() : await f.admit();
  let charges = 0;
  retry.checkCapacityWithin = () => { charges++; return { class: 'general', allocationId: null }; };
  const before = { rows: f.rows(), holds: f.holds(), files: f.files() };
  // Observe both jobs before checking refusal, so a failure shows the capacity consequence.
  let result, error;
  try { result = await f.reserve(retry); } catch (cause) { error = cause; }
  const after = { rows: f.rows(), holds: f.holds(), files: f.files() };
  const next = await f.reserve(await f.admit(f.payload({ jobId: JOB2 })));
  assert.deepEqual({ retry: result?.state ?? null, code: error?.code, next: next.state, charges },
    { retry: null, code: 'context_job_closed', next: 'new', charges: 0 });
  assert.deepEqual(after, before);
  assert.equal(port.admissionCounts().contextRecords, 0);
  await assert.rejects(f.reserve(await f.admit(f.payload({ jobId: NEXT_JOB }))), { code: 'peer_job_capacity', status: 503 });
});


