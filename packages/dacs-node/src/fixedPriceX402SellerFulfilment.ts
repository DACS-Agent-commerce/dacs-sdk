import {
  encodeAddressSegment,
  type DurableSellerFulfilmentDeps,
  type ProtocolAnchorReceipt,
  type SellerFulfilmentAuditSourceV1,
  type SellerFulfilmentDurability,
  type SellerFulfilmentListing,
  type SellerFulfilmentSessionRecord,
  type SellerFulfilmentAgreement,
  type SellerPaymentAuthorization,
  type SignedSellerDeliveryEvidence,
  fixedPriceAgreementLogicalAddress,
} from "@kynesyslabs/dacs";
import {
  isCanonicalBase64Url,
} from "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import { canonicalDemosAgentPublicKey } from "@kynesyslabs/dacs/identity";
import type {
  FixedPricePayDemOrderRecord,
  FixedPriceX402OrderRecord,
} from "@kynesyslabs/dacs/commerce";

import { loadDacsSellerAgreementVetProductionForOrderV1 } from
  "./agreementTransportRuntime.js";
import {
  DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1,
  captureDacsFixedPriceX402ApplicationV1,
  loadDacsFixedPriceX402CommitmentResultV1,
} from "./fixedPriceX402Profile.js";
import { loadDacsFixedPricePayDemCommitmentResultV1 } from
  "./fixedPricePayDemProfile.js";
import {
  createDacsFixedPricePayDemRoleOrderV1,
  createDacsFixedPriceX402RoleOrderV1,
} from "./liveOrder.js";
import { loadDacsLiveOrderInputV1 } from "./orderInput.js";
import { loadDacsPayDemSellerPaymentAuthorizationForOrderV1 } from
  "./payDemSellerPayment.js";
import { dacsFixedPricePurchaseAnchorOptionsV1 } from "./purchaseDemosBudget.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";
import { loadDacsSellerX402AuthorizationForOrderV1 } from "./sellerX402Runtime.js";
import {
  loadDacsPayDemSellerSessionAgreementFactsForOrderV1,
  loadDacsSellerSessionAgreementFactsForOrderV1,
} from "./sessionBootstrapAgreementRuntime.js";

const PREPARED_VERSION = "1" as const;
const PREPARED_DOMAIN = "dacs-live-public-storage-delivery:v1:" as const;
const HASH_RE = /^[0-9a-f]{64}$/;
const DEFAULT_LEASE_TTL_MS = 30_000;

export interface DacsPublicStorageDeliverableInputV1 {
  fulfilmentId: string;
  jobId: string;
  request: Readonly<Record<string, unknown>>;
  agreement: Readonly<SellerFulfilmentAgreement>;
  listing: Readonly<SellerFulfilmentListing>;
}

export interface DacsFixedPriceX402SellerFulfilmentOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  authority: Readonly<{
    resolveFulfilmentAgreement: DurableSellerFulfilmentDeps["resolveAgreement"];
    resolveFulfilmentListing: DurableSellerFulfilmentDeps["resolveListing"];
  }>;
  workerId: string;
  recipeRegistryVersion: number;
  leaseTtlMs?: number;
  /**
   * Pure/idempotent application work. The host persists the returned JSON and
   * exclusively owns every irreversible publication and evidence operation.
   */
  prepareDeliverable(
    input: Readonly<DacsPublicStorageDeliverableInputV1>,
  ): Promise<Readonly<Record<string, unknown>>> |
    Readonly<Record<string, unknown>>;
}

export interface DacsFixedPriceSellerFulfilmentOptionsV1
  extends DacsFixedPriceX402SellerFulfilmentOptionsV1 {
  paymentProfile: "x402" | "pay-dem";
}

type SellerLiveOrderRecord = FixedPriceX402OrderRecord | FixedPricePayDemOrderRecord;

function isPayDemOrder(
  order: Readonly<SellerLiveOrderRecord>,
): order is Readonly<FixedPricePayDemOrderRecord> {
  return order.protocol.phase === "pay-dem";
}

export interface DacsFixedPriceX402SellerFulfilmentV1 {
  fulfilmentDeps: Omit<DurableSellerFulfilmentDeps, "receiptStore">;
  fulfilmentDurability: Omit<SellerFulfilmentDurability, "store" | "workerId">;
}

