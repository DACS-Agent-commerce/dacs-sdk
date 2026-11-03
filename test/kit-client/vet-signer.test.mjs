// K12-H3 (E7 baseline): who signs the seller's Vet record, as the kit's default and the client's consumer each require it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ARTIFACT_SEPARATORS, canonicalize, contentHash, identityBundleHash, sha256Hex, signComponentArtifact } from '@kynesyslabs/dacs';
import { vetRecordProblem } from '../../packages/dacs-seller/src/dacs/session-admission.mjs';
import { createDemDeliveryContext, resolveDemDeliverySellerContext } from '../../packages/dacs-client/src/dacs/dem-delivery-context-consumer.mjs';
import { BUYER, JOB, SELLER, T0, buyerBundle, contextInput, k4Listing, listingSellerBundle, vetRef } from './fixtures.mjs';

const REQUIREMENT = { requirementVersion: '1', required: [] };
const KIT_REFUSAL = 'the Vet record is not signed by its counterparty verifier';
const CLIENT_REFUSAL = 'DEM_DELIVERY_CONTEXT_INPUT_MISMATCH: seller Vet ref is not signed by the bound phase orchestrator';

/** The seller's composite Vet record on K4-B1, signed by `signer`, with the reference that names it. */
async function sellerVetRecord(signer) {
  const record = await signComponentArtifact({ recordVersion: '1', jobId: JOB, evaluatedParty: SELLER.claim,
    bundleHash: identityBundleHash(listingSellerBundle()), requirementHash: sha256Hex(canonicalize(REQUIREMENT)),
    freshness: [], supplementary: [], dealSpecific: [], overallDecision: 'pass', generatedAt: T0 },
  ARTIFACT_SEPARATORS.CompositeVerificationRecord, { algorithm: 'ed25519', signer: signer.claim, sign: signer.signBytes });
  return { record, ref: vetRef(SELLER, signer, contentHash(record)) };
}

/** The kit's default check: the verifier of a seller record is its counterparty, the buyer. */
const kitDefaultProblem = ({ record, ref }) => vetRecordProblem(record, { ref, jobId: JOB, role: 'seller', party: SELLER.claim,
  bundleHash: identityBundleHash(listingSellerBundle()), verifier: BUYER.claim, invocation: { requirement: REQUIREMENT, freshness: [], dealSpecific: [] }, now: () => T0 });

/** The client's real seller-context entry over K4-B1 and a seller Vet ref. */
async function clientAnswer(ref) {
  const listing = await k4Listing();
  const input = contextInput({ listing, sellerRef: ref });
  const capability = createDemDeliveryContext({ authority: 'TEST-kit-client-h3', resolveBuyer: () => null,
    resolveSeller: async () => ({ disposition: 'present', value: { input, vetRequirements: [] } }) });
  return resolveDemDeliverySellerContext(capability, { jobId: JOB, listing, buyerBundle: buyerBundle(), generatedAt: T0 });
}

test("K12-H3(i) today: the kit's default vetRecordProblem refuses a SELLER-signed seller record", async () => {
  assert.equal(await kitDefaultProblem(await sellerVetRecord(SELLER)), KIT_REFUSAL);
});

test("K12-H3(i) control: the kit's default vetRecordProblem accepts the BUYER-signed seller record", async () => {
  assert.equal(await kitDefaultProblem(await sellerVetRecord(BUYER)), null);
});

test('K12-H3(ii) today: the client refuses a BUYER-signed seller Vet ref (not signed by the bound phase orchestrator)', async () => {
  const answer = await clientAnswer((await sellerVetRecord(BUYER)).ref);
  assert.equal(answer.disposition, 'rejected');
  assert.equal(answer.reason, CLIENT_REFUSAL);
});

test('K12-H3(ii) control: the client accepts the SELLER-signed seller Vet ref', async () => {
  const { ref } = await sellerVetRecord(SELLER);
  const answer = await clientAnswer(ref);
  assert.equal(answer.disposition, 'present');
  assert.equal(answer.input.seller.vetRecordRef.signer, SELLER.claim);
});
