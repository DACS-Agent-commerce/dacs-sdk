import { randomBytes } from "node:crypto";

import type {
  ComponentSignatureAlgorithm,
  IdentityBundle,
  Listing,
  ListingRef,
  PaymentRailRef,
  VerificationMethod,
} from "../artifacts/types.js";
import {
  assertPositiveAmount,
  baseUnits,
  canonicalize,
  contentHash,
  sha256Hex,
} from "../canonical/index.js";
import {
  demosAddressFromClaim,
  normalizeDemosNativeAddress,
  DEM_CURRENCY,
  DEM_DECIMALS,
} from "../rails/payDem.js";
import {
  isVerifiedListingAdmission,
  type ListingValidationResult,
} from "../agent/listingValidation.js";
import {
  isIdentityBundle,
  isPayeeBoundAgreementDocument,
} from "../artifacts/validators.js";
import { identityBundleHash } from "../identity/bundle.js";
import { validateFixedPriceAgreementBinding } from "../negotiate/commitment.js";
import {
  verifyX402ReceiptClaim,
  type X402ResponseHeader,
} from "./x402Receipt.js";

export type SellerPaymentIntakeDisposition =
  | "verified"
  | "rejected"
  | "indeterminate"
  | "error";

export type SellerFulfilmentPermit = "claim" | "already-claimed" | "none";

export type SellerSessionBindingGuarantee = "established" | "not-established";

/** DACS-4 §9.7 exact pay-DEM `ChainTxRef`. */
export interface SellerDemosTxRef {
  kind: "demos";
  txHash: string;
  blockNumber?: number;
}

/** DACS-4 §9.7 exact pay-x402 `ChainTxRef`. */
export interface SellerX402TxRef {
  kind: "x402";
  httpResource: string;
  paymentReceiptHash: string;
  settlementTxHash?: string;
  chainId?: number;
  protocolVersion: string;
}

export type SellerPaymentTxRef = SellerDemosTxRef | SellerX402TxRef;

export type SellerPaymentFinality =
  | { model: "bft-final"; finalityObservedAt: number }
  | {
      model: "block-depth";
      finalityBlocks: number;
      finalityObservedAt: number;
    };

/**
 * Unsigned, exact DACS-4 §9.7 success evidence input. `phaseIndex` is
 * intentionally absent: SB-1 recovers it from the PC-2 evidence address.
 */
export interface SellerPaymentEvidenceInput {
  evidenceVersion: "1";
  jobId: string;
  phase: "pay-dem" | "pay-x402";
  outcome: "success";
  paymentTxRefs: [SellerPaymentTxRef];
  paymentAmount: { amount: string; currency: string; unit?: string };
  settlementFinality: SellerPaymentFinality;
  observedAt: number;
}

export type SellerPaymentClaim =
  | { kind: "pay-dem"; txHash: string }
  | {
      kind: "pay-x402";
      protocolVersion: string;
      responseHeader: X402ResponseHeader;
      httpResource: string;
      paymentReceiptHash: string;
      settlementTxHash?: string;
      chainId?: number;
    };

export interface SellerPaymentIntakeInput {
  jobId: string;
  phaseIndex: number;
  railId: string;
  /** DACS-4 §9.5.1 payingKey; it must occur in the committed buyer bundle. */
  payerPayingKey: string;
  receipt: SellerPaymentClaim;
}

/**
 * Operational projection of a verified/finalized DACS-3 §8.6 commitment.
 * This is not a signed SDK artifact. Before returning `verified`, the injected
 * resolver MUST verify the actual `FinalityCommitmentRecord` and both required
 * Agreement party signatures, including signer/party binding, as required by
 * DACS-3 CA-7. Structural Agreement validation or hash matching alone is not
 * sufficient. The resolver then returns the fields the intake gate consumes.
 */
export type CommittedAgreementResolution =
  | {
      disposition: "verified";
      agreement: Record<string, unknown>;
      agreementHash: string;
      commitment: {
        finality: "finalized";
        /** Authenticated SR-2 reference and signature-omitting record hash. */
        ref: string;
        contentHash: string;
        jobId: string;
        agreementHash: string;
        listingRef: ListingRef;
        committedAt: number;
      };
      /** Verified DACS-5 SessionRecord rail-registry pin. */
      railRegistryVersion: number;
    }
  | { disposition: "rejected" | "indeterminate"; reason: string };

/**
 * Local DACS-4 §9.6.3 DPA-1 producer admission captured before commitment.
 * This is operational session state, not a normative signed DACS artifact.
 */
export interface SellerPayloadVerificationProducerAdmission {
  operation: "produce";
  disposition: "supported";
  listingRef: ListingRef;
  verificationMethodKind: VerificationMethod["kind"];
  verificationMethodHash: string;
  deliverableSpecHash: string;
  admittedAt: number;
}

/**
 * One authoritative historical Listing checkpoint. The resolver MUST return
 * the exact raw Listing and the DACS-1 §6.3.4 reader result produced for those
 * bytes atomically with any DPA-1 producer admission captured before the
 * DACS-3 §8.6 commitment. It MUST NOT reconstruct admission from live state.
 */
export interface SellerListingAtCommitResolution {
  rawListing: Record<string, unknown>;
  validation: ListingValidationResult;
  payloadVerificationProducerAdmission?: SellerPayloadVerificationProducerAdmission;
}

export type IdentityBundleResolution =
  | { disposition: "verified"; bundle: IdentityBundle }
  | { disposition: "rejected" | "indeterminate"; reason: string };

interface RailBase {
  railVersion: number;
  railId: string;
  availability: "live" | "operator_gated" | "closed_data" | "bilateral";
}

export interface SellerDemosRailDefinition extends RailBase {
  railType: "demos-native";
  asset: { kind: "native-dem"; symbol: "DEM"; decimals: 9 };
  network: { kind: "demos" };
  phaseHandler: "pay-dem";
  parameters: Record<string, unknown>;
}

export interface SellerX402RailDefinition extends RailBase {
  railType: "x402";
  asset: {
    kind: "erc20";
    chainId: number;
    contract: string;
    symbol: string;
    decimals: number;
  };
  network: { kind: "x402-resource"; resourceBaseUrl: string };
  phaseHandler: "pay-x402";
  parameters: Record<string, unknown> & { finalityBlocks?: number };
}

export type SellerSupportedRailDefinition =
  | SellerDemosRailDefinition
  | SellerX402RailDefinition;

export type SellerRailResolution =
  | {
      disposition: "verified";
      rail: SellerSupportedRailDefinition;
      /** Authenticated registry snapshot from which `rail` was resolved. */
      railRegistryVersion: number;
    }
  | { disposition: "rejected" | "indeterminate"; reason: string };

export type AddressResolution =
  | { disposition: "verified"; address: string }
  | { disposition: "rejected" | "indeterminate"; reason: string };

/** DACS-4 §9.5.1 PB-2 strongest-applicable destination result. */
export type DestinationBindingResolution =
  | { disposition: "bound"; address: string; tier: 2 | 3 }
  | { disposition: "mismatch"; reason: string; tier: 2 | 3 }
  | { disposition: "indeterminate"; reason: string; tier: 2 }
  | { disposition: "error"; reason: string; tier: 2 };

export type DemosTransferObservation =
  | { status: "pending" | "not-found" | "unavailable"; reason?: string }
  | { status: "failed"; reason?: string }
  | {
      status: "included";
      txHash: string;
      payer: string;
      payee: string;
      amountOs: string;
      blockNumber: number;
      includedAt: number;
    };

export type X402SessionBinding =
  | { kind: "eip3009"; nonce: string }
  | { kind: "permit2"; jobId: string }
  | { kind: "absent" }
  | { kind: "unverifiable"; reason: string };

export type X402TransferObservation =
  | { status: "pending" | "not-found" | "unavailable"; reason?: string }
  | { status: "failed"; reason?: string }
  | {
      status: "finalized";
      chainId: number;
      txHash: string;
      logIndex: number;
      payer: string;
      payee: string;
      amountBaseUnits: string;
      asset: { contract: string; symbol: string; decimals: number };
      confirmations: number;
      /** Authenticated timestamp of the settlement event's inclusion block. */
      includedAt: number;
      finalityObservedAt: number;
      sessionBinding: X402SessionBinding;
    };

export interface SellerReceiptClaim {
  settlementId: string;
  jobId: string;
  phaseIndex: number;
  /** DACS-4 SB-2 primary winner key. */
  observedAt: number;
  /** DACS-4 SB-2 tie-breaker and the exact authorization evidence binding. */
  evidenceHash: string;
  authorization: SellerPaymentAuthorization;
}

/**
 * Exact, resumable seller work retained atomically with permit consumption.
 *
 * The receipt store treats this as opaque operational state. The fulfilment
 * core is responsible for deriving and re-validating every binding and the
 * complete candidate before an idempotent submit. Keeping the complete
 * candidate (rather than only its hash) closes the crash window between
 * one-shot permit consumption and the first external delivery effect.
 */
export interface SellerFulfilmentHandoff {
  handoffVersion: "1";
  fulfilmentId: string;
  jobId: string;
  agreementRef: string;
  agreementHash: string;
  commitmentRef: string;
  authorizationHash: string;
  settlementId: string;
  paymentEvidenceHash: string;
  paymentPhaseIndex: number;
  deliveryPhaseIndex: number;
  phase:
    | "deliver-storage-program"
    | "deliver-entitlement"
    | "deliver-attested-payload";
  logicalAddress: string;
  deliverableSpecHash: string;
  /** Canonical hash of the complete authenticated agreement view at consumption. */
  agreementViewHash: string;
  /** Immutable causal floor used when the retained candidate was validated. */
  validationFloorAt: number;
  /** Authenticated SessionRecord phase-orchestrator authority at consumption. */
  evidenceAuthority: {
    primaryClaim: string;
    algorithm: ComponentSignatureAlgorithm;
  };
  candidate:
    | {
        status: "prepared";
        validatedAt: number;
        artifactHash: string;
        delivery: {
          artifact: unknown;
          payloadAttestationRecord?: unknown;
        };
      }
    | {
        status: "preparation-failed";
        validatedAt: number;
        reason: string;
      };
}

export type SellerReceiptClaimResult =
  | {
      /**
       * `already-consumed` is returned only for the exact consumed claim (or
       * its permitted monotonic observation replay). Its permit is a recovery
       * capability for the store-retained work, never authority for a later
       * canonical winner or another conflicting request.
       */
      status: "claimed" | "already-claimed" | "already-consumed";
      permitId: string;
      /** Authoritative store-retained winner for this permit. */
      claim: SellerReceiptClaim;
    }
  | {
      status: "conflict";
      reason:
        | "lower-priority"
        | "winner-already-consumed"
        | "authorization-scope-conflict";
      /** Current canonical SB-2 winner, even if another claim was consumed. */
      existing: SellerReceiptClaim;
      /** Immutable side-effect binding when consumption preceded winner discovery. */
      consumed?: SellerReceiptClaim;
    };

export type SellerReceiptPermitResult =
  | {
      /** Only `consumed` grants this caller the one-shot fulfilment right. */
      status: "consumed" | "already-consumed";
      claim: SellerReceiptClaim;
      /** Immutable work selected by the first successful consumption. */
      handoff: SellerFulfilmentHandoff;
    }
  | { status: "invalid" };

export type SellerReceiptInspectionResult =
  | { status: "available"; claim: SellerReceiptClaim }
  | {
      status: "already-consumed";
      claim: SellerReceiptClaim;
      handoff: SellerFulfilmentHandoff;
    }
  | { status: "invalid" };

/**
 * Authoritative operational payment facts retained behind an opaque permit.
 * The fulfilment boundary consumes this store-backed value instead of trusting
 * a caller-constructible `SellerPaymentIntakeResult`. This is not a signed
 * DACS artifact and MUST NOT be published as one.
 */
export interface SellerPaymentAuthorization {
  jobId: string;
  phaseIndex: number;
  agreementHash: string;
  listingRef: ListingRef;
  railId: string;
  /** Exact authenticated DACS-5 SessionRecord rail-registry snapshot. */
  railRegistryVersion: number;
  /** Exact finalized DACS-3 commitment that existed before payment inclusion. */
  commitment: SellerPaymentCommitmentBinding;
  /** Canonical event-level SB-1 identity retained behind the opaque permit. */
  settlementIdentity: SellerSettlementIdentity;
  settlementId: string;
  evidenceHash: string;
  evidenceInput: SellerPaymentEvidenceInput;
  payoutBindingTier: 1 | 2 | 3;
  sessionBinding?: SellerSessionBindingGuarantee;
  /** Local DPA-1 producer authority; present exactly when the Listing selects DPA. */
  payloadVerificationProducerAdmission?: SellerPayloadVerificationProducerAdmission;
}

