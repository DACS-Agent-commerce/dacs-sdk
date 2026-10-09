import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { SettleResult } from "../../src/agent/runSessionCore.js";
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
const claimInput = { key: "rail:job:0", bindingHash: "a".repeat(64), owner: "first", now: 100, leaseDurationMs: 100 };
const result: SettleResult = {
  ok: true, txHash: "tx-original", chainId: "test-network", payer: "payer", payee: "payee",
  finality: { model: "block-depth", finalityBlocks: 2 },
};

describe("test filesystem SettlementLog contract", () => {
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
