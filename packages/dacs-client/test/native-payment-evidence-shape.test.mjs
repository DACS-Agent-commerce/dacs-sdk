// A seller-signed payment artifact with a malformed shape fails the scope
// check; it never throws.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARTIFACT_SEPARATORS, ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey, signComponentArtifact } from '@kynesyslabs/dacs';
import { checkNativePaymentEvidence } from '../src/dacs/native-payment-evidence-consumer.mjs';

const SCOPE_MISMATCH = { decision: 'fail', reasons: ['native-payment-evidence-scope-mismatch'] };
const JOB = '01J8N4YV7YVYQ4DB7M8T4C7W0A', OBSERVED_AT = 1_780_000_000_000;
const TX = { txHash: 'a'.repeat(64), blockNumber: 77 };
const sellerSeed = new Uint8Array(32).fill(17);
const sellerKey = privateKeyFromSeed(sellerSeed);
const seller = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(sellerSeed))).toString('hex')}`;
const buyer = `did:demos:agent:${'b'.repeat(64)}`;
const agreement = { jobId: JOB, parties: [{ role: 'buyer', primaryClaim: buyer }, { role: 'seller', primaryClaim: seller }],
  terms: { price: { amount: '2.5', currency: 'DEM' }, deadline: OBSERVED_AT + 3_600_000, payoutBindings: [{ payeeAddress: seller, phaseIndex: 2, railId: 'demos-native:DEM' }] } };
const input = { agreement, writer: seller, ...TX };
const signedArtifact = () => signComponentArtifact({ evidenceVersion: '1', jobId: JOB, phase: 'pay-dem', outcome: 'success', observedAt: OBSERVED_AT,
  paymentTxRefs: [{ kind: 'demos', ...TX }], paymentAmount: { amount: '2.5', currency: 'DEM' }, settlementFinality: { model: 'bft-final', finalityObservedAt: OBSERVED_AT } },
ARTIFACT_SEPARATORS.SettlementEvidence, { algorithm: 'ed25519', signer: seller, sign: bytes => Buffer.from(ed25519Sign(bytes, sellerKey)) });

test('a well-formed signed payment artifact passes the native evidence check', async () => {
  const result = await checkNativePaymentEvidence({ artifact: await signedArtifact(), ...input });
  assert.equal(result.decision, 'pass', JSON.stringify(result));
});

for (const [label, paymentTxRefs] of [['a null entry', [null]], ['a number entry', [7]], ['a string entry', ['demos']], ['an array entry', [[]]],
  ['a string of length one', 'a'], ['an object of length one', { length: 1 }], ['null', null], ['no entries', []]]) {
  test(`the native evidence check fails on scope when paymentTxRefs is ${label}`, async () => {
    assert.deepEqual(await checkNativePaymentEvidence({ artifact: { ...await signedArtifact(), paymentTxRefs }, ...input }), SCOPE_MISMATCH);
  });
}

test('the native evidence check fails on scope when paymentTxRefs has two entries', async () => {
  const artifact = await signedArtifact();
  assert.deepEqual(await checkNativePaymentEvidence({ artifact: { ...artifact, paymentTxRefs: [...artifact.paymentTxRefs, ...artifact.paymentTxRefs] }, ...input }), SCOPE_MISMATCH);
});

test('the native evidence check fails on scope when paymentTxRefs is missing', async () => {
  const { paymentTxRefs, ...withoutPaymentTxRefs } = await signedArtifact();
  assert.deepEqual(await checkNativePaymentEvidence({ artifact: withoutPaymentTxRefs, ...input }), SCOPE_MISMATCH);
});

test('the native evidence check fails on scope when the artifact cannot be hashed', async () => {
  assert.deepEqual(await checkNativePaymentEvidence({ artifact: { ...await signedArtifact(), extra: undefined }, ...input }), SCOPE_MISMATCH);
});

for (const [label, artifact] of [['null', null], ['undefined', undefined], ['a string', 'TEST artifact'], ['an array', []]]) {
  test(`the native evidence check fails on scope when the artifact is ${label}`, async () => {
    assert.deepEqual(await checkNativePaymentEvidence({ artifact, ...input }), SCOPE_MISMATCH);
  });
}

for (const field of ['paymentAmount', 'settlementFinality', 'signature']) for (const [label, value] of [['null', null], ['a string', 'TEST'], ['a number', 7]]) {
  test(`the native evidence check fails on scope when ${field} is ${label}`, async () => {
    assert.deepEqual(await checkNativePaymentEvidence({ artifact: { ...await signedArtifact(), [field]: value }, ...input }), SCOPE_MISMATCH);
  });
}

test('the native evidence check does not read the artifact fields of a writer that is not the seller', async () => {
  assert.deepEqual(await checkNativePaymentEvidence({ artifact: { ...await signedArtifact(), paymentTxRefs: [null] }, ...input, writer: buyer }), SCOPE_MISMATCH);
});