export interface SellerPaymentCommitmentBinding {
  ref: string;
  contentHash: string;
  finalizedAt: number;
}

export type SellerSettlementIdentity =
  | {
      kind: "demos";
      txHash: string;
      blockNumber: number;
      includedAt: number;
    }
  | {
      kind: "evm";
      chainId: number;
      txHash: string;
      logIndex: number;
      includedAt: number;
    };

/**
 * Durable implementations MUST make winner selection atomic and MUST commit
 * permit consumption, the retained authorization, and the complete fulfilment
 * handoff in one transaction. Permit ids are bearer capabilities and MUST be
 * unpredictable, confidential, and bound to that retained state. A recovered
 * `already-consumed` permit may resume only the exact retained candidate under
 * the same stable idempotency key; it can never authorize replacement work.
 */
export interface SellerReceiptStore {
  /** The SDK supplies an owned, deeply frozen claim snapshot. */
  claim(input: Readonly<SellerReceiptClaim>): Promise<SellerReceiptClaimResult>;
  /** Atomically retain the exact resumable work with the consumed permit. */
  consumePermit(
    permitId: string,
    handoff: Readonly<SellerFulfilmentHandoff>,
  ): Promise<SellerReceiptPermitResult>;
  /**
   * Read-only fulfilment preflight; this does not grant permission to invoke
   * an effect. Implementations used only for intake need not expose it.
   */
  inspectPermit?(permitId: string): Promise<SellerReceiptInspectionResult>;
}

/** Receipt-store surface required at the fulfilment authorization boundary. */
export interface SellerFulfilmentReceiptStore extends SellerReceiptStore {
  inspectPermit(permitId: string): Promise<SellerReceiptInspectionResult>;
}

export type X402ReceiptExtensionVerification =
  | { disposition: "pass" }
  | {
      disposition: "fail" | "indeterminate" | "error";
      reason: string;
    };

/** Local registry classification used only when a rail omits finalityBlocks. */
export type X402SettlementChainClassification =
  | { disposition: "l2" }
  | { disposition: "unsupported" | "indeterminate" | "error"; reason: string };

/**
 * Every structured callback input is an owned, deeply frozen canonical
 * snapshot. Security-bearing outputs MUST be cloneable plain data; the SDK
 * snapshots them before reading a discriminator or field.
 */
export interface SellerPaymentIntakeDeps {
  /**
   * Trusted CA-7 boundary. A `verified` result MUST mean that the finalized
   * commitment and both Agreement party signatures have been cryptographically
   * verified with their required party bindings; see
   * `CommittedAgreementResolution`.
   */
  resolveCommittedAgreement(jobId: string): Promise<CommittedAgreementResolution>;
  /**
   * Atomic historical DACS-1/DACS-4 admission at commitment time. Later
   * revocation is irrelevant; live capability reconstruction is forbidden.
   */
  resolveListingAtCommit(
    listingRef: ListingRef,
  ): Promise<SellerListingAtCommitResolution>;
  resolveRail(input: {
    ref: PaymentRailRef;
    railRegistryVersion: number;
  }): Promise<SellerRailResolution>;
  resolveIdentityBundle(bundleHash: string): Promise<IdentityBundleResolution>;
  resolvePayerAddress(input: {
    payingKey: string;
    buyerBundle: IdentityBundle;
    rail: SellerX402RailDefinition;
  }): Promise<AddressResolution>;
  resolvePayeeDestination(input: {
    payeePrimaryClaim: string;
    payeeBundle: IdentityBundle;
    payoutAddress: string;
    rail: SellerX402RailDefinition;
  }): Promise<DestinationBindingResolution>;
  observeDemosTransfer(txHash: string): Promise<DemosTransferObservation>;
  observeX402Transfer(input: {
    chainId: number;
    txHash: string;
  }): Promise<X402TransferObservation>;
  /**
   * Verify every recognized signed extension under its owning x402 registry.
   * Unknown/unsigned members remain hash-bound and preserved. DACS does not
   * invent one universal extension-signature schema.
   */
  verifyX402ReceiptExtensions(input: {
    protocolVersion: string;
    receipt: Readonly<Record<string, unknown>>;
  }): Promise<X402ReceiptExtensionVerification> | X402ReceiptExtensionVerification;
  /**
   * Classify a non-mainnet EVM chain using the local authenticated rail/chain
   * registry. DACS-4's one-block default applies only after an `l2` result.
   */
  classifyX402SettlementChain(input: {
    chainId: number;
    rail: Readonly<SellerX402RailDefinition>;
  }): Promise<X402SettlementChainClassification> | X402SettlementChainClassification;
  receiptStore: SellerReceiptStore;
}

export interface SellerPaymentIntakeResult {
  disposition: SellerPaymentIntakeDisposition;
  fulfilment: SellerFulfilmentPermit;
  reason: string;
  /** Exact store-retained scope on claim and consumed-recovery outcomes. */
  jobId?: string;
  phaseIndex?: number;
  agreementHash?: string;
  listingRef?: ListingRef;
  railId?: string;
  railRegistryVersion?: number;
  commitment?: SellerPaymentCommitmentBinding;
  settlementIdentity?: SellerSettlementIdentity;
  settlementId?: string;
  evidenceHash?: string;
  evidenceInput?: SellerPaymentEvidenceInput;
  payoutBindingTier?: 1 | 2 | 3;
  sessionBinding?: SellerSessionBindingGuarantee;
  payloadVerificationProducerAdmission?: SellerPayloadVerificationProducerAdmission;
  /**
   * Audit-only disclosure that another exact authorization was already
   * consumed. This is not fulfilment authority without its bound `permitId`.
   */
  consumedAuthorization?: SellerPaymentAuthorization;
  /** Opaque store capability required by the seller fulfilment boundary. */
  permitId?: string;
}

interface AgreementPartyView {
  role: "buyer" | "seller";
  bundleHash: string;
  primaryClaim: string;
}

interface PayoutBindingView {
  railId: string;
  phaseIndex: number;
  payeeAddress: string;
}

interface AgreementView {
  jobId: string;
  listingRef: ListingRef;
  buyer: AgreementPartyView;
  seller: AgreementPartyView;
  derivedFromPattern: "fixed-price" | "rfq" | "sealed-envelope";
  terms: {
    price: { amount: string; currency: string; unit?: string };
    rail: PaymentRailRef;
    deadline: number;
    deliverable: { deliverableType: string; hash: string; schemaUrl?: string };
    payoutBindings: PayoutBindingView[];
  };
}

const HASH_RE = /^[0-9a-f]{64}$/;
const TX_HASH_RE = /^(?:0[xX])?[0-9a-fA-F]{64}$/;
const INTEGER_RE = /^(0|[1-9][0-9]*)$/;
const VERIFICATION_METHOD_KINDS: ReadonlySet<string> = new Set([
  "verifiable-credential",
  "tlsnotary",
  "zktls",
  "consensus-backed-proxy",
  "oauth-attested",
  "evm-rpc",
  "domain-tls-control",
  "self-signed",
  "demos-gcr-domain",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSafeUint(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 &&
    !Object.is(value, -0);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return Object.keys(value).length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/** Runtime guard for the opaque receipt-store handoff envelope. */
export function isSellerFulfilmentHandoff(
  value: unknown,
): value is SellerFulfilmentHandoff {
  if (!isRecord(value) || !hasExactKeys(value, [
    "handoffVersion",
    "fulfilmentId",
    "jobId",
    "agreementRef",
    "agreementHash",
    "commitmentRef",
    "authorizationHash",
    "settlementId",
    "paymentEvidenceHash",
    "paymentPhaseIndex",
    "deliveryPhaseIndex",
    "phase",
    "logicalAddress",
    "deliverableSpecHash",
    "agreementViewHash",
    "validationFloorAt",
    "evidenceAuthority",
    "candidate",
  ])) return false;
  const nonEmpty = (candidate: unknown): candidate is string =>
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate.trim() === candidate;
  if (
    value.handoffVersion !== "1" ||
    !nonEmpty(value.fulfilmentId) ||
    !nonEmpty(value.jobId) ||
    !nonEmpty(value.agreementRef) ||
    !nonEmpty(value.commitmentRef) ||
    !nonEmpty(value.settlementId) ||
    !nonEmpty(value.logicalAddress) ||
    !HASH_RE.test(value.agreementHash as string) ||
    !HASH_RE.test(value.authorizationHash as string) ||
    !HASH_RE.test(value.paymentEvidenceHash as string) ||
    !HASH_RE.test(value.deliverableSpecHash as string) ||
    !HASH_RE.test(value.agreementViewHash as string) ||
    !isSafeUint(value.validationFloorAt) ||
    !isRecord(value.evidenceAuthority) ||
    !hasExactKeys(value.evidenceAuthority, ["primaryClaim", "algorithm"]) ||
    !nonEmpty(value.evidenceAuthority.primaryClaim) ||
    !["ed25519", "ecdsa-secp256k1", "sr1-aggregate"].includes(
      String(value.evidenceAuthority.algorithm),
    ) ||
    !isSafeUint(value.paymentPhaseIndex) ||
    !isSafeUint(value.deliveryPhaseIndex) ||
    ![
      "deliver-storage-program",
      "deliver-entitlement",
      "deliver-attested-payload",
    ].includes(value.phase as string) ||
    !isRecord(value.candidate)
  ) return false;
  const candidate = value.candidate;
  if (candidate.status === "preparation-failed") {
    if (!hasExactKeys(candidate, ["status", "validatedAt", "reason"]) ||
        !isSafeUint(candidate.validatedAt) || !nonEmpty(candidate.reason)) return false;
  } else if (candidate.status === "prepared") {
    if (!hasExactKeys(candidate, [
      "status",
      "validatedAt",
      "artifactHash",
      "delivery",
    ]) || !isSafeUint(candidate.validatedAt) ||
        !HASH_RE.test(candidate.artifactHash as string) ||
        !isRecord(candidate.delivery) ||
        !hasOnlyKeys(candidate.delivery, ["artifact", "payloadAttestationRecord"]) ||
        !Object.prototype.hasOwnProperty.call(candidate.delivery, "artifact") ||
        !isRecord(candidate.delivery.artifact)) return false;
  } else {
    return false;
  }
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

type SecurityBoundaryResult<T> =
  | { status: "ok"; value: T }
  | { status: "threw" | "invalid-input" | "invalid-output" | "mutated-input" };

function deepFreezeJson<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeJson(child, seen);
  }
  return Object.freeze(value);
}

/** Snapshot a security-bearing callback result before its first property read. */
async function callSecurityBoundary<T>(
  call: () => T | Promise<T>,
): Promise<SecurityBoundaryResult<T>> {
  let raw: unknown;
  try {
    raw = await call();
  } catch {
    return { status: "threw" };
  }
  try {
    return { status: "ok", value: structuredClone(raw) as T };
  } catch {
    return { status: "invalid-output" };
  }
}

/**
 * Give a callback one isolated exact input, snapshot its result immediately,
 * and reject any mutation of the input retained across the asynchronous call.
 */
async function callSecurityBoundaryWithInput<I, O>(
  input: I,
  call: (isolated: I) => O | Promise<O>,
): Promise<SecurityBoundaryResult<O>> {
  let isolated: I;
  let canonical: string;
  try {
    isolated = deepFreezeJson(structuredClone(input));
    canonical = canonicalize(isolated);
  } catch {
    return { status: "invalid-input" };
  }

  let raw: unknown;
  let threw = false;
  try {
    raw = await call(isolated);
  } catch {
    threw = true;
  }

  let output: O | undefined;
  let outputInvalid = false;
  if (!threw) {
    try {
      // Do this before inspecting or post-processing any callback output.
      output = structuredClone(raw) as O;
    } catch {
      outputInvalid = true;
    }
  }

  try {
    if (canonicalize(isolated) !== canonical) {
      return { status: "mutated-input" };
    }
  } catch {
    return { status: "mutated-input" };
  }
  if (threw) return { status: "threw" };
  if (outputInvalid) return { status: "invalid-output" };
  return { status: "ok", value: output as O };
}

function snapshotPaymentIntakeInput(value: unknown): SellerPaymentIntakeInput | null {
  let snapshot: unknown;
  try {
    snapshot = structuredClone(value);
  } catch {
    return null;
  }
  if (!isRecord(snapshot) || !hasExactKeys(snapshot, [
    "jobId",
    "phaseIndex",
    "railId",
    "payerPayingKey",
    "receipt",
  ]) ||
      typeof snapshot.jobId !== "string" || snapshot.jobId.length === 0 ||
      !isSafeUint(snapshot.phaseIndex) ||
      typeof snapshot.railId !== "string" || snapshot.railId.length === 0 ||
      typeof snapshot.payerPayingKey !== "string" || snapshot.payerPayingKey.length === 0 ||
      !isRecord(snapshot.receipt)) return null;

  const receipt = snapshot.receipt;
  if (receipt.kind === "pay-dem") {
    return hasExactKeys(receipt, ["kind", "txHash"]) &&
      typeof receipt.txHash === "string" && receipt.txHash.length > 0
      ? snapshot as unknown as SellerPaymentIntakeInput
      : null;
  }
  if (receipt.kind !== "pay-x402" || !hasOnlyKeys(receipt, [
    "kind",
    "protocolVersion",
    "responseHeader",
    "httpResource",
    "paymentReceiptHash",
    "settlementTxHash",
    "chainId",
  ]) ||
      !["kind", "protocolVersion", "responseHeader", "httpResource", "paymentReceiptHash"]
        .every((key) => Object.prototype.hasOwnProperty.call(receipt, key)) ||
      typeof receipt.protocolVersion !== "string" || receipt.protocolVersion.length === 0 ||
      typeof receipt.httpResource !== "string" || receipt.httpResource.length === 0 ||
      typeof receipt.paymentReceiptHash !== "string" || receipt.paymentReceiptHash.length === 0 ||
      (receipt.settlementTxHash !== undefined &&
        (typeof receipt.settlementTxHash !== "string" || receipt.settlementTxHash.length === 0)) ||
      (receipt.chainId !== undefined && typeof receipt.chainId !== "number") ||
      !isRecord(receipt.responseHeader) ||
      !hasExactKeys(receipt.responseHeader, ["name", "value"]) ||
      typeof receipt.responseHeader.name !== "string" ||
      receipt.responseHeader.name.length === 0 ||
      typeof receipt.responseHeader.value !== "string" ||
      receipt.responseHeader.value.length === 0) return null;
  return snapshot as unknown as SellerPaymentIntakeInput;
}

function reject(reason: string): SellerPaymentIntakeResult {
  return { disposition: "rejected", fulfilment: "none", reason };
}

function indeterminate(reason: string): SellerPaymentIntakeResult {
  return { disposition: "indeterminate", fulfilment: "none", reason };
}

function verifierError(reason: string): SellerPaymentIntakeResult {
  return { disposition: "error", fulfilment: "none", reason };
}

function sameListingRef(left: ListingRef, right: ListingRef): boolean {
  return left.listingId === right.listingId &&
    left.version === right.version &&
    left.contentHash === right.contentHash;
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

function parseListingRef(value: unknown): ListingRef | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["listingId", "version", "contentHash"]) ||
      typeof value.listingId !== "string" ||
      value.listingId.length === 0 ||
      !isSafeUint(value.version) || value.version === 0 ||
    typeof value.contentHash !== "string" ||
    !HASH_RE.test(value.contentHash)
  ) return null;
  return {
    listingId: value.listingId,
    version: value.version,
    contentHash: value.contentHash,
  };
}

