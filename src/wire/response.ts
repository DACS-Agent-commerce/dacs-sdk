// Seller responses and the buyer's request/response half of dacs-seller-http/v1.
//
// Ported from the plugin implementation's response header, client request and
// response verification. Changes (D6): the request and response carry the TP-1 `profile` and are
// signed only under a current TP-1 binding and the tuple the signer kept for
// the purchase; the response is checked against the buyer's own binding. The
// receiver's 60 s window is unchanged; a signer gives at most 30 s
// (maxSignedLifetimeMs), so a 30 s clock difference either way still passes,
// and a lifetime above that is refused.
// D7: both signers admit their outgoing body with the
// receiver's CF-5 profile, and the buyer admits the exact received response
// bytes before hashing them. Every caller-built request, options object, job
// and body is read once, into an owned copy, and only the copy is used.
import { randomBytes } from "node:crypto";

import { sha256Hex } from "../canonical/hash.js";
import { isCanonicalJobId } from "../negotiate/jobId.js";
import { assertEndpointProof, type EndpointProof } from "./discovery.js";
import {
  admitOutgoingBody, admitWireResponseBody, messageLifetime, openWireEnvelope, signWireEnvelope, wireRequestHash,
  type EnvelopeSigningContext, type SigningContext, type WireRequestPayload, type WireResponsePayload,
} from "./envelope.js";
import { verifySellerSessionDelegation, type SellerSessionDelegation } from "./delegation.js";
import { assertPurchaseProfile, assertTp1Binding, type Tp1WireProfile } from "./profile.js";
import { DACS_SELLER_HTTP_LIMITS } from "./routes.js";
import {
  fail, isClaim, isUint, ownedArtifact, ownedBytes, ownedConfig, ownedFields, sameCanonical, WireError, type JsonRecord, type ListingPin, type WireSigner,
} from "./validate.js";

/**
 * The seller signs its answer bound to the request hash, status and exact body
 * text. Nothing is signed unless `purchaseProfile`, the tuple the seller kept
 * for the job, is exactly the binding's, or `null` when it keeps none (a new
 * purchase); it is checked before anything else is read. The answer expires
 * `lifetimeMs` (default and most 30 s) after the seller's clock, inside the
 * buyer's 60 s window even when the seller's clock runs up to 30 s ahead.
 * `maxLifetimeMs` (checkWireRequest's window) is refused here. The request is copied
 * once: the response fields, the request hash and the signer check all come
 * from that copy.
 */
export async function signWireResponse(supplied: WireRequestPayload, status: number, text: string, ctx: EnvelopeSigningContext & { now: number; lifetimeMs?: number }): Promise<string> {
  const { signer, binding, local, purchaseProfile, now, lifetimeMs: override, maxLifetimeMs: window } = ownedFields(ctx, ["signer", "binding", "local", "purchaseProfile", "now", "lifetimeMs", "maxLifetimeMs"]) as EnvelopeSigningContext & { now: number; lifetimeMs: number; maxLifetimeMs: unknown };
  const request = ownedArtifact(supplied, "peer_envelope_invalid", 500) as WireRequestPayload;
  await assertTp1Binding(binding, local);
  if (purchaseProfile !== null) await assertPurchaseProfile(purchaseProfile, binding, 500);
  const requestHash = wireRequestHash(request);
  // maxLifetimeMs is checkWireRequest's acceptance window, never an answer's lifetime: a context that names it is refused.
  if (window !== undefined) fail("seller_configuration_invalid", 500);
  const lifetimeMs = messageLifetime(override, "seller_configuration_invalid", DACS_SELLER_HTTP_LIMITS.maxSignedLifetimeMs);
  if (Buffer.byteLength(text) > DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes) fail("peer_response_too_large", 500);
  const bytes = admitOutgoingBody(text, DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes);
  const payload: WireResponsePayload = {
    ...request, kind: "response", bodyHash: sha256Hex(bytes), expiresAt: (now as number) + lifetimeMs,
    requestHash, status,
  };
  if ((signer as WireSigner).claim !== request.seller) fail("peer_signer_wrong", 500);
  return signWireEnvelope(payload, { signer: signer as WireSigner, binding, local, purchaseProfile: purchaseProfile as Tp1WireProfile | null });
}

/** The job context the buyer approved: never taken from an HTTP response. */
export interface WireJobContext {
  listingPin: ListingPin;
  agreementHash: string;
  deadline?: number;
  /** The tuple the buyer selected and kept for this purchase; it must be its binding's profile exactly. */
  profile: Tp1WireProfile;
}

