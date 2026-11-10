import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_PATHS } from '@kynesyslabs/dacs/wire';
import { world, request } from './helpers/wire-client-fixture.mjs';

test('wire authentication signs the kept job and purchase profile', async (t) => {
  const w = await world(t);
  const signed = await request(w);
  assert.equal(signed.payload.jobId, w.job.jobId);
  assert.deepEqual(signed.payload.profile, w.binding.profile);
  assert.deepEqual(w.state.signs, [Buffer.from(DACS_SELLER_HTTP_DOMAINS.request + canonicalize(signed.payload))]);
});

test('wire authentication refuses another job before signing', async (t) => {
  const w = await world(t);
  await assert.rejects(w.auth.request(DACS_SELLER_HTTP_PATHS.state, { jobId: 'other-job' }, '{"jobId":"other-job"}'), { code: 'peer_job_mismatch' });
  assert.equal(w.state.signs.length, 0);
});
