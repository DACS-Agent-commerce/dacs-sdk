import {
  baseUnits,
  encodeAddressSegment,
  type SettlementEvidence,
  type SellerPaymentIntakeDeps,
  type SellerSessionSettlementPublicationDeps,
  x402Eip3009Nonce,
} from "@kynesyslabs/dacs";
import { isSettlementEvidence } from "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import { canonicalDemosAgentPublicKey } from "@kynesyslabs/dacs/identity";

import type { DacsFixedPriceX402SellerSettlementV1 } from
  "./fixedPriceX402SellerSettlement.js";
import type { DacsSellerPaymentEvidenceRuntimeOptionsV1 } from
  "./paymentEvidenceRuntime.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";
import type { DacsSellerSettlementPublicationTrackOptionsV1 } from
  "./sellerSettlementRuntime.js";
import type { DacsPayDemSellerSettlementPublicationTrackOptionsV1 } from
  "./sellerSettlementRuntime.js";
import { loadDacsSellerX402AuthorizationForOrderV1 } from "./sellerX402Runtime.js";
import { loadDacsPayDemSellerPaymentAuthorizationForOrderV1 } from
  "./payDemSellerPayment.js";

const RECORD_VERSION = "1" as const;
const RECORD_DOMAIN = "dacs-live-seller-payment-evidence:v1:" as const;
const PUBLICATION_DOMAIN = "dacs-live-seller-payment-evidence-publication:v1:" as const;
const HASH_RE = /^[0-9a-f]{64}$/;

function sameEvmAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

interface RetainedEvidenceV1 {
  retainedEvidenceVersion: typeof RECORD_VERSION;
  effectId: string;
  jobId: string;
  localBindingHash: string;
  logicalAddress: string;
  evidenceHash: string;
  evidence: Readonly<SettlementEvidence>;
  expectedWriter: Readonly<{
    role: "phase-orchestrator" | "buyer";
    primaryClaim: string;
  }>;
}

interface RetainedPublicationV1 {
  retainedPublicationVersion: typeof RECORD_VERSION;
  effectId: string;
  localBindingHash: string;
  evidenceHash: string;
  evidenceRef: Readonly<{
    anchor: Readonly<{ kind: string; locator: string }>;
    contentHash: string;
    signer?: string;
  }>;
  anchorReceipt: Readonly<{
    nativeAddress: string;
    logicalAddress: string;
    contentHash: string;
    writer: string;
  }>;
}

export interface DacsFixedPriceX402SellerPaymentEvidenceOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  settlement: Readonly<DacsFixedPriceX402SellerSettlementV1>;
}

export interface DacsFixedPriceX402SellerPaymentEvidenceV1 {
  paymentEvidence: Omit<
    DacsSellerPaymentEvidenceRuntimeOptionsV1,
    "context" | "workerId"
  >;
  settlement: Omit<
    DacsSellerSettlementPublicationTrackOptionsV1,
    "context" | "paymentEvidence"
  >;
}

export interface DacsFixedPricePayDemSellerPaymentEvidenceOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  observeDemosTransfer: SellerPaymentIntakeDeps["observeDemosTransfer"];
}

export interface DacsFixedPricePayDemSellerPaymentEvidenceV1 {
  paymentEvidence: Omit<
    DacsSellerPaymentEvidenceRuntimeOptionsV1,
    "context" | "workerId"
  >;
  settlement: Omit<
    DacsPayDemSellerSettlementPublicationTrackOptionsV1,
    "context" | "paymentEvidence"
  >;
}

