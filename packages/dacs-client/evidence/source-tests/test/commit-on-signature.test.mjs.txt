import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalize, contentHash } from '@kynesyslabs/dacs';
import { commitWorld, clone } from './helpers/review-commit-retry-coverage-world.mjs';
import { loadConfig } from '../src/config.mjs';
import { createSellerAgent } from '../src/dacs/seller-agent.mjs';
import { commitOnSignatureConfig, signatureCommitmentAnchor } from '../src/dacs/commit-on-signature.mjs';

const request = w => ({ jobId: w.jobId, agreement: clone(w.agreement), signedProjection: clone(w.signedProjection) });
const configEnv = { DACS_PUBLIC_ORIGIN: 'https://plugin.example', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(32) };

test('configuration is off by default and accepts only explicit on/off', () => {
  assert.equal(loadConfig(configEnv).commitOnSignature, false);
  assert.equal(loadConfig({ ...configEnv, DACS_COMMIT_ON_SIGNATURE: 'off' }).commitOnSignature, false);
  assert.equal(loadConfig({ ...configEnv, DACS_COMMIT_ON_SIGNATURE: 'on' }).commitOnSignature, true);
  for (const value of ['', 'true', '1', 'ON']) assert.throws(() => loadConfig({ ...configEnv, DACS_COMMIT_ON_SIGNATURE: value }), /off or on/);
  for (const value of [null, 'on', 1, {}]) assert.throws(() => commitOnSignatureConfig(value), /boolean/);
});

test('off: no early request and same anchor object; on: both writes start before either completes', async () => {
  const events = []; let release;
  const anchor = { onCreateAuthorized: (_input, notify) => { anchor.notify = notify; }, anchorAgreement: async () => { events.push('agreement-broadcast'); anchor.notify({ hash: 'authorized' }); await new Promise(r => { release = r; }); return { disposition: 'submitted' }; } };
  const seller = { commitOnSignature: async () => { events.push('commitment-broadcast'); release(); events.push('commitment-readback'); } };
  assert.equal(signatureCommitmentAnchor(anchor, seller, false), anchor);
  const result = await signatureCommitmentAnchor(anchor, seller, true).anchorAgreement({ artifact: { jobId: 'test' } });
  assert.deepEqual(result, { disposition: 'submitted' });
  assert.deepEqual(events, ['agreement-broadcast', 'commitment-broadcast', 'commitment-readback']);
});

test('seller refuses different Agreement bytes and signatures before commitment signing or publication', async t => {
  const w = await commitWorld(t, { fixedClock: true, commitOnSignature: true });
  const reads = w.effects.agreementReads;
  const bad = request(w);
  const signature = bad.agreement.signatures.find(s => s.party === w.buyer.claim);
  // Hash deliberately remains equal: Agreement contentHash excludes signatures.
  signature.value = w.buyer.signBytes(Buffer.from('another Agreement')).toString('base64url');
  assert.equal(contentHash(bad.agreement), contentHash(w.agreement));
  await assert.rejects(w.agent.commitOnSignature(bad), e => e.code === 'signature_agreement_invalid');
  for (const change of [a => { a.jobId = '00'.repeat(32); }, a => { a.listingRef.contentHash = 'ff'.repeat(32); }, a => { a.terms.price.amount = '2'; }, a => { a.parties[0].primaryClaim = w.seller.claim; }]) {
    const candidate = request(w); change(candidate.agreement);
    await assert.rejects(w.agent.commitOnSignature(candidate), e => e.code === 'signature_agreement_invalid');
  }
  assert.equal(w.effects.publish, 0); assert.equal(w.effects.commitmentSignatures, 0); assert.equal(w.effects.agreementReads, reads);
  assert.equal((await w.agent.commitOnSignature(request(w))).status, 'commitment-held');
  assert.equal(w.effects.publish, 1);
});

for (const disposition of ['absent', 'indeterminate']) test(`early commitment is held on ${disposition} Agreement after restart; only readbacks resume`, async t => {
  const w = await commitWorld(t, { fixedClock: true, commitOnSignature: true, http: true });
  w.agreementStatus.disposition = disposition;
  const reads = w.effects.agreementReads;
  assert.equal((await w.client.commitOnSignature(w.jobId, w.agreement, w.signedProjection)).status, 'commitment-held');
  assert.equal(w.effects.agreementReads, reads);
  const pending = await w.retained();
  assert.equal(pending.signatureCommitmentAttempt, true);
  assert.equal(pending.commitment, undefined); assert.equal(pending.phaseResults.length, 1);
  await assert.rejects(w.agent.commit({ jobId: w.jobId }));
  await assert.rejects(w.agent.submitPayment({ jobId: w.jobId, txHash: 'ab'.repeat(32), payerPayingKey: w.buyer.claim }));
  assert.equal(w.effects.publish, 1);
  const stored = clone(w.native.stored); w.native.stored = null;
  await assert.rejects(w.agent.commitOnSignature(request(w)), e => e.code === 'commitment_failed');
  w.agreementStatus.disposition = 'present';
  await assert.rejects(w.agent.commit({ jobId: w.jobId }), e => e.code === 'commitment_failed');
  assert.equal(w.effects.publish, 1, 'missing commitment cannot authorize a second CREATE');
  w.native.stored = stored;
  assert.equal((await w.agent.commit({ jobId: w.jobId })).status, 'committed');
  assert.equal((await w.retained()).phaseResults.length, 2);
  assert.equal(w.effects.publish, 1);
});

