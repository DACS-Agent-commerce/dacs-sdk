import { createHash, randomBytes } from "node:crypto";

import {
  isAttestationRef,
  isCompositeVerificationRecord,
  isIdentityBundle,
  type AttestationRef,
  type BundleSignature,
  type CompositeVerificationRecord,
  type IdentityBundle,
} from "@kynesyslabs/dacs/artifacts";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import type {
  FixedPriceX402OrderInput,
  PaymentEvidenceAnchorCompletion,
  PaymentEvidenceAnchorRequest,
  PaymentEvidenceAuthenticatedPeer,
} from "@kynesyslabs/dacs/commerce";
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import {
  parseCanonicalClaimReference,
  sameCanonicalClaimIdentity,
} from "@kynesyslabs/dacs/identity";
import {
  isCanonicalJobId,
  type FixedPriceAgreementProposal,
  type FixedPriceAgreementTransportIdentity,
} from "@kynesyslabs/dacs/negotiate";
import type { DurableSellerFixedPriceAgreementResponse } from "@kynesyslabs/dacs/seller";

export const DACS_HTTP_TRANSPORT_PATH = "/dacs-transport/v1/messages" as const;
export const DACS_HTTP_ENVELOPE_VERSION = "1" as const;
export const DACS_HTTP_ENVELOPE_ID_DOMAIN =
  "dacs-http-envelope-id:v1:" as const;
export const DACS_HTTP_MESSAGE_DOMAIN = "dacs-http-message:v1:" as const;
export const DACS_HTTP_MAX_ENVELOPE_LIFETIME_MS = 300_000 as const;
export const DACS_HTTP_MAX_FUTURE_SKEW_MS = 60_000 as const;
export const DACS_HTTP_NONCE_BYTES = 32 as const;
export const DACS_HTTP_SIGNATURE_BYTES = 64 as const;
export const DACS_HTTP_MAX_BODY_BYTES = 262_144 as const;

export const DACS_HTTP_MESSAGE_TYPES = Object.freeze([
  "session-init",
  "session-challenge",
  "session-presentation",
  "session-admission",
  "agreement-proposal",
  "agreement-response",
  "payment-evidence-request",
  "payment-evidence-completion",
  "bundle-signature-request",
  "bundle-signature-response",
  "diagnostic-probe-buyer",
  "diagnostic-probe-seller",
  "acknowledgement",
] as const);

export type DacsHttpMessageType = typeof DACS_HTTP_MESSAGE_TYPES[number];

export interface DacsAgreementProposalPayloadV1 {
  proposal: Readonly<FixedPriceAgreementProposal>;
  transportIdentity: Readonly<FixedPriceAgreementTransportIdentity>;
}

export interface DacsSessionInitPayloadV1 {
  bootstrapVersion: "1";
  order: Readonly<FixedPriceX402OrderInput>;
  application: Readonly<Record<string, unknown>>;
  sellerChallenge: string;
}

export interface DacsSessionChallengePayloadV1 {
  bootstrapVersion: "1";
  initPayloadHash: string;
  sellerChallenge: string;
  buyerChallenge: string;
  sellerIdentity: Readonly<IdentityBundle>;
}

export interface DacsSessionPresentationPayloadV1 {
  bootstrapVersion: "1";
  challengePayloadHash: string;
  buyerChallenge: string;
  buyerIdentity: Readonly<IdentityBundle>;
}

export interface DacsSessionAdmissionPayloadV1 {
  bootstrapVersion: "1";
  presentationPayloadHash: string;
  buyerIdentityHash: string;
  sellerIdentityHash: string;
  buyerVetRecord: Readonly<CompositeVerificationRecord>;
  buyerVetRef: Readonly<AttestationRef>;
}

export interface DacsBundleSignatureRequestV1 {
  bundleContentHash: string;
  signedScope: Readonly<Record<string, unknown>>;
  signedBytes: string;
  requiredCounterSigners: readonly string[];
}

export interface DacsHttpAcknowledgementV1 {
  acknowledgedEnvelopeId: string;
  acknowledgedPayloadHash: string;
  disposition: "accepted" | "existing" | "rejected";
  reasonCode?: string;
}

export interface DacsHttpDiagnosticProbePayloadV1 {
  purpose: "transport-readiness";
  challenge: string;
}

