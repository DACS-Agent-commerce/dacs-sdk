// Discovery document and endpoint proof (new).
//
// The seller serves GET /.well-known/dacs-seller.json: a document signed by
// its Listing key under `dacs-seller-http:v1:discovery:`. Before anything is
// signed for a purchase, the buyer accepts the endpoint only if the signer is
// the verified Listing's seller and `publicEndpoint` equals the Listing's value
// byte for byte. This stops a Listing from aiming buyer traffic at a server its
// seller does not control. The document carries the TP-1 profile and states
// the TP-1 restrictions as its capabilities.
import { snapshotWireJsonRead } from "../canonical/snapshot.js";
import { canonicalize } from "../canonical/jcs.js";
import { assertPeerProfile, assertTp1Binding, isTp1WireProfile, TP1_CAPABILITIES, type Tp1Binding, type Tp1WireProfile } from "./profile.js";
import { DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_LIMITS, DACS_SELLER_HTTP_V1 } from "./routes.js";
import {
  admitWireJson, claimKey, cloneJson, envelopeSignatureBytes, fail, hasKeys, isClaim, isListingPin, isUint,
  lacksProfile, ownedArtifact, deepFreeze, ownedFields, uncurry, sameCanonical, verifyEd25519, type JsonRecord, type ListingPin, type WireSigner,
} from "./validate.js";

export const DACS_SELLER_DISCOVERY_FORMAT = "dacs-seller-discovery/v1";

export interface DiscoveryPayload {
  format: typeof DACS_SELLER_DISCOVERY_FORMAT;
  profile: Tp1WireProfile;
  seller: string;
  publicEndpoint: string;
  transport: [typeof DACS_SELLER_HTTP_V1];
  listings: ListingPin[];
  capabilities: typeof TP1_CAPABILITIES;
  ready: boolean;
  issuedAt: number;
  expiresAt: number;
}

export interface DiscoveryDocument {
  payload: DiscoveryPayload;
  signature: string;
}

const FIELDS = ["format", "profile", "seller", "publicEndpoint", "transport", "listings", "capabilities", "ready", "issuedAt", "expiresAt"];
const MAX_LISTINGS = 32;
/** Clock skew tolerated on issuedAt. */
const ISSUED_SKEW_MS = 60_000;

/** An absolute HTTPS URL with no credentials, query or fragment. Compared byte for byte, never normalized. */
export function isPublicEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && !value.includes("#") && !value.includes("?");
  } catch {
    return false;
  }
}

function payloadValid(p: unknown): p is DiscoveryPayload {
  return hasKeys(p, FIELDS) && p.format === DACS_SELLER_DISCOVERY_FORMAT && isTp1WireProfile(p.profile) && isClaim(p.seller) &&
    isPublicEndpoint(p.publicEndpoint) && Array.isArray(p.transport) && p.transport.length === 1 && p.transport[0] === DACS_SELLER_HTTP_V1 &&
    Array.isArray(p.listings) && p.listings.length > 0 && p.listings.length <= MAX_LISTINGS && p.listings.every(isListingPin) &&
    typeof p.ready === "boolean" && isUint(p.issuedAt) && isUint(p.expiresAt) && p.expiresAt > p.issuedAt &&
    p.expiresAt - p.issuedAt <= DACS_SELLER_HTTP_LIMITS.maxDiscoveryLifetimeMs;
}

/** The bytes a discovery signature covers, from one owned copy of the payload. */
export function discoverySigningBytes(supplied: DiscoveryPayload): Buffer {
  const payload = ownedArtifact(supplied, "discovery_invalid", 502);
  if (!payloadValid(payload)) fail("discovery_invalid", 502);
  return Buffer.from(`${DACS_SELLER_HTTP_DOMAINS.discovery}${canonicalize(payload)}`, "utf8");
}

/**
 * Seller side: the exact bytes to serve. Signed only under a current TP-1
 * binding. The payload is copied once: the checks, the signed bytes and the
 * served document all come from that copy.
 */
export async function signDiscoveryDocument(supplied: DiscoveryPayload, signer: WireSigner, binding: Tp1Binding, local: unknown): Promise<Uint8Array> {
  assertTp1Binding(binding, local);
  const payload = ownedArtifact(supplied, "discovery_invalid", 500) as DiscoveryPayload;
  assertPeerProfile((payload as unknown as JsonRecord | null)?.profile, binding, 500);
  if (!sameCanonical(payload.capabilities, TP1_CAPABILITIES)) fail("discovery_capabilities_unsupported", 500);
  if (signer.claim !== payload.seller) fail("discovery_signer_wrong", 500);
  const signingBytes = discoverySigningBytes(payload);
  if (Buffer.byteLength(canonicalize({ payload, signature: "A".repeat(86) })) > DACS_SELLER_HTTP_LIMITS.maxDiscoveryBytes) fail("discovery_too_large", 500);
  const signature = envelopeSignatureBytes(await signer.sign(signingBytes), "discovery_signature_invalid").toString("base64url");
  return Buffer.from(canonicalize({ payload, signature }), "utf8");
}

