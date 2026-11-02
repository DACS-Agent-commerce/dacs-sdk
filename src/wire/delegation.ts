// Seller session delegation of dacs-seller-http/v1: the buyer's wallet lets a
// fresh session key authenticate transport toward one seller, Listing and job
// until expiry. It never authorizes identity presentations, storage writes,
// Agreements or payments.
//
// Ported from the plugin implementation's delegation signing bytes, signature
// decoding and verification, with its 24 h lifetime bound. Changes
// (D6): the `dacs-seller-http:v1:delegation:` domain replaces
// `dacs-chatgpt-plugin:seller-session-delegation:v1:`, the payload carries the
// TP-1 `profile`, and the bytes are produced and verified only under a current
// TP-1 binding.
import { types } from "node:util";
import { canonicalize } from "../canonical/jcs.js";
import { isCanonicalJobId } from "../negotiate/jobId.js";
import { assertPeerProfile, assertTp1Binding, assertTp1Authority, isTp1WireProfile, type Tp1Binding, type Tp1WireProfile } from "./profile.js";
import { DACS_SELLER_HTTP_DOMAINS, DACS_SELLER_HTTP_LIMITS } from "./routes.js";
import {
  admitWireJson, isAdmittedValue, ownedBytes, claimKey, cloneJson, fail, hasKeys, HASH, isClaim, isListingPin, isUint, lacksProfile, ownedArtifact, ownedConfig, ownedFields,
  sameCanonical, verifyEd25519, walletSignatureBytes, type JsonRecord, type ListingPin, type WireSigner,
} from "./validate.js";

export interface SellerSessionDelegationPayload {
  version: "1";
  kind: "seller-session-delegation";
  buyer: string;
  sessionPublicKey: string;
  seller: string;
  listingPin: ListingPin;
  jobId: string;
  notBefore: number;
  expiresAt: number;
  profile: Tp1WireProfile;
}

export interface SellerSessionDelegation {
  payload: SellerSessionDelegationPayload;
  /** The buyer wallet's Ed25519 signature: hex (0x-prefixed or not) or base64url. */
  signature: string;
}

const FIELDS = ["version", "kind", "buyer", "sessionPublicKey", "seller", "listingPin", "jobId", "notBefore", "expiresAt", "profile"];

/** `status`: 401 for a received delegation, 500 for the wallet side's own payload. */
function payloadBytes(p: unknown, status = 401): Buffer {
  if (!hasKeys(p, FIELDS) || p.version !== "1" || p.kind !== "seller-session-delegation" ||
      !isClaim(p.buyer) || !isClaim(p.seller) || p.buyer === p.seller ||
      typeof p.sessionPublicKey !== "string" || !HASH.test(p.sessionPublicKey) || p.sessionPublicKey === claimKey(p.buyer) || p.sessionPublicKey === claimKey(p.seller) || !isListingPin(p.listingPin) ||
      !isCanonicalJobId(p.jobId) || !isUint(p.notBefore) || !isUint(p.expiresAt) || p.expiresAt <= p.notBefore ||
      p.expiresAt - p.notBefore > DACS_SELLER_HTTP_LIMITS.maxDelegationLifetimeMs || !isTp1WireProfile(p.profile)) {
    return fail("peer_delegation_invalid", status);
  }
  return Buffer.from(`${DACS_SELLER_HTTP_DOMAINS.delegation}${canonicalize(p)}`, "utf8");
}

/** One owned copy of the payload, checked against the current binding, and the bytes signed for that copy. */
async function ownedSigning(supplied: unknown, binding: Tp1Binding, local: unknown): Promise<{ payload: SellerSessionDelegationPayload; bytes: Buffer }> {
  const payload = ownedArtifact(supplied, "peer_delegation_invalid", 500) as SellerSessionDelegationPayload;
  await assertTp1Binding(binding, local);
  await assertPeerProfile((payload as unknown as JsonRecord | null)?.profile, binding, 500);
  const bytes = payloadBytes(payload, 500);
  await assertTp1Authority(binding, local, [payload.buyer, payload.seller], payload.jobId);
  return { payload, bytes };
}

/**
 * The exact bytes the buyer's wallet signs. Producing them needs the wallet
 * side's current TP-1 binding, so a missing or unapproved identity yields no
 * message to sign. The payload is copied once; the bytes are the copy's.
 */
export async function sellerSessionDelegationSigningBytes(payload: SellerSessionDelegationPayload, binding: Tp1Binding, local: unknown): Promise<Buffer> {
  return (await ownedSigning(payload, binding, local)).bytes;
}

