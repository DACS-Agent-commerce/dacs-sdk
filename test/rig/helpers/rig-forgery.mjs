import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import * as rig from './node_modules/@kynesyslabs/dacs/dist/wire/rig.js';
import { received, signedAgreement, tp1Listing, wireCommitment } from './commitment-fixture.mjs';

export async function probeRigCommitmentForgery({ wire, selection, makeSource, local }) {
  const party = () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return { claim: `did:demos:agent:${publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')}`,
      calls: 0, sign(bytes) { this.calls++; return new Uint8Array(sign(null, Buffer.from(bytes), privateKey)); } };
  };
  const signer = party(), sellerSigner = party();
  const fixture = makeSource(signer.claim, sellerSigner.claim);
  fixture.register();
  const binding = await fixture.bind();
  const now = Date.UTC(2026, 10, 8), publicEndpoint = 'https://seller.rig.invalid';
  const listing = tp1Listing({ seller: sellerSigner, publicEndpoint });
  const listingPin = listing.pin, jobId = '01K7FZ8Q9W3V5T2R1N0M8K6J4H';
  const { agreement, agreementHash } = signedAgreement({ buyer: signer, seller: sellerSigner,
    jobId, listingPin, listing, generatedAt: now - 60_000 });
  const drainedBytes = await wire.signDiscoveryDocument({ format: 'dacs-seller-discovery/v1',
    profile: binding.profile, seller: sellerSigner.claim, publicEndpoint, transport: ['dacs-seller-http/v1'],
    listings: [listingPin], capabilities: wire.TP1_CAPABILITIES, ready: false, issuedAt: now, expiresAt: now + 60_000,
  }, sellerSigner, binding, local);
  const readListingEligibility = scope => ({ seller: scope.seller, publicEndpoint: scope.publicEndpoint,
    listingPin: scope.listingPin, pricingKind: 'fixed', negotiation: 'negotiate-fixed-price',
    commitPhase: 'commit-payee-bound-agreement', rail: 'pay-dem', delivery: wire.TP1_CAPABILITIES.delivery,
    service: { kind: 'fixed-text' }, output: wire.TP1_CAPABILITIES.output, buyerRequestInput: false,
    notBefore: 0, expiresAt: Number.MAX_SAFE_INTEGER });
  const endpointProof = await wire.verifyEndpointProof(drainedBytes, { readListingEligibility,
    readCommitmentReceipt: Object.assign(() => 'valid', { chainIdentity: binding.profile.chainIdentity }),
    listing: { seller: sellerSigner.claim, publicEndpoint, listingPin }, binding, local, now });
  const pay = commitment => wire.signWireRequest({ endpointProof, publicEndpoint, signer, binding, local,
    path: '/dacs/v1/payments', jobId, text: '{}', seller: sellerSigner.claim,
    job: { listingPin, agreementHash, profile: binding.profile }, now,
    commitment: received(commitment), agreement: received(agreement), signedListing: received(listing.listing) });
  const facts = { jobId, agreementHash, listingRef: listingPin, buyer: signer.claim, seller: sellerSigner.claim, committedAt: 42 };
  // Enumerate every rig-module export, including functions reachable by file path,
  // plus the binder exported from ./wire. No name-based filter can omit a function.
  const exports = { ...rig, bindRigProfile: wire.bindRigProfile };
  const functions = Object.entries(exports).filter(([, value]) => typeof value === 'function');
  for (const name of ['admitRigSource', 'isRigSource', 'selectRigProfile', 'rigProfileSelected', 'rigProfileRecord', 'bindRigProfile']) {
    assert.equal(exports[name], wire[name]);
    assert(Object.keys(wire).includes(name));
  }
  signer.calls = 0; // Count only wire signing after the Agreement fixture is signed.
  const before = signer.calls;
  let tried = 0;
  const refuse = async (candidate, label) => {
    tried++;
    await assert.rejects(pay(candidate), error => error.code === 'continuation_commitment_invalid', label);
    assert.equal(signer.calls, before, label);
  };
  for (const [name, fn] of functions) {
    for (const args of [[{}, facts], [facts], [{ ...facts }, { ...facts }]]) {
      let result;
      try { result = await fn(...args); } catch { /* Same forgery calls as builtPackage.test.ts. */ }
      for (const candidate of [...args, ...(result && typeof result === 'object' ? [result] : [])]) {
        await refuse(candidate, name);
      }
    }
  }
  // Also try the opaque objects returned by successful, correctly shaped rig calls,
  // the admitted source, and every exported data object, with caller-owned copies.
  for (const candidate of [selection, wire.rigProfileRecord(selection), binding, fixture.source,
    ...Object.values(exports).filter(value => value && typeof value === 'object')]) {
    await refuse(candidate, 'rig object');
    await refuse({ ...candidate }, 'rig object copy');
  }
  assert(tried >= functions.length * 5);
  assert.equal(signer.calls, 0);
  // Positive control: real signed/finalized evidence continues the same payment.
  const genuine = wireCommitment({ seller: sellerSigner, buyer: signer.claim, jobId, agreementHash,
    listingPin, committedAt: now - 1000 });
  await pay(genuine);
  assert.equal(signer.calls, 1);
}
