import { types as nodeTypes } from "node:util";

import type { SettleRequest, SettleResult } from "../agent/runSessionCore.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import {
  COMPONENT_SIGNATURE_ALGORITHMS,
  isCanonicalBase64Url,
  isComponentSignature,
  signComponentArtifact,
  type BuildComponentSignatureOptions,
} from "../artifacts/signatures.js";
import type {
  AgreementArtifact,
  ChainTxRef,
  ComponentSignature,
  ComponentSignatureAlgorithm,
  SettlementEvidence,
} from "../artifacts/types.js";
import {
  isAgreementArtifact,
  isChainTxRef,
  isSettlementEvidence,
} from "../artifacts/validators.js";
import {
  baseUnits,
  canonicalize,
  contentHash,
  stripSignature,
} from "../canonical/index.js";
import {
  snapshotCanonicalJson,
  snapshotCanonicalJsonRead,
} from "../canonical/snapshot.js";
import { dacsXSeparator, signedBytes } from "../crypto/index.js";
import { CounterpartyError, DacsError, TransientError } from "../errors.js";
import {
  requireCanonicalClaimReference,
  sameCanonicalClaimIdentity,
} from "../identity/claimReference.js";
import type { CommitmentSignatureVerifier } from "../negotiate/commitment.js";
import {
  isAuthenticatedRailDefinition,
  type AuthenticatedRailDefinition,
} from "../registry/resolve.js";
import type { UcpRfqAgreementInput } from "./ucpRfq.js";
import {
  assertUcpRfqAgreementMatches,
  DACS_UCP_X402_COMMERCE_PROFILE,
} from "./ucpRfq.js";
import {
  DACS_UCP_X402_HANDLER,
  dacsUcpIdempotencyKey,
  requireUcpHttpUrl,
  UCP_MVP_VERSION,
  ucpDataHash,
  type UcpBusinessProfileSnapshot,
  type UcpCheckout,
  type UcpCompleteCheckoutRequest,
  type UcpLineItemRequest,
  type UcpOrder,
  type UcpRestClient,
} from "./ucp.js";

export const UCP_IDENTITY_BINDING_SEPARATOR = dacsXSeparator(
  "ucp-identity-binding",
) as "dacs-x-ucp-identity-binding:v1:";
export const UCP_CHECKOUT_BINDING_SEPARATOR = dacsXSeparator(
  "ucp-checkout-binding",
) as "dacs-x-ucp-checkout-binding:v1:";
export const UCP_ORDER_EVIDENCE_SEPARATOR = dacsXSeparator(
  "ucp-order-evidence",
) as "dacs-x-ucp-order-evidence:v1:";

export interface DacsUcpMerchantIdentityBinding {
  ucpIdentityBindingVersion: "1";
  commerceProfile: typeof DACS_UCP_X402_COMMERCE_PROFILE;
  merchantClaim: string;
  profileUrl: string;
  profileHash: string;
  ucpVersion: typeof UCP_MVP_VERSION;
  ucpSigningKeyIds: string[];
  issuedAt: number;
  expiresAt: number;
  signature: ComponentSignature;
}

export interface DacsUcpCheckoutBinding {
  ucpCheckoutBindingVersion: "1";
  commerceProfile: typeof DACS_UCP_X402_COMMERCE_PROFILE;
  jobId: string;
  agreementHash: string;
  merchantClaim: string;
  identityBindingHash: string;
  profileUrl: string;
  profileHash: string;
  ucpVersion: typeof UCP_MVP_VERSION;
  checkoutId: string;
  checkoutHash: string;
  checkoutStatus: "ready_for_complete";
  checkoutExpiresAt?: string;
  phaseOrchestrator: string;
  payment: {
    handlerName: typeof DACS_UCP_X402_HANDLER;
    handlerId: string;
    handlerVersion: typeof UCP_MVP_VERSION;
    railId: string;
    phaseIndex: number;
    network: `eip155:${number}`;
    checkoutCurrency: string;
    checkoutAmount: string;
    assetAmountPerCheckoutUnit: "1";
    asset: `0x${string}`;
    assetSymbol: string;
    assetDecimals: number;
    payTo: `0x${string}`;
    amount: string;
    resource: string;
    finalityBlocks: number;
  };
  createdAt: number;
  signature: ComponentSignature;
}

export interface DacsUcpOrderEvidence {
  ucpOrderEvidenceVersion: "1";
  commerceProfile: typeof DACS_UCP_X402_COMMERCE_PROFILE;
  jobId: string;
  agreementHash: string;
  checkoutBindingHash: string;
  checkoutId: string;
  checkoutHash: string;
  orderId: string;
  orderHash: string;
  orderPermalink: string;
  paymentTxRefHash: string;
  observedAt: number;
  signature: ComponentSignature;
}

export type UcpCompositionSignaturePurpose =
  | "merchant-identity-binding"
  | "checkout-binding"
  | "order-evidence";

export interface UcpCompositionSignatureVerificationInput {
  purpose: UcpCompositionSignaturePurpose;
  signedBytes: Uint8Array;
  algorithm: ComponentSignatureAlgorithm;
  signer: string;
  value: string;
}

export type UcpCompositionSignatureVerifier = (
  input: UcpCompositionSignatureVerificationInput,
) =>
  | Promise<"valid" | "invalid" | "indeterminate" | "error">
  | "valid"
  | "invalid"
  | "indeterminate"
  | "error";

export interface UcpX402MvpInput {
  agreement: AgreementArtifact;
  derivation: UcpRfqAgreementInput;
  business: Readonly<UcpBusinessProfileSnapshot>;
  identityBinding: DacsUcpMerchantIdentityBinding;
  /** Steward-authenticated rail definition that configures the injected x402 executor. */
  authenticatedRail: AuthenticatedRailDefinition;
  lineItems: UcpLineItemRequest[];
  /** Authenticated session authority for the pay-x402 phase (DACS-5 SEB-3). */
  paymentPhaseOrchestrator: string;
  nowMs: () => number;
  /** Signer controlling paymentPhaseOrchestrator. */
  paymentEvidenceSigner: BuildComponentSignatureOptions;
  /** Bounded polling hook. Omit in tests or supply a runtime delay. */
  waitBeforePoll?: (attempt: number) => Promise<void> | void;
  maxCheckoutPolls?: number;
}