/** Signs one owned copy of the payload and returns that copy: the payload returned is the one signed. */
export async function signSellerSessionDelegation(supplied: SellerSessionDelegationPayload, walletSigner: WireSigner, binding: Tp1Binding, local: unknown): Promise<SellerSessionDelegation> {
  const { payload, bytes } = await ownedSigning(supplied, binding, local);
  if (walletSigner.claim !== payload.buyer) fail("peer_delegation_invalid", 500);
  await assertTp1Authority(binding, local, [payload.buyer, payload.seller], payload.jobId);
  const signature = await walletSigner.sign(bytes);
  await assertTp1Authority(binding, local, [payload.buyer, payload.seller], payload.jobId);
  return { payload, signature: walletSignatureBytes(typeof signature === "string" ? signature : Buffer.from(signature).toString("base64url")).toString("base64url") };
}

export interface DelegationScope {
  binding: Tp1Binding;
  /** The verifier's connection right now; it must be the one the binding was made with. */
  local: unknown;
  buyer?: string;
  /** The seller, Listing and job the verifier is serving: a delegation for any other is refused. */
  seller: string;
  listingPin: ListingPin;
  jobId: string;
  /**
   * The verifier's trusted clock: require notBefore <= time < expiresAt (only
   * notBefore with allowExpired). Required unless allowExpired is true.
   */
  time?: number;
  /** The delegation must end by this Agreement deadline. */
  deadline?: number;
  /** Readback of already journaled effects only; never for starting new seller work. */
  allowExpired?: boolean;
}

const SCOPE_KEYS = ["binding", "local", "buyer", "seller", "listingPin", "jobId", "time", "deadline", "allowExpired"] as const;

/** Refuses a scope that leaves out a check or sets one to undefined: a skipped check must never read as a pass. */
function assertCompleteScope(scope: unknown, fields: Partial<DelegationScope>): void {
  for (const key of SCOPE_KEYS) if (fields[key] === undefined && Object.hasOwn(scope as object, key)) fail("wire_input_invalid", 500);
  if (typeof fields.seller !== "string" || typeof fields.jobId !== "string" || fields.listingPin === undefined) fail("wire_input_invalid", 500);
  if (fields.allowExpired !== undefined && typeof fields.allowExpired !== "boolean") fail("wire_input_invalid", 500);
  if (fields.time === undefined && fields.allowExpired !== true) fail("wire_input_invalid", 500);
}

/**
 * Verify a delegation and its scope under the verifier's current TP-1 binding;
 * returns a copy of its payload. The scope is read once (ownedScope) and its
 * Listing pin copied; the delegation is copied once and every check reads that
 * copy, so the payload returned is the one whose signature verified.
 * Throws wire_input_invalid (500) for a scope without seller, Listing pin and
 * job, without a clock (unless allowExpired), or with a member set to undefined.
 */
export async function verifySellerSessionDelegation(supplied: unknown, scope: DelegationScope): Promise<SellerSessionDelegationPayload> {
  const fields = ownedFields(scope, SCOPE_KEYS) as Partial<DelegationScope>;
  assertCompleteScope(scope, fields);
  const { binding, local, buyer, seller, jobId, time, deadline, allowExpired = false } = fields;
  const listingPin = ownedConfig(fields.listingPin, "wire_input_invalid");
  const admitted = types.isUint8Array(supplied)
    ? admitWireJson(ownedBytes(supplied, "peer_delegation_invalid", 401, { maxBytes: DACS_SELLER_HTTP_LIMITS.maxHeaderLength, code: "peer_delegation_invalid", status: 401 }), DACS_SELLER_HTTP_LIMITS.maxHeaderLength, "peer_delegation_invalid", 401)
    : isAdmittedValue(supplied) ? supplied : fail("peer_delegation_invalid", 401, "ARTIFACT-NOT-ADMITTED");
  const delegation = ownedArtifact(admitted, "peer_delegation_invalid");
  await assertTp1Binding(binding, local);
  if (!hasKeys(delegation, ["payload", "signature"])) return fail("peer_delegation_invalid");
  const p = delegation.payload as SellerSessionDelegationPayload;
  if (lacksProfile(p, FIELDS)) fail("tp1_profile_missing", 409);
  // With exactly the wire's members, the profile gate comes before every other payload check, so a revision fault is named as one.
  if (hasKeys(p, FIELDS)) await assertPeerProfile(p.profile, binding as Tp1Binding);
  const bytes = payloadBytes(p);
  if (!verifyEd25519(bytes, walletSignatureBytes(delegation.signature), claimKey(p.buyer))) fail("peer_delegation_signature_invalid");
  // The trusted reader is asked only about a delegation the buyer's wallet signed.
  await assertTp1Authority(binding as Tp1Binding, local, [p.buyer, p.seller], p.jobId);
  if ((buyer !== undefined && p.buyer !== buyer) || p.seller !== seller || !sameCanonical(p.listingPin, listingPin) || p.jobId !== jobId) {
    fail("peer_delegation_mismatch", 409);
  }
  if (time !== undefined && (!isUint(time) || p.notBefore > time || (!allowExpired && p.expiresAt <= time))) fail("peer_delegation_expired", 408);
  if (deadline !== undefined && (!isUint(deadline) || p.expiresAt > deadline)) fail("peer_delegation_deadline", 409);
  return cloneJson(p);
}
