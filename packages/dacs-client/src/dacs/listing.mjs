// Listing construction (for wallet signing) and Standard validation.
//
// Contracts: DACS-Standard d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20,
// CORE CF-1 / CF-2 / SIG-1 and DACS-1 Listing reader. Implementation imports
// resolve to this repository's SDK workspace; no historical demo is authority.
import {
  canonicalize,
  contentHash,
  sha256Hex,
  signedBytes,
  ed25519Verify,
  publicKeyFromRaw,
  identityBundleHash,
  isIdentityBundle,
  isListingDraft,
  validateListingArtifact,
  listingAddress,
  baseUnits,
  canonicalizeDecimal,
  DACS_STANDARD_PIN,
  VERSION as DACS_SDK_VERSION,
} from '@kynesyslabs/dacs';
import { addressForClaim, claimForAddress, decodeSignature } from '../signatures.mjs';
import { OS_INTEGER, OS_VERIFIABLE_MAX } from './chain.mjs';

export const DEM_RAIL = Object.freeze({ railId: 'demos-native:DEM', railVersion: 1 });
export const DEM_DECIMALS = 9;
export const SDK_PROVENANCE = Object.freeze({
  package: '@kynesyslabs/dacs',
  version: DACS_SDK_VERSION,
  source: '@kynesyslabs/dacs package implementation',
  standardPin: DACS_STANDARD_PIN,
});

const DID_PREFIX = 'did:demos:agent:';
const LISTING_SEPARATOR = 'dacs-listing:v1:';
const PRESENTATION_SEPARATOR = 'dacs-bundle-presentation:v1:';

export function utf8(bytes) {
  return Buffer.from(bytes).toString('utf8');
}

// Wallets sign raw UTF-8 messages; DACS signed_bytes are UTF-8(separator || hex hash),
// so the wallet message is exactly that string.
export function listingSigningMessage(draft) {
  return utf8(signedBytes(LISTING_SEPARATOR, contentHash(draft)));
}

export function verifyComponent({ signedBytes: bytes, signature }) {
  if (signature?.algorithm !== 'ed25519' || typeof signature.value !== 'string' || !signature.signer?.startsWith(DID_PREFIX)) return false;
  try {
    const raw = Buffer.from(signature.signer.slice(DID_PREFIX.length), 'hex');
    if (raw.length !== 32) return false;
    return ed25519Verify(bytes, Buffer.from(signature.value, 'base64url'), publicKeyFromRaw(raw));
  } catch {
    return false;
  }
}

export function buildUnsignedIdentityBundle({ address, presentedAt, sessionSeed }) {
  const claim = claimForAddress(address);
  const bundle = {
    bundleVersion: '1',
    presentedBy: claim,
    presentedAt,
    sessionNonce: sha256Hex(`dacs-chatgpt-plugin:${sessionSeed}:${claim}:${presentedAt}`),
    claims: [{ ref: claim }],
  };
  const bundleHash = sha256Hex(canonicalize(bundle));
  return { bundle, bundleHash, message: utf8(signedBytes(PRESENTATION_SEPARATOR, bundleHash)) };
}

export function attachIdentityPresentation({ bundle, bundleHash }, walletSignature) {
  const value = decodeSignature(walletSignature).toString('base64url');
  const signed = { ...structuredClone(bundle), presentation: { kind: 'per-claim', signatures: [{ ref: bundle.presentedBy, signature: value }] } };
  if (!isIdentityBundle(signed) || identityBundleHash(signed) !== bundleHash) throw new Error('identity bundle does not preserve its signed scope');
  const ok = verifyComponent({
    signedBytes: signedBytes(PRESENTATION_SEPARATOR, bundleHash),
    signature: { algorithm: 'ed25519', signer: bundle.presentedBy, value },
  });
  if (!ok) throw new Error('identity presentation signature does not verify for the agent wallet');
  return signed;
}

