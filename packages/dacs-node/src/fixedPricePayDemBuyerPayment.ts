import {
  getAuthenticatedRailProvenance,
  isAuthenticatedRailDefinition,
  type AuthenticatedRailDefinition,
  type DemosTransferObservation,
} from "@kynesyslabs/dacs";
import { isAgreementArtifact } from "@kynesyslabs/dacs/artifacts";
import { baseUnits, canonicalize, contentHash, sha256Hex } from
  "@kynesyslabs/dacs/canonical";
import { canonicalDemosAgentPublicKey } from "@kynesyslabs/dacs/identity";

import {
  captureDacsGuardedPlanV1,
  type DacsGuardedPayDemPurchasePlanV1,
} from "./guardedCommands.js";
import {
  captureDacsFixedPriceX402ApplicationV1,
  ensureDacsFixedPriceBuyerCommitmentV1,
} from "./fixedPriceX402Profile.js";
import {
  loadDacsFixedPricePayDemBuyerAgreementPublicationV1,
} from "./fixedPricePayDemProfile.js";
import { DacsLiveEffectInputControlError } from "./liveEffects.js";
import type {
  DacsPayDemBuyerChainReconciliationV1,
  DacsPayDemBuyerPaymentAuthorityV1,
  DacsPayDemBuyerPaymentTrackOptionsV1,
} from "./payDemPayment.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";
import {
  loadDacsPayDemBuyerSessionAgreementFactsForOrderV1,
} from "./sessionBootstrapAgreementRuntime.js";

const INTEGER_RE = /^[1-9][0-9]*$/;

export interface DacsFixedPricePayDemBuyerPaymentOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  rail: Readonly<AuthenticatedRailDefinition>;
}

export interface DacsFixedPricePayDemBuyerPaymentV1 {
  resolveAuthority: DacsPayDemBuyerPaymentTrackOptionsV1["resolveAuthority"];
}

export class DacsFixedPricePayDemBuyerPaymentError extends Error {
  override readonly name = "DacsFixedPricePayDemBuyerPaymentError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function walletAddress(claim: string): string | null {
  const key = canonicalDemosAgentPublicKey(claim);
  return key === null ? null : Buffer.from(key).toString("hex");
}

function loadPlan(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  jobId: string,
  requestHash: string,
): Readonly<DacsGuardedPayDemPurchasePlanV1> {
  const effectId = `purchase:${jobId}:${requestHash}`;
  const captured = captureDacsGuardedPlanV1(
    context.database.loadEffectInput("payment", effectId),
  );
  if (captured?.kind !== "purchase-pay-dem" || captured.effectId !== effectId ||
      captured.jobId !== jobId || captured.requestHash !== requestHash) {
    throw new DacsFixedPricePayDemBuyerPaymentError(
      "pay-dem-purchase-authority-missing",
    );
  }
  return captured;
}

/**
 * Bind the irreversible native transfer to the consented purchase plan, the
 * authenticated rail registry entry, and the final anchored Agreement.
 */
