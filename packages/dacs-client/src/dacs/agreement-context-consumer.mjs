// Buyer-side consumer of an operator-configured Agreement context for the
// opt-in offline wallet Agreement profile (protocol-purchases.mjs).
//
// The provider is programmatic server configuration (dacsProtocol
// .agreementContext = { authority, resolve }), never an MCP/model/portal
// argument. It returns the already authenticated, pinned full SDK
// deriveFixedPriceAgreement input: the verified Listing (exact bytes and pin),
// both IdentityBundles, both Vet record refs, the native rail, the seller payout
// binding and generatedAt. This module performs no Vet, Listing reader,
// revocation or rail authority of its own and promotes nothing to verified: it
// only checks that the provider's answer binds exactly the scope this purchase
// already fixed (account, operation, wallet, job, buyer identity, Listing pin
// and bytes, rail, payee, price, time) and that both Vet refs are real record
// refs at the canonical composite address, not the not-performed placeholder.
// Anything absent, indeterminate, malformed or out of scope is held; the caller
// then plans, saves and signs nothing.
import { canonicalize, compositeVerificationAddress, identityBundleHash } from '@kynesyslabs/dacs';
import { DEM_RAIL } from './listing.mjs';
import { claimForAddress } from '../signatures.mjs';
import { listingPin, protocolSupport, vetNotPerformedRef } from './purchase-protocol.mjs';

export const AGREEMENT_CONTEXT_SOURCE = 'dacs-chatgpt-plugin/operator-agreement-context/v1';

const DID = /^did:demos:agent:[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const INPUT_KEYS = ['buyer', 'generatedAt', 'jobId', 'payoutBindings', 'selectedRail', 'seller', 'verifiedListing'];
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (v, keys) => isPlain(v) && canonicalize(Object.keys(v).sort()) === canonicalize([...keys].sort());
const same = (a, b) => { try { return canonicalize(a) === canonicalize(b); } catch { return false; } };
const HELD = ['absent', 'rejected', 'indeterminate'];
// Total: whatever disposition it is given, a held result is never `present`.
const held = (disposition, reason) => ({ disposition: HELD.includes(disposition) ? disposition : 'indeterminate', reason: String(reason).slice(0, 240) });
// A provider's answer is read only inside a try, each of its fields once, and
// its thrown value only through failureText(): nothing it returns or throws can
// escape as a server error with no attempt recorded for a possible write.
const failureText = (error) => { try { return String(error?.message ?? error); } catch { return 'unreadable error'; } };

// The provider's authority label: one lowercase line of at most 120 characters.
// The purchase receipt accepts a stored resolution marker only with this label.
export const isOperatorContextAuthority = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9:/._-]{0,119}$/.test(value);

// Validated once at server construction; a malformed provider is a startup
// error, never a silent fallback to the placeholder profile.
export function agreementContextConfig(value) {
  if (value === undefined || value === null) return null;
  if (!exactKeys(value, ['authority', 'resolve']) || typeof value.resolve !== 'function' || !isOperatorContextAuthority(value.authority)) {
    throw new TypeError('dacsProtocol.agreementContext must be exactly { authority, resolve } with a labelled authority');
  }
  return Object.freeze({ authority: value.authority, resolve: value.resolve });
}

// The exact purchase scope the provider must bind and echo.
export function agreementContextScope({ operation, buyerBundle, generatedAt }) {
  const t = operation.terms;
  return {
    source: AGREEMENT_CONTEXT_SOURCE,
    account: operation.accountId,
    operation: operation.id,
    wallet: t.buyer.wallet,
    jobId: t.protocol.jobId,
    buyer: buyerBundle.presentedBy,
    buyerBundleHash: identityBundleHash(buyerBundle),
    seller: t.seller.claim,
    listingPin: { listingId: t.listing.listingId, version: t.listing.version, contentHash: t.listing.contentHash },
    rail: { railId: DEM_RAIL.railId, railVersion: DEM_RAIL.railVersion },
    payee: t.seller.payee,
    price: structuredClone(t.price),
    generatedAt,
  };
}

function vetRefProblem(ref, jobId, party, role) {
  if (!exactKeys(ref, ['anchor', 'contentHash', 'signer']) || !exactKeys(ref.anchor, ['kind', 'locator'])) return `${role} Vet ref is not an exact signed record ref`;
  if (ref.anchor.kind !== 'storage-program' || ref.anchor.locator !== compositeVerificationAddress(jobId, party)) return `${role} Vet ref is not at the canonical composite address for this job and party`;
  if (!HEX64.test(ref.contentHash) || ref.contentHash === vetNotPerformedRef(jobId, party).contentHash) return `${role} Vet ref is not a record content hash`;
  if (!DID.test(ref.signer) || ref.signer === party) return `${role} Vet ref has no independent record signer`;
  return null;
}

