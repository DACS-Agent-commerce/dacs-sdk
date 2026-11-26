// Explicit process-local capability for fixed-price DEM context resolution.
// Present binds Agreement input and proves SDK derivability. Record signatures,
// requirement provenance, receipts and delivery readiness belong to admission.
// The capability is built in one Vet mode and keeps it: the default counterparty
// mode (the buyer verifies the seller's record; a seller presentation of the
// Listing bundle is accepted) or the TP-1 G3 orchestrator mode "W" (the seller
// verifies both records; only the exact Listing seller bundle is accepted).
import { canonicalize, compositeVerificationAddress, deriveFixedPriceAgreement, isAttestationRef, requireCanonicalJobId, sameCanonicalClaimIdentity, sellerFulfilmentVetModeOf } from '@kynesyslabs/dacs';
import { isDemDeliveryContextAuthority } from '@kynesyslabs/dacs-client';
import { isTp1AuthorityToken } from '@kynesyslabs/dacs-client/node-wallet';
import { assertKitOperationAdmitted } from '../kit-operation-guard.mjs';
import { admitKitCapabilityAuthority } from './capability-authority.mjs';
import { agreementInput, listingPin } from './purchase-protocol.mjs';
import { isOrchestratorVetMode, sellerBundleProblem, sellerRecordVerifier } from './session-admission.mjs';
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

/** Whether a value is a canonical `TEST-` or `TP1-` label string (the client's predicate). A label names an authority and grants none. */
export { isDemDeliveryContextAuthority };

const HOST_CALLBACKS = ['recoverBuyer', 'resumableBuyer', 'bindRetainedScope'];
const refuseConfiguration = () => { throw new TypeError('DEM delivery context requires explicit TEST authority or bound TP-1 token and buyer/seller resolvers'); };

/** Register buyer/seller resolvers and optional lifecycle callbacks in one Vet mode
 * (`vetMode`, default counterparty); throws on invalid configuration or an unsupported mode.
 * `authority` is a `TEST-` label or a TP-1 token admitted for `binding`, the composition's own binding; the capability keeps
 * the label. A token throws kit_operation_guard_off, profile_not_admitted (hold held) or authority_unbound (another binding), as a `TP1-` string does.
 * `recoverBuyer`, `resumableBuyer` and `bindRetainedScope` are the callbacks the seller host
 * needs (see `demDeliveryContextHost`); each must be a function when given. */
export function createDemDeliveryContext({ authority, binding, vetMode, resolveBuyer, resolveSeller, release = null, usage = null, recoverBuyer = null, resumableBuyer = null, bindRetainedScope = null }) {
  if (isTp1AuthorityToken(authority)) assertKitOperationAdmitted('createDemDeliveryContext');
  const hostCallbacks = { recoverBuyer, resumableBuyer, bindRetainedScope };
  if (typeof resolveBuyer !== 'function' || typeof resolveSeller !== 'function' || (release !== null && typeof release !== 'function') || (usage !== null && typeof usage !== 'function')
    || HOST_CALLBACKS.some(key => hostCallbacks[key] !== null && typeof hostCallbacks[key] !== 'function')) {
    refuseConfiguration();
  }
  const label = admitKitCapabilityAuthority(authority, { binding, refuse: refuseConfiguration });
  const mode = sellerFulfilmentVetModeOf(vetMode);
  if (mode === null) throw new TypeError('DEM delivery context vetMode is not a supported fulfilment Vet mode');
  const capability = Object.freeze({ source: DEM_DELIVERY_CONTEXT_SOURCE, authority: label });
  capabilities.set(capability, { authority: label, vetMode: mode, resolveBuyer, resolveSeller, release, usage, ...hostCallbacks });
  return capability;
}

// A host call carries the attempt's write check and cancellation signal; a missing check must never default to "writable".
const hostCall = callback => async (input, options) => {
  if (!object(input) || typeof options?.writable !== 'function' || !(options.signal instanceof AbortSignal)) throw new TypeError('a host context call needs its input and a writable check and abort signal');
  return callback(input, options);
};

