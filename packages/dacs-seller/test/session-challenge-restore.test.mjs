import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { canonicalize, identityBundleHash, sha256Hex } from '@kynesyslabs/dacs';
import { createSellerDurableState, SELLER_STATE_SIGNING_DOMAIN } from '../src/dacs/seller-durable-state.mjs';
import { createSellerTransportStore } from '../src/dacs/seller-transport-auth.mjs';
import { listingPin } from '../src/dacs/purchase-protocol.mjs';
import { proposalAdmissionFixture } from './helpers/proposal-admission-fixture.mjs';
import { JOB, buyer } from './helpers/protocol-fixture.mjs';

const HOUR = 3_600_000;
const JOB2 = JOB.slice(0, -1) + 'B';
const staged = error => error.code === 'proposal_not_assembled';
function database(path, action) {
  const db = new Database(path);
  try { return action(db); } finally { db.close(); }
}
const count = (f, table) => database(f.storePath, db => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);

async function acceptedFixture(t, { legacy = false, save = true, vetted = false } = {}) {
  const f = await proposalAdmissionFixture(t, { assembled: vetted }), agent = await f.open();
  const input = vetted ? await f.proposal(agent) : await f.input(agent);
  if (vetted) assert.equal((await agent.receiveProposal(input)).disposition, 'complete');
  else await assert.rejects(agent.stagedProposal(input), staged);
  agent.close();
  const nonce = input.buyerIdentityBundle.sessionNonce;
  const challenge = f.store.challenges.retained(nonce);
  const state = await createSellerDurableState({ dir: f.dir, signer: f.config.signer, listingPin: listingPin(f.listing) });
  if (save && !vetted) await state.withJob(JOB, () => state.saveSession({ jobId: JOB, buyerBundle: input.buyerIdentityBundle,
    buyerBundleHash: identityBundleHash(input.buyerIdentityBundle), stage: 'proposed' }));
  state.close();
  const legacyBody = { kind: 'session-challenge', jobId: JOB, buyer: buyer.claim, sessionNonce: nonce,
    issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt, attempt: { presentationHash: challenge.presentationHash,
      admitted: true, accepted: { buyerBundle: input.buyerIdentityBundle, buyerBundleHash: challenge.accepted.buyerBundleHash,
        admission: challenge.accepted.admission, admittedAt: challenge.accepted.admittedAt } } };
  const writeLegacy = body => database(join(f.dir, 'seller-state.sqlite'), db => {
    const id = `session-challenge:${nonce}`;
    const payload = { version: '1', kind: 'effect', id, seller: f.config.signer.claim, listingPin: listingPin(f.listing), body };
    const signature = f.config.signer.sign(Buffer.from(SELLER_STATE_SIGNING_DOMAIN + canonicalize(payload))).toString('base64url');
    db.prepare('INSERT OR REPLACE INTO seller_effects VALUES (?, ?)').run(id, JSON.stringify({ payload, signature }));
  });
  if (legacy) {
    writeLegacy(legacyBody);
    database(f.storePath, db => {
      db.exec('DELETE FROM kit_challenges; DELETE FROM kit_job_bindings');
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'kit_accepted_challenges'").get()) db.exec('DELETE FROM kit_accepted_challenges');
    });
  }
  return { ...f, get store() { return f.store; }, f, nonce, input, challenge, legacyBody, writeLegacy };
}

test('legacy accepted challenges restore existing sessions after upgrade', async t => {
  const w = await acceptedFixture(t, { legacy: true });
  const fresh = await w.open();
  assert.equal(fresh.stageOf(JOB), 'proposed');
  assert.equal(w.store.challenges.retained(w.nonce).state, 'accepted');
  assert.equal(w.store.challenges.jobBinding(JOB).nonce, w.nonce);
  await assert.rejects(fresh.stagedProposal(w.input), staged);
  assert.equal(w.admission.calls.filter(([name]) => name === 'admit').length, 1);
  assert.equal(w.signed.filter(text => text.startsWith('dacs-agreement:')).length, 0);
});

