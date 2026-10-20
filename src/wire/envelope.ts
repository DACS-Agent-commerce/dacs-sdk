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
import { assertEndpointProof, CONTINUING_PATHS, type EndpointProof } from "./discovery.js";
import { assertPeerProfile, assertPurchaseProfile, assertTp1Binding, assertTp1Authority, isTp1WireProfile, type Tp1Binding, type Tp1WireProfile } from "./profile.js";
import { DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_LIMITS, isReadRoute } from "./routes.js";
import { verifySellerSessionDelegation, type SellerSessionDelegation } from "./delegation.js";
import {
  admitWireJson, claimKey, cloneJson, deepFreeze, envelopeSignatureBytes, fail, hasKeys, isClaim, isHash, isListingPin,
  isRecord, isUint, lacksProfile, NONCE, ownedArtifact, ownedBytes, ownedConfig, ownedFields, ownedOrNothing, sameCanonical,
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

function payloadShape(p: unknown, kind: unknown): p is WirePayload {
  return (kind === "request" || kind === "response") && hasKeys(p, kind === "response" ? RESPONSE_FIELDS : REQUEST_FIELDS) &&
    p.version === "1" && p.kind === kind && p.method === "POST" &&
    typeof p.path === "string" && /^\/dacs\/v1\/[a-z/-]+$/.test(p.path) && p.path.length <= 160 &&
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
  /** A request continuing a committed purchase: the job's finalized commitment (WireRequestInput.commitment). */
  commitment?: object;
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
 * header all come from those copies.
 */
export async function signWireEnvelope(supplied: WirePayload, context: EnvelopeSigningContext, suppliedDelegation?: SellerSessionDelegation | null): Promise<string> {
  const { signer, binding, local, purchaseProfile, endpointProof, publicEndpoint, now, commitment } = ownedFields(context, ["signer", "binding", "local", "purchaseProfile", "endpointProof", "publicEndpoint", "now", "commitment"]) as Partial<EnvelopeSigningContext>;
  assertTp1Binding(binding, local);
  const payload = ownedArtifact(supplied, "peer_envelope_invalid", 500);
  if (!isRecord(payload)) return fail("peer_envelope_invalid", 500);
  if (purchaseProfile !== null || payload.kind !== "response") assertPurchaseProfile(purchaseProfile, binding, 500);
  const delegation = suppliedDelegation ? ownedArtifact(suppliedDelegation, "peer_delegation_invalid", 500) : null;
  // Only a request carries a delegation; every receiver refuses a response header that has one.
  if (delegation !== null && payload.kind !== "request") fail("peer_envelope_invalid", 500);
  assertPeerProfile(payload.profile, binding, 500);
  // A payload this signer built, such as an answer status outside 200-599, is its own fault.
  if (!payloadShape(payload, payload.kind)) fail("peer_envelope_invalid", 500);
  const signingBytes = wireEnvelopeSigningBytes(payload as unknown as WirePayload);
  // A canonical Ed25519 signature is always 86 base64url characters. Bound
  // the complete encoded header, including a supplied delegation, before signing.
  const encode = (signature: string) => Buffer.from(canonicalize({ payload, signature, ...(delegation ? { delegation } : {}) })).toString("base64url");
  if (encode("A".repeat(86)).length > DACS_SELLER_HTTP_LIMITS.maxHeaderLength) fail("peer_envelope_too_large", 500);
  if (payload.kind === "request") assertEndpointProof(endpointProof, {
    binding, seller: payload.seller as string, listingPin: payload.listingPin as ListingPin,
    publicEndpoint: publicEndpoint as string, now: now as number, request: payload as unknown as WireRequestPayload, commitment,
  });
  assertTp1Authority(binding, local, [payload.buyer as string, payload.seller as string], payload.jobId as string);
  const signature = envelopeSignatureBytes(await (signer as WireSigner).sign(signingBytes)).toString("base64url");
  assertTp1Authority(binding, local, [payload.buyer as string, payload.seller as string], payload.jobId as string);
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
  /** Required signer of a response (the seller); a request is signed by its buyer or delegated session key. */
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
export function openWireEnvelope<K extends WireKind>(header: unknown, kind: K, options: OpenEnvelopeOptions): OpenedEnvelope<Extract<WirePayload, { kind: K }>> {
  const { binding, local, purchaseProfile, principal, requireDelegation = false } = ownedFields(options, ["binding", "local", "purchaseProfile", "principal", "requireDelegation"]) as Partial<OpenEnvelopeOptions>;
  assertTp1Binding(binding, local);
  if (purchaseProfile !== null || kind !== "request") assertPurchaseProfile(purchaseProfile, binding, 500);
  if (typeof header !== "string" || header.length > DACS_SELLER_HTTP_LIMITS.maxHeaderLength || !/^[A-Za-z0-9_-]+$/.test(header)) fail("peer_envelope_invalid");
  const bytes = Buffer.from(header as string, "base64url");
  if (bytes.toString("base64url") !== header) fail("peer_envelope_invalid");
  const envelope = admitWireJson(bytes, DACS_SELLER_HTTP_LIMITS.maxHeaderLength, "wire_json_rejected", 401) as JsonRecord;
  const delegated = kind === "request" && Object.hasOwn(envelope ?? {}, "delegation");
  if (!hasKeys(envelope, ["payload", "signature", ...(delegated ? ["delegation"] : [])])) fail("peer_envelope_invalid");
  const p = envelope.payload as JsonRecord;
  if (lacksProfile(p, kind === "response" ? RESPONSE_FIELDS : REQUEST_FIELDS)) fail("tp1_profile_missing", 409);
  // With exactly the wire's members, the profile gate comes before every other payload check, so a revision fault is named as one.
  if (hasKeys(p, kind === "response" ? RESPONSE_FIELDS : REQUEST_FIELDS)) assertPeerProfile(p.profile, binding);
  if (!payloadShape(p, kind)) fail("peer_envelope_invalid");
  if (requireDelegation && !delegated) fail("peer_delegation_required");
  const payload = p as unknown as Extract<WirePayload, { kind: K }>;
  const actor = kind === "request" ? payload.buyer : payload.seller;
  if (principal !== undefined && actor !== principal) fail("peer_signer_wrong");
  const delegation = delegated ? verifySellerSessionDelegation(envelope.delegation, { binding, local, buyer: payload.buyer }) : null;
  const key = delegation?.sessionPublicKey ?? claimKey(actor);
  if (!verifyEd25519(wireEnvelopeSigningBytes(payload), envelopeSignatureBytes(envelope.signature), key)) fail("peer_signature_invalid");
  // The trusted reader is asked about these participants and this job only once a signature authenticates them.
  assertTp1Authority(binding, local, [payload.buyer, payload.seller], payload.jobId);
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

export interface RequestCheck {
  seller: string;
  listingPin: ListingPin;
  method: string;
  path: string;
  /** The exact received body bytes; they are admitted (CF-5) here, before their hash is compared. */
  rawBody: Uint8Array;
  now: number;
  /** At most the 60 s default; anything else is a configuration error (as in the plugin). */
  maxLifetimeMs?: number;
  /** The binding the request was opened under. */
  binding: Tp1Binding;
  /** The seller's connection right now; it must be the one the binding was made with. */
  local: unknown;
  /**
   * Required: the tuple the seller kept for this job, or `null` when it keeps
   * none yet (a new purchase; the seller then keeps the request's). Omitted or
   * anything but the request's own tuple is refused.
   */
  purchaseProfile: Tp1WireProfile | null;
  requireDelegation?: boolean;
  /**
   * Required on every signed route: the job, Agreement hash and parties the
   * host retained before this request (for an initial proposal, the admitted
   * draft's hash and parties; for the context route, the exact context-scope
   * hash). Each must equal the signed jobId, agreementHash, buyer and seller
   * exactly, before any delegation scope, reservation or return. Omitted or
   * malformed is refused.
   */
  retained: WireRetainedAgreement;
  /**
   * The host's proposal draft and/or retained Agreement. On every request,
   * each one given must also name the signed job, Listing, buyer and seller.
   * At least one is required for delegated requests, and their deadline
   * bounds the delegation.
   */
  artifacts?: readonly unknown[];
  /**
   * Required for effect routes: the host's durable request journal. Anything
   * else, a bare callback or a journal without `durable: true` included, is
   * refused (`seller_replay_guard_required`) before it is called.
   */
  requestJournal?: WireRequestJournal;
  /**
   * Required on every route that starts or commits a purchase (proposals,
   * commitments, commitment signature, context): whether this seller accepts
   * new purchases now, from its own current state (the `ready` it would
   * publish). A buyer's endpoint proof can still say `ready: true` for up to
   * ten minutes after the seller drains, so such a request is refused here
   * (`seller_not_ready`, 503). The payment, delivery and read routes continue
   * a committed purchase and do not read it.
   */
  ready?: boolean;
}

/**
 * The seller host's request journal, a plain object. `durable: true` is the
 * host's statement that `reserve` atomically and durably reserves the key
 * before returning true, and returns false if it is already reserved, even for
 * the same hash. Share the journal across workers/restarts and retain the
 * reservation until retainUntil (expiresAt + maxClockSkewMs) by the journal's
 * clock: a worker refuses the request as expired from expiresAt by its own
 * clock, and its clock may lag the journal's. A failed/ambiguous effect must
 * not release it. `reserve` is synchronous and must finish its durable write
 * before returning; promises are refused. An in-memory set or a callback is
 * not durable: the wire refuses a journal that does not declare itself so. The
 * wire has no journal: a checked effect request authorizes no effect until
 * the host's journal passes restart and concurrent-worker tests (a TP-1
 * composition qualification entry).
 */
export interface WireRequestJournal {
  readonly durable: true;
  reserve(reservation: WireRequestReservation): boolean;
}

/** What the seller host retained for a job: never taken from the request it is compared with. */
export interface WireRetainedAgreement {
  jobId: string;
  agreementHash: string;
  /** The job's buyer and seller claims, from the host's own record: a request from anyone else is refused. */
  buyer: string;
  seller: string;
}

export interface WireRequestReservation {
  /** SHA-256 of {buyer, seller, profile, nonce}; shared across jobs and routes. */
  readonly key: string;
  readonly requestHash: string;
  readonly expiresAt: number;
  /**
   * expiresAt + maxClockSkewMs: the journal keeps the key until this instant
   * by its own clock, so a worker whose clock is up to maxClockSkewMs behind
   * the journal's, and still accepts the request, finds it reserved.
   */
  readonly retainUntil: number;
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

const CHECK_FIELDS = ["seller", "listingPin", "method", "path", "rawBody", "now", "maxLifetimeMs", "binding", "local", "purchaseProfile", "requireDelegation", "retained", "artifacts", "requestJournal", "ready"] as const;

/**
 * A request that starts or commits a purchase (every effect route the buyer
 * does not sign as a continuation) is admitted only while the seller accepts
 * new purchases by its own current state, never a buyer's kept proof.
 */
function admitNewPurchase(request: WireRequestPayload, ready: unknown): void {
  if (isReadRoute(request.path) || CONTINUING_PATHS.includes(request.path)) return;
  if (typeof ready !== "boolean") fail("seller_readiness_required", 500);
  if (!ready) fail("seller_not_ready", 503);
}

function reserveEffectRequest(request: WireRequestPayload, journal: unknown): void {
  if (isReadRoute(request.path)) return;
  // Only a journal that declares itself durable reserves an effect: a bare callback or an undeclared store is never called.
  const { durable, reserve } = isRecord(journal) ? ownedFields(journal, ["durable", "reserve"]) : { durable: undefined, reserve: undefined };
  if (durable !== true || typeof reserve !== "function") fail("seller_replay_guard_required", 500);
  const { buyer, seller, profile, nonce } = request;
  const reservation = deepFreeze({ key: sha256Hex(canonicalize({ buyer, seller, profile, nonce })),
    requestHash: wireRequestHash(request), expiresAt: request.expiresAt,
    retainUntil: request.expiresAt + DACS_SELLER_HTTP_LIMITS.maxClockSkewMs });
  const result = (reserve as WireRequestJournal["reserve"]).call(journal, reservation);
  if (result === false) fail("peer_request_replayed", 409);
  if (result !== true) fail("seller_replay_guard_invalid", 500);
}

export interface CheckedWireRequest {
  /** The admitted request body. Effect handling must use this, never a separately parsed copy. */
  body: JsonRecord;
  /**
   * Only an expired delegation authenticates the request. Such requests can
   * reach only declared read routes; effect routes are refused by this check.
   */
  readbackOnly: boolean;
}

/**
 * Seller-side binding of an opened request to this HTTP exchange
 * (the plugin's server-side request checks, without its body checks). It takes only the
 * value openWireEnvelope returned, under the same binding, and the seller's
 * current connection: a payload or delegation the caller assembled is refused.
 * The check is read once (ownedFields), and its Listing pin, retained
 * Agreement, artifacts and body bytes copied once. The tuple kept for the job
 * is compared first, then the exchange, then the job and Agreement the host
 * retained. The received body bytes are admitted (CF-5) before their hash is
 * compared, and the admitted body is returned.
 */
export function checkWireRequest(envelope: OpenedEnvelope<WireRequestPayload>, check: RequestCheck): CheckedWireRequest {
  const c = ownedFields(check, CHECK_FIELDS) as unknown as RequestCheck;
  assertTp1Binding(c.binding, c.local);
  const listingPin = ownedConfig(c.listingPin, "wire_input_invalid") as ListingPin;
  const retained = c.retained === undefined ? undefined : ownedConfig(c.retained, "seller_retained_agreement_required") as JsonRecord;
  const artifacts = (c.artifacts === undefined ? [] : ownedArtifact(c.artifacts, "wire_input_invalid", 500)) as unknown[];
  if (!Array.isArray(artifacts)) fail("wire_input_invalid", 500);
  // Over 64 KiB is refused as admission refuses it, before the body is copied or anything else is checked.
  const rawBody = ownedBytes(c.rawBody, "wire_input_invalid", 500, { maxBytes: DACS_SELLER_HTTP_LIMITS.maxRequestBodyBytes, code: "bad_json", status: 400 });
  if (typeof envelope !== "object" || envelope === null || openedBinding(opened, envelope) !== c.binding ||
      envelope.payload?.kind !== "request") fail("peer_request_unverified", 500);
  // openWireEnvelope checked the kept tuple and the request's own; the tuple kept now is checked again.
  if (c.purchaseProfile !== null) assertPurchaseProfile(c.purchaseProfile, c.binding, 500);
  const { payload: request, delegation } = envelope;
  assertTp1Authority(c.binding, c.local, [request.buyer, request.seller], request.jobId);
  const maxLifetimeMs = messageLifetime(c.maxLifetimeMs, "seller_configuration_invalid");
  if (request.seller !== c.seller) fail("peer_audience_wrong");
  if (!isUint(c.now) || request.expiresAt <= c.now || request.expiresAt > c.now + maxLifetimeMs) fail("peer_expired", 408);
  const body = admitWireRequestBody(rawBody);
  if (request.method !== c.method || request.path !== c.path || request.bodyHash !== sha256Hex(rawBody)) fail("peer_request_mismatch");
  if (!sameCanonical(request.listingPin, listingPin)) fail("peer_listing_mismatch", 409);
  // A correctly signed request naming another job or Agreement never reaches the delegation scope, a reservation or a handler.
  if (!hasKeys(retained, ["jobId", "agreementHash", "buyer", "seller"]) || !isCanonicalJobId(retained.jobId) || !isHash(retained.agreementHash) ||
      !isClaim(retained.buyer) || !isClaim(retained.seller)) {
    fail("seller_retained_agreement_required", 500);
  }
  if (request.jobId !== retained.jobId) fail("peer_job_mismatch", 409);
  if (request.agreementHash !== retained.agreementHash) fail("peer_agreement_mismatch", 409);
  // The retained parties bind every request, with or without artifacts: another key that knows the job and its public Agreement is refused.
  if (request.buyer !== retained.buyer) fail("peer_agreement_party_mismatch", 409);
  if (request.seller !== retained.seller) fail("peer_agreement_party_mismatch", 409);
  if (c.requireDelegation && !delegation) fail("peer_delegation_required");
  // Every host artifact given binds the signed job, Listing and both parties, on a direct request as on a delegated one.
  const retainedArtifacts = artifacts.filter((a) => a != null) as JsonRecord[];
  for (const artifact of retainedArtifacts) {
    const parties = Array.isArray(artifact.parties) ? (artifact.parties as JsonRecord[]) : [];
    if (artifact.jobId !== request.jobId || !sameCanonical(artifact.listingRef ?? null, listingPin) ||
        parties.find((party) => party?.role === "buyer")?.primaryClaim !== request.buyer ||
        parties.find((party) => party?.role === "seller")?.primaryClaim !== request.seller) {
      fail(delegation ? "peer_delegation_agreement_mismatch" : "peer_agreement_party_mismatch", 409);
    }
  }
  if (!delegation) {
    admitNewPurchase(request, c.ready);
    reserveEffectRequest(request, c.requestJournal);
    return { body, readbackOnly: false };
  }
  if (retainedArtifacts.length === 0) fail("peer_delegation_agreement_required", 409);
  for (const artifact of retainedArtifacts) {
    const deadline = (artifact.terms as JsonRecord | undefined)?.deadline;
    if (!isUint(deadline)) fail("peer_delegation_deadline", 409);
    verifySellerSessionDelegation(delegation, { binding: c.binding, local: c.local, deadline: deadline as number });
  }
  verifySellerSessionDelegation(delegation, { binding: c.binding, local: c.local, buyer: request.buyer, seller: request.seller, listingPin, jobId: request.jobId, time: c.now, allowExpired: true });
  if (c.now < delegation.payload.expiresAt && request.expiresAt <= delegation.payload.expiresAt) {
    admitNewPurchase(request, c.ready);
    reserveEffectRequest(request, c.requestJournal);
    return { body, readbackOnly: false };
  }
  // An expired delegation, or a request that outlives a live one, authenticates readback only. The buyer
  // picks readback by its own clock, which may run ahead of this one: a read route is answered either way.
  // A nonce reservation never extends expired delegation authority.
  // Refuse effect routes rather than returning a flag a host could overlook.
  if (!isReadRoute(request.path)) fail("peer_delegation_expired", 408);
  return { body, readbackOnly: true };
}

/** CF-5 admission of a received request body (64 KiB); it must be a JSON object. */
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

/** CF-5 admission of a received response body (512 KiB); it must be a JSON object. */
export function admitWireResponseBody(bytes: Uint8Array): JsonRecord {
  const body = admitWireJson(bytes, DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes, "response_json_rejected", 502);
  if (body === null || typeof body !== "object" || Array.isArray(body)) fail("response_json_rejected", 502, "NOT-AN-OBJECT");
  return body as JsonRecord;
}
