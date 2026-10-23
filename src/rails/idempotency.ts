import { randomUUID } from "node:crypto";
import { types as nodeTypes } from "node:util";

import type { SettleResult } from "../agent/runSessionCore.js";
import {
  canonicalize,
  sha256Hex,
} from "../canonical/index.js";
import { snapshotCanonicalJsonRead } from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";

/**
 * Settlement idempotency (issue #43).
 *
 * The evidence anchor follows the irreversible rail effect, so an ordinary
 * cache cannot close the crash window. This module records a rail-terms hash,
 * grants exactly one expiring generation, and fences both the rail effect and
 * outcome write. An expired attempt is reconciled by one recovery owner; even
 * authoritative absence cannot authorize a replacement unless the rail also
 * proves the old effect terminal or enforces one deterministic external effect
 * identity. Otherwise recovery deliberately stops for operator action.
 *
 * The in-memory log models the atomic contract but is process-local. Production
 * cross-process recovery requires a durable {@link SettlementLog} implementing
 * every transition as a compare-and-set transaction. That adapter must also bind
 * the enclosing agreement identity; this rail-local contract does not yet carry
 * `agreementHash` and is therefore a foundation for, not full closure of, #43.
 */

const DEFAULT_LEASE_DURATION_MS = 300_000;

/**
 * Immutable rail-local authority for one settlement effect. The idempotency key
 * identifies the phase; this value prevents that key being reused for changed
 * rail, commercial or finality terms. The enclosing durable coordinator remains
 * responsible for binding the exact agreement identity.
 */
export interface SettlementBinding {
  bindingVersion: "1";
  railId: string;
  jobId: string;
  phaseIndex: number;
  phase: string;
  amount: string;
  agreementAsset: string;
  settlementAsset: string;
  payer: string;
  payee: string;
  network: string;
  finality: Readonly<{
    model: string;
    finalityBlocks?: number;
  }>;
  /** Chain/protocol-enforced identity reused by every permitted redrive. */
  effectIdentity?: string;
  /** Exact seller-selected resource for an HTTP-coupled rail such as x402. */
  resource?: string;
}

export interface SettlementLeaseToken {
  owner: string;
  generation: number;
}

export interface SettlementIntentLease extends SettlementLeaseToken {
  stage: "fresh" | "reconcile" | "replay";
  expiresAt: number;
}

/** Fence handed to rail code and asserted immediately beside the effect. */
export interface SettlementEffectFence extends SettlementLeaseToken {
  settlementKey: string;
  bindingHash: string;
  effectIdentity?: string;
  assertCurrent(): Promise<void>;
}

/**
 * Explicit rail result proving that no irreversible effect was invoked. An
 * ordinary failed {@link SettleResult}, even one without a transaction hash,
 * remains ambiguous and never releases the durable intent.
 */
export interface SettlementNotInvokedResult {
  disposition: "not-invoked";
  result: Readonly<SettleResult>;
}

export interface SettlementOutcomeRecord {
  bindingHash: string;
  result: Readonly<SettleResult>;
}

export type SettlementIntentClaim =
  | {
      status: "acquired";
      bindingHash: string;
      lease: Readonly<SettlementIntentLease>;
    }
  | {
      status: "held";
      bindingHash: string;
      lease: Readonly<SettlementIntentLease>;
    }
  | { status: "outcome"; outcome: Readonly<SettlementOutcomeRecord> }
  | { status: "conflict" };

export type SettlementRecoveryGrant =
  | {
      status: "granted";
      bindingHash: string;
      lease: Readonly<SettlementIntentLease>;
    }
  | { status: "outcome"; outcome: Readonly<SettlementOutcomeRecord> }
  | { status: "stale" | "conflict" };

export type SettlementOutcomeWrite =
  | { status: "recorded" | "existing"; outcome: Readonly<SettlementOutcomeRecord> }
  | { status: "stale" | "conflict" };