export function normalizeDemAmount(value) {
  const amount = canonicalizeDecimal(String(value));
  const os = baseUnits(amount, DEM_DECIMALS);
  // No balance has more OS digits (chain.mjs), so a longer price could never be
  // paid.
  if (!OS_INTEGER.test(os)) throw new Error('price is longer than any Demos balance');
  if (BigInt(os) <= 0n) throw new Error('price must be positive');
  // A payment above OS_VERIFIABLE_MAX could be sent but never read back
  // (chain.mjs). Rejecting it here keeps it out of every listing draft, buyer
  // purchase (purchaseSupport) and seller session (protocolSupport).
  if (BigInt(os) > OS_VERIFIABLE_MAX) throw Object.assign(new Error(`price exceeds ${OS_VERIFIABLE_MAX} OS, the largest payment a Demos transaction read can verify`), { code: 'price_unverifiable' });
  return { amount, amountOs: os };
}

// Why a Listing's price is not a payable and verifiable DEM amount, or null.
export function demPriceProblem(listing) {
  try {
    normalizeDemAmount(listing?.pricing?.price?.amount);
    return null;
  } catch (error) {
    return error?.code === 'price_unverifiable' ? error.message : 'price amount is not a positive DEM decimal';
  }
}

export function buildListingDraft({
  identityBundle,
  displayName,
  publicEndpoint,
  listingId,
  listingVersion,
  title,
  description,
  category,
  tags,
  priceDem,
  notBefore,
  notAfter,
  deadlineSecAfterCommit = 3600,
}) {
  const { amount } = normalizeDemAmount(priceDem);
  const draft = {
    dacsVersion: '1',
    listingVersion,
    listingId,
    requiredCapabilities: ['SR-1', 'SR-2'],
    seller: { identity: structuredClone(identityBundle), displayName, publicEndpoint },
    offering: {
      title,
      description,
      category,
      tags,
      deliverable: { kind: 'storage-program', schemaUrl: 'urn:dacs-chatgpt-plugin:v0.1:seller-defined-delivery', accessModel: 'public' },
    },
    buyerRequirement: { requirementVersion: '1', required: [], preferredPresentation: 'any' },
    pipeline: [
      { kind: 'negotiate-fixed-price' },
      { kind: 'commit-payee-bound-agreement' },
      { kind: 'pay-dem', parameters: { rail: DEM_RAIL.railId } },
      { kind: 'deliver-storage-program' },
    ],
    pricing: { kind: 'fixed', price: { amount, currency: 'DEM' } },
    acceptedRails: [{ ...DEM_RAIL }],
    terms: { deadlineSecAfterCommit, cancellationPolicy: 'pre-commit', transcriptDisclosurePolicy: 'encrypted-anchored-recommended' },
    validity: notAfter === undefined ? { notBefore } : { notBefore, notAfter },
  };
  if (!isListingDraft(draft)) throw new Error('the pinned SDK rejected this listing draft');
  return draft;
}

export function attachListingSignature(draft, walletSignature) {
  const signer = draft.seller.identity.presentedBy;
  const value = decodeSignature(walletSignature).toString('base64url');
  const listing = { ...structuredClone(draft), signature: { algorithm: 'ed25519', signer, value } };
  if (!verifyComponent({ signedBytes: signedBytes(LISTING_SEPARATOR, contentHash(draft)), signature: listing.signature })) {
    throw new Error('listing signature does not verify for the agent wallet');
  }
  return listing;
}

export function logicalListingAddress(listing) {
  return listingAddress(listing.seller.identity.presentedBy, listing.listingId, listing.listingVersion);
}

