import {
  baseUnits,
  captureFixedPriceX402ProtocolBinding,
  demosWriteEvidenceToAnchorReceipt,
  commitFixedPriceAgreement,
  deriveFixedPriceAgreement,
  finalityCommitmentAddress,
  finalizeFixedPriceAgreementContributions,
  fixedPriceAgreementLogicalAddress,
  faultCategory,
  getAuthenticatedRailProvenance,
  isAuthenticatedRailDefinition,
  type AnchoredFinalityCommitment,
  type AuthenticatedRailDefinition,
  type CommitmentSignatureVerifier,
  type DurableAnchoredFixedPriceAgreement,
  type FixedPriceAgreementAnchorProvider,
  type FixedPriceAgreementContributionVerifier,
  type FixedPriceAgreementSignatureReconciliation,
  type FixedPriceAgreementInput,
  type FinalityCommitmentProvider,
  type FinalizedAgreementCommitment,
  type FinalizedFinalityAgreementCommitment,
  type X402BuyerEvmIntentAuthority,
  type X402BuyerPaymentRequirements,
  type X402BuyerSettlementIntent,
  type SellerFixedPriceAgreementContextQuery,
  type SellerFixedPriceAgreementContextResolution,
  type UnsignedAgreementArtifact,
} from "@kynesyslabs/dacs";
import {
  isBundleRequirement,
  isAgreementArtifact,
  isCanonicalBase64Url,
  isFinalityCommitmentRecord,
  isReadableAnchorReceipt,
  isListing,
  type BundleRequirement,
  type Listing,
  type FinalityCommitmentRecord,
  type PaymentRailRef,
} from "@kynesyslabs/dacs/artifacts";
import {
  canonicalize,
  contentHash,
  listingAddress,
  sha256Hex,
} from "@kynesyslabs/dacs/canonical";
import type {
  FixedPriceX402OrderInput,
  FixedPriceX402OrderRecord,
  FixedPriceX402TrackOperationInput,
} from "@kynesyslabs/dacs/commerce";
import { fixedPriceX402OrderLocalBindingHash } from "@kynesyslabs/dacs/commerce";
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import {
  canonicalDemosAgentPublicKey,
  identityBundleHash,
  sameCanonicalClaimIdentity,
} from "@kynesyslabs/dacs/identity";

import type { DacsSellerAgreementTransportRuntimeOptionsV1 } from
  "./agreementTransportRuntime.js";
import type {
  DacsBuyerAgreementTrackOptionsV1,
  DacsSellerAgreementTrackOptionsV1,
} from "./agreementRuntime.js";
import { DacsLiveEffectInputControlError } from "./liveEffects.js";
import {
  resolveDacsX402ExistingListingV1,
  type DacsX402ExistingListingAdmissionV1,
} from "./listingDoctor.js";
import { createDacsFixedPriceX402RoleOrderV1 } from "./liveOrder.js";
import {
  loadDacsLiveOrderInputV1,
  type DacsLiveOrderInputV1,
} from "./orderInput.js";
import { createDacsFixedPriceX402ProtocolBindingV1 } from "./purchaseQueue.js";
import { readDacsPublicJsonV1 } from "./publicJson.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";
import type {
  DacsSellerSessionBootstrapAdmissionV1,
  DacsSellerSessionBootstrapTransportOptionsV1,
} from "./sessionBootstrapTransportRuntime.js";
import { DacsSellerSessionAdmissionUnavailableError } from
  "./sessionBootstrapTransportRuntime.js";
import type {
  DacsBuyerSessionAgreementFactsV1,
  DacsSellerSessionAgreementFactsV1,
} from "./sessionBootstrapAgreementRuntime.js";
import { loadDacsBuyerSessionAgreementFactsForOrderV1 } from
  "./sessionBootstrapAgreementRuntime.js";
import type {
  DacsX402BuyerRuntimePaymentTrackOptionsV1,
  DacsX402BuyerRuntimePreparationV1,
} from "./x402RuntimePayment.js";
import type { DacsAgreementSellerVetProductionV1 } from
  "./agreementTransportRuntime.js";

const APPLICATION_VERSION = "1" as const;
const ADMISSION_VERSION = "2" as const;
const ADMISSION_DOMAIN = "dacs-fixed-price-x402-seller-admission:v2:" as const;
const DRAFT_CLOCK_VERSION = "1" as const;
const DRAFT_CLOCK_DOMAIN = "dacs-fixed-price-x402-agreement-clock:v1:" as const;
const AGREEMENT_PUBLICATION_VERSION = "1" as const;
const AGREEMENT_PUBLICATION_DOMAIN =
  "dacs-fixed-price-x402-agreement-publication:v1:" as const;
const COMMITMENT_CLOCK_VERSION = "1" as const;
const COMMITMENT_CLOCK_DOMAIN = "dacs-fixed-price-x402-commitment-clock:v1:" as const;
const COMMITMENT_PUBLICATION_VERSION = "1" as const;
const COMMITMENT_PUBLICATION_DOMAIN =
  "dacs-fixed-price-x402-commitment-publication:v1:" as const;
const COMMITMENT_RESULT_VERSION = "1" as const;
const COMMITMENT_RESULT_DOMAIN = "dacs-fixed-price-x402-commitment-result:v1:" as const;
const BUYER_COMMITMENT_RESULT_DOMAIN =
  "dacs-fixed-price-x402-buyer-commitment-result:v1:" as const;
const DEFAULT_MAXIMUM_CLOCK_SKEW_MS = 60_000;
const HASH_RE = /^[0-9a-f]{64}$/;
const STORAGE_RE = /^stor-[0-9a-f]{40}$/;

export const DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1: Readonly<BundleRequirement> =
  Object.freeze({ requirementVersion: "1", required: [] });

/**
 * Turn the Listing-bound x402 base URL into one unambiguous paid resource.
 * The canonical job id is path data, never caller-selected routing authority.
 */
