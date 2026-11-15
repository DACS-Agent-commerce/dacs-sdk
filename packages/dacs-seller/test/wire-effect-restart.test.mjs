// A host that stops at each cut of an effect route's attempt, and reopens over the same wire journal and transport store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SellerAgentError } from '../src/dacs/seller-agent.mjs';
import { createOperatorBuyerAccess } from '../src/devnet-demo/buyer-access.mjs';
import { PATHS, proposalFor, proposeJob, world } from './helpers/wire-routes-world.mjs';
import { BUNDLE_REFUSALS, SHORT_LEASE_MS, bundleWorld, claimedTransport, completions, editSession, markPaid, operationOf, proposalSigningRig, reconcileInput, realWorld, tempDirectory } from './helpers/route-recovery-world.mjs';
import { JOB, NOW, buyer, seller as sellerKey, testWallet } from './helpers/protocol-fixture.mjs';
import { FINALITY_COMMITMENT_SEPARATOR, sha256Hex } from '@kynesyslabs/dacs';
import { createSellerDurableState } from '../src/dacs/seller-durable-state.mjs';
import { provenUnsignedAbsence } from '../src/dacs/native-dem-delivery-consumer.mjs';
import { commitmentFixture } from './helpers/commitment-fixture.mjs';
import { agreementCreateProjection } from './helpers/agreement-create-projection.mjs';

// The durable responder's worker lease, which a killed worker leaves behind (60 s, with a margin).
const RESPONDER_LEASE_MS = 61_000;
const SIGNATURE_CUT_CHILD = new URL('./helpers/proposal-signature-cut-child.mjs', import.meta.url);

// The work is done and its answer computed, but the answer cannot be signed: nothing was completed.
const cutAfterWork = async (w, job) => {
  w.signing.failures = 2;
  const cut = await job.post();
  assert.equal(cut.status, 503);
  assert.equal(cut.signed, false);
};

test('a cut between the agent\'s durable write and completion (host reopened over the same journal): after the lease the next request recovers, reconciles the write and completes once', async t => {
  const w = await world(t), job = await proposeJob(w, 'cut-after-write');
  await cutAfterWork(w, job);
  assert.equal(w.agent.calls.proposals, 1, 'the agent wrote');
  w.reopen();
  assert.equal((await job.post()).body.error, 'seller_effect_pending', 'a live lease holds the operation across the restart');
  w.state.time += w.leaseMs;
  const recovered = await job.post();
  assert.equal(recovered.status, 200);
  assert.deepEqual({ proposals: w.agent.calls.proposals, reconciled: w.agent.calls.reconciled }, { proposals: 1, reconciled: 1 }, 'the write was reconciled, never run again');
  w.reopen();
  assert.equal((await job.post()).text, recovered.text, 'completed once: the stored outcome answers after another restart');
  assert.equal(w.agent.calls.reconciled, 1);
});

test('a null end whose reply was lost keeps its binding across a restart, and the same binding recovers at once', async t => {
  const w = await world(t), job = await proposeJob(w, 'null-lost-reply');
  w.agent.answer = () => { throw new SellerAgentError('peer_job_capacity', 'TEST no work was done', 503); };
  const refused = await job.post();
  assert.equal(refused.body.error, 'peer_job_capacity', 'the proof of no effect ended the attempt with null');
  // The reply is lost: the buyer never read it, and the host restarts.
  w.reopen();
  // The host's retained Agreement changed: a request under it is another binding of the same operation.
  const other = await proposalFor(job.jobId, NOW + 1000), original = w.agent.transportAgreementOf;
  w.agent.transportAgreementOf = () => structuredClone(other.body.proposal.plan.draft);
  const rebound = await w.post(PATHS.proposals, other.body, { jobId: job.jobId, agreementHash: other.agreementHash });
  assert.deepEqual({ status: rebound.status, error: rebound.body.error }, { status: 409, error: 'peer_job_conflict' }, 'the operation kept its binding');
  w.agent.transportAgreementOf = original;
  w.agent.answer = undefined;
  const reconciledBefore = w.agent.calls.reconciled;
  assert.equal((await job.post()).status, 200, 'the same binding recovers at once, with no lease to wait for');
  assert.equal(w.agent.calls.reconciled, reconciledBefore + 1);
});

