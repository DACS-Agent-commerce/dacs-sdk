import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARTIFACT_SEPARATORS, ed25519Sign, privateKeyFromSeed, publicKeyFromSeed,
  rawPublicKey, signComponentArtifact,
} from '../dist/index.js';
import { isNativeDeliveryEvidence } from '../packages/dacs-client/src/dacs/delivery-evidence.mjs';
import { verifyDemosSignature } from '../packages/dacs-client/src/signatures.mjs';

const seed = Buffer.alloc(32, 7);
const privateKey = privateKeyFromSeed(seed);
const claim = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString('hex')}`;
const smallOrderClaim = `did:demos:agent:${'01' + '00'.repeat(31)}`;
const constantSignature = Buffer.from('01' + '00'.repeat(63), 'hex').toString('base64url');

test('client signature verification accepts an ordinary key and refuses invalid signatures', () => {
  const message = 'signed message';
  const signature = Buffer.from(ed25519Sign(Buffer.from(message), privateKey)).toString('base64url');
  assert.equal(verifyDemosSignature({ address: `0x${claim.slice(-64)}`, message, signature }), true);
  assert.equal(verifyDemosSignature({ address: `0x${claim.slice(-64)}`, message: 'different message', signature }), false);
  assert.equal(verifyDemosSignature({ address: `0x${smallOrderClaim.slice(-64)}`, message, signature: constantSignature }), false);
});

test('client delivery evidence rejects a small-order seller key', async () => {
  const jobId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const address = `dacs4:evidence:${jobId}`;
  const unsigned = {
    evidenceVersion: '1', jobId, phase: 'deliver-storage-program', outcome: 'success',
    dacsSdkAuditSourceHash: 'a'.repeat(64), deliverableContentHash: 'b'.repeat(64),
    deliverableAnchor: { kind: 'storage-program', locator: `dacs4:deliverable:${jobId}` }, observedAt: 2,
  };
  const evidence = await signComponentArtifact(unsigned, ARTIFACT_SEPARATORS.SettlementEvidence, {
    algorithm: 'ed25519', signer: claim, sign: (bytes) => ed25519Sign(bytes, privateKey),
  });
  assert.equal(isNativeDeliveryEvidence(evidence, claim, address), true);
  const invalid = { ...evidence, signature: { algorithm: 'ed25519', signer: smallOrderClaim, value: constantSignature } };
  assert.equal(isNativeDeliveryEvidence(invalid, smallOrderClaim, address), false);
});
