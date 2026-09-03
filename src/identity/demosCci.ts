import { types as nodeTypes } from "node:util";

import type {
  IdentityBundle,
  SupplementarySignal,
} from "../artifacts/types.js";
import { isIdentityBundle } from "../artifacts/validators.js";
import { signedBytes } from "../crypto/index.js";
import { snapshotCanonicalJsonRead } from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";
import { requireCanonicalJobId } from "../negotiate/jobId.js";
import {
  isCanonicalClaimReference,
  sameCanonicalClaimIdentity,
} from "./claimReference.js";
import { isCanonicalDomainHostname } from "./domainHost.js";
import { identityBundleHash } from "./bundle.js";
import {
  parseCciRecord,
  type CciClaim,
  type CciRecord,
} from "./cci.js";

export interface DemosCciProvenance {
  /** Exact primary claim whose GCR resolution was authenticated. */
  subject: string;
  /** When the authenticated GCR state was observed, in Unix milliseconds. */
  observedAt: number;
  /** Application-defined authority identifier (network/finality provider). */
  authority: string;
  /** Optional data-only proof coordinates retained for audit. */
  evidence?: Record<string, unknown>;
}

export type DemosCciResolutionAuthentication =
  | ({ status: "authenticated" } & DemosCciProvenance)
  | { status: "invalid" | "indeterminate" | "error"; reason: string };

export interface AuthenticateDemosCciInput {
  subject: string;
  /** Owned and deeply frozen parser output. */
  record: Readonly<CciRecord>;
  /** The exact owned GCR response carried by `record.raw`. */
  raw: unknown;
}

export type DemosCciProviderClaim = Extract<
  CciClaim,
  { kind: "nomis" | "humanpassport" | "ethos" }
>;

export interface AuthenticateDemosCciProviderClaimInput {
  subject: string;
  /** The authenticated parsed projection; unrelated raw RPC fields are removed. */
  record: Readonly<CciRecord>;
  /** One exact frozen provider claim extracted from that record. */
  claim: Readonly<DemosCciProviderClaim>;
}

export type DemosCciProviderClaimAuthentication =
  | Readonly<{
      status: "verified";
      subject: string;
      claimRef: string;
      verifiedAt: number;
      authority: string;
      evidence?: Record<string, unknown>;
    }>
  | Readonly<{
      status: "invalid" | "indeterminate" | "error";
      reason: string;
    }>;

export interface AuthenticateDemosCciDeps {
  /**
   * Authenticate the exact captured GCR response, its subject binding, and the
   * applicable Demos finality/current-state evidence. A successful callback is
   * a trust capability; a plain RPC success code is not sufficient by itself.
   */
  authenticateResolution: (
    input: Readonly<AuthenticateDemosCciInput>,
  ) =>
    | Promise<DemosCciResolutionAuthentication>
    | DemosCciResolutionAuthentication;
  /**
   * Independently authenticate provider semantics and subject/control binding
   * for each Nomis, Human Passport, and Ethos claim. GCR inclusion alone does
   * not establish those semantics. Without this capability the record remains
   * usable for presence, but provider scores cannot enter Vet signals.
   */
  authenticateProviderClaim?: (
    input: Readonly<AuthenticateDemosCciProviderClaimInput>,
  ) =>
    | Promise<DemosCciProviderClaimAuthentication>
    | DemosCciProviderClaimAuthentication;
}

declare const authenticatedCciRecordBrand: unique symbol;
export type AuthenticatedCciRecord = CciRecord & {
  readonly [authenticatedCciRecordBrand]: true;
};

export type AuthenticateDemosCciResult =
  | {
      status: "authenticated";
      record: AuthenticatedCciRecord;
      provenance: Readonly<DemosCciProvenance>;
    }
  | { status: "invalid" | "indeterminate" | "error"; reason: string };

interface AuthenticatedCciState {
  provenance: Readonly<DemosCciProvenance>;
  providerClaims: ReadonlyMap<string, DemosCciProviderClaimAuthentication>;
}