test('a host cut between the end record and the outcome file answers the exact stored bytes after a restart, with no agent run', async t => {
  const w = await world(t), job = await proposeJob(w, 'end-only');
  const first = await job.post();
  assert.equal(first.status, 200);
  const outcomes = readdirSync(w.state.journals[0]).filter((name) => name.endsWith('.done'));
  assert.equal(outcomes.length, 1, 'the journal publishes the outcome as a file of its own');
  // The host died between publishing the end record and the outcome file.
  rmSync(join(w.state.journals[0], outcomes[0]));
  w.reopen();
  const calls = w.effects();
  const replayed = await job.post();
  assert.equal(replayed.text, first.text, 'the end record alone completes the operation with the exact stored bytes');
  assert.equal(w.effects(), calls, 'no agent ran');
});

test('a completed answer that cannot be signed keeps its stored outcome across a restart, never a refusal or a null end', async t => {
  const w = await world(t), job = await proposeJob(w, 'signing-failure');
  const first = await job.post();
  assert.equal(first.status, 200);
  const files = w.journalFiles().length;
  w.signing.failures = 2;
  assert.equal((await job.post()).status, 503, 'the stored answer cannot be signed now');
  w.reopen();
  const again = await job.post();
  assert.equal(again.text, first.text, 'the failure after completion substituted neither a refusal nor a null end');
  assert.equal(w.journalFiles().length, files + 2, 'only the two repeats\' nonce keys were added');
  assert.equal(w.agent.calls.proposals, 1);
});

test('K5-R3 SIGKILL between the seller signature record and completion on proposals: recover finds the contribution and signs nothing more', async (t) => {
  const { directory, data } = tempDirectory(t), log = join(directory, 'signatures.log');
  writeFileSync(log, '');
  const child = spawn(process.execPath, [SIGNATURE_CUT_CHILD.pathname, data, JOB, log], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  assert.deepEqual(await once(child, 'exit'), [null, 'SIGKILL'], 'the child died at the cut');
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1, 'the child made its one signature');
  const { agent, body, signatures } = await proposalSigningRig(data);
  t.after(() => agent.close());
  assert.equal(agent.retainsProposalWork(JOB), true, 'the retained signature work keeps the attempt open');
  const recover = () => agent.reconcileTransport({ ...reconcileInput(agent, body), transport: claimedTransport });
  assert.equal((await recover()).value.disposition, 'waiting', 'the killed worker still holds the responder inside its lease');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + RESPONDER_LEASE_MS });
  const recovered = await recover();
  assert.deepEqual([recovered.disposition, recovered.value.disposition], ['present', 'complete'], 'recovery completes the proposal after the lease');
  assert.deepEqual(signatures, [], 'the restarted seller signed nothing more');
});

test('NEW-D1a-signature-before-contribution', async (t) => {
  const { data } = tempDirectory(t), { agent, body, signatures } = await proposalSigningRig(data);
  t.after(() => agent.close());
  let cut = true;
  const transport = { path: PATHS.proposals, settle() {}, check() { if (cut && signatures.length > 0) throw new Error('TEST cut after the signature record'); } };
  await assert.rejects(agent.receiveProposal(body, { transport }), /TEST cut/);
  const kept = agent.durableSessionOf(JOB);
  assert.deepEqual([typeof kept.agreementSignatureKey, kept.sellerContribution], ['string', undefined], 'the signature record is kept, the contribution is not');
  cut = false;
  assert.equal((await agent.receiveProposal(body)).disposition, 'complete');
  const done = agent.durableSessionOf(JOB);
  assert.deepEqual([done.agreementSignatureKey, done.agreementSignatureProposalHash], [kept.agreementSignatureKey, body.proposal.proposalHash], 'the same key and proposal resumed');
  assert.equal(signatures.length, 1, 'one signature in all');
});

test('bundles/request and bundles/countersignature: a restart after the wire reservation, then two retries with fresh nonces, each answer the exact named refusal with a clean null end', async (t) => {
  for (const [path, paid, code, status] of BUNDLE_REFUSALS) {
    const w = await bundleWorld(t, { leaseMs: SHORT_LEASE_MS }), cell = `${path} paid ${paid}`;
    if (paid) await editSession(w.fixture, w.jobId, markPaid);
    const signed = w.fixture.signed.length, writes = w.fixture.publications.length;
    w.signing.failures = 2;
    assert.equal((await w.request(path)).signed, false, `${cell}: the refusal could not be signed, so the reservation is the only record`);
    w.reopen();
    w.state.time += SHORT_LEASE_MS;
    for (const retry of [1, 2]) {
      const answered = await w.request(path), view = operationOf(w, w.jobId, path);
      assert.deepEqual({ status: answered.status, error: answered.body.error }, { status, error: code }, `${cell}: retry ${retry}`);
      assert.deepEqual({ state: view.state, superseded: view.superseded }, { state: 'ended', superseded: 1 }, `${cell}: retry ${retry} ended null and spent no more crash attempts`);
    }
    assert.deepEqual(completions(w).filter((row) => row.route === path), [], `${cell}: no completed bundle claim`);
    assert.deepEqual([w.fixture.signed.length, w.fixture.publications.length], [signed, writes], `${cell}: nothing was signed or sent`);
  }
  const control = await bundleWorld(t, { leaseMs: SHORT_LEASE_MS });
  await editSession(control.fixture, control.jobId, (session) => { session.countersignatureWork = { buyerSignature: 'TEST-retained-countersignature' }; });
  control.signing.failures = 2;
  await control.request(PATHS.bundleCountersignature);
  control.reopen();
  control.state.time += SHORT_LEASE_MS;
  assert.equal((await control.request(PATHS.bundleCountersignature)).body.error, 'operation_uncertain', 'retained work answers uncertain');
  assert.equal(operationOf(control, control.jobId, PATHS.bundleCountersignature).state, 'pending', 'retained work keeps the attempt open after the restart');
});

