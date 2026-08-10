import { randomBytes } from "node:crypto";

import type { IdentityBundle, Listing, ListingRef, PaymentRailRef } from "../artifacts/types.js";
import {
  assertPositiveAmount,
  baseUnits,
  canonicalize,
  contentHash,
  sha256Hex,
} from "../canonical/index.js";
import { demosAddressFromClaim, DEM_CURRENCY, DEM_DECIMALS } from "../rails/payDem.js";
import type { ListingValidationResult } from "../agent/listingValidation.js";
import { isPayeeBoundAgreementDocument } from "../artifacts/validators.js";
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
        jobId: string;
        agreementHash: string;
        listingRef: ListingRef;
        committedAt: number;
      };
      /** Verified DACS-5 SessionRecord rail-registry pin. */
      railRegistryVersion: number;
    }
  | { disposition: "rejected" | "indeterminate"; reason: string };

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
  | { disposition: "bound"; address: string; tier: 1 | 2 | 3 }
  | { disposition: "mismatch"; reason: string; tier: 1 | 2 | 3 }
  | { disposition: "indeterminate"; reason: string; tier: 2 };

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

export type SellerReceiptClaimResult =
  | {
      status: "claimed" | "already-claimed";
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
  settlementId: string;
  evidenceHash: string;
  evidenceInput: SellerPaymentEvidenceInput;
  payoutBindingTier: 1 | 2 | 3;
  sessionBinding?: SellerSessionBindingGuarantee;
}

/**
 * Durable implementations MUST make winner selection and permit consumption
 * atomic. Permit ids are bearer capabilities and MUST be unpredictable,
 * confidential, and bound to the retained authorization. Consumers MUST NOT
 * invoke an irreversible callback for `already-consumed`; that disposition is
 * reconciliation-only.
 */