export interface UcpX402MvpDeps {
  ucp: UcpRestClient;
  settle: (request: SettleRequest) => Promise<SettleResult>;
  merchantAttestor: UcpDacsMerchantAttestor;
  /** UCP requires trusted-UI approval unless an AP2 mandate authorises completion. */
  authorizeCompletion: (
    request: Readonly<UcpCompletionAuthorizationRequest>,
  ) => Promise<UcpCompletionAuthorization> | UcpCompletionAuthorization;
  verifyAgreementSignature: CommitmentSignatureVerifier;
  verifyCompositionSignature: UcpCompositionSignatureVerifier;
}

export interface UcpCompletionAuthorizationRequest {
  jobId: string;
  agreementHash: string;
  phaseOrchestrator: string;
  checkoutId: string;
  checkoutBindingHash: string;
  amount: string;
  assetSymbol: string;
  checkoutAmount: string;
  checkoutCurrency: string;
  payTo: string;
}

export type UcpCompletionAuthorization =
  | {
      approved: true;
      mechanism: "trusted-ui" | "ap2-mandate";
      reference?: string;
    }
  | { approved: false; reason: string };

export interface UcpCheckoutAttestationInput {
  agreement: AgreementArtifact;
  business: Readonly<UcpBusinessProfileSnapshot>;
  identityBinding: DacsUcpMerchantIdentityBinding;
  checkout: Readonly<UcpCheckout>;
  requestedLineItems: readonly UcpLineItemRequest[];
  phaseIndex: number;
  phaseOrchestrator: string;
  createdAt: number;
}

export interface UcpOrderAttestationInput {
  agreement: AgreementArtifact;
  checkout: Readonly<UcpCheckout>;
  checkoutBinding: DacsUcpCheckoutBinding;
  order: Readonly<UcpOrder>;
  settlement: SettleResult;
  observedAt: number;
}

/** Merchant-side seam; a real deployment transports these attestations over its UCP extension. */
export interface UcpDacsMerchantAttestor {
  attestCheckout(input: UcpCheckoutAttestationInput): Promise<DacsUcpCheckoutBinding>;
  attestOrder(input: UcpOrderAttestationInput): Promise<DacsUcpOrderEvidence>;
}

export interface UcpX402MvpResult {
  agreementHash: string;
  checkout: Readonly<UcpCheckout>;
  checkoutBinding: DacsUcpCheckoutBinding;
  completionAuthorization: Extract<UcpCompletionAuthorization, { approved: true }>;
  settlement: SettleResult;
  paymentEvidence: SettlementEvidence;
  completedCheckout: Readonly<UcpCheckout>;
  order: Readonly<UcpOrder>;
  orderEvidence: DacsUcpOrderEvidence;
}

type UnsignedIdentityBinding = Omit<DacsUcpMerchantIdentityBinding, "signature">;
type UnsignedCheckoutBinding = Omit<DacsUcpCheckoutBinding, "signature">;
type UnsignedOrderEvidence = Omit<DacsUcpOrderEvidence, "signature">;

const HASH_RE = /^[0-9a-f]{64}$/;
const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;

function exact(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

function completionAuthorization(
  value: unknown,
): UcpCompletionAuthorization {
  const result = snapshotCanonicalJson(value, "UCP completion authorization") as unknown;
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new DacsError("UCP completion authorization is malformed");
  }
  const record = result as Record<string, unknown>;
  if (record.approved === false && nonEmpty(record.reason)) {
    return result as UcpCompletionAuthorization;
  }
  if (
    record.approved === true &&
    (record.mechanism === "trusted-ui" || record.mechanism === "ap2-mandate") &&
    (record.reference === undefined || nonEmpty(record.reference))
  ) {
    return result as UcpCompletionAuthorization;
  }
  throw new DacsError("UCP completion authorization is malformed");
}

