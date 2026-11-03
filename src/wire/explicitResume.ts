// Explicit resume of dacs-seller-http/v1: a buyer-signed proof, in the
// `x-dacs-seller-resume` header, that the buyer asks the seller to resume one
// CREATE. It is bound to the exact request that carries it and is good once.
//
// The header is the base64url (no padding) encoding of the canonical JSON
// `{payload, signature}`, at most `maxHeaderLength` characters. The signed bytes
// are the `explicitCreateResume` domain followed by the canonical payload. The
// signer is the request's buyer, or the session key of the request's delegation.
// Nothing here reads a network or a store: a host brings the request it already
// opened, its clock and its one-use ledger.
import { canonicalize } from "../canonical/jcs.js";
import { sha256Hex } from "../canonical/hash.js";
import { isCanonicalJobId } from "../negotiate/jobId.js";
import type { SellerSessionDelegationPayload } from "./delegation.js";
import { wireRequestHash, type WireRequestPayload } from "./envelope.js";
import { assertPeerProfile, assertTp1Authority, assertTp1Binding, isTp1WireProfile, type Tp1Binding, type Tp1WireProfile } from "./profile.js";
import { DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_LIMITS, DACS_SELLER_HTTP_ROUTES } from "./routes.js";
import {
  admitWireJson, claimKey, cloneJson, envelopeSignatureBytes, fail, hasKeys, isClaim, isHash, isListingPin, isUint, NONCE, ownedArtifact, ownedConfig,
  ownedFields, sameCanonical, verifyEd25519, type JsonRecord, type ListingPin, type WireSigner,
} from "./validate.js";

/** Most unexpired proofs the in-memory ledger holds; past it a claim is refused rather than a live one forgotten. */
export const MAX_EXPLICIT_RESUME_CLAIMS = 4096;

const INVALID = "explicit_resume_invalid";
const SIGNATURE_INVALID = "explicit_resume_signature_invalid";
const KIND = "explicit-create-resume";

export interface ExplicitCreateResumePayload {
  version: "1";
  kind: "explicit-create-resume";
  /** The principal: the request's buyer. */
  buyer: string;
  seller: string;
  listingPin: ListingPin;
  jobId: string;
  /** The lane: the effect route the request is sent to. */
  path: string;
  agreementHash: string;
  /** `wireRequestHash` of the request that carries the header. */
  requestHash: string;
  /** Names this proof in the ledger; a nonce is used once per buyer, seller and profile. */
  nonce: string;
  expiresAt: number;
  profile: Tp1WireProfile;
}

const FIELDS = ["version", "kind", "buyer", "seller", "listingPin", "jobId", "path", "agreementHash", "requestHash", "nonce", "expiresAt", "profile"];
const CREATE_LANES: ReadonlySet<string> = new Set(DACS_SELLER_HTTP_ROUTES.filter((r) => r.auth === "signed" && r.effect === "effect").map((r) => r.path));

function isResumePayload(p: unknown): p is ExplicitCreateResumePayload {
  return hasKeys(p, FIELDS) && p.version === "1" && p.kind === KIND && isClaim(p.buyer) && isClaim(p.seller) && p.buyer !== p.seller &&
    isListingPin(p.listingPin) && isCanonicalJobId(p.jobId) && typeof p.path === "string" && CREATE_LANES.has(p.path) &&
    isHash(p.agreementHash) && isHash(p.requestHash) && typeof p.nonce === "string" && NONCE.test(p.nonce) &&
    Buffer.from(p.nonce, "base64url").toString("base64url") === p.nonce && isUint(p.expiresAt) && isTp1WireProfile(p.profile);
}

/** The bytes signed for a payload; `status` is 401 for a received proof and 500 for the signer's own. */
function resumeBytes(p: unknown, status: number): Buffer {
  if (!isResumePayload(p)) return fail(INVALID, status);
  return Buffer.from(`${DACS_SELLER_HTTP_DOMAINS.explicitCreateResume}${canonicalize(p)}`, "utf8");
}

const encodeHeader = (payload: ExplicitCreateResumePayload, signature: string): string => Buffer.from(canonicalize({ payload, signature })).toString("base64url");

/** The exact bytes the buyer's key signs for a payload. Throws `explicit_resume_invalid` (500) unless the payload has exactly the proof's members. */
export function explicitCreateResumeSigningBytes(payload: ExplicitCreateResumePayload): Buffer {
  return resumeBytes(ownedArtifact(payload, INVALID, 500), 500);
}

