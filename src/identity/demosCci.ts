import type {
  IdentityBundle,
  SupplementarySignal,
} from "../artifacts/types.js";
import { isIdentityBundle } from "../artifacts/validators.js";
import { signedBytes } from "../crypto/index.js";
import { snapshotCanonicalJsonRead } from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";
import { sameCanonicalClaimIdentity } from "./claimReference.js";
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

const authenticatedCciRecords = new WeakMap<
  object,
  Readonly<DemosCciProvenance>
>();
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
    subject.normalize("NFC") !== subject
  ) {
    return malformedAuthentication("CCI subject is malformed");
  }
  let authenticateResolution: AuthenticateDemosCciDeps["authenticateResolution"];
  try {
    if (
      deps === null ||
      typeof deps !== "object" ||
      Array.isArray(deps) ||
      (Object.getPrototypeOf(deps) !== Object.prototype &&
        Object.getPrototypeOf(deps) !== null)
    ) {
      throw new TypeError("dependencies must be a plain record");
    }
    const keys = Reflect.ownKeys(deps);
    const descriptor = Object.getOwnPropertyDescriptor(deps, "authenticateResolution");
    if (
      keys.length !== 1 ||
      keys[0] !== "authenticateResolution" ||
      !descriptor ||
      descriptor.enumerable !== true ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "function"
    ) {
      throw new TypeError("authenticator must be an own data function");
    }
    authenticateResolution = descriptor.value as AuthenticateDemosCciDeps["authenticateResolution"];
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
  authenticatedCciRecords.set(record, provenance);
  return Object.freeze({
    status: "authenticated",
    record: record as AuthenticatedCciRecord,
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
    ? authenticatedCciRecords.get(value) ?? null
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
  const provenance = getAuthenticatedCciProvenance(record);
  if (!provenance) {
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
    }
  | { status: "external-required"; reason: string }
  | { status: "invalid"; reason: string };

export interface ClassifyCciTlsnDeps {
  /** Authenticate BP-4 over the exact captured bundle hash. */
  verifyIdentityPresentation: (input: Readonly<{
    bundle: Readonly<IdentityBundle>;
    signedBytes: Uint8Array;
  }>) => Promise<boolean> | boolean;
}

/**
 * Distinguish a registered native TLSN commitment from an unregistered session
 * proof. Only the latter may enter DACS-2's external `tlsnotary` method.
 */
export async function classifyCciTlsnProof(
  record: AuthenticatedCciRecord,
  bundle: Readonly<IdentityBundle>,
  proofHash: string,
  deps: ClassifyCciTlsnDeps,
): Promise<CciTlsnDisposition> {
  if (!isAuthenticatedCciRecord(record)) {
    return Object.freeze({ status: "invalid", reason: "CCI record is unauthenticated" });
  }
  let capturedBundle: IdentityBundle;
  try {
    capturedBundle = snapshotCanonicalJsonRead(bundle, "CCI TLSN IdentityBundle");
  } catch {
    return Object.freeze({ status: "invalid", reason: "IdentityBundle is malformed" });
  }
  if (!isIdentityBundle(capturedBundle)) {
    return Object.freeze({ status: "invalid", reason: "IdentityBundle is malformed" });
  }
  let verifyPresentation: ClassifyCciTlsnDeps["verifyIdentityPresentation"];
  try {
    const descriptor = Object.getOwnPropertyDescriptor(deps, "verifyIdentityPresentation");
    if (
      deps === null ||
      typeof deps !== "object" ||
      Reflect.ownKeys(deps).length !== 1 ||
      !descriptor ||
      descriptor.enumerable !== true ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "function"
    ) {
      throw new TypeError("presentation verifier is malformed");
    }
    verifyPresentation = descriptor.value as ClassifyCciTlsnDeps["verifyIdentityPresentation"];
  } catch {
    return Object.freeze({
      status: "invalid",
      reason: "IdentityBundle presentation verifier is unavailable",
    });
  }
  let presentationValid = false;
  try {
    presentationValid = await Reflect.apply(
      verifyPresentation,
      INERT_CCI_RECEIVER,
      [deepFreeze({
        bundle: capturedBundle,
        signedBytes: signedBytes(
          "dacs-bundle-presentation:v1:",
          identityBundleHash(capturedBundle),
        ),
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
  if (!sameCanonicalClaimIdentity(capturedBundle.presentedBy, record.primaryClaim)) {
    return Object.freeze({
      status: "invalid",
      reason: "IdentityBundle presenter does not match the authenticated CCI subject",
    });
  }
  const normalizedHash = typeof proofHash === "string" ? proofHash.toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(normalizedHash)) {
    return Object.freeze({ status: "invalid", reason: "TLSN proof hash is malformed" });
  }
  const ref = `cci-tlsn:${normalizedHash}`;
  const claim = record.tlsn.find((candidate) => candidate.ref === ref);
  const presented = capturedBundle.claims.some((candidate) => candidate.ref === ref);
  if (claim && presented) {
    return Object.freeze({ status: "native-cci", claim });
  }
  return Object.freeze({
    status: "external-required",
    reason: claim
      ? "registered TLSN commitment was not presented in the signed IdentityBundle"
      : "TLSN proof is not registered in the authenticated CCI record",
  });
}
