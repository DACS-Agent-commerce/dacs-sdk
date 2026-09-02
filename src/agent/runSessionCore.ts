import { types as nodeTypes } from "node:util";

import {
  canonicalize,
  contentHash,
  encodeAddressSegment,
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
  type CheckpointValue,
  type SessionLoad,
  type SessionRecord,
  type SessionReceipt,
  type SessionStore,
  type TransitionResult,
} from "./sessionStore.js";
import type {
  AnyAttestationBundle,
  ChainTxRef,
  CompositeVerificationRecord,
  ListingPin,
  Price,
  SettlementEvidence as CurrentSettlementEvidence,
  SettlementFinality,
  SettlementFinalityParameters,
  SettlementFinalityModel,
} from "../artifacts/types.js";
import { attestationBundleHash } from "./twoSidedBundle.js";
import {
  isVerifiedListingAdmission,
  type ListingValidationResult,
} from "./listingValidation.js";
import {
  type LegacyMvpAgreementDocument as AgreementDocument,
  type LegacyMvpAttestationBundle as AttestationBundle,
  type LegacyMvpAttestationRef as AttestationRef,
  type LegacyMvpPhaseSummaryEntry as PhaseSummaryEntry,
  type LegacyMvpSettlementEvidence as LegacySettlementEvidence,
  type LegacyMvpTxRef,
  isLegacyMvpAttestationBundle as isAttestationBundle,
  isLegacyMvpAgreementDocument as isAgreementDocument,
  isLegacyMvpSettlementEvidence,
} from "../artifacts/legacyMvp.js";
import {
  isCompositeVerificationRecord,
  isAttestationRef,
  isChainTxRef,
  isExactJsonRecord,
  isSettlementEvidence as isCurrentSettlementEvidence,
  readListingArtifact,
} from "../artifacts/validators.js";
import { deriveX402ReceiptCommitment } from "../seller/x402Receipt.js";

type SessionSettlementEvidence =
  | LegacySettlementEvidence
  | CurrentSettlementEvidence;

function isSessionSettlementEvidence(
  value: unknown,
): value is SessionSettlementEvidence {
  return isCurrentSettlementEvidence(value) ||
    isLegacyMvpSettlementEvidence(value);
}
import type { StrictCompositeVerification } from "./compositeVerification.js";
import {
  isFinalizedVetAnchorReceipt,
  type FinalizedVetAnchor,
  type VetProduction,
} from "./vetCore.js";

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
  finality?: SettlementFinalityParameters;
  /** Block/ledger height the settlement landed at, when the rail reports it (§9.5.9 `demos`). */
  blockNumber?: number;
  /** The txRef kind the rail's tx is (e.g. §9.5.9 `demos`); defaults to `payment`. */
  txRefKind?: string;
  /** Exact DACS-4 transaction/event reference for current rail producers. */
  txRef?: ChainTxRef;
  /** Authoritative rail finality observation time, not local wall-clock time. */
  finalityObservedAt?: number;
  /** Durable raw x402 settlement-response input used to re-derive its receipt hash. */
  x402Receipt?: {
    protocolVersion: "2";
    headerName: "PAYMENT-RESPONSE";
    headerValue: string;
    paymentReceiptHash: string;
  };
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
   * Optional caller-held LR-1 tuple selected before entering the session. The
   * core still re-reads and validates the Listing independently, then requires
   * the tuple derived from those exact bytes to match this snapshot before Vet
   * or payment. Omit for the historical unpinned string-ref flow.
   */
  expectedListingPin?: ListingPin;
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
   * Optional current DACS-2 Vet producer. It returns an already finalized,
   * independently readable record plus its authenticated CORE §5.1 receipt.
   */
  vet?: (request: SessionVetRequest) => Promise<VetProduction>;
  /**
   * Mandatory with `vet`: recursively validate the record and its complete
   * VerifyResult/authority closure against caller-held bundle and requirement
   * expectations. Shape-only vet passes are never accepted by the money path.
   */
  verifyVetRecord?: (
    record: Readonly<CompositeVerificationRecord>,
    request: Readonly<SessionVetRequest>,
  ) => Promise<StrictCompositeVerification>;
  /**
   * Mandatory with `vet`: independently resolve and cryptographically
   * authenticate the finalized SR-2 record binding from caller-held substrate
   * trust. On a fresh production, `claimed` is the producer's ref/receipt and
   * the authenticated result must match it exactly. On resume, `claimed` is
   * absent, so this seam must recover the finalized ref/receipt by the supplied
   * logical/native address and exact record hash. Returning `null` fails closed.
   *
   * This must not accept a receipt merely because it has the CORE §5.1 shape.
   */
  authenticateVetFinality?: (
    request: Readonly<VetFinalityAuthenticationRequest>,
  ) => Promise<FinalizedVetAnchor | null>;
  /** Fresh canonical uppercase ULID for a new normative session. */
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
   * DACS-1 §6.3.4 LR-2/LR-3 full ordered validation result. A normative
   * Listing cannot start a new session without this result, and only
   * `verified` is admissible; `rejected`, `revoked`, and `indeterminate` all
   * fail closed before Vet, rail selection, or settlement.
   */
  validateListing?: (
    raw: Record<string, unknown>,
  ) => Promise<ListingValidationResult> | ListingValidationResult;
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

export interface SessionVetRequest {
  jobId: string;
  evaluatedParty: string;
}

/** Exact inputs to the caller-held VPC-3 finalized-anchor authenticator. */
export interface VetFinalityAuthenticationRequest {
  logicalAddress: string;
  nativeAddress: string;
  contentHash: string;
  record: Readonly<CompositeVerificationRecord>;
  /** Present only on the fresh-producer path; absent during durable resume. */
  claimed?: Readonly<FinalizedVetAnchor>;
}

/**
 * Address grammar emitted by the quarantined pre-#308 buyer-only session
 * producer. These names exist for deterministic resume and legacy reads only;
 * they are not the current normative DACS addressing contract.
 *
 * New code uses the typed producers exported beside each current protocol
 * component, including `compositeVerificationAddress`,
 * `fixedPriceAgreementLogicalAddress`, payment phase addresses, and
 * `bundleAddress`.
 */
export const legacyMvpSessionAnchorName = Object.freeze({
  vet: (jobId: string, evaluatedParty?: string) =>
    evaluatedParty
      ? `dacs2:composite:${encodeAddressSegment(jobId)}:${encodeAddressSegment(evaluatedParty)}`
      : `dacs2:verifyrecord:${encodeAddressSegment(jobId)}`, // explicit pre-§7.7 read compatibility only
  agreement: (jobId: string) => `dacs3:agreement:${jobId}`,
  evidence: (jobId: string) => `dacs4:evidence:${jobId}`,
  bundle: (jobId: string) => `dacs5:bundle:${jobId}`,
});

