import { canonicalize } from "@kynesyslabs/dacs/canonical";
import type {
  FixedPriceX402CoordinatorRole,
  FixedPriceX402Track,
  FixedPricePayDemTrackOperationInput,
  FixedPriceX402TrackOperationInput,
  FixedPriceX402TrackOperationResult,
} from "@kynesyslabs/dacs/commerce";

import type {
  DacsNodeSqliteDatabase,
  DacsNodeSqliteEffectKind,
  DacsNodeSqliteEffectLease,
} from "./sqlite.js";

const HASH_RE = /^[0-9a-f]{64}$/;
const REASON_CODE_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const DEFAULT_EFFECT_LEASE_MS = 120_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;

export interface DacsLiveEffectFenceV1 {
  readonly role: FixedPriceX402CoordinatorRole;
  readonly track: FixedPriceX402Track;
  readonly jobId: string;
  readonly effectId: string;
  readonly idempotencyKey: string;
  readonly bindingHash: string;
  readonly generation: number;
  /**
   * Assert both the coordinator generation and the SQLite irreversible-effect
   * generation. An adapter must call this immediately before an operation that
   * can become externally observable.
   */
  assertCurrent(): Promise<void>;
  /** Commit immutable public recovery coordinates under this exact generation. */
  checkpoint(name: string, value: unknown): Promise<void>;
}

export interface DacsLiveEffectInvocationV1<Input> {
  readonly input: Readonly<Input>;
  readonly fence: Readonly<DacsLiveEffectFenceV1>;
  readonly signal?: AbortSignal;
}

export type DacsLiveEffectReconciliationV1<Result> = Readonly<
  | { status: "completed"; result: Readonly<Result> }
  | { status: "absent"; absenceProofHash: string }
  | { status: "indeterminate"; reasonCode: string; retryAt?: number }
  | { status: "operator-action"; reasonCode: string }
>;

export type DacsLiveEffectExecutionControlV1 = Readonly<
  | {
      effectControlVersion: "1";
      status: "indeterminate";
      reasonCode: string;
      retryAt?: number;
    }
  | {
      effectControlVersion: "1";
      status: "operator-action";
      reasonCode: string;
    }
>;

/**
 * Capability required by a live irreversible coordinator track. `execute`
 * must use the supplied idempotency key at the external provider whenever the
 * provider supports it. `reconcile` must be authoritative for the same exact
 * effect identity; an indeterminate result never authorizes another execute.
 */
export interface DacsLiveEffectAdapterV1<Input, Result> {
  reconcile(
    invocation: Readonly<DacsLiveEffectInvocationV1<Input>>,
  ): Promise<Readonly<DacsLiveEffectReconciliationV1<Result>>> |
    Readonly<DacsLiveEffectReconciliationV1<Result>>;
  execute(
    invocation: Readonly<DacsLiveEffectInvocationV1<Input>>,
  ): Promise<Readonly<Result> | DacsLiveEffectExecutionControlV1> |
    Readonly<Result> | DacsLiveEffectExecutionControlV1;
}

export interface DacsLiveEffectResultProjectionV1 {
  reference: string;
  authenticationHash?: string;
}

type DacsLiveEffectTrackOperationInputV1 =
  | FixedPriceX402TrackOperationInput
  | FixedPricePayDemTrackOperationInput;

export interface DacsLiveEffectTrackOptionsV1<
  Input,
  Result,
  OperationInput extends DacsLiveEffectTrackOperationInputV1 =
    FixedPriceX402TrackOperationInput,
> {
  database: DacsNodeSqliteDatabase;
  kind: DacsNodeSqliteEffectKind;
  role: FixedPriceX402CoordinatorRole;
  track: FixedPriceX402Track;
  workerId: string;
  buildInput(
    input: Readonly<OperationInput>,
  ): Promise<Readonly<Input>> | Readonly<Input>;
  adapter: Readonly<DacsLiveEffectAdapterV1<Input, Result>>;
  projectResult(
    result: Readonly<Result>,
  ): Readonly<DacsLiveEffectResultProjectionV1>;
  leaseDurationMs?: number;
  retryDelayMs?: number;
}