const authenticatedCciRecords = new WeakMap<object, AuthenticatedCciState>();
const INERT_CCI_RECEIVER = Object.freeze(Object.create(null)) as object;

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value as object)) {
    return value;
  }
  if (ArrayBuffer.isView(value)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

const isSafeTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    !nodeTypes.isProxy(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function ownDataFunction<T extends (...args: never[]) => unknown>(
  source: object,
  key: string,
  optional = false,
): T | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined && optional) return undefined;
  if (!descriptor?.enumerable || !("value" in descriptor) ||
      typeof descriptor.value !== "function" || nodeTypes.isProxy(descriptor.value)) {
    throw new TypeError(`${key} must be an own non-Proxy data function`);
  }
  return descriptor.value as T;
}

function providerAuthentication(
  value: unknown,
  subject: string,
  claimRef: string,
  resolutionObservedAt: number,
): DemosCciProviderClaimAuthentication {
  const retained = snapshotCanonicalJsonRead(value, "Demos CCI provider authentication");
  if (!isPlainRecord(retained) || typeof retained.status !== "string") {
    return Object.freeze({ status: "error", reason: "provider authentication is malformed" });
  }
  const keys = Reflect.ownKeys(retained);
  if (retained.status === "verified") {
    if (!keys.every((key) =>
      key === "status" || key === "subject" || key === "claimRef" ||
      key === "verifiedAt" || key === "authority" || key === "evidence") ||
        keys.length !== (retained.evidence === undefined ? 5 : 6) ||
        retained.subject !== subject || retained.claimRef !== claimRef ||
        !isSafeTime(retained.verifiedAt) || retained.verifiedAt > resolutionObservedAt ||
        typeof retained.authority !== "string" || retained.authority.length === 0 ||
        retained.authority.trim() !== retained.authority ||
        (retained.evidence !== undefined && !isPlainRecord(retained.evidence))) {
      return Object.freeze({ status: "error", reason: "provider authentication is malformed" });
    }
    return deepFreeze(retained as unknown as DemosCciProviderClaimAuthentication);
  }
  if ((retained.status === "invalid" || retained.status === "indeterminate" ||
      retained.status === "error") && keys.length === 2 && keys.includes("reason") &&
      typeof retained.reason === "string" && retained.reason.trim().length > 0) {
    return Object.freeze({ status: retained.status, reason: retained.reason });
  }
  return Object.freeze({ status: "error", reason: "provider authentication is malformed" });
}

function malformedAuthentication(reason: string): AuthenticateDemosCciResult {
  return Object.freeze({ status: "error", reason });
}

