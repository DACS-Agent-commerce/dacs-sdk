import { requireAuthenticatedSessionProfile, type AuthenticateSessionProfile } from "../discovery/sessionProfileAdmission.js";
import { types as nodeTypes } from "node:util";

import type {
  AnchorReceipt,
  BundleBinding,
  FaultAttestationBundle,
} from "../artifacts/types.js";
import {
  BUNDLE_BINDING_SEPARATOR,
  isAnchorReceipt,
  isBundleBinding,
  isCanonicalBase64Url,
  isFaultAttestationBundle,
} from "../artifacts/index.js";
import { bundleAddress, canonicalize, contentHash } from "../canonical/index.js";
import { snapshotCanonicalJsonRead } from "../canonical/snapshot.js";
import { signedBytes } from "../crypto/index.js";
import { DacsError, IndeterminateSubstrateError, SubstrateError } from "../errors.js";
import { isUnresolvedBundleBindingCandidateSet } from "../discovery/bundleBindingCandidates.js";
import {
  isCanonicalClaimReference,
  sameCanonicalClaimIdentity,
} from "../identity/claimReference.js";
import { requireCanonicalJobId } from "../negotiate/jobId.js";
import {
  verifyBundleCopy,
  type BundleCopyDeps,
} from "../agent/bundleCopyValidity.js";
import { bundleConsistency } from "../agent/bundleConsistency.js";
import {
  attestationBundleHash,
  bundleSignedScope,
} from "../agent/twoSidedBundle.js";
import {
  verifyFinalizedSellerBundleReadOnly,
  type FinalizedSellerBundle,
  type SellerBundleFinalizationReadProvider,
  type VerifyFinalizedSellerBundleInput,
} from "../seller/bundleFinalization.js";
import {
  combineFixedPricePayDemOrderStatus,
  combineFixedPriceX402OrderStatus,
  type FixedPricePayDemCombinedOrderStatus,
  type FixedPricePayDemOrderStatus,
  type FixedPriceX402CombinedOrderStatus,
  type FixedPriceX402OrderStatus,
} from "./fixedPriceX402Coordinator.js";

export type FixedPriceX402AuditVerificationDisposition =
  | { disposition: "valid" }
  | { disposition: "invalid" | "indeterminate" | "error"; reason: string };

/**
 * Authenticated CORE §6.2 mapping classification for one independently read
 * role-owned bundle copy. `valid` means the adapter has also authenticated the
 * supplied receipt and, for a pure mapping, re-derived `nativeAddress` from
 * `logicalAddress`. Demos is always the write-input case (DEMOS-MAPPING §A.2).
 */
export type FixedPriceX402BundleAnchorVerificationDisposition =
  | { disposition: "valid"; mapping: "pure" | "write-input" }
  | { disposition: "invalid" | "indeterminate" | "error"; reason: string };

/** One independently published role-owned copy of a completed DACS-5 bundle. */
export type CompletedTwoSidedSessionRole = "buyer" | "seller";

export interface CompletedTwoSidedBundleCopy {
  role: CompletedTwoSidedSessionRole;
  nativeAddress: string;
  bundle: Readonly<FaultAttestationBundle>;
  anchorReceipt: Readonly<AnchorReceipt>;
  /** Required only when this copy's authenticated substrate mapping is write-input. */
  binding?: Readonly<BundleBinding>;
}

/** Backwards-compatible profile name retained for existing x402 callers. */
export type FixedPriceX402CompletedBundleCopy = CompletedTwoSidedBundleCopy;

/**
 * The exact durable `audit-pending` session closure and retained seller
 * finalization result. The SDK re-authenticates both with the existing strict
 * seller ST-11 verifier; this is not a caller-selected expected-ref list.
 */
export interface CompletedTwoSidedSellerClosure {
  verificationInput: Readonly<VerifyFinalizedSellerBundleInput>;
  result: Readonly<FinalizedSellerBundle>;
}

/** Backwards-compatible profile name retained for existing x402 callers. */
export type FixedPriceX402SellerCompletionClosure = CompletedTwoSidedSellerClosure;

/**
 * Rail-neutral input to the strict two-sided completed-session gate. The
 * seller closure is the authenticated ST-11 dependency manifest; the two
 * publications remain independently role-owned.
 */
export interface CompletedTwoSidedSessionInput {
  jobId: string;
  buyer: string;
  seller: string;
  sellerClosure: Readonly<CompletedTwoSidedSellerClosure>;
  copies: Readonly<{
    buyer: Readonly<CompletedTwoSidedBundleCopy>;
    seller: Readonly<CompletedTwoSidedBundleCopy>;
  }>;
}

export interface CompletedTwoSidedSessionResult {
  state: "audit-complete";
  jobId: string;
  buyer: Readonly<{
    logicalAddress: string;
    nativeAddress: string;
    bundleContentHash: string;
  }>;
  seller: Readonly<{
    logicalAddress: string;
    nativeAddress: string;
    bundleContentHash: string;
  }>;
}

export interface FixedPriceX402AuditCompletionInput {
  buyer: Readonly<FixedPriceX402OrderStatus>;
  seller: Readonly<FixedPriceX402OrderStatus>;
  sellerClosure: Readonly<FixedPriceX402SellerCompletionClosure>;
  copies: Readonly<{
    buyer: Readonly<FixedPriceX402CompletedBundleCopy>;
    seller: Readonly<FixedPriceX402CompletedBundleCopy>;
  }>;
}

/** Native-DEM projection of the same strict two-role completion boundary. */
export interface FixedPricePayDemAuditCompletionInput {
  buyer: Readonly<FixedPricePayDemOrderStatus>;
  seller: Readonly<FixedPricePayDemOrderStatus>;
  sellerClosure: Readonly<CompletedTwoSidedSellerClosure>;
  copies: Readonly<{
    buyer: Readonly<CompletedTwoSidedBundleCopy>;
    seller: Readonly<CompletedTwoSidedBundleCopy>;
  }>;
}