export interface DacsHttpPayloadByType {
  "session-init": DacsSessionInitPayloadV1;
  "session-challenge": DacsSessionChallengePayloadV1;
  "session-presentation": DacsSessionPresentationPayloadV1;
  "session-admission": DacsSessionAdmissionPayloadV1;
  "agreement-proposal": DacsAgreementProposalPayloadV1;
  "agreement-response": DurableSellerFixedPriceAgreementResponse;
  "payment-evidence-request": PaymentEvidenceAnchorRequest;
  "payment-evidence-completion": PaymentEvidenceAnchorCompletion;
  "bundle-signature-request": DacsBundleSignatureRequestV1;
  "bundle-signature-response": BundleSignature;
  "diagnostic-probe-buyer": DacsHttpDiagnosticProbePayloadV1;
  "diagnostic-probe-seller": DacsHttpDiagnosticProbePayloadV1;
  acknowledgement: DacsHttpAcknowledgementV1;
}

export type DacsHttpUnsignedEnvelopeFor<
  Type extends DacsHttpMessageType,
> = Readonly<{
  version: typeof DACS_HTTP_ENVELOPE_VERSION;
  type: Type;
  envelopeId: string;
  jobId: string;
  sender: string;
  audience: string;
  keyId: string;
  algorithm: "ed25519";
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  payloadHash: string;
  payload: Readonly<DacsHttpPayloadByType[Type]>;
}>;

export type DacsHttpEnvelopeFor<Type extends DacsHttpMessageType> =
  DacsHttpUnsignedEnvelopeFor<Type> & Readonly<{ signature: string }>;

export type DacsHttpUnsignedEnvelopeV1 = {
  [Type in DacsHttpMessageType]: DacsHttpUnsignedEnvelopeFor<Type>;
}[DacsHttpMessageType];

export type DacsHttpEnvelopeV1 = {
  [Type in DacsHttpMessageType]: DacsHttpEnvelopeFor<Type>;
}[DacsHttpMessageType];

export interface DacsHttpEnvelopeCreateInput<
  Type extends DacsHttpMessageType,
> {
  type: Type;
  jobId: string;
  sender: string;
  audience: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  payload: Readonly<DacsHttpPayloadByType[Type]>;
}

export type DacsHttpEnvelopeSigner = (
  signedBytes: Uint8Array,
) => Promise<Uint8Array> | Uint8Array;

export type DacsHttpIdentityRejectionCode =
  | "identity-unresolved"
  | "identity-expired"
  | "identity-revoked"
  | "identity-ambiguous"
  | "identity-role-incompatible";

export type DacsHttpIdentityResolutionV1 =
  | Readonly<{
      status: "authenticated";
      principal: string;
      jobId: string;
      role: "buyer" | "seller";
      publicKey: Uint8Array;
      evidenceHash: string;
    }>
  | Readonly<{
      status: "rejected";
      reasonCode: DacsHttpIdentityRejectionCode;
    }>;

export interface DacsHttpIdentityResolutionInputV1 {
  sender: string;
  audience: string;
  keyId: string;
  jobId: string;
  messageType: DacsHttpMessageType;
  storeTime: number;
}

/**
 * Resolve only verified canonical Demos primary identity material. The host
 * implementation owns expiry, revocation, ambiguity, and job-role checks; a
 * locally configured key or alternate key ID is insufficient.
 */
export type DacsHttpIdentityResolverV1 = (
  input: Readonly<DacsHttpIdentityResolutionInputV1>,
) => Promise<DacsHttpIdentityResolutionV1> | DacsHttpIdentityResolutionV1;

export type DacsHttpPayloadValidationV1 =
  | Readonly<{ status: "valid" }>
  | Readonly<{
      status: "invalid" | "authentication-failure";
      reasonCode: string;
    }>;

/**
 * Validate the exact public-SDK DTO and its sender/audience/job direction
 * against independently resolved session facts before any coordinator action.
 */
export type DacsHttpPayloadValidatorV1 = (
  input: Readonly<{
    type: Exclude<DacsHttpMessageType, "acknowledgement">;
    payload: unknown;
    jobId: string;
    sender: string;
    audience: string;
  }>,
) => Promise<DacsHttpPayloadValidationV1> | DacsHttpPayloadValidationV1;

export interface DacsHttpEnvelopeAuthenticationOptionsV1 {
  storeTime: number;
  /** Canonical local Demos primary ClaimRef; mandatory confused-deputy boundary. */
  expectedAudience: string;
  expectedJobId?: string;
  resolveIdentity: DacsHttpIdentityResolverV1;
  validatePayload?: DacsHttpPayloadValidatorV1;
}