export interface SellerReceiptStore {
  claim(input: SellerReceiptClaim): Promise<SellerReceiptClaimResult>;
  consumePermit(permitId: string): Promise<SellerReceiptPermitResult>;
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

export interface SellerPaymentIntakeDeps {
  /**
   * Trusted CA-7 boundary. A `verified` result MUST mean that the finalized
   * commitment and both Agreement party signatures have been cryptographically
   * verified with their required party bindings; see
   * `CommittedAgreementResolution`.
   */
  resolveCommittedAgreement(jobId: string): Promise<CommittedAgreementResolution>;
  /** Historical DACS-1 validation at commitment time; later revocation is irrelevant. */
  resolveListingAtCommit(listingRef: ListingRef): Promise<ListingValidationResult>;
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
  agreementHash?: string;
  listingRef?: ListingRef;
  railId?: string;
  settlementId?: string;
  evidenceHash?: string;
  evidenceInput?: SellerPaymentEvidenceInput;
  payoutBindingTier?: 1 | 2 | 3;
  sessionBinding?: SellerSessionBindingGuarantee;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSafeUint(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
    typeof value.listingId !== "string" ||
    value.listingId.length === 0 ||
    !isSafeUint(value.version) ||
    !HASH_RE.test(String(value.contentHash))
  ) return null;
  return {
    listingId: value.listingId,
    version: value.version,
    contentHash: String(value.contentHash),
  };
}

function isValidSellerReceiptClaim(value: unknown): value is SellerReceiptClaim {
  if (
    !isRecord(value) ||
    typeof value.settlementId !== "string" ||
    value.settlementId.length === 0 ||
    typeof value.jobId !== "string" ||
    value.jobId.length === 0 ||
    !isSafeUint(value.phaseIndex) ||
    !isSafeUint(value.observedAt) ||
    !HASH_RE.test(String(value.evidenceHash)) ||
    !isRecord(value.authorization)
  ) return false;

  const authorization = value.authorization;
  const evidenceInput = authorization.evidenceInput;
  if (
    authorization.jobId !== value.jobId ||
    authorization.phaseIndex !== value.phaseIndex ||
    authorization.settlementId !== value.settlementId ||
    authorization.evidenceHash !== value.evidenceHash ||
    !HASH_RE.test(String(authorization.agreementHash)) ||
    parseListingRef(authorization.listingRef) === null ||
    typeof authorization.railId !== "string" ||
    authorization.railId.length === 0 ||
    (authorization.payoutBindingTier !== 1 &&
      authorization.payoutBindingTier !== 2 &&
      authorization.payoutBindingTier !== 3) ||
    (authorization.sessionBinding !== undefined &&
      authorization.sessionBinding !== "established" &&
      authorization.sessionBinding !== "not-established") ||
    !isRecord(evidenceInput) ||
    evidenceInput.jobId !== value.jobId ||
    evidenceInput.observedAt !== value.observedAt
  ) return false;

  try {
    return sha256Hex(canonicalize(evidenceInput)) === value.evidenceHash;
  } catch {
    return false;
  }
}

function parseParty(value: unknown): AgreementPartyView | null {
  if (
    !isRecord(value) ||
    (value.role !== "buyer" && value.role !== "seller") ||
    !HASH_RE.test(String(value.bundleHash)) ||
    typeof value.primaryClaim !== "string" ||
    value.primaryClaim.length === 0 ||
    !isRecord(value.vetRecordRef)
  ) return null;
  return {
    role: value.role,
    bundleHash: String(value.bundleHash),
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
    !HASH_RE.test(String(terms.deliverable.hash)) ||
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
        hash: String(terms.deliverable.hash),
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
  if (!isSafeUint(input.chainId) || !isSafeUint(input.logIndex)) return null;
  return `evm:${input.chainId}:${txHash}:${input.logIndex}`;
}

/** DACS-4 §9.5.8 byte-exact EIP-3009 SB-3 nonce. */
export function x402Eip3009Nonce(jobId: string, phaseIndex: number): string {
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
): SellerReceiptStore {
  interface StoredClaim {
    selected: SellerReceiptClaim;
    pendingPermitId?: string;
    consumed?: { permitId: string; claim: SellerReceiptClaim };
  }

  const claims = new Map<string, StoredClaim>();
  const permits = new Map<string, string>();
  const permitId = (): string =>
    `seller-payment:${randomBytes(32).toString("base64url")}`;
  const cloneClaim = (claim: SellerReceiptClaim): SellerReceiptClaim =>
    structuredClone(claim);
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
        existing.selected.authorization.railId === candidate.authorization.railId;
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
            status: "already-claimed",
            permitId: existing.consumed.permitId,
            claim: cloneClaim(existing.consumed.claim),
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
    async consumePermit(candidatePermitId) {
      const settlementId = permits.get(candidatePermitId);
      if (!settlementId) return { status: "invalid" };
      const stored = claims.get(settlementId);
      if (!stored) return { status: "invalid" };
      if (stored.consumed?.permitId === candidatePermitId) {
        return { status: "already-consumed", claim: cloneClaim(stored.consumed.claim) };
      }
      if (stored.pendingPermitId !== candidatePermitId || stored.consumed) {
        return { status: "invalid" };
      }
      stored.consumed = { permitId: candidatePermitId, claim: cloneClaim(stored.selected) };
      stored.pendingPermitId = undefined;
      return { status: "consumed", claim: cloneClaim(stored.consumed.claim) };
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

function validRailShape(rail: SellerSupportedRailDefinition): boolean {
  if (
    !Number.isSafeInteger(rail.railVersion) || rail.railVersion <= 0 ||
    !["live", "operator_gated", "closed_data", "bilateral"].includes(rail.availability)
  ) return false;
  if (rail.railType === "demos-native") {
    return rail.phaseHandler === "pay-dem" && rail.asset.kind === "native-dem" &&
      rail.asset.symbol === DEM_CURRENCY && rail.asset.decimals === DEM_DECIMALS &&
      rail.network.kind === "demos";
  }
  if (rail.railType !== "x402") return false;
  return rail.phaseHandler === "pay-x402" && rail.asset.kind === "erc20" &&
    isSafeUint(rail.asset.chainId) && typeof rail.asset.contract === "string" &&
    rail.asset.contract.length > 0 && typeof rail.asset.symbol === "string" &&
    rail.asset.symbol.length > 0 && isSafeUint(rail.asset.decimals) &&
    rail.network.kind === "x402-resource" &&
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
  store: SellerReceiptStore,
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
  let rawClaim: unknown;
  try {
    rawClaim = await store.claim(candidate);
  } catch {
    return indeterminate("receipt-store-unavailable");
  }
  if (!isRecord(rawClaim) ||
      !["claimed", "already-claimed", "conflict"].includes(String(rawClaim.status))) {
    return indeterminate("receipt-store-invalid-result");
  }
  const claim = rawClaim as SellerReceiptClaimResult;
  if (claim.status === "conflict") {
    if (
      ![
        "lower-priority",
        "winner-already-consumed",
        "authorization-scope-conflict",
      ].includes(String(claim.reason)) ||
      !isValidSellerReceiptClaim(claim.existing) ||
      claim.existing.settlementId !== candidate.settlementId ||
      (claim.consumed !== undefined &&
        (!isValidSellerReceiptClaim(claim.consumed) ||
          claim.consumed.settlementId !== candidate.settlementId)) ||
      (claim.reason === "winner-already-consumed" && claim.consumed === undefined)
    ) return indeterminate("receipt-store-invalid-result");
    if (claim.reason === "authorization-scope-conflict") {
      return reject("settlement-authorization-scope-conflict");
    }
    return claim.reason === "winner-already-consumed"
      ? indeterminate("settlement-winner-conflict-after-consumption")
      : reject("settlement-identity-replay");
  }
  if (
    typeof claim.permitId !== "string" ||
    claim.permitId.length === 0 ||
    !isValidSellerReceiptClaim(claim.claim) ||
    claim.claim.settlementId !== candidate.settlementId ||
    claim.claim.jobId !== candidate.jobId ||
    claim.claim.phaseIndex !== candidate.phaseIndex ||
    claim.claim.authorization.agreementHash !== candidate.authorization.agreementHash ||
    !sameListingRef(
      claim.claim.authorization.listingRef,
      candidate.authorization.listingRef,
    ) ||
    claim.claim.authorization.railId !== candidate.authorization.railId ||
    (claim.status === "claimed" && canonicalize(claim.claim) !== canonicalize(candidate))
  ) return indeterminate("receipt-store-invalid-result");
  return {
    disposition: "verified",
    fulfilment: claim.status === "claimed" ? "claim" : "already-claimed",
    reason: claim.status === "claimed" ? "payment-verified" : "payment-already-claimed",
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
  if (!input.jobId || !isSafeUint(input.phaseIndex) || !input.railId || !input.payerPayingKey) {
    return verifierError("invalid-intake-input");
  }

  let committed: CommittedAgreementResolution;
  try {
    committed = await deps.resolveCommittedAgreement(input.jobId);
  } catch {
    return indeterminate("agreement-resolution-unavailable");
  }
  if (committed.disposition !== "verified") {
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
    agreement.jobId !== input.jobId ||
    committed.agreementHash !== computedAgreementHash ||
    committed.commitment.finality !== "finalized" ||
    committed.commitment.jobId !== input.jobId ||
    committed.commitment.agreementHash !== computedAgreementHash ||
    !sameListingRef(committed.commitment.listingRef, agreement.listingRef) ||
    !isSafeUint(committed.commitment.committedAt) ||
    !isSafeUint(committed.railRegistryVersion) ||
    committed.railRegistryVersion === 0 ||
    committed.commitment.committedAt > agreement.terms.deadline
  ) return reject("commitment-agreement-mismatch");

  let listingResult: ListingValidationResult;
  try {
    listingResult = await deps.resolveListingAtCommit(agreement.listingRef);
  } catch {
    return indeterminate("listing-resolution-unavailable");
  }
  if (listingResult.disposition !== "verified" || !listingResult.listing ||
      listingResult.listingContentHash !== agreement.listingRef.contentHash) {
    return listingResult.disposition === "indeterminate"
      ? indeterminate(`listing-${listingResult.reason}`)
      : reject(`listing-${listingResult.reason}`);
  }
  try {
    validateFixedPriceAgreementBinding({
      agreement: agreementArtifact,
      verifiedListing: {
        disposition: "verified",
        listing: listingResult.listing,
        pin: { ...agreement.listingRef },
      },
      committedAt: committed.commitment.committedAt,
    });
  } catch {
    return reject("agreement-listing-conformance-failed");
  }
  const listingMismatch = verifyAgreementListing(
    agreement,
    listingResult.listing,
    input.phaseIndex,
    input.railId,
  );
  if (listingMismatch) return reject(listingMismatch);

  const payoutBindings = agreement.terms.payoutBindings.filter((binding) =>
    binding.railId === input.railId && binding.phaseIndex === input.phaseIndex);
  if (payoutBindings.length !== 1) return reject("payout-binding-mismatch");
  const payout = payoutBindings[0]!;

  let railResult: SellerRailResolution;
  try {
    railResult = await deps.resolveRail({
      ref: structuredClone(agreement.terms.rail),
      railRegistryVersion: committed.railRegistryVersion,
    });
  } catch {
    return indeterminate("rail-resolution-unavailable");
  }
  if (railResult.disposition !== "verified") {
    return railResult.disposition === "indeterminate"
      ? indeterminate(`rail-${railResult.reason}`)
      : reject(`rail-${railResult.reason}`);
  }
  const rail = railResult.rail;
  if (!isSafeUint(railResult.railRegistryVersion) ||
      railResult.railRegistryVersion !== committed.railRegistryVersion ||
      !validRailShape(rail) || rail.railId !== input.railId ||
      agreement.terms.rail.railVersion !== undefined &&
      agreement.terms.rail.railVersion !== rail.railVersion) {
    return reject("unsupported-or-mismatched-rail");
  }
  if (rail.phaseHandler !== input.receipt.kind) return reject("receipt-rail-kind-mismatch");
  if (agreement.terms.price.currency !== rail.asset.symbol) return reject("payment-asset-mismatch");

  let buyerResult: IdentityBundleResolution;
  let sellerResult: IdentityBundleResolution;
  try {
    [buyerResult, sellerResult] = await Promise.all([
      deps.resolveIdentityBundle(agreement.buyer.bundleHash),
      deps.resolveIdentityBundle(agreement.seller.bundleHash),
    ]);
  } catch {
    return indeterminate("party-bundle-resolution-unavailable");
  }
  if (buyerResult.disposition !== "verified") {
    return buyerResult.disposition === "indeterminate"
      ? indeterminate(`buyer-bundle-${buyerResult.reason}`)
      : reject(`buyer-bundle-${buyerResult.reason}`);
  }
  if (sellerResult.disposition !== "verified") {
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
  if (!buyerBundle.claims.some((claim) => claim.ref === input.payerPayingKey)) {
    return reject("payer-paying-key-not-in-bundle");
  }

  const common = {
    agreementHash: computedAgreementHash,
    listingRef: agreement.listingRef,
    railId: input.railId,
  };

  if (rail.railType === "demos-native" && input.receipt.kind === "pay-dem") {
    const payerAddress = demosAddressFromClaim(input.payerPayingKey);
    const payeeAddress = demosAddressFromClaim(agreement.seller.primaryClaim);
    if (!payerAddress) return reject("payer-address-not-demos-bound");
    if (!payeeAddress || normalizeAddress(payout.payeeAddress) !== payeeAddress) {
      return reject("payee-destination-binding-mismatch");
    }
    const claimedTxHash = canonicalTxHash(input.receipt.txHash);
    if (!claimedTxHash) return verifierError("malformed-settlement-identity");
    let observed: DemosTransferObservation;
    try {
      observed = await deps.observeDemosTransfer(input.receipt.txHash);
    } catch {
      return indeterminate("demos-observation-unavailable");
    }
    if (observed.status !== "included") {
      return observed.status === "failed"
        ? reject("demos-transfer-failed")
        : indeterminate(`demos-${observed.status}`);
    }
    if (
      canonicalTxHash(observed.txHash) !== claimedTxHash ||
      normalizeAddress(observed.payer) !== payerAddress ||
      normalizeAddress(observed.payee) !== payeeAddress
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
      jobId: input.jobId,
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
      evidenceInput,
      payoutBindingTier: 1,
    }, input, deps.receiptStore);
  }

  if (rail.railType !== "x402" || input.receipt.kind !== "pay-x402") {
    return reject("receipt-rail-kind-mismatch");
  }
  if (!resourceAllowed(input.receipt.httpResource, rail.network.resourceBaseUrl)) {
    return reject("x402-http-resource-mismatch");
  }
  const pinnedResource = agreement.terms.rail.parameters?.httpResource;
  if (typeof pinnedResource === "string" && pinnedResource !== input.receipt.httpResource) {
    return reject("x402-http-resource-mismatch");
  }
  const receiptVerification = verifyX402ReceiptClaim({
    protocolVersion: input.receipt.protocolVersion,
    responseHeader: input.receipt.responseHeader,
    evidence: {
      paymentReceiptHash: input.receipt.paymentReceiptHash,
      settlementTxHash: input.receipt.settlementTxHash,
      chainId: input.receipt.chainId,
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
  let extensionVerification: X402ReceiptExtensionVerification;
  try {
    extensionVerification = await deps.verifyX402ReceiptExtensions({
      protocolVersion: input.receipt.protocolVersion,
      receipt: structuredClone(receiptVerification.receipt),
    });
  } catch {
    return indeterminate("x402-extension-verification-unavailable");
  }
  if (
    !isRecord(extensionVerification) ||
    !["pass", "fail", "indeterminate", "error"].includes(
      String(extensionVerification.disposition),
    ) ||
    (extensionVerification.disposition !== "pass" &&
      (typeof extensionVerification.reason !== "string" ||
        extensionVerification.reason.length === 0))
  ) {
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
  if (input.receipt.settlementTxHash === undefined || input.receipt.chainId === undefined) {
    // SB-1 requires event-level EVM identity. Provider-receipt fallback cannot
    // mint a seller fulfilment permit until such an identity is recoverable.
    return indeterminate("x402-settlement-identity-unavailable");
  }
  if (input.receipt.chainId !== rail.asset.chainId) return reject("x402-chain-mismatch");
  const claimedTxHash = canonicalTxHash(input.receipt.settlementTxHash);
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
    let classification: X402SettlementChainClassification;
    try {
      classification = await deps.classifyX402SettlementChain({
        chainId: rail.asset.chainId,
        rail: structuredClone(rail),
      });
    } catch {
      return indeterminate("x402-chain-classification-unavailable");
    }
    if (!isRecord(classification) ||
        !["l2", "unsupported", "indeterminate", "error"].includes(
          String(classification.disposition),
        ) ||
        (classification.disposition !== "l2" &&
          (typeof classification.reason !== "string" || classification.reason.length === 0))) {
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

  let payerResolution: AddressResolution;
  let destinationResolution: DestinationBindingResolution;
  try {
    [payerResolution, destinationResolution] = await Promise.all([
      deps.resolvePayerAddress({ payingKey: input.payerPayingKey, buyerBundle, rail }),
      deps.resolvePayeeDestination({
        payeePrimaryClaim: agreement.seller.primaryClaim,
        payeeBundle: sellerBundle,
        payoutAddress: payout.payeeAddress,
        rail,
      }),
    ]);
  } catch {
    return indeterminate("address-binding-resolution-unavailable");
  }
  if (payerResolution.disposition !== "verified") {
    return payerResolution.disposition === "indeterminate"
      ? indeterminate(`payer-address-${payerResolution.reason}`)
      : reject(`payer-address-${payerResolution.reason}`);
  }
  if (destinationResolution.disposition !== "bound") {
    return destinationResolution.disposition === "indeterminate"
      ? indeterminate(`payee-destination-${destinationResolution.reason}`)
      : reject(`payee-destination-${destinationResolution.reason}`);
  }
  if (normalizeAddress(destinationResolution.address) !== normalizeAddress(payout.payeeAddress)) {
    return reject("payee-destination-binding-mismatch");
  }

  let observed: X402TransferObservation;
  try {
    observed = await deps.observeX402Transfer({
      chainId: input.receipt.chainId,
      txHash: input.receipt.settlementTxHash,
    });
  } catch {
    return indeterminate("x402-observation-unavailable");
  }
  if (observed.status !== "finalized") {
    return observed.status === "failed"
      ? reject("x402-transfer-failed")
      : indeterminate(`x402-${observed.status}`);
  }
  if (
    observed.chainId !== input.receipt.chainId ||
    canonicalTxHash(observed.txHash) !== claimedTxHash ||
    normalizeAddress(observed.payer) !== normalizeAddress(payerResolution.address) ||
    normalizeAddress(String(receiptVerification.receipt.payer)) !==
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
      if (typeof observed.sessionBinding.nonce !== "string" ||
          !/^0x[0-9a-f]{64}$/.test(observed.sessionBinding.nonce)) {
        return verifierError("x402-session-nonce-malformed");
      }
      if (observed.sessionBinding.nonce !== x402Eip3009Nonce(input.jobId, input.phaseIndex)) {
        return reject("x402-session-binding-mismatch");
      }
      sessionBinding = "established";
      break;
    case "permit2":
      if (typeof observed.sessionBinding.jobId !== "string" ||
          observed.sessionBinding.jobId.length === 0) {
        return verifierError("x402-session-binding-malformed");
      }
      if (observed.sessionBinding.jobId !== input.jobId) {
        return reject("x402-session-binding-mismatch");
      }
      sessionBinding = "established";
      break;
    case "absent":
      break;
    case "unverifiable":
      if (typeof observed.sessionBinding.reason !== "string" ||
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
    jobId: input.jobId,
    phase: "pay-x402",
    outcome: "success",
    paymentTxRefs: [{
      kind: "x402",
      httpResource: input.receipt.httpResource,
      paymentReceiptHash: input.receipt.paymentReceiptHash,
      settlementTxHash: input.receipt.settlementTxHash,
      chainId: input.receipt.chainId,
      protocolVersion: input.receipt.protocolVersion,
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
    evidenceInput,
    payoutBindingTier: destinationResolution.tier,
    sessionBinding,
  }, input, deps.receiptStore);
}