export interface CompletedTwoSidedSessionDeps {
  /** Independently authenticated deployment admission, required before completion. */
  authenticateSessionProfile: AuthenticateSessionProfile;
  /**
   * Existing strict seller finalization provider. Its dependency graph is the
   * authoritative completed-session manifest: Listing, DACS-2 composites,
   * AgreementArtifact, DACS-3 commitment, every executed DACS-4 evidence
   * record, and the complete transitive DPA closure are all verified here.
   */
  sellerFinalizationProvider: SellerBundleFinalizationReadProvider;
  /** Independently read an exact role-owned bundle at its native address. */
  readBundleCopy(
    nativeAddress: string,
    role: CompletedTwoSidedSessionRole,
  ):
    | Promise<Readonly<Record<string, unknown>> | null>
    | Readonly<Record<string, unknown>>
    | null;
  /**
   * Authenticate this exact bundle receipt and establish its mapping class.
   * For a pure mapping the adapter MUST re-derive the native address. For a
   * write-input mapping it MUST authenticate the receipt's native publication;
   * BB-1..BB-8 verification is additionally required below.
   */
  verifyBundleAnchor(
    copy: Readonly<CompletedTwoSidedBundleCopy>,
  ):
    | Promise<FixedPriceX402BundleAnchorVerificationDisposition>
    | FixedPriceX402BundleAnchorVerificationDisposition;
  /**
   * Required for each write-input copy. The adapter must apply BB-4..BB-8,
   * including candidate authorization, multiplicity, fetch bounds, and
   * suppression diligence, before returning one resolved binding. `carried`
   * is the signed binding the copy carries (BB-2); the adapter adds it to the
   * candidates it discovered, so BB-6 judges them together. Report
   * non-observation as `indeterminate` with a
   * `BUNDLE_BINDING_NON_OBSERVATION_REASONS` reason (BB-8); it gates nothing.
   * Every other `indeterminate` reason is a candidate set that did not
   * resolve (equivocation, an exhausted budget, an unfetched or rejected
   * candidate) and holds completion back.
   */
  resolveBundleBinding?: (
    logicalAddress: string,
    signer: string,
    role: CompletedTwoSidedSessionRole,
    carried?: Readonly<BundleBinding>,
  ) =>
    | Promise<
      | { disposition: "present"; binding: unknown }
      | { disposition: "absent" }
      | { disposition: "indeterminate"; reason: string }
    >
    | { disposition: "present"; binding: unknown }
    | { disposition: "absent" }
    | { disposition: "indeterminate"; reason: string };
  /**
   * Required for each write-input copy. It authenticates method-native
   * publication/finality after the SDK's local checks and exact resolver
   * readback comparison.
   */
  verifyBundleBinding?: (
    binding: Readonly<BundleBinding>,
  ) =>
    | Promise<FixedPriceX402AuditVerificationDisposition>
    | FixedPriceX402AuditVerificationDisposition;
  /** Bounds the whole gate; see `CompletedTwoSidedSessionDeadline`. */
  deadline?: Readonly<CompletedTwoSidedSessionDeadline>;
}

/** Default bound on the completed-session gate. */
export const COMPLETED_TWO_SIDED_SESSION_DEADLINE_MS = 60_000;

/**
 * How long the gate may take. One deadline, armed once when the gate starts
 * and disarmed when it returns, bounds native DEM profile admission,
 * the seller-closure re-verification,
 * both copies' verification and the final pair check. At the deadline an
 * authoritative rejection of a copy already observed is reported; without one
 * the gate throws `IndeterminateSubstrateError`, which is retryable. Whatever
 * settles later changes nothing. `start` arms the deadline, calls `expire`
 * when it passes and returns a function that disarms it; inject it to drive
 * the clock. The default is an unreferenced `setTimeout`.
 */
export interface CompletedTwoSidedSessionDeadline {
  /** Defaults to `COMPLETED_TWO_SIDED_SESSION_DEADLINE_MS`. */
  timeoutMs?: number;
  start?(expire: () => void, timeoutMs: number): () => void;
}

/** Backwards-compatible profile name retained for existing x402 callers. */
export interface FixedPriceX402AuditCompletionDeps
  extends CompletedTwoSidedSessionDeps {}

/** Native-DEM alias retained as an explicit discoverable public surface. */
export { COMPLETED_SESSION_MODULE_VERSIONS, DACS_STANDARD_PROFILE_STATUS } from "../discovery/sessionProfileAdmission.js";

export interface FixedPricePayDemAuditCompletionDeps extends CompletedTwoSidedSessionDeps {
  /**
   * Verifier-owned deployment admission, independent of all caller input.
   * Authenticate every role's exact session, participant, release and full
   * module tuple from trusted configuration/evidence. Never copy profile or
   * role claims from artifacts or order statuses into this result.
   */
  authenticateSessionProfile(): Promise<unknown> | unknown;
}

interface CapturedAuditCompletionDeps {
  deadline: Readonly<Required<CompletedTwoSidedSessionDeadline>>;
  sellerFinalizationProvider: SellerBundleFinalizationReadProvider;
  sellerMapping: "pure" | "write-input";
  bundleCopyVerifier: BundleCopyDeps;
  readBundleCopy: CompletedTwoSidedSessionDeps["readBundleCopy"];
  verifyBundleAnchor: CompletedTwoSidedSessionDeps["verifyBundleAnchor"];
  resolveBundleBinding?: NonNullable<
    CompletedTwoSidedSessionDeps["resolveBundleBinding"]
  >;
  verifyBundleBinding?: NonNullable<
    CompletedTwoSidedSessionDeps["verifyBundleBinding"]
  >;
}

const clone = <T>(value: T): T => structuredClone(value);
const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    !nodeTypes.isProxy(value);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key)) &&
    optional.every((key) => !hasOwn(value, key) || value[key] !== undefined);
}

function verificationDisposition(
  value: unknown,
  label: string,
): FixedPriceX402AuditVerificationDisposition {
  const retained = snapshotCanonicalJsonRead(value, `${label} disposition`);
  if (!isRecord(retained)) throw new DacsError(`${label} returned a malformed disposition`);
  if (retained.disposition === "valid" && exactKeys(retained, ["disposition"])) {
    return { disposition: "valid" };
  }
  if ((retained.disposition === "invalid" || retained.disposition === "indeterminate" ||
      retained.disposition === "error") && exactKeys(retained, ["disposition", "reason"]) &&
      typeof retained.reason === "string" && retained.reason.length > 0) {
    return retained as unknown as FixedPriceX402AuditVerificationDisposition;
  }
  throw new DacsError(`${label} returned a malformed disposition`);
}

