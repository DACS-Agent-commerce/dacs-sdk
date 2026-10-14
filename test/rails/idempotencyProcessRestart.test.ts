import { readFileSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { dacsX402AuthorizationNonce } from "../../src/rails/x402.js";
import {
  createSettlementProcessHarness, RESTART_JOB_ID, type RailMode, type RailRecord,
  type SettlementProcessHarness, type WorkerOptions,
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

const PAYEE = `0x${"1".repeat(40)}`;
const NONCE = await dacsX402AuthorizationNonce({ jobId: RESTART_JOB_ID, phaseIndex: 0 });
// What the test rail authority reports for the landed effect; never the
// crashed process's unpersisted result.
const RECONCILED = {
  ok: true, txHash: `0x${"a".repeat(64)}`, chainId: "eip155:84532", payer: `0x${"2".repeat(40)}`,
  payee: PAYEE, finality: { model: "block-depth", finalityBlocks: 2 },
};
const IDENTITY: Record<RailMode, string | undefined> = {
  generic: `test-effect:${RESTART_JOB_ID}:0`, evm: undefined, x402: NONCE,
};

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

// Every effect went through the mode's own wrapper, under the rail identity it
// retains, and every x402 authorization signed (including one signed by a
// process killed before submitting it) reused the same SB-3 nonce.
async function expectRailEffects(h: SettlementProcessHarness, mode: RailMode, count: number, signed = count) {
  const effects = await h.lines<RailRecord>("effects");
  expect(effects).toHaveLength(count);
  for (const effect of effects) {
    expect(effect.rail).toBe(mode);
    if (effect.rail === "x402") expect(effect).toMatchObject({ nonce: NONCE, state: "used", to: PAYEE });
    if (effect.rail === "generic") expect(effect.identity).toBe(IDENTITY.generic);
  }
  for (const reconcile of await h.lines<{ identity?: string }>("reconciles")) {
    expect(reconcile.identity).toBe(IDENTITY[mode]);
  }
  const payloads = await h.lines<{ nonce: string }>("payloads");
  if (mode === "x402") expect(payloads.map(({ nonce }) => nonce)).toEqual(Array(signed).fill(NONCE));
  else expect(payloads).toEqual([]);
}

function expectRailResult(mode: RailMode, value: unknown) {
  if (mode === "evm") expect(value).toMatchObject({ ok: true, txRef: { kind: "evm-event" } });
  else if (mode === "x402") {
    expect(value).toMatchObject({ ok: true, txRef: { kind: "x402-event" }, x402Receipt: { headerName: "PAYMENT-RESPONSE" } });
  } else expect(value).not.toHaveProperty("txRef");
}

describe.each(["generic", "evm", "x402"] as const)("real Node restart: %s settlement (#43)", (mode) => {
  test("a fresh process settles once through the rail's own wrapper", async () => {
    const h = await harness();
    const settled = await h.start("fresh", { mode }).result();
    expect(settled.ok).toBe(true);
    expectRailResult(mode, settled.value);
    await expectRailEffects(h, mode, 1);
    const cached = await h.start("cached", { mode, now: 300, reconcile: "throws" }).result();
    expect(cached).toMatchObject({ ok: true, value: settled.value });
    await expectRailEffects(h, mode, 1);
  }, 30_000);

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
      expect(restarted.value).toEqual(RECONCILED);
      // A third process must load the canonical saved outcome without reconciling.
      const cached = await h.start("cached", { mode, now: 300, reconcile: "throws" }).result();
      expect(cached).toMatchObject({ ok: true, value: RECONCILED });
      expect(await h.count("reconciles")).toBe(1);
    } else {
      expect(restarted.error?.message).toMatch(error);
      // Another expired-generation retry also fails closed.
      const again = await h.start("again", { mode, now: 300, reconcile }).result();
      expect(again.ok).toBe(false);
      expect(again.error?.message).toMatch(error);
    }
    await expectRailEffects(h, mode, 1);
    expect(await h.count("grants")).toBe(0);
  }, 30_000);

  test("two restarted processes race to adopt the landed effect at exact lease expiry", async () => {
    const h = await harness();
    await crash(h, mode, "before-outcome");
    const winner = await race(h, mode, "landed");
    expect(winner).toMatchObject({ ok: true, value: RECONCILED });
    await expectRailEffects(h, mode, 1);
    expect(await h.count("grants")).toBe(0);
  }, 30_000);

  const changes: Array<[string, WorkerOptions]> = [
    ["amount", { amount: "2000000" }],
    ["token", { token: `0x${"3".repeat(40)}` }],
    ...(mode === "x402" ? [["paywall resource", { resource: "https://seller.example/other" }] as [string, WorkerOptions]] : []),
  ];
  test.each(changes)("same key with changed %s conflicts in a restarted process", async (_name, changed) => {
    const h = await harness();
    await crash(h, mode, "before-outcome");
    const result = await h.start("changed", { mode, now: 200, reconcile: "landed", ...changed }).result();
    expect(result).toMatchObject({ ok: false, error: { name: "DacsError" } });
    expect(result.error?.message).toMatch(/retained under different terms/);
    await expectRailEffects(h, mode, 1);
    expect(await h.count("reconciles")).toBe(0);
    expect(await h.count("grants")).toBe(0);
  }, 30_000);
});

