import { types as nodeTypes } from "node:util";

import {
  contentHash,
  sha256Hex,
  stripSignature,
} from "../canonical/index.js";
import {
  snapshotCanonicalJson,
  snapshotCanonicalJsonRead,
} from "../canonical/snapshot.js";
import { signedBytes } from "../crypto/index.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import {
  isComponentSignature,
  signComponentArtifact,
} from "../artifacts/signatures.js";
import {
  CounterpartyError,
  DacsError,
  SubstrateError,
  UnsupportedCapabilityError,
} from "../errors.js";
import {
  sessionRecordShapeViolation,
  type CheckpointClaimResult,
  type SessionLoad,
  type SessionRecord,
  type SessionReceipt,
  type SessionStore,
  type TransitionResult,
} from "./sessionStore.js";
import type {
  AnyAttestationBundle,
  CompositeVerificationRecord,
  ListingPin,
  Price,
  SettlementFinality,
  SettlementFinalityModel,
} from "../artifacts/types.js";
import { attestationBundleHash } from "./twoSidedBundle.js";
import {
  type LegacyMvpAgreementDocument as AgreementDocument,
  type LegacyMvpAttestationBundle as AttestationBundle,
  type LegacyMvpAttestationRef as AttestationRef,
  type LegacyMvpPhaseSummaryEntry as PhaseSummaryEntry,
  type LegacyMvpSettlementEvidence as SettlementEvidence,
  isLegacyMvpAttestationBundle as isAttestationBundle,
  isLegacyMvpAgreementDocument as isAgreementDocument,
  isLegacyMvpSettlementEvidence as isSettlementEvidence,
} from "../artifacts/legacyMvp.js";
import {
  isCompositeVerificationRecord,
  readListingArtifact,
} from "../artifacts/validators.js";

/**
 * Pure orchestration for the legacy MVP buyer session (T4 runSession): negotiate
 * (fixed-price) → settle → verify, producing + anchoring the AgreementDocument,
 * legacy SettlementEvidence and one-sided AttestationBundle records. These
 * pre-#308 shapes are isolated in `artifacts/legacyMvp`; issue #81 owns migration
 * of this producer to normative DACS-4/DACS-5 records. Identify is implicit (the
 * buyer's id) and vet is a seam. Settlement execution is injected (`settle`) so
 * the rail integration is pluggable and this is testable.
 *
 * Idempotent / crash-safe (T9): every phase anchors at a deterministic address
 * keyed by jobId, so the anchored artifacts ARE the session state. On resume
 * (same jobId) each phase checks-before-acting — a present agreement/evidence/
 * bundle is reused, never re-signed or re-anchored, and crucially settlement is
 * skipped if evidence already exists (no double-pay). A crash between paying and
 * anchoring evidence is the rail's idempotency window — `settle` is handed the
 * jobId so the rail can dedupe there.
 */

export interface SessionTerms {
  price: Price;
  deliveryPhase: string;
  deliveryFormat: string;
}

export interface SettleRequest {
  rail: string;
  /** Exact payment PhaseStep kind whose invocation is being settled. */
  phase: string;
  amount: string;
  asset: string;
  /** The seller claim bound by the Listing/Agreement. */
  payee: string;
  /**
   * Runtime rail destination selected by the buyer. This is separate from
   * `payee`: an EVM/x402 destination and a seller DID are different namespaces.
   * On the legacy path it is retained in a buyer-signed extension, not negotiated
   * with seller authority. A rail MUST pay this destination and return this exact
   * identifier as `SettleResult.payee`.
   */
  expectedPayee: string;
  jobId: string;
  /**
   * The settlement phase index — part of the `(railId, jobId, phaseIndex)`
   * idempotency key a rail dedupes on (#43). Defaults to 0 (the single MVP
   * settle phase) when the caller omits it.
   */
  phaseIndex?: number;
  /**
   * Ordered durable transaction attempts supplied only to `resumeSettlement`.
   * A fresh process uses this history to reconcile every ambiguous attempt and
   * prove a replacement submission supersedes the latest one. Ordinary fresh
   * settlement requests omit it.
   */
  priorAttempts?: readonly SettlementRecoveryAttempt[];
}

export interface SettlementRecoveryAttempt {
  txHash: string;
  chainId: string;
  ok: boolean;
}

export interface SettleResult {
  ok: boolean;
  txHash: string;
  chainId: string;
  payer: string;
  payee: string;
  /**
   * Rail-specific finality (§9.5.x / PC-6). When a rail knows the finality model
   * it settled under, it reports it here and runSessionCore records it on the
   * evidence instead of the default provider-receipt. E.g. §9.5.9 pay-dem →
   * `{ model: "bft-final" }`. Omit for a receipt-confirmed rail.
   */
  finality?: { model: SettlementFinalityModel; finalityBlocks?: number };
  /** Block/ledger height the settlement landed at, when the rail reports it (§9.5.9 `demos`). */
  blockNumber?: number;
  /** The txRef kind the rail's tx is (e.g. §9.5.9 `demos`); defaults to `payment`. */
  txRefKind?: string;
}

/**
 * Result of resolving whether a session artifact is already anchored, for resume
 * (#70). `indeterminate` (the lookup failed) is DISTINCT from `absent` — the
 * session must never treat a substrate failure as "never anchored", which would
 * reopen duplicate-settlement risk.
 */
export type AnchorLookup =
  | { status: "present"; ref: string; value: Record<string, unknown> }
  | { status: "absent" }
  | { status: "indeterminate"; reason: string };

export interface SessionDeps {
  /** The buyer agent's id / primary claim. */
  buyerId: string;
  /** Read the (signed) listing at a ref. */
  readListing: (ref: string) => Promise<unknown>;
  /**
   * Sign the reduced-MVP AgreementDocument compatibility artifact. The exact
   * DACS-3 producer is exposed by the transport-independent fixed-price core;
   * wiring it into this legacy public orchestration path remains in #98.
   */
  sign: (artifact: object, separator: string) => Promise<object>;
  /** Sign raw bytes for ComponentSignature artifacts and the bundle. */
  signBytes: (bytes: Uint8Array) => Promise<Uint8Array>;
  /**
   * Explicit compatibility policy for pre-ComponentSignature anchored session
   * artifacts. The secure default rejects legacy string signatures. The opt-in
   * exists only to resume deployments that have authenticated old anchors by an
   * external mechanism; the SDK cannot recover signer role metadata from them.
   */
  legacyComponentSignatures?: "reject" | "accept-unverified";
  /** Anchor a value under a name; returns the storage address. */
  anchor: (name: string, value: object) => Promise<string>;
  /**
   * Resolve whether the artifact for `name` is already anchored, for RESUME.
   * Returns the stored value + its ref when present; `absent` when not yet
   * anchored; `indeterminate` when the lookup itself failed. Resolution MUST be
   * by NAME, not by a re-derived address: the physical address folds in the
   * writer's create-time nonce and can't be recomputed (#70). On `indeterminate`
   * the session refuses to proceed rather than treat a substrate hiccup as
   * "absent" and risk a duplicate anchor or a double settlement.
   */
  resolveAnchor: (name: string) => Promise<AnchorLookup>;
  /**
   * Execute payment on the chosen rail.
   *
   * CRASH-WINDOW NOTE (#67/#52): this seam starts a freshly claimed payment. A
   * SessionStore intent cannot prove what happened if the process dies AFTER
   * `settle` moved value but BEFORE its outcome checkpoint. When `sessionStore` is
   * wired, callers must therefore also wire `resumeSettlement` to the durable
   * rail-idempotency/reconciliation path. The SessionStore and rail store are
   * complementary: one guards the orchestration claim, the other resolves the
   * post-payment crash window.
   */
  settle: (req: SettleRequest) => Promise<SettleResult>;
  /**
   * Runtime rail destination selected by the buyer and retained in the
   * buyer-signed legacy Agreement extension. Omit only when the seller claim
   * itself resolves to the rail destination (for example a native Demos claim);
   * otherwise this must be supplied explicitly. This is not PB-1
   * seller-authenticated payout negotiation.
   */
  expectedSettlementPayee?: string;
  /**
   * Restart-safe recovery for a previously claimed settlement whose SessionStore
   * still carries only `settle:intent`.
   *
   * This MUST use the original `(rail, jobId, phaseIndex)` idempotency binding,
   * return the prior definitive result when payment landed, resubmit only after a
   * rail query proves no payment landed, and throw while state is indeterminate.
   * `req.priorAttempts` carries the validated ordered transaction history from
   * the SessionStore; a fresh process must reconcile the entire chain before it
   * may return a replacement transaction.
   * It MUST also serialize recovery with a possibly-live original submitter; a
   * non-observation is not proof of absence while that worker can still submit.
   * The durable #52 `SettlementIdempotencyStore.once(..., reconcile)` wrapper is
   * the intended implementation when its documented single-writer/leased recovery
   * precondition is met. Callers may then wire the same wrapper as both `settle`
   * and `resumeSettlement`.
   *
   * `runSessionCore` deliberately does not call the ordinary `settle` seam under
   * an unresolved SessionStore intent because it cannot assume every implementation
   * is restart-safe.
   */
  resumeSettlement?: (req: SettleRequest) => Promise<SettleResult>;
  /**
   * Optional Vet step: verify the seller before paying. Returns a
   * CompositeVerificationRecord; unless the decision is `pass` the session
   * aborts before settlement. Omit to skip vetting.
   */
  vet?: (subject: string) => Promise<CompositeVerificationRecord>;
  /** Fresh job id (e.g. crypto.randomUUID). */
  newJobId: () => string;
  /** Current ISO-8601 timestamp (used where the spec field is a string). */
  now: () => string;
  /** Current unix-ms timestamp (used where the spec field is a number). */
  nowMs: () => number;
  /**
   * Verify the anchored listing before any external effect is taken from it
   * (#41). Receives the raw stored artifact (signature intact) and the seller
   * claim it advertises; must return true only if the signature verifies AND
   * binds to that seller.
   *
   * This is enforced INDEPENDENTLY of discovery: a session may be handed a ref
   * that never passed through `discover`, and the listing drives vetting, rail
   * and recipient selection, and payment. Verification therefore happens before
   * the vet step and before settlement — a forged listing must never reach the
   * money path. This seam authenticates the exact artifact; runSessionCore owns
   * validity-window admission so authenticated recovery can complete a deal
   * already paid before `notAfter`. REQUIRED unless `trustListing` is set.
   */
  verifyListing?: (
    raw: Record<string, unknown>,
    sellerClaim: string,
  ) => Promise<boolean> | boolean;
  /**
   * Authenticate the exact buyer-owned legacy Agreement recovered while
   * resuming a session. This must verify the signature bytes, not merely the
   * presence of a signature field or the owner of the anchor.
   */
  authenticateRecoveredAgreement?: (
    raw: Record<string, unknown>,
    buyerClaim: string,
  ) => Promise<boolean> | boolean;
  /**
   * Authenticate the exact buyer ComponentSignature on recovered
   * SettlementEvidence. This must verify both signer authorization and the
   * signature bytes over the complete SIG-5 signed scope.
   */
  authenticateRecoveredSettlementEvidence?: (
    raw: Record<string, unknown>,
    buyerClaim: string,
  ) => Promise<boolean> | boolean;
  /**
   * Cryptographically authenticate any recovered buyer artifact before reuse.
   * The separator identifies the exact signed-scope recipe. This generic seam
   * is required for recovered Vet records and bundles; the two narrower seams
   * above remain compatibility fallbacks for Agreement/Evidence only.
   */
  authenticateRecoveredArtifact?: (
    raw: Record<string, unknown>,
    separator: string,
    buyerClaim: string,
  ) => Promise<boolean> | boolean;
  /**
   * Explicit, grep-able opt-out of listing verification, for callers that
   * verified upstream. Ignored when `verifyListing` is supplied.
   */
  trustListing?: boolean;
  /**
   * OPTIONAL durable session store (#55). When wired, the store is the
   * settlement BOUNDARY PROTOCOL (#52/#67), not just an after-the-fact log:
   *   1. BEFORE paying, fail CLOSED on corrupt/unsupported durable state and
   *      REJECT a replayed agreement hash — so a second session over the same
   *      deal can never reach `settle`.
   *   2. Write-ahead a `settle:intent` checkpoint BEFORE the payment and a
   *      `settle:outcome` checkpoint (with the tx ref) AFTER — a crash in the
   *      gap is visible on restart and is reconciled through
   *      `resumeSettlement`, never blindly re-paid.
   *   3. The agreement/settlement/bundle receipts + final status are recorded
   *      for restart-safe status/receipt queries without an app-specific job DB.
   * Fully additive: with no store wired the session behaves exactly as before.
   */
  sessionStore?: SessionStore;
}

export interface SessionResult {
  outcome: "completed" | "failed";
  jobId: string;
  /** Exact DACS-1 §6.3.4 LR-1 Listing tuple used for this session. */
  listingPin: ListingPin;
  /** Set when a Vet step ran — the anchored CompositeVerificationRecord. */
  vetRef?: string;
  agreementRef: string;
  settlementRef: string;
  bundleRef: string;
}

/**
 * Deterministic anchor names for a session's artifacts, keyed by jobId. The
 * address derived from each name IS the session's storage slot for that phase —
 * shared between runSessionCore (write/resume) and verifyBundle (dereference).
 */
export const sessionAnchorName = {
  vet: (jobId: string) => `dacs2:verifyrecord:${jobId}`,
  agreement: (jobId: string) => `dacs3:agreement:${jobId}`,
  evidence: (jobId: string) => `dacs4:evidence:${jobId}`,
  bundle: (jobId: string) => `dacs5:bundle:${jobId}`,
};

/** Result of a resume-time semantic check on an already-anchored artifact. */
type Match = { ok: boolean; reason?: string };

interface DurableSettlementOutcome {
  outcomeSource: "rail-result";
  /** Versioned semantic binding carried by all newly written outcomes. */
  settlementBindingVersion: 1;
  rail: string;
  phase: string;
  agreementHash: string;
  amount: string;
  asset: string;
  payeeClaim: string;
  expectedPayee: string;
  phaseIndex: number;
  txHash: string;
  chainId: string;
  payer: string;
  payee: string;
  ok: boolean;
  finalityModel?: SettlementFinalityModel;
  finalityBlocks?: number;
  blockNumber?: number;
  txRefKind?: string;
  /** Authenticated recovery provenance when a safe resubmit used a new tx. */
  supersedesTxHash?: string;
  supersedesChainId?: string;
}

interface AuthenticatedEvidenceSettlementOutcome {
  outcomeSource: "authenticated-evidence";
  settlementBindingVersion: 1;
  rail: string;
  phase: string;
  agreementHash: string;
  amount: string;
  asset: string;
  payeeClaim: string;
  expectedPayee: string;
  phaseIndex: number;
  evidenceRef: string;
  evidenceContentHash: string;
  evidenceSigner: string;
  txHash: string;
  chainId: string;
  txRefKind: string;
  blockNumber?: number;
  ok: boolean;
}

const isSettlementFinalityModel = (
  value: unknown,
): value is SettlementFinalityModel =>
  value === "block-depth" ||
  value === "commitment-level" ||
  value === "provider-receipt" ||
  value === "htlc-reveal" ||
  value === "liquidity-tank" ||
  value === "bft-final";