test('unknown commitment acknowledgement reconciles over authenticated HTTP without a second effect', async t => {
  const w = await commitWorld(t, { fixedClock: true, commitOnSignature: true, http: true });
  w.native.lostPublishResponse = true;
  await assert.rejects(w.client.commitOnSignature(w.jobId, w.agreement, w.signedProjection));
  await w.retained();
  w.native.status = null; w.native.lostPublishResponse = false;
  w.agreementStatus.disposition = 'absent';
  const result = await w.client.commitOnSignature(w.jobId, w.agreement, w.signedProjection);
  assert.equal(result.status, 'commitment-held'); assert.equal(result.resumed, true);
  assert.equal(w.effects.publish, 1);
  assert.equal((await w.retained()).commitment, undefined);
});

test('off: seller refuses early route; default and baseline commitment bytes agree', async t => {
  const w = await commitWorld(t, { fixedClock: true });
  await assert.rejects(w.agent.commitOnSignature(request(w)), e => e.code === 'signature_commitment_disabled');
  const retained = await w.retained();
  const mainSource = readFileSync(process.env.WS4_BASELINE_SOURCE ?? new URL('../src/dacs/seller-agent.mjs', import.meta.url), 'utf8');
  const root = mkdtempSync(join(tmpdir(), 'ws4-main-')); t.after(() => rmSync(root, { recursive: true }));
  const url = new URL('../src/dacs/seller-agent.mjs', import.meta.url);
  const source = mainSource.replace(/from '(\.\.?\/[^']+)'/g, (_, p) => `from '${new URL(p, url).href}'`).replace(/from '@kynesyslabs\/dacs'/g, () => `from '${import.meta.resolve('@kynesyslabs/dacs')}'`);
  const path = join(root, 'main.mjs'); writeFileSync(path, source);
  const mainOptions = { ...w.buildOptions, durableDirectory: join(root, 'seller') }; delete mainOptions.commitOnSignature;
  const main = await (await import(pathToFileURL(path))).createSellerAgent(mainOptions); t.after(() => main.close());
  await main.receiveProposal({ proposal: retained.proposal, transportIdentity: retained.transportIdentity, buyerIdentityBundle: retained.buyerBundle });
  const baseline = await main.commit({ jobId: w.jobId }); const bytes = canonicalize(w.native.stored);
  w.native.stored = null;
  assert.deepEqual(await w.agent.commit({ jobId: w.jobId }), baseline);
  assert.equal(canonicalize(w.native.stored), bytes, 'record, signature, txRef and receipt match main byte for byte');
});


test('malformed signature request cannot fall through to normal commitment', async t => {
  const w = await commitWorld(t, { fixedClock: true, commitOnSignature: true });
  for (const body of [{ jobId: w.jobId }, { jobId: w.jobId, agreement: undefined }, { ...request(w), extra: true }, { jobId: w.jobId, agreement: null }]) {
    await assert.rejects(w.agent.commitOnSignature(body), e => e.code === 'signature_agreement_invalid');
  }
  assert.equal(w.effects.commitmentSignatures, 0); assert.equal(w.effects.publish, 0);
});

test('restart after a pre-sign unknown observation cannot sign past the retained attempt', async t => {
  const w = await commitWorld(t, { fixedClock: true, commitOnSignature: true });
  w.native.status = 'indeterminate';
  await assert.rejects(w.agent.commitOnSignature(request(w)), e => e.code === 'commitment_failed');
  assert.equal(w.effects.commitmentSignatures, 0);
  const pending = await w.retained(); assert.equal(pending.signatureCommitmentAttempt, true);
  w.native.status = null;
  await assert.rejects(w.agent.commitOnSignature(request(w)), e => e.code === 'commitment_failed');
  assert.equal(w.effects.commitmentSignatures, 0, 'a retained attempt can only read, even if no signature survived');
  assert.equal(w.effects.publish, 0);
});


test('malformed uncertain HTTP signature request stays read-only on reconciliation', async t => {
  const w = await commitWorld(t, { fixedClock: true, commitOnSignature: true, http: true });
  await assert.rejects(w.client.commitOnSignature(w.jobId, undefined));
  await assert.rejects(w.client.commitOnSignature(w.jobId, undefined));
  assert.equal(w.effects.commitmentSignatures, 0);
  assert.equal(w.effects.publish, 0);
});


test('scripted same-block inclusion: early record stays held until both readbacks verify', async t => {
  const w = await commitWorld(t, { fixedClock: true, commitOnSignature: true });
  w.agreementStatus.disposition = 'indeterminate';
  w.agreementStatus.blockNumber = 9;
  const reads = w.effects.agreementReads;
  assert.equal((await w.agent.commitOnSignature(request(w))).status, 'commitment-held');
  assert.equal(w.effects.agreementReads, reads, 'no Agreement read before signing or broadcast');
  assert.equal(w.effects.commitmentSignatures, 1);
  assert.equal(w.effects.publish, 1);
  w.agreementStatus.disposition = 'present'; w.native.status = 'indeterminate';
  await assert.rejects(w.agent.commit({ jobId: w.jobId }), e => e.code === 'commitment_failed');
  assert.equal(w.agent.stageOf(w.jobId), 'proposed');
  w.native.status = null;
  const committed = await w.agent.commit({ jobId: w.jobId });
  assert.equal(committed.agreementAnchor.txRef.blockNumber, Number(w.native.stored.receipt.blockRef.height));
  assert.equal(w.agent.stageOf(w.jobId), 'committed');
  assert.equal(w.effects.publish, 1);
});

test('signature mode refuses an ephemeral seller before any effect', async () => {
  await assert.rejects(createSellerAgent({ commitOnSignature: true }), /requires durable seller state/);
  await assert.rejects(createSellerAgent({ commitOnSignature: false }), /seller signer/);
});