function isValidPaymentEvidenceInput(value: unknown): value is SellerPaymentEvidenceInput {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "evidenceVersion",
      "jobId",
      "phase",
      "outcome",
      "paymentTxRefs",
      "paymentAmount",
      "settlementFinality",
      "observedAt",
    ]) ||
    value.evidenceVersion !== "1" ||
    typeof value.jobId !== "string" ||
    value.jobId.length === 0 ||
    (value.phase !== "pay-dem" && value.phase !== "pay-x402") ||
    value.outcome !== "success" ||
    !Array.isArray(value.paymentTxRefs) ||
    value.paymentTxRefs.length !== 1 ||
    !isRecord(value.paymentAmount) ||
    !hasOnlyKeys(value.paymentAmount, ["amount", "currency", "unit"]) ||
    typeof value.paymentAmount.amount !== "string" ||
    typeof value.paymentAmount.currency !== "string" ||
    value.paymentAmount.currency.length === 0 ||
    (value.paymentAmount.unit !== undefined &&
      (typeof value.paymentAmount.unit !== "string" || value.paymentAmount.unit.length === 0)) ||
    !isRecord(value.settlementFinality) ||
    !isSafeUint(value.observedAt)
  ) return false;
  try {
    if (assertPositiveAmount(value.paymentAmount.amount) !== value.paymentAmount.amount) return false;
  } catch {
    return false;
  }

  const txRef = value.paymentTxRefs[0];
  if (!isRecord(txRef) || typeof txRef.kind !== "string") return false;
  if (value.phase === "pay-dem") {
    if (
      !hasOnlyKeys(txRef, ["kind", "txHash", "blockNumber"]) ||
      txRef.kind !== "demos" ||
      typeof txRef.txHash !== "string" ||
      canonicalTxHash(txRef.txHash) === null ||
      (txRef.blockNumber !== undefined && !isSafeUint(txRef.blockNumber)) ||
      !hasOnlyKeys(value.settlementFinality, ["model", "finalityObservedAt"]) ||
      value.settlementFinality.model !== "bft-final" ||
      !isSafeUint(value.settlementFinality.finalityObservedAt)
    ) return false;
  } else if (
    !hasOnlyKeys(txRef, [
      "kind",
      "httpResource",
      "paymentReceiptHash",
      "settlementTxHash",
      "chainId",
      "protocolVersion",
    ]) ||
    txRef.kind !== "x402" ||
    typeof txRef.httpResource !== "string" ||
    txRef.httpResource.length === 0 ||
    !HASH_RE.test(String(txRef.paymentReceiptHash)) ||
    typeof txRef.settlementTxHash !== "string" ||
    canonicalTxHash(txRef.settlementTxHash) === null ||
    !isSafeUint(txRef.chainId) || txRef.chainId === 0 ||
    typeof txRef.protocolVersion !== "string" ||
    txRef.protocolVersion.length === 0 ||
    !hasOnlyKeys(value.settlementFinality, [
      "model",
      "finalityBlocks",
      "finalityObservedAt",
    ]) ||
    value.settlementFinality.model !== "block-depth" ||
    !isSafeUint(value.settlementFinality.finalityBlocks) ||
    value.settlementFinality.finalityBlocks === 0 ||
    !isSafeUint(value.settlementFinality.finalityObservedAt)
  ) return false;
  return value.settlementFinality.finalityObservedAt === value.observedAt;
}

function parseProducerAdmission(
  value: unknown,
): SellerPayloadVerificationProducerAdmission | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "operation",
    "disposition",
    "listingRef",
    "verificationMethodKind",
    "verificationMethodHash",
    "deliverableSpecHash",
    "admittedAt",
  ]) ||
      value.operation !== "produce" ||
      value.disposition !== "supported" ||
      typeof value.verificationMethodKind !== "string" ||
      !VERIFICATION_METHOD_KINDS.has(value.verificationMethodKind) ||
      typeof value.verificationMethodHash !== "string" ||
      !HASH_RE.test(value.verificationMethodHash) ||
      typeof value.deliverableSpecHash !== "string" ||
      !HASH_RE.test(value.deliverableSpecHash) ||
      !isSafeUint(value.admittedAt)) return null;
  const listingRef = parseListingRef(value.listingRef);
  if (!listingRef) return null;
  return {
    operation: "produce",
    disposition: "supported",
    listingRef,
    verificationMethodKind:
      value.verificationMethodKind as VerificationMethod["kind"],
    verificationMethodHash: value.verificationMethodHash,
    deliverableSpecHash: value.deliverableSpecHash,
    admittedAt: value.admittedAt,
  };
}

function sameProducerAdmission(
  left: SellerPayloadVerificationProducerAdmission | undefined,
  right: SellerPayloadVerificationProducerAdmission | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.operation === right.operation &&
    left.disposition === right.disposition &&
    sameListingRef(left.listingRef, right.listingRef) &&
    left.verificationMethodKind === right.verificationMethodKind &&
    left.verificationMethodHash === right.verificationMethodHash &&
    left.deliverableSpecHash === right.deliverableSpecHash &&
    left.admittedAt === right.admittedAt;
}

function sameClaimAuthorizationScope(
  left: SellerReceiptClaim,
  right: SellerReceiptClaim,
): boolean {
  if (left.settlementId !== right.settlementId ||
      left.jobId !== right.jobId || left.phaseIndex !== right.phaseIndex) return false;
  const replayInvariant = (
    authorization: SellerPaymentAuthorization,
  ): Record<string, unknown> => {
    const invariant: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(authorization)) {
      // `isCanonicalReplayWinner` validates the excluded observation fields,
      // including event-identity equivalence in the fulfilment stack where a
      // later observation may carry a later authenticated inclusion time.
      if (key !== "evidenceHash" && key !== "evidenceInput" &&
          key !== "payoutBindingTier" && key !== "sessionBinding" &&
          key !== "settlementIdentity") {
        invariant[key] = value;
      }
    }
    return invariant;
  };
  try {
    return canonicalize(replayInvariant(left.authorization)) ===
      canonicalize(replayInvariant(right.authorization));
  } catch {
    return false;
  }
}

function isCommittedAgreementResolutionValue(
  value: unknown,
): value is CommittedAgreementResolution {
  if (!isRecord(value)) return false;
  if (value.disposition === "rejected" || value.disposition === "indeterminate") {
    return hasExactKeys(value, ["disposition", "reason"]) &&
      typeof value.reason === "string" && value.reason.length > 0;
  }
  if (value.disposition !== "verified" || !hasExactKeys(value, [
    "disposition",
    "agreement",
    "agreementHash",
    "commitment",
    "railRegistryVersion",
  ]) ||
      !isRecord(value.agreement) ||
      typeof value.agreementHash !== "string" ||
      !HASH_RE.test(value.agreementHash) ||
      !isRecord(value.commitment) ||
      !hasExactKeys(value.commitment, [
        "finality",
        "ref",
        "contentHash",
        "jobId",
        "agreementHash",
        "listingRef",
        "committedAt",
      ]) ||
      value.commitment.finality !== "finalized" ||
      typeof value.commitment.ref !== "string" ||
      value.commitment.ref.length === 0 ||
      typeof value.commitment.contentHash !== "string" ||
      !HASH_RE.test(value.commitment.contentHash) ||
      typeof value.commitment.jobId !== "string" ||
      value.commitment.jobId.length === 0 ||
      typeof value.commitment.agreementHash !== "string" ||
      !HASH_RE.test(value.commitment.agreementHash) ||
      parseListingRef(value.commitment.listingRef) === null ||
      !isSafeUint(value.commitment.committedAt) ||
      !isSafeUint(value.railRegistryVersion) ||
      value.railRegistryVersion === 0) return false;
  try {
    canonicalize(value.agreement);
    return true;
  } catch {
    return false;
  }
}

function isIdentityBundleResolutionValue(
  value: unknown,
): value is IdentityBundleResolution {
  if (!isRecord(value)) return false;
  if (value.disposition === "rejected" || value.disposition === "indeterminate") {
    return hasExactKeys(value, ["disposition", "reason"]) &&
      typeof value.reason === "string" && value.reason.length > 0;
  }
  if (!(value.disposition === "verified" &&
    hasExactKeys(value, ["disposition", "bundle"]) &&
    isIdentityBundle(value.bundle))) return false;
  try {
    identityBundleHash(value.bundle);
    return true;
  } catch {
    return false;
  }
}

function isSellerRailResolutionValue(value: unknown): value is SellerRailResolution {
  if (!isRecord(value)) return false;
  if (value.disposition === "rejected" || value.disposition === "indeterminate") {
    return hasExactKeys(value, ["disposition", "reason"]) &&
      typeof value.reason === "string" && value.reason.length > 0;
  }
  if (!(value.disposition === "verified" &&
    hasExactKeys(value, ["disposition", "rail", "railRegistryVersion"]) &&
    validRailShape(value.rail) &&
    isSafeUint(value.railRegistryVersion) && value.railRegistryVersion > 0)) return false;
  try {
    canonicalize(value.rail);
    return true;
  } catch {
    return false;
  }
}

