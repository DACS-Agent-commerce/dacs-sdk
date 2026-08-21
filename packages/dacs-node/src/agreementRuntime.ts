import {
  advanceFixedPriceAgreementDurable,
  respondToFixedPriceAgreementProposalDurable,
  type DurableAnchoredFixedPriceAgreement,
  type DurableFixedPriceAgreementDurability,
  type DurableSellerFixedPriceAgreementDurability,
  type DurableSellerFixedPriceAgreementResponse,
  type FixedPriceAgreementAnchorProvider,
  type FixedPriceAgreementContributionVerifier,
  type FixedPriceAgreementTransport,
  type FixedPriceAgreementTransportIdentity,
  type FixedPriceAgreementProposal,
  type FixedPriceX402ErrorClass,
  type FixedPriceX402FaultedParty,
  type FixedPriceX402TrackOperation,
  type FixedPriceX402TrackOperationInput,
  type FixedPriceX402TrackOperationResult,
  type SellerFixedPriceAgreementContributionTransport,
  type UnsignedAgreementArtifact,
} from "@kynesyslabs/dacs";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";

import {
  loadDacsLiveOrderInputForTrackV1,
  type DacsLiveOrderInputV1,
} from "./orderInput.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";

const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_LEASE_TTL_MS = 120_000;
const REASON_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

export type DacsAgreementRejectionDecisionV1 = Readonly<
  | { disposition: "operator-action"; reasonCode: string }
  | {
      disposition: "failure";
      errorClass: FixedPriceX402ErrorClass;
      faultedParty: FixedPriceX402FaultedParty;
      reference: string;
    }
>;

interface DacsAgreementRuntimeOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  workerId: string;
  leaseTtlMs?: number;
  retryDelayMs?: number;
}

export interface DacsBuyerAgreementTrackOptionsV1
  extends DacsAgreementRuntimeOptionsV1 {
  buildDraft(input: Readonly<{
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
  }>): Promise<Readonly<UnsignedAgreementArtifact>> |
    Readonly<UnsignedAgreementArtifact>;
  verifyContribution: FixedPriceAgreementContributionVerifier;
  reconcileBuyerSignature: DurableFixedPriceAgreementDurability["reconcileBuyerSignature"];
  transport: Readonly<FixedPriceAgreementTransport>;
  anchor: Readonly<FixedPriceAgreementAnchorProvider>;
  authorizeAnchored(input: Readonly<{
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
    result: Readonly<DurableAnchoredFixedPriceAgreement>;
  }>): Promise<boolean> | boolean;
  classifyRejected?: (input: Readonly<{
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
    stage: string;
    reasonCode: string;
  }>) => Promise<Readonly<DacsAgreementRejectionDecisionV1>> |
    Readonly<DacsAgreementRejectionDecisionV1>;
}

export interface DacsSellerAgreementTrackOptionsV1
  extends DacsAgreementRuntimeOptionsV1 {
  resolveProposal(input: Readonly<{
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
  }>): Promise<Readonly<{
    proposal: Readonly<FixedPriceAgreementProposal>;
    transportIdentity: Readonly<FixedPriceAgreementTransportIdentity>;
  }>> | Readonly<{
    proposal: Readonly<FixedPriceAgreementProposal>;
    transportIdentity: Readonly<FixedPriceAgreementTransportIdentity>;
  }>;
  resolveAuthenticatedAgreementContext:
    DurableSellerFixedPriceAgreementDurability["resolveAuthenticatedAgreementContext"];
  verifyContribution: FixedPriceAgreementContributionVerifier;
  reconcileSellerSignature:
    DurableSellerFixedPriceAgreementDurability["reconcileSellerSignature"];
  transport: Readonly<SellerFixedPriceAgreementContributionTransport>;
  authorizeComplete(input: Readonly<{
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
    result: Readonly<DurableSellerFixedPriceAgreementResponse>;
  }>): Promise<boolean> | boolean;
  classifyRejected?: DacsBuyerAgreementTrackOptionsV1["classifyRejected"];
}

export class DacsAgreementRuntimeError extends Error {
  override readonly name = "DacsAgreementRuntimeError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
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

function positiveInteger(value: unknown, fallback: number): number {
  const captured = value ?? fallback;
  if (!Number.isSafeInteger(captured) || Number(captured) <= 0 ||
      Number(captured) > 600_000) {
    throw new TypeError("agreement runtime timing is invalid");
  }
  return Number(captured);
}

function reasonCode(prefix: string, stage: unknown, reason: unknown): string {
  const value = `${prefix}-${String(stage)}-${String(reason)}`.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80)
    .replace(/-+$/g, "");
  return value || `${prefix}-unavailable`;
}