/**
 * The calls the seller host makes on a registered capability: `resolveBuyer`, `recoverBuyer` and `resumableBuyer`
 * (each takes `(input, { writable, signal })`, hands both objects to the provider's callback unchanged and rejects
 * with a TypeError when the options are missing) and `bindRetainedScope(reader)`, which returns the provider's pinned
 * `{ sellerBundlePresentedBy }`. Throws a TypeError for a copied descriptor or a capability built without the recovery callbacks.
 */
export function demDeliveryContextHost(capability) {
  const configured = capabilities.get(capability);
  if (!configured || HOST_CALLBACKS.some(key => typeof configured[key] !== 'function')) throw new TypeError('the seller host requires a constructed capability with the recovery and binding callbacks');
  return Object.freeze({
    resolveBuyer: hostCall(configured.resolveBuyer),
    recoverBuyer: hostCall(configured.recoverBuyer),
    resumableBuyer: hostCall(configured.resumableBuyer),
    bindRetainedScope(reader) {
      const bound = configured.bindRetainedScope(reader);
      if (typeof bound?.sellerBundlePresentedBy !== 'string' || bound.sellerBundlePresentedBy === '') throw new TypeError('the provider named no seller presenter');
      return Object.freeze({ sellerBundlePresentedBy: bound.sellerBundlePresentedBy });
    },
  });
}

/** Admit a registered capability or explicit absence; throws for a copied descriptor. */
export function demDeliveryContextConfig(value) {
  if (value == null) return null;
  if (!capabilities.has(value)) throw new TypeError('demDeliveryContext requires a constructed application capability');
  return value;
}
const capabilityFor = value => capabilities.get(demDeliveryContextConfig(value));

/** The Vet mode a registered capability was built in; throws for an absent or copied descriptor. */
export function demDeliveryContextVetMode(capability) {
  const configured = capabilityFor(capability);
  if (!configured) throw new TypeError('demDeliveryContext requires a constructed application capability');
  return configured.vetMode;
}

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

function reconstruct(input, expected, vetMode) {
  const buyerClaim = expected.buyer.identityBundle.presentedBy, sellerClaim = expected.seller.identityBundle.presentedBy;
  const roles = [['buyer', buyerClaim, sellerClaim], ['seller', sellerClaim, sellerRecordVerifier(vetMode, sellerClaim, buyerClaim)]];
  for (const [role, party, verifier] of roles) {
    const ref = input[role]?.vetRecordRef;
    if (!isAttestationRef(ref)) return `${role} Vet ref is not an exact signed record ref`;
    if (ref.anchor.kind !== 'storage-program' || ref.anchor.locator !== compositeVerificationAddress(expected.jobId, party)) {
      return `${role} Vet ref is not at the canonical composite address`;
    }
    if (typeof ref.signer !== 'string' || !sameCanonicalClaimIdentity(ref.signer, verifier)) {
      return isOrchestratorVetMode(vetMode) && role === 'seller' ? 'seller Vet ref is not signed by the seller as orchestrator verifier' : `${role} Vet ref is not signed by its counterparty verifier`;
    }
    expected[role].vetRecordRef = ref;
  }
  const sellerProblem = sellerBundleProblem(input.seller?.identityBundle, expected.seller.identityBundle, vetMode);
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
    const problem = reconstruct(input, expected, configured.vetMode);
    if (problem) return held('rejected', `DEM_DELIVERY_CONTEXT_INPUT_MISMATCH: ${problem}`);
    return { disposition: 'present', input: snapshot(expected), vetRequirements: snapshot(answer.value.vetRequirements), authority: configured.authority, vetMode: configured.vetMode };
  } catch (error) { return held('indeterminate', `DEM delivery seller context failed: ${failureText(error)}`); }
}