function anchorVerificationDisposition(
  value: unknown,
  label: string,
): FixedPriceX402BundleAnchorVerificationDisposition {
  const retained = snapshotCanonicalJsonRead(value, `${label} disposition`);
  if (!isRecord(retained)) throw new DacsError(`${label} returned a malformed disposition`);
  if (retained.disposition === "valid" &&
      exactKeys(retained, ["disposition", "mapping"]) &&
      (retained.mapping === "pure" || retained.mapping === "write-input")) {
    return retained as unknown as FixedPriceX402BundleAnchorVerificationDisposition;
  }
  if ((retained.disposition === "invalid" || retained.disposition === "indeterminate" ||
      retained.disposition === "error") && exactKeys(retained, ["disposition", "reason"]) &&
      typeof retained.reason === "string" && retained.reason.length > 0) {
    return retained as unknown as FixedPriceX402BundleAnchorVerificationDisposition;
  }
  throw new DacsError(`${label} returned a malformed disposition`);
}

function objectBoundary(value: unknown, label: string): object {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      nodeTypes.isProxy(value)) {
    throw new DacsError(`${label} is malformed`);
  }
  return value;
}

function method<T extends (...args: never[]) => unknown>(
  source: object,
  key: string,
  label: string,
  optional = false,
): T | undefined {
  const visited = new Set<object>();
  let current: object | null = source;
  while (current !== null && !visited.has(current)) {
    if (nodeTypes.isProxy(current)) throw new DacsError(`${label}.${key} is malformed`);
    visited.add(current);
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function" ||
          nodeTypes.isProxy(descriptor.value)) {
        throw new DacsError(`${label}.${key} must be a data method`);
      }
      return descriptor.value.bind(source) as T;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  if (optional) return undefined;
  throw new DacsError(`${label}.${key} is required`);
}

function dataProperty<T>(source: object, key: string, label: string): T {
  const visited = new Set<object>();
  let current: object | null = source;
  while (current !== null && !visited.has(current)) {
    if (nodeTypes.isProxy(current)) throw new DacsError(`${label}.${key} is malformed`);
    visited.add(current);
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      if (!("value" in descriptor) || descriptor.value === undefined) {
        throw new DacsError(`${label}.${key} must be a data property`);
      }
      return descriptor.value as T;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  throw new DacsError(`${label}.${key} is required`);
}

function captureCopyVerifier(value: unknown): BundleCopyDeps {
  const source = objectBoundary(value, "bundle-copy verifier");
  const resolve = method<BundleCopyDeps["resolvePublicKey"]>(
    source,
    "resolvePublicKey",
    "bundle-copy verifier",
  )!;
  const verify = method<BundleCopyDeps["verify"]>(
    source,
    "verify",
    "bundle-copy verifier",
  )!;
  return Object.freeze({
    resolvePublicKey: async (claim: string) => {
      const key = await resolve(claim);
      return key instanceof Uint8Array ? new Uint8Array(key) : null;
    },
    verify: async (
      message: Uint8Array,
      signature: Uint8Array,
      publicKey: Uint8Array,
    ) => await verify(
      new Uint8Array(message),
      new Uint8Array(signature),
      new Uint8Array(publicKey),
    ) === true,
  });
}

function captureCoordinatorInput<T>(value: unknown, profile: string): T {
  const retained = snapshotCanonicalJsonRead(
    value,
    `${profile} audit completion input`,
  );
  if (!isRecord(retained) ||
      !exactKeys(retained, ["buyer", "seller", "sellerClosure", "copies"]) ||
      !isRecord(retained.sellerClosure) ||
      !exactKeys(retained.sellerClosure, ["verificationInput", "result"]) ||
      !isRecord(retained.copies) || !exactKeys(retained.copies, ["buyer", "seller"])) {
    throw new DacsError(`${profile} audit completion input is malformed`);
  }
  for (const role of ["buyer", "seller"] as const) {
    const copy = retained.copies[role];
    if (!isRecord(copy) || !exactKeys(
      copy,
      ["role", "nativeAddress", "bundle", "anchorReceipt"],
      ["binding"],
    ) || copy.role !== role) {
      throw new DacsError(`${profile} ${role} completion copy is malformed`);
    }
  }
  return retained as unknown as T;
}

function captureInput(value: unknown): FixedPriceX402AuditCompletionInput {
  return captureCoordinatorInput(value, "fixed-price x402");
}

function capturePayDemInput(value: unknown): FixedPricePayDemAuditCompletionInput {
  return captureCoordinatorInput(value, "fixed-price pay-DEM");
}

function captureCompletedInput(value: unknown): CompletedTwoSidedSessionInput {
  const retained = snapshotCanonicalJsonRead(
    value,
    "completed two-sided session input",
  );
  if (!isRecord(retained) ||
      !exactKeys(retained, ["jobId", "buyer", "seller", "sellerClosure", "copies"]) ||
      !isCanonicalClaimReference(retained.buyer) ||
      !isCanonicalClaimReference(retained.seller) ||
      sameCanonicalClaimIdentity(retained.buyer, retained.seller) ||
      !isRecord(retained.sellerClosure) ||
      !exactKeys(retained.sellerClosure, ["verificationInput", "result"]) ||
      !isRecord(retained.copies) || !exactKeys(retained.copies, ["buyer", "seller"])) {
    throw new DacsError("completed two-sided session input is malformed");
  }
  requireCanonicalJobId(retained.jobId, "completed two-sided session jobId");
  for (const role of ["buyer", "seller"] as const) {
    const copy = retained.copies[role];
    if (!isRecord(copy) || !exactKeys(
      copy,
      ["role", "nativeAddress", "bundle", "anchorReceipt"],
      ["binding"],
    ) || copy.role !== role) {
      throw new DacsError(`completed ${role} session copy is malformed`);
    }
  }
  return retained as unknown as CompletedTwoSidedSessionInput;
}

function startDeadlineTimer(expire: () => void, timeoutMs: number): () => void {
  const timer = setTimeout(expire, timeoutMs);
  (timer as { unref?: () => unknown }).unref?.();
  return () => clearTimeout(timer);
}

function captureDeadline(source: object): Readonly<Required<CompletedTwoSidedSessionDeadline>> {
  const label = "completed two-sided session dependencies.deadline";
  if (!("deadline" in source)) {
    return Object.freeze({
      timeoutMs: COMPLETED_TWO_SIDED_SESSION_DEADLINE_MS,
      start: startDeadlineTimer,
    });
  }
  const deadline = objectBoundary(
    dataProperty<unknown>(source, "deadline", "completed two-sided session dependencies"),
    label,
  );
  const timeoutMs = "timeoutMs" in deadline
    ? dataProperty<unknown>(deadline, "timeoutMs", label)
    : COMPLETED_TWO_SIDED_SESSION_DEADLINE_MS;
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new DacsError(`${label}.timeoutMs is malformed`);
  }
  return Object.freeze({
    timeoutMs,
    start: method<NonNullable<CompletedTwoSidedSessionDeadline["start"]>>(
      deadline,
      "start",
      label,
      true,
    ) ?? startDeadlineTimer,
  });
}