// Ordered DACS-1 reader via the SDK. Revocation surfaces come from the caller;
// a missing or stale catalog observation yields `indeterminate`, never `absent`.
export async function validateListing(listing, { now, revocationSurfaces, readMarker }) {
  return validateListingArtifact(listing, {
    nowMs: () => now(),
    verifyListingSignature: verifyComponent,
    verifyIdentityPresentation: ({ bundle, signedBytes: bytes }) => {
      const proof = bundle.presentation?.kind === 'per-claim' && bundle.presentation.signatures.find((entry) => entry.ref === bundle.presentedBy);
      return Boolean(proof && verifyComponent({ signedBytes: bytes, signature: { algorithm: 'ed25519', signer: bundle.presentedBy, value: proof.signature } }));
    },
    verifySellerControl: ({ bundle, signer }) => bundle.presentedBy === signer && bundle.claims.some((claim) => claim.ref === signer),
    revocation: { surfaces: revocationSurfaces, readMarker, verifyMarkerSignature: verifyComponent },
    loadRailResolution: () => ({
      trustPhase: 'PA-1',
      trustPolicyAcceptsPA1: true,
      registry: { state: 'not-used', entries: [], definitions: [] },
      inCodeDefinitions: [{ railId: DEM_RAIL.railId, railVersion: DEM_RAIL.railVersion, phaseHandler: 'pay-dem', governanceAnchoring: 'in-code', signatureValid: true, availability: 'disabled' }],
    }),
  });
}

// The Listing's declared deliverable access model. Absent means public (as
// the SDK fulfilment reader); any other value, including an unknown one, is
// returned as declared and treated as non-public.
export function deliverableAccessModel(listing) {
  const deliverable = listing?.offering?.deliverable;
  return deliverable?.accessModel === undefined ? 'public' : deliverable.accessModel;
}

// This client writes and reads only public storage programs, so it can never
// satisfy a declared non-public deliverable (DACS-4 §9.6.1 DV-2).
export function deliverableAccessProblem(listing) {
  const model = deliverableAccessModel(listing);
  return model === 'public' ? null : `deliverable accessModel ${typeof model === 'string' ? model.slice(0, 64) : 'is malformed and'} is not public; this client reads only public deliverables (DACS-4 §9.6.1 DV-2)`;
}

// v0.1 transacts only fixed-price native DEM listings. Anything else stays
// discoverable but is reported as unsupported for purchase.
export function purchaseSupport(listing) {
  const reasons = ['rail availability is not authenticated; purchase actions are held'];
  const access = deliverableAccessProblem(listing);
  if (access) reasons.push(access);
  if (listing?.pricing?.kind !== 'fixed') reasons.push('pricing is not fixed-price');
  if (listing?.pricing?.price?.currency !== 'DEM') reasons.push('price currency is not DEM');
  const priceProblem = demPriceProblem(listing);
  if (priceProblem) reasons.push(priceProblem);
  const amount = priceProblem ? null : normalizeDemAmount(listing.pricing.price.amount);
  const rails = Array.isArray(listing?.acceptedRails) ? listing.acceptedRails : [];
  // DACS-1 LRR-3 / LRR-6: a present railVersion must be exactly the version
  // this client implements; an absent one means the latest version, which in
  // the client's in-code PA-1 resolution (validateListing) is that same one.
  if (!rails.some((rail) => rail?.railId === DEM_RAIL.railId && (rail?.railVersion === undefined || rail.railVersion === DEM_RAIL.railVersion))) reasons.push(`listing does not accept demos-native:DEM version ${DEM_RAIL.railVersion}`);
  const pipeline = Array.isArray(listing?.pipeline) ? listing.pipeline : [];
  if (!pipeline.some((phase) => phase?.kind === 'pay-dem' && phase?.parameters?.rail === DEM_RAIL.railId)) reasons.push('pipeline has no pay-dem phase on demos-native:DEM');
  if (pipeline.some((phase) => /^negotiate-/.test(phase?.kind ?? '') && phase.kind !== 'negotiate-fixed-price')) reasons.push('negotiation is not fixed-price');
  let payee = null;
  try {
    payee = addressForClaim(listing?.seller?.identity?.presentedBy);
  } catch {
    reasons.push('seller is not a did:demos:agent claim');
  }
  return {
    supported: reasons.length === 0,
    reasons,
    price: amount ? { amount: amount.amount, currency: 'DEM', amountOs: amount.amountOs } : null,
    payee,
  };
}

export { contentHash, canonicalize };
