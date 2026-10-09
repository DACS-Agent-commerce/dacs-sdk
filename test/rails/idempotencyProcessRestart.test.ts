import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  createSettlementProcessHarness, type RailMode, type SettlementProcessHarness,
} from "../fixtures/settlementProcess.js";

const harnesses: SettlementProcessHarness[] = [];
async function harness() {
  const value = await createSettlementProcessHarness();
  harnesses.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((value) => value.cleanup()));
});

async function crash(h: SettlementProcessHarness, mode: RailMode, point: "before-effect" | "before-outcome") {
  const first = h.start("first", { mode, crash: point });
  await first.wait([`${point}-first`]);
  expect(first.child.pid).not.toBe(process.pid);
  expect(first.child.kill("SIGKILL")).toBe(true);
  expect(await first.exit).toMatchObject({ code: null, signal: "SIGKILL" });
  return first.child.pid;
}

async function race(h: SettlementProcessHarness, mode: RailMode, reconcile: "landed" | "absent" | "replay") {
  const a = h.start("a", { mode, now: 200, reconcile, race: true });
  const b = h.start("b", { mode, now: 200, reconcile, race: true });
  await Promise.all([a.wait(["ready-a"]), b.wait(["ready-b"])]);
  expect(a.child.pid).not.toBe(b.child.pid);
  await h.barrier("start-race");
  const winningBarrier = await h.wait(["reconciling-a", "reconciling-b"]);
  const winnerId = winningBarrier === "reconciling-a" ? "a" : "b";
  const winner = winnerId === "a" ? a : b;
  const loser = winnerId === "a" ? b : a;
  // Keep the winner in reconciliation until the other process proves it saw the
  // held generation. This prevents sequential cached-outcome calls passing a race.
  const lost = await loser.result();
  expect(lost).toMatchObject({ ok: false, error: { name: "DacsError" } });
  expect(lost.error?.message).toMatch(/unresolved or in-flight current generation/);
  await h.barrier("finish-reconcile");
  const won = await winner.result();
  expect(await h.count("reconciles")).toBe(1);
  return won;
}

describe.each(["generic", "evm", "x402"] as const)("real Node restart: %s settlement (#43)", (mode) => {
  test.each([
    ["landed", null],
    ["absent", /absence alone.*operator action/],
    ["throws", /authoritative lookup unavailable/],
  ] as const)("SIGKILL after effect, before putOutcome: reconcile %s", async (reconcile, error) => {
    const h = await harness();
    const firstPid = await crash(h, mode, "before-outcome");
    expect(await h.count()).toBe(1);
    const restarted = await h.start("restarted", { mode, now: 200, reconcile }).result();
    expect(restarted.pid).not.toBe(firstPid);
    expect(restarted.ok).toBe(error === null);
    expect(await h.count("reconciles")).toBe(1);
    if (error === null) {
      const landed = await h.read("landed");
      expect(restarted.value).toEqual(landed);
      // A third process must load the canonical saved outcome without reconciling.
      const cached = await h.start("cached", { mode, now: 300, reconcile: "throws" }).result();
      expect(cached).toMatchObject({ ok: true, value: landed });
      expect(await h.count("reconciles")).toBe(1);
    } else {
      expect(restarted.error?.message).toMatch(error);
      // Another expired-generation retry also fails closed.
      const again = await h.start("again", { mode, now: 300, reconcile }).result();
      expect(again.ok).toBe(false);
      expect(again.error?.message).toMatch(error);
    }
    expect(await h.count()).toBe(1);
    expect(await h.count("grants")).toBe(0);
  }, 30_000);

  test("two restarted processes race to adopt the landed effect at exact lease expiry", async () => {
    const h = await harness();
    await crash(h, mode, "before-outcome");
    const winner = await race(h, mode, "landed");
    expect(winner).toMatchObject({ ok: true, value: await h.read("landed") });
    expect(await h.count()).toBe(1);
    expect(await h.count("grants")).toBe(0);
  }, 30_000);

  test("same key with changed terms conflicts in a restarted process", async () => {
    const h = await harness();
    await crash(h, mode, "before-outcome");
    const changed = await h.start("changed", { mode, now: 200, amount: "2000000", reconcile: "landed" }).result();
    expect(changed).toMatchObject({ ok: false, error: { name: "DacsError" } });
    expect(changed.error?.message).toMatch(/retained under different terms/);
    expect(await h.count()).toBe(1);
    expect(await h.count("reconciles")).toBe(0);
    expect(await h.count("grants")).toBe(0);
  }, 30_000);
});