function snapshotSettleResult(value: unknown, label: string): SettleResult {
  let snapshot: unknown;
  try {
    snapshot = snapshotCanonicalJson(value, label);
  } catch (cause) {
    throw new CounterpartyError(`${label} was not stable canonical JSON`, {
      cause,
    });
  }
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    throw new CounterpartyError(`${label} returned a malformed result`);
  }
  const result = snapshot as Record<string, unknown>;
  const allowed = new Set([
    "ok",
    "txHash",
    "chainId",
    "payer",
    "payee",
    "finality",
    "blockNumber",
    "txRefKind",
  ]);
  if (
    Object.keys(result).some((key) => !allowed.has(key)) ||
    typeof result.ok !== "boolean" ||
    typeof result.txHash !== "string" ||
    (result.ok && result.txHash.length === 0) ||
    result.txHash.trim() !== result.txHash ||
    typeof result.chainId !== "string" ||
    result.chainId.length === 0 ||
    result.chainId.trim() !== result.chainId ||
    typeof result.payer !== "string" ||
    result.payer.length === 0 ||
    result.payer.trim() !== result.payer ||
    typeof result.payee !== "string" ||
    result.payee.length === 0 ||
    result.payee.trim() !== result.payee ||
    (result.blockNumber !== undefined &&
      (!Number.isSafeInteger(result.blockNumber) ||
        (result.blockNumber as number) < 0)) ||
    (result.txRefKind !== undefined &&
      (typeof result.txRefKind !== "string" ||
        result.txRefKind.length === 0 ||
        result.txRefKind.trim() !== result.txRefKind))
  ) {
    throw new CounterpartyError(`${label} returned a malformed result`);
  }
  if (result.finality !== undefined) {
    if (
      !result.ok ||
      result.finality === null ||
      typeof result.finality !== "object" ||
      Array.isArray(result.finality)
    ) {
      throw new CounterpartyError(`${label} returned malformed finality`);
    }
    const finality = result.finality as Record<string, unknown>;
    if (
      !(
        hasExactKeys(finality, ["model"]) ||
        hasExactKeys(finality, ["model", "finalityBlocks"])
      ) ||
      !isSettlementFinalityModel(finality.model) ||
      (finality.finalityBlocks !== undefined &&
        (!Number.isSafeInteger(finality.finalityBlocks) ||
          (finality.finalityBlocks as number) < 0)) ||
      (finality.model === "block-depth" &&
        finality.finalityBlocks === undefined) ||
      (finality.model !== "block-depth" &&
        finality.finalityBlocks !== undefined)
    ) {
      throw new CounterpartyError(`${label} returned malformed finality`);
    }
  }
  return result as unknown as SettleResult;
}

function isListingPinValue(value: unknown): value is ListingPin {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const pin = value as Record<string, unknown>;
  const keys = Object.keys(pin);
  return (
    keys.length === 3 &&
    Object.prototype.hasOwnProperty.call(pin, "listingId") &&
    Object.prototype.hasOwnProperty.call(pin, "version") &&
    Object.prototype.hasOwnProperty.call(pin, "contentHash") &&
    typeof pin.listingId === "string" &&
    pin.listingId.length > 0 &&
    typeof pin.version === "number" &&
    Number.isSafeInteger(pin.version) &&
    pin.version >= 1 &&
    typeof pin.contentHash === "string" &&
    /^[0-9a-f]{64}$/.test(pin.contentHash)
  );
}

function sameListingPin(left: ListingPin, right: ListingPin): boolean {
  return (
    left.listingId === right.listingId &&
    left.version === right.version &&
    left.contentHash === right.contentHash
  );
}

function describeListingPin(pin: ListingPin): string {
  return `${pin.listingId}:v${pin.version}:${pin.contentHash}`;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

/** Read a dependency data property without invoking accessors or proxy traps. */
function stableDataProperty(
  source: object,
  key: PropertyKey,
  label: string,
): unknown {
  if (nodeTypes.isProxy(source)) {
    throw new DacsError(`${label} must be a stable data object`);
  }
  let owner: object | null = source;
  try {
    while (owner !== null) {
      if (nodeTypes.isProxy(owner)) throw new TypeError("proxy prototype");
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor) {
        if (!("value" in descriptor)) throw new TypeError("accessor property");
        return descriptor.value;
      }
      owner = Object.getPrototypeOf(owner);
    }
  } catch (cause) {
    throw new DacsError(`${label} must be stable data`, { cause });
  }
  return undefined;
}

function stableDataMethod<T>(
  source: object,
  key: PropertyKey,
  label: string,
  optional = false,
): T {
  const candidate = stableDataProperty(source, key, label);
  if (candidate === undefined && optional) return undefined as T;
  if (typeof candidate !== "function" || nodeTypes.isProxy(candidate)) {
    throw new DacsError(`${label} must be a stable data method`);
  }
  return Function.prototype.bind.call(candidate, source) as T;
}

function isSafeProtocolString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function protocolString(
  value: unknown,
  label: string,
  options: { allowColon?: boolean } = {},
): string {
  if (
    typeof value !== "string" ||
    !isSafeProtocolString(value) ||
    value.length === 0 ||
    value.trim() !== value ||
    value.normalize("NFC") !== value ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    (!options.allowColon && value.includes(":"))
  ) {
    throw new DacsError(`${label} must be a non-empty canonical protocol string`);
  }
  return value;
}

/** Capture a SessionStore's methods and own every JSON input/output. */
function captureSessionStore(value: unknown): SessionStore | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) {
    throw new DacsError("sessionStore must be a stable data object");
  }
  const source = value as SessionStore;
  const observedAgreementHashes = new Map<string, string | undefined>();
  const create = stableDataMethod<SessionStore["create"]>(
    source,
    "create",
    "sessionStore.create",
  );
  const load = stableDataMethod<SessionStore["load"]>(
    source,
    "load",
    "sessionStore.load",
  );
  const transition = stableDataMethod<SessionStore["transition"]>(
    source,
    "transition",
    "sessionStore.transition",
  );
  const claimCheckpoint = stableDataMethod<SessionStore["claimCheckpoint"]>(
    source,
    "claimCheckpoint",
    "sessionStore.claimCheckpoint",
  );
  const acquireLease = stableDataMethod<SessionStore["acquireLease"]>(
    source,
    "acquireLease",
    "sessionStore.acquireLease",
  );
  const bindHash = stableDataMethod<SessionStore["bindHash"]>(
    source,
    "bindHash",
    "sessionStore.bindHash",
  );
  const list = stableDataMethod<SessionStore["list"]>(
    source,
    "list",
    "sessionStore.list",
  );

  const record = (value: unknown, label: string): SessionRecord => {
    const snapshot = snapshotCanonicalJson(value, label);
    const violation = sessionRecordShapeViolation(snapshot);
    if (violation) throw new DacsError(`${label} is invalid: ${violation}`);
    return snapshot as SessionRecord;
  };
  const recordForJob = (
    value: unknown,
    jobId: string,
    label: string,
  ): SessionRecord => {
    const captured = record(value, label);
    if (captured.jobId !== jobId) {
      throw new DacsError(
        `${label} returned jobId ${captured.jobId} for requested job ${jobId}`,
      );
    }
    if (
      observedAgreementHashes.has(jobId) &&
      observedAgreementHashes.get(jobId) !== captured.agreementHash
    ) {
      throw new DacsError(
        `${label} changed the immutable agreementHash for session ${jobId}`,
      );
    }
    observedAgreementHashes.set(jobId, captured.agreementHash);
    return captured;
  };
  const samePrimitiveData = (
    left: Record<string, unknown> | undefined,
    right: Record<string, unknown> | undefined,
  ): boolean => {
    if (left === undefined || right === undefined) return left === right;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] && left[key] === right[key],
      )
    );
  };
  const hasCheckpoint = (
    value: SessionRecord,
    expected: { key: string; stage: string; data?: Record<string, unknown> },
  ): boolean =>
    value.checkpoints.some(
      (checkpoint) =>
        checkpoint.key === expected.key &&
        checkpoint.stage === expected.stage &&
        samePrimitiveData(checkpoint.data, expected.data),
    );
  const loadResult = (value: unknown, requestedJobId: string): SessionLoad => {
    const snapshot = snapshotCanonicalJson(value, "sessionStore.load result");
    if (
      snapshot === null ||
      typeof snapshot !== "object" ||
      Array.isArray(snapshot)
    ) {
      throw new DacsError("sessionStore.load returned a malformed envelope");
    }
    const result = snapshot as Record<string, unknown>;
    if (result.status === "missing" && hasExactKeys(result, ["status"])) {
      return { status: "missing" };
    }
    if (
      result.status === "corrupt" &&
      hasExactKeys(result, ["status", "reason"]) &&
      typeof result.reason === "string" &&
      result.reason.length > 0
    ) {
      return result as SessionLoad;
    }
    if (
      result.status === "unsupported" &&
      hasExactKeys(result, ["status", "version"]) &&
      Number.isSafeInteger(result.version) &&
      (result.version as number) >= 0
    ) {
      return result as SessionLoad;
    }
    if (
      result.status === "ok" &&
      hasExactKeys(result, ["status", "record"]) &&
      sessionRecordShapeViolation(result.record) === null
    ) {
      return {
        status: "ok",
        record: recordForJob(
          result.record,
          requestedJobId,
          "sessionStore.load result.record",
        ),
      };
    }
    throw new DacsError("sessionStore.load returned a malformed envelope");
  };
  const mutationResult = <T extends TransitionResult | CheckpointClaimResult>(
    value: unknown,
    label: string,
    failureReasons: ReadonlySet<string>,
    requestedJobId: string,
  ): T => {
    const snapshot = snapshotCanonicalJson(value, label);
    if (
      snapshot === null ||
      typeof snapshot !== "object" ||
      Array.isArray(snapshot)
    ) {
      throw new DacsError(`${label} returned a malformed envelope`);
    }
    const result = snapshot as Record<string, unknown>;
    if (
      result.ok === true &&
      hasExactKeys(result, ["ok", "record"]) &&
      sessionRecordShapeViolation(result.record) === null
    ) {
      return {
        ok: true,
        record: recordForJob(result.record, requestedJobId, `${label}.record`),
      } as T;
    }
    if (
      result.ok === false &&
      (hasExactKeys(result, ["ok", "reason"]) ||
        hasExactKeys(result, ["ok", "reason", "record"])) &&
      typeof result.reason === "string" &&
      failureReasons.has(result.reason) &&
      (!Object.prototype.hasOwnProperty.call(result, "record") ||
        sessionRecordShapeViolation(result.record) === null)
    ) {
      if (Object.prototype.hasOwnProperty.call(result, "record")) {
        return {
          ok: false,
          reason: result.reason,
          record: recordForJob(
            result.record,
            requestedJobId,
            `${label}.record`,
          ),
        } as T;
      }
      return { ok: false, reason: result.reason } as T;
    }
    throw new DacsError(`${label} returned a malformed envelope`);
  };

  const transitionReasons = new Set([
    "not-found",
    "revision-mismatch",
    "immutable-receipt",
    "lease-held",
    "corrupt",
    "unsupported",
  ]);
  const claimReasons = new Set([
    "not-found",
    "held",
    "completed",
    "lease-held",
    "corrupt",
    "unsupported",
  ]);

  return Object.freeze({
    create: async (input: Parameters<SessionStore["create"]>[0]) => {
      const owned = snapshotCanonicalJson(input, "sessionStore.create input");
      const created = recordForJob(
        await create(owned),
        owned.jobId,
        "sessionStore.create result",
      );
      const expectedPhase = owned.phase ?? "created";
      if (
        created.revision !== 0 ||
        created.phase !== expectedPhase ||
        created.agreementHash !== owned.agreementHash ||
        created.checkpoints.length !== 0 ||
        created.receipts.length !== 0 ||
        (owned.now !== undefined &&
          (created.createdAt !== owned.now || created.updatedAt !== owned.now))
      ) {
        throw new DacsError(
          "sessionStore.create result does not match the requested session",
        );
      }
      return created;
    },
    load: async (jobId: string) => {
      const ownedJobId = protocolString(jobId, "sessionStore load jobId");
      return loadResult(await load(ownedJobId), ownedJobId);
    },
    transition: async (input: Parameters<SessionStore["transition"]>[0]) => {
      const owned = snapshotCanonicalJson(
        input,
        "sessionStore.transition input",
      );
      const result = mutationResult<TransitionResult>(
        await transition(owned),
        "sessionStore.transition result",
        transitionReasons,
        owned.jobId,
      );
      if (result.ok) {
        const rec = result.record;
        if (
          rec.revision !== owned.expectedRevision + 1 ||
          (owned.phase !== undefined && rec.phase !== owned.phase) ||
          (owned.checkpoint !== undefined &&
            !hasCheckpoint(rec, owned.checkpoint)) ||
          (owned.receipt !== undefined &&
            !rec.receipts.some(
              (receipt) =>
                receipt.kind === owned.receipt!.kind &&
                receipt.ref === owned.receipt!.ref,
            )) ||
          (owned.lease === null && rec.lease !== undefined) ||
          (owned.lease !== undefined &&
            owned.lease !== null &&
            (rec.lease?.owner !== owned.lease.owner ||
              rec.lease.expiresAt !== owned.lease.expiresAt))
        ) {
          throw new DacsError(
            "sessionStore.transition result does not apply the requested transition",
          );
        }
      } else if (
        result.reason === "not-found" &&
        result.record !== undefined
      ) {
        throw new DacsError(
          "sessionStore.transition returned not-found with a record",
        );
      } else if (result.reason === "revision-mismatch") {
        if (
          !result.record ||
          result.record.revision === owned.expectedRevision
        ) {
          throw new DacsError(
            "sessionStore.transition returned a false revision mismatch",
          );
        }
      } else if (result.reason === "immutable-receipt") {
        const prior = owned.receipt
          ? result.record?.receipts.find(
              (receipt) => receipt.kind === owned.receipt!.kind,
            )
          : undefined;
        if (!prior || prior.ref === owned.receipt!.ref) {
          throw new DacsError(
            "sessionStore.transition returned a false immutable-receipt failure",
          );
        }
      } else if (result.reason === "lease-held") {
        const lease = result.record?.lease;
        if (
          !lease ||
          lease.owner === owned.owner ||
          (owned.now !== undefined && lease.expiresAt <= owned.now)
        ) {
          throw new DacsError(
            "sessionStore.transition returned a false lease-held failure",
          );
        }
      } else if (
        (result.reason === "corrupt" || result.reason === "unsupported") &&
        result.record !== undefined
      ) {
        throw new DacsError(
          `sessionStore.transition returned ${result.reason} with trusted record data`,
        );
      }
      return result;
    },
    claimCheckpoint: async (
      input: Parameters<SessionStore["claimCheckpoint"]>[0],
    ) => {
      const owned = snapshotCanonicalJson(
        input,
        "sessionStore.claimCheckpoint input",
      );
      const result = mutationResult<CheckpointClaimResult>(
        await claimCheckpoint(owned),
        "sessionStore.claimCheckpoint result",
        claimReasons,
        owned.jobId,
      );
      const matching = result.record?.checkpoints.filter(
        (checkpoint) => checkpoint.key === owned.key,
      );
      if (
        result.ok &&
        (matching?.length !== 1 ||
          matching[0]?.stage !== "intent" ||
          !hasCheckpoint(result.record, {
            key: owned.key,
            stage: "intent",
            ...(owned.data ? { data: owned.data } : {}),
          }) ||
          (owned.phase !== undefined && result.record.phase !== owned.phase))
      ) {
        throw new DacsError(
          "sessionStore.claimCheckpoint success does not contain exactly the claimed unresolved intent",
        );
      }
      if (!result.ok && result.reason === "held" && matching) {
        if (
          matching.length !== 1 ||
          matching[0]?.stage !== "intent" ||
          !hasCheckpoint(result.record!, {
            key: owned.key,
            stage: "intent",
            ...(owned.data ? { data: owned.data } : {}),
          })
        ) {
          throw new DacsError(
            "sessionStore.claimCheckpoint returned held with contradictory checkpoint history",
          );
        }
      }
      if (!result.ok && result.reason === "completed" && matching) {
        const firstOutcome = matching.findIndex(
          (checkpoint) => checkpoint.stage === "outcome",
        );
        if (
          firstOutcome < 0 ||
          matching
            .slice(firstOutcome + 1)
            .some((checkpoint) => checkpoint.stage === "intent") ||
          matching.filter((checkpoint) => checkpoint.stage === "intent")
            .length > 1
        ) {
          throw new DacsError(
            "sessionStore.claimCheckpoint returned completed with contradictory checkpoint history",
          );
        }
      }
      if (
        !result.ok &&
        (result.reason === "held" || result.reason === "completed") &&
        (!matching ||
          (result.reason === "held"
            ? !hasCheckpoint(result.record!, {
                key: owned.key,
                stage: "intent",
                ...(owned.data ? { data: owned.data } : {}),
              })
            : !matching.some((checkpoint) => checkpoint.stage === "outcome")))
      ) {
        throw new DacsError(
          `sessionStore.claimCheckpoint returned ${result.reason} without matching durable state`,
        );
      }
      if (!result.ok) {
        if (result.reason === "not-found" && result.record !== undefined) {
          throw new DacsError(
            "sessionStore.claimCheckpoint returned not-found with a record",
          );
        }
        if (result.reason === "lease-held") {
          const lease = result.record?.lease;
          if (
            !lease ||
            lease.owner === owned.owner ||
            (owned.now !== undefined && lease.expiresAt <= owned.now)
          ) {
            throw new DacsError(
              "sessionStore.claimCheckpoint returned a false lease-held failure",
            );
          }
        }
        if (
          (result.reason === "corrupt" || result.reason === "unsupported") &&
          result.record !== undefined
        ) {
          throw new DacsError(
            `sessionStore.claimCheckpoint returned ${result.reason} with trusted record data`,
          );
        }
      }
      return result;
    },
    acquireLease: async (input: Parameters<SessionStore["acquireLease"]>[0]) => {
      const owned = snapshotCanonicalJson(
        input,
        "sessionStore.acquireLease input",
      );
      const snapshot = snapshotCanonicalJson(
        await acquireLease(owned),
        "sessionStore.acquireLease result",
      ) as unknown;
      if (
        snapshot === null ||
        typeof snapshot !== "object" ||
        Array.isArray(snapshot)
      ) {
        throw new DacsError("sessionStore.acquireLease returned malformed data");
      }
      const result = snapshot as Record<string, unknown>;
      if (
        typeof result.ok !== "boolean" ||
        !(
          hasExactKeys(result, ["ok"]) ||
          hasExactKeys(result, ["ok", "record"])
        ) ||
        (Object.prototype.hasOwnProperty.call(result, "record") &&
          sessionRecordShapeViolation(result.record) !== null)
      ) {
        throw new DacsError("sessionStore.acquireLease returned malformed data");
      }
      const rec = Object.prototype.hasOwnProperty.call(result, "record")
        ? recordForJob(
            result.record,
            owned.jobId,
            "sessionStore.acquireLease result.record",
          )
        : undefined;
      if (
        result.ok === true &&
        (!rec ||
          rec.lease?.owner !== owned.owner ||
          (owned.now !== undefined &&
            rec.lease.expiresAt !== owned.now + owned.ttlMs))
      ) {
        throw new DacsError(
          "sessionStore.acquireLease result does not contain the requested lease",
        );
      }
      if (
        result.ok === false &&
          rec &&
        (!rec.lease ||
          rec.lease.owner === owned.owner ||
          (owned.now !== undefined && rec.lease.expiresAt <= owned.now))
      ) {
        throw new DacsError(
          "sessionStore.acquireLease returned a false lease conflict",
        );
      }
      return {
        ok: result.ok,
        ...(rec ? { record: rec } : {}),
      } as Awaited<ReturnType<SessionStore["acquireLease"]>>;
    },
    bindHash: async (input: Parameters<SessionStore["bindHash"]>[0]) => {
      const ownedInput = snapshotCanonicalJson(
        input,
        "sessionStore.bindHash input",
      );
      const snapshot = snapshotCanonicalJson(
        await bindHash(ownedInput),
        "sessionStore.bindHash result",
      ) as unknown;
      if (
        snapshot === null ||
        typeof snapshot !== "object" ||
        Array.isArray(snapshot)
      ) {
        throw new DacsError("sessionStore.bindHash returned malformed data");
      }
      const result = snapshot as Record<string, unknown>;
      if (
        typeof result.ok !== "boolean" ||
        !(
          (result.ok &&
            (hasExactKeys(result, ["ok"]) ||
              (hasExactKeys(result, ["ok", "boundTo"]) &&
                result.boundTo === ownedInput.jobId))) ||
          (!result.ok &&
            hasExactKeys(result, ["ok", "boundTo"]) &&
            typeof result.boundTo === "string" &&
            result.boundTo.length > 0 &&
            result.boundTo !== ownedInput.jobId)
        )
      ) {
        throw new DacsError("sessionStore.bindHash returned malformed data");
      }
      return result as Awaited<ReturnType<SessionStore["bindHash"]>>;
    },
    list: async (filter?: Parameters<SessionStore["list"]>[0]) => {
      const ownedFilter =
        filter === undefined
          ? undefined
          : (snapshotCanonicalJson(
              filter,
              "sessionStore.list filter",
            ) as NonNullable<Parameters<SessionStore["list"]>[0]>);
      if (
        ownedFilter !== undefined &&
        (Object.keys(ownedFilter).some(
          (key) => key !== "phase" && key !== "limit",
        ) ||
          (ownedFilter.phase !== undefined &&
            protocolString(
              ownedFilter.phase,
              "sessionStore.list filter.phase",
              { allowColon: true },
            ) !== ownedFilter.phase) ||
          (ownedFilter.limit !== undefined &&
            (!Number.isSafeInteger(ownedFilter.limit) ||
              ownedFilter.limit < 0)))
      ) {
        throw new DacsError("sessionStore.list received a malformed filter");
      }
      const snapshot = snapshotCanonicalJson(
        await list(ownedFilter),
        "sessionStore.list result",
      );
      if (
        !Array.isArray(snapshot) ||
        snapshot.some((item) => sessionRecordShapeViolation(item) !== null) ||
        (ownedFilter?.limit !== undefined &&
          snapshot.length > ownedFilter.limit)
      ) {
        throw new DacsError("sessionStore.list returned malformed data");
      }
      const records = snapshot.map((item, index) => {
        const jobId = protocolString(
          (item as SessionRecord).jobId,
          `sessionStore.list result[${index}].jobId`,
          { allowColon: true },
        );
        const captured = recordForJob(
          item,
          jobId,
          `sessionStore.list result[${index}]`,
        );
        if (
          ownedFilter?.phase !== undefined &&
          captured.phase !== ownedFilter.phase
        ) {
          throw new DacsError(
            `sessionStore.list returned phase ${captured.phase} for filter ${ownedFilter.phase}`,
          );
        }
        return captured;
      });
      return records;
    },
  });
}