export interface DacsHttpAuthenticatedEnvelopeV1 {
  status: "authenticated";
  envelope: Readonly<DacsHttpEnvelopeV1>;
  authenticationHash: string;
  identityEvidenceHash: string;
  identityRole: "buyer" | "seller";
  receivedAt: number;
}

export interface DacsHttpEnvelopeRejectionV1 {
  status: "rejected";
  category: "malformed" | "authentication";
  reasonCode: string;
}

export type DacsHttpEnvelopeAuthenticationResultV1 =
  | DacsHttpAuthenticatedEnvelopeV1
  | DacsHttpEnvelopeRejectionV1;

export type DacsHttpEnvelopeSelfVerificationV1 = Readonly<
  | {
      status: "valid";
      envelope: Readonly<DacsHttpEnvelopeV1>;
      authenticationHash: string;
    }
  | DacsHttpEnvelopeRejectionV1
>;

const TYPE_SET = new Set<string>(DACS_HTTP_MESSAGE_TYPES);
const REQUIRED_SENDER_ROLE = Object.freeze({
  "session-init": "buyer",
  "session-challenge": "seller",
  "session-presentation": "buyer",
  "session-admission": "seller",
  "agreement-proposal": "buyer",
  "agreement-response": "seller",
  "payment-evidence-request": "seller",
  "payment-evidence-completion": "buyer",
  "bundle-signature-request": "seller",
  "bundle-signature-response": "buyer",
  "diagnostic-probe-buyer": "buyer",
  "diagnostic-probe-seller": "seller",
} as const);
const HASH_RE = /^[0-9a-f]{64}$/;
const IDENTITY_REJECTION_CODE_SET = new Set<DacsHttpIdentityRejectionCode>([
  "identity-unresolved",
  "identity-expired",
  "identity-revoked",
  "identity-ambiguous",
  "identity-role-incompatible",
]);
const DEMOS_AGENT_IDENTIFIER_RE = /^demos:agent:([0-9a-f]{64})$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const REASON_CODE_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const ENVELOPE_KEYS = Object.freeze([
  "version",
  "type",
  "envelopeId",
  "jobId",
  "sender",
  "audience",
  "keyId",
  "algorithm",
  "issuedAt",
  "expiresAt",
  "nonce",
  "payloadHash",
  "payload",
  "signature",
] as const);
const ACK_KEYS = Object.freeze([
  "acknowledgedEnvelopeId",
  "acknowledgedPayloadHash",
  "disposition",
] as const);

class EnvelopeFailure extends Error {
  constructor(
    readonly category: "malformed" | "authentication",
    readonly reasonCode: string,
  ) {
    super(reasonCode);
  }
}

function failure(
  category: "malformed" | "authentication",
  reasonCode: string,
): never {
  throw new EnvelopeFailure(category, reasonCode);
}

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
  });
}

export function validateDacsHttpDiagnosticProbePayloadV1(
  value: unknown,
): value is Readonly<DacsHttpDiagnosticProbePayloadV1> {
  if (!record(value) || Object.keys(value).length !== 2 ||
      value.purpose !== "transport-readiness" ||
      typeof value.challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.challenge)) {
    return false;
  }
  try {
    const decoded = Buffer.from(value.challenge, "base64url");
    return decoded.byteLength === 32 && decoded.toString("base64url") === value.challenge;
  } catch {
    return false;
  }
}

