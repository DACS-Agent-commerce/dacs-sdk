// A node can include a seller write after the transport's own inclusion wait has
// ended. publish({awaitInclusion}) keeps reading that write back, and never sends
// it again; the plan step's Vet record writes use it, and readBackRecords reads a
// job's retained Vet records back with nothing signed or sent. Loopback fixtures
// only: the clock moves only when the anchor waits between readbacks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalityCommitmentAddress } from '@kynesyslabs/dacs';
import { anchorFixture, signSdkCreate } from './helpers/anchor-isolated-fixture.mjs';
import { orchestratorFixture, assertPresent, blocked, address, BUYER, SELLER, OTHER, JOB } from './helpers/vet-orchestrator-fixture.mjs';
import { fixture as counterpartyFixture } from './helpers/bilateral-vet-fixture.mjs';

const T0 = 1800000000000, JOB_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const READBACK_BOUND_MS = 30 * 60_000;
// The orchestrator fixture's anchor clock does not move, so its waits are counted
// instead: a readback that never stops fails the test rather than hanging it.
const countedSleep = (onSleep = () => {}) => { let count = 0; return async () => { if (++count > 100) throw new Error('TEST the readback did not stop'); onSleep(count); }; };

// One CREATE the wallet signs and the node accepts; its readback answers pending
// for the first `pendingReads` reads, then included. The one recovery check a
// pending first read makes is answered "not sent", so its slot stays unused.
async function issuedWorld({ pendingReads = Infinity, onSleep = () => {} } = {}) {
  let clock = T0;
  const sleeps = [], reads = [], recoveries = [];
  const w = await anchorFixture({ signRpc: async () => 'TEST rpc authentication', now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; onSleep(sleeps.length); } });
  w.source.observeBinding = async () => {};
  w.source.binding = async ({ hash }) => { reads.push(hash); return { disposition: reads.length > pendingReads ? 'included' : 'pending' }; };
  w.source.recoverStorageWrite = async ({ signedTransaction }) => { recoveries.push(signedTransaction.hash); return { resent: false }; };
  w.controls.reader.read = async (logicalAddress) => {
    const row = [...w.journal.rows.values()].find((r) => r.input?.logicalAddress === logicalAddress);
    return { status: 'present', artifact: row.input.artifact, receipt: { contentHash: row.input.receiptContentHash, transactionRef: { value: 'a'.repeat(64) } }, demosEvidence: {} };
  };
  w.controls.reader.verifyReceipt = async () => 'valid';
  w.controls.request = async (request) => {
    const signed = await signSdkCreate(request.transaction);
    await w.journal.put('demo/wallet/lane', { stage: 'broadcast-accepted', hash: signed.hash, signedTransaction: signed });
    await w.sourceJournal.put(`source/${signed.hash}`, { stage: 'signed', hash: signed.hash, signedTransaction: signed });
    return { success: true, data: { hash: signed.hash } };
  };
  const publish = async (authorize = async () => true) => w.open().publish({ logicalAddress: finalityCommitmentAddress(JOB_ID), artifact: await w.artifact(JOB_ID),
    artifactKind: 'FinalityCommitmentRecord', authorize, awaitInclusion: true });
  const stage = () => [...w.journal.rows.values()].find((row) => row.input?.logicalAddress === finalityCommitmentAddress(JOB_ID))?.stage;
  return { ...w, sleeps, reads, recoveries, publish, stage, elapsed: () => clock - T0 };
}

test('publish keeps reading back a CREATE it sent until the node includes it, and sends it once', async () => {
  const w = await issuedWorld({ pendingReads: 3 });
  const out = await w.publish();
  assert.equal(out.status, 'present', JSON.stringify(out));
  assert.equal(w.stage(), 'verified');
  assert.equal(w.captured.length, 1, 'one wallet request');
  assert.deepEqual(w.recoveries.length, 1, 'only the first readback\'s existing recovery check');
  assert.equal(w.reads.length, 4);
  assert.equal(w.sleeps.length, 2);
});

