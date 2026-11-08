// Test adapters keep the legacy regression names while driving the shared challenge ledger.
import { canonicalize, identityBundleHash, sha256Hex } from '@kynesyslabs/dacs';
import { listingPin } from '../../src/dacs/purchase-protocol.mjs';
import { SELLER_PROFILE } from '../../src/dacs/session-admission.mjs';
import { SellerTransportError, sellerContextScopeHash, sellerContextChallengeScope } from '../../src/dacs/seller-transport-auth.mjs';

/** Issues through the raw store's ledger; propagates its refusal or a scope-hash error. */
export function issueChallenge(store, request, scope) {
  return store.challenges.issue(request, sellerContextScopeHash(scope));
}

/** Returns the ledger decision, throwing SellerTransportError for a refused attempt. */
export function attemptChallenge(store, request, body) {
  const result = store.challenges.attempt({ request, path: 'context', jobId: request.jobId, buyer: request.buyer,
    nonce: body.buyerIdentityBundle?.sessionNonce, challengeScopeHash: sellerContextScopeHash(sellerContextChallengeScope(body.scope)),
    presentationHash: sha256Hex(canonicalize(body.buyerIdentityBundle)) });
  if (result.kind === 'refused') throw new SellerTransportError(result.code, result.status, { cause: result.cause });
  return result;
}

/** A route's `admitPresentation` that admits every presented bundle for `listing`'s seller. */
export const admitFixtureFor = (listing) => async ({ jobId, bundle }) => admittedSession({ jobId, bundle, bundleHash: identityBundleHash(bundle),
  seller: listing.seller.identity.presentedBy, listingPin: listingPin(listing) });

/** The admitted session answer the ledger keeps for `bundle`, as the seller's profile admission returns it. */
export function admittedSession({ jobId, bundle, bundleHash, seller, listingPin }) {
  const buyer = bundle.presentedBy;
  return { disposition: 'admitted', jobId, buyer, buyerBundleHash: bundleHash, listingPin,
    participants: [{ role: 'buyer', claim: buyer, ...structuredClone(SELLER_PROFILE) }, { role: 'seller', claim: seller, ...structuredClone(SELLER_PROFILE) }] };
}