interface ArmedDeadline {
  timeoutMs: number;
  /** Settles once the deadline passes. */
  expired: Promise<void>;
  disarm(): void;
}

function armDeadline(
  deadline: Readonly<Required<CompletedTwoSidedSessionDeadline>>,
): ArmedDeadline {
  let expire = (): void => undefined;
  const expired = new Promise<void>((resolve) => { expire = resolve; });
  const disarm = deadline.start(() => expire(), deadline.timeoutMs);
  return { timeoutMs: deadline.timeoutMs, expired, disarm: () => disarm() };
}

// Settles as `phase` does, or throws an indeterminate result once the deadline
// passes first; whatever `phase` does later is ignored.
async function within<T>(phase: Promise<T>, deadline: ArmedDeadline, label: string): Promise<T> {
  const settled = await Promise.race([
    phase.then((value) => ({ value })),
    deadline.expired.then(() => undefined),
  ]);
  if (settled === undefined) {
    throw new IndeterminateSubstrateError(`${label} did not settle within ${deadline.timeoutMs} ms`);
  }
  return settled.value;
}

// Settles both verifications, or stops at the deadline. A verification still
// pending then is reported as undefined; whatever it does later is ignored.
async function settleWithin<T>(
  verifications: readonly [Promise<T>, Promise<T>],
  deadline: ArmedDeadline,
): Promise<[PromiseSettledResult<T> | undefined, PromiseSettledResult<T> | undefined]> {
  const settled: [PromiseSettledResult<T> | undefined, PromiseSettledResult<T> | undefined] =
    [undefined, undefined];
  const tracked = verifications.map((verification, index) => verification.then(
    (value) => { settled[index] = { status: "fulfilled", value }; },
    (reason: unknown) => { settled[index] = { status: "rejected", reason }; },
  ));
  await Promise.race([Promise.all(tracked), deadline.expired]);
  return [settled[0], settled[1]];
}

function captureDeps(value: unknown): CapturedAuditCompletionDeps {
  const source = objectBoundary(value, "completed two-sided session dependencies");
  const deadline = captureDeadline(source);
  const readBundleCopy = method<CompletedTwoSidedSessionDeps["readBundleCopy"]>(
    source,
    "readBundleCopy",
    "completed two-sided session dependencies",
  )!;
  const verifyBundleAnchor = method<CompletedTwoSidedSessionDeps["verifyBundleAnchor"]>(
    source,
    "verifyBundleAnchor",
    "completed two-sided session dependencies",
  )!;
  const verifyBundleBinding = method<
    NonNullable<CompletedTwoSidedSessionDeps["verifyBundleBinding"]>
  >(
    source,
    "verifyBundleBinding",
    "completed two-sided session dependencies",
    true,
  );
  const resolveBundleBinding = method<
    NonNullable<CompletedTwoSidedSessionDeps["resolveBundleBinding"]>
  >(
    source,
    "resolveBundleBinding",
    "completed two-sided session dependencies",
    true,
  );
  const sellerFinalizationProvider = dataProperty<SellerBundleFinalizationReadProvider>(
    source,
    "sellerFinalizationProvider",
    "completed two-sided session dependencies",
  );
  const provider = objectBoundary(
    sellerFinalizationProvider,
    "seller finalization provider",
  ) as SellerBundleFinalizationReadProvider;
  const sellerMapping = dataProperty<unknown>(
    provider,
    "mapping",
    "seller finalization provider",
  );
  if (sellerMapping !== "pure" && sellerMapping !== "write-input") {
    throw new DacsError("seller finalization provider.mapping is malformed");
  }
  const bundleCopyVerifier = captureCopyVerifier(dataProperty<BundleCopyDeps>(
    provider,
    "bundleCopyVerifier",
    "seller finalization provider",
  ));
  return Object.freeze({
    deadline,
    sellerFinalizationProvider: provider,
    sellerMapping,
    bundleCopyVerifier,
    readBundleCopy: async (
      nativeAddress: string,
      role: CompletedTwoSidedSessionRole,
    ) => {
      const bundle = await readBundleCopy(nativeAddress, role);
      return bundle === null
        ? null
        : snapshotCanonicalJsonRead(bundle, `${role} native bundle readback`);
    },
    verifyBundleAnchor: async (
      copy: Readonly<CompletedTwoSidedBundleCopy>,
    ) => verifyBundleAnchor(clone(copy)),
    ...(resolveBundleBinding
      ? { resolveBundleBinding: async (
          logicalAddress: string,
          signer: string,
          role: CompletedTwoSidedSessionRole,
          carried?: Readonly<BundleBinding>,
        ) => snapshotCanonicalJsonRead(
          await resolveBundleBinding(logicalAddress, signer, role,
            carried === undefined ? undefined : clone(carried)),
          `${role} BundleBinding resolution`,
        ) }
      : {}),
    ...(verifyBundleBinding
      ? { verifyBundleBinding: async (binding: Readonly<BundleBinding>) =>
          verifyBundleBinding(clone(binding)) }
      : {}),
  });
}

