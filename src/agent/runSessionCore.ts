import { contentHash, sha256Hex, stripSignature } from "../canonical/index.js";
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
import type { ListingValidationResult } from "./listingValidation.js";
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
  const stored = await deps.readListing(listingRef);
  if (stored == null || typeof stored !== "object" || Array.isArray(stored)) {
    throw new Error(`listing not found or invalid at ${listingRef}`);
  }
  const storedRecord = stored as Record<string, unknown>;
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

  if (readableListing.compatibility === "normative") {
    const now = deps.nowMs();
    const validity = readableListing.listing.validity;
    if (now < validity.notBefore || (validity.notAfter !== undefined && now > validity.notAfter)) {
      throw new CounterpartyError(
        `listing ${listing.pin.listingId} v${listing.pin.version} is outside its DACS-1 §6.3.4 validity window`,
      );
    }
  }

  const listingView: {
    sellerClaim: string;
    supportedPaymentRails: string[];
    supportedDelivery: string[];
    pin: ListingPin;
  } = listing;

  if (readableListing.compatibility === "normative") {
    if (!deps.validateListing) {
      throw new DacsError(
        "runSessionCore requires deps.validateListing for normative DACS-1 Listings; " +
          "LR-3 permits new sessions only when the disposition is verified",
      );
    }
    let validation: ListingValidationResult;
    try {
      validation = await deps.validateListing(storedRecord);
    } catch {
      throw new CounterpartyError(
        `listing at ${listingRef} validation was indeterminate (validator threw)`,
      );
    }
    if (validation.disposition !== "verified") {
      throw new CounterpartyError(
        `listing at ${listingRef} is ${validation.disposition} at DACS-1 reader step ` +
          `${validation.step} (${validation.reason}); LR-3 refuses the new session`,
      );
    }
    if (validation.listingContentHash !== listingView.pin.contentHash) {
      throw new CounterpartyError(
        `listing at ${listingRef} validation result is not bound to the exact LR-1 ` +
          `content hash; refusing the new session`,
      );
    }
  }

  // #41 — verify the listing BEFORE vetting, rail selection or settlement. A
  // forged/tampered listing steers the recipient and rail, so an unverified one
  // must never reach the money path. Fails closed; the gate is not defaultable.
  if (
    readableListing.compatibility === "legacy-mvp" &&
    !deps.verifyListing &&
    !deps.trustListing
  ) {
    throw new DacsError(
      "runSessionCore requires deps.verifyListing or an explicit deps.trustListing: true opt-out — " +
        "acting on an unverified listing lets a forged listing drive payment (#41)",
    );
  }
  if (deps.verifyListing) {
    let verified = false;
    try {
      verified = await deps.verifyListing(
        stored as Record<string, unknown>,
        listingView.sellerClaim,
      );
    } catch {
      verified = false; // a throwing verifier is not a pass
    }
    if (!verified) {
      throw new CounterpartyError(
        `listing at ${listingRef} failed signature verification for seller ${listingView.sellerClaim} (#41)`,
      );
    }
  }

  if (!listingView.supportedPaymentRails.includes(terms.price.rail)) {
    throw new Error(`rail ${terms.price.rail} not offered by the listing`);
  }
  if (!listingView.supportedDelivery.includes(terms.deliveryPhase)) {
    throw new Error(`delivery ${terms.deliveryPhase} not offered by the listing`);
  }

  // A caller-supplied jobId resumes an interrupted session; otherwise fresh.
  const jobId = resumeJobId ?? deps.newJobId();

  const signSessionArtifact = <T extends object>(
    artifact: T,
    separator: Parameters<typeof signComponentArtifact>[1],
  ) =>
    signComponentArtifact(artifact, separator, {
      algorithm: "ed25519",
      signer: deps.buyerId,
      sign: (bytes) => deps.signBytes(bytes),
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
  ): Promise<{ ref: string; value: Record<string, unknown>; existing: boolean }> => {
    // Resolve BY NAME (the address can't be recomputed). Fail closed on an
    // indeterminate lookup: proceeding as if absent could re-anchor a duplicate
    // or, for evidence, defeat the no-double-pay guard and settle twice (#70).
    const found = await deps.resolveAnchor(name);
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
      const m = match(stripSignature(found.value));
      if (!m.ok) {
        throw new CounterpartyError(
          `resume: artifact anchored at ${found.ref} does not match the requested deal: ${m.reason}`,
        );
      }
      return { ref: found.ref, value: found.value, existing: true };
    }
    const built = (await build()) as Record<string, unknown>;
    const ref = await deps.anchor(name, built);
    return { ref, value: built, existing: false };
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
          await deps.vet!(listingView.sellerClaim),
          ARTIFACT_SEPARATORS.CompositeVerificationRecord,
        ),
      deps.buyerId,
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
    (v) => {
      if (!isAgreementDocument(v))
        return { ok: false, reason: "not an agreement" };
      const a = v as unknown as AgreementDocument;
      if (a.jobId !== jobId)
        return { ok: false, reason: `jobId ${a.jobId} ≠ ${jobId}` };
      if (a.buyer !== deps.buyerId)
        return { ok: false, reason: `buyer ${a.buyer} ≠ ${deps.buyerId}` };
      if (a.seller !== listingView.sellerClaim)
        return { ok: false, reason: `seller ${a.seller} ≠ ${listingView.sellerClaim}` };
      if (a.listingRef !== listingRef)
        return { ok: false, reason: `listingRef ${a.listingRef} ≠ ${listingRef}` };
      if (!pricesEqual(a.price, terms.price))
        return { ok: false, reason: "price mismatch" };
      if (
        a.delivery.phase !== terms.deliveryPhase ||
        a.delivery.format !== terms.deliveryFormat
      )
        return { ok: false, reason: "delivery mismatch" };
      return { ok: true };
    },
    () => {
      const agreement: AgreementDocument = {
        jobId,
        pattern: "negotiate-fixed-price",
        buyer: deps.buyerId,
        seller: listingView.sellerClaim,
        listingRef,
        price: terms.price,
        delivery: { phase: terms.deliveryPhase, format: terms.deliveryFormat },
        expiresAt: deps.now(),
      };
      return deps.sign(agreement, ARTIFACT_SEPARATORS.AgreementDocument);
    },
  );

  // The agreement's content hash is this deal's anti-replay key.
  const agreementHash = contentHash(stripSignature(agreementValue as Record<string, unknown>));

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
      now: deps.nowMs(),
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
      now: deps.nowMs(),
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
      if (e.phase !== terms.price.rail)
        return { ok: false, reason: `rail ${e.phase} ≠ ${terms.price.rail}` };
      if (!e.paymentAmount)
        return { ok: false, reason: "settlement evidence has no payment amount" };
      if (e.paymentAmount.amount !== terms.price.amount)
        return { ok: false, reason: "settled amount mismatch" };
      if (e.paymentAmount.currency !== terms.price.asset)
        return { ok: false, reason: "settled currency mismatch" };
      return { ok: true };
    },
    async () => {
      const settleRequest: SettleRequest = {
        rail: terms.price.rail,
        amount: terms.price.amount,
        asset: terms.price.asset,
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
        const claim = await claimSettlement({ rail: terms.price.rail, agreementHash });
        if (claim.status === "completed" && claim.outcome) {
          settlement = claim.outcome;
        } else if (claim.status === "held") {
          if (!deps.resumeSettlement) {
            throw new CounterpartyError(
              `settlement for ${jobId} has an unresolved intent; ` +
                `resumeSettlement is required to reconcile the durable rail outcome`,
            );
          }
          // PC-7 recovery: this seam is explicitly contracted to reuse the original
          // rail idempotency binding, adopt a landed payment, and resubmit only when
          // the rail proves no payment landed. It is safe where ordinary `settle`
          // would be an unproven second submission.
          const recovered = await deps.resumeSettlement(settleRequest);
          settlement = durableSettlementOutcome(recovered);
          needsOutcomeCheckpoint = true;
        } else if (claim.status === "completed") {
          throw new CounterpartyError(
            `settlement for ${jobId} is marked completed without a valid durable outcome`,
          );
        } else {
          const pay = await deps.settle(settleRequest);
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
        phase: terms.price.rail,
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
      // Signed scope omits signatures + anchoredByRole (§10.4.1).
      const scope = { ...body };
      delete scope.anchoredByRole;
      const hash = contentHash(scope);
      const sig = await deps.signBytes(
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
