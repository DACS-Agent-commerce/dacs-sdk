import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { SettleResult } from "../../src/agent/runSessionCore.js";
import {
  createIdempotencyStore, createInMemorySettlementLog, settlementBindingHash, settlementKey,
  type SettlementBinding, type SettlementLog,
} from "../../src/rails/idempotency.js";
import { createTestFsSettlementLog } from "../fixtures/settlementLogFs.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dacs-settlement-log-"));
  roots.push(root);
  return { root, log: createTestFsSettlementLog(root) };
}
// A canonical CORE JID-1 ULID (the Standard's `valid-ulid-full-input` vector).
const JOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const claimInput = {
  key: settlementKey("pay-x402", JOB_ID, 0), bindingHash: "a".repeat(64), owner: "first", now: 100, leaseDurationMs: 100,
};
const result: SettleResult = {
  ok: true, txHash: "tx-original", chainId: "test-network", payer: "payer", payee: "payee",
  finality: { model: "block-depth", finalityBlocks: 2 },
};

describe("test filesystem SettlementLog durability", () => {
  test("expiry is exact and replay atomically replaces the reconcile generation", async () => {
    const { root, log } = await fixture();
    const first = await log.claimIntent(claimInput);
    expect(first.status).toBe("acquired");
    if (first.status !== "acquired") throw new Error("expected initial lease");
    const input = { key: claimInput.key, bindingHash: claimInput.bindingHash, lease: first.lease };
    expect(await log.isCurrent({ ...input, now: 199 })).toBe(true);
    expect(await log.isCurrent({ ...input, now: 200 })).toBe(false);
    expect(await log.grantRecovery({ ...input, now: 199, owner: "replay", leaseDurationMs: 100 })).toEqual({ status: "stale" });
    expect(await log.putOutcome({ ...input, now: 200, result })).toEqual({ status: "stale" });
    expect(await log.releaseIntent({ ...input, now: 200 })).toBe("stale");
    const recovered = await createTestFsSettlementLog(root).claimIntent({ ...claimInput, owner: "recovery", now: 200 });
    expect(recovered).toMatchObject({ status: "acquired", lease: { stage: "reconcile", generation: 2 } });
    if (recovered.status !== "acquired") throw new Error("expected recovery lease");
    const recoveryInput = { ...input, lease: recovered.lease, now: 200, owner: "replay", leaseDurationMs: 100 };
    const replay = await log.grantRecovery(recoveryInput);
    expect(replay).toMatchObject({ status: "granted", lease: { stage: "replay", generation: 3, owner: "replay" } });
    expect(await log.grantRecovery(recoveryInput)).toEqual({ status: "stale" });
    expect(await log.isCurrent({ ...input, lease: recovered.lease, now: 200 })).toBe(false);
  });

  test("release retains immutable terms and advances the next fresh generation", async () => {
    const { root, log } = await fixture();
    const first = await log.claimIntent(claimInput);
    if (first.status !== "acquired") throw new Error("expected initial lease");
    const input = { key: claimInput.key, bindingHash: claimInput.bindingHash, lease: first.lease, now: 100 };
    expect(await log.releaseIntent({ ...input, lease: { ...first.lease, owner: "impostor" } })).toBe("stale");
    expect(await log.releaseIntent(input)).toBe("released");
    const reopened = createTestFsSettlementLog(root);
    expect(await reopened.claimIntent({ ...claimInput, bindingHash: "b".repeat(64) })).toEqual({ status: "conflict" });
    expect(await reopened.claimIntent({ ...claimInput, owner: "second" })).toMatchObject({
      status: "acquired", lease: { owner: "second", generation: 2, stage: "fresh" },
    });
    expect(await reopened.putOutcome({ ...input, result })).toEqual({ status: "stale" });
  });

  test("outcomes are canonical snapshots on writes and reopened reads", async () => {
    const { root, log } = await fixture();
    const first = await log.claimIntent(claimInput);
    if (first.status !== "acquired") throw new Error("expected initial lease");
    const mutable = structuredClone(result);
    const input = { key: claimInput.key, bindingHash: claimInput.bindingHash, lease: first.lease, now: 100 };
    const written = await log.putOutcome({ ...input, result: mutable });
    expect(written.status).toBe("recorded");
    mutable.txHash = "mutated";
    mutable.finality!.finalityBlocks = 99;
    if (written.status !== "recorded") throw new Error("expected recorded outcome");
    expect(written.outcome.result).toEqual(result);
    expect(() => { (written.outcome.result as SettleResult).finality!.finalityBlocks = 88; }).toThrow(TypeError);
    const read = await createTestFsSettlementLog(root).claimIntent({ ...claimInput, owner: "restarted", now: 500 });
    expect(read).toEqual({ status: "outcome", outcome: { bindingHash: claimInput.bindingHash, result } });
    if (read.status !== "outcome") throw new Error("expected cached outcome");
    expect(read.outcome).not.toBe(written.outcome);
    expect(read.outcome.result.finality).not.toBe(written.outcome.result.finality);
    expect(await log.putOutcome({ ...input, result })).toMatchObject({ status: "existing" });
    expect(await log.putOutcome({ ...input, result: mutable })).toEqual({ status: "conflict" });
    expect(await log.releaseIntent(input)).toBe("stale");
  });
});