export function createDacsFixedPricePayDemBuyerPaymentV1(
  options: Readonly<DacsFixedPricePayDemBuyerPaymentOptionsV1>,
): Readonly<DacsFixedPricePayDemBuyerPaymentV1> {
  const context = options?.context;
  const rail = options?.rail;
  const provenance = getAuthenticatedRailProvenance(rail);
  if (context?.role !== "buyer" || context.demos.payDem === undefined ||
      !isAuthenticatedRailDefinition(rail) || provenance === null ||
      rail.railType !== "demos-native" || rail.phaseHandler !== "pay-dem" ||
      rail.availability !== "live" || rail.asset.kind !== "native-dem" ||
      rail.asset.symbol !== "DEM" || rail.asset.decimals !== 9 ||
      rail.network.kind !== "demos") {
    throw new TypeError("fixed-price pay-dem buyer payment options are invalid");
  }
  const payDemRail = context.demos.payDem.rail;

  const resolveAuthority: DacsFixedPricePayDemBuyerPaymentV1["resolveAuthority"] =
    async ({ operation, retained }) => {
      try {
        const application = captureDacsFixedPriceX402ApplicationV1(retained.application);
        const agreement = await loadDacsFixedPricePayDemBuyerAgreementPublicationV1(
          context,
          operation.order,
        );
        const session = loadDacsPayDemBuyerSessionAgreementFactsForOrderV1(
          context,
          operation.order,
        );
        const commitment = await ensureDacsFixedPriceBuyerCommitmentV1({
          context,
          operation,
          retained,
          application,
          agreement,
          session,
        });
        const artifact = agreement.artifact;
        if (!isAgreementArtifact(artifact) ||
            !("payeeBoundAgreementVersion" in artifact)) {
          throw new DacsFixedPricePayDemBuyerPaymentError(
            "pay-dem-agreement-invalid",
          );
        }
        const phaseIndexes = application.listing.pipeline.flatMap((phase, index) =>
          phase.kind === "pay-dem" ? [index] : []);
        const selectedRails = application.listing.acceptedRails?.filter((candidate) =>
          candidate.railId === rail.railId && candidate.railVersion === rail.railVersion) ?? [];
        const phaseIndex = phaseIndexes[0];
        const selected = selectedRails[0];
        const payout = phaseIndex === undefined || !("payoutBindings" in artifact.terms)
          ? []
          : artifact.terms.payoutBindings.filter((candidate) =>
              candidate.railId === rail.railId && candidate.phaseIndex === phaseIndex);
        const binding = payout[0];
        const payee = typeof selected?.parameters?.payTo === "string"
          ? selected.parameters.payTo : undefined;
        const payer = walletAddress(operation.order.buyer);
        const seller = walletAddress(operation.order.seller);
        const plan = loadPlan(context, operation.order.jobId, application.requestHash);
        let amountOs: string;
        let maxTotalDebitOs: string;
        try {
          amountOs = baseUnits(artifact.terms.price.amount, 9);
          maxTotalDebitOs = baseUnits(plan.maximumTotalDebitDem, 9);
        } catch {
          throw new DacsFixedPricePayDemBuyerPaymentError(
            "pay-dem-payment-amount-invalid",
          );
        }
        if (operation.order.role !== "buyer" || retained.role !== "buyer" ||
            retained.jobId !== operation.order.jobId ||
            retained.localBindingHash !== operation.order.localBindingHash ||
            operation.order.buyer !== context.authority ||
            operation.order.seller !== context.peerAuthority ||
            operation.order.protocol.phase !== "pay-dem" ||
            operation.order.protocol.rail.railId !== rail.railId ||
            operation.order.protocol.rail.railVersion !== rail.railVersion ||
            operation.order.protocol.rail.registryIndexHash !== provenance.indexContentHash ||
            operation.order.protocol.rail.railDefinitionHash !==
              provenance.definitionContentHash ||
            phaseIndexes.length !== 1 || phaseIndex !== 2 ||
            application.listing.pipeline.length !== 4 ||
            selectedRails.length !== 1 || selected === undefined ||
            selected.parameters?.network !== "demos" ||
            payout.length !== 1 || binding === undefined ||
            typeof payee !== "string" || payer === null || seller === null ||
            payee !== seller || binding.payeeAddress !== payee ||
            artifact.jobId !== operation.order.jobId ||
            artifact.terms.price.currency !== "DEM" ||
            agreement.agreementHash !== contentHash(
              artifact as unknown as Record<string, unknown>,
            ) || commitment.agreementHash !== agreement.agreementHash ||
            context.database.readTime() > artifact.terms.deadline ||
            plan.listingRef !== application.listingRef ||
            plan.buyerAuthority !== operation.order.buyer ||
            plan.sellerAuthority !== operation.order.seller ||
            plan.payer !== payer || plan.payee !== payee ||
            plan.railId !== rail.railId || plan.serviceAmount !== artifact.terms.price.amount ||
            !INTEGER_RE.test(amountOs) || !INTEGER_RE.test(maxTotalDebitOs) ||
            BigInt(maxTotalDebitOs) < BigInt(amountOs) ||
            payDemRail.address.toLowerCase().replace(/^0x/, "") !== payer) {
          throw new DacsFixedPricePayDemBuyerPaymentError(
            "pay-dem-payment-authority-invalid",
          );
        }
        return Object.freeze({
          authorityVersion: "1" as const,
          jobId: operation.order.jobId,
          phaseIndex,
          railId: rail.railId,
          railVersion: rail.railVersion,
          railDescriptorHash: provenance.definitionContentHash,
          network: "demos" as const,
          payer,
          payee,
          amountOs,
          maxTotalDebitOs,
          agreementHash: agreement.agreementHash,
          termsHash: sha256Hex(canonicalize(artifact.terms)),
          payoutBindingHash: sha256Hex(canonicalize(binding)),
        }) satisfies Readonly<DacsPayDemBuyerPaymentAuthorityV1>;
      } catch (cause) {
        if (cause instanceof DacsLiveEffectInputControlError) throw cause;
        throw new DacsLiveEffectInputControlError(
          cause instanceof DacsFixedPricePayDemBuyerPaymentError &&
              cause.reasonCode.endsWith("-missing")
            ? "pending-retry" : "operator-action",
          cause instanceof DacsFixedPricePayDemBuyerPaymentError
            ? cause.reasonCode : "pay-dem-payment-authority-invalid",
        );
      }
    };
  return Object.freeze({ resolveAuthority });
}