/**
 * @deprecated Deep-import compatibility alias. Public barrels intentionally
 * expose only `legacyMvpSessionAnchorName`, whose name cannot be mistaken for
 * the normative address scheme.
 */
export const sessionAnchorName = legacyMvpSessionAnchorName;

/** Result of a resume-time semantic check on an already-anchored artifact. */
type Match = { ok: boolean; reason?: string };
type VerifiedVetMatch =
  | { ok: false; reason: string }
  | { ok: true; record: CompositeVerificationRecord };

function deepFreezeSnapshot<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value as object)) {
    return value;
  }
  if (ArrayBuffer.isView(value)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeSnapshot(child, seen);
  }
  return Object.freeze(value);
}

function immutableSnapshot<T>(value: T, label: string): T {
  try {
    return deepFreezeSnapshot(structuredClone(value));
  } catch {
    throw new CounterpartyError(`${label} is not snapshot-safe`);
  }
}

function immutableJsonSnapshot<T extends Record<string, unknown>>(
  value: T,
  label: string,
): T {
  // Validate before cloning: structuredClone invokes accessors and normalises
  // prototypes, so using it first would turn a hostile callback response into
  // apparently valid JSON.
  if (!isExactJsonRecord(value)) {
    throw new CounterpartyError(`${label} is not an exact JSON wire record`);
  }
  const captured = immutableSnapshot(value, label);
  if (!isExactJsonRecord(captured)) {
    throw new CounterpartyError(`${label} changed during snapshot`);
  }
  return captured;
}

interface DurableSettlementOutcomeBase {
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
  blockNumber?: number;
  txRefKind?: string;
  /** Canonical JSON encoding preserves the discriminated current reference in the primitive WAL. */
  txRefJson?: string;
  finalityObservedAt?: number;
  x402ReceiptHeaderValue?: string;
  x402PaymentReceiptHash?: string;
  /** Authenticated recovery provenance when a safe resubmit used a new tx. */
  supersedesTxHash?: string;
  supersedesChainId?: string;
}

/** Flat primitive-only form retained in the durable session checkpoint. */
type DurableSettlementFinality =
  | {
      finalityModel?: never;
      finalityBlocks?: never;
      finalityCommitmentLevel?: never;
    }
  | {
      finalityModel: "block-depth";
      finalityBlocks?: number;
      finalityCommitmentLevel?: never;
    }
  | {
      finalityModel: "commitment-level";
      finalityBlocks?: never;
      finalityCommitmentLevel?: "processed" | "confirmed" | "finalized";
    }
  | {
      finalityModel: Exclude<
        SettlementFinalityModel,
        "block-depth" | "commitment-level"
      >;
      finalityBlocks?: never;
      finalityCommitmentLevel?: never;
    };

type DurableSettlementOutcome = DurableSettlementOutcomeBase &
  DurableSettlementFinality;

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

function withEvmHexPrefix(value: string): string {
  return /^0x/i.test(value) ? `0x${value.slice(2)}` : `0x${value}`;
}

function settlementIdentityFromTxRef(ref: unknown): {
  txHash: string;
  chainId: string;
  kind: string;
  blockNumber?: number;
} {
  if (!isChainTxRef(ref)) {
    const legacy = ref as {
      rail?: unknown;
      txHash?: unknown;
      kind?: unknown;
      blockNumber?: unknown;
    };
    if (typeof legacy.rail !== "string" || typeof legacy.txHash !== "string" ||
        typeof legacy.kind !== "string") {
      throw new CounterpartyError("settlement transaction reference is malformed");
    }
    return {
      txHash: legacy.txHash,
      chainId: legacy.rail,
      kind: legacy.kind,
      ...(typeof legacy.blockNumber === "number"
        ? { blockNumber: legacy.blockNumber }
        : {}),
    };
  }
  switch (ref.kind) {
    case "evm":
    case "evm-event":
      return {
        txHash: withEvmHexPrefix(ref.txHash),
        chainId: `eip155:${ref.chainId}`,
        kind: ref.kind,
      };
    case "x402-event":
      return {
        txHash: withEvmHexPrefix(ref.settlementTxHash),
        chainId: `eip155:${ref.chainId}`,
        kind: ref.kind,
      };
    case "x402":
      return {
        txHash: ref.settlementTxHash
          ? withEvmHexPrefix(ref.settlementTxHash)
          : "",
        chainId: ref.chainId === undefined ? "x402" : `eip155:${ref.chainId}`,
        kind: ref.kind,
      };
    case "demos":
      return {
        txHash: ref.txHash,
        chainId: "demos",
        kind: ref.kind,
        ...(ref.blockNumber === undefined ? {} : { blockNumber: ref.blockNumber }),
      };
    default:
      throw new CounterpartyError(
        `legacy session recovery cannot project ${ref.kind} transaction identity`,
      );
  }
}

function parseSettlementFinalityParameters(
  value: unknown,
): SettlementFinalityParameters | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const finality = value as Record<string, unknown>;
  if (!isSettlementFinalityModel(finality.model)) return null;
  if (finality.model === "block-depth") {
    if (
      !(
        hasExactKeys(finality, ["model"]) ||
        hasExactKeys(finality, ["model", "finalityBlocks"])
      )
    ) {
      return null;
    }
    if (
      finality.finalityBlocks !== undefined &&
      (!Number.isSafeInteger(finality.finalityBlocks) ||
        (finality.finalityBlocks as number) < 0)
    ) {
      return null;
    }
    return {
      model: finality.model,
      ...(typeof finality.finalityBlocks === "number"
        ? { finalityBlocks: finality.finalityBlocks }
        : {}),
    };
  }
  if (finality.model === "commitment-level") {
    if (
      !(
        hasExactKeys(finality, ["model"]) ||
        hasExactKeys(finality, ["model", "finalityCommitmentLevel"])
      )
    ) {
      return null;
    }
    if (
      finality.finalityCommitmentLevel !== undefined &&
      finality.finalityCommitmentLevel !== "processed" &&
      finality.finalityCommitmentLevel !== "confirmed" &&
      finality.finalityCommitmentLevel !== "finalized"
    ) {
      return null;
    }
    return {
      model: finality.model,
      ...(typeof finality.finalityCommitmentLevel === "string"
        ? { finalityCommitmentLevel: finality.finalityCommitmentLevel }
        : {}),
    };
  }
  return hasExactKeys(finality, ["model"])
    ? { model: finality.model }
    : null;
}

function durableFinalityFields(
  finality: SettlementFinalityParameters | undefined,
): DurableSettlementFinality {
  if (finality === undefined) return {};
  if (finality.model === "block-depth") {
    return {
      finalityModel: finality.model,
      ...(finality.finalityBlocks === undefined
        ? {}
        : { finalityBlocks: finality.finalityBlocks }),
    };
  }
  if (finality.model === "commitment-level") {
    return {
      finalityModel: finality.model,
      ...(finality.finalityCommitmentLevel === undefined
        ? {}
        : { finalityCommitmentLevel: finality.finalityCommitmentLevel }),
    };
  }
  return { finalityModel: finality.model };
}

