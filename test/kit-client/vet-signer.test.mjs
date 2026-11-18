// Who signs the seller's Vet record: the kit's selected mode and the client's consumer both require the seller; the kit's counterparty mode requires the buyer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ARTIFACT_SEPARATORS, canonicalize, contentHash, identityBundleHash, sha256Hex, signComponentArtifact } from '@kynesyslabs/dacs';
import { KIT_TP1_VET_MODE } from '../../packages/dacs-seller/src/host.mjs';
import { sellerRecordVerifier, vetRecordProblem } from '../../packages/dacs-seller/src/dacs/session-admission.mjs';
import { createDemDeliveryContext as createKitContext, resolveDemDeliverySellerContext as resolveKitContext } from '../../packages/dacs-seller/src/dacs/dem-delivery-context-consumer.mjs';
import { createDemDeliveryContext, resolveDemDeliverySellerContext } from '../../packages/dacs-client/src/dacs/dem-delivery-context-consumer.mjs';
import { assertPresent, orchestratorFixture } from '../../packages/dacs-seller/test/helpers/vet-orchestrator-fixture.mjs';
import { BUYER, JOB, SELLER, T0, buyerBundle, contextInput, k4Listing, listingSellerBundle, vetRef } from './fixtures.mjs';

const REQUIREMENT = { requirementVersion: '1', required: [] };
const COUNTERPARTY_MODE = undefined;
const COUNTERPARTY_RECORD_REFUSAL = 'the Vet record is not signed by its counterparty verifier';
const COUNTERPARTY_REF_REFUSAL = 'DEM_DELIVERY_CONTEXT_INPUT_MISMATCH: seller Vet ref is not signed by its counterparty verifier';
const SELLER_RECORD_REFUSAL = 'the Vet record is not signed by the seller as orchestrator verifier';
const SELLER_REF_REFUSAL = 'DEM_DELIVERY_CONTEXT_INPUT_MISMATCH: seller Vet ref is not signed by the seller as orchestrator verifier';
const CLIENT_REF_REFUSAL = 'DEM_DELIVERY_CONTEXT_INPUT_MISMATCH: seller Vet ref is not signed by the bound phase orchestrator';

/** The seller's composite Vet record on the Listing's bundle, signed by `signer`, with the reference that names it. */
async function sellerVetRecord(signer) {
  const record = await signComponentArtifact({ recordVersion: '1', jobId: JOB, evaluatedParty: SELLER.claim,
    bundleHash: identityBundleHash(listingSellerBundle()), requirementHash: sha256Hex(canonicalize(REQUIREMENT)),
    freshness: [], supplementary: [], dealSpecific: [], overallDecision: 'pass', generatedAt: T0 },
  ARTIFACT_SEPARATORS.CompositeVerificationRecord, { algorithm: 'ed25519', signer: signer.claim, sign: signer.signBytes });
  return { record, ref: vetRef(SELLER, signer, contentHash(record)) };
}

/** The kit's check of a seller record in `vetMode`, with the verifier that mode requires. */
const kitRecordProblem = (vetMode, { record, ref }) => vetRecordProblem(record, { ref, jobId: JOB, role: 'seller', party: SELLER.claim,
  bundleHash: identityBundleHash(listingSellerBundle()), verifier: sellerRecordVerifier(vetMode, SELLER.claim, BUYER.claim), vetMode,
  invocation: { requirement: REQUIREMENT, freshness: [], dealSpecific: [] }, now: () => T0 });

/** A seller-context entry (the kit's or the client's) over the Listing and a context input, answering `input`. */
async function contextAnswer({ create, resolve, vetMode, listing, input }) {
  const capability = create({ authority: 'TEST-kit-client-h3', vetMode, resolveBuyer: () => null,
    resolveSeller: async () => ({ disposition: 'present', value: { input, vetRequirements: [] } }) });
  return resolve(capability, { jobId: JOB, listing, buyerBundle: buyerBundle(), generatedAt: T0 });
}

/** The kit's consumer in `vetMode` over K4's Listing and a seller Vet ref. */
async function kitAnswer(vetMode, ref) {
  const listing = await k4Listing();
  return contextAnswer({ create: createKitContext, resolve: resolveKitContext, vetMode, listing, input: contextInput({ listing, sellerRef: ref }) });
}

