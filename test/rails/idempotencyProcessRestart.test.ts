import { readFileSync } from "node:fs";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { dacsX402AuthorizationNonce } from "../../src/rails/x402.js";
import {
  createSettlementProcessHarness, RESTART_JOB_ID, X402_SIGNED_WINDOW, type RailMode, type RailRecord,
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
const PAYER = `0x${"2".repeat(40)}`;
const NONCE = await dacsX402AuthorizationNonce({ jobId: RESTART_JOB_ID, phaseIndex: 0 });
// The published Base Sepolia USDC contract the worker transfers.
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
// Where the token contract keeps this payer's EIP-3009 nonce state.
const NONCE_SCOPE = { network: "eip155:84532", asset: USDC, from: PAYER } as const;
// What the test rail authority reports for the landed effect; never the
// crashed process's unpersisted result.
const RECONCILED = {
  ok: true, txHash: `0x${"a".repeat(64)}`, chainId: "eip155:84532", payer: PAYER,
  payee: PAYEE, finality: { model: "block-depth", finalityBlocks: 2 },
};
const IDENTITY: Record<RailMode, string | undefined> = {
  generic: `test-effect:${RESTART_JOB_ID}:0`, evm: undefined, x402: NONCE,
};
const ABSENT = /absence alone.*operator action/;
// Direct ERC-20 keeps no submission reference before the crash window, so even
// a landed transfer is not adopted by its terms: recovery stops for an operator.
const UNATTRIBUTABLE = /direct ERC-20 retained no submission reference.*operator action/;
const LANDED: Record<RailMode, RegExp | null> = { generic: null, evm: UNATTRIBUTABLE, x402: null };

async function crash(
  h: SettlementProcessHarness, mode: RailMode, point: NonNullable<WorkerOptions["crash"]>, owner?: string,
  extra: WorkerOptions = {},
) {
  const first = h.start("first", { mode, crash: point, owner, ...extra });
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
// process killed before submitting it) reused the same SB-3 nonce. An authorized
// replay signs again, but only this one authorization: every signature covers
// the identical EIP-3009 transfer (nonce, payee, value and validity window), and
// the token contract executes a nonce once, so at most one of them can land.
async function expectRailEffects(h: SettlementProcessHarness, mode: RailMode, count: number, signed = count) {
  const effects = await h.lines<RailRecord>("effects");
  expect(effects).toHaveLength(count);
  for (const effect of effects) {
    expect(effect.rail).toBe(mode);
    if (effect.rail === "x402") {
      expect(effect).toMatchObject({ ...NONCE_SCOPE, ...X402_SIGNED_WINDOW, nonce: NONCE, state: "used", to: PAYEE });
    }
    if (effect.rail === "generic") expect(effect.identity).toBe(IDENTITY.generic);
  }
  for (const reconcile of await h.lines<{ identity?: string }>("reconciles")) {
    expect(reconcile.identity).toBe(IDENTITY[mode]);
  }
  const payloads = await h.lines<{ nonce: string; authorization: unknown }>("payloads");
  if (mode === "x402") {
    expect(payloads.map(({ nonce }) => nonce)).toEqual(Array(signed).fill(NONCE));
    expect(payloads.map(({ authorization }) => authorization)).toEqual(Array(signed).fill({
      from: PAYER, to: PAYEE, value: "1000000", ...X402_SIGNED_WINDOW, nonce: NONCE,
    }));
  } else expect(payloads).toEqual([]);
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
    ["landed", LANDED[mode]],
    ["absent", ABSENT],
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
    if (LANDED[mode] === null) expect(winner).toMatchObject({ ok: true, value: RECONCILED });
    else {
      expect(winner).toMatchObject({ ok: false, error: { name: "DacsError" } });
      expect(winner.error?.message).toMatch(LANDED[mode]!);
    }
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
const OTHER_PAYEE = `0x${"9".repeat(40)}`;

// One line of the test rail authority that this test, not the worker, writes.
async function seed(h: SettlementProcessHarness, records: RailRecord[]) {
  for (const record of records) await appendFile(join(h.root, "authority"), `${JSON.stringify(record)}\n`);
}

describe("x402 SB-3 retry identity across a real restart (#43)", () => {
  test("the Standard still carries the three retry vectors", () => {
    expect(RETRY.map(({ name }) => name).sort()).toEqual([
      "cancelled-nonce-fails-closed", "used-different-transfer-fails-closed", "used-same-transfer-resumes",
    ]);
  });

  // An EIP-3009 nonce is used or cancelled once. Used-same is our own landed
  // transfer (crash after the effect). The refusals start from a crash after
  // signing but before submission, so the nonce's only state is the one the
  // vector names, and each refusal must give its own reason.
  const REASON = { cancelled: /SB-3 authorization nonce is cancelled; refusing a fresh nonce/, different:
    /SB-3 authorization nonce was used by a different transfer; refusing a fresh nonce/ };
  test.each(RETRY.map((vector) => [vector.name, vector] as const))("%s", async (_name, vector) => {
    const h = await harness();
    const prior = vector.priorAuthorization!;
    const ours = prior.state === "used" && prior.sameTransferParameters;
    await crash(h, "x402", ours ? "before-outcome" : "before-effect");
    // The token contract's authorization state for this nonce, as a reconciler observes it.
    if (prior.state === "cancelled") await seed(h, [{ rail: "x402", ...NONCE_SCOPE, nonce: NONCE, state: "cancelled" }]);
    else if (!ours) {
      // The exact signed window, so only the transfer parameters differ.
      await seed(h, [{
        rail: "x402", txHash: `0x${"e".repeat(64)}`, ...NONCE_SCOPE, nonce: NONCE, state: "used", to: OTHER_PAYEE, value: "1000000",
        ...X402_SIGNED_WINDOW,
      }]);
    }
    const restarted = await h.start("restarted", { mode: "x402", now: 200, reconcile: "landed" }).result();
    expect(vector.want.mustGenerateFreshNonce).toBe(false);
    if (vector.expected === "pass") {
      expect(vector.want.action).toBe("resume-existing");
      expect(restarted).toMatchObject({ ok: true, value: RECONCILED });
    } else {
      expect(vector.want.action).toBe("refuse");
      const reason = prior.state === "cancelled" ? REASON.cancelled : REASON.different;
      expect(restarted).toMatchObject({ ok: false, error: { name: "DacsError" } });
      expect(restarted.error?.message).toMatch(reason);
      // Refusal is durable: a later process still cannot replace the authorization.
      const again = await h.start("again", { mode: "x402", now: 300, reconcile: "landed" }).result();
      expect(again).toMatchObject({ ok: false, error: { name: "DacsError" } });
      expect(again.error?.message).toMatch(reason);
    }
    // Only the crashed process ever signed, and only a used-same nonce landed here.
    await expectRailEffects(h, "x402", ours ? 1 : 0, 1);
    expect(await h.count("grants")).toBe(0);
  }, 30_000);

  // Each record carries the exact signed window, so the named field alone differs.
  test.each([
    ["amount", { to: PAYEE, value: "2000000" }],
    ["payee", { to: OTHER_PAYEE, value: "1000000" }],
    ["transaction (no landed hash)", { to: PAYEE, value: "1000000", txHash: undefined }],
  ] as const)("used by a different %s is refused for that reason, with no fresh nonce", async (_name, transfer) => {
    const h = await harness();
    await crash(h, "x402", "before-effect");
    await seed(h, [{
      rail: "x402", txHash: `0x${"e".repeat(64)}`, ...NONCE_SCOPE, nonce: NONCE, state: "used", ...transfer,
      ...X402_SIGNED_WINDOW,
    }]);
    const restarted = await h.start("restarted", { mode: "x402", now: 200, reconcile: "landed" }).result();
    expect(restarted).toMatchObject({ ok: false, error: { name: "DacsError" } });
    expect(restarted.error?.message).toMatch(REASON.different);
    await expectRailEffects(h, "x402", 0, 1);
    expect(await h.count("grants")).toBe(0);
  }, 30_000);

  // DACS-4 §9.5.8 resumes only the same authorization. Both validity bounds are
  // signed, so a same-scope, same-transfer record with either bound changed, or
  // one that cannot show the window at all, is not this phase's authorization.
  test.each([
    ["validBefore", { ...X402_SIGNED_WINDOW, validBefore: "4102444700" }],
    ["validAfter", { ...X402_SIGNED_WINDOW, validAfter: "1" }],
    ["window (absent)", {}],
  ] as const)("used under a different signed %s is refused, with no fresh nonce", async (_name, window) => {
    const h = await harness();
    await crash(h, "x402", "before-effect");
    await seed(h, [{
      rail: "x402", txHash: `0x${"a".repeat(64)}`, ...NONCE_SCOPE, nonce: NONCE, state: "used", to: PAYEE,
      value: "1000000", ...window,
    }]);
    const restarted = await h.start("restarted", { mode: "x402", now: 200, reconcile: "landed" }).result();
    expect(restarted).toMatchObject({ ok: false, error: { name: "DacsError" } });
    expect(restarted.error?.message).toMatch(REASON.different);
    await expectRailEffects(h, "x402", 0, 1);
    expect(await h.count("grants")).toBe(0);
  }, 30_000);

  // Control for the cases above: the same record with the exact signed window
  // is this phase's authorization, so only the window decides those refusals.
  test("used under the exact signed window resumes the existing transfer", async () => {
    const h = await harness();
    await crash(h, "x402", "before-effect");
    await seed(h, [{
      rail: "x402", txHash: `0x${"a".repeat(64)}`, ...NONCE_SCOPE, nonce: NONCE, state: "used", to: PAYEE,
      value: "1000000", ...X402_SIGNED_WINDOW,
    }]);
    const restarted = await h.start("restarted", { mode: "x402", now: 200, reconcile: "landed" }).result();
    expect(restarted).toMatchObject({ ok: true, value: RECONCILED });
    await expectRailEffects(h, "x402", 0, 1);
    expect(await h.count("grants")).toBe(0);
  }, 30_000);
});

// The restarted process must consult the rail authority under its own retained
// identity: what the authority does not hold for this effect is never adopted.
const OTHER_PHASE_NONCE = await dacsX402AuthorizationNonce({ jobId: RESTART_JOB_ID, phaseIndex: 1 });
const TX = `0x${"a".repeat(64)}`;
const UNRELATED: Record<RailMode, RailRecord[]> = {
  generic: [{ rail: "generic", txHash: TX, identity: `test-effect:${RESTART_JOB_ID}:1` }],
  // An earlier transfer with exactly this job's token, payer, payee and value.
  evm: [{ rail: "evm", txHash: `0x${"f".repeat(64)}`, token: USDC, from: PAYER, to: PAYEE, value: "1000000" }],
  x402: [{ rail: "x402", txHash: TX, ...NONCE_SCOPE, nonce: OTHER_PHASE_NONCE, state: "used", to: PAYEE, value: "1000000" }],
};
const MISS: Record<RailMode, RegExp> = { generic: ABSENT, evm: UNATTRIBUTABLE, x402: ABSENT };

describe.each(["generic", "evm", "x402"] as const)("real Node restart: %s landed recovery queries its own identity (#43)", (mode) => {
  test("an authority with no record for this effect is not adopted", async () => {
    const h = await harness();
    await crash(h, mode, "before-effect");
    const restarted = await h.start("restarted", { mode, now: 200, reconcile: "landed" }).result();
    expect(restarted).toMatchObject({ ok: false, error: { name: "DacsError" } });
    expect(restarted.error?.message).toMatch(MISS[mode]);
    await expectRailEffects(h, mode, 0, mode === "x402" ? 1 : 0);
    expect(await h.count("grants")).toBe(0);
  }, 30_000);

  test("a record under another identity, or an identical earlier transfer, is not adopted", async () => {
    const h = await harness();
    await crash(h, mode, "before-effect");
    await seed(h, UNRELATED[mode]);
    const restarted = await h.start("restarted", { mode, now: 200, reconcile: "landed" }).result();
    expect(restarted).toMatchObject({ ok: false, error: { name: "DacsError" } });
    expect(restarted.error?.message).toMatch(MISS[mode]);
    await expectRailEffects(h, mode, 0, mode === "x402" ? 1 : 0);
    expect(await h.count("grants")).toBe(0);
  }, 30_000);
});

// DACS-4 §9.5.8 SB-3 binds the same authorization: an EIP-3009 nonce lives on
// one token contract on one chain, per authorizer. The same nonce bytes used by
// another payer, on another token or on another chain are not this transfer.
describe("real Node restart: x402 landed recovery reads the nonce in its own scope (#43)", () => {
  test.each([
    ["payer", { from: OTHER_PAYEE }],
    ["token", { asset: `0x${"3".repeat(40)}` }],
    ["network", { network: "eip155:1" }],
  ] as const)("the same nonce used under a foreign %s is not adopted", async (_name, foreign) => {
    const h = await harness();
    await crash(h, "x402", "before-effect");
    await seed(h, [{
      rail: "x402", txHash: TX, ...NONCE_SCOPE, ...foreign, nonce: NONCE, state: "used", to: PAYEE, value: "1000000",
    }]);
    const restarted = await h.start("restarted", { mode: "x402", now: 200, reconcile: "landed" }).result();
    expect(restarted).toMatchObject({ ok: false, error: { name: "DacsError" } });
    expect(restarted.error?.message).toMatch(ABSENT);
    await expectRailEffects(h, "x402", 0, 1);
    expect(await h.count("grants")).toBe(0);
  }, 30_000);
});

// Reserved, never signed. The SB-3 nonce is bound in the durable intent before
// the signer runs, so the restart reconciles that nonce and signs nothing new.
describe("real Node restart: x402 SIGKILL after reserving, before signing (#43)", () => {
  test("recovery reconciles the reserved nonce; absence fails closed with nothing signed", async () => {
    const h = await harness();
    await crash(h, "x402", "before-sign");
    expect(await h.count("payloads")).toBe(0);
    const restarted = await h.start("restarted", { mode: "x402", now: 200, reconcile: "landed" }).result();
    expect(restarted).toMatchObject({ ok: false, error: { name: "DacsError" } });
    expect(restarted.error?.message).toMatch(ABSENT);
    // The killed process's reservation was durable: recovery took the next generation.
    expect(await h.lines("reconciles")).toMatchObject([{ generation: 2, identity: NONCE }]);
    await expectRailEffects(h, "x402", 0, 0);
    expect(await h.count("grants")).toBe(0);
  }, 30_000);
});

// Every point a process can die before its rail effect. x402 signs inside the
// effect callback, so it can also die after reserving and before signing.
const PRE_EFFECT = [["generic", "before-effect"], ["x402", "before-sign"], ["x402", "before-effect"]] as const;
// The x402 authorizations the killed process had already signed.
const signedBeforeKill = (mode: RailMode, point: string) => mode === "x402" && point === "before-effect" ? 1 : 0;

describe("atomic recovery across processes (#43)", () => {
  test.each(PRE_EFFECT)("%s killed %s: terminal pre-effect crash permits exactly one recovery grant and submission", async (mode, point) => {
    const h = await harness();
    await crash(h, mode, point);
    expect(await h.count()).toBe(0);
    await h.barrier("prior-effect-terminal");
    const winner = await race(h, mode, "replay");
    expect(winner).toMatchObject({ ok: true, value: { ok: true } });
    expectRailResult(mode, winner.value);
    expect(await h.count("grants")).toBe(1);
    await expectRailEffects(h, mode, 1, signedBeforeKill(mode, point) + 1);
    const cached = await h.start("cached", { mode, now: 300, reconcile: "throws" }).result();
    expect(cached).toMatchObject({ ok: true, value: winner.value });
    await expectRailEffects(h, mode, 1, signedBeforeKill(mode, point) + 1);
  }, 30_000);

  test.each(PRE_EFFECT)("%s killed %s: without proof the prior effect is terminal, replay is neither granted nor submitted", async (mode, point) => {
    const h = await harness();
    await crash(h, mode, point);
    const winner = await race(h, mode, "replay");
    expect(winner).toMatchObject({ ok: false, error: { name: "DacsError" } });
    expect(winner.error?.message).toMatch(/cannot prove the prior effect terminal/);
    expect(await h.count("grants")).toBe(0);
    await expectRailEffects(h, mode, 0, signedBeforeKill(mode, point));
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

// The test log keeps one directory of numbered revisions per settlement key; a
// commit links a flushed `.candidate` file as the next revision.
interface LogRecord {
  generation: number;
  lease?: { owner: string; generation: number; stage: string };
  outcome?: { result: unknown };
}
async function logState(h: SettlementProcessHarness) {
  const keys = await readdir(join(h.root, "log"));
  expect(keys).toHaveLength(1);
  const directory = join(h.root, "log", keys[0]!);
  const files = await readdir(directory);
  const revisions = files.filter((name) => name.endsWith(".json"))
    .map((name) => Number(name.slice(0, -".json".length))).sort((a, b) => a - b);
  expect(revisions).toEqual(revisions.map((_revision, index) => index));
  return {
    records: await Promise.all(revisions.map(async (revision) =>
      JSON.parse(await readFile(join(directory, `${revision}.json`), "utf8")) as LogRecord)),
    candidates: files.filter((name) => name.endsWith(".candidate")).length,
  };
}
// A revision with neither a lease nor an outcome is a committed release.
const stages = (records: LogRecord[]) =>
  records.map((record) => record.lease?.stage ?? (record.outcome ? "outcome" : "released"));

// Each durable transition commits by linking one flushed candidate as the next
// revision. A kill before the link leaves only an orphan candidate, so the
// transition never happened; a kill after it leaves the transition committed for
// every reader. A process kill cannot lose the directory flush (only power loss
// can), so a kill after the link is a committed transition, not a lost flush.
describe.each(["generic", "evm", "x402"] as const)("real Node restart: SIGKILL inside the %s settlement log commit (#43)", (mode) => {
  test("a torn reserve never committed: a restart claims afresh and settles once", async () => {
    const h = await harness();
    await crash(h, mode, "claimIntent-flushed");
    expect(await logState(h)).toEqual({ records: [], candidates: 1 });
    expect(await h.count("payloads")).toBe(0);
    const restarted = await h.start("restarted", { mode, now: 200, reconcile: "throws" }).result();
    expect(restarted.ok).toBe(true);
    expectRailResult(mode, restarted.value);
    // The orphan was never read: the restart's own claim is the first revision.
    const { records, candidates } = await logState(h);
    expect(stages(records)).toEqual(["fresh", "outcome"]);
    expect(records[0]).toMatchObject({ generation: 1, lease: { owner: "restarted" } });
    expect(candidates).toBe(1);
    expect(await h.count("reconciles")).toBe(0);
    await expectRailEffects(h, mode, 1);
  }, 30_000);

  test("a reserve committed then killed is visible to every reader: recovery reconciles and never submits on absence", async () => {
    const h = await harness();
    await crash(h, mode, "claimIntent-linked");
    const torn = await logState(h);
    expect(torn.records).toMatchObject([{ generation: 1, lease: { owner: "first", stage: "fresh" } }]);
    expect(torn.candidates).toBe(1);
    const restarted = await h.start("restarted", { mode, now: 200, reconcile: "landed" }).result();
    expect(restarted).toMatchObject({ ok: false, error: { name: "DacsError" } });
    expect(restarted.error?.message).toMatch(MISS[mode]);
    expect((await h.lines<{ generation: number }>("reconciles")).map(({ generation }) => generation)).toEqual([2]);
    await expectRailEffects(h, mode, 0, 0);
    expect(await h.count("grants")).toBe(0);
  }, 30_000);

  test("a torn record never committed: recovery reconciles the landed effect once", async () => {
    const h = await harness();
    await crash(h, mode, "putOutcome-flushed");
    expect(await h.count()).toBe(1);
    const torn = await logState(h);
    expect(stages(torn.records)).toEqual(["fresh"]);
    expect(torn.candidates).toBe(1);
    const restarted = await h.start("restarted", { mode, now: 200, reconcile: "landed" }).result();
    if (LANDED[mode] === null) expect(restarted).toMatchObject({ ok: true, value: RECONCILED });
    else {
      expect(restarted).toMatchObject({ ok: false, error: { name: "DacsError" } });
      expect(restarted.error?.message).toMatch(LANDED[mode]!);
    }
    expect(await h.count("reconciles")).toBe(1);
    await expectRailEffects(h, mode, 1);
    expect(await h.count("grants")).toBe(0);
  }, 30_000);

  test("a record committed then killed is visible to every reader and reused without reconciling", async () => {
    const h = await harness();
    await crash(h, mode, "putOutcome-linked");
    const { records, candidates } = await logState(h);
    expect(stages(records)).toEqual(["fresh", "outcome"]);
    expect(candidates).toBe(1);
    const restarted = await h.start("restarted", { mode, now: 200, reconcile: "throws" }).result();
    expect(restarted).toMatchObject({ ok: true, value: records[1]!.outcome!.result });
    expectRailResult(mode, restarted.value);
    expect(await h.count("reconciles")).toBe(0);
    await expectRailEffects(h, mode, 1);
  }, 30_000);
});

describe.each(["generic", "x402"] as const)("SIGKILL during %s recovery", (mode) => {
  test.each(["grantRecovery-flushed", "grantRecovery-linked"] as const)(
    "a kill inside the replay grant commit (%s) submits nothing; the next recovery takes its own grant",
    async (point) => {
      const h = await harness();
      await crash(h, mode, "before-effect");
      await h.barrier("prior-effect-terminal");
      const grant = h.start("replay-grant", { mode, now: 200, reconcile: "replay", crash: point });
      await grant.wait([`${point}-replay-grant`]);
      expect(grant.child.kill("SIGKILL")).toBe(true);
      expect(await grant.exit).toMatchObject({ code: null, signal: "SIGKILL" });
      // A torn grant leaves the reconcile generation current; a linked one is the replay generation.
      const torn = point === "grantRecovery-flushed";
      const { records, candidates } = await logState(h);
      expect(stages(records)).toEqual(torn ? ["fresh", "reconcile"] : ["fresh", "reconcile", "replay"]);
      expect(candidates).toBe(1);
      await expectRailEffects(h, mode, 0, mode === "x402" ? 1 : 0);
      const replay = await h.start("replay", { mode, now: 400, reconcile: "replay" }).result();
      expect(replay).toMatchObject({ ok: true, value: { ok: true } });
      expectRailResult(mode, replay.value);
      expect((await h.lines<{ generation: number }>("grants")).map((v) => v.generation)).toEqual([torn ? 4 : 5]);
      expect((await h.lines<{ generation: number }>("reconciles")).map((v) => v.generation)).toEqual(torn ? [2, 3] : [2, 4]);
      await expectRailEffects(h, mode, 1, mode === "x402" ? 2 : 1);
    }, 30_000,
  );

  test.each([undefined, "fixed-node-owner"])("reopens after committed replay grant and committed replay effect (owner %s)", async (owner) => {
    const h = await harness();
    await crash(h, mode, "before-effect", owner);
    await h.barrier("prior-effect-terminal");
    const grant = h.start("replay-grant", { mode, now: 200, owner, reconcile: "replay", crash: "grant-committed" });
    await grant.wait(["grant-committed-replay-grant"]);
    expect(grant.child.kill("SIGKILL")).toBe(true);
    expect(await grant.exit).toMatchObject({ code: null, signal: "SIGKILL" });
    await expectRailEffects(h, mode, 0, mode === "x402" ? 1 : 0);
    const effect = h.start("replay-effect", { mode, now: 400, owner, reconcile: "replay", crash: "replay-effect-committed" });
    await effect.wait(["replay-effect-committed-replay-effect"]);
    expect(effect.child.kill("SIGKILL")).toBe(true);
    expect(await effect.exit).toMatchObject({ code: null, signal: "SIGKILL" });
    await expectRailEffects(h, mode, 1, mode === "x402" ? 2 : 1);
    const final = await h.start("final-recovery", { mode, now: 600, owner, reconcile: "landed" }).result();
    expect(final).toMatchObject({ ok: true, value: RECONCILED });
    expect((await h.lines<{ generation: number }>("grants")).map((v) => v.generation)).toEqual([3, 5]);
    expect((await h.lines<{ generation: number }>("reconciles")).map((v) => v.generation)).toEqual([2, 4, 6]);
    const cached = await h.start("final-cached", { mode, now: 800, owner, reconcile: "throws" }).result();
    expect(cached).toMatchObject({ ok: true, value: final.value });
    await expectRailEffects(h, mode, 1, mode === "x402" ? 2 : 1);
  }, 30_000);
});

// A kill inside the reconcile-stage claim of a restarted process (generation 2),
// not only the first fresh claim. A torn reconcile claim never happened; a linked
// one is a held generation that the next recovery supersedes. Neither submits.
describe.each(["generic", "evm", "x402"] as const)("SIGKILL inside the %s reconcile claim commit (#43)", (mode) => {
  test.each(["claimIntent-flushed", "claimIntent-linked"] as const)(
    "a kill inside the generation-2 claim (%s) submits nothing; the next recovery reconciles once",
    async (point) => {
      const h = await harness();
      await crash(h, mode, "before-effect");
      const second = h.start("reconcile-claim", { mode, now: 200, reconcile: "landed", crash: point });
      await second.wait([`${point}-reconcile-claim`]);
      expect(second.child.kill("SIGKILL")).toBe(true);
      expect(await second.exit).toMatchObject({ code: null, signal: "SIGKILL" });
      const torn = point === "claimIntent-flushed";
      const killed = await logState(h);
      expect(stages(killed.records)).toEqual(torn ? ["fresh"] : ["fresh", "reconcile"]);
      expect(killed.records.at(-1)).toMatchObject(torn
        ? { generation: 1, lease: { owner: "first" } }
        : { generation: 2, lease: { owner: "reconcile-claim", stage: "reconcile" } });
      expect(killed.candidates).toBe(1);
      expect(await h.count("reconciles")).toBe(0);
      const recovery = await h.start("recovery", { mode, now: 400, reconcile: "landed" }).result();
      expect(recovery).toMatchObject({ ok: false, error: { name: "DacsError" } });
      expect(recovery.error?.message).toMatch(MISS[mode]);
      expect((await h.lines<{ generation: number }>("reconciles")).map((v) => v.generation)).toEqual([torn ? 2 : 3]);
      expect(await h.count("grants")).toBe(0);
      await expectRailEffects(h, mode, 0, mode === "x402" ? 1 : 0);
      if (mode === "evm") return;
      // Proof the prior attempt is terminal still yields exactly one replay.
      await h.barrier("prior-effect-terminal");
      const replay = await h.start("replay", { mode, now: 600, reconcile: "replay" }).result();
      expect(replay).toMatchObject({ ok: true, value: { ok: true } });
      expect((await h.lines<{ generation: number }>("grants")).map((v) => v.generation)).toEqual([torn ? 4 : 5]);
      await expectRailEffects(h, mode, 1, mode === "x402" ? 2 : 1);
    }, 30_000,
  );
});

// releaseIntent is the one transition that returns a phase to `fresh`. It runs
// only after the rail returned an explicit not-invoked disposition, so the
// released attempt provably made no effect.
describe("SIGKILL inside the generic release commit (#43)", () => {
  test("an uninterrupted not-invoked attempt commits a release and makes no effect", async () => {
    const h = await harness();
    const first = await h.start("first", { mode: "generic", submit: "not-invoked" }).result();
    expect(first).toMatchObject({ ok: true, value: { ok: false, txHash: "" } });
    expect(stages((await logState(h)).records)).toEqual(["fresh", "released"]);
    await expectRailEffects(h, "generic", 0);
  }, 30_000);

  test("a torn release never committed: the attempt stays held and recovery never submits on absence", async () => {
    const h = await harness();
    await crash(h, "generic", "releaseIntent-flushed", undefined, { submit: "not-invoked" });
    const torn = await logState(h);
    expect(stages(torn.records)).toEqual(["fresh"]);
    expect(torn.candidates).toBe(1);
    const restarted = await h.start("restarted", { mode: "generic", now: 200, reconcile: "landed" }).result();
    expect(restarted).toMatchObject({ ok: false, error: { name: "DacsError" } });
    expect(restarted.error?.message).toMatch(ABSENT);
    expect((await h.lines<{ generation: number }>("reconciles")).map((v) => v.generation)).toEqual([2]);
    expect(await h.count("grants")).toBe(0);
    await expectRailEffects(h, "generic", 0);
  }, 30_000);

  test("a release committed then killed is visible to every reader: a restart claims fresh and settles once", async () => {
    const h = await harness();
    await crash(h, "generic", "releaseIntent-linked", undefined, { submit: "not-invoked" });
    const released = await logState(h);
    expect(stages(released.records)).toEqual(["fresh", "released"]);
    expect(released.candidates).toBe(1);
    const restarted = await h.start("restarted", { mode: "generic", now: 200, reconcile: "throws" }).result();
    expect(restarted).toMatchObject({ ok: true, value: RECONCILED });
    const { records } = await logState(h);
    expect(stages(records)).toEqual(["fresh", "released", "fresh", "outcome"]);
    expect(records[2]).toMatchObject({ generation: 2, lease: { owner: "restarted", stage: "fresh" } });
    expect(await h.count("reconciles")).toBe(0);
    await expectRailEffects(h, "generic", 1);
  }, 30_000);
});