function reclaim(t, w, { fail = false } = {}) {
  w.f.advance(HOUR + 1);
  const store = createSellerTransportStore({ path: w.storePath, now: w.config.now, maxChallenges: 1,
    contextSessionState: ({ jobId }) => jobId === JOB ? 'vet-failed' : null });
  t.after(() => store.close());
  if (fail) database(w.storePath, db => db.exec("CREATE TRIGGER TEST_cut BEFORE INSERT ON kit_challenges BEGIN SELECT RAISE(ABORT, 'TEST reclaim cut'); END"));
  const issue = () => store.challenges.issueForOperator({ jobId: JOB2, buyer: buyer.claim });
  if (fail) assert.throws(issue, /TEST reclaim cut/); else issue();
  store.close();
}

test('reclaiming an accepted challenge preserves native session restoration', async t => {
  const w = await acceptedFixture(t);
  reclaim(t, w);
  assert.equal(w.store.challenges.retained(w.nonce), null);
  w.f.reopenStore();
  const fresh = await w.open();
  assert.equal(fresh.stageOf(JOB), 'proposed');
  assert.equal(count(w, 'kit_challenges'), 1);
  assert.equal(w.store.challenges.attempt({ nonce: w.nonce, path: 'proposal', jobId: JOB, buyer: buyer.claim,
    presentationHash: w.challenge.presentationHash }).code, 'context_challenge_mismatch');
  assert.equal(w.admission.calls.filter(([name]) => name === 'admit').length, 1);
});

test('legacy import rolls back challenge proof and binding on a failed write', async t => {
  const w = await acceptedFixture(t, { legacy: true });
  database(w.storePath, db => db.exec("CREATE TRIGGER TEST_cut BEFORE INSERT ON kit_job_bindings BEGIN SELECT RAISE(ABORT, 'TEST import cut'); END"));
  await assert.rejects(w.open(), /TEST import cut/);
  assert.equal(count(w, 'kit_challenges'), 0);
  assert.equal(count(w, 'kit_job_bindings'), 0);
  assert.equal(count(w, 'kit_accepted_challenges'), 0);
  database(w.storePath, db => db.exec('DROP TRIGGER TEST_cut'));
  w.f.reopenStore();
  assert.equal((await w.open()).stageOf(JOB), 'proposed');
});

test('legacy import survives a restart after commit without another admission', async t => {
  const w = await acceptedFixture(t, { legacy: true, save: false });
  const first = await w.open(); first.close();
  assert.equal(count(w, 'kit_challenges'), 1);
  const kept = w.store.challenges.retained(w.nonce);
  w.f.reopenStore();
  const fresh = await w.open();
  await assert.rejects(fresh.stagedProposal(w.input), staged);
  assert.deepEqual(w.store.challenges.retained(w.nonce), kept);
  assert.equal(w.admission.calls.filter(([name]) => name === 'admit').length, 1);
});

test('legacy import does not resurrect a reclaimed challenge', async t => {
  const w = await acceptedFixture(t, { legacy: true });
  (await w.open()).close();
  reclaim(t, w); w.f.reopenStore();
  assert.equal((await w.open()).stageOf(JOB), 'proposed');
  assert.equal(w.store.challenges.retained(w.nonce), null);
  assert.equal(count(w, 'kit_challenges'), 1);
});

test('legacy import refuses conflicting bindings without overwriting them', async t => {
  const w = await acceptedFixture(t, { legacy: true });
  database(w.storePath, db => db.prepare('INSERT INTO kit_job_bindings VALUES (?, ?, ?, ?, ?, ?)').run(
    JOB, w.nonce, buyer.claim, w.challenge.presentationHash, sha256Hex('TEST conflicting bundle'), w.challenge.accepted.admittedAt));
  const before = w.store.challenges.jobBinding(JOB);
  await assert.rejects(w.open(), error => error.code === 'seller_job_bound');
  assert.deepEqual(w.store.challenges.jobBinding(JOB), before);
  assert.equal(count(w, 'kit_challenges'), 0);
});