function exact(left: unknown, right: unknown): boolean {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
}

function roleParty(
  bundle: Readonly<FaultAttestationBundle>,
  role: CompletedTwoSidedSessionRole,
): string {
  const matches = bundle.parties.filter((party) => party.role === role);
  if (matches.length !== 1 || !isCanonicalClaimReference(matches[0]!.primaryClaim)) {
    throw new DacsError(`completed ${role} bundle does not identify one canonical ${role}`);
  }
  return matches[0]!.primaryClaim;
}

function requireExactReceipt(
  copy: Readonly<CompletedTwoSidedBundleCopy>,
  bundleHash: string,
): AnchorReceipt {
  const receipt = copy.anchorReceipt;
  const writer = roleParty(copy.bundle, copy.role);
  if (!isAnchorReceipt(receipt) || receipt.state !== "finalized" ||
      receipt.observationDisposition !== "established" ||
      receipt.logicalAddress !== bundleAddress(copy.bundle.jobId, copy.role) ||
      receipt.nativeAddress !== copy.nativeAddress ||
      receipt.contentHash !== bundleHash ||
      !sameCanonicalClaimIdentity(receipt.writer, writer)) {
    throw new DacsError(
      `${copy.role} bundle receipt is not the exact established finalized receipt`,
    );
  }
  return clone(receipt);
}

// A read the host could not answer stays retryable: anything it throws other
// than a DacsError that is not a substrate fault (an answer) becomes
// IndeterminateSubstrateError. A plain SubstrateError is a substrate that did
// not answer (DemosAdapter's "observation unavailable"), not an answer about
// the session, as in the seller closure's own read classification.
async function unanswered<T>(read: () => Promise<T> | T, label: string): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof IndeterminateSubstrateError) throw error;
    if (error instanceof DacsError && !(error instanceof SubstrateError)) throw error;
    throw new IndeterminateSubstrateError(`${label} errored`, { cause: error });
  }
}

// `indeterminate` and `error` mean the verifier could not decide; only
// `invalid` is an answer against the copy.
function requireValid(
  disposition: Readonly<{ disposition: string; reason?: string }>,
  label: string,
): void {
  if (disposition.disposition === "indeterminate" || disposition.disposition === "error") {
    throw new IndeterminateSubstrateError(
      `${label} is ${disposition.disposition}: ${disposition.reason ?? ""}`,
    );
  }
  if (disposition.disposition !== "valid") {
    throw new DacsError(`${label} is ${disposition.disposition}`);
  }
}

async function requireBinding(
  copy: Readonly<CompletedTwoSidedBundleCopy>,
  bundleHash: string,
  deps: CapturedAuditCompletionDeps,
): Promise<void> {
  const binding = copy.binding;
  const party = roleParty(copy.bundle, copy.role);
  if (!binding || !isBundleBinding(binding) || binding.jobId !== copy.bundle.jobId ||
      binding.role !== copy.role ||
      binding.logicalAddress !== bundleAddress(copy.bundle.jobId, copy.role) ||
      binding.nativeAddress !== copy.nativeAddress ||
      binding.bundleContentHash !== bundleHash ||
      !sameCanonicalClaimIdentity(binding.signer, party) ||
      !sameCanonicalClaimIdentity(binding.signature.signer, binding.signer) ||
      binding.signature.algorithm !== "ed25519" ||
      !isCanonicalBase64Url(binding.signature.value)) {
    throw new DacsError(`completed ${copy.role} bundle lacks its exact BB-1 binding`);
  }
  const signature = Uint8Array.from(Buffer.from(binding.signature.value, "base64url"));
  const key = await deps.bundleCopyVerifier.resolvePublicKey(binding.signer);
  if (!key || key.byteLength !== 32 || signature.byteLength !== 64 ||
      !(await deps.bundleCopyVerifier.verify(
        signedBytes(
          BUNDLE_BINDING_SEPARATOR,
          contentHash(binding as unknown as Record<string, unknown>),
        ),
        signature,
        new Uint8Array(key),
      ))) {
    throw new DacsError(`completed ${copy.role} BundleBinding signature is invalid`);
  }
  if (!deps.verifyBundleBinding) {
    throw new DacsError("write-input audit requires a BundleBinding verifier");
  }
  if (!deps.resolveBundleBinding) {
    throw new DacsError("write-input audit requires a BundleBinding resolver");
  }
  const resolveBundleBinding = deps.resolveBundleBinding;
  let lookup: unknown;
  try {
    lookup = await unanswered(() => resolveBundleBinding(
      binding.logicalAddress,
      binding.signer,
      copy.role,
      clone(binding),
    ), `${copy.role} BundleBinding resolution`);
  } catch (error) {
    if (!(error instanceof IndeterminateSubstrateError)) throw error;
    lookup = { disposition: "indeterminate", reason: "bundle-binding-unanswered" };
  }
  if (!isRecord(lookup) || !(
    (lookup.disposition === "present" && exactKeys(lookup, ["disposition", "binding"])) ||
    (lookup.disposition === "absent" && exactKeys(lookup, ["disposition"])) ||
    (lookup.disposition === "indeterminate" &&
      exactKeys(lookup, ["disposition", "reason"]) &&
      typeof lookup.reason === "string" && lookup.reason.length > 0)
  )) {
    throw new DacsError(`${copy.role} BundleBinding resolver returned a malformed result`);
  }
  // ST-11: external index visibility never gates completion, and BB-2 lets the
  // copy carry its signed binding, checked above under BB-4 and BB-5. A lookup
  // that does not show the binding, or does not answer, is no evidence either
  // way (BB-8). A different selected binding must independently verify the
  // same signed content at its own native publication.
  if (lookup.disposition === "present" && !exact(lookup.binding, binding)) {
    const selected = lookup.binding;
    if (!isBundleBinding(selected) || selected.jobId !== binding.jobId ||
        selected.role !== binding.role || selected.logicalAddress !== binding.logicalAddress ||
        selected.bundleContentHash !== binding.bundleContentHash ||
        !sameCanonicalClaimIdentity(selected.signer, binding.signer)) {
      throw new DacsError(`completed ${copy.role} BundleBinding is not independently resolvable and exact`);
    }
    // BB-6 may select an equal copy at another native address. Authenticate
    // that binding's native publication/finality and independently verify its
    // actual bytes; the carried copy retains all its own receipt checks.
    const selectedKey = await deps.bundleCopyVerifier.resolvePublicKey(selected.signer);
    const selectedSignature = Uint8Array.from(Buffer.from(selected.signature.value, "base64url"));
    if (!selectedKey || selectedKey.byteLength !== 32 || selectedSignature.byteLength !== 64 ||
        !(await deps.bundleCopyVerifier.verify(signedBytes(BUNDLE_BINDING_SEPARATOR,
          contentHash(selected as unknown as Record<string, unknown>)), selectedSignature, selectedKey))) {
      throw new DacsError(`completed ${copy.role} BundleBinding is not independently resolvable and exact: selected signature is invalid`);
    }
    requireValid(verificationDisposition(await unanswered(
      () => deps.verifyBundleBinding!(clone(selected)), `${copy.role} selected BundleBinding verifier`),
      `${copy.role} selected BundleBinding verifier`), `completed ${copy.role} selected BundleBinding verification`);
    const selectedCopy = await unanswered(() => deps.readBundleCopy(selected.nativeAddress, copy.role),
      `${copy.role} selected bundle native readback`);
    if (selectedCopy === null) throw new IndeterminateSubstrateError("selected bundle copy is not yet readable");
    const validity = await verifyBundleCopy(selectedCopy, copy.role, deps.bundleCopyVerifier);
    if (!validity.valid || !validity.fullySigned || validity.abortStanding ||
        !exact(bundleSignedScope(selectedCopy as unknown as FaultAttestationBundle), bundleSignedScope(copy.bundle))) {
      throw new DacsError(`completed ${copy.role} selected BundleBinding does not name the same verified signed scope`);
    }
  }
  const verifyBundleBinding = deps.verifyBundleBinding;
  requireValid(verificationDisposition(
    await unanswered(() => verifyBundleBinding(clone(binding)), `${copy.role} BundleBinding verifier`),
    `${copy.role} BundleBinding verifier`,
  ), `completed ${copy.role} BundleBinding verification`);
  // BB-6, BB-7: the carried binding verifies on its own, but the candidate set
  // it belongs to did not resolve to one copy (for example an equally signed
  // second copy): the side's read disposition stays indeterminate. Any reason
  // other than non-observation is such a set. Checked after the verifier, so
  // its answer against the carried binding comes first.
  if (lookup.disposition === "indeterminate" &&
      isUnresolvedBundleBindingCandidateSet(lookup.reason)) {
    throw new IndeterminateSubstrateError(
      `${copy.role} BundleBinding candidate set is unresolved: ${String(lookup.reason)}`,
    );
  }
}