function isAddressResolutionValue(value: unknown): value is AddressResolution {
  if (!isRecord(value)) return false;
  if (value.disposition === "verified") {
    return hasExactKeys(value, ["disposition", "address"]) &&
      typeof value.address === "string" && value.address.length > 0;
  }
  return (value.disposition === "rejected" || value.disposition === "indeterminate") &&
    hasExactKeys(value, ["disposition", "reason"]) &&
    typeof value.reason === "string" && value.reason.length > 0;
}

function isDestinationBindingResolutionValue(
  value: unknown,
): value is DestinationBindingResolution {
  if (!isRecord(value) ||
      value.tier !== 2 && value.tier !== 3) return false;
  if (value.disposition === "bound") {
    return hasExactKeys(value, ["disposition", "address", "tier"]) &&
      typeof value.address === "string" && value.address.length > 0;
  }
  if (value.disposition === "mismatch") {
    return hasExactKeys(value, ["disposition", "reason", "tier"]) &&
      typeof value.reason === "string" && value.reason.length > 0;
  }
  return (value.disposition === "indeterminate" ||
    value.disposition === "error") && value.tier === 2 &&
    hasExactKeys(value, ["disposition", "reason", "tier"]) &&
    typeof value.reason === "string" && value.reason.length > 0;
}

function isDemosTransferObservationValue(
  value: unknown,
): value is DemosTransferObservation {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "pending" || value.status === "not-found" ||
      value.status === "unavailable" || value.status === "failed") {
    return hasOnlyKeys(value, ["status", "reason"]) &&
      (value.reason === undefined || typeof value.reason === "string");
  }
  return value.status === "included" && hasExactKeys(value, [
    "status",
    "txHash",
    "payer",
    "payee",
    "amountOs",
    "blockNumber",
    "includedAt",
  ]) &&
    typeof value.txHash === "string" &&
    typeof value.payer === "string" &&
    typeof value.payee === "string" &&
    typeof value.amountOs === "string" &&
    isSafeUint(value.blockNumber) &&
    isSafeUint(value.includedAt);
}

function isX402TransferObservationValue(
  value: unknown,
): value is X402TransferObservation {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "pending" || value.status === "not-found" ||
      value.status === "unavailable" || value.status === "failed") {
    return hasOnlyKeys(value, ["status", "reason"]) &&
      (value.reason === undefined || typeof value.reason === "string");
  }
  return value.status === "finalized" && hasExactKeys(value, [
    "status",
    "chainId",
    "txHash",
    "logIndex",
    "payer",
    "payee",
    "amountBaseUnits",
    "asset",
    "confirmations",
    "includedAt",
    "finalityObservedAt",
    "sessionBinding",
  ]) &&
    isSafeUint(value.chainId) &&
    typeof value.txHash === "string" &&
    isSafeUint(value.logIndex) &&
    typeof value.payer === "string" &&
    typeof value.payee === "string" &&
    typeof value.amountBaseUnits === "string" &&
    isRecord(value.asset) &&
    hasExactKeys(value.asset, ["contract", "symbol", "decimals"]) &&
    typeof value.asset.contract === "string" &&
    typeof value.asset.symbol === "string" &&
    isSafeUint(value.asset.decimals) &&
    isSafeUint(value.confirmations) &&
    isSafeUint(value.includedAt) &&
    isSafeUint(value.finalityObservedAt) &&
    isRecord(value.sessionBinding) &&
    typeof value.sessionBinding.kind === "string";
}

function isX402ReceiptExtensionVerificationValue(
  value: unknown,
): value is X402ReceiptExtensionVerification {
  if (!isRecord(value)) return false;
  if (value.disposition === "pass") {
    return hasExactKeys(value, ["disposition"]);
  }
  return (value.disposition === "fail" || value.disposition === "indeterminate" ||
    value.disposition === "error") &&
    hasExactKeys(value, ["disposition", "reason"]) &&
    typeof value.reason === "string" && value.reason.length > 0;
}

function isX402SettlementChainClassificationValue(
  value: unknown,
): value is X402SettlementChainClassification {
  if (!isRecord(value)) return false;
  if (value.disposition === "l2") {
    return hasExactKeys(value, ["disposition"]);
  }
  return (value.disposition === "unsupported" ||
    value.disposition === "indeterminate" || value.disposition === "error") &&
    hasExactKeys(value, ["disposition", "reason"]) &&
    typeof value.reason === "string" && value.reason.length > 0;
}

function isSellerReceiptClaimResultValue(
  value: unknown,
): value is SellerReceiptClaimResult {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "claimed" || value.status === "already-claimed" ||
      value.status === "already-consumed") {
    return hasExactKeys(value, ["status", "permitId", "claim"]) &&
      typeof value.permitId === "string" && value.permitId.length > 0 &&
      isValidSellerReceiptClaim(value.claim);
  }
  if (value.status !== "conflict" || !hasOnlyKeys(value, [
    "status",
    "reason",
    "existing",
    "consumed",
  ]) ||
      !["status", "reason", "existing"].every((key) =>
        Object.prototype.hasOwnProperty.call(value, key)) ||
      (value.reason !== "lower-priority" &&
        value.reason !== "winner-already-consumed" &&
        value.reason !== "authorization-scope-conflict") ||
      !isValidSellerReceiptClaim(value.existing)) return false;
  const consumedWasReturned = Object.prototype.hasOwnProperty.call(value, "consumed");
  return !consumedWasReturned || isValidSellerReceiptClaim(value.consumed);
}

export function isValidSellerReceiptClaim(value: unknown): value is SellerReceiptClaim {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "settlementId",
      "jobId",
      "phaseIndex",
      "observedAt",
      "evidenceHash",
      "authorization",
    ]) ||
    typeof value.settlementId !== "string" ||
    value.settlementId.length === 0 ||
    typeof value.jobId !== "string" ||
    value.jobId.length === 0 ||
    !isSafeUint(value.phaseIndex) ||
    !isSafeUint(value.observedAt) ||
    typeof value.evidenceHash !== "string" ||
    !HASH_RE.test(value.evidenceHash) ||
    !isRecord(value.authorization)
  ) return false;

  const authorization = value.authorization;
  const evidenceInput = authorization.evidenceInput;
  if (
    !hasOnlyKeys(authorization, [
      "jobId",
      "phaseIndex",
      "agreementHash",
      "listingRef",
      "railId",
      "railRegistryVersion",
      "commitment",
      "settlementIdentity",
      "settlementId",
      "evidenceHash",
      "evidenceInput",
      "payoutBindingTier",
      "sessionBinding",
      "payloadVerificationProducerAdmission",
    ]) ||
    ![
      "jobId",
      "phaseIndex",
      "agreementHash",
      "listingRef",
      "railId",
      "railRegistryVersion",
      "commitment",
      "settlementIdentity",
      "settlementId",
      "evidenceHash",
      "evidenceInput",
      "payoutBindingTier",
    ].every((key) => Object.prototype.hasOwnProperty.call(authorization, key)) ||
    authorization.jobId !== value.jobId ||
    authorization.phaseIndex !== value.phaseIndex ||
    authorization.settlementId !== value.settlementId ||
    authorization.evidenceHash !== value.evidenceHash ||
    typeof authorization.agreementHash !== "string" ||
    !HASH_RE.test(authorization.agreementHash) ||
    parseListingRef(authorization.listingRef) === null ||
    typeof authorization.railId !== "string" ||
    authorization.railId.length === 0 ||
    !isSafeUint(authorization.railRegistryVersion) ||
    authorization.railRegistryVersion === 0 ||
    !isRecord(authorization.commitment) ||
    !hasExactKeys(authorization.commitment, ["ref", "contentHash", "finalizedAt"]) ||
    typeof authorization.commitment.ref !== "string" ||
    authorization.commitment.ref.length === 0 ||
    typeof authorization.commitment.contentHash !== "string" ||
    !HASH_RE.test(authorization.commitment.contentHash) ||
    !isSafeUint(authorization.commitment.finalizedAt) ||
    !isRecord(authorization.settlementIdentity) ||
    (authorization.payoutBindingTier !== 1 &&
      authorization.payoutBindingTier !== 2 &&
      authorization.payoutBindingTier !== 3) ||
    (authorization.sessionBinding !== undefined &&
      authorization.sessionBinding !== "established" &&
      authorization.sessionBinding !== "not-established") ||
    (Object.prototype.hasOwnProperty.call(
      authorization,
      "payloadVerificationProducerAdmission",
    ) && parseProducerAdmission(
      authorization.payloadVerificationProducerAdmission,
    ) === null) ||
    !isValidPaymentEvidenceInput(evidenceInput) ||
    evidenceInput.jobId !== value.jobId ||
    evidenceInput.observedAt !== value.observedAt ||
    evidenceInput.observedAt < authorization.commitment.finalizedAt
  ) return false;

  const identity = authorization.settlementIdentity;
  const txRef = evidenceInput.paymentTxRefs[0];
  if (evidenceInput.phase === "pay-dem") {
    if (!hasExactKeys(identity, ["kind", "txHash", "blockNumber", "includedAt"]) ||
        identity.kind !== "demos" || typeof identity.txHash !== "string" ||
        canonicalTxHash(identity.txHash) === null || !isSafeUint(identity.blockNumber) ||
        !isSafeUint(identity.includedAt) || identity.includedAt !== evidenceInput.observedAt ||
        identity.includedAt < authorization.commitment.finalizedAt || txRef.kind !== "demos" ||
        canonicalTxHash(txRef.txHash) !== canonicalTxHash(identity.txHash) ||
        txRef.blockNumber !== identity.blockNumber ||
        canonicalSellerSettlementId({ kind: "demos", txHash: identity.txHash }) !==
          value.settlementId) return false;
  } else {
    if (!hasExactKeys(identity, ["kind", "chainId", "txHash", "logIndex", "includedAt"]) ||
        identity.kind !== "evm" || !isSafeUint(identity.chainId) || identity.chainId === 0 ||
        typeof identity.txHash !== "string" || canonicalTxHash(identity.txHash) === null ||
        !isSafeUint(identity.logIndex) || !isSafeUint(identity.includedAt) ||
        identity.includedAt < authorization.commitment.finalizedAt ||
        identity.includedAt > evidenceInput.observedAt || txRef.kind !== "x402" ||
        txRef.chainId !== identity.chainId ||
        canonicalTxHash(txRef.settlementTxHash!) !== canonicalTxHash(identity.txHash) ||
        canonicalSellerSettlementId({
          kind: "evm",
          chainId: identity.chainId,
          txHash: identity.txHash,
          logIndex: identity.logIndex,
        }) !== value.settlementId) return false;
  }

  try {
    return sha256Hex(canonicalize(evidenceInput)) === value.evidenceHash;
  } catch {
    return false;
  }
}

/**
 * An SB-2 retry may recover the store's earlier canonical observation, but it
 * may not substitute different payment semantics. The only evidence fields
 * allowed to move are the monotonic observation/finality timestamp. For SB-3,
 * a retained weaker result is conservative; a retained stronger result may
 * not override a fresh weaker observation.
 */
function sameSettlementEventIdentity(
  left: SellerSettlementIdentity,
  right: SellerSettlementIdentity,
): boolean {
  if (left.kind !== right.kind || canonicalTxHash(left.txHash) !== canonicalTxHash(right.txHash)) {
    return false;
  }
  return left.kind === "demos" && right.kind === "demos"
    ? left.blockNumber === right.blockNumber
    : left.kind === "evm" && right.kind === "evm" &&
      left.chainId === right.chainId && left.logIndex === right.logIndex;
}