test('NEW-D1a-buyer-access-restart', async (t) => {
  const w = await realWorld(t), first = await w.request(PATHS.proposals), openAccess = w.fixture.config.buyerAccess;
  assert.equal(first.status, 200);
  const signed = w.fixture.signed.length, writes = w.fixture.publications.length;
  w.fixture.config.buyerAccess = createOperatorBuyerAccess({ openBuyerAccess: false, custodyBuyer: testWallet(9).claim });
  for (const restart of [1, 2]) {
    w.reopen();
    await w.fixture.reopen();
    const refused = await w.request(PATHS.proposals);
    assert.deepEqual({ status: refused.status, error: refused.body.error, signed: refused.signed }, { status: 409, error: 'buyer_access_closed', signed: true }, `restart ${restart}`);
    assert.equal(operationOf(w, w.jobId, PATHS.proposals).state, 'completed', `restart ${restart}: the outcome stays completed`);
  }
  assert.deepEqual([w.calls.receive, w.fixture.signed.length, w.fixture.publications.length], [1, signed, writes], 'the proposal never ran, signed or published again');
  w.fixture.config.buyerAccess = openAccess;
  w.reopen();
  await w.fixture.reopen();
  assert.equal((await w.request(PATHS.proposals)).text, first.text, 'open access again replays the exact stored bytes');
});

const COMMITMENT_ROUTES = [['commitments', false], ['commitments/signature', true]];
const answerOf = (early) => (early ? 'commitment-held' : 'committed');

/**
 * A seller over the commitment fixture and its durable directory. `abortAt(cut)` makes the next commitment attempt stop at that point
 * and restarts the agent over the same files, as a killed process leaves them. Cuts: `before-reservation` (the early route's wire
 * reservation exists, its buyer slot and attempt marker do not), `after-attempt-marker` (the marker is saved, no CREATE intent exists) and
 * `after-create` (the CREATE is on the source, the session holds no commitment). The source's reader proves nothing was signed for an
 * absent address, as the native reader does with no intent in either signed journal. `sent` logs each CREATE sent, `signatures()`
 * counts the seller's signatures and `beforePublish` may fail or observe a send. `recover()` runs the agent's recovery of the request.
 */
async function commitmentSeller(t, { early }) {
  const f = await commitmentFixture(t, { early });
  const cut = { name: null }, sent = [], { publish, readRetained } = f.native;
  const killed = () => new Error('TEST the process was killed');
  const seller = { f, sent, early, signatures: () => f.signed.filter((text) => text.startsWith(FINALITY_COMMITMENT_SEPARATOR)).length, beforePublish: async () => {} };
  f.native.publish = async (input) => {
    await seller.beforePublish(input);
    const out = await publish(input);
    sent.push(input.logicalAddress);
    if (cut.name === 'after-create') throw killed();
    return out;
  };
  f.native.readRetained = async (input, options) => {
    if (cut.name === 'after-attempt-marker') throw killed();
    const read = await readRetained(input, options);
    return input.proofOfNoIntent && read.status === 'absent' ? provenUnsignedAbsence('TEST no signed CREATE is retained') : read;
  };
  f.config.signatureCommitmentReady = async () => { if (cut.name === 'before-reservation') throw killed(); };
  const prepared = await f.prepare();
  seller.agent = prepared.agent;
  seller.body = early ? { jobId: JOB, agreement: prepared.agreement, signedProjection: agreementCreateProjection(prepared.agreement) } : { jobId: JOB };
  seller.commit = () => (early ? seller.agent.commitOnSignature(seller.body) : seller.agent.commit(seller.body));
  seller.recover = () => {
    const rawBody = Buffer.from(JSON.stringify(seller.body));
    const request = { method: 'POST', path: early ? PATHS.commitmentSignature : PATHS.commitments, jobId: JOB, buyer: buyer.claim, seller: sellerKey.claim,
      listingPin: seller.agent.listingPin, agreementHash: seller.agent.durableSessionOf(JOB).agreementHash, bodyHash: sha256Hex(rawBody) };
    return seller.agent.reconcileTransport({ request, body: seller.body, rawBody, transport: claimedTransport });
  };
  /** The agent restarted over the same files, with the clock moved on. */
  seller.restart = async (advanceMs = 0) => {
    seller.agent.close();
    f.advance(advanceMs);
    seller.agent = await f.open();
  };
  seller.fails = async () => assert.rejects(seller.commit());
  seller.abortAt = async (name) => {
    cut.name = name;
    await seller.fails();
    cut.name = null;
    await seller.restart();
  };
  return seller;
}