/** Authenticate one captured GCR response before it can feed trust decisions. */
export async function authenticateDemosCciRecord(
  subject: string,
  raw: unknown,
  deps: AuthenticateDemosCciDeps,
): Promise<AuthenticateDemosCciResult> {
  if (
    typeof subject !== "string" ||
    subject === "" ||
    subject.trim() !== subject ||
    subject.normalize("NFC") !== subject ||
    !isCanonicalClaimReference(subject)
  ) {
    return malformedAuthentication("CCI subject is malformed");
  }
  let authenticateResolution: AuthenticateDemosCciDeps["authenticateResolution"];
  let authenticateProviderClaim:
    | AuthenticateDemosCciDeps["authenticateProviderClaim"]
    | undefined;
  try {
    if (
      !isPlainRecord(deps) ||
      (Object.getPrototypeOf(deps) !== Object.prototype &&
        Object.getPrototypeOf(deps) !== null)
    ) {
      throw new TypeError("dependencies must be a plain record");
    }
    const keys = Reflect.ownKeys(deps);
    if (
      !keys.includes("authenticateResolution") ||
      !keys.every((key) =>
        key === "authenticateResolution" || key === "authenticateProviderClaim")
    ) {
      throw new TypeError("authentication dependencies contain unknown fields");
    }
    authenticateResolution = ownDataFunction<AuthenticateDemosCciDeps["authenticateResolution"]>(
      deps,
      "authenticateResolution",
    )!;
    authenticateProviderClaim = ownDataFunction<
      NonNullable<AuthenticateDemosCciDeps["authenticateProviderClaim"]>
    >(deps, "authenticateProviderClaim", true);
  } catch {
    return malformedAuthentication("CCI resolution authenticator is unavailable");
  }

  let record: CciRecord;
  try {
    record = deepFreeze(parseCciRecord(subject, raw));
  } catch {
    return malformedAuthentication("CCI response is not stable data-only JSON");
  }

  let authentication: DemosCciResolutionAuthentication;
  try {
    const returned = await Reflect.apply(
      authenticateResolution,
      INERT_CCI_RECEIVER,
      [Object.freeze({ subject, record, raw: record.raw })],
    );
    try {
      authentication = snapshotCanonicalJsonRead(
        returned,
        "Demos CCI authentication result",
      );
    } catch {
      return malformedAuthentication("CCI resolution authentication is malformed");
    }
  } catch {
    return Object.freeze({
      status: "indeterminate",
      reason: "CCI resolution authentication was unavailable",
    });
  }

  if (
    authentication === null ||
    typeof authentication !== "object" ||
    !("status" in authentication)
  ) {
    return malformedAuthentication("CCI resolution authentication is malformed");
  }
  if (authentication.status !== "authenticated") {
    if (Reflect.ownKeys(authentication).length !== 2) {
      return malformedAuthentication("CCI resolution authentication is malformed");
    }
    if (
      (authentication.status !== "invalid" &&
        authentication.status !== "indeterminate" &&
        authentication.status !== "error") ||
      typeof authentication.reason !== "string" ||
      authentication.reason.trim() === ""
    ) {
      return malformedAuthentication("CCI resolution authentication is malformed");
    }
    return Object.freeze({
      status: authentication.status,
      reason: authentication.reason,
    });
  }

  if (
    !Reflect.ownKeys(authentication).every((key) =>
      key === "status" ||
      key === "subject" ||
      key === "observedAt" ||
      key === "authority" ||
      key === "evidence"
    ) ||
    Reflect.ownKeys(authentication).length !==
      (authentication.evidence === undefined ? 4 : 5) ||
    authentication.subject !== subject ||
    !isSafeTime(authentication.observedAt) ||
    typeof authentication.authority !== "string" ||
    authentication.authority === "" ||
    authentication.authority.trim() !== authentication.authority ||
    (authentication.evidence !== undefined &&
      (authentication.evidence === null ||
        typeof authentication.evidence !== "object" ||
        Array.isArray(authentication.evidence)))
  ) {
    return malformedAuthentication("CCI resolution authentication is malformed or misbound");
  }

  const provenance = deepFreeze({
    subject,
    observedAt: authentication.observedAt,
    authority: authentication.authority,
    ...(authentication.evidence !== undefined
      ? { evidence: authentication.evidence }
      : {}),
  });
  // Resolution authentication receives the exact raw response. Once that
  // capability has bound it into retained provenance, do not keep unrelated
  // RPC fields alive in the trust-bearing record.
  const authenticatedRecord = deepFreeze({
    ...record,
    raw: null,
  });
  const providerClaims = new Map<string, DemosCciProviderClaimAuthentication>();
  for (const claim of [
    ...authenticatedRecord.nomis,
    ...authenticatedRecord.humanPassport,
    ...authenticatedRecord.ethos,
  ]) {
    if (!authenticateProviderClaim) continue;
    let disposition: DemosCciProviderClaimAuthentication;
    try {
      const returned = await Reflect.apply(
        authenticateProviderClaim,
        INERT_CCI_RECEIVER,
        [deepFreeze({ subject, record: authenticatedRecord, claim })],
      );
      disposition = providerAuthentication(
        returned,
        subject,
        claim.ref,
        provenance.observedAt,
      );
      if (disposition.status === "verified" &&
          disposition.verifiedAt < claim.observedAt) {
        disposition = Object.freeze({
          status: "error",
          reason: "provider authentication predates the claimed observation",
        });
      }
    } catch {
      disposition = Object.freeze({
        status: "error",
        reason: "provider authentication was unavailable",
      });
    }
    providerClaims.set(claim.ref, disposition);
  }
  authenticatedCciRecords.set(authenticatedRecord, { provenance, providerClaims });
  return Object.freeze({
    status: "authenticated",
    record: authenticatedRecord as AuthenticatedCciRecord,
    provenance,
  });
}

