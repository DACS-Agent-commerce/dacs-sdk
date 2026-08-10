import type {
  ListingRef,
  SettlementEvidence,
} from "../artifacts/types.js";
import {
  assertPositiveAmount,
  canonicalize,
  sha256Hex,
} from "../canonical/index.js";

/** Exact registry definition selected and hash-pinned for the session. */
export interface SellerRailPin {
  railId: string;
  railVersion: number;
  contentHash: string;
}

export interface SellerPayoutBinding {
  railId: string;
  phaseIndex: number;
  payeeAddress: string;
}

/**
 * Strict normalized view of a finalized DACS-3 payee-bound agreement. The
 * resolver that produces it owns artifact parsing/signature verification; this
 * core independently checks every action-bearing field against the request,
 * Listing, rail, receipt, and finalized commitment.
 */
export interface SellerCommittedAgreement {
  artifactKind: "payee-bound";
  ref: string;
  contentHash: string;
  jobId: string;
  listingPin: ListingRef;
  buyer: { primaryClaim: string; bundleHash: string };
  seller: { primaryClaim: string; bundleHash: string };
  price: { amount: string; currency: string };
  railPin: SellerRailPin;
  payoutBindings: SellerPayoutBinding[];
  signaturesVerified: boolean;
  commitment: {
    status: "finalized";
    ref: string;
    agreementHash: string;
    recordContentHash: string;
    finalizedAt: number;
  };
}

export interface SellerPinnedListing {
  pin: ListingRef;
  sellerPrimaryClaim: string;
  pipeline: Array<{ kind: string; parameters?: Record<string, unknown> }>;
}

export interface SellerPinnedRail {
  pin: SellerRailPin;
  railType: "x402" | "demos-native";
  phaseHandler: "pay-x402" | "pay-dem";
  asset: {
    /** Human-facing symbol bound into the agreement price (for example USDC). */
    symbol: string;
    /** Rail-native asset identity (for example an EVM token contract). */
    identifier?: string;
  };
  network:
    | { kind: "evm"; chainId: number }
    | { kind: "demos" };
}

export type SellerAuthorityResolution<T> =
  | { status: "verified"; value: T; evidence?: Record<string, unknown> }
  | { status: "rejected"; reason: string; evidence?: Record<string, unknown> }
  | {
      status: "indeterminate";
      reason: string;
      evidence?: Record<string, unknown>;
    };

export interface SellerPaymentClaim {
  jobId: string;
  phaseIndex: number;
  agreementRef: string;
  agreementHash: string;
  commitmentRef: string;
  listingPin: ListingRef;
  railPin: SellerRailPin;
  payer: {
    primaryClaim: string;
    bundleHash: string;
    payingKey: string;
  };
  payee: {
    primaryClaim: string;
    bundleHash: string;
    payeeAddress: string;
  };
  amount: { amount: string; currency: string };
  receipt:
    | { kind: "x402"; message: unknown }
    | { kind: "pay-dem"; message: unknown };
}

export type X402SessionBinding =
  | { kind: "permit2-witness"; jobId: string; phaseIndex: number }
  | { kind: "eip-3009"; nonce: string }
  | { kind: "absent" };

export interface VerifiedX402SellerReceipt {
  kind: "x402";
  railId: string;
  payer: string;
  payeeAddress: string;
  amount: string;
  asset: string;
  /** Network spelling carried by the x402 response before CAIP-2 normalization. */
  responseNetwork: string;
  /** Verified CAIP-2 mapping of responseNetwork. */
  chainId: string;
  authorizationId: string;
  sessionBinding: X402SessionBinding;
  protocolVersion: "1" | "2";
  httpResource: string;
  settlementResponseJcs: string;
  paymentReceiptHash: string;
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  blockTimestamp: number;
  finalityBlocks: number;
  finality: { model: "block-depth"; finalityObservedAt: number };
  facilitatorSignature?: string;
}

export interface VerifiedPayDemSellerReceipt {
  kind: "pay-dem";
  railId: string;
  payer: string;
  payeeAddress: string;
  amount: string;
  asset: "DEM";
  network: "demos";
  transactionHash: string;
  blockNumber: number;
  included: true;
  finality: { model: "bft-final"; finalityObservedAt: number };
}

export type VerifiedSellerReceipt =
  | VerifiedX402SellerReceipt
  | VerifiedPayDemSellerReceipt;