export class DacsFixedPriceX402SellerPaymentEvidenceError extends Error {
  override readonly name = "DacsFixedPriceX402SellerPaymentEvidenceError";

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

function recordId(effectId: string): string {
  return sha256Hex(RECORD_DOMAIN + effectId);
}

function publicationId(effectId: string): string {
  return sha256Hex(PUBLICATION_DOMAIN + effectId);
}

function captureRecord(value: unknown): Readonly<RetainedEvidenceV1> {
  if (!plainObject(value) || Object.keys(value).length !== 8 ||
      value.retainedEvidenceVersion !== RECORD_VERSION ||
      typeof value.effectId !== "string" || value.effectId.length === 0 ||
      typeof value.jobId !== "string" || value.jobId.length === 0 ||
      typeof value.localBindingHash !== "string" || !HASH_RE.test(value.localBindingHash) ||
      typeof value.logicalAddress !== "string" || value.logicalAddress.length === 0 ||
      typeof value.evidenceHash !== "string" || !HASH_RE.test(value.evidenceHash) ||
      !isSettlementEvidence(value.evidence) || !plainObject(value.expectedWriter) ||
      (value.expectedWriter.role !== "buyer" &&
        value.expectedWriter.role !== "phase-orchestrator") ||
      typeof value.expectedWriter.primaryClaim !== "string") {
    throw new DacsFixedPriceX402SellerPaymentEvidenceError(
      "seller-payment-evidence-record-corrupt",
    );
  }
  const captured = copy(value) as unknown as RetainedEvidenceV1;
  if (contentHash(captured.evidence as unknown as Record<string, unknown>) !==
      captured.evidenceHash || captured.evidence.jobId !== captured.jobId) {
    throw new DacsFixedPriceX402SellerPaymentEvidenceError(
      "seller-payment-evidence-record-corrupt",
    );
  }
  return deepFreeze(captured);
}

async function loadOrder(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  jobId: string,
) {
  const [x402, payDem] = await Promise.all([
    context.database.createLiveCoordinatorStore("seller").load("seller", jobId),
    context.database.createPayDemCoordinatorStore("seller").load("seller", jobId),
  ]);
  if (x402.status === "ok" && payDem.status === "ok") {
    throw new DacsFixedPriceX402SellerPaymentEvidenceError(
      "seller-payment-evidence-order-profile-conflict",
    );
  }
  const loaded = x402.status === "ok" ? x402 : payDem.status === "ok" ? payDem : undefined;
  if (loaded === undefined) {
    throw new DacsFixedPriceX402SellerPaymentEvidenceError(
      "seller-payment-evidence-order-invalid",
    );
  }
  if (loaded.status !== "ok" || loaded.record.seller !== context.authority ||
      loaded.record.buyer !== context.peerAuthority) {
    throw new DacsFixedPriceX402SellerPaymentEvidenceError(
      "seller-payment-evidence-order-invalid",
    );
  }
  return loaded.record;
}

function loadRecord(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  effectId: string,
): Readonly<RetainedEvidenceV1> | undefined {
  const value = context.database.loadEffectInput(
    "artifact-publication",
    recordId(effectId),
  );
  return value === undefined ? undefined : captureRecord(value);
}

function capturePublication(value: unknown): Readonly<RetainedPublicationV1> {
  if (!plainObject(value) || Object.keys(value).length !== 6 ||
      value.retainedPublicationVersion !== RECORD_VERSION ||
      typeof value.effectId !== "string" || value.effectId.length === 0 ||
      typeof value.localBindingHash !== "string" || !HASH_RE.test(value.localBindingHash) ||
      typeof value.evidenceHash !== "string" || !HASH_RE.test(value.evidenceHash) ||
      !plainObject(value.evidenceRef) || !plainObject(value.anchorReceipt)) {
    throw new DacsFixedPriceX402SellerPaymentEvidenceError(
      "seller-payment-evidence-publication-corrupt",
    );
  }
  const captured = copy(value) as unknown as RetainedPublicationV1;
  if (captured.evidenceRef.contentHash !== captured.evidenceHash ||
      captured.anchorReceipt.contentHash !== captured.evidenceHash ||
      captured.evidenceRef.anchor.locator !== captured.anchorReceipt.logicalAddress) {
    throw new DacsFixedPriceX402SellerPaymentEvidenceError(
      "seller-payment-evidence-publication-corrupt",
    );
  }
  return deepFreeze(captured);
}

function loadPublication(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  effectId: string,
): Readonly<RetainedPublicationV1> | undefined {
  const value = context.database.loadEffectInput(
    "artifact-publication",
    publicationId(effectId),
  );
  return value === undefined ? undefined : capturePublication(value);
}

async function retainPublication(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  effectId: string,
  evidenceRef: RetainedPublicationV1["evidenceRef"],
  anchorReceipt: RetainedPublicationV1["anchorReceipt"],
): Promise<void> {
  const retained = loadRecord(context, effectId);
  if (retained === undefined || retained.evidenceHash !== evidenceRef.contentHash ||
      retained.logicalAddress !== evidenceRef.anchor.locator ||
      anchorReceipt.writer !== retained.expectedWriter.primaryClaim) {
    throw new DacsFixedPriceX402SellerPaymentEvidenceError(
      "seller-payment-evidence-publication-unbound",
    );
  }
  const record: RetainedPublicationV1 = {
    retainedPublicationVersion: RECORD_VERSION,
    effectId,
    localBindingHash: retained.localBindingHash,
    evidenceHash: retained.evidenceHash,
    evidenceRef: copy(evidenceRef),
    anchorReceipt: copy(anchorReceipt),
  };
  const id = publicationId(effectId);
  const put = context.database.putEffectIntent({
    kind: "artifact-publication",
    effectId: id,
    bindingHash: retained.localBindingHash,
    input: record,
    idempotencyKey: id,
    jobId: retained.jobId,
  });
  if (put.status === "conflict") {
    throw new DacsFixedPriceX402SellerPaymentEvidenceError(
      "seller-payment-evidence-publication-conflict",
    );
  }
  const loaded = loadPublication(context, effectId);
  if (loaded === undefined || canonicalize(loaded) !== canonicalize(record)) {
    throw new DacsFixedPriceX402SellerPaymentEvidenceError(
      "seller-payment-evidence-publication-corrupt",
    );
  }
}

async function retainRecord(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  input: Parameters<SellerSessionSettlementPublicationDeps["anchorEvidence"]>[0],
): Promise<void> {
  const order = await loadOrder(context, input.evidence.jobId);
  if (input.expectedWriter.role !== "buyer" ||
      input.expectedWriter.primaryClaim !== order.buyer ||
      input.evidence.signature.signer !== order.seller ||
      contentHash(input.evidence as unknown as Record<string, unknown>) !==
        input.evidenceHash) {
    throw new DacsFixedPriceX402SellerPaymentEvidenceError(
      "seller-payment-evidence-retention-unbound",
    );
  }
  const record: RetainedEvidenceV1 = {
    retainedEvidenceVersion: RECORD_VERSION,
    effectId: input.effectId,
    jobId: order.jobId,
    localBindingHash: order.localBindingHash,
    logicalAddress: input.logicalAddress,
    evidenceHash: input.evidenceHash,
    evidence: copy(input.evidence),
    expectedWriter: copy(input.expectedWriter),
  };
  const id = recordId(input.effectId);
  const put = context.database.putEffectIntent({
    kind: "artifact-publication",
    effectId: id,
    bindingHash: order.localBindingHash,
    input: record,
    idempotencyKey: id,
    jobId: order.jobId,
  });
  if (put.status === "conflict") {
    throw new DacsFixedPriceX402SellerPaymentEvidenceError(
      "seller-payment-evidence-retention-conflict",
    );
  }
  const retained = loadRecord(context, input.effectId);
  if (retained === undefined || retained.localBindingHash !== order.localBindingHash ||
      canonicalize(retained) !== canonicalize(record)) {
    throw new DacsFixedPriceX402SellerPaymentEvidenceError(
      "seller-payment-evidence-retention-corrupt",
    );
  }
}

function evidenceVerifier() {
  return Object.freeze({
    async resolvePublicKey(signer: string) {
      const key = canonicalDemosAgentPublicKey(signer);
      return key === null ? null : Uint8Array.from(key);
    },
    verify(bytes: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) {
      try {
        return ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey));
      } catch {
        return false;
      }
    },
  });
}