function retryAt(context: Readonly<DacsLiveRoleOperationContextV1>, delay: number): number {
  const result = context.database.readTime() + delay;
  if (!Number.isSafeInteger(result)) {
    throw new DacsAgreementRuntimeError("agreement-retry-time-overflow");
  }
  return result;
}

function progressResult(
  status: "pending-retry" | "indeterminate",
  code: string,
  at: number,
): Readonly<FixedPriceX402TrackOperationResult> {
  return Object.freeze({ status, reasonCode: code, retryAt: at });
}

function captureRejection(
  value: unknown,
): Readonly<DacsAgreementRejectionDecisionV1> {
  if (!plainObject(value) || typeof value.disposition !== "string") {
    throw new DacsAgreementRuntimeError("agreement-rejection-decision-invalid");
  }
  if (value.disposition === "operator-action" &&
      Reflect.ownKeys(value).length === 2 &&
      typeof value.reasonCode === "string" && REASON_RE.test(value.reasonCode)) {
    return Object.freeze({
      disposition: "operator-action",
      reasonCode: value.reasonCode,
    });
  }
  const errorClasses = new Set([
    "permanent", "transient", "counterparty", "substrate", "settlement-atomicity",
  ]);
  const parties = new Set(["buyer", "seller", "none"]);
  if (value.disposition === "failure" && Reflect.ownKeys(value).length === 4 &&
      typeof value.errorClass === "string" && errorClasses.has(value.errorClass) &&
      typeof value.faultedParty === "string" && parties.has(value.faultedParty) &&
      typeof value.reference === "string" && value.reference.length > 0 &&
      value.reference.length <= 1_024 && value.reference.trim() === value.reference &&
      ((value.errorClass === "substrate") === (value.faultedParty === "none"))) {
    return Object.freeze(value as unknown as DacsAgreementRejectionDecisionV1);
  }
  throw new DacsAgreementRuntimeError("agreement-rejection-decision-invalid");
}

async function rejectedResult(
  classify: DacsBuyerAgreementTrackOptionsV1["classifyRejected"],
  input: Readonly<{
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
    stage: string;
    reasonCode: string;
  }>,
): Promise<Readonly<FixedPriceX402TrackOperationResult>> {
  if (classify === undefined) {
    return Object.freeze({
      status: "operator-action" as const,
      reasonCode: input.reasonCode,
    });
  }
  let decision: Readonly<DacsAgreementRejectionDecisionV1>;
  try {
    decision = captureRejection(await classify(input));
  } catch {
    return Object.freeze({
      status: "operator-action" as const,
      reasonCode: "agreement-rejection-classification-invalid",
    });
  }
  return decision.disposition === "operator-action"
    ? Object.freeze({ status: "operator-action", reasonCode: decision.reasonCode })
    : Object.freeze({
        status: "final",
        outcome: "failure",
        errorClass: decision.errorClass,
        faultedParty: decision.faultedParty,
        reference: decision.reference,
      });
}

function commonOptions(options: Readonly<DacsAgreementRuntimeOptionsV1>): Readonly<{
  context: Readonly<DacsLiveRoleOperationContextV1>;
  workerId: string;
  leaseTtlMs: number;
  retryDelayMs: number;
}> {
  if (!plainObject(options) || !plainObject(options.context) ||
      typeof options.workerId !== "string" || options.workerId.length === 0 ||
      options.workerId.trim() !== options.workerId) {
    throw new TypeError("agreement runtime options are invalid");
  }
  return Object.freeze({
    context: options.context,
    workerId: options.workerId,
    leaseTtlMs: positiveInteger(options.leaseTtlMs, DEFAULT_LEASE_TTL_MS),
    retryDelayMs: positiveInteger(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS),
  });
}