export type DacsFixedPriceSellerFulfilmentV1 =
  DacsFixedPriceX402SellerFulfilmentV1;

export class DacsFixedPriceX402SellerFulfilmentError extends Error {
  override readonly name = "DacsFixedPriceX402SellerFulfilmentError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

interface PreparedRecordV1 {
  preparedVersion: typeof PREPARED_VERSION;
  fulfilmentId: string;
  jobId: string;
  localBindingHash: string;
  requestHash: string;
  payloadHash: string;
  payload: Readonly<Record<string, unknown>>;
}

type PublicAnchorResolution = Readonly<
  | {
      status: "present";
      raw: Readonly<Record<string, unknown>>;
      receipt: Readonly<ProtocolAnchorReceipt>;
    }
  | { status: "absent" }
  | { status: "indeterminate"; reason: string }
>;

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

function safePositive(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 &&
    value <= maximum;
}

function preparedId(jobId: string, fulfilmentId: string): string {
  return sha256Hex(`${PREPARED_DOMAIN}${canonicalize({ jobId, fulfilmentId })}`);
}

function capturePrepared(value: unknown): Readonly<PreparedRecordV1> {
  if (!plainObject(value) || Object.keys(value).length !== 7 ||
      value.preparedVersion !== PREPARED_VERSION ||
      typeof value.fulfilmentId !== "string" || value.fulfilmentId.length === 0 ||
      typeof value.jobId !== "string" || value.jobId.length === 0 ||
      typeof value.localBindingHash !== "string" || !HASH_RE.test(value.localBindingHash) ||
      typeof value.requestHash !== "string" || !HASH_RE.test(value.requestHash) ||
      typeof value.payloadHash !== "string" || !HASH_RE.test(value.payloadHash) ||
      !plainObject(value.payload)) {
    throw new DacsFixedPriceX402SellerFulfilmentError(
      "seller-fulfilment-prepared-record-corrupt",
    );
  }
  const record = copy(value) as unknown as PreparedRecordV1;
  if (sha256Hex(canonicalize(record.payload)) !== record.payloadHash) {
    throw new DacsFixedPriceX402SellerFulfilmentError(
      "seller-fulfilment-prepared-record-corrupt",
    );
  }
  return deepFreeze(record);
}

async function loadOrder(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  jobId: string,
  paymentProfile: "x402" | "pay-dem",
): Promise<Readonly<SellerLiveOrderRecord>> {
  const loaded = paymentProfile === "pay-dem"
    ? await context.database.createPayDemCoordinatorStore("seller").load("seller", jobId)
    : await context.database.createLiveCoordinatorStore("seller").load("seller", jobId);
  if (loaded.status !== "ok" || loaded.record.seller !== context.authority ||
      loaded.record.buyer !== context.peerAuthority ||
      loaded.record.protocol.phase !== (paymentProfile === "pay-dem" ? "pay-dem" : "pay-x402")) {
    throw new DacsFixedPriceX402SellerFulfilmentError(
      "seller-fulfilment-order-invalid",
    );
  }
  return loaded.record;
}

function expectedOwner(context: Readonly<DacsLiveRoleOperationContextV1>): string {
  return Buffer.from(context.demos.publicKey).toString("hex");
}

function loadRetainedOrder(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<SellerLiveOrderRecord>,
) {
  if (isPayDemOrder(order)) {
    return loadDacsLiveOrderInputV1({
      database: context.database,
      order: createDacsFixedPricePayDemRoleOrderV1({
        role: "seller",
        jobId: order.jobId,
        buyer: order.buyer,
        seller: order.seller,
        protocol: order.protocol,
      }),
    });
  }
  return loadDacsLiveOrderInputV1({
    database: context.database,
    order: createDacsFixedPriceX402RoleOrderV1({
      role: "seller",
      jobId: order.jobId,
      buyer: order.buyer,
      seller: order.seller,
      protocol: order.protocol,
    }),
  });
}

async function resolvePublicAnchor(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  logicalAddress: string,
  expectedHash?: string,
): Promise<PublicAnchorResolution> {
  try {
    const resolved = await context.demos.adapter.resolveAnchorByName(
      logicalAddress,
      expectedOwner(context),
    );
    if (resolved.status === "absent") return Object.freeze({ status: "absent" as const });
    if (resolved.status !== "present") {
      return Object.freeze({ status: "indeterminate" as const, reason: resolved.reason });
    }
    const raw = await context.demos.adapter.readAnchor(resolved.address);
    if (raw === null) {
      return Object.freeze({ status: "indeterminate" as const,
        reason: "seller-anchor-native-readback-unavailable" });
    }
    const hash = contentHash(raw);
    if (expectedHash !== undefined && hash !== expectedHash) {
      return Object.freeze({ status: "indeterminate" as const,
        reason: "seller-anchor-content-conflict" });
    }
    const receipt = await context.demos.adapter.resolveDemosAnchorReceipt({
      logicalAddress,
      nativeAddress: resolved.address,
      contentHash: hash,
      writer: context.authority,
    });
    if (receipt === null || receipt.writer !== context.authority ||
        receipt.logicalAddress !== logicalAddress ||
        receipt.nativeAddress !== resolved.address || receipt.contentHash !== hash ||
        receipt.observationDisposition !== "established" ||
        (receipt.state !== "included" && receipt.state !== "finalized") ||
        await context.demos.adapter.verifyDemosAnchorReceipt(receipt) !== true) {
      return Object.freeze({ status: "indeterminate" as const,
        reason: "seller-anchor-receipt-unavailable" });
    }
    return deepFreeze({ status: "present" as const, raw: copy(raw), receipt: copy(receipt) });
  } catch {
    return Object.freeze({ status: "indeterminate" as const,
      reason: "seller-anchor-resolution-unavailable" });
  }
}

async function publishPublicAnchor(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  jobId: string,
  logicalAddress: string,
  raw: Readonly<Record<string, unknown>>,
  expectedHash: string,
): Promise<PublicAnchorResolution> {
  if (contentHash(raw) !== expectedHash) {
    return Object.freeze({ status: "indeterminate" as const,
      reason: "seller-anchor-input-hash-invalid" });
  }
  try {
    await context.demos.adapter.anchorWriteOnce(
      logicalAddress,
      copy(raw),
      dacsFixedPricePurchaseAnchorOptionsV1(
        context,
        jobId,
        {
          logicalAddress,
          contentHash: expectedHash,
          envelopeHash: sha256Hex(canonicalize(raw)),
        },
      ),
    );
  } catch {
    // A submitted Demos write is ambiguous until the exact logical name is
    // reconciled. Never retry under a different name or report absence here.
  }
  return resolvePublicAnchor(context, logicalAddress, expectedHash);
}

function verifyComponent(
  expectedSigner: string,
  algorithm: string,
  value: string,
  bytes: Uint8Array,
): "valid" | "invalid" | "error" {
  const key = canonicalDemosAgentPublicKey(expectedSigner);
  if (key === null || algorithm !== "ed25519" || !isCanonicalBase64Url(value)) {
    return "invalid";
  }
  const signature = Buffer.from(value, "base64url");
  if (signature.byteLength !== 64 || signature.toString("base64url") !== value) {
    return "invalid";
  }
  try {
    return ed25519Verify(bytes, Uint8Array.from(signature), publicKeyFromRaw(key))
      ? "valid" : "invalid";
  } catch {
    return "error";
  }
}

function settlementEvidenceRef(
  payment: Readonly<SellerPaymentAuthorization>,
  signer: string,
) {
  return Object.freeze({
    anchor: {
      kind: "storage-program" as const,
      locator: `dacs4:payment:${payment.jobId}:${
        encodeAddressSegment(payment.railId)}:${payment.phaseIndex}`,
    },
    contentHash: payment.evidenceHash,
    signer,
  });
}

function agreementCommitmentRef(
  order: Readonly<SellerLiveOrderRecord>,
  result: ReturnType<typeof loadDacsFixedPriceX402CommitmentResultV1>,
) {
  return Object.freeze({
    anchor: { kind: "storage-program" as const, locator: result.commitment.logicalAddress },
    contentHash: contentHash(
      result.commitment.record as unknown as Record<string, unknown>,
    ),
    signer: order.seller,
  });
}

function buildAuditSource(input: Readonly<{
  context: Readonly<DacsLiveRoleOperationContextV1>;
  order: Readonly<SellerLiveOrderRecord>;
  payment: Readonly<SellerPaymentAuthorization>;
  recipeRegistryVersion: number;
}>): Readonly<SellerFulfilmentAuditSourceV1> {
  const { context, order, payment } = input;
  const session = isPayDemOrder(order)
    ? loadDacsPayDemSellerSessionAgreementFactsForOrderV1(context, order)
    : loadDacsSellerSessionAgreementFactsForOrderV1(context, order);
  const sellerVet = loadDacsSellerAgreementVetProductionForOrderV1(context, order);
  const commitment = isPayDemOrder(order)
    ? loadDacsFixedPricePayDemCommitmentResultV1(context, order)
    : loadDacsFixedPriceX402CommitmentResultV1(context, order);
  const retained = loadRetainedOrder(context, order);
  if (retained === undefined || retained.localBindingHash !== order.localBindingHash ||
      commitment.commitment.recordKind !== "finality") {
    throw new DacsFixedPriceX402SellerFulfilmentError(
      "seller-fulfilment-audit-authority-invalid",
    );
  }
  const application = captureDacsFixedPriceX402ApplicationV1(retained.application);
  const paymentKind = order.protocol.phase;
  if (payment.jobId !== order.jobId ||
      payment.railId !== order.protocol.rail.railId ||
      payment.commitment.ref !== commitment.commitment.logicalAddress ||
      payment.commitment.contentHash !== contentHash(
        commitment.commitment.record as unknown as Record<string, unknown>,
      ) || payment.commitment.finalizedAt !== commitment.commitment.committedAt ||
      payment.evidenceInput.observedAt < commitment.commitment.committedAt ||
      payment.phaseIndex !== 2 || application.listing.pipeline.length !== 4 ||
      application.listing.pipeline[payment.phaseIndex]?.kind !== paymentKind) {
    throw new DacsFixedPriceX402SellerFulfilmentError(
      "seller-fulfilment-audit-binding-invalid",
    );
  }
  const agreementHash = contentHash(
    commitment.agreement as unknown as Record<string, unknown>,
  );
  const negotiationDelta = {
    "negotiate-fixed-price": {
      agreementHash,
      agreementRef: {
        anchor: {
          kind: "storage-program" as const,
          locator: fixedPriceAgreementLogicalAddress(order.jobId),
        },
        contentHash: agreementHash,
        signer: order.buyer,
      },
    },
  };
  const commitmentDelta = {
    "commit-payee-bound-agreement": {
      agreementHash,
      anchorTxRef: copy(commitment.commitment.anchorTxRef),
      anchorReceipt: copy(commitment.commitment.anchorReceipt),
      committedAt: commitment.commitment.committedAt,
    },
  };
  const commitmentRef = agreementCommitmentRef(order, commitment);
  const sessionRecord: SellerFulfilmentSessionRecord = {
    recordVersion: "1",
    jobId: order.jobId,
    state: "settle-pending",
    listingRef: copy(payment.listingRef),
    parties: [
      {
        role: "buyer",
        bundleHash: commitment.agreement.parties.find((party) =>
          party.role === "buyer")!.bundleHash,
        primaryClaim: order.buyer,
        vetRecordRef: copy(session.buyerVetRef),
      },
      {
        role: "seller",
        bundleHash: commitment.agreement.parties.find((party) =>
          party.role === "seller")!.bundleHash,
        primaryClaim: order.seller,
        vetRecordRef: copy(sellerVet.recordRef),
      },
      {
        role: "orchestrator",
        bundleHash: commitment.agreement.parties.find((party) =>
          party.role === "seller")!.bundleHash,
        primaryClaim: order.seller,
      },
    ],
    pipeline: copy(application.listing.pipeline),
    phaseResults: [
      {
        index: 0,
        step: copy(application.listing.pipeline[0]!),
        invokedAt: commitment.agreement.generatedAt,
        result: { ok: true, contextDelta: copy(negotiationDelta) },
        contextDelta: copy(negotiationDelta),
      },
      {
        index: 1,
        step: copy(application.listing.pipeline[1]!),
        invokedAt: commitment.commitment.committedAt,
        result: {
          ok: true,
          txRefs: [copy(commitment.commitment.anchorTxRef)],
          attestationRef: copy(commitmentRef),
          anchorReceipt: copy(commitment.commitment.anchorReceipt),
          contextDelta: copy(commitmentDelta),
        },
        contextDelta: copy(commitmentDelta),
      },
      {
        index: payment.phaseIndex,
        step: copy(application.listing.pipeline[payment.phaseIndex]!),
        invokedAt: payment.evidenceInput.observedAt,
        result: {
          ok: true,
          txRefs: copy(payment.evidenceInput.paymentTxRefs),
          contextDelta: {},
        },
        contextDelta: {},
      },
    ],
    startedAt: commitment.agreement.generatedAt,
    lastUpdatedAt: payment.evidenceInput.observedAt,
    recipeRegistryVersion: input.recipeRegistryVersion,
    railRegistryVersion: payment.railRegistryVersion,
  };
  return deepFreeze({
    sourceVersion: "1" as const,
    session: sessionRecord,
    artifacts: {
      agreementCommitment: commitmentRef,
      vetRecords: [copy(session.buyerVetRef), copy(sellerVet.recordRef)],
      vetRequirements: [
        {
          vetRecordRef: copy(session.buyerVetRef),
          evaluatedParty: order.buyer,
          requirement: copy(application.listing.buyerRequirement),
          verifier: order.seller,
          freshness: [],
          dealSpecific: [],
        },
        {
          vetRecordRef: copy(sellerVet.recordRef),
          evaluatedParty: order.seller,
          requirement: copy(DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1),
          verifier: order.buyer,
          freshness: [],
          dealSpecific: [],
        },
      ],
      settlementEvidence: [settlementEvidenceRef(payment, order.seller)],
    },
    provenanceProfile: "dacs-sdk-operational-v1" as const,
  });
}

function finalReceipt(input: Readonly<{
  fulfilmentId: string;
  authorizationBinding: unknown;
  resultHash: string;
}>) {
  return Object.freeze({
    receiptVersion: "1" as const,
    kind: "seller-fulfilment-final" as const,
    fulfilmentId: input.fulfilmentId,
    authorizationBindingHash: sha256Hex(canonicalize(input.authorizationBinding)),
    resultHash: input.resultHash,
  });
}

/**
 * Compose the production seller fulfilment dependencies for the generated v1
 * public-storage profile. No caller can choose an anchor name, evidence signer,
 * payment authority, or retry identity.
 */
export function createDacsFixedPriceSellerFulfilmentV1(
  options: Readonly<DacsFixedPriceSellerFulfilmentOptionsV1>,
): Readonly<DacsFixedPriceSellerFulfilmentV1> {
  if (!plainObject(options) || !plainObject(options.context) ||
      options.context.role !== "seller" || !plainObject(options.authority) ||
      typeof options.workerId !== "string" || options.workerId.length === 0 ||
      !safePositive(options.recipeRegistryVersion) ||
      (options.paymentProfile !== "x402" && options.paymentProfile !== "pay-dem") ||
      (options.leaseTtlMs !== undefined &&
        !safePositive(options.leaseTtlMs, 600_000)) ||
      typeof options.prepareDeliverable !== "function") {
    throw new TypeError("fixed-price seller fulfilment options are invalid");
  }
  const context = options.context;
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const paymentProfile = options.paymentProfile;

  const resolveByLogicalAddress = async (logicalAddress: string) =>
    resolvePublicAnchor(context, logicalAddress);

  const fulfilmentDeps: Omit<DurableSellerFulfilmentDeps, "receiptStore"> = {
    auditSourceProfile: "v2",
    resolveAgreement: (ref) => options.authority.resolveFulfilmentAgreement(ref),
    resolveListing: (ref) => options.authority.resolveFulfilmentListing(ref),
    async resolveAuditSource(jobId) {
      try {
        const order = await loadOrder(context, jobId, paymentProfile);
        const paymentPhaseIndex = 2;
        const payment = isPayDemOrder(order)
          ? (await loadDacsPayDemSellerPaymentAuthorizationForOrderV1(
              context,
              order,
            )).authorization
          : loadDacsSellerX402AuthorizationForOrderV1(
              context,
              order,
              paymentPhaseIndex,
            ).paymentAuthorization;
        return { status: "verified" as const, value: buildAuditSource({
          context,
          order,
          payment,
          recipeRegistryVersion: options.recipeRegistryVersion,
        }) };
      } catch {
        return { status: "indeterminate" as const,
          reason: "seller-fulfilment-audit-source-unavailable" };
      }
    },
    async prepareDelivery(input) {
      if (input.phase !== "deliver-storage-program" ||
          input.deliverable.kind !== "storage-program" ||
          (input.deliverable.accessModel !== undefined &&
            input.deliverable.accessModel !== "public") ||
          input.deliverable.schemaUrl !== undefined) {
        return { status: "rejected" as const,
          reason: "generated seller supports only schema-free public storage delivery" };
      }
      try {
        const order = await loadOrder(context, input.jobId, paymentProfile);
        const retained = loadRetainedOrder(context, order);
        if (retained === undefined || retained.localBindingHash !== order.localBindingHash) {
          throw new Error("retained order unavailable");
        }
        const application = captureDacsFixedPriceX402ApplicationV1(retained.application);
        const id = preparedId(input.jobId, input.fulfilmentId);
        const existing = context.database.loadEffectInput("fulfilment", id);
        let record: Readonly<PreparedRecordV1>;
        if (existing !== undefined) {
          record = capturePrepared(existing);
        } else {
          const payload = await options.prepareDeliverable(deepFreeze({
            fulfilmentId: input.fulfilmentId,
            jobId: input.jobId,
            request: copy(application.request),
            agreement: copy(input.agreement),
            listing: {
              pin: copy(input.agreement.listingPin),
              sellerPrimaryClaim: input.agreement.seller.primaryClaim,
              buyerRequirement: copy(application.listing.buyerRequirement),
              pipeline: copy(application.listing.pipeline),
              deliverable: copy(application.listing.offering.deliverable),
            },
          }));
          if (!plainObject(payload)) throw new Error("deliverable must be a JSON object");
          const capturedPayload = copy(payload);
          record = deepFreeze({
            preparedVersion: PREPARED_VERSION,
            fulfilmentId: input.fulfilmentId,
            jobId: input.jobId,
            localBindingHash: order.localBindingHash,
            requestHash: application.requestHash,
            payloadHash: sha256Hex(canonicalize(capturedPayload)),
            payload: capturedPayload,
          });
          const put = context.database.putEffectIntent({
            kind: "fulfilment",
            effectId: id,
            bindingHash: order.localBindingHash,
            input: record,
            idempotencyKey: id,
            jobId: input.jobId,
          });
          if (put.status === "conflict") throw new Error("prepared payload conflict");
          record = capturePrepared(context.database.loadEffectInput("fulfilment", id));
        }
        if (record.fulfilmentId !== input.fulfilmentId || record.jobId !== input.jobId ||
            record.localBindingHash !== order.localBindingHash ||
            record.requestHash !== application.requestHash) {
          throw new Error("prepared payload binding mismatch");
        }
        return {
          status: "prepared" as const,
          delivery: {
            artifact: {
              kind: "deliver-storage-program" as const,
              cleartextPayload: copy(record.payload),
              anchoredValue: copy(record.payload),
              access: { model: "public" as const },
            },
          },
        };
      } catch {
        return { status: "indeterminate" as const,
          reason: "seller application deliverable preparation unavailable" };
      }
    },
    async submitDelivery(input) {
      if (input.phase !== "deliver-storage-program" ||
          !plainObject(input.artifact.anchoredValue)) {
        return { status: "rejected" as const, reason: "delivery artifact unsupported" };
      }
      const published = await publishPublicAnchor(
        context,
        input.jobId,
        input.logicalAddress,
        input.artifact.anchoredValue,
        contentHash(input.artifact.anchoredValue),
      );
      return published.status === "present"
        ? { status: "accepted" as const, reconciliationId: published.receipt.nativeAddress }
        : { status: "indeterminate" as const, reason: published.status === "absent"
          ? "delivery publication not yet visible" : published.reason };
    },
    async reconcileDelivery(input) {
      const logicalAddress = input.phase === "deliver-entitlement"
        ? `dacs4:entitlement:${input.jobId}:0`
        : `dacs4:deliverable:${input.jobId}`;
      const resolved = await resolveByLogicalAddress(logicalAddress);
      if (resolved.status === "absent") {
        return { status: "absent" as const, reason: "delivery-authoritatively-absent" };
      }
      if (resolved.status !== "present") {
        return { status: "indeterminate" as const, reason: resolved.reason,
          ...(input.reconciliationId === undefined
            ? {} : { reconciliationId: input.reconciliationId }) };
      }
      return {
        status: "complete" as const,
        reconciliationId: resolved.receipt.nativeAddress,
        observedAt: resolved.receipt.blockRef?.timestamp ?? resolved.receipt.observedAt,
      };
    },
    async resolveDelivery(input) {
      const resolved = await resolvePublicAnchor(context, input.logicalAddress);
      if (resolved.status !== "present") {
        return { status: "indeterminate" as const,
          reason: resolved.status === "absent" ? "delivery-anchor-absent" : resolved.reason };
      }
      return {
        status: "verified" as const,
        value: {
          artifact: {
            kind: "deliver-storage-program" as const,
            cleartextPayload: copy(resolved.raw),
            anchoredValue: copy(resolved.raw),
            access: { model: "public" as const },
          },
          anchorReceipt: copy(resolved.receipt),
        },
      };
    },
    async verifyAnchorReceipt({ expectedWriter, ref, receipt }) {
      if (expectedWriter.primaryClaim !== context.authority ||
          ref.anchor.kind !== "storage-program" ||
          receipt.writer !== context.authority ||
          receipt.logicalAddress !== ref.anchor.locator ||
          receipt.contentHash !== ref.contentHash ||
          receipt.observationDisposition !== "established" ||
          (receipt.state !== "included" && receipt.state !== "finalized")) {
        return { disposition: "invalid" as const, reason: "anchor receipt binding invalid" };
      }
      try {
        const raw = await context.demos.adapter.readAnchor(receipt.nativeAddress);
        return raw !== null && contentHash(raw) === ref.contentHash &&
            await context.demos.adapter.verifyDemosAnchorReceipt(receipt) === true
          ? { disposition: "valid" as const }
          : { disposition: "invalid" as const, reason: "anchor receipt proof invalid" };
      } catch {
        return { disposition: "error" as const, reason: "anchor receipt proof unavailable" };
      }
    },
    evidenceSigner: {
      algorithm: "ed25519",
      signer: context.authority,
      sign: (bytes) => context.demos.adapter.sign(bytes),
    },
    auditSourceCommitmentSigner: {
      algorithm: "ed25519",
      signer: context.authority,
      sign: (bytes) => context.demos.adapter.sign(bytes),
    },
    verifyEvidenceSignature: ({ signedBytes, signature, expectedSigner }) => {
      const verified = verifyComponent(
        expectedSigner,
        signature.algorithm,
        signature.value,
        signedBytes,
      );
      return verified === "valid"
        ? { disposition: "valid" as const }
        : { disposition: verified === "error" ? "error" as const : "invalid" as const,
          reason: "delivery evidence signature invalid" };
    },
    verifyAuditSourceCommitmentSignature: ({ signedBytes, signature, expectedSigner }) => {
      const verified = verifyComponent(
        expectedSigner,
        signature.algorithm,
        signature.value,
        signedBytes,
      );
      return verified === "valid"
        ? { disposition: "valid" as const }
        : { disposition: verified === "error" ? "error" as const : "invalid" as const,
          reason: "audit source commitment signature invalid" };
    },
    async anchorEvidence(input) {
      const logicalAddress = `dacs4:delivery-evidence:${input.evidence.jobId}`;
      const raw = input.evidence as unknown as Readonly<Record<string, unknown>>;
      const published = await publishPublicAnchor(
        context,
        input.evidence.jobId,
        logicalAddress,
        raw,
        input.evidenceHash,
      );
      if (published.status !== "present") {
        return { status: "indeterminate" as const,
          reason: published.status === "absent"
            ? "delivery evidence not yet visible" : published.reason };
      }
      return {
        status: "anchored" as const,
        ref: {
          anchor: { kind: "storage-program" as const, locator: logicalAddress },
          contentHash: input.evidenceHash,
          signer: context.authority,
        },
        anchorReceipt: copy(published.receipt),
      };
    },
    async resolveEvidence(ref) {
      if (ref.anchor.kind !== "storage-program") {
        return { status: "rejected" as const, reason: "evidence anchor kind invalid" };
      }
      const resolved = await resolvePublicAnchor(
        context,
        ref.anchor.locator,
        ref.contentHash,
      );
      return resolved.status === "present"
        ? { status: "verified" as const,
          value: copy(resolved.raw) as unknown as SignedSellerDeliveryEvidence }
        : { status: "indeterminate" as const,
          reason: resolved.status === "absent" ? "delivery evidence absent" : resolved.reason };
    },
    nowMs: () => context.database.readTime(),
  };

  const fulfilmentDurability: Omit<
    SellerFulfilmentDurability,
    "store" | "workerId"
  > = {
    leaseTtlMs,
    leaseNowMs: () => context.database.readTime(),
    reconcilePayloadAttestation: async () => ({
      status: "absent" as const,
      reason: "public-storage-delivery-has-no-payload-attestation",
    }),
    async reconcileDeliverySubmission(input) {
      if (!plainObject(input.artifact.anchoredValue)) {
        return { status: "absent" as const, reason: "delivery-artifact-unsupported" };
      }
      const expectedHash = contentHash(input.artifact.anchoredValue);
      const resolved = await resolvePublicAnchor(context, input.logicalAddress, expectedHash);
      if (resolved.status === "absent") {
        return { status: "absent" as const, reason: "delivery-authoritatively-absent" };
      }
      if (resolved.status !== "present") {
        return { status: "indeterminate" as const, reason: resolved.reason };
      }
      return canonicalize(resolved.raw) === canonicalize(input.artifact.anchoredValue)
        ? { status: "accepted" as const,
          reconciliationId: resolved.receipt.nativeAddress }
        : { status: "indeterminate" as const, reason: "delivery-envelope-conflict" };
    },
    async reconcileEvidencePublication(input) {
      const logicalAddress = `dacs4:delivery-evidence:${input.evidence.jobId}`;
      const resolved = await resolvePublicAnchor(
        context,
        logicalAddress,
        input.evidenceHash,
      );
      if (resolved.status === "absent") {
        return { status: "absent" as const,
          reason: "delivery-evidence-authoritatively-absent" };
      }
      if (resolved.status !== "present" ||
          canonicalize(resolved.raw) !== canonicalize(input.evidence)) {
        return { status: "indeterminate" as const,
          reason: resolved.status === "present"
            ? "delivery-evidence-envelope-conflict" : resolved.reason };
      }
      return {
        status: "anchored" as const,
        ref: {
          anchor: { kind: "storage-program" as const, locator: logicalAddress },
          contentHash: input.evidenceHash,
          signer: context.authority,
        },
        anchorReceipt: copy(resolved.receipt),
      };
    },
    async publishFinalSessionReceipt(input) {
      return { status: "recorded" as const, receipt: finalReceipt(input) };
    },
    async reconcileFinalSessionReceipt(input) {
      return { status: "recorded" as const, receipt: finalReceipt(input) };
    },
  };

  return Object.freeze({
    fulfilmentDeps: Object.freeze(fulfilmentDeps),
    fulfilmentDurability: Object.freeze(fulfilmentDurability),
  });
}

/** Backward-compatible x402-only composition. */
export function createDacsFixedPriceX402SellerFulfilmentV1(
  options: Readonly<DacsFixedPriceX402SellerFulfilmentOptionsV1>,
): Readonly<DacsFixedPriceX402SellerFulfilmentV1> {
  return createDacsFixedPriceSellerFulfilmentV1({
    ...options,
    paymentProfile: "x402",
  });
}