async function verifyCopy(
  copy: Readonly<CompletedTwoSidedBundleCopy>,
  expected: Readonly<{
    role: CompletedTwoSidedSessionRole;
    jobId: string;
    buyer: string;
    seller: string;
  }>,
  deps: CapturedAuditCompletionDeps,
): Promise<{
  bundle: Record<string, unknown>;
  mapping: "pure" | "write-input";
}> {
  if (copy.role !== expected.role || !isFaultAttestationBundle(copy.bundle) ||
      copy.bundle.faultBundleVersion !== "1" || copy.bundle.bundleVersion !== undefined ||
      copy.bundle.outcome !== "completed" || copy.bundle.faultedParty !== "none" ||
      copy.bundle.anchoredByRole !== copy.role || copy.bundle.jobId !== expected.jobId ||
      typeof copy.nativeAddress !== "string" || copy.nativeAddress.length === 0) {
    throw new DacsError(`completed ${expected.role} bundle has the wrong type or session binding`);
  }
  if (copy.bundle.parties.length !== 2 ||
      copy.bundle.parties.some((party) => party.role === "orchestrator")) {
    throw new DacsError(
      `completed ${expected.role} bundle contradicts the seller-as-orchestrator topology`,
    );
  }
  const buyer = roleParty(copy.bundle, "buyer");
  const seller = roleParty(copy.bundle, "seller");
  if (!sameCanonicalClaimIdentity(buyer, expected.buyer) ||
      !sameCanonicalClaimIdentity(seller, expected.seller)) {
    throw new DacsError(`completed ${expected.role} bundle changed an order party`);
  }
  const copyObject = clone(copy.bundle) as unknown as Record<string, unknown>;
  const local = await verifyBundleCopy(copyObject, copy.role, deps.bundleCopyVerifier);
  if (!local.valid || !local.fullySigned || local.abortStanding) {
    throw new DacsError(
      local.valid
        ? `completed ${copy.role} bundle is not fully signed`
        : `completed ${copy.role} bundle signature verification failed: ${local.reason}`,
    );
  }

  const readback = await unanswered(
    () => deps.readBundleCopy(copy.nativeAddress, copy.role),
    `${copy.role} native bundle readback`,
  );
  // Nothing readable yet is unanswered (a Demos node may lag finality);
  // different content is an answer against the copy.
  if (readback === null) {
    throw new IndeterminateSubstrateError(
      `completed ${copy.role} bundle is not yet readable at its native address`,
    );
  }
  if (!exact(readback, copy.bundle)) {
    throw new DacsError(
      `completed ${copy.role} bundle is not independently readable at its exact native address`,
    );
  }

  const bundleHash = attestationBundleHash(copy.bundle);
  const receipt = requireExactReceipt(copy, bundleHash);
  const anchorDisposition = anchorVerificationDisposition(
    await unanswered(() => deps.verifyBundleAnchor(clone(copy)), `${copy.role} bundle anchor verifier`),
    `${copy.role} bundle anchor verifier`,
  );
  requireValid(anchorDisposition, `completed ${copy.role} bundle anchor verification`);
  if (anchorDisposition.disposition !== "valid") {
    throw new DacsError(`completed ${copy.role} bundle anchor verification is not valid`);
  }
  const mapping = anchorDisposition.mapping;
  if (receipt.substrate === "demos" && mapping !== "write-input") {
    throw new DacsError("Demos bundle anchors must use the write-input mapping");
  }
  if (copy.role === "seller" && mapping !== deps.sellerMapping) {
    throw new DacsError(
      "seller bundle anchor mapping contradicts its authenticated finalization provider",
    );
  }
  if (mapping === "write-input") {
    await requireBinding(copy, bundleHash, deps);
  } else if (copy.binding !== undefined) {
    throw new DacsError(`pure ${copy.role} bundle mapping must not carry a BundleBinding`);
  }
  return { bundle: copyObject, mapping };
}