function isCanonicalReplayWinner(
  stored: SellerReceiptClaim,
  candidate: SellerReceiptClaim,
): boolean {
  const storedWinsSb2 = stored.observedAt < candidate.observedAt ||
    stored.observedAt === candidate.observedAt &&
      stored.evidenceHash <= candidate.evidenceHash;
  if (!storedWinsSb2 ||
      stored.authorization.payoutBindingTier !==
        candidate.authorization.payoutBindingTier ||
      !sameSettlementEventIdentity(
        stored.authorization.settlementIdentity,
        candidate.authorization.settlementIdentity,
      )) return false;

  const storedHasSessionBinding = Object.prototype.hasOwnProperty.call(
    stored.authorization,
    "sessionBinding",
  );
  const candidateHasSessionBinding = Object.prototype.hasOwnProperty.call(
    candidate.authorization,
    "sessionBinding",
  );
  if (storedHasSessionBinding !== candidateHasSessionBinding) return false;
  if (storedHasSessionBinding) {
    const storedBinding = stored.authorization.sessionBinding;
    const candidateBinding = candidate.authorization.sessionBinding;
    if (storedBinding !== candidateBinding &&
        !(storedBinding === "not-established" &&
          candidateBinding === "established")) return false;
  }

  const storedEvidence = stored.authorization.evidenceInput;
  const candidateEvidence = candidate.authorization.evidenceInput;
  if (!isRecord(storedEvidence.settlementFinality) ||
      !isRecord(candidateEvidence.settlementFinality) ||
      storedEvidence.observedAt !== stored.observedAt ||
      candidateEvidence.observedAt !== candidate.observedAt ||
      storedEvidence.settlementFinality.finalityObservedAt !== stored.observedAt ||
      candidateEvidence.settlementFinality.finalityObservedAt !==
        candidate.observedAt) return false;

  try {
    const normalizedStoredEvidence = {
      ...storedEvidence,
      observedAt: candidate.observedAt,
      settlementFinality: {
        ...storedEvidence.settlementFinality,
        finalityObservedAt: candidate.observedAt,
      },
    };
    return canonicalize(normalizedStoredEvidence) === canonicalize(candidateEvidence);
  } catch {
    return false;
  }
}

function parseParty(value: unknown): AgreementPartyView | null {
  if (
    !isRecord(value) ||
    (value.role !== "buyer" && value.role !== "seller") ||
    typeof value.bundleHash !== "string" ||
    !HASH_RE.test(value.bundleHash) ||
    typeof value.primaryClaim !== "string" ||
    value.primaryClaim.length === 0 ||
    !isRecord(value.vetRecordRef)
  ) return null;
  return {
    role: value.role,
    bundleHash: value.bundleHash,
    primaryClaim: value.primaryClaim,
  };
}

function parseRailRef(value: unknown): PaymentRailRef | null {
  if (
    !isRecord(value) ||
    typeof value.railId !== "string" ||
    value.railId.length === 0 ||
    (value.railVersion !== undefined && (!isSafeUint(value.railVersion) || value.railVersion === 0)) ||
    (value.parameters !== undefined && !isRecord(value.parameters))
  ) return null;
  return {
    railId: value.railId,
    ...(value.railVersion === undefined ? {} : { railVersion: value.railVersion }),
    ...(value.parameters === undefined ? {} : { parameters: value.parameters }),
  };
}

function parseAgreement(raw: Record<string, unknown>): AgreementView | null {
  // DACS-3 §8.5: select the PB schema before interpreting action fields.
  if (
    raw.payeeBoundAgreementVersion !== "1" ||
    raw.agreementVersion !== undefined ||
    typeof raw.jobId !== "string" ||
    raw.jobId.length === 0 ||
    !Array.isArray(raw.parties) ||
    !isRecord(raw.terms)
  ) return null;

  const listingRef = parseListingRef(raw.listingRef);
  if (!listingRef) return null;
  const parties = raw.parties.map(parseParty);
  const buyer = parties.find((party) => party?.role === "buyer") ?? null;
  const seller = parties.find((party) => party?.role === "seller") ?? null;
  if (
    !buyer || !seller ||
    parties.filter((party) => party?.role === "buyer").length !== 1 ||
    parties.filter((party) => party?.role === "seller").length !== 1
  ) return null;

  const terms = raw.terms;
  if (
    !isRecord(terms.price) ||
    typeof terms.price.amount !== "string" ||
    typeof terms.price.currency !== "string" ||
    (terms.price.unit !== undefined && typeof terms.price.unit !== "string") ||
    !isSafeUint(terms.deadline) ||
    !isRecord(terms.deliverable) ||
    typeof terms.deliverable.deliverableType !== "string" ||
    typeof terms.deliverable.hash !== "string" ||
    !HASH_RE.test(terms.deliverable.hash) ||
    (terms.deliverable.schemaUrl !== undefined && typeof terms.deliverable.schemaUrl !== "string") ||
    !Array.isArray(terms.payoutBindings)
  ) return null;
  const rail = parseRailRef(terms.rail);
  if (!rail) return null;
  try {
    if (assertPositiveAmount(terms.price.amount) !== terms.price.amount) return null;
  } catch {
    return null;
  }
  const payoutBindings: PayoutBindingView[] = [];
  for (const binding of terms.payoutBindings) {
    if (
      !isRecord(binding) ||
      typeof binding.railId !== "string" ||
      !isSafeUint(binding.phaseIndex) ||
      typeof binding.payeeAddress !== "string" ||
      binding.payeeAddress.length === 0
    ) return null;
    payoutBindings.push({
      railId: binding.railId,
      phaseIndex: binding.phaseIndex,
      payeeAddress: binding.payeeAddress,
    });
  }
  return {
    jobId: raw.jobId,
    listingRef,
    buyer,
    seller,
    derivedFromPattern: raw.derivedFromPattern as AgreementView["derivedFromPattern"],
    terms: {
      price: {
        amount: terms.price.amount,
        currency: terms.price.currency,
        ...(terms.price.unit === undefined ? {} : { unit: terms.price.unit }),
      },
      rail,
      deadline: terms.deadline,
      deliverable: {
        deliverableType: terms.deliverable.deliverableType,
        hash: terms.deliverable.hash,
        ...(terms.deliverable.schemaUrl === undefined
          ? {}
          : { schemaUrl: terms.deliverable.schemaUrl }),
      },
      payoutBindings,
    },
  };
}

function canonicalTxHash(txHash: string): string | null {
  if (!TX_HASH_RE.test(txHash)) return null;
  return txHash.toLowerCase().replace(/^0x/, "");
}

/** DACS-4 §9.5.8 SB-1 canonical settlement identity for supported rails. */
export function canonicalSellerSettlementId(input:
  | { kind: "demos"; txHash: string }
  | { kind: "evm"; chainId: number; txHash: string; logIndex: number },
): string | null {
  const txHash = canonicalTxHash(input.txHash);
  if (!txHash) return null;
  if (input.kind === "demos") return `demos:${txHash}`;
  if (!isSafeUint(input.chainId) || input.chainId === 0 || !isSafeUint(input.logIndex)) return null;
  return `evm:${input.chainId}:${txHash}:${input.logIndex}`;
}

/** DACS-4 §9.5.8 byte-exact EIP-3009 SB-3 nonce. */
export function x402Eip3009Nonce(jobId: string, phaseIndex: number): string {
  if (typeof jobId !== "string" || jobId.length === 0) {
    throw new TypeError("jobId must be a non-empty string");
  }
  if (!isSafeUint(phaseIndex)) throw new TypeError("phaseIndex must be a safe unsigned integer");
  return `0x${sha256Hex(`dacs-sb3:v1:${jobId.normalize("NFC")}:${phaseIndex}`)}`;
}

/**
 * Process-local reference store for tests and single-process deployments.
 * Recovery-capable sellers MUST inject a durable implementation with the same
 * atomic winner-selection and one-shot-consumption guarantees.
 */
export function createInMemorySellerReceiptStore(
  initial: readonly SellerReceiptClaim[] = [],
): SellerFulfilmentReceiptStore {
  interface StoredClaim {
    selected: SellerReceiptClaim;
    pendingPermitId?: string;
    consumed?: {
      permitId: string;
      claim: SellerReceiptClaim;
      handoff: SellerFulfilmentHandoff;
    };
  }

  const claims = new Map<string, StoredClaim>();
  const permits = new Map<string, string>();
  const permitId = (): string =>
    `seller-payment:${randomBytes(32).toString("base64url")}`;
  const cloneClaim = (claim: SellerReceiptClaim): SellerReceiptClaim =>
    structuredClone(claim);
  const cloneHandoff = (handoff: SellerFulfilmentHandoff): SellerFulfilmentHandoff =>
    structuredClone(handoff);
  const validateClaim = (claim: SellerReceiptClaim): void => {
    if (!isValidSellerReceiptClaim(claim)) {
      throw new TypeError("seller receipt claim is malformed or internally inconsistent");
    }
  };
  const exactClaim = (left: SellerReceiptClaim, right: SellerReceiptClaim): boolean =>
    canonicalize(left) === canonicalize(right);
  const winnerOrder = (left: SellerReceiptClaim, right: SellerReceiptClaim): number => {
    if (left.observedAt !== right.observedAt) {
      return left.observedAt < right.observedAt ? -1 : 1;
    }
    if (left.evidenceHash !== right.evidenceHash) {
      return left.evidenceHash < right.evidenceHash ? -1 : 1;
    }
    // Equal signed-scope hashes cannot bind different sessions without a hash
    // collision. Keep the store deterministic even under malformed/colliding
    // external state; the lower canonical binding wins.
    const leftBinding = `${left.jobId}\u0000${left.phaseIndex}`;
    const rightBinding = `${right.jobId}\u0000${right.phaseIndex}`;
    return leftBinding < rightBinding ? -1 : leftBinding > rightBinding ? 1 : 0;
  };
  const install = (claim: SellerReceiptClaim): StoredClaim => {
    const pendingPermitId = permitId();
    const stored = { selected: cloneClaim(claim), pendingPermitId };
    claims.set(claim.settlementId, stored);
    permits.set(pendingPermitId, claim.settlementId);
    return stored;
  };
  const replacePendingSelection = (
    stored: StoredClaim,
    claim: SellerReceiptClaim,
  ): string => {
    if (stored.pendingPermitId) permits.delete(stored.pendingPermitId);
    const nextPermitId = permitId();
    stored.selected = cloneClaim(claim);
    stored.pendingPermitId = nextPermitId;
    permits.set(nextPermitId, claim.settlementId);
    return nextPermitId;
  };

  for (const candidate of initial) {
    validateClaim(candidate);
    const existing = claims.get(candidate.settlementId);
    if (!existing) {
      install(candidate);
    } else if (winnerOrder(candidate, existing.selected) < 0) {
      replacePendingSelection(existing, candidate);
    }
  }

  return {
    async claim(input) {
      validateClaim(input);
      const candidate = cloneClaim(input);
      const existing = claims.get(candidate.settlementId);
      if (!existing) {
        const stored = install(candidate);
        return {
          status: "claimed",
          permitId: stored.pendingPermitId!,
          claim: cloneClaim(stored.selected),
        };
      }
      const order = winnerOrder(candidate, existing.selected);
      const sameSelectedSession = existing.selected.jobId === candidate.jobId &&
        existing.selected.phaseIndex === candidate.phaseIndex;
      const sameAuthorizationScope =
        existing.selected.authorization.agreementHash ===
          candidate.authorization.agreementHash &&
        sameListingRef(
          existing.selected.authorization.listingRef,
          candidate.authorization.listingRef,
        ) &&
        existing.selected.authorization.railId === candidate.authorization.railId &&
        existing.selected.authorization.railRegistryVersion ===
          candidate.authorization.railRegistryVersion &&
        canonicalize(existing.selected.authorization.commitment) ===
          canonicalize(candidate.authorization.commitment) &&
        sameSettlementEventIdentity(
          existing.selected.authorization.settlementIdentity,
          candidate.authorization.settlementIdentity,
        ) &&
        sameProducerAdmission(
          existing.selected.authorization.payloadVerificationProducerAdmission,
          candidate.authorization.payloadVerificationProducerAdmission,
        );
      if (existing.consumed &&
          sameClaimAuthorizationScope(existing.consumed.claim, candidate) &&
          isCanonicalReplayWinner(existing.consumed.claim, candidate)) {
        return {
          status: "already-consumed",
          permitId: existing.consumed.permitId,
          claim: cloneClaim(existing.consumed.claim),
        };
      }
      if (sameSelectedSession && !sameAuthorizationScope) {
        return {
          status: "conflict",
          reason: "authorization-scope-conflict",
          existing: cloneClaim(existing.selected),
          ...(existing.consumed ? { consumed: cloneClaim(existing.consumed.claim) } : {}),
        };
      }
      if (order < 0) {
        existing.selected = cloneClaim(candidate);
        if (existing.consumed) {
          return {
            status: "conflict",
            reason: "winner-already-consumed",
            existing: cloneClaim(existing.selected),
            consumed: cloneClaim(existing.consumed.claim),
          };
        }
        const nextPermitId = replacePendingSelection(existing, candidate);
        return {
          status: "claimed",
          permitId: nextPermitId,
          claim: cloneClaim(existing.selected),
        };
      }
      if (exactClaim(existing.selected, candidate) ||
          (sameSelectedSession && sameAuthorizationScope)) {
        if (existing.consumed) {
          if (!exactClaim(existing.selected, existing.consumed.claim)) {
            return {
              status: "conflict",
              reason: "winner-already-consumed",
              existing: cloneClaim(existing.selected),
              consumed: cloneClaim(existing.consumed.claim),
            };
          }
          return {
            status: "conflict",
            reason: "lower-priority",
            existing: cloneClaim(existing.selected),
            consumed: cloneClaim(existing.consumed.claim),
          };
        }
        if (!existing.pendingPermitId) {
          throw new TypeError("seller receipt store lost its pending permit");
        }
        return {
          status: "already-claimed",
          permitId: existing.pendingPermitId,
          claim: cloneClaim(existing.selected),
        };
      }
      return {
        status: "conflict",
        reason: "lower-priority",
        existing: cloneClaim(existing.selected),
        ...(existing.consumed ? { consumed: cloneClaim(existing.consumed.claim) } : {}),
      };
    },
    async inspectPermit(candidatePermitId) {
      const settlementId = permits.get(candidatePermitId);
      if (!settlementId) return { status: "invalid" };
      const stored = claims.get(settlementId);
      if (!stored) return { status: "invalid" };
      if (stored.consumed?.permitId === candidatePermitId) {
        return {
          status: "already-consumed",
          claim: cloneClaim(stored.consumed.claim),
          handoff: cloneHandoff(stored.consumed.handoff),
        };
      }
      if (stored.pendingPermitId !== candidatePermitId || stored.consumed) {
        return { status: "invalid" };
      }
      return { status: "available", claim: cloneClaim(stored.selected) };
    },
    async consumePermit(candidatePermitId, handoffInput) {
      if (!isSellerFulfilmentHandoff(handoffInput)) {
        throw new TypeError("seller fulfilment handoff is malformed");
      }
      const handoff = cloneHandoff(handoffInput);
      const settlementId = permits.get(candidatePermitId);
      if (!settlementId) return { status: "invalid" };
      const stored = claims.get(settlementId);
      if (!stored) return { status: "invalid" };
      if (stored.consumed?.permitId === candidatePermitId) {
        return {
          status: "already-consumed",
          claim: cloneClaim(stored.consumed.claim),
          handoff: cloneHandoff(stored.consumed.handoff),
        };
      }
      if (stored.pendingPermitId !== candidatePermitId || stored.consumed) {
        return { status: "invalid" };
      }
      // One synchronous mutation is the in-memory implementation's atomic
      // commit point. Durable stores MUST commit these three values together.
      stored.consumed = {
        permitId: candidatePermitId,
        claim: cloneClaim(stored.selected),
        handoff,
      };
      stored.pendingPermitId = undefined;
      return {
        status: "consumed",
        claim: cloneClaim(stored.consumed.claim),
        handoff: cloneHandoff(stored.consumed.handoff),
      };
    },
  };
}