function ensurePlainSigner(options: BuildComponentSignatureOptions): {
  algorithm: ComponentSignatureAlgorithm;
  signer: string;
  sign: BuildComponentSignatureOptions["sign"];
} {
  const algorithms: ReadonlySet<unknown> = new Set(COMPONENT_SIGNATURE_ALGORITHMS);
  if (
    options === null ||
    typeof options !== "object" ||
    nodeTypes.isProxy(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype &&
      Object.getPrototypeOf(options) !== null)
  ) {
    throw new DacsError("UCP composition signer is malformed");
  }
  const data = (key: keyof BuildComponentSignatureOptions): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new DacsError(`UCP composition signer.${key} must be an enumerable data property`);
    }
    return descriptor.value;
  };
  const algorithm = data("algorithm");
  const signer = data("signer");
  const sign = data("sign");
  if (!algorithms.has(algorithm) || !nonEmpty(signer) || typeof sign !== "function" || nodeTypes.isProxy(sign)) {
    throw new DacsError("UCP composition signer is malformed");
  }
  return {
    algorithm: algorithm as ComponentSignatureAlgorithm,
    signer: signer.normalize("NFC"),
    sign: Function.prototype.bind.call(sign, options) as BuildComponentSignatureOptions["sign"],
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

async function signExtension<T extends object>(
  unsignedValue: T,
  separator: string,
  optionsValue: BuildComponentSignatureOptions,
): Promise<T & { signature: ComponentSignature }> {
  if (!separator.startsWith("dacs-x-") || !separator.endsWith(":v1:")) {
    throw new DacsError("UCP extension signatures require a dacs-x v1 separator");
  }
  const options = ensurePlainSigner(optionsValue);
  const unsigned = snapshotCanonicalJson(unsignedValue, "unsigned UCP extension artifact");
  if (
    Object.prototype.hasOwnProperty.call(unsigned, "signature") ||
    Object.prototype.hasOwnProperty.call(unsigned, "signatures")
  ) {
    throw new DacsError("unsigned UCP extension artifact carries a signature field");
  }
  const expected = signedBytes(
    separator,
    contentHash(unsigned as unknown as Record<string, unknown>),
  );
  const callbackBytes = Uint8Array.from(expected);
  const context = { algorithm: options.algorithm, signer: options.signer };
  const callbackContext = { ...context };
  const raw = await options.sign(callbackBytes, callbackContext);
  if (
    !sameBytes(expected, callbackBytes) ||
    !exact(context, callbackContext)
  ) {
    throw new DacsError("UCP composition signer mutated its signing inputs");
  }
  if (typeof raw !== "string" && !nodeTypes.isUint8Array(raw)) {
    throw new DacsError("UCP composition signer returned an unsupported signature value");
  }
  const value = typeof raw === "string"
    ? raw
    : Buffer.from(new Uint8Array(raw)).toString("base64url");
  if (!isCanonicalBase64Url(value)) {
    throw new DacsError("UCP composition signer returned a non-canonical signature");
  }
  return snapshotCanonicalJson({
    ...unsigned,
    signature: { ...context, value },
  }, "signed UCP extension artifact") as T & { signature: ComponentSignature };
}

async function verifyExtension(
  artifact: Record<string, unknown>,
  separator: string,
  purpose: UcpCompositionSignaturePurpose,
  expectedSigner: string,
  verify: UcpCompositionSignatureVerifier,
): Promise<void> {
  if (!isComponentSignature(artifact.signature)) {
    throw new CounterpartyError(`${purpose} signature is malformed`);
  }
  if (!sameCanonicalClaimIdentity(artifact.signature.signer, expectedSigner)) {
    throw new CounterpartyError(`${purpose} signer is not the bound merchant`);
  }
  const unsigned = stripSignature(artifact);
  const result = await verify({
    purpose,
    signedBytes: signedBytes(separator, contentHash(unsigned)),
    algorithm: artifact.signature.algorithm,
    signer: artifact.signature.signer,
    value: artifact.signature.value,
  });
  if (result === "valid") return;
  if (result === "indeterminate" || result === "error") {
    throw new TransientError(`${purpose} signature could not be verified (${result})`);
  }
  throw new CounterpartyError(`${purpose} signature is invalid`);
}

function requireIdentityBindingShape(value: unknown): asserts value is DacsUcpMerchantIdentityBinding {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new CounterpartyError("merchant UCP identity binding is malformed");
  }
  const binding = value as Partial<DacsUcpMerchantIdentityBinding>;
  if (
    binding.ucpIdentityBindingVersion !== "1" ||
    binding.commerceProfile !== DACS_UCP_X402_COMMERCE_PROFILE ||
    !nonEmpty(binding.merchantClaim) ||
    !nonEmpty(binding.profileUrl) ||
    !HASH_RE.test(binding.profileHash ?? "") ||
    binding.ucpVersion !== UCP_MVP_VERSION ||
    !Array.isArray(binding.ucpSigningKeyIds) ||
    binding.ucpSigningKeyIds.length === 0 ||
    !binding.ucpSigningKeyIds.every(nonEmpty) ||
    new Set(binding.ucpSigningKeyIds).size !== binding.ucpSigningKeyIds.length ||
    !isTime(binding.issuedAt) ||
    !isTime(binding.expiresAt) ||
    binding.expiresAt <= binding.issuedAt ||
    !isComponentSignature(binding.signature)
  ) {
    throw new CounterpartyError("merchant UCP identity binding is malformed");
  }
  requireCanonicalClaimReference(binding.merchantClaim, "merchant claim");
}

/** Bind a merchant's mutable UCP discovery document to its DACS identity. */
export async function createUcpMerchantIdentityBinding(input: {
  merchantClaim: string;
  business: Readonly<UcpBusinessProfileSnapshot>;
  issuedAt: number;
  expiresAt: number;
  signer: BuildComponentSignatureOptions;
}): Promise<DacsUcpMerchantIdentityBinding> {
  requireCanonicalClaimReference(input.merchantClaim, "merchant claim");
  if (!isTime(input.issuedAt) || !isTime(input.expiresAt) || input.expiresAt <= input.issuedAt) {
    throw new DacsError("UCP identity binding needs a positive validity interval");
  }
  if (!sameCanonicalClaimIdentity(input.signer.signer, input.merchantClaim)) {
    throw new DacsError("UCP identity binding signer must be the merchant claim");
  }
  const unsigned: UnsignedIdentityBinding = {
    ucpIdentityBindingVersion: "1",
    commerceProfile: DACS_UCP_X402_COMMERCE_PROFILE,
    merchantClaim: input.merchantClaim,
    profileUrl: input.business.profileUrl,
    profileHash: input.business.profileHash,
    ucpVersion: UCP_MVP_VERSION,
    ucpSigningKeyIds: [...input.business.keyIds].sort(),
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  };
  return signExtension(unsigned, UCP_IDENTITY_BINDING_SEPARATOR, input.signer);
}

export async function verifyUcpMerchantIdentityBinding(input: {
  binding: DacsUcpMerchantIdentityBinding;
  business: Readonly<UcpBusinessProfileSnapshot>;
  expectedMerchantClaim: string;
  evaluatedAt: number;
  verify: UcpCompositionSignatureVerifier;
}): Promise<void> {
  const binding = snapshotCanonicalJson(input.binding, "UCP merchant identity binding");
  requireIdentityBindingShape(binding);
  if (!isTime(input.evaluatedAt)) throw new DacsError("identity evaluation time is malformed");
  if (
    input.evaluatedAt < binding.issuedAt ||
    input.evaluatedAt > binding.expiresAt ||
    !sameCanonicalClaimIdentity(binding.merchantClaim, input.expectedMerchantClaim) ||
    binding.profileUrl !== input.business.profileUrl ||
    binding.profileHash !== input.business.profileHash ||
    binding.ucpVersion !== input.business.version ||
    !exact(binding.ucpSigningKeyIds, [...input.business.keyIds].sort())
  ) {
    throw new CounterpartyError("UCP merchant identity binding is stale or mismatches discovery");
  }
  await verifyExtension(
    binding as unknown as Record<string, unknown>,
    UCP_IDENTITY_BINDING_SEPARATOR,
    "merchant-identity-binding",
    binding.merchantClaim,
    input.verify,
  );
}

