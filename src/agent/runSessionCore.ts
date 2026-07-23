import { contentHash, sha256Hex, stripSignature } from "../canonical/index.js";
import { signedBytes } from "../crypto/index.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import { CounterpartyError, SubstrateError } from "../errors.js";
import type {
  AgreementDocument,
  AttestationBundle,
  AttestationRef,
  CompositeVerificationRecord,
  PhaseSummaryEntry,
  Price,
  SettlementEvidence,
} from "../artifacts/types.js";
import {
  isAgreementDocument,
  isAttestationBundle,
  isCompositeVerificationRecord,
  isListing,
  isSettlementEvidence,
} from "../artifacts/validators.js";

/**
 * Pure orchestration for the MVP buyer session (T4 runSession): negotiate
 * (fixed-price) → settle → verify, producing + anchoring the AgreementDocument,
 * SettlementEvidence, and AttestationBundle. Identify is implicit (the buyer's
 * id) and vet is a seam. Settlement execution is injected (`settle`) so the rail
 * integration is pluggable and this is testable.
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
}

export interface SettleResult {
  ok: boolean;
  txHash: string;
  chainId: string;
  payer: string;
  payee: string;
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
  /** Sign an artifact under a separator, returning the signed envelope. */
  sign: (artifact: object, separator: string) => Promise<object>;
  /** Sign raw bytes (for artifacts whose signature shape the core assembles, e.g. the bundle). */
  signBytes: (bytes: Uint8Array) => Promise<Uint8Array>;
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
  /** Execute payment on the chosen rail. */
  settle: (req: SettleRequest) => Promise<SettleResult>;
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
}

export interface SessionResult {
  outcome: "completed" | "failed";
  jobId: string;
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

export async function runSessionCore(
  listingRef: string,
  terms: SessionTerms,
  deps: SessionDeps,
  resumeJobId?: string,
): Promise<SessionResult> {
  const stored = await deps.readListing(listingRef);
  if (stored == null || !isListing(stripSignature(stored as Record<string, unknown>))) {
    throw new Error(`listing not found or invalid at ${listingRef}`);
  }
  const listing = stripSignature(stored as Record<string, unknown>) as unknown as {
    agentId: string;
    supportedPaymentRails: string[];
    supportedDelivery: string[];
  };

  if (!listing.supportedPaymentRails.includes(terms.price.rail)) {
    throw new Error(`rail ${terms.price.rail} not offered by the listing`);
  }
  if (!listing.supportedDelivery.includes(terms.deliveryPhase)) {
    throw new Error(`delivery ${terms.deliveryPhase} not offered by the listing`);
  }

  // A caller-supplied jobId resumes an interrupted session; otherwise fresh.
  const jobId = resumeJobId ?? deps.newJobId();

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
        if (r.subject !== listing.agentId)
          return {
            ok: false,
            reason: `vet subject ${r.subject} ≠ seller ${listing.agentId}`,
          };
        return { ok: true };
      },
      async () =>
        deps.sign(
          await deps.vet!(listing.agentId),
          ARTIFACT_SEPARATORS.CompositeVerificationRecord,
        ),
    );
    vetRef = ref;
    vetValue = value;
    const record = stripSignature(value) as unknown as CompositeVerificationRecord;
    // Proceed only on an explicit pass — fail, indeterminate and error all abort
    // (indeterminate/error are NOT pass; DACS-2 §7.7).
    if (record.decision !== "pass") {
      throw new CounterpartyError(
        `seller ${listing.agentId} did not pass verification (recipe ${record.recipeId}, decision=${record.decision})`,
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
      if (a.seller !== listing.agentId)
        return { ok: false, reason: `seller ${a.seller} ≠ ${listing.agentId}` };
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
        seller: listing.agentId,
        listingRef,
        price: terms.price,
        delivery: { phase: terms.deliveryPhase, format: terms.deliveryFormat },
        expiresAt: deps.now(),
      };
      return deps.sign(agreement, ARTIFACT_SEPARATORS.AgreementDocument);
    },
  );

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
      if (e.paymentAmount.amount !== terms.price.amount)
        return { ok: false, reason: "settled amount mismatch" };
      if (e.paymentAmount.currency !== terms.price.asset)
        return { ok: false, reason: "settled currency mismatch" };
      return { ok: true };
    },
    async () => {
      const pay = await deps.settle({
        rail: terms.price.rail,
        amount: terms.price.amount,
        asset: terms.price.asset,
        payee: listing.agentId,
        jobId,
      });
      // Defense in depth (independent of the rail): a settlement is only a
      // success if it produced a verifiable on-chain tx id. A rail reporting
      // ok:true with no txHash cannot back a provider-receipt claim.
      settledOk = pay.ok && pay.txHash.trim().length > 0;
      const observedAt = deps.nowMs();
      // DACS-4 SettlementEvidence (spec shape). The rail's reported chain id +
      // tx hash become a payment txRef. Finality is the rail's receipt
      // (§9.7 `provider-receipt`) — the rail seam confirms via receipt, not
      // block depth, so finalityBlocks is 0.
      const evidence: SettlementEvidence = {
        evidenceVersion: "1",
        jobId,
        phase: terms.price.rail,
        phaseIndex: 0,
        outcome: settledOk ? "success" : "failure",
        paymentTxRefs: [
          { rail: pay.chainId, txHash: pay.txHash, kind: "payment" },
        ],
        paymentAmount: { amount: terms.price.amount, currency: terms.price.asset },
        settlementFinality: {
          model: "provider-receipt",
          finalityBlocks: 0,
          finalityObservedAt: observedAt,
        },
        observedAt,
      };
      return deps.sign(evidence, ARTIFACT_SEPARATORS.SettlementEvidence);
    },
  );
  if (evidenceExisting) {
    // Reused a prior settlement — take the outcome from the anchored evidence.
    settledOk =
      (stripSignature(evidenceValue) as { outcome?: unknown }).outcome ===
      "success";
  }

  // Verify (DACS-5): assemble + sign + anchor the attestation bundle in the
  // spec shape. MVP emits the one-sided form (the buyer's copy) — spec-valid
  // per DACS-VERIFY-L3-ONE-SIDED; the seller-side copy / two-sided reconcile is
  // a follow-up. Refs are content-addressed; registry versions are pinned at 1.
  const outcome: SessionResult["outcome"] = settledOk ? "completed" : "failed";
  const listingScope = stripSignature(stored as Record<string, unknown>);
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
        listingRef: {
          listingId: (listingScope as { serviceId?: string }).serviceId ?? jobId,
          version: 1,
          contentHash: contentHash(listingScope),
        },
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

  return { outcome, jobId, vetRef, agreementRef, settlementRef, bundleRef };
}