export interface SettlementLog {
  /** Atomically install a fresh intent, acquire an expired intent, or load its outcome. */
  claimIntent(input: Readonly<{
    key: string;
    bindingHash: string;
    owner: string;
    now: number;
    leaseDurationMs: number;
  }>): Promise<SettlementIntentClaim>;
  /** True only for the exact unexpired installed generation. */
  isCurrent(input: Readonly<{
    key: string;
    bindingHash: string;
    lease: Readonly<SettlementLeaseToken>;
    now: number;
  }>): Promise<boolean>;
  /**
   * Atomically replace a reconcile lease with a replay lease. Authoritative
   * absence alone is not permission to submit; this grant is that permission.
   */
  grantRecovery(input: Readonly<{
    key: string;
    bindingHash: string;
    lease: Readonly<SettlementLeaseToken>;
    owner: string;
    now: number;
    leaseDurationMs: number;
  }>): Promise<SettlementRecoveryGrant>;
  /** Record only through the exact current generation. */
  putOutcome(input: Readonly<{
    key: string;
    bindingHash: string;
    lease: Readonly<SettlementLeaseToken>;
    result: Readonly<SettleResult>;
    now: number;
  }>): Promise<SettlementOutcomeWrite>;
  /** Release an explicitly proven not-invoked attempt without deleting its term binding. */
  releaseIntent(input: Readonly<{
    key: string;
    bindingHash: string;
    lease: Readonly<SettlementLeaseToken>;
    now: number;
  }>): Promise<"released" | "stale" | "conflict">;
}

/**
 * Reconcile an unresolved settlement against the authoritative rail. `null`
 * is a positive proof of absence; throws are indeterminate. The optional fence
 * lets a provider reject work after its recovery generation is superseded.
 */
export type SettlementReconcile = (
  key: string,
  fence?: Readonly<SettlementEffectFence>,
) => Promise<SettleResult | SettlementReplayAuthorization | null>;

/**
 * Rail-specific authority for a replacement effect. A proof that nothing has
 * landed is not enough while an old process/authorization may still execute.
 */
export interface SettlementReplayAuthorization {
  disposition: "replay-authorized";
  bindingHash: string;
  effectIdentity: string;
  protection: "deterministic-external-idempotency" | "prior-effect-terminal";
  assertReplaySafe(fence: Readonly<SettlementEffectFence>): Promise<void>;
}

export interface SettlementIdempotencyStore {
  /**
   * Run one settlement under a generation-fenced write-ahead protocol.
   *
   * `binding` is mandatory. Callers that cannot supply complete immutable terms
   * must not use this API for funded effects.
   */
  once(
    key: string,
    binding: Readonly<SettlementBinding>,
    submit: (
      fence?: Readonly<SettlementEffectFence>,
    ) => Promise<SettleResult | SettlementNotInvokedResult>,
    reconcile?: SettlementReconcile,
  ): Promise<SettleResult>;
}

export interface SettlementIdempotencyStoreOptions {
  owner?: string;
  leaseDurationMs?: number;
  now?: () => number;
}

interface StoredSettlementRecord {
  bindingHash: string;
  generation: number;
  lease?: SettlementIntentLease;
  outcome?: SettlementOutcomeRecord;
}

function leaseExpiry(now: number, duration: number): number {
  if (!Number.isSafeInteger(now) || now < 0 ||
      !Number.isSafeInteger(duration) || duration <= 0 ||
      now > Number.MAX_SAFE_INTEGER - duration) {
    throw new DacsError("settlement lease timestamp or duration is invalid");
  }
  return now + duration;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}

function frozenClone<T>(value: T, label: string): Readonly<T> {
  return deepFreeze(snapshotCanonicalJsonRead(value, label));
}

function nonEmptyNfc(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 ||
      value.trim() !== value || value.normalize("NFC") !== value) {
    throw new DacsError(`${label} must be a non-empty exact NFC string`);
  }
  return value;
}