// The shipped reference log and the restart fixture must satisfy one contract.
const LOGS: Array<[string, () => Promise<SettlementLog>]> = [
  ["in-memory", async () => createInMemorySettlementLog()],
  ["filesystem fixture", async () => (await fixture()).log],
];
const H = claimInput.bindingHash;
const OTHER = "b".repeat(64);
const KEY = claimInput.key;

async function acquired(log: SettlementLog, now: number, owner = "node") {
  const claim = await log.claimIntent({ ...claimInput, owner, now });
  if (claim.status !== "acquired") throw new Error(`expected an acquired lease, got ${claim.status}`);
  return claim.lease;
}

describe.each(LOGS)("SettlementLog contract: %s", (_name, open) => {
  test("a second takeover under one fixed owner never reissues a generation", async () => {
    const log = await open();
    await acquired(log, 100);
    const second = await acquired(log, 200);
    const third = await acquired(log, 300);
    expect(third.generation).toBe(second.generation + 1);
    expect(await log.isCurrent({ key: KEY, bindingHash: H, lease: second, now: 250 })).toBe(false);
  });

  test("a takeover after a replay grant fences the paused replay holder", async () => {
    const log = await open();
    await acquired(log, 100);
    const reconcile = await acquired(log, 200);
    const replay = await log.grantRecovery({
      key: KEY, bindingHash: H, lease: reconcile, owner: "node", now: 200, leaseDurationMs: 100,
    });
    if (replay.status !== "granted") throw new Error("expected a replay grant");
    expect(replay.lease.generation).toBe(3);
    const takeover = await acquired(log, 300);
    expect(takeover).toMatchObject({ generation: 4, stage: "reconcile" });
    const paused = { key: KEY, bindingHash: H, lease: replay.lease, now: 250 };
    expect(await log.isCurrent(paused)).toBe(false);
    expect(await log.putOutcome({ ...paused, result })).toEqual({ status: "stale" });
    expect(await log.releaseIntent(paused)).toBe("stale");
  });

  test("a missing record is stale for every transition", async () => {
    const log = await open();
    const lease = { owner: "node", generation: 1 };
    const input = { key: KEY, bindingHash: H, lease, now: 100 };
    expect(await log.isCurrent(input)).toBe(false);
    expect(await log.grantRecovery({ ...input, owner: "node", leaseDurationMs: 100 })).toEqual({ status: "stale" });
    expect(await log.putOutcome({ ...input, result })).toEqual({ status: "stale" });
    expect(await log.releaseIntent(input)).toBe("stale");
    // None of them created the record.
    expect(await acquired(log, 100)).toMatchObject({ generation: 1, stage: "fresh" });
  });

  test("changed terms conflict for every transition and leave the live lease intact", async () => {
    const log = await open();
    await acquired(log, 100);
    const reconcile = await acquired(log, 200);
    const changed = { key: KEY, bindingHash: OTHER, lease: reconcile, now: 200 };
    expect(await log.claimIntent({ ...claimInput, bindingHash: OTHER, now: 400 })).toEqual({ status: "conflict" });
    expect(await log.isCurrent(changed)).toBe(false);
    expect(await log.grantRecovery({ ...changed, owner: "node", leaseDurationMs: 100 })).toEqual({ status: "conflict" });
    expect(await log.putOutcome({ ...changed, result })).toEqual({ status: "conflict" });
    expect(await log.releaseIntent(changed)).toBe("conflict");
    expect(await log.isCurrent({ ...changed, bindingHash: H })).toBe(true);
  });

  test("every lease token field is checked, and expiry is exact", async () => {
    const log = await open();
    const lease = await acquired(log, 100);
    const input = { key: KEY, bindingHash: H, lease, now: 150 };
    expect(await log.isCurrent(input)).toBe(true);
    expect(await log.isCurrent({ ...input, lease: { ...lease, owner: "other" } })).toBe(false);
    expect(await log.isCurrent({ ...input, lease: { ...lease, generation: lease.generation + 1 } })).toBe(false);
    expect(await log.isCurrent({ ...input, now: 199 })).toBe(true);
    expect(await log.isCurrent({ ...input, now: 200 })).toBe(false);
    for (const wrong of [{ ...lease, owner: "other" }, { ...lease, generation: 0 }]) {
      expect(await log.putOutcome({ ...input, lease: wrong, result })).toEqual({ status: "stale" });
      expect(await log.releaseIntent({ ...input, lease: wrong })).toBe("stale");
    }
    expect(await log.isCurrent(input)).toBe(true);
  });

  test("only a current reconcile-stage lease can be granted recovery", async () => {
    const log = await open();
    const fresh = await acquired(log, 100);
    const grant = (lease: typeof fresh, now: number) => log.grantRecovery({
      key: KEY, bindingHash: H, lease, owner: "node", now, leaseDurationMs: 100,
    });
    expect(await grant(fresh, 150)).toEqual({ status: "stale" });
    const reconcile = await acquired(log, 200);
    expect(await grant(reconcile, 300)).toEqual({ status: "stale" });
    const replay = await grant(reconcile, 250);
    if (replay.status !== "granted") throw new Error("expected a replay grant");
    expect(await grant(replay.lease, 260)).toEqual({ status: "stale" });
  });

  test("an outcome is terminal for every transition", async () => {
    const log = await open();
    const lease = await acquired(log, 100);
    const input = { key: KEY, bindingHash: H, lease, now: 150 };
    expect(await log.putOutcome({ ...input, result })).toMatchObject({ status: "recorded" });
    const outcome = { bindingHash: H, result };
    expect(await log.isCurrent(input)).toBe(false);
    expect(await log.claimIntent({ ...claimInput, now: 500 })).toEqual({ status: "outcome", outcome });
    expect(await log.grantRecovery({ ...input, owner: "node", leaseDurationMs: 100 })).toEqual({ status: "outcome", outcome });
    expect(await log.putOutcome({ ...input, result })).toEqual({ status: "existing", outcome });
    expect(await log.putOutcome({ ...input, result: { ...result, txHash: "tx-other" } })).toEqual({ status: "conflict" });
    expect(await log.releaseIntent(input)).toBe("stale");
  });

  test("a malformed settlement result is refused without recording", async () => {
    const log = await open();
    const lease = await acquired(log, 100);
    const input = { key: KEY, bindingHash: H, lease, now: 150 };
    await expect(log.putOutcome({ ...input, result: { ...result, txHash: 7 } as never })).rejects.toThrow();
    expect(await log.isCurrent(input)).toBe(true);
  });
});

