// Signed request and response envelopes of dacs-seller-http/v1.
//
// Ported from the plugin implementation's payload check, signing bytes, header
// encoding and decoding, and server-side request checks (its body checks and
// context-route branch stay with the seller). Transport changes
// enumerated as D6/D7: the `dacs-seller-http:v1:{request,response}:` domains
// replace `dacs-chatgpt-plugin:loopback-seller-peer:v1:`; every payload carries
// the TP-1 `profile`; the header is admitted with admitRawJson before parsing;
// signing and verifying require a TP-1 binding for the actor's current
// connection and the tuple the actor kept for the purchase; checkWireRequest
// takes only an envelope openWireEnvelope verified; every caller-built payload
// and options object is read once, into an owned copy.
import { canonicalize } from "../canonical/jcs.js";
import { sha256Hex } from "../canonical/hash.js";
import { isCanonicalJobId } from "../negotiate/jobId.js";
import { assertEndpointProof, type EndpointProof } from "./discovery.js";
import { assertPeerProfile, assertPurchaseProfile, assertTp1Binding, assertTp1Authority, isTp1WireProfile, type Tp1Binding, type Tp1WireProfile } from "./profile.js";
import { DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_LIMITS, DACS_SELLER_HTTP_PATHS } from "./routes.js";
import { verifySellerSessionDelegation, type SellerSessionDelegation } from "./delegation.js";
import {
  admitWireJson, claimKey, cloneJson, deepFreeze, envelopeSignatureBytes, fail, hasKeys, isClaim, isHash, isListingPin,
  isRecord, isUint, lacksProfile, NONCE, ownedArtifact, ownedFields, ownedOrNothing, sameCanonical,
  uncurry, verifyEd25519, walletSignatureBytes, type JsonRecord, type ListingPin, type WireSigner,
} from "./validate.js";

export interface WireRequestPayload {
  version: "1";
  kind: "request";
  method: "POST";
  path: string;
  bodyHash: string;
  jobId: string;
  buyer: string;
  seller: string;
  listingPin: ListingPin;
  agreementHash: string;
  nonce: string;
  expiresAt: number;
  profile: Tp1WireProfile;
}

export interface WireResponsePayload extends Omit<WireRequestPayload, "kind"> {
  kind: "response";
  requestHash: string;
  status: number;
}

export type WirePayload = WireRequestPayload | WireResponsePayload;
export type WireKind = WirePayload["kind"];

const REQUEST_FIELDS = ["version", "kind", "method", "path", "bodyHash", "jobId", "buyer", "seller", "listingPin", "agreementHash", "nonce", "expiresAt", "profile"];
const RESPONSE_FIELDS = [...REQUEST_FIELDS, "requestHash", "status"];

/** Shape of one owned copy: a Proxy or accessor is not a payload. */
export function isWirePayload(supplied: unknown, kind: unknown): supplied is WirePayload {
  return payloadShape(ownedOrNothing(supplied), kind);
}

/** The only paths a request or response is signed for: exactly the route table's signed routes, never a spelling of one (trailing slash, case, double slash). */
const SIGNED_PATHS: ReadonlySet<string> = new Set(Object.values(DACS_SELLER_HTTP_PATHS));

function payloadShape(p: unknown, kind: unknown): p is WirePayload {
  return (kind === "request" || kind === "response") && hasKeys(p, kind === "response" ? RESPONSE_FIELDS : REQUEST_FIELDS) &&
    p.version === "1" && p.kind === kind && p.method === "POST" &&
    typeof p.path === "string" && SIGNED_PATHS.has(p.path) &&
    isHash(p.bodyHash) && isCanonicalJobId(p.jobId) && isClaim(p.buyer) && isClaim(p.seller) && p.buyer !== p.seller &&
    isListingPin(p.listingPin) && isHash(p.agreementHash) && typeof p.nonce === "string" && NONCE.test(p.nonce) &&
    Buffer.from(p.nonce, "base64url").toString("base64url") === p.nonce && isUint(p.expiresAt) &&
    isTp1WireProfile(p.profile) &&
    (kind !== "response" || (isHash(p.requestHash) && isUint(p.status) && (p.status as number) >= 200 && (p.status as number) <= 599));
}

/** Exact bytes a request or response signature covers, from one owned copy of the payload. */
export function wireEnvelopeSigningBytes(supplied: WirePayload): Buffer {
  const payload = ownedArtifact(supplied, "peer_envelope_invalid") as WirePayload;
  if (!payloadShape(payload, payload?.kind)) fail("peer_envelope_invalid");
  return Buffer.from(`${DACS_SELLER_HTTP_DOMAINS[payload.kind]}${canonicalize(payload)}`, "utf8");
}

