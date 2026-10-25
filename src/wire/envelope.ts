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
import { commitmentReceiptTime, type CommitmentReceiptReader } from "./commitment.js";
import { journalStore, reserveEffect, type WireEffect, type WireRequestJournal } from "./journal.js";
import { assertEndpointProof, isContinuingRoute, type EndpointProof } from "./discovery.js";
import { assertPeerProfile, assertPurchaseProfile, assertTp1Binding, assertTp1Authority, isTp1WireProfile, type Tp1Binding, type Tp1WireProfile } from "./profile.js";
import { DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_LIMITS, DACS_SELLER_HTTP_PATHS, isReadRoute } from "./routes.js";
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
   * Required for effect routes: the journal openWireRequestJournal returned
   * (journal.ts). Anything else, a host's own journal object included, is
   * refused (`seller_replay_guard_required`) before anything is reserved.
   */
  requestJournal?: WireRequestJournal;
  /**
   * Required on the payment and delivery routes (CONTINUING_PATHS): the job's
   * finalized commitment, as the exact bytes the seller read itself (the
   * result commitFixedPriceAgreement returned or a later read of the same
   * record), or a value the wire admitted (admitWireArtifact); it is admitted
   * (CF-5) before it is read. The wire checks it against the retained job, Agreement, parties and
   * Listing pin, and authenticates its receipt with `readCommitmentReceipt`,
   * for every request (commitment.ts). `null`, the host's own reader having
   * found no commitment, refuses the request as `peer_agreement_uncommitted`
   * (409); omitted is `seller_commitment_required` (500).
   */
  commitment?: unknown;
  /**
   * Required with `commitment`: the retained Agreement both parties signed
   * that it commits, as bytes or an admitted value, like `commitment`. Its
   * hash, job, Listing, parties and both signatures are checked (DACS-3 §8.6
   * CA-7), and its terms against `signedListing` at the receipt time by the
   * SDK's DACS-3 §8.5.2 verifier (checks 1-4: detail `LISTING-TERMS`); either
   * fault is `continuation_agreement_invalid`.
   */
  agreement?: unknown;
  /** The seller's SR-2 receipt reader for `commitment` (commitment.ts); required with it. */
  readCommitmentReceipt?: CommitmentReceiptReader;
  /**
   * Required with `commitment`: the seller's own signed Listing that the
   * request's Listing pin names, as its exact bytes or an admitted value, like
   * `commitment`. The wire reads its commit phase (which selects the Agreement
   * type before any signature is read: DACS-3 §8.5.2 check 9, CA-5, CA-7),
   * validity window and deadlineSecAfterCommit from it, never from a host's
   * statement of them, and refuses a commitment the Standard's post-finality
   * checks 5 and 6 make invalid (commitment.ts). Another Listing, or none, is
   * `continuation_listing_invalid`; a phase other than `commit-payee-bound-agreement` is
   * `continuation_phase_unsupported` (500). It must be TP-1's Listing: one
   * `pay-dem` phase and one `deliver-storage-program` phase
   * (`continuation_phase_unsupported`), a `storage-program` deliverable and
   * fixed DEM pricing (`continuation_listing_invalid`).
   */
  signedListing?: unknown;
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

