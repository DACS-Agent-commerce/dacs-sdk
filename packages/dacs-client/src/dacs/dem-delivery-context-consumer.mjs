// Explicit application capability for the fixed-price DEM delivery profile.
//
// This is narrower than the generic operator Agreement-context seam: the same
// capability must answer both the buyer planner and the seller orchestrator,
// and every Vet reference must name a seller/orchestrator-produced composite
// at the canonical DACS-2 address.  The underlying composite records and their
// verification provenance are kept seller-side; this consumer only binds the
// exact Agreement derivation input to the already prepared purchase scope.
import { canonicalize, compositeVerificationAddress, identityBundleHash } from '@kynesyslabs/dacs';
import { claimForAddress } from '../signatures.mjs';
import { DEM_RAIL } from './listing.mjs';
import { agreementContextScope } from './agreement-context-consumer.mjs';
import { listingPin, protocolSupport } from './purchase-protocol.mjs';
import { cutText } from '../util/text.mjs';

export const DEM_DELIVERY_CONTEXT_SOURCE = 'dacs-chatgpt-plugin/dem-delivery-context/v1';
// A buyer resolver may publish seller Vet records. Only an absent capability,
// where no resolver was invoked, returns `written: false` (ops health: nothing
// to read back). Nothing an invoked resolver answers or throws does: each is a
// possibly-issued seller write.

const capabilities = new WeakMap();
const HEX64 = /^[0-9a-f]{64}$/;
const INPUT_KEYS = ['buyer', 'generatedAt', 'jobId', 'payoutBindings', 'selectedRail', 'seller', 'verifiedListing'];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && canonicalize(Object.keys(value).sort()) === canonicalize([...keys].sort());
const same = (left, right) => { try { return canonicalize(left) === canonicalize(right); } catch { return false; } };
const HELD = ['absent', 'rejected', 'indeterminate'];
// Total: whatever disposition it is given, a held result is never `present`.
const held = (disposition, reason) => ({ disposition: HELD.includes(disposition) ? disposition : 'indeterminate', reason: cutText(reason, 240) });
// Provider refusal codes the purchase may name as its own error code.
const HELD_CODES = new Set(['legacy_party_vet_state_missing']);
// A resolver's answer is read only inside a try, each of its fields once, and
// its thrown value only through failureText(): nothing it returns or throws can
// escape as a server error with no attempt recorded for a possible write.
const failureText = (error) => { try { return String(error?.message ?? error); } catch { return 'unreadable error'; } };

// The capability's authority label: one `TEST-` line of at most 120 characters (an
// operator run authority `TEST-RUN-…` fits). The purchase receipt accepts a stored
// resolution marker only with this label.
export const isDemDeliveryContextAuthority = (value) => typeof value === 'string' && /^TEST-[A-Za-z0-9._:-]{1,115}$/.test(value);

// release (optional): told when a job's plan is saved or its purchase ended,
// so the provider can drop that job's entries. usage (optional): the
// provider's store capacity, for the health report.
export function createDemDeliveryContext({ authority, resolveBuyer, resolveSeller, release = null, usage = null }) {
  if (!isDemDeliveryContextAuthority(authority) || typeof resolveBuyer !== 'function' || typeof resolveSeller !== 'function' || (release !== null && typeof release !== 'function') || (usage !== null && typeof usage !== 'function')) {
    throw new TypeError('DEM delivery context requires explicit TEST authority and buyer/seller resolvers');
  }
  const capability = Object.freeze({ source: DEM_DELIVERY_CONTEXT_SOURCE, authority });
  capabilities.set(capability, { authority, resolveBuyer, resolveSeller, release, usage });
  return capability;
}

// The provider store's used and remaining capacity, or null.
export function demDeliveryContextUsage(capability) {
  try { return capabilityFor(capability)?.usage?.() ?? null; } catch { return { status: 'error' }; }
}

// generatedAt names the saved plan's request (its context stays for the
// seller); without it the purchase ended. Eviction never changes a purchase.
export function releaseDemDeliveryContext(capability, { jobId, generatedAt = null }) {
  try { capabilityFor(capability)?.release?.({ jobId, generatedAt }); } catch { /* eviction only */ }
}

export function demDeliveryContextConfig(value) {
  if (value == null) return null;
  if (!capabilities.has(value)) throw new TypeError('demDeliveryContext requires a constructed application capability');
  return value;
}

const capabilityFor = (value) => {
  const configured = demDeliveryContextConfig(value);
  return configured ? capabilities.get(configured) : null;
};

function vetRefProblem(ref, jobId, party, seller, role) {
  if (!exactKeys(ref, ['anchor', 'contentHash', 'signer']) || !exactKeys(ref.anchor, ['kind', 'locator'])) return `${role} Vet ref is not an exact orchestrator-signed record ref`;
  if (ref.anchor.kind !== 'storage-program' || ref.anchor.locator !== compositeVerificationAddress(jobId, party)) return `${role} Vet ref is not at the canonical composite address`;
  if (!HEX64.test(ref.contentHash) || ref.signer !== seller) return `${role} Vet ref is not signed by the bound phase orchestrator`;
  return null;
}

