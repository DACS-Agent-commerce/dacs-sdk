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
import {
  verifyX402ReceiptClaim,
  type X402ResponseHeader,
} from "./x402Receipt.js";

export type SellerPaymentIntakeDisposition =
  | "verified"
  | "rejected"
  | "indeterminate";

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
 * This is not a signed SDK artifact; the injected resolver verifies the actual
 * `FinalityCommitmentRecord` and returns the fields the intake gate consumes.
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
  | { disposition: "verified"; rail: SellerSupportedRailDefinition }
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
      finalityObservedAt: number;
      sessionBinding: X402SessionBinding;
    };

export interface SellerReceiptClaim {
  settlementId: string;
  jobId: string;
  phaseIndex: number;
  evidenceHash: string;
}

export type SellerReceiptClaimResult =
  | { status: "claimed" }
  | { status: "already-claimed" }
  | { status: "conflict"; existing: SellerReceiptClaim };

/** Durable implementations MUST make `claim` one atomic compare-and-set. */
export interface SellerReceiptStore {
  claim(input: SellerReceiptClaim): Promise<SellerReceiptClaimResult>;
}

export interface SellerPaymentIntakeDeps {
  resolveCommittedAgreement(jobId: string): Promise<CommittedAgreementResolution>;
  /** Historical DACS-1 validation at commitment time; later revocation is irrelevant. */
  resolveListingAtCommit(listingRef: ListingRef): Promise<ListingValidationResult>;
  resolveRail(ref: PaymentRailRef): Promise<SellerRailResolution>;
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

function pipelinePaymentBindings(listing: Listing): PayoutBindingView[] | null {
  const bindings: PayoutBindingView[] = [];
  for (let phaseIndex = 0; phaseIndex < listing.pipeline.length; phaseIndex += 1) {
    const phase = listing.pipeline[phaseIndex]!;
    if (!phase.kind.startsWith("pay-")) continue;
    const railId = phase.parameters?.rail;
    if (typeof railId !== "string" || railId.length === 0) return null;
    // The destination comes from the agreement, not the Listing. A placeholder
    // here lets the caller compare the complete key coverage separately.
    bindings.push({ railId, phaseIndex, payeeAddress: "" });
  }
  return bindings;
}

function payoutCoverageMatches(
  expected: PayoutBindingView[],
  actual: PayoutBindingView[],
): boolean {
  if (expected.length !== actual.length) return false;
  const keys = new Set<string>();
  for (const binding of actual) {
    const key = `${binding.railId}\u0000${binding.phaseIndex}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return expected.every((binding) =>
    actual.some((candidate) =>
      candidate.railId === binding.railId &&
      candidate.phaseIndex === binding.phaseIndex));
}

function acceptedRailMatches(listing: Listing, rail: PaymentRailRef): boolean {
  try {
    return listing.acceptedRails?.some((candidate) =>
      canonicalize(candidate) === canonicalize(rail)) === true;
  } catch {
    return false;
  }
}

function bundleHash(bundle: IdentityBundle): string {
  return sha256Hex(canonicalize(bundle));
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

export function createInMemorySellerReceiptStore(
  initial: readonly SellerReceiptClaim[] = [],
): SellerReceiptStore {
  const claims = new Map(initial.map((claim) => [claim.settlementId, { ...claim }]));
  return {
    async claim(input) {
      const existing = claims.get(input.settlementId);
      if (!existing) {
        claims.set(input.settlementId, { ...input });
        return { status: "claimed" };
      }
      if (
        existing.jobId === input.jobId &&
        existing.phaseIndex === input.phaseIndex &&
        existing.evidenceHash === input.evidenceHash
      ) return { status: "already-claimed" };
      return { status: "conflict", existing: { ...existing } };
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
  if (listing.listingId !== agreement.listingRef.listingId ||
      listing.listingVersion !== agreement.listingRef.version) {
    return "agreement-listing-tuple-mismatch";
  }
  const listingHash = contentHash(listing as unknown as Record<string, unknown>);
  if (listingHash !== agreement.listingRef.contentHash) return "agreement-listing-hash-mismatch";
  if (listing.seller.identity.presentedBy !== agreement.seller.primaryClaim) {
    return "agreement-seller-mismatch";
  }
  if (bundleHash(listing.seller.identity) !== agreement.seller.bundleHash) {
    return "agreement-seller-bundle-mismatch";
  }
  if (agreement.terms.deliverable.deliverableType !== listing.offering.deliverable.kind ||
      agreement.terms.deliverable.hash !== sha256Hex(canonicalize(listing.offering.deliverable)) ||
      agreement.terms.deliverable.schemaUrl !==
        ("schemaUrl" in listing.offering.deliverable
          ? listing.offering.deliverable.schemaUrl
          : undefined)) {
    return "agreement-deliverable-mismatch";
  }
  if (!acceptedRailMatches(listing, agreement.terms.rail)) return "agreement-rail-not-accepted";
  const expectedBindings = pipelinePaymentBindings(listing);
  if (!expectedBindings || !payoutCoverageMatches(expectedBindings, agreement.terms.payoutBindings)) {
    return "agreement-payout-coverage-mismatch";
  }
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
  base: Omit<SellerPaymentIntakeResult, "disposition" | "fulfilment" | "reason"> & {
    evidenceInput: SellerPaymentEvidenceInput;
    settlementId: string;
  },
  input: SellerPaymentIntakeInput,
  store: SellerReceiptStore,
): Promise<SellerPaymentIntakeResult> {
  const evidenceHash = sha256Hex(canonicalize(base.evidenceInput));
  let claim: SellerReceiptClaimResult;
  try {
    claim = await store.claim({
      settlementId: base.settlementId,
      jobId: input.jobId,
      phaseIndex: input.phaseIndex,
      evidenceHash,
    });
  } catch {
    return indeterminate("receipt-store-unavailable");
  }
  if (claim.status === "conflict") return reject("settlement-identity-replay");
  return {
    disposition: "verified",
    fulfilment: claim.status === "claimed" ? "claim" : "already-claimed",
    reason: claim.status === "claimed" ? "payment-verified" : "payment-already-claimed",
    ...base,
    evidenceHash,
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
    return reject("invalid-intake-input");
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
  if (listingResult.listing.validity.notAfter !== undefined &&
      listingResult.listing.validity.notAfter < committed.commitment.committedAt) {
    return reject("listing-expired-before-commitment");
  }
  const deadlineWindow = listingResult.listing.terms.deadlineSecAfterCommit;
  if (deadlineWindow !== undefined) {
    const latestDeadline = committed.commitment.committedAt + deadlineWindow * 1_000;
    if (!Number.isSafeInteger(latestDeadline) || agreement.terms.deadline > latestDeadline) {
      return reject("agreement-deadline-exceeds-listing-window");
    }
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
    railResult = await deps.resolveRail(agreement.terms.rail);
  } catch {
    return indeterminate("rail-resolution-unavailable");
  }
  if (railResult.disposition !== "verified") {
    return railResult.disposition === "indeterminate"
      ? indeterminate(`rail-${railResult.reason}`)
      : reject(`rail-${railResult.reason}`);
  }
  const rail = railResult.rail;
  if (!validRailShape(rail) || rail.railId !== input.railId ||
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
  if (bundleHash(buyerBundle) !== agreement.buyer.bundleHash ||
      buyerBundle.presentedBy !== agreement.buyer.primaryClaim ||
      bundleHash(sellerBundle) !== agreement.seller.bundleHash ||
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
    if (!claimedTxHash) return reject("malformed-settlement-identity");
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
    if (!settlementId) return reject("malformed-settlement-identity");
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
    return reject(`x402-${receiptVerification.reason}`);
  }
  if (input.receipt.settlementTxHash === undefined || input.receipt.chainId === undefined) {
    // SB-1 requires event-level EVM identity. Provider-receipt fallback cannot
    // mint a seller fulfilment permit until such an identity is recoverable.
    return indeterminate("x402-settlement-identity-unavailable");
  }
  if (input.receipt.chainId !== rail.asset.chainId) return reject("x402-chain-mismatch");

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
  const claimedTxHash = canonicalTxHash(input.receipt.settlementTxHash);
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
  const finalityBlocks = rail.parameters.finalityBlocks ?? 1;
  if (!Number.isSafeInteger(finalityBlocks) || finalityBlocks <= 0 ||
      !isSafeUint(observed.confirmations) || observed.confirmations < finalityBlocks ||
      !isSafeUint(observed.finalityObservedAt)) {
    return reject("x402-finality-mismatch");
  }
  if (observed.finalityObservedAt < committed.commitment.committedAt) {
    return reject("payment-before-finalized-commitment");
  }
  if (observed.finalityObservedAt > agreement.terms.deadline) return reject("payment-after-deadline");

  let sessionBinding: SellerSessionBindingGuarantee = "not-established";
  if (observed.sessionBinding.kind === "eip3009") {
    if (!/^0x[0-9a-f]{64}$/.test(observed.sessionBinding.nonce)) {
      return reject("x402-session-nonce-malformed");
    }
    if (observed.sessionBinding.nonce !== x402Eip3009Nonce(input.jobId, input.phaseIndex)) {
      return reject("x402-session-binding-mismatch");
    }
    sessionBinding = "established";
  } else if (observed.sessionBinding.kind === "permit2") {
    if (observed.sessionBinding.jobId !== input.jobId) {
      return reject("x402-session-binding-mismatch");
    }
    sessionBinding = "established";
  }

  const settlementId = canonicalSellerSettlementId({
    kind: "evm",
    chainId: observed.chainId,
    txHash: observed.txHash,
    logIndex: observed.logIndex,
  });
  if (!settlementId) return reject("malformed-settlement-identity");
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
