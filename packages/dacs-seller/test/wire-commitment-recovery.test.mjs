// An open commitment attempt recovered over the wire by the real agent, which reads the retained commitment back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PATHS, operationOf } from './helpers/wire-routes-world.mjs';
import { SHORT_LEASE_MS, realWorld } from './helpers/route-recovery-world.mjs';

for (const early of [false, true]) {
  test(`an open ${early ? 'signature' : 'ordinary'} commitment attempt is held while the fresh receipt no longer authenticates, writes nothing, and completes once it does`, async (t) => {
    const w = await realWorld(t, { early, leaseMs: SHORT_LEASE_MS });
    assert.equal((await w.request(PATHS.proposals)).status, 200, 'the host admits the job through its proposal');
    w.agent.transportAgreementOf = (jobId) => w.fixture.agent().transportAgreementOf(jobId);
    // The answer cannot be signed, so the attempt stays open.
    w.signing.failures = 2;
    assert.equal((await w.commitmentRequest()).status, 503);
    assert.equal(operationOf(w, w.jobId, w.commitmentPath).state, 'pending');
    w.state.time += w.leaseMs;
    const writes = w.fixture.publications.length, [row] = [...w.fixture.rows.values()], receipt = row.receipt;
    row.receipt = { ...receipt, contentHash: '0'.repeat(64) };
    const held = await w.commitmentRequest();
    assert.deepEqual({ status: held.status, signed: held.signed }, { status: 503, signed: true });
    assert.equal(operationOf(w, w.jobId, w.commitmentPath).state, 'pending', 'the attempt is still open');
    assert.equal(w.fixture.publications.length, writes, 'nothing is written');
    row.receipt = receipt;
    w.state.time += w.leaseMs;
    assert.equal((await w.commitmentRequest()).status, 200, 'the recovery completes once the receipt authenticates');
    assert.equal(w.fixture.publications.length, writes, 'the completed recovery writes nothing either');
  });
}
