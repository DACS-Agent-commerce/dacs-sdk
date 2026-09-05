import {
  demosWriteEvidenceToAnchorReceipt,
  type ProtocolAnchorReceipt,
} from "@kynesyslabs/dacs";
import { isReadableAnchorReceipt } from "@kynesyslabs/dacs/artifacts";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import type {
  FixedPriceX402CoordinatorRole,
  FixedPriceX402Track,
  FixedPriceX402TrackOperation,
  FixedPriceX402TrackOperationInput,
} from "@kynesyslabs/dacs/commerce";
import type { DacsDemosActorRuntimeV1 } from "./demosRuntime.js";
import {
  createDacsLiveEffectTrackV1,
  type DacsLiveEffectExecutionControlV1,
  type DacsLiveEffectFenceV1,
  type DacsLiveEffectReconciliationV1,
} from "./liveEffects.js";
import type { DacsNodeSqliteDatabase } from "./sqlite.js";

const HASH_RE = /^[0-9a-f]{64}$/;

export interface DacsDemosPublicationDraftV1 {
  logicalAddress: string;
  artifact: Readonly<Record<string, unknown>>;
}

export interface DacsDemosPublicationInputV1 {
  publicationInputVersion: "1";
  orderBindingHash: string;
  orderLocalBindingHash: string;
  writer: string;
  logicalAddress: string;
  contentHash: string;
  artifact: Readonly<Record<string, unknown>>;
}

export interface DacsDemosPublicationResultV1 {
  publicationResultVersion: "1";
  receipt: Readonly<ProtocolAnchorReceipt>;
}

export interface DacsDemosPublicationTrackOptionsV1 {
  database: DacsNodeSqliteDatabase;
  runtime: Readonly<DacsDemosActorRuntimeV1>;
  role: FixedPriceX402CoordinatorRole;
  track: FixedPriceX402Track;
  workerId: string;
  buildPublication(
    input: Readonly<FixedPriceX402TrackOperationInput>,
  ): Promise<Readonly<DacsDemosPublicationDraftV1>> |
    Readonly<DacsDemosPublicationDraftV1>;
  /** Bind the exact artifact and address to independently retained session facts. */
  authorizePublication(input: Readonly<{
    order: Readonly<FixedPriceX402TrackOperationInput["order"]>;
    publication: Readonly<DacsDemosPublicationDraftV1>;
    contentHash: string;
  }>): Promise<boolean> | boolean;
  leaseDurationMs?: number;
  retryDelayMs?: number;
}

export class DacsDemosPublicationError extends Error {
  override readonly name = "DacsDemosPublicationError";

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

function text(value: unknown, maximum = 1_024): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value.trim() === value && !value.includes("\0");
}

function control(reasonCode: string): DacsLiveEffectExecutionControlV1 {
  return Object.freeze({
    effectControlVersion: "1",
    status: "indeterminate",
    reasonCode,
  });
}

function captureInput(value: unknown): Readonly<DacsDemosPublicationInputV1> {
  if (!plainObject(value) || Object.keys(value).length !== 7 ||
      value.publicationInputVersion !== "1" ||
      typeof value.orderBindingHash !== "string" ||
      !HASH_RE.test(value.orderBindingHash) ||
      typeof value.orderLocalBindingHash !== "string" ||
      !HASH_RE.test(value.orderLocalBindingHash) ||
      !text(value.writer) || !text(value.logicalAddress) ||
      typeof value.contentHash !== "string" || !HASH_RE.test(value.contentHash) ||
      !plainObject(value.artifact)) {
    throw new DacsDemosPublicationError("demos-publication-input-invalid");
  }
  let observedHash: string;
  try {
    observedHash = sha256Hex(canonicalize(value.artifact));
  } catch {
    throw new DacsDemosPublicationError("demos-publication-artifact-invalid");
  }
  if (observedHash !== value.contentHash) {
    throw new DacsDemosPublicationError("demos-publication-content-mismatch");
  }
  return value as unknown as Readonly<DacsDemosPublicationInputV1>;
}

function captureReceipt(
  receipt: unknown,
  input: Readonly<DacsDemosPublicationInputV1>,
): Readonly<ProtocolAnchorReceipt> {
  if (!isReadableAnchorReceipt(receipt)) {
    throw new DacsDemosPublicationError("demos-publication-receipt-invalid");
  }
  if (receipt.substrate !== "demos" ||
      receipt.logicalAddress !== input.logicalAddress ||
      receipt.contentHash !== input.contentHash || receipt.writer !== input.writer) {
    throw new DacsDemosPublicationError("demos-publication-receipt-mismatch");
  }
  return receipt;
}

/**
 * Publish one immutable role-owned DACS artifact through the Demos adapter's
 * durable write journal. Reconciliation deliberately re-enters the exact
 * write-once operation: that operation owns cross-process nonce fencing and
 * can return the retained canonical winner without creating a duplicate.
 */