export function createDacsBuyerAgreementTrackV1(
  options: Readonly<DacsBuyerAgreementTrackOptionsV1>,
): FixedPriceX402TrackOperation {
  const common = commonOptions(options);
  if (common.context.role !== "buyer" || common.context.demos.role !== "buyer" ||
      typeof common.context.demos.signComponent !== "function" ||
      typeof options.buildDraft !== "function" ||
      typeof options.verifyContribution !== "function" ||
      typeof options.reconcileBuyerSignature !== "function" ||
      !plainObject(options.transport) || !plainObject(options.anchor) ||
      typeof options.transport.publishProposal !== "function" ||
      typeof options.transport.reconcileProposalPublication !== "function" ||
      typeof options.transport.resolveSellerContributions !== "function" ||
      typeof options.anchor.anchorAgreement !== "function" ||
      typeof options.anchor.reconcileAgreementAnchor !== "function" ||
      typeof options.anchor.verifyAnchorReceipt !== "function" ||
      typeof options.authorizeAnchored !== "function") {
    throw new TypeError("buyer agreement track options are invalid");
  }
  if ((options.anchor.publishBinding === undefined) !==
      (options.anchor.reconcileBindingPublication === undefined)) {
    throw new TypeError("buyer agreement binding callbacks are incomplete");
  }

  return async (operation) => {
    if (operation.fence.track !== "agreement" || operation.fence.role !== "buyer") {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "buyer-agreement-track-binding-mismatch",
      });
    }
    let retained: Readonly<DacsLiveOrderInputV1>;
    let draft: Readonly<UnsignedAgreementArtifact>;
    try {
      retained = loadDacsLiveOrderInputForTrackV1(operation, common.context.database);
      draft = await options.buildDraft({ operation, retained });
      await operation.fence.assertCurrent();
    } catch {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "buyer-agreement-input-invalid",
      });
    }
    const durability: DurableFixedPriceAgreementDurability = {
      store: common.context.sessionStore,
      workerId: common.workerId,
      leaseTtlMs: common.leaseTtlMs,
      verifyContribution: options.verifyContribution,
      reconcileBuyerSignature: async (input, fence) => {
        await operation.fence.assertCurrent();
        return options.reconcileBuyerSignature(input, fence);
      },
      transport: {
        publishProposal: async (proposal, identity, fence) => {
          await operation.fence.assertCurrent();
          return options.transport.publishProposal(proposal, identity, fence);
        },
        reconcileProposalPublication: async (identity, fence) => {
          await operation.fence.assertCurrent();
          return options.transport.reconcileProposalPublication(identity, fence);
        },
        resolveSellerContributions: (identity) =>
          options.transport.resolveSellerContributions(identity),
      },
      anchor: {
        anchorAgreement: async (input, fence) => {
          await operation.fence.assertCurrent();
          return options.anchor.anchorAgreement(input, fence);
        },
        reconcileAgreementAnchor: async (input, fence) => {
          await operation.fence.assertCurrent();
          return options.anchor.reconcileAgreementAnchor(input, fence);
        },
        verifyAnchorReceipt: (input) => options.anchor.verifyAnchorReceipt(input),
        ...(options.anchor.publishBinding === undefined
          ? {}
          : {
              publishBinding: async (binding, fence) => {
                await operation.fence.assertCurrent();
                return options.anchor.publishBinding!(binding, fence);
              },
              reconcileBindingPublication: async (binding, fence) => {
                await operation.fence.assertCurrent();
                return options.anchor.reconcileBindingPublication!(binding, fence);
              },
            }),
      },
    };
    let progress: Awaited<ReturnType<typeof advanceFixedPriceAgreementDurable>>;
    try {
      progress = await advanceFixedPriceAgreementDurable({
        draft,
        buyer: {
          party: common.context.authority,
          algorithm: "ed25519",
          sign: async (bytes, signatureContext) => {
            await operation.fence.assertCurrent();
            return common.context.demos.signComponent(bytes, {
              algorithm: signatureContext.algorithm,
              signer: signatureContext.party,
            });
          },
        },
      }, durability);
    } catch {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "buyer-agreement-runtime-failed",
      });
    }
    const code = reasonCode("buyer-agreement", "stage" in progress ? progress.stage : "complete",
      "reason" in progress ? progress.reason : "complete");
    if (progress.disposition === "waiting") {
      return progressResult("pending-retry", code,
        retryAt(common.context, common.retryDelayMs));
    }
    if (progress.disposition === "indeterminate") {
      return progressResult("indeterminate", code,
        retryAt(common.context, common.retryDelayMs));
    }
    if (progress.disposition === "rejected") {
      return rejectedResult(options.classifyRejected, {
        operation,
        retained,
        stage: progress.stage,
        reasonCode: code,
      });
    }
    if (progress.disposition !== "anchored") {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "buyer-agreement-progress-invalid",
      });
    }
    try {
      await operation.fence.assertCurrent();
      if (progress.result.agreement.jobId !== operation.order.jobId ||
          await options.authorizeAnchored({
            operation,
            retained,
            result: progress.result,
          }) !== true) {
        throw new Error();
      }
      return Object.freeze({
        status: "final" as const,
        outcome: "success" as const,
        reference: progress.result.agreementRef.anchor.locator,
        authenticationHash: progress.result.agreementHash,
      });
    } catch {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "buyer-agreement-result-unauthorized",
      });
    }
  };
}