/** Capture and hash the complete fixed settlement authority. */
export function settlementBindingHash(value: Readonly<SettlementBinding>): string {
  const binding = frozenClone(value, "settlement binding") as Readonly<SettlementBinding>;
  const allowed = new Set([
    "bindingVersion", "railId", "jobId", "phaseIndex", "phase", "amount",
    "agreementAsset", "settlementAsset", "payer", "payee", "network",
    "finality", "effectIdentity", "resource",
  ]);
  if (Object.keys(binding).some((key) => !allowed.has(key)) ||
      binding.bindingVersion !== "1" ||
      !Number.isSafeInteger(binding.phaseIndex) || binding.phaseIndex < 0 ||
      Object.is(binding.phaseIndex, -0)) {
    throw new DacsError("settlement binding has an invalid shape or phase index");
  }
  for (const [label, item] of Object.entries({
    railId: binding.railId,
    jobId: binding.jobId,
    phase: binding.phase,
    amount: binding.amount,
    agreementAsset: binding.agreementAsset,
    settlementAsset: binding.settlementAsset,
    payer: binding.payer,
    payee: binding.payee,
    network: binding.network,
  })) nonEmptyNfc(item, `settlement binding ${label}`);
  if (binding.jobId.includes(":")) {
    throw new DacsError("settlement binding jobId must be colon-free");
  }
  if (binding.resource !== undefined) nonEmptyNfc(binding.resource, "settlement binding resource");
  if (binding.effectIdentity !== undefined) {
    nonEmptyNfc(binding.effectIdentity, "settlement binding effectIdentity");
  }
  if (binding.finality === null || typeof binding.finality !== "object" ||
      Array.isArray(binding.finality)) {
    throw new DacsError("settlement binding finality must be an object");
  }
  const finalityKeys = Object.keys(binding.finality);
  if (finalityKeys.some((key) => key !== "model" && key !== "finalityBlocks") ||
      !finalityKeys.includes("model")) {
    throw new DacsError("settlement binding finality has an invalid shape");
  }
  nonEmptyNfc(binding.finality.model, "settlement binding finality model");
  if (binding.finality.finalityBlocks !== undefined &&
      (!Number.isSafeInteger(binding.finality.finalityBlocks) ||
       binding.finality.finalityBlocks <= 0)) {
    throw new DacsError("settlement binding finalityBlocks must be positive");
  }
  if (settlementKey(binding.railId, binding.jobId, binding.phaseIndex).length === 0) {
    throw new DacsError("settlement binding key is invalid");
  }
  return sha256Hex(canonicalize(binding));
}

function captureResult(value: SettleResult, label: string): Readonly<SettleResult> {
  const result = frozenClone(value, label) as Readonly<SettleResult>;
  if (typeof result.ok !== "boolean" || typeof result.txHash !== "string" ||
      typeof result.chainId !== "string" || typeof result.payer !== "string" ||
      typeof result.payee !== "string") {
    throw new DacsError(`${label} is not a settlement result`);
  }
  return result;
}

function captureBoundResult(
  value: SettleResult,
  binding: Readonly<SettlementBinding>,
  label: string,
): Readonly<SettleResult> {
  const result = captureResult(value, label);
  if (result.chainId !== binding.network || result.payer !== binding.payer ||
      result.payee !== binding.payee) {
    throw new DacsError(
      `${label} does not match the retained settlement network or parties`,
    );
  }
  if (!result.ok) {
    if (result.finality !== undefined) {
      throw new DacsError(`${label} failure must not claim settlement finality`);
    }
    return result;
  }
  if (result.txHash.trim().length === 0 || result.finality === undefined ||
      result.finality === null || typeof result.finality !== "object" ||
      Array.isArray(result.finality)) {
    throw new DacsError(`${label} success must carry transaction identity and finality`);
  }
  const expectedFinalityKeys = binding.finality.finalityBlocks === undefined
    ? ["model"]
    : ["model", "finalityBlocks"];
  if (!hasExactKeys(result.finality, expectedFinalityKeys) ||
      result.finality.model !== binding.finality.model ||
      result.finality.finalityBlocks !== binding.finality.finalityBlocks) {
    throw new DacsError(`${label} does not match the retained settlement finality policy`);
  }
  return result;
}

function captureOutcome(
  bindingHash: string,
  value: SettleResult,
): Readonly<SettlementOutcomeRecord> {
  return deepFreeze({
    bindingHash,
    result: captureResult(value, "settlement outcome"),
  });
}

function cloneOutcome(value: SettlementOutcomeRecord): Readonly<SettlementOutcomeRecord> {
  return frozenClone(value, "stored settlement outcome") as Readonly<SettlementOutcomeRecord>;
}