/** The client's real seller-context entry over K4's Listing and a seller Vet ref. */
async function clientAnswer(ref) {
  const listing = await k4Listing();
  return contextAnswer({ create: createDemDeliveryContext, resolve: resolveDemDeliverySellerContext, listing, input: contextInput({ listing, sellerRef: ref }) });
}

test("K12-H3(i) target: the kit's selected Vet mode accepts a SELLER-signed seller record", async () => {
  assert.equal(await kitRecordProblem(KIT_TP1_VET_MODE, await sellerVetRecord(SELLER)), null);
});

test("K12-H3(i) control: the kit's selected Vet mode refuses a BUYER-signed seller record", async () => {
  assert.equal(await kitRecordProblem(KIT_TP1_VET_MODE, await sellerVetRecord(BUYER)), SELLER_RECORD_REFUSAL);
});

test('K12-H3(ii) target: the client accepts a SELLER-signed seller Vet ref', async () => {
  const { ref } = await sellerVetRecord(SELLER);
  const answer = await clientAnswer(ref);
  assert.equal(answer.disposition, 'present');
  assert.equal(answer.input.seller.vetRecordRef.signer, SELLER.claim);
});

test('K12-H3(ii) control: the client refuses a BUYER-signed seller Vet ref', async () => {
  const answer = await clientAnswer((await sellerVetRecord(BUYER)).ref);
  assert.equal(answer.disposition, 'rejected');
  assert.equal(answer.reason, CLIENT_REF_REFUSAL);
});

test("the kit's context consumer in the selected Vet mode accepts a SELLER-signed seller ref and refuses a BUYER-signed one", async () => {
  const accepted = await kitAnswer(KIT_TP1_VET_MODE, (await sellerVetRecord(SELLER)).ref);
  assert.equal(accepted.disposition, 'present');
  assert.equal(accepted.input.seller.vetRecordRef.signer, SELLER.claim);
  const refused = await kitAnswer(KIT_TP1_VET_MODE, (await sellerVetRecord(BUYER)).ref);
  assert.equal(refused.disposition, 'rejected');
  assert.equal(refused.reason, SELLER_REF_REFUSAL);
});

test("the kit's counterparty mode still refuses a SELLER-signed seller record, with its exact wording, and accepts a BUYER-signed one", async () => {
  assert.equal(await kitRecordProblem(COUNTERPARTY_MODE, await sellerVetRecord(SELLER)), COUNTERPARTY_RECORD_REFUSAL);
  assert.equal(await kitRecordProblem(COUNTERPARTY_MODE, await sellerVetRecord(BUYER)), null);
});

test("the kit's counterparty context consumer still refuses a SELLER-signed seller ref, with its exact wording, and accepts a BUYER-signed one", async () => {
  const refused = await kitAnswer(COUNTERPARTY_MODE, (await sellerVetRecord(SELLER)).ref);
  assert.equal(refused.disposition, 'rejected');
  assert.equal(refused.reason, COUNTERPARTY_REF_REFUSAL);
  assert.equal((await kitAnswer(COUNTERPARTY_MODE, (await sellerVetRecord(BUYER)).ref)).disposition, 'present');
});

test("the context the real W producer makes passes the kit's selected mode and the client, and the kit's counterparty mode refuses it", async (t) => {
  const fixture = await orchestratorFixture(t, { real: true });
  const { input } = assertPresent(await fixture.run());
  assert.equal(input.seller.vetRecordRef.signer, SELLER.claim);
  for (const [name, create, resolve, vetMode] of [['kit', createKitContext, resolveKitContext, KIT_TP1_VET_MODE], ['client', createDemDeliveryContext, resolveDemDeliverySellerContext]]) {
    const answer = await contextAnswer({ create, resolve, vetMode, listing: fixture.listing, input });
    assert.equal(answer.disposition, 'present', `${name}: ${JSON.stringify(answer)}`);
  }
  const counterparty = await contextAnswer({ create: createKitContext, resolve: resolveKitContext, vetMode: COUNTERPARTY_MODE, listing: fixture.listing, input });
  assert.equal(counterparty.disposition, 'rejected');
  assert.equal(counterparty.reason, COUNTERPARTY_REF_REFUSAL);
});