export class DacsLiveEffectError extends Error {
  override readonly name = "DacsLiveEffectError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

/**
 * A safe pre-intent outcome. It may be used only while resolving read-only
 * prerequisites or preparing deterministic bytes, before an effect intent is
 * admitted. Once submission might have happened, adapters must use the normal
 * reconciliation path instead.
 */
export class DacsLiveEffectInputControlError extends Error {
  override readonly name = "DacsLiveEffectInputControlError";

  constructor(
    readonly status: "pending-retry" | "indeterminate" | "operator-action",
    readonly reasonCode: string,
    readonly retryAt?: number,
  ) {
    super(reasonCode);
    if (!reasonCode || !REASON_CODE_RE.test(reasonCode) ||
        (status === "operator-action" && retryAt !== undefined) ||
        (retryAt !== undefined &&
          (!Number.isSafeInteger(retryAt) || retryAt < 0))) {
      throw new TypeError("live effect input control is invalid");
    }
  }
}

function plainDataObject(value: unknown): value is Record<string, unknown> {
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

function positiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 &&
    value <= maximum;
}

function text(value: unknown, maximum = 1_024): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value.trim() === value && !value.includes("\0");
}

function reasonCode(value: unknown): value is string {
  return typeof value === "string" && REASON_CODE_RE.test(value);
}

function canonicalSnapshot<T>(value: T, label: string): Readonly<T> {
  try {
    return JSON.parse(canonicalize(value)) as T;
  } catch {
    throw new DacsLiveEffectError(`${label}-not-canonical-json`);
  }
}

function captureProjection(value: unknown): Readonly<DacsLiveEffectResultProjectionV1> {
  if (!plainDataObject(value)) {
    throw new DacsLiveEffectError("effect-result-projection-invalid");
  }
  const keys = Object.keys(value);
  if (!keys.every((key) => key === "reference" || key === "authenticationHash") ||
      !text(value.reference) ||
      (value.authenticationHash !== undefined &&
        (typeof value.authenticationHash !== "string" ||
          !HASH_RE.test(value.authenticationHash)))) {
    throw new DacsLiveEffectError("effect-result-projection-invalid");
  }
  return Object.freeze({
    reference: value.reference,
    ...(value.authenticationHash === undefined
      ? {}
      : { authenticationHash: value.authenticationHash }),
  });
}

function finalResult(
  projection: Readonly<DacsLiveEffectResultProjectionV1>,
): Readonly<FixedPriceX402TrackOperationResult> {
  return Object.freeze({
    status: "final" as const,
    outcome: "success" as const,
    reference: projection.reference,
    ...(projection.authenticationHash === undefined
      ? {}
      : { authenticationHash: projection.authenticationHash }),
  });
}

function retryAt(database: DacsNodeSqliteDatabase, delayMs: number): number {
  const value = database.readTime() + delayMs;
  if (!Number.isSafeInteger(value)) {
    throw new DacsLiveEffectError("effect-retry-time-overflow");
  }
  return value;
}

function pending(
  status: "pending-retry" | "indeterminate",
  code: string,
  at: number,
): Readonly<FixedPriceX402TrackOperationResult> {
  return Object.freeze({ status, reasonCode: code, retryAt: at });
}

function effectFence(
  input: Readonly<DacsLiveEffectTrackOperationInputV1>,
  database: DacsNodeSqliteDatabase,
  kind: DacsNodeSqliteEffectKind,
  lease: Readonly<DacsNodeSqliteEffectLease>,
): Readonly<DacsLiveEffectFenceV1> {
  const coordinatorFence = input.fence;
  return Object.freeze({
    role: coordinatorFence.role,
    track: coordinatorFence.track,
    jobId: coordinatorFence.jobId,
    effectId: coordinatorFence.idempotencyKey,
    idempotencyKey: coordinatorFence.idempotencyKey,
    bindingHash: coordinatorFence.localBindingHash,
    generation: lease.generation,
    async assertCurrent() {
      await coordinatorFence.assertCurrent();
      if (!database.isCurrentEffect({
        kind,
        effectId: coordinatorFence.idempotencyKey,
        bindingHash: coordinatorFence.localBindingHash,
        lease,
      })) {
        throw new DacsLiveEffectError("effect-fence-stale");
      }
    },
    async checkpoint(name: string, value: unknown) {
      await coordinatorFence.assertCurrent();
      const written = database.recordEffectCheckpoint({
        kind,
        effectId: coordinatorFence.idempotencyKey,
        bindingHash: coordinatorFence.localBindingHash,
        lease,
        name,
        value,
      });
      if (written.status !== "recorded" && written.status !== "existing") {
        throw new DacsLiveEffectError(
          written.status === "conflict"
            ? "effect-checkpoint-conflict"
            : "effect-fence-stale",
        );
      }
      await coordinatorFence.assertCurrent();
      if (!database.isCurrentEffect({
        kind,
        effectId: coordinatorFence.idempotencyKey,
        bindingHash: coordinatorFence.localBindingHash,
        lease,
      })) {
        throw new DacsLiveEffectError("effect-fence-stale");
      }
    },
  });
}