/** Runtime provenance check; structural copies intentionally fail it. */
export function isAuthenticatedCciRecord(
  value: unknown,
): value is AuthenticatedCciRecord {
  return value !== null && typeof value === "object" &&
    authenticatedCciRecords.has(value);
}

/** Return retained GCR provenance, or null for untrusted/structural values. */
export function getAuthenticatedCciProvenance(
  value: unknown,
): Readonly<DemosCciProvenance> | null {
  return value !== null && typeof value === "object"
    ? authenticatedCciRecords.get(value)?.provenance ?? null
    : null;
}

export interface CciSupplementaryFreshnessPolicy {
  evaluatedAt: number;
  /** Explicit source-specific freshness ceilings. No implicit TTL is applied. */
  maxAgeSec: {
    nomis: number;
    humanPassport: number;
    ethos: number;
  };
}

export type CciSignalOmissionReason =
  | "provider-unverified"
  | "provider-invalid"
  | "provider-indeterminate"
  | "provider-error"
  | "source-after-resolution"
  | "source-in-future"
  | "stale"
  | "expired"
  | "not-passing";

export interface CciSignalOmission {
  ref: string;
  reason: CciSignalOmissionReason;
}

export interface CciSupplementarySignalProjection {
  signals: SupplementarySignal[];
  omitted: CciSignalOmission[];
}

function maxAgeMilliseconds(seconds: unknown, label: string): number {
  if (
    typeof seconds !== "number" ||
    !Number.isSafeInteger(seconds) ||
    seconds < 0 ||
    !Number.isSafeInteger(seconds * 1_000)
  ) {
    throw new DacsError(`${label} must be a non-negative safe integer`);
  }
  return seconds * 1_000;
}

function freshnessOmission(
  observedAt: number,
  provenanceAt: number,
  evaluatedAt: number,
  maxAgeMs: number,
): CciSignalOmissionReason | null {
  if (observedAt > provenanceAt) return "source-after-resolution";
  if (observedAt > evaluatedAt) return "source-in-future";
  if (evaluatedAt - observedAt > maxAgeMs) return "stale";
  return null;
}

/**
 * Project fresh, native reputation scores into DACS-2 advisory signals.
 *
 * The input must carry runtime authentication provenance. Signals remain
 * supplementary: callers pass `projection.signals` to Vet, whose aggregation
 * algorithm never uses them to elevate or downgrade `overallDecision`.
 */