function parseDurableFinality(
  data: Readonly<{
    finalityModel?: unknown;
    finalityBlocks?: unknown;
    finalityCommitmentLevel?: unknown;
  }>,
): SettlementFinalityParameters | null | undefined {
  if (
    data.finalityModel === undefined &&
    data.finalityBlocks === undefined &&
    data.finalityCommitmentLevel === undefined
  ) {
    return undefined;
  }
  return parseSettlementFinalityParameters({
    model: data.finalityModel,
    ...(data.finalityBlocks === undefined
      ? {}
      : { finalityBlocks: data.finalityBlocks }),
    ...(data.finalityCommitmentLevel === undefined
      ? {}
      : { finalityCommitmentLevel: data.finalityCommitmentLevel }),
  });
}

function settlementFinalityFromDurable(
  outcome: DurableSettlementOutcome,
): SettlementFinalityParameters | undefined {
  const parsed = parseDurableFinality(outcome);
  // Durable outcomes are constructed only after this combination is validated.
  if (parsed === null) {
    throw new CounterpartyError("durable settlement finality is malformed");
  }
  return parsed;
}

function settlementTxRefFromDurable(
  outcome: Pick<DurableSettlementOutcome, "txRefJson">,
): ChainTxRef | undefined {
  if (outcome.txRefJson === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.txRefJson);
  } catch {
    throw new CounterpartyError("durable settlement txRef is malformed");
  }
  if (!isChainTxRef(parsed) || canonicalize(parsed) !== outcome.txRefJson) {
    throw new CounterpartyError("durable settlement txRef is non-canonical or malformed");
  }
  return parsed;
}

function durableCurrentFieldsValid(data: Record<string, unknown>): boolean {
  const txRefJson = data.txRefJson;
  let txRef: ChainTxRef | undefined;
  if (txRefJson !== undefined) {
    if (typeof txRefJson !== "string") return false;
    try {
      const parsed = JSON.parse(txRefJson);
      if (!isChainTxRef(parsed) || canonicalize(parsed) !== txRefJson) return false;
      txRef = parsed;
    } catch {
      return false;
    }
  }
  if (data.finalityObservedAt !== undefined &&
      (!Number.isSafeInteger(data.finalityObservedAt) ||
        (data.finalityObservedAt as number) < 0)) return false;
  if (txRef !== undefined &&
      (data.finalityObservedAt === undefined || data.finalityModel === undefined)) {
    return false;
  }
  if ((txRef?.kind === "evm-event" || txRef?.kind === "x402-event") &&
      (data.finalityModel !== "block-depth" ||
        !Number.isSafeInteger(data.finalityBlocks) ||
        (data.finalityBlocks as number) <= 0)) return false;
  if (txRef?.kind === "evm-event") {
    if (data.txHash !== `0x${txRef.txHash}` ||
        data.chainId !== `eip155:${txRef.chainId}`) return false;
  }
  if (txRef?.kind === "x402-event") {
    if (data.txHash !== `0x${txRef.settlementTxHash}` ||
        data.chainId !== `eip155:${txRef.chainId}`) return false;
  }
  const receiptValue = data.x402ReceiptHeaderValue;
  const receiptHash = data.x402PaymentReceiptHash;
  if ((receiptValue === undefined) !== (receiptHash === undefined)) return false;
  if (txRef?.kind === "x402-event" && receiptValue === undefined) return false;
  if (receiptValue !== undefined) {
    if (typeof receiptValue !== "string" || typeof receiptHash !== "string") return false;
    const derived = deriveX402ReceiptCommitment({
      protocolVersion: "2",
      responseHeader: { name: "PAYMENT-RESPONSE", value: receiptValue },
    });
    if (derived.disposition !== "pass" ||
        derived.computedPaymentReceiptHash !== receiptHash) return false;
    if (typeof txRefJson !== "string") return false;
    const receipt = derived.receipt;
    if (txRef?.kind !== "x402-event" || txRef.paymentReceiptHash !== receiptHash ||
        typeof receipt?.transaction !== "string" ||
        receipt.transaction.toLowerCase() !== `0x${txRef.settlementTxHash}` ||
        receipt?.network !== `eip155:${txRef.chainId}` ||
        typeof receipt.payer !== "string" || typeof data.payer !== "string" ||
        receipt.payer.toLowerCase() !== data.payer.toLowerCase()) {
      return false;
    }
  }
  return true;
}

