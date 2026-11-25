// A host that stops at each cut of an effect route's attempt, and reopens over the same wire journal and transport store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readOnlyRoleOf } from './helpers/agent-signing.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SellerAgentError } from '../src/dacs/seller-agent.mjs';
import { createOperatorBuyerAccess } from '../src/devnet-demo/buyer-access.mjs';
import { BUYER, PATHS, SELLER, proposalFor, proposeJob, world } from './helpers/wire-routes-world.mjs';
import { wireBuyer } from './helpers/wire-buyer.mjs';
import { DELEGATION_MS, T0, nativePaymentWorld } from './helpers/native-payment-wire-fixture.mjs';
import { nativeTransfer } from './helpers/completed-source-cells.mjs';
import { BUNDLE_REFUSALS, SHORT_LEASE_MS, bundleWorld, claimedTransport, completions, editSession, markPaid, operationOf, proposalSigningRig, reconcileInput, realWorld, tempDirectory } from './helpers/route-recovery-world.mjs';
import { JOB, NOW, buyer, seller as sellerKey, testWallet } from './helpers/protocol-fixture.mjs';
import { FINALITY_COMMITMENT_SEPARATOR, sha256Hex } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_DOMAINS } from '@kynesyslabs/dacs/wire';
import { createSellerDurableState } from '../src/dacs/seller-durable-state.mjs';
import { provenUnsignedAbsence } from '../src/dacs/native-dem-delivery-consumer.mjs';
import { commitmentFixture } from './helpers/commitment-fixture.mjs';
import { agreementCreateProjection } from './helpers/agreement-create-projection.mjs';
import { EVIDENCE_SIGNATURE, fixturePaymentWorld, includedTransfer } from './helpers/wire-payment-fixture.mjs';

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