describe("atomic recovery across processes (#43)", () => {
  test.each(["generic", "x402"] as const)("%s: terminal pre-effect crash permits exactly one recovery grant and submission", async (mode) => {
    const h = await harness();
    await crash(h, mode, "before-effect");
    expect(await h.count()).toBe(0);
    await h.barrier("prior-effect-terminal");
    const winner = await race(h, mode, "replay");
    expect(winner).toMatchObject({ ok: true, value: { ok: true } });
    expect(await h.count("grants")).toBe(1);
    expect(await h.count()).toBe(1);
    const cached = await h.start("cached", { mode, now: 300, reconcile: "throws" }).result();
    expect(cached).toMatchObject({ ok: true, value: winner.value });
    expect(await h.count()).toBe(1);
  }, 30_000);

  test("direct ERC-20: two absent recoveries cannot authorize a replacement transfer", async () => {
    const h = await harness();
    await crash(h, "evm", "before-effect");
    const winner = await race(h, "evm", "absent");
    expect(winner.ok).toBe(false);
    expect(winner.error?.message).toMatch(/absence alone.*operator action/);
    expect(await h.count("grants")).toBe(0);
    expect(await h.count()).toBe(0);
  }, 30_000);

  test("a superseded live process cannot write, release, or grant through its old generation", async () => {
    const h = await harness();
    const stale = h.start("stale", { action: "stale" });
    await stale.wait(["claimed-stale"]);
    const replacement = await h.start("replacement", { action: "takeover", now: 200 }).result();
    expect(replacement).toMatchObject({ ok: true, value: {
      status: "acquired", lease: { generation: 2, owner: "replacement", stage: "reconcile", expiresAt: 300 },
    } });
    await h.barrier("try-stale");
    expect(await stale.result()).toMatchObject({ ok: true, value: {
      current: false, put: { status: "stale" }, release: "stale", grant: { status: "stale" },
    } });
    // Stale release did not erase the new owner's lease or retained binding.
    expect(await h.start("observer", { action: "takeover", now: 250 }).result()).toMatchObject({
      ok: true, value: { status: "held", lease: { generation: 2, owner: "replacement" } },
    });
    expect(await h.count()).toBe(0);
  }, 30_000);

  test("two processes compare-and-set the exact same reconcile token: one replay grant", async () => {
    const h = await harness();
    await crash(h, "generic", "before-effect");
    const claim = await h.start("recovery", { action: "takeover", now: 200 }).result();
    expect(claim).toMatchObject({ ok: true, value: { status: "acquired", lease: { generation: 2 } } });
    await writeFile(join(h.root, "recovery-claim"), JSON.stringify(claim.value));
    const a = h.start("a", { action: "grant", now: 200, race: true });
    const b = h.start("b", { action: "grant", now: 200, race: true });
    await Promise.all([a.wait(["ready-a"]), b.wait(["ready-b"])]);
    await h.barrier("start-race");
    const results = await Promise.all([a.result(), b.result()]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.map((result) => (result.value as { status: string }).status).sort()).toEqual(["granted", "stale"]);
    expect(await h.count("grants")).toBe(1);
    expect(await h.count()).toBe(0);
  }, 30_000);
});