function agreementMerchantClaim(agreement: AgreementArtifact): string {
  const seller = agreement.parties.find((party) => party.role === "seller");
  if (!seller) throw new DacsError("UCP agreement has no seller");
  return seller.primaryClaim;
}

function paymentPhaseIndex(derivation: UcpRfqAgreementInput): number {
  const payments = derivation.verifiedListing.listing.pipeline
    .map((phase, index) => ({ phase, index }))
    .filter(({ phase }) => phase.kind.startsWith("pay-"));
  if (payments.length !== 1 || payments[0]!.phase.kind !== "pay-x402") {
    throw new DacsError("UCP MVP requires exactly one pay-x402 phase");
  }
  return payments[0]!.index;
}

function resourceIsWithinBase(resource: string, base: string): boolean {
  try {
    const actual = new URL(resource);
    const allowed = new URL(base);
    if (actual.origin !== allowed.origin) return false;
    const prefix = allowed.pathname.endsWith("/")
      ? allowed.pathname
      : `${allowed.pathname}/`;
    return actual.pathname === allowed.pathname || actual.pathname.startsWith(prefix);
  } catch {
    return false;
  }
}

function requireAuthenticatedSettlementRail(
  value: AuthenticatedRailDefinition,
  business: Readonly<UcpBusinessProfileSnapshot>,
  selectedRail: UcpRfqAgreementInput["selectedRail"],
): void {
  if (!isAuthenticatedRailDefinition(value)) {
    throw new DacsError("UCP x402 settlement requires a rail returned by resolveRail");
  }
  // Resolver provenance is carried out-of-band; project only the signed JSON
  // fields after checking that provenance so the private runtime brand is not
  // mistaken for wire data by the canonical snapshotter.
  const rail = snapshotCanonicalJsonRead({
    railVersion: value.railVersion,
    railId: value.railId,
    railType: value.railType,
    asset: value.asset,
    network: value.network,
    phaseHandler: value.phaseHandler,
    parameters: value.parameters,
    availability: value.availability,
    governance: value.governance,
    signature: value.signature,
  }, "authenticated UCP x402 rail");
  const config = business.x402.config;
  const chainId = Number(config.network.slice("eip155:".length));
  if (
    rail.railId !== selectedRail.railId ||
    rail.railVersion !== selectedRail.railVersion ||
    rail.railId !== config.railId ||
    rail.railType !== "x402" ||
    rail.phaseHandler !== "pay-x402" ||
    rail.availability !== "live" ||
    rail.asset.kind !== "erc20" ||
    rail.asset.chainId !== chainId ||
    rail.asset.contract.toLowerCase() !== config.asset.toLowerCase() ||
    rail.asset.symbol !== config.assetSymbol ||
    rail.asset.decimals !== config.assetDecimals ||
    rail.network.kind !== "x402-resource" ||
    !resourceIsWithinBase(config.resource, rail.network.resourceBaseUrl) ||
    rail.parameters.finalityBlocks !== config.finalityBlocks
  ) {
    throw new DacsError(
      "merchant UCP x402 coordinates differ from the authenticated DACS rail",
    );
  }
}

function totalAmount(checkout: Readonly<UcpCheckout>): number {
  const totals = checkout.totals.filter((entry) => entry.type === "total");
  if (totals.length !== 1 || !Number.isSafeInteger(totals[0]!.amount)) {
    throw new CounterpartyError("UCP Checkout has no unique safe-integer total");
  }
  return totals[0]!.amount;
}

function requireCheckoutLineItems(
  checkout: Readonly<UcpCheckout>,
  requestedValue: readonly UcpLineItemRequest[],
): void {
  const requested = snapshotCanonicalJson(requestedValue, "UCP requested line items");
  requireRequestedLineItems(requested);
  const expected = requested
    .map((line) => ({ item: { id: line.item.id }, quantity: line.quantity }))
    .sort((a, b) => a.item.id.localeCompare(b.item.id));
  const actual = checkout.line_items
    .map((line) => ({ item: { id: line.item.id }, quantity: line.quantity }))
    .sort((a, b) => a.item.id.localeCompare(b.item.id));
  if (!exact(actual, expected)) {
    throw new CounterpartyError("merchant changed or injected UCP checkout line items");
  }
}

function requireRequestedLineItems(requested: readonly UcpLineItemRequest[]): void {
  if (
    requested.length === 0 ||
    requested.some((line) => !nonEmpty(line.item?.id) || !Number.isSafeInteger(line.quantity) || line.quantity <= 0)
  ) {
    throw new DacsError("UCP checkout request line items are malformed");
  }
}

function requireCheckoutHandler(
  checkout: Readonly<UcpCheckout>,
  business: Readonly<UcpBusinessProfileSnapshot>,
): void {
  const entries = checkout.ucp.payment_handlers[DACS_UCP_X402_HANDLER];
  if (!Array.isArray(entries)) {
    throw new CounterpartyError("Checkout does not offer the negotiated DACS x402 handler");
  }
  const found = entries.some(
    (entry) =>
      entry.id === business.x402.id &&
      entry.version === business.x402.version &&
      exact(entry.config, business.x402.config),
  );
  if (!found) {
    throw new CounterpartyError("Checkout x402 handler differs from authenticated discovery");
  }
}

export async function createUcpCheckoutBinding(input: {
  agreement: AgreementArtifact;
  business: Readonly<UcpBusinessProfileSnapshot>;
  identityBinding: DacsUcpMerchantIdentityBinding;
  checkout: Readonly<UcpCheckout>;
  requestedLineItems: readonly UcpLineItemRequest[];
  phaseIndex: number;
  phaseOrchestrator: string;
  createdAt: number;
  signer: BuildComponentSignatureOptions;
}): Promise<DacsUcpCheckoutBinding> {
  const unsigned = unsignedCheckoutBinding(input);
  return signExtension(unsigned, UCP_CHECKOUT_BINDING_SEPARATOR, input.signer);
}