export type SellerReceiptVerification<T extends VerifiedSellerReceipt> =
  | { status: "verified"; receipt: T; evidence?: Record<string, unknown> }
  | { status: "rejected"; reason: string; evidence?: Record<string, unknown> }
  | {
      status: "indeterminate";
      reason: string;
      evidence?: Record<string, unknown>;
    }
  | {
      status: "ambiguous";
      /** Deterministic rail-native identity used for reconciliation, never a random retry id. */
      settlementIdentity: string;
      authorizationIdentity: string;
      reason: string;
      evidence?: Record<string, unknown>;
    };

export type SellerReceiptReconciliation =
  | { status: "verified"; receipt: VerifiedSellerReceipt; evidence?: Record<string, unknown> }
  | { status: "rejected"; reason: string; evidence?: Record<string, unknown> }
  | {
      status: "indeterminate";
      reason: string;
      evidence?: Record<string, unknown>;
    }
  | {
      status: "absent";
      /** True only when the rail authoritatively proves that no settlement landed. */
      authoritative: boolean;
      evidence?: Record<string, unknown>;
    };

export type SellerSettlementEvidenceInput = Extract<
  SettlementEvidence,
  { outcome: "success" }
>;

export interface SellerPaymentIntakeRecord {
  phaseKey: string;
  requestHash: string;
  settlementIdentity: string;
  authorizationIdentity: string;
  evidenceHash: string;
  evidenceInput: SellerSettlementEvidenceInput;
  fulfilmentId: string;
  createdAt: number;
}

export type SellerPaymentPersistenceResult =
  | { status: "accepted"; record: SellerPaymentIntakeRecord }
  | { status: "duplicate"; record: SellerPaymentIntakeRecord }
  | {
      status: "conflict";
      reason:
        | "phase-conflict"
        | "settlement-replay"
        | "authorization-replay"
        | "request-replay";
      existing?: SellerPaymentIntakeRecord;
    };

/**
 * Atomic persistence boundary. A durable implementation MUST compare and insert
 * the phase, request, authorization, settlement, evidence, and fulfilment-outbox
 * identities in one transaction. This is what makes restart replay fail closed.
 */
export interface SellerPaymentIntakeStore {
  accept(record: SellerPaymentIntakeRecord): Promise<SellerPaymentPersistenceResult>;
}

export interface SellerPaymentIntakeDeps {
  resolveAgreement: (
    ref: string,
  ) => Promise<SellerAuthorityResolution<SellerCommittedAgreement>>;
  resolveListing: (
    pin: Readonly<ListingRef>,
  ) => Promise<SellerAuthorityResolution<SellerPinnedListing>>;
  resolveRail: (
    pin: Readonly<SellerRailPin>,
  ) => Promise<SellerAuthorityResolution<SellerPinnedRail>>;
  verifyX402Receipt: (
    message: unknown,
  ) => Promise<SellerReceiptVerification<VerifiedX402SellerReceipt>>;
  verifyPayDemReceipt: (
    message: unknown,
  ) => Promise<SellerReceiptVerification<VerifiedPayDemSellerReceipt>>;
  /** Reconcile only by the deterministic identities returned for an ambiguous result. */
  reconcileReceipt?: (input: {
    kind: SellerPaymentClaim["receipt"]["kind"];
    settlementIdentity: string;
    authorizationIdentity: string;
  }) => Promise<SellerReceiptReconciliation>;
  nowMs: () => number;
  store: SellerPaymentIntakeStore;
}

export type SellerPaymentIntakeResult =
  | {
      decision: "verified";
      duplicate: boolean;
      settlementIdentity: string;
      authorizationIdentity: string;
      evidenceInput: SellerSettlementEvidenceInput;
      evidenceHash: string;
      /**
       * Only `enqueue` creates a new durable outbox item. A host must never invoke
       * work merely because it saw `already-enqueued`; its outbox consumer owns
       * callback delivery with fulfilmentId as the idempotency key.
       */
      fulfilment: {
        action: "enqueue" | "already-enqueued";
        fulfilmentId: string;
      };
    }
  | {
      decision: "rejected";
      code: string;
      reasons: string[];
    }
  | {
      decision: "indeterminate";
      code: string;
      reasons: string[];
      reconciliationIdentity?: string;
      /** True only after an authoritative rail lookup proves no settlement landed. */
      safeToRetry: boolean;
    };

const rejected = (code: string, ...reasons: string[]): SellerPaymentIntakeResult => ({
  decision: "rejected",
  code,
  reasons,
});