function captureSessionDeps(input: SessionDeps): Readonly<SessionDeps> {
  if (input === null || typeof input !== "object" || nodeTypes.isProxy(input)) {
    throw new DacsError("runSessionCore dependencies must be a stable data object");
  }
  const buyerId = protocolString(
    stableDataProperty(input, "buyerId", "deps.buyerId"),
    "deps.buyerId",
    { allowColon: true },
  );
  const legacyComponentSignatures = stableDataProperty(
    input,
    "legacyComponentSignatures",
    "deps.legacyComponentSignatures",
  );
  if (
    legacyComponentSignatures !== undefined &&
    legacyComponentSignatures !== "reject" &&
    legacyComponentSignatures !== "accept-unverified"
  ) {
    throw new DacsError("legacyComponentSignatures has an unsupported value");
  }
  const trustListing = stableDataProperty(
    input,
    "trustListing",
    "deps.trustListing",
  );
  if (trustListing !== undefined && typeof trustListing !== "boolean") {
    throw new DacsError("trustListing must be a boolean when provided");
  }
  const rawExpectedSettlementPayee = stableDataProperty(
    input,
    "expectedSettlementPayee",
    "deps.expectedSettlementPayee",
  );
  const expectedSettlementPayee =
    rawExpectedSettlementPayee === undefined
      ? undefined
      : protocolString(
          rawExpectedSettlementPayee,
          "deps.expectedSettlementPayee",
          { allowColon: true },
        );

  const newJobId = stableDataMethod<SessionDeps["newJobId"]>(
    input,
    "newJobId",
    "deps.newJobId",
  );
  const now = stableDataMethod<SessionDeps["now"]>(input, "now", "deps.now");
  const nowMs = stableDataMethod<SessionDeps["nowMs"]>(
    input,
    "nowMs",
    "deps.nowMs",
  );
  const sessionStore = captureSessionStore(
    stableDataProperty(input, "sessionStore", "deps.sessionStore"),
  );

  return Object.freeze({
    buyerId,
    readListing: stableDataMethod<SessionDeps["readListing"]>(
      input,
      "readListing",
      "deps.readListing",
    ),
    sign: stableDataMethod<SessionDeps["sign"]>(input, "sign", "deps.sign"),
    signBytes: stableDataMethod<SessionDeps["signBytes"]>(
      input,
      "signBytes",
      "deps.signBytes",
    ),
    legacyComponentSignatures: legacyComponentSignatures as
      | SessionDeps["legacyComponentSignatures"]
      | undefined,
    anchor: stableDataMethod<SessionDeps["anchor"]>(
      input,
      "anchor",
      "deps.anchor",
    ),
    resolveAnchor: stableDataMethod<SessionDeps["resolveAnchor"]>(
      input,
      "resolveAnchor",
      "deps.resolveAnchor",
    ),
    settle: stableDataMethod<SessionDeps["settle"]>(
      input,
      "settle",
      "deps.settle",
    ),
    expectedSettlementPayee,
    resumeSettlement: stableDataMethod<SessionDeps["resumeSettlement"]>(
      input,
      "resumeSettlement",
      "deps.resumeSettlement",
      true,
    ),
    vet: stableDataMethod<SessionDeps["vet"]>(
      input,
      "vet",
      "deps.vet",
      true,
    ),
    newJobId: () => protocolString(newJobId(), "new jobId"),
    now: () => {
      const value = protocolString(now(), "session ISO timestamp", {
        allowColon: true,
      });
      if (!Number.isFinite(Date.parse(value))) {
        throw new DacsError("session ISO timestamp must be parseable ISO-8601 data");
      }
      return value;
    },
    nowMs: () => {
      const value = nowMs();
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new DacsError("session clock must return a non-negative unix-ms safe integer");
      }
      return value;
    },
    verifyListing: stableDataMethod<SessionDeps["verifyListing"]>(
      input,
      "verifyListing",
      "deps.verifyListing",
      true,
    ),
    authenticateRecoveredAgreement: stableDataMethod<
      SessionDeps["authenticateRecoveredAgreement"]
    >(
      input,
      "authenticateRecoveredAgreement",
      "deps.authenticateRecoveredAgreement",
      true,
    ),
    authenticateRecoveredSettlementEvidence: stableDataMethod<
      SessionDeps["authenticateRecoveredSettlementEvidence"]
    >(
      input,
      "authenticateRecoveredSettlementEvidence",
      "deps.authenticateRecoveredSettlementEvidence",
      true,
    ),
    authenticateRecoveredArtifact: stableDataMethod<
      SessionDeps["authenticateRecoveredArtifact"]
    >(
      input,
      "authenticateRecoveredArtifact",
      "deps.authenticateRecoveredArtifact",
      true,
    ),
    trustListing: trustListing as boolean | undefined,
    sessionStore,
  });
}

function deepFreezeJson<T extends object>(value: T): Readonly<T> {
  const seen = new WeakSet<object>();
  const visit = (candidate: object): void => {
    if (seen.has(candidate)) return;
    seen.add(candidate);
    for (const nested of Object.values(candidate)) {
      if (nested !== null && typeof nested === "object") visit(nested);
    }
    Object.freeze(candidate);
  };
  visit(value);
  return value;
}

/** Capture and strictly validate a resolver result before retaining it. */
function snapshotAnchorLookup(value: unknown, label: string): AnchorLookup {
  let captured: unknown;
  try {
    captured = snapshotCanonicalJsonRead(value, label);
  } catch (cause) {
    throw new SubstrateError(`${label} returned an unstable or non-wire result`, {
      cause,
    });
  }
  if (
    captured === null ||
    typeof captured !== "object" ||
    Array.isArray(captured)
  ) {
    throw new SubstrateError(`${label} returned a malformed lookup envelope`);
  }
  const record = captured as Record<string, unknown>;
  if (record.status === "absent" && hasExactKeys(record, ["status"])) {
    return { status: "absent" };
  }
  if (
    record.status === "indeterminate" &&
    hasExactKeys(record, ["status", "reason"]) &&
    typeof record.reason === "string" &&
    record.reason.length > 0
  ) {
    return { status: "indeterminate", reason: record.reason };
  }
  if (
    record.status === "present" &&
    hasExactKeys(record, ["status", "ref", "value"]) &&
    typeof record.ref === "string" &&
    record.ref.length > 0 &&
    record.value !== null &&
    typeof record.value === "object" &&
    !Array.isArray(record.value)
  ) {
    return {
      status: "present",
      ref: record.ref,
      value: record.value as Record<string, unknown>,
    };
  }
  throw new SubstrateError(`${label} returned a malformed lookup envelope`);
}

interface SettlementBinding {
  settlementBindingVersion: 1;
  rail: string;
  phase: string;
  agreementHash: string;
  amount: string;
  asset: string;
  payeeClaim: string;
  expectedPayee: string;
  phaseIndex: number;
}

function settlementBinding(
  request: SettleRequest,
  agreementHash: string,
): SettlementBinding {
  return {
    settlementBindingVersion: 1,
    rail: request.rail,
    phase: request.phase,
    agreementHash,
    amount: request.amount,
    asset: request.asset,
    payeeClaim: request.payee,
    expectedPayee: request.expectedPayee,
    phaseIndex: request.phaseIndex ?? 0,
  };
}