function unsignedCheckoutBinding(input: UcpCheckoutAttestationInput): UnsignedCheckoutBinding {
  const { agreement, business, checkout } = input;
  if (!isAgreementArtifact(agreement) || checkout.status !== "ready_for_complete") {
    throw new CounterpartyError("only a ready UCP Checkout can be payment-bound");
  }
  if (!isTime(input.createdAt) || !Number.isSafeInteger(input.phaseIndex) || input.phaseIndex < 0) {
    throw new DacsError("checkout binding time or phase index is malformed");
  }
  const merchantClaim = agreementMerchantClaim(agreement);
  requireCanonicalClaimReference(input.phaseOrchestrator, "payment phase orchestrator");
  requireCheckoutLineItems(checkout, input.requestedLineItems);
  requireCheckoutHandler(checkout, business);
  if (checkout.currency !== business.x402.config.checkoutCurrency) {
    throw new CounterpartyError("Checkout currency differs from authenticated UCP presentment");
  }
  const amount = baseUnits(agreement.terms.price.amount, business.x402.config.assetDecimals);
  const checkoutAmount = baseUnits(
    agreement.terms.price.amount,
    business.x402.config.checkoutCurrencyDecimals,
  );
  const checkoutNumber = Number(checkoutAmount);
  if (!Number.isSafeInteger(checkoutNumber) || totalAmount(checkout) !== checkoutNumber) {
    throw new CounterpartyError("Checkout total differs from the signed DACS agreement");
  }
  if (
    checkout.expires_at !== undefined &&
    Date.parse(checkout.expires_at) <= input.createdAt
  ) {
    throw new CounterpartyError("UCP Checkout expired before payment binding");
  }
  return {
    ucpCheckoutBindingVersion: "1",
    commerceProfile: DACS_UCP_X402_COMMERCE_PROFILE,
    jobId: agreement.jobId,
    agreementHash: contentHash(agreement as unknown as Record<string, unknown>),
    merchantClaim,
    identityBindingHash: contentHash(input.identityBinding as unknown as Record<string, unknown>),
    profileUrl: business.profileUrl,
    profileHash: business.profileHash,
    ucpVersion: UCP_MVP_VERSION,
    checkoutId: checkout.id,
    checkoutHash: ucpDataHash(checkout),
    checkoutStatus: "ready_for_complete",
    ...(checkout.expires_at === undefined ? {} : { checkoutExpiresAt: checkout.expires_at }),
    phaseOrchestrator: input.phaseOrchestrator,
    payment: {
      handlerName: DACS_UCP_X402_HANDLER,
      handlerId: business.x402.id,
      handlerVersion: UCP_MVP_VERSION,
      railId: business.x402.config.railId,
      phaseIndex: input.phaseIndex,
      network: business.x402.config.network,
      checkoutCurrency: business.x402.config.checkoutCurrency,
      checkoutAmount,
      assetAmountPerCheckoutUnit: business.x402.config.assetAmountPerCheckoutUnit,
      asset: business.x402.config.asset,
      assetSymbol: business.x402.config.assetSymbol,
      assetDecimals: business.x402.config.assetDecimals,
      payTo: business.x402.config.payTo,
      amount,
      resource: business.x402.config.resource,
      finalityBlocks: business.x402.config.finalityBlocks,
    },
    createdAt: input.createdAt,
  };
}

export async function verifyUcpCheckoutBinding(input: {
  binding: DacsUcpCheckoutBinding;
  attestation: UcpCheckoutAttestationInput;
  verify: UcpCompositionSignatureVerifier;
}): Promise<void> {
  const binding = snapshotCanonicalJson(input.binding, "UCP checkout binding");
  const expected = unsignedCheckoutBinding(input.attestation);
  if (!exact(stripSignature(binding as unknown as Record<string, unknown>), expected)) {
    throw new CounterpartyError("merchant checkout binding differs from the verified checkout");
  }
  await verifyExtension(
    binding as unknown as Record<string, unknown>,
    UCP_CHECKOUT_BINDING_SEPARATOR,
    "checkout-binding",
    agreementMerchantClaim(input.attestation.agreement),
    input.verify,
  );
}

function unsignedOrderEvidence(input: UcpOrderAttestationInput): UnsignedOrderEvidence {
  if (!input.settlement.txRef || !isChainTxRef(input.settlement.txRef)) {
    throw new CounterpartyError("order attestation lacks a normative payment transaction reference");
  }
  if (!isTime(input.observedAt)) throw new DacsError("order attestation time is malformed");
  assertOrderMatches(input.order, input.checkout);
  return {
    ucpOrderEvidenceVersion: "1",
    commerceProfile: DACS_UCP_X402_COMMERCE_PROFILE,
    jobId: input.agreement.jobId,
    agreementHash: contentHash(input.agreement as unknown as Record<string, unknown>),
    checkoutBindingHash: contentHash(input.checkoutBinding as unknown as Record<string, unknown>),
    checkoutId: input.checkout.id,
    checkoutHash: ucpDataHash(input.checkout),
    orderId: input.order.id,
    orderHash: ucpDataHash(input.order),
    orderPermalink: requireUcpHttpUrl(input.order.permalink_url, "UCP order permalink"),
    paymentTxRefHash: contentHash(input.settlement.txRef as unknown as Record<string, unknown>),
    observedAt: input.observedAt,
  };
}

/** Reference merchant adapter. Keep this object in the merchant trust boundary. */
export function createUcpDacsMerchantAttestor(input: {
  merchantSigner: BuildComponentSignatureOptions;
}): UcpDacsMerchantAttestor {
  const signer = ensurePlainSigner(input.merchantSigner);
  return {
    async attestCheckout(attestation) {
      const merchant = agreementMerchantClaim(attestation.agreement);
      if (!sameCanonicalClaimIdentity(signer.signer, merchant)) {
        throw new DacsError("merchant attestor does not control the agreement seller claim");
      }
      return createUcpCheckoutBinding({ ...attestation, signer });
    },
    async attestOrder(attestation) {
      const merchant = agreementMerchantClaim(attestation.agreement);
      if (!sameCanonicalClaimIdentity(signer.signer, merchant)) {
        throw new DacsError("merchant attestor does not control the agreement seller claim");
      }
      return signExtension(
        unsignedOrderEvidence(attestation),
        UCP_ORDER_EVIDENCE_SEPARATOR,
        signer,
      );
    },
  };
}