/** What the seller host retained for a job: never taken from the request it is compared with. */
export interface WireRetainedAgreement {
  jobId: string;
  agreementHash: string;
  /** The job's buyer and seller claims, from the host's own record: a request from anyone else is refused. */
  buyer: string;
  seller: string;
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

const CHECK_FIELDS = ["seller", "listingPin", "method", "path", "rawBody", "now", "maxLifetimeMs", "binding", "local", "purchaseProfile", "requireDelegation", "retained", "artifacts", "requestJournal", "ready", "commitment", "agreement", "readCommitmentReceipt", "signedListing"] as const;

/**
 * A request that starts or commits a purchase (every effect route the buyer
 * does not sign as a continuation) is admitted only while the seller accepts
 * new purchases by its own current state, never a buyer's kept proof.
 */
function admitNewPurchase(request: WireRequestPayload, ready: unknown): void {
  if (isReadRoute(request.path) || isContinuingRoute(request.path)) return;
  if (typeof ready !== "boolean") fail("seller_readiness_required", 500);
  if (!ready) fail("seller_not_ready", 503);
}

/**
 * A payment or delivery request continues only a purchase whose finalized
 * commitment the seller holds for exactly this job, Agreement, parties and
 * Listing, for an Agreement both parties signed, valid at its receipt time
 * under the seller's own Listing, its receipt authenticated now (commitment.ts).
 */
async function admitContinuation(request: WireRequestPayload, c: RequestCheck, listingPin: ListingPin): Promise<void> {
  if (!isContinuingRoute(request.path)) return;
  if (c.commitment === null) fail("peer_agreement_uncommitted", 409);
  if (c.commitment === undefined) fail("seller_commitment_required", 500);
  await commitmentReceiptTime(c.commitment, c.agreement, c.signedListing, c.readCommitmentReceipt, { binding: c.binding, seller: request.seller, listingPin, now: c.now,
    request: { jobId: request.jobId, agreementHash: request.agreementHash, buyer: request.buyer } });
}

/** The journal an effect route needs, before anything about the request is admitted; null on a read route. */
function effectJournal(request: WireRequestPayload, journal: unknown): object | null {
  return isReadRoute(request.path) ? null : journalStore(journal);
}

/**
 * The effect's identity is its job's and route's only: {seller, jobId, path}.
 * A request with a fresh nonce, other incidental body fields, or another
 * Agreement hash, buyer or tuple for the same job and route is the same
 * operation. The journal records the binding the operation was first reserved
 * under ({profile, buyer, agreementHash}) and refuses any other one
 * (`peer_operation_mismatch`); the same binding gets the recorded outcome,
 * never a second effect (journal.ts).
 */
export function wireOperationId(request: Pick<WireRequestPayload, "seller" | "jobId" | "path">): string {
  const { seller, jobId, path } = request;
  return sha256Hex(canonicalize({ seller, jobId, path }));
}

function reserveEffectRequest(request: WireRequestPayload, store: object | null): WireEffect | null {
  if (store === null) return null;
  const { buyer, seller, profile, nonce, agreementHash, jobId, path } = request;
  return reserveEffect(store, { key: sha256Hex(canonicalize({ buyer, seller, profile, nonce })), seller, jobId, path,
    binding: sha256Hex(canonicalize({ profile, buyer, agreementHash })), requestHash: wireRequestHash(request) });
}

/**
 * Receipt and authority reads can take time. Check current authority first,
 * then both expiries at the check's start plus all elapsed time, just before reservation.
 */
async function assertStillAuthorized(request: WireRequestPayload, c: RequestCheck, delegationExpiresAt: number | null, startedAt: number): Promise<void> {
  await assertTp1Authority(c.binding, c.local, [request.buyer, request.seller], request.jobId);
  const at = c.now + (performance.now() - startedAt);
  if (request.expiresAt <= at) fail("peer_expired", 408);
  if (delegationExpiresAt !== null && delegationExpiresAt <= at) fail("peer_delegation_expired", 408);
}

/** Every per-request admission an effect needs, in order, then its reservation. */
async function admitEffect(request: WireRequestPayload, c: RequestCheck, listingPin: ListingPin, delegationExpiresAt: number | null, startedAt: number): Promise<WireEffect | null> {
  const store = effectJournal(request, c.requestJournal);
  admitNewPurchase(request, c.ready);
  await admitContinuation(request, c, listingPin);
  if (store !== null) await assertStillAuthorized(request, c, delegationExpiresAt, startedAt);
  return reserveEffectRequest(request, store);
}

export interface CheckedWireRequest {
  /** The admitted request body. Effect handling must use this, never a separately parsed copy. */
  body: JsonRecord;
  /**
   * Only an expired delegation authenticates the request. Such requests can
   * reach only declared read routes; effect routes are refused by this check.
   */
  readbackOnly: boolean;
  /**
   * The effect route's operation, from the request journal (journal.ts):
   * `new` or `recover` (run, or first reconcile, then completeWireEffect) or
   * `completed` (answer with its outcome; run nothing). `null` on a read route.
   */
  effect: WireEffect | null;
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
export async function checkWireRequest(envelope: OpenedEnvelope<WireRequestPayload>, check: RequestCheck): Promise<CheckedWireRequest> {
  const startedAt = performance.now();
  const c = ownedFields(check, CHECK_FIELDS) as unknown as RequestCheck;
  const listingPin = ownedConfig(c.listingPin, "wire_input_invalid") as ListingPin;
  const retained = c.retained === undefined ? undefined : ownedConfig(c.retained, "seller_retained_agreement_required") as JsonRecord;
  const artifacts = (c.artifacts === undefined ? [] : ownedArtifact(c.artifacts, "wire_input_invalid", 500)) as unknown[];
  if (!Array.isArray(artifacts)) fail("wire_input_invalid", 500);
  // Over 64 KiB is refused as admission refuses it, before the body is copied or anything else is checked.
  const rawBody = ownedBytes(c.rawBody, "wire_input_invalid", 500, { maxBytes: DACS_SELLER_HTTP_LIMITS.maxRequestBodyBytes, code: "bad_json", status: 400 });
  await assertTp1Binding(c.binding, c.local);
  if (typeof envelope !== "object" || envelope === null || openedBinding(opened, envelope) !== c.binding ||
      envelope.payload?.kind !== "request") fail("peer_request_unverified", 500);
  // openWireEnvelope checked the kept tuple and the request's own; the tuple kept now is checked again.
  if (c.purchaseProfile !== null) await assertPurchaseProfile(c.purchaseProfile, c.binding, 500);
  const { payload: request, delegation } = envelope;
  await assertTp1Authority(c.binding, c.local, [request.buyer, request.seller], request.jobId);
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
    return { body, readbackOnly: false, effect: await admitEffect(request, c, listingPin, null, startedAt) };
  }
  if (retainedArtifacts.length === 0) fail("peer_delegation_agreement_required", 409);
  // This frozen copy came only from an authenticated, CF-5-admitted envelope.
  const admittedDelegation = admitWireJson(Buffer.from(JSON.stringify(delegation)), DACS_SELLER_HTTP_LIMITS.maxHeaderLength, "peer_delegation_invalid", 401);
  const scope = { binding: c.binding, local: c.local, buyer: request.buyer, seller: request.seller, listingPin, jobId: request.jobId, time: c.now, allowExpired: true };
  for (const artifact of retainedArtifacts) {
    const deadline = (artifact.terms as JsonRecord | undefined)?.deadline;
    if (!isUint(deadline)) fail("peer_delegation_deadline", 409);
    await verifySellerSessionDelegation(admittedDelegation, { ...scope, deadline: deadline as number });
  }
  await verifySellerSessionDelegation(admittedDelegation, scope);
  if (c.now < delegation.payload.expiresAt && request.expiresAt <= delegation.payload.expiresAt) {
    return { body, readbackOnly: false, effect: await admitEffect(request, c, listingPin, delegation.payload.expiresAt, startedAt) };
  }
  // An expired delegation, or a request that outlives a live one, authenticates readback only. The buyer
  // picks readback by its own clock, which may run ahead of this one: a read route is answered either way.
  // A nonce reservation never extends expired delegation authority.
  // Refuse effect routes rather than returning a flag a host could overlook.
  if (!isReadRoute(request.path)) fail("peer_delegation_expired", 408);
  return { body, readbackOnly: true, effect: null };
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