function sameSettlementBinding(
  left: SettlementBinding,
  right: SettlementBinding,
): boolean {
  return (
    left.settlementBindingVersion === right.settlementBindingVersion &&
    left.rail === right.rail &&
    left.phase === right.phase &&
    left.agreementHash === right.agreementHash &&
    left.amount === right.amount &&
    left.asset === right.asset &&
    left.payeeClaim === right.payeeClaim &&
    left.expectedPayee === right.expectedPayee &&
    left.phaseIndex === right.phaseIndex
  );
}

function validateSettlementResultBinding(
  result: SettleResult,
  request: SettleRequest,
  label: string,
): void {
  if (result.payee !== request.expectedPayee) {
    throw new CounterpartyError(
      `${label} returned payee ${result.payee}, expected the request-bound destination ${request.expectedPayee}`,
    );
  }
}

function durableSettlementOutcome(
  result: SettleResult,
  binding: SettlementBinding,
  supersedes?: SettlementRecoveryAttempt,
): DurableSettlementOutcome {
  const ok = result.ok && result.txHash.trim().length > 0;
  return {
    outcomeSource: "rail-result",
    ...binding,
    txHash: result.txHash,
    chainId: result.chainId,
    payer: result.payer,
    payee: result.payee,
    ok,
    ...(result.finality ? { finalityModel: result.finality.model } : {}),
    ...(result.finality?.finalityBlocks !== undefined
      ? { finalityBlocks: result.finality.finalityBlocks }
      : {}),
    ...(result.blockNumber !== undefined ? { blockNumber: result.blockNumber } : {}),
    ...(result.txRefKind !== undefined ? { txRefKind: result.txRefKind } : {}),
    ...(supersedes &&
    (supersedes.txHash !== result.txHash ||
      supersedes.chainId !== result.chainId)
      ? {
          supersedesTxHash: supersedes.txHash,
          supersedesChainId: supersedes.chainId,
        }
      : {}),
  };
}

function sameSettlementOutcome(
  left: DurableSettlementOutcome,
  right: DurableSettlementOutcome,
): boolean {
  return (
    sameSettlementBinding(left, right) &&
    left.txHash === right.txHash &&
    left.chainId === right.chainId &&
    left.payer === right.payer &&
    left.payee === right.payee &&
    left.ok === right.ok &&
    left.finalityModel === right.finalityModel &&
    left.finalityBlocks === right.finalityBlocks &&
    left.blockNumber === right.blockNumber &&
    left.txRefKind === right.txRefKind &&
    left.supersedesTxHash === right.supersedesTxHash &&
    left.supersedesChainId === right.supersedesChainId
  );
}

function sameAuthenticatedEvidenceOutcome(
  left: AuthenticatedEvidenceSettlementOutcome,
  right: AuthenticatedEvidenceSettlementOutcome,
): boolean {
  return (
    sameSettlementBinding(left, right) &&
    left.evidenceRef === right.evidenceRef &&
    left.evidenceContentHash === right.evidenceContentHash &&
    left.evidenceSigner === right.evidenceSigner &&
    left.txHash === right.txHash &&
    left.chainId === right.chainId &&
    left.txRefKind === right.txRefKind &&
    left.blockNumber === right.blockNumber &&
    left.ok === right.ok
  );
}

interface LegacyDurableSettlementOutcome {
  txHash: string;
  chainId: string;
  ok: boolean;
}

type SettlementOutcomeRead =
  | { status: "absent" }
  | { status: "current-rail"; outcome: DurableSettlementOutcome }
  | {
      status: "current-evidence";
      outcome: AuthenticatedEvidenceSettlementOutcome;
    }
  | { status: "legacy-unbound"; outcome: LegacyDurableSettlementOutcome }
  | { status: "invalid"; reason: string };

/**
 * Read the newest settlement outcome without ever turning malformed or legacy
 * state into "absent". v1 stores predate the request/payee binding fields, so
 * those records are explicitly classified for rail-authenticated migration.
 */
function readNewestSettleOutcome(load: SessionLoad): SettlementOutcomeRead {
  if (load.status !== "ok") return { status: "absent" };
  const { checkpoints } = load.record;
  for (let i = checkpoints.length - 1; i >= 0; i--) {
    const cp = checkpoints[i];
    if (!cp || cp.key !== "settle:0" || cp.stage !== "outcome" || !cp.data) continue;
    const data = cp.data as Record<string, unknown>;
    const { txHash, chainId, ok } = data;
    if (
      typeof txHash !== "string" ||
      txHash.trim() !== txHash ||
      typeof chainId !== "string" ||
      chainId.length === 0 ||
      chainId.trim() !== chainId ||
      typeof ok !== "boolean" ||
      (ok && txHash.length === 0)
    ) {
      return {
        status: "invalid",
        reason: "settlement outcome has malformed txHash/chainId/ok fields",
      };
    }
    const bindingFields = [
      "settlementBindingVersion",
      "rail",
      "phase",
      "agreementHash",
      "amount",
      "asset",
      "payeeClaim",
      "expectedPayee",
      "phaseIndex",
    ] as const;
    const hasCompleteBinding = bindingFields.every((key) =>
      Object.prototype.hasOwnProperty.call(data, key),
    );
    if (!hasCompleteBinding || data.outcomeSource === undefined) {
      // Historical SESSION_STORE_VERSION=1 records carried only the rail
      // receipt. They are not discarded and never trigger a fresh submit: the
      // explicit resumeSettlement seam must authenticate and enrich them.
      const legacyAllowed = new Set([
        "txHash",
        "chainId",
        "ok",
        "finalityModel",
        "finalityBlocks",
        "blockNumber",
        "txRefKind",
      ]);
      const hasPartialCurrentDiscriminator =
        data.outcomeSource !== undefined ||
        bindingFields.some((key) =>
          Object.prototype.hasOwnProperty.call(data, key),
        );
      if (
        hasPartialCurrentDiscriminator ||
        Object.keys(data).some((key) => !legacyAllowed.has(key)) ||
        (data.finalityModel !== undefined &&
          !isSettlementFinalityModel(data.finalityModel)) ||
        (data.finalityBlocks !== undefined &&
          (!Number.isSafeInteger(data.finalityBlocks) ||
            (data.finalityBlocks as number) < 0)) ||
        (data.blockNumber !== undefined &&
          (!Number.isSafeInteger(data.blockNumber) ||
            (data.blockNumber as number) < 0)) ||
        (data.txRefKind !== undefined &&
          (typeof data.txRefKind !== "string" ||
            data.txRefKind.length === 0))
      ) {
        return {
          status: "invalid",
          reason: "legacy settlement outcome has partial or malformed fields",
        };
      }
      return {
        status: "legacy-unbound",
        outcome: { txHash, chainId, ok },
      };
    }
    const {
      settlementBindingVersion,
      rail,
      phase,
      agreementHash,
      amount,
      asset,
      payeeClaim,
      expectedPayee,
      phaseIndex,
    } = data;
    if (
      settlementBindingVersion !== 1 ||
      typeof rail !== "string" ||
      rail.length === 0 ||
      typeof phase !== "string" ||
      phase.length === 0 ||
      typeof agreementHash !== "string" ||
      agreementHash.length === 0 ||
      typeof amount !== "string" ||
      amount.length === 0 ||
      typeof asset !== "string" ||
      asset.length === 0 ||
      typeof payeeClaim !== "string" ||
      payeeClaim.length === 0 ||
      typeof expectedPayee !== "string" ||
      expectedPayee.length === 0 ||
      !Number.isSafeInteger(phaseIndex) ||
      (phaseIndex as number) < 0
    ) {
      return {
        status: "invalid",
        reason: "settlement outcome has malformed request-binding fields",
      };
    }
    const binding: SettlementBinding = {
      settlementBindingVersion: 1,
      rail,
      phase,
      agreementHash,
      amount,
      asset,
      payeeClaim,
      expectedPayee,
      phaseIndex: phaseIndex as number,
    };
    if (data.outcomeSource === "rail-result") {
      const {
        payer,
        payee,
        finalityModel,
        finalityBlocks,
        blockNumber,
        txRefKind,
        supersedesTxHash,
        supersedesChainId,
      } = data;
      const allowed = new Set([
        "outcomeSource",
        ...bindingFields,
        "txHash",
        "chainId",
        "payer",
        "payee",
        "ok",
        "finalityModel",
        "finalityBlocks",
        "blockNumber",
        "txRefKind",
        "supersedesTxHash",
        "supersedesChainId",
      ]);
      if (
        Object.keys(data).some((key) => !allowed.has(key)) ||
        typeof payer !== "string" ||
        payer.length === 0 ||
        payer.trim() !== payer ||
        typeof payee !== "string" ||
        payee.length === 0 ||
        payee.trim() !== payee ||
        (finalityModel !== undefined &&
          !isSettlementFinalityModel(finalityModel)) ||
        (finalityBlocks !== undefined &&
          (!Number.isSafeInteger(finalityBlocks) ||
            (finalityBlocks as number) < 0)) ||
        (finalityModel === "block-depth" &&
          finalityBlocks === undefined) ||
        (finalityModel !== undefined &&
          finalityModel !== "block-depth" &&
          finalityBlocks !== undefined) ||
        (finalityModel === undefined && finalityBlocks !== undefined) ||
        (blockNumber !== undefined &&
          (!Number.isSafeInteger(blockNumber) || (blockNumber as number) < 0)) ||
        (txRefKind !== undefined &&
          (typeof txRefKind !== "string" ||
            txRefKind.length === 0 ||
            txRefKind.trim() !== txRefKind)) ||
        ((supersedesTxHash === undefined) !==
          (supersedesChainId === undefined)) ||
        (supersedesTxHash !== undefined &&
          (typeof supersedesTxHash !== "string" ||
            supersedesTxHash.length === 0 ||
            supersedesTxHash.trim() !== supersedesTxHash ||
            typeof supersedesChainId !== "string" ||
            supersedesChainId.length === 0 ||
            supersedesChainId.trim() !== supersedesChainId))
      ) {
        return {
          status: "invalid",
          reason: "rail settlement outcome has malformed or extra fields",
        };
      }
      return {
        status: "current-rail",
        outcome: {
          outcomeSource: "rail-result",
          ...binding,
          txHash,
          chainId,
          payer,
          payee,
          ok,
          ...(isSettlementFinalityModel(finalityModel)
            ? { finalityModel }
            : {}),
          ...(typeof finalityBlocks === "number" ? { finalityBlocks } : {}),
          ...(typeof blockNumber === "number" ? { blockNumber } : {}),
          ...(typeof txRefKind === "string" ? { txRefKind } : {}),
          ...(typeof supersedesTxHash === "string" &&
          typeof supersedesChainId === "string"
            ? { supersedesTxHash, supersedesChainId }
            : {}),
        },
      };
    }
    if (data.outcomeSource === "authenticated-evidence") {
      const {
        evidenceRef,
        evidenceContentHash,
        evidenceSigner,
        txRefKind,
        blockNumber,
      } = data;
      const allowed = new Set([
        "outcomeSource",
        ...bindingFields,
        "evidenceRef",
        "evidenceContentHash",
        "evidenceSigner",
        "txHash",
        "chainId",
        "txRefKind",
        "blockNumber",
        "ok",
      ]);
      if (
        Object.keys(data).some((key) => !allowed.has(key)) ||
        typeof ok !== "boolean" ||
        typeof evidenceRef !== "string" ||
        evidenceRef.length === 0 ||
        evidenceRef.trim() !== evidenceRef ||
        typeof evidenceContentHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(evidenceContentHash) ||
        typeof evidenceSigner !== "string" ||
        evidenceSigner.length === 0 ||
        evidenceSigner.trim() !== evidenceSigner ||
        typeof txRefKind !== "string" ||
        txRefKind.length === 0 ||
        txRefKind.trim() !== txRefKind ||
        (blockNumber !== undefined &&
          (!Number.isSafeInteger(blockNumber) || (blockNumber as number) < 0))
      ) {
        return {
          status: "invalid",
          reason: "authenticated-evidence outcome has malformed or extra fields",
        };
      }
      return {
        status: "current-evidence",
        outcome: {
          outcomeSource: "authenticated-evidence",
          ...binding,
          evidenceRef,
          evidenceContentHash,
          evidenceSigner,
          txHash,
          chainId,
          txRefKind,
          ...(typeof blockNumber === "number" ? { blockNumber } : {}),
          ok,
        },
      };
    }
    return {
      status: "invalid",
      reason: "settlement outcome has an unknown outcome source",
    };
  }
  return { status: "absent" };
}

type ParsedSettlementOutcome = Exclude<
  SettlementOutcomeRead,
  { status: "absent" } | { status: "invalid" }
>;

function isValidSettlementOutcomeProgression(
  prior: ParsedSettlementOutcome,
  next: ParsedSettlementOutcome,
): boolean {
  if (prior.status === "legacy-unbound") {
    if (next.status === "legacy-unbound") {
      return (
        prior.outcome.txHash === next.outcome.txHash &&
        prior.outcome.chainId === next.outcome.chainId &&
        prior.outcome.ok === next.outcome.ok
      );
    }
    const sameKnownTransaction =
      prior.outcome.txHash.length === 0 ||
      (prior.outcome.txHash === next.outcome.txHash &&
        prior.outcome.chainId === next.outcome.chainId);
    const authenticatedSupersession =
      !prior.outcome.ok &&
      next.status === "current-rail" &&
      next.outcome.supersedesTxHash === prior.outcome.txHash &&
      next.outcome.supersedesChainId === prior.outcome.chainId;
    if (!sameKnownTransaction && !authenticatedSupersession) return false;
    if (next.status === "current-evidence") {
      return prior.outcome.ok
        ? next.outcome.ok && sameKnownTransaction
        : next.outcome.ok;
    }
    // Rail-authenticated migration may promote an old non-definitive failure to
    // success, but can never demote an already-successful durable receipt.
    return !prior.outcome.ok || next.outcome.ok;
  }

  if (prior.status === "current-rail") {
    if (next.status === "legacy-unbound") return false;
    if (next.status === "current-evidence") {
      return (
        sameSettlementBinding(prior.outcome, next.outcome) &&
        ((prior.outcome.txHash === next.outcome.txHash &&
          prior.outcome.chainId === next.outcome.chainId &&
          prior.outcome.ok === next.outcome.ok) ||
          (prior.outcome.ok === false &&
            prior.outcome.txHash.length > 0 &&
            next.outcome.ok === true))
      );
    }
    return (
      sameSettlementOutcome(prior.outcome, next.outcome) ||
      (sameSettlementBinding(prior.outcome, next.outcome) &&
        prior.outcome.ok === false &&
        prior.outcome.txHash.length > 0 &&
        ((prior.outcome.txHash === next.outcome.txHash &&
          prior.outcome.chainId === next.outcome.chainId) ||
          (next.outcome.supersedesTxHash === prior.outcome.txHash &&
            next.outcome.supersedesChainId === prior.outcome.chainId)))
    );
  }

  return (
    next.status === "current-evidence" &&
    sameAuthenticatedEvidenceOutcome(prior.outcome, next.outcome)
  );
}