/**
 * Compose the all-rail PC-7 seller authoring path with the buyer-owned Demos
 * publication lane. Signed evidence is retained before authenticated HTTP
 * handoff, while native EVM proof is re-read from the canonical observer.
 */
export function createDacsFixedPriceX402SellerPaymentEvidenceV1(
  options: Readonly<DacsFixedPriceX402SellerPaymentEvidenceOptionsV1>,
): Readonly<DacsFixedPriceX402SellerPaymentEvidenceV1> {
  if (!plainObject(options) || !plainObject(options.context) ||
      options.context.role !== "seller" || !plainObject(options.settlement)) {
    throw new TypeError("fixed-price seller payment evidence options are invalid");
  }
  const context = options.context;
  const observer = options.settlement.observer;

  const paymentEvidence: DacsFixedPriceX402SellerPaymentEvidenceV1["paymentEvidence"] = {
    verifyAnchorReceipt: async ({ request, completion }) => {
      if (completion.anchorReceipt.writer !== context.peerAuthority ||
          completion.anchorReceipt.logicalAddress !== request.logicalAddress ||
          completion.anchorReceipt.contentHash !== request.evidenceHash ||
          completion.evidenceRef.anchor.locator !== request.logicalAddress ||
          completion.evidenceRef.contentHash !== request.evidenceHash) {
        return { disposition: "invalid" as const,
          reason: "buyer payment-evidence receipt binding invalid" };
      }
      try {
        const readback = await context.demos.adapter.readAnchor(
          completion.anchorReceipt.nativeAddress,
        );
        return await context.demos.adapter.verifyDemosAnchorReceipt(
          completion.anchorReceipt,
        ) === true && readback !== null &&
            contentHash(readback) === request.evidenceHash &&
            canonicalize(readback) === canonicalize(request.evidence)
          ? { disposition: "valid" as const }
          : { disposition: "indeterminate" as const,
            reason: "buyer payment-evidence receipt unverified" };
      } catch {
        return { disposition: "indeterminate" as const,
          reason: "buyer payment-evidence receipt unavailable" };
      }
    },
  };

  const settlement: DacsFixedPriceX402SellerPaymentEvidenceV1["settlement"] = {
    async resolvePublication({ operation, retained }) {
      const scope = await options.settlement.resolveOrderScope({ operation, retained });
      const authorization = loadDacsSellerX402AuthorizationForOrderV1(
        context,
        operation.order,
        scope.paymentPhaseIndex,
      );
      return {
        request: {
          paymentPermitId: authorization.paymentPermitId,
          authorization: copy(authorization.paymentAuthorization),
        },
        dependencies: {
          anchorWriter: { role: "buyer" as const, primaryClaim: operation.order.buyer },
          evidence: evidenceVerifier(),
          async resolveAuthenticatedNativeProof({ authorization: payment }) {
            if (payment.settlementIdentity.kind !== "evm") {
              return { disposition: "rejected" as const,
                reason: "x402 settlement identity is not EVM" };
            }
            const observed = await observer.observeX402Transfer({
              chainId: payment.settlementIdentity.chainId,
              txHash: payment.settlementIdentity.txHash,
            });
            const retainedFinality = payment.evidenceInput.settlementFinality;
            const session = authorization.sessionAuthorization;
            if (observed.status !== "finalized" ||
                retainedFinality.model !== "block-depth" ||
                observed.chainId !== payment.settlementIdentity.chainId ||
                observed.txHash.toLowerCase() !==
                  payment.settlementIdentity.txHash.toLowerCase() ||
                observed.logIndex !== payment.settlementIdentity.logIndex ||
                observed.includedAt !== payment.settlementIdentity.includedAt ||
                observed.confirmations < retainedFinality.finalityBlocks ||
                observed.finalityObservedAt < retainedFinality.finalityObservedAt ||
                !sameEvmAddress(observed.payer, session.payer) ||
                !sameEvmAddress(observed.payee, session.expected.payTo) ||
                observed.amountBaseUnits !== session.expected.amount ||
                !sameEvmAddress(observed.asset.contract, session.expected.asset) ||
                observed.sessionBinding.kind !== "eip3009" ||
                observed.sessionBinding.nonce !== x402Eip3009Nonce(
                  payment.jobId,
                  payment.phaseIndex,
                )) {
              return {
                disposition: observed.status === "failed"
                  ? "rejected" as const : "indeterminate" as const,
                reason: "authenticated x402 native proof unavailable",
              };
            }
            const artifact = {
              proofVersion: "dacs-x402-evm-event-v1",
              jobId: payment.jobId,
              railId: payment.railId,
              phaseIndex: payment.phaseIndex,
              event: copy(payment.settlementIdentity),
              payer: observed.payer,
              payee: observed.payee,
              amountBaseUnits: observed.amountBaseUnits,
              asset: copy(observed.asset),
              // Retain the authorization's exact authenticated finality floor.
              // A later observer may report a higher block depth or a newer
              // observation time, but those monotonic facts must not change the
              // publication effect identity on replay.
              confirmations: retainedFinality.finalityBlocks,
              finalityObservedAt: retainedFinality.finalityObservedAt,
              sessionBinding: copy(observed.sessionBinding),
            };
            return {
              disposition: "authenticated" as const,
              binding: {
                bindingVersion: "1" as const,
                jobId: payment.jobId,
                railId: payment.railId,
                phaseIndex: payment.phaseIndex,
                phase: payment.evidenceInput.phase,
                evidenceHash: payment.evidenceHash,
                settlementId: payment.settlementId,
                network: "eip155:" + String(payment.settlementIdentity.chainId),
                event: copy(payment.settlementIdentity),
                settlementFinality: copy(payment.evidenceInput.settlementFinality),
              },
              proof: {
                encoding: "jcs" as const,
                kind: "authenticated-x402-event",
                locator: payment.settlementIdentity.txHash.toLowerCase() + ":" +
                  String(payment.settlementIdentity.logIndex),
                artifact,
              },
            };
          },
          async resolveRetainedSignedEvidence(input) {
            const retainedEvidence = loadRecord(context, input.effectId);
            if (retainedEvidence === undefined) return { disposition: "absent" as const };
            const unsigned = Object.fromEntries(Object.entries(
              retainedEvidence.evidence,
            ).filter(([key]) => key !== "signature"));
            if (retainedEvidence.evidenceHash !== input.evidenceHash ||
                retainedEvidence.evidence.signature.signer !== input.expectedSigner ||
                canonicalize(unsigned) !== canonicalize(input.unsignedEvidence)) {
              return { disposition: "rejected" as const,
                reason: "retained payment evidence binding conflict" };
            }
            return {
              disposition: "present" as const,
              effectId: input.effectId,
              evidence: copy(retainedEvidence.evidence),
            };
          },
          async verifyAnchorReceipt({
            effectId,
            expectedWriter,
            evidenceRef,
            anchorReceipt,
          }) {
            if (expectedWriter !== operation.order.buyer ||
                anchorReceipt.writer !== expectedWriter ||
                anchorReceipt.logicalAddress !== evidenceRef.anchor.locator ||
                anchorReceipt.contentHash !== evidenceRef.contentHash) {
              return { disposition: "fail" as const,
                reason: "buyer payment-evidence anchor binding invalid" };
            }
            try {
              const verified = await context.demos.adapter.verifyDemosAnchorReceipt(
                anchorReceipt,
              );
              const readback = verified
                ? await context.demos.adapter.readAnchor(anchorReceipt.nativeAddress)
                : null;
              if (!verified || readback === null ||
                  contentHash(readback) !== evidenceRef.contentHash) {
                return { disposition: "indeterminate" as const,
                  reason: "buyer payment-evidence anchor unverified" };
              }
              const retained = loadRecord(context, effectId);
              if (retained === undefined ||
                  canonicalize(readback) !== canonicalize(retained.evidence)) {
                return { disposition: "fail" as const,
                  reason: "buyer payment-evidence readback conflict" };
              }
              await retainPublication(
                context,
                effectId,
                evidenceRef,
                anchorReceipt,
              );
              return { disposition: "pass" as const };
            } catch {
              return { disposition: "indeterminate" as const,
                reason: "buyer payment-evidence anchor unavailable" };
            }
          },
          async resolveEvidence({ effectId, evidenceRef }) {
            const retainedEvidence = loadRecord(context, effectId);
            const publication = loadPublication(context, effectId);
            if (retainedEvidence === undefined || publication === undefined) {
              return { disposition: "absent" as const };
            }
            if (canonicalize(publication.evidenceRef) !== canonicalize(evidenceRef)) {
              return { disposition: "indeterminate" as const,
                reason: "payment-evidence publication reference conflict" };
            }
            try {
              const readback = await context.demos.adapter.readAnchor(
                publication.anchorReceipt.nativeAddress,
              );
              return readback !== null &&
                  canonicalize(readback) === canonicalize(retainedEvidence.evidence)
                ? { disposition: "present" as const,
                  evidence: copy(retainedEvidence.evidence) }
                : { disposition: "indeterminate" as const,
                  reason: "payment-evidence native readback unavailable" };
            } catch {
              return { disposition: "indeterminate" as const,
                reason: "payment-evidence native readback unavailable" };
            }
          },
        },
      };
    },
    retainSignedEvidence: (input) => retainRecord(context, input),
    async authorizePublished({ operation, retained, evidenceHash, reference }) {
      try {
        const scope = await options.settlement.resolveOrderScope({ operation, retained });
        const authorization = loadDacsSellerX402AuthorizationForOrderV1(
          context,
          operation.order,
          scope.paymentPhaseIndex,
        );
        const payment = authorization.paymentAuthorization;
        return evidenceHash === payment.evidenceHash &&
          reference === "dacs4:payment:" + payment.jobId + ":" +
            encodeAddressSegment(payment.railId) + ":" + String(payment.phaseIndex);
      } catch {
        return false;
      }
    },
  };

  return Object.freeze({
    paymentEvidence: Object.freeze(paymentEvidence),
    settlement: Object.freeze(settlement),
  });
}