export function projectCciSupplementarySignals(
  record: AuthenticatedCciRecord,
  policy: CciSupplementaryFreshnessPolicy,
): CciSupplementarySignalProjection {
  const authenticated = authenticatedCciRecords.get(record);
  const provenance = authenticated?.provenance;
  if (!authenticated || !provenance) {
    throw new DacsError("CCI supplementary signals require an authenticated GCR record");
  }
  let capturedPolicy: CciSupplementaryFreshnessPolicy;
  try {
    capturedPolicy = snapshotCanonicalJsonRead(
      policy,
      "CCI supplementary freshness policy",
    );
  } catch {
    throw new DacsError("CCI supplementary freshness policy is malformed");
  }
  if (
    Reflect.ownKeys(capturedPolicy).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(capturedPolicy, "evaluatedAt") ||
    !Object.prototype.hasOwnProperty.call(capturedPolicy, "maxAgeSec") ||
    capturedPolicy.maxAgeSec === null ||
    typeof capturedPolicy.maxAgeSec !== "object" ||
    Array.isArray(capturedPolicy.maxAgeSec) ||
    Reflect.ownKeys(capturedPolicy.maxAgeSec).length !== 3 ||
    !Object.prototype.hasOwnProperty.call(capturedPolicy.maxAgeSec, "nomis") ||
    !Object.prototype.hasOwnProperty.call(capturedPolicy.maxAgeSec, "humanPassport") ||
    !Object.prototype.hasOwnProperty.call(capturedPolicy.maxAgeSec, "ethos")
  ) {
    throw new DacsError("CCI supplementary freshness policy is malformed");
  }
  if (!isSafeTime(capturedPolicy.evaluatedAt)) {
    throw new DacsError("CCI signal evaluatedAt must be a non-negative safe integer");
  }
  if (provenance.observedAt > capturedPolicy.evaluatedAt) {
    throw new DacsError("CCI signal evaluation predates the authenticated GCR read");
  }

  const maxAge = {
    nomis: maxAgeMilliseconds(capturedPolicy.maxAgeSec?.nomis, "Nomis maxAgeSec"),
    humanPassport: maxAgeMilliseconds(
      capturedPolicy.maxAgeSec?.humanPassport,
      "Human Passport maxAgeSec",
    ),
    ethos: maxAgeMilliseconds(capturedPolicy.maxAgeSec?.ethos, "Ethos maxAgeSec"),
  };
  const signals: SupplementarySignal[] = [];
  const omitted: CciSignalOmission[] = [];

  const addScore = (
    claim: Extract<CciClaim, { kind: "nomis" | "humanpassport" | "ethos" }>,
    source: "cci-nomis" | "cci-humanpassport" | "cci-ethos",
    maxAgeMs: number,
  ): void => {
    const provider = authenticated.providerClaims.get(claim.ref);
    if (!provider || provider.status !== "verified") {
      const reason: CciSignalOmissionReason = !provider
        ? "provider-unverified"
        : provider.status === "invalid"
          ? "provider-invalid"
          : provider.status === "indeterminate"
            ? "provider-indeterminate"
            : "provider-error";
      omitted.push({ ref: claim.ref, reason });
      return;
    }
    const reason = freshnessOmission(
      claim.observedAt,
      provenance.observedAt,
      capturedPolicy.evaluatedAt,
      maxAgeMs,
    );
    if (reason) {
      omitted.push({ ref: claim.ref, reason });
      return;
    }
    if (claim.kind === "humanpassport") {
      if (!claim.passingScore) {
        omitted.push({ ref: claim.ref, reason: "not-passing" });
        return;
      }
      if (claim.expiresAt !== null && capturedPolicy.evaluatedAt >= claim.expiresAt) {
        omitted.push({ ref: claim.ref, reason: "expired" });
        return;
      }
    }
    signals.push({
      source,
      signalType: `score:${claim.ref}`,
      value: claim.score,
      observedAt: claim.observedAt,
    });
  };

  for (const claim of record.nomis) addScore(claim, "cci-nomis", maxAge.nomis);
  for (const claim of record.humanPassport) {
    addScore(claim, "cci-humanpassport", maxAge.humanPassport);
  }
  for (const claim of record.ethos) addScore(claim, "cci-ethos", maxAge.ethos);

  return deepFreeze({ signals, omitted });
}

export type CciTlsnDisposition =
  | {
      status: "native-cci";
      claim: Readonly<Extract<CciClaim, { kind: "tlsn" }>>;
      jobId: string;
      sessionNonce: string;
      bundleHash: string;
      verification: Readonly<{
        verifiedAt: number;
        authority: string;
        binding: Readonly<NativeCciTlsnBinding>;
        evidence?: Record<string, unknown>;
      }>;
    }
  | { status: "external-required"; reason: string }
  | { status: "invalid" | "indeterminate" | "error"; reason: string };

export interface CciTlsnSessionContext {
  jobId: string;
  expectedPresenter: string;
  sessionNonce: string;
  expectedServer: string;
  evaluatedAt: number;
  maxResolutionAgeSec: number;
  maxProofAgeSec: number;
  maxPresentationAgeSec: number;
}

export interface VerifyNativeCciTlsnInput {
  subject: string;
  jobId: string;
  sessionNonce: string;
  expectedServer: string;
  bundleHash: string;
  proofHash: string;
  evaluatedAt: number;
  claim: Readonly<Extract<CciClaim, { kind: "tlsn" }>>;
  resolution: Readonly<DemosCciProvenance>;
}

export interface NativeCciTlsnBinding {
  subject: string;
  jobId: string;
  sessionNonce: string;
  expectedServer: string;
  bundleHash: string;
  proofHash: string;
  resolutionObservedAt: number;
}