export function createDacsDemosPublicationTrackV1(
  options: Readonly<DacsDemosPublicationTrackOptionsV1>,
): FixedPriceX402TrackOperation {
  if (!plainObject(options) ||
      (options.role !== "buyer" && options.role !== "seller") ||
      !text(options.workerId) || typeof options.track !== "string" ||
      typeof options.buildPublication !== "function" ||
      typeof options.authorizePublication !== "function" ||
      options.runtime === null || typeof options.runtime !== "object" ||
      options.runtime.role !== options.role ||
      typeof options.runtime.adapter?.anchorWriteOnce !== "function" ||
      typeof options.runtime.adapter.verifyDemosAnchorReceipt !== "function" ||
      typeof options.runtime.adapter.resolveDemosAnchorReceipt !== "function" ||
      options.database === null || typeof options.database !== "object" ||
      options.database.metadata.role !== options.role ||
      options.database.metadata.authority !== options.runtime.authority) {
    throw new TypeError("Demos publication track options are invalid");
  }
  const runtime = options.runtime;

  async function publish(
    input: Readonly<DacsDemosPublicationInputV1>,
    fence: Readonly<DacsLiveEffectFenceV1>,
  ): Promise<Readonly<DacsDemosPublicationResultV1> | DacsLiveEffectExecutionControlV1> {
    const captured = captureInput(input);
    if (captured.writer !== runtime.authority ||
        captured.orderLocalBindingHash !== fence.bindingHash ||
        fence.jobId.length === 0) {
      return Object.freeze({
        effectControlVersion: "1" as const,
        status: "operator-action" as const,
        reasonCode: "demos-publication-binding-mismatch",
      });
    }
    try {
      await fence.assertCurrent();
      const anchor = await runtime.adapter.anchorWriteOnce(
        captured.logicalAddress,
        captured.artifact,
        {
          metadata: {
            logicalAddress: captured.logicalAddress,
            contentHash: captured.contentHash,
            envelopeHash: sha256Hex(canonicalize(captured.artifact)),
          },
        },
      );
      let receipt: ProtocolAnchorReceipt | null;
      if (anchor.demosEvidence !== undefined) {
        receipt = demosWriteEvidenceToAnchorReceipt({
          evidence: anchor.demosEvidence,
          logicalAddress: captured.logicalAddress,
          contentHash: captured.contentHash,
          writer: captured.writer,
        });
      } else {
        receipt = await runtime.adapter.resolveDemosAnchorReceipt({
          logicalAddress: captured.logicalAddress,
          nativeAddress: anchor.address,
          contentHash: captured.contentHash,
          writer: captured.writer,
        });
      }
      if (receipt === null) return control("demos-publication-receipt-unavailable");
      const verified = captureReceipt(receipt, captured);
      await fence.assertCurrent();
      if (await runtime.adapter.verifyDemosAnchorReceipt(verified) !== true) {
        return control("demos-publication-receipt-unverified");
      }
      await fence.assertCurrent();
      return Object.freeze({
        publicationResultVersion: "1" as const,
        receipt: verified,
      });
    } catch {
      return control("demos-publication-reconciliation-required");
    }
  }

  return createDacsLiveEffectTrackV1({
    database: options.database,
    kind: "artifact-publication",
    role: options.role,
    track: options.track,
    workerId: options.workerId,
    ...(options.leaseDurationMs === undefined
      ? {} : { leaseDurationMs: options.leaseDurationMs }),
    ...(options.retryDelayMs === undefined
      ? {} : { retryDelayMs: options.retryDelayMs }),
    async buildInput(operationInput) {
      const publication = await options.buildPublication(operationInput);
      if (!plainObject(publication) || Object.keys(publication).length !== 2 ||
          !text(publication.logicalAddress) || !plainObject(publication.artifact)) {
        throw new DacsDemosPublicationError("demos-publication-draft-invalid");
      }
      const contentHash = sha256Hex(canonicalize(publication.artifact));
      if (await options.authorizePublication({
        order: operationInput.order,
        publication,
        contentHash,
      }) !== true) {
        throw new DacsDemosPublicationError("demos-publication-unauthorized");
      }
      return {
        publicationInputVersion: "1" as const,
        orderBindingHash: operationInput.order.bindingHash,
        orderLocalBindingHash: operationInput.order.localBindingHash,
        writer: runtime.authority,
        logicalAddress: publication.logicalAddress,
        contentHash,
        artifact: publication.artifact,
      };
    },
    adapter: {
      execute: ({ input, fence }) => publish(input, fence),
      async reconcile({ input, fence }): Promise<Readonly<
        DacsLiveEffectReconciliationV1<DacsDemosPublicationResultV1>
      >> {
        const result = await publish(input, fence);
        if ("effectControlVersion" in result) {
          return result.status === "operator-action"
            ? { status: "operator-action", reasonCode: result.reasonCode }
            : { status: "indeterminate", reasonCode: result.reasonCode };
        }
        return { status: "completed", result };
      },
    },
    projectResult: (result) => ({
      reference: result.receipt.logicalAddress,
      authenticationHash: sha256Hex(canonicalize(result.receipt)),
    }),
  });
}