// Checks only binding to facts this purchase already fixed; trust in the
// provider's `verified` Listing and Vet refs is the operator's configuration.
function inputProblem(input, { scope, listing, buyerBundle }) {
  if (!exactKeys(input, INPUT_KEYS)) return 'context input is not exactly the SDK derive input';
  if (input.jobId !== scope.jobId) return 'job differs';
  const v = input.verifiedListing;
  if (!exactKeys(v, ['disposition', 'listing', 'pin']) || v.disposition !== 'verified') return 'Listing is not provider-verified';
  if (!same(v.listing, listing)) return 'Listing bytes differ from the Listing this purchase verified';
  if (!same(v.pin, listingPin(listing)) || !same(v.pin, scope.listingPin)) return 'Listing pin differs';
  if (!exactKeys(input.buyer, ['identityBundle', 'vetRecordRef']) || !exactKeys(input.seller, ['identityBundle', 'vetRecordRef'])) return 'party context is not exact';
  if (!same(input.buyer.identityBundle, buyerBundle)) return 'buyer identity differs from the wallet-presented bundle';
  if (!same(input.seller.identityBundle, listing.seller.identity) || input.seller.identityBundle.presentedBy !== scope.seller) return 'seller identity differs from the signed Listing';
  const vet = vetRefProblem(input.buyer.vetRecordRef, scope.jobId, scope.buyer, 'buyer') ?? vetRefProblem(input.seller.vetRecordRef, scope.jobId, scope.seller, 'seller');
  if (vet) return vet;
  if (!same(input.selectedRail, scope.rail)) return 'rail differs';
  if (!same(input.payoutBindings, [{ railId: DEM_RAIL.railId, phaseIndex: protocolSupport(listing).phases.payment, payeeAddress: scope.payee }])) return 'payout binding differs from the prepared payee';
  if (input.generatedAt !== scope.generatedAt) return 'generatedAt differs';
  return null;
}

// One provider read. `present` carries a plain clone of the bound input.
export async function resolveAgreementContext(config, { operation, listing, buyerBundle, generatedAt }) {
  // No provider was invoked, so nothing was written (ops health trusts this mark, not the text).
  if (!config) return { ...held('indeterminate', 'CONTEXT_PROVIDER_UNAVAILABLE: no operator Agreement context provider is configured'), written: false };
  if (buyerBundle?.presentedBy !== claimForAddress(operation.terms.buyer.wallet)) return held('rejected', 'CONTEXT_SCOPE_MISMATCH: buyer bundle is not the purchase wallet identity');
  const scope = agreementContextScope({ operation, buyerBundle, generatedAt });
  let answer;
  try {
    answer = await config.resolve(structuredClone({ scope, buyerIdentityBundle: buyerBundle }));
  } catch (error) {
    return held('indeterminate', `CONTEXT_PROVIDER_FAILED: ${failureText(error)}`);
  }
  try {
    return captureAnswer(answer, { scope, listing, buyerBundle, authority: config.authority });
  } catch {
    return held('indeterminate', 'CONTEXT_PROVIDER_FAILED: unreadable answer');
  }
}

function captureAnswer(answer, { scope, listing, buyerBundle, authority }) {
  if (!isPlain(answer)) return held('indeterminate', 'CONTEXT_PROVIDER_FAILED: no disposition');
  // Read once: a getter cannot pass a check with one value and reach the result with another.
  const disposition = answer.disposition;
  if (HELD.includes(disposition)) {
    const reason = answer.reason;
    return held(disposition, `CONTEXT_${disposition.toUpperCase()}: ${typeof reason === 'string' ? reason : 'no reason'}`);
  }
  const value = disposition === 'present' ? answer.value : undefined;
  if (!exactKeys(value, ['input', 'scope'])) return held('indeterminate', 'CONTEXT_PROVIDER_FAILED: unknown disposition');
  if (!same(value.scope, scope)) return held('rejected', 'CONTEXT_SCOPE_MISMATCH: provider bound another purchase scope');
  let input;
  try { input = JSON.parse(canonicalize(value.input)); } catch { return held('rejected', 'CONTEXT_INPUT_INVALID: not canonical JSON'); }
  const problem = inputProblem(input, { scope, listing, buyerBundle });
  if (problem) return held('rejected', `CONTEXT_INPUT_MISMATCH: ${problem}`);
  return { disposition: 'present', input, scope, authority };
}