function resourceAllowed(resource: string, base: string): boolean {
  try {
    const actual = new URL(resource);
    const expected = new URL(base);
    if (actual.protocol !== "https:" || expected.protocol !== "https:") return false;
    if (actual.username || actual.password || expected.username || expected.password) return false;
    if (actual.origin !== expected.origin) return false;
    const prefix = expected.pathname.endsWith("/")
      ? expected.pathname
      : `${expected.pathname}/`;
    return actual.pathname === expected.pathname || actual.pathname.startsWith(prefix);
  } catch {
    return false;
  }
}

function verifyAgreementListing(
  agreement: AgreementView,
  listing: Listing,
  phaseIndex: number,
  railId: string,
): string | null {
  const phase = listing.pipeline[phaseIndex];
  if (!phase || phase.kind !== "pay-dem" && phase.kind !== "pay-x402") {
    return "phase-is-not-supported-payment";
  }
  if (phase.parameters?.rail !== railId || agreement.terms.rail.railId !== railId) {
    return "phase-rail-mismatch";
  }
  return null;
}

function validRailShape(rail: unknown): rail is SellerSupportedRailDefinition {
  if (!isRecord(rail) || !hasExactKeys(rail, [
    "railVersion",
    "railId",
    "railType",
    "asset",
    "network",
    "phaseHandler",
    "parameters",
    "availability",
  ]) ||
      typeof rail.railVersion !== "number" ||
      !Number.isSafeInteger(rail.railVersion) || rail.railVersion <= 0 ||
      typeof rail.railId !== "string" || rail.railId.length === 0 ||
      typeof rail.availability !== "string" ||
      !["live", "operator_gated", "closed_data", "bilateral"].includes(
        rail.availability,
      ) ||
      !isRecord(rail.asset) || !isRecord(rail.network) ||
      !isRecord(rail.parameters)) return false;
  if (rail.railType === "demos-native") {
    return rail.phaseHandler === "pay-dem" &&
      hasExactKeys(rail.asset, ["kind", "symbol", "decimals"]) &&
      rail.asset.kind === "native-dem" &&
      rail.asset.symbol === DEM_CURRENCY && rail.asset.decimals === DEM_DECIMALS &&
      hasExactKeys(rail.network, ["kind"]) && rail.network.kind === "demos";
  }
  if (rail.railType !== "x402") return false;
  return rail.phaseHandler === "pay-x402" &&
    hasExactKeys(rail.asset, [
      "kind",
      "chainId",
      "contract",
      "symbol",
      "decimals",
    ]) &&
    rail.asset.kind === "erc20" &&
    isSafeUint(rail.asset.chainId) && typeof rail.asset.contract === "string" &&
    rail.asset.contract.length > 0 && typeof rail.asset.symbol === "string" &&
    rail.asset.symbol.length > 0 && isSafeUint(rail.asset.decimals) &&
    hasExactKeys(rail.network, ["kind", "resourceBaseUrl"]) &&
    rail.network.kind === "x402-resource" &&
    typeof rail.network.resourceBaseUrl === "string" &&
    resourceAllowed(rail.network.resourceBaseUrl, rail.network.resourceBaseUrl);
}

async function settleReplay(
  base: Omit<
    SellerPaymentAuthorization,
    "jobId" | "phaseIndex" | "evidenceHash"
  > & {
    evidenceInput: SellerPaymentEvidenceInput;
    settlementId: string;
  },
  input: SellerPaymentIntakeInput,
  claimReceipt: SellerReceiptStore["claim"],
): Promise<SellerPaymentIntakeResult> {
  const evidenceHash = sha256Hex(canonicalize(base.evidenceInput));
  const authorization: SellerPaymentAuthorization = {
    jobId: input.jobId,
    phaseIndex: input.phaseIndex,
    ...base,
    evidenceHash,
  };
  const candidate: SellerReceiptClaim = {
    settlementId: base.settlementId,
    jobId: input.jobId,
    phaseIndex: input.phaseIndex,
    observedAt: base.evidenceInput.observedAt,
    evidenceHash,
    authorization,
  };
  const stored = await callSecurityBoundaryWithInput(
    candidate,
    claimReceipt,
  );
  if (stored.status === "threw") {
    return indeterminate("receipt-store-unavailable");
  }
  if (stored.status !== "ok" ||
      !isSellerReceiptClaimResultValue(stored.value)) {
    return indeterminate("receipt-store-invalid-result");
  }
  const claim = stored.value;
  if (claim.status === "conflict") {
    if (
      claim.existing.settlementId !== candidate.settlementId ||
      (claim.consumed !== undefined &&
        claim.consumed.settlementId !== candidate.settlementId) ||
      (claim.reason === "winner-already-consumed" && claim.consumed === undefined)
    ) return indeterminate("receipt-store-invalid-result");
    const reason = claim.reason === "authorization-scope-conflict"
      ? "settlement-authorization-scope-conflict"
      : claim.reason === "winner-already-consumed"
        ? "settlement-winner-conflict-after-consumption"
        : "settlement-identity-replay";
    const disposition = claim.reason === "winner-already-consumed"
      ? "indeterminate" as const
      : "rejected" as const;
    if (claim.consumed !== undefined) {
      return {
        disposition,
        fulfilment: "none",
        reason,
        consumedAuthorization: claim.consumed.authorization,
      };
    }
    return disposition === "indeterminate" ? indeterminate(reason) : reject(reason);
  }
  if (
    typeof claim.permitId !== "string" ||
    claim.permitId.length === 0 ||
    !isValidSellerReceiptClaim(claim.claim) ||
    !sameClaimAuthorizationScope(claim.claim, candidate) ||
    (claim.status === "claimed" &&
      canonicalize(claim.claim) !== canonicalize(candidate)) ||
    ((claim.status === "already-claimed" || claim.status === "already-consumed") &&
      !isCanonicalReplayWinner(claim.claim, candidate))
  ) return indeterminate("receipt-store-invalid-result");
  return {
    disposition: "verified",
    fulfilment: claim.status === "claimed" ? "claim" : "already-claimed",
    reason: claim.status === "claimed"
      ? "payment-verified"
      : claim.status === "already-consumed"
        ? "payment-already-consumed"
        : "payment-already-claimed",
    ...claim.claim.authorization,
    permitId: claim.permitId,
  };
}

/**
 * Pure transport-independent seller payment gate for DACS-4 pay-DEM/x402.
 * It never submits or re-submits payment and never invokes application work.
 */