function cloneLease(value: SettlementIntentLease): Readonly<SettlementIntentLease> {
  return frozenClone(value, "settlement lease") as Readonly<SettlementIntentLease>;
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function captureLease(
  value: unknown,
  label: string,
): Readonly<SettlementIntentLease> {
  const lease = frozenClone(
    value as SettlementIntentLease,
    label,
  ) as Readonly<SettlementIntentLease>;
  if (!hasExactKeys(lease, ["owner", "generation", "stage", "expiresAt"]) ||
      typeof lease.owner !== "string" || lease.owner.length === 0 ||
      !/^[\x20-\x7e]+$/.test(lease.owner) ||
      !Number.isSafeInteger(lease.generation) || lease.generation <= 0 ||
      (lease.stage !== "fresh" && lease.stage !== "reconcile" && lease.stage !== "replay") ||
      !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= 0) {
    throw new DacsError(`${label} has an invalid shape`);
  }
  return lease;
}

function captureStoredOutcome(
  value: unknown,
  label: string,
): Readonly<SettlementOutcomeRecord> {
  const outcome = frozenClone(
    value as SettlementOutcomeRecord,
    label,
  ) as Readonly<SettlementOutcomeRecord>;
  if (!hasExactKeys(outcome, ["bindingHash", "result"]) ||
      typeof outcome.bindingHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(outcome.bindingHash)) {
    throw new DacsError(`${label} has an invalid shape`);
  }
  return deepFreeze({
    bindingHash: outcome.bindingHash,
    result: captureResult(outcome.result as SettleResult, `${label} result`),
  });
}

function captureIntentClaim(value: unknown): Readonly<SettlementIntentClaim> {
  const claim = frozenClone(
    value as SettlementIntentClaim,
    "settlement intent claim",
  ) as Readonly<SettlementIntentClaim>;
  if (claim.status === "conflict" && hasExactKeys(claim, ["status"])) return claim;
  if (claim.status === "outcome" && hasExactKeys(claim, ["status", "outcome"])) {
    return deepFreeze({
      status: "outcome",
      outcome: captureStoredOutcome(claim.outcome, "settlement claim outcome"),
    });
  }
  if ((claim.status === "acquired" || claim.status === "held") &&
      hasExactKeys(claim, ["status", "bindingHash", "lease"]) &&
      typeof claim.bindingHash === "string" && /^[0-9a-f]{64}$/.test(claim.bindingHash)) {
    return deepFreeze({
      status: claim.status,
      bindingHash: claim.bindingHash,
      lease: captureLease(claim.lease, "settlement claim lease"),
    });
  }
  throw new DacsError("settlement intent claim has an invalid shape");
}

function captureRecoveryGrant(value: unknown): Readonly<SettlementRecoveryGrant> {
  const grant = frozenClone(
    value as SettlementRecoveryGrant,
    "settlement recovery grant",
  ) as Readonly<SettlementRecoveryGrant>;
  if ((grant.status === "stale" || grant.status === "conflict") &&
      hasExactKeys(grant, ["status"])) return grant;
  if (grant.status === "outcome" && hasExactKeys(grant, ["status", "outcome"])) {
    return deepFreeze({
      status: "outcome",
      outcome: captureStoredOutcome(grant.outcome, "settlement recovery outcome"),
    });
  }
  if (grant.status === "granted" &&
      hasExactKeys(grant, ["status", "bindingHash", "lease"]) &&
      typeof grant.bindingHash === "string" && /^[0-9a-f]{64}$/.test(grant.bindingHash)) {
    return deepFreeze({
      status: "granted",
      bindingHash: grant.bindingHash,
      lease: captureLease(grant.lease, "settlement replay lease"),
    });
  }
  throw new DacsError("settlement recovery grant has an invalid shape");
}

function captureOutcomeWrite(value: unknown): Readonly<SettlementOutcomeWrite> {
  const write = frozenClone(
    value as SettlementOutcomeWrite,
    "settlement outcome write",
  ) as Readonly<SettlementOutcomeWrite>;
  if ((write.status === "stale" || write.status === "conflict") &&
      hasExactKeys(write, ["status"])) return write;
  if ((write.status === "recorded" || write.status === "existing") &&
      hasExactKeys(write, ["status", "outcome"])) {
    return deepFreeze({
      status: write.status,
      outcome: captureStoredOutcome(write.outcome, "settlement written outcome"),
    });
  }
  throw new DacsError("settlement outcome write has an invalid shape");
}

function captureSubmission(
  value: unknown,
): Readonly<SettleResult | SettlementNotInvokedResult> {
  if (value !== null && typeof value === "object" && !nodeTypes.isProxy(value)) {
    const disposition = Object.getOwnPropertyDescriptor(value, "disposition");
    if (disposition !== undefined && "value" in disposition &&
        disposition.value === "not-invoked") {
      const submission = frozenClone(
        value as SettlementNotInvokedResult,
        "not-invoked settlement result",
      ) as Readonly<SettlementNotInvokedResult>;
      if (!hasExactKeys(submission, ["disposition", "result"])) {
        throw new DacsError("not-invoked settlement result has an invalid shape");
      }
      const result = captureResult(
        submission.result as SettleResult,
        "not-invoked settlement outcome",
      );
      if (result.ok || result.txHash.trim().length !== 0) {
        throw new DacsError(
          "not-invoked settlement result cannot claim success or transaction identity",
        );
      }
      return deepFreeze({ disposition: "not-invoked", result });
    }
  }
  return captureResult(value as SettleResult, "submitted settlement result");
}

function sameOutcome(left: SettlementOutcomeRecord, right: SettlementOutcomeRecord): boolean {
  return canonicalize(left) === canonicalize(right);
}

function nextGeneration(record: StoredSettlementRecord): number {
  const generation = record.generation + 1;
  if (!Number.isSafeInteger(generation)) {
    throw new DacsError("settlement lease generation exhausted");
  }
  return generation;
}

/** Process-local reference log with the same lease/fencing contract as a durable backend. */
export function createInMemorySettlementLog(): SettlementLog {
  const records = new Map<string, StoredSettlementRecord>();
  const current = (
    record: StoredSettlementRecord,
    input: Readonly<{
      bindingHash: string;
      lease: Readonly<SettlementLeaseToken>;
      now: number;
    }>,
  ): boolean => record.outcome === undefined && record.bindingHash === input.bindingHash &&
    record.lease?.owner === input.lease.owner &&
    record.lease.generation === input.lease.generation &&
    record.lease.expiresAt > input.now;

  return {
    async claimIntent(input) {
      const expiresAt = leaseExpiry(input.now, input.leaseDurationMs);
      const existing = records.get(input.key);
      if (!existing) {
        const lease: SettlementIntentLease = {
          owner: input.owner,
          generation: 1,
          stage: "fresh",
          expiresAt,
        };
        records.set(input.key, {
          bindingHash: input.bindingHash,
          generation: 1,
          lease,
        });
        return { status: "acquired", bindingHash: input.bindingHash, lease: cloneLease(lease) };
      }
      if (existing.bindingHash !== input.bindingHash) return { status: "conflict" };
      if (existing.outcome) return { status: "outcome", outcome: cloneOutcome(existing.outcome) };
      if (existing.lease && existing.lease.expiresAt > input.now) {
        return {
          status: "held",
          bindingHash: existing.bindingHash,
          lease: cloneLease(existing.lease),
        };
      }
      const generation = nextGeneration(existing);
      const lease: SettlementIntentLease = {
        owner: input.owner,
        generation,
        stage: existing.lease === undefined ? "fresh" : "reconcile",
        expiresAt,
      };
      existing.generation = generation;
      existing.lease = lease;
      return { status: "acquired", bindingHash: existing.bindingHash, lease: cloneLease(lease) };
    },
    async isCurrent(input) {
      const record = records.get(input.key);
      return record !== undefined && current(record, input);
    },
    async grantRecovery(input) {
      const expiresAt = leaseExpiry(input.now, input.leaseDurationMs);
      const record = records.get(input.key);
      if (!record) return { status: "stale" };
      if (record.bindingHash !== input.bindingHash) return { status: "conflict" };
      if (record.outcome) return { status: "outcome", outcome: cloneOutcome(record.outcome) };
      if (!current(record, input) || record.lease?.stage !== "reconcile") {
        return { status: "stale" };
      }
      const generation = nextGeneration(record);
      const lease: SettlementIntentLease = {
        owner: input.owner,
        generation,
        stage: "replay",
        expiresAt,
      };
      record.generation = generation;
      record.lease = lease;
      return { status: "granted", bindingHash: record.bindingHash, lease: cloneLease(lease) };
    },
    async putOutcome(input) {
      const record = records.get(input.key);
      if (!record) return { status: "stale" };
      if (record.bindingHash !== input.bindingHash) return { status: "conflict" };
      const candidate = captureOutcome(input.bindingHash, input.result as SettleResult);
      if (record.outcome) {
        return sameOutcome(record.outcome, candidate)
          ? { status: "existing", outcome: cloneOutcome(record.outcome) }
          : { status: "conflict" };
      }
      if (!current(record, input)) return { status: "stale" };
      record.outcome = candidate as SettlementOutcomeRecord;
      record.lease = undefined;
      return { status: "recorded", outcome: cloneOutcome(candidate as SettlementOutcomeRecord) };
    },
    async releaseIntent(input) {
      const record = records.get(input.key);
      if (!record) return "stale";
      if (record.bindingHash !== input.bindingHash) return "conflict";
      if (!current(record, input)) return "stale";
      record.lease = undefined;
      return "released";
    },
  };
}

/** Deterministic settlement idempotency key: `railId:jobId:phaseIndex`. */
export function settlementKey(railId: string, jobId: string, phaseIndex: number): string {
  if (typeof railId !== "string" || railId.length === 0 || railId.normalize("NFC") !== railId ||
      typeof jobId !== "string" || jobId.length === 0 || jobId.normalize("NFC") !== jobId ||
      jobId.includes(":") || !Number.isSafeInteger(phaseIndex) || phaseIndex < 0 ||
      Object.is(phaseIndex, -0)) {
    throw new DacsError(
      "settlement key requires exact NFC rail/job identifiers, a colon-free job id, and a non-negative phase index",
    );
  }
  return `${railId}:${jobId}:${phaseIndex}`;
}

function isDefinitive(result: Readonly<SettleResult>): boolean {
  return result.ok && result.txHash.trim().length > 0;
}

function storeOptions(options: Readonly<SettlementIdempotencyStoreOptions>): Readonly<{
  owner: string;
  leaseDurationMs: number;
  now: () => number;
}> {
  if (options === null || typeof options !== "object" || Array.isArray(options) ||
      nodeTypes.isProxy(options) || Object.getOwnPropertySymbols(options).length !== 0) {
    throw new DacsError("settlement store lease options must be stable own data");
  }
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const allowed = new Set(["owner", "leaseDurationMs", "now"]);
  if (Object.keys(descriptors).some((key) => !allowed.has(key)) ||
      Object.values(descriptors).some((descriptor) => !("value" in descriptor))) {
    throw new DacsError("settlement store lease options must be stable own data");
  }
  const owner = descriptors.owner?.value ?? randomUUID();
  const leaseDurationMs = descriptors.leaseDurationMs?.value ?? DEFAULT_LEASE_DURATION_MS;
  const rawNow = descriptors.now?.value ?? Date.now;
  if (typeof owner !== "string" || owner.length === 0 || owner.trim() !== owner ||
      !/^[\x20-\x7e]+$/.test(owner) || !Number.isSafeInteger(leaseDurationMs) ||
      leaseDurationMs <= 0 || typeof rawNow !== "function" || nodeTypes.isProxy(rawNow)) {
    throw new DacsError("settlement store lease options are invalid");
  }
  const now = Function.prototype.bind.call(rawNow, undefined) as () => number;
  return Object.freeze({ owner, leaseDurationMs, now });
}

type BoundSettlementLog = Readonly<{
  [K in keyof SettlementLog]: SettlementLog[K];
}>;

function settlementLogMethod<K extends keyof SettlementLog>(
  log: SettlementLog,
  name: K,
): SettlementLog[K] {
  let cursor: object | null = log;
  while (cursor !== null) {
    if (nodeTypes.isProxy(cursor)) {
      throw new DacsError("settlement log must not be a proxy");
    }
    const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function" ||
          nodeTypes.isProxy(descriptor.value)) {
        throw new DacsError(`settlement log ${String(name)} must be stable callable data`);
      }
      return Function.prototype.bind.call(descriptor.value, log) as SettlementLog[K];
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  throw new DacsError(`settlement log is missing ${String(name)}`);
}

function captureSettlementLog(log: SettlementLog): BoundSettlementLog {
  if (log === null || typeof log !== "object" || nodeTypes.isProxy(log)) {
    throw new DacsError("settlement log must be a stable object capability");
  }
  return Object.freeze({
    claimIntent: settlementLogMethod(log, "claimIntent"),
    isCurrent: settlementLogMethod(log, "isCurrent"),
    grantRecovery: settlementLogMethod(log, "grantRecovery"),
    putOutcome: settlementLogMethod(log, "putOutcome"),
    releaseIntent: settlementLogMethod(log, "releaseIntent"),
  });
}

function isReplayAuthorization(value: unknown): value is SettlementReplayAuthorization {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, "disposition");
  return descriptor !== undefined && "value" in descriptor &&
    descriptor.value === "replay-authorized";
}

