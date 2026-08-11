import {
  canonicalize,
  contentHash,
  encodeAddressSegment,
  sha256Hex,
  stripSignature,
} from "../canonical/index.js";
import { signedBytes } from "../crypto/index.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import {
  isComponentSignature,
  signComponentArtifact,
} from "../artifacts/signatures.js";
import { CounterpartyError, DacsError, SubstrateError } from "../errors.js";
import type { SessionLoad, SessionReceipt, SessionStore } from "./sessionStore.js";
import type {
  CompositeVerificationRecord,
  ListingPin,
  Price,
  SettlementFinality,
  SettlementFinalityModel,
} from "../artifacts/types.js";
import {
  isVerifiedListingAdmission,
  type ListingValidationResult,
} from "./listingValidation.js";
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
  isAttestationRef,
  isExactJsonRecord,
  readListingArtifact,
} from "../artifacts/validators.js";
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function snapshotCanonicalArtifact(
  value: unknown,
): { value: Record<string, unknown>; canonical: string } | null {
  let snapshot: unknown;
  try {
    snapshot = structuredClone(value);
    if (!isRecord(snapshot)) return null;
    return { value: snapshot, canonical: canonicalize(snapshot) };
  } catch {
    return null;
  }
}

/** Freeze the isolated effect input so an adapter cannot rewrite it in place. */
function deepFreezeJson<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeJson(child, seen);
  }
  return Object.freeze(value);
}

function snapshotSessionTerms(value: unknown): SessionTerms | null {
  let snapshot: unknown;
  try {
    snapshot = structuredClone(value);
  } catch {
    return null;
  }
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return null;
  }
  const candidate = snapshot as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => ![
    "price",
    "deliveryPhase",
    "deliveryFormat",
  ].includes(key)) ||
      typeof candidate.deliveryPhase !== "string" ||
      candidate.deliveryPhase.length === 0 ||
      typeof candidate.deliveryFormat !== "string" ||
      candidate.deliveryFormat.length === 0 ||
      candidate.price === null || typeof candidate.price !== "object" ||
      Array.isArray(candidate.price)) return null;
  const price = candidate.price as Record<string, unknown>;
  if (Object.keys(price).some((key) => ![
    "amount",
    "asset",
    "decimals",
    "rail",
  ].includes(key)) ||
      typeof price.amount !== "string" || price.amount.length === 0 ||
      typeof price.asset !== "string" || price.asset.length === 0 ||
      typeof price.rail !== "string" || price.rail.length === 0 ||
      typeof price.decimals !== "number" ||
      !Number.isSafeInteger(price.decimals) || price.decimals < 0) return null;
  return snapshot as SessionTerms;
}