export function dacsFixedPriceX402DeliveryResourceV1(
  resourceBaseUrl: string,
  jobId: string,
): string {
  if (typeof resourceBaseUrl !== "string" || resourceBaseUrl.length === 0 ||
      resourceBaseUrl.trim() !== resourceBaseUrl ||
      !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(jobId)) {
    throw new TypeError("fixed-price x402 delivery resource is invalid");
  }
  let base: URL;
  try {
    base = new URL(resourceBaseUrl);
  } catch {
    throw new TypeError("fixed-price x402 delivery resource is invalid");
  }
  if (base.protocol !== "https:" || base.username || base.password || base.search ||
      base.hash) {
    throw new TypeError("fixed-price x402 delivery resource is invalid");
  }
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/${jobId}`;
  return base.toString();
}

export interface DacsFixedPriceX402ApplicationV1 {
  applicationVersion: typeof APPLICATION_VERSION;
  listingRef: string;
  listingContentHash: string;
  listingLogicalAddress: string;
  listing: Readonly<Listing>;
  requestHash: string;
  request: Readonly<Record<string, unknown>>;
}

export interface DacsFixedPriceX402SellerAdmissionRecordV1 {
  admissionVersion: typeof ADMISSION_VERSION;
  jobId: string;
  localBindingHash: string;
  admittedAt: number;
  application: Readonly<DacsFixedPriceX402ApplicationV1>;
  protocol: Readonly<FixedPriceX402OrderInput["protocol"]>;
}

export interface DacsFixedPriceX402SellerSessionPolicyOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  rail: Readonly<AuthenticatedRailDefinition>;
  sellerPublicEndpoint: string;
  sellerPayee: string;
  maximumServiceAmount: string;
  now?(): number;
  readJson?(url: string): Promise<unknown>;
}

export interface DacsFixedPriceX402SellerSessionPolicyV1 {
  admitInit: DacsSellerSessionBootstrapTransportOptionsV1["admitInit"];
  admitProposal: DacsSellerAgreementTransportRuntimeOptionsV1["admitProposal"];
  resolveBuyerRequirement(input: Readonly<{
    retained: Readonly<DacsLiveOrderInputV1>;
  }>): Readonly<BundleRequirement>;
  resolveSellerRequirement(): Readonly<BundleRequirement>;
}

export interface DacsFixedPriceX402BuyerAgreementPolicyOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  now?(): number;
}

export interface DacsFixedPriceX402BuyerAgreementPolicyV1 {
  buildDraft(input: Readonly<{
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
    session: Readonly<DacsBuyerSessionAgreementFactsV1>;
  }>): Readonly<UnsignedAgreementArtifact>;
  verifyContribution: FixedPriceAgreementContributionVerifier;
  reconcileBuyerSignature: DacsBuyerAgreementTrackOptionsV1[
    "reconcileBuyerSignature"
  ];
  anchor: Readonly<FixedPriceAgreementAnchorProvider>;
  authorizeAnchored(input: Readonly<{
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
    result: Readonly<DurableAnchoredFixedPriceAgreement>;
  }>): Promise<boolean> | boolean;
}

export interface DacsFixedPriceX402BuyerPaymentPolicyOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  rail: Readonly<AuthenticatedRailDefinition>;
  tokenDomain: Readonly<{ name: string; version: string }>;
  maxTimeoutSeconds: number;
}

export interface DacsFixedPriceX402BuyerPaymentPolicyV1 {
  resolvePreparation: DacsX402BuyerRuntimePaymentTrackOptionsV1["resolvePreparation"];
  authorizeIntent: X402BuyerEvmIntentAuthority;
  authorizePreparedIntent:
    DacsX402BuyerRuntimePaymentTrackOptionsV1["authorizePreparedIntent"];
}

export interface DacsFixedPriceX402SellerAgreementPolicyOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  maximumClockSkewMs?: number;
}

export interface DacsFixedPriceX402SellerAgreementPolicyV1 {
  resolveAuthenticatedAgreementContext(input: Readonly<
    SellerFixedPriceAgreementContextQuery & {
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
    session: Readonly<DacsSellerSessionAgreementFactsV1>;
    sellerVet: Readonly<DacsAgreementSellerVetProductionV1>;
    sellerRequirement: Readonly<BundleRequirement>;
  }>): SellerFixedPriceAgreementContextResolution;
  verifyContribution: FixedPriceAgreementContributionVerifier;
  reconcileSellerSignature: DacsSellerAgreementTrackOptionsV1[
    "reconcileSellerSignature"
  ];
  authorizeComplete: DacsSellerAgreementTrackOptionsV1["authorizeComplete"];
}

export class DacsFixedPriceX402ProfileError extends Error {
  override readonly name = "DacsFixedPriceX402ProfileError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function plainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null) &&
      Reflect.ownKeys(value).every((key) => {
        if (typeof key !== "string") return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
      });
  } catch {
    return false;
  }
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function copy<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function captureDacsFixedPriceX402ApplicationV1(
  value: unknown,
): Readonly<DacsFixedPriceX402ApplicationV1> {
  if (!plainObject(value) || !exactKeys(value, [
    "applicationVersion", "listingRef", "listingContentHash", "listingLogicalAddress",
    "listing", "requestHash", "request",
  ]) || value.applicationVersion !== APPLICATION_VERSION ||
      typeof value.listingRef !== "string" || !STORAGE_RE.test(value.listingRef) ||
      typeof value.listingContentHash !== "string" ||
        !HASH_RE.test(value.listingContentHash) ||
      typeof value.listingLogicalAddress !== "string" ||
        value.listingLogicalAddress.length === 0 ||
      !isListing(value.listing) || typeof value.requestHash !== "string" ||
        !HASH_RE.test(value.requestHash) || !plainObject(value.request)) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-application-invalid");
  }
  let captured: DacsFixedPriceX402ApplicationV1;
  try {
    captured = copy(value) as unknown as DacsFixedPriceX402ApplicationV1;
  } catch {
    throw new DacsFixedPriceX402ProfileError("fixed-price-application-invalid");
  }
  if (contentHash(captured.listing as unknown as Record<string, unknown>) !==
        captured.listingContentHash ||
      listingAddress(
        captured.listing.seller.identity.presentedBy,
        captured.listing.listingId,
        captured.listing.listingVersion,
      ) !== captured.listingLogicalAddress ||
      sha256Hex(canonicalize(captured.request)) !== captured.requestHash) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-application-binding-invalid");
  }
  return deepFreeze(captured);
}

export function resolveDacsFixedPriceX402BuyerRequirementsV1(
  retained: Readonly<DacsLiveOrderInputV1>,
): Readonly<{ buyer: Readonly<BundleRequirement>; seller: Readonly<BundleRequirement> }> {
  const application = captureDacsFixedPriceX402ApplicationV1(retained.application);
  if (!isBundleRequirement(application.listing.buyerRequirement)) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-buyer-requirement-invalid");
  }
  return Object.freeze({
    buyer: deepFreeze(copy(application.listing.buyerRequirement)),
    // Standard #331 does not yet define complementary requirement provenance.
    // The generated v1 profile is therefore explicit and intentionally empty.
    seller: DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1,
  });
}

function admissionId(jobId: string): string {
  return sha256Hex(`${ADMISSION_DOMAIN}${jobId}`);
}

function captureAdmission(value: unknown): Readonly<DacsFixedPriceX402SellerAdmissionRecordV1> {
  if (!plainObject(value) || !exactKeys(value, [
    "admissionVersion", "jobId", "localBindingHash", "admittedAt", "application",
    "protocol",
  ]) || value.admissionVersion !== ADMISSION_VERSION ||
      typeof value.jobId !== "string" || typeof value.localBindingHash !== "string" ||
      !HASH_RE.test(value.localBindingHash) || !Number.isSafeInteger(value.admittedAt) ||
      Number(value.admittedAt) < 0 || !plainObject(value.protocol)) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-seller-admission-corrupt");
  }
  const application = captureDacsFixedPriceX402ApplicationV1(value.application);
  let protocol: FixedPriceX402OrderInput["protocol"];
  try {
    protocol = captureFixedPriceX402ProtocolBinding(value.protocol);
  } catch {
    throw new DacsFixedPriceX402ProfileError("fixed-price-seller-admission-corrupt");
  }
  return deepFreeze(copy({
    admissionVersion: ADMISSION_VERSION,
    jobId: value.jobId,
    localBindingHash: value.localBindingHash,
    admittedAt: Number(value.admittedAt),
    application,
    protocol,
  }));
}

function retainAdmission(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<FixedPriceX402OrderInput>,
  application: Readonly<DacsFixedPriceX402ApplicationV1>,
  admittedAt: number,
): Readonly<DacsFixedPriceX402SellerAdmissionRecordV1> {
  const id = admissionId(order.jobId);
  const record: DacsFixedPriceX402SellerAdmissionRecordV1 = {
    admissionVersion: ADMISSION_VERSION,
    jobId: order.jobId,
    localBindingHash: fixedPriceX402OrderLocalBindingHash(order),
    admittedAt,
    application,
    protocol: order.protocol,
  };
  const existing = context.database.loadEffectInput("session", id);
  if (existing !== undefined) {
    const captured = captureAdmission(existing);
    if (captured.jobId !== record.jobId ||
        captured.localBindingHash !== record.localBindingHash ||
        canonicalize(captured.application) !== canonicalize(record.application) ||
        canonicalize(captured.protocol) !== canonicalize(record.protocol)) {
      throw new DacsFixedPriceX402ProfileError("fixed-price-seller-admission-conflict");
    }
    return captured;
  }
  const put = context.database.putEffectIntent({
    kind: "session",
    effectId: id,
    bindingHash: record.localBindingHash,
    input: record,
    idempotencyKey: id,
    jobId: order.jobId,
  });
  if (put.status === "conflict") {
    throw new DacsFixedPriceX402ProfileError("fixed-price-seller-admission-conflict");
  }
  return captureAdmission(context.database.loadEffectInput("session", id));
}

export function loadDacsFixedPriceX402SellerAdmissionV1(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<FixedPriceX402OrderRecord>,
): Readonly<DacsFixedPriceX402SellerAdmissionRecordV1> {
  if (context.role !== "seller" || order.role !== "seller") {
    throw new DacsFixedPriceX402ProfileError("fixed-price-seller-order-mismatch");
  }
  const value = context.database.loadEffectInput("session", admissionId(order.jobId));
  if (value === undefined) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-seller-admission-missing");
  }
  const admission = captureAdmission(value);
  if (admission.jobId !== order.jobId ||
      admission.localBindingHash !== order.localBindingHash ||
      canonicalize(admission.protocol) !== canonicalize(order.protocol)) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-seller-admission-corrupt");
  }
  return admission;
}

export function createDacsFixedPriceX402SellerSessionPolicyV1(
  options: Readonly<DacsFixedPriceX402SellerSessionPolicyOptionsV1>,
): Readonly<DacsFixedPriceX402SellerSessionPolicyV1> {
  if (!plainObject(options) || !plainObject(options.context) ||
      options.context.role !== "seller" || typeof options.sellerPublicEndpoint !== "string" ||
      typeof options.sellerPayee !== "string" ||
      typeof options.maximumServiceAmount !== "string" ||
      (options.now !== undefined && typeof options.now !== "function") ||
      (options.readJson !== undefined && typeof options.readJson !== "function")) {
    throw new TypeError("fixed-price seller session policy options are invalid");
  }
  const context = options.context;
  const sellerPublicKey = canonicalDemosAgentPublicKey(context.authority);
  if (sellerPublicKey === null) {
    throw new TypeError("fixed-price seller authority is invalid");
  }

  const admitInit: DacsSellerSessionBootstrapTransportOptionsV1["admitInit"] =
    async ({ authenticated, payload }): Promise<Readonly<
      DacsSellerSessionBootstrapAdmissionV1
    >> => {
      const application = captureDacsFixedPriceX402ApplicationV1(payload.application);
      if (payload.order.sdkJobs.role !== "buyer" ||
          !sameCanonicalClaimIdentity(payload.order.buyer, context.peerAuthority) ||
          !sameCanonicalClaimIdentity(payload.order.seller, context.authority) ||
          authenticated.envelope.sender !== context.peerAuthority ||
          authenticated.envelope.audience !== context.authority) {
        throw new DacsFixedPriceX402ProfileError("fixed-price-session-party-mismatch");
      }
      const admittedAt = options.now?.() ?? context.database.readTime();
      const resolved = await resolveDacsX402ExistingListingV1({
        listingRef: application.listingRef,
        sellerAuthority: context.authority,
        sellerPublicKey,
        sellerPublicEndpoint: options.sellerPublicEndpoint,
        sellerPayee: options.sellerPayee,
        network: context.config.rail.requestedNetwork as `eip155:${number}`,
        rail: options.rail,
        maximumServiceAmount: options.maximumServiceAmount,
        now: admittedAt,
        readAnchor: (locator) => context.demos.adapter.readAnchor(locator),
        async authenticateAnchor(anchor) {
          const receipt = await context.demos.adapter.resolveDemosAnchorReceipt(anchor);
          return receipt !== null &&
            await context.demos.adapter.verifyDemosAnchorReceipt(receipt) === true;
        },
        readJson: options.readJson ?? ((url) => readDacsPublicJsonV1(url)),
      });
      if (resolved.status === "blocked") {
        throw new DacsSellerSessionAdmissionUnavailableError(resolved.reasonCode);
      }
      if (resolved.status !== "verified") {
        throw new DacsFixedPriceX402ProfileError(resolved.reasonCode);
      }
      if (resolved.admission.listingRef !== application.listingRef ||
          resolved.admission.listingContentHash !== application.listingContentHash ||
          resolved.admission.logicalAddress !== application.listingLogicalAddress ||
          canonicalize(resolved.admission.listing) !== canonicalize(application.listing) ||
          canonicalize(createDacsFixedPriceX402ProtocolBindingV1(resolved.admission)) !==
            canonicalize(payload.order.protocol)) {
        throw new DacsFixedPriceX402ProfileError("fixed-price-session-listing-not-admitted");
      }
      const order = createDacsFixedPriceX402RoleOrderV1({
        role: "seller",
        jobId: payload.order.jobId,
        buyer: payload.order.buyer,
        seller: payload.order.seller,
        protocol: payload.order.protocol,
      });
      retainAdmission(
        context,
        order,
        application,
        admittedAt,
      );
      return Object.freeze({ order, application });
    };

  return Object.freeze({
    admitInit,
    async admitProposal({ payload }: Parameters<
      DacsSellerAgreementTransportRuntimeOptionsV1["admitProposal"]
    >[0]) {
      const loaded = await context.database.createLiveCoordinatorStore("seller")
        .load("seller", payload.transportIdentity.jobId);
      if (loaded.status !== "ok") {
        throw new DacsFixedPriceX402ProfileError("fixed-price-seller-order-missing");
      }
      const admission = loadDacsFixedPriceX402SellerAdmissionV1(context, loaded.record);
      return Object.freeze({
        order: createDacsFixedPriceX402RoleOrderV1({
          role: "seller",
          jobId: loaded.record.jobId,
          buyer: loaded.record.buyer,
          seller: loaded.record.seller,
          protocol: loaded.record.protocol,
        }),
        application: admission.application,
      });
    },
    resolveBuyerRequirement({ retained }: Readonly<{
      retained: Readonly<DacsLiveOrderInputV1>;
    }>) {
      const application = captureDacsFixedPriceX402ApplicationV1(retained.application);
      return deepFreeze(copy(application.listing.buyerRequirement));
    },
    resolveSellerRequirement() {
      return DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1;
    },
  });
}

interface AgreementClockRecordV1 {
  clockVersion: typeof DRAFT_CLOCK_VERSION;
  role: "buyer";
  jobId: string;
  localBindingHash: string;
  generatedAt: number;
}

export interface DacsFixedPriceX402BuyerAgreementPublicationV1 {
  publicationVersion: typeof AGREEMENT_PUBLICATION_VERSION;
  jobId: string;
  localBindingHash: string;
  writer: string;
  logicalAddress: string;
  agreementHash: string;
  artifact: Readonly<Record<string, unknown>>;
}

function agreementClockId(jobId: string): string {
  return sha256Hex(`${DRAFT_CLOCK_DOMAIN}${jobId}`);
}

function agreementPublicationId(logicalAddress: string): string {
  return sha256Hex(`${AGREEMENT_PUBLICATION_DOMAIN}${logicalAddress}`);
}

function captureAgreementClock(value: unknown): Readonly<AgreementClockRecordV1> {
  if (!plainObject(value) || !exactKeys(value, [
    "clockVersion", "role", "jobId", "localBindingHash", "generatedAt",
  ]) || value.clockVersion !== DRAFT_CLOCK_VERSION || value.role !== "buyer" ||
      typeof value.jobId !== "string" || typeof value.localBindingHash !== "string" ||
      !HASH_RE.test(value.localBindingHash) || !Number.isSafeInteger(value.generatedAt) ||
      Number(value.generatedAt) < 0) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-agreement-clock-corrupt");
  }
  return Object.freeze({
    clockVersion: DRAFT_CLOCK_VERSION,
    role: "buyer",
    jobId: value.jobId,
    localBindingHash: value.localBindingHash,
    generatedAt: Number(value.generatedAt),
  });
}

function retainAgreementClock(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  operation: Readonly<FixedPriceX402TrackOperationInput>,
  now: () => number,
): Readonly<AgreementClockRecordV1> {
  const id = agreementClockId(operation.order.jobId);
  const existing = context.database.loadEffectInput("session", id);
  if (existing !== undefined) {
    const captured = captureAgreementClock(existing);
    if (captured.jobId !== operation.order.jobId ||
        captured.localBindingHash !== operation.order.localBindingHash) {
      throw new DacsFixedPriceX402ProfileError("fixed-price-agreement-clock-conflict");
    }
    return captured;
  }
  const generatedAt = now();
  const record: AgreementClockRecordV1 = {
    clockVersion: DRAFT_CLOCK_VERSION,
    role: "buyer",
    jobId: operation.order.jobId,
    localBindingHash: operation.order.localBindingHash,
    generatedAt,
  };
  const put = context.database.putEffectIntent({
    kind: "session",
    effectId: id,
    bindingHash: operation.order.localBindingHash,
    input: record,
    idempotencyKey: id,
    jobId: operation.order.jobId,
  });
  if (put.status === "conflict") {
    throw new DacsFixedPriceX402ProfileError("fixed-price-agreement-clock-conflict");
  }
  return captureAgreementClock(context.database.loadEffectInput("session", id));
}

function exactRail(
  application: Readonly<DacsFixedPriceX402ApplicationV1>,
  order: Readonly<FixedPriceX402OrderInput>,
): Readonly<{ rail: PaymentRailRef; phaseIndex: number; payeeAddress: string }> {
  const listing = application.listing;
  const accepted = listing.acceptedRails?.filter((candidate) =>
    candidate.railId === order.protocol.rail.railId &&
    candidate.railVersion === order.protocol.rail.railVersion
  ) ?? [];
  const phaseIndexes = listing.pipeline.flatMap((phase, index) =>
    phase.kind === "pay-x402" ? [index] : []
  );
  const commitmentCount = listing.pipeline.filter((phase) =>
    phase.kind === "commit-payee-bound-agreement"
  ).length;
  const phase = phaseIndexes.length === 1 ? listing.pipeline[phaseIndexes[0]!] : undefined;
  const rail = accepted.length === 1 ? accepted[0] : undefined;
  const payeeAddress = plainObject(rail?.parameters)
    ? rail.parameters.payTo
    : undefined;
  if (order.protocol.phase !== "pay-x402" ||
      order.protocol.rail.phaseHandler !== "pay-x402" ||
      phaseIndexes.length !== 1 || commitmentCount !== 1 || rail === undefined ||
      !plainObject(phase?.parameters) || phase.parameters.rail !== rail.railId ||
      typeof payeeAddress !== "string" || payeeAddress.length === 0 ||
      rail.parameters?.network !== order.protocol.rail.network) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-agreement-rail-invalid");
  }
  return Object.freeze({
    rail: deepFreeze(copy(rail)),
    phaseIndex: phaseIndexes[0]!,
    payeeAddress,
  });
}

function buildAgreementInput(input: Readonly<{
  application: Readonly<DacsFixedPriceX402ApplicationV1>;
  order: Readonly<FixedPriceX402OrderInput>;
  buyerIdentity: Readonly<DacsBuyerSessionAgreementFactsV1["buyerIdentity"]>;
  sellerIdentity: Readonly<DacsBuyerSessionAgreementFactsV1["sellerIdentity"]>;
  buyerVetRef: Readonly<DacsBuyerSessionAgreementFactsV1["buyerVetRef"]>;
  sellerVetRef: Readonly<DacsBuyerSessionAgreementFactsV1["sellerVetRef"]>;
  generatedAt: number;
}>): Readonly<FixedPriceAgreementInput> {
  const { application, order } = input;
  if (order.jobId.length === 0 ||
      application.listingContentHash !== contentHash(
        application.listing as unknown as Record<string, unknown>,
      ) ||
      !sameCanonicalClaimIdentity(application.listing.seller.identity.presentedBy,
        order.seller) ||
      !sameCanonicalClaimIdentity(input.buyerIdentity.presentedBy, order.buyer) ||
      !sameCanonicalClaimIdentity(input.sellerIdentity.presentedBy, order.seller)) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-agreement-party-invalid");
  }
  const selected = exactRail(application, order);
  return copy({
    jobId: order.jobId,
    verifiedListing: {
      disposition: "verified" as const,
      listing: application.listing,
      pin: {
        listingId: application.listing.listingId,
        version: application.listing.listingVersion,
        contentHash: application.listingContentHash,
      },
    },
    buyer: {
      identityBundle: input.buyerIdentity,
      vetRecordRef: input.buyerVetRef,
    },
    seller: {
      identityBundle: input.sellerIdentity,
      vetRecordRef: input.sellerVetRef,
    },
    selectedRail: selected.rail,
    payoutBindings: [{
      railId: selected.rail.railId,
      phaseIndex: selected.phaseIndex,
      payeeAddress: selected.payeeAddress,
    }],
    generatedAt: input.generatedAt,
  });
}

function agreementVerifier(
  buyer: string,
  seller: string,
): FixedPriceAgreementContributionVerifier {
  return ({ role, party, algorithm, value, signedBytes }) => {
    const expected = role === "buyer" ? buyer : seller;
    if (algorithm !== "ed25519" || party !== expected ||
        !isCanonicalBase64Url(value)) return "invalid";
    const signature = Buffer.from(value, "base64url");
    if (signature.byteLength !== 64 || signature.toString("base64url") !== value) {
      return "invalid";
    }
    const publicKey = canonicalDemosAgentPublicKey(expected);
    if (publicKey === null) return "invalid";
    try {
      return ed25519Verify(
        signedBytes,
        Uint8Array.from(signature),
        publicKeyFromRaw(publicKey),
      ) ? "valid" : "invalid";
    } catch {
      return "error";
    }
  };
}

const absentSignature = (): FixedPriceAgreementSignatureReconciliation =>
  ({ disposition: "absent", reason: "local-signature-not-retained" });

function captureAgreementPublication(
  value: unknown,
): Readonly<DacsFixedPriceX402BuyerAgreementPublicationV1> {
  if (!plainObject(value) || !exactKeys(value, [
    "publicationVersion", "jobId", "localBindingHash", "writer",
    "logicalAddress", "agreementHash", "artifact",
  ]) || value.publicationVersion !== AGREEMENT_PUBLICATION_VERSION ||
      typeof value.jobId !== "string" || typeof value.localBindingHash !== "string" ||
      !HASH_RE.test(value.localBindingHash) || typeof value.writer !== "string" ||
      typeof value.logicalAddress !== "string" || typeof value.agreementHash !== "string" ||
      !HASH_RE.test(value.agreementHash) || !isAgreementArtifact(value.artifact) ||
      value.artifact.jobId !== value.jobId ||
      fixedPriceAgreementLogicalAddress(value.jobId) !== value.logicalAddress ||
      contentHash(value.artifact as unknown as Record<string, unknown>) !==
        value.agreementHash) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-agreement-publication-corrupt");
  }
  return deepFreeze(copy(value as unknown as
    DacsFixedPriceX402BuyerAgreementPublicationV1));
}

async function buyerOrderRecord(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  jobId: string,
): Promise<Readonly<FixedPriceX402OrderRecord>> {
  const loaded = await context.database.createLiveCoordinatorStore("buyer")
    .load("buyer", jobId);
  if (loaded.status !== "ok" || loaded.record.role !== "buyer" ||
      loaded.record.buyer !== context.authority ||
      loaded.record.seller !== context.peerAuthority) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-buyer-order-missing");
  }
  return loaded.record;
}

export async function loadDacsFixedPriceX402BuyerAgreementPublicationV1(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<FixedPriceX402OrderRecord>,
): Promise<Readonly<DacsFixedPriceX402BuyerAgreementPublicationV1>> {
  if (context.role !== "buyer" || order.role !== "buyer") {
    throw new DacsFixedPriceX402ProfileError("fixed-price-buyer-agreement-role-mismatch");
  }
  const logicalAddress = fixedPriceAgreementLogicalAddress(order.jobId);
  const value = context.database.loadEffectInput(
    "artifact-publication",
    agreementPublicationId(logicalAddress),
  );
  if (value === undefined) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-buyer-agreement-missing");
  }
  const record = captureAgreementPublication(value);
  if (record.jobId !== order.jobId || record.localBindingHash !== order.localBindingHash ||
      record.writer !== context.authority || record.logicalAddress !== logicalAddress) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-buyer-agreement-corrupt");
  }
  const loaded = await buyerOrderRecord(context, record.jobId);
  if (loaded.localBindingHash !== order.localBindingHash) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-buyer-agreement-corrupt");
  }
  return record;
}

function createAgreementAnchorProvider(
  context: Readonly<DacsLiveRoleOperationContextV1>,
): Readonly<FixedPriceAgreementAnchorProvider> {
  async function retained(
    logicalAddress: string,
    agreementHash: string,
  ): Promise<Readonly<DacsFixedPriceX402BuyerAgreementPublicationV1> | undefined> {
    const value = context.database.loadEffectInput(
      "artifact-publication",
      agreementPublicationId(logicalAddress),
    );
    if (value === undefined) return undefined;
    const record = captureAgreementPublication(value);
    if (record.logicalAddress !== logicalAddress || record.agreementHash !== agreementHash ||
        record.writer !== context.authority) {
      throw new DacsFixedPriceX402ProfileError("fixed-price-agreement-publication-conflict");
    }
    const order = await buyerOrderRecord(context, record.jobId);
    if (record.localBindingHash !== order.localBindingHash) {
      throw new DacsFixedPriceX402ProfileError("fixed-price-agreement-publication-conflict");
    }
    return record;
  }

  const provider: FixedPriceAgreementAnchorProvider = {
    async anchorAgreement(input, fence) {
      try {
        if (!isAgreementArtifact(input.artifact) ||
            input.artifact.jobId.length === 0 ||
            fixedPriceAgreementLogicalAddress(input.artifact.jobId) !== input.logicalAddress ||
            contentHash(input.artifact as unknown as Record<string, unknown>) !==
              input.agreementHash) {
          return { disposition: "rejected" as const,
            reason: "agreement publication is malformed" };
        }
        const order = await buyerOrderRecord(context, input.artifact.jobId);
        const record: DacsFixedPriceX402BuyerAgreementPublicationV1 = {
          publicationVersion: AGREEMENT_PUBLICATION_VERSION,
          jobId: order.jobId,
          localBindingHash: order.localBindingHash,
          writer: context.authority,
          logicalAddress: input.logicalAddress,
          agreementHash: input.agreementHash,
          artifact: input.artifact as unknown as Record<string, unknown>,
        };
        const effectId = agreementPublicationId(input.logicalAddress);
        const put = context.database.putEffectIntent({
          kind: "artifact-publication",
          effectId,
          bindingHash: order.localBindingHash,
          input: record,
          idempotencyKey: effectId,
          jobId: order.jobId,
        });
        if (put.status === "conflict") {
          return { disposition: "rejected" as const,
            reason: "agreement publication conflicts with retained intent" };
        }
        captureAgreementPublication(context.database.loadEffectInput(
          "artifact-publication", effectId,
        ));
        await context.demos.adapter.anchorWriteOnce(
          record.logicalAddress,
          record.artifact,
          { metadata: {
            logicalAddress: record.logicalAddress,
            contentHash: record.agreementHash,
            envelopeHash: sha256Hex(canonicalize(record.artifact)),
          } },
        );
        return { disposition: "submitted" as const };
      } catch {
        return { disposition: "indeterminate" as const,
          reason: "agreement publication outcome is ambiguous" };
      }
    },
    async reconcileAgreementAnchor(input, fence) {
      let record: Readonly<DacsFixedPriceX402BuyerAgreementPublicationV1> | undefined;
      try {
        record = await retained(input.logicalAddress, input.agreementHash);
      } catch {
        return { disposition: "rejected" as const,
          reason: "retained agreement publication conflicts" };
      }
      if (record === undefined) {
        return { disposition: "absent" as const,
          reason: "agreement publication intent is absent" };
      }
      try {
        const anchor = await context.demos.adapter.anchorWriteOnce(
          record.logicalAddress,
          record.artifact,
          { metadata: {
            logicalAddress: record.logicalAddress,
            contentHash: record.agreementHash,
            envelopeHash: sha256Hex(canonicalize(record.artifact)),
          } },
        );
        const receipt = anchor.demosEvidence === undefined
          ? await context.demos.adapter.resolveDemosAnchorReceipt({
              logicalAddress: record.logicalAddress,
              nativeAddress: anchor.address,
              contentHash: record.agreementHash,
              writer: record.writer,
            })
          : demosWriteEvidenceToAnchorReceipt({
              evidence: anchor.demosEvidence,
              logicalAddress: record.logicalAddress,
              contentHash: record.agreementHash,
              writer: record.writer,
            });
        if (receipt === null || !isReadableAnchorReceipt(receipt) ||
            receipt.logicalAddress !== record.logicalAddress ||
            receipt.contentHash !== record.agreementHash ||
            receipt.writer !== record.writer ||
            receipt.observationDisposition !== "established" ||
            (receipt.state !== "included" && receipt.state !== "finalized")) {
          return { disposition: "indeterminate" as const,
            reason: "agreement receipt is not authoritatively observable" };
        }
        const readback = await context.demos.adapter.readAnchor(receipt.nativeAddress);
        if (readback === null || !isAgreementArtifact(readback) ||
            canonicalize(readback) !== canonicalize(record.artifact) ||
            contentHash(readback) !== record.agreementHash) {
          return { disposition: "indeterminate" as const,
            reason: "agreement native readback is unavailable" };
        }
        return {
          disposition: "present" as const,
          value: {
            artifact: copy(readback),
            ref: {
              anchor: { kind: "storage-program" as const,
                locator: record.logicalAddress },
              contentHash: record.agreementHash,
              signer: record.writer,
            },
            anchorReceipt: copy(receipt),
          },
        };
      } catch {
        return { disposition: "indeterminate" as const,
          reason: "agreement publication reconciliation is unavailable" };
      }
    },
    async verifyAnchorReceipt(input) {
      if (input.expectedWriter !== context.authority ||
          input.ref.anchor.kind !== "storage-program" ||
          input.ref.signer !== context.authority ||
          input.receipt.writer !== context.authority ||
          input.receipt.logicalAddress !== input.ref.anchor.locator ||
          input.receipt.contentHash !== input.ref.contentHash) return "invalid";
      try {
        return await context.demos.adapter.verifyDemosAnchorReceipt(input.receipt)
          ? "valid" : "invalid";
      } catch {
        return "error";
      }
    },
  };
  return Object.freeze(provider);
}

function buyerSessionBindingsValid(
  application: Readonly<DacsFixedPriceX402ApplicationV1>,
  session: Readonly<DacsBuyerSessionAgreementFactsV1>,
): boolean {
  return session.buyerRequirementHash === sha256Hex(canonicalize(
    application.listing.buyerRequirement,
  )) && session.sellerRequirementHash === sha256Hex(canonicalize(
    DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1,
  ));
}

export function createDacsFixedPriceX402BuyerAgreementPolicyV1(
  options: Readonly<DacsFixedPriceX402BuyerAgreementPolicyOptionsV1>,
): Readonly<DacsFixedPriceX402BuyerAgreementPolicyV1> {
  if (!plainObject(options) || !plainObject(options.context) ||
      options.context.role !== "buyer" ||
      (options.now !== undefined && typeof options.now !== "function")) {
    throw new TypeError("fixed-price buyer agreement policy options are invalid");
  }
  const context = options.context;
  const buildDraft: DacsFixedPriceX402BuyerAgreementPolicyV1["buildDraft"] = (input) => {
    const application = captureDacsFixedPriceX402ApplicationV1(input.retained.application);
    if (input.operation.order.jobId !== input.retained.jobId ||
        input.operation.order.localBindingHash !== input.retained.localBindingHash ||
        input.session.jobId !== input.retained.jobId ||
        input.session.localBindingHash !== input.retained.localBindingHash ||
        !buyerSessionBindingsValid(application, input.session)) {
      throw new DacsFixedPriceX402ProfileError("fixed-price-buyer-agreement-binding-invalid");
    }
    const clock = retainAgreementClock(
      context,
      input.operation,
      options.now ?? (() => context.database.readTime()),
    );
    return deriveFixedPriceAgreement(buildAgreementInput({
      application,
      order: input.retained.order,
      buyerIdentity: input.session.buyerIdentity,
      sellerIdentity: input.session.sellerIdentity,
      buyerVetRef: input.session.buyerVetRef,
      sellerVetRef: input.session.sellerVetRef,
      generatedAt: clock.generatedAt,
    }));
  };
  const policy: DacsFixedPriceX402BuyerAgreementPolicyV1 = {
    buildDraft,
    verifyContribution: agreementVerifier(context.authority, context.peerAuthority),
    reconcileBuyerSignature: absentSignature,
    anchor: createAgreementAnchorProvider(context),
    authorizeAnchored({ operation, retained, result }) {
      const application = captureDacsFixedPriceX402ApplicationV1(retained.application);
      return operation.order.jobId === retained.jobId &&
        operation.order.localBindingHash === retained.localBindingHash &&
        result.agreement.jobId === retained.jobId &&
        result.agreementHash === contentHash(
          result.agreement as unknown as Record<string, unknown>,
        ) &&
        result.agreementRef.anchor.kind === "storage-program" &&
        result.agreementRef.anchor.locator === fixedPriceAgreementLogicalAddress(retained.jobId) &&
        result.agreementRef.contentHash === result.agreementHash &&
        result.agreementRef.signer === context.authority &&
        result.anchorReceipt.writer === context.authority &&
        result.anchorReceipt.contentHash === result.agreementHash &&
        result.agreement.listingRef.listingId === application.listing.listingId &&
        result.agreement.listingRef.version === application.listing.listingVersion &&
        result.agreement.listingRef.contentHash === application.listingContentHash;
    },
  };
  return Object.freeze(policy);
}

export interface DacsFixedPriceX402BuyerCommitmentResultV1 {
  resultVersion: typeof COMMITMENT_RESULT_VERSION;
  role: "buyer";
  jobId: string;
  localBindingHash: string;
  agreementHash: string;
  commitment: Readonly<FinalizedFinalityAgreementCommitment>;
}

function buyerCommitmentResultId(jobId: string): string {
  return sha256Hex(`${BUYER_COMMITMENT_RESULT_DOMAIN}${jobId}`);
}

function captureBuyerCommitmentResult(
  value: unknown,
): Readonly<DacsFixedPriceX402BuyerCommitmentResultV1> {
  if (!plainObject(value) || !exactKeys(value, [
    "resultVersion", "role", "jobId", "localBindingHash", "agreementHash",
    "commitment",
  ]) || value.resultVersion !== COMMITMENT_RESULT_VERSION || value.role !== "buyer" ||
      typeof value.jobId !== "string" || typeof value.localBindingHash !== "string" ||
      !HASH_RE.test(value.localBindingHash) || typeof value.agreementHash !== "string" ||
      !HASH_RE.test(value.agreementHash) || !plainObject(value.commitment)) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-buyer-commitment-corrupt");
  }
  const commitment = value.commitment as unknown as FinalizedAgreementCommitment;
  if (commitment.recordKind !== "finality" ||
      !isFinalityCommitmentRecord(commitment.record) ||
      commitment.record.jobId !== value.jobId ||
      commitment.record.agreementHash !== value.agreementHash ||
      commitment.agreementHash !== value.agreementHash ||
      commitment.logicalAddress !== finalityCommitmentAddress(value.jobId) ||
      commitment.anchorReceipt.logicalAddress !== commitment.logicalAddress ||
      commitment.anchorReceipt.nativeAddress !== commitment.nativeAddress ||
      commitment.anchorReceipt.contentHash !== contentHash(
        commitment.record as unknown as Record<string, unknown>,
      )) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-buyer-commitment-corrupt");
  }
  return deepFreeze(copy(value as unknown as DacsFixedPriceX402BuyerCommitmentResultV1));
}

function retainBuyerCommitmentResult(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  operation: Readonly<FixedPriceX402TrackOperationInput>,
  agreementHash: string,
  commitment: Readonly<FinalizedFinalityAgreementCommitment>,
): Readonly<DacsFixedPriceX402BuyerCommitmentResultV1> {
  if (commitment.recordKind !== "finality") {
    throw new DacsFixedPriceX402ProfileError("fixed-price-current-commitment-required");
  }
  const record: DacsFixedPriceX402BuyerCommitmentResultV1 = {
    resultVersion: COMMITMENT_RESULT_VERSION,
    role: "buyer",
    jobId: operation.order.jobId,
    localBindingHash: operation.order.localBindingHash,
    agreementHash,
    commitment: { ...copy(commitment), resumed: false },
  };
  const id = buyerCommitmentResultId(record.jobId);
  const put = context.database.putEffectIntent({
    kind: "session",
    effectId: id,
    bindingHash: record.localBindingHash,
    input: record,
    idempotencyKey: id,
    jobId: record.jobId,
  });
  if (put.status === "conflict") {
    throw new DacsFixedPriceX402ProfileError("fixed-price-buyer-commitment-conflict");
  }
  return captureBuyerCommitmentResult(context.database.loadEffectInput("session", id));
}

export function loadDacsFixedPriceX402BuyerCommitmentResultV1(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<FixedPriceX402OrderRecord>,
): Readonly<DacsFixedPriceX402BuyerCommitmentResultV1> {
  if (context.role !== "buyer" || order.role !== "buyer") {
    throw new DacsFixedPriceX402ProfileError("fixed-price-buyer-commitment-role-mismatch");
  }
  const value = context.database.loadEffectInput(
    "session",
    buyerCommitmentResultId(order.jobId),
  );
  if (value === undefined) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-buyer-commitment-missing");
  }
  const result = captureBuyerCommitmentResult(value);
  if (result.jobId !== order.jobId || result.localBindingHash !== order.localBindingHash ||
      result.commitment.record.signature.signer !== order.seller ||
      result.commitment.anchorReceipt.writer !== order.seller) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-buyer-commitment-corrupt");
  }
  return result;
}

async function readBuyerCommitment(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  logicalAddress: string,
): Promise<Readonly<
  | { disposition: "present"; anchored: Readonly<AnchoredFinalityCommitment> }
  | { disposition: "absent" }
  | { disposition: "indeterminate"; reason: string }
>> {
  const sellerKey = canonicalDemosAgentPublicKey(context.peerAuthority);
  if (sellerKey === null) {
    return Object.freeze({ disposition: "indeterminate",
      reason: "seller-commitment-authority-invalid" });
  }
  try {
    const resolved = await context.demos.adapter.resolveAnchorByName(
      logicalAddress,
      Buffer.from(sellerKey).toString("hex"),
    );
    if (resolved.status === "absent") return Object.freeze({ disposition: "absent" });
    if (resolved.status !== "present") {
      return Object.freeze({ disposition: "indeterminate", reason: resolved.reason });
    }
    const raw = await context.demos.adapter.readAnchor(resolved.address);
    if (raw === null) {
      return Object.freeze({ disposition: "indeterminate",
        reason: "commitment-native-readback-unavailable" });
    }
    const recordHash = contentHash(raw);
    const receipt = await context.demos.adapter.resolveDemosAnchorReceipt({
      logicalAddress,
      nativeAddress: resolved.address,
      contentHash: recordHash,
      writer: context.peerAuthority,
    });
    if (receipt === null) {
      return Object.freeze({ disposition: "indeterminate",
        reason: "commitment-receipt-unavailable" });
    }
    const anchored: AnchoredFinalityCommitment = {
      record: raw,
      nativeAddress: resolved.address,
      anchorTxRef: {
        kind: "storage-program",
        address: resolved.address,
        writeTxHash: receipt.transactionRef.value,
      },
      anchorReceipt: receipt,
    };
    return Object.freeze({
      disposition: "present",
      anchored: copy(anchored),
    });
  } catch {
    return Object.freeze({ disposition: "indeterminate",
      reason: "commitment-resolution-unavailable" });
  }
}

async function authenticateBuyerCommitment(input: Readonly<{
  context: Readonly<DacsLiveRoleOperationContextV1>;
  operation: Readonly<FixedPriceX402TrackOperationInput>;
  retained: Readonly<DacsLiveOrderInputV1>;
  application: Readonly<DacsFixedPriceX402ApplicationV1>;
  agreement: Readonly<DacsFixedPriceX402BuyerAgreementPublicationV1>;
}>): Promise<Readonly<FinalizedFinalityAgreementCommitment>> {
  const { context, operation, application, agreement } = input;
  if (input.retained.jobId !== operation.order.jobId ||
      input.retained.localBindingHash !== operation.order.localBindingHash ||
      canonicalize(input.retained.application) !== canonicalize(application) ||
      agreement.jobId !== operation.order.jobId ||
      agreement.localBindingHash !== operation.order.localBindingHash ||
      agreement.writer !== context.authority) {
    throw new DacsFixedPriceX402ProfileError(
      "fixed-price-buyer-commitment-binding-invalid",
    );
  }
  const session = loadDacsBuyerSessionAgreementFactsForOrderV1(
    context,
    operation.order,
  );
  const logicalAddress = finalityCommitmentAddress(operation.order.jobId);
  const lookup = await readBuyerCommitment(context, logicalAddress);
  if (lookup.disposition !== "present") {
    throw new DacsLiveEffectInputControlError(
      "pending-retry",
      lookup.disposition === "absent"
        ? "fixed-price-commitment-pending"
        : "fixed-price-commitment-resolution-pending",
    );
  }
  const provider: FinalityCommitmentProvider = {
    resolve: async (requested) => requested === logicalAddress
      ? { disposition: "present", anchored: copy(lookup.anchored) }
      : { disposition: "absent" },
    submit: async () => {
      throw new DacsFixedPriceX402ProfileError("buyer-commitment-write-forbidden");
    },
    async verifyAnchorReceipt(anchored) {
      if (anchored.anchorReceipt.logicalAddress !== logicalAddress ||
          anchored.anchorReceipt.nativeAddress !== anchored.nativeAddress ||
          anchored.anchorReceipt.writer !== context.peerAuthority ||
          anchored.anchorReceipt.contentHash !== contentHash(
            anchored.record as Record<string, unknown>,
          )) return "invalid";
      try {
        return await context.demos.adapter.verifyDemosAnchorReceipt(
          anchored.anchorReceipt,
        ) ? "valid" : "invalid";
      } catch {
        return "error";
      }
    },
  };
  const artifact = agreement.artifact as unknown as
    DurableAnchoredFixedPriceAgreement["agreement"];
  const commitment = await commitFixedPriceAgreement({
    agreement: copy(artifact),
    verifiedListing: {
      disposition: "verified",
      listing: copy(application.listing),
      pin: copy(artifact.listingRef),
    },
    session: {
      jobId: operation.order.jobId,
      listingRef: copy(artifact.listingRef),
      phaseKind: "commit-payee-bound-agreement",
      orchestrator: operation.order.seller,
      buyer: {
        primaryClaim: operation.order.buyer,
        bundleHash: identityBundleHash(session.buyerIdentity),
        vetRecordRef: copy(session.buyerVetRef),
      },
      seller: {
        primaryClaim: operation.order.seller,
        bundleHash: identityBundleHash(session.sellerIdentity),
        vetRecordRef: copy(session.sellerVetRef),
      },
    },
    createdAt: artifact.generatedAt,
    commitmentSigner: {
      signer: operation.order.seller,
      algorithm: "ed25519",
      sign: () => {
        throw new DacsFixedPriceX402ProfileError("buyer-commitment-write-forbidden");
      },
    },
  }, provider, commitmentVerifier(operation.order.buyer, operation.order.seller));
  if (commitment.recordKind !== "finality") {
    throw new DacsFixedPriceX402ProfileError("fixed-price-current-commitment-required");
  }
  return commitment;
}

function tokenDomain(value: unknown): Readonly<{ name: string; version: string }> {
  if (!plainObject(value) || !exactKeys(value, ["name", "version"]) ||
      typeof value.name !== "string" || value.name.length === 0 ||
      value.name.trim() !== value.name || typeof value.version !== "string" ||
      value.version.length === 0 || value.version.trim() !== value.version) {
    throw new TypeError("fixed-price x402 token domain is invalid");
  }
  return Object.freeze({ name: value.name, version: value.version });
}

function paymentPreparation(
  options: Readonly<DacsFixedPriceX402BuyerPaymentPolicyOptionsV1>,
  input: Readonly<{
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
  }>,
  enforceDeadline = true,
): Readonly<DacsX402BuyerRuntimePreparationV1> {
  const { context, rail } = options;
  const application = captureDacsFixedPriceX402ApplicationV1(input.retained.application);
  const publication = context.database.loadEffectInput(
    "artifact-publication",
    agreementPublicationId(fixedPriceAgreementLogicalAddress(input.operation.order.jobId)),
  );
  const agreement = captureAgreementPublication(publication);
  const commitment = loadDacsFixedPriceX402BuyerCommitmentResultV1(
    context,
    input.operation.order,
  );
  const provenance = getAuthenticatedRailProvenance(rail);
  const selected = exactRail(application, input.retained.order);
  const artifact = agreement.artifact as unknown as
    DurableAnchoredFixedPriceAgreement["agreement"];
  const parameters = selected.rail.parameters;
  const phase = application.listing.pipeline[selected.phaseIndex];
  const payout = "payoutBindings" in artifact.terms
    ? artifact.terms.payoutBindings.filter((candidate) =>
        candidate.railId === selected.rail.railId &&
        candidate.phaseIndex === selected.phaseIndex)
    : [];
  const payerClaim = `cci-xm:evm:${rail.asset.kind === "erc20" ? rail.asset.chainId : 0}:` +
    context.evm.address;
  const session = loadDacsBuyerSessionAgreementFactsForOrderV1(
    context,
    input.operation.order,
  );
  let amount: string;
  try {
    amount = rail.asset.kind === "erc20"
      ? baseUnits(artifact.terms.price.amount, rail.asset.decimals) : "0";
  } catch {
    throw new DacsFixedPriceX402ProfileError("fixed-price-payment-amount-invalid");
  }
  if (input.operation.order.jobId !== input.retained.jobId ||
      input.operation.order.localBindingHash !== input.retained.localBindingHash ||
      !isAuthenticatedRailDefinition(rail) || provenance === null ||
      provenance.indexContentHash !== input.operation.order.protocol.rail.registryIndexHash ||
      provenance.definitionContentHash !==
        input.operation.order.protocol.rail.railDefinitionHash ||
      rail.railId !== input.operation.order.protocol.rail.railId ||
      rail.railVersion !== input.operation.order.protocol.rail.railVersion ||
      rail.railType !== "x402" || rail.phaseHandler !== "pay-x402" ||
      rail.availability !== "live" || rail.asset.kind !== "erc20" ||
      input.operation.order.protocol.rail.network !== `eip155:${rail.asset.chainId}` ||
      !plainObject(parameters) || parameters.network !==
        input.operation.order.protocol.rail.network ||
      typeof parameters.payTo !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(parameters.payTo) ||
      parameters.payTo.toLowerCase() !== selected.payeeAddress.toLowerCase() ||
      typeof parameters.asset !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(parameters.asset) ||
      parameters.asset.toLowerCase() !== rail.asset.contract.toLowerCase() ||
      typeof parameters.httpResource !== "string" ||
      rail.network.kind !== "x402-resource" ||
      parameters.httpResource !== rail.network.resourceBaseUrl ||
      phase?.kind !== "pay-x402" || artifact.jobId !== input.operation.order.jobId ||
      agreement.jobId !== input.operation.order.jobId ||
      agreement.localBindingHash !== input.operation.order.localBindingHash ||
      agreement.writer !== context.authority ||
      agreement.logicalAddress !== fixedPriceAgreementLogicalAddress(
        input.operation.order.jobId,
      ) ||
      artifact.listingRef.listingId !== application.listing.listingId ||
      artifact.listingRef.version !== application.listing.listingVersion ||
      artifact.listingRef.contentHash !== application.listingContentHash ||
      artifact.terms.rail === undefined ||
      canonicalize(artifact.terms.rail) !== canonicalize(selected.rail) ||
      artifact.terms.price.currency !== rail.asset.symbol || amount === "0" ||
      !("payoutBindings" in artifact.terms) ||
      artifact.terms.payoutBindings.length !== 1 || payout.length !== 1 ||
      payout[0]!.payeeAddress.toLowerCase() !==
        selected.payeeAddress.toLowerCase() ||
      agreement.agreementHash !== contentHash(
        artifact as unknown as Record<string, unknown>,
      ) || commitment.agreementHash !== agreement.agreementHash ||
      commitment.commitment.record.agreementHash !== agreement.agreementHash ||
      canonicalize(commitment.commitment.record.listingRef) !==
        canonicalize(artifact.listingRef) ||
      !session.buyerIdentity.claims.some((claim) => claim.ref === payerClaim) ||
      context.evm.role !== "buyer" || context.evm.runtime.chainId !== rail.asset.chainId ||
      context.evm.runtime.network !== input.operation.order.protocol.rail.network ||
      (enforceDeadline && context.database.readTime() > artifact.terms.deadline)) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-payment-authority-invalid");
  }
  try {
    const resource = new URL(parameters.httpResource);
    if (resource.protocol !== "https:" || resource.username || resource.password ||
        resource.hash) throw new Error();
  } catch {
    throw new DacsFixedPriceX402ProfileError("fixed-price-payment-resource-invalid");
  }
  const expectedRequirements: X402BuyerPaymentRequirements = {
    scheme: "exact",
    network: input.operation.order.protocol.rail.network,
    amount,
    asset: rail.asset.contract,
    payTo: selected.payeeAddress,
    maxTimeoutSeconds: options.maxTimeoutSeconds,
    extra: {
      name: options.tokenDomain.name,
      version: options.tokenDomain.version,
    },
  };
  const httpResource = dacsFixedPriceX402DeliveryResourceV1(
    parameters.httpResource,
    input.operation.order.jobId,
  );
  return deepFreeze(copy({
    authority: {
      jobId: input.operation.order.jobId,
      phaseIndex: selected.phaseIndex,
      railId: selected.rail.railId,
      railVersion: String(selected.rail.railVersion),
      railDescriptorHash: input.operation.order.protocol.rail.railDefinitionHash,
      agreementHash: agreement.agreementHash,
      termsHash: sha256Hex(canonicalize(artifact.terms)),
      sessionBindingHash: sha256Hex(canonicalize({
        jobId: input.operation.order.jobId,
        payer: context.evm.address,
        commitment: commitment.commitment.logicalAddress,
      })),
      network: input.operation.order.protocol.rail.network,
      payer: context.evm.address,
      payee: selected.payeeAddress,
      asset: rail.asset.contract,
      amount,
      httpResource,
      method: "GET",
    },
    expectedRequirements,
  }));
}

function intentMatchesPreparation(
  intent: Readonly<X402BuyerSettlementIntent>,
  preparation: Readonly<DacsX402BuyerRuntimePreparationV1>,
): boolean {
  const authority = preparation.authority;
  return [
    "jobId", "phaseIndex", "railId", "railVersion", "railDescriptorHash",
    "agreementHash", "termsHash", "sessionBindingHash", "network", "amount",
    "httpResource", "method",
  ].every((key) => canonicalize((intent as unknown as Record<string, unknown>)[key]) ===
      canonicalize((authority as unknown as Record<string, unknown>)[key])) &&
    intent.payer.toLowerCase() === authority.payer.toLowerCase() &&
    intent.payee.toLowerCase() === authority.payee.toLowerCase() &&
    intent.asset.toLowerCase() === authority.asset.toLowerCase() &&
    intent.chosenRequirements.scheme === preparation.expectedRequirements.scheme &&
    intent.chosenRequirements.network === preparation.expectedRequirements.network &&
    intent.chosenRequirements.amount === preparation.expectedRequirements.amount &&
    intent.chosenRequirements.asset.toLowerCase() ===
      preparation.expectedRequirements.asset.toLowerCase() &&
    intent.chosenRequirements.payTo.toLowerCase() ===
      preparation.expectedRequirements.payTo.toLowerCase() &&
    intent.chosenRequirements.maxTimeoutSeconds ===
      preparation.expectedRequirements.maxTimeoutSeconds &&
    canonicalize(intent.chosenRequirements.extra) ===
      canonicalize(preparation.expectedRequirements.extra);
}

function authorizationWithinAgreement(
  options: Readonly<DacsFixedPriceX402BuyerPaymentPolicyOptionsV1>,
  order: Readonly<FixedPriceX402OrderRecord>,
  intent: Readonly<X402BuyerSettlementIntent>,
  authorization: Readonly<Parameters<X402BuyerEvmIntentAuthority>[0]["authorization"]>,
): boolean {
  const value = options.context.database.loadEffectInput(
    "artifact-publication",
    agreementPublicationId(fixedPriceAgreementLogicalAddress(order.jobId)),
  );
  const publication = captureAgreementPublication(value);
  const artifact = publication.artifact as unknown as
    DurableAnchoredFixedPriceAgreement["agreement"];
  const evm = options.context.evm;
  if (evm.role !== "buyer") return false;
  if (!/^(0|[1-9][0-9]*)$/.test(authorization.validAfter) ||
      !/^[1-9][0-9]*$/.test(authorization.validBefore)) return false;
  const deadline = BigInt(artifact.terms.deadline);
  return authorization.from.toLowerCase() === intent.payer.toLowerCase() &&
    authorization.to.toLowerCase() === intent.payee.toLowerCase() &&
    authorization.value === intent.amount &&
    authorization.domain.name === options.tokenDomain.name &&
    authorization.domain.version === options.tokenDomain.version &&
    authorization.domain.chainId === evm.runtime.chainId &&
    authorization.domain.verifyingContract.toLowerCase() === intent.asset.toLowerCase() &&
    BigInt(authorization.validAfter) * 1_000n < deadline &&
    BigInt(authorization.validBefore) * 1_000n <= deadline;
}

export function createDacsFixedPriceX402BuyerPaymentPolicyV1(
  rawOptions: Readonly<DacsFixedPriceX402BuyerPaymentPolicyOptionsV1>,
): Readonly<DacsFixedPriceX402BuyerPaymentPolicyV1> {
  if (!plainObject(rawOptions) || !plainObject(rawOptions.context) ||
      rawOptions.context.role !== "buyer" ||
      !isAuthenticatedRailDefinition(rawOptions.rail) ||
      !Number.isSafeInteger(rawOptions.maxTimeoutSeconds) ||
      rawOptions.maxTimeoutSeconds <= 0 || rawOptions.maxTimeoutSeconds > 86_400) {
    throw new TypeError("fixed-price buyer payment policy options are invalid");
  }
  const options = Object.freeze({
    ...rawOptions,
    tokenDomain: tokenDomain(rawOptions.tokenDomain),
  });
  const context = options.context;
  const policy: DacsFixedPriceX402BuyerPaymentPolicyV1 = {
    async resolvePreparation(input) {
      try {
        loadDacsFixedPriceX402BuyerCommitmentResultV1(context, input.operation.order);
      } catch (error) {
        if (!(error instanceof DacsFixedPriceX402ProfileError) ||
            error.reasonCode !== "fixed-price-buyer-commitment-missing") {
          throw new DacsLiveEffectInputControlError(
            "operator-action",
            "fixed-price-commitment-retention-invalid",
          );
        }
        let application: Readonly<DacsFixedPriceX402ApplicationV1>;
        let agreement: Readonly<DacsFixedPriceX402BuyerAgreementPublicationV1>;
        try {
          application = captureDacsFixedPriceX402ApplicationV1(
            input.retained.application,
          );
          agreement = await loadDacsFixedPriceX402BuyerAgreementPublicationV1(
            context,
            input.operation.order,
          );
        } catch {
          throw new DacsLiveEffectInputControlError(
            "operator-action",
            "fixed-price-agreement-authority-invalid",
          );
        }
        let commitment: Readonly<FinalizedFinalityAgreementCommitment>;
        try {
          commitment = await authenticateBuyerCommitment({
            context,
            operation: input.operation,
            retained: input.retained,
            application,
            agreement,
          });
        } catch (cause) {
          if (cause instanceof DacsLiveEffectInputControlError) throw cause;
          throw new DacsLiveEffectInputControlError(
            "operator-action",
            "fixed-price-commitment-invalid",
          );
        }
        retainBuyerCommitmentResult(
          context,
          input.operation,
          agreement.agreementHash,
          commitment,
        );
      }
      try {
        return paymentPreparation(options, input);
      } catch (cause) {
        if (cause instanceof DacsLiveEffectInputControlError) throw cause;
        throw new DacsLiveEffectInputControlError(
          "operator-action",
          "fixed-price-payment-authority-invalid",
        );
      }
    },
    async authorizeIntent({ intent, authorization }) {
      try {
        const order = await buyerOrderRecord(context, intent.jobId);
        const orderInput = createDacsFixedPriceX402RoleOrderV1({
          role: "buyer",
          jobId: order.jobId,
          buyer: order.buyer,
          seller: order.seller,
          protocol: order.protocol,
        });
        const retained = loadDacsLiveOrderInputV1({
          database: context.database,
          order: orderInput,
        });
        if (retained === undefined) throw new Error();
        const preparation = paymentPreparation(options, {
          operation: { order } as FixedPriceX402TrackOperationInput,
          retained,
        }, false);
        return intentMatchesPreparation(intent, preparation) &&
          authorizationWithinAgreement(options, order, intent, authorization)
          ? { disposition: "authorized" as const, bindingHash: intent.bindingHash }
          : { disposition: "rejected" as const, reason: "payment-authority-mismatch" };
      } catch (cause) {
        return { disposition: "indeterminate" as const,
          reason: cause instanceof DacsFixedPriceX402ProfileError
            ? cause.reasonCode : "payment-authority-unavailable" };
      }
    },
    authorizePreparedIntent({ operation, retained, intent }) {
      try {
        return intentMatchesPreparation(
          intent,
          paymentPreparation(options, { operation, retained }),
        );
      } catch {
        return false;
      }
    },
  };
  return Object.freeze(policy);
}

function sellerClockSkew(value: unknown): number {
  const captured = value ?? DEFAULT_MAXIMUM_CLOCK_SKEW_MS;
  if (!Number.isSafeInteger(captured) || Number(captured) < 0 ||
      Number(captured) > 600_000) {
    throw new TypeError("fixed-price seller agreement clock skew is invalid");
  }
  return Number(captured);
}

interface CommitmentClockRecordV1 {
  clockVersion: typeof COMMITMENT_CLOCK_VERSION;
  role: "seller";
  jobId: string;
  localBindingHash: string;
  createdAt: number;
}

interface CommitmentPublicationRecordV1 {
  publicationVersion: typeof COMMITMENT_PUBLICATION_VERSION;
  jobId: string;
  localBindingHash: string;
  writer: string;
  logicalAddress: string;
  commitmentHash: string;
  record: Readonly<FinalityCommitmentRecord>;
}

export interface DacsFixedPriceX402CommitmentResultV1 {
  resultVersion: typeof COMMITMENT_RESULT_VERSION;
  jobId: string;
  localBindingHash: string;
  agreement: Readonly<DurableAnchoredFixedPriceAgreement["agreement"]>;
  commitment: Readonly<FinalizedAgreementCommitment>;
}

function commitmentClockId(jobId: string): string {
  return sha256Hex(`${COMMITMENT_CLOCK_DOMAIN}${jobId}`);
}

function commitmentPublicationId(logicalAddress: string): string {
  return sha256Hex(`${COMMITMENT_PUBLICATION_DOMAIN}${logicalAddress}`);
}

function commitmentResultId(jobId: string): string {
  return sha256Hex(`${COMMITMENT_RESULT_DOMAIN}${jobId}`);
}

function retainCommitmentClock(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  operation: Readonly<FixedPriceX402TrackOperationInput>,
): Readonly<CommitmentClockRecordV1> {
  const id = commitmentClockId(operation.order.jobId);
  const existing = context.database.loadEffectInput("session", id);
  if (existing !== undefined) {
    if (!plainObject(existing) || !exactKeys(existing, [
      "clockVersion", "role", "jobId", "localBindingHash", "createdAt",
    ]) || existing.clockVersion !== COMMITMENT_CLOCK_VERSION ||
        existing.role !== "seller" || existing.jobId !== operation.order.jobId ||
        existing.localBindingHash !== operation.order.localBindingHash ||
        !Number.isSafeInteger(existing.createdAt) || Number(existing.createdAt) < 0) {
      throw new DacsFixedPriceX402ProfileError("fixed-price-commitment-clock-corrupt");
    }
    return Object.freeze(existing as unknown as CommitmentClockRecordV1);
  }
  const record: CommitmentClockRecordV1 = {
    clockVersion: COMMITMENT_CLOCK_VERSION,
    role: "seller",
    jobId: operation.order.jobId,
    localBindingHash: operation.order.localBindingHash,
    createdAt: context.database.readTime(),
  };
  const put = context.database.putEffectIntent({
    kind: "session",
    effectId: id,
    bindingHash: record.localBindingHash,
    input: record,
    idempotencyKey: id,
    jobId: record.jobId,
  });
  if (put.status === "conflict") {
    throw new DacsFixedPriceX402ProfileError("fixed-price-commitment-clock-conflict");
  }
  return retainCommitmentClock(context, operation);
}

function captureCommitmentPublication(
  value: unknown,
): Readonly<CommitmentPublicationRecordV1> {
  if (!plainObject(value) || !exactKeys(value, [
    "publicationVersion", "jobId", "localBindingHash", "writer",
    "logicalAddress", "commitmentHash", "record",
  ]) || value.publicationVersion !== COMMITMENT_PUBLICATION_VERSION ||
      typeof value.jobId !== "string" || typeof value.localBindingHash !== "string" ||
      !HASH_RE.test(value.localBindingHash) || typeof value.writer !== "string" ||
      typeof value.logicalAddress !== "string" || typeof value.commitmentHash !== "string" ||
      !HASH_RE.test(value.commitmentHash) || !isFinalityCommitmentRecord(value.record) ||
      value.record.jobId !== value.jobId ||
      finalityCommitmentAddress(value.jobId) !== value.logicalAddress ||
      contentHash(value.record as unknown as Record<string, unknown>) !==
        value.commitmentHash) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-commitment-publication-corrupt");
  }
  return deepFreeze(copy(value as unknown as CommitmentPublicationRecordV1));
}

function verifyDemosComponent(
  expected: string,
  algorithm: string,
  value: string,
  signedBytes: Uint8Array,
): "valid" | "invalid" | "error" {
  if (algorithm !== "ed25519" || !isCanonicalBase64Url(value)) return "invalid";
  const signature = Buffer.from(value, "base64url");
  const publicKey = canonicalDemosAgentPublicKey(expected);
  if (signature.byteLength !== 64 || signature.toString("base64url") !== value ||
      publicKey === null) return "invalid";
  try {
    return ed25519Verify(signedBytes, Uint8Array.from(signature), publicKeyFromRaw(publicKey))
      ? "valid" : "invalid";
  } catch {
    return "error";
  }
}

function commitmentVerifier(buyer: string, seller: string): CommitmentSignatureVerifier {
  return ({ signer, algorithm, value, signedBytes }) => {
    if (signer !== buyer && signer !== seller) return "invalid";
    return verifyDemosComponent(signer, algorithm, value, signedBytes);
  };
}

function createCommitmentProvider(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  operation: Readonly<FixedPriceX402TrackOperationInput>,
): Readonly<FinalityCommitmentProvider> {
  async function load(logicalAddress: string): Promise<
    Readonly<CommitmentPublicationRecordV1> | undefined
  > {
    const value = context.database.loadEffectInput(
      "artifact-publication",
      commitmentPublicationId(logicalAddress),
    );
    if (value === undefined) return undefined;
    const record = captureCommitmentPublication(value);
    if (record.jobId !== operation.order.jobId ||
        record.localBindingHash !== operation.order.localBindingHash ||
        record.writer !== context.authority || record.logicalAddress !== logicalAddress) {
      throw new DacsFixedPriceX402ProfileError("fixed-price-commitment-publication-conflict");
    }
    return record;
  }

  async function publish(
    retained: Readonly<CommitmentPublicationRecordV1>,
  ): Promise<Readonly<AnchoredFinalityCommitment>> {
    const anchor = await context.demos.adapter.anchorWriteOnce(
      retained.logicalAddress,
      retained.record as unknown as Record<string, unknown>,
      { metadata: {
        logicalAddress: retained.logicalAddress,
        contentHash: retained.commitmentHash,
        envelopeHash: sha256Hex(canonicalize(retained.record)),
      } },
    );
    const receipt = anchor.demosEvidence === undefined
      ? await context.demos.adapter.resolveDemosAnchorReceipt({
          logicalAddress: retained.logicalAddress,
          nativeAddress: anchor.address,
          contentHash: retained.commitmentHash,
          writer: retained.writer,
        })
      : demosWriteEvidenceToAnchorReceipt({
          evidence: anchor.demosEvidence,
          logicalAddress: retained.logicalAddress,
          contentHash: retained.commitmentHash,
          writer: retained.writer,
        });
    if (receipt === null || !isReadableAnchorReceipt(receipt) ||
        receipt.logicalAddress !== retained.logicalAddress ||
        receipt.contentHash !== retained.commitmentHash ||
        receipt.writer !== retained.writer || receipt.observationDisposition !== "established" ||
        (receipt.state !== "included" && receipt.state !== "finalized")) {
      throw new DacsFixedPriceX402ProfileError("fixed-price-commitment-receipt-pending");
    }
    const readback = await context.demos.adapter.readAnchor(receipt.nativeAddress);
    if (readback === null || !isFinalityCommitmentRecord(readback) ||
        canonicalize(readback) !== canonicalize(retained.record) ||
        contentHash(readback) !== retained.commitmentHash) {
      throw new DacsFixedPriceX402ProfileError("fixed-price-commitment-readback-pending");
    }
    return copy({
      record: readback,
      nativeAddress: receipt.nativeAddress,
      anchorTxRef: {
        kind: "storage-program",
        address: receipt.nativeAddress,
        writeTxHash: receipt.transactionRef.value,
      },
      anchorReceipt: receipt,
    });
  }

  const provider: FinalityCommitmentProvider = {
    async resolve(logicalAddress) {
      try {
        const retained = await load(logicalAddress);
        return retained === undefined
          ? { disposition: "absent" as const }
          : { disposition: "present" as const,
              anchored: await publish(retained) };
      } catch {
        return { disposition: "indeterminate" as const,
          reason: "commitment publication reconciliation is unavailable" };
      }
    },
    async submit(logicalAddress, record) {
      if (logicalAddress !== finalityCommitmentAddress(operation.order.jobId) ||
          record.jobId !== operation.order.jobId ||
          record.signature.signer !== context.authority) {
        throw new DacsFixedPriceX402ProfileError("fixed-price-commitment-submission-invalid");
      }
      const retained: CommitmentPublicationRecordV1 = {
        publicationVersion: COMMITMENT_PUBLICATION_VERSION,
        jobId: operation.order.jobId,
        localBindingHash: operation.order.localBindingHash,
        writer: context.authority,
        logicalAddress,
        commitmentHash: contentHash(record as unknown as Record<string, unknown>),
        record,
      };
      const effectId = commitmentPublicationId(logicalAddress);
      const put = context.database.putEffectIntent({
        kind: "artifact-publication",
        effectId,
        bindingHash: retained.localBindingHash,
        input: retained,
        idempotencyKey: effectId,
        jobId: retained.jobId,
      });
      if (put.status === "conflict") {
        throw new DacsFixedPriceX402ProfileError(
          "fixed-price-commitment-publication-conflict",
        );
      }
      return publish(captureCommitmentPublication(context.database.loadEffectInput(
        "artifact-publication", effectId,
      )));
    },
    async verifyAnchorReceipt(anchored) {
      if (!isFinalityCommitmentRecord(anchored.record) ||
          anchored.record.jobId !== operation.order.jobId ||
          anchored.record.signature.signer !== context.authority ||
          anchored.anchorReceipt.writer !== context.authority ||
          anchored.anchorReceipt.logicalAddress !==
            finalityCommitmentAddress(operation.order.jobId) ||
          anchored.anchorReceipt.contentHash !== contentHash(
            anchored.record as unknown as Record<string, unknown>,
          ) || anchored.anchorReceipt.nativeAddress !== anchored.nativeAddress) {
        return "invalid";
      }
      try {
        if (await context.demos.adapter.verifyDemosAnchorReceipt(
          anchored.anchorReceipt,
        ) !== true) return "invalid";
        const readback = await context.demos.adapter.readAnchor(anchored.nativeAddress);
        return readback !== null && isFinalityCommitmentRecord(readback) &&
          canonicalize(readback) === canonicalize(anchored.record)
          ? "valid" : "indeterminate";
      } catch {
        return "error";
      }
    },
  };
  return Object.freeze(provider);
}

function captureCommitmentResult(
  value: unknown,
): Readonly<DacsFixedPriceX402CommitmentResultV1> {
  if (!plainObject(value) || !exactKeys(value, [
    "resultVersion", "jobId", "localBindingHash", "agreement", "commitment",
  ]) || value.resultVersion !== COMMITMENT_RESULT_VERSION ||
      typeof value.jobId !== "string" || typeof value.localBindingHash !== "string" ||
      !HASH_RE.test(value.localBindingHash) || !isAgreementArtifact(value.agreement) ||
      !plainObject(value.commitment)) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-commitment-result-corrupt");
  }
  const commitment = value.commitment as unknown as FinalizedAgreementCommitment;
  if (value.agreement.jobId !== value.jobId || commitment.recordKind !== "finality" ||
      commitment.record.jobId !== value.jobId ||
      commitment.agreementHash !== contentHash(
        value.agreement as unknown as Record<string, unknown>,
      ) || commitment.anchorReceipt.logicalAddress !== commitment.logicalAddress ||
      commitment.anchorReceipt.nativeAddress !== commitment.nativeAddress) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-commitment-result-corrupt");
  }
  return deepFreeze(copy(value as unknown as DacsFixedPriceX402CommitmentResultV1));
}

function retainCommitmentResult(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  operation: Readonly<FixedPriceX402TrackOperationInput>,
  agreement: Readonly<DurableAnchoredFixedPriceAgreement["agreement"]>,
  commitment: Readonly<FinalizedAgreementCommitment>,
): Readonly<DacsFixedPriceX402CommitmentResultV1> {
  if (commitment.recordKind !== "finality") {
    throw new DacsFixedPriceX402ProfileError("fixed-price-commitment-kind-invalid");
  }
  const result: DacsFixedPriceX402CommitmentResultV1 = {
    resultVersion: COMMITMENT_RESULT_VERSION,
    jobId: operation.order.jobId,
    localBindingHash: operation.order.localBindingHash,
    agreement,
    // `resumed` describes this invocation, not the immutable commitment.
    // Normalize it so recovery reuses the same retained authority record.
    commitment: { ...copy(commitment), resumed: false },
  };
  const id = commitmentResultId(result.jobId);
  const put = context.database.putEffectIntent({
    kind: "session",
    effectId: id,
    bindingHash: result.localBindingHash,
    input: result,
    idempotencyKey: id,
    jobId: result.jobId,
  });
  if (put.status === "conflict") {
    throw new DacsFixedPriceX402ProfileError("fixed-price-commitment-result-conflict");
  }
  return captureCommitmentResult(context.database.loadEffectInput("session", id));
}

export function loadDacsFixedPriceX402CommitmentResultV1(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<FixedPriceX402OrderRecord>,
): Readonly<DacsFixedPriceX402CommitmentResultV1> {
  if (context.role !== "seller" || order.role !== "seller") {
    throw new DacsFixedPriceX402ProfileError("fixed-price-commitment-role-mismatch");
  }
  const value = context.database.loadEffectInput("session", commitmentResultId(order.jobId));
  if (value === undefined) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-commitment-result-missing");
  }
  const result = captureCommitmentResult(value);
  if (result.jobId !== order.jobId || result.localBindingHash !== order.localBindingHash) {
    throw new DacsFixedPriceX402ProfileError("fixed-price-commitment-result-corrupt");
  }
  return result;
}

export function createDacsFixedPriceX402SellerAgreementPolicyV1(
  options: Readonly<DacsFixedPriceX402SellerAgreementPolicyOptionsV1>,
): Readonly<DacsFixedPriceX402SellerAgreementPolicyV1> {
  if (!plainObject(options) || !plainObject(options.context) ||
      options.context.role !== "seller") {
    throw new TypeError("fixed-price seller agreement policy options are invalid");
  }
  const context = options.context;
  const maximumClockSkewMs = sellerClockSkew(options.maximumClockSkewMs);
  const policy: DacsFixedPriceX402SellerAgreementPolicyV1 = {
    resolveAuthenticatedAgreementContext(input) {
      try {
        const admission = loadDacsFixedPriceX402SellerAdmissionV1(
          context,
          input.operation.order,
        );
        const application = captureDacsFixedPriceX402ApplicationV1(
          input.retained.application,
        );
        const generatedAt = input.candidateDraft.generatedAt;
        const now = context.database.readTime();
        if (input.queryVersion !== "1" || input.jobId !== input.operation.order.jobId ||
            input.jobId !== input.retained.jobId || input.buyer !== input.operation.order.buyer ||
            input.seller !== input.operation.order.seller ||
            input.operation.order.localBindingHash !== input.retained.localBindingHash ||
            canonicalize(application) !== canonicalize(admission.application) ||
            input.listingPin.listingId !== application.listing.listingId ||
            input.listingPin.version !== application.listing.listingVersion ||
            input.listingPin.contentHash !== application.listingContentHash ||
            input.session.jobId !== input.jobId ||
            input.session.localBindingHash !== input.retained.localBindingHash ||
            input.session.buyerRequirementHash !== sha256Hex(canonicalize(
              application.listing.buyerRequirement,
            )) || input.sellerRequirement.required.length !== 0 ||
            sha256Hex(canonicalize(input.sellerRequirement)) !== sha256Hex(canonicalize(
              DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1,
            )) || !Number.isSafeInteger(generatedAt) || generatedAt < 0 ||
            generatedAt < application.listing.validity.notBefore ||
            (application.listing.validity.notAfter !== undefined &&
              generatedAt > application.listing.validity.notAfter) ||
            generatedAt + maximumClockSkewMs < admission.admittedAt ||
            generatedAt > now + maximumClockSkewMs ||
            input.sellerVet.recordRef.contentHash !== contentHash(
              input.sellerVet.record as unknown as Record<string, unknown>,
            ) || input.sellerVet.recordRef.signer !== input.operation.order.buyer) {
          return { disposition: "rejected" as const,
            reason: "seller-local agreement context does not match admitted session" };
        }
        const value = buildAgreementInput({
          application,
          order: input.retained.order,
          buyerIdentity: input.session.buyerIdentity,
          sellerIdentity: input.session.sellerIdentity,
          buyerVetRef: input.session.buyerVetRef,
          sellerVetRef: input.sellerVet.recordRef,
          generatedAt,
        });
        return { disposition: "present" as const, value };
      } catch {
        return { disposition: "indeterminate" as const,
          reason: "seller-local agreement context is unavailable" };
      }
    },
    verifyContribution: agreementVerifier(context.peerAuthority, context.authority),
    reconcileSellerSignature: absentSignature,
    async authorizeComplete({ operation, retained, proposal, result }) {
      if (operation.order.jobId !== retained.jobId ||
          operation.order.localBindingHash !== retained.localBindingHash ||
          result.transportIdentity.jobId !== retained.jobId ||
          result.transportIdentity.buyer !== context.peerAuthority ||
          result.transportIdentity.seller !== context.authority ||
          result.sellerContribution.role !== "seller" ||
          result.sellerContribution.party !== context.authority ||
          result.sellerContribution.planHash !== result.transportIdentity.planHash ||
          proposal.proposalHash !== result.transportIdentity.proposalHash ||
          proposal.plan.planHash !== result.transportIdentity.planHash ||
          proposal.plan.agreementHash !== result.transportIdentity.agreementHash) return false;
      try {
        const application = captureDacsFixedPriceX402ApplicationV1(retained.application);
        const admission = loadDacsFixedPriceX402SellerAdmissionV1(
          context,
          operation.order,
        );
        if (canonicalize(application) !== canonicalize(admission.application)) return false;
        const agreement = await finalizeFixedPriceAgreementContributions(
          proposal.plan,
          [proposal.buyerContribution, result.sellerContribution],
          agreementVerifier(context.peerAuthority, context.authority),
        );
        if (agreement.jobId !== retained.jobId ||
            contentHash(agreement as unknown as Record<string, unknown>) !==
              result.transportIdentity.agreementHash) return false;
        const buyer = agreement.parties.find((party) => party.role === "buyer");
        const seller = agreement.parties.find((party) => party.role === "seller");
        if (buyer === undefined || seller === undefined ||
            buyer.primaryClaim !== context.peerAuthority ||
            seller.primaryClaim !== context.authority) return false;
        const clock = retainCommitmentClock(context, operation);
        await operation.fence.assertCurrent();
        const commitment = await commitFixedPriceAgreement({
          agreement: copy(agreement),
          verifiedListing: {
            disposition: "verified",
            listing: copy(application.listing),
            pin: {
              listingId: application.listing.listingId,
              version: application.listing.listingVersion,
              contentHash: application.listingContentHash,
            },
          },
          session: {
            jobId: retained.jobId,
            listingRef: {
              listingId: application.listing.listingId,
              version: application.listing.listingVersion,
              contentHash: application.listingContentHash,
            },
            phaseKind: "commit-payee-bound-agreement",
            orchestrator: context.authority,
            buyer: {
              primaryClaim: buyer.primaryClaim,
              bundleHash: buyer.bundleHash,
              vetRecordRef: copy(buyer.vetRecordRef),
            },
            seller: {
              primaryClaim: seller.primaryClaim,
              bundleHash: seller.bundleHash,
              vetRecordRef: copy(seller.vetRecordRef),
            },
          },
          createdAt: clock.createdAt,
          commitmentSigner: {
            algorithm: "ed25519",
            signer: context.authority,
            sign: (bytes, signatureContext) => context.demos.signComponent(
              bytes,
              signatureContext,
            ),
          },
        }, createCommitmentProvider(context, operation),
        commitmentVerifier(context.peerAuthority, context.authority));
        await operation.fence.assertCurrent();
        retainCommitmentResult(context, operation, agreement, commitment);
        return true;
      } catch (error) {
        const category = faultCategory(error);
        return category === "transient" || category === "substrate"
          ? { status: "pending-retry" as const,
              reasonCode: "seller-commitment-pending" }
          : { status: "operator-action" as const,
              reasonCode: "seller-commitment-invalid" };
      }
    },
  };
  return Object.freeze(policy);
}
