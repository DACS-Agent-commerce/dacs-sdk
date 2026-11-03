import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '@kynesyslabs/dacs';
import { commitWorld, clone } from './helpers/review-commit-retry-coverage-world.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { signatureCommitmentAnchor } from '../src/dacs/commit-on-signature.mjs';
const request = w => ({ jobId: w.jobId, agreement: clone(w.agreement), signedProjection: clone(w.signedProjection) });

test('seller requires independent exact buyer CREATE authorization before any signature', async t => {
  const w = await commitWorld(t, { commitOnSignature: true, fixedClock: true });
  await assert.rejects(w.agent.commitOnSignature({ jobId: w.jobId, agreement: w.agreement }), e => e.code === 'signature_agreement_invalid');
  for (const change of [tx => { tx.signature.data = w.seller.signHex(tx.hash); }, tx => { tx.hash = 'ff'.repeat(32); },
    tx => { tx.content.data[1].data.signatures[0].value = 'substituted'; }, tx => { tx.content.data[1].metadata.logicalAddress = 'other'; },
    tx => { tx.content.data[1].metadata.contentHash = 'ff'.repeat(32); }, tx => { tx.content.data[1].metadata.envelopeHash = 'ff'.repeat(32); },
    tx => { tx.content.data[1].metadata.artifactKind = 'Listing'; }, tx => { tx.content.data[1].operation = 'UPDATE_STORAGE_PROGRAM'; },
    tx => { tx.content.data[1].storageAddress = 'stor-' + 'ff'.repeat(20); }, tx => { tx.content.to = 'stor-' + 'ff'.repeat(20); },
    tx => { tx.content.from = w.seller.address; }, tx => { tx.content.nonce = 0; }]) {
    const r = request(w); change(r.signedProjection);
    // Re-sign content changes with the real buyer. Exact scope still matters.
    if (r.signedProjection.hash === w.signedProjection.hash && JSON.stringify(r.signedProjection.content) !== JSON.stringify(w.signedProjection.content)) {
      r.signedProjection.hash = sha256Hex(JSON.stringify(r.signedProjection.content));
      r.signedProjection.signature.data = w.buyer.signHex(r.signedProjection.hash);
    }
    await assert.rejects(w.agent.commitOnSignature(r), e => e.code === 'signature_agreement_invalid');
  }
  assert.equal(w.effects.commitmentSignatures, 0); assert.equal(w.effects.publish, 0);
  assert.equal((await w.agent.commitOnSignature(request(w))).status, 'commitment-held');
});

test('unbroadcast, cancelled or expired CREATEs cannot exceed one unresolved early commitment per buyer across restart', async t => {
  const w = await commitWorld(t, { commitOnSignature: true, fixedClock: true });
  w.agreementStatus.disposition = 'absent';
  assert.equal((await w.agent.commitOnSignature(request(w))).status, 'commitment-held');
  await w.retained();
  for (const abandoned of ['unbroadcast', 'cancelled', 'expired']) {
    const next = await w.newAgreement();
    await assert.rejects(w.agent.commitOnSignature(next), e => e.code === 'seller_signature_buyer_unresolved', abandoned);
    await w.retained();
  }
  assert.equal(w.effects.commitmentSignatures, 1); assert.equal(w.effects.publish, 1);
  // Only authenticated readback of the original Agreement releases its slot.
  w.agreementStatus.disposition = 'indeterminate';
  await assert.rejects(w.agent.commit({ jobId: w.jobId }));
  await assert.rejects(w.agent.commitOnSignature(await w.newAgreement()), e => e.code === 'seller_signature_buyer_unresolved');
  w.agreementStatus.disposition = 'present';
  await w.agent.commit({ jobId: w.jobId });
  const next = await w.newAgreement(); w.native.stored = null;
  assert.equal((await w.agent.commitOnSignature(next)).status, 'commitment-held');
  assert.equal(w.effects.publish, 2);
});

test('authorization gate keeps overlap but never triggers for a denied or absent CREATE journal', async () => {
  let notify, finish, signed; const events = [];
  const authorized = new Promise(r => { signed = r; });
  const anchor = { onCreateAuthorized: (_input, callback) => { notify = callback; },
    anchorAgreement: async () => { events.push('wallet-request'); await new Promise(r => { finish = r; }); return { disposition: 'submitted' }; } };
  const seller = { commitOnSignature: async (_job, _agreement, tx) => { assert.equal(tx.hash, 'exact'); events.push('seller-sign'); signed(); } };
  const wrapped = signatureCommitmentAnchor(anchor, seller, true);
  assert.equal(Object.hasOwn(wrapped, 'onCreateAuthorized'), false, 'SDK anchor shape remains exact');
  const work = wrapped.anchorAgreement({ artifact: { jobId: 'job' } });
  await new Promise(r => setTimeout(r, 30)); assert.deepEqual(events, ['wallet-request']);
  notify({ hash: 'exact' }); await authorized;
  assert.deepEqual(events, ['wallet-request', 'seller-sign'], 'seller runs while buyer anchor is still pending'); finish(); await work;
  const denied = { onCreateAuthorized: () => {}, anchorAgreement: async () => ({ disposition: 'rejected' }) };
  assert.deepEqual(await signatureCommitmentAnchor(denied, { commitOnSignature: () => assert.fail('denied CREATE cannot trigger seller') }, true).anchorAgreement({ artifact: { jobId: 'job' } }), { disposition: 'rejected' });
  const unsupported = { anchorAgreement: async () => ({ disposition: 'submitted' }) };
  assert.equal(signatureCommitmentAnchor(unsupported, seller, true), unsupported, 'no authorization seam means no early request');
});

test('closed early admission is seller-owned and checked before an attempt', async t => {
  const w = await commitWorld(t, { commitOnSignature: true, fixedClock: true });
  w.buildOptions.signatureBuyer = createEphemeralWallet().claim;
  await w.retained();
  await assert.rejects(w.agent.commitOnSignature(request(w)), e => e.code === 'signature_buyer_not_admitted');
  assert.equal(w.effects.commitmentSignatures, 0); assert.equal(w.effects.publish, 0);
  assert.equal((await w.retained()).signatureCommitmentAttempt, undefined);
  w.buildOptions.signatureBuyer = w.buyer.claim; await w.retained();
  assert.equal((await w.agent.commitOnSignature(request(w))).status, 'commitment-held');
});

test('connection readiness precedes the attempt; a definitely unavailable reservation leaves ordinary commitment possible', async t => {
  const w = await commitWorld(t, { commitOnSignature: true, fixedClock: true });
  let ready; const pending = new Promise(resolve => { ready = resolve; });
  w.buildOptions.signatureCommitmentReady = () => pending; await w.retained();
  const attempt = w.agent.commitOnSignature(request(w));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(w.effects.commitmentSignatures, 0); assert.equal(w.effects.publish, 0);
  ready(); assert.equal((await attempt).status, 'commitment-held');
  const other = await commitWorld(t, { commitOnSignature: true, fixedClock: true });
  other.buildOptions.signatureCommitmentReady = async () => { throw Error('actual connection busy'); }; await other.retained();
  await assert.rejects(other.agent.commitOnSignature(request(other)), e => e.code === 'signature_connection_unavailable');
  assert.equal((await other.retained()).signatureCommitmentAttempt, undefined);
  assert.equal(other.effects.commitmentSignatures, 0); assert.equal(other.effects.publish, 0);
  assert.equal((await other.agent.commit({ jobId: other.jobId })).status, 'committed');
  assert.equal(other.effects.publish, 1);
});
