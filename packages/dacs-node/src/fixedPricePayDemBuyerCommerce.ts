import {
  baseUnits,
  verifySettlementEvidence,
  type AuthenticatedRailDefinition,
  type DemosTransferObservation,
} from "@kynesyslabs/dacs";
import { isAgreementArtifact, isSettlementEvidence } from
  "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import { canonicalDemosAgentPublicKey } from "@kynesyslabs/dacs/identity";

import {
  loadDacsFixedPricePayDemBuyerAgreementPublicationV1,
} from "./fixedPricePayDemProfile.js";
import type { DacsPayDemBuyerReceivedRuntimeOptionsV1 } from
  "./payDemBuyerReceivedRuntime.js";
import { loadDacsPayDemBuyerPaymentForOrderV1 } from "./payDemPayment.js";
import type { DacsBuyerDemosPaymentEvidenceRuntimeOptionsV1 } from
  "./paymentEvidenceRuntime.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";

const DID_PREFIX = "did:demos:agent:";

export interface DacsFixedPricePayDemBuyerCommerceOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  rail: Readonly<AuthenticatedRailDefinition>;
  observeDemosTransfer(txHash: string): Promise<DemosTransferObservation>;
  retryDelayMs?: number;
}

export interface DacsFixedPricePayDemBuyerCommerceV1 {
  paymentEvidence: Omit<
    DacsBuyerDemosPaymentEvidenceRuntimeOptionsV1,
    "context" | "workerId"
  >;
  buyerReceived: Omit<DacsPayDemBuyerReceivedRuntimeOptionsV1, "context">;
}