export interface WireRequestInput extends SigningContext {
  /** Proof returned by verifyEndpointProof for this seller, Listing and endpoint. */
  endpointProof: EndpointProof;
  /**
   * For a request that continues a committed purchase (its payment, delivery
   * and readback routes): the job's finalized finality commitment, as the
   * exact bytes received (CF-5), or a value the wire admitted
   * (admitWireArtifact, or a member of the body verifyWireResponse
   * returned). The seller (TP-1's orchestrator) sends it; the result
   * commitFixedPriceAgreement returned, or a copy read again after a restart,
   * is checked the same way. A caller's object is refused. The wire first
   * checks `signedListing` (the Listing the purchase pins), its own commit
   * phase and TP-1 shape (pay-dem, deliver-storage-program, a storage-program
   * deliverable, fixed DEM pricing), then the record, the seller's
   * signature, `agreement` (both parties' signatures, CA-7), the finalized
   * receipt, the Listing's window and deadline at its receipt time
   * (DACS-3 §8.5.2 checks 5 and 6) and the Agreement's terms against the
   * Listing (checks 1-4, the SDK's own verifier), and the receipt reader kept with
   * `endpointProof` (verifyEndpointProof's `readCommitmentReceipt`)
   * authenticates it at every signing. The request then continues, so
   * `ready: false` does not refuse it and the Listing's window is compared at
   * the commitment's receipt time, not now. Omitted, or on any other route (a
   * proposal, commitment or context request): a new purchase.
   */
  commitment?: unknown;
  /** Required with `commitment`: the Agreement both parties signed that it commits (DACS-3 §8.6 CA-7), as bytes or an admitted value. */
  agreement?: unknown;
  /**
   * Required with `commitment`: the seller's signed Listing the purchase pins
   * (the one the buyer's eligibility reader authenticated), as bytes or an
   * admitted value. Its commit phase, window and deadline are read from it.
   */
  signedListing?: unknown;
  publicEndpoint: string;
  path: string;
  jobId: string;
  /** The exact body text that will be sent. */
  text: string;
  seller: string;
  job: WireJobContext;
  /** With a session signer: the buyer wallet's delegation of that session key. */
  delegation?: SellerSessionDelegation | null;
  now: number;
  lifetimeMs?: number;
  nonce?: string;
}

const REQUEST_INPUT_FIELDS = ["signer", "binding", "local", "endpointProof", "commitment", "agreement", "signedListing", "publicEndpoint", "path", "jobId", "text", "seller", "job", "delegation", "now", "lifetimeMs", "nonce"] as const;

/**
 * A wire refusal of the buyer's own delegation keeps its code and detail with
 * status 500 (`permanent`) and the original error as cause. A 500 or 503
 * refusal, or a non-WireError reader failure, passes unchanged.
 */
async function ownDelegation<T>(verify: () => Promise<T>): Promise<T> {
  try {
    return await verify();
  } catch (error) {
    if (error instanceof WireError && error.status !== 500 && error.status !== 503) fail(error.code, 500, error.detail, error);
    throw error;
  }
}

/**
 * Build and sign one purchase request after endpoint verification. An expired
 * delegation can sign readback requests; seller checks refuse effect routes. The input is read once (ownedFields), and its job
 * and delegation copied once: the delegation copy is verified, bounds the
 * expiry and is embedded in the header, and the job copy scopes both the
 * delegation check and the request. Nothing is signed unless the job's kept
 * tuple is exactly the binding's.
 */
