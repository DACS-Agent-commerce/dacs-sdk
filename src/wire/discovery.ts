// Discovery document and endpoint proof (new).
//
// The seller serves GET /.well-known/dacs-seller.json: a document signed by
// its Listing key under `dacs-seller-http:v1:discovery:`. Before anything is
// signed for a purchase, the buyer accepts the endpoint only if the signer is
// the verified Listing's seller and `publicEndpoint` equals the Listing's value
// byte for byte. This stops a Listing from aiming buyer traffic at a server its
// seller does not control. The document carries the TP-1 profile and states
// the TP-1 restrictions as its capabilities.
import { types } from "node:util";
import { snapshotWireJsonRead } from "../canonical/snapshot.js";
import { canonicalize } from "../canonical/jcs.js";
import { commitmentReceiptTime, MAX_WIRE_ARTIFACT_BYTES, TP1_COMMIT_PHASE, type CommitmentReceiptReader } from "./commitment.js";
import { assertPeerProfile, assertTp1Binding, assertTp1Authority, isTp1WireProfile, TP1_CAPABILITIES, type Tp1Binding, type Tp1WireProfile } from "./profile.js";
import { DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_LIMITS, DACS_SELLER_HTTP_PATHS, DACS_SELLER_HTTP_V1, isReadRoute } from "./routes.js";
import {
  admitWireJson, claimKey, cloneJson, envelopeSignatureBytes, fail, hasKeys, isClaim, isListingPin, isRecord, isUint,
  lacksProfile, ownedArtifact, ownedBytes, deepFreeze, ownedFields, uncurry, sameCanonical, verifyEd25519, type JsonRecord, type ListingPin, type WireSigner,
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

/**
 * An HTTPS origin: `https://` and an authority, then at most one `/`, with no
 * credentials, path, query or fragment. A request goes to the origin followed
 * by the signed route path, and discovery to its `/.well-known/dacs-seller.json`
 * (RFC 8615), so a path would leave two buyers forming different URLs.
 * Compared byte for byte, never normalized. Before parsing, the spellings the
 * URL parser would repair into another URL are refused: a backslash, a tab or
 * line break anywhere, and a trailing space or control character. Otherwise
 * the parser repairs spellings such as `https:host` or `https:\\host` that a
 * browser resolves against its own page. Spellings it only normalizes (letter
 * case, a default port) are accepted as written; byte equality with the
 * Listing's endpoint is what binds them.
 */
export function isPublicEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return false;
  if (!/^https:\/\/[^/\\]/.test(value) || /[\\\t\n\r]/.test(value) || value.charCodeAt(value.length - 1) <= 0x20) return false;
  if (!/^https:\/\/[^/]+\/?$/.test(value)) return false;
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
  const payload = ownedArtifact(supplied, "discovery_invalid", 500) as DiscoveryPayload;
  await assertTp1Binding(binding, local);
  await assertPeerProfile((payload as unknown as JsonRecord | null)?.profile, binding, 500);
  if (!sameCanonical(payload.capabilities, TP1_CAPABILITIES)) fail("discovery_capabilities_unsupported", 500);
  if (signer.claim !== payload.seller) fail("discovery_signer_wrong", 500);
  // A document this signer built is its own fault (500); a received one is the seller's (502).
  if (!payloadValid(payload)) fail("discovery_invalid", 500);
  const signingBytes = discoverySigningBytes(payload);
  // Defence in depth: the field bounds keep the largest valid document under 16 KiB (test/wire/admission.test.ts),
  // so this refuses only if those bounds are widened without the buyer's limit.
  if (Buffer.byteLength(canonicalize({ payload, signature: "A".repeat(86) })) > DACS_SELLER_HTTP_LIMITS.maxDiscoveryBytes) fail("discovery_too_large", 500);
  await assertTp1Authority(binding, local, [payload.seller], DACS_SELLER_DISCOVERY_FORMAT);
  const signature = envelopeSignatureBytes(await signer.sign(signingBytes), "discovery_signature_invalid").toString("base64url");
  await assertTp1Authority(binding, local, [payload.seller], DACS_SELLER_DISCOVERY_FORMAT);
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

/**
 * An authenticated local reader's selection for one exact Listing content hash.
 * The reader must derive this from the verified full Listing and locally
 * configured service, including pipeline/accepted-rail resolution. Never
 * populate it from discovery or other unverified seller assertions. Return
 * it only for a TP-1 Listing: fixed DEM pricing, exactly one `pay-dem` phase,
 * and exactly one `deliver-storage-program` phase with a `storage-program`
 * `offering.deliverable` (DACS-4 §9.6.1 step 1). A continuation checks the
 * same from the Listing's own bytes (commitment.ts), so no payment follows a
 * purchase whose Listing is not one.
 */
export interface VerifiedListingEligibility extends VerifiedListingEndpoint {
  pricingKind: "fixed";
  negotiation: "negotiate-fixed-price";
  /**
   * The commit phase kind of the Listing's pipeline. It selects the Agreement
   * type a continuation must carry (DACS-3 §8.5.2 check 9, CA-7); TP-1
   * commits only `commit-payee-bound-agreement` (a PayeeBoundAgreementDocument).
   */
  commitPhase: typeof TP1_COMMIT_PHASE;
  rail: "pay-dem";
  delivery: typeof TP1_CAPABILITIES.delivery;
  service: { kind: "fixed-text" } | {
    kind: "pure-synchronous-text-module"; configured: true; pure: true; deterministic: true; synchronous: true;
  };
  output: typeof TP1_CAPABILITIES.output;
  buyerRequestInput: false;
  notBefore: number;
  expiresAt: number;
}

/**
 * Trusted buyer integration, not a peer-supplied callback. Authenticate the
 * Listing and its content hash before returning its selected terms. A missing,
 * revoked or unavailable Listing must throw its real error or return no
 * decision; an ended window is returned as it is, and the wire compares it.
 * It may return the decision or a promise of it; the wire awaits it, and a
 * rejection keeps its cause. The buyer's checks do no I/O of their own.
 * Called at proof creation and assertion for new purchases, so a cached
 * success is never authoritative. A verified continuation uses its pinned
 * signed Listing instead; later revocation cannot cancel fulfillment.
 */
export type ListingEligibilityReader = (scope: Readonly<VerifiedListingEndpoint & { now: number }>) => unknown;

type KeptProof = { binding: Tp1Binding; listing: VerifiedListingEndpoint; readListingEligibility: ListingEligibilityReader; readCommitmentReceipt: unknown };
const proofs = new WeakMap<object, KeptProof>();
const proofGet = uncurry(WeakMap.prototype.get) as (map: typeof proofs, key: object) => KeptProof | undefined;
const proofSet = uncurry(WeakMap.prototype.set) as (map: typeof proofs, key: object, value: KeptProof) => unknown;

/** The signed request a continuation is checked against. */
interface ContinuedRequest { path: string; jobId: string; agreementHash: string; buyer: string }

/**
 * Effect routes that continue a committed purchase: its payment and delivery.
 * With the read routes (its readback), the only ones a commitment continues;
 * a proposal, commitment or context request never does. The seller's checks
 * (checkWireRequest) classify routes by this same list: each of these needs
 * the job's finalized commitment there too.
 */
export const CONTINUING_PATHS: readonly string[] = Object.freeze([DACS_SELLER_HTTP_PATHS.payments, DACS_SELLER_HTTP_PATHS.bundleRequest, DACS_SELLER_HTTP_PATHS.bundleCountersignature]);
const listHas = uncurry(Array.prototype.includes) as (list: readonly string[], value: string) => boolean;
export const isContinuingRoute = (path: string): boolean => listHas(CONTINUING_PATHS, path);

/**
 * The time that continues a committed purchase: the receipt time of the job's
 * finalized commitment (`committedAt`, DACS-3 §8.6 CA-8), never a time the
 * caller states. `commitment` is the job's finality commitment as received
 * bytes or a value the wire admitted (the gate's result, the seller's copy,
 * or one read again after a restart). Under the commit phase of `signedListing`
 * (the Listing the purchase pins, never the reader's statement of it, and
 * TP-1's shape), the wire checks its record, the seller's signature, the
 * signed Agreement it commits (`agreement`: both parties' signatures, CA-7),
 * the finalized receipt, the Listing's window and deadline at its receipt
 * time (DACS-3 §8.5.2 checks 5 and 6) and the Agreement's terms against the
 * Listing (checks 1-4), and asks the buyer's receipt reader to authenticate
 * it, every time (commitment.ts). At signing it must name the request's job,
 * Agreement hash and buyer. A payment or delivery request without a
 * commitment is refused. At signing, a request on any other route is a new
 * purchase: undefined.
 */
async function commitmentTime(commitment: unknown, agreement: unknown, listing: unknown, reader: unknown, scope: { seller: string; listingPin: ListingPin; publicEndpoint: string; now: number; binding: Tp1Binding; request?: ContinuedRequest }): Promise<number | undefined> {
  const { request } = scope;
  if (commitment === undefined && request && isContinuingRoute(request.path)) fail("continuation_commitment_invalid", 500, "CONTINUATION-EVIDENCE-REQUIRED");
  if (commitment === undefined || (request && !isContinuingRoute(request.path) && !isReadRoute(request.path))) return undefined;
  if (!request) fail("continuation_commitment_invalid", 500, "CONTINUATION-REQUEST-REQUIRED");
  // Verify and compare the endpoint from the same admitted, frozen Listing.
  const signedListing = types.isUint8Array(listing) ? admitWireJson(ownedBytes(listing, "continuation_listing_invalid", 500,
    { maxBytes: MAX_WIRE_ARTIFACT_BYTES, code: "continuation_listing_invalid", status: 500 }), MAX_WIRE_ARTIFACT_BYTES, "continuation_listing_invalid", 500) : listing;
  const committedAt = await commitmentReceiptTime(commitment, agreement, signedListing, reader, { binding: scope.binding, seller: scope.seller, listingPin: scope.listingPin, now: scope.now,
    request: { jobId: request.jobId, agreementHash: request.agreementHash, buyer: request.buyer } });
  if (!isRecord(signedListing) || !isRecord(signedListing.seller) || signedListing.seller.publicEndpoint !== scope.publicEndpoint) {
    fail("continuation_listing_invalid", 500, "ENDPOINT");
  }
  return committedAt;
}

/**
 * The authenticated reader's decision for a new purchase, its terms checked;
 * its current window is checked by assertListingWindow.
 * Its commit phase gates a new purchase; a continuation reads the phase from
 * the Listing it is given (commitment.ts), never from this decision.
 */
async function readListingDecision(reader: unknown, listing: VerifiedListingEndpoint, now: number): Promise<VerifiedListingEligibility> {
  if (typeof reader !== "function") fail("listing_eligibility_required", 500);
  const scope = deepFreeze({ ...cloneJson(listing), now });
  // Reader failures retain their cause (for example timeout, not-found or
  // revocation). Only malformed or unsupported decisions get a wire error.
  const decision = ownedArtifact(await (reader as ListingEligibilityReader)(scope), "listing_unsupported", 500) as unknown as VerifiedListingEligibility;
  if (!hasKeys(decision, ["seller", "publicEndpoint", "listingPin", "pricingKind", "negotiation", "commitPhase", "rail", "delivery", "service", "output", "buyerRequestInput", "notBefore", "expiresAt"])) fail("listing_unsupported", 500);
  if (decision.seller !== listing.seller || decision.publicEndpoint !== listing.publicEndpoint ||
      !sameCanonical(decision.listingPin, listing.listingPin)) fail("listing_eligibility_mismatch", 500);
  const service = decision.service;
  const fixedText = hasKeys(service, ["kind"]) && service.kind === "fixed-text";
  const module = hasKeys(service, ["kind", "configured", "pure", "deterministic", "synchronous"]) &&
    service.kind === "pure-synchronous-text-module" && service.configured === true && service.pure === true &&
    service.deterministic === true && service.synchronous === true;
  if (decision.pricingKind !== "fixed" || decision.negotiation !== "negotiate-fixed-price" || decision.commitPhase !== TP1_COMMIT_PHASE ||
      decision.rail !== "pay-dem" || !sameCanonical(decision.delivery, TP1_CAPABILITIES.delivery) || (!fixedText && !module) ||
      !sameCanonical(decision.output, TP1_CAPABILITIES.output) || decision.buyerRequestInput !== false) fail("listing_unsupported", 500);
  return decision;
}

/**
 * A new purchase requires a current Listing window. A continuation checks
 * the signed Listing's window at commitment time in commitment.ts instead.
 */
function assertListingWindow(decision: VerifiedListingEligibility, now: number): void {
  if (!isUint(decision.notBefore) || !isUint(decision.expiresAt) || !isUint(now) ||
      decision.notBefore > now || decision.expiresAt < now) fail("listing_unsupported", 500);
}

/**
 * Purchase signing accepts only a proof this module verified for the buyer's
 * binding. `ready: false` and the Listing's window ending stop new purchases
 * only: neither refuses a continuing request given the job's finalized
 * commitment (commitmentTime).
 */
export async function assertEndpointProof(proof: unknown, scope: { binding: Tp1Binding; seller: string; listingPin: ListingPin; publicEndpoint: string; now: number; request: ContinuedRequest; commitment?: unknown; agreement?: unknown; signedListing?: unknown }): Promise<void> {
  const kept = typeof proof === "object" && proof !== null ? proofGet(proofs, proof) : undefined;
  if (!kept || kept.binding !== scope.binding) fail("endpoint_proof_required", 500);
  const p = proof as EndpointProof;
  if (kept.listing.seller !== scope.seller || kept.listing.publicEndpoint !== scope.publicEndpoint ||
      !sameCanonical(kept.listing.listingPin, scope.listingPin)) fail("endpoint_proof_mismatch", 500);
  // The buyer's own kept proof has lapsed: fetching discovery again clears it (transient), not the seller's fault.
  if (!isUint(scope.now) || p.payload.issuedAt > scope.now + ISSUED_SKEW_MS || p.payload.expiresAt <= scope.now) fail("discovery_expired", 503);
  const committedAt = await commitmentTime(scope.commitment, scope.agreement, scope.signedListing, kept.readCommitmentReceipt, scope);
  if (committedAt === undefined) {
    const decision = await readListingDecision(kept.readListingEligibility, kept.listing, scope.now);
    if (!p.ready) fail("seller_not_ready", 503);
    assertListingWindow(decision, scope.now);
  }
  await assertTp1Authority(scope.binding, scope.binding.local, [p.payload.seller], DACS_SELLER_DISCOVERY_FORMAT);
}

/**
 * Buyer side. `bytes` are the exact received document bytes. Refuses before
 * any request is prepared or signed: a wrong profile, signer, signature,
 * endpoint, Listing, capability set, authenticated eligibility or validity
 * window. The Listing reader is retained and rechecked for new purchases. Before all of these:
 * the buyer's own binding from bindTp1Profile and its current connection
 * (`local`). The options are read once (ownedFields) and the Listing copied.
 * `commitment` (a job's finalized commitment, as signing for that job takes
 * it, with `agreement`, the signed Agreement it commits, and `signedListing`,
 * the signed Listing it pins) compares the Listing's window at its receipt time. `readCommitmentReceipt`,
 * the buyer's own SR-2 receipt reader (commitment.ts), authenticates that
 * commitment here and is kept with the proof: purchase signing asks it again
 * for every continuing request. Without it no request continues a purchase.
 */
export async function verifyEndpointProof(bytes: Uint8Array, options: {
  listing: VerifiedListingEndpoint; binding: Tp1Binding; local: unknown; now: number; readListingEligibility: ListingEligibilityReader;
  request?: ContinuedRequest; commitment?: unknown; agreement?: unknown; signedListing?: unknown; readCommitmentReceipt?: CommitmentReceiptReader;
}): Promise<EndpointProof> {
  const { listing: suppliedListing, binding, local, now, readListingEligibility, commitment, agreement, signedListing, readCommitmentReceipt, request: suppliedRequest } =
    ownedFields(options, ["listing", "binding", "local", "now", "readListingEligibility", "commitment", "agreement", "signedListing", "readCommitmentReceipt", "request"]);
  const received = ownedBytes(bytes, "wire_input_invalid", 500, { maxBytes: DACS_SELLER_HTTP_LIMITS.maxDiscoveryBytes, code: "discovery_json_rejected", status: 502 });
  const request = suppliedRequest === undefined ? undefined : ownedArtifact(suppliedRequest, "wire_input_invalid", 500) as ContinuedRequest;
  let listing: VerifiedListingEndpoint;
  try { listing = snapshotWireJsonRead(suppliedListing, "verified Listing") as VerifiedListingEndpoint; }
  catch { return fail("wire_input_invalid", 500); }
  await assertTp1Binding(binding, local);
  const document = admitWireJson(received, DACS_SELLER_HTTP_LIMITS.maxDiscoveryBytes, "discovery_json_rejected", 502) as JsonRecord;
  if (!hasKeys(document, ["payload", "signature"])) fail("discovery_invalid", 502);
  const p = document.payload as JsonRecord;
  if (lacksProfile(p, FIELDS)) fail("tp1_profile_missing", 502);
  // With exactly the wire's members, the profile gate comes before every other payload check, so a revision fault is named as one.
  if (hasKeys(p, FIELDS)) await assertPeerProfile(p.profile, binding as Tp1Binding, 502);
  if (!payloadValid(p)) fail("discovery_invalid", 502);
  if (!hasKeys(listing, ["seller", "publicEndpoint", "listingPin"]) || !isClaim(listing.seller) ||
      !isPublicEndpoint(listing.publicEndpoint) || !isListingPin(listing.listingPin)) fail("wire_input_invalid", 500);
  if (p.seller !== listing.seller) fail("discovery_signer_wrong", 502);
  if (!verifyEd25519(discoverySigningBytes(p), envelopeSignatureBytes(document.signature, "discovery_signature_invalid"), claimKey(p.seller))) {
    fail("discovery_signature_invalid", 502);
  }
  // The trusted reader is asked only about the verified Listing's seller, once its signature verified.
  await assertTp1Authority(binding as Tp1Binding, local, [p.seller], DACS_SELLER_DISCOVERY_FORMAT);
  if (p.publicEndpoint !== listing.publicEndpoint) fail("discovery_endpoint_mismatch", 502);
  if (!p.listings.some((pin) => sameCanonical(pin, listing.listingPin))) fail("discovery_listing_missing", 502);
  if (!sameCanonical(p.capabilities, TP1_CAPABILITIES)) fail("discovery_capabilities_unsupported", 502);
  if (!isUint(now) || p.issuedAt > now + ISSUED_SKEW_MS || p.expiresAt <= now) fail("discovery_expired", 502);
  const committedAt = await commitmentTime(commitment, agreement, signedListing, readCommitmentReceipt,
    { binding: binding as Tp1Binding, request, ...listing, now: now as number });
  if (committedAt === undefined) assertListingWindow(await readListingDecision(readListingEligibility, listing, now as number), now as number);
  await assertTp1Authority(binding as Tp1Binding, local, [p.seller], DACS_SELLER_DISCOVERY_FORMAT);
  const proof = deepFreeze({ payload: cloneJson(p), ready: p.ready });
  proofSet(proofs, proof, { binding: binding as Tp1Binding, listing: deepFreeze(listing), readListingEligibility: readListingEligibility as ListingEligibilityReader, readCommitmentReceipt });
  return proof;
}