test('an ordinary replay restores the outcome file from its retained end record', async t => {
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
  assert.deepEqual(readdirSync(w.state.journals[0]).filter((name) => name.endsWith('.done')), outcomes, 'the replay published the outcome file again from the end record');
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
      const state = await createSellerDurableState({ dir: seller.f.dir, integritySigner: seller.f.config.signer, listingPin });
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

// ---- A worker that outlives its lease ----

const HOST_LEASE_MS = 300_000;
const ENDPOINT = 'https://seller.example.invalid';
const ATTEMPT_RECORD = /^o-([0-9a-f]+)-(\d+)(\.end)?$/;
const DONE_RECORD = /^o-[0-9a-f]+\.done$/;
const REFUSED = { status: 503, error: 'operation_uncertain', signed: true };

/** A pause the test arms for the next worker that calls `hold()`: `reached` settles when a worker is held, `release()` lets it go. */
function pausePoint(t) {
  const pause = { armed: false, release: () => {} };
  pause.arm = () => {
    pause.armed = true;
    pause.reached = new Promise((resolve) => { pause.reach = resolve; });
    const opened = new Promise((resolve) => { pause.release = resolve; });
    pause.hold = async () => {
      if (!pause.armed) return;
      pause.armed = false;
      pause.reach();
      await opened;
    };
  };
  pause.hold = async () => {};
  t.after(() => pause.release());
  return pause;
}

const refusalOf = (answer) => ({ status: answer.status, error: answer.body.error, signed: answer.signed });

/** What the wire journal holds for the operations created after `known` was taken: attempts, supersession records, and whether an outcome is published. */
function journalOf(w, known) {
  const directory = w.state.journals[0], names = readdirSync(directory).filter((name) => !known.has(name));
  const ends = names.filter((name) => ATTEMPT_RECORD.exec(name)?.[3] !== undefined).map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')));
  return { attempts: names.filter((name) => ATTEMPT_RECORD.exec(name)?.[3] === undefined && ATTEMPT_RECORD.test(name)).length,
    superseded: ends.filter((end) => end.superseded).length, outcomes: ends.filter((end) => end.outcome !== null).length, done: names.some((name) => DONE_RECORD.test(name)) };
}

/**
 * A worker of one effect route stopped inside its job at `cell.pause` as its lease runs out. Another request then supersedes it and is refused at the held job,
 * the stopped worker's late end is refused, and a later request completes the operation once.
 * A cell has `w` (the wire world), `pause`, `post()` (a fresh signed request for the operation), `prepare()` (what the recovering kind needs first), `sink()` (one
 * count per outside effect), `lapse()`, `reopen()`, `reservesBeforeRefusal` (whether the successor's reservation is recorded before it is refused),
 * and `kind`: `new` or `recover`.
 */
async function overrunScenario(cell) {
  const { w, pause, label } = cell, known = new Set(readdirSync(w.state.journals[0]));
  await cell.prepare();
  const before = cell.sink(), attemptsBefore = journalOf(w, known).attempts;
  pause.arm();
  const worker = cell.post();
  await Promise.race([pause.reached, worker.then((answer) => { throw new Error(`${label}: the worker finished without stopping: ${answer.text}`); })]);
  assert.equal(journalOf(w, known).attempts, attemptsBefore + 1, `${label}: the stopped worker holds its own attempt`);
  const held = journalOf(w, known);
  cell.lapse();
  const successor = await cell.post(), refused = journalOf(w, known);
  assert.deepEqual(refusalOf(successor), REFUSED, `${label}: the successor is refused inside the held job`);
  assert.deepEqual([refused.attempts, refused.superseded], cell.reservesBeforeRefusal ? [held.attempts + 1, held.superseded + 1] : [held.attempts, held.superseded],
    `${label}: the successor's reservation and the supersession of the stopped attempt`);
  assert.deepEqual(cell.sink(), before, `${label}: the refused successor caused no outside effect`);
  pause.release();
  const late = await worker, ended = journalOf(w, known);
  assert.deepEqual(refusalOf(late), REFUSED, `${label}: the stopped worker's late end is refused`);
  assert.deepEqual([ended.attempts, ended.outcomes, ended.done], [refused.attempts, 0, false], `${label}: the late end left no outcome and no new attempt`);
  assert.ok(cell.sink().every((count, index) => count <= Math.max(1, before[index])), `${label}: at most one outside effect in all`);
  cell.lapse();
  const completed = await cell.post(), final = journalOf(w, known);
  assert.equal(completed.status, 200, `${label}: a later request completes: ${completed.text}`);
  assert.deepEqual([final.outcomes, final.done], [1, true], `${label}: exactly one attempt ended with the published outcome`);
  assert.ok(cell.sink().every((count) => count === 1), `${label}: the work was done once`);
  const effects = cell.sink();
  assert.equal((await cell.post()).text, completed.text, `${label}: a repeat answers the stored bytes`);
  await cell.reopen();
  assert.equal((await cell.post()).text, completed.text, `${label}: a reopened seller answers the stored bytes`);
  assert.deepEqual(cell.sink(), effects, `${label}: repeats and the reopen added no effect`);
}

/** The fixture payment route: the worker stops at its awaited read of the transfer. */
async function paymentCell(t, kind) {
  const w = await fixturePaymentWorld(t), pause = pausePoint(t);
  w.script.observe = async (txHash) => { await pause.hold(); return includedTransfer(txHash); };
  return { w, pause, kind, label: `payments ${kind}`, reservesBeforeRefusal: true, post: () => w.pay(), lapse: () => w.lapse(), reopen: () => w.restart(),
    sink: () => [w.evidenceCreates(), w.deliverableWrites(), w.deliveryEvidenceWrites()],
    prepare: async () => {
      if (kind === 'new') return;
      // The seller saved the work and could not sign its evidence: the attempt stays open with retained work.
      w.script.signFault = EVIDENCE_SIGNATURE;
      assert.equal((await w.pay()).status, 503);
      w.lapse();
    } };
}

/**
 * A seller over the commitment fixture behind the wire handler, its Agreement proposed but not committed. An armed `pause` stops a worker at the awaited
 * commitment publisher; `faults.beforePublish` makes the next publish fail before anything is sent, and `sent` lists each CREATE the publisher sent.
 */
async function commitmentWire(t, { early, leaseMs }) {
  const f = await commitmentFixture(t, { early, publicEndpoint: ENDPOINT }), pause = pausePoint(t), sent = [], faults = { beforePublish: null };
  const { publish, readRetained } = f.native;
  f.native.publish = async (input) => {
    if (faults.beforePublish !== null) { const fault = faults.beforePublish; faults.beforePublish = null; throw fault; }
    await pause.hold();
    const out = await publish(input);
    sent.push(input.logicalAddress);
    return out;
  };
  f.native.readRetained = async (input, options) => {
    const read = await readRetained(input, options);
    return input.proofOfNoIntent && read.status === 'absent' ? provenUnsignedAbsence('TEST no signed CREATE is retained') : read;
  };
  const { agent: opened, request, agreement } = await f.prepare();
  let agent = opened;
  const w = await world(t, { fixture: { listing: f.listing, agent: () => agent }, leaseMs }), admitted = new Set();
  Object.assign(w.agent, {
    // The host holds a job from the proposal its wire route admitted, which is when the transport store keeps the job's tuple.
    transportAgreementOf: (id) => (admitted.has(id) ? agent.transportAgreementOf(id) : null),
    receiveProposal: (body, settings) => agent.receiveProposal(body, settings),
    agreementState: (identity) => agent.agreementState(identity),
    reconcileTransport: (input) => agent.reconcileTransport(input),
    retainsProposalWork: (id) => agent.retainsProposalWork(id),
    retainsUnfinishedWork: (target) => agent.retainsUnfinishedWork(target),
    retainsCommitmentWork: (id) => agent.retainsCommitmentWork(id),
    revalidateCompletedAnswer: (input) => agent.revalidateCompletedAnswer(input),
    commit: (body, settings) => agent.commit(body, settings),
    commitOnSignature: (body, settings) => agent.commitOnSignature(body, settings),
  });
  const jobId = agreement.jobId, agreementHash = request.transportIdentity.agreementHash;
  // The agent already signed the proposal, so its wire route replays that answer.
  const proposed = await w.post(PATHS.proposals, request, { jobId, agreementHash });
  assert.equal(proposed.status, 200, proposed.text);
  admitted.add(jobId);
  const path = early ? PATHS.commitmentSignature : PATHS.commitments;
  const body = early ? { jobId, agreement, signedProjection: agreementCreateProjection(agreement) } : { jobId };
  return { w, pause, sent, faults, post: () => w.post(path, body, { jobId, agreementHash }),
    reopen: async () => { w.reopen(); agent.close(); agent = await f.open(); } };
}

const commitmentCell = async (t, { early, kind }) => {
  const seller = await commitmentWire(t, { early, leaseMs: SHORT_LEASE_MS }), { w } = seller;
  return { w, pause: seller.pause, kind, label: `${early ? 'commitments/signature' : 'commitments'} ${kind}`, reservesBeforeRefusal: true, post: seller.post, reopen: seller.reopen,
    sink: () => [seller.sent.length], lapse: () => { w.state.time += SHORT_LEASE_MS; },
    prepare: async () => {
      if (kind === 'new') return;
      // The publisher failed before it sent anything: the attempt stays open with the publish-asked marker saved.
      seller.faults.beforePublish = new Error('TEST the publisher died before any intent');
      assert.equal((await seller.post()).status, 503);
      w.state.time += SHORT_LEASE_MS;
    } };
};

/**
 * The proposals route of a fresh job. The worker stops at the awaited read of the Vet record inside the agent's durable responder, before the Agreement is signed.
 * A new worker runs under the host's own lease and is overrun one millisecond past it.
 */
async function proposalCell(t, kind) {
  const f = await commitmentFixture(t, { early: false, publicEndpoint: ENDPOINT }), pause = pausePoint(t);
  const admission = f.config.sessionAdmission;
  f.config.sessionAdmission = { ...admission, resolveVetRecord: async (...args) => {
    await pause.hold();
    return admission.resolveVetRecord(...args);
  } };
  let agent = await f.open();
  const request = await f.proposal(agent), { jobId, agreementHash } = request.transportIdentity, agreementText = Buffer.from(request.proposal.plan.signedBytes).toString();
  const leaseMs = kind === 'new' ? HOST_LEASE_MS : SHORT_LEASE_MS, lapseMs = leaseMs + 1;
  const w = await world(t, { fixture: { listing: f.listing, agent: () => agent }, leaseMs });
  Object.assign(w.agent, {
    transportAgreementOf: (id) => agent.transportAgreementOf(id),
    receiveProposal: (body, settings) => agent.receiveProposal(body, settings),
    agreementState: (identity) => agent.agreementState(identity),
    reconcileTransport: (input) => agent.reconcileTransport(input),
    retainsProposalWork: (id) => agent.retainsProposalWork(id),
    retainsUnfinishedWork: (target) => agent.retainsUnfinishedWork(target),
    revalidateCompletedAnswer: (input) => agent.revalidateCompletedAnswer(input),
  });
  // The buyer's discovery proof lasts ten minutes, which two host leases outrun: each request is signed by a buyer that discovers the seller anew.
  const post = async () => {
    const buyerWire = await wireBuyer({ buyer: BUYER, seller: SELLER, listingPin: w.agent.listingPin, clock: w.clock, connection: () => ({ ...w.state.connection }), publicEndpoint: ENDPOINT });
    return w.send(PATHS.proposals, await buyerWire.signRequest(PATHS.proposals, request, { jobId, agreementHash }));
  };
  return { w, pause, kind, label: `proposals ${kind}`, reservesBeforeRefusal: kind === 'recover', post, lapse: () => { w.state.time += lapseMs; },
    sink: () => [f.signed.filter((text) => text === agreementText).length],
    reopen: async () => { w.reopen(); agent.close(); agent = await f.open(); },
    prepare: async () => {
      if (kind === 'new') return;
      // The Agreement was signed and its answer could not be signed: the attempt stays open with the proposal's work retained.
      w.signing.failures = 2;
      const cut = await post();
      assert.equal(cut.signed, false);
      w.state.time += lapseMs;
    } };
}

/**
 * A bundle world whose response signer stops the next armed worker inside the wire's settle, which still holds the job. `signer.failures` makes the next
 * responses unsignable and `signer.responses` counts the responses signed. `paid` marks the job's payment as made and delivered first.
 */
async function bundleOverrunWorld(t, { paid, retainedCountersignature = false }) {
  const w = await bundleWorld(t, { leaseMs: SHORT_LEASE_MS }), pause = pausePoint(t), signer = { failures: 0, responses: 0 };
  if (paid) await editSession(w.fixture, w.jobId, markPaid);
  if (retainedCountersignature) await editSession(w.fixture, w.jobId, (session) => { session.countersignatureWork = { buyerSignature: 'TEST-retained-countersignature' }; });
  const responseSigner = { claim: SELLER.claim, sign: (bytes) => {
    if (!Buffer.from(bytes).toString('utf8').startsWith(DACS_SELLER_HTTP_DOMAINS.response)) return SELLER.sign(bytes);
    if (signer.failures > 0) { signer.failures--; throw new Error('TEST signer failure'); }
    signer.responses++;
    return pause.armed ? pause.hold().then(() => SELLER.sign(bytes)) : SELLER.sign(bytes);
  } };
  w.handle.wireOverrides = { signer: { ...responseSigner, readOnlyAnswerSigner: readOnlyRoleOf(responseSigner) } };
  w.reopen();
  return { w, pause, signer, effects: () => [w.fixture.signed.length, w.fixture.publications.length, completions(w).length] };
}

test('a bundle worker that outlives its lease has its late end refused without causing an effect', async (t) => {
  const cells = BUNDLE_REFUSALS.flatMap(([path, paid, code, status]) => ['new', 'recover'].map((kind) => ({ path, paid, kind, refusal: { status, error: code }, retained: false })));
  cells.push(...['new', 'recover'].map((kind) => ({ path: PATHS.bundleCountersignature, paid: false, kind, refusal: { status: 503, error: 'operation_uncertain' }, retained: true })));
  for (const { path, paid, kind, refusal, retained } of cells) {
    const { w, pause, signer, effects } = await bundleOverrunWorld(t, { paid, retainedCountersignature: retained }), label = `${path} paid ${paid} retained ${retained} ${kind}`;
    const known = new Set(readdirSync(w.state.journals[0])), lapse = () => { w.state.time += SHORT_LEASE_MS; };
    if (kind === 'recover') {
      signer.failures = 2;
      assert.equal((await w.request(path)).signed, false, `${label}: the first answer could not be signed, so its attempt stays open`);
      lapse();
    }
    const effectsBefore = effects(), attemptsBefore = journalOf(w, known).attempts;
    pause.arm();
    const worker = w.request(path);
    await Promise.race([pause.reached, worker.then((answer) => { throw new Error(`${label}: the worker finished without stopping: ${answer.text}`); })]);
    const held = journalOf(w, known);
    assert.equal(held.attempts, attemptsBefore + 1, `${label}: the stopped worker holds its own attempt`);
    lapse();
    const successor = await w.request(path), refused = journalOf(w, known);
    assert.deepEqual(refusalOf(successor), REFUSED, `${label}: the successor is refused at the held job`);
    assert.deepEqual([refused.attempts, refused.superseded], [held.attempts + 1, held.superseded + 1], `${label}: the stopped attempt is recorded superseded and the successor's attempt is open`);
    pause.release();
    const late = await worker, ended = journalOf(w, known);
    assert.deepEqual(refusalOf(late), REFUSED, `${label}: the late end is refused`);
    assert.deepEqual([ended.attempts, ended.outcomes, ended.done], [refused.attempts, 0, false], `${label}: the late end left no outcome`);
    lapse();
    const answered = await w.request(path), view = operationOf(w, w.jobId, path);
    assert.deepEqual({ status: answered.status, error: answered.body.error }, refusal, `${label}: a later request answers the route's own refusal`);
    // A refusal that proves no work and no worker ends its attempt with no outcome; retained work leaves the attempt open.
    assert.equal(view.state, retained ? 'pending' : 'ended', `${label}: the attempt's end`);
    assert.equal(journalOf(w, known).done, false, `${label}: no bundle outcome was published`);
    for (const again of ['same process', 'after a restart']) {
      if (again === 'after a restart') w.reopen();
      const repeated = await w.request(path);
      // Retained work keeps its attempt open, and a live lease holds it: a repeat inside the lease is pending.
      assert.deepEqual({ status: repeated.status, error: repeated.body.error }, retained ? { status: 503, error: 'seller_effect_pending' } : refusal, `${label}: ${again}`);
    }
    assert.deepEqual(effects(), effectsBefore, `${label}: no signature, CREATE, receipt claim or delivery was added`);
    assert.ok(signer.responses > 0, `${label}: the seller's own responses were signed`);
  }
});

const MAX_EFFECT_ATTEMPTS = 16;
// Retained payment work without the last hold reason it records, which changes with each recovery.
const identityOf = (work) => Object.fromEntries(Object.entries(work).filter(([key]) => key !== 'anchorError'));

test('a retained payment that stays held through more lease lapses than the crash limit is never refused as unresolved and still completes', async (t) => {
  const w = await nativePaymentWorld(t), p = await w.purchase(), txHash = p.pay();
  // The seller saves the payment's work and its wallet fails before signing: the payment is held with the work retained.
  w.faults.walletSignature = 1;
  assert.equal((await p.send(txHash, { delegated: true })).body.status, 'held');
  const work = await w.work(p);
  assert.ok(work !== undefined, 'the payment work is retained');
  // From here the transfer is not found, so every recovery holds with the same work.
  const restoreTransfer = nativeTransfer(w, txHash, () => null);
  const untouched = () => [w.counts.walletSignatures, w.evidenceCreates(p), w.deliverableWrites(p), w.deliveryEvidenceWrites(p), w.grantedReceipts()];
  const effectsBefore = untouched();
  for (let recovery = 1; recovery <= MAX_EFFECT_ATTEMPTS + 4; recovery++) {
    const held = await p.send(txHash, { delegated: true }), view = w.wireState(p);
    assert.equal(held.body.status, 'held', `recovery ${recovery} holds`);
    assert.deepEqual([view.state, view.superseded], ['ended', 0], `recovery ${recovery} ends its attempt with no outcome and spends no crash attempt`);
  }
  assert.ok(w.clock() < T0 + DELEGATION_MS, 'every request was signed inside the six-hour delegation');
  assert.deepEqual(untouched(), effectsBefore, 'no signature, CREATE, receipt or delivery was added by the held recoveries');
  await w.restart();
  assert.deepEqual(identityOf(await w.work(p)), identityOf(work), 'the retained work is still readable and keeps its claim, evidence and CREATE address');
  restoreTransfer();
  const completed = await p.send(txHash, { delegated: true });
  assert.deepEqual([completed.body.status, completed.body.delivery.status], ['payment-evidenced', 'delivered']);
  assert.deepEqual([w.evidenceCreates(p), w.deliverableWrites(p), w.deliveryEvidenceWrites(p)], [1, 1, 1], 'the payment is delivered once');
});

test('a worker that overruns its lease cannot add a second effect and its operation completes once later', async (t) => {
  for (const kind of ['new', 'recover']) {
    await overrunScenario(await proposalCell(t, kind));
    await overrunScenario(await paymentCell(t, kind));
    for (const early of [false, true]) await overrunScenario(await commitmentCell(t, { early, kind }));
  }
});
