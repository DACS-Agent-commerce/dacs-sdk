/**
 * Explicit compatibility boundary for artifacts emitted by early dacs-sdk MVP
 * releases before DACS-Standard#308 / Standard PR #310 reconciled the §14
 * oracle with the normative reference shapes.
 *
 * These types are READ/RESUME compatibility only. New protocol surfaces MUST
 * use `AttestationRef`, `ChainTxRef`, `SettlementEvidence`, and the bundle types
 * from `./types.ts` (DACS-2 §7.5.2; DACS-4 §9.3/§9.7; DACS-5 §10.4).
 */
import type {
  ArtifactSignature,
  BundleParty,
  BundlePhaseErrorClass,
  BundlePhaseOutcome,
  BundleSignature,
  Delivery,
  ListingRef,
  PaymentAmount,
  Price,
  SettlementFinality,
} from "./types.js";

/** Pre-normative buyer-only agreement emitted by early runSessionCore releases. */
export interface LegacyMvpAgreementDocument {
  jobId: string;
  pattern: string;
  buyer: string;
  seller: string;
  listingRef: string;
  price: Price;
  delivery: Delivery;
  expiresAt: string;
  signature?: unknown;
}

export interface LegacyMvpAttestationRef {
  kind: string;
  id: string;
  contentHash: string;
}

export interface LegacyMvpTxRef {
  rail: string;
  txHash: string;
  kind: string;
  blockNumber?: number;
}

interface LegacyMvpSettlementEvidenceBase {
  evidenceVersion: "1";
  jobId: string;
  phase: string;
  phaseIndex: number;
  paymentTxRefs: LegacyMvpTxRef[];
  observedAt: number;
  signature?: ArtifactSignature;
}

export type LegacyMvpSettlementEvidence =
  | (LegacyMvpSettlementEvidenceBase & {
      outcome: "success";
      paymentAmount: PaymentAmount;
      settlementFinality: SettlementFinality;
    })
  | (LegacyMvpSettlementEvidenceBase & {
      outcome: "failure";
      reason?: string;
      paymentAmount?: PaymentAmount;
      settlementFinality?: never;
    });

export interface LegacyMvpPhaseSummaryEntry {
  index: number;
  kind: string;
  outcome: BundlePhaseOutcome;
  errorClass?: BundlePhaseErrorClass;
  txRefs?: LegacyMvpTxRef[];
  attestationRef?: LegacyMvpAttestationRef;
}

interface LegacyMvpBundleFields {
  jobId: string;
  outcome: string;
  anchoredByRole?: "buyer" | "seller" | "orchestrator";
  listingRef: ListingRef;
  agreementRef?: LegacyMvpAttestationRef;
  cancellation?: { claimedPolicy: string };
  parties: BundleParty[];
  phaseSummary: LegacyMvpPhaseSummaryEntry[];
  vetRecords: LegacyMvpAttestationRef[];
  settlementEvidence: LegacyMvpAttestationRef[];
  amendments?: LegacyMvpAttestationRef[];
  ratingRefs?: LegacyMvpAttestationRef[];
  recipeRegistryVersion: number;
  railRegistryVersion: number;
  finalisedAt: number;
  signatures?: BundleSignature[];
}

export interface LegacyMvpAttestationBundle extends LegacyMvpBundleFields {
  bundleVersion: "1";
  faultBundleVersion?: never;
  faultedParty?: never;
}

export interface LegacyMvpFaultAttestationBundle extends LegacyMvpBundleFields {
  faultBundleVersion: "1";
  faultedParty: "buyer" | "seller" | "orchestrator" | "none";
  bundleVersion?: never;
}

export type LegacyMvpAnyAttestationBundle =
  | LegacyMvpAttestationBundle
  | LegacyMvpFaultAttestationBundle;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function isLegacyMvpAgreementDocument(
  value: unknown,
): value is LegacyMvpAgreementDocument {
  if (!isRecord(value)) return false;
  const price = value.price;
  const delivery = value.delivery;
  return (
    isString(value.jobId) &&
    isString(value.pattern) &&
    isString(value.buyer) &&
    isString(value.seller) &&
    isString(value.listingRef) &&
    isRecord(price) &&
    isString(price.amount) &&
    isString(price.asset) &&
    isNumber(price.decimals) &&
    isString(price.rail) &&
    isRecord(delivery) &&
    isString(delivery.phase) &&
    isString(delivery.format) &&
    isString(value.expiresAt)
  );
}