test('a CREATE still pending past the readback bound ends indeterminate and is never sent again', async () => {
  const w = await issuedWorld();
  const out = await w.publish();
  assert.equal(out.status, 'indeterminate');
  assert.match(out.reason, /no authenticated inclusion readback \(pending/);
  assert.equal(w.elapsed(), READBACK_BOUND_MS);
  assert.ok(w.reads.length > 2, 'read again after the first readback');
  assert.equal(w.captured.length, 1, 'one wallet request');
  assert.equal(w.recoveries.length, 1, 'no recovery send from the later readbacks');
  assert.equal(w.stage(), 'issued');
});

test('publish stops reading back a pending CREATE once its purchase closes', async () => {
  let open = true;
  const w = await issuedWorld({ onSleep: (count) => { if (count === 3) open = false; } });
  const out = await w.publish(async () => { if (!open) throw Object.assign(new Error('TEST purchase closed'), { code: 'not-pending' }); return true; });
  assert.equal(out.status, 'indeterminate');
  assert.equal(w.sleeps.length, 3, 'no wait after the purchase closed');
  assert.equal(w.reads.length, 4, 'no readback after the purchase closed');
  assert.equal(w.captured.length, 1);
  assert.equal(w.recoveries.length, 1);
});

test('a plan step whose Vet records are included after the transport\'s wait still answers present, sending each record once', async (t) => {
  const f = await orchestratorFixture(t, { real: true, sleep: countedSleep() });
  const reads = new Map();
  f.native.source.binding = async ({ hash }) => { const count = (reads.get(hash) ?? 0) + 1; reads.set(hash, count); return { disposition: count > 2 ? 'included' : 'pending' }; };
  assertPresent(await f.run());
  assert.deepEqual(f.native.captured.map((request) => request.logicalAddress).sort(), [address(BUYER), address(SELLER)].sort());
});

test('the counterparty plan step asks the anchor to keep reading back each Vet record it sends', async () => {
  const f = counterpartyFixture(), asked = [], publish = f.anchor.publish;
  f.anchor.publish = async (request) => { asked.push(request); return publish(request); };
  assert.equal((await f.provider().resolveBuyer(f.input())).disposition, 'present');
  assert.equal(asked.length, 2);
  for (const request of asked) assert.equal(request.awaitInclusion, true, request.logicalAddress);
});

test('readBackRecords reads a retained Vet record back with nothing signed or sent, and the next plan request completes from it', async (t) => {
  let included = false, open = true;
  const f = await orchestratorFixture(t, { real: true, signRpc: async () => 'TEST rpc authentication', sleep: countedSleep(() => { open = false; }) });
  const recoveries = [];
  f.native.source.binding = async () => ({ disposition: included ? 'included' : 'pending' });
  f.native.source.recoverStorageWrite = async ({ signedTransaction }) => { recoveries.push(signedTransaction.hash); return { resent: false }; };
  const p = f.provider();
  await blocked(() => p.resolveBuyer(f.input, { writable: () => open || 'TEST purchase closed' }));
  assert.deepEqual(f.native.captured.map((request) => request.logicalAddress), [address(SELLER)]);
  const signatures = f.controls.signatures.length, recoveryChecks = recoveries.length;
  assert.equal((await p.readBackRecords({ jobId: JOB, buyer: BUYER.claim })).disposition, 'indeterminate');
  included = true;
  const sellerOnly = await p.readBackRecords({ jobId: JOB, buyer: BUYER.claim });
  assert.equal(sellerOnly.disposition, 'indeterminate', 'the buyer record is not written yet');
  assert.equal(f.native.captured.length, 1, 'nothing was sent');
  assert.equal(recoveries.length, recoveryChecks, 'no recovery send');
  assert.equal(f.controls.signatures.length, signatures, 'nothing was signed');
  await assert.rejects(p.readBackRecords({ jobId: JOB, buyer: OTHER.claim }), { code: 'buyer_access_closed' });
  assertPresent(await p.resolveBuyer(f.input, { writable: () => true }));
  assert.deepEqual(f.native.captured.map((request) => request.logicalAddress), [address(SELLER), address(BUYER)], 'the seller record was not sent again');
  assert.equal((await p.readBackRecords({ jobId: JOB, buyer: BUYER.claim })).disposition, 'present', 'both records read back');
});

test('a restart between the two Vet record readbacks leaves both retained records unchanged, and the next readback answers as an uninterrupted one', async (t) => {
  const f = await orchestratorFixture(t, { real: true, disk: true, signRpc: async () => 'TEST rpc authentication' });
  const recoveries = [];
  f.native.source.recoverStorageWrite = async ({ signedTransaction }) => { recoveries.push(signedTransaction.hash); return { resent: false }; };
  assertPresent(await f.run());
  const retained = async () => structuredClone({ chain: [...f.records], party: await f.row(), anchor: [...f.native.journal.rows], source: [...f.native.sourceJournal.rows] });
  const uninterrupted = await f.provider().readBackRecords({ jobId: JOB, buyer: BUYER.claim });
  assert.equal(uninterrupted.disposition, 'present');
  const before = await retained(), signatures = f.controls.signatures.length, requests = f.native.captured.length;

  const readBefore = [];
  f.controls.onRead = (logicalAddress) => {
    readBefore.push(logicalAddress);
    if (logicalAddress === address(SELLER)) throw new Error('TEST process stopped before the second readback');
  };
  await assert.rejects(f.provider().readBackRecords({ jobId: JOB, buyer: BUYER.claim }), /TEST process stopped/);
  f.controls.onRead = undefined;
  assert.ok(readBefore.includes(address(BUYER)), 'the first record was read back before the stop');
  assert.deepEqual(await retained(), before, 'the stop changed no retained record');

  const afterRestart = await f.fresh().readBackRecords({ jobId: JOB, buyer: BUYER.claim });
  assert.deepEqual(afterRestart, uninterrupted);
  assert.deepEqual(await retained(), before, 'the next readback changed no retained record');
  assert.equal(f.controls.signatures.length, signatures, 'nothing was signed');
  assert.equal(f.native.captured.length, requests, 'no wallet request');
  assert.deepEqual(recoveries, [], 'nothing was sent again');
});

test('readBackRecords answers indeterminate, not present, when a retained record gives no readback answer', async (t) => {
  const f = await orchestratorFixture(t);
  assertPresent(await f.run());
  assert.equal((await f.provider().readBackRecords({ jobId: JOB, buyer: BUYER.claim })).disposition, 'present');
  const silent = f.provider({ anchor: { ...f.openAnchor(), readRetained: async () => undefined } });
  const out = await silent.readBackRecords({ jobId: JOB, buyer: BUYER.claim });
  assert.equal(out.disposition, 'indeterminate', JSON.stringify(out));
});