export async function signWireRequest(supplied: WireRequestInput): Promise<{ payload: WireRequestPayload; header: string }> {
  const input = ownedFields(supplied, REQUEST_INPUT_FIELDS) as unknown as WireRequestInput;
  const { binding, signer, local, now } = input;
  const job = ownedConfig(input.job, "wire_input_invalid") as WireJobContext;
  const delegation = input.delegation ? ownedArtifact(input.delegation, "peer_delegation_invalid", 500) as SellerSessionDelegation : null;
  await assertTp1Binding(binding, local);
  await assertPurchaseProfile(job?.profile, binding, 500);
  if (!isCanonicalJobId(input.jobId)) fail("peer_envelope_invalid", 500);
  const claim = signer.claim;
  const lifetimeMs = input.lifetimeMs ?? DACS_SELLER_HTTP_LIMITS.maxSignedLifetimeMs;
  if (!isClaim(input.seller) || !isUint(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > DACS_SELLER_HTTP_LIMITS.maxSignedLifetimeMs) {
    throw new TypeError("buyer transport configuration is invalid");
  }
  if (Buffer.byteLength(input.text) > DACS_SELLER_HTTP_LIMITS.maxRequestBodyBytes) fail("body_too_large", 500);
  const bytes = admitOutgoingBody(input.text, DACS_SELLER_HTTP_LIMITS.maxRequestBodyBytes);
  // The buyer's own delegation: a refusal of it is this host's fault (500), never the seller's.
  let buyer = claim;
  let delegatedUntil: number | null = null;
  if (delegation) {
    const d = await ownDelegation(() => verifySellerSessionDelegation(Buffer.from(JSON.stringify(delegation)), { binding, local, seller: input.seller, listingPin: job.listingPin, jobId: input.jobId, time: now, allowExpired: true, ...(job.deadline === undefined ? {} : { deadline: job.deadline }) }));
    if (claim !== `did:demos:agent:${d.sessionPublicKey}`) throw new TypeError("session signing key differs from the buyer delegation");
    buyer = d.buyer;
    delegatedUntil = d.expiresAt;
  }
  if (buyer === input.seller) throw new TypeError("buyer transport configuration is invalid");
  const live = delegatedUntil === null || now < delegatedUntil;
  const payload: WireRequestPayload = {
    version: "1", kind: "request", method: "POST", path: input.path, bodyHash: sha256Hex(bytes), jobId: input.jobId,
    buyer, seller: input.seller, listingPin: job.listingPin, agreementHash: job.agreementHash,
    nonce: input.nonce ?? randomBytes(24).toString("base64url"),
    expiresAt: live ? Math.min(now + lifetimeMs, delegatedUntil ?? Number.MAX_SAFE_INTEGER) : now + lifetimeMs,
    profile: { ...binding.profile },
  };
  // Validate the complete payload before checking the purchase effect gate.
  wireRequestHash(payload);
  await assertEndpointProof(input.endpointProof, { binding, seller: input.seller, listingPin: job.listingPin, publicEndpoint: input.publicEndpoint, now, request: payload, commitment: input.commitment, agreement: input.agreement, signedListing: input.signedListing });
  return { payload, header: await signWireEnvelope(payload, { signer, binding, local, purchaseProfile: job.profile, endpointProof: input.endpointProof, publicEndpoint: input.publicEndpoint, now, commitment: input.commitment, agreement: input.agreement, signedListing: input.signedListing }, delegation) };
}

export interface WireResponseReceipt {
  principal: string;
  audience: string;
  messageId: string;
  messageHash: string;
  authenticationHash: string;
  /** The admitted response body. The buyer must use this, never a separately parsed copy. */
  body: JsonRecord;
}

export interface ReceivedWireResponse {
  header: unknown;
  status: number;
  /** The exact received body bytes, not a decoded string (CF-5). */
  body: Uint8Array;
  now: number;
  binding: SigningContext["binding"];
  /** The buyer's connection right now; it must be the one the binding was made with. */
  local: unknown;
}

/**
 * Buyer-side check of a seller answer against the request it sent. The request
 * and the received answer are read once, into owned copies. The request is the
 * buyer's record of the purchase: its tuple must be the buyer's binding's, and
 * the answer must carry both. The body is admitted before it is hashed.
 */
export async function verifyWireResponse(suppliedRequest: WireRequestPayload, suppliedReceived: ReceivedWireResponse): Promise<WireResponseReceipt> {
  const received = ownedFields(suppliedReceived, ["header", "status", "body", "now", "binding", "local"]) as unknown as ReceivedWireResponse;
  const request = ownedArtifact(suppliedRequest, "peer_envelope_invalid", 500) as WireRequestPayload;
  const expectedRequestHash = wireRequestHash(request);
  // Over 512 KiB is refused as admission refuses it, before the body is copied or the header is read.
  const responseBytes = ownedBytes(received.body, "wire_input_invalid", 500, { maxBytes: DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes, code: "response_json_rejected", status: 502 });
  await assertTp1Binding(received.binding, received.local);
  await assertPurchaseProfile(request?.profile, received.binding, 500);
  const { payload: response, authenticationHash } = await openWireEnvelope(received.header, "response", { binding: received.binding, local: received.local, purchaseProfile: request.profile, principal: request.seller });
  const body = admitWireResponseBody(responseBytes);
  const { kind, bodyHash, expiresAt, requestHash, status, ...identity } = response;
  const { kind: _k, bodyHash: _b, expiresAt: _e, ...expected } = request;
  void kind; void _k; void _b; void _e;
  if (!sameCanonical(identity, expected) || requestHash !== expectedRequestHash || status !== received.status ||
      bodyHash !== sha256Hex(responseBytes) || !isUint(received.now) || expiresAt <= received.now ||
      expiresAt > received.now + DACS_SELLER_HTTP_LIMITS.maxMessageLifetimeMs) fail("peer_response_mismatch");
  return { principal: request.seller, audience: request.buyer, messageId: request.nonce, messageHash: requestHash, authenticationHash, body };
}
