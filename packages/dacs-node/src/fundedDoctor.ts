import {
  demosWriteEvidenceToAnchorReceipt,
  type ProtocolAnchorReceipt,
} from "@kynesyslabs/dacs";
import { isReadableAnchorReceipt } from "@kynesyslabs/dacs/artifacts";
import { canonicalize, canonicalizeDecimal, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { isCanonicalJobId } from "@kynesyslabs/dacs/negotiate";

import type { DacsDemosActorRuntimeV1 } from "./demosRuntime.js";
import {
  createDacsFundedDoctorPlanV1,
  type DacsFundedDoctorPlanV1,
  type DacsGuardedExecutorV1,
} from "./guardedCommands.js";

export const DACS_FUNDED_DOCTOR_SMOKE_SCHEMA = "dacs-funded-doctor-smoke/v1" as const;

export interface DacsFundedDoctorSmokeArtifactV1 {
  schema: typeof DACS_FUNDED_DOCTOR_SMOKE_SCHEMA;
  runId: string;
  disposableWallet: string;
  walletAuthority: string;
  network: string;
}

export interface DacsPreparedFundedDoctorV1 {
  artifact: Readonly<DacsFundedDoctorSmokeArtifactV1>;
  logicalAddress: string;
  contentHash: string;
  plan: Readonly<DacsFundedDoctorPlanV1>;
}

export interface DacsPrepareFundedDoctorOptionsV1 {
  runId: string;
  disposableWallet: string;
  walletAuthority: string;
  network: string;
  actionMaximumDebitDem: string;
  maximumTotalDebitDem: string;
}

export interface DacsFundedDoctorExecutorOptionsV1 {
  prepared: Readonly<DacsPreparedFundedDoctorV1>;
  runtime: Readonly<DacsDemosActorRuntimeV1>;
}

export class DacsFundedDoctorError extends Error {
  override readonly name = "DacsFundedDoctorError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function positiveDecimal(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 ||
      value.trim() !== value || value.startsWith("-")) return false;
  try {
    const canonical = canonicalizeDecimal(value);
    return canonical === value && /[1-9]/u.test(canonical);
  } catch {
    return false;
  }
}

function preparedCopy(value: Readonly<DacsPreparedFundedDoctorV1>):
  Readonly<DacsPreparedFundedDoctorV1> {
  try {
    return JSON.parse(canonicalize(value)) as DacsPreparedFundedDoctorV1;
  } catch {
    throw new TypeError("funded doctor preparation is invalid");
  }
}

function receiptFor(
  receipt: unknown,
  prepared: Readonly<DacsPreparedFundedDoctorV1>,
): Readonly<ProtocolAnchorReceipt> | undefined {
  if (!isReadableAnchorReceipt(receipt) || receipt.substrate !== "demos" ||
      receipt.logicalAddress !== prepared.logicalAddress ||
      receipt.contentHash !== prepared.contentHash ||
      receipt.writer !== prepared.plan.walletAuthority) return undefined;
  return receipt;
}

/**
 * Bind one disposable-wallet Storage Program smoke to a separate consent
 * domain and a whole-run DEM debit ceiling. A fresh invocation receives a new
 * run ID; recovery must explicitly retain the original ID and exact cap.
 */
export function prepareDacsFundedDoctorV1(
  options: Readonly<DacsPrepareFundedDoctorOptionsV1>,
): Readonly<DacsPreparedFundedDoctorV1> {
  if (options === null || typeof options !== "object" ||
      !isCanonicalJobId(options.runId) ||
      !positiveDecimal(options.actionMaximumDebitDem) ||
      !positiveDecimal(options.maximumTotalDebitDem)) {
    throw new TypeError("funded doctor preparation options are invalid");
  }
  const artifact = Object.freeze({
    schema: DACS_FUNDED_DOCTOR_SMOKE_SCHEMA,
    runId: options.runId,
    disposableWallet: options.disposableWallet,
    walletAuthority: options.walletAuthority,
    network: options.network,
  });
  const contentHash = sha256Hex(canonicalize(artifact));
  const logicalAddress = `dacs:doctor:funded:v1:${options.runId}`;
  const plan = createDacsFundedDoctorPlanV1({
    effectId: `funded-doctor:demos-anchor:${options.runId}`,
    runId: options.runId,
    disposableWallet: options.disposableWallet,
    walletAuthority: options.walletAuthority,
    network: options.network,
    debits: [{
      actionId: "demos-anchor",
      asset: "DEM",
      maximumDebit: options.actionMaximumDebitDem,
    }],
    ceilings: [{ asset: "DEM", maximumTotalDebit: options.maximumTotalDebitDem }],
  });
  return Object.freeze({ artifact, logicalAddress, contentHash, plan });
}

/**
 * Execute exactly one funded Demos write. Reconciliation is read-only: an
 * absent result is returned as an authenticated local absence decision and is
 * never converted into another debit. The operator must authorize a fresh run
 * ID before another broadcast can occur.
 */