export type NativeCciTlsnAuthentication =
  | Readonly<{
      status: "verified";
      verifiedAt: number;
      authority: string;
      binding: Readonly<NativeCciTlsnBinding>;
      evidence?: Record<string, unknown>;
    }>
  | Readonly<{
      status: "invalid" | "indeterminate" | "error";
      reason: string;
    }>;

export interface ClassifyCciTlsnDeps {
  /** Authenticate BP-4 over the exact captured bundle hash. */
  verifyIdentityPresentation: (input: Readonly<{
    bundle: Readonly<IdentityBundle>;
    signedBytes: Uint8Array;
  }>) => Promise<boolean> | boolean;
  /**
   * Verify native TLSN evidence against every exact active-session coordinate.
   * GCR inclusion and an IdentityBundle presentation are insufficient alone.
   */
  verifyNativeTlsn(
    input: Readonly<VerifyNativeCciTlsnInput>,
  ): Promise<NativeCciTlsnAuthentication> | NativeCciTlsnAuthentication;
}

function nativeTlsnBindingMatches(
  value: unknown,
  expected: Readonly<NativeCciTlsnBinding>,
): value is Record<string, unknown> {
  if (!isPlainRecord(value) || Reflect.ownKeys(value).length !== 7) return false;
  return Object.entries(expected).every(([key, expectedValue]) =>
    value[key] === expectedValue);
}

function captureTlsnContext(value: unknown): CciTlsnSessionContext {
  const retained = snapshotCanonicalJsonRead(value, "CCI TLSN session context");
  if (!isPlainRecord(retained) || Reflect.ownKeys(retained).length !== 8 ||
      !["jobId", "expectedPresenter", "sessionNonce", "evaluatedAt",
        "expectedServer", "maxResolutionAgeSec", "maxProofAgeSec",
        "maxPresentationAgeSec"]
        .every((key) => Object.prototype.hasOwnProperty.call(retained, key)) ||
      !isCanonicalClaimReference(retained.expectedPresenter) ||
      !isCanonicalDomainHostname(retained.expectedServer) ||
      typeof retained.sessionNonce !== "string" || retained.sessionNonce.length === 0 ||
      retained.sessionNonce.length > 256 ||
      retained.sessionNonce.trim() !== retained.sessionNonce ||
      retained.sessionNonce.normalize("NFC") !== retained.sessionNonce ||
      /[\u0000-\u001f\u007f]/.test(retained.sessionNonce) ||
      !isSafeTime(retained.evaluatedAt)) {
    throw new DacsError("CCI TLSN session context is malformed");
  }
  requireCanonicalJobId(retained.jobId, "CCI TLSN jobId");
  maxAgeMilliseconds(retained.maxResolutionAgeSec, "CCI resolution maxAgeSec");
  maxAgeMilliseconds(retained.maxProofAgeSec, "CCI TLSN proof maxAgeSec");
  maxAgeMilliseconds(retained.maxPresentationAgeSec, "IdentityBundle maxAgeSec");
  return retained as unknown as CciTlsnSessionContext;
}

function captureTlsnDeps(value: unknown): Required<ClassifyCciTlsnDeps> {
  if (!isPlainRecord(value)) throw new DacsError("CCI TLSN verifiers are malformed");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes("verifyIdentityPresentation") ||
      !keys.includes("verifyNativeTlsn")) {
    throw new DacsError("CCI TLSN verifiers are malformed");
  }
  return Object.freeze({
    verifyIdentityPresentation: ownDataFunction<
      ClassifyCciTlsnDeps["verifyIdentityPresentation"]
    >(value, "verifyIdentityPresentation")!,
    verifyNativeTlsn: ownDataFunction<ClassifyCciTlsnDeps["verifyNativeTlsn"]>(
      value,
      "verifyNativeTlsn",
    )!,
  });
}

