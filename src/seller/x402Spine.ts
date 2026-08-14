import { isDeepStrictEqual } from "node:util";

import type { ListingRef } from "../artifacts/types.js";
import {
  runDurableFulfilmentCore,
  type DurableSellerFulfilmentDeps,
  type SellerFulfilmentDurability,
} from "../agent/runDurableFulfilmentCore.js";
import type { FencedSessionStoreV2 } from "../agent/fencedSessionStore.js";
import type {
  SellerFulfilmentResult,
  SellerVerificationResult,
} from "../agent/runFulfilmentCore.js";
import { canonicalize, sha256Hex } from "../canonical/index.js";
import { x402PaywallSettlementKey } from "../rails/x402Paywall.js";
import type {
  X402PaywallAuthorizationContext,
  X402PaywallCoreDeps,
  X402PaywallExpectedTerms,
  X402PaywallFulfilment,
  X402PaywallFulfilmentContext,
  X402PaywallHandlers,
  X402PaywallHttpAdapter,
  X402PaywallPaymentPayload,
  X402PaywallPaymentRequirements,
  X402PaywallPreSettlementAuthorization,
  X402PaywallPreSettlementContext,
  X402PaywallSettlementStore,
} from "../rails/x402Paywall.js";
import {
  isSellerFulfilmentHandoff,
  isValidSellerReceiptClaim,
  verifySellerPaymentIntake,
  type SellerFulfilmentReceiptStore,
  type SellerPaymentAuthorization,
  type SellerPaymentIntakeDeps,
  type SellerPaymentIntakeResult,
} from "./paymentIntake.js";
import { verifyX402ReceiptClaim } from "./x402Receipt.js";

const HASH_RE = /^[0-9a-f]{64}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const INTEGER_RE = /^(0|[1-9][0-9]*)$/;

/**
 * Authenticated, pre-settlement DACS scope retained by the x402 WAL.
 *
 * A resolver may return `verified` only after authenticating the finalized
 * commitment, both Agreement party signatures, the historical Listing and
 * rail-registry snapshot, the payer/payee bindings, and these exact x402
 * terms. This is deliberately a strict versioned plain object: it is durable
 * authority, not application metadata.
 */
export interface X402SellerCommittedSessionScope {
  scopeVersion: "1";
  jobId: string;
  paymentPhaseIndex: number;
  deliveryPhaseIndex: number;
  payer: string;
  payerPayingKey: string;
  httpResource: string;
  railId: string;
  railRegistryVersion: number;
  agreementRef: string;
  agreementHash: string;
  listingRef: ListingRef;
  commitmentRef: string;
  commitmentContentHash: string;
  commitmentFinalizedAt: number;
  expected: X402PaywallExpectedTerms;
}

export type X402SellerCommittedSessionResolution =
  | { disposition: "verified"; session: X402SellerCommittedSessionScope }
  | { disposition: "rejected" | "indeterminate"; reason: string };

/** Opaque post-settlement authority passed from #119 into #120/#121. */
export interface X402SellerPaymentPermitAuthorization {
  authorizationVersion: "1";
  sessionAuthorization: X402SellerCommittedSessionScope;
  paymentPermitId: string;
  paymentAuthorization: SellerPaymentAuthorization;
}

type CompletedSellerFulfilment = Extract<SellerFulfilmentResult, { decision: "completed" }>;

export interface X402SellerResponseContext {
  jobId: string;
  paymentPhaseIndex: number;
  deliveryPhaseIndex: number;
  payer: string;
  authorization: X402SellerPaymentPermitAuthorization;
  fulfilment: CompletedSellerFulfilment;
}

export interface X402SellerRenderedResponse<T = unknown> {
  status?: number;
  headers?: Record<string, string>;
  body?: T;
}

export interface X402SellerSpineOptions<T = unknown> {
  settlementStore: X402PaywallSettlementStore;
  reconcileSettlement: X402PaywallCoreDeps<
    X402SellerPaymentPermitAuthorization,
    T
  >["reconcileSettlement"];
  /** One authority shared by #119 permit creation and #120 permit consumption. */
  receiptStore: SellerFulfilmentReceiptStore;
  /**
   * Resolve authenticated, immutable session state before the facilitator may
   * move value. Live Listing reconstruction is not sufficient.
   */
  resolveCommittedSession(
    context: Readonly<X402PaywallPreSettlementContext>,
  ): Promise<X402SellerCommittedSessionResolution>;
  paymentIntakeDeps: Omit<SellerPaymentIntakeDeps, "receiptStore">;
  fulfilmentDeps: Omit<DurableSellerFulfilmentDeps, "receiptStore">;
  fulfilmentDurability: SellerFulfilmentDurability;
  /** Render transport output only after durable fulfilment completed. */
  renderResponse(
    context: Readonly<X402SellerResponseContext>,
  ): Promise<X402SellerRenderedResponse<T>> | X402SellerRenderedResponse<T>;
}

export type X402SellerSpine<T = unknown> = X402PaywallHandlers<
  X402SellerPaymentPermitAuthorization,
  T
> & Pick<
  X402PaywallCoreDeps<X402SellerPaymentPermitAuthorization, T>,
  "authorizeSettlement"
>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isNonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;

const isSafeUint = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 &&
  !Object.is(value, -0);

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function hasRequiredKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function validNetwork(value: unknown): value is `eip155:${string}` {
  if (typeof value !== "string") return false;
  const match = /^eip155:([1-9][0-9]*)$/.exec(value);
  if (!match) return false;
  const chainId = Number(match[1]);
  return Number.isSafeInteger(chainId) && chainId > 0;
}