/**
 * Validate the complete append-only settlement history, not only its newest
 * entry. A hostile or corrupt store must not be able to hide a conflicting
 * payment underneath a later well-formed checkpoint.
 */
function readSettleOutcome(load: SessionLoad): SettlementOutcomeRead {
  if (load.status !== "ok") return { status: "absent" };
  const outcomes = load.record.checkpoints.filter(
    (checkpoint) =>
      checkpoint.key === "settle:0" && checkpoint.stage === "outcome",
  );
  let prior: ParsedSettlementOutcome | undefined;
  for (const checkpoint of outcomes) {
    if (!checkpoint.data) {
      return {
        status: "invalid",
        reason: "settlement outcome checkpoint has no data",
      };
    }
    const parsed = readNewestSettleOutcome({
      status: "ok",
      record: { ...load.record, checkpoints: [checkpoint] },
    });
    if (parsed.status === "absent") {
      return {
        status: "invalid",
        reason: "settlement outcome checkpoint could not be read",
      };
    }
    if (parsed.status === "invalid") return parsed;
    if (prior && !isValidSettlementOutcomeProgression(prior, parsed)) {
      return {
        status: "invalid",
        reason: "settlement outcome history contains conflicting entries",
      };
    }
    prior = parsed;
  }
  return prior ?? { status: "absent" };
}

/** Ordered, validated rail attempts exposed to a fresh recovery process. */
function settlementRecoveryAttempts(
  load: SessionLoad,
): SettlementRecoveryAttempt[] {
  if (load.status !== "ok") return [];
  const attempts: SettlementRecoveryAttempt[] = [];
  for (const checkpoint of load.record.checkpoints) {
    if (
      checkpoint.key !== "settle:0" ||
      checkpoint.stage !== "outcome" ||
      !checkpoint.data
    ) {
      continue;
    }
    const parsed = readNewestSettleOutcome({
      status: "ok",
      record: { ...load.record, checkpoints: [checkpoint] },
    });
    if (
      (parsed.status === "current-rail" ||
        parsed.status === "legacy-unbound") &&
      parsed.outcome.txHash.length > 0
    ) {
      attempts.push({
        txHash: parsed.outcome.txHash,
        chainId: parsed.outcome.chainId,
        ok: parsed.outcome.ok,
      });
    }
  }
  return attempts;
}

function assertSessionAgreementBinding(
  load: SessionLoad,
  jobId: string,
  agreementHash: string,
  label: string,
): void {
  if (
    load.status === "ok" &&
    (load.record.jobId !== jobId || load.record.agreementHash !== agreementHash)
  ) {
    throw new CounterpartyError(
      `${label} returned durable state not bound to this job and Agreement`,
    );
  }
}

/**
 * Record a completed/failed session to the durable store (#55): create-or-load,
 * bind the agreement hash for cross-session anti-replay, and checkpoint each
 * receipt + the final phase via compare-and-set. Every store result is checked:
 * silently dropping a receipt would make a successful return disagree with the
 * public status surface callers use for restart recovery.
 */
async function recordSessionOutcome(
  store: SessionStore,
  jobId: string,
  input: { agreementHash: string; phase: string; now: number; receipts: SessionReceipt[] },
): Promise<void> {
  const loaded = await store.load(jobId);
  assertSessionAgreementBinding(
    loaded,
    jobId,
    input.agreementHash,
    "session outcome load",
  );
  if (loaded.status === "missing") {
    await store.create({ jobId, agreementHash: input.agreementHash, phase: input.phase, now: input.now });
  } else if (loaded.status !== "ok") {
    throw new CounterpartyError(
      `could not record session outcome for ${jobId}: durable state is ${loaded.status}`,
    );
  }
  const bound = await store.bindHash({
    hash: input.agreementHash,
    jobId,
    kind: "agreement",
  });
  if (!bound.ok) {
    throw new CounterpartyError(
      `agreement hash for ${jobId} is bound to ${bound.boundTo}; refusing to record inconsistent receipts`,
    );
  }
  for (const receipt of input.receipts) {
    let recorded = false;
    for (let attempt = 0; attempt < 4 && !recorded; attempt++) {
      const cur = await store.load(jobId);
      assertSessionAgreementBinding(
        cur,
        jobId,
        input.agreementHash,
        `session ${receipt.kind} receipt load`,
      );
      if (cur.status !== "ok") {
        throw new CounterpartyError(
          `could not record ${receipt.kind} receipt for ${jobId}: durable state is ${cur.status}`,
        );
      }
      const prior = cur.record.receipts.find((item) => item.kind === receipt.kind);
      if (prior) {
        if (prior.ref !== receipt.ref) {
          throw new CounterpartyError(
            `could not record ${receipt.kind} receipt for ${jobId}: immutable receipt conflicts with ${prior.ref}`,
          );
        }
        recorded = true;
        break;
      }
      const result = await store.transition({
        jobId,
        expectedRevision: cur.record.revision,
        receipt,
        phase: input.phase,
        now: input.now,
      });
      if (result.ok) {
        recorded = true;
      } else if (result.reason !== "revision-mismatch") {
        throw new CounterpartyError(
          `could not record ${receipt.kind} receipt for ${jobId}: ${result.reason}`,
        );
      }
    }
    if (!recorded) {
      throw new CounterpartyError(
        `could not record ${receipt.kind} receipt for ${jobId}: repeated concurrent updates`,
      );
    }
  }
}

