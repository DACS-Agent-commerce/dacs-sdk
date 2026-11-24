// The agent's effect signatures with the real durable seller store and the production effect boundary: each is made once
// inside a boundary sign pass with the key's effect role, its completion survives a restart, and the store signs only its
// own journal records with the integrity role.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@kynesyslabs/dacs';
import { agentFixture, fixtureProposal } from './helpers/seller-agent-isolated-fixture.mjs';
import { countedKeyRoles } from './helpers/counted-key-roles.mjs';
import { JOBS } from './helpers/bilateral-vet-fixture.mjs';
import { seller as sellerKey, NOW } from './helpers/protocol-fixture.mjs';
import { fixtureListing } from './fixtures/listings.mjs';
import { localAnchor } from './helpers/local-anchor-fixture.mjs';
import { testEffectBoundary } from './helpers/agent-signing.mjs';
import { anchorWriteMessage } from '../src/dacs/fixture-anchors.mjs';
import { createEffectHistory } from '../src/dacs/effect-history.mjs';
import { SELLER_STATE_SIGNING_DOMAIN } from '../src/dacs/seller-durable-state.mjs';
import { createSellerAgent } from '../src/dacs/seller-agent.mjs';

const AGREEMENT_PREFIX = 'dacs-payee-bound-agreement:v1:';
const ANCHOR_PREFIX = anchorWriteMessage('', '').slice(0, -1);
const PAYMENT_TX = 'a'.repeat(64);
// The durable responder's worker lease, which a killed worker leaves behind (60 s, with a margin).
const RESPONDER_LEASE_MS = 61_000;
const CUT_CHILD = new URL('./helpers/sign-once-cut-child.mjs', import.meta.url);

const kindOf = (bytes) => {
  const text = bytes.toString('utf8');
  if (text.startsWith(AGREEMENT_PREFIX)) return 'agreement';
  if (text.startsWith(ANCHOR_PREFIX)) return 'anchor-write';
  if (text.startsWith(core.ARTIFACT_SEPARATORS.SettlementEvidence)) return 'settlement-evidence';
  return 'commitment';
};
const signedRecords = (directory) => {
  const history = createEffectHistory({ dataDirectory: directory });
  return Promise.all(JOBS.map((jobId) => history.read(`job-${jobId}`))).then((lanes) => lanes.flat().filter((record) => record.state === 'signed'));
};

test('with the real durable seller store, the production effect boundary and distinct signing roles, fresh Agreement, commitment, settlement-evidence and anchor-authorization signatures made through the agent\'s shared sign helper each succeed once under the approved binding; each completion survives restart and a repeat returns the retained signature with no new cryptographic signer call; integrity signatures are counted apart, never enter the boundary, and the integrity role refuses every effect domain with no cryptographic call', async (t) => {
  const roles = await countedKeyRoles(t);
  const w = await agentFixture({ roles });
  t.after(() => w.close());
  const jobId = JOBS[0], payment = { jobId, txHash: PAYMENT_TX, payerPayingKey: w.buyer.claim };
  assert.equal((await w.agent.commit({ jobId })).status, 'committed');
  assert.equal((await w.agent.submitPayment(payment)).status, 'delivered');
  assert.deepEqual([...new Set(roles.effectBytes.map(kindOf))].sort(), ['agreement', 'anchor-write', 'commitment', 'settlement-evidence']);
  assert.equal(roles.effectBytes.filter((bytes) => kindOf(bytes) === 'agreement').length, JOBS.length, 'one Agreement signature per negotiated job');
  const hashes = roles.effectBytes.map((bytes) => core.sha256Hex(bytes));
  assert.equal(new Set(hashes).size, hashes.length, 'no exact bytes were signed twice');
  assert.equal(roles.counts.effect, hashes.length, 'one cryptographic call per effect signature');
  for (const hash of hashes) assert.equal(w.store.signature(`signature:${hash}`).disposition, 'present', 'the completion is in the durable store');
  const signed = await signedRecords(w.effectsDirectory);
  assert.deepEqual(signed.map((record) => record.operationId).sort(), hashes.map((hash) => `signature-${hash}`).sort(), 'each signature is one signed record of its job\'s lane, and nothing else entered the boundary');
  assert.ok(roles.counts.integrity > 0, 'the store authenticated its journal with the integrity role');

  await w.reopen();
  const effectsAtRestart = roles.counts.effect;
  for (const hash of hashes) assert.equal(w.store.signature(`signature:${hash}`).disposition, 'present', 'the completion survives the restart');
  const { body } = await fixtureProposal(w.listing, JOBS[1]);
  assert.equal((await w.agent.receiveProposal(body)).disposition, 'complete');
  assert.equal((await w.agent.commit({ jobId })).status, 'committed');
  assert.equal((await w.agent.submitPayment(payment)).status, 'delivered');
  assert.equal(roles.counts.effect, effectsAtRestart, 'the repeats made no cryptographic effect signature');
  assert.equal((await signedRecords(w.effectsDirectory)).length, signed.length, 'the repeats added no signed record');

  const integrityBefore = roles.counts.integrity;
  for (const kind of ['agreement', 'anchor-write', 'commitment', 'settlement-evidence']) {
    assert.throws(() => roles.integritySigner.sign(roles.effectBytes.find((bytes) => kindOf(bytes) === kind)), { code: 'seller_key_role_refused' }, kind);
  }
  assert.equal(roles.counts.integrity, integrityBefore, 'the refusals made no cryptographic call');
});