function validExpectedTerms(value: unknown): value is X402PaywallExpectedTerms {
  if (!isRecord(value) || !hasExactKeys(value, [
    "network", "payTo", "amount", "asset", "eip712",
  ]) || !validNetwork(value.network) || typeof value.payTo !== "string" ||
      !EVM_ADDRESS_RE.test(value.payTo) || typeof value.asset !== "string" ||
      !EVM_ADDRESS_RE.test(value.asset) || typeof value.amount !== "string" ||
      !INTEGER_RE.test(value.amount) || value.amount === "0" || !isRecord(value.eip712) ||
      !hasExactKeys(value.eip712, ["name", "version"]) ||
      !isNonEmpty(value.eip712.name) || !isNonEmpty(value.eip712.version)) return false;
  try {
    return BigInt(value.amount) > 0n;
  } catch {
    return false;
  }
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameExpectedTerms(
  left: X402PaywallExpectedTerms,
  right: X402PaywallExpectedTerms,
): boolean {
  return left.network === right.network && sameAddress(left.payTo, right.payTo) &&
    left.amount === right.amount && sameAddress(left.asset, right.asset) &&
    left.eip712.name === right.eip712.name &&
    left.eip712.version === right.eip712.version;
}

function requirementsMatch(
  requirements: unknown,
  expected: X402PaywallExpectedTerms,
): requirements is X402PaywallPaymentRequirements {
  return isRecord(requirements) && isRecord(requirements.extra) &&
    requirements.scheme === "exact" && requirements.network === expected.network &&
    typeof requirements.payTo === "string" && EVM_ADDRESS_RE.test(requirements.payTo) &&
    sameAddress(requirements.payTo, expected.payTo) &&
    requirements.amount === expected.amount && typeof requirements.asset === "string" &&
    EVM_ADDRESS_RE.test(requirements.asset) && sameAddress(requirements.asset, expected.asset) &&
    isSafeUint(requirements.maxTimeoutSeconds) && requirements.maxTimeoutSeconds > 0 &&
    requirements.extra.name === expected.eip712.name &&
    requirements.extra.version === expected.eip712.version;
}

function requirementsAgree(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right) || !isRecord(left.extra) ||
      !isRecord(right.extra) || typeof left.payTo !== "string" ||
      typeof right.payTo !== "string" || typeof left.asset !== "string" ||
      typeof right.asset !== "string") return false;
  try {
    return left.scheme === right.scheme && left.network === right.network &&
      sameAddress(left.payTo, right.payTo) && left.amount === right.amount &&
      sameAddress(left.asset, right.asset) &&
      left.maxTimeoutSeconds === right.maxTimeoutSeconds &&
      canonicalize(left.extra) === canonicalize(right.extra);
  } catch {
    return false;
  }
}

function listingRefValid(value: unknown): value is ListingRef {
  return isRecord(value) && hasExactKeys(value, ["listingId", "version", "contentHash"]) &&
    isNonEmpty(value.listingId) && isSafeUint(value.version) && value.version > 0 &&
    typeof value.contentHash === "string" && HASH_RE.test(value.contentHash);
}