test('K5-R3 SIGKILL between the commitment CREATE and completion, on commitments and on commitments/signature: recover reads it back finalized and publishes nothing more', async (t) => {
  for (const [route, early] of COMMITMENT_ROUTES) {
    const seller = await commitmentSeller(t, { early });
    await seller.abortAt('after-create');
    assert.equal(seller.sent.length, 1, `${route}: one CREATE was sent before the cut`);
    assert.equal(seller.agent.retainsCommitmentWork(JOB), true, `${route}: the retained work keeps the attempt open`);
    assert.equal(seller.agent.durableSessionOf(JOB).commitment ?? null, null, `${route}: the session holds no commitment yet`);
    const signatures = seller.signatures(), recovered = await seller.recover();
    assert.deepEqual([recovered.disposition, recovered.value.status], ['present', answerOf(early)], `${route}: the CREATE is read back finalized`);
    assert.deepEqual([seller.sent.length, seller.signatures()], [1, signatures], `${route}: nothing more was published or signed`);
    await seller.restart();
    assert.equal((await seller.recover()).value.status, answerOf(early), `${route}: a second restart answers the same`);
    assert.equal(seller.sent.length, 1, `${route}: still the one CREATE`);
  }
});

test('commitments recover resumes only the exact retained CREATE under its replay and supersession policy', async (t) => {
  const asked = async () => {
    const seller = await commitmentSeller(t, { early: false });
    seller.beforePublish = async () => { throw new Error('TEST the publisher died before any intent'); };
    await seller.fails();
    seller.beforePublish = async () => {};
    assert.equal(seller.agent.retainsCommitmentWork(JOB), true);
    return seller;
  };
  // A request asked of the publisher with no proof that nothing was signed is read back only.
  const unproven = await asked(), { readRetained } = unproven.f.native;
  unproven.f.native.readRetained = async (input, options) => { const read = await readRetained(input, options); return read.status === 'absent' ? { status: 'absent', reason: 'TEST no proof' } : read; };
  assert.equal((await unproven.recover()).disposition, 'indeterminate');
  assert.deepEqual(unproven.sent, [], 'an absent read with no proof sends nothing');
  // With the proof, the original operation runs once and resumes the same CREATE.
  const proven = await asked(), recovered = await proven.recover();
  assert.deepEqual([recovered.disposition, recovered.value.status, proven.sent.length], ['present', 'committed', 1]);
  assert.equal((await proven.recover()).value.status, 'committed');
  assert.equal(proven.sent.length, 1, 'a repeated recovery sends no second CREATE');
  // An unknown dispatch (a signed CREATE retained, its readback indeterminate) is never sent again.
  const unknown = await asked();
  unknown.f.native.readRetained = async () => ({ status: 'indeterminate', reason: 'TEST signed CREATE retained, readback unknown' });
  const signatures = unknown.signatures();
  assert.equal((await unknown.recover()).disposition, 'indeterminate');
  assert.deepEqual([unknown.sent, unknown.signatures()], [[], signatures], 'nothing is sent or signed over an unknown dispatch');
});