/**
 * Rail-neutral DACS-5 completed-session gate.
 *
 * This function accepts no signer and performs no publication. It
 * re-authenticates the seller's exact ST-11 closure, independently reads and
 * verifies both role-owned bundle copies, enforces finalized receipt/mapping
 * and BB-1 binding rules, and requires a unified fully signed pair. Only this
 * stronger boundary returns `audit-complete`.
 *
 * A read nobody answered is `IndeterminateSubstrateError`, so retry it: a
 * host read that throws anything but a `DacsError`, a host read that throws a
 * `SubstrateError`, an `indeterminate` or `error` verifier disposition, a
 * bundle copy not yet readable at its native address, and a seller bundle whose
 * signed binding has not been discovered yet. A BundleBinding lookup may select
 * an equal signed copy at another authenticated native publication (BB-6); unresolved
 * candidate sets remain indeterminate. The copy also carries its own binding
 * (ST-11, BB-2). Any
 * other `DacsError` is an answer against the session and needs an operator.
 */
export async function verifyCompletedTwoSidedSession(
  input: Readonly<CompletedTwoSidedSessionInput>,
  deps: CompletedTwoSidedSessionDeps,
): Promise<CompletedTwoSidedSessionResult> {
  const retained = captureCompletedInput(input);
  const capturedDeps = captureDeps(deps);
  const authenticate = method<AuthenticateSessionProfile>(
    objectBoundary(deps, "completed two-sided session dependencies"),
    "authenticateSessionProfile", "completed two-sided session dependencies",
  )!;
  // One deadline, from here to the result, bounds every read below.
  const deadline = armDeadline(capturedDeps.deadline);
  try {
    const admission = await within(unanswered(() => authenticate(),
      "trusted session profile admission"), deadline, "trusted session profile admission");
    requireAuthenticatedSessionProfile(admission, retained);
    return await verifyCompletedTwoSidedSessionWithin(retained, capturedDeps, deadline);
  } finally {
    deadline.disarm();
  }
}

// Native DEM admission and the shared gate use the same already-armed deadline.
async function verifyCompletedTwoSidedSessionWithin(
  retained: Readonly<CompletedTwoSidedSessionInput>,
  capturedDeps: CapturedAuditCompletionDeps,
  deadline: ArmedDeadline,
): Promise<CompletedTwoSidedSessionResult> {
  const verifiedClosure = await within(verifyFinalizedSellerBundleReadOnly(
    clone(retained.sellerClosure.verificationInput),
    clone(retained.sellerClosure.result),
    capturedDeps.sellerFinalizationProvider,
  ), deadline, "completed seller closure re-verification");
  if (verifiedClosure.state !== "finalised" ||
      verifiedClosure.nativeAddress !== retained.copies.seller.nativeAddress ||
      !exact(verifiedClosure.anchorReceipt, retained.copies.seller.anchorReceipt) ||
      !exact(verifiedClosure.sellerBundle, retained.copies.seller.bundle) ||
      !exact(verifiedClosure.buyerBundle, retained.copies.buyer.bundle) ||
      ((verifiedClosure.binding !== undefined ||
        retained.copies.seller.binding !== undefined) &&
        !exact(verifiedClosure.binding, retained.copies.seller.binding)) ||
      verifiedClosure.bundleContentHash !==
        attestationBundleHash(retained.copies.seller.bundle)) {
    throw new DacsError(
      "completed bundle copies do not match the authenticated durable session closure",
    );
  }

  // Both copies settle before either rejection is reported: an unavailable
  // read of one copy must not hide an answer about the other that arrives
  // later. Any other rejection is reported before an unavailable read, then
  // the buyer copy's before the seller's. A read that never settles is cut
  // off at the deadline: a rejection already observed is reported as above,
  // and without one the result is indeterminate.
  const [buyerResult, sellerResult] = await settleWithin([
    verifyCopy(retained.copies.buyer, {
      role: "buyer",
      jobId: retained.jobId,
      buyer: retained.buyer,
      seller: retained.seller,
    }, capturedDeps),
    verifyCopy(retained.copies.seller, {
      role: "seller",
      jobId: retained.jobId,
      buyer: retained.buyer,
      seller: retained.seller,
    }, capturedDeps),
  ], deadline);
  if (buyerResult?.status === "rejected" || sellerResult?.status === "rejected") {
    const reasons = [buyerResult, sellerResult]
      .flatMap((result): unknown[] => result?.status === "rejected" ? [result.reason] : []);
    throw reasons.find((reason) => !(reason instanceof IndeterminateSubstrateError)) ?? reasons[0];
  }
  if (buyerResult === undefined || sellerResult === undefined) {
    throw new IndeterminateSubstrateError(
      `completed ${buyerResult === undefined ? "buyer" : "seller"} bundle copy verification ` +
        `did not settle within ${deadline.timeoutMs} ms`,
    );
  }
  const buyerCopy = buyerResult.value;
  const sellerCopy = sellerResult.value;
  if (!exact(
    bundleSignedScope(retained.copies.buyer.bundle),
    bundleSignedScope(retained.copies.seller.bundle),
  )) {
    throw new DacsError("completed buyer and seller bundles carry different signed scopes");
  }
  const consistency = await within(bundleConsistency({
    buyer: { disposition: "present", bundle: buyerCopy.bundle },
    seller: { disposition: "present", bundle: sellerCopy.bundle },
  }, {
    isValid: async (bundle, role) => {
      const verdict = await verifyBundleCopy(bundle, role, capturedDeps.bundleCopyVerifier);
      return verdict.valid && verdict.fullySigned && !verdict.abortStanding;
    },
  }), deadline, "completed bundle pair consistency check");
  if (consistency !== "unified") {
    throw new DacsError(`completed bundle pair is ${consistency}, not unified`);
  }
  return clone({
    state: "audit-complete" as const,
    jobId: retained.jobId,
    buyer: {
      logicalAddress: bundleAddress(retained.jobId, "buyer"),
      nativeAddress: retained.copies.buyer.nativeAddress,
      bundleContentHash: attestationBundleHash(retained.copies.buyer.bundle),
    },
    seller: {
      logicalAddress: bundleAddress(retained.jobId, "seller"),
      nativeAddress: retained.copies.seller.nativeAddress,
      bundleContentHash: attestationBundleHash(retained.copies.seller.bundle),
    },
  });
}