const ok = (txHash: string): SettleResult => ({
  ok: true, txHash, chainId: "eip155:84532", payer: "0xpayer", payee: "0xpayee",
  finality: { model: "block-depth", finalityBlocks: 12 },
});
const binding = (override: Partial<SettlementBinding> = {}): Readonly<SettlementBinding> => Object.freeze({
  bindingVersion: "1", railId: "evm-erc20-usdc", jobId: JOB_ID, phaseIndex: 0, phase: "pay-evm-erc20",
  amount: "1000000", agreementAsset: "USDC", settlementAsset: "0xtoken", payer: "0xpayer", payee: "0xpayee",
  network: "eip155:84532", finality: Object.freeze({ model: "block-depth", finalityBlocks: 12 }), ...override,
});
const STORE_KEY = settlementKey("evm-erc20-usdc", JOB_ID, 0);

async function crashedIntent(log: SettlementLog, terms: Readonly<SettlementBinding>, clock: { now: number }) {
  await expect(createIdempotencyStore(log, { owner: "crashed", leaseDurationMs: 10, now: () => clock.now })
    .once(STORE_KEY, terms, async () => { throw new Error("crash after intent"); })).rejects.toThrow(/crash after intent/);
}

describe.each(LOGS)("idempotency store recovery over the %s log", (_name, open) => {
  test.each([
    ["before", false],
    ["after", true],
  ] as const)("a replay-safety proof failing %s the grant prevents submission", async (_when, afterGrant) => {
    const log = await open();
    const terms = binding({ effectIdentity: "effect-1" });
    const clock = { now: 0 };
    await crashedIntent(log, terms, clock);
    clock.now = 11;
    let grants = 0;
    let checks = 0;
    let submissions = 0;
    const counted: SettlementLog = {
      ...log,
      async grantRecovery(input) {
        const grant = await log.grantRecovery(input);
        if (grant.status === "granted") grants += 1;
        return grant;
      },
    };
    await expect(createIdempotencyStore(counted, { owner: "restarted", leaseDurationMs: 100, now: () => clock.now })
      .once(STORE_KEY, terms, async () => { submissions += 1; return ok("0xreplacement"); }, async () => ({
        disposition: "replay-authorized" as const, bindingHash: settlementBindingHash(terms),
        effectIdentity: "effect-1", protection: "prior-effect-terminal" as const,
        async assertReplaySafe() {
          checks += 1;
          if (!afterGrant || checks > 1) throw new Error("prior effect may still execute");
        },
      }))).rejects.toThrow(/prior effect may still execute/);
    expect(submissions).toBe(0);
    expect(checks).toBe(afterGrant ? 2 : 1);
    expect(grants).toBe(afterGrant ? 1 : 0);
  });

  test("an ok:false reconciliation is not adopted and leaves the intent recoverable", async () => {
    const log = await open();
    const clock = { now: 0 };
    await crashedIntent(log, binding(), clock);
    clock.now = 11;
    let submissions = 0;
    const submit = async () => { submissions += 1; return ok("0xdouble"); };
    const maybe = { ok: false, txHash: "0xmaybe", chainId: "eip155:84532", payer: "0xpayer", payee: "0xpayee" };
    await expect(createIdempotencyStore(log, { owner: "r1", leaseDurationMs: 10, now: () => clock.now })
      .once(STORE_KEY, binding(), submit, async () => maybe)).rejects.toThrow(/not definitive/);
    clock.now = 22;
    await expect(createIdempotencyStore(log, { owner: "r2", leaseDurationMs: 10, now: () => clock.now })
      .once(STORE_KEY, binding(), submit, async () => ok("0xlanded"))).resolves.toMatchObject({ txHash: "0xlanded" });
    expect(submissions).toBe(0);
  });

  test("a fresh attempt whose lease expires before submission does not submit", async () => {
    const times = [0, 10];
    let index = 0;
    let submissions = 0;
    await expect(createIdempotencyStore(await open(), {
      owner: "slow", leaseDurationMs: 10, now: () => times[Math.min(index++, times.length - 1)]!,
    }).once(STORE_KEY, binding(), async () => { submissions += 1; return ok("0xlate"); })).rejects.toThrow(/fence is stale/);
    expect(submissions).toBe(0);
  });
});

test("idempotency store: a concurrent call with different terms does not join the in-flight settlement", async () => {
  const store = createIdempotencyStore();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let submissions = 0;
  const first = store.once(STORE_KEY, binding(), async () => { submissions += 1; await gate; return ok("0xfirst"); });
  await expect(store.once(STORE_KEY, binding({ amount: "999000000" }), async () => {
    submissions += 1;
    return ok("0xsecond");
  })).rejects.toThrow(/already running under different terms/);
  release();
  await expect(first).resolves.toMatchObject({ txHash: "0xfirst" });
  expect(submissions).toBe(1);
});