test('commitments/signature cut after the wire reservation, before the early-attempt marker: recover proves no intent and no worker, runs the original early commitment once and completes', async (t) => {
  for (const afterSlot of [false, true]) {
    const seller = await commitmentSeller(t, { early: true });
    await seller.abortAt('before-reservation');
    if (afterSlot) {
      // The buyer's slot was reserved durably before the cut: the same retained state with its slot and no marker.
      const { listingPin } = seller.agent;
      seller.agent.close();
      const state = await createSellerDurableState({ dir: seller.f.dir, signer: seller.f.config.signer, listingPin });
      await state.withJob(JOB, () => state.reserveSignatureCommitment(buyer.claim, JOB));
      state.close();
      await seller.restart();
    }
    assert.equal(seller.agent.durableSessionOf(JOB).signatureCommitmentAttempt, undefined, 'no attempt marker was saved');
    const recovered = await seller.recover();
    assert.deepEqual([recovered.disposition, recovered.value.status, seller.sent.length], ['present', 'commitment-held', 1], `slot reserved before the cut ${afterSlot}: the original operation ran once`);
    await seller.restart();
    assert.equal((await seller.recover()).value.status, 'commitment-held', 'a second restart answers the stored outcome');
    assert.equal(seller.sent.length, 1, 'still one CREATE');
  }
});

test('commitments/signature cut after the early-attempt marker, before any CREATE intent: the marker alone is not proof of transmission; recover proves no intent and runs the original operation once', async (t) => {
  const seller = await commitmentSeller(t, { early: true });
  await seller.abortAt('after-attempt-marker');
  assert.deepEqual([seller.sent, seller.agent.durableSessionOf(JOB).signatureCommitmentAttempt], [[], true], 'the attempt marker was saved, no CREATE was sent');
  const recovered = await seller.recover();
  assert.deepEqual([recovered.disposition, recovered.value.status, seller.sent.length], ['present', 'commitment-held', 1], 'it is not held readback-only');
  assert.equal((await seller.recover()).value.status, 'commitment-held');
  assert.equal(seller.sent.length, 1, 'one CREATE in all');
});

test('commitments/signature cut after a durable unsent CREATE is retained: recover uses only the exact-byte replay policy; an unknown dispatch stays readback-only and open', async (t) => {
  const seller = await commitmentSeller(t, { early: true });
  await seller.abortAt('after-attempt-marker');
  // A signed CREATE is retained for the address but its readback is unknown.
  seller.f.native.readRetained = async () => ({ status: 'indeterminate', reason: 'TEST signed CREATE retained, readback unknown' });
  const signatures = seller.signatures();
  for (const repeat of [1, 2]) {
    const held = await seller.recover();
    assert.deepEqual([held.disposition, held.status, held.value.error], ['indeterminate', 503, 'operation_uncertain'], `repeat ${repeat}: held`);
  }
  assert.deepEqual([seller.sent, seller.signatures()], [[], signatures], 'no transmission and no second commitment signature');
  assert.equal(seller.agent.retainsCommitmentWork(JOB), true, 'the attempt stays open');
});

const LEASE_MS = 61_000;

test('commitments and commitments/signature × publisher state {a pre-intent read fails after the publish-asked marker is saved, wallet captured without signing} × retry {same process, after a restart with both clocks advanced past the lease}', async (t) => {
  for (const [route, early] of COMMITMENT_ROUTES) for (const state of ['pre-intent read fails', 'wallet captured without signing', 'unknown dispatch']) for (const retry of ['same process', 'after a restart']) {
    const cell = `${route} × ${state} × ${retry}`, seller = await commitmentSeller(t, { early }), wallet = { requests: 0 };
    seller.beforePublish = async () => {
      if (state !== 'pre-intent read fails') wallet.requests++;
      throw new Error(state === 'pre-intent read fails' ? 'TEST the nonce read failed before any intent' : 'TEST the wallet answered capture-without-signing');
    };
    await seller.fails();
    seller.beforePublish = async () => { wallet.requests++; };
    assert.equal(seller.agent.durableSessionOf(JOB).commitmentPublishAsked, true, `${cell}: the publish-asked marker was saved`);
    assert.equal(wallet.requests, state === 'pre-intent read fails' ? 0 : 1, `${cell}: wallet requests before the retry`);
    if (state === 'unknown dispatch') seller.f.native.readRetained = async () => ({ status: 'indeterminate', reason: 'TEST signed CREATE retained, readback unknown' });
    if (retry === 'after a restart') await seller.restart(LEASE_MS);
    const signatures = seller.signatures(), retried = await seller.recover();
    if (state === 'unknown dispatch') {
      assert.deepEqual([retried.disposition, seller.sent.length, seller.signatures()], ['indeterminate', 0, signatures], `${cell}: held, nothing sent or signed`);
      continue;
    }
    assert.deepEqual([retried.disposition, retried.value.status, seller.sent.length], ['present', answerOf(early), 1], `${cell}: the original operation ran once and completed`);
    assert.equal((await seller.recover()).value.status, answerOf(early), `${cell}: a repeated retry answers the stored outcome`);
    assert.equal(seller.sent.length, 1, `${cell}: one CREATE in all`);
  }
});