// DACS-4 §9.5.8 SB-3 retry identity, from the pinned Standard's `retry` vectors.
// Their legacy job IDs are derivation-only, so only the authorization state and
// wanted action are applied here, to the canonical restart job.
const SB3 = JSON.parse(readFileSync(new URL(
  "../../vendor/DACS-Standard/conformance/vectors/security/sb3-eip3009-nonce-v0.1.json",
  import.meta.url,
), "utf8")) as { vectors: Array<{
  name: string; op: string; expected: "pass" | "fail";
  priorAuthorization?: { state: "used" | "cancelled"; sameTransferParameters: boolean };
  want: { action?: "resume-existing" | "refuse"; mustGenerateFreshNonce?: boolean };
}> };
const RETRY = SB3.vectors.filter((vector) => vector.op === "retry");

describe("x402 SB-3 retry identity across a real restart (#43)", () => {
  test("the Standard still carries the three retry vectors", () => {
    expect(RETRY.map(({ name }) => name).sort()).toEqual([
      "cancelled-nonce-fails-closed", "used-different-transfer-fails-closed", "used-same-transfer-resumes",
    ]);
  });

  test.each(RETRY.map((vector) => [vector.name, vector] as const))("%s", async (_name, vector) => {
    const h = await harness();
    await crash(h, "x402", "before-outcome");
    const prior = vector.priorAuthorization!;
    // The token contract's authorization state for this nonce, as a reconciler observes it.
    if (prior.state === "cancelled") {
      await appendFile(join(h.root, "authority"), `${JSON.stringify({ rail: "x402", nonce: NONCE, state: "cancelled" })}\n`);
    } else if (!prior.sameTransferParameters) {
      await appendFile(join(h.root, "authority"), `${JSON.stringify({
        rail: "x402", txHash: `0x${"e".repeat(64)}`, nonce: NONCE, state: "used", to: `0x${"9".repeat(40)}`, value: "1000000",
      })}\n`);
    }
    const restarted = await h.start("restarted", { mode: "x402", now: 200, reconcile: "landed" }).result();
    expect(vector.want.mustGenerateFreshNonce).toBe(false);
    if (vector.expected === "pass") {
      expect(vector.want.action).toBe("resume-existing");
      expect(restarted).toMatchObject({ ok: true, value: RECONCILED });
    } else {
      expect(vector.want.action).toBe("refuse");
      expect(restarted).toMatchObject({ ok: false, error: { name: "DacsError" } });
      expect(restarted.error?.message).toMatch(/SB-3 authorization nonce .*refusing a fresh nonce/);
      // Refusal is durable: a later process still cannot replace the authorization.
      const again = await h.start("again", { mode: "x402", now: 300, reconcile: "landed" }).result();
      expect(again.ok).toBe(false);
    }
    await expectRailEffects(h, "x402", 1);
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
    expectRailResult(mode, winner.value);
    expect(await h.count("grants")).toBe(1);
    await expectRailEffects(h, mode, 1, mode === "x402" ? 2 : 1);
    const cached = await h.start("cached", { mode, now: 300, reconcile: "throws" }).result();
    expect(cached).toMatchObject({ ok: true, value: winner.value });
    await expectRailEffects(h, mode, 1, mode === "x402" ? 2 : 1);
  }, 30_000);

  test.each(["generic", "x402"] as const)("%s: without proof the prior effect is terminal, replay is neither granted nor submitted", async (mode) => {
    const h = await harness();
    await crash(h, mode, "before-effect");
    const winner = await race(h, mode, "replay");
    expect(winner).toMatchObject({ ok: false, error: { name: "DacsError" } });
    expect(winner.error?.message).toMatch(/cannot prove the prior effect terminal/);
    expect(await h.count("grants")).toBe(0);
    await expectRailEffects(h, mode, 0, mode === "x402" ? 1 : 0);
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

  test.each([
    { owners: "distinct owners", stale: "stale", replacement: "replacement" },
    { owners: "one fixed owner, so only the generation differs", stale: "node", replacement: "node" },
  ])("a superseded live process cannot write, release, or grant through its old generation: $owners", async (owners) => {
    const h = await harness();
    const stale = h.start("stale", { action: "stale", owner: owners.stale });
    await stale.wait(["claimed-stale"]);
    const replacement = await h.start("replacement", { action: "takeover", now: 200, owner: owners.replacement }).result();
    expect(replacement).toMatchObject({ ok: true, value: {
      status: "acquired", lease: { generation: 2, owner: owners.replacement, stage: "reconcile", expiresAt: 300 },
    } });
    await h.barrier("try-stale");
    expect(await stale.result()).toMatchObject({ ok: true, value: {
      current: false, put: { status: "stale" }, release: "stale", grant: { status: "stale" },
    } });
    // Stale release did not erase the new owner's lease or retained binding.
    expect(await h.start("observer", { action: "takeover", now: 250 }).result()).toMatchObject({
      ok: true, value: { status: "held", lease: { generation: 2, owner: owners.replacement } },
    });
    expect(await h.count()).toBe(0);
    expect(await h.count("grants")).toBe(0);
  }, 30_000);

  test("one fixed owner: a paused reconcile process is fenced by generation after its recovery grant", async () => {
    const h = await harness();
    const first = h.start("first", { crash: "before-effect", owner: "node" });
    await first.wait(["before-effect-first"]);
    expect(first.child.kill("SIGKILL")).toBe(true);
    expect(await first.exit).toMatchObject({ code: null, signal: "SIGKILL" });
    // The restarted process takes the reconcile generation, then pauses.
    const paused = h.start("paused", { action: "stale", now: 200, owner: "node" });
    await paused.wait(["claimed-paused"]);
    const claim = await h.read<{ lease: { generation: number; stage: string } }>("claimed-paused");
    expect(claim.lease).toMatchObject({ generation: 2, stage: "reconcile" });
    await writeFile(join(h.root, "recovery-claim"), JSON.stringify(claim));
    const granted = await h.start("replay", { action: "grant", now: 200, owner: "node" }).result();
    expect(granted).toMatchObject({ ok: true, value: {
      status: "granted", lease: { generation: 3, owner: "node", stage: "replay", expiresAt: 300 },
    } });
    // At 250 the reconcile lease would still be unexpired; only its generation is old.
    await h.barrier("try-stale");
    expect(await paused.result()).toMatchObject({ ok: true, value: {
      current: false, put: { status: "stale" }, release: "stale", grant: { status: "stale" },
    } });
    expect(await h.start("observer", { action: "takeover", now: 250, owner: "node" }).result()).toMatchObject({
      ok: true, value: { status: "held", lease: { generation: 3, owner: "node", stage: "replay" } },
    });
    // After the replay lease expires, the next takeover must not reissue generation 3.
    expect(await h.start("takeover", { action: "takeover", now: 300, owner: "node" }).result()).toMatchObject({
      ok: true, value: { status: "acquired", lease: { generation: 4, owner: "node", stage: "reconcile" } },
    });
    expect(await h.count("grants")).toBe(1);
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
    // Both have read the reconcile revision and flushed a grant candidate; only
    // the exclusive commit can choose between them.
    await Promise.all([a.wait(["decided-a"]), b.wait(["decided-b"])]);
    await h.barrier("commit-grant");
    const results = await Promise.all([a.result(), b.result()]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.map((result) => (result.value as { status: string }).status).sort()).toEqual(["granted", "stale"]);
    expect(await h.count("grants")).toBe(1);
    expect(await h.count()).toBe(0);
  }, 30_000);
});