export function createDacsFundedDoctorExecutorV1(
  options: Readonly<DacsFundedDoctorExecutorOptionsV1>,
): DacsGuardedExecutorV1 {
  if (options === null || typeof options !== "object" ||
      options.runtime === null || typeof options.runtime !== "object" ||
      (options.runtime.role !== "buyer" && options.runtime.role !== "seller")) {
    throw new TypeError("funded doctor executor options are invalid");
  }
  const prepared = preparedCopy(options.prepared);
  if (prepared.artifact.schema !== DACS_FUNDED_DOCTOR_SMOKE_SCHEMA ||
      sha256Hex(canonicalize(prepared.artifact)) !== prepared.contentHash ||
      prepared.artifact.runId !== prepared.plan.runId ||
      prepared.artifact.disposableWallet !== prepared.plan.disposableWallet ||
      prepared.artifact.walletAuthority !== prepared.plan.walletAuthority ||
      prepared.artifact.network !== prepared.plan.network ||
      prepared.logicalAddress !== `dacs:doctor:funded:v1:${prepared.plan.runId}` ||
      options.runtime.authority !== prepared.plan.walletAuthority) {
    throw new TypeError("funded doctor preparation is inconsistent");
  }
  const expectedPlan = canonicalize(prepared.plan);

  async function resolveRetained(): Promise<Readonly<ProtocolAnchorReceipt> |
    "absent" | "indeterminate" | "conflict"> {
    let resolved;
    try {
      resolved = await options.runtime.adapter.resolveAnchorByName(
        prepared.logicalAddress,
        prepared.plan.walletAuthority,
      );
    } catch {
      return "indeterminate";
    }
    if (resolved.status === "absent") return "absent";
    if (resolved.status !== "present") return "indeterminate";
    let artifact;
    try {
      artifact = await options.runtime.adapter.readAnchor(resolved.address);
    } catch {
      return "indeterminate";
    }
    if (artifact === null || canonicalize(artifact) !== canonicalize(prepared.artifact)) {
      return "conflict";
    }
    let receipt;
    try {
      receipt = await options.runtime.adapter.resolveDemosAnchorReceipt({
        logicalAddress: prepared.logicalAddress,
        nativeAddress: resolved.address,
        contentHash: prepared.contentHash,
        writer: prepared.plan.walletAuthority,
      });
      const captured = receiptFor(receipt, prepared);
      if (captured === undefined ||
          await options.runtime.adapter.verifyDemosAnchorReceipt(captured) !== true) {
        return "indeterminate";
      }
      return captured;
    } catch {
      return "indeterminate";
    }
  }

  return async ({ plan, fence }) => {
    if (plan.kind !== "funded-doctor" || canonicalize(plan) !== expectedPlan) {
      return Object.freeze({ status: "operator-action" as const,
        reasonCode: "funded-doctor-plan-mismatch" });
    }
    if (fence.mode === "reconcile") {
      const retained = await resolveRetained();
      await fence.assertCurrent();
      if (retained === "absent") {
        return Object.freeze({
          status: "reconciled-absent" as const,
          absenceProofHash: sha256Hex(canonicalize({
            logicalAddress: prepared.logicalAddress,
            writer: prepared.plan.walletAuthority,
            state: "absent",
          })),
        });
      }
      if (retained === "conflict") {
        return Object.freeze({ status: "operator-action" as const,
          reasonCode: "funded-doctor-anchor-conflict" });
      }
      if (retained === "indeterminate") {
        return Object.freeze({ status: "reconciled-indeterminate" as const,
          reasonCode: "funded-doctor-reconciliation-indeterminate" });
      }
      return Object.freeze({ status: "reconciled-performed" as const,
        result: { receipt: retained } });
    }

    try {
      await fence.assertCurrent();
      const anchored = await options.runtime.adapter.anchorWriteOnce(
        prepared.logicalAddress,
        prepared.artifact,
        { metadata: {
          logicalAddress: prepared.logicalAddress,
          contentHash: prepared.contentHash,
          envelopeHash: prepared.contentHash,
        } },
      );
      let receipt: ProtocolAnchorReceipt | null;
      if (anchored.demosEvidence !== undefined) {
        receipt = demosWriteEvidenceToAnchorReceipt({
          evidence: anchored.demosEvidence,
          logicalAddress: prepared.logicalAddress,
          contentHash: prepared.contentHash,
          writer: prepared.plan.walletAuthority,
        });
      } else {
        receipt = await options.runtime.adapter.resolveDemosAnchorReceipt({
          logicalAddress: prepared.logicalAddress,
          nativeAddress: anchored.address,
          contentHash: prepared.contentHash,
          writer: prepared.plan.walletAuthority,
        });
      }
      const captured = receiptFor(receipt, prepared);
      if (captured === undefined) {
        return Object.freeze({ status: "ambiguous" as const,
          reasonCode: "funded-doctor-receipt-unavailable" });
      }
      await fence.assertCurrent();
      if (await options.runtime.adapter.verifyDemosAnchorReceipt(captured) !== true) {
        return Object.freeze({ status: "ambiguous" as const,
          reasonCode: "funded-doctor-receipt-unverified" });
      }
      await fence.assertCurrent();
      return Object.freeze({ status: "completed" as const,
        result: { receipt: captured } });
    } catch {
      return Object.freeze({ status: "ambiguous" as const,
        reasonCode: "funded-doctor-reconciliation-required" });
    }
  };
}