/** What `signExplicitCreateResume` needs besides the payload. */
export interface ExplicitResumeSigningContext {
  signer: WireSigner;
  binding: Tp1Binding;
  /** The signer's connection right now; it must be the one the binding was made with. */
  local: unknown;
  /** The signer's clock: `expiresAt` must be after it and at most `maxSignedLifetimeMs` ahead. */
  now: number;
}

/**
 * Signs one owned copy of the payload under the current TP-1 binding and returns
 * the `x-dacs-seller-resume` header for that copy.
 * Throws `explicit_resume_invalid` (500) for a payload that is not exactly the
 * proof's members, a signer other than the payload's buyer, or an `expiresAt`
 * outside the signer's lifetime; the TP-1 binding and authority errors of the
 * other signers; and `explicit_resume_signature_invalid` for a signature
 * the signer returned malformed. The longest payload the members allow gives a
 * header under `maxHeaderLength`, so no size check is needed here.
 */
export async function signExplicitCreateResume(supplied: ExplicitCreateResumePayload, context: ExplicitResumeSigningContext): Promise<string> {
  const { signer, binding, local, now } = ownedFields(context, ["signer", "binding", "local", "now"]) as unknown as ExplicitResumeSigningContext;
  const payload = ownedArtifact(supplied, INVALID, 500) as ExplicitCreateResumePayload;
  await assertTp1Binding(binding, local);
  const bytes = resumeBytes(payload, 500);
  await assertPeerProfile(payload.profile, binding, 500);
  if (signer.claim !== payload.buyer) fail(INVALID, 500, "SIGNER");
  if (!isUint(now) || payload.expiresAt <= now || payload.expiresAt - now > DACS_SELLER_HTTP_LIMITS.maxSignedLifetimeMs) fail(INVALID, 500, "LIFETIME");
  const participants = [payload.buyer, payload.seller];
  await assertTp1Authority(binding, local, participants, payload.jobId);
  const signature = envelopeSignatureBytes(await signer.sign(bytes), SIGNATURE_INVALID).toString("base64url");
  await assertTp1Authority(binding, local, participants, payload.jobId);
  return encodeHeader(payload, signature);
}

/** Records proofs as used. A host that must survive a restart supplies a durable one. */
export interface ExplicitResumeLedger {
  /**
   * Marks `key` used until `expiresAt` by the verifier's clock `time`. Resolves
   * to false if it was already used; throws or rejects if it cannot record the
   * claim, and the proof is then refused.
   */
  claim(key: string, expiresAt: number, time: number): boolean | Promise<boolean>;
}

/**
 * A ledger in process memory. It forgets a claim only once the proof has
 * expired (a proof at or past `time` is refused before it is claimed), and
 * refuses with `explicit_resume_ledger_full` (503) at `MAX_EXPLICIT_RESUME_CLAIMS`.
 */
export function createExplicitResumeLedger(): ExplicitResumeLedger {
  const claims = new Map<string, number>();
  return {
    claim(key, expiresAt, time) {
      for (const [held, until] of claims) if (until <= time) claims.delete(held);
      if (claims.has(key)) return false;
      if (claims.size >= MAX_EXPLICIT_RESUME_CLAIMS) return fail("explicit_resume_ledger_full", 503);
      claims.set(key, expiresAt);
      return true;
    },
  };
}

/** What the verifier already knows: the request that carries the header and its own binding, clock and ledger. */
export interface ExplicitResumeScope {
  binding: Tp1Binding;
  /** The verifier's connection right now; it must be the one the binding was made with. */
  local: unknown;
  /** The request carrying the header, as `openWireEnvelope` returned it. */
  request: WireRequestPayload;
  /** That request's delegation payload, or `null` for a request the buyer's own key signed. Never omitted. */
  delegation: SellerSessionDelegationPayload | null;
  /** The verifier's trusted clock. */
  time: number;
  ledger: ExplicitResumeLedger;
}

const SCOPE_KEYS = ["binding", "local", "request", "delegation", "time", "ledger"] as const;

/** One read of the header: bounded before it is decoded, canonical base64url, then admitted as JSON. */
function admitHeader(header: unknown): JsonRecord {
  if (typeof header !== "string") return fail(INVALID);
  if (header.length > DACS_SELLER_HTTP_LIMITS.maxHeaderLength) return fail(INVALID, 401, "HEADER-TOO-LONG");
  if (!/^[A-Za-z0-9_-]+$/.test(header)) return fail(INVALID);
  const bytes = Buffer.from(header, "base64url");
  if (bytes.toString("base64url") !== header) return fail(INVALID);
  const admitted = admitWireJson(bytes, DACS_SELLER_HTTP_LIMITS.maxHeaderLength, INVALID, 401);
  return hasKeys(admitted, ["payload", "signature"]) ? admitted : fail(INVALID);
}