/** sha256 of the canonical request payload, from one owned copy; a response binds it. */
export function wireRequestHash(request: WireRequestPayload): string {
  const copy = ownedArtifact(request, "peer_envelope_invalid", 500);
  if (!payloadShape(copy, "request")) fail("peer_envelope_invalid", 500);
  return sha256Hex(canonicalize(copy));
}

export interface SigningContext {
  signer: WireSigner;
  binding: Tp1Binding;
  /** The signer's connection right now; it must be the one the binding was made with. */
  local: unknown;
}

/** signWireEnvelope's context: the signer's, and the tuple it kept for the purchase. */
export interface EnvelopeSigningContext extends SigningContext {
  /** Required when signing a request; responses do not require buyer endpoint proof. */
  endpointProof?: EndpointProof;
  publicEndpoint?: string;
  now?: number;
  /**
   * A request continuing a committed purchase: the job's finalized commitment
   * as received bytes or an admitted value (WireRequestInput.commitment),
   * authenticated by the receipt reader kept with the endpoint proof.
   */
  commitment?: unknown;
  /** Required with `commitment`: the Agreement both parties signed that it commits (DACS-3 §8.6 CA-7). */
  agreement?: unknown;
  /** Required with `commitment`: the Listing the purchase pins, as bytes or an admitted value (WireRequestInput.signedListing). */
  signedListing?: unknown;
  /**
   * Required: the tuple the signer kept for this purchase, exactly the
   * binding's profile. `null` (none kept yet) only for a seller's answer to a
   * new purchase; a request is always signed under a kept tuple. Omitted is
   * refused.
   */
  purchaseProfile: Tp1WireProfile | null;
}

/**
 * Sign a payload and encode the envelope header. Nothing is signed without a
 * current TP-1 binding and the tuple kept for the purchase. The payload and
 * delegation are copied once: the profile check, the signed bytes and the
 * header all come from those copies. A delegation is verified for the
 * request's buyer, seller, Listing and job at `now` before the signer is called
 * (expiry is not checked here: the receiver decides which routes an expired one serves).
 */
export async function signWireEnvelope(supplied: WirePayload, context: EnvelopeSigningContext, suppliedDelegation?: SellerSessionDelegation | null): Promise<string> {
  const { signer, binding, local, purchaseProfile, endpointProof, publicEndpoint, now, commitment, agreement, signedListing } = ownedFields(context, ["signer", "binding", "local", "purchaseProfile", "endpointProof", "publicEndpoint", "now", "commitment", "agreement", "signedListing"]) as EnvelopeSigningContext;
  const payload = ownedArtifact(supplied, "peer_envelope_invalid", 500);
  await assertTp1Binding(binding, local);
  if (!isRecord(payload)) return fail("peer_envelope_invalid", 500);
  if (purchaseProfile !== null || payload.kind !== "response") await assertPurchaseProfile(purchaseProfile, binding, 500);
  const delegation = suppliedDelegation ? ownedArtifact(suppliedDelegation, "peer_delegation_invalid", 500) : null;
  // Only a request carries a delegation; every receiver refuses a response header that has one.
  if (delegation !== null && payload.kind !== "request") fail("peer_envelope_invalid", 500);
  await assertPeerProfile(payload.profile, binding, 500);
  // A payload this signer built, such as an answer status outside 200-599, is its own fault.
  if (!payloadShape(payload, payload.kind)) fail("peer_envelope_invalid", 500);
  const signingBytes = wireEnvelopeSigningBytes(payload as unknown as WirePayload);
  // A canonical Ed25519 signature is always 86 base64url characters. Bound
  // the complete encoded header, including a supplied delegation, before signing.
  const encode = (signature: string) => Buffer.from(canonicalize({ payload, signature, ...(delegation ? { delegation } : {}) })).toString("base64url");
  if (encode("A".repeat(86)).length > DACS_SELLER_HTTP_LIMITS.maxHeaderLength) fail("peer_envelope_too_large", 500);
  // A delegation is verified against this request's scope and clock before a request signature is spent on it. Expiry is the receiver's call: it
  // reads back an operation already started under a lapsed delegation, and refuses every effect route.
  if (delegation !== null) await verifySellerSessionDelegation(Buffer.from(canonicalize(delegation)), {
    binding, local, buyer: payload.buyer as string, seller: payload.seller as string, listingPin: payload.listingPin as ListingPin, jobId: payload.jobId as string, time: now,
    allowExpired: true,
  });
  if (payload.kind === "request") await assertEndpointProof(endpointProof, {
    binding, seller: payload.seller as string, listingPin: payload.listingPin as ListingPin,
    publicEndpoint: publicEndpoint as string, now: now as number, request: payload as unknown as WireRequestPayload, commitment, agreement, signedListing,
  });
  await assertTp1Authority(binding, local, [payload.buyer as string, payload.seller as string], payload.jobId as string);
  const signature = envelopeSignatureBytes(await (signer as WireSigner).sign(signingBytes)).toString("base64url");
  await assertTp1Authority(binding, local, [payload.buyer as string, payload.seller as string], payload.jobId as string);
  return Buffer.from(canonicalize({ payload, signature, ...(delegation ? { delegation } : {}) })).toString("base64url");
}