test('unsigned legacy challenge changes refuse startup', async t => {
  const w = await acceptedFixture(t, { legacy: true });
  database(join(w.dir, 'seller-state.sqlite'), db => db.prepare("UPDATE seller_effects SET value = json_set(value, '$.payload.body.attempt.presentationHash', 'changed') WHERE id = ?").run(`session-challenge:${w.nonce}`));
  await assert.rejects(w.open(), error => error.code === 'seller_state_corrupt');
  assert.equal(count(w, 'kit_challenges'), 0);
});

test('unaccepted legacy challenges never authorize restoration', async t => {
  const w = await acceptedFixture(t, { legacy: true });
  w.writeLegacy({ ...w.legacyBody, attempt: { presentationHash: w.challenge.presentationHash } });
  await assert.rejects(w.open(), error => error.code === 'seller_state_unverified');
  assert.equal(count(w, 'kit_challenges'), 0);
});

test('accepted proof rolls back with a failed job binding', async t => {
  const f = await proposalAdmissionFixture(t), agent = await f.open(), input = await f.input(agent);
  database(f.storePath, db => db.exec("CREATE TRIGGER TEST_cut BEFORE INSERT ON kit_job_bindings BEGIN SELECT RAISE(ABORT, 'TEST accept cut'); END"));
  await assert.rejects(agent.stagedProposal(input), /TEST accept cut/);
  assert.equal(count(f, 'kit_accepted_challenges'), 0);
  assert.equal(count(f, 'kit_job_bindings'), 0);
  assert.equal(f.store.challenges.retained(input.buyerIdentityBundle.sessionNonce).state, 'failed');
});

test('proof backfill retries after a failed transaction', async t => {
  const w = await acceptedFixture(t);
  database(w.storePath, db => {
    db.exec("DELETE FROM kit_accepted_challenges; CREATE TRIGGER TEST_cut BEFORE INSERT ON kit_accepted_challenges BEGIN SELECT RAISE(ABORT, 'TEST backfill cut'); END");
  });
  const open = () => createSellerTransportStore({ path: w.storePath, now: w.config.now });
  assert.throws(open, /TEST backfill cut/);
  assert.equal(count(w, 'kit_accepted_challenges'), 0);
  database(w.storePath, db => db.exec('DROP TRIGGER TEST_cut'));
  open().close();
  reclaim(t, w); w.f.reopenStore();
  assert.equal((await w.open()).stageOf(JOB), 'proposed');
});

test('failed reclamation leaves the accepted proof restorable', async t => {
  const w = await acceptedFixture(t);
  reclaim(t, w, { fail: true }); w.f.reopenStore();
  assert.equal(w.store.challenges.retained(w.nonce).state, 'accepted');
  assert.equal((await w.open()).stageOf(JOB), 'proposed');
  assert.equal(count(w, 'kit_challenges'), 1);
});

test('archived challenges still require retained Vet evidence', async t => {
  const w = await acceptedFixture(t);
  reclaim(t, w);
  const state = await createSellerDurableState({ dir: w.dir, signer: w.config.signer, listingPin: listingPin(w.listing) });
  await state.withJob(JOB, session => { session.stage = 'agreed'; state.saveSession(session); }); state.close();
  await assert.rejects(w.open(), error => error.code === 'seller_state_unverified' && /Vet/.test(error.message));
});

test('a completed native proposal restores after its accepted challenge is reclaimed', async t => {
  const w = await acceptedFixture(t, { vetted: true });
  reclaim(t, w); w.f.reopenStore();
  const reads = w.admission.calls.filter(([name]) => name === 'resolveVetRecord').length;
  const signatures = w.signed.filter(text => text.startsWith('dacs-agreement:')).length;
  const fresh = await w.open();
  assert.deepEqual(fresh.durableSessions()[0].buyerBundle, w.input.buyerIdentityBundle);
  assert.equal(w.admission.calls.filter(([name]) => name === 'resolveVetRecord').length, reads + 2);
  assert.equal(w.signed.filter(text => text.startsWith('dacs-agreement:')).length, signatures);
});