function capturedReconciliation<Result>(
  value: unknown,
): Readonly<DacsLiveEffectReconciliationV1<Result>> {
  if (!plainDataObject(value) || typeof value.status !== "string") {
    throw new DacsLiveEffectError("effect-reconciliation-invalid");
  }
  if (value.status === "completed" && Object.keys(value).length === 2 &&
      Object.hasOwn(value, "result")) {
    return Object.freeze({
      status: "completed",
      result: canonicalSnapshot(value.result, "effect-reconciliation-result") as Result,
    });
  }
  if (value.status === "absent" && Object.keys(value).length === 2 &&
      typeof value.absenceProofHash === "string" && HASH_RE.test(value.absenceProofHash)) {
    return Object.freeze({ status: "absent", absenceProofHash: value.absenceProofHash });
  }
  if (value.status === "indeterminate" &&
      Object.keys(value).every((key) =>
        key === "status" || key === "reasonCode" || key === "retryAt") &&
      reasonCode(value.reasonCode) &&
      (value.retryAt === undefined ||
        (typeof value.retryAt === "number" && Number.isSafeInteger(value.retryAt) &&
          value.retryAt >= 0))) {
    return Object.freeze({
      status: "indeterminate",
      reasonCode: value.reasonCode,
      ...(value.retryAt === undefined ? {} : { retryAt: value.retryAt }),
    });
  }
  if (value.status === "operator-action" && Object.keys(value).length === 2 &&
      reasonCode(value.reasonCode)) {
    return Object.freeze({ status: "operator-action", reasonCode: value.reasonCode });
  }
  throw new DacsLiveEffectError("effect-reconciliation-invalid");
}

function capturedExecutionControl(
  value: unknown,
): DacsLiveEffectExecutionControlV1 | undefined {
  if (!plainDataObject(value) || value.effectControlVersion === undefined) {
    return undefined;
  }
  if (value.effectControlVersion !== "1" || !reasonCode(value.reasonCode)) {
    throw new DacsLiveEffectError("effect-execution-control-invalid");
  }
  if (value.status === "operator-action" && Object.keys(value).length === 3) {
    return Object.freeze({
      effectControlVersion: "1",
      status: "operator-action",
      reasonCode: value.reasonCode,
    });
  }
  if (value.status === "indeterminate" &&
      Object.keys(value).every((key) =>
        key === "effectControlVersion" || key === "status" ||
        key === "reasonCode" || key === "retryAt") &&
      (value.retryAt === undefined ||
        (typeof value.retryAt === "number" && Number.isSafeInteger(value.retryAt) &&
          value.retryAt >= 0))) {
    return Object.freeze({
      effectControlVersion: "1",
      status: "indeterminate",
      reasonCode: value.reasonCode,
      ...(value.retryAt === undefined ? {} : { retryAt: value.retryAt }),
    });
  }
  throw new DacsLiveEffectError("effect-execution-control-invalid");
}

/**
 * Turn one live coordinator track into a durable SQLite-backed irreversible
 * effect. A thrown/ambiguous execute is never retried directly: the next claim
 * is reconciliation-only, and only an authoritative `absent` result restores
 * permission to execute the same deterministic effect identity.
 */
export function createDacsLiveEffectTrackV1<
  Input,
  Result,
  OperationInput extends DacsLiveEffectTrackOperationInputV1 =
    FixedPriceX402TrackOperationInput,