const indeterminate = (
  code: string,
  reasons: string[],
  options: { reconciliationIdentity?: string; safeToRetry?: boolean } = {},
): SellerPaymentIntakeResult => ({
  decision: "indeterminate",
  code,
  reasons,
  ...(options.reconciliationIdentity
    ? { reconciliationIdentity: options.reconciliationIdentity }
    : {}),
  safeToRetry: options.safeToRetry ?? false,
});

function pinsEqual(left: ListingRef, right: ListingRef): boolean {
  return (
    left.listingId === right.listingId &&
    left.version === right.version &&
    left.contentHash === right.contentHash
  );
}

function railPinsEqual(left: SellerRailPin, right: SellerRailPin): boolean {
  return (
    left.railId === right.railId &&
    left.railVersion === right.railVersion &&
    left.contentHash === right.contentHash
  );
}

function canonicalAmount(value: string): string | null {
  try {
    return assertPositiveAmount(value);
  } catch {
    return null;
  }
}

function sameAmount(left: string, right: string): boolean {
  const a = canonicalAmount(left);
  const b = canonicalAmount(right);
  return a !== null && b !== null && a === left && b === right && left === right;
}

function sameAddress(left: string, right: string, evm: boolean): boolean {
  return evm
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function normalizedEvmTxHash(value: string): string | null {
  const stripped = /^0x/i.test(value) ? value.slice(2) : value;
  return /^[0-9a-fA-F]{64}$/.test(stripped) ? stripped.toLowerCase() : null;
}

/** CORE §B.8 SB-1 canonical event identity for EVM/x402. */
export function x402SettlementIdentity(input: {
  chainId: string;
  transactionHash: string;
  logIndex: number;
}): string | null {
  const match = /^eip155:([1-9][0-9]*)$/.exec(input.chainId);
  if (!match || !Number.isSafeInteger(input.logIndex) || input.logIndex < 0) {
    return null;
  }
  const txHash = normalizedEvmTxHash(input.transactionHash);
  return txHash
    ? `evm:${match[1]}:${txHash}:${input.logIndex}`
    : null;
}

/** CORE §B.8 SB-1 canonical native-Demos settlement identity. */
export function payDemSettlementIdentity(transactionHash: string): string | null {
  const normalized = transactionHash.trim();
  return normalized.length > 0 ? `demos:${normalized}` : null;
}

/** Exact DACS-4 SB-3 EIP-3009 nonce derivation. */
export function sellerX402AuthorizationNonce(
  jobId: string,
  phaseIndex: number,
): string | null {
  if (
    typeof jobId !== "string" ||
    jobId.length === 0 ||
    !Number.isSafeInteger(phaseIndex) ||
    phaseIndex < 0
  ) {
    return null;
  }
  const preimage = Buffer.concat([
    Buffer.from("dacs-sb3:v1:", "utf8"),
    Buffer.from(jobId.normalize("NFC"), "utf8"),
    Buffer.from(":"),
    Buffer.from(String(phaseIndex), "ascii"),
  ]);
  return `0x${sha256Hex(preimage)}`;
}

function receiptIdentity(receipt: VerifiedSellerReceipt): string | null {
  return receipt.kind === "x402"
    ? x402SettlementIdentity(receipt)
    : payDemSettlementIdentity(receipt.transactionHash);
}

function authorizationIdentity(receipt: VerifiedSellerReceipt): string | null {
  if (receipt.kind === "x402") {
    const id = receipt.authorizationId.trim();
    return id.length > 0 ? `x402:${id}` : null;
  }
  return payDemSettlementIdentity(receipt.transactionHash);
}

function ambiguousIdentityIsWellFormed(
  kind: SellerPaymentClaim["receipt"]["kind"],
  settlementIdentity: string,
  authorizationIdentityValue: string,
): boolean {
  return kind === "x402"
    ? /^evm:[1-9][0-9]*:[0-9a-f]{64}:[0-9]+$/.test(settlementIdentity) &&
        authorizationIdentityValue.startsWith("x402:")
    : settlementIdentity.startsWith("demos:") &&
        authorizationIdentityValue === settlementIdentity;
}

async function resolveVerifiedReceipt(
  claim: SellerPaymentClaim,
  deps: SellerPaymentIntakeDeps,
): Promise<
  | { status: "verified"; receipt: VerifiedSellerReceipt }
  | { status: "terminal"; result: SellerPaymentIntakeResult }
> {
  let verification: SellerReceiptVerification<VerifiedSellerReceipt>;
  try {
    verification = claim.receipt.kind === "x402"
      ? await deps.verifyX402Receipt(claim.receipt.message)
      : await deps.verifyPayDemReceipt(claim.receipt.message);
  } catch (error) {
    return {
      status: "terminal",
      result: indeterminate("receipt-verifier-failed", [String(error)]),
    };
  }

  if (verification.status === "rejected") {
    return {
      status: "terminal",
      result: rejected("receipt-rejected", verification.reason),
    };
  }
  if (verification.status === "indeterminate") {
    return {
      status: "terminal",
      result: indeterminate("receipt-indeterminate", [verification.reason]),
    };
  }
  if (verification.status === "verified") {
    if (
      (claim.receipt.kind === "x402" && verification.receipt.kind !== "x402") ||
      (claim.receipt.kind === "pay-dem" && verification.receipt.kind !== "pay-dem")
    ) {
      return {
        status: "terminal",
        result: rejected(
          "rail-receipt-type-confusion",
          "receipt verifier returned a different rail kind",
        ),
      };
    }
    return { status: "verified", receipt: verification.receipt };
  }

  if (
    !ambiguousIdentityIsWellFormed(
      claim.receipt.kind,
      verification.settlementIdentity,
      verification.authorizationIdentity,
    )
  ) {
    return {
      status: "terminal",
      result: rejected(
        "ambiguous-identity-malformed",
        "ambiguous receipt lacks a canonical deterministic identity",
      ),
    };
  }
  if (!deps.reconcileReceipt) {
    return {
      status: "terminal",
      result: indeterminate(
        "reconciliation-required",
        [verification.reason],
        { reconciliationIdentity: verification.settlementIdentity },
      ),
    };
  }

  let reconciliation: SellerReceiptReconciliation;
  try {
    reconciliation = await deps.reconcileReceipt({
      kind: claim.receipt.kind,
      settlementIdentity: verification.settlementIdentity,
      authorizationIdentity: verification.authorizationIdentity,
    });
  } catch (error) {
    reconciliation = { status: "indeterminate", reason: String(error) };
  }
  if (reconciliation.status === "absent") {
    return {
      status: "terminal",
      result: indeterminate(
        "settlement-not-found",
        [
          reconciliation.authoritative
            ? "rail authoritatively found no settlement"
            : "non-authoritative absence cannot establish a safe retry",
        ],
        {
          reconciliationIdentity: verification.settlementIdentity,
          safeToRetry: reconciliation.authoritative,
        },
      ),
    };
  }
  if (reconciliation.status === "rejected") {
    return {
      status: "terminal",
      result: rejected("reconciliation-rejected", reconciliation.reason),
    };
  }
  if (reconciliation.status === "indeterminate") {
    return {
      status: "terminal",
      result: indeterminate(
        "reconciliation-indeterminate",
        [reconciliation.reason],
        { reconciliationIdentity: verification.settlementIdentity },
      ),
    };
  }
  if (
    (claim.receipt.kind === "x402" && reconciliation.receipt.kind !== "x402") ||
    (claim.receipt.kind === "pay-dem" && reconciliation.receipt.kind !== "pay-dem")
  ) {
    return {
      status: "terminal",
      result: rejected(
        "rail-receipt-type-confusion",
        "reconciliation returned a different rail kind",
      ),
    };
  }
  const reconciledSettlement = receiptIdentity(reconciliation.receipt);
  const reconciledAuthorization = authorizationIdentity(reconciliation.receipt);
  if (
    reconciledSettlement !== verification.settlementIdentity ||
    reconciledAuthorization !== verification.authorizationIdentity
  ) {
    return {
      status: "terminal",
      result: rejected(
        "reconciliation-identity-mismatch",
        "reconciled receipt does not preserve the ambiguous deterministic identity",
      ),
    };
  }
  return { status: "verified", receipt: reconciliation.receipt };
}

function buildEvidenceInput(
  claim: SellerPaymentClaim,
  receipt: VerifiedSellerReceipt,
  observedAt: number,
): SellerSettlementEvidenceInput {
  if (receipt.kind === "pay-dem") {
    return {
      evidenceVersion: "1",
      jobId: claim.jobId,
      phase: claim.railPin.railId,
      phaseIndex: claim.phaseIndex,
      paymentTxRefs: [
        {
          rail: "demos",
          txHash: receipt.transactionHash,
          kind: "demos",
          blockNumber: receipt.blockNumber,
        },
      ],
      observedAt,
      outcome: "success",
      paymentAmount: {
        amount: claim.amount.amount,
        currency: claim.amount.currency,
      },
      settlementFinality: {
        model: "bft-final",
        finalityObservedAt: receipt.finality.finalityObservedAt,
      },
    };
  }

  return {
    evidenceVersion: "1",
    jobId: claim.jobId,
    phase: claim.railPin.railId,
    phaseIndex: claim.phaseIndex,
    paymentTxRefs: [
      {
        rail: receipt.chainId,
        txHash: receipt.transactionHash,
        kind: "x402",
        httpResource: receipt.httpResource,
        paymentReceiptHash: receipt.paymentReceiptHash,
        protocolVersion: receipt.protocolVersion,
        facilitatorReceiptJcs: receipt.settlementResponseJcs,
        ...(receipt.facilitatorSignature
          ? { facilitatorSignature: receipt.facilitatorSignature }
          : {}),
        chainId: receipt.chainId,
        settlementTxHash: receipt.transactionHash,
        logIndex: receipt.logIndex,
        blockNumber: receipt.blockNumber,
        blockTimestamp: receipt.blockTimestamp,
        finalityBlocks: receipt.finalityBlocks,
      },
    ],
    observedAt,
    outcome: "success",
    paymentAmount: {
      amount: claim.amount.amount,
      currency: claim.amount.currency,
    },
    settlementFinality: {
      model: "block-depth",
      finalityBlocks: receipt.finalityBlocks,
      finalityObservedAt: receipt.finality.finalityObservedAt,
    },
  };
}

/**
 * Pure seller-side intake gate. It verifies and persists a fulfilment outbox
 * command; it never starts a server, transport, private channel, or application
 * callback and never submits/rebroadcasts a payment.
 */
export async function sellerPaymentIntakeCore(
  claim: SellerPaymentClaim,
  deps: SellerPaymentIntakeDeps,
): Promise<SellerPaymentIntakeResult> {
  if (
    typeof claim.jobId !== "string" ||
    claim.jobId.length === 0 ||
    !Number.isSafeInteger(claim.phaseIndex) ||
    claim.phaseIndex < 0
  ) {
    return rejected("invalid-phase-key", "jobId and non-negative phaseIndex are required");
  }

  let agreementResolution: SellerAuthorityResolution<SellerCommittedAgreement>;
  try {
    agreementResolution = await deps.resolveAgreement(claim.agreementRef);
  } catch (error) {
    agreementResolution = { status: "indeterminate", reason: String(error) };
  }
  if (agreementResolution.status === "rejected") {
    return rejected("agreement-rejected", agreementResolution.reason);
  }
  if (agreementResolution.status === "indeterminate") {
    return indeterminate("agreement-indeterminate", [agreementResolution.reason]);
  }
  const agreement = agreementResolution.value;
  if (
    agreement.artifactKind !== "payee-bound" ||
    !agreement.signaturesVerified ||
    agreement.commitment.status !== "finalized" ||
    agreement.ref !== claim.agreementRef ||
    agreement.contentHash !== claim.agreementHash ||
    agreement.commitment.agreementHash !== claim.agreementHash ||
    agreement.commitment.recordContentHash.length === 0 ||
    agreement.commitment.ref !== claim.commitmentRef ||
    !Number.isSafeInteger(agreement.commitment.finalizedAt) ||
    agreement.commitment.finalizedAt < 0
  ) {
    return rejected(
      "agreement-commitment-mismatch",
      "agreement is not the exact signed and finalized payee-bound artifact",
    );
  }
  if (agreement.jobId !== claim.jobId) {
    return rejected("job-mismatch", "claim jobId does not match the committed agreement");
  }
  if (!pinsEqual(agreement.listingPin, claim.listingPin)) {
    return rejected("listing-pin-mismatch", "claim does not carry the agreement-pinned Listing tuple");
  }
  if (!railPinsEqual(agreement.railPin, claim.railPin)) {
    return rejected("rail-pin-mismatch", "claim does not carry the agreement-pinned rail definition");
  }

  let listingResolution: SellerAuthorityResolution<SellerPinnedListing>;
  try {
    listingResolution = await deps.resolveListing(claim.listingPin);
  } catch (error) {
    listingResolution = { status: "indeterminate", reason: String(error) };
  }
  if (listingResolution.status === "rejected") {
    return rejected("listing-rejected", listingResolution.reason);
  }
  if (listingResolution.status === "indeterminate") {
    return indeterminate("listing-indeterminate", [listingResolution.reason]);
  }
  const listing = listingResolution.value;
  if (
    !pinsEqual(listing.pin, claim.listingPin) ||
    listing.sellerPrimaryClaim !== agreement.seller.primaryClaim
  ) {
    return rejected("listing-resolution-mismatch", "resolved Listing does not match its pin or seller");
  }
  const phase = listing.pipeline[claim.phaseIndex];
  if (
    !phase ||
    (phase.kind !== "pay-x402" && phase.kind !== "pay-dem") ||
    phase.parameters?.rail !== claim.railPin.railId
  ) {
    return rejected("phase-mismatch", "phaseIndex does not select the claimed pay rail in the pinned Listing");
  }
  const expectedReceiptKind = phase.kind === "pay-x402" ? "x402" : "pay-dem";
  if (claim.receipt.kind !== expectedReceiptKind) {
    return rejected("rail-receipt-type-confusion", "receipt kind does not match the pinned phase handler");
  }

  const payPhases = listing.pipeline
    .map((entry, phaseIndex) => ({ entry, phaseIndex }))
    .filter(({ entry }) => entry.kind.startsWith("pay-"));
  if (agreement.payoutBindings.length !== payPhases.length) {
    return rejected("payout-binding-coverage", "payoutBindings do not cover exactly every pay phase");
  }
  const bindingKeys = new Set<string>();
  for (const binding of agreement.payoutBindings) {
    const key = `${binding.railId}:${binding.phaseIndex}`;
    const listedPhase = listing.pipeline[binding.phaseIndex];
    if (
      bindingKeys.has(key) ||
      !listedPhase?.kind.startsWith("pay-") ||
      listedPhase.parameters?.rail !== binding.railId
    ) {
      return rejected("payout-binding-coverage", "payoutBindings contain a duplicate, wrong-rail, or extra entry");
    }
    bindingKeys.add(key);
  }
  const payout = agreement.payoutBindings.find(
    (binding) =>
      binding.railId === claim.railPin.railId &&
      binding.phaseIndex === claim.phaseIndex,
  );
  if (
    !payout ||
    !sameAddress(
      payout.payeeAddress,
      claim.payee.payeeAddress,
      phase.kind === "pay-x402",
    )
  ) {
    return rejected("payout-destination-mismatch", "claim destination is not the agreement-signed payout binding");
  }

  if (
    claim.payer.primaryClaim !== agreement.buyer.primaryClaim ||
    claim.payer.bundleHash !== agreement.buyer.bundleHash
  ) {
    return rejected("payer-mismatch", "payer is not the agreement buyer/bundle");
  }
  if (
    claim.payee.primaryClaim !== agreement.seller.primaryClaim ||
    claim.payee.bundleHash !== agreement.seller.bundleHash
  ) {
    return rejected("payee-mismatch", "payee is not the agreement seller/bundle");
  }
  if (
    !sameAmount(claim.amount.amount, agreement.price.amount) ||
    claim.amount.currency !== agreement.price.currency
  ) {
    return rejected("amount-mismatch", "claim amount/currency does not equal the committed agreement price");
  }

  let railResolution: SellerAuthorityResolution<SellerPinnedRail>;
  try {
    railResolution = await deps.resolveRail(claim.railPin);
  } catch (error) {
    railResolution = { status: "indeterminate", reason: String(error) };
  }
  if (railResolution.status === "rejected") {
    return rejected("rail-rejected", railResolution.reason);
  }
  if (railResolution.status === "indeterminate") {
    return indeterminate("rail-indeterminate", [railResolution.reason]);
  }
  const rail = railResolution.value;
  if (
    !railPinsEqual(rail.pin, claim.railPin) ||
    rail.phaseHandler !== phase.kind ||
    rail.asset.symbol !== claim.amount.currency ||
    (phase.kind === "pay-x402" &&
      (rail.railType !== "x402" ||
        rail.network.kind !== "evm" ||
        typeof rail.asset.identifier !== "string" ||
        rail.asset.identifier.length === 0)) ||
    (phase.kind === "pay-dem" &&
      (rail.railType !== "demos-native" || rail.network.kind !== "demos"))
  ) {
    return rejected("rail-definition-mismatch", "resolved rail does not match phase, asset, or network");
  }

  const receiptResolution = await resolveVerifiedReceipt(claim, deps);
  if (receiptResolution.status === "terminal") return receiptResolution.result;
  const receipt = receiptResolution.receipt;
  const usesEvmAddress = receipt.kind === "x402";
  const expectedReceiptAsset = rail.asset.identifier ?? rail.asset.symbol;
  if (
    receipt.railId !== claim.railPin.railId ||
    claim.payer.payingKey.length === 0 ||
    !sameAddress(receipt.payer, claim.payer.payingKey, usesEvmAddress) ||
    !sameAddress(receipt.payeeAddress, claim.payee.payeeAddress, usesEvmAddress) ||
    !sameAmount(receipt.amount, claim.amount.amount) ||
    !sameAddress(receipt.asset, expectedReceiptAsset, usesEvmAddress)
  ) {
    return rejected("receipt-terms-mismatch", "verified receipt does not match rail, payer, payout, amount, or asset");
  }

  if (receipt.kind === "x402") {
    const expectedChain = `eip155:${rail.network.kind === "evm" ? rail.network.chainId : ""}`;
    if (
      receipt.chainId !== expectedChain ||
      receipt.finality.model !== "block-depth" ||
      !Number.isSafeInteger(receipt.finalityBlocks) ||
      receipt.finalityBlocks < 1 ||
      !Number.isSafeInteger(receipt.blockNumber) ||
      receipt.blockNumber < 0 ||
      receipt.httpResource.length === 0 ||
      receipt.finality.finalityObservedAt !== receipt.blockTimestamp
    ) {
      return rejected("x402-finality-mismatch", "x402 receipt chain or applied block finality is incoherent");
    }
    let parsedReceipt: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(receipt.settlementResponseJcs);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        canonicalize(parsed) !== receipt.settlementResponseJcs
      ) {
        throw new Error("not canonical JCS");
      }
      parsedReceipt = parsed as Record<string, unknown>;
    } catch (error) {
      return rejected("x402-receipt-malformed", String(error));
    }
    if (
      (receipt.protocolVersion !== "1" && receipt.protocolVersion !== "2") ||
      !/^[0-9a-f]{64}$/.test(receipt.paymentReceiptHash) ||
      sha256Hex(receipt.settlementResponseJcs) !== receipt.paymentReceiptHash ||
      parsedReceipt["success"] !== true ||
      parsedReceipt["transaction"] !== receipt.transactionHash ||
      parsedReceipt["network"] !== receipt.responseNetwork ||
      (parsedReceipt["x402Version"] !== undefined &&
        String(parsedReceipt["x402Version"]) !== receipt.protocolVersion) ||
      (parsedReceipt["payer"] !== undefined &&
        (typeof parsedReceipt["payer"] !== "string" ||
          !sameAddress(parsedReceipt["payer"], receipt.payer, true)))
    ) {
      return rejected("x402-receipt-hash-mismatch", "canonical x402 response, hash, version, transaction, or network mismatch");
    }
    if (receipt.sessionBinding.kind === "absent") {
      return indeterminate(
        "x402-session-binding-absent",
        ["payer-signed session binding was not established"],
      );
    }
    if (
      receipt.sessionBinding.kind === "permit2-witness" &&
      (receipt.sessionBinding.jobId !== claim.jobId ||
        receipt.sessionBinding.phaseIndex !== claim.phaseIndex)
    ) {
      return rejected("x402-session-binding-mismatch", "Permit2 witness binds a different job/phase");
    }
    if (receipt.sessionBinding.kind === "eip-3009") {
      const expectedNonce = sellerX402AuthorizationNonce(
        claim.jobId,
        claim.phaseIndex,
      );
      if (
        !/^0x[0-9a-f]{64}$/.test(receipt.sessionBinding.nonce) ||
        receipt.sessionBinding.nonce !== expectedNonce ||
        receipt.authorizationId !== receipt.sessionBinding.nonce
      ) {
        return rejected("x402-session-binding-mismatch", "EIP-3009 nonce binds a different job/phase or is malformed");
      }
    }
  } else if (
    receipt.network !== "demos" ||
    receipt.asset !== "DEM" ||
    receipt.finality.model !== "bft-final" ||
    receipt.included !== true ||
    !Number.isSafeInteger(receipt.blockNumber) ||
    receipt.blockNumber < 0
  ) {
    return rejected("pay-dem-finality-mismatch", "pay-DEM receipt is not included under Demos BFT finality");
  }

  const settlementIdentityValue = receiptIdentity(receipt);
  const authorizationIdentityValue = authorizationIdentity(receipt);
  if (!settlementIdentityValue || !authorizationIdentityValue) {
    return rejected("settlement-identity-malformed", "receipt cannot produce a canonical settlement/authorization identity");
  }

  const createdAt = deps.nowMs();
  const observedAt = receipt.finality.finalityObservedAt;
  if (
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    !Number.isSafeInteger(observedAt) ||
    observedAt < 0 ||
    observedAt > createdAt
  ) {
    return rejected(
      "receipt-time-invalid",
      "receipt finality time or injected clock is invalid",
    );
  }
  const evidenceInput = buildEvidenceInput(claim, receipt, observedAt);
  const evidenceHash = sha256Hex(canonicalize(evidenceInput));
  const phaseKey = `${claim.jobId}:${claim.phaseIndex}`;
  const requestHash = sha256Hex(canonicalize({
    phaseKey,
    agreementHash: claim.agreementHash,
    listingPin: claim.listingPin,
    railPin: claim.railPin,
    settlementIdentity: settlementIdentityValue,
    authorizationIdentity: authorizationIdentityValue,
    evidenceHash,
  }));
  const fulfilmentId = sha256Hex(
    `dacs-seller-fulfilment:v1:${phaseKey}:${evidenceHash}`,
  );
  const record: SellerPaymentIntakeRecord = {
    phaseKey,
    requestHash,
    settlementIdentity: settlementIdentityValue,
    authorizationIdentity: authorizationIdentityValue,
    evidenceHash,
    evidenceInput,
    fulfilmentId,
    createdAt,
  };

  let persisted: SellerPaymentPersistenceResult;
  try {
    persisted = await deps.store.accept(record);
  } catch (error) {
    return indeterminate("persistence-failed", [String(error)]);
  }
  if (persisted.status === "conflict") {
    return rejected(persisted.reason, `durable intake conflict: ${persisted.reason}`);
  }
  const accepted = persisted.record;
  return {
    decision: "verified",
    duplicate: persisted.status === "duplicate",
    settlementIdentity: accepted.settlementIdentity,
    authorizationIdentity: accepted.authorizationIdentity,
    evidenceInput: accepted.evidenceInput,
    evidenceHash: accepted.evidenceHash,
    fulfilment: {
      action: persisted.status === "accepted" ? "enqueue" : "already-enqueued",
      fulfilmentId: accepted.fulfilmentId,
    },
  };
}