/** A verified envelope, frozen. Only openWireEnvelope makes one that checkWireRequest accepts. */
export interface OpenedEnvelope<P extends WirePayload> {
  readonly payload: P;
  readonly delegation: SellerSessionDelegation | null;
  /** SHA-256 of the canonical header with signatures normalized to base64url. */
  readonly authenticationHash: string;
}

// Each envelope openWireEnvelope verified, with the binding it was verified
// under. Methods taken at module load (see profile.ts).
const opened = new WeakMap<object, Tp1Binding>();
const openedBinding = uncurry(WeakMap.prototype.get) as (map: WeakMap<object, Tp1Binding>, key: object) => Tp1Binding | undefined;
const recordOpened = uncurry(WeakMap.prototype.set) as (map: WeakMap<object, Tp1Binding>, key: object, value: Tp1Binding) => unknown;

export interface OpenEnvelopeOptions {
  binding: Tp1Binding;
  /** The verifier's connection right now; it must be the one the binding was made with. */
  local: unknown;
  /**
   * Required: the tuple the verifier kept for this purchase, exactly the
   * binding's profile. The seller opening a request passes the tuple kept for
   * the job, or `null` when it keeps none yet (a new purchase); the buyer
   * opening a response passes the tuple its request carries. Omitted, or
   * `null` for a response, is refused.
   */
  purchaseProfile: Tp1WireProfile | null;
  /**
   * Required when opening a response: its signer (the Listing's seller).
   * Omitted for a response is refused. A request is signed by its buyer or
   * delegated session key, and the seller checks the buyer against its own
   * retained record (checkWireRequest).
   */
  principal?: string;
  /**
   * Seller-side: a request must carry a delegation. Without it, a request may
   * still carry one, and it is verified whenever present: a buyer never needs
   * to know this setting. A response never carries one: with this set, a
   * response is refused.
   */
  requireDelegation?: boolean;
}

/**
 * Admit, decode and verify an envelope header. Order: the TP-1 binding, then
 * the tuple kept for the purchase, before the header is read; then the
 * plugin's header decoding.
 */
