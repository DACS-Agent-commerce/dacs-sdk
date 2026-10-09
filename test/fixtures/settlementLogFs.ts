import { randomUUID } from "node:crypto";
import {
  closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import { snapshotCanonicalJsonRead } from "../../src/canonical/snapshot.js";
import { DacsError } from "../../src/errors.js";
import type {
  SettlementIntentLease, SettlementLeaseToken, SettlementLog, SettlementOutcomeRecord,
} from "../../src/rails/idempotency.js";

interface RecordValue {
  bindingHash: string;
  generation: number;
  lease?: SettlementIntentLease;
  outcome?: SettlementOutcomeRecord;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function snapshot<T>(value: T): T {
  return freeze(snapshotCanonicalJsonRead(value, "test filesystem settlement snapshot"));
}

function expiresAt(now: number, duration: number): number {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(duration) ||
      duration <= 0 || now > Number.MAX_SAFE_INTEGER - duration) {
    throw new DacsError("test settlement lease timestamp or duration is invalid");
  }
  return now + duration;
}

function nextGeneration(record?: RecordValue): number {
  const generation = (record?.generation ?? 0) + 1;
  if (!Number.isSafeInteger(generation)) throw new DacsError("test settlement generation exhausted");
  return generation;
}

function current(record: RecordValue | undefined, input: {
  bindingHash: string; lease: Readonly<SettlementLeaseToken>; now: number;
}): boolean {
  return record !== undefined && record.outcome === undefined &&
    record.bindingHash === input.bindingHash && record.lease?.owner === input.lease.owner &&
    record.lease.generation === input.lease.generation && record.lease.expiresAt > input.now;
}

/**
 * Test-only append-only CAS log. Each revision is an immutable complete snapshot;
 * linking a flushed candidate to the next revision is the exclusive atomic commit.
 * Losers reread and retry. No process lock can be stranded by SIGKILL. Candidates
 * left by a crash are ignored; the test harness removes the entire directory.
 * This fixture models process restart on a local filesystem, not a public adapter.
 */
export function createTestFsSettlementLog(dir: string): SettlementLog {
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  function transaction<T>(key: string, decide: (record?: RecordValue) => {
    result: T; next?: RecordValue;
  }): T {
    const records = join(dir, sha256Hex(key));
    mkdirSync(records, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 10_000;
    let revision = 0;
    let record: RecordValue | undefined;
    while (Date.now() < deadline) {
      try {
        record = JSON.parse(readFileSync(join(records, `${revision}.json`), "utf8")) as RecordValue;
        revision += 1;
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const decision = decide(record);
      if (!decision.next) return snapshot(decision.result);
      const candidate = join(records, `${randomUUID()}.candidate`);
      const handle = openSync(candidate, "wx", 0o600);
      try {
        writeFileSync(handle, canonicalize(decision.next));
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      try {
        linkSync(candidate, join(records, `${revision}.json`));
        const directory = openSync(records, "r");
        try { fsyncSync(directory); } finally { closeSync(directory); }
        return snapshot(decision.result);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      } finally {
        unlinkSync(candidate);
      }
    }
    throw new DacsError("test filesystem settlement CAS deadline exceeded");
  }

  return {
    async claimIntent(input) {
      const expiry = expiresAt(input.now, input.leaseDurationMs);
      return transaction<Awaited<ReturnType<SettlementLog["claimIntent"]>>>(input.key, (record) => {
        if (record && record.bindingHash !== input.bindingHash) return { result: { status: "conflict" } };
        if (record?.outcome) return { result: { status: "outcome", outcome: record.outcome } };
        if (record?.lease && record.lease.expiresAt > input.now) {
          return { result: { status: "held", bindingHash: record.bindingHash, lease: record.lease } };
        }
        const lease: SettlementIntentLease = {
          owner: input.owner, generation: nextGeneration(record),
          stage: record?.lease ? "reconcile" : "fresh", expiresAt: expiry,
        };
        return {
          result: { status: "acquired", bindingHash: input.bindingHash, lease },
          next: { bindingHash: input.bindingHash, generation: lease.generation, lease },
        };
      });
    },
    async isCurrent(input) {
      return transaction(input.key, (record) => ({ result: current(record, input) }));
    },
    async grantRecovery(input) {
      const expiry = expiresAt(input.now, input.leaseDurationMs);
      return transaction<Awaited<ReturnType<SettlementLog["grantRecovery"]>>>(input.key, (record) => {
        if (!record) return { result: { status: "stale" } };
        if (record.bindingHash !== input.bindingHash) return { result: { status: "conflict" } };
        if (record.outcome) return { result: { status: "outcome", outcome: record.outcome } };
        if (!current(record, input) || record.lease?.stage !== "reconcile") {
          return { result: { status: "stale" } };
        }
        const lease: SettlementIntentLease = {
          owner: input.owner, generation: nextGeneration(record), stage: "replay", expiresAt: expiry,
        };
        return {
          result: { status: "granted", bindingHash: record.bindingHash, lease },
          next: { bindingHash: record.bindingHash, generation: lease.generation, lease },
        };
      });
    },
    async putOutcome(input) {
      const outcome = snapshot({ bindingHash: input.bindingHash, result: input.result });
      if (typeof outcome.result.ok !== "boolean" || typeof outcome.result.txHash !== "string" ||
          typeof outcome.result.chainId !== "string" || typeof outcome.result.payer !== "string" ||
          typeof outcome.result.payee !== "string") {
        throw new DacsError("test filesystem settlement outcome is not a settlement result");
      }
      return transaction<Awaited<ReturnType<SettlementLog["putOutcome"]>>>(input.key, (record) => {
        if (!record) return { result: { status: "stale" } };
        if (record.bindingHash !== input.bindingHash) return { result: { status: "conflict" } };
        if (record.outcome) {
          return { result: canonicalize(record.outcome) === canonicalize(outcome)
            ? { status: "existing", outcome: record.outcome } : { status: "conflict" } };
        }
        if (!current(record, input)) return { result: { status: "stale" } };
        return {
          result: { status: "recorded", outcome },
          next: { bindingHash: record.bindingHash, generation: record.generation, outcome },
        };
      });
    },
    async releaseIntent(input) {
      return transaction<Awaited<ReturnType<SettlementLog["releaseIntent"]>>>(input.key, (record) => {
        if (!record) return { result: "stale" };
        if (record.bindingHash !== input.bindingHash) return { result: "conflict" };
        if (!current(record, input)) return { result: "stale" };
        return {
          result: "released",
          next: { bindingHash: record!.bindingHash, generation: record!.generation },
        };
      });
    },
  };
}