function durableSettlementCheckpointData(
  outcome: DurableSettlementOutcome,
): Record<string, CheckpointValue> {
  const data: Record<string, CheckpointValue> = {
    outcomeSource: outcome.outcomeSource,
    settlementBindingVersion: outcome.settlementBindingVersion,
    rail: outcome.rail,
    phase: outcome.phase,
    agreementHash: outcome.agreementHash,
    amount: outcome.amount,
    asset: outcome.asset,
    payeeClaim: outcome.payeeClaim,
    expectedPayee: outcome.expectedPayee,
    phaseIndex: outcome.phaseIndex,
    txHash: outcome.txHash,
    chainId: outcome.chainId,
    payer: outcome.payer,
    payee: outcome.payee,
    ok: outcome.ok,
  };
  if (outcome.finalityModel !== undefined) {
    data.finalityModel = outcome.finalityModel;
  }
  if (outcome.finalityBlocks !== undefined) {
    data.finalityBlocks = outcome.finalityBlocks;
  }
  if (outcome.finalityCommitmentLevel !== undefined) {
    data.finalityCommitmentLevel = outcome.finalityCommitmentLevel;
  }
  if (outcome.txRefJson !== undefined) data.txRefJson = outcome.txRefJson;
  if (outcome.finalityObservedAt !== undefined) {
    data.finalityObservedAt = outcome.finalityObservedAt;
  }
  if (outcome.x402ReceiptHeaderValue !== undefined) {
    data.x402ReceiptHeaderValue = outcome.x402ReceiptHeaderValue;
  }
  if (outcome.x402PaymentReceiptHash !== undefined) {
    data.x402PaymentReceiptHash = outcome.x402PaymentReceiptHash;
  }
  if (outcome.blockNumber !== undefined) data.blockNumber = outcome.blockNumber;
  if (outcome.txRefKind !== undefined) data.txRefKind = outcome.txRefKind;
  if (outcome.supersedesTxHash !== undefined) {
    data.supersedesTxHash = outcome.supersedesTxHash;
  }
  if (outcome.supersedesChainId !== undefined) {
    data.supersedesChainId = outcome.supersedesChainId;
  }
  return data;
}

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
    "txRef",
    "finalityObservedAt",
    "x402Receipt",
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
  const parsedFinality = parseSettlementFinalityParameters(result.finality);
  if (result.finality !== undefined) {
    if (
      !result.ok ||
      parsedFinality === null
    ) {
      throw new CounterpartyError(`${label} returned malformed finality`);
    }
  }
  if (
    (result.finalityObservedAt !== undefined &&
      (!result.ok || !Number.isSafeInteger(result.finalityObservedAt) ||
        (result.finalityObservedAt as number) < 0)) ||
    (result.txRef !== undefined && !result.ok)
  ) {
    throw new CounterpartyError(`${label} returned malformed current finality evidence`);
  }
  if (result.txRef !== undefined && !isChainTxRef(result.txRef)) {
    throw new CounterpartyError(`${label} returned malformed txRef`);
  }
  if (result.txRef !== undefined && result.finality === undefined) {
    throw new CounterpartyError(`${label} returned current txRef without finality`);
  }
  if (result.txRef !== undefined && result.finalityObservedAt === undefined) {
    throw new CounterpartyError(`${label} returned current txRef without finality time`);
  }
  if ((result.txRef?.kind === "evm-event" ||
      result.txRef?.kind === "x402-event") &&
      (parsedFinality?.model !== "block-depth" ||
        !Number.isSafeInteger(parsedFinality.finalityBlocks) ||
        (parsedFinality.finalityBlocks ?? 0) <= 0)) {
    throw new CounterpartyError(
      `${label} returned current EVM event without positive block-depth finality`,
    );
  }
  if (result.txRef?.kind === "x402-event" && result.x402Receipt === undefined) {
    throw new CounterpartyError(`${label} returned x402-event without raw receipt`);
  }
  if (result.txRef?.kind === "evm-event" &&
      (result.txHash !== `0x${result.txRef.txHash}` ||
        result.chainId !== `eip155:${result.txRef.chainId}`)) {
    throw new CounterpartyError(`${label} returned inconsistent evm-event identity`);
  }
  if (result.txRef?.kind === "x402-event" &&
      (result.txHash !== `0x${result.txRef.settlementTxHash}` ||
        result.chainId !== `eip155:${result.txRef.chainId}`)) {
    throw new CounterpartyError(`${label} returned inconsistent x402-event identity`);
  }
  if (result.x402Receipt !== undefined) {
    const receipt = result.x402Receipt;
    if (
      receipt === null || typeof receipt !== "object" || Array.isArray(receipt) ||
      !hasExactKeys(receipt as Record<string, unknown>, [
        "protocolVersion",
        "headerName",
        "headerValue",
        "paymentReceiptHash",
      ]) ||
      (receipt as Record<string, unknown>).protocolVersion !== "2" ||
      (receipt as Record<string, unknown>).headerName !== "PAYMENT-RESPONSE" ||
      typeof (receipt as Record<string, unknown>).headerValue !== "string" ||
      typeof (receipt as Record<string, unknown>).paymentReceiptHash !== "string"
    ) {
      throw new CounterpartyError(`${label} returned malformed x402 receipt`);
    }
    const parsed = deriveX402ReceiptCommitment({
      protocolVersion: "2",
      responseHeader: {
        name: "PAYMENT-RESPONSE",
        value: (receipt as { headerValue: string }).headerValue,
      },
    });
    if (parsed.disposition !== "pass" ||
        parsed.computedPaymentReceiptHash !==
          (receipt as { paymentReceiptHash: string }).paymentReceiptHash ||
        !result.txRef || result.txRef.kind !== "x402-event" ||
        result.txRef.paymentReceiptHash !== parsed.computedPaymentReceiptHash ||
        typeof parsed.receipt?.transaction !== "string" ||
        parsed.receipt.transaction.toLowerCase() !==
          `0x${result.txRef.settlementTxHash}` ||
        parsed.receipt?.network !== `eip155:${result.txRef.chainId}` ||
        typeof parsed.receipt?.payer !== "string" ||
        parsed.receipt.payer.toLowerCase() !== result.payer.toLowerCase()) {
      throw new CounterpartyError(`${label} returned unauthenticated x402 receipt`);
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

function snapshotExpectedListingPin(
  value: unknown,
): ListingPin | undefined {
  if (value === undefined) return undefined;
  const captured = snapshotCanonicalJsonRead(value, "expected Listing pin");
  if (!isListingPinValue(captured)) {
    throw new DacsError(
      "expectedListingPin must be an exact canonical ListingPin",
    );
  }
  return captured;
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
  const expectedListingPin = snapshotExpectedListingPin(
    stableDataProperty(input, "expectedListingPin", "deps.expectedListingPin"),
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
    expectedListingPin,
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
    verifyVetRecord: stableDataMethod<SessionDeps["verifyVetRecord"]>(
      input,
      "verifyVetRecord",
      "deps.verifyVetRecord",
      true,
    ),
    authenticateVetFinality: stableDataMethod<
      SessionDeps["authenticateVetFinality"]
    >(
      input,
      "authenticateVetFinality",
      "deps.authenticateVetFinality",
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
    validateListing: stableDataMethod<SessionDeps["validateListing"]>(
      input,
      "validateListing",
      "deps.validateListing",
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
  const finality = parseSettlementFinalityParameters(result.finality);
  if (finality === null) {
    throw new CounterpartyError("settlement rail returned malformed finality");
  }
  return {
    outcomeSource: "rail-result",
    ...binding,
    txHash: result.txHash,
    chainId: result.chainId,
    payer: result.payer,
    payee: result.payee,
    ok,
    ...durableFinalityFields(finality),
    ...(result.blockNumber !== undefined ? { blockNumber: result.blockNumber } : {}),
    ...(result.txRefKind !== undefined ? { txRefKind: result.txRefKind } : {}),
    ...(result.txRef !== undefined
      ? { txRefJson: canonicalize(result.txRef) }
      : {}),
    ...(result.finalityObservedAt !== undefined
      ? { finalityObservedAt: result.finalityObservedAt }
      : {}),
    ...(result.x402Receipt !== undefined
      ? {
          x402ReceiptHeaderValue: result.x402Receipt.headerValue,
          x402PaymentReceiptHash: result.x402Receipt.paymentReceiptHash,
        }
      : {}),
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
    left.finalityCommitmentLevel === right.finalityCommitmentLevel &&
    left.blockNumber === right.blockNumber &&
    left.txRefKind === right.txRefKind &&
    left.txRefJson === right.txRefJson &&
    left.finalityObservedAt === right.finalityObservedAt &&
    left.x402ReceiptHeaderValue === right.x402ReceiptHeaderValue &&
    left.x402PaymentReceiptHash === right.x402PaymentReceiptHash &&
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
    // DACS-4 §9.7 makes settlementFinality success-only. Apply that rule at
    // the shared durable reader before classifying current, authenticated, or
    // legacy checkpoint shapes so no recovery path can silently discard a
    // finality assertion attached to a failed settlement.
    const carriesFinality = [
      "finalityModel",
      "finalityBlocks",
      "finalityCommitmentLevel",
      "txRefJson",
      "finalityObservedAt",
      "x402ReceiptHeaderValue",
      "x402PaymentReceiptHash",
    ].some((key) => Object.prototype.hasOwnProperty.call(data, key));
    if (!ok && carriesFinality) {
      return {
        status: "invalid",
        reason: "failed settlement outcome must omit finality fields",
      };
    }
    const finality = parseDurableFinality(data);
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
        "finalityCommitmentLevel",
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
        finality === null ||
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
        blockNumber,
        txRefKind,
        txRefJson,
        finalityObservedAt,
        x402ReceiptHeaderValue,
        x402PaymentReceiptHash,
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
        "finalityCommitmentLevel",
        "blockNumber",
        "txRefKind",
        "txRefJson",
        "finalityObservedAt",
        "x402ReceiptHeaderValue",
        "x402PaymentReceiptHash",
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
        finality === null ||
        (blockNumber !== undefined &&
          (!Number.isSafeInteger(blockNumber) || (blockNumber as number) < 0)) ||
        (txRefKind !== undefined &&
          (typeof txRefKind !== "string" ||
            txRefKind.length === 0 ||
            txRefKind.trim() !== txRefKind)) ||
        !durableCurrentFieldsValid(data) ||
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
          ...durableFinalityFields(finality),
          ...(typeof blockNumber === "number" ? { blockNumber } : {}),
          ...(typeof txRefKind === "string" ? { txRefKind } : {}),
          ...(typeof txRefJson === "string" ? { txRefJson } : {}),
          ...(typeof finalityObservedAt === "number"
            ? { finalityObservedAt }
            : {}),
          ...(typeof x402ReceiptHeaderValue === "string" &&
          typeof x402PaymentReceiptHash === "string"
            ? { x402ReceiptHeaderValue, x402PaymentReceiptHash }
            : {}),
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
  const runtime = deps;
  const sessionTerms = terms;
  const requestedListingRef = listingRef;
  const requestedResumeJobId = resumeJobId;
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
    throw new Error(`listing not found or invalid at ${requestedListingRef}`);
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

  let listingView: {
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

  // LR-3 is a fresh-admission gate. An expired resume must instead prove the
  // exact already-paid state through the authenticated recovery path below;
  // reapplying the current validity/revocation disposition would strand deals
  // that finalized while the Listing was live.
  if (readableListing.compatibility === "normative" && !listingExpired) {
    if (!deps.validateListing) {
      throw new DacsError(
        "runSessionCore requires deps.validateListing for normative DACS-1 Listings; " +
          "LR-3 permits new sessions only when the disposition is verified",
      );
    }
    let validation: ListingValidationResult;
    try {
      const rawValidation = snapshotCanonicalJsonRead(
        await deps.validateListing(
          snapshotCanonicalJson(storedRecord, "Listing validator input"),
        ),
        "Listing validation result",
      );
      if (
        rawValidation === null ||
        typeof rawValidation !== "object" ||
        Array.isArray(rawValidation) ||
        !["verified", "rejected", "revoked", "indeterminate"].includes(
          (rawValidation as { disposition?: string }).disposition ?? "",
        ) ||
        !Number.isSafeInteger((rawValidation as { step?: number }).step) ||
        typeof (rawValidation as { reason?: unknown }).reason !== "string"
      ) {
        throw new TypeError("malformed Listing validation result");
      }
      validation = rawValidation as ListingValidationResult;
    } catch (cause) {
      throw new SubstrateError(
        `listing at ${listingRef} validation was indeterminate (validator threw)`,
        { cause },
      );
    }
    if (validation.disposition === "indeterminate") {
      throw new SubstrateError(
        `listing at ${listingRef} validation is indeterminate at DACS-1 reader step ` +
          `${validation.step} (${validation.reason}); LR-3 refuses the new session`,
      );
    }
    if (validation.disposition !== "verified") {
      throw new CounterpartyError(
        `listing at ${requestedListingRef} is ${validation.disposition} at DACS-1 reader step ` +
          `${validation.step} (${validation.reason}); LR-3 refuses the new session`,
      );
    }
    const exactRawHash = contentHash(storedRecord);
    if (validation.listingContentHash !== exactRawHash) {
      throw new CounterpartyError(
        `listing at ${requestedListingRef} validation result is not bound to the exact LR-1 ` +
          `content hash; refusing the new session`,
      );
    }
    if (!isVerifiedListingAdmission(storedRecord, validation)) {
      throw new CounterpartyError(
        `listing at ${requestedListingRef} has a stale, substituted, or capability-incomplete ` +
          `verified result; DACS-1 LR-3 / DACS-4 DPA-1 refuse the new session`,
      );
    }
    const admitted = validation.listing;
    if (admitted.signature.signer !== admitted.seller.identity.presentedBy) {
      throw new CounterpartyError(
        `listing at ${requestedListingRef} is not payee-bound: the Listing signer must equal ` +
          `seller.identity.presentedBy until the complete DACS-1 §6.3.2 ` +
          `presentation is verified`,
      );
    }
    const now = runtime.nowMs();
    if (
      now < admitted.validity.notBefore ||
      (admitted.validity.notAfter !== undefined && now > admitted.validity.notAfter)
    ) {
      throw new CounterpartyError(
        `listing ${admitted.listingId} v${admitted.listingVersion} is outside its ` +
          `DACS-1 §6.3.4 validity window`,
      );
    }
    listingView = {
      sellerClaim: admitted.seller.identity.presentedBy,
      supportedPaymentRails:
        admitted.acceptedRails?.map((rail) => rail.railId) ?? [],
      supportedDelivery: admitted.pipeline
        .map((phase) => phase.kind)
        .filter((kind) => kind.startsWith("deliver-")),
      pin: {
        listingId: admitted.listingId,
        version: admitted.listingVersion,
        contentHash: validation.listingContentHash,
      },
    };
  }

  if (
    runtime.expectedListingPin !== undefined &&
    !sameListingPin(runtime.expectedListingPin, listingView.pin)
  ) {
    throw new CounterpartyError(
      `listing at ${requestedListingRef} does not match the caller-held expected ` +
        `Listing pin (${describeListingPin(runtime.expectedListingPin)} != ` +
        `${describeListingPin(listingView.pin)})`,
    );
  }

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
          deepFreezeJson(
            snapshotCanonicalJson(storedRecord, "Listing verifier input"),
          ),
          listingView.sellerClaim,
        )) === true;
    } catch {
      verified = false; // a throwing verifier is not a pass
    }
    if (!verified) {
      throw new CounterpartyError(
        `listing at ${requestedListingRef} failed signature verification for seller ${listingView.sellerClaim} (#41)`,
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
          const matching = paymentPhases.filter(
            (phase) => phase.parameters?.rail === terms.price.rail,
          );
          if (matching.length === 0) {
            throw new CounterpartyError(
              `rail ${terms.price.rail} has no matching normative payment phase`,
            );
          }
          const matchingKinds = [
            ...new Set(matching.map((phase) => phase.kind)),
          ];
          if (matchingKinds.length !== 1) {
            throw new CounterpartyError(
              `rail ${terms.price.rail} must select exactly one normative payment ` +
                `phase kind; found ${matchingKinds.length}`,
            );
          }
          // DACS-4 PIPE-5 permits repeated invocations of the same phase kind.
          // SettlementEvidence carries the phase kind, not an invocation id,
          // so identical repetitions remain unambiguous here.
          return matchingKinds[0]!;
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
      runtime.legacyComponentSignatures === "accept-unverified"
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
    match: (v: Record<string, unknown>) => Match | Promise<Match>,
    build: () => Promise<object>,
    expectedComponentSigner?: string,
    knownLookup?: AnchorLookup,
    recoveredSeparator?: string,
    preserveSignatureForMatch = false,
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
      const m = await match(
        preserveSignatureForMatch ? existing : stripSignature(existing),
      );
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
    const builtMatch = await match(
      preserveSignatureForMatch
        ? built
        : stripSignature(built),
    );
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
    const builtCanonical = canonicalize(built);
    const rawRef = await deps.anchor(name, publication);
    const ref = protocolString(rawRef, `anchor result for "${name}"`, {
      allowColon: true,
    });
    if (
      canonicalize(built) !== builtCanonical ||
      canonicalize(publication) !== builtCanonical
    ) {
      throw new SubstrateError(
        `anchor for "${name}" mutated the signed artifact; refusing to continue`,
      );
    }
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
    if (!isSessionSettlementEvidence(v))
      return { ok: false, reason: "not settlement evidence" };
    const e = v as SessionSettlementEvidence;
    if (e.jobId !== jobId)
      return { ok: false, reason: `jobId ${e.jobId} ≠ ${jobId}` };
    if (e.phase !== paymentEvidencePhase)
      return {
        ok: false,
        reason: `payment phase ${e.phase} ≠ ${paymentEvidencePhase}`,
      };
    if ("phaseIndex" in e && e.phaseIndex !== 0)
      return { ok: false, reason: `phaseIndex ${e.phaseIndex} ≠ 0` };
    if (!e.paymentAmount)
      return { ok: false, reason: "settlement evidence has no payment amount" };
    if (e.paymentAmount.amount !== terms.price.amount)
      return { ok: false, reason: "settled amount mismatch" };
    if (e.paymentAmount.currency !== terms.price.asset)
      return { ok: false, reason: "settled currency mismatch" };
    const paymentTxRefs = e.paymentTxRefs ?? [];
    if (paymentTxRefs.length !== 1) {
      return {
        ok: false,
        reason: `session settlement evidence must carry exactly one transaction ref (got ${paymentTxRefs.length})`,
      };
    }
    if (e.outcome === "success") {
      const settlementFinality = e.settlementFinality;
      if (!settlementFinality) {
        return { ok: false, reason: "successful evidence has no finality" };
      }
      if (
        paymentTxRefs.some(
          (ref) => {
            if (isChainTxRef(ref)) return false;
            return ref.rail.trim().length === 0 ||
              ref.txHash.trim().length === 0 ||
              ref.kind.trim().length === 0;
          },
        )
      ) {
        return {
          ok: false,
          reason: "successful evidence has an empty transaction-ref component",
        };
      }
      if (!isSettlementFinalityModel(settlementFinality.model)) {
        return { ok: false, reason: "unrecognized settlement finality model" };
      }
      if (
        settlementFinality.model === "block-depth" &&
        settlementFinality.finalityBlocks !== undefined &&
        (!Number.isSafeInteger(settlementFinality.finalityBlocks) ||
          settlementFinality.finalityBlocks < 0)
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
    const agreementName = legacyMvpSessionAnchorName.agreement(jobId);
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
    const agreementName = legacyMvpSessionAnchorName.agreement(jobId);
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

    const evidenceName = legacyMvpSessionAnchorName.evidence(jobId);
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

  const matchSessionBundle = (v: Record<string, unknown>): Match => {
    if (!isAttestationBundle(v)) {
      return { ok: false, reason: "not an attestation bundle" };
    }
    const bundle = v as unknown as AttestationBundle;
    if (bundle.jobId !== jobId) {
      return { ok: false, reason: `jobId ${bundle.jobId} ≠ ${jobId}` };
    }
    if (!sameListingPin(bundle.listingRef, listingView.pin)) {
      return {
        ok: false,
        reason:
          `listing pin ${describeListingPin(bundle.listingRef)} ≠ ` +
          describeListingPin(listingView.pin),
      };
    }
    return { ok: true };
  };

  // A completed bundle already carries the exact LR-1 tuple. Check it before
  // Vet or settlement on an explicit resume, rather than discovering a stale
  // job/listing pairing only after payment evidence has been processed.
  if (requestedResumeJobId !== undefined) {
    const bundleName = legacyMvpSessionAnchorName.bundle(jobId);
    let resumedBundle: AnchorLookup;
    try {
      resumedBundle = snapshotAnchorLookup(
        await runtime.resolveAnchor(bundleName),
        `resume bundle lookup for ${bundleName}`,
      );
    } catch {
      throw new SubstrateError(
        `resume: bundle lookup for "${bundleName}" returned a live, malformed, or non-canonical result`,
      );
    }
    if (resumedBundle.status === "indeterminate") {
      throw new SubstrateError(
        `resume: could not determine whether "${bundleName}" is already anchored ` +
          `(${resumedBundle.reason}); refusing to proceed with a potentially stale Listing pin`,
      );
    }
    if (resumedBundle.status === "present") {
      const match = matchSessionBundle(
        stripSignature(resumedBundle.value) as Record<string, unknown>,
      );
      if (!match.ok) {
        throw new CounterpartyError(
          `resume: artifact anchored at ${resumedBundle.ref} does not match the ` +
            `requested deal: ${match.reason}`,
        );
      }
    }
  }

  // Vet (DACS-2): verify the seller before paying. Abort before settlement if
  // verification fails — never pay a seller that didn't clear the recipe.
  let vetRef: string | undefined;
  let vetValue: Record<string, unknown> | undefined;
  if (runtime.vet) {
    if (!runtime.verifyVetRecord) {
      throw new DacsError(
        "runSessionCore requires verifyVetRecord with vet; a shape-only DACS-2 pass cannot authorize payment",
      );
    }
    if (!runtime.authenticateVetFinality) {
      throw new DacsError(
        "runSessionCore requires authenticateVetFinality with vet; a shape-only or unresolved VPC-3 receipt cannot authorize payment",
      );
    }
    const vetRequest: SessionVetRequest = {
      jobId,
      evaluatedParty: listingView.sellerClaim,
    };
    const vetProducer = runtime.vet;
    const strictVetVerifier = runtime.verifyVetRecord;
    const finalityAuthenticator = runtime.authenticateVetFinality;
    const validateVetRecord = async (
      v: Record<string, unknown>,
    ): Promise<VerifiedVetMatch> => {
      if (!isExactJsonRecord(v)) {
        return { ok: false, reason: "not an exact JSON wire record" };
      }
      const candidate = immutableJsonSnapshot(v, "Vet record verification input");
      if (!isCompositeVerificationRecord(candidate)) {
        return { ok: false, reason: "not a current signed verification record" };
      }
      if (candidate.jobId !== jobId) {
        return { ok: false, reason: `vet jobId ${candidate.jobId} ≠ ${jobId}` };
      }
      if (candidate.evaluatedParty !== listingView.sellerClaim) {
        return {
          ok: false,
          reason: `vet party ${candidate.evaluatedParty} ≠ seller ${listingView.sellerClaim}`,
        };
      }
      const rawVerification = await strictVetVerifier(
          immutableSnapshot(candidate, "strict Vet callback input"),
          immutableSnapshot(vetRequest, "strict Vet request input"),
        );
      if (!isExactJsonRecord(rawVerification)) {
        return { ok: false, reason: "strict verifier returned a non-wire verdict" };
      }
      const verification = immutableJsonSnapshot(
        rawVerification as unknown as Record<string, unknown>,
        "strict Vet callback result",
      ) as unknown as StrictCompositeVerification;
      if (verification.status !== "valid") {
        return {
          ok: false,
          reason: `strict vet closure ${verification.status}: ${verification.code}`,
        };
      }
      if (
        contentHash(verification.record as unknown as Record<string, unknown>) !==
          contentHash(candidate) ||
        verification.record.signature.algorithm !== candidate.signature.algorithm ||
        verification.record.signature.signer !== candidate.signature.signer ||
        verification.record.signature.value !== candidate.signature.value
      ) {
        return { ok: false, reason: "strict verifier returned a different record" };
      }
      // Return the exact private snapshot that was recursively verified. Callers
      // must authorize from this value and never re-read resolver-owned bytes
      // after the asynchronous verifier callback.
      return { ok: true, record: candidate };
    };
    const authenticateFinality = async (
      record: CompositeVerificationRecord,
      nativeAddress: string,
      claimed?: FinalizedVetAnchor,
    ): Promise<FinalizedVetAnchor> => {
      const hash = contentHash(record as unknown as Record<string, unknown>);
      const rawAuthenticated = await finalityAuthenticator(
          immutableSnapshot(
            {
              logicalAddress: vetName,
              nativeAddress,
              contentHash: hash,
              record: immutableSnapshot(record, "Vet finality record input"),
              ...(claimed
                ? {
                    claimed: immutableSnapshot(
                      claimed,
                      "Vet claimed finality input",
                    ),
                  }
                : {}),
            },
            "Vet finality authentication request",
          ),
        );
      const authenticated = rawAuthenticated === null
        ? null
        : immutableJsonSnapshot(
            rawAuthenticated as unknown as Record<string, unknown>,
            "authenticated Vet finality",
          ) as unknown as FinalizedVetAnchor;
      if (
        authenticated === null ||
        !isAttestationRef(authenticated.ref) ||
        !isFinalizedVetAnchorReceipt(authenticated.receipt) ||
        authenticated.ref.anchor.locator !== nativeAddress ||
        authenticated.ref.contentHash !== hash ||
        authenticated.receipt.logicalAddress !== vetName ||
        authenticated.receipt.nativeAddress !== nativeAddress ||
        authenticated.receipt.contentHash !== hash
      ) {
        throw new CounterpartyError(
          `Vet finality for ${vetName} was not independently authenticated with exact record/ref/receipt bindings`,
        );
      }
      if (
        claimed &&
        (canonicalize(authenticated.ref) !== canonicalize(claimed.ref) ||
          canonicalize(authenticated.receipt) !== canonicalize(claimed.receipt))
      ) {
        throw new CounterpartyError(
          `Vet producer's claimed finality for ${vetName} differs from the independently authenticated receipt`,
        );
      }
      return authenticated;
    };
    const vetName = legacyMvpSessionAnchorName.vet(jobId, listingView.sellerClaim);
    let durable = snapshotAnchorLookup(
      await runtime.resolveAnchor(vetName),
      `Vet lookup for ${vetName}`,
    );
    let claimedFinality: FinalizedVetAnchor | undefined;
    if (durable.status === "indeterminate") {
      throw new SubstrateError(
        `resume: could not establish finalized Vet anchor ${vetName}: ${durable.reason}`,
      );
    }
    if (durable.status === "absent") {
      const rawProduction = await vetProducer(
        immutableSnapshot(vetRequest, "Vet producer request"),
      );
      const production = immutableJsonSnapshot(
        rawProduction as unknown as Record<string, unknown>,
        "Vet production",
      ) as unknown as VetProduction;
      if (
        !isCompositeVerificationRecord(production.record) ||
        !isAttestationRef(production.recordRef) ||
        !isFinalizedVetAnchorReceipt(production.anchorReceipt) ||
        production.recordRef.anchor.locator !==
          production.anchorReceipt.nativeAddress ||
        production.recordRef.contentHash !==
          contentHash(
            production.record as unknown as Record<string, unknown>,
          ) ||
        production.anchorReceipt.logicalAddress !== vetName ||
        production.anchorReceipt.contentHash !== production.recordRef.contentHash
      ) {
        throw new CounterpartyError(
          "Vet producer did not return an exact finalized record/ref/receipt binding",
        );
      }
      claimedFinality = immutableSnapshot(
        {
          ref: production.recordRef,
          receipt: production.anchorReceipt,
        },
        "Vet producer claimed finality",
      );
      const producedMatch = await validateVetRecord(
        production.record as unknown as Record<string, unknown>,
      );
      if (!producedMatch.ok) {
        throw new CounterpartyError(
          `Vet producer returned an unsafe record: ${producedMatch.reason}`,
        );
      }
      // The producer promises an independently readable finalized SR-2 write.
      // Resolve it again by the canonical logical address and authorize money
      // only from those durable exact bytes—not from its in-memory return.
      durable = snapshotAnchorLookup(
        await runtime.resolveAnchor(vetName),
        `Vet finalized readback for ${vetName}`,
      );
      if (durable.status !== "present") {
        throw new SubstrateError(
          `Vet producer returned before ${vetName} was independently readable`,
        );
      }
      if (
        durable.ref !== production.recordRef.anchor.locator ||
        canonicalize(durable.value) !== canonicalize(production.record)
      ) {
        throw new CounterpartyError(
          "durable Vet readback differs from the producer's finalized record",
        );
      }
    }
    const durableRef = durable.ref;
    const durableMatch = await validateVetRecord(durable.value);
    if (!durableMatch.ok) {
      throw new CounterpartyError(
        `durable Vet record is unsafe: ${durableMatch.reason}`,
      );
    }
    // VPC-3 money gate: a structurally plausible producer receipt and a present
    // CVR are both insufficient. The caller-held seam must independently
    // recover/authenticate finality on every run, including resume.
    const authenticatedFinality = await authenticateFinality(
      durableMatch.record,
      durableRef,
      claimedFinality,
    );
    vetRef = authenticatedFinality.ref.anchor.locator;
    vetValue = immutableSnapshot(
      durableMatch.record as unknown as Record<string, unknown>,
      "verified durable Vet record",
    );
    const record = durableMatch.record;
    // Proceed only on an explicit pass — fail, indeterminate and error all abort
    // (indeterminate/error are NOT pass; DACS-2 §7.7).
    if (record.overallDecision !== "pass") {
      throw new CounterpartyError(
        `seller ${listingView.sellerClaim} did not pass verification (decision=${record.overallDecision})`,
      );
    }
  }

  // Negotiate (fixed-price): accept the listed terms.
  const { ref: agreementRef, value: agreementValue } = await anchorOnce(
    legacyMvpSessionAnchorName.agreement(jobId),
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
        buyer: runtime.buyerId,
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
  const store = runtime.sessionStore;
  if (store) {
    const loaded = await store.load(jobId);
    if (loaded.status === "corrupt" || loaded.status === "unsupported") {
      throw new CounterpartyError(
        `session ${jobId} durable state is ${loaded.status}; refusing to settle (fail-closed)`,
      );
    }
    if (loaded.status === "missing") {
      await store.create({ jobId, agreementHash, phase: "negotiated", now: runtime.nowMs() });
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
      now: runtime.nowMs(),
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
      checkpoint: {
        key: "settle:0",
        stage: "outcome",
        data: durableSettlementCheckpointData(outcome),
      },
      now: runtime.nowMs(),
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
    legacyMvpSessionAnchorName.evidence(jobId),
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
      // Current rails that return a discriminated ChainTxRef emit normative
      // DACS-4 evidence. Historical/custom rails remain inside the explicit
      // phaseIndex compatibility envelope until they acquire an exact current
      // transaction identity; both forms remain readable on restart.
      const currentTxRef = settlementTxRefFromDurable(settlement);
      const evidenceBase = {
        evidenceVersion: "1" as const,
        jobId,
        // DACS-4 §9.7 carries the PhaseStep kind here. `terms.price.rail` is
        // the independently selected PaymentRailRef.railId and remains the
        // value passed to the rail adapter above.
        phase: paymentEvidencePhase,
        paymentTxRefs: [currentTxRef ?? {
          rail: settlement.chainId,
          txHash: settlement.txHash,
          kind: settlement.txRefKind ?? "payment",
          ...(settlement.blockNumber !== undefined
            ? { blockNumber: settlement.blockNumber }
            : {}),
        }],
        paymentAmount: { amount: terms.price.amount, currency: terms.price.asset },
        observedAt,
      };
      let evidence: Record<string, unknown>;
      if (!settledOk) {
        evidence = currentTxRef
          ? {
              ...evidenceBase,
              outcome: "failure",
              reason: "settlement rail reported definitive failure",
            }
          : { ...evidenceBase, phaseIndex: 0, outcome: "failure" };
      } else {
        const finality = settlementFinalityFromDurable(settlement) ?? {
          model: "provider-receipt" as const,
        };
        const settlementFinality: SettlementFinality = {
          ...finality,
          finalityObservedAt: settlement.finalityObservedAt ?? observedAt,
        };
        evidence = currentTxRef
          ? { ...evidenceBase, outcome: "success", settlementFinality }
          : {
              ...evidenceBase,
              phaseIndex: 0,
              outcome: "success",
              settlementFinality,
            };
      }
      return signSessionArtifact(
        evidence,
        ARTIFACT_SEPARATORS.SettlementEvidence,
      );
    },
    deps.buyerId,
    recoveredEvidence,
    ARTIFACT_SEPARATORS.SettlementEvidence,
    true,
  );
  if (evidenceExisting) {
    // Reused a prior settlement — take the outcome from the anchored evidence.
    const unsignedEvidence = stripSignature(
      evidenceValue,
    ) as unknown as SessionSettlementEvidence;
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
      const tx = unsignedEvidence.paymentTxRefs?.[0];
      if (!tx) {
        throw new CounterpartyError(
          `authenticated evidence at ${settlementRef} has no transaction reference`,
        );
      }
      const txIdentity = settlementIdentityFromTxRef(tx);
      const evidenceOutcome: AuthenticatedEvidenceSettlementOutcome = {
        outcomeSource: "authenticated-evidence",
        ...expectedSettlementBinding,
        evidenceRef: settlementRef,
        evidenceContentHash: contentHash(
          unsignedEvidence as unknown as Record<string, unknown>,
        ),
        evidenceSigner: signature.signer,
        txHash: txIdentity.txHash,
        chainId: txIdentity.chainId,
        txRefKind: txIdentity.kind,
        ...(txIdentity.blockNumber !== undefined
          ? { blockNumber: txIdentity.blockNumber }
          : {}),
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
    // The surrounding bundle is still the explicit legacy-MVP shape, but a
    // newly written vet entry names the actual native composite anchor so it
    // remains resolvable after the move to the normative §7.7 logical address.
    const vetAttRef = refTo("dacs-2-composite", vetRef, vetValue);
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
      | Array<LegacyMvpTxRef | ChainTxRef>
      | undefined
  )?.map((txRef) => structuredClone(txRef));
  phaseSummary.push({
    index: phaseSummary.length,
    kind: "settle",
    outcome: settledOk ? "ok" : "fail",
    ...(evidenceTxRefs ? { txRefs: evidenceTxRefs } : {}),
    attestationRef: evidenceRef,
  });

  const { ref: bundleRef } = await anchorOnce(
    legacyMvpSessionAnchorName.bundle(jobId),
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
          // The buyer's party. bundleHash remains the reduced-MVP stand-in until
          // #140's normative IdentityBundle hash is wired into this legacy path.
          {
            role: "buyer",
            bundleHash: sha256Hex(runtime.buyerId),
            primaryClaim: runtime.buyerId,
          },
          // A current Vet record carries the exact IdentityBundle hash it
          // evaluated. Retain that party binding in DACS-5 so a recursive
          // verifier can reject CVR replay across parties or identity bundles.
          ...(vetValue && isCompositeVerificationRecord(vetValue)
            ? [
                {
                  role: "seller",
                  bundleHash: vetValue.bundleHash,
                  primaryClaim: listingView.sellerClaim,
                },
              ]
            : []),
        ],
        phaseSummary,
        vetRecords,
        settlementEvidence: [evidenceRef],
        recipeRegistryVersion: 1,
        railRegistryVersion: 1,
        finalisedAt: runtime.nowMs(),
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
            party: runtime.buyerId,
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
      now: runtime.nowMs(),
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