/**
 * Compose native DEM settlement authoring with the buyer-owned PC-7 Demos
 * publication lane. The native transfer is re-observed and bound to the exact
 * store-backed authorization before signed evidence can leave the seller.
 */
export function createDacsFixedPricePayDemSellerPaymentEvidenceV1(
  options: Readonly<DacsFixedPricePayDemSellerPaymentEvidenceOptionsV1>,
): Readonly<DacsFixedPricePayDemSellerPaymentEvidenceV1> {
  if (!plainObject(options) || !plainObject(options.context) ||
      options.context.role !== "seller" ||
      typeof options.observeDemosTransfer !== "function") {
    throw new TypeError("fixed-price pay-dem seller payment evidence options are invalid");
  }
  const context = options.context;

  const paymentEvidence: DacsFixedPricePayDemSellerPaymentEvidenceV1[
    "paymentEvidence"
  ] = {
    verifyAnchorReceipt: async ({ request, completion }) => {
      if (completion.anchorReceipt.writer !== context.peerAuthority ||
          completion.anchorReceipt.logicalAddress !== request.logicalAddress ||
          completion.anchorReceipt.contentHash !== request.evidenceHash ||
          completion.evidenceRef.anchor.locator !== request.logicalAddress ||
          completion.evidenceRef.contentHash !== request.evidenceHash) {
        return { disposition: "invalid" as const,
          reason: "buyer payment-evidence receipt binding invalid" };
      }
      try {
        const readback = await context.demos.adapter.readAnchor(
          completion.anchorReceipt.nativeAddress,
        );
        return await context.demos.adapter.verifyDemosAnchorReceipt(
          completion.anchorReceipt,
        ) === true && readback !== null &&
            contentHash(readback) === request.evidenceHash &&
            canonicalize(readback) === canonicalize(request.evidence)
          ? { disposition: "valid" as const }
          : { disposition: "indeterminate" as const,
            reason: "buyer payment-evidence receipt unverified" };
      } catch {
        return { disposition: "indeterminate" as const,
          reason: "buyer payment-evidence receipt unavailable" };
      }
    },
  };

  const settlement: DacsFixedPricePayDemSellerPaymentEvidenceV1["settlement"] = {
    async resolvePublication({ operation }) {
      const recovered = await loadDacsPayDemSellerPaymentAuthorizationForOrderV1(
        context,
        operation.order,
      );
      const authorization = recovered.authorization;
      return {
        request: {
          paymentPermitId: recovered.result.permitId,
          authorization: copy(authorization),
        },
        dependencies: {
          anchorWriter: { role: "buyer" as const, primaryClaim: operation.order.buyer },
          evidence: evidenceVerifier(),
          async resolveAuthenticatedNativeProof({ authorization: payment }) {
            const identity = payment.settlementIdentity;
            const retainedFinality = payment.evidenceInput.settlementFinality;
            const txRef = payment.evidenceInput.paymentTxRefs[0];
            if (identity.kind !== "demos" || retainedFinality.model !== "bft-final" ||
                txRef?.kind !== "demos") {
              return { disposition: "rejected" as const,
                reason: "pay-dem settlement identity is not native Demos" };
            }
            const observed = await options.observeDemosTransfer(identity.txHash);
            const buyerKey = canonicalDemosAgentPublicKey(operation.order.buyer);
            const sellerKey = canonicalDemosAgentPublicKey(operation.order.seller);
            let amountOs: string | undefined;
            try {
              amountOs = payment.evidenceInput.paymentAmount.currency === "DEM"
                ? baseUnits(payment.evidenceInput.paymentAmount.amount, 9)
                : undefined;
            } catch {
              amountOs = undefined;
            }
            if (observed.status !== "included" || buyerKey === null || sellerKey === null ||
                amountOs === undefined || observed.txHash !== identity.txHash ||
                observed.blockNumber !== identity.blockNumber ||
                observed.includedAt !== identity.includedAt ||
                observed.includedAt !== retainedFinality.finalityObservedAt ||
                observed.payer !== Buffer.from(buyerKey).toString("hex") ||
                observed.payee !== Buffer.from(sellerKey).toString("hex") ||
                observed.amountOs !== amountOs || txRef.txHash !== identity.txHash ||
                txRef.blockNumber !== identity.blockNumber) {
              return {
                disposition: observed.status === "failed" || observed.status === "invalid"
                  ? "rejected" as const : "indeterminate" as const,
                reason: "authenticated pay-dem native proof unavailable",
              };
            }
            const artifact = {
              proofVersion: "dacs-pay-dem-transfer-v1",
              jobId: payment.jobId,
              railId: payment.railId,
              phaseIndex: payment.phaseIndex,
              transfer: copy(identity),
              payer: observed.payer,
              payee: observed.payee,
              amountOs: observed.amountOs,
              asset: { kind: "native-dem", symbol: "DEM", decimals: 9 },
              finality: copy(retainedFinality),
            };
            return {
              disposition: "authenticated" as const,
              binding: {
                bindingVersion: "1" as const,
                jobId: payment.jobId,
                railId: payment.railId,
                phaseIndex: payment.phaseIndex,
                phase: payment.evidenceInput.phase,
                evidenceHash: payment.evidenceHash,
                settlementId: payment.settlementId,
                network: "demos",
                event: copy(identity),
                settlementFinality: copy(retainedFinality),
              },
              proof: {
                encoding: "jcs" as const,
                kind: "authenticated-demos-transfer",
                locator: identity.txHash,
                artifact,
              },
            };
          },
          async resolveRetainedSignedEvidence(input) {
            const retainedEvidence = loadRecord(context, input.effectId);
            if (retainedEvidence === undefined) return { disposition: "absent" as const };
            const unsigned = Object.fromEntries(Object.entries(
              retainedEvidence.evidence,
            ).filter(([key]) => key !== "signature"));
            if (retainedEvidence.evidenceHash !== input.evidenceHash ||
                retainedEvidence.evidence.signature.signer !== input.expectedSigner ||
                canonicalize(unsigned) !== canonicalize(input.unsignedEvidence)) {
              return { disposition: "rejected" as const,
                reason: "retained payment evidence binding conflict" };
            }
            return { disposition: "present" as const,
              effectId: input.effectId,
              evidence: copy(retainedEvidence.evidence) };
          },
          async verifyAnchorReceipt({
            effectId,
            expectedWriter,
            evidenceRef,
            anchorReceipt,
          }) {
            if (expectedWriter !== operation.order.buyer ||
                anchorReceipt.writer !== expectedWriter ||
                anchorReceipt.logicalAddress !== evidenceRef.anchor.locator ||
                anchorReceipt.contentHash !== evidenceRef.contentHash) {
              return { disposition: "fail" as const,
                reason: "buyer payment-evidence anchor binding invalid" };
            }
            try {
              const verified = await context.demos.adapter.verifyDemosAnchorReceipt(
                anchorReceipt,
              );
              const readback = verified
                ? await context.demos.adapter.readAnchor(anchorReceipt.nativeAddress)
                : null;
              if (!verified || readback === null ||
                  contentHash(readback) !== evidenceRef.contentHash) {
                return { disposition: "indeterminate" as const,
                  reason: "buyer payment-evidence anchor unverified" };
              }
              const retained = loadRecord(context, effectId);
              if (retained === undefined ||
                  canonicalize(readback) !== canonicalize(retained.evidence)) {
                return { disposition: "fail" as const,
                  reason: "buyer payment-evidence readback conflict" };
              }
              await retainPublication(context, effectId, evidenceRef, anchorReceipt);
              return { disposition: "pass" as const };
            } catch {
              return { disposition: "indeterminate" as const,
                reason: "buyer payment-evidence anchor unavailable" };
            }
          },
          async resolveEvidence({ effectId, evidenceRef }) {
            const retainedEvidence = loadRecord(context, effectId);
            const publication = loadPublication(context, effectId);
            if (retainedEvidence === undefined || publication === undefined) {
              return { disposition: "absent" as const };
            }
            if (canonicalize(publication.evidenceRef) !== canonicalize(evidenceRef)) {
              return { disposition: "indeterminate" as const,
                reason: "payment-evidence publication reference conflict" };
            }
            try {
              const readback = await context.demos.adapter.readAnchor(
                publication.anchorReceipt.nativeAddress,
              );
              return readback !== null &&
                  canonicalize(readback) === canonicalize(retainedEvidence.evidence)
                ? { disposition: "present" as const,
                  evidence: copy(retainedEvidence.evidence) }
                : { disposition: "indeterminate" as const,
                  reason: "payment-evidence native readback unavailable" };
            } catch {
              return { disposition: "indeterminate" as const,
                reason: "payment-evidence native readback unavailable" };
            }
          },
        },
      };
    },
    retainSignedEvidence: (input) => retainRecord(context, input),
    async authorizePublished({ operation, evidenceHash, reference }) {
      try {
        const recovered = await loadDacsPayDemSellerPaymentAuthorizationForOrderV1(
          context,
          operation.order,
        );
        const payment = recovered.authorization;
        return evidenceHash === payment.evidenceHash &&
          reference === "dacs4:payment:" + payment.jobId + ":" +
            encodeAddressSegment(payment.railId) + ":" + String(payment.phaseIndex);
      } catch {
        return false;
      }
    },
  };

  return Object.freeze({
    paymentEvidence: Object.freeze(paymentEvidence),
    settlement: Object.freeze(settlement),
  });
}