/** Reference atomic in-memory store; inject a durable transactional store in production. */
export function createInMemorySellerPaymentIntakeStore(): SellerPaymentIntakeStore {
  const byPhase = new Map<string, SellerPaymentIntakeRecord>();
  const bySettlement = new Map<string, SellerPaymentIntakeRecord>();
  const byAuthorization = new Map<string, SellerPaymentIntakeRecord>();
  const byRequest = new Map<string, SellerPaymentIntakeRecord>();
  return {
    async accept(record) {
      // Deliberately no await between reads and writes: one event-loop turn is
      // the in-memory implementation's atomic transaction.
      const phase = byPhase.get(record.phaseKey);
      if (phase) {
        return phase.requestHash === record.requestHash &&
          phase.settlementIdentity === record.settlementIdentity &&
          phase.authorizationIdentity === record.authorizationIdentity &&
          phase.evidenceHash === record.evidenceHash
          ? { status: "duplicate", record: phase }
          : { status: "conflict", reason: "phase-conflict", existing: phase };
      }
      const settlement = bySettlement.get(record.settlementIdentity);
      if (settlement) {
        return {
          status: "conflict",
          reason: "settlement-replay",
          existing: settlement,
        };
      }
      const authorization = byAuthorization.get(record.authorizationIdentity);
      if (authorization) {
        return {
          status: "conflict",
          reason: "authorization-replay",
          existing: authorization,
        };
      }
      const request = byRequest.get(record.requestHash);
      if (request) {
        return {
          status: "conflict",
          reason: "request-replay",
          existing: request,
        };
      }
      byPhase.set(record.phaseKey, record);
      bySettlement.set(record.settlementIdentity, record);
      byAuthorization.set(record.authorizationIdentity, record);
      byRequest.set(record.requestHash, record);
      return { status: "accepted", record };
    },
  };
}