/** What the buyer read from the verified Listing's own chain bytes. */
export interface VerifiedListingEndpoint {
  seller: string;
  publicEndpoint: string;
  listingPin: ListingPin;
}

export interface EndpointProof {
  readonly payload: DiscoveryPayload;
  readonly ready: boolean;
}

const proofs = new WeakMap<object, { binding: Tp1Binding; listing: VerifiedListingEndpoint }>();
const proofGet = uncurry(WeakMap.prototype.get) as (map: typeof proofs, key: object) => { binding: Tp1Binding; listing: VerifiedListingEndpoint } | undefined;
const proofSet = uncurry(WeakMap.prototype.set) as (map: typeof proofs, key: object, value: { binding: Tp1Binding; listing: VerifiedListingEndpoint }) => unknown;

/** Purchase signing accepts only a proof this module verified for the buyer's binding. */
export function assertEndpointProof(proof: unknown, scope: { binding: Tp1Binding; seller: string; listingPin: ListingPin; publicEndpoint: string; now: number }): asserts proof is EndpointProof {
  const kept = typeof proof === "object" && proof !== null ? proofGet(proofs, proof) : undefined;
  if (!kept || kept.binding !== scope.binding) fail("endpoint_proof_required", 500);
  const p = proof as EndpointProof;
  if (kept.listing.seller !== scope.seller || kept.listing.publicEndpoint !== scope.publicEndpoint ||
      !sameCanonical(kept.listing.listingPin, scope.listingPin)) fail("endpoint_proof_mismatch", 500);
  if (!isUint(scope.now) || p.payload.issuedAt > scope.now + ISSUED_SKEW_MS || p.payload.expiresAt <= scope.now) fail("discovery_expired", 502);
  if (!p.ready) fail("seller_not_ready", 503);
}

/**
 * Buyer side. `bytes` are the exact received document bytes. Refuses before
 * any request is prepared or signed: a wrong profile, signer, signature,
 * endpoint, Listing, capability set or validity window. Before all of these:
 * the buyer's own binding from bindTp1Profile and its current connection
 * (`local`). The options are read once (ownedFields) and the Listing copied.
 */
export function verifyEndpointProof(bytes: Uint8Array, options: { listing: VerifiedListingEndpoint; binding: Tp1Binding; local: unknown; now: number }): EndpointProof {
  const { listing: suppliedListing, binding, local, now } = ownedFields(options, ["listing", "binding", "local", "now"]);
  assertTp1Binding(binding, local);
  let listing: VerifiedListingEndpoint;
  try { listing = snapshotWireJsonRead(suppliedListing, "verified Listing") as VerifiedListingEndpoint; }
  catch { return fail("wire_input_invalid", 500); }
  const document = admitWireJson(bytes, DACS_SELLER_HTTP_LIMITS.maxDiscoveryBytes, "discovery_json_rejected", 502) as JsonRecord;
  if (!hasKeys(document, ["payload", "signature"])) fail("discovery_invalid", 502);
  const p = document.payload as JsonRecord;
  if (lacksProfile(p, FIELDS)) fail("tp1_profile_missing", 502);
  // With exactly the wire's members, the profile gate comes before every other payload check, so a revision fault is named as one.
  if (hasKeys(p, FIELDS)) assertPeerProfile(p.profile, binding as Tp1Binding, 502);
  if (!payloadValid(p)) fail("discovery_invalid", 502);
  if (!hasKeys(listing, ["seller", "publicEndpoint", "listingPin"]) || !isClaim(listing.seller) ||
      !isPublicEndpoint(listing.publicEndpoint) || !isListingPin(listing.listingPin)) fail("wire_input_invalid", 500);
  if (p.seller !== listing.seller) fail("discovery_signer_wrong", 502);
  if (!verifyEd25519(discoverySigningBytes(p), envelopeSignatureBytes(document.signature, "discovery_signature_invalid"), claimKey(p.seller))) {
    fail("discovery_signature_invalid", 502);
  }
  if (p.publicEndpoint !== listing.publicEndpoint) fail("discovery_endpoint_mismatch", 502);
  if (!p.listings.some((pin) => sameCanonical(pin, listing.listingPin))) fail("discovery_listing_missing", 502);
  if (!sameCanonical(p.capabilities, TP1_CAPABILITIES)) fail("discovery_capabilities_unsupported", 502);
  if (!isUint(now) || p.issuedAt > now + ISSUED_SKEW_MS || p.expiresAt <= now) fail("discovery_expired", 502);
  const proof = deepFreeze({ payload: cloneJson(p), ready: p.ready });
  proofSet(proofs, proof, { binding: binding as Tp1Binding, listing: deepFreeze(listing) });
  return proof;
}