// A seller over the directory a killed child used, with stand-in roles that log every Agreement signature and every
// integrity call over bytes outside the journal domain.
async function restartedSeller(t, directory, jobId) {
  const listing = fixtureListing(sellerKey, { now: NOW }), { body } = await fixtureProposal(listing, jobId);
  const agreementBytes = Buffer.from(body.proposal.plan.signedBytes).toString(), journal = Buffer.from(SELLER_STATE_SIGNING_DOMAIN);
  const calls = { agreementSignatures: 0, integrityOutsideJournal: 0 };
  const effectSigner = { claim: sellerKey.claim, sign: (bytes) => { if (Buffer.from(bytes).toString() === agreementBytes) calls.agreementSignatures++; return sellerKey.signBytes(bytes); } };
  const integritySigner = { claim: sellerKey.claim, sign: (bytes) => { if (!Buffer.from(bytes).subarray(0, journal.length).equals(journal)) calls.integrityOutsideJournal++; return sellerKey.signBytes(bytes); } };
  const open = async () => {
    const agent = await createSellerAgent({ effectSigner, integritySigner, effectBoundary: testEffectBoundary({ dataDirectory: `${directory}-effects` }).effectBoundary,
      listing, anchors: localAnchor({ now: () => NOW + 2000 }), durableDirectory: directory, now: () => NOW + 2000, simulatedFixture: true });
    t.after(() => agent.close());
    return agent;
  };
  return { body, calls, open, agreementBytes };
}

async function killedAt(t, cut, jobId) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-sign-once-cut-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const directory = join(parent, 'seller'), progress = join(parent, 'progress.log');
  writeFileSync(progress, '');
  const child = spawn(process.execPath, [CUT_CHILD.pathname, directory, jobId, cut, progress], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  assert.deepEqual(await once(child, 'exit'), [null, 'SIGKILL'], 'the child died at the cut');
  return { directory, progress: readFileSync(progress, 'utf8').trim().split('\n') };
}

test('a process killed between signOnce\'s intent and the signing call releases no signature; a new owned pass completes the same bytes without the integrity signer', async (t) => {
  const jobId = JOBS[0], { directory, progress } = await killedAt(t, 'before-signature', jobId);
  assert.deepEqual(progress, ['signing'], 'the child reached its signer and made no signature');
  const seller = await restartedSeller(t, directory, jobId);
  assert.deepEqual(await signedRecords(`${directory}-effects`), [], 'the boundary kept no signature');
  const agent = await seller.open();
  assert.equal(agent.durableSessionOf(jobId)?.sellerContribution, undefined, 'no contribution was published');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + RESPONDER_LEASE_MS });
  assert.equal((await agent.receiveProposal(seller.body)).disposition, 'complete');
  assert.deepEqual(seller.calls, { agreementSignatures: 1, integrityOutsideJournal: 0 }, 'the new pass signed the same bytes once with the effect role');
  assert.equal((await signedRecords(`${directory}-effects`)).length, 1, 'one signed record');
});

test('a process killed between the signature and its completion record lets no signature out; a committed completion survives restart and repeats return it with no cryptographic call', async (t) => {
  const jobId = JOBS[0], { directory, progress } = await killedAt(t, 'after-signature', jobId);
  assert.deepEqual(progress, ['signing', 'signed'], 'the child signed and died before its completion record');
  const seller = await restartedSeller(t, directory, jobId);
  assert.deepEqual(await signedRecords(`${directory}-effects`), [], 'the boundary kept no signature');
  const agent = await seller.open();
  assert.equal(agent.durableSessionOf(jobId)?.sellerContribution, undefined, 'no contribution was published');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + RESPONDER_LEASE_MS });
  const first = await agent.receiveProposal(seller.body);
  assert.equal(first.disposition, 'complete');
  assert.equal(seller.calls.agreementSignatures, 1, 'the retained intent was signed again under a new pass');
  agent.close();
  const reopened = await seller.open(), again = await reopened.receiveProposal(seller.body);
  assert.deepEqual(again.contribution, first.contribution, 'the repeat returns the retained signature');
  assert.deepEqual(seller.calls, { agreementSignatures: 1, integrityOutsideJournal: 0 }, 'the repeat made no cryptographic call');
});