function sessionChallenge(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function hash(value: unknown): value is string {
  return typeof value === "string" && HASH_RE.test(value);
}

export function validateDacsHttpSessionInitPayloadV1(
  value: unknown,
): value is Readonly<DacsSessionInitPayloadV1> {
  return record(value) && exactKeys(value, [
    "bootstrapVersion", "order", "application", "sellerChallenge",
  ]) && value.bootstrapVersion === "1" && record(value.order) &&
    record(value.application) && sessionChallenge(value.sellerChallenge);
}

export function validateDacsHttpSessionChallengePayloadV1(
  value: unknown,
): value is Readonly<DacsSessionChallengePayloadV1> {
  return record(value) && exactKeys(value, [
    "bootstrapVersion", "initPayloadHash", "sellerChallenge", "buyerChallenge",
    "sellerIdentity",
  ]) && value.bootstrapVersion === "1" && hash(value.initPayloadHash) &&
    sessionChallenge(value.sellerChallenge) && sessionChallenge(value.buyerChallenge) &&
    value.sellerChallenge !== value.buyerChallenge && isIdentityBundle(value.sellerIdentity) &&
    value.sellerIdentity.sessionNonce === value.sellerChallenge;
}

export function validateDacsHttpSessionPresentationPayloadV1(
  value: unknown,
): value is Readonly<DacsSessionPresentationPayloadV1> {
  return record(value) && exactKeys(value, [
    "bootstrapVersion", "challengePayloadHash", "buyerChallenge", "buyerIdentity",
  ]) && value.bootstrapVersion === "1" && hash(value.challengePayloadHash) &&
    sessionChallenge(value.buyerChallenge) && isIdentityBundle(value.buyerIdentity) &&
    value.buyerIdentity.sessionNonce === value.buyerChallenge;
}

export function validateDacsHttpSessionAdmissionPayloadV1(
  value: unknown,
): value is Readonly<DacsSessionAdmissionPayloadV1> {
  return record(value) && exactKeys(value, [
    "bootstrapVersion", "presentationPayloadHash", "buyerIdentityHash",
    "sellerIdentityHash", "buyerVetRecord", "buyerVetRef",
  ]) && value.bootstrapVersion === "1" && hash(value.presentationPayloadHash) &&
    hash(value.buyerIdentityHash) && hash(value.sellerIdentityHash) &&
    isCompositeVerificationRecord(value.buyerVetRecord) &&
    isAttestationRef(value.buyerVetRef);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function demosAgentPrincipalPublicKey(value: unknown): Uint8Array | undefined {
  const parsed = parseCanonicalClaimReference(value);
  if (parsed === null || parsed.identity.scheme !== "did") return undefined;
  const match = DEMOS_AGENT_IDENTIFIER_RE.exec(parsed.identity.identifier);
  return match === null ? undefined : Buffer.from(match[1]!, "hex");
}

// CORE §B.1 CF-2 preserves canonical parameters in signed/forwarded bytes;
// CF-3 excludes them only from principal comparison and key ownership.
function sameDemosAgentIdentity(left: unknown, right: unknown): boolean {
  return demosAgentPrincipalPublicKey(left) !== undefined &&
    demosAgentPrincipalPublicKey(right) !== undefined &&
    sameCanonicalClaimIdentity(left, right);
}

function safeTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function decodeBase64Url(value: unknown, bytes: number, label: string): Uint8Array {
  if (typeof value !== "string" || !BASE64URL_RE.test(value) || value.includes("=")) {
    failure("malformed", `${label}-base64url-invalid`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== bytes || decoded.toString("base64url") !== value) {
    failure("malformed", `${label}-base64url-invalid`);
  }
  return decoded;
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function canonicalSnapshot<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalize(value)) as T);
}

function withoutSignature(
  envelope: Readonly<DacsHttpEnvelopeV1>,
): DacsHttpUnsignedEnvelopeV1 {
  const { signature: _signature, ...unsigned } = envelope;
  return unsigned as DacsHttpUnsignedEnvelopeV1;
}

function validateTimes(issuedAt: number, expiresAt: number): void {
  if (!safeTime(issuedAt) || !safeTime(expiresAt) || expiresAt <= issuedAt ||
      expiresAt - issuedAt > DACS_HTTP_MAX_ENVELOPE_LIFETIME_MS) {
    failure("malformed", "envelope-time-window-invalid");
  }
}

function validateAcknowledgementPayload(
  value: unknown,
): asserts value is DacsHttpAcknowledgementV1 {
  if (!record(value) || !exactKeys(value, ACK_KEYS, ["reasonCode"]) ||
      typeof value.acknowledgedEnvelopeId !== "string" ||
      !HASH_RE.test(value.acknowledgedEnvelopeId) ||
      typeof value.acknowledgedPayloadHash !== "string" ||
      !HASH_RE.test(value.acknowledgedPayloadHash) ||
      (value.disposition !== "accepted" && value.disposition !== "existing" &&
        value.disposition !== "rejected")) {
    failure("malformed", "acknowledgement-payload-invalid");
  }
  if (value.disposition === "rejected") {
    if (typeof value.reasonCode !== "string" || !REASON_CODE_RE.test(value.reasonCode)) {
      failure("malformed", "acknowledgement-reason-code-invalid");
    }
  } else if (Object.hasOwn(value, "reasonCode")) {
    failure("malformed", "acknowledgement-reason-code-forbidden");
  }
}

function parseEnvelope(value: unknown): DacsHttpEnvelopeV1 {
  if (!record(value) || !exactKeys(value, ENVELOPE_KEYS)) {
    failure("malformed", "envelope-fields-invalid");
  }
  let snapshot: Record<string, unknown>;
  try {
    snapshot = canonicalSnapshot(value);
  } catch {
    failure("malformed", "envelope-canonical-json-invalid");
  }
  if (snapshot.version !== DACS_HTTP_ENVELOPE_VERSION ||
      typeof snapshot.type !== "string" || !TYPE_SET.has(snapshot.type) ||
      snapshot.algorithm !== "ed25519") {
    failure("malformed", "envelope-version-type-or-algorithm-invalid");
  }
  if (typeof snapshot.envelopeId !== "string" || !HASH_RE.test(snapshot.envelopeId) ||
      typeof snapshot.payloadHash !== "string" || !HASH_RE.test(snapshot.payloadHash) ||
      !isCanonicalJobId(snapshot.jobId) ||
      demosAgentPrincipalPublicKey(snapshot.sender) === undefined ||
      demosAgentPrincipalPublicKey(snapshot.audience) === undefined ||
      sameDemosAgentIdentity(snapshot.sender, snapshot.audience) ||
      snapshot.keyId !== snapshot.sender) {
    failure("malformed", "envelope-identity-fields-invalid");
  }
  validateTimes(snapshot.issuedAt as number, snapshot.expiresAt as number);
  decodeBase64Url(snapshot.nonce, DACS_HTTP_NONCE_BYTES, "nonce");
  decodeBase64Url(snapshot.signature, DACS_HTTP_SIGNATURE_BYTES, "signature");
  if (snapshot.type === "acknowledgement") {
    validateAcknowledgementPayload(snapshot.payload);
  }
  return snapshot as unknown as DacsHttpEnvelopeV1;
}

function snapshotIdentityResolution(
  value: unknown,
): DacsHttpIdentityResolutionV1 {
  if (!record(value)) {
    failure("authentication", "identity-resolution-mismatch");
  }
  let snapshot: unknown;
  try {
    snapshot = structuredClone(value);
  } catch {
    failure("authentication", "identity-resolution-mismatch");
  }
  if (!record(snapshot)) {
    failure("authentication", "identity-resolution-mismatch");
  }
  if (snapshot.status === "rejected") {
    if (!exactKeys(snapshot, ["status", "reasonCode"]) ||
        typeof snapshot.reasonCode !== "string" ||
        !IDENTITY_REJECTION_CODE_SET.has(
          snapshot.reasonCode as DacsHttpIdentityRejectionCode,
        )) {
      failure("authentication", "identity-resolution-mismatch");
    }
    return snapshot as unknown as DacsHttpIdentityResolutionV1;
  }
  if (snapshot.status !== "authenticated" || !exactKeys(snapshot, [
    "status",
    "principal",
    "jobId",
    "role",
    "publicKey",
    "evidenceHash",
  ]) || typeof snapshot.principal !== "string" ||
      typeof snapshot.jobId !== "string" ||
      (snapshot.role !== "buyer" && snapshot.role !== "seller") ||
      !(snapshot.publicKey instanceof Uint8Array) ||
      snapshot.publicKey.byteLength !== 32 ||
      typeof snapshot.evidenceHash !== "string" ||
      !HASH_RE.test(snapshot.evidenceHash)) {
    failure("authentication", "identity-resolution-mismatch");
  }
  return snapshot as unknown as DacsHttpIdentityResolutionV1;
}

export function generateDacsHttpNonceV1(): string {
  return randomBytes(DACS_HTTP_NONCE_BYTES).toString("base64url");
}

export function dacsHttpPayloadHashV1(payload: unknown): string {
  return sha256Hex(canonicalize(payload));
}

export function dacsHttpEnvelopeIdV1(input: Readonly<{
  type: DacsHttpMessageType;
  jobId: string;
  sender: string;
  audience: string;
  nonce: string;
  payloadHash: string;
}>): string {
  return sha256Hex(Buffer.concat([
    Buffer.from(DACS_HTTP_ENVELOPE_ID_DOMAIN, "utf8"),
    Buffer.from(canonicalize(input), "utf8"),
  ]));
}

export function dacsHttpEnvelopeHashBytesV1(
  envelope: Readonly<DacsHttpUnsignedEnvelopeV1 | DacsHttpEnvelopeV1>,
): Uint8Array {
  const unsigned = Object.hasOwn(envelope, "signature")
    ? withoutSignature(envelope as DacsHttpEnvelopeV1)
    : envelope as DacsHttpUnsignedEnvelopeV1;
  return createHash("sha256")
    .update(Buffer.from(canonicalize(unsigned), "utf8"))
    .digest();
}

export function dacsHttpEnvelopeHashV1(
  envelope: Readonly<DacsHttpUnsignedEnvelopeV1 | DacsHttpEnvelopeV1>,
): string {
  return Buffer.from(dacsHttpEnvelopeHashBytesV1(envelope)).toString("hex");
}

export function dacsHttpEnvelopeSignedBytesV1(
  envelope: Readonly<DacsHttpUnsignedEnvelopeV1 | DacsHttpEnvelopeV1>,
): Uint8Array {
  return Buffer.concat([
    Buffer.from(DACS_HTTP_MESSAGE_DOMAIN, "utf8"),
    Buffer.from(dacsHttpEnvelopeHashBytesV1(envelope)),
  ]);
}

export async function createDacsHttpEnvelopeV1<
  Type extends DacsHttpMessageType,
>(
  input: Readonly<DacsHttpEnvelopeCreateInput<Type>>,
  sign: DacsHttpEnvelopeSigner,
): Promise<Readonly<DacsHttpEnvelopeFor<Type>>> {
  if (!TYPE_SET.has(input.type) || !isCanonicalJobId(input.jobId) ||
      demosAgentPrincipalPublicKey(input.sender) === undefined ||
      demosAgentPrincipalPublicKey(input.audience) === undefined ||
      sameDemosAgentIdentity(input.sender, input.audience)) {
    failure("malformed", "envelope-create-input-invalid");
  }
  validateTimes(input.issuedAt, input.expiresAt);
  decodeBase64Url(input.nonce, DACS_HTTP_NONCE_BYTES, "nonce");
  if (input.type === "acknowledgement") {
    validateAcknowledgementPayload(input.payload);
  }

  let payload: Readonly<DacsHttpPayloadByType[Type]>;
  let payloadHash: string;
  try {
    payload = canonicalSnapshot(input.payload);
    payloadHash = dacsHttpPayloadHashV1(payload);
  } catch (error) {
    if (error instanceof EnvelopeFailure) throw error;
    failure("malformed", "envelope-payload-canonical-json-invalid");
  }
  const idInput = {
    type: input.type,
    jobId: input.jobId,
    sender: input.sender,
    audience: input.audience,
    nonce: input.nonce,
    payloadHash,
  };
  const unsigned = canonicalSnapshot({
    version: DACS_HTTP_ENVELOPE_VERSION,
    type: input.type,
    envelopeId: dacsHttpEnvelopeIdV1(idInput),
    jobId: input.jobId,
    sender: input.sender,
    audience: input.audience,
    keyId: input.sender,
    algorithm: "ed25519" as const,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    nonce: input.nonce,
    payloadHash,
    payload,
  }) as DacsHttpUnsignedEnvelopeFor<Type>;
  const signatureBytes = await sign(
    dacsHttpEnvelopeSignedBytesV1(unsigned as DacsHttpUnsignedEnvelopeV1),
  );
  if (!(signatureBytes instanceof Uint8Array) ||
      signatureBytes.byteLength !== DACS_HTTP_SIGNATURE_BYTES) {
    failure("malformed", "envelope-signer-result-invalid");
  }
  const envelope = {
    ...unsigned,
    signature: encodeBase64Url(signatureBytes),
  } as DacsHttpEnvelopeFor<Type>;
  parseEnvelope(envelope);
  return Object.freeze(envelope);
}

export async function authenticateDacsHttpEnvelopeV1(
  value: unknown,
  options: Readonly<DacsHttpEnvelopeAuthenticationOptionsV1>,
): Promise<DacsHttpEnvelopeAuthenticationResultV1> {
  try {
    if (!safeTime(options.storeTime)) {
      failure("malformed", "store-time-invalid");
    }
    const expectedAudience = options.expectedAudience;
    if (!Object.hasOwn(options, "expectedAudience") ||
        demosAgentPrincipalPublicKey(expectedAudience) === undefined) {
      failure("malformed", "expected-audience-invalid");
    }
    const envelope = parseEnvelope(value);
    if (!sameDemosAgentIdentity(envelope.audience, expectedAudience)) {
      failure("authentication", "envelope-audience-mismatch");
    }
    if (options.expectedJobId !== undefined && envelope.jobId !== options.expectedJobId) {
      failure("authentication", "envelope-job-mismatch");
    }
    if (envelope.expiresAt <= options.storeTime) {
      failure("authentication", "envelope-expired");
    }
    if (envelope.issuedAt > options.storeTime + DACS_HTTP_MAX_FUTURE_SKEW_MS) {
      failure("authentication", "envelope-issued-in-future");
    }

    let payloadHash: string;
    try {
      payloadHash = dacsHttpPayloadHashV1(envelope.payload);
    } catch {
      failure("malformed", "envelope-payload-canonical-json-invalid");
    }
    if (payloadHash !== envelope.payloadHash) {
      failure("authentication", "envelope-payload-hash-mismatch");
    }
    const envelopeId = dacsHttpEnvelopeIdV1({
      type: envelope.type,
      jobId: envelope.jobId,
      sender: envelope.sender,
      audience: envelope.audience,
      nonce: envelope.nonce,
      payloadHash,
    });
    if (envelopeId !== envelope.envelopeId) {
      failure("authentication", "envelope-id-mismatch");
    }

    let resolvedIdentity: unknown;
    try {
      resolvedIdentity = await options.resolveIdentity({
        sender: envelope.sender,
        audience: envelope.audience,
        keyId: envelope.keyId,
        jobId: envelope.jobId,
        messageType: envelope.type,
        storeTime: options.storeTime,
      });
    } catch {
      failure("authentication", "identity-resolution-failed");
    }
    const identity = snapshotIdentityResolution(resolvedIdentity);
    if (identity.status === "rejected") {
      failure("authentication", identity.reasonCode);
    }
    const senderPublicKey = demosAgentPrincipalPublicKey(envelope.sender);
    if (!sameDemosAgentIdentity(identity.principal, envelope.sender) ||
        identity.jobId !== envelope.jobId ||
        (identity.role !== "buyer" && identity.role !== "seller") ||
        senderPublicKey === undefined ||
        !Buffer.from(identity.publicKey).equals(Buffer.from(senderPublicKey)) ||
        typeof identity.evidenceHash !== "string" ||
        !HASH_RE.test(identity.evidenceHash)) {
      failure("authentication", "identity-resolution-mismatch");
    }
    if (envelope.type !== "acknowledgement" &&
        identity.role !== REQUIRED_SENDER_ROLE[envelope.type]) {
      failure("authentication", "identity-role-incompatible");
    }
    let signatureValid = false;
    try {
      signatureValid = ed25519Verify(
        dacsHttpEnvelopeSignedBytesV1(envelope),
        decodeBase64Url(envelope.signature, DACS_HTTP_SIGNATURE_BYTES, "signature"),
        publicKeyFromRaw(identity.publicKey),
      );
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) failure("authentication", "envelope-signature-invalid");

    if (envelope.type !== "acknowledgement") {
      if (options.validatePayload === undefined) {
        failure("malformed", "payload-validator-unavailable");
      }
      let validation: DacsHttpPayloadValidationV1;
      try {
        validation = await options.validatePayload({
          type: envelope.type,
          payload: envelope.payload,
          jobId: envelope.jobId,
          sender: envelope.sender,
          audience: envelope.audience,
        });
      } catch {
        failure("malformed", "payload-validation-failed");
      }
      if (validation.status !== "valid") {
        if (!REASON_CODE_RE.test(validation.reasonCode)) {
          failure("malformed", "payload-reason-code-invalid");
        }
        failure(
          validation.status === "authentication-failure"
            ? "authentication"
            : "malformed",
          validation.reasonCode,
        );
      }
    }

    return Object.freeze({
      status: "authenticated" as const,
      envelope,
      authenticationHash: dacsHttpEnvelopeHashV1(envelope),
      identityEvidenceHash: identity.evidenceHash,
      identityRole: identity.role,
      receivedAt: options.storeTime,
    });
  } catch (error) {
    if (error instanceof EnvelopeFailure) {
      return Object.freeze({
        status: "rejected" as const,
        category: error.category,
        reasonCode: error.reasonCode,
      });
    }
    return Object.freeze({
      status: "rejected" as const,
      category: "malformed" as const,
      reasonCode: "envelope-processing-failed",
    });
  }
}

/**
 * Revalidates canonical envelope bytes, identifiers and the self-certifying
 * Demos sender signature without performing network identity resolution. This
 * is the durable-store admission primitive; action admission must still use
 * `authenticateDacsHttpEnvelopeV1` and retain its identity evidence.
 */
export function verifyDacsHttpEnvelopeSelfSignatureV1(
  value: unknown,
): DacsHttpEnvelopeSelfVerificationV1 {
  try {
    const envelope = parseEnvelope(value);
    let payloadHash: string;
    try {
      payloadHash = dacsHttpPayloadHashV1(envelope.payload);
    } catch {
      failure("malformed", "envelope-payload-canonical-json-invalid");
    }
    if (payloadHash !== envelope.payloadHash) {
      failure("authentication", "envelope-payload-hash-mismatch");
    }
    const envelopeId = dacsHttpEnvelopeIdV1({
      type: envelope.type,
      jobId: envelope.jobId,
      sender: envelope.sender,
      audience: envelope.audience,
      nonce: envelope.nonce,
      payloadHash,
    });
    if (envelopeId !== envelope.envelopeId) {
      failure("authentication", "envelope-id-mismatch");
    }
    const publicKey = demosAgentPrincipalPublicKey(envelope.sender);
    let signatureValid = false;
    try {
      signatureValid = publicKey !== undefined && ed25519Verify(
        dacsHttpEnvelopeSignedBytesV1(envelope),
        decodeBase64Url(envelope.signature, DACS_HTTP_SIGNATURE_BYTES, "signature"),
        publicKeyFromRaw(publicKey),
      );
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) failure("authentication", "envelope-signature-invalid");
    return Object.freeze({
      status: "valid" as const,
      envelope,
      authenticationHash: dacsHttpEnvelopeHashV1(envelope),
    });
  } catch (error) {
    if (error instanceof EnvelopeFailure) {
      return Object.freeze({
        status: "rejected" as const,
        category: error.category,
        reasonCode: error.reasonCode,
      });
    }
    return Object.freeze({
      status: "rejected" as const,
      category: "malformed" as const,
      reasonCode: "envelope-processing-failed",
    });
  }
}

export async function createDacsHttpAcknowledgementEnvelopeV1(
  original: Readonly<DacsHttpEnvelopeV1>,
  input: Readonly<{
    disposition: DacsHttpAcknowledgementV1["disposition"];
    reasonCode?: string;
    issuedAt: number;
    expiresAt: number;
    nonce: string;
  }>,
  sign: DacsHttpEnvelopeSigner,
): Promise<Readonly<DacsHttpEnvelopeFor<"acknowledgement">>> {
  const payload: DacsHttpAcknowledgementV1 = {
    acknowledgedEnvelopeId: original.envelopeId,
    acknowledgedPayloadHash: original.payloadHash,
    disposition: input.disposition,
    ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
  };
  return createDacsHttpEnvelopeV1({
    type: "acknowledgement",
    jobId: original.jobId,
    sender: original.audience,
    audience: original.sender,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    nonce: input.nonce,
    payload,
  }, sign);
}

export function verifyDacsHttpAcknowledgementBindingV1(
  acknowledgement: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
  original: Readonly<DacsHttpEnvelopeV1>,
): Readonly<
  | { status: "valid"; disposition: DacsHttpAcknowledgementV1["disposition"] }
  | { status: "invalid"; reasonCode: string }
> {
  const envelope = acknowledgement.envelope;
  if (envelope.type !== "acknowledgement") {
    return Object.freeze({ status: "invalid", reasonCode: "not-an-acknowledgement" });
  }
  if (envelope.jobId !== original.jobId || envelope.sender !== original.audience ||
      envelope.audience !== original.sender ||
      envelope.payload.acknowledgedEnvelopeId !== original.envelopeId ||
      envelope.payload.acknowledgedPayloadHash !== original.payloadHash) {
    return Object.freeze({ status: "invalid", reasonCode: "acknowledgement-binding-mismatch" });
  }
  return Object.freeze({
    status: "valid",
    disposition: envelope.payload.disposition,
  });
}

export function paymentEvidencePeerFromDacsHttpEnvelopeV1(
  authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
): Readonly<PaymentEvidenceAuthenticatedPeer> {
  const envelope = authenticated.envelope;
  if (envelope.type === "payment-evidence-request") {
    return Object.freeze({
      principal: envelope.sender,
      audience: envelope.audience,
      messageId: envelope.payload.messageId,
      messageHash: envelope.payload.requestHash,
      authenticationHash: authenticated.authenticationHash,
    });
  }
  if (envelope.type === "payment-evidence-completion") {
    return Object.freeze({
      principal: envelope.sender,
      audience: envelope.audience,
      messageId: envelope.payload.messageId,
      messageHash: envelope.payload.completionHash,
      authenticationHash: authenticated.authenticationHash,
    });
  }
  throw new TypeError("authenticated envelope is not a payment-evidence message");
}
