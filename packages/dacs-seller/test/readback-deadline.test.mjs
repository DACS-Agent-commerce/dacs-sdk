// Readback of an anchored commitment is bounded in time and size, and a
// read-only replay (an expired delegation) signs and saves nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import * as core from '@kynesyslabs/dacs';
import { agentFixture } from './helpers/seller-agent-isolated-fixture.mjs';
import { commitmentFixture } from './helpers/commitment-fixture.mjs';
import { JOBS } from './helpers/bilateral-vet-fixture.mjs';
import { JOB } from './helpers/protocol-fixture.mjs';
import { provenUnsignedAbsence } from '../src/dacs/native-dem-delivery-consumer.mjs';

const READ_DEADLINE_MS = 10_000, OVERSIZED_REPLY_CHARS = 70 * 1024, TX_HASH = 'a'.repeat(64);
const never = () => new Promise(() => {});
const oversized = row => (row.status === 'present' ? { ...row, artifact: { ...row.artifact, padding: 'x'.repeat(OVERSIZED_REPLY_CHARS) } } : row);
const command = (w, jobId, path, body) => {
  const rawBody = Buffer.from(JSON.stringify(body));
  return { body, rawBody, request: { method: 'POST', path, jobId, buyer: w.buyer.claim, seller: w.seller.claim, listingPin: w.pin, agreementHash: w.agent.durableSessionOf(jobId).agreementHash, bodyHash: core.sha256Hex(rawBody) } };
};
const payment = w => ({ jobId: JOBS[0], txHash: TX_HASH, payerPayingKey: w.buyer.claim });
const replay = (w, path = '/dacs/v1/payments', body = payment(w)) => w.agent.reconcileTransport({ ...command(w, JOBS[0], path, body), readOnly: true });
const deliveredFixture = async () => {
  const w = await agentFixture({ lifecycle: true });
  await w.agent.commit({ jobId: JOBS[0] });
  assert.equal((await w.agent.submitPayment(payment(w))).status, 'delivered');
  return w;
};
// Starts the replay, lets it reach its reader, then expires the local deadline.
async function expireDeadline(t, start) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = start();
  await setImmediate();
  t.mock.timers.tick(READ_DEADLINE_MS);
  return pending;
}

for (const [reply, causeCode, hang] of [['never answers', 'timeout', never], ['is larger than the reply limit', 'reply-limit', null]]) {
  test(`read-only replay of a delivered fixture payment is indeterminate when the commitment reader ${reply}`, async t => {
    const w = await deliveredFixture();
    try {
      const address = core.finalityCommitmentAddress(JOBS[0]), writes = w.anchors.writes.length;
      // The journal's own bounded readback of this address answers first; the commitment reader asks second.
      let asked = 0;
      w.anchors.controls.read = (row, at) => (at === address && ++asked > 1 ? (hang ? hang() : oversized(row)) : row);
      const out = await (hang ? expireDeadline(t, () => replay(w)) : replay(w));
      assert.equal(out.disposition, 'indeterminate', JSON.stringify(out));
      assert.equal(out.causeCode, causeCode);
      assert.equal(w.anchors.writes.length, writes);
      // The job fence is released: the next replay of the job runs and succeeds.
      w.anchors.controls.read = row => row;
      assert.equal((await replay(w)).disposition, 'present');
    } finally { w.close(); }
  });
}

test('commitment route: a fixture commitment reader that never answers is indeterminate with its timeout cause', async t => {
  const w = await deliveredFixture();
  try {
    const address = core.finalityCommitmentAddress(JOBS[0]);
    let asked = 0;
    w.anchors.controls.read = (row, at) => (at === address && ++asked > 1 ? never() : row);
    const out = await expireDeadline(t, () => replay(w, '/dacs/v1/commitments', { jobId: JOBS[0] }));
    assert.deepEqual([out.disposition, out.causeCode], ['indeterminate', 'timeout']);
  } finally { w.close(); }
});