export async function verifyUcpOrderEvidence(input: {
  evidence: DacsUcpOrderEvidence;
  attestation: UcpOrderAttestationInput;
  verify: UcpCompositionSignatureVerifier;
}): Promise<void> {
  const evidence = snapshotCanonicalJson(input.evidence, "UCP order evidence");
  const expected = unsignedOrderEvidence(input.attestation);
  if (!exact(stripSignature(evidence as unknown as Record<string, unknown>), expected)) {
    throw new CounterpartyError("merchant order evidence differs from the verified UCP order");
  }
  await verifyExtension(
    evidence as unknown as Record<string, unknown>,
    UCP_ORDER_EVIDENCE_SEPARATOR,
    "order-evidence",
    agreementMerchantClaim(input.attestation.agreement),
    input.verify,
  );
}

async function verifyAgreement(
  agreement: AgreementArtifact,
  verify: CommitmentSignatureVerifier,
): Promise<void> {
  if (!isAgreementArtifact(agreement)) throw new CounterpartyError("DACS agreement is malformed");
  const unsigned = stripSignature(agreement as unknown as Record<string, unknown>);
  const separator = "agreementVersion" in agreement
    ? ARTIFACT_SEPARATORS.AgreementDocument
    : ARTIFACT_SEPARATORS.PayeeBoundAgreementDocument;
  const bytes = signedBytes(separator, contentHash(unsigned));
  for (const signature of agreement.signatures) {
    const disposition = await verify({
      purpose: "agreement",
      signedBytes: bytes,
      algorithm: signature.algorithm,
      signer: signature.party,
      value: signature.value,
    });
    if (disposition === "valid") continue;
    if (disposition === "indeterminate" || disposition === "error") {
      throw new TransientError(`DACS agreement signature could not be verified (${disposition})`);
    }
    throw new CounterpartyError("DACS agreement signature is invalid");
  }
}

function assertSettlementMatches(
  result: SettleResult,
  binding: DacsUcpCheckoutBinding,
): asserts result is SettleResult & {
  ok: true;
  txRef: Extract<ChainTxRef, { kind: "x402-event" }>;
  finality: { model: "block-depth"; finalityBlocks?: number };
  finalityObservedAt: number;
} {
  const chainId = Number(binding.payment.network.slice("eip155:".length));
  if (
    !result.ok ||
    !nonEmpty(result.txHash) ||
    result.chainId !== binding.payment.network ||
    result.payee.toLowerCase() !== binding.payment.payTo.toLowerCase() ||
    !result.txRef ||
    !isChainTxRef(result.txRef) ||
    result.txRef.kind !== "x402-event" ||
    result.txRef.httpResource !== binding.payment.resource ||
    result.txRef.chainId !== chainId ||
    result.txHash.toLowerCase() !== `0x${result.txRef.settlementTxHash}`.toLowerCase() ||
    !HASH_RE.test(result.txRef.paymentReceiptHash) ||
    result.finality?.model !== "block-depth" ||
    result.finality.finalityBlocks !== binding.payment.finalityBlocks ||
    !isTime(result.finalityObservedAt)
  ) {
    throw new CounterpartyError("x402 settlement result differs from the signed checkout binding");
  }
}

async function paymentEvidence(
  agreement: AgreementArtifact,
  binding: DacsUcpCheckoutBinding,
  settlement: SettleResult,
  observedAt: number,
  phaseOrchestrator: string,
  signer: BuildComponentSignatureOptions,
): Promise<SettlementEvidence> {
  requireCanonicalClaimReference(phaseOrchestrator, "payment phase orchestrator");
  if (!sameCanonicalClaimIdentity(signer.signer, phaseOrchestrator)) {
    throw new DacsError("DACS-4 payment evidence signer must be the authenticated phase orchestrator");
  }
  if (!settlement.txRef || !isChainTxRef(settlement.txRef)) {
    throw new CounterpartyError("x402 settlement lacks a normative transaction reference");
  }
  if (settlement.finality?.model !== "block-depth") {
    throw new CounterpartyError("x402 payment evidence requires authenticated block-depth finality");
  }
  const finality = settlement.finality;
  const unsigned = {
    evidenceVersion: "1" as const,
    jobId: agreement.jobId,
    phase: "pay-x402" as const,
    outcome: "success" as const,
    paymentTxRefs: [settlement.txRef],
    paymentAmount: {
      amount: agreement.terms.price.amount,
      currency: agreement.terms.price.currency,
    },
    settlementFinality: {
      ...finality,
      finalityObservedAt: settlement.finalityObservedAt ?? observedAt,
    },
    observedAt,
  };
  const signed = await signComponentArtifact(
    unsigned,
    ARTIFACT_SEPARATORS.SettlementEvidence,
    signer,
  );
  if (!isSettlementEvidence(signed)) {
    throw new DacsError("constructed x402 SettlementEvidence failed DACS-4 validation");
  }
  return signed;
}

function paymentCredential(binding: DacsUcpCheckoutBinding, result: SettleResult) {
  if (!result.txRef || result.txRef.kind !== "x402-event") {
    throw new CounterpartyError("x402 completion credential requires an event reference");
  }
  const txRefHash = contentHash(result.txRef as unknown as Record<string, unknown>);
  return {
    type: "x402",
    protocol_version: "2",
    payment_receipt_hash: result.txRef.paymentReceiptHash,
    settlement_tx_hash: result.txHash,
    network: result.chainId,
    agreement_hash: binding.agreementHash,
    checkout_binding_hash: contentHash(binding as unknown as Record<string, unknown>),
    transaction_reference_hash: txRefHash,
  };
}

