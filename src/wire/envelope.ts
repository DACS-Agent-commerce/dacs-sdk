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
import { inspectWireOperation, journalStore, reserveEffect, type WireEffect, type WireRequestJournal } from "./journal.js";
import { assertEndpointProof, isCommittedRoute, isContinuingRoute, isStageRoute, type EndpointProof, type RetainedPurchaseContinuation } from "./discovery.js";
import { assertPeerProfile, assertPurchaseProfile, assertTp1Binding, assertTp1Authority, isTp1WireProfile, type Tp1Binding, type Tp1WireProfile } from "./profile.js";
import { DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_LIMITS, DACS_SELLER_HTTP_PATHS, isPreAgreementRoute, isReadRoute } from "./routes.js";
import { verifySellerSessionDelegation, type SellerSessionDelegation, type SellerSessionDelegationPayload } from "./delegation.js";
import {
  admitWireJson, claimKey, cloneJson, envelopeSignatureBytes, fail, hasKeys, isClaim, isHash, isListingPin, withCanonicalClaims,
  isRecord, isUint, lacksProfile, NONCE, ownedArtifact, ownedBytes, ownedConfig, ownedFields, ownedOrNothing, sameCanonical,
  uncurry, verifyEd25519, walletSignatureBytes, type JsonRecord, type ListingPin, type WireSigner,
} from "./validate.js";
import { deepFreeze } from "../internal/deepFreeze.js";

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
  /** Retained purchase work signed under a `ready: false` proof: the capability for this exact request (WireRequestInput.continuation). */
  continuation?: RetainedPurchaseContinuation;
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
 * The signature the signer returns is verified under the key the receiver will
 * use (the delegated session key, else the buyer's key for a request or the
 * seller's for a response); a signature that does not verify throws
 * `peer_signature_invalid` and no header is returned.
 */
export async function signWireEnvelope(supplied: WirePayload, context: EnvelopeSigningContext, suppliedDelegation?: SellerSessionDelegation | null): Promise<string> {
  const { signer, binding, local, purchaseProfile, endpointProof, publicEndpoint, now, commitment, agreement, signedListing, continuation } = ownedFields(context, ["signer", "binding", "local", "purchaseProfile", "endpointProof", "publicEndpoint", "now", "commitment", "agreement", "signedListing", "continuation"]) as EnvelopeSigningContext;
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
  const verifiedDelegation = delegation === null ? null : await verifySellerSessionDelegation(Buffer.from(canonicalize(delegation)), {
    binding, local, buyer: payload.buyer as string, seller: payload.seller as string, listingPin: payload.listingPin as ListingPin, jobId: payload.jobId as string, time: now,
    allowExpired: true,
  });
  if (payload.kind === "request") await assertEndpointProof(endpointProof, {
    binding, seller: payload.seller as string, listingPin: payload.listingPin as ListingPin,
    publicEndpoint: publicEndpoint as string, now: now as number, request: payload as unknown as WireRequestPayload, commitment, agreement, signedListing, continuation,
  });
  await assertTp1Authority(binding, local, [payload.buyer as string, payload.seller as string], payload.jobId as string);
  const signatureBytes = envelopeSignatureBytes(await (signer as WireSigner).sign(signingBytes));
  // The receiver verifies under the delegated session key, or else the key of the actor the payload names.
  const verifyingKey = verifiedDelegation?.sessionPublicKey ?? claimKey((payload.kind === "request" ? payload.buyer : payload.seller) as string);
  if (!verifyEd25519(signingBytes, signatureBytes, verifyingKey)) fail("peer_signature_invalid", 500);
  const signature = signatureBytes.toString("base64url");
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
  // DACS-1 reader rule: a `DID:` scheme resolves as `did:` and is canonicalised before hashing, signing or comparison (CF-2): every check, the signature and the authentication hash below read the canonical copy.
  const canonical = withCanonicalClaims(p, ["buyer", "seller"]);
  if (!payloadShape(canonical, kind)) fail("peer_envelope_invalid");
  if (requireDelegation && !delegated) fail("peer_delegation_required");
  const payload = canonical as unknown as Extract<WirePayload, { kind: K }>;
  const actor = kind === "request" ? payload.buyer : payload.seller;
  if (principal !== undefined && actor !== principal) fail("peer_signer_wrong");
  // The opener has no clock: whether the delegation is still live is the admitting caller's decision.
  const delegation = delegated ? await verifySellerSessionDelegation(envelope.delegation, { binding, local, buyer: payload.buyer, seller: payload.seller, listingPin: payload.listingPin, jobId: payload.jobId, allowExpired: true }) : null;
  const key = delegation?.sessionPublicKey ?? claimKey(actor);
  if (!verifyEd25519(wireEnvelopeSigningBytes(payload as unknown as WirePayload), envelopeSignatureBytes(envelope.signature), key)) fail("peer_signature_invalid");
  // The trusted reader is asked about these participants and this job only once a signature authenticates them.
  await assertTp1Authority(binding, local, [payload.buyer, payload.seller], payload.jobId);
  const normalizedDelegation = delegated ? {
    payload: delegation,
    signature: walletSignatureBytes((envelope.delegation as SellerSessionDelegation).signature).toString("base64url"),
  } : null;
  // The authenticated header in CF-2 canonical form: its payload and delegation are the canonical copies the signatures cover.
  const normalizedHeader = Buffer.from(canonicalize({ payload, signature: envelopeSignatureBytes(envelope.signature).toString("base64url"),
    ...(normalizedDelegation ? { delegation: normalizedDelegation } : {}) })).toString("base64url");
  const result = deepFreeze({ payload: cloneJson(payload), delegation: delegated ? cloneJson({ ...(envelope.delegation as SellerSessionDelegation), payload: delegation as SellerSessionDelegationPayload }) : null,
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
   * malformed is refused. The proposals, commitments and commitment signature
   * routes take a WireRetainedStage. Pre-Agreement context takes the four
   * members plus host-owned `accepted`; every other route takes exactly four.
   */
  retained: WireRetainedAgreement | WireRetainedStage;
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
   * commitments, commitment signature, and both pre-Agreement routes through
   * `admitPreAgreementRequest`): whether this seller accepts new purchases
   * now, from its own current state (the `ready` it would
   * publish). A buyer's endpoint proof can still say `ready: true` for up to
   * ten minutes after the seller drains, so such a request is refused here
   * (`seller_not_ready`, 503). The payment, delivery and read routes continue
   * a committed purchase and do not read it. While it is false, the proposals,
   * commitments and commitment signature routes are still admitted when
   * `retained.allocated` is true, or when the journal already holds the
   * route's operation under this request's binding; the context route when
   * `retained.accepted` is true.
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

/** What the host retains on the proposals, commitments and commitment signature routes: also whether it holds a live allocation for this stage (`allocated`, from its own records, never the request). */
export interface WireRetainedStage extends WireRetainedAgreement {
  allocated: boolean;
}

const RETAINED_MEMBERS = ["jobId", "agreementHash", "buyer", "seller"];

/** The members the host retains for a route: the stage routes add `allocated`, the context route `accepted`. */
function retainedMembers(path: string): string[] {
  if (isStageRoute(path)) return [...RETAINED_MEMBERS, "allocated"];
  return path === DACS_SELLER_HTTP_PATHS.context ? [...RETAINED_MEMBERS, "accepted"] : RETAINED_MEMBERS;
}

/** The retained record's exact members for a route, each well-formed: anything else is `seller_retained_agreement_required` (500). */
function assertRetainedShape(path: string, retained: JsonRecord | undefined): asserts retained is JsonRecord {
  const stage = isStageRoute(path);
  if (!hasKeys(retained, retainedMembers(path)) || !isCanonicalJobId(retained.jobId) || !isHash(retained.agreementHash) ||
      !isClaim(retained.buyer) || !isClaim(retained.seller) || (stage && typeof retained.allocated !== "boolean")) fail("seller_retained_agreement_required", 500);
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

const AGREEMENT_EVIDENCE_FIELDS: readonly string[] = ["artifacts", "commitment", "agreement", "readCommitmentReceipt", "signedListing"];
const PRE_AGREEMENT_CHECK_FIELDS = [...CHECK_FIELDS.filter((field) => !AGREEMENT_EVIDENCE_FIELDS.includes(field)), "route"];

/**
 * What `admitPreAgreementRequest` needs: `RequestCheck` without the Agreement
 * evidence (artifacts, commitment, agreement, receipt reader, signed Listing),
 * plus the `route` the host is serving, which must be the request's path. The
 * challenge route takes the four retained members; the context route takes
 * them plus the host's own `accepted`: whether its admission of this scope may
 * continue while the seller is not ready. `accepted` is never taken from the
 * request, and any other member set is refused.
 */
export type PreAgreementCheck = Omit<RequestCheck, "artifacts" | "commitment" | "agreement" | "readCommitmentReceipt" | "signedListing" | "retained"> & {
  route: "contextChallenge" | "context";
  retained: WireRetainedAgreement & { accepted?: boolean };
};

/** A pre-Agreement request admitted by `admitPreAgreementRequest`. */
export interface AdmittedPreAgreementRequest {
  readonly route: PreAgreementCheck["route"];
  /** The admitted request body. Handling must use this, never a separately parsed copy. */
  readonly body: JsonRecord;
  /** When the admitted delegation expires; `null` on a direct request, which carries none. */
  readonly delegationExpiresAt: number | null;
  /**
   * Context route only: the reservation in the request journal, made when it is
   * called, after the host's accounting. It re-checks current authority, then
   * the request's expiry, then the delegation's (time counted from the check's
   * start), and resolves as `CheckedWireRequest.reserve` does. Admission itself
   * writes nothing. Absent on the challenge route, which has no journal operation.
   */
  readonly reserve?: () => Promise<WireEffect>;
}

/**
 * A request that starts or commits a purchase on the stage routes is admitted
 * only while the seller accepts new purchases by its own current state, never
 * a buyer's kept proof. While it does not, it is admitted only for a purchase
 * the host retains (`retained.allocated`, or the journal's operation is bound
 * to this request).
 */
function admitNewPurchase(request: WireRequestPayload, c: RequestCheck, retained: JsonRecord): void {
  if (isReadRoute(request.path) || isContinuingRoute(request.path)) return;
  if (typeof c.ready !== "boolean") fail("seller_readiness_required", 500);
  if (c.ready || retained.allocated === true || hasBoundOperation(request, c.requestJournal)) return;
  fail("seller_not_ready", 503);
}

/** Whether the journal already holds this request's operation under the binding the request carries: work the seller began, whatever its state. */
function hasBoundOperation(request: WireRequestPayload, journal: WireRequestJournal | undefined): boolean {
  if (journal === undefined) return fail("seller_replay_guard_required", 500);
  const view = inspectWireOperation(journal, request);
  return view.state !== "none" && view.binding === wireOperationBinding(request);
}

/**
 * A payment, delivery or buyer-copy request continues only a purchase whose finalized
 * commitment the seller holds for exactly this job, Agreement, parties and
 * Listing, for an Agreement both parties signed, valid at its receipt time
 * under the seller's own Listing, its receipt authenticated now (commitment.ts).
 */
async function admitContinuation(request: WireRequestPayload, c: RequestCheck, listingPin: ListingPin): Promise<void> {
  if (!isCommittedRoute(request.path)) return;
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

/** The binding an operation is first reserved under (sha256 of the canonical profile, buyer and Agreement hash): compare it with inspectWireOperation's `binding`. */
export function wireOperationBinding(request: Pick<WireRequestPayload, "profile" | "buyer" | "agreementHash">): string {
  const { profile, buyer, agreementHash } = request;
  return sha256Hex(canonicalize({ profile, buyer, agreementHash }));
}

function reserveEffectRequest(request: WireRequestPayload, store: object): WireEffect {
  const { buyer, seller, profile, nonce, jobId, path } = request;
  return reserveEffect(store, { key: sha256Hex(canonicalize({ buyer, seller, profile, nonce })), seller, jobId, path,
    binding: wireOperationBinding(request), requestHash: wireRequestHash(request) });
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

/** What admission leaves for the host: the authority and expiry re-check (`authorize`), then reserve (which runs it first). */
interface Deferred {
  authorize: (() => Promise<void>) | null;
  reserve: (() => Promise<WireEffect>) | null;
}
const NOTHING_DEFERRED: Deferred = Object.freeze({ authorize: null, reserve: null });

/** What admission carries from the check to the deferred steps. */
interface EffectAdmission { listingPin: ListingPin; retained: JsonRecord; delegationExpiresAt: number | null; startedAt: number }

/** Every per-request admission an effect needs, in order. Its journal write is `reserve()`, which the host calls after its own accounting. */
async function admitEffect(request: WireRequestPayload, c: RequestCheck, { listingPin, retained, delegationExpiresAt, startedAt }: EffectAdmission): Promise<Deferred> {
  const store = effectJournal(request, c.requestJournal);
  admitNewPurchase(request, c, retained);
  await admitContinuation(request, c, listingPin);
  if (store === null) return NOTHING_DEFERRED;
  return deferredReservation(request, c, store, delegationExpiresAt, startedAt);
}

/** The authority and expiry re-check, and the reservation behind it, for an effect route: also pre-Agreement context. */
function deferredReservation(request: WireRequestPayload, c: RequestCheck, store: object, delegationExpiresAt: number | null, startedAt: number): { authorize: () => Promise<void>; reserve: () => Promise<WireEffect> } {
  const authorize = () => assertStillAuthorized(request, c, delegationExpiresAt, startedAt);
  return { authorize, reserve: async () => { await authorize(); return reserveEffectRequest(request, store); } };
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
   * The effect route's reservation in the request journal (journal.ts), made
   * when it is called, after the host's accounting. It re-checks current
   * authority, then the request's expiry, then the delegation's (time counted
   * from the check's start), and resolves `new` or `recover` (run, or first
   * reconcile, then completeWireEffect) or `completed` (answer with its
   * outcome; run nothing). It rejects with the journal's answer: a second call
   * is `peer_request_replayed`. `null` on a read route.
   */
  reserve: (() => Promise<WireEffect>) | null;
}

/**
 * Seller-side binding of an opened request to this HTTP exchange
 * (the plugin's server-side request checks, without its body checks), shared by
 * both admission entries and authorizeWireRequest. It takes only the
 * value openWireEnvelope returned, under the same binding, and the seller's
 * current connection: a payload or delegation the caller assembled is refused.
 * The check is read once (ownedFields), and its Listing pin, retained
 * Agreement, artifacts and body bytes copied once. The tuple kept for the job
 * is compared first, then the exchange, then the job and Agreement the host
 * retained. The received body bytes are admitted (CF-5) before their hash is
 * compared, and the admitted body is returned.
 */
async function requestAdmissionPrefix(envelope: OpenedEnvelope<WireRequestPayload>, check: RequestCheck | PreAgreementCheck, preAgreement: boolean): Promise<RequestAdmissionPrefix> {
  const startedAt = performance.now();
  const c = ownedFields(check, preAgreement ? PRE_AGREEMENT_CHECK_FIELDS : CHECK_FIELDS) as unknown as RequestCheck & { route?: unknown };
  const listingPin = ownedConfig(c.listingPin, "wire_input_invalid") as ListingPin;
  const retained = c.retained === undefined ? undefined : ownedConfig(c.retained, "seller_retained_agreement_required") as JsonRecord;
  const artifacts = (c.artifacts === undefined ? [] : ownedArtifact(c.artifacts, "wire_input_invalid", 500)) as unknown[];
  if (!Array.isArray(artifacts)) fail("wire_input_invalid", 500);
  // Over 64 KiB is refused as admission refuses it, before the body is copied or anything else is checked.
  const rawBody = ownedBytes(c.rawBody, "wire_input_invalid", 500, { maxBytes: DACS_SELLER_HTTP_LIMITS.maxRequestBodyBytes, code: "bad_json", status: 400 });
  await assertTp1Binding(c.binding, c.local);
  if (typeof envelope !== "object" || envelope === null || openedBinding(opened, envelope) !== c.binding ||
      envelope.payload?.kind !== "request") fail("peer_request_unverified", 500);
  // A pre-Agreement route issues a nonce no Agreement covers: it is admitted only by admitPreAgreementRequest.
  if (!preAgreement && isPreAgreementRoute(envelope.payload.path)) fail("wire_route_requires_preagreement", 500);
  // openWireEnvelope checked the kept tuple and the request's own; the tuple kept now is checked again.
  if (c.purchaseProfile !== null) await assertPurchaseProfile(c.purchaseProfile, c.binding, 500);
  const { payload: request, delegation } = envelope;
  await assertTp1Authority(c.binding, c.local, [request.buyer, request.seller], request.jobId);
  const maxLifetimeMs = messageLifetime(c.maxLifetimeMs, "seller_configuration_invalid");
  if (preAgreement && (!isPreAgreementRouteName(c.route) || DACS_SELLER_HTTP_PATHS[c.route] !== request.path)) fail("wire_input_invalid", 500);
  if (request.seller !== c.seller) fail("peer_audience_wrong");
  if (!isUint(c.now) || request.expiresAt <= c.now || request.expiresAt > c.now + maxLifetimeMs) fail("peer_expired", 408);
  const body = admitWireRequestBody(rawBody);
  if (request.method !== c.method || request.path !== c.path || request.bodyHash !== sha256Hex(rawBody)) fail("peer_request_mismatch");
  if (!sameCanonical(request.listingPin, listingPin)) fail("peer_listing_mismatch", 409);
  // A correctly signed request naming another job or Agreement never reaches the delegation scope, a reservation or a handler.
  assertRetainedShape(request.path, retained);
  if (request.jobId !== retained.jobId) fail("peer_job_mismatch", 409);
  if (request.agreementHash !== retained.agreementHash) fail("peer_agreement_mismatch", 409);
  // The retained parties bind every request, with or without artifacts: another key that knows the job and its public Agreement is refused.
  if (request.buyer !== retained.buyer) fail("peer_agreement_party_mismatch", 409);
  if (request.seller !== retained.seller) fail("peer_agreement_party_mismatch", 409);
  if (c.requireDelegation && !delegation) fail("peer_delegation_required");
  return { c, request, delegation, listingPin, retained, artifacts, body, startedAt };
}

/** What the shared prefix hands to each admission entry once its checks pass. */
interface RequestAdmissionPrefix {
  c: RequestCheck;
  request: WireRequestPayload;
  delegation: SellerSessionDelegation | null;
  listingPin: ListingPin;
  retained: JsonRecord;
  artifacts: unknown[];
  body: JsonRecord;
  startedAt: number;
}

const isPreAgreementRouteName = (route: unknown): route is PreAgreementCheck["route"] => route === "contextChallenge" || route === "context";

/** Re-admit the authenticated delegation copy before either admission path verifies it. */
function readmittedDelegation(delegation: SellerSessionDelegation): unknown {
  return admitWireJson(Buffer.from(JSON.stringify(delegation)), DACS_SELLER_HTTP_LIMITS.maxHeaderLength, "peer_delegation_invalid", 401);
}

async function admitWireRequest(envelope: OpenedEnvelope<WireRequestPayload>, check: RequestCheck): Promise<Omit<CheckedWireRequest, "reserve"> & Deferred> {
  const { c, request, delegation, listingPin, retained, artifacts, body, startedAt } = await requestAdmissionPrefix(envelope, check, false);
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
    return { body, readbackOnly: false, ...await admitEffect(request, c, { listingPin, retained, delegationExpiresAt: null, startedAt }) };
  }
  if (retainedArtifacts.length === 0) fail("peer_delegation_agreement_required", 409);
  // This frozen copy came only from an authenticated, CF-5-admitted envelope.
  const admittedDelegation = readmittedDelegation(delegation);
  const scope = { binding: c.binding, local: c.local, buyer: request.buyer, seller: request.seller, listingPin, jobId: request.jobId, time: c.now, allowExpired: true };
  for (const artifact of retainedArtifacts) {
    const deadline = (artifact.terms as JsonRecord | undefined)?.deadline;
    if (!isUint(deadline)) fail("peer_delegation_deadline", 409);
    await verifySellerSessionDelegation(admittedDelegation, { ...scope, deadline: deadline as number });
  }
  await verifySellerSessionDelegation(admittedDelegation, scope);
  if (c.now < delegation.payload.expiresAt && request.expiresAt <= delegation.payload.expiresAt) {
    return { body, readbackOnly: false, ...await admitEffect(request, c, { listingPin, retained, delegationExpiresAt: delegation.payload.expiresAt, startedAt }) };
  }
  // An expired delegation, or a request that outlives a live one, authenticates readback only. The buyer
  // picks readback by its own clock, which may run ahead of this one: a read route is answered either way.
  // A nonce reservation never extends expired delegation authority.
  // Refuse effect routes rather than returning a flag a host could overlook.
  if (!isReadRoute(request.path)) fail("peer_delegation_expired", 408);
  return { body, readbackOnly: true, ...NOTHING_DEFERRED };
}

/**
 * Step 13: a delegation the request carries must be live now, for this buyer,
 * seller, Listing pin and job, and must outlast the request; no deadline is
 * needed, as no Agreement exists. A direct request carries none. Verifier
 * failures other than scope and time (binding, profile, authority) propagate
 * unchanged. Returns the delegation's expiry, or `null`.
 */
async function admitPreAgreementDelegation({ c, request, delegation, listingPin }: RequestAdmissionPrefix): Promise<number | null> {
  if (!delegation) return null;
  const scope = { binding: c.binding, local: c.local, buyer: request.buyer, seller: request.seller, listingPin, jobId: request.jobId, time: c.now, allowExpired: false };
  const { expiresAt } = await verifySellerSessionDelegation(readmittedDelegation(delegation), scope);
  if (request.expiresAt > expiresAt) fail("peer_delegation_expired", 408);
  return expiresAt;
}

/** Step 14: new work needs `ready`; on the context route the host's `accepted` also lets a retained admission continue while it is false. */
function admitPreAgreementReadiness(request: WireRequestPayload, c: RequestCheck, retained: JsonRecord): void {
  const context = request.path === DACS_SELLER_HTTP_PATHS.context;
  if (typeof c.ready !== "boolean") fail("seller_readiness_required", 500);
  if (context && typeof retained.accepted !== "boolean") fail("seller_retained_agreement_required", 500);
  if (!c.ready && !(context && retained.accepted === true)) fail("seller_not_ready", 503);
}

/**
 * Admit a challenge or context request before any Agreement exists (K2): the
 * same binding, exchange, Listing and retained checks as `checkWireRequest`,
 * then the delegation it carries (live, in scope, outliving the request; direct
 * requests carry none unless `requireDelegation` is set), the context route's
 * journal handle, then readiness. Admission writes nothing and never reads
 * back under an expired delegation. On the context route `reserve()` makes the
 * journal reservation after the host's accounting.
 * @throws the first failing step's refusal (`wire_input_invalid` for a `route`
 * that is not the request's path); a verifier failure keeps its own code and cause.
 */
export async function admitPreAgreementRequest(envelope: OpenedEnvelope<WireRequestPayload>, check: PreAgreementCheck): Promise<AdmittedPreAgreementRequest> {
  const prefix = await requestAdmissionPrefix(envelope, check, true);
  const { c, request, retained, body, startedAt } = prefix;
  const delegationExpiresAt = await admitPreAgreementDelegation(prefix);
  const store = request.path === DACS_SELLER_HTTP_PATHS.context ? journalStore(c.requestJournal) : null;
  admitPreAgreementReadiness(request, c, retained);
  if (store === null) return Object.freeze({ route: "contextChallenge", body, delegationExpiresAt });
  return Object.freeze({ route: "context", body, delegationExpiresAt, reserve: deferredReservation(request, c, store, delegationExpiresAt, startedAt).reserve });
}

/** Admit an opened request (admitWireRequest) and return its body and, on an effect route, `reserve()`: nothing is journaled until the host calls it. */
export async function checkWireRequest(envelope: OpenedEnvelope<WireRequestPayload>, check: RequestCheck): Promise<CheckedWireRequest> {
  const { body, readbackOnly, reserve } = await admitWireRequest(envelope, check);
  return { body, readbackOnly, reserve };
}

/**
 * Admit an opened request as checkWireRequest does, then run the re-check `reserve()` begins with, and return without reserving or publishing anything: for a
 * host answering from its own retained state, such as a completed outcome it re-signs. A refusal keeps its own code and cause; success records no nonce key,
 * so the same signed request can be answered again until it expires.
 */
export async function authorizeWireRequest(envelope: OpenedEnvelope<WireRequestPayload>, check: RequestCheck): Promise<Pick<CheckedWireRequest, "body" | "readbackOnly">> {
  const { body, readbackOnly, authorize } = await admitWireRequest(envelope, check);
  await authorize?.();
  return { body, readbackOnly };
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