function inputProblem(input, { scope, listing, buyerBundle }) {
  if (!exactKeys(input, INPUT_KEYS) || input.jobId !== scope.jobId) return 'context input is not the exact SDK derive input';
  const verified = input.verifiedListing;
  if (!exactKeys(verified, ['disposition', 'listing', 'pin']) || verified.disposition !== 'verified' || !same(verified.listing, listing)
      || !same(verified.pin, listingPin(listing)) || !same(verified.pin, scope.listingPin)) return 'verified Listing or pin differs';
  if (!exactKeys(input.buyer, ['identityBundle', 'vetRecordRef']) || !exactKeys(input.seller, ['identityBundle', 'vetRecordRef'])) return 'party context is not exact';
  if (!same(input.buyer.identityBundle, buyerBundle) || identityBundleHash(buyerBundle) !== scope.buyerBundleHash) return 'buyer identity differs';
  if (!same(input.seller.identityBundle, listing.seller.identity) || input.seller.identityBundle.presentedBy !== scope.seller) return 'seller identity differs';
  const vet = vetRefProblem(input.buyer.vetRecordRef, scope.jobId, scope.buyer, scope.seller, 'buyer')
    ?? vetRefProblem(input.seller.vetRecordRef, scope.jobId, scope.seller, scope.seller, 'seller');
  if (vet) return vet;
  if (!same(input.selectedRail, scope.rail)
      || !same(input.payoutBindings, [{ railId: DEM_RAIL.railId, phaseIndex: protocolSupport(listing).phases.payment, payeeAddress: scope.payee }])
      || input.generatedAt !== scope.generatedAt) return 'rail, payout, or generation time differs';
  return null;
}

function captureAnswer(answer, { scope, listing, buyerBundle }) {
  if (!object(answer)) return held('indeterminate', 'DEM_DELIVERY_CONTEXT_FAILED: no disposition');
  // Read once: a getter cannot pass a check with one value and reach the result with another.
  const disposition = answer.disposition;
  if (HELD.includes(disposition)) {
    const code = answer.code;
    return { ...held(disposition, answer.reason ?? 'context unavailable'), ...(HELD_CODES.has(code) ? { code } : {}) };
  }
  const value = disposition === 'present' ? answer.value : undefined;
  if (!exactKeys(value, ['input', 'scope'])) return held('indeterminate', 'DEM_DELIVERY_CONTEXT_FAILED: malformed result');
  if (!same(value.scope, scope)) return held('rejected', 'DEM_DELIVERY_CONTEXT_SCOPE_MISMATCH');
  let input;
  try { input = JSON.parse(canonicalize(value.input)); } catch { return held('rejected', 'DEM_DELIVERY_CONTEXT_INPUT_INVALID'); }
  const problem = inputProblem(input, { scope, listing, buyerBundle });
  return problem ? held('rejected', `DEM_DELIVERY_CONTEXT_INPUT_MISMATCH: ${problem}`) : { disposition: 'present', input };
}

// writable: the purchase check the provider re-runs before each Vet signature
// or anchor intent (true, or why no new write may start).
export async function resolveDemDeliveryBuyerContext(capability, { operation, listing, buyerBundle, generatedAt, writable }) {
  const configured = capabilityFor(capability);
  if (!configured) return { ...held('indeterminate', 'CONTEXT_PROVIDER_UNAVAILABLE: DEM delivery context capability is absent'), written: false };
  if (buyerBundle?.presentedBy !== claimForAddress(operation.terms.buyer.wallet)) return held('rejected', 'buyer bundle is not the purchase wallet identity');
  const scope = agreementContextScope({ operation, buyerBundle, generatedAt });
  let answer;
  try { answer = await configured.resolveBuyer(structuredClone({ scope, buyerIdentityBundle: buyerBundle }), ...(writable ? [{ writable }] : [])); }
  catch (error) { return held('indeterminate', `DEM delivery context failed: ${failureText(error)}`); }
  let captured;
  try { captured = captureAnswer(answer, { scope, listing, buyerBundle }); }
  catch { return held('indeterminate', 'DEM_DELIVERY_CONTEXT_FAILED: unreadable answer'); }
  return captured.disposition === 'present' ? { ...captured, scope, authority: configured.authority } : captured;
}

export async function resolveDemDeliverySellerContext(capability, { jobId, listing, buyerBundle, generatedAt }) {
  const configured = capabilityFor(capability);
  if (!configured) return held('indeterminate', 'DEM delivery context capability is absent');
  let answer;
  try { answer = await configured.resolveSeller(structuredClone({ jobId, listingPin: listingPin(listing), buyerIdentityBundle: buyerBundle, generatedAt })); }
  catch (error) { return held('indeterminate', `DEM delivery seller context failed: ${error?.message ?? error}`); }
  if (!object(answer) || answer.disposition !== 'present' || !object(answer.value) || !object(answer.value.input) || !Array.isArray(answer.value.vetRequirements)) {
    return held(answer?.disposition ?? 'indeterminate', answer?.reason ?? 'DEM delivery seller context is malformed');
  }
  const input = JSON.parse(canonicalize(answer.value.input));
  const syntheticScope = {
    jobId, buyer: buyerBundle.presentedBy, buyerBundleHash: identityBundleHash(buyerBundle), seller: listing.seller.identity.presentedBy,
    listingPin: listingPin(listing), rail: { railId: DEM_RAIL.railId, railVersion: DEM_RAIL.railVersion },
    payee: input.payoutBindings?.[0]?.payeeAddress, generatedAt,
  };
  const problem = inputProblem(input, { scope: syntheticScope, listing, buyerBundle });
  if (problem) return held('rejected', `DEM_DELIVERY_CONTEXT_INPUT_MISMATCH: ${problem}`);
  return { disposition: 'present', input, vetRequirements: JSON.parse(canonicalize(answer.value.vetRequirements)), authority: configured.authority };
}