function captureReplayAuthorization(
  value: SettlementReplayAuthorization,
  bindingHash: string,
  expectedEffectIdentity: string | undefined,
): Readonly<SettlementReplayAuthorization> {
  if (nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) {
    throw new DacsError("settlement replay authorization must be stable data");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = [
    "disposition", "bindingHash", "effectIdentity", "protection", "assertReplaySafe",
  ];
  if (Object.keys(descriptors).length !== keys.length ||
      keys.some((key) => !descriptors[key] || !("value" in descriptors[key]!))) {
    throw new DacsError("settlement replay authorization has an invalid shape");
  }
  if (descriptors.disposition!.value !== "replay-authorized" ||
      descriptors.bindingHash!.value !== bindingHash ||
      typeof expectedEffectIdentity !== "string" ||
      descriptors.effectIdentity!.value !== expectedEffectIdentity ||
      (descriptors.protection!.value !== "deterministic-external-idempotency" &&
       descriptors.protection!.value !== "prior-effect-terminal") ||
      typeof descriptors.assertReplaySafe!.value !== "function" ||
      nodeTypes.isProxy(descriptors.assertReplaySafe!.value)) {
    throw new DacsError(
      "settlement replay authorization does not bind the retained effect identity",
    );
  }
  const assertReplaySafe = Function.prototype.bind.call(
    descriptors.assertReplaySafe!.value,
    value,
  ) as SettlementReplayAuthorization["assertReplaySafe"];
  return Object.freeze({
    disposition: "replay-authorized",
    bindingHash,
    effectIdentity: expectedEffectIdentity,
    protection: descriptors.protection!.value as SettlementReplayAuthorization["protection"],
    assertReplaySafe,
  });
}

/** A generation-fenced idempotency store over a durable-capable log. */
export function createIdempotencyStore(
  log: SettlementLog = createInMemorySettlementLog(),
  options: Readonly<SettlementIdempotencyStoreOptions> = {},
): SettlementIdempotencyStore {
  const policy = storeOptions(options);
  const durable = captureSettlementLog(log);
  const inflight = new Map<string, Readonly<{
    bindingHash: string;
    promise: Promise<SettleResult>;
  }>>();
  const now = (): number => {
    const value = policy.now();
    if (!Number.isSafeInteger(value) || value < 0 ||
        value > Number.MAX_SAFE_INTEGER - policy.leaseDurationMs) {
      throw new DacsError("settlement store clock returned an invalid timestamp");
    }
    return value;
  };

  return {
    async once(key, binding, submit, reconcile) {
      const capturedBinding = frozenClone(
        binding,
        "settlement idempotency binding",
      ) as Readonly<SettlementBinding>;
      const bindingHash = settlementBindingHash(capturedBinding);
      if (settlementKey(
        capturedBinding.railId,
        capturedBinding.jobId,
        capturedBinding.phaseIndex,
      ) !== key) {
        throw new DacsError("settlement binding does not match its idempotency key");
      }
      const flying = inflight.get(key);
      if (flying) {
        if (flying.bindingHash !== bindingHash) {
          throw new DacsError(`settlement ${key} is already running under different terms`);
        }
        return captureBoundResult(
          await flying.promise,
          capturedBinding,
          "in-flight settlement result",
        ) as SettleResult;
      }

      const operation = (async (): Promise<SettleResult> => {
        const claim = captureIntentClaim(await durable.claimIntent({
          key,
          bindingHash,
          owner: policy.owner,
          now: now(),
          leaseDurationMs: policy.leaseDurationMs,
        }));
        if (claim.status === "conflict") {
          throw new DacsError(
            `settlement ${key} is retained under different terms; refusing reuse or resubmission`,
          );
        }
        if (claim.status === "outcome") {
          if (claim.outcome.bindingHash !== bindingHash) {
            throw new DacsError(`settlement ${key} outcome binding conflicts with requested terms`);
          }
          return captureBoundResult(
            claim.outcome.result as SettleResult,
            capturedBinding,
            "cached settlement result",
          ) as SettleResult;
        }
        if (claim.status === "held") {
          if (claim.bindingHash !== bindingHash) {
            throw new DacsError(`settlement ${key} is held under different terms`);
          }
          throw new DacsError(
            `settlement ${key} has an unresolved or in-flight current generation; refusing to resubmit (double-pay risk)`,
          );
        }

        if (claim.bindingHash !== bindingHash || claim.lease.owner !== policy.owner ||
            (claim.lease.stage !== "fresh" && claim.lease.stage !== "reconcile")) {
          throw new DacsError(`settlement ${key} returned an invalid acquired generation`);
        }

        let lease = claim.lease;
        const fence = (): Readonly<SettlementEffectFence> => {
          const token = Object.freeze({ owner: lease.owner, generation: lease.generation });
          return Object.freeze({
            ...token,
            settlementKey: key,
            bindingHash,
            ...(capturedBinding.effectIdentity === undefined
              ? {}
              : { effectIdentity: capturedBinding.effectIdentity }),
            async assertCurrent() {
              if (await durable.isCurrent({
                key,
                bindingHash,
                lease: token,
                now: now(),
              }) !== true) {
                throw new DacsError(`settlement ${key} effect fence is stale`);
              }
            },
          });
        };

        const persist = async (
          result: Readonly<SettleResult>,
          effectFence: Readonly<SettlementEffectFence>,
        ): Promise<SettleResult> => {
          const checked = captureBoundResult(
            result as SettleResult,
            capturedBinding,
            "settlement result before persistence",
          );
          const write = captureOutcomeWrite(await durable.putOutcome({
            key,
            bindingHash,
            lease: effectFence,
            result: checked,
            now: now(),
          }));
          if (write.status === "conflict") {
            throw new DacsError(`settlement ${key} outcome conflicts with retained terms or result`);
          }
          if (write.status === "stale") {
            throw new DacsError(`settlement ${key} outcome was produced by a stale generation`);
          }
          if (write.status === "recorded" || write.status === "existing") {
            if (write.outcome.bindingHash !== bindingHash) {
              throw new DacsError(`settlement ${key} store returned an outcome for different terms`);
            }
            return captureBoundResult(
              write.outcome.result as SettleResult,
              capturedBinding,
              "recorded settlement result",
            ) as SettleResult;
          }
          throw new DacsError(`settlement ${key} outcome write is invalid`);
        };

        let effectFence = fence();
        if (lease.stage === "reconcile") {
          if (!reconcile) {
            throw new DacsError(
              `settlement ${key} has an expired unresolved attempt and no reconcile capability; refusing to resubmit (double-pay risk)`,
            );
          }
          await effectFence.assertCurrent();
          const rawFound = await reconcile(key, effectFence);
          await effectFence.assertCurrent();
          if (rawFound !== null && !isReplayAuthorization(rawFound)) {
            const found = captureBoundResult(
              rawFound,
              capturedBinding,
              "reconciled settlement result",
            );
            if (!isDefinitive(found)) {
              throw new DacsError(
                `settlement ${key} reconciliation was not definitive; require a finalized result or bound replay authorization`,
              );
            }
            return persist(found, effectFence);
          }
          if (rawFound === null) {
            throw new DacsError(
              `settlement ${key} is authoritatively absent, but absence alone cannot revoke a prior external effect; operator action required`,
            );
          }
          const replay = captureReplayAuthorization(
            rawFound,
            bindingHash,
            capturedBinding.effectIdentity,
          );
          await replay.assertReplaySafe(effectFence);
          await effectFence.assertCurrent();
          const grant = captureRecoveryGrant(await durable.grantRecovery({
            key,
            bindingHash,
            lease: effectFence,
            owner: policy.owner,
            now: now(),
            leaseDurationMs: policy.leaseDurationMs,
          }));
          if (grant.status === "outcome") {
            if (grant.outcome.bindingHash !== bindingHash) {
              throw new DacsError(
                `settlement ${key} concurrent outcome belongs to different terms`,
              );
            }
            return captureBoundResult(
              grant.outcome.result as SettleResult,
              capturedBinding,
              "concurrently recorded settlement result",
            ) as SettleResult;
          }
          if (grant.status !== "granted") {
            throw new DacsError(
              `settlement ${key} recovery grant is ${grant.status}; refusing stale replay`,
            );
          }
          if (grant.bindingHash !== bindingHash || grant.lease.owner !== policy.owner ||
              grant.lease.stage !== "replay") {
            throw new DacsError(`settlement ${key} returned an invalid replay generation`);
          }
          lease = grant.lease;
          effectFence = fence();
          await replay.assertReplaySafe(effectFence);
          await effectFence.assertCurrent();
        }

        // The reference rails assert this same fence again immediately beside
        // their irreversible request. An ordinary empty-hash failure is still
        // ambiguous; only an explicit not-invoked rail disposition releases.
        await effectFence.assertCurrent();
        const submission = captureSubmission(await submit(effectFence));
        const result = captureBoundResult(
          ("disposition" in submission ? submission.result : submission) as SettleResult,
          capturedBinding,
          "submitted settlement result",
        );
        if (isDefinitive(result)) return persist(result, effectFence);
        if ("disposition" in submission) {
          const released = await durable.releaseIntent({
            key,
            bindingHash,
            lease: effectFence,
            now: now(),
          });
          if (released !== "released" && released !== "stale" && released !== "conflict") {
            throw new DacsError(`settlement ${key} clean attempt release is invalid`);
          }
          if (released !== "released") {
            throw new DacsError(`settlement ${key} clean attempt release is ${released}`);
          }
        }
        return captureBoundResult(
          result as SettleResult,
          capturedBinding,
          "returned settlement result",
        ) as SettleResult;
      })();

      inflight.set(key, { bindingHash, promise: operation });
      try {
        return captureBoundResult(
          await operation,
          capturedBinding,
          "settlement store result",
        ) as SettleResult;
      } finally {
        const current = inflight.get(key);
        if (current?.promise === operation) inflight.delete(key);
      }
    },
  };
}