export function createDacsSellerAgreementTrackV1(
  options: Readonly<DacsSellerAgreementTrackOptionsV1>,
): FixedPriceX402TrackOperation {
  const common = commonOptions(options);
  if (common.context.role !== "seller" || common.context.demos.role !== "seller" ||
      typeof common.context.demos.signComponent !== "function" ||
      typeof options.resolveProposal !== "function" ||
      typeof options.resolveAuthenticatedAgreementContext !== "function" ||
      typeof options.verifyContribution !== "function" ||
      typeof options.reconcileSellerSignature !== "function" ||
      !plainObject(options.transport) ||
      typeof options.transport.publishSellerContribution !== "function" ||
      typeof options.transport.reconcileSellerContributionPublication !== "function" ||
      typeof options.authorizeComplete !== "function") {
    throw new TypeError("seller agreement track options are invalid");
  }

  return async (operation) => {
    if (operation.fence.track !== "agreement" || operation.fence.role !== "seller") {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "seller-agreement-track-binding-mismatch",
      });
    }
    let retained: Readonly<DacsLiveOrderInputV1>;
    let resolved: Awaited<ReturnType<DacsSellerAgreementTrackOptionsV1["resolveProposal"]>>;
    try {
      retained = loadDacsLiveOrderInputForTrackV1(operation, common.context.database);
      resolved = await options.resolveProposal({ operation, retained });
      await operation.fence.assertCurrent();
    } catch {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "seller-agreement-input-invalid",
      });
    }
    let progress: Awaited<ReturnType<typeof respondToFixedPriceAgreementProposalDurable>>;
    try {
      progress = await respondToFixedPriceAgreementProposalDurable({
        proposal: resolved.proposal,
        transportIdentity: resolved.transportIdentity,
        seller: {
          party: common.context.authority,
          algorithm: "ed25519",
          sign: async (bytes, signatureContext) => {
            await operation.fence.assertCurrent();
            return common.context.demos.signComponent(bytes, {
              algorithm: signatureContext.algorithm,
              signer: signatureContext.party,
            });
          },
        },
      }, {
        store: common.context.sessionStore,
        workerId: common.workerId,
        leaseTtlMs: common.leaseTtlMs,
        resolveAuthenticatedAgreementContext: options.resolveAuthenticatedAgreementContext,
        verifyContribution: options.verifyContribution,
        reconcileSellerSignature: async (input, fence) => {
          await operation.fence.assertCurrent();
          return options.reconcileSellerSignature(input, fence);
        },
        transport: {
          publishSellerContribution: async (contribution, identity, fence) => {
            await operation.fence.assertCurrent();
            return options.transport.publishSellerContribution(contribution, identity, fence);
          },
          reconcileSellerContributionPublication: async (identity, fence) => {
            await operation.fence.assertCurrent();
            return options.transport.reconcileSellerContributionPublication(identity, fence);
          },
        },
      });
    } catch {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "seller-agreement-runtime-failed",
      });
    }
    const code = reasonCode("seller-agreement", "stage" in progress ? progress.stage : "complete",
      "reason" in progress ? progress.reason : "complete");
    if (progress.disposition === "waiting") {
      return progressResult("pending-retry", code,
        retryAt(common.context, common.retryDelayMs));
    }
    if (progress.disposition === "indeterminate") {
      return progressResult("indeterminate", code,
        retryAt(common.context, common.retryDelayMs));
    }
    if (progress.disposition === "rejected") {
      return rejectedResult(options.classifyRejected, {
        operation,
        retained,
        stage: progress.stage,
        reasonCode: code,
      });
    }
    if (progress.disposition !== "complete") {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "seller-agreement-progress-invalid",
      });
    }
    try {
      await operation.fence.assertCurrent();
      if (progress.result.transportIdentity.jobId !== operation.order.jobId ||
          progress.result.transportIdentity.buyer !== operation.order.buyer ||
          progress.result.transportIdentity.seller !== operation.order.seller ||
          await options.authorizeComplete({
            operation,
            retained,
            result: progress.result,
          }) !== true) {
        throw new Error();
      }
      return Object.freeze({
        status: "final" as const,
        outcome: "success" as const,
        reference: `agreement-response:${progress.result.transportIdentity.proposalHash}`,
        authenticationHash: sha256Hex(canonicalize(progress.result)),
      });
    } catch {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "seller-agreement-result-unauthorized",
      });
    }
  };
}