/**
 * DACS-5 §10.3.1 ST-11 completion gate. It was first checked against
 * Standard `next` 81ded2b49851d8fa17399e3fdade9e36e33a4ff7; the profile pins
 * `FIXED_PRICE_X402_STANDARD_REVISION`. ST-11 steps 1-3, including the signed
 * Listing, agreement and four-way dispatch the pinned revision adds, are the
 * seller closure's (`verifyFinalizedSellerBundleReadOnly`). Both completion
 * gates independently require BB-5 current-profile admission from trusted
 * context before using the requested buyer and seller identities.
 *
 * The synchronous combiner is intentionally operational and can never return
 * `audit-complete`. This function first re-authenticates the exact durable
 * seller session with the SDK's strict finalization verifier, including its
 * complete transitive dependency closure. It then independently reads and
 * authenticates each role-owned bundle receipt/mapping/binding and requires
 * both copies to carry the byte-identical signed production scope.
 */
export async function verifyFixedPriceX402AuditCompletion(
  input: Readonly<FixedPriceX402AuditCompletionInput>,
  deps: FixedPriceX402AuditCompletionDeps,
): Promise<FixedPriceX402CombinedOrderStatus> {
  const retained = captureInput(input);
  const operational = combineFixedPriceX402OrderStatus({
    buyer: retained.buyer,
    seller: retained.seller,
  });
  if (retained.buyer.tracks.audit?.state !== "final" ||
      retained.buyer.tracks.audit.outcome !== "success" ||
      retained.seller.tracks.audit?.state !== "final" ||
      retained.seller.tracks.audit.outcome !== "success" ||
      retained.buyer.tracks.audit.reference !== retained.copies.buyer.nativeAddress ||
      retained.seller.tracks.audit.reference !== retained.copies.seller.nativeAddress) {
    throw new DacsError(
      "audit completion requires both operational audit tracks to reference their exact bundle",
    );
  }

  await verifyCompletedTwoSidedSession({
    jobId: retained.buyer.jobId,
    buyer: retained.buyer.buyer,
    seller: retained.buyer.seller,
    sellerClosure: retained.sellerClosure,
    copies: retained.copies,
  }, deps);
  return clone({ ...operational, milestone: "audit-complete" as const });
}

/**
 * Native DEM projection of the strict DACS-5 completed-session gate.
 *
 * The local buyer and seller coordinators remain authority-separated. Their
 * operational success is necessary but insufficient: both role publications
 * and the exact seller ST-11 closure are independently re-authenticated before
 * this function returns `audit-complete`.
 */
export async function verifyFixedPricePayDemAuditCompletion(
  input: Readonly<FixedPricePayDemAuditCompletionInput>,
  deps: FixedPricePayDemAuditCompletionDeps,
): Promise<FixedPricePayDemCombinedOrderStatus> {
  const retained = capturePayDemInput(input);
  const operational = combineFixedPricePayDemOrderStatus({
    buyer: retained.buyer,
    seller: retained.seller,
  });
  if (retained.buyer.tracks.audit?.state !== "final" ||
      retained.buyer.tracks.audit.outcome !== "success" ||
      retained.seller.tracks.audit?.state !== "final" ||
      retained.seller.tracks.audit.outcome !== "success" ||
      retained.buyer.tracks.audit.reference !== retained.copies.buyer.nativeAddress ||
      retained.seller.tracks.audit.reference !== retained.copies.seller.nativeAddress) {
    throw new DacsError(
      "audit completion requires both operational audit tracks to reference their exact bundle",
    );
  }

  const source = objectBoundary(deps, "native DEM completion dependencies");
  const authenticate = method<FixedPricePayDemAuditCompletionDeps["authenticateSessionProfile"]>(
    source, "authenticateSessionProfile", "native DEM completion dependencies",
  )!;
  const completedInput = captureCompletedInput({
    jobId: retained.buyer.jobId,
    buyer: retained.buyer.buyer,
    seller: retained.buyer.seller,
    sellerClosure: retained.sellerClosure,
    copies: retained.copies,
  });
  const capturedDeps = captureDeps(deps);
  const deadline = armDeadline(capturedDeps.deadline);
  try {
    const admission = snapshotCanonicalJsonRead(await within(
      unanswered(() => authenticate(), "trusted session profile admission"),
      deadline,
      "trusted session profile admission",
    ), "trusted session profile admission");
    // The shared admission check (pin, profile status, tuple, exact roles),
    // then both orders' own revision.
    requireAuthenticatedSessionProfile(admission, {
      jobId: retained.buyer.jobId, buyer: retained.buyer.buyer, seller: retained.buyer.seller,
    });
    if (!isRecord(admission) ||
        admission.releasePin !== retained.buyer.protocol.standardRevision ||
        admission.releasePin !== retained.seller.protocol.standardRevision) {
      throw new DacsError("native DEM completion lacks authenticated session profile and role authority");
    }

    await verifyCompletedTwoSidedSessionWithin(completedInput, capturedDeps, deadline);
  } finally {
    deadline.disarm();
  }
  return clone({ ...operational, milestone: "audit-complete" as const });
}