export interface SettleRequest {
  rail: string;
  amount: string;
  asset: string;
  payee: string;
  jobId: string;
  /**
   * The settlement phase index — part of the `(railId, jobId, phaseIndex)`
   * idempotency key a rail dedupes on (#43). Defaults to 0 (the single MVP
   * settle phase) when the caller omits it.
   */
  phaseIndex?: number;
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
   * Restart-safe recovery for a previously claimed settlement whose SessionStore
   * still carries only `settle:intent`.
   *
   * This MUST use the original `(rail, jobId, phaseIndex)` idempotency binding,
   * return the prior definitive result when payment landed, resubmit only after a
   * rail query proves no payment landed, and throw while state is indeterminate.
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
  /** Fresh job id (e.g. crypto.randomUUID). */
  newJobId: () => string;
  /** Current ISO-8601 timestamp (used where the spec field is a string). */
  now: () => string;
  /** Current unix-ms timestamp (used where the spec field is a number). */
  nowMs: () => number;
  /**
   * Verify the anchored listing before ANY action is taken on it (#41). Receives
   * the raw stored artifact (signature intact) and the seller claim it advertises;
   * must return true only if the signature verifies AND binds to that seller.
   *
   * This is enforced INDEPENDENTLY of discovery: a session may be handed a ref
   * that never passed through `discover`, and the listing drives vetting, rail
   * and recipient selection, and payment. Verification therefore happens before
   * the vet step and before settlement — a forged listing must never reach the
   * money path. REQUIRED unless `trustListing` is set.
   */
  verifyListing?: (
    raw: Record<string, unknown>,
    sellerClaim: string,
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
 * Deterministic anchor names for a session's artifacts, keyed by jobId. The
 * address derived from each name IS the session's storage slot for that phase —
 * shared between runSessionCore (write/resume) and verifyBundle (dereference).
 */
export const sessionAnchorName = {
  vet: (jobId: string, evaluatedParty?: string) =>
    evaluatedParty
      ? `dacs2:composite:${encodeAddressSegment(jobId)}:${encodeAddressSegment(evaluatedParty)}`
      : `dacs2:verifyrecord:${encodeAddressSegment(jobId)}`, // explicit pre-§7.7 read compatibility only
  agreement: (jobId: string) => `dacs3:agreement:${jobId}`,
  evidence: (jobId: string) => `dacs4:evidence:${jobId}`,
  bundle: (jobId: string) => `dacs5:bundle:${jobId}`,
};

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

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === required.length &&
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function snapshotAnchorLookup(value: AnchorLookup, label: string): AnchorLookup {
  const captured = immutableJsonSnapshot(
    value as unknown as Record<string, unknown>,
    label,
  );
  if (
    captured.status === "absent" &&
    exactKeys(captured, ["status"])
  ) {
    return captured as unknown as AnchorLookup;
  }
  if (
    captured.status === "indeterminate" &&
    exactKeys(captured, ["status", "reason"]) &&
    typeof captured.reason === "string" &&
    captured.reason.length > 0
  ) {
    return captured as unknown as AnchorLookup;
  }
  if (
    captured.status === "present" &&
    exactKeys(captured, ["status", "ref", "value"]) &&
    typeof captured.ref === "string" &&
    captured.ref.length > 0 &&
    isExactJsonRecord(captured.value)
  ) {
    return captured as unknown as AnchorLookup;
  }
  throw new CounterpartyError(`${label} has an invalid lookup result`);
}

/**
 * Capture a stateful SessionStore's methods without cloning/freezing the store
 * itself. This prevents an asynchronous caller from swapping authorization
 * methods while preserving class/user-adapter `this` behavior and live state.
 */
function captureSessionStore(store: SessionStore | undefined): SessionStore | undefined {
  if (!store) return undefined;
  return Object.freeze({
    create: store.create.bind(store),
    load: store.load.bind(store),
    transition: store.transition.bind(store),
    claimCheckpoint: store.claimCheckpoint.bind(store),
    acquireLease: store.acquireLease.bind(store),
    bindHash: store.bindHash.bind(store),
    list: store.list.bind(store),
  });
}

interface DurableSettlementOutcome {
  txHash: string;
  chainId: string;
  ok: boolean;
  finalityModel?: SettlementFinalityModel;
  finalityBlocks?: number;
  blockNumber?: number;
  txRefKind?: string;
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

function durableSettlementOutcome(result: SettleResult): DurableSettlementOutcome {
  const ok = result.ok && result.txHash.trim().length > 0;
  return {
    txHash: result.txHash,
    chainId: result.chainId,
    ok,
    ...(result.finality ? { finalityModel: result.finality.model } : {}),
    ...(result.finality?.finalityBlocks !== undefined
      ? { finalityBlocks: result.finality.finalityBlocks }
      : {}),
    ...(result.blockNumber !== undefined ? { blockNumber: result.blockNumber } : {}),
    ...(result.txRefKind !== undefined ? { txRefKind: result.txRefKind } : {}),
  };
}

function sameSettlementOutcome(
  left: DurableSettlementOutcome,
  right: DurableSettlementOutcome,
): boolean {
  return (
    left.txHash === right.txHash &&
    left.chainId === right.chainId &&
    left.ok === right.ok &&
    left.finalityModel === right.finalityModel &&
    left.finalityBlocks === right.finalityBlocks &&
    left.blockNumber === right.blockNumber &&
    left.txRefKind === right.txRefKind
  );
}

/**
 * Extract the most recent settlement OUTCOME write-ahead checkpoint from a
 * loaded session — the reconciliation point a resumed run reads to avoid
 * re-paying after a crash between payment and evidence anchoring (#52).
 */
function findSettleOutcome(
  load: SessionLoad,
): DurableSettlementOutcome | undefined {
  if (load.status !== "ok") return undefined;
  const { checkpoints } = load.record;
  for (let i = checkpoints.length - 1; i >= 0; i--) {
    const cp = checkpoints[i];
    if (!cp || cp.key !== "settle:0" || cp.stage !== "outcome" || !cp.data) continue;
    const {
      txHash,
      chainId,
      ok,
      finalityModel,
      finalityBlocks,
      blockNumber,
      txRefKind,
    } = cp.data;
    if (typeof txHash === "string" && typeof ok === "boolean") {
      return {
        txHash,
        chainId: typeof chainId === "string" ? chainId : "",
        ok,
        ...(isSettlementFinalityModel(finalityModel) ? { finalityModel } : {}),
        ...(typeof finalityBlocks === "number" ? { finalityBlocks } : {}),
        ...(typeof blockNumber === "number" ? { blockNumber } : {}),
        ...(typeof txRefKind === "string" ? { txRefKind } : {}),
      };
    }
  }
  return undefined;
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
  terms: SessionTerms,
  deps: SessionDeps,
  resumeJobId?: string,
): Promise<SessionResult> {
  // Capture every caller-controlled policy value and callable before the first
  // await. Methods stay bound to the original object, while later property
  // swaps on `deps` cannot redirect listing admission, vetting, or payment.
  const runtime = Object.freeze({
    buyerId: immutableSnapshot(deps.buyerId, "buyer id"),
    legacyComponentSignatures: deps.legacyComponentSignatures,
    trustListing: deps.trustListing,
    readListing: deps.readListing.bind(deps),
    sign: deps.sign.bind(deps),
    signBytes: deps.signBytes.bind(deps),
    anchor: deps.anchor.bind(deps),
    resolveAnchor: deps.resolveAnchor.bind(deps),
    settle: deps.settle.bind(deps),
    resumeSettlement: deps.resumeSettlement?.bind(deps),
    vet: deps.vet?.bind(deps),
    verifyVetRecord: deps.verifyVetRecord?.bind(deps),
    authenticateVetFinality: deps.authenticateVetFinality?.bind(deps),
    newJobId: deps.newJobId.bind(deps),
    now: deps.now.bind(deps),
    nowMs: deps.nowMs.bind(deps),
    verifyListing: deps.verifyListing?.bind(deps),
    validateListing: deps.validateListing?.bind(deps),
    sessionStore: captureSessionStore(deps.sessionStore),
  });
  const sessionTerms = snapshotSessionTerms(terms);
  if (!sessionTerms) {
    throw new DacsError("runSessionCore requires cloneable, well-formed fixed terms");
  }
  const requestedListingRef = immutableSnapshot(listingRef, "listing ref");
  const requestedResumeJobId = immutableSnapshot(resumeJobId, "resume job id");
  let stored: Record<string, unknown>;
  try {
    // Own the resolver result before the first validation await. The exact
    // Listing admitted by DPA-1 must remain the Listing that drives terms,
    // rail selection and payment.
    const returned = await runtime.readListing(requestedListingRef);
    if (!isExactJsonRecord(returned)) throw new TypeError("non-wire Listing");
    stored = immutableJsonSnapshot(returned, "stored listing");
  } catch {
    throw new Error(`listing not found or invalid at ${requestedListingRef}`);
  }
  const storedRecord = stored;
  const readableListing = readListingArtifact(storedRecord);
  if (!readableListing) {
    throw new Error(`listing not found or invalid at ${requestedListingRef}`);
  }
  let listingView: {
    sellerClaim: string;
    supportedPaymentRails: string[];
    supportedDelivery: string[];
    pin: ListingPin;
  };

  if (readableListing.compatibility === "normative") {
    if (!runtime.validateListing) {
      throw new DacsError(
        "runSessionCore requires deps.validateListing for normative DACS-1 Listings; " +
          "LR-3 permits new sessions only when the disposition is verified",
      );
    }
    let validation: ListingValidationResult;
    try {
      validation = structuredClone(
        await runtime.validateListing(structuredClone(storedRecord)),
      );
    } catch {
      throw new CounterpartyError(
        `listing at ${requestedListingRef} validation was indeterminate (validator threw)`,
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
  } else {
    listingView = {
      sellerClaim: readableListing.listing.agentId,
      supportedPaymentRails: readableListing.listing.supportedPaymentRails,
      supportedDelivery: readableListing.listing.supportedDelivery,
      pin: {
        listingId: readableListing.listing.serviceId,
        version: readableListing.listing.listingVersion ?? 1,
        contentHash: contentHash(storedRecord),
      },
    };
  }

  // #41 — verify the listing BEFORE vetting, rail selection or settlement. A
  // forged/tampered listing steers the recipient and rail, so an unverified one
  // must never reach the money path. Fails closed; the gate is not defaultable.
  if (
    readableListing.compatibility === "legacy-mvp" &&
    !runtime.verifyListing &&
    !runtime.trustListing
  ) {
    throw new DacsError(
      "runSessionCore requires deps.verifyListing or an explicit deps.trustListing: true opt-out — " +
        "acting on an unverified listing lets a forged listing drive payment (#41)",
    );
  }
  if (runtime.verifyListing) {
    let verified = false;
    try {
      verified = (await runtime.verifyListing(
        immutableSnapshot(stored, "listing verifier input"),
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
  }

  if (!listingView.supportedPaymentRails.includes(sessionTerms.price.rail)) {
    throw new Error(`rail ${sessionTerms.price.rail} not offered by the listing`);
  }
  const paymentEvidencePhase =
    readableListing.compatibility === "normative"
      ? (() => {
          const matching = readableListing.listing.pipeline.filter(
            (phase) =>
              phase.kind.startsWith("pay-") &&
              phase.parameters?.rail === sessionTerms.price.rail,
          );
          const matchingKinds = [
            ...new Set(matching.map((phase) => phase.kind)),
          ];
          if (matchingKinds.length !== 1) {
            throw new CounterpartyError(
              `rail ${sessionTerms.price.rail} must select exactly one normative payment ` +
                `phase kind; found ${matchingKinds.length}`,
            );
          }
          // DACS-4 PIPE-5 permits repeated invocations of the same phase kind.
          // SettlementEvidence carries the phase kind, not an invocation id,
          // so identical repetitions remain unambiguous here.
          return matchingKinds[0]!;
        })()
      : sessionTerms.price.rail;
  if (!listingView.supportedDelivery.includes(sessionTerms.deliveryPhase)) {
    throw new Error(`delivery ${sessionTerms.deliveryPhase} not offered by the listing`);
  }

  // A caller-supplied jobId resumes an interrupted session; otherwise fresh.
  const jobId = requestedResumeJobId ?? runtime.newJobId();

  const signSessionArtifact = <T extends object>(
    artifact: T,
    separator: Parameters<typeof signComponentArtifact>[1],
  ) =>
    signComponentArtifact(artifact, separator, {
      algorithm: "ed25519",
      signer: runtime.buyerId,
      sign: (bytes) => runtime.signBytes(bytes),
    });

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
    preserveSignatureForMatch = false,
  ): Promise<{ ref: string; value: Record<string, unknown>; existing: boolean }> => {
    // Resolve BY NAME (the address can't be recomputed). Fail closed on an
    // indeterminate lookup: proceeding as if absent could re-anchor a duplicate
    // or, for evidence, defeat the no-double-pay guard and settle twice (#70).
    let found: AnchorLookup;
    try {
      found = snapshotAnchorLookup(
        await runtime.resolveAnchor(name),
        `anchor lookup for ${name}`,
      );
    } catch {
      throw new SubstrateError(
        `resume: anchor lookup for "${name}" returned a live, malformed, or non-canonical result`,
      );
    }
    if (found.status === "indeterminate") {
      throw new SubstrateError(
        `resume: could not determine whether "${name}" is already anchored (${found.reason}); ` +
          `refusing to proceed rather than risk a duplicate anchor or double settlement`,
      );
    }
    if (found.status === "present") {
      if (expectedComponentSigner) {
        const signatureMatch = storedComponentSignatureMatches(
          found.value,
          expectedComponentSigner,
        );
        if (!signatureMatch.ok) {
          throw new CounterpartyError(
            `resume: artifact anchored at ${found.ref} has unacceptable signature: ${signatureMatch.reason}`,
          );
        }
      }
      const m = await match(
        preserveSignatureForMatch ? found.value : stripSignature(found.value),
      );
      if (!m.ok) {
        throw new CounterpartyError(
          `resume: artifact anchored at ${found.ref} does not match the requested deal: ${m.reason}`,
        );
      }
      return { ref: found.ref, value: found.value, existing: true };
    }
    // `build` can cross a public signer/verifier boundary. Own its result
    // immediately, then apply the SAME semantic and signer checks used for a
    // resumed artifact. This prevents a signer from swapping admitted terms in
    // the object it returns and prevents an invalid artifact from being written
    // merely because this is the first run rather than a resume.
    const builtSnapshot = snapshotCanonicalArtifact(await build());
    if (!builtSnapshot) {
      throw new CounterpartyError(
        `new artifact for "${name}" was live, malformed, or non-canonical`,
      );
    }
    if (expectedComponentSigner) {
      const signatureMatch = storedComponentSignatureMatches(
        builtSnapshot.value,
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
        ? builtSnapshot.value
        : stripSignature(builtSnapshot.value),
    );
    if (!builtMatch.ok) {
      throw new CounterpartyError(
        `new artifact for "${name}" does not match the requested deal: ${builtMatch.reason}`,
      );
    }

    // Give the irreversible anchor effect a separate, read-only clone. Even a
    // retaining or mutating adapter cannot alter the retained signed artifact
    // subsequently hashed into evidence/bundle refs. Re-check both copies after
    // the await as defense against an adapter that tried to rewrite its input.
    const anchorInput = deepFreezeJson(
      structuredClone(builtSnapshot.value),
    );
    const ref = await runtime.anchor(name, anchorInput);
    if (typeof ref !== "string" || ref.length === 0) {
      throw new SubstrateError(`anchor for "${name}" returned an invalid ref`);
    }
    if (
      canonicalize(builtSnapshot.value) !== builtSnapshot.canonical ||
      canonicalize(anchorInput) !== builtSnapshot.canonical
    ) {
      throw new SubstrateError(
        `anchor for "${name}" mutated the signed artifact; refusing to continue`,
      );
    }
    return { ref, value: builtSnapshot.value, existing: false };
  };

  const pricesEqual = (a: Price, b: Price): boolean =>
    a.amount === b.amount &&
    a.asset === b.asset &&
    a.decimals === b.decimals &&
    a.rail === b.rail;

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
    const vetName = sessionAnchorName.vet(jobId, listingView.sellerClaim);
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
    sessionAnchorName.agreement(jobId),
    (v) => {
      if (!isAgreementDocument(v))
        return { ok: false, reason: "not an agreement" };
      const a = v as unknown as AgreementDocument;
      if (a.jobId !== jobId)
        return { ok: false, reason: `jobId ${a.jobId} ≠ ${jobId}` };
      if (a.buyer !== runtime.buyerId)
        return { ok: false, reason: `buyer ${a.buyer} ≠ ${runtime.buyerId}` };
      if (a.seller !== listingView.sellerClaim)
        return { ok: false, reason: `seller ${a.seller} ≠ ${listingView.sellerClaim}` };
      if (a.listingRef !== requestedListingRef)
        return { ok: false, reason: `listingRef ${a.listingRef} ≠ ${requestedListingRef}` };
      if (!pricesEqual(a.price, sessionTerms.price))
        return { ok: false, reason: "price mismatch" };
      if (
        a.delivery.phase !== sessionTerms.deliveryPhase ||
        a.delivery.format !== sessionTerms.deliveryFormat
      )
        return { ok: false, reason: "delivery mismatch" };
      return { ok: true };
    },
    () => {
      const agreement: AgreementDocument = {
        jobId,
        pattern: "negotiate-fixed-price",
        buyer: runtime.buyerId,
        seller: listingView.sellerClaim,
        listingRef: requestedListingRef,
        // Keep the signed artifact isolated from the immutable comparison
        // baseline: an untrusted signer may mutate its input before returning.
        price: structuredClone(sessionTerms.price),
        delivery: {
          phase: sessionTerms.deliveryPhase,
          format: sessionTerms.deliveryFormat,
        },
        expiresAt: runtime.now(),
      };
      return runtime.sign(agreement, ARTIFACT_SEPARATORS.AgreementDocument);
    },
  );

  // The agreement's content hash is this deal's anti-replay key.
  const agreementHash = contentHash(stripSignature(agreementValue as Record<string, unknown>));

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
      const bound = await store.bindHash({ hash: agreementHash, jobId, kind: "agreement" });
      if (!bound.ok) {
        throw new CounterpartyError(
          `agreement hash for ${jobId} is bound to ${bound.boundTo} (anti-replay); refusing to settle`,
        );
      }
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
    | { status: "completed"; outcome?: DurableSettlementOutcome }
  > => {
    if (!store) return { status: "claimed" };
    const res = await store.claimCheckpoint({
      jobId,
      key: "settle:0",
      data,
      phase: "settling",
      now: runtime.nowMs(),
    });
    if (res.ok) return { status: "claimed" };
    if (res.reason === "completed") {
      return {
        status: "completed",
        outcome: res.record
          ? findSettleOutcome({ status: "ok", record: res.record })
          : undefined,
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
    outcome: DurableSettlementOutcome,
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
    const prior = findSettleOutcome(cur);
    if (prior) {
      if (sameSettlementOutcome(prior, outcome)) return;
      throw new CounterpartyError(
        `could not record settlement outcome for ${jobId}: existing outcome conflicts with ${outcome.txHash}`,
      );
    }
    const res = await store.transition({
      jobId,
      expectedRevision: cur.record.revision,
      phase,
      checkpoint: { key: "settle:0", stage: "outcome", data: { ...outcome } },
      now: runtime.nowMs(),
    });
    if (res.ok) return;

    // A reconciler and the original worker may race to write the same outcome.
    // Accept the winner only when it wrote byte-equivalent settlement metadata.
    if (res.reason === "revision-mismatch") {
      const latest = await store.load(jobId);
      const recorded = findSettleOutcome(latest);
      if (recorded && sameSettlementOutcome(recorded, outcome)) return;
    }
    throw new CounterpartyError(
      `could not record settlement outcome for ${jobId}: transition failed (${res.reason})`,
    );
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
    (v) => {
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
      if (!e.paymentAmount)
        return { ok: false, reason: "settlement evidence has no payment amount" };
      if (e.paymentAmount.amount !== sessionTerms.price.amount)
        return { ok: false, reason: "settled amount mismatch" };
      if (e.paymentAmount.currency !== sessionTerms.price.asset)
        return { ok: false, reason: "settled currency mismatch" };
      return { ok: true };
    },
    async () => {
      const settleRequest: SettleRequest = {
        rail: sessionTerms.price.rail,
        amount: sessionTerms.price.amount,
        asset: sessionTerms.price.asset,
        payee: listingView.sellerClaim,
        jobId,
        phaseIndex: 0,
      };
      // Reconcile across a crash (#52): if a prior run already PAID — recorded a
      // `settle:outcome` write-ahead — but crashed before the evidence was
      // anchored, rebuild the evidence from the recorded tx ref instead of paying
      // again. Without this the anchoring guard alone would re-pay in that window.
      const prior = store ? findSettleOutcome(await store.load(jobId)) : undefined;
      let settlement: DurableSettlementOutcome;
      let needsOutcomeCheckpoint = false;
      if (prior) {
        settlement = prior;
      } else {
        // CLAIM the settlement phase via the intent checkpoint's atomic CAS, AND
        // write-ahead the intent, BEFORE the irreversible payment. A lost claim
        // means a concurrent worker already advanced this phase — abort rather than
        // settle twice (#67). (When no store is wired this always claims.)
        const claim = await claimSettlement({
          rail: sessionTerms.price.rail,
          agreementHash,
        });
        if (claim.status === "completed" && claim.outcome) {
          settlement = claim.outcome;
        } else if (claim.status === "held") {
          if (!runtime.resumeSettlement) {
            throw new CounterpartyError(
              `settlement for ${jobId} has an unresolved intent; ` +
                `resumeSettlement is required to reconcile the durable rail outcome`,
            );
          }
          // PC-7 recovery: this seam is explicitly contracted to reuse the original
          // rail idempotency binding, adopt a landed payment, and resubmit only when
          // the rail proves no payment landed. It is safe where ordinary `settle`
          // would be an unproven second submission.
          const recovered = await runtime.resumeSettlement(settleRequest);
          settlement = durableSettlementOutcome(recovered);
          needsOutcomeCheckpoint = true;
        } else if (claim.status === "completed") {
          throw new CounterpartyError(
            `settlement for ${jobId} is marked completed without a valid durable outcome`,
          );
        } else {
          const pay = await runtime.settle(settleRequest);
          // Defense in depth (independent of the rail): a settlement is only a
          // success if it produced a verifiable on-chain tx id. A rail reporting
          // ok:true with no txHash cannot back a provider-receipt claim.
          settlement = durableSettlementOutcome(pay);
          needsOutcomeCheckpoint = true;
        }
      }
      settledOk = settlement.ok;

      // Binding first closes the outcome→binding crash window. The call is also
      // made for replayed outcomes, so any historical residue is self-healed.
      await bindSettlementTransaction(settlement);
      if (needsOutcomeCheckpoint) {
        await completeSettlement(settlement, settledOk ? "settled" : "failed");
      }
      const observedAt = runtime.nowMs();
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
        paymentAmount: {
          amount: sessionTerms.price.amount,
          currency: sessionTerms.price.asset,
        },
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
    runtime.buyerId,
  );
  if (evidenceExisting) {
    // Reused a prior settlement — take the outcome from the anchored evidence.
    settledOk =
      (stripSignature(evidenceValue) as { outcome?: unknown }).outcome ===
      "success";
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
      // Signed scope omits signatures + anchoredByRole (§10.4.1).
      const scope = { ...body };
      delete scope.anchoredByRole;
      const hash = contentHash(scope);
      const sig = await runtime.signBytes(
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
