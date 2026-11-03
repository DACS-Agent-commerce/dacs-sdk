// K12-H2 (E7 baseline): the client's context input check against the seller bundle bytes of K4.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemDeliveryContext, resolveDemDeliverySellerContext } from '../../packages/dacs-client/src/dacs/dem-delivery-context-consumer.mjs';
import { JOB, T0, buyerBundle, contextInput, freshSellerBundle, k4Listing, listingSellerBundle, sameBytes } from './fixtures.mjs';

const unreachable = () => { throw new Error('TEST the buyer resolver is not part of this case'); };

/** The client's real seller-context entry, over a capability whose seller answer carries `seller` as `seller.identityBundle`. */
async function resolveWithSellerBundle(seller) {
  const listing = await k4Listing();
  const input = contextInput({ listing, seller });
  const capability = createDemDeliveryContext({ authority: 'TEST-kit-client-h2', resolveBuyer: unreachable,
    resolveSeller: async () => ({ disposition: 'present', value: { input, vetRequirements: [] } }) });
  return { listing, input, answer: await resolveDemDeliverySellerContext(capability, { jobId: JOB, listing, buyerBundle: buyerBundle(), generatedAt: T0 }) };
}

test("K12-H2 today: the client's context input check refuses K4-B2's fresh seller presentation (seller identity differs)", async () => {
  const { answer } = await resolveWithSellerBundle(freshSellerBundle());
  assert.equal(answer.disposition, 'rejected');
  assert.equal(answer.reason, 'DEM_DELIVERY_CONTEXT_INPUT_MISMATCH: seller identity differs');
});

test("K12-H2 control: the same input with K4-B1's exact Listing bundle passes the client's input check", async () => {
  const { listing, input, answer } = await resolveWithSellerBundle(listingSellerBundle());
  assert.equal(answer.disposition, 'present');
  assert.ok(sameBytes(listing.seller.identity, input.seller.identityBundle), 'the accepted bundle is the Listing bundle, byte for byte');
  assert.ok(sameBytes(answer.input, input));
});