const nativeCommitmentRequest = (agent) => {
  const session = agent.durableSessionOf(JOB), body = { jobId: JOB }, rawBody = Buffer.from(JSON.stringify(body));
  return { body, rawBody, request: { method: 'POST', path: '/dacs/v1/commitments', jobId: JOB, buyer: session.buyerBundle.presentedBy, seller: agent.claim, listingPin: agent.listingPin, agreementHash: session.agreementHash, bodyHash: core.sha256Hex(rawBody) } };
};
for (const [reply, causeCode, answer] of [['never answers', 'timeout', never], ['is larger than the reply limit', 'reply-limit', async (read, input) => oversized(await read(input))]]) {
  test(`read-only native commitment readback is indeterminate when the retained-artifact reader ${reply}`, async t => {
    const f = await commitmentFixture(t), { agent } = await f.prepare(), read = f.native.readRetained;
    assert.equal((await agent.commit({ jobId: JOB })).status, 'committed');
    f.native.readRetained = input => answer(read, input);
    const writes = f.local.writes.length, start = () => agent.reconcileTransport({ ...nativeCommitmentRequest(agent), readOnly: true });
    const out = await (causeCode === 'timeout' ? expireDeadline(t, start) : start());
    assert.deepEqual([out.disposition, out.causeCode], ['indeterminate', causeCode]);
    assert.equal(f.local.writes.length, writes);
    f.native.readRetained = read;
    assert.equal((await start()).disposition, 'present', 'the job fence is released');
  });
}

test('a retry decision whose proof-of-no-intent read never answers stays indeterminate and publishes nothing', async t => {
  const f = await commitmentFixture(t), { agent } = await f.prepare(), read = f.native.readRetained;
  let reads = 0;
  f.native.readRetained = input => (++reads === 1 ? read(input) : never());
  const out = await expireDeadline(t, () => agent.reconcileTransport(nativeCommitmentRequest(agent)));
  assert.deepEqual([out.disposition, reads, f.local.writes.length], ['indeterminate', 2, 0]);
});

test('bounding a retained read keeps the proof that nothing was signed, so a live retry still publishes once', async t => {
  const f = await commitmentFixture(t), { agent } = await f.prepare(), read = f.native.readRetained;
  f.native.readRetained = async input => { const out = await read(input); return out.status === 'absent' ? provenUnsignedAbsence('TEST no seller-signed intent') : out; };
  const out = await agent.reconcileTransport(nativeCommitmentRequest(agent));
  assert.deepEqual([out.disposition, out.value?.status, f.local.writes.length], ['present', 'committed', 1]);
});

test('read-only replay of a delivered fixture payment signs nothing and saves nothing', async () => {
  const w = await deliveredFixture();
  try {
    const sign = w.config.signer.sign;
    let signs = 0;
    w.config.signer = { ...w.config.signer, sign: bytes => { signs++; return sign(bytes); } };
    await w.reopen();
    const before = JSON.stringify(w.store.loadSession(JOBS[0])), writes = w.anchors.writes.length;
    const out = await replay(w);
    assert.equal(out.disposition, 'present', JSON.stringify(out));
    assert.deepEqual([signs, w.anchors.writes.length, JSON.stringify(w.store.loadSession(JOBS[0]))], [0, writes, before]);
  } finally { w.close(); }
});

test('read-only commitment replay of a retained fixture commitment signs nothing and saves nothing', async () => {
  const w = await deliveredFixture();
  try {
    const sign = w.config.signer.sign;
    let signs = 0;
    w.config.signer = { ...w.config.signer, sign: bytes => { signs++; return sign(bytes); } };
    await w.reopen();
    const before = JSON.stringify(w.store.loadSession(JOBS[0]));
    const out = await replay(w, '/dacs/v1/commitments', { jobId: JOBS[0] });
    assert.equal(out.disposition, 'present', JSON.stringify(out));
    assert.deepEqual([signs, JSON.stringify(w.store.loadSession(JOBS[0]))], [0, before]);
  } finally { w.close(); }
});

test('read-only commitment replay holds instead of adopting a commitment that was never saved', async () => {
  const w = await agentFixture({ lifecycle: true });
  try {
    await w.agent.commit({ jobId: JOBS[0] });
    const session = w.store.loadSession(JOBS[0]);
    delete session.commitment;
    await w.store.withJob(JOBS[0], () => w.store.saveSession(session));
    await w.reopen();
    const before = JSON.stringify(w.store.loadSession(JOBS[0]));
    const out = await replay(w, '/dacs/v1/commitments', { jobId: JOBS[0] });
    assert.equal(out.disposition, 'indeterminate');
    assert.equal(JSON.stringify(w.store.loadSession(JOBS[0])), before);
  } finally { w.close(); }
});