function nativeTlsnAuthentication(
  value: unknown,
  expectedBinding: Readonly<NativeCciTlsnBinding>,
  minimumVerifiedAt: number,
  evaluatedAt: number,
): NativeCciTlsnAuthentication {
  const retained = snapshotCanonicalJsonRead(value, "native CCI TLSN authentication");
  if (!isPlainRecord(retained) || typeof retained.status !== "string") {
    return Object.freeze({ status: "error", reason: "native TLSN authentication is malformed" });
  }
  const keys = Reflect.ownKeys(retained);
  if (retained.status === "verified") {
    if (!keys.every((key) =>
      key === "status" || key === "verifiedAt" || key === "authority" ||
      key === "binding" || key === "evidence") ||
        keys.length !== (retained.evidence === undefined ? 4 : 5) ||
        !isSafeTime(retained.verifiedAt) || retained.verifiedAt < minimumVerifiedAt ||
        retained.verifiedAt > evaluatedAt || typeof retained.authority !== "string" ||
        retained.authority.length === 0 || retained.authority.trim() !== retained.authority ||
        !nativeTlsnBindingMatches(retained.binding, expectedBinding) ||
        (retained.evidence !== undefined && !isPlainRecord(retained.evidence))) {
      return Object.freeze({ status: "error", reason: "native TLSN authentication is malformed" });
    }
    return deepFreeze(retained as unknown as NativeCciTlsnAuthentication);
  }
  if ((retained.status === "invalid" || retained.status === "indeterminate" ||
      retained.status === "error") && keys.length === 2 && keys.includes("reason") &&
      typeof retained.reason === "string" && retained.reason.trim().length > 0) {
    return Object.freeze({ status: retained.status, reason: retained.reason });
  }
  return Object.freeze({ status: "error", reason: "native TLSN authentication is malformed" });
}

/**
 * Distinguish a registered native TLSN commitment from an unregistered session
 * proof. Only the latter may enter DACS-2's external `tlsnotary` method.
 */
