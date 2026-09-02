import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import {
  deriveAp2IdempotencyKey,
  type Ap2SettlementIntent,
} from "../../src/rails/ap2.js";
import { createFsAp2BindingStore } from "../../src/rails/ap2SettlementFs.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const result = await mkdtemp(join(tmpdir(), "dacs-ap2-"));
  dirs.push(result);
  return result;
}

const TX = "M-_9dPIbMk7OgNvy87SmOf0bWlrKktiUkMKVtAYwajo";
const JOB = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

function intent(jobId = JOB): Ap2SettlementIntent {
  const unsigned = {
    intentVersion: "1" as const,
    transactionId: TX,
    jobId,
    phaseIndex: 2,
    agreementHash: "a".repeat(64),
    idempotencyKey: deriveAp2IdempotencyKey(jobId, 2),
    mandateId: "mandate-1",
    payee: "merchant",
    amount: "1.5",
    currency: "USD",
    protocolVersion: "0.2",
    paymentInstrumentId: "pm_card_visa",
  };
  return { ...unsigned, bindingHash: sha256Hex(canonicalize(unsigned)) };
}

describe("filesystem AP2-7 binding store", () => {
  test("rejects option accessors without invoking them", async () => {
    let getterCalls = 0;
    const options = Object.defineProperty({}, "dir", {
      enumerable: true,
      get() { getterCalls += 1; return "unreachable"; },
    });
    await expect(createFsAp2BindingStore(options as never)).rejects.toThrow(/exact data properties/);
    expect(getterCalls).toBe(0);
  });

  test("persists an exact generation-fenced binding across instances", async () => {
    const dir = await directory();
    const first = await createFsAp2BindingStore({ dir });
    const acquired = await first.claim({
      intent: intent(), owner: "worker-a", now: 1, leaseDurationMs: 10,
    });
    expect(acquired).toMatchObject({ status: "acquired", lease: { generation: 1 } });

    const second = await createFsAp2BindingStore({ dir });
    await expect(second.claim({
      intent: intent(), owner: "worker-b", now: 2, leaseDurationMs: 10,
    })).resolves.toMatchObject({ status: "waiting", lease: { generation: 1 } });
    await expect(second.claim({
      intent: intent(), owner: "worker-b", now: 12, leaseDurationMs: 10,
    })).resolves.toMatchObject({ status: "acquired", lease: { generation: 2 } });

    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    const files = await readdir(join(dir, "records"));
    expect(files).toHaveLength(1);
    expect((await stat(join(dir, "records", files[0]!))).mode & 0o777).toBe(0o600);
  });

  test("concurrent first presentations install one binding and reject the other job", async () => {
    const dir = await directory();
    const a = await createFsAp2BindingStore({ dir });
    const b = await createFsAp2BindingStore({ dir });
    const [one, two] = await Promise.all([
      a.claim({ intent: intent(JOB), owner: "a", now: 1, leaseDurationMs: 10 }),
      b.claim({
        intent: intent("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
        owner: "b",
        now: 1,
        leaseDurationMs: 10,
      }),
    ]);
    expect([one.status, two.status].sort()).toEqual(["acquired", "conflict"]);
  });

  test("a durable provider reference resumes after restart without a new submission authority", async () => {
    const dir = await directory();
    const value = intent();
    const first = await createFsAp2BindingStore({ dir });
    const claim = await first.claim({
      intent: value, owner: "worker-a", now: 1, leaseDurationMs: 10,
    });
    expect(claim.status).toBe("acquired");
    if (claim.status !== "acquired") throw new Error("claim failed");
    await expect(first.recordProviderRef({
      transactionId: value.transactionId,
      bindingHash: value.bindingHash,
      owner: claim.lease.owner,
      generation: claim.lease.generation,
      providerRef: "pi_restart123",
    })).resolves.toEqual({ status: "recorded" });

    const restarted = await createFsAp2BindingStore({ dir });
    await expect(restarted.claim({
      intent: value, owner: "worker-restarted", now: 12, leaseDurationMs: 10,
    })).resolves.toMatchObject({
      status: "acquired",
      providerRef: "pi_restart123",
      lease: { generation: 2 },
    });
  });

  test("corrupt durable bytes fail closed", async () => {
    const dir = await directory();
    const store = await createFsAp2BindingStore({ dir });
    await store.claim({ intent: intent(), owner: "a", now: 1, leaseDurationMs: 10 });
    const [record] = await readdir(join(dir, "records"));
    await writeFile(join(dir, "records", record!), "{not-json", { mode: 0o600 });
    await expect(store.claim({
      intent: intent(), owner: "b", now: 12, leaseDurationMs: 10,
    })).resolves.toMatchObject({ status: "corrupt" });
  });

  test("never reclaims an aged lock still owned by a live process", async () => {
    const dir = await directory();
    await createFsAp2BindingStore({ dir });
    const lock = join(dir, "locks", `${sha256Hex(TX)}.lock`);
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner"), JSON.stringify({
      token: "00000000-0000-4000-8000-000000000000",
      pid: process.pid,
    }), { mode: 0o600 });
    await utimes(lock, 0, 0);
    const contender = await createFsAp2BindingStore({
      dir, lockTimeoutMs: 25, lockStaleMs: 5, lockPollMs: 1,
    });
    await expect(contender.claim({
      intent: intent(), owner: "a", now: 1, leaseDurationMs: 10,
    })).rejects.toThrow(/timed out waiting/);
  });

  test("reclaims an aged lock whose owner process no longer exists", async () => {
    const dir = await directory();
    await createFsAp2BindingStore({ dir });
    const lock = join(dir, "locks", `${sha256Hex(TX)}.lock`);
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner"), JSON.stringify({
      token: "00000000-0000-4000-8000-000000000001",
      pid: 2_000_000_000,
    }), { mode: 0o600 });
    await utimes(lock, 0, 0);
    const contender = await createFsAp2BindingStore({
      dir, lockTimeoutMs: 100, lockStaleMs: 5, lockPollMs: 1,
    });
    await expect(contender.claim({
      intent: intent(), owner: "a", now: 1, leaseDurationMs: 10,
    })).resolves.toMatchObject({ status: "acquired" });
  });
});