function verifier() {
  return Object.freeze({
    async resolvePublicKey(signer: string) {
      const raw = canonicalDemosAgentPublicKey(signer);
      return raw === null ? null : Uint8Array.from(raw);
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

function owner(claim: string): string {
  if (!claim.startsWith(DID_PREFIX) || claim.length !== DID_PREFIX.length + 64) {
    throw new TypeError("pay-dem buyer peer authority is invalid");
  }
  return claim.slice(DID_PREFIX.length);
}

async function verifyPeerAnchor(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  logicalAddress: string,
  expectedHash?: string,
): Promise<Readonly<{
  artifact: Readonly<Record<string, unknown>>;
  attestationRef: Readonly<{
    anchor: Readonly<{ kind: "storage-program"; locator: string }>;
    contentHash: string;
    signer: string;
  }>;
}> | null> {
  const resolved = await context.demos.adapter.resolveAnchorByName(
    logicalAddress,
    owner(context.peerAuthority),
  );
  if (resolved.status !== "present") return null;
  const artifact = await context.demos.adapter.readAnchor(resolved.address);
  if (artifact === null) return null;
  const hash = contentHash(artifact);
  if (expectedHash !== undefined && hash !== expectedHash) return null;
  const receipt = await context.demos.adapter.resolveDemosAnchorReceipt({
    logicalAddress,
    nativeAddress: resolved.address,
    contentHash: hash,
    writer: context.peerAuthority,
  });
  return receipt !== null && receipt.writer === context.peerAuthority &&
      receipt.logicalAddress === logicalAddress &&
      receipt.nativeAddress === resolved.address && receipt.contentHash === hash &&
      receipt.observationDisposition === "established" &&
      (receipt.state === "included" || receipt.state === "finalized") &&
      await context.demos.adapter.verifyDemosAnchorReceipt(receipt) === true
    ? Object.freeze({
        artifact,
        attestationRef: Object.freeze({
          anchor: Object.freeze({ kind: "storage-program" as const, locator: logicalAddress }),
          contentHash: hash,
          signer: context.peerAuthority,
        }),
      }) : null;
}

/** Native PC-7 and buyer-received policy over authenticated Demos facts. */
export function createDacsFixedPricePayDemBuyerCommerceV1(
  options: Readonly<DacsFixedPricePayDemBuyerCommerceOptionsV1>,
): Readonly<DacsFixedPricePayDemBuyerCommerceV1> {
  const context = options?.context;
  const rail = options?.rail;
  if (context?.role !== "buyer" || context.commerceStores.role !== "buyer" ||
      rail?.railType !== "demos-native" || rail.phaseHandler !== "pay-dem" ||
      rail.asset.kind !== "native-dem" || rail.asset.symbol !== "DEM" ||
      rail.asset.decimals !== 9 || rail.network.kind !== "demos" ||
      typeof options.observeDemosTransfer !== "function") {
    throw new TypeError("fixed-price pay-dem buyer commerce options are invalid");
  }
  const railContext = Object.freeze({
    railId: rail.railId,
    railType: rail.railType,
    asset: "DEM",
    network: "demos",
    handler: "pay-dem",
  });

  const paymentEvidence: DacsFixedPricePayDemBuyerCommerceV1["paymentEvidence"] = {
    async verifyEvidence(request) {
      try {
        const loaded = await context.database.createPayDemCoordinatorStore("buyer")
          .load("buyer", request.jobId);
        if (loaded.status !== "ok" || loaded.record.buyer !== context.authority ||
            loaded.record.seller !== context.peerAuthority ||
            request.evidence.signature.signer !== context.peerAuthority) {
          return { disposition: "invalid" as const,
            reason: "payment evidence actor binding invalid" };
        }
        const agreement = await loadDacsFixedPricePayDemBuyerAgreementPublicationV1(
          context,
          loaded.record,
        );
        const payment = loadDacsPayDemBuyerPaymentForOrderV1(context, loaded.record);
        const settlement = payment.result.settlement;
        const observed = await options.observeDemosTransfer(settlement.txHash);
        const txRef = request.evidence.paymentTxRefs?.[0];
        const finality = request.evidence.settlementFinality;
        const artifact = agreement.artifact;
        if (!isAgreementArtifact(artifact) ||
            !("payeeBoundAgreementVersion" in artifact)) {
          return { disposition: "invalid" as const,
            reason: "payment evidence agreement invalid" };
        }
        let amountOs: string;
        try {
          amountOs = baseUnits(artifact.terms.price.amount, 9);
        } catch {
          return { disposition: "invalid" as const,
            reason: "payment evidence amount invalid" };
        }
        if (request.evidence.phase !== "pay-dem" ||
            request.evidence.outcome !== "success" || txRef?.kind !== "demos" ||
            finality?.model !== "bft-final" || observed.status !== "included" ||
            txRef.txHash !== settlement.txHash ||
            txRef.blockNumber !== settlement.blockNumber ||
            observed.txHash !== settlement.txHash ||
            observed.blockNumber !== settlement.blockNumber ||
            observed.payer !== payment.payment.payer ||
            observed.payee !== payment.payment.payee || observed.amountOs !== amountOs ||
            finality.finalityObservedAt !== observed.includedAt ||
            request.evidence.paymentAmount.amount !== artifact.terms.price.amount ||
            request.evidence.paymentAmount.currency !== "DEM") {
          return { disposition: observed.status === "failed" || observed.status === "invalid"
            ? "invalid" as const : "indeterminate" as const,
          reason: "payment evidence settlement binding invalid" };
        }
        const verified = await verifySettlementEvidence(request.evidence, {
          orchestrator: context.peerAuthority,
          agreement: { amount: artifact.terms.price.amount, currency: "DEM" },
          rail: railContext,
          attestationRef: {
            anchor: { kind: "storage-program", locator: request.logicalAddress },
            contentHash: request.evidenceHash,
            signer: context.peerAuthority,
          },
          paymentAddress: {
            railId: loaded.record.protocol.rail.railId,
            phaseIndex: 2,
            resolved: false,
          },
          result: {
            ok: true,
            txRefs: [{
              kind: "demos",
              txHash: settlement.txHash,
              blockNumber: settlement.blockNumber,
            }],
          },
        }, verifier());
        return verified.decision === "pass"
          ? { disposition: "valid" as const }
          : {
              disposition: verified.decision === "indeterminate"
                ? "indeterminate" as const : "invalid" as const,
              reason: "payment evidence cryptographic verification failed",
            };
      } catch {
        return { disposition: "indeterminate" as const,
          reason: "payment evidence verification unavailable" };
      }
    },
  };

  const buyerReceived: DacsFixedPricePayDemBuyerCommerceV1["buyerReceived"] = {
    async authorizeReceived({ operation, record, payload }) {
      try {
        const evidenceAnchor = await verifyPeerAnchor(
          context,
          `dacs4:delivery-evidence:${operation.order.jobId}`,
        );
        if (evidenceAnchor === null) return "indeterminate" as const;
        const evidenceRaw = evidenceAnchor.artifact;
        if (!isSettlementEvidence(evidenceRaw) ||
            evidenceRaw.jobId !== operation.order.jobId ||
            evidenceRaw.phase !== "deliver-storage-program" ||
            evidenceRaw.outcome !== "success" ||
            evidenceRaw.signature.signer !== context.peerAuthority ||
            evidenceRaw.deliverableAnchor.locator !== record.logicalAddress ||
            evidenceRaw.deliverableContentHash !== record.contentHash ||
            contentHash(payload) !== evidenceRaw.deliverableContentHash) return false;
        const agreement = await loadDacsFixedPricePayDemBuyerAgreementPublicationV1(
          context,
          operation.order,
        );
        const artifact = agreement.artifact;
        if (!isAgreementArtifact(artifact) ||
            !("payeeBoundAgreementVersion" in artifact)) return false;
        const verification = await verifySettlementEvidence(evidenceRaw, {
          orchestrator: context.peerAuthority,
          agreement: {
            amount: artifact.terms.price.amount,
            currency: artifact.terms.price.currency,
          },
          attestationRef: evidenceAnchor.attestationRef,
          result: { ok: true },
          expectedAnchorLocator: record.logicalAddress,
        }, verifier());
        return verification.decision === "indeterminate"
          ? "indeterminate" as const
          : verification.decision === "pass";
      } catch {
        return "indeterminate" as const;
      }
    },
    ...(options.retryDelayMs === undefined
      ? {} : { retryDelayMs: options.retryDelayMs }),
  };
  return Object.freeze({
    paymentEvidence: Object.freeze(paymentEvidence),
    buyerReceived: Object.freeze(buyerReceived),
  });
}