/**
 * Reconcile only the exact signed hash retained before broadcast. Absence of a
 * prepared checkpoint is a local proof that the rail never reached broadcast;
 * a missing chain result after preparation remains indeterminate forever.
 */
export function createDacsFixedPricePayDemBuyerReconciliationV1(
  observeDemosTransfer: (txHash: string) => Promise<DemosTransferObservation>,
): DacsPayDemBuyerPaymentTrackOptionsV1["reconcile"] {
  if (typeof observeDemosTransfer !== "function") {
    throw new TypeError("pay-dem buyer reconciliation requires a Demos observer");
  }
  return async ({ payment, prepared, fence }): Promise<
    DacsPayDemBuyerChainReconciliationV1
  > => {
    await fence.assertCurrent();
    if (prepared === undefined) {
      return Object.freeze({
        status: "absent" as const,
        absenceProofHash: sha256Hex(canonicalize({
          disposition: "no-prepared-transfer",
          settlementKey: payment.settlementKey,
          orderLocalBindingHash: payment.orderLocalBindingHash,
        })),
      });
    }
    let observation: DemosTransferObservation;
    try {
      observation = await observeDemosTransfer(prepared.txHash);
      await fence.assertCurrent();
    } catch {
      return Object.freeze({ status: "indeterminate" as const,
        reasonCode: "pay-dem-chain-observation-unavailable" });
    }
    if (observation.status === "included") {
      if (observation.txHash !== prepared.txHash ||
          observation.payer !== payment.payer || observation.payee !== payment.payee ||
          observation.amountOs !== payment.amountOs) {
        return Object.freeze({ status: "operator-action" as const,
          reasonCode: "pay-dem-chain-observation-conflict" });
      }
      return Object.freeze({
        status: "completed" as const,
        settlement: Object.freeze({
          ok: true,
          txHash: observation.txHash,
          chainId: "demos",
          payer: observation.payer,
          payee: observation.payee,
          finality: Object.freeze({ model: "bft-final" as const }),
          blockNumber: observation.blockNumber,
          txRefKind: "demos" as const,
          amountOs: observation.amountOs,
        }),
      });
    }
    if (observation.status === "failed" || observation.status === "invalid") {
      return Object.freeze({ status: "operator-action" as const,
        reasonCode: "pay-dem-prepared-transfer-invalid" });
    }
    return Object.freeze({ status: "indeterminate" as const,
      reasonCode: "pay-dem-prepared-transfer-pending" });
  };
}