async function completedCheckout(
  initial: Readonly<UcpCheckout>,
  request: Readonly<UcpCompleteCheckoutRequest>,
  key: string,
  input: UcpX402MvpInput,
  ucp: UcpRestClient,
): Promise<Readonly<UcpCheckout>> {
  let checkout = snapshotCanonicalJson(
    await ucp.completeCheckout(initial.id, request, key),
    "completed UCP Checkout",
  );
  const maxPolls = input.maxCheckoutPolls ?? 3;
  if (!Number.isSafeInteger(maxPolls) || maxPolls < 0 || maxPolls > 20) {
    throw new DacsError("maxCheckoutPolls must be between 0 and 20");
  }
  for (let attempt = 1; checkout.status === "complete_in_progress" && attempt <= maxPolls; attempt += 1) {
    await input.waitBeforePoll?.(attempt);
    checkout = snapshotCanonicalJson(
      await ucp.getCheckout(initial.id),
      "polled UCP Checkout",
    );
  }
  if (checkout.status !== "completed" || !checkout.order) {
    throw new TransientError(`UCP Checkout did not reach completed (status ${checkout.status})`);
  }
  return checkout;
}

function assertCompletedCheckoutMatches(
  completed: Readonly<UcpCheckout>,
  paid: Readonly<UcpCheckout>,
): void {
  if (
    completed.id !== paid.id ||
    completed.currency !== paid.currency ||
    !exact(completed.line_items, paid.line_items) ||
    !exact(completed.totals, paid.totals) ||
    !exact(completed.ucp.payment_handlers, paid.ucp.payment_handlers)
  ) {
    throw new CounterpartyError("completed UCP Checkout changed payment-bound commerce terms");
  }
}

function assertOrderMatches(
  order: Readonly<UcpOrder>,
  checkout: Readonly<UcpCheckout>,
): void {
  const confirmation = checkout.order;
  if (
    !confirmation ||
    order.id !== confirmation.id ||
    order.checkout_id !== checkout.id ||
    order.permalink_url !== confirmation.permalink_url ||
    order.currency !== checkout.currency ||
    !exact(order.totals, checkout.totals) ||
    !exact(order.line_items, checkout.line_items)
  ) {
    throw new CounterpartyError("UCP Order differs from the completed Checkout confirmation");
  }
}

/**
 * Experimental end-to-end composition: authenticated UCP checkout, DACS RFQ
 * authority, x402 finality, and hash-only order evidence. It deliberately does
 * not interpret UCP `completed` as DACS delivery finality.
 */