function isCommittedSessionScope(value: unknown): value is X402SellerCommittedSessionScope {
  return isRecord(value) && hasExactKeys(value, [
    "scopeVersion",
    "jobId",
    "paymentPhaseIndex",
    "deliveryPhaseIndex",
    "payer",
    "payerPayingKey",
    "httpResource",
    "railId",
    "railRegistryVersion",
    "agreementRef",
    "agreementHash",
    "listingRef",
    "commitmentRef",
    "commitmentContentHash",
    "commitmentFinalizedAt",
    "expected",
  ]) && value.scopeVersion === "1" && isNonEmpty(value.jobId) &&
    isSafeUint(value.paymentPhaseIndex) && isSafeUint(value.deliveryPhaseIndex) &&
    value.deliveryPhaseIndex > value.paymentPhaseIndex && typeof value.payer === "string" &&
    EVM_ADDRESS_RE.test(value.payer) && isNonEmpty(value.payerPayingKey) &&
    isNonEmpty(value.httpResource) && isNonEmpty(value.railId) &&
    isSafeUint(value.railRegistryVersion) && value.railRegistryVersion > 0 &&
    isNonEmpty(value.agreementRef) && typeof value.agreementHash === "string" &&
    HASH_RE.test(value.agreementHash) && listingRefValid(value.listingRef) &&
    isNonEmpty(value.commitmentRef) && typeof value.commitmentContentHash === "string" &&
    HASH_RE.test(value.commitmentContentHash) && isSafeUint(value.commitmentFinalizedAt) &&
    validExpectedTerms(value.expected);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    if (ArrayBuffer.isView(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function ownedFrozen<T>(value: T): Readonly<T> | null {
  try {
    return deepFreeze(structuredClone(value));
  } catch {
    return null;
  }
}

function captureHttpAdapter(source: X402PaywallHttpAdapter): {
  request: X402PaywallHttpAdapter;
  httpResource: string;
} | null {
  try {
    const getHeader = source?.getHeader;
    const getMethod = source?.getMethod;
    const getPath = source?.getPath;
    const getUrl = source?.getUrl;
    const getAcceptHeader = source?.getAcceptHeader;
    const getUserAgent = source?.getUserAgent;
    const getQueryParams = source?.getQueryParams;
    const getQueryParam = source?.getQueryParam;
    const getBody = source?.getBody;
    if (!source || typeof getHeader !== "function" || typeof getMethod !== "function" ||
        typeof getPath !== "function" || typeof getUrl !== "function" ||
        typeof getAcceptHeader !== "function" || typeof getUserAgent !== "function" ||
        (getQueryParams !== undefined && typeof getQueryParams !== "function") ||
        (getQueryParam !== undefined && typeof getQueryParam !== "function") ||
        (getBody !== undefined && typeof getBody !== "function")) return null;

    const invoke = <T>(method: Function, ...args: unknown[]): T =>
      Reflect.apply(method, source, args) as T;
    const method = invoke<unknown>(getMethod);
    const path = invoke<unknown>(getPath);
    const httpResource = invoke<unknown>(getUrl);
    const accept = invoke<unknown>(getAcceptHeader);
    const userAgent = invoke<unknown>(getUserAgent);
    if (typeof method !== "string" || typeof path !== "string" ||
        !isNonEmpty(httpResource) || typeof accept !== "string" ||
        typeof userAgent !== "string") return null;
    const parsed = new URL(httpResource);

    const headerCache = new Map<string, string | undefined>();
    for (const name of ["PAYMENT-SIGNATURE", "X-PAYMENT"]) {
      const value = invoke<unknown>(getHeader, name);
      if (value !== undefined && typeof value !== "string") return null;
      headerCache.set(name.toLowerCase(), value as string | undefined);
    }

    let queryParams: Record<string, string | string[]> = {};
    if (getQueryParams) {
      const supplied = ownedFrozen(invoke<unknown>(getQueryParams));
      if (!supplied || !isRecord(supplied) || Object.values(supplied).some(
        (value) => typeof value !== "string" &&
          (!Array.isArray(value) || value.some((item) => typeof item !== "string")),
      )) return null;
      queryParams = structuredClone(supplied) as Record<string, string | string[]>;
    } else {
      for (const name of new Set(parsed.searchParams.keys())) {
        const values = parsed.searchParams.getAll(name);
        queryParams[name] = values.length === 1 ? values[0]! : values;
      }
    }
    const body = getBody === undefined
      ? undefined
      : deepFreeze(structuredClone(invoke<unknown>(getBody)));

    const request: X402PaywallHttpAdapter = Object.freeze({
      getHeader: (name: string) => headerCache.get(name.toLowerCase()),
      getMethod: () => method,
      getPath: () => path,
      getUrl: () => httpResource,
      getAcceptHeader: () => accept,
      getUserAgent: () => userAgent,
      getQueryParams: () => structuredClone(queryParams),
      getQueryParam: (name: string) => Object.prototype.hasOwnProperty.call(queryParams, name)
        ? structuredClone(queryParams[name])
        : undefined,
      ...(getBody === undefined ? {} : { getBody: () => structuredClone(body) }),
    });
    return { request, httpResource };
  } catch {
    return null;
  }
}

function bind<T extends Function>(callback: T, owner: unknown): T {
  if (typeof callback !== "function") throw new TypeError("required callback is missing");
  return Function.prototype.bind.call(callback, owner) as T;
}

function captureReceiptStore(source: SellerFulfilmentReceiptStore): SellerFulfilmentReceiptStore {
  return Object.freeze({
    claim: bind(source.claim, source),
    inspectPermit: bind(source.inspectPermit, source),
    consumePermit: bind(source.consumePermit, source),
  });
}

function capturePaymentDeps(
  source: Omit<SellerPaymentIntakeDeps, "receiptStore">,
  receiptStore: SellerFulfilmentReceiptStore,
): SellerPaymentIntakeDeps {
  return Object.freeze({
    resolveCommittedAgreement: bind(source.resolveCommittedAgreement, source),
    resolveListingAtCommit: bind(source.resolveListingAtCommit, source),
    resolveRail: bind(source.resolveRail, source),
    resolveIdentityBundle: bind(source.resolveIdentityBundle, source),
    resolvePayerAddress: bind(source.resolvePayerAddress, source),
    resolvePayeeDestination: bind(source.resolvePayeeDestination, source),
    observeDemosTransfer: bind(source.observeDemosTransfer, source),
    observeX402Transfer: bind(source.observeX402Transfer, source),
    verifyX402ReceiptExtensions: bind(source.verifyX402ReceiptExtensions, source),
    classifyX402SettlementChain: bind(source.classifyX402SettlementChain, source),
    receiptStore,
  });
}

function captureFencedStore(source: FencedSessionStoreV2): FencedSessionStoreV2 {
  return Object.freeze({
    apiVersion: source.apiVersion,
    create: bind(source.create, source),
    load: bind(source.load, source),
    transition: bind(source.transition, source),
    claimCheckpoint: bind(source.claimCheckpoint, source),
    acquireLease: bind(source.acquireLease, source),
    renewLease: bind(source.renewLease, source),
    bindSessionAuthorization: bind(source.bindSessionAuthorization, source),
    bindHash: bind(source.bindHash, source),
    list: bind(source.list, source),
  });
}

function captureFulfilmentDeps(
  source: Omit<DurableSellerFulfilmentDeps, "receiptStore">,
  receiptStore: SellerFulfilmentReceiptStore,
): DurableSellerFulfilmentDeps {
  const resolveAgreement = source.resolveAgreement;
  const resolveListing = source.resolveListing;
  const auditSourceProfile = source.auditSourceProfile;
  const resolveAuditSource = source.resolveAuditSource;
  const prepareDelivery = source.prepareDelivery;
  const submitDelivery = source.submitDelivery;
  const reconcileDelivery = source.reconcileDelivery;
  const resolveDelivery = source.resolveDelivery;
  const verifyAnchorReceipt = source.verifyAnchorReceipt;
  const verifyDeliverySchema = source.verifyDeliverySchema;
  const verifyEncryptedDelivery = source.verifyEncryptedDelivery;
  const resolvePayloadAttestation = source.resolvePayloadAttestation;
  const anchorPayloadAttestation = source.anchorPayloadAttestation;
  const resolvePayloadVerificationCapability = source.resolvePayloadVerificationCapability;
  const verifyPayloadAttestationSignature = source.verifyPayloadAttestationSignature;
  const verifyPayloadMethodProof = source.verifyPayloadMethodProof;
  const verifyEntitlementSignature = source.verifyEntitlementSignature;
  const evidenceSigner = source.evidenceSigner;
  const auditSourceCommitmentSigner = source.auditSourceCommitmentSigner;
  const verifyEvidenceSignature = source.verifyEvidenceSignature;
  const verifyAuditSourceCommitmentSignature =
    source.verifyAuditSourceCommitmentSignature;
  const anchorEvidence = source.anchorEvidence;
  const resolveEvidence = source.resolveEvidence;
  const nowMs = source.nowMs;
  return Object.freeze({
    receiptStore,
    auditSourceProfile,
    resolveAgreement: bind(resolveAgreement, source),
    resolveListing: bind(resolveListing, source),
    resolveAuditSource: bind(resolveAuditSource, source),
    prepareDelivery: bind(prepareDelivery, source),
    submitDelivery: bind(submitDelivery, source),
    reconcileDelivery: bind(reconcileDelivery, source),
    resolveDelivery: bind(resolveDelivery, source),
    verifyAnchorReceipt: bind(verifyAnchorReceipt, source),
    ...(verifyDeliverySchema
      ? { verifyDeliverySchema: bind(verifyDeliverySchema, source) }
      : {}),
    ...(verifyEncryptedDelivery
      ? { verifyEncryptedDelivery: bind(verifyEncryptedDelivery, source) }
      : {}),
    ...(resolvePayloadAttestation
      ? { resolvePayloadAttestation: bind(resolvePayloadAttestation, source) }
      : {}),
    ...(anchorPayloadAttestation
      ? { anchorPayloadAttestation: bind(anchorPayloadAttestation, source) }
      : {}),
    ...(resolvePayloadVerificationCapability
      ? {
          resolvePayloadVerificationCapability: bind(
            resolvePayloadVerificationCapability,
            source,
          ),
        }
      : {}),
    ...(verifyPayloadAttestationSignature
      ? {
          verifyPayloadAttestationSignature: bind(
            verifyPayloadAttestationSignature,
            source,
          ),
        }
      : {}),
    ...(verifyPayloadMethodProof
      ? { verifyPayloadMethodProof: bind(verifyPayloadMethodProof, source) }
      : {}),
    ...(verifyEntitlementSignature
      ? { verifyEntitlementSignature: bind(verifyEntitlementSignature, source) }
      : {}),
    evidenceSigner: Object.freeze({
      algorithm: evidenceSigner.algorithm,
      signer: evidenceSigner.signer,
      sign: bind(evidenceSigner.sign, evidenceSigner),
    }),
    auditSourceCommitmentSigner: Object.freeze({
      algorithm: auditSourceCommitmentSigner.algorithm,
      signer: auditSourceCommitmentSigner.signer,
      sign: bind(auditSourceCommitmentSigner.sign, auditSourceCommitmentSigner),
    }),
    verifyEvidenceSignature: bind(verifyEvidenceSignature, source),
    verifyAuditSourceCommitmentSignature: bind(
      verifyAuditSourceCommitmentSignature,
      source,
    ),
    anchorEvidence: bind(anchorEvidence, source),
    resolveEvidence: bind(resolveEvidence, source),
    nowMs: bind(nowMs, source),
  });
}

function captureDurability(source: SellerFulfilmentDurability): SellerFulfilmentDurability {
  const store = source.store;
  const workerId = source.workerId;
  const leaseTtlMs = source.leaseTtlMs;
  const leaseNowMs = source.leaseNowMs;
  const reconcilePayloadAttestation = source.reconcilePayloadAttestation;
  const reconcileDeliverySubmission = source.reconcileDeliverySubmission;
  const reconcileEvidencePublication = source.reconcileEvidencePublication;
  const publishFinalSessionReceipt = source.publishFinalSessionReceipt;
  const reconcileFinalSessionReceipt = source.reconcileFinalSessionReceipt;
  return Object.freeze({
    store: captureFencedStore(store),
    workerId,
    leaseTtlMs,
    ...(leaseNowMs ? { leaseNowMs: bind(leaseNowMs, source) } : {}),
    reconcilePayloadAttestation: bind(reconcilePayloadAttestation, source),
    reconcileDeliverySubmission: bind(reconcileDeliverySubmission, source),
    reconcileEvidencePublication: bind(reconcileEvidencePublication, source),
    publishFinalSessionReceipt: bind(publishFinalSessionReceipt, source),
    reconcileFinalSessionReceipt: bind(reconcileFinalSessionReceipt, source),
  });
}

function captureSettlementStore(source: X402PaywallSettlementStore): X402PaywallSettlementStore {
  return Object.freeze({
    load: bind(source.load, source),
    claim: bind(source.claim, source),
    recordOutcome: bind(source.recordOutcome, source),
  });
}

function validPreContext(context: Readonly<X402PaywallPreSettlementContext>): boolean {
  return isRecord(context) && isRecord(context.request) &&
    typeof context.request.getUrl === "function" &&
    isNonEmpty(context.jobId) && isSafeUint(context.phaseIndex) &&
    typeof context.payer === "string" && EVM_ADDRESS_RE.test(context.payer) &&
    validExpectedTerms(context.expected) &&
    requirementsMatch(context.paymentRequirements, context.expected) &&
    isRecord(context.paymentPayload) &&
    requirementsAgree(context.paymentPayload.accepted, context.paymentRequirements);
}

function sessionMatchesPreContext(
  session: X402SellerCommittedSessionScope,
  context: Readonly<X402PaywallPreSettlementContext>,
  httpResource: string,
): boolean {
  return session.jobId === context.jobId &&
    session.paymentPhaseIndex === context.phaseIndex &&
    sameAddress(session.payer, context.payer) && session.httpResource === httpResource &&
    sameExpectedTerms(session.expected, context.expected) &&
    requirementsMatch(context.paymentRequirements, session.expected) &&
    requirementsAgree(context.paymentPayload.accepted, context.paymentRequirements);
}

function authorizationFromIntake(
  result: Readonly<SellerPaymentIntakeResult>,
): SellerPaymentAuthorization | null {
  const authorization = {
    jobId: result.jobId,
    phaseIndex: result.phaseIndex,
    agreementHash: result.agreementHash,
    listingRef: result.listingRef,
    railId: result.railId,
    railRegistryVersion: result.railRegistryVersion,
    commitment: result.commitment,
    settlementIdentity: result.settlementIdentity,
    settlementId: result.settlementId,
    evidenceHash: result.evidenceHash,
    evidenceInput: result.evidenceInput,
    payoutBindingTier: result.payoutBindingTier,
    ...(result.sessionBinding === undefined ? {} : { sessionBinding: result.sessionBinding }),
    ...(result.payloadVerificationProducerAdmission === undefined
      ? {}
      : {
          payloadVerificationProducerAdmission:
            result.payloadVerificationProducerAdmission,
        }),
  } as SellerPaymentAuthorization;
  if (!isRecord(result.evidenceInput) || !isSafeUint(result.evidenceInput.observedAt)) return null;
  const claim = {
    settlementId: authorization.settlementId,
    jobId: authorization.jobId,
    phaseIndex: authorization.phaseIndex,
    observedAt: result.evidenceInput.observedAt,
    evidenceHash: authorization.evidenceHash,
    authorization,
  };
  return isValidSellerReceiptClaim(claim) ? structuredClone(authorization) : null;
}

function authorizationMatchesSession(
  authorization: SellerPaymentAuthorization,
  session: X402SellerCommittedSessionScope,
): boolean {
  return authorization.jobId === session.jobId &&
    authorization.phaseIndex === session.paymentPhaseIndex &&
    authorization.agreementHash === session.agreementHash &&
    isDeepStrictEqual(authorization.listingRef, session.listingRef) &&
    authorization.railId === session.railId &&
    authorization.railRegistryVersion === session.railRegistryVersion &&
    authorization.commitment.ref === session.commitmentRef &&
    authorization.commitment.contentHash === session.commitmentContentHash &&
    authorization.commitment.finalizedAt === session.commitmentFinalizedAt;
}

function validPaymentAuthorization(value: unknown): value is SellerPaymentAuthorization {
  if (!isRecord(value) || !isRecord(value.evidenceInput) ||
      !isSafeUint(value.evidenceInput.observedAt)) return false;
  return isValidSellerReceiptClaim({
    settlementId: value.settlementId,
    jobId: value.jobId,
    phaseIndex: value.phaseIndex,
    observedAt: value.evidenceInput.observedAt,
    evidenceHash: value.evidenceHash,
    authorization: value,
  });
}

function validPermitAuthorization(
  value: unknown,
): value is X402SellerPaymentPermitAuthorization {
  return isRecord(value) && hasExactKeys(value, [
    "authorizationVersion",
    "sessionAuthorization",
    "paymentPermitId",
    "paymentAuthorization",
  ]) && value.authorizationVersion === "1" &&
    isCommittedSessionScope(value.sessionAuthorization) &&
    isNonEmpty(value.paymentPermitId) && validPaymentAuthorization(value.paymentAuthorization) &&
    authorizationMatchesSession(value.paymentAuthorization, value.sessionAuthorization);
}

function settlementMatchesSession(
  context: Pick<X402PaywallAuthorizationContext, "payer" | "paymentClaim" | "settlement">,
  session: X402SellerCommittedSessionScope,
): boolean {
  if (typeof context.payer !== "string" || !EVM_ADDRESS_RE.test(context.payer) ||
      !isRecord(context.paymentClaim) || !isRecord(context.paymentClaim.responseHeader) ||
      typeof context.paymentClaim.responseHeader.name !== "string" ||
      typeof context.paymentClaim.responseHeader.value !== "string" ||
      !isRecord(context.settlement) || !isRecord(context.settlement.headers) ||
      typeof context.settlement.transaction !== "string" ||
      typeof context.settlement.network !== "string") return false;
  const chainId = Number(session.expected.network.slice("eip155:".length));
  const expectedHeaderName = context.paymentClaim.responseHeader.name.toUpperCase();
  const responseHeaders = Object.entries(context.settlement.headers).filter(
    ([name]) => name.toUpperCase() === expectedHeaderName,
  );
  return sameAddress(context.payer, session.payer) &&
    context.paymentClaim.protocolVersion === "2" &&
    context.paymentClaim.httpResource === session.httpResource &&
    context.paymentClaim.chainId === chainId &&
    context.paymentClaim.settlementTxHash === context.settlement.transaction &&
    responseHeaders.length === 1 &&
    responseHeaders[0]?.[1] === context.paymentClaim.responseHeader.value &&
    context.settlement.network === session.expected.network &&
    (context.settlement.payer === undefined ||
      typeof context.settlement.payer === "string" &&
      sameAddress(context.settlement.payer, session.payer)) &&
    (context.settlement.amount === undefined ||
      context.settlement.amount === session.expected.amount) &&
    requirementsMatch(context.settlement.requirements, session.expected);
}

function claimMatchesAuthorization(
  paymentClaim: X402PaywallFulfilmentContext<X402SellerPaymentPermitAuthorization>["paymentClaim"],
  authorization: SellerPaymentAuthorization,
  expectedPayer: string,
): boolean {
  const txRef = authorization.evidenceInput.paymentTxRefs[0];
  if (txRef?.kind !== "x402" ||
      paymentClaim.protocolVersion !== txRef.protocolVersion ||
      paymentClaim.httpResource !== txRef.httpResource ||
      paymentClaim.paymentReceiptHash !== txRef.paymentReceiptHash ||
      paymentClaim.settlementTxHash !== txRef.settlementTxHash ||
      paymentClaim.chainId !== txRef.chainId) return false;
  try {
    const verification = verifyX402ReceiptClaim({
      protocolVersion: paymentClaim.protocolVersion,
      responseHeader: paymentClaim.responseHeader,
      evidence: {
        paymentReceiptHash: txRef.paymentReceiptHash,
        ...(txRef.settlementTxHash === undefined
          ? {}
          : { settlementTxHash: txRef.settlementTxHash }),
        ...(txRef.chainId === undefined ? {} : { chainId: txRef.chainId }),
      },
    });
    const receiptPayer = verification.receipt?.payer;
    return verification.disposition === "pass" &&
      typeof receiptPayer === "string" && EVM_ADDRESS_RE.test(receiptPayer) &&
      sameAddress(receiptPayer, expectedPayer);
  } catch {
    return false;
  }
}

function exactAuthorization(
  left: SellerPaymentAuthorization,
  right: SellerPaymentAuthorization,
): boolean {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
}

function retainedSettlementMatches(
  value: unknown,
  settlementKey: string,
  session: X402SellerCommittedSessionScope,
  paymentPayload: Readonly<X402PaywallPaymentPayload>,
  paymentRequirements: Readonly<X402PaywallPaymentRequirements>,
  settlement: Readonly<X402PaywallFulfilmentContext<unknown>["settlement"]>,
): "match" | "unavailable" | "invalid" | "mismatch" {
  if (!isRecord(value)) return "invalid";
  if (value.status !== "settled") return "unavailable";
  if (!hasExactKeys(value, ["status", "intent", "outcome"]) ||
      !isRecord(value.intent) || !isRecord(value.outcome)) return "invalid";
  const intent = value.intent;
  if (!hasRequiredKeys(intent, [
    "intentVersion",
    "settlementKey",
    "bindingHash",
    "jobId",
    "phaseIndex",
    "httpResource",
    "payer",
    "paymentHeader",
    "paymentPayload",
    "paymentRequirements",
    "sessionAuthorization",
  ], ["declaredExtensions"]) || intent.intentVersion !== "2" ||
      intent.settlementKey !== settlementKey ||
      typeof intent.bindingHash !== "string" || !HASH_RE.test(intent.bindingHash) ||
      typeof intent.jobId !== "string" || !isSafeUint(intent.phaseIndex) ||
      typeof intent.httpResource !== "string" ||
      typeof intent.payer !== "string" || !EVM_ADDRESS_RE.test(intent.payer) ||
      !isNonEmpty(intent.paymentHeader) || !isRecord(intent.paymentPayload) ||
      !isRecord(intent.paymentRequirements) ||
      !isCommittedSessionScope(intent.sessionAuthorization) ||
      (intent.declaredExtensions !== undefined && !isRecord(intent.declaredExtensions))) {
    return "invalid";
  }
  try {
    const { bindingHash: _bindingHash, ...intentCore } = intent;
    if (sha256Hex(canonicalize(intentCore)) !== intent.bindingHash) return "invalid";
  } catch {
    return "invalid";
  }
  if (intent.jobId !== session.jobId ||
      intent.phaseIndex !== session.paymentPhaseIndex ||
      intent.httpResource !== session.httpResource ||
      !sameAddress(intent.payer, session.payer) ||
      !isDeepStrictEqual(intent.sessionAuthorization, session) ||
      !isDeepStrictEqual(intent.paymentPayload, paymentPayload) ||
      !isDeepStrictEqual(intent.paymentRequirements, paymentRequirements)) {
    return "mismatch";
  }
  if (!hasExactKeys(value.outcome, ["status", "settlement"]) ||
      value.outcome.status !== "settled" ||
      !isDeepStrictEqual(value.outcome.settlement, settlement)) return "mismatch";
  return "match";
}

function validRenderedResponse<T>(value: unknown): value is X402SellerRenderedResponse<T> {
  if (!isRecord(value) || !Object.keys(value).every((key) =>
    key === "status" || key === "headers" || key === "body")) return false;
  if (value.status !== undefined && (!Number.isInteger(value.status) ||
      Number(value.status) < 200 || Number(value.status) > 399)) return false;
  return value.headers === undefined || isRecord(value.headers) &&
    Object.values(value.headers).every((item) => typeof item === "string");
}

/**
 * Compose the x402 transport with the real #119 payment gate and generation-
 * fenced #120/#121 fulfilment spine. No delivery callback or response renderer
 * can run unless the exact pre-settlement scope survives both lower gates.
 */
export function createX402SellerSpine<T = unknown>(
  options: X402SellerSpineOptions<T>,
): X402SellerSpine<T> {
  // Capture every executable authority before returning handlers. Later caller
  // mutation cannot swap one side of the payment/fulfilment boundary.
  const receiptStore = captureReceiptStore(options.receiptStore);
  const settlementStore = captureSettlementStore(options.settlementStore);
  const reconcileSettlement = bind(options.reconcileSettlement, options);
  const resolveCommittedSession = bind(options.resolveCommittedSession, options);
  const paymentIntakeDeps = capturePaymentDeps(options.paymentIntakeDeps, receiptStore);
  const fulfilmentDeps = captureFulfilmentDeps(options.fulfilmentDeps, receiptStore);
  const fulfilmentDurability = captureDurability(options.fulfilmentDurability);
  const renderResponse = bind(options.renderResponse, options);

  const authorizeSettlement = async (
    context: Readonly<X402PaywallPreSettlementContext>,
  ): Promise<X402PaywallPreSettlementAuthorization> => {
    if (!isRecord(context)) {
      return { disposition: "rejected", reason: "seller-session-request-invalid" };
    }
    let snapshot: X402PaywallPreSettlementContext;
    let httpResource: string;
    try {
      const jobId = context.jobId;
      const phaseIndex = context.phaseIndex;
      const payer = context.payer;
      const requestSource = context.request;
      const paymentPayload = ownedFrozen(context.paymentPayload);
      const paymentRequirements = ownedFrozen(context.paymentRequirements);
      const expected = ownedFrozen(context.expected);
      const capturedRequest = captureHttpAdapter(requestSource);
      if (!paymentPayload || !paymentRequirements || !expected || !capturedRequest) {
        return { disposition: "indeterminate", reason: "seller-session-request-unavailable" };
      }
      httpResource = capturedRequest.httpResource;
      snapshot = Object.freeze({
        jobId,
        phaseIndex,
        payer,
        request: capturedRequest.request,
        paymentPayload,
        paymentRequirements,
        expected,
      });
    } catch {
      return { disposition: "indeterminate", reason: "seller-session-request-unavailable" };
    }
    if (!validPreContext(snapshot)) {
      return { disposition: "rejected", reason: "seller-session-request-invalid" };
    }

    let raw: X402SellerCommittedSessionResolution;
    try {
      raw = await resolveCommittedSession(snapshot);
    } catch {
      return { disposition: "indeterminate", reason: "seller-session-resolution-unavailable" };
    }
    const result = ownedFrozen(raw);
    if (!result || !isRecord(result)) {
      return { disposition: "indeterminate", reason: "seller-session-resolution-invalid" };
    }
    if (result.disposition === "rejected" || result.disposition === "indeterminate") {
      if (!hasExactKeys(result, ["disposition", "reason"]) || !isNonEmpty(result.reason)) {
        return { disposition: "indeterminate", reason: "seller-session-resolution-invalid" };
      }
      return { disposition: result.disposition, reason: result.reason };
    }
    if (result.disposition !== "verified" ||
        !hasExactKeys(result, ["disposition", "session"]) ||
        !isCommittedSessionScope(result.session)) {
      return { disposition: "indeterminate", reason: "seller-session-resolution-invalid" };
    }
    if (!sessionMatchesPreContext(result.session, snapshot, httpResource)) {
      return { disposition: "rejected", reason: "seller-session-scope-mismatch" };
    }
    return { disposition: "authorized", authorization: result.session };
  };

  const authorizePayment = async (
    context: Readonly<X402PaywallAuthorizationContext>,
  ) => {
    if (!isRecord(context)) {
      return {
        disposition: "indeterminate" as const,
        reason: "seller-settlement-session-mismatch",
      };
    }
    const jobId = context.jobId;
    const phaseIndex = context.phaseIndex;
    const payer = context.payer;
    const sessionSnapshot = ownedFrozen(context.sessionAuthorization);
    const claim = ownedFrozen(context.paymentClaim);
    const settlement = ownedFrozen(context.settlement);
    if (!sessionSnapshot || !isCommittedSessionScope(sessionSnapshot)) {
      return {
        disposition: "indeterminate" as const,
        reason: "seller-session-authorization-invalid",
      };
    }
    if (!claim || !settlement || jobId !== sessionSnapshot.jobId ||
        phaseIndex !== sessionSnapshot.paymentPhaseIndex ||
        !settlementMatchesSession({ payer, paymentClaim: claim, settlement }, sessionSnapshot)) {
      return {
        disposition: "indeterminate" as const,
        reason: "seller-settlement-session-mismatch",
      };
    }
    let raw: SellerPaymentIntakeResult;
    try {
      raw = await verifySellerPaymentIntake({
        jobId: sessionSnapshot.jobId,
        phaseIndex: sessionSnapshot.paymentPhaseIndex,
        railId: sessionSnapshot.railId,
        payerPayingKey: sessionSnapshot.payerPayingKey,
        receipt: claim,
      }, paymentIntakeDeps);
    } catch {
      return { disposition: "indeterminate" as const, reason: "seller-payment-intake-unavailable" };
    }
    const result = ownedFrozen(raw);
    if (!result || !isRecord(result) || !isNonEmpty(result.reason)) {
      return { disposition: "indeterminate" as const, reason: "seller-payment-intake-invalid" };
    }
    if (result.disposition !== "verified") {
      return {
        disposition: result.disposition === "rejected" ? "rejected" as const : "indeterminate" as const,
        reason: result.reason,
      };
    }
    if ((result.fulfilment !== "claim" && result.fulfilment !== "already-claimed") ||
        !isNonEmpty(result.permitId)) {
      return { disposition: "indeterminate" as const, reason: "seller-payment-permit-invalid" };
    }
    const paymentAuthorization = authorizationFromIntake(result);
    if (!paymentAuthorization ||
        !authorizationMatchesSession(paymentAuthorization, sessionSnapshot)) {
      return {
        disposition: "indeterminate" as const,
        reason: "seller-payment-authorization-mismatch",
      };
    }
    const authorization = ownedFrozen<X402SellerPaymentPermitAuthorization>({
      authorizationVersion: "1",
      sessionAuthorization: sessionSnapshot,
      paymentPermitId: result.permitId,
      paymentAuthorization,
    });
    if (!authorization || !validPermitAuthorization(authorization)) {
      return { disposition: "indeterminate" as const, reason: "seller-payment-authorization-invalid" };
    }
    return { disposition: "authorized" as const, authorization };
  };

  const fulfil = async (
    context: Readonly<X402PaywallFulfilmentContext<X402SellerPaymentPermitAuthorization>>,
  ): Promise<X402PaywallFulfilment<T>> => {
    if (!isRecord(context)) {
      return { disposition: "failed", reason: "seller-payment-authorization-invalid" };
    }
    const jobId = context.jobId;
    const phaseIndex = context.phaseIndex;
    const payer = context.payer;
    const authorization = ownedFrozen(context.authorization);
    const paymentPayloadSnapshot = ownedFrozen(context.paymentPayload);
    const paymentRequirementsSnapshot = ownedFrozen(context.paymentRequirements);
    const paymentClaimSnapshot = ownedFrozen(context.paymentClaim);
    const settlementSnapshot = ownedFrozen(context.settlement);
    if (!authorization || !validPermitAuthorization(authorization)) {
      return { disposition: "failed", reason: "seller-payment-authorization-invalid" };
    }
    const session = authorization.sessionAuthorization;
    if (!paymentPayloadSnapshot || !paymentRequirementsSnapshot || !paymentClaimSnapshot ||
        !settlementSnapshot || jobId !== session.jobId ||
        phaseIndex !== session.paymentPhaseIndex ||
        typeof payer !== "string" || !EVM_ADDRESS_RE.test(payer) ||
        !sameAddress(payer, session.payer) ||
        !requirementsMatch(paymentRequirementsSnapshot, session.expected) ||
        !isRecord(paymentPayloadSnapshot) ||
        !requirementsAgree(
          paymentPayloadSnapshot.accepted,
          paymentRequirementsSnapshot,
        ) ||
        !settlementMatchesSession({
          payer,
          paymentClaim: paymentClaimSnapshot,
          settlement: settlementSnapshot,
        }, session) ||
        !claimMatchesAuthorization(
          paymentClaimSnapshot,
          authorization.paymentAuthorization,
          session.payer,
        )) {
      return { disposition: "indeterminate", reason: "seller-fulfilment-session-mismatch" };
    }

    let rawSettlementState: unknown;
    try {
      rawSettlementState = await settlementStore.load(x402PaywallSettlementKey({
        jobId: session.jobId,
        phaseIndex: session.paymentPhaseIndex,
      }));
    } catch {
      return {
        disposition: "indeterminate",
        reason: "seller-settlement-store-unavailable",
      };
    }
    const settlementState = ownedFrozen(rawSettlementState);
    const retainedSettlement = retainedSettlementMatches(
      settlementState,
      x402PaywallSettlementKey({
        jobId: session.jobId,
        phaseIndex: session.paymentPhaseIndex,
      }),
      session,
      paymentPayloadSnapshot,
      paymentRequirementsSnapshot,
      settlementSnapshot,
    );
    if (retainedSettlement !== "match") {
      return {
        disposition: "indeterminate",
        reason: retainedSettlement === "unavailable"
          ? "seller-settlement-state-unavailable"
          : retainedSettlement === "invalid"
            ? "seller-settlement-store-invalid"
            : "seller-settlement-session-authorization-mismatch",
      };
    }

    let rawInspection: unknown;
    try {
      rawInspection = await receiptStore.inspectPermit(authorization.paymentPermitId);
    } catch {
      return {
        disposition: "indeterminate",
        reason: "seller-payment-permit-store-unavailable",
      };
    }
    const inspection = ownedFrozen(rawInspection);
    if (!inspection || !isRecord(inspection)) {
      return { disposition: "indeterminate", reason: "seller-payment-permit-store-invalid" };
    }
    if (inspection.status === "invalid" && hasExactKeys(inspection, ["status"])) {
      return { disposition: "failed", reason: "seller-payment-permit-invalid" };
    }
    const available = inspection.status === "available" &&
      hasExactKeys(inspection, ["status", "claim"]);
    const consumed = inspection.status === "already-consumed" &&
      hasExactKeys(inspection, ["status", "claim", "handoff"]);
    if ((!available && !consumed) || !isValidSellerReceiptClaim(inspection.claim) ||
        consumed && !isSellerFulfilmentHandoff(inspection.handoff)) {
      return { disposition: "indeterminate", reason: "seller-payment-permit-store-invalid" };
    }
    if (!exactAuthorization(
      inspection.claim.authorization,
      authorization.paymentAuthorization,
    )) {
      return {
        disposition: "indeterminate",
        reason: "seller-consumed-payment-authorization-mismatch",
      };
    }

    let raw: SellerFulfilmentResult;
    try {
      raw = await runDurableFulfilmentCore({
        agreementRef: session.agreementRef,
        agreementHash: session.agreementHash,
        commitmentRef: session.commitmentRef,
        deliveryPhaseIndex: session.deliveryPhaseIndex,
        paymentPermitId: authorization.paymentPermitId,
        ...(authorization.paymentAuthorization.payloadVerificationProducerAdmission
          ? {
              payloadVerificationProducerAdmission:
                authorization.paymentAuthorization.payloadVerificationProducerAdmission,
            }
          : {}),
      }, fulfilmentDeps, fulfilmentDurability);
    } catch {
      return { disposition: "indeterminate", reason: "seller-durable-fulfilment-unavailable" };
    }
    const result = ownedFrozen(raw);
    if (!result || !isRecord(result) || typeof result.decision !== "string") {
      return { disposition: "indeterminate", reason: "seller-durable-fulfilment-invalid" };
    }
    const consumedAuthorization = "consumedPaymentAuthorization" in result
      ? result.consumedPaymentAuthorization
      : undefined;
    if (consumedAuthorization !== undefined &&
        (!validPaymentAuthorization(consumedAuthorization) ||
          !exactAuthorization(
            consumedAuthorization,
            authorization.paymentAuthorization,
          ))) {
      return {
        disposition: "indeterminate",
        reason: "seller-consumed-payment-authorization-mismatch",
      };
    }
    if (result.decision === "rejected") {
      return { disposition: "failed", reason: result.code };
    }
    if (result.decision === "indeterminate") {
      return { disposition: "indeterminate", reason: result.code };
    }
    if (result.decision === "failed") {
      if (!consumedAuthorization) {
        return {
          disposition: "indeterminate",
          reason: "seller-consumed-payment-authorization-mismatch",
        };
      }
      return {
        disposition: "failed",
        reason: `seller-fulfilment-${result.errorClass}`,
      };
    }
    if (!consumedAuthorization ||
        !exactAuthorization(
          consumedAuthorization,
          authorization.paymentAuthorization,
        )) {
      return {
        disposition: "indeterminate",
        reason: "seller-consumed-payment-authorization-mismatch",
      };
    }

    let rendered: X402SellerRenderedResponse<T>;
    try {
      rendered = await renderResponse(Object.freeze({
        jobId: session.jobId,
        paymentPhaseIndex: session.paymentPhaseIndex,
        deliveryPhaseIndex: session.deliveryPhaseIndex,
        payer: session.payer,
        authorization,
        fulfilment: result,
      }));
    } catch {
      return { disposition: "indeterminate", reason: "seller-response-rendering-unavailable" };
    }
    const response = ownedFrozen(rendered);
    if (!response || !validRenderedResponse<T>(response)) {
      return { disposition: "indeterminate", reason: "seller-response-rendering-invalid" };
    }
    return {
      disposition: "fulfilled",
      ...(response.status === undefined ? {} : { status: response.status }),
      ...(response.headers === undefined ? {} : { headers: response.headers }),
      ...(response.body === undefined ? {} : { body: response.body }),
    };
  };

  return Object.freeze({
    settlementStore,
    reconcileSettlement,
    authorizeSettlement,
    authorizePayment,
    fulfil,
  });
}