export async function openWireEnvelope<K extends WireKind>(header: unknown, kind: K, options: OpenEnvelopeOptions): Promise<OpenedEnvelope<Extract<WirePayload, { kind: K }>>> {
  const { binding, local, purchaseProfile, principal, requireDelegation = false } = ownedFields(options, ["binding", "local", "purchaseProfile", "principal", "requireDelegation"]) as OpenEnvelopeOptions;
  await assertTp1Binding(binding, local);
  if (purchaseProfile !== null || kind !== "request") await assertPurchaseProfile(purchaseProfile, binding, 500);
  // Without its principal, a response signed by anyone who names itself the seller would verify.
  if (kind === "response" && !isClaim(principal)) fail("wire_input_invalid", 500);
  if (typeof header !== "string" || header.length > DACS_SELLER_HTTP_LIMITS.maxHeaderLength || !/^[A-Za-z0-9_-]+$/.test(header)) fail("peer_envelope_invalid");
  const bytes = Buffer.from(header as string, "base64url");
  if (bytes.toString("base64url") !== header) fail("peer_envelope_invalid");
  const envelope = admitWireJson(bytes, DACS_SELLER_HTTP_LIMITS.maxHeaderLength, "wire_json_rejected", 401) as JsonRecord;
  const delegated = kind === "request" && Object.hasOwn(envelope ?? {}, "delegation");
  if (!hasKeys(envelope, ["payload", "signature", ...(delegated ? ["delegation"] : [])])) fail("peer_envelope_invalid");
  const p = envelope.payload as JsonRecord;
  if (lacksProfile(p, kind === "response" ? RESPONSE_FIELDS : REQUEST_FIELDS)) fail("tp1_profile_missing", 409);
  // With exactly the wire's members, the profile gate comes before every other payload check, so a revision fault is named as one.
  if (hasKeys(p, kind === "response" ? RESPONSE_FIELDS : REQUEST_FIELDS)) await assertPeerProfile(p.profile, binding);
  if (!payloadShape(p, kind)) fail("peer_envelope_invalid");
  if (requireDelegation && !delegated) fail("peer_delegation_required");
  const payload = p as unknown as Extract<WirePayload, { kind: K }>;
  const actor = kind === "request" ? payload.buyer : payload.seller;
  if (principal !== undefined && actor !== principal) fail("peer_signer_wrong");
  // The opener has no clock: whether the delegation is still live is the admitting caller's decision.
  const delegation = delegated ? await verifySellerSessionDelegation(envelope.delegation, { binding, local, buyer: payload.buyer, seller: payload.seller, listingPin: payload.listingPin, jobId: payload.jobId, allowExpired: true }) : null;
  const key = delegation?.sessionPublicKey ?? claimKey(actor);
  if (!verifyEd25519(wireEnvelopeSigningBytes(payload), envelopeSignatureBytes(envelope.signature), key)) fail("peer_signature_invalid");
  // The trusted reader is asked about these participants and this job only once a signature authenticates them.
  await assertTp1Authority(binding, local, [payload.buyer, payload.seller], payload.jobId);
  const normalizedDelegation = delegated ? {
    payload: (envelope.delegation as SellerSessionDelegation).payload,
    signature: walletSignatureBytes((envelope.delegation as SellerSessionDelegation).signature).toString("base64url"),
  } : null;
  const normalizedHeader = Buffer.from(canonicalize({ payload, signature: envelopeSignatureBytes(envelope.signature).toString("base64url"),
    ...(normalizedDelegation ? { delegation: normalizedDelegation } : {}) })).toString("base64url");
  const result = deepFreeze({ payload: cloneJson(payload), delegation: delegated ? cloneJson(envelope.delegation as SellerSessionDelegation) : null,
    authenticationHash: sha256Hex(normalizedHeader) });
  recordOpened(opened, result, binding);
  return result;
}

/**
 * An override must be an integer from 1 to `max` ms, as the plugin's own
 * configuration check requires; omitted, it is `max`. A receiver's window
 * allows up to maxMessageLifetimeMs, a signer's lifetime up to maxSignedLifetimeMs.
 */
export function messageLifetime(override: unknown, code: string, max: number = DACS_SELLER_HTTP_LIMITS.maxMessageLifetimeMs): number {
  const ms = override ?? max;
  if (!isUint(ms) || ms < 1 || ms > max) fail(code, 500);
  return ms;
}
/**
 * CF-5 admission of a received request body (64 KiB); it must be a JSON
 * object. It is returned frozen and recorded as admitted, so an Agreement or
 * commitment inside it is accepted as admitted (commitment.ts).
 */
export function admitWireRequestBody(rawBody: Uint8Array): JsonRecord {
  const body = admitWireJson(rawBody, DACS_SELLER_HTTP_LIMITS.maxRequestBodyBytes, "bad_json", 400);
  if (body === null || typeof body !== "object" || Array.isArray(body)) fail("bad_request", 400);
  return body as JsonRecord;
}

/**
 * A producer applies the receiver's admission profile to the exact bytes it is
 * about to hash and sign (CF-5's last sentence), so it never signs a body its
 * peer must refuse. Returns those bytes.
 */
export function admitOutgoingBody(text: string, maxBytes: number): Buffer {
  const bytes = Buffer.from(text, "utf8");
  const body = admitWireJson(bytes, maxBytes, "outgoing_body_rejected", 500);
  if (body === null || typeof body !== "object" || Array.isArray(body)) fail("outgoing_body_rejected", 500, "NOT-AN-OBJECT");
  return bytes;
}

/**
 * CF-5 admission of a received response body (512 KiB); it must be a JSON
 * object. It is returned frozen and recorded as admitted, so the commitment
 * and Agreement a seller sends in it are accepted as admitted (commitment.ts).
 */
export function admitWireResponseBody(bytes: Uint8Array): JsonRecord {
  const body = admitWireJson(bytes, DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes, "response_json_rejected", 502);
  if (body === null || typeof body !== "object" || Array.isArray(body)) fail("response_json_rejected", 502, "NOT-AN-OBJECT");
  return body as JsonRecord;
}