export async function runUcpX402Mvp(
  callerInput: UcpX402MvpInput,
  deps: UcpX402MvpDeps,
): Promise<UcpX402MvpResult> {
  const ucpSource = deps.ucp;
  const ucp: UcpRestClient = {
    createCheckout: Function.prototype.bind.call(ucpSource.createCheckout, ucpSource),
    getCheckout: Function.prototype.bind.call(ucpSource.getCheckout, ucpSource),
    completeCheckout: Function.prototype.bind.call(ucpSource.completeCheckout, ucpSource),
    getOrder: Function.prototype.bind.call(ucpSource.getOrder, ucpSource),
  };
  const settle = Function.prototype.bind.call(deps.settle, deps) as UcpX402MvpDeps["settle"];
  const merchantSource = deps.merchantAttestor;
  const merchantAttestor: UcpDacsMerchantAttestor = {
    attestCheckout: Function.prototype.bind.call(
      merchantSource.attestCheckout,
      merchantSource,
    ),
    attestOrder: Function.prototype.bind.call(merchantSource.attestOrder, merchantSource),
  };
  const authorizeCompletion = Function.prototype.bind.call(
    deps.authorizeCompletion,
    deps,
  ) as UcpX402MvpDeps["authorizeCompletion"];
  const verifyAgreementSignature = Function.prototype.bind.call(
    deps.verifyAgreementSignature,
    deps,
  ) as CommitmentSignatureVerifier;
  const verifyCompositionSignature = Function.prototype.bind.call(
    deps.verifyCompositionSignature,
    deps,
  ) as UcpCompositionSignatureVerifier;
  const agreement = snapshotCanonicalJson(callerInput.agreement, "UCP agreement");
  const derivation = snapshotCanonicalJson(callerInput.derivation, "UCP RFQ derivation");
  const business = snapshotCanonicalJson(callerInput.business, "UCP business snapshot");
  const identityBinding = snapshotCanonicalJson(
    callerInput.identityBinding,
    "UCP merchant identity binding",
  );
  const lineItems = snapshotCanonicalJson(callerInput.lineItems, "UCP line items");
  const paymentPhaseOrchestrator = requireCanonicalClaimReference(
    callerInput.paymentPhaseOrchestrator,
    "payment phase orchestrator",
  ).reference;
  const nowMs = callerInput.nowMs;
  if (typeof nowMs !== "function") throw new DacsError("UCP workflow clock is required");
  requireRequestedLineItems(lineItems);
  const paymentEvidenceSigner = ensurePlainSigner(callerInput.paymentEvidenceSigner);
  if (!sameCanonicalClaimIdentity(paymentEvidenceSigner.signer, paymentPhaseOrchestrator)) {
    throw new DacsError(
      "DACS-4 payment evidence signer must be the authenticated phase orchestrator",
    );
  }
  const maxCheckoutPolls = callerInput.maxCheckoutPolls ?? 3;
  if (
    !Number.isSafeInteger(maxCheckoutPolls) ||
    maxCheckoutPolls < 0 ||
    maxCheckoutPolls > 20
  ) {
    throw new DacsError("maxCheckoutPolls must be between 0 and 20");
  }
  const waitBeforePoll = callerInput.waitBeforePoll;
  if (waitBeforePoll !== undefined && typeof waitBeforePoll !== "function") {
    throw new DacsError("waitBeforePoll must be a function");
  }
  const input: UcpX402MvpInput = {
    agreement,
    derivation,
    business,
    identityBinding,
    authenticatedRail: callerInput.authenticatedRail,
    lineItems,
    paymentPhaseOrchestrator,
    nowMs,
    paymentEvidenceSigner,
    ...(waitBeforePoll === undefined
      ? {}
      : { waitBeforePoll }),
    maxCheckoutPolls,
  };
  const merchantClaim = agreementMerchantClaim(agreement);
  const now = input.nowMs();
  if (!isTime(now)) throw new DacsError("UCP workflow clock returned an invalid time");
  assertUcpRfqAgreementMatches(agreement, derivation);
  requireAuthenticatedSettlementRail(
    input.authenticatedRail,
    business,
    derivation.selectedRail,
  );
  if (!isTime(agreement.terms.deadline) || now > agreement.terms.deadline) {
    throw new DacsError("DACS agreement deadline passed before UCP checkout");
  }
  await verifyAgreement(agreement, verifyAgreementSignature);
  await verifyUcpMerchantIdentityBinding({
    binding: identityBinding,
    business,
    expectedMerchantClaim: merchantClaim,
    evaluatedAt: now,
    verify: verifyCompositionSignature,
  });
  const agreementHash = contentHash(agreement as unknown as Record<string, unknown>);
  const checkout = snapshotCanonicalJson(
    await ucp.createCheckout(
      { line_items: lineItems },
      dacsUcpIdempotencyKey({
        jobId: agreement.jobId,
        agreementHash,
        operation: "create-checkout",
      }),
    ),
    "created UCP Checkout",
  );
  const phaseIndex = paymentPhaseIndex(derivation);
  const checkoutAttestation: UcpCheckoutAttestationInput = {
    agreement,
    business,
    identityBinding,
    checkout,
    requestedLineItems: lineItems,
    phaseIndex,
    phaseOrchestrator: paymentPhaseOrchestrator,
    createdAt: now,
  };
  const checkoutBinding = snapshotCanonicalJson(
    await merchantAttestor.attestCheckout(checkoutAttestation),
    "merchant checkout binding",
  );
  await verifyUcpCheckoutBinding({
    binding: checkoutBinding,
    attestation: checkoutAttestation,
    verify: verifyCompositionSignature,
  });
  const authorized = completionAuthorization(await authorizeCompletion({
    jobId: agreement.jobId,
    agreementHash,
    phaseOrchestrator: paymentPhaseOrchestrator,
    checkoutId: checkout.id,
    checkoutBindingHash: contentHash(checkoutBinding as unknown as Record<string, unknown>),
    amount: checkoutBinding.payment.amount,
    assetSymbol: checkoutBinding.payment.assetSymbol,
    checkoutAmount: checkoutBinding.payment.checkoutAmount,
    checkoutCurrency: checkoutBinding.payment.checkoutCurrency,
    payTo: checkoutBinding.payment.payTo,
  }));
  if (!authorized.approved) {
    throw new DacsError(`UCP checkout completion was not authorised: ${authorized.reason}`);
  }
  const authorizationTime = input.nowMs();
  if (!isTime(authorizationTime)) {
    throw new DacsError("UCP workflow clock returned an invalid time");
  }
  if (authorizationTime > agreement.terms.deadline) {
    throw new DacsError("DACS agreement deadline passed before x402 settlement");
  }
  if (
    checkout.expires_at !== undefined &&
    Date.parse(checkout.expires_at) <= authorizationTime
  ) {
    throw new CounterpartyError("UCP Checkout expired before x402 settlement");
  }
  const settlement = snapshotCanonicalJson(await settle({
    rail: checkoutBinding.payment.railId,
    phase: "pay-x402",
    amount: checkoutBinding.payment.amount,
    asset: checkoutBinding.payment.assetSymbol,
    payee: merchantClaim,
    expectedPayee: checkoutBinding.payment.payTo,
    jobId: agreement.jobId,
    phaseIndex,
  }), "x402 settlement result");
  assertSettlementMatches(settlement, checkoutBinding);
  const observedAt = input.nowMs();
  if (!isTime(observedAt)) throw new DacsError("UCP workflow clock returned an invalid time");
  const paymentRecord = await paymentEvidence(
    agreement,
    checkoutBinding,
    settlement,
    observedAt,
    paymentPhaseOrchestrator,
    input.paymentEvidenceSigner,
  );
  const completeRequest: UcpCompleteCheckoutRequest = {
    payment: {
      instruments: [{
        id: `${DACS_UCP_X402_HANDLER}:${checkoutBinding.payment.handlerId}`,
        handler_id: checkoutBinding.payment.handlerId,
        type: DACS_UCP_X402_HANDLER,
        selected: true,
        credential: paymentCredential(checkoutBinding, settlement),
      }],
    },
  };
  const complete = await completedCheckout(
    checkout,
    completeRequest,
    dacsUcpIdempotencyKey({
      jobId: agreement.jobId,
      agreementHash,
      operation: "complete-checkout",
    }),
    input,
    ucp,
  );
  assertCompletedCheckoutMatches(complete, checkout);
  const order = snapshotCanonicalJson(
    await ucp.getOrder(complete.order!.id),
    "UCP Order",
  );
  assertOrderMatches(order, complete);
  const orderObservedAt = input.nowMs();
  if (!isTime(orderObservedAt)) throw new DacsError("UCP workflow clock returned an invalid time");
  const orderAttestation: UcpOrderAttestationInput = {
    agreement,
    checkout: complete,
    checkoutBinding,
    order,
    settlement,
    observedAt: orderObservedAt,
  };
  const orderEvidence = snapshotCanonicalJson(
    await merchantAttestor.attestOrder(orderAttestation),
    "merchant UCP order evidence",
  );
  await verifyUcpOrderEvidence({
    evidence: orderEvidence,
    attestation: orderAttestation,
    verify: verifyCompositionSignature,
  });
  return {
    agreementHash,
    checkout,
    checkoutBinding,
    completionAuthorization: authorized,
    settlement,
    paymentEvidence: paymentRecord,
    completedCheckout: complete,
    order,
    orderEvidence,
  };
}