test('legacy post-Vet sessions without an admission wrapper still verify their exact Vet records', async t => {
  const w = await acceptedFixture(t, { legacy: true, vetted: true });
  const body = structuredClone(w.legacyBody); delete body.attempt.accepted;
  w.writeLegacy(body);
  assert.deepEqual((await w.open()).durableSessions()[0].buyerBundle, w.input.buyerIdentityBundle);
});

test('archived accepted proof cannot replace unavailable Vet source evidence', async t => {
  const w = await acceptedFixture(t, { vetted: true });
  reclaim(t, w);
  const cause = Object.assign(new Error('TEST Vet source unavailable'), { code: 'ETIMEDOUT' });
  w.admission.sessionAdmission.resolveVetRecord = async () => { throw cause; };
  await assert.rejects(w.open(), error => error.code === 'seller_state_unverified' && error.cause === cause);
});

test('a signed legacy acceptance for different presentation bytes is refused', async t => {
  const w = await acceptedFixture(t, { legacy: true });
  const body = structuredClone(w.legacyBody); body.attempt.accepted.buyerBundle.extra = 'TEST changed presentation';
  w.writeLegacy(body);
  await assert.rejects(w.open(), error => error.code === 'context_challenge_attempt_invalid');
  assert.equal(count(w, 'kit_challenges'), 0);
});

test('legacy admission records with missing required fields refuse migration', async t => {
  const w = await acceptedFixture(t, { legacy: true });
  for (const field of ['admittedAt', 'buyerBundleHash', 'admission', 'buyerBundle']) {
    const body = structuredClone(w.legacyBody); delete body.attempt.accepted[field];
    w.writeLegacy(body);
    await assert.rejects(w.open(), error => error.code === 'context_challenge_attempt_invalid', field);
    assert.equal(count(w, 'kit_challenges'), 0);
  }
});

const counts = w => ({ active: count(w, 'kit_challenges'), proofs: count(w, 'kit_accepted_challenges'), bindings: count(w, 'kit_job_bindings') });

test('a legacy admission with no wrapper, session or bundle hash neither stops startup nor authorizes anything', async t => {
  const w = await acceptedFixture(t, { legacy: true, save: false });
  const body = structuredClone(w.legacyBody); delete body.attempt.accepted;
  w.writeLegacy(body);
  for (let start = 0; start < 2; start++) {
    const fresh = await w.open();
    assert.deepEqual(counts(w), { active: 0, proofs: 0, bindings: 0 });
    assert.equal(w.store.challenges.retainedForSession(w.nonce), null);
    await assert.rejects(fresh.stagedProposal(w.input), /not a challenge this seller issued/);
    fresh.close(); w.f.reopenStore();
  }
  assert.equal(w.admission.calls.filter(([name]) => name === 'admit').length, 1);
});

test('a retired legacy admission keeps its proof and job binding without taking active challenge capacity', async t => {
  const w = await acceptedFixture(t, { legacy: true, save: false });
  const body = structuredClone(w.legacyBody); body.attempt.retired = true;
  w.writeLegacy(body);
  for (let start = 0; start < 2; start++) {
    const fresh = await w.open();
    assert.deepEqual(counts(w), { active: 0, proofs: 1, bindings: 1 });
    assert.equal(w.store.challenges.retained(w.nonce), null);
    assert.equal(w.store.challenges.retainedForSession(w.nonce).accepted.buyerBundleHash, w.challenge.accepted.buyerBundleHash);
    assert.equal(w.store.challenges.jobBinding(JOB).nonce, w.nonce);
    await assert.rejects(fresh.stagedProposal(w.input), /not a challenge this seller issued/);
    fresh.close(); w.f.reopenStore();
  }
  assert.equal(w.admission.calls.filter(([name]) => name === 'admit').length, 1);
});

test('a retired legacy admission whose session was saved still restores it from the retained proof', async t => {
  const w = await acceptedFixture(t, { legacy: true });
  const body = structuredClone(w.legacyBody); body.attempt.retired = true;
  w.writeLegacy(body);
  assert.equal((await w.open()).stageOf(JOB), 'proposed');
  assert.deepEqual(counts(w), { active: 0, proofs: 1, bindings: 1 });
});
