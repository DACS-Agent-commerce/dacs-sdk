// Run-time port of http-mcp/src/dacs/listing.mjs at DACS-Agent-commerce/frontend 15fdf23: the
// whole file.
// Listing construction (for wallet signing) and Standard validation.
//
// Provenance:
//  - Signing bytes, hashing and the ordered reader come from this repository's
//    @kynesyslabs/dacs peer at the seller package's version, with its embedded
//    Standard pin exposed as DACS_STANDARD_PIN. This is not a claim of complete
//    Standard v0.4 conformance.
//  - validateListingArtifact dependency wiring is adapted from
//    agent-commerce-demo v2/live/sdk-admission.mjs (ab41d3a).
//  - Identity bundle shape is adapted from agent-commerce-demo lib/workflow.mjs identity().
import {
  canonicalize,
  contentHash,
  sha256Hex,
  signedBytes,
  ed25519Verify,
  publicKeyFromRaw,
  canonicalDemosAgentPublicKey,
  sameCanonicalClaimIdentity,
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
import { addressForClaim, claimForAddress, decodeSignature, isCanonicalEd25519Signature } from './demos-claims.mjs';
import { OS_INTEGER } from './chain.mjs';

export const DEM_RAIL = Object.freeze({ railId: 'demos-native:DEM', railVersion: 1 });
export const DEM_DECIMALS = 9;
export const SDK_PROVENANCE = Object.freeze({
  package: '@kynesyslabs/dacs',
  version: DACS_SDK_VERSION,
  source: 'the @kynesyslabs/dacs peer dependency at this package\'s own version, built from the same repository',
  standardPin: DACS_STANDARD_PIN,
});

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

export function verifyComponent(input) {
  try {
    const { signedBytes: bytes, signature } = input;
    if (signature?.algorithm !== 'ed25519' || !isCanonicalEd25519Signature(signature.value)) return false;
    const raw = canonicalDemosAgentPublicKey(signature.signer);
    if (!raw) return false;
    return ed25519Verify(bytes, Buffer.from(signature.value, 'base64url'), publicKeyFromRaw(raw));
  } catch {
    return false;
  }
}

// `sessionNonce`, when given, is the challenge the seller issued for this
// presentation (CORE SN-1..SN-3: lowercase hex, 32 to 128 characters) and is
// presented as it is; without it the nonce is derived from `sessionSeed`, which
// a seller host that issues its own challenges refuses.
export function buildUnsignedIdentityBundle({ address, presentedAt, sessionSeed, sessionNonce }) {
  const claim = claimForAddress(address);
  if (sessionNonce !== undefined && (typeof sessionNonce !== 'string' || !/^[0-9a-f]{32,128}$/.test(sessionNonce))) throw new TypeError('sessionNonce must be the issued challenge: lowercase hex of 32 to 128 characters');
  const bundle = {
    bundleVersion: '1',
    presentedBy: claim,
    presentedAt,
    sessionNonce: sessionNonce ?? sha256Hex(`dacs-chatgpt-plugin:${sessionSeed}:${claim}:${presentedAt}`),
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
  if (typeof value !== 'string') throw new TypeError('DEM price must be decimal text');
  const amount = canonicalizeDecimal(value);
  const os = baseUnits(amount, DEM_DECIMALS);
  // No balance has more OS digits (chain.mjs), so a longer price could never be
  // paid; rejecting it here keeps it out of every listing, purchase and result.
  if (!OS_INTEGER.test(os)) throw new Error('price is longer than any Demos balance');
  if (BigInt(os) <= 0n) throw new Error('price must be positive');
  return { amount, amountOs: os };
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
  expectedSizeBytes,
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
      deliverable: { ...(expectedSizeBytes === undefined ? {} : { expectedSizeBytes }), kind: 'storage-program', schemaUrl: 'urn:dacs-chatgpt-plugin:v0.1:seller-defined-delivery', accessModel: 'public' },
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
// Rail authority must be authenticated by the caller; missing authority is indeterminate.
export async function validateListing(listing, { now, revocationSurfaces, readMarker, loadRailResolution }) {
  return validateListingArtifact(listing, {
    nowMs: () => now(),
    verifyListingSignature: verifyComponent,
    verifyIdentityPresentation: ({ bundle, signedBytes: bytes }) => {
      const proof = bundle.presentation?.kind === 'per-claim' && bundle.presentation.signatures.find((entry) => sameCanonicalClaimIdentity(entry.ref, bundle.presentedBy));
      return Boolean(proof && verifyComponent({ signedBytes: bytes, signature: { algorithm: 'ed25519', signer: bundle.presentedBy, value: proof.signature } }));
    },
    verifySellerControl: ({ bundle, signer }) => sameCanonicalClaimIdentity(bundle.presentedBy, signer) && bundle.claims.some((claim) => sameCanonicalClaimIdentity(claim.ref, signer)),
    revocation: { surfaces: revocationSurfaces, readMarker, verifyMarkerSignature: verifyComponent },
    loadRailResolution,
  });
}

const SUPPORTED_PHASES = Object.freeze(['negotiate-fixed-price', 'commit-payee-bound-agreement', 'pay-dem', 'deliver-storage-program']);

// v0.1 transacts only fixed-price native DEM listings. Anything else stays
// discoverable but is reported as unsupported for purchase.
export function purchaseSupport(listing) {
  const reasons = [];
  if (listing?.pricing?.kind !== 'fixed') reasons.push('pricing is not fixed-price');
  if (listing?.pricing?.price?.currency !== 'DEM') reasons.push('price currency is not DEM');
  let amount = null;
  try {
    amount = normalizeDemAmount(listing?.pricing?.price?.amount);
  } catch {
    reasons.push('price amount is not a positive DEM decimal');
  }
  const rails = Array.isArray(listing?.acceptedRails) ? listing.acceptedRails : [];
  if (!rails.some((rail) => rail?.railId === DEM_RAIL.railId && rail.railVersion === DEM_RAIL.railVersion)) reasons.push('listing does not accept demos-native:DEM');
  const pipeline = Array.isArray(listing?.pipeline) ? listing.pipeline : [];
  if (!pipeline.some((phase) => phase?.kind === 'pay-dem' && phase?.parameters?.rail === DEM_RAIL.railId)) reasons.push('pipeline has no pay-dem phase on demos-native:DEM');
  if (pipeline.length !== SUPPORTED_PHASES.length || !SUPPORTED_PHASES.every((kind, index) => pipeline[index]?.kind === kind)) reasons.push('pipeline is outside the fixed-price DEM storage profile');
  if (listing?.offering?.deliverable?.kind !== 'storage-program' || listing.offering.deliverable.accessModel !== 'public') reasons.push('delivery is not public storage-program');
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