export async function classifyCciTlsnProof(
  record: AuthenticatedCciRecord,
  bundle: Readonly<IdentityBundle>,
  proofHash: string,
  context: Readonly<CciTlsnSessionContext>,
  deps: ClassifyCciTlsnDeps,
): Promise<CciTlsnDisposition> {
  const authenticated = authenticatedCciRecords.get(record);
  if (!authenticated) {
    return Object.freeze({ status: "invalid", reason: "CCI record is unauthenticated" });
  }
  let capturedContext: CciTlsnSessionContext;
  let capturedBundle: IdentityBundle;
  let capturedDeps: Required<ClassifyCciTlsnDeps>;
  try {
    capturedContext = captureTlsnContext(context);
    capturedBundle = snapshotCanonicalJsonRead(bundle, "CCI TLSN IdentityBundle");
    capturedDeps = captureTlsnDeps(deps);
  } catch {
    return Object.freeze({ status: "invalid", reason: "CCI TLSN request is malformed" });
  }
  if (!isIdentityBundle(capturedBundle)) {
    return Object.freeze({ status: "invalid", reason: "IdentityBundle is malformed" });
  }
  if (!sameCanonicalClaimIdentity(capturedContext.expectedPresenter, record.primaryClaim) ||
      !sameCanonicalClaimIdentity(capturedBundle.presentedBy, record.primaryClaim)) {
    return Object.freeze({
      status: "invalid",
      reason: "IdentityBundle presenter does not match the authenticated CCI subject",
    });
  }
  if (capturedBundle.sessionNonce !== capturedContext.sessionNonce) {
    return Object.freeze({
      status: "invalid",
      reason: "IdentityBundle session nonce does not match the active Vet session",
    });
  }
  const resolutionAt = authenticated.provenance.observedAt;
  const resolutionMaxAge = maxAgeMilliseconds(
    capturedContext.maxResolutionAgeSec,
    "CCI resolution maxAgeSec",
  );
  const presentationMaxAge = maxAgeMilliseconds(
    capturedContext.maxPresentationAgeSec,
    "IdentityBundle maxAgeSec",
  );
  if (resolutionAt > capturedContext.evaluatedAt ||
      capturedContext.evaluatedAt - resolutionAt > resolutionMaxAge) {
    return Object.freeze({
      status: "invalid",
      reason: "authenticated CCI resolution is not current for the active Vet session",
    });
  }
  if (!isSafeTime(capturedBundle.presentedAt) ||
      capturedBundle.presentedAt > capturedContext.evaluatedAt ||
      capturedContext.evaluatedAt - capturedBundle.presentedAt > presentationMaxAge) {
    return Object.freeze({
      status: "invalid",
      reason: "IdentityBundle presentation is not current for the active Vet session",
    });
  }
  if (typeof proofHash !== "string" || !/^[0-9a-f]{64}$/.test(proofHash)) {
    return Object.freeze({ status: "invalid", reason: "TLSN proof hash is malformed" });
  }
  const bundleHash = identityBundleHash(capturedBundle);
  let presentationValid = false;
  try {
    presentationValid = await Reflect.apply(
      capturedDeps.verifyIdentityPresentation,
      INERT_CCI_RECEIVER,
      [deepFreeze({
        bundle: capturedBundle,
        signedBytes: signedBytes("dacs-bundle-presentation:v1:", bundleHash),
      })],
    ) === true;
  } catch {
    presentationValid = false;
  }
  if (!presentationValid) {
    return Object.freeze({
      status: "invalid",
      reason: "IdentityBundle presentation is not authenticated",
    });
  }
  const ref = `cci-tlsn:${proofHash}`;
  const claim = record.tlsn.find((candidate) => candidate.ref === ref);
  const presented = capturedBundle.claims.some((candidate) => candidate.ref === ref);
  if (!claim) {
    return Object.freeze({
      status: "external-required",
      reason: "TLSN proof is not registered in the authenticated CCI record",
    });
  }
  if (!presented) {
    return Object.freeze({
      status: "invalid",
      reason: "registered TLSN commitment was not presented in the signed IdentityBundle",
    });
  }
  const proofMaxAge = maxAgeMilliseconds(
    capturedContext.maxProofAgeSec,
    "CCI TLSN proof maxAgeSec",
  );
  if (!isSafeTime(claim.observedAt) || claim.observedAt > resolutionAt ||
      claim.observedAt > capturedContext.evaluatedAt ||
      capturedBundle.presentedAt < claim.observedAt ||
      capturedContext.evaluatedAt - claim.observedAt > proofMaxAge) {
    return Object.freeze({
      status: "invalid",
      reason: "registered TLSN commitment is not current for the active Vet session",
    });
  }
  let nativeAuthentication: NativeCciTlsnAuthentication;
  try {
    const binding = deepFreeze({
      subject: record.primaryClaim,
      jobId: capturedContext.jobId,
      sessionNonce: capturedContext.sessionNonce,
      expectedServer: capturedContext.expectedServer,
      bundleHash,
      proofHash,
      resolutionObservedAt: authenticated.provenance.observedAt,
    });
    const returned = await Reflect.apply(
      capturedDeps.verifyNativeTlsn,
      INERT_CCI_RECEIVER,
      [deepFreeze({
        subject: record.primaryClaim,
        jobId: capturedContext.jobId,
        sessionNonce: capturedContext.sessionNonce,
        expectedServer: capturedContext.expectedServer,
        bundleHash,
        proofHash,
        evaluatedAt: capturedContext.evaluatedAt,
        claim,
        resolution: authenticated.provenance,
      })],
    );
    nativeAuthentication = nativeTlsnAuthentication(
      returned,
      binding,
      Math.max(claim.observedAt, capturedBundle.presentedAt, resolutionAt),
      capturedContext.evaluatedAt,
    );
  } catch {
    return Object.freeze({
      status: "indeterminate",
      reason: "native TLSN authentication was unavailable",
    });
  }
  if (nativeAuthentication.status !== "verified") {
    return Object.freeze({
      status: nativeAuthentication.status,
      reason: nativeAuthentication.reason,
    });
  }
  return deepFreeze({
    status: "native-cci" as const,
    claim,
    jobId: capturedContext.jobId,
    sessionNonce: capturedContext.sessionNonce,
    bundleHash,
    verification: {
      verifiedAt: nativeAuthentication.verifiedAt,
      authority: nativeAuthentication.authority,
      binding: nativeAuthentication.binding,
      ...(nativeAuthentication.evidence !== undefined
        ? { evidence: nativeAuthentication.evidence }
        : {}),
    },
  });
}