export async function runSessionCore(
  listingRef: string,
  inputTerms: SessionTerms,
  inputDeps: SessionDeps,
  resumeJobId?: string,
): Promise<SessionResult> {
  // Capture every caller-controlled callback/scalar without invoking accessors.
  // A mutable dependency bag must not be able to switch an authenticator,
  // signer, rail, or durable store while another boundary is being inspected.
  const deps = captureSessionDeps(inputDeps);
  listingRef = protocolString(listingRef, "listingRef", { allowColon: true });
  if (resumeJobId !== undefined) {
    resumeJobId = protocolString(resumeJobId, "resume jobId");
  }
  const terms = snapshotCanonicalJson(inputTerms, "session terms");
  protocolString(terms.price.rail, "session price rail", { allowColon: true });
  protocolString(terms.price.asset, "session price asset", { allowColon: true });
  protocolString(terms.deliveryPhase, "session delivery phase");
  protocolString(terms.deliveryFormat, "session delivery format", {
    allowColon: true,
  });

  const stored = await deps.readListing(listingRef);
  if (stored == null || typeof stored !== "object" || Array.isArray(stored)) {
    throw new Error(`listing not found or invalid at ${listingRef}`);
  }
  let storedRecord: Record<string, unknown>;
  try {
    storedRecord = snapshotCanonicalJson(
      stored as Record<string, unknown>,
      `listing at ${listingRef}`,
    );
  } catch (cause) {
    throw new Error(`listing not found or invalid at ${listingRef}`, { cause });
  }
  const readableListing = readListingArtifact(storedRecord);
  if (!readableListing) {
    throw new Error(`listing not found or invalid at ${listingRef}`);
  }
  const listing =
    readableListing.compatibility === "normative"
      ? {
          sellerClaim: readableListing.listing.seller.identity.presentedBy,
          supportedPaymentRails:
            readableListing.listing.acceptedRails?.map((rail) => rail.railId) ?? [],
          supportedDelivery: readableListing.listing.pipeline
            .map((phase) => phase.kind)
            .filter((kind) => kind.startsWith("deliver-")),
          pin: {
            listingId: readableListing.listing.listingId,
            version: readableListing.listing.listingVersion,
            contentHash: contentHash(storedRecord),
          },
        }
      : {
          sellerClaim: readableListing.listing.agentId,
          supportedPaymentRails:
            readableListing.listing.supportedPaymentRails,
          supportedDelivery: readableListing.listing.supportedDelivery,
          pin: {
            listingId: readableListing.listing.serviceId,
            version: readableListing.listing.listingVersion ?? 1,
            contentHash: contentHash(storedRecord),
          },
        };

  let listingExpired = false;
  if (readableListing.compatibility === "normative") {
    if (
      readableListing.listing.signature.signer !==
      readableListing.listing.seller.identity.presentedBy
    ) {
      throw new CounterpartyError(
        `listing at ${listingRef} is not payee-bound: the Listing signer must equal ` +
          `seller.identity.presentedBy until the complete DACS-1 §6.3.2 ` +
          `presentation is verified`,
      );
    }
    const now = deps.nowMs();
    const validity = readableListing.listing.validity;
    if (now < validity.notBefore) {
      throw new CounterpartyError(
        `listing ${listing.pin.listingId} v${listing.pin.version} is outside its DACS-1 §6.3.4 validity window`,
      );
    }
    listingExpired = validity.notAfter !== undefined && now > validity.notAfter;
  }

  const listingView: {
    sellerClaim: string;
    supportedPaymentRails: string[];
    supportedDelivery: string[];
    pin: ListingPin;
  } = listing;
  // Never normalize signed protocol identifiers in place: NFC aliases must be
  // rejected so an upgrade cannot redirect an existing session/name binding.
  protocolString(listingView.sellerClaim, "Listing seller claim", {
    allowColon: true,
  });
  protocolString(listingView.pin.listingId, "Listing id", { allowColon: true });
  const expectedSettlementPayee = protocolString(
    deps.expectedSettlementPayee ?? listingView.sellerClaim,
    "expected settlement payee",
    { allowColon: true },
  );

  // #41 — authenticate the listing before any external effect. Fresh admission
  // preserves the existing early gate. An expired recovery deliberately waits
  // until the exact signed Agreement and successful SettlementEvidence prove
  // that this is completion of an already-paid deal; only that path may use an
  // authentication-only Listing reader that ignores the current wall clock.
  if (!deps.verifyListing && !deps.trustListing) {
    throw new DacsError(
      "runSessionCore requires deps.verifyListing or an explicit deps.trustListing: true opt-out — " +
        "acting on an unverified listing lets a forged listing drive payment (#41)",
    );
  }
  if (listingExpired && !deps.verifyListing) {
    throw new DacsError(
      "runSessionCore requires deps.verifyListing to authenticate the exact Listing " +
        "after proving an expired-session recovery",
    );
  }
  if (
    listingExpired &&
    (!(
      deps.authenticateRecoveredArtifact ||
      deps.authenticateRecoveredAgreement
    ) ||
      !(
        deps.authenticateRecoveredArtifact ||
        deps.authenticateRecoveredSettlementEvidence
      ))
  ) {
    throw new DacsError(
      "runSessionCore requires cryptographic Agreement and SettlementEvidence " +
        "authentication before an expired-session recovery",
    );
  }

  const authenticateListing = async (): Promise<void> => {
    if (!deps.verifyListing) return;
    let verified = false;
    try {
      verified =
        (await deps.verifyListing(
          structuredClone(storedRecord),
          listingView.sellerClaim,
        )) === true;
    } catch {
      verified = false; // a throwing verifier is not a pass
    }
    if (!verified) {
      throw new CounterpartyError(
        `listing at ${listingRef} failed signature verification for seller ${listingView.sellerClaim} (#41)`,
      );
    }
  };
  if (!listingExpired) {
    await authenticateListing();
  }

  if (!listingView.supportedPaymentRails.includes(terms.price.rail)) {
    throw new Error(`rail ${terms.price.rail} not offered by the listing`);
  }
  const paymentEvidencePhase =
    readableListing.compatibility === "normative"
      ? (() => {
          const paymentPhases = readableListing.listing.pipeline.filter(
            (phase) => phase.kind.startsWith("pay-"),
          );
          if (paymentPhases.length > 1) {
            throw new UnsupportedCapabilityError(
              `runSessionCore cannot execute ${paymentPhases.length} pay-* invocations ` +
                `across the normative pipeline: DACS-4 PIPE-5 repetition is valid, ` +
                `but this single-settle orchestrator supports one invocation`,
            );
          }
          const matching = paymentPhases.filter(
            (phase) => phase.parameters?.rail === terms.price.rail,
          );
          if (matching.length === 0) {
            throw new CounterpartyError(
              `rail ${terms.price.rail} has no matching normative payment phase`,
            );
          }
          return matching[0]!.kind;
        })()
      : terms.price.rail;
  if (!listingView.supportedDelivery.includes(terms.deliveryPhase)) {
    throw new Error(`delivery ${terms.deliveryPhase} not offered by the listing`);
  }

  if (listingExpired && resumeJobId === undefined) {
    throw new CounterpartyError(
      `listing ${listing.pin.listingId} v${listing.pin.version} is outside its DACS-1 §6.3.4 validity window`,
    );
  }

  // A caller-supplied jobId requests recovery; otherwise this is a fresh
  // admission. Invalid Listings and unsupported pipelines fail before minting
  // a new id; an expired recovery uses the caller's exact prior id below.
  const jobId = resumeJobId ?? deps.newJobId();

  const signEd25519 = async (bytes: Uint8Array): Promise<Uint8Array> => {
    const callbackBytes = Uint8Array.from(bytes);
    const result = await deps.signBytes(callbackBytes);
    if (
      !(result instanceof Uint8Array) ||
      result.byteLength !== 64 ||
      callbackBytes.byteLength !== bytes.byteLength ||
      callbackBytes.some((byte, index) => byte !== bytes[index])
    ) {
      throw new CounterpartyError(
        "buyer ed25519 signer must return exactly 64 bytes without mutating its input",
      );
    }
    return Uint8Array.from(result);
  };

  const signSessionArtifact = <T extends object>(
    artifact: T,
    separator: Parameters<typeof signComponentArtifact>[1],
  ) =>
    signComponentArtifact(artifact, separator, {
      algorithm: "ed25519",
      signer: deps.buyerId,
      sign: signEd25519,
    });

  const authenticateExistingArtifact = async (
    raw: Record<string, unknown>,
    separator: string,
  ): Promise<boolean> => {
    const generic = deps.authenticateRecoveredArtifact;
    const compatibility =
      separator === ARTIFACT_SEPARATORS.AgreementDocument
        ? deps.authenticateRecoveredAgreement
        : separator === ARTIFACT_SEPARATORS.SettlementEvidence
          ? deps.authenticateRecoveredSettlementEvidence
          : undefined;
    const authenticate = generic
      ? (artifact: Record<string, unknown>) =>
          generic(artifact, separator, deps.buyerId)
      : compatibility
        ? (artifact: Record<string, unknown>) =>
            compatibility(artifact, deps.buyerId)
        : undefined;
    if (!authenticate) return false;
    try {
      return (
        (await authenticate(
          snapshotCanonicalJson(raw, "recovered session artifact"),
        )) === true
      );
    } catch {
      return false;
    }
  };

  const storedComponentSignatureMatches = (
    value: Record<string, unknown>,
    expectedSigner: string,
  ): Match => {
    if (Object.prototype.hasOwnProperty.call(value, "signatures")) {
      return { ok: false, reason: "ambiguous singular/plural signature fields" };
    }
    if (isComponentSignature(value.signature)) {
      return value.signature.signer === expectedSigner
        ? { ok: true }
        : {
            ok: false,
            reason: `component signer ${value.signature.signer} ≠ ${expectedSigner}`,
          };
    }
    if (
      typeof value.signature === "string" &&
      deps.legacyComponentSignatures === "accept-unverified"
    ) {
      return { ok: true };
    }
    return {
      ok: false,
      reason:
        typeof value.signature === "string"
          ? "legacy string signature rejected by component-signature policy"
          : "missing or malformed ComponentSignature",
    };
  };

  /**
   * Anchor `build()` under `name` only if a matching artifact isn't already there.
   * `match` is a resume-safety predicate: it must confirm an already-anchored
   * artifact is not just structurally valid but semantically the SAME deal as the
   * current request (jobId, parties, price, delivery, …). If an artifact is
   * present but does NOT match, this ABORTS rather than reusing or overwriting it
   * — a stale/wrong resumeJobId must never silently complete with another deal's
   * agreement/evidence (and overwriting evidence could double-pay). Returns the
   * ref + the artifact now at that ref so callers can content-hash it.
   */
  const anchorOnce = async (
    name: string,
    match: (v: Record<string, unknown>) => Match,
    build: () => Promise<object>,
    expectedComponentSigner?: string,
    knownLookup?: AnchorLookup,
    recoveredSeparator?: string,
  ): Promise<{ ref: string; value: Record<string, unknown>; existing: boolean }> => {
    // Resolve BY NAME (the address can't be recomputed). Fail closed on an
    // indeterminate lookup: proceeding as if absent could re-anchor a duplicate
    // or, for evidence, defeat the no-double-pay guard and settle twice (#70).
    let lookup: AnchorLookup;
    try {
      lookup = knownLookup ?? (await deps.resolveAnchor(name));
    } catch (cause) {
      throw new SubstrateError(
        `resume: lookup for "${name}" failed; refusing to proceed rather than ` +
          `risk a duplicate anchor or double settlement`,
        { cause },
      );
    }
    const found = snapshotAnchorLookup(lookup, `anchor lookup for "${name}"`);
    if (found.status === "indeterminate") {
      throw new SubstrateError(
        `resume: could not determine whether "${name}" is already anchored (${found.reason}); ` +
          `refusing to proceed rather than risk a duplicate anchor or double settlement`,
      );
    }
    if (found.status === "present") {
      const existing = snapshotCanonicalJson(
        found.value,
        `recovered artifact at ${found.ref}`,
      );
      if (expectedComponentSigner) {
        const signatureMatch = storedComponentSignatureMatches(
          existing,
          expectedComponentSigner,
        );
        if (!signatureMatch.ok) {
          throw new CounterpartyError(
            `resume: artifact anchored at ${found.ref} has unacceptable signature: ${signatureMatch.reason}`,
          );
        }
      }
      // A supplied knownLookup comes only from the authenticated recovery
      // preflight above; avoid asking an external verifier to authenticate the
      // same bytes twice. Direct resolver lookups authenticate here.
      if (
        knownLookup === undefined &&
        (!recoveredSeparator ||
          !(await authenticateExistingArtifact(existing, recoveredSeparator)))
      ) {
        throw new CounterpartyError(
          `resume: artifact anchored at ${found.ref} failed cryptographic authentication`,
        );
      }
      const m = match(stripSignature(existing));
      if (!m.ok) {
        throw new CounterpartyError(
          `resume: artifact anchored at ${found.ref} does not match the requested deal: ${m.reason}`,
        );
      }
      return { ref: found.ref, value: existing, existing: true };
    }
    const produced = await build();
    let built: Record<string, unknown>;
    try {
      const candidate = snapshotCanonicalJson(
        produced,
        `new artifact for "${name}"`,
      ) as unknown;
      if (
        candidate === null ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      ) {
        throw new TypeError("artifact root is not an object");
      }
      built = candidate as Record<string, unknown>;
    } catch (cause) {
      throw new CounterpartyError(
        `new artifact for "${name}" was not stable canonical JSON`,
        { cause },
      );
    }
    if (expectedComponentSigner) {
      const signatureMatch = storedComponentSignatureMatches(
        built,
        expectedComponentSigner,
      );
      if (!signatureMatch.ok) {
        throw new CounterpartyError(
          `new artifact for "${name}" has unacceptable signature: ${signatureMatch.reason}`,
        );
      }
    }
    const builtMatch = match(stripSignature(built));
    if (!builtMatch.ok) {
      throw new CounterpartyError(
        `new artifact for "${name}" does not match the requested deal: ${builtMatch.reason}`,
      );
    }

    // The callback receives an isolated immutable publication. Keep `built` as
    // the authoritative owned snapshot used for every later hash/ref so even a
    // hostile adapter that retains or mutates its argument cannot change the
    // authenticated view this session returns.
    const publication = deepFreezeJson(
      snapshotCanonicalJson(built, `publication for "${name}"`),
    );
    const rawRef = await deps.anchor(name, publication);
    const ref = protocolString(rawRef, `anchor result for "${name}"`, {
      allowColon: true,
    });
    return { ref, value: built, existing: false };
  };

  const pricesEqual = (a: Price, b: Price): boolean =>
    a.amount === b.amount &&
    a.asset === b.asset &&
    a.decimals === b.decimals &&
    a.rail === b.rail;

  const matchAgreement = (v: Record<string, unknown>): Match => {
    if (!isAgreementDocument(v))
      return { ok: false, reason: "not an agreement" };
    const a = v as unknown as AgreementDocument;
    if (a.pattern !== "negotiate-fixed-price")
      return { ok: false, reason: `pattern ${a.pattern} is not fixed-price` };
    if (a.jobId !== jobId)
      return { ok: false, reason: `jobId ${a.jobId} ≠ ${jobId}` };
    if (a.buyer !== deps.buyerId)
      return { ok: false, reason: `buyer ${a.buyer} ≠ ${deps.buyerId}` };
    if (a.seller !== listingView.sellerClaim)
      return { ok: false, reason: `seller ${a.seller} ≠ ${listingView.sellerClaim}` };
    if (a.listingRef !== listingRef)
      return { ok: false, reason: `listingRef ${a.listingRef} ≠ ${listingRef}` };
    const pinnedSettlementPayee = v.dacsSdkExpectedSettlementPayee;
    if (pinnedSettlementPayee !== undefined) {
      if (pinnedSettlementPayee !== expectedSettlementPayee) {
        return {
          ok: false,
          reason:
            `signed settlement destination ${String(pinnedSettlementPayee)} ≠ ` +
            expectedSettlementPayee,
        };
      }
    } else if (expectedSettlementPayee !== listingView.sellerClaim) {
      return {
        ok: false,
        reason:
          "legacy Agreement does not bind the cross-namespace settlement destination",
      };
    }
    const hasPinnedListing = Object.prototype.hasOwnProperty.call(
      v,
      "dacsSdkListingPin",
    );
    // A pin written by a normative session remains load-bearing even if the
    // same native address is later replaced by a legacy-shaped Listing. The
    // reciprocal legacy→normative replacement is rejected because current
    // normative recovery requires the pin to be present.
    if (hasPinnedListing || readableListing.compatibility === "normative") {
      const pinned = v.dacsSdkListingPin;
      if (!isListingPinValue(pinned)) {
        return { ok: false, reason: "Agreement has no exact signed Listing pin" };
      }
      if (!sameListingPin(pinned, listingView.pin)) {
        return {
          ok: false,
          reason:
            `signed Listing pin ${describeListingPin(pinned)} ≠ ` +
            describeListingPin(listingView.pin),
        };
      }
    }
    if (!pricesEqual(a.price, terms.price))
      return { ok: false, reason: "price mismatch" };
    if (
      a.delivery.phase !== terms.deliveryPhase ||
      a.delivery.format !== terms.deliveryFormat
    )
      return { ok: false, reason: "delivery mismatch" };
    return { ok: true };
  };

  const matchSettlementEvidence = (v: Record<string, unknown>): Match => {
    if (!isSettlementEvidence(v))
      return { ok: false, reason: "not settlement evidence" };
    const e = v as unknown as SettlementEvidence;
    if (e.jobId !== jobId)
      return { ok: false, reason: `jobId ${e.jobId} ≠ ${jobId}` };
    if (e.phase !== paymentEvidencePhase)
      return {
        ok: false,
        reason: `payment phase ${e.phase} ≠ ${paymentEvidencePhase}`,
      };
    if (e.phaseIndex !== 0)
      return { ok: false, reason: `phaseIndex ${e.phaseIndex} ≠ 0` };
    if (!e.paymentAmount)
      return { ok: false, reason: "settlement evidence has no payment amount" };
    if (e.paymentAmount.amount !== terms.price.amount)
      return { ok: false, reason: "settled amount mismatch" };
    if (e.paymentAmount.currency !== terms.price.asset)
      return { ok: false, reason: "settled currency mismatch" };
    if (e.paymentTxRefs.length !== 1) {
      return {
        ok: false,
        reason: `legacy MVP settlement evidence must carry exactly one transaction ref (got ${e.paymentTxRefs.length})`,
      };
    }
    if (e.outcome === "success") {
      if (
        e.paymentTxRefs.some(
          (ref) =>
            ref.rail.trim().length === 0 ||
            ref.txHash.trim().length === 0 ||
            ref.kind.trim().length === 0,
        )
      ) {
        return {
          ok: false,
          reason: "successful evidence has an empty transaction-ref component",
        };
      }
      if (!isSettlementFinalityModel(e.settlementFinality.model)) {
        return { ok: false, reason: "unrecognized settlement finality model" };
      }
      if (
        e.settlementFinality.model === "block-depth" &&
        e.settlementFinality.finalityBlocks !== undefined &&
        (!Number.isSafeInteger(e.settlementFinality.finalityBlocks) ||
          e.settlementFinality.finalityBlocks < 0)
      ) {
        return { ok: false, reason: "invalid block-depth finality" };
      }
    }
    return { ok: true };
  };

  const recoveryLookup = async (
    name: string,
    subject: string,
  ): Promise<Exclude<AnchorLookup, { status: "indeterminate" }>> => {
    let found: AnchorLookup;
    try {
      found = snapshotAnchorLookup(
        await deps.resolveAnchor(name),
        `${subject} lookup for "${name}"`,
      );
    } catch (cause) {
      throw new SubstrateError(
        `recovery: ${subject} lookup for "${name}" failed; refusing session recovery`,
        { cause },
      );
    }
    if (found.status === "indeterminate") {
      throw new SubstrateError(
        `recovery: could not authenticate prior ${subject} at "${name}" ` +
          `(${found.reason}); refusing session recovery`,
      );
    }
    return found;
  };

  // Listing expiry closes admission, not audit completion of an already-paid
  // deal. A resume id or Agreement alone is insufficient: before Listing
  // authentication, Vet, anchoring, or settlement, retain an exact matching
  // Agreement plus successful buyer-signed SettlementEvidence. Non-expired
  // resumes also preflight any existing Agreement so its signed Listing pin
  // cannot be bypassed by replacing a normative Listing with a legacy shape.
  let recoveredAgreement: AnchorLookup | undefined;
  let recoveredEvidence: AnchorLookup | undefined;
  if (!listingExpired && resumeJobId !== undefined) {
    const agreementName = sessionAnchorName.agreement(jobId);
    const priorAgreement = await recoveryLookup(agreementName, "admission");
    if (priorAgreement.status === "present") {
      const agreementMatch = matchAgreement(stripSignature(priorAgreement.value));
      if (!agreementMatch.ok) {
        throw new CounterpartyError(
          `recovery: prior admission anchored at ${priorAgreement.ref} does not match ` +
            `the requested deal: ${agreementMatch.reason}`,
        );
      }
      if (
        !(await authenticateExistingArtifact(
          priorAgreement.value,
          ARTIFACT_SEPARATORS.AgreementDocument,
        ))
      ) {
        throw new CounterpartyError(
          `recovery: prior admission anchored at ${priorAgreement.ref} failed ` +
            `cryptographic Agreement authentication`,
        );
      }
      recoveredAgreement = priorAgreement;
    }
  }
  if (listingExpired) {
    const agreementName = sessionAnchorName.agreement(jobId);
    recoveredAgreement = await recoveryLookup(agreementName, "admission");
    if (recoveredAgreement.status === "absent") {
      throw new CounterpartyError(
        `listing ${listing.pin.listingId} v${listing.pin.version} is outside its ` +
          `DACS-1 §6.3.4 validity window and job ${jobId} has no prior Agreement`,
      );
    }
    const agreementMatch = matchAgreement(stripSignature(recoveredAgreement.value));
    if (!agreementMatch.ok) {
      throw new CounterpartyError(
        `recovery: prior admission anchored at ${recoveredAgreement.ref} does not match ` +
        `the requested deal: ${agreementMatch.reason}`,
      );
    }
    const agreementAuthenticated = await authenticateExistingArtifact(
      recoveredAgreement.value,
      ARTIFACT_SEPARATORS.AgreementDocument,
    );
    if (!agreementAuthenticated) {
      throw new CounterpartyError(
        `recovery: prior admission anchored at ${recoveredAgreement.ref} failed ` +
          `cryptographic Agreement authentication`,
      );
    }

    const evidenceName = sessionAnchorName.evidence(jobId);
    recoveredEvidence = await recoveryLookup(evidenceName, "payment");
    if (recoveredEvidence.status === "absent") {
      throw new CounterpartyError(
        `listing ${listing.pin.listingId} v${listing.pin.version} is outside its ` +
          `DACS-1 §6.3.4 validity window and job ${jobId} has no prior SettlementEvidence`,
      );
    }
    const evidenceSignature = storedComponentSignatureMatches(
      recoveredEvidence.value,
      deps.buyerId,
    );
    if (!evidenceSignature.ok) {
      throw new CounterpartyError(
        `recovery: prior payment at ${recoveredEvidence.ref} has unacceptable ` +
          `signature: ${evidenceSignature.reason}`,
      );
    }
    const evidenceAuthenticated = await authenticateExistingArtifact(
      recoveredEvidence.value,
      ARTIFACT_SEPARATORS.SettlementEvidence,
    );
    if (!evidenceAuthenticated) {
      throw new CounterpartyError(
        `recovery: prior payment at ${recoveredEvidence.ref} failed cryptographic ` +
          `SettlementEvidence authentication`,
      );
    }
    const evidenceMatch = matchSettlementEvidence(
      stripSignature(recoveredEvidence.value),
    );
    if (!evidenceMatch.ok) {
      throw new CounterpartyError(
        `recovery: prior payment at ${recoveredEvidence.ref} does not match the ` +
          `requested deal: ${evidenceMatch.reason}`,
      );
    }
    if (
      (stripSignature(recoveredEvidence.value) as { outcome?: unknown }).outcome !==
      "success"
    ) {
      throw new CounterpartyError(
        `recovery: prior payment at ${recoveredEvidence.ref} was not successful; ` +
          `refusing expired-session recovery`,
      );
    }

    // This is intentionally after the recovered-state proof above. The public
    // Agent wires an authentication-only Listing verifier here; allowing it on
    // an arbitrary expired job id would turn a historical read into admission.
    await authenticateListing();
  }

  /** Content-addressed ref to a signed artifact's signed scope. */
  const refTo = (kind: string, id: string, value: Record<string, unknown>): AttestationRef => ({
    kind,
    id,
    contentHash: contentHash(stripSignature(value)),
  });

  // Vet (DACS-2): verify the seller before paying. Abort before settlement if
  // verification fails — never pay a seller that didn't clear the recipe.
  let vetRef: string | undefined;
  let vetValue: Record<string, unknown> | undefined;
  if (deps.vet) {
    const { ref, value } = await anchorOnce(
      sessionAnchorName.vet(jobId),
      (v) => {
        if (!isCompositeVerificationRecord(v))
          return { ok: false, reason: "not a verification record" };
        const r = v as unknown as CompositeVerificationRecord;
        // The CVR has no jobId; its load-bearing invariant is the subject — a
        // reused record MUST vet THIS seller, not whoever a stale job vetted.
        if (r.subject !== listingView.sellerClaim)
          return {
            ok: false,
            reason: `vet subject ${r.subject} ≠ seller ${listingView.sellerClaim}`,
          };
        return { ok: true };
      },
      async () =>
        signSessionArtifact(
          snapshotCanonicalJson(
            await deps.vet!(listingView.sellerClaim),
            "Vet result",
          ),
          ARTIFACT_SEPARATORS.CompositeVerificationRecord,
        ),
      deps.buyerId,
      undefined,
      ARTIFACT_SEPARATORS.CompositeVerificationRecord,
    );
    vetRef = ref;
    vetValue = value;
    const record = stripSignature(value) as unknown as CompositeVerificationRecord;
    // Proceed only on an explicit pass — fail, indeterminate and error all abort
    // (indeterminate/error are NOT pass; DACS-2 §7.7).
    if (record.decision !== "pass") {
      throw new CounterpartyError(
        `seller ${listingView.sellerClaim} did not pass verification (recipe ${record.recipeId}, decision=${record.decision})`,
      );
    }
  }

  // Negotiate (fixed-price): accept the listed terms.
  const { ref: agreementRef, value: agreementValue } = await anchorOnce(
    sessionAnchorName.agreement(jobId),
    matchAgreement,
    () => {
      const agreement: AgreementDocument & {
        /** SDK operational extension; retained inside the legacy signed scope. */
        dacsSdkListingPin?: ListingPin;
        /** Buyer-requested rail destination; distinct from the seller claim namespace. */
        dacsSdkExpectedSettlementPayee: string;
      } = {
        jobId,
        pattern: "negotiate-fixed-price",
        buyer: deps.buyerId,
        seller: listingView.sellerClaim,
        listingRef,
        dacsSdkExpectedSettlementPayee: expectedSettlementPayee,
        ...(readableListing.compatibility === "normative"
          ? { dacsSdkListingPin: structuredClone(listingView.pin) }
          : {}),
        price: structuredClone(terms.price),
        delivery: { phase: terms.deliveryPhase, format: terms.deliveryFormat },
        expiresAt: deps.now(),
      };
      return deps.sign(agreement, ARTIFACT_SEPARATORS.AgreementDocument);
    },
    undefined,
    recoveredAgreement,
    ARTIFACT_SEPARATORS.AgreementDocument,
  );

  // The agreement's content hash is this deal's anti-replay key.
  const agreementHash = contentHash(stripSignature(agreementValue as Record<string, unknown>));
  const settleRequest: SettleRequest = {
    rail: terms.price.rail,
    phase: paymentEvidencePhase,
    amount: terms.price.amount,
    asset: terms.price.asset,
    payee: listingView.sellerClaim,
    expectedPayee: expectedSettlementPayee,
    jobId,
    phaseIndex: 0,
  };
  const expectedSettlementBinding = settlementBinding(
    settleRequest,
    agreementHash,
  );

  // #52/#67 settlement boundary — BEFORE paying, when a durable store is wired:
  // fail CLOSED on untrustworthy durable state, and reject a replayed agreement
  // hash. `create` binds the hash atomically and THROWS on a cross-session reuse,
  // so a replayed deal aborts here — before any call to `settle`.
  const store = deps.sessionStore;
  if (store) {
    const loaded = await store.load(jobId);
    if (loaded.status === "corrupt" || loaded.status === "unsupported") {
      throw new CounterpartyError(
        `session ${jobId} durable state is ${loaded.status}; refusing to settle (fail-closed)`,
      );
    }
    if (loaded.status === "missing") {
      await store.create({ jobId, agreementHash, phase: "negotiated", now: deps.nowMs() });
    } else {
      // Resume: enforce that the live record's bound hash is THIS deal's — a
      // mismatch is a replayed/altered agreement under a reused jobId.
      if (loaded.record.agreementHash !== agreementHash) {
        throw new CounterpartyError(
          `session ${jobId} agreement hash does not match the resumed agreement; refusing to settle`,
        );
      }
    }
    // Do not rely on a custom store's create() implementation to reserve the
    // anti-replay index as an undocumented side effect. The explicit binding is
    // required on both fresh and resumed paths, and still occurs before payment.
    const bound = await store.bindHash({
      hash: agreementHash,
      jobId,
      kind: "agreement",
    });
    if (!bound.ok) {
      throw new CounterpartyError(
        `agreement hash for ${jobId} is bound to ${bound.boundTo} (anti-replay); refusing to settle`,
      );
    }
  }

  /**
   * Atomically claim the settlement semantic key. A revision CAS alone is not a
   * claim: a staggered worker can load the revision written by the first worker
   * and append a second intent while payment is still in flight. The store-level
   * primitive rejects any unresolved prior intent regardless of revision.
   */
  const claimSettlement = async (
    data: Record<string, string | number | boolean>,
  ): Promise<
    | { status: "claimed" }
    | { status: "held" }
    | { status: "completed"; outcome: SettlementOutcomeRead }
  > => {
    if (!store) return { status: "claimed" };
    const res = await store.claimCheckpoint({
      jobId,
      key: "settle:0",
      data,
      phase: "settling",
      now: deps.nowMs(),
    });
    if (res.ok) {
      // Defense in depth against a custom store that reports a successful
      // atomic claim while returning an already-completed checkpoint history.
      // The captured store wrapper rejects this too, but never turn a locally
      // observable contradiction into authorization for an irreversible call.
      const observed = readSettleOutcome({ status: "ok", record: res.record });
      if (observed.status !== "absent") {
        throw new CounterpartyError(
          `settlement claim for ${jobId} contradicted existing durable outcome state`,
        );
      }
      return { status: "claimed" };
    }
    if (res.reason === "completed") {
      if (!res.record) {
        throw new CounterpartyError(
          `settlement for ${jobId} is marked completed without durable state`,
        );
      }
      return {
        status: "completed",
        outcome: readSettleOutcome({ status: "ok", record: res.record }),
      };
    }
    if (res.reason === "held") return { status: "held" };
    throw new CounterpartyError(
      `could not claim settlement for ${jobId}: durable state is ${res.reason}`,
    );
  };

  /**
   * Bind the transaction BEFORE publishing the outcome checkpoint. If the process
   * dies between these two writes, resume/reconciliation sees an idempotent binding
   * owned by this job; the opposite order left a completed outcome whose tx was
   * never bound and whose resume path skipped binding entirely.
   */
  const bindSettlementTransaction = async (
    outcome: { txHash: string },
  ): Promise<void> => {
    if (!store || outcome.txHash.trim().length === 0) return;
    const bound = await store.bindHash({
      hash: outcome.txHash,
      jobId,
      kind: "transaction",
    });
    if (!bound.ok) {
      throw new CounterpartyError(
        `settlement tx ${outcome.txHash} is already bound to session ${bound.boundTo} (transaction replay)`,
      );
    }
  };

  /** Persist the rail outcome idempotently; never ignore a failed write. */
  const completeSettlement = async (
    outcome: DurableSettlementOutcome,
    phase: string,
  ): Promise<void> => {
    if (!store) return;
    const cur = await store.load(jobId);
    if (cur.status !== "ok") {
      throw new CounterpartyError(
        `could not record settlement outcome for ${jobId}: durable state is ${cur.status}`,
      );
    }
    assertSessionAgreementBinding(
      cur,
      jobId,
      outcome.agreementHash,
      "settlement outcome load",
    );
    const prior = readSettleOutcome(cur);
    if (prior.status === "current-rail") {
      if (sameSettlementOutcome(prior.outcome, outcome)) return;
      const canResolveAmbiguous =
        sameSettlementBinding(prior.outcome, outcome) &&
        prior.outcome.ok === false &&
        prior.outcome.txHash.length > 0 &&
        ((prior.outcome.txHash === outcome.txHash &&
          prior.outcome.chainId === outcome.chainId) ||
          (outcome.supersedesTxHash === prior.outcome.txHash &&
            outcome.supersedesChainId === prior.outcome.chainId));
      if (!canResolveAmbiguous) {
        throw new CounterpartyError(
          `could not record settlement outcome for ${jobId}: existing outcome conflicts with ${outcome.txHash}`,
        );
      }
    } else if (prior.status === "current-evidence") {
      throw new CounterpartyError(
        `could not record settlement outcome for ${jobId}: authenticated evidence already completed this phase`,
      );
    } else if (prior.status === "invalid") {
      throw new CounterpartyError(
        `could not record settlement outcome for ${jobId}: ${prior.reason}`,
      );
    }
    const res = await store.transition({
      jobId,
      expectedRevision: cur.record.revision,
      phase,
      checkpoint: { key: "settle:0", stage: "outcome", data: { ...outcome } },
      now: deps.nowMs(),
    });
    if (res.ok) return;

    // A reconciler and the original worker may race to write the same outcome.
    // Accept the winner only when it wrote byte-equivalent settlement metadata.
    if (res.reason === "revision-mismatch") {
      const latest = await store.load(jobId);
      assertSessionAgreementBinding(
        latest,
        jobId,
        outcome.agreementHash,
        "settlement outcome retry load",
      );
      const recorded = readSettleOutcome(latest);
      if (
        recorded.status === "current-rail" &&
        sameSettlementOutcome(recorded.outcome, outcome)
      ) {
        return;
      }
    }
    throw new CounterpartyError(
      `could not record settlement outcome for ${jobId}: transition failed (${res.reason})`,
    );
  };

  const recoverRailOutcome = async (
    label: string,
    prior?: LegacyDurableSettlementOutcome | DurableSettlementOutcome,
  ): Promise<DurableSettlementOutcome> => {
    if (!deps.resumeSettlement) {
      throw new CounterpartyError(
        `settlement for ${jobId} requires authenticated rail reconciliation (${label}); ` +
          "resumeSettlement is required to reconcile it",
      );
    }
    let priorAttempts: SettlementRecoveryAttempt[] = [];
    if (store) {
      const durable = await store.load(jobId);
      assertSessionAgreementBinding(
        durable,
        jobId,
        expectedSettlementBinding.agreementHash,
        "settlement recovery history load",
      );
      const validated = readSettleOutcome(durable);
      if (validated.status === "invalid") {
        throw new CounterpartyError(
          `settlement for ${jobId} has invalid recovery history: ${validated.reason}`,
        );
      }
      priorAttempts = settlementRecoveryAttempts(durable);
    }
    if (priorAttempts.length === 0 && prior && prior.txHash.length > 0) {
      priorAttempts = [
        { txHash: prior.txHash, chainId: prior.chainId, ok: prior.ok },
      ];
    }
    const recoveryRequest: SettleRequest = {
      ...settleRequest,
      ...(priorAttempts.length > 0 ? { priorAttempts } : {}),
    };
    const recovered = snapshotSettleResult(
      await deps.resumeSettlement(
        deepFreezeJson(
          snapshotCanonicalJson(
            recoveryRequest,
            "settlement recovery request",
          ),
        ),
      ),
      "settlement recovery",
    );
    validateSettlementResultBinding(
      recovered,
      settleRequest,
      "settlement recovery",
    );
    const outcome = durableSettlementOutcome(
      recovered,
      expectedSettlementBinding,
      prior && !prior.ok && prior.txHash.length > 0
        ? { txHash: prior.txHash, chainId: prior.chainId, ok: prior.ok }
        : undefined,
    );
    if (prior) {
      if (
        prior.ok &&
        prior.txHash.length > 0 &&
        (outcome.txHash !== prior.txHash || outcome.chainId !== prior.chainId)
      ) {
        throw new CounterpartyError(
          `settlement recovery returned ${outcome.chainId}:${outcome.txHash}, which does not authenticate the prior ${prior.chainId}:${prior.txHash}`,
        );
      }
      if (prior.ok && !outcome.ok) {
        throw new CounterpartyError(
          "settlement recovery contradicted a previously successful durable outcome",
        );
      }
    }
    // A returned transaction without definitive success is still ambiguous. It
    // may have landed, so bind it for anti-replay but retain the unresolved
    // intent and require another reconciliation; never mint failure evidence.
    await bindSettlementTransaction(outcome);
    if (!outcome.ok && outcome.txHash.length > 0) {
      // A tx-bearing non-success is not terminal evidence, but it is essential
      // recovery history. Persist it before throwing so a process restart can
      // audit the exact latest transaction instead of retaining only an opaque
      // bindHash entry or a stale earlier attempt.
      await completeSettlement(outcome, "settling");
      throw new CounterpartyError(
        `settlement ${outcome.chainId}:${outcome.txHash} remains indeterminate; refusing terminal failure evidence until reconciliation is definitive`,
      );
    }
    await completeSettlement(outcome, outcome.ok ? "settled" : "failed");
    return outcome;
  };

  const acceptRecordedOutcome = async (
    recorded: SettlementOutcomeRead,
  ): Promise<DurableSettlementOutcome> => {
    if (recorded.status === "invalid") {
      throw new CounterpartyError(
        `settlement for ${jobId} has invalid durable state: ${recorded.reason}`,
      );
    }
    if (recorded.status === "current-evidence") {
      throw new CounterpartyError(
        `settlement for ${jobId} is complete only through authenticated anchored evidence, ` +
          "but that evidence is no longer present; refusing to rebuild it or pay again",
      );
    }
    if (recorded.status === "legacy-unbound") {
      return recoverRailOutcome(
        "legacy v1 outcome lacks request/payee binding",
        recorded.outcome,
      );
    }
    if (recorded.status !== "current-rail") {
      throw new CounterpartyError(
        `settlement for ${jobId} has no reusable durable outcome`,
      );
    }
    const outcome = recorded.outcome;
    if (
      !sameSettlementBinding(outcome, expectedSettlementBinding) ||
      outcome.payee !== settleRequest.expectedPayee
    ) {
      throw new CounterpartyError(
        `settlement for ${jobId} is not bound to the requested rail, Agreement, terms, phase, and destination`,
      );
    }
    if (!outcome.ok && outcome.txHash.length > 0) {
      return recoverRailOutcome(
        "transaction-bearing failure remains indeterminate",
        outcome,
      );
    }
    // Re-bind historical/current outcomes before reuse to close any old
    // outcome-before-binding crash residue.
    await bindSettlementTransaction(outcome);
    return outcome;
  };

  // Settle on the chosen rail — but only if evidence isn't already anchored
  // (the no-double-pay guard: a present evidence record means we already paid).
  let settledOk = false;
  const {
    ref: settlementRef,
    value: evidenceValue,
    existing: evidenceExisting,
  } = await anchorOnce(
    sessionAnchorName.evidence(jobId),
    matchSettlementEvidence,
    async () => {
      // Reconcile across a crash (#52): if a prior run already PAID — recorded a
      // `settle:outcome` write-ahead — but crashed before the evidence was
      // anchored, rebuild the evidence from the recorded tx ref instead of paying
      // again. Without this the anchoring guard alone would re-pay in that window.
      let settlement: DurableSettlementOutcome;
      let prior: SettlementOutcomeRead = { status: "absent" };
      if (store) {
        const loaded = await store.load(jobId);
        assertSessionAgreementBinding(
          loaded,
          jobId,
          agreementHash,
          "settlement preflight load",
        );
        if (loaded.status !== "ok") {
          throw new CounterpartyError(
            `settlement for ${jobId} has unavailable durable state (${loaded.status})`,
          );
        }
        prior = readSettleOutcome(loaded);
      }
      if (prior.status !== "absent") {
        settlement = await acceptRecordedOutcome(prior);
      } else {
        // CLAIM the settlement phase via the intent checkpoint's atomic CAS, AND
        // write-ahead the intent, BEFORE the irreversible payment. A lost claim
        // means a concurrent worker already advanced this phase — abort rather than
        // settle twice (#67). (When no store is wired this always claims.)
        const claim = await claimSettlement({ ...expectedSettlementBinding });
        if (claim.status === "completed") {
          settlement = await acceptRecordedOutcome(claim.outcome);
        } else if (claim.status === "held") {
          // PC-7 recovery: this seam is explicitly contracted to reuse the original
          // rail idempotency binding, adopt a landed payment, and resubmit only when
          // the rail proves no payment landed. It is safe where ordinary `settle`
          // would be an unproven second submission.
          settlement = await recoverRailOutcome("unresolved settlement intent");
        } else {
          const pay = snapshotSettleResult(
            await deps.settle(
              deepFreezeJson(
                snapshotCanonicalJson(settleRequest, "settlement request"),
              ),
            ),
            "settlement rail",
          );
          validateSettlementResultBinding(pay, settleRequest, "settlement rail");
          // Defense in depth (independent of the rail): a settlement is only a
          // success if it produced a verifiable on-chain tx id. A rail reporting
          // ok:true with no txHash cannot back a provider-receipt claim.
          settlement = durableSettlementOutcome(
            pay,
            expectedSettlementBinding,
          );
          await bindSettlementTransaction(settlement);
          if (!settlement.ok && settlement.txHash.length > 0) {
            await completeSettlement(settlement, "settling");
            throw new CounterpartyError(
              `settlement ${settlement.chainId}:${settlement.txHash} remains indeterminate; refusing terminal failure evidence until reconciliation is definitive`,
            );
          }
          await completeSettlement(
            settlement,
            settlement.ok ? "settled" : "failed",
          );
        }
      }
      settledOk = settlement.ok;
      const observedAt = deps.nowMs();
      // Legacy MVP settlement evidence. The rail's reported chain id +
      // tx hash become a payment txRef. Finality defaults to the rail's receipt
      // (§9.7 `provider-receipt`, finalityBlocks 0) but a rail that knows its own
      // model — e.g. §9.5.9 pay-dem's `bft-final` + block height — reports it via
      // `pay.finality` / `pay.blockNumber` / `pay.txRefKind`, so the evidence
      // asserts the finality model that actually settled, not a hardcoded one
      // (F7/#22). Issue #81 removes phaseIndex and emits exact ChainTxRef variants.
      const evidenceBase = {
        evidenceVersion: "1" as const,
        jobId,
        // DACS-4 §9.7 carries the PhaseStep kind here. `terms.price.rail` is
        // the independently selected PaymentRailRef.railId and remains the
        // value passed to the rail adapter above.
        phase: paymentEvidencePhase,
        phaseIndex: 0,
        paymentTxRefs: [
          {
            rail: settlement.chainId,
            txHash: settlement.txHash,
            kind: settlement.txRefKind ?? "payment",
            ...(settlement.blockNumber !== undefined
              ? { blockNumber: settlement.blockNumber }
              : {}),
          },
        ],
        paymentAmount: { amount: terms.price.amount, currency: terms.price.asset },
        observedAt,
      };
      let evidence: SettlementEvidence;
      if (!settledOk) {
        evidence = { ...evidenceBase, outcome: "failure" };
      } else {
        const model = settlement.finalityModel ?? "provider-receipt";
        if (model === "block-depth" && settlement.finalityBlocks === undefined) {
          throw new CounterpartyError(
            "settlement rail reported block-depth finality without finalityBlocks",
          );
        }
        let settlementFinality: SettlementFinality;
        if (model === "block-depth") {
          settlementFinality = {
            model,
            finalityBlocks: settlement.finalityBlocks!,
            finalityObservedAt: observedAt,
          };
        } else if (model === "commitment-level") {
          settlementFinality = { model, finalityObservedAt: observedAt };
        } else {
          settlementFinality = { model, finalityObservedAt: observedAt };
        }
        evidence = { ...evidenceBase, outcome: "success", settlementFinality };
      }
      return signSessionArtifact(
        evidence,
        ARTIFACT_SEPARATORS.SettlementEvidence,
      );
    },
    deps.buyerId,
    recoveredEvidence,
    ARTIFACT_SEPARATORS.SettlementEvidence,
  );
  if (evidenceExisting) {
    // Reused a prior settlement — take the outcome from the anchored evidence.
    const unsignedEvidence = stripSignature(
      evidenceValue,
    ) as unknown as SettlementEvidence;
    settledOk = unsignedEvidence.outcome === "success";

    if (store) {
      const signature = evidenceValue.signature;
      if (
        !isComponentSignature(signature) ||
        signature.signer !== deps.buyerId
      ) {
        throw new CounterpartyError(
          `authenticated evidence at ${settlementRef} has no exact buyer ComponentSignature authority`,
        );
      }
      const tx = unsignedEvidence.paymentTxRefs[0]!;
      const evidenceOutcome: AuthenticatedEvidenceSettlementOutcome = {
        outcomeSource: "authenticated-evidence",
        ...expectedSettlementBinding,
        evidenceRef: settlementRef,
        evidenceContentHash: contentHash(
          unsignedEvidence as unknown as Record<string, unknown>,
        ),
        evidenceSigner: signature.signer,
        txHash: tx.txHash,
        chainId: tx.rail,
        txRefKind: tx.kind,
        ...(tx.blockNumber !== undefined ? { blockNumber: tx.blockNumber } : {}),
        ok: settledOk,
      };

      // Bind every authenticated tx identifier before declaring the phase
      // complete. The legacy MVP profile has exactly one ref (enforced by the
      // matcher), so no ordered-set information is lost in this v1 checkpoint.
      await bindSettlementTransaction(evidenceOutcome);
      if (!evidenceOutcome.ok && evidenceOutcome.txHash.length > 0) {
        throw new CounterpartyError(
          `authenticated failure evidence carries transaction ${evidenceOutcome.chainId}:${evidenceOutcome.txHash}; ` +
            "the payment remains indeterminate and cannot become a terminal checkpoint",
        );
      }

      let loaded = await store.load(jobId);
      assertSessionAgreementBinding(
        loaded,
        jobId,
        agreementHash,
        "evidence migration load",
      );
      if (loaded.status !== "ok") {
        throw new CounterpartyError(
          `cannot migrate authenticated evidence for ${jobId}: durable state is ${loaded.status}`,
        );
      }
      let recorded = readSettleOutcome(loaded);
      if (recorded.status === "absent") {
        const claim = await claimSettlement({ ...expectedSettlementBinding });
        if (claim.status === "completed") recorded = claim.outcome;
        // `claimed` and a same-binding `held` intent are both safely completed
        // below by the independently authenticated anchored evidence.
      }

      const validatePrior = (prior: SettlementOutcomeRead): boolean => {
        if (prior.status === "absent" || prior.status === "legacy-unbound") {
          if (
            prior.status === "legacy-unbound" &&
            ((prior.outcome.txHash.length > 0 &&
              (prior.outcome.txHash !== evidenceOutcome.txHash ||
                prior.outcome.chainId !== evidenceOutcome.chainId)) ||
              prior.outcome.ok !== evidenceOutcome.ok)
          ) {
            throw new CounterpartyError(
              "authenticated evidence conflicts with the legacy durable settlement outcome",
            );
          }
          return false;
        }
        if (prior.status === "invalid") {
          throw new CounterpartyError(
            `cannot migrate authenticated evidence for ${jobId}: ${prior.reason}`,
          );
        }
        if (prior.status === "current-evidence") {
          if (!sameAuthenticatedEvidenceOutcome(prior.outcome, evidenceOutcome)) {
            throw new CounterpartyError(
              "authenticated evidence conflicts with the durable evidence outcome",
            );
          }
          return true;
        }
        if (
          !sameSettlementBinding(prior.outcome, expectedSettlementBinding) ||
          prior.outcome.payee !== expectedSettlementPayee ||
          prior.outcome.txHash !== evidenceOutcome.txHash ||
          prior.outcome.chainId !== evidenceOutcome.chainId ||
          prior.outcome.ok !== evidenceOutcome.ok
        ) {
          throw new CounterpartyError(
            "authenticated evidence conflicts with the durable rail outcome",
          );
        }
        return true;
      };

      if (!validatePrior(recorded)) {
        let completed = false;
        for (let attempt = 0; attempt < 4 && !completed; attempt += 1) {
          loaded = await store.load(jobId);
          assertSessionAgreementBinding(
            loaded,
            jobId,
            agreementHash,
            "evidence migration transition load",
          );
          if (loaded.status !== "ok") {
            throw new CounterpartyError(
              `cannot migrate authenticated evidence for ${jobId}: durable state is ${loaded.status}`,
            );
          }
          const latest = readSettleOutcome(loaded);
          if (validatePrior(latest)) {
            completed = true;
            break;
          }
          const transition = await store.transition({
            jobId,
            expectedRevision: loaded.record.revision,
            phase: settledOk ? "settled" : "failed",
            checkpoint: {
              key: "settle:0",
              stage: "outcome",
              data: { ...evidenceOutcome },
            },
            now: deps.nowMs(),
          });
          if (transition.ok) completed = true;
          else if (transition.reason !== "revision-mismatch") {
            throw new CounterpartyError(
              `cannot migrate authenticated evidence for ${jobId}: ${transition.reason}`,
            );
          }
        }
        if (!completed) {
          throw new CounterpartyError(
            `cannot migrate authenticated evidence for ${jobId}: repeated concurrent updates`,
          );
        }
      }
    }
  }

  // Verify (legacy MVP): assemble + sign + anchor the buyer's one-sided bundle shape.
  // Strict DACS-5 consumers reject terminal completed/failed bundles that lack the
  // seller signature; use buildTwoSidedBundle for conformant two-sided bundles.
  // Refs are content-addressed; registry versions are pinned at 1.
  const outcome: SessionResult["outcome"] = settledOk ? "completed" : "failed";
  const evidenceRef = refTo("dacs-4-evidence", `settlement-${jobId}`, evidenceValue);
  const phaseSummary: PhaseSummaryEntry[] = [];
  const vetRecords: AttestationRef[] = [];
  if (vetRef && vetValue) {
    const vetAttRef = refTo("dacs-2-verifyresult", `vet-${jobId}`, vetValue);
    vetRecords.push(vetAttRef);
    phaseSummary.push({
      index: phaseSummary.length,
      kind: "vet-counterparty",
      outcome: "ok",
      attestationRef: vetAttRef,
    });
  }
  const evidenceTxRefs = (
    (stripSignature(evidenceValue) as { paymentTxRefs?: unknown }).paymentTxRefs as
      | Array<{ rail: string; txHash: string }>
      | undefined
  )?.map((t) => ({ rail: t.rail, txHash: t.txHash, kind: "settlement" }));
  phaseSummary.push({
    index: phaseSummary.length,
    kind: "settle",
    outcome: settledOk ? "ok" : "fail",
    ...(evidenceTxRefs ? { txRefs: evidenceTxRefs } : {}),
    attestationRef: evidenceRef,
  });

  const { ref: bundleRef } = await anchorOnce(
    sessionAnchorName.bundle(jobId),
    (v) => {
      if (!isAttestationBundle(v))
        return { ok: false, reason: "not an attestation bundle" };
      const b = v as unknown as AttestationBundle;
      if (b.jobId !== jobId)
        return { ok: false, reason: `jobId ${b.jobId} ≠ ${jobId}` };
      if (b.outcome !== outcome)
        return { ok: false, reason: `outcome ${b.outcome} ≠ ${outcome}` };
      if (!sameListingPin(b.listingRef, listingView.pin))
        return { ok: false, reason: "Listing pin mismatch" };
      if (b.agreementRef?.contentHash !== contentHash(stripSignature(agreementValue)))
        return { ok: false, reason: "Agreement ref mismatch" };
      if (
        b.settlementEvidence.length !== 1 ||
        b.settlementEvidence[0]?.contentHash !== evidenceRef.contentHash
      ) {
        return { ok: false, reason: "Settlement evidence ref mismatch" };
      }
      return { ok: true };
    },
    async () => {
      const body: AttestationBundle = {
        bundleVersion: "1",
        jobId,
        outcome,
        anchoredByRole: "buyer",
        // DACS-1 §6.3.4 LR-1: use the single tuple derived from the exact
        // verified bytes at session entry; never re-resolve "latest".
        listingRef: listingView.pin,
        agreementRef: refTo("dacs-3-agreement", `agreement-${jobId}`, agreementValue),
        parties: [
          // MVP one-sided: the buyer's party. bundleHash stands in for the
          // party's DACS-1 IdentityBundle hash (IdentityBundles are a follow-up).
          { role: "buyer", bundleHash: sha256Hex(deps.buyerId), primaryClaim: deps.buyerId },
        ],
        phaseSummary,
        vetRecords,
        settlementEvidence: [evidenceRef],
        recipeRegistryVersion: 1,
        railRegistryVersion: 1,
        finalisedAt: deps.nowMs(),
      };
      // Use the same single-source legacy-compatible §10.4.1 scope recipe as
      // the public recovery verifier: signatures + anchoredByRole are omitted.
      const hash = attestationBundleHash(
        body as unknown as AnyAttestationBundle,
      );
      const sig = await signEd25519(
        signedBytes(ARTIFACT_SEPARATORS.AttestationBundle, hash),
      );
      return {
        ...body,
        signatures: [
          {
            party: deps.buyerId,
            algorithm: "ed25519",
            value: Buffer.from(sig).toString("base64url"),
          },
        ],
      };
    },
    undefined,
    undefined,
    ARTIFACT_SEPARATORS.AttestationBundle,
  );

  if (store) {
    await recordSessionOutcome(store, jobId, {
      agreementHash,
      phase: outcome,
      now: deps.nowMs(),
      receipts: [
        { kind: "agreement", ref: agreementRef },
        { kind: "settlement", ref: settlementRef },
        { kind: "bundle", ref: bundleRef },
      ],
    });
  }

  return {
    outcome,
    jobId,
    listingPin: listingView.pin,
    vetRef,
    agreementRef,
    settlementRef,
    bundleRef,
  };
}