export function isLegacyMvpAttestationRef(
  value: unknown,
): value is LegacyMvpAttestationRef {
  return (
    isRecord(value) &&
    isString(value.kind) &&
    isString(value.id) &&
    isString(value.contentHash)
  );
}

export function isLegacyMvpTxRef(value: unknown): value is LegacyMvpTxRef {
  return (
    isRecord(value) &&
    isString(value.rail) &&
    isString(value.txHash) &&
    isString(value.kind) &&
    (value.blockNumber === undefined || isNumber(value.blockNumber))
  );
}

export function isLegacyMvpSettlementEvidence(
  value: unknown,
): value is LegacyMvpSettlementEvidence {
  if (!isRecord(value)) return false;
  const finality = value.settlementFinality;
  const amount = value.paymentAmount;
  const base =
    value.evidenceVersion === "1" &&
    isString(value.jobId) &&
    isString(value.phase) &&
    isNumber(value.phaseIndex) &&
    (value.outcome === "success" || value.outcome === "failure") &&
    Array.isArray(value.paymentTxRefs) &&
    value.paymentTxRefs.every(isLegacyMvpTxRef) &&
    isNumber(value.observedAt);
  if (!base) return false;
  if (value.outcome === "failure") return finality === undefined;
  return (
    isRecord(amount) &&
    isString(amount.amount) &&
    isString(amount.currency) &&
    isRecord(finality) &&
    isString(finality.model) &&
    isNumber(finality.finalityObservedAt)
  );
}

function hasLegacyMvpBundleFields(value: Record<string, unknown>): boolean {
  const listing = value.listingRef;
  return (
    isString(value.jobId) &&
    isString(value.outcome) &&
    isRecord(listing) &&
    isString(listing.listingId) &&
    isNumber(listing.version) &&
    isString(listing.contentHash) &&
    (value.agreementRef === undefined ||
      isLegacyMvpAttestationRef(value.agreementRef)) &&
    Array.isArray(value.parties) &&
    Array.isArray(value.phaseSummary) &&
    value.phaseSummary.every(
      (phase) =>
        isRecord(phase) &&
        isNumber(phase.index) &&
        isString(phase.kind) &&
        (phase.outcome === "ok" || phase.outcome === "fail") &&
        (phase.txRefs === undefined ||
          (Array.isArray(phase.txRefs) &&
            phase.txRefs.every(isLegacyMvpTxRef))) &&
        (phase.attestationRef === undefined ||
          isLegacyMvpAttestationRef(phase.attestationRef)),
    ) &&
    Array.isArray(value.vetRecords) &&
    value.vetRecords.every(isLegacyMvpAttestationRef) &&
    Array.isArray(value.settlementEvidence) &&
    value.settlementEvidence.every(isLegacyMvpAttestationRef) &&
    isNumber(value.recipeRegistryVersion) &&
    isNumber(value.railRegistryVersion) &&
    isNumber(value.finalisedAt)
  );
}

export function isLegacyMvpAttestationBundle(
  value: unknown,
): value is LegacyMvpAttestationBundle {
  return (
    isRecord(value) &&
    value.bundleVersion === "1" &&
    value.faultBundleVersion === undefined &&
    value.faultedParty === undefined &&
    hasLegacyMvpBundleFields(value)
  );
}

export function isLegacyMvpFaultAttestationBundle(
  value: unknown,
): value is LegacyMvpFaultAttestationBundle {
  return (
    isRecord(value) &&
    value.faultBundleVersion === "1" &&
    value.bundleVersion === undefined &&
    (value.faultedParty === "buyer" ||
      value.faultedParty === "seller" ||
      value.faultedParty === "orchestrator" ||
      value.faultedParty === "none") &&
    hasLegacyMvpBundleFields(value)
  );
}

export function isLegacyMvpAnyAttestationBundle(
  value: unknown,
): value is LegacyMvpAnyAttestationBundle {
  return (
    isLegacyMvpAttestationBundle(value) ||
    isLegacyMvpFaultAttestationBundle(value)
  );
}
