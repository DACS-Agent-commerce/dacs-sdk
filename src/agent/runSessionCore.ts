import { contentHash, sha256Hex, stripSignature } from "../canonical/index.js";
import { signedBytes } from "../crypto/index.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import { CounterpartyError } from "../errors.js";
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
  /** Deterministic storage address for a name (without writing) — for resume. */
  anchorAddress: (name: string) => Promise<string>;
  /** Read the artifact anchored at an address (null if absent) — for resume. */
  readAnchor: (address: string) => Promise<Record<string, unknown> | null>;
  /** Execute payment on the chosen rail. */
  settle: (req: SettleRequest) => Promise<SettleResult>;
  /**
   * Optional Vet step: verify the seller before paying. Returns a
   * CompositeVerificationRecord; if requiredPassed is false the session aborts
   * before settlement. Omit to skip vetting.
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
   * Anchor `build()` under `name` only if a valid artifact isn't already there.
   * Returns the ref + the artifact now at that ref (reused or freshly built) so
   * callers can content-hash it for the bundle's refs.
   */
  const anchorOnce = async (
    name: string,
    isValid: (v: Record<string, unknown>) => boolean,
    build: () => Promise<object>,
  ): Promise<{ ref: string; value: Record<string, unknown>; existing: boolean }> => {
    const address = await deps.anchorAddress(name);
    const existing = await deps.readAnchor(address);
    if (existing && isValid(stripSignature(existing))) {
      return { ref: address, value: existing, existing: true };
    }
    const built = (await build()) as Record<string, unknown>;
    const ref = await deps.anchor(name, built);
    return { ref, value: built, existing: false };
  };

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
      `dacs2:verifyrecord:${jobId}`,
      isCompositeVerificationRecord,
      async () =>
        deps.sign(
          await deps.vet!(listing.agentId),
          ARTIFACT_SEPARATORS.CompositeVerificationRecord,
        ),
    );
    vetRef = ref;
    vetValue = value;
    const record = stripSignature(value) as unknown as CompositeVerificationRecord;
    if (record.requiredPassed !== true) {
      throw new CounterpartyError(
        `seller ${listing.agentId} failed verification (recipe ${record.recipeId})`,
      );
    }
  }

  // Negotiate (fixed-price): accept the listed terms.
  const { ref: agreementRef, value: agreementValue } = await anchorOnce(
    `dacs3:agreement:${jobId}`,
    isAgreementDocument,
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
    `dacs4:evidence:${jobId}`,
    isSettlementEvidence,
    async () => {
      const pay = await deps.settle({
        rail: terms.price.rail,
        amount: terms.price.amount,
        asset: terms.price.asset,
        payee: listing.agentId,
        jobId,
      });
      settledOk = pay.ok;
      const observedAt = deps.nowMs();
      // DACS-4 SettlementEvidence (spec shape). The rail's reported chain id +
      // tx hash become a payment txRef; finality is recorded as observed (the
      // rail seam doesn't surface depth yet — finalityBlocks 0).
      const evidence: SettlementEvidence = {
        evidenceVersion: "1",
        jobId,
        phase: terms.price.rail,
        phaseIndex: 0,
        outcome: pay.ok ? "success" : "failed",
        paymentTxRefs: [
          { rail: pay.chainId, txHash: pay.txHash, kind: "payment" },
        ],
        paymentAmount: { amount: terms.price.amount, currency: terms.price.asset },
        settlementFinality: {
          model: "observed",
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
    `dacs5:bundle:${jobId}`,
    isAttestationBundle,
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
