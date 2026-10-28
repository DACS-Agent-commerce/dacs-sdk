// Explicit process-local capability for fixed-price DEM context resolution.
// Present binds Agreement input and proves SDK derivability. Record signatures,
// requirement provenance, receipts and delivery readiness belong to admission.
import { canonicalize, compositeVerificationAddress, deriveFixedPriceAgreement, isAttestationRef, requireCanonicalJobId, sameCanonicalClaimIdentity } from '@kynesyslabs/dacs';
import { agreementInput, listingPin } from './purchase-protocol.mjs';
import { sellerSessionPresentationProblem } from './session-admission.mjs';
import { cutText } from '../util/text.mjs';
import { resolveWithDeadline, boundedResolutionValue } from '../util/bounded-resolution.mjs';

/** Fixed context limits; providers must also cap wire bytes before decoding. */
export const DEM_DELIVERY_CONTEXT_LIMITS = Object.freeze({ timeoutMs: 10_000, maxBytes: 64 * 1024, maxValues: 4096, maxDepth: 32, maxListEntries: 256, maxVetRequirements: 64 });
export const DEM_DELIVERY_CONTEXT_SOURCE = 'dacs-chatgpt-plugin/dem-delivery-context/v1';
const capabilities = new WeakMap();
const HELD = ['absent', 'rejected', 'indeterminate'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const snapshot = value => JSON.parse(canonicalize(value));
const held = (disposition, reason) => ({ disposition: HELD.includes(disposition) ? disposition : 'indeterminate', reason: cutText(reason, 240) });

/** Whether a bounded single-line TEST authority may label a capability. */
export const isDemDeliveryContextAuthority = value => typeof value === 'string' && /^TEST-[A-Za-z0-9._:-]{1,115}$/.test(value);

/** Register buyer/seller resolvers and optional lifecycle callbacks; throws on invalid configuration. */
export function createDemDeliveryContext({ authority, resolveBuyer, resolveSeller, release = null, usage = null }) {
  if (!isDemDeliveryContextAuthority(authority) || typeof resolveBuyer !== 'function' || typeof resolveSeller !== 'function' || (release !== null && typeof release !== 'function') || (usage !== null && typeof usage !== 'function')) {
    throw new TypeError('DEM delivery context requires explicit TEST authority and buyer/seller resolvers');
  }
  const capability = Object.freeze({ source: DEM_DELIVERY_CONTEXT_SOURCE, authority });
  capabilities.set(capability, { authority, resolveBuyer, resolveSeller, release, usage });
  return capability;
}

/** Admit a registered capability or explicit absence; throws for a copied descriptor. */
export function demDeliveryContextConfig(value) {
  if (value == null) return null;
  if (!capabilities.has(value)) throw new TypeError('demDeliveryContext requires a constructed application capability');
  return value;
}
const capabilityFor = value => capabilities.get(demDeliveryContextConfig(value));

/** Return synchronous usage or null; rejected/async usage is reported as an error. */
export function demDeliveryContextUsage(capability) {
  try {
    const value = capabilityFor(capability)?.usage?.() ?? null;
    if (typeof value?.then !== 'function') return value;
    Promise.resolve(value).catch(() => {});
  } catch { /* report callback/configuration failure */ }
  return { status: 'error' };
}

/** Best-effort eviction: generatedAt retains the saved plan; null ends the job.
 * Throws for a noncanonical job. Eviction cannot change purchase authority. */
export function releaseDemDeliveryContext(capability, { jobId, generatedAt = null }) {
  requireCanonicalJobId(jobId);
  try { Promise.resolve(capabilityFor(capability)?.release?.({ jobId, generatedAt })).catch(() => {}); } catch { /* eviction only */ }
}

function failureText(error) {
  try { return String(error?.message ?? error); } catch { return 'unreadable provider failure'; }
}

function reconstruct(input, expected) {
  const roles = [['buyer', expected.buyer.identityBundle.presentedBy, expected.seller.identityBundle.presentedBy],
    ['seller', expected.seller.identityBundle.presentedBy, expected.buyer.identityBundle.presentedBy]];
  for (const [role, party, verifier] of roles) {
    const ref = input[role]?.vetRecordRef;
    if (!isAttestationRef(ref) || typeof ref.signer !== 'string' || ref.anchor.kind !== 'storage-program'
        || ref.anchor.locator !== compositeVerificationAddress(expected.jobId, party) || !sameCanonicalClaimIdentity(ref.signer, verifier)) {
      return `${role} Vet ref is not at its canonical address with its counterparty verifier`;
    }
    expected[role].vetRecordRef = ref;
  }
  const sellerProblem = sellerSessionPresentationProblem(input.seller?.identityBundle, expected.seller.identityBundle);
  if (sellerProblem) return `seller identity differs: ${sellerProblem}`;
  expected.seller.identityBundle = input.seller.identityBundle;
  if (canonicalize(input) !== canonicalize(expected)) return 'input differs from the captured purchase';
  deriveFixedPriceAgreement(expected);
  return null;
}

/** Resolve bound, derivable seller input under read limits, or a held cause.
 * Throws for an invalid job or copied capability before invoking callbacks. */
export async function resolveDemDeliverySellerContext(capability, { jobId, listing, buyerBundle, generatedAt }) {
  requireCanonicalJobId(jobId);
  const configured = capabilityFor(capability);
  if (!configured) return held('indeterminate', 'DEM delivery context capability is absent');
  try {
    const local = snapshot({ jobId, listing, buyerBundle, generatedAt });
    const expected = agreementInput(local);
    const request = snapshot({ jobId: local.jobId, listingPin: listingPin(local.listing), buyerIdentityBundle: local.buyerBundle, generatedAt: local.generatedAt });
    const reply = await resolveWithDeadline(options => configured.resolveSeller(request, options), DEM_DELIVERY_CONTEXT_LIMITS);
    const answer = boundedResolutionValue(reply, DEM_DELIVERY_CONTEXT_LIMITS);
    const malformed = 'DEM delivery seller context is malformed';
    if (object(answer) && HELD.includes(answer.disposition)) {
      return held(answer.disposition, typeof answer.reason === 'string' ? answer.reason : malformed);
    }
    if (!object(answer) || answer.disposition !== 'present') {
      return held('indeterminate', typeof answer?.reason === 'string' ? answer.reason : malformed);
    }
    if (!object(answer.value) || !object(answer.value.input) || !Array.isArray(answer.value.vetRequirements)) return held('indeterminate', malformed);
    if (answer.value.vetRequirements.length > DEM_DELIVERY_CONTEXT_LIMITS.maxVetRequirements) return held('indeterminate', 'DEM delivery context exceeds Vet requirement limit');
    const input = snapshot(answer.value.input);
    const problem = reconstruct(input, expected);
    if (problem) return held('rejected', `DEM_DELIVERY_CONTEXT_INPUT_MISMATCH: ${problem}`);
    return { disposition: 'present', input: snapshot(expected), vetRequirements: snapshot(answer.value.vetRequirements), authority: configured.authority };
  } catch (error) { return held('indeterminate', `DEM delivery seller context failed: ${failureText(error)}`); }
}