const delegationCoversRequest = (delegation: SellerSessionDelegationPayload, request: WireRequestPayload): boolean =>
  delegation.buyer === request.buyer && delegation.seller === request.seller && delegation.jobId === request.jobId && sameCanonical(delegation.listingPin, request.listingPin);

function assertMatchesRequest(p: ExplicitCreateResumePayload, request: WireRequestPayload, delegation: SellerSessionDelegationPayload | null): void {
  if (p.buyer !== request.buyer || p.seller !== request.seller || p.jobId !== request.jobId || p.path !== request.path || p.agreementHash !== request.agreementHash ||
      !sameCanonical(p.listingPin, request.listingPin) || !sameCanonical(p.profile, request.profile) || p.requestHash !== wireRequestHash(request) ||
      (delegation !== null && !delegationCoversRequest(delegation, request))) {
    fail("explicit_resume_mismatch", 409);
  }
}

/** Uses the proof up. A ledger that throws or rejects refuses the proof as `explicit_resume_ledger_failed` (503), with the ledger's error as the cause. */
async function claimProof(ledger: ExplicitResumeLedger, key: string, expiresAt: number, time: number): Promise<void> {
  let claimed: boolean;
  try { claimed = await ledger.claim(key, expiresAt, time); } catch (cause) { return fail("explicit_resume_ledger_failed", 503, undefined, cause); }
  if (claimed !== true) fail("explicit_resume_used", 409);
}

/**
 * Verifies an `x-dacs-seller-resume` header against the request that carries it
 * and uses the proof up; returns a copy of its payload. A refused proof is not
 * used up. Order: scope, TP-1 binding, header size and encoding, admission,
 * profile, exact members, signature, participants' authority, request match,
 * expiry, one-use claim.
 * Throws `explicit_resume_invalid` (401) for a header past the limit, not
 * canonical, or with other than the proof's members or lifetime;
 * `explicit_resume_signature_invalid` (401); `explicit_resume_mismatch` (409)
 * for any difference from the request; `explicit_resume_expired` (408);
 * `explicit_resume_used` (409); `explicit_resume_ledger_failed` (503) when the
 * ledger cannot record the claim; and `wire_input_invalid` (500) for an incomplete scope.
 */
export async function verifyExplicitCreateResume(header: unknown, scope: ExplicitResumeScope): Promise<ExplicitCreateResumePayload> {
  const fields = ownedFields(scope, SCOPE_KEYS) as Partial<ExplicitResumeScope>;
  const { binding, local, time, ledger } = fields;
  if (binding === undefined || !isUint(time) || fields.request === undefined || fields.delegation === undefined || ledger === undefined || typeof ledger.claim !== "function") {
    fail("wire_input_invalid", 500);
  }
  const request = ownedConfig(fields.request, "wire_input_invalid") as WireRequestPayload;
  const delegation = fields.delegation === null ? null : ownedConfig(fields.delegation, "wire_input_invalid") as SellerSessionDelegationPayload;
  await assertTp1Binding(binding, local);
  const received = admitHeader(header);
  const p = received.payload as JsonRecord;
  if (hasKeys(p, FIELDS)) await assertPeerProfile(p.profile, binding);
  if (!isResumePayload(p)) return fail(INVALID);
  const signature = envelopeSignatureBytes(received.signature, SIGNATURE_INVALID);
  if (encodeHeader(p, signature.toString("base64url")) !== header) fail(INVALID);
  if (!verifyEd25519(resumeBytes(p, 401), signature, delegation === null ? claimKey(p.buyer) : delegation.sessionPublicKey)) fail(SIGNATURE_INVALID);
  await assertTp1Authority(binding, local, [p.buyer, p.seller], p.jobId);
  assertMatchesRequest(p, request, delegation);
  if (p.expiresAt <= time) fail("explicit_resume_expired", 408);
  if (p.expiresAt - time > DACS_SELLER_HTTP_LIMITS.maxMessageLifetimeMs) fail(INVALID, 401, "LIFETIME");
  await claimProof(ledger, sha256Hex(canonicalize({ buyer: p.buyer, seller: p.seller, profile: p.profile, nonce: p.nonce })), p.expiresAt, time);
  return cloneJson(p);
}