>(
  options: Readonly<DacsLiveEffectTrackOptionsV1<Input, Result, OperationInput>>,
): (
  input: Readonly<OperationInput>,
) => Promise<Readonly<FixedPriceX402TrackOperationResult>> {
  if (!plainDataObject(options) ||
      !text(options.workerId) ||
      (options.role !== "buyer" && options.role !== "seller") ||
      typeof options.track !== "string" || typeof options.kind !== "string" ||
      typeof options.buildInput !== "function" ||
      typeof options.projectResult !== "function" ||
      !plainDataObject(options.adapter) ||
      typeof options.adapter.execute !== "function" ||
      typeof options.adapter.reconcile !== "function" ||
      options.database === null || typeof options.database !== "object") {
    throw new TypeError("live effect track options are invalid");
  }
  const database = options.database;
  if (database.metadata.mode !== "live-demos" ||
      database.metadata.role !== options.role) {
    throw new TypeError("live effect database is role- or profile-incompatible");
  }
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_EFFECT_LEASE_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  if (!positiveInteger(leaseDurationMs, 600_000) ||
      !positiveInteger(retryDelayMs, 60_000)) {
    throw new TypeError("live effect timing options are invalid");
  }
  const workerId = options.workerId;
  const role = options.role;
  const track = options.track;
  const kind = options.kind;
  const buildInput = options.buildInput.bind(options);
  const projectResult = options.projectResult.bind(options);
  const execute = options.adapter.execute.bind(options.adapter);
  const reconcile = options.adapter.reconcile.bind(options.adapter);

  return async (operationInput) => {
    if (operationInput.fence.role !== role || operationInput.fence.track !== track ||
        operationInput.order.role !== role ||
        operationInput.order.jobId !== operationInput.fence.jobId) {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "effect-track-binding-mismatch",
      });
    }
    const effectId = operationInput.fence.idempotencyKey;
    const bindingHash = operationInput.fence.localBindingHash;
    let effectInput: Readonly<Input>;
    try {
      const retained = database.loadEffectInput(kind, effectId);
      effectInput = canonicalSnapshot(
        retained === undefined ? await buildInput(operationInput) : retained,
        "effect-input",
      ) as Readonly<Input>;
    } catch (error) {
      if (error instanceof DacsLiveEffectInputControlError) {
        if (error.status === "operator-action") {
          return Object.freeze({
            status: "operator-action" as const,
            reasonCode: error.reasonCode,
          });
        }
        return pending(
          error.status,
          error.reasonCode,
          error.retryAt ?? retryAt(database, retryDelayMs),
        );
      }
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "effect-input-invalid",
      });
    }
    const intent = database.putEffectIntent({
      kind,
      effectId,
      bindingHash,
      input: effectInput,
      idempotencyKey: effectId,
      jobId: operationInput.fence.jobId,
    });
    if (intent.status === "conflict") {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "effect-intent-conflict",
      });
    }

    const claim = database.claimEffect({
      kind,
      effectId,
      bindingHash,
      owner: workerId,
      leaseDurationMs,
    });
    if (claim.status === "completed") {
      try {
        return finalResult(captureProjection(projectResult(claim.record.result as Result)));
      } catch {
        return Object.freeze({
          status: "operator-action" as const,
          reasonCode: "effect-result-invalid",
        });
      }
    }
    if (claim.status === "waiting") {
      return pending("pending-retry", "effect-worker-active", claim.lease.expiresAt);
    }
    if (claim.status === "not-runnable") {
      if (claim.record.state === "operator-action") {
        return Object.freeze({
          status: "operator-action" as const,
          reasonCode: claim.record.reasonCode ?? "effect-operator-action",
        });
      }
      return pending(
        claim.record.state === "reconciliation-required"
          ? "indeterminate"
          : "pending-retry",
        claim.record.reasonCode ?? "effect-not-runnable",
        claim.record.retryAt ?? retryAt(database, retryDelayMs),
      );
    }
    if (claim.status !== "acquired") {
      return pending(
        "indeterminate",
        "effect-claim-stale",
        retryAt(database, retryDelayMs),
      );
    }

    const fence = effectFence(operationInput, database, kind, claim.lease);
    const invocation: Readonly<DacsLiveEffectInvocationV1<Input>> = Object.freeze({
      input: effectInput,
      fence,
      ...(operationInput.signal === undefined ? {} : { signal: operationInput.signal }),
    });

    if (claim.mode === "reconcile") {
      let resolution: Readonly<DacsLiveEffectReconciliationV1<Result>>;
      try {
        resolution = capturedReconciliation<Result>(await reconcile(invocation));
      } catch {
        resolution = Object.freeze({
          status: "indeterminate",
          reasonCode: "effect-reconciliation-unavailable",
          retryAt: retryAt(database, retryDelayMs),
        });
      }
      if (resolution.status === "operator-action") {
        database.requireEffectOperatorAction({
          kind,
          effectId,
          bindingHash,
          lease: claim.lease,
          reasonCode: resolution.reasonCode,
        });
        return Object.freeze({
          status: "operator-action" as const,
          reasonCode: resolution.reasonCode,
        });
      }
      if (resolution.status === "completed") {
        const write = database.recordEffectReconciliation({
          kind,
          effectId,
          bindingHash,
          lease: claim.lease as DacsNodeSqliteEffectLease & { mode: "reconcile" },
          result: { disposition: "performed", result: resolution.result },
        });
        if (write.status === "recorded" || write.status === "existing") {
          try {
            return finalResult(captureProjection(projectResult(resolution.result)));
          } catch {
            return Object.freeze({
              status: "operator-action" as const,
              reasonCode: "effect-result-invalid",
            });
          }
        }
        return pending("indeterminate", "effect-fence-stale", retryAt(database, retryDelayMs));
      }
      if (resolution.status === "absent") {
        database.recordEffectReconciliation({
          kind,
          effectId,
          bindingHash,
          lease: claim.lease as DacsNodeSqliteEffectLease & { mode: "reconcile" },
          result: {
            disposition: "absent",
            absenceProofHash: resolution.absenceProofHash,
          },
        });
        return pending("pending-retry", "effect-authoritatively-absent",
          retryAt(database, retryDelayMs));
      }
      const at = resolution.retryAt ?? retryAt(database, retryDelayMs);
      database.recordEffectReconciliation({
        kind,
        effectId,
        bindingHash,
        lease: claim.lease as DacsNodeSqliteEffectLease & { mode: "reconcile" },
        result: {
          disposition: "indeterminate",
          reasonCode: resolution.reasonCode,
          retryAt: at,
        },
      });
      return pending("indeterminate", resolution.reasonCode, at);
    }

    let result: Readonly<Result>;
    let write: ReturnType<DacsNodeSqliteDatabase["recordEffectCompleted"]>;
    try {
      await fence.assertCurrent();
      const rawResult = await execute(invocation);
      const control = capturedExecutionControl(rawResult);
      if (control?.status === "operator-action") {
        database.requireEffectOperatorAction({
          kind,
          effectId,
          bindingHash,
          lease: claim.lease,
          reasonCode: control.reasonCode,
        });
        return Object.freeze({
          status: "operator-action" as const,
          reasonCode: control.reasonCode,
        });
      }
      if (control?.status === "indeterminate") {
        const at = control.retryAt ?? retryAt(database, retryDelayMs);
        database.recordEffectAmbiguous({
          kind,
          effectId,
          bindingHash,
          lease: claim.lease,
          reasonCode: control.reasonCode,
          retryAt: at,
        });
        return pending("indeterminate", control.reasonCode, at);
      }
      result = canonicalSnapshot(rawResult, "effect-result") as Result;
      write = database.recordEffectCompleted({
        kind,
        effectId,
        bindingHash,
        lease: claim.lease,
        result,
      });
    } catch {
      const at = retryAt(database, retryDelayMs);
      try {
        database.recordEffectAmbiguous({
          kind,
          effectId,
          bindingHash,
          lease: claim.lease,
          reasonCode: "effect-outcome-ambiguous",
          retryAt: at,
        });
      } catch {
        // A superseding generation owns durable recovery. This worker remains
        // conservative and never converts a lost fence into permission to run.
      }
      return pending("indeterminate", "effect-outcome-ambiguous", at);
    }
    if (write.status !== "recorded" && write.status !== "existing") {
      return pending("indeterminate", "effect-fence-stale", retryAt(database, retryDelayMs));
    }
    try {
      return finalResult(captureProjection(projectResult(result)));
    } catch {
      // The external outcome and full result are already durable. A bad host
      // projection must never demote that fact to ambiguous or repeat it.
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "effect-result-invalid",
      });
    }
  };
}