export async function verifySellerPaymentIntake(
  input: SellerPaymentIntakeInput,
  deps: SellerPaymentIntakeDeps,
): Promise<SellerPaymentIntakeResult> {
  // Own the complete public request before its first property read. The caller
  // may retain and mutate its object while any dependency below is awaited.
  const request = snapshotPaymentIntakeInput(input);
  if (!request) {
    return verifierError("invalid-intake-input");
  }

  // Capture each callback once before the first await. Runtime JavaScript can
  // otherwise swap a method on the dependency object between security gates.
  const resolveCommittedAgreement = deps.resolveCommittedAgreement;
  const resolveListingAtCommit = deps.resolveListingAtCommit;
  const resolveRail = deps.resolveRail;
  const resolveIdentityBundle = deps.resolveIdentityBundle;
  const resolvePayerAddress = deps.resolvePayerAddress;
  const resolvePayeeDestination = deps.resolvePayeeDestination;
  const observeDemosTransfer = deps.observeDemosTransfer;
  const observeX402Transfer = deps.observeX402Transfer;
  const verifyX402ReceiptExtensions = deps.verifyX402ReceiptExtensions;
  const classifyX402SettlementChain = deps.classifyX402SettlementChain;
  const receiptStore = deps.receiptStore;
  if (
    typeof resolveCommittedAgreement !== "function" ||
    typeof resolveListingAtCommit !== "function" ||
    typeof resolveRail !== "function" ||
    typeof resolveIdentityBundle !== "function" ||
    typeof resolvePayerAddress !== "function" ||
    typeof resolvePayeeDestination !== "function" ||
    typeof observeDemosTransfer !== "function" ||
    typeof observeX402Transfer !== "function" ||
    typeof verifyX402ReceiptExtensions !== "function" ||
    typeof classifyX402SettlementChain !== "function" ||
    !receiptStore || typeof receiptStore.claim !== "function"
  ) return verifierError("invalid-intake-dependencies");
  const claimReceiptMethod = receiptStore.claim;
  const claimReceipt: SellerReceiptStore["claim"] = (claim) =>
    claimReceiptMethod.call(receiptStore, claim);

  const committedCall = await callSecurityBoundary(() =>
    resolveCommittedAgreement.call(deps, request.jobId));
  if (committedCall.status === "threw") {
    return indeterminate("agreement-resolution-unavailable");
  }
  if (committedCall.status !== "ok" ||
      !isCommittedAgreementResolutionValue(committedCall.value)) {
    return verifierError("agreement-resolution-invalid-result");
  }
  const committed = committedCall.value;
  if (committed.disposition !== "verified") {
    if (typeof committed.reason !== "string" || committed.reason.length === 0) {
      return verifierError("agreement-resolution-invalid-result");
    }
    return committed.disposition === "indeterminate"
      ? indeterminate(`agreement-${committed.reason}`)
      : reject(`agreement-${committed.reason}`);
  }
  if (!isPayeeBoundAgreementDocument(committed.agreement)) {
    return reject("unsupported-or-malformed-agreement");
  }
  const agreementArtifact = committed.agreement;
  const agreement = parseAgreement(committed.agreement);
  if (!agreement) return reject("unsupported-or-malformed-agreement");
  const computedAgreementHash = contentHash(committed.agreement);
  if (
    agreement.jobId !== request.jobId ||
    committed.agreementHash !== computedAgreementHash ||
    committed.commitment.finality !== "finalized" ||
    typeof committed.commitment.ref !== "string" || committed.commitment.ref.length === 0 ||
    !HASH_RE.test(committed.commitment.contentHash) ||
    committed.commitment.jobId !== request.jobId ||
    committed.commitment.agreementHash !== computedAgreementHash ||
    !sameListingRef(committed.commitment.listingRef, agreement.listingRef) ||
    !isSafeUint(committed.commitment.committedAt) ||
    !isSafeUint(committed.railRegistryVersion) ||
    committed.railRegistryVersion === 0 ||
    committed.commitment.committedAt > agreement.terms.deadline
  ) return reject("commitment-agreement-mismatch");

  const listingCall = await callSecurityBoundaryWithInput(
    agreement.listingRef,
    (listingRef) => resolveListingAtCommit.call(deps, listingRef),
  );
  if (listingCall.status === "threw") {
    return indeterminate("listing-resolution-unavailable");
  }
  if (listingCall.status !== "ok" || !isRecord(listingCall.value) ||
      !hasOnlyKeys(listingCall.value, [
        "rawListing",
        "validation",
        "payloadVerificationProducerAdmission",
      ]) ||
      !Object.prototype.hasOwnProperty.call(listingCall.value, "rawListing") ||
      !Object.prototype.hasOwnProperty.call(listingCall.value, "validation") ||
      !isRecord(listingCall.value.rawListing) ||
      !isRecord(listingCall.value.validation)) {
    return indeterminate("listing-at-commit-admission-unavailable");
  }
  const listingAtCommit = listingCall.value as unknown as SellerListingAtCommitResolution;
  const listingResult = listingAtCommit.validation;
  if (listingResult.disposition !== "verified") {
    if (typeof listingResult.reason !== "string" || listingResult.reason.length === 0) {
      return verifierError("listing-resolution-invalid-result");
    }
    return listingResult.disposition === "indeterminate"
      ? indeterminate(`listing-${listingResult.reason}`)
      : reject(`listing-${listingResult.reason}`);
  }
  if (!isVerifiedListingAdmission(listingAtCommit.rawListing, listingResult) ||
      listingResult.listingContentHash !== agreement.listingRef.contentHash) {
    return reject("listing-at-commit-admission-mismatch");
  }

  const listing = listingResult.listing;
  const dpaSelected = listing.pipeline.some(
    (phase) => phase.kind === "deliver-attested-payload",
  );
  const producerAdmissionWasReturned = Object.prototype.hasOwnProperty.call(
    listingAtCommit,
    "payloadVerificationProducerAdmission",
  );
  let producerAdmission: SellerPayloadVerificationProducerAdmission | undefined;
  if (!dpaSelected) {
    if (producerAdmissionWasReturned) {
      return reject("payload-verification-producer-admission-unexpected");
    }
  } else {
    if (!producerAdmissionWasReturned) {
      return indeterminate("payload-verification-producer-admission-unavailable");
    }
    producerAdmission = parseProducerAdmission(
      listingAtCommit.payloadVerificationProducerAdmission,
    ) ?? undefined;
    const deliverable = listing.offering.deliverable;
    if (!producerAdmission || deliverable.kind !== "attested-payload" ||
        !deliverable.verificationMethod ||
        !sameListingRef(producerAdmission.listingRef, agreement.listingRef) ||
        producerAdmission.verificationMethodKind !==
          deliverable.verificationMethod.kind ||
        producerAdmission.verificationMethodHash !==
          sha256Hex(canonicalize(deliverable.verificationMethod)) ||
        producerAdmission.deliverableSpecHash !==
          sha256Hex(canonicalize(deliverable)) ||
        producerAdmission.admittedAt > committed.commitment.committedAt) {
      return reject("payload-verification-producer-admission-mismatch");
    }
  }
  try {
    validateFixedPriceAgreementBinding({
      agreement: agreementArtifact,
      verifiedListing: {
        disposition: "verified",
        listing,
        pin: { ...agreement.listingRef },
      },
      committedAt: committed.commitment.committedAt,
    });
  } catch {
    return reject("agreement-listing-conformance-failed");
  }
  const listingMismatch = verifyAgreementListing(
    agreement,
    listing,
    request.phaseIndex,
    request.railId,
  );
  if (listingMismatch) return reject(listingMismatch);

  const payoutBindings = agreement.terms.payoutBindings.filter((binding) =>
    binding.railId === request.railId && binding.phaseIndex === request.phaseIndex);
  if (payoutBindings.length !== 1) return reject("payout-binding-mismatch");
  const payout = payoutBindings[0]!;

  const railCall = await callSecurityBoundaryWithInput({
      ref: structuredClone(agreement.terms.rail),
      railRegistryVersion: committed.railRegistryVersion,
    }, (railInput) => resolveRail.call(deps, railInput));
  if (railCall.status === "threw") {
    return indeterminate("rail-resolution-unavailable");
  }
  if (railCall.status !== "ok" ||
      !isSellerRailResolutionValue(railCall.value)) {
    return verifierError("rail-resolution-invalid-result");
  }
  const railResult = railCall.value;
  if (railResult.disposition !== "verified") {
    if (typeof railResult.reason !== "string" || railResult.reason.length === 0) {
      return verifierError("rail-resolution-invalid-result");
    }
    return railResult.disposition === "indeterminate"
      ? indeterminate(`rail-${railResult.reason}`)
      : reject(`rail-${railResult.reason}`);
  }
  const rail = railResult.rail;
  if (!isSafeUint(railResult.railRegistryVersion) ||
      railResult.railRegistryVersion !== committed.railRegistryVersion ||
      !validRailShape(rail) || rail.railId !== request.railId ||
      agreement.terms.rail.railVersion !== undefined &&
      agreement.terms.rail.railVersion !== rail.railVersion) {
    return reject("unsupported-or-mismatched-rail");
  }
  if (rail.phaseHandler !== request.receipt.kind) return reject("receipt-rail-kind-mismatch");
  if (agreement.terms.price.currency !== rail.asset.symbol) return reject("payment-asset-mismatch");

  const [buyerCall, sellerCall] = await Promise.all([
    callSecurityBoundary(() =>
      resolveIdentityBundle.call(deps, agreement.buyer.bundleHash)),
    callSecurityBoundary(() =>
      resolveIdentityBundle.call(deps, agreement.seller.bundleHash)),
  ]);
  if (buyerCall.status === "threw" || sellerCall.status === "threw") {
    return indeterminate("party-bundle-resolution-unavailable");
  }
  if (buyerCall.status !== "ok" || sellerCall.status !== "ok" ||
      !isIdentityBundleResolutionValue(buyerCall.value) ||
      !isIdentityBundleResolutionValue(sellerCall.value)) {
    return verifierError("party-bundle-resolution-invalid-result");
  }
  const buyerResult = buyerCall.value;
  const sellerResult = sellerCall.value;
  if (buyerResult.disposition !== "verified") {
    if (typeof buyerResult.reason !== "string" || buyerResult.reason.length === 0) {
      return verifierError("party-bundle-resolution-invalid-result");
    }
    return buyerResult.disposition === "indeterminate"
      ? indeterminate(`buyer-bundle-${buyerResult.reason}`)
      : reject(`buyer-bundle-${buyerResult.reason}`);
  }
  if (sellerResult.disposition !== "verified") {
    if (typeof sellerResult.reason !== "string" || sellerResult.reason.length === 0) {
      return verifierError("party-bundle-resolution-invalid-result");
    }
    return sellerResult.disposition === "indeterminate"
      ? indeterminate(`seller-bundle-${sellerResult.reason}`)
      : reject(`seller-bundle-${sellerResult.reason}`);
  }
  const buyerBundle = buyerResult.bundle;
  const sellerBundle = sellerResult.bundle;
  if (identityBundleHash(buyerBundle) !== agreement.buyer.bundleHash ||
      buyerBundle.presentedBy !== agreement.buyer.primaryClaim ||
      identityBundleHash(sellerBundle) !== agreement.seller.bundleHash ||
      sellerBundle.presentedBy !== agreement.seller.primaryClaim) {
    return reject("party-bundle-agreement-mismatch");
  }
  if (!buyerBundle.claims.some((claim) => claim.ref === request.payerPayingKey)) {
    return reject("payer-paying-key-not-in-bundle");
  }

  const common = {
    agreementHash: computedAgreementHash,
    listingRef: agreement.listingRef,
    railId: request.railId,
    railRegistryVersion: committed.railRegistryVersion,
    commitment: {
      ref: committed.commitment.ref,
      contentHash: committed.commitment.contentHash,
      finalizedAt: committed.commitment.committedAt,
    },
    ...(producerAdmission
      ? { payloadVerificationProducerAdmission: producerAdmission }
      : {}),
  };

  if (rail.railType === "demos-native" && request.receipt.kind === "pay-dem") {
    const receipt = request.receipt;
    const payerAddress = demosAddressFromClaim(request.payerPayingKey);
    const payeeAddress = demosAddressFromClaim(agreement.seller.primaryClaim);
    const payoutAddress = normalizeDemosNativeAddress(payout.payeeAddress);
    if (!payerAddress) return reject("payer-address-not-demos-bound");
    if (!payeeAddress || !payoutAddress || payoutAddress !== payeeAddress) {
      return reject("payee-destination-binding-mismatch");
    }
    const claimedTxHash = canonicalTxHash(receipt.txHash);
    if (!claimedTxHash) return verifierError("malformed-settlement-identity");
    const observation = await callSecurityBoundary(() =>
      observeDemosTransfer.call(deps, receipt.txHash));
    if (observation.status === "threw") {
      return indeterminate("demos-observation-unavailable");
    }
    if (observation.status !== "ok" ||
        !isDemosTransferObservationValue(observation.value)) {
      return verifierError("demos-observation-invalid-result");
    }
    const observed = observation.value;
    if (observed.status !== "included") {
      return observed.status === "failed"
        ? reject("demos-transfer-failed")
        : indeterminate(`demos-${observed.status}`);
    }
    const observedPayer = normalizeDemosNativeAddress(observed.payer);
    const observedPayee = normalizeDemosNativeAddress(observed.payee);
    if (
      canonicalTxHash(observed.txHash) !== claimedTxHash ||
      !observedPayer || observedPayer !== payerAddress ||
      !observedPayee || observedPayee !== payeeAddress
    ) return reject("demos-transfer-party-or-identity-mismatch");
    let expectedAmountOs: string;
    try {
      expectedAmountOs = baseUnits(agreement.terms.price.amount, DEM_DECIMALS);
    } catch {
      return reject("payment-amount-invalid");
    }
    if (!INTEGER_RE.test(observed.amountOs) || observed.amountOs !== expectedAmountOs) {
      return reject("payment-amount-mismatch");
    }
    if (!isSafeUint(observed.blockNumber) || !isSafeUint(observed.includedAt)) {
      return reject("demos-finality-invalid");
    }
    if (observed.includedAt < committed.commitment.committedAt) {
      return reject("payment-before-finalized-commitment");
    }
    if (observed.includedAt > agreement.terms.deadline) return reject("payment-after-deadline");
    const settlementId = canonicalSellerSettlementId({ kind: "demos", txHash: observed.txHash });
    if (!settlementId) return verifierError("malformed-settlement-identity");
    const evidenceInput: SellerPaymentEvidenceInput = {
      evidenceVersion: "1",
      jobId: request.jobId,
      phase: "pay-dem",
      outcome: "success",
      paymentTxRefs: [{
        kind: "demos",
        txHash: observed.txHash,
        blockNumber: observed.blockNumber,
      }],
      paymentAmount: { ...agreement.terms.price },
      settlementFinality: {
        model: "bft-final",
        finalityObservedAt: observed.includedAt,
      },
      observedAt: observed.includedAt,
    };
    return settleReplay({
      ...common,
      settlementId,
      settlementIdentity: {
        kind: "demos",
        txHash: observed.txHash,
        blockNumber: observed.blockNumber,
        includedAt: observed.includedAt,
      },
      evidenceInput,
      payoutBindingTier: 1,
    }, request, claimReceipt);
  }

  if (rail.railType !== "x402" || request.receipt.kind !== "pay-x402") {
    return reject("receipt-rail-kind-mismatch");
  }
  if (!resourceAllowed(request.receipt.httpResource, rail.network.resourceBaseUrl)) {
    return reject("x402-http-resource-mismatch");
  }
  const pinnedResource = agreement.terms.rail.parameters?.httpResource;
  if (typeof pinnedResource === "string" && pinnedResource !== request.receipt.httpResource) {
    return reject("x402-http-resource-mismatch");
  }
  const receiptVerification = verifyX402ReceiptClaim({
    protocolVersion: request.receipt.protocolVersion,
    responseHeader: request.receipt.responseHeader,
    evidence: {
      paymentReceiptHash: request.receipt.paymentReceiptHash,
      settlementTxHash: request.receipt.settlementTxHash,
      chainId: request.receipt.chainId,
    },
  });
  if (receiptVerification.disposition !== "pass" || !receiptVerification.receipt) {
    // X402-4 classifies malformed/non-success/hash-mismatched receipts as a
    // permanent refusal. The SB-1 `error` class below is narrower: it is for a
    // settlement event identity that cannot be canonicalised.
    return receiptVerification.reason === "invalid-chainId"
      ? verifierError("malformed-settlement-identity")
      : reject(`x402-${receiptVerification.reason}`);
  }
  const extensionCall = await callSecurityBoundaryWithInput({
      protocolVersion: request.receipt.protocolVersion,
      receipt: structuredClone(receiptVerification.receipt),
    }, (extensionInput) =>
      verifyX402ReceiptExtensions.call(deps, extensionInput));
  if (extensionCall.status === "threw") {
    return indeterminate("x402-extension-verification-unavailable");
  }
  if (extensionCall.status !== "ok") {
    return verifierError("x402-extension-verifier-invalid-result");
  }
  const extensionVerification = extensionCall.value;
  if (!isX402ReceiptExtensionVerificationValue(extensionVerification)) {
    return verifierError("x402-extension-verifier-invalid-result");
  }
  if (extensionVerification.disposition === "fail") {
    return reject(`x402-extension-${extensionVerification.reason}`);
  }
  if (extensionVerification.disposition === "indeterminate") {
    return indeterminate(`x402-extension-${extensionVerification.reason}`);
  }
  if (extensionVerification.disposition === "error") {
    return verifierError(`x402-extension-${extensionVerification.reason}`);
  }
  if (request.receipt.settlementTxHash === undefined || request.receipt.chainId === undefined) {
    // SB-1 requires event-level EVM identity. Provider-receipt fallback cannot
    // mint a seller fulfilment permit until such an identity is recoverable.
    return indeterminate("x402-settlement-identity-unavailable");
  }
  if (request.receipt.chainId !== rail.asset.chainId) return reject("x402-chain-mismatch");
  const claimedTxHash = canonicalTxHash(request.receipt.settlementTxHash);
  if (!claimedTxHash) return verifierError("malformed-settlement-identity");

  let finalityBlocks: number;
  if (rail.parameters.finalityBlocks !== undefined) {
    if (!Number.isSafeInteger(rail.parameters.finalityBlocks) ||
        rail.parameters.finalityBlocks <= 0) {
      return reject("x402-finality-policy-invalid");
    }
    finalityBlocks = rail.parameters.finalityBlocks;
  } else if (rail.asset.chainId === 1) {
    finalityBlocks = 12;
  } else {
    const classificationCall = await callSecurityBoundaryWithInput({
        chainId: rail.asset.chainId,
        rail: structuredClone(rail),
      }, (classificationInput) =>
        classifyX402SettlementChain.call(deps, classificationInput));
    if (classificationCall.status === "threw") {
      return indeterminate("x402-chain-classification-unavailable");
    }
    if (classificationCall.status !== "ok") {
      return verifierError("x402-chain-classifier-invalid-result");
    }
    const classification = classificationCall.value;
    if (!isX402SettlementChainClassificationValue(classification)) {
      return verifierError("x402-chain-classifier-invalid-result");
    }
    if (classification.disposition === "unsupported") {
      return reject(`x402-chain-${classification.reason}`);
    }
    if (classification.disposition === "indeterminate") {
      return indeterminate(`x402-chain-${classification.reason}`);
    }
    if (classification.disposition === "error") {
      return verifierError(`x402-chain-${classification.reason}`);
    }
    finalityBlocks = 1;
  }

  const [payerCall, destinationCall] = await Promise.all([
    callSecurityBoundaryWithInput({
      payingKey: request.payerPayingKey,
      buyerBundle,
      rail,
    }, (payerInput) => resolvePayerAddress.call(deps, payerInput)),
    callSecurityBoundaryWithInput({
        payeePrimaryClaim: agreement.seller.primaryClaim,
        payeeBundle: sellerBundle,
        payoutAddress: payout.payeeAddress,
        rail,
      }, (destinationInput) =>
        resolvePayeeDestination.call(deps, destinationInput)),
  ]);
  if (payerCall.status === "threw" || destinationCall.status === "threw") {
    return indeterminate("address-binding-resolution-unavailable");
  }
  if (payerCall.status !== "ok" || destinationCall.status !== "ok" ||
      !isAddressResolutionValue(payerCall.value) ||
      !isDestinationBindingResolutionValue(destinationCall.value)) {
    return verifierError("address-binding-resolution-invalid-result");
  }
  const payerResolution = payerCall.value;
  const destinationResolution = destinationCall.value;
  if (payerResolution.disposition !== "verified") {
    if (typeof payerResolution.reason !== "string" || payerResolution.reason.length === 0) {
      return verifierError("address-binding-resolution-invalid-result");
    }
    return payerResolution.disposition === "indeterminate"
      ? indeterminate(`payer-address-${payerResolution.reason}`)
      : reject(`payer-address-${payerResolution.reason}`);
  }
  if (destinationResolution.disposition !== "bound") {
    if (typeof destinationResolution.reason !== "string" ||
        destinationResolution.reason.length === 0) {
      return verifierError("address-binding-resolution-invalid-result");
    }
    if (destinationResolution.disposition === "indeterminate") {
      return indeterminate(
        `payee-destination-${destinationResolution.reason}`,
      );
    }
    if (destinationResolution.disposition === "error") {
      return verifierError(
        `payee-destination-${destinationResolution.reason}`,
      );
    }
    return reject(`payee-destination-${destinationResolution.reason}`);
  }
  if (normalizeAddress(destinationResolution.address) !== normalizeAddress(payout.payeeAddress)) {
    return reject("payee-destination-binding-mismatch");
  }

  const observation = await callSecurityBoundaryWithInput({
      chainId: request.receipt.chainId,
      txHash: request.receipt.settlementTxHash,
    }, (observationInput) => observeX402Transfer.call(deps, observationInput));
  if (observation.status === "threw") {
    return indeterminate("x402-observation-unavailable");
  }
  if (observation.status !== "ok" ||
      !isX402TransferObservationValue(observation.value)) {
    return verifierError("x402-observation-invalid-result");
  }
  const observed = observation.value;
  if (observed.status !== "finalized") {
    return observed.status === "failed"
      ? reject("x402-transfer-failed")
      : indeterminate(`x402-${observed.status}`);
  }
  const receiptPayer = receiptVerification.receipt.payer;
  if (typeof receiptPayer !== "string" || receiptPayer.length === 0) {
    return verifierError("x402-receipt-payer-malformed");
  }
  if (
    observed.chainId !== request.receipt.chainId ||
    canonicalTxHash(observed.txHash) !== claimedTxHash ||
    normalizeAddress(observed.payer) !== normalizeAddress(payerResolution.address) ||
    normalizeAddress(receiptPayer) !==
      normalizeAddress(payerResolution.address) ||
    normalizeAddress(observed.payee) !== normalizeAddress(payout.payeeAddress)
  ) return reject("x402-transfer-party-or-identity-mismatch");
  if (
    normalizeAddress(observed.asset.contract) !== normalizeAddress(rail.asset.contract) ||
    observed.asset.symbol !== rail.asset.symbol ||
    observed.asset.decimals !== rail.asset.decimals
  ) return reject("x402-asset-mismatch");
  let expectedBaseUnits: string;
  try {
    expectedBaseUnits = baseUnits(agreement.terms.price.amount, rail.asset.decimals);
  } catch {
    return reject("payment-amount-invalid");
  }
  if (!INTEGER_RE.test(observed.amountBaseUnits) || observed.amountBaseUnits !== expectedBaseUnits) {
    return reject("payment-amount-mismatch");
  }
  if (!isSafeUint(observed.confirmations) || observed.confirmations < finalityBlocks ||
      !isSafeUint(observed.includedAt) || !isSafeUint(observed.finalityObservedAt) ||
      observed.finalityObservedAt < observed.includedAt) {
    return reject("x402-finality-mismatch");
  }
  if (observed.includedAt < committed.commitment.committedAt) {
    return reject("payment-before-finalized-commitment");
  }
  if (observed.finalityObservedAt > agreement.terms.deadline) return reject("payment-after-deadline");

  let sessionBinding: SellerSessionBindingGuarantee = "not-established";
  if (!isRecord(observed.sessionBinding) ||
      typeof observed.sessionBinding.kind !== "string") {
    return verifierError("x402-session-binding-malformed");
  }
  switch (observed.sessionBinding.kind) {
    case "eip3009":
      if (!hasExactKeys(observed.sessionBinding, ["kind", "nonce"]) ||
          typeof observed.sessionBinding.nonce !== "string" ||
          !/^0x[0-9a-f]{64}$/.test(observed.sessionBinding.nonce)) {
        return verifierError("x402-session-nonce-malformed");
      }
      if (observed.sessionBinding.nonce !==
          x402Eip3009Nonce(request.jobId, request.phaseIndex)) {
        return reject("x402-session-binding-mismatch");
      }
      sessionBinding = "established";
      break;
    case "permit2":
      if (!hasExactKeys(observed.sessionBinding, ["kind", "jobId"]) ||
          typeof observed.sessionBinding.jobId !== "string" ||
          observed.sessionBinding.jobId.length === 0) {
        return verifierError("x402-session-binding-malformed");
      }
      if (observed.sessionBinding.jobId !== request.jobId) {
        return reject("x402-session-binding-mismatch");
      }
      sessionBinding = "established";
      break;
    case "absent":
      if (!hasExactKeys(observed.sessionBinding, ["kind"])) {
        return verifierError("x402-session-binding-malformed");
      }
      break;
    case "unverifiable":
      if (!hasExactKeys(observed.sessionBinding, ["kind", "reason"]) ||
          typeof observed.sessionBinding.reason !== "string" ||
          observed.sessionBinding.reason.length === 0) {
        return verifierError("x402-session-binding-malformed");
      }
      break;
    default:
      return verifierError("x402-session-binding-unsupported");
  }

  const settlementId = canonicalSellerSettlementId({
    kind: "evm",
    chainId: observed.chainId,
    txHash: observed.txHash,
    logIndex: observed.logIndex,
  });
  if (!settlementId) return verifierError("malformed-settlement-identity");
  const evidenceInput: SellerPaymentEvidenceInput = {
    evidenceVersion: "1",
    jobId: request.jobId,
    phase: "pay-x402",
    outcome: "success",
    paymentTxRefs: [{
      kind: "x402",
      httpResource: request.receipt.httpResource,
      paymentReceiptHash: request.receipt.paymentReceiptHash,
      settlementTxHash: request.receipt.settlementTxHash,
      chainId: request.receipt.chainId,
      protocolVersion: request.receipt.protocolVersion,
    }],
    paymentAmount: { ...agreement.terms.price },
    settlementFinality: {
      model: "block-depth",
      finalityBlocks,
      finalityObservedAt: observed.finalityObservedAt,
    },
    observedAt: observed.finalityObservedAt,
  };
  return settleReplay({
    ...common,
    settlementId,
    settlementIdentity: {
      kind: "evm",
      chainId: observed.chainId,
      txHash: observed.txHash,
      logIndex: observed.logIndex,
      includedAt: observed.includedAt,
    },
    evidenceInput,
    payoutBindingTier: destinationResolution.tier,
    sessionBinding,
  }, request, claimReceipt);
}
