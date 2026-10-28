import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { legacyMvpSessionAnchorName } from "../../src/agent/runSessionCore.js";
import { createFsSessionStore } from "../../src/agent/sessionStoreFs.js";
import { sha256Hex } from "../../src/canonical/index.js";
import { settlementKey } from "../../src/rails/idempotency.js";
import {
  createSettlementProcessHarness, RESTART_JOB_ID, type RailMode, type SettlementProcessHarness,
} from "../fixtures/settlementProcess.js";

const harnesses: SettlementProcessHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((value) => value.cleanup()));
});

// runSessionCore anchors at the quarantined legacy MVP names, so this proves the
// PC-7 no-resubmission rule on that path, not PC-7(b)'s per-phase payment anchor.
describe("runSessionCore with filesystem stores across SIGKILL (#43)", () => {
  const evidencePath = (h: SettlementProcessHarness) =>
    join(h.root, "anchors", `${sha256Hex(legacyMvpSessionAnchorName.evidence(RESTART_JOB_ID))}.json`);
  async function interrupt(mode: RailMode, point: "before-outcome" | "before-anchor") {
    const h = await createSettlementProcessHarness();
    harnesses.push(h);
    const first = h.start("first", { action: "session", mode, crash: point });
    await first.wait([`${point}-first`]);
    expect(first.child.kill("SIGKILL")).toBe(true);
    expect(await first.exit).toMatchObject({ code: null, signal: "SIGKILL" });
    expect(await h.count()).toBe(1);
    // The session settled under the rail it negotiated: the log holds only that key.
    const rail = mode === "evm" ? "pay-evm-erc20" : "pay-x402";
    expect(readdirSync(join(h.root, "log"))).toEqual([sha256Hex(settlementKey(rail, RESTART_JOB_ID, 0))]);
    expect(existsSync(evidencePath(h))).toBe(false);
    const sessionStore = await createFsSessionStore({ dir: join(h.root, "sessions") });
    const interrupted = await sessionStore.load(RESTART_JOB_ID);
    expect(interrupted.status).toBe("ok");
    if (interrupted.status !== "ok") throw new Error("missing interrupted session");
    const checkpoints = interrupted.record.checkpoints.filter((cp) => cp.key === "settle:0");
    expect(checkpoints.map((cp) => cp.stage)).toEqual(
      point === "before-outcome" ? ["intent"] : ["intent", "outcome"],
    );
    return { h, firstPid: first.child.pid, sessionStore, agreementHash: interrupted.record.agreementHash };
  }

  // generic: the store's own effect path; evm: the real evmErc20Settle wrapper;
  // x402: the real x402Settle wrapper and v2 HTTP client, recovered by its SB-3 nonce.
  test.each([
    ["generic", "before-outcome"], ["generic", "before-anchor"],
    ["evm", "before-anchor"],
    ["x402", "before-outcome"], ["x402", "before-anchor"],
  ] as const)(
    "%s: resume after %s rebuilds evidence with no second payment",
    async (mode, point) => {
      const { h, firstPid, sessionStore, agreementHash: originalAgreementHash } = await interrupt(mode, point);
      const evidence = evidencePath(h);

      const resumed = await h.start("resumed", {
        action: "session", mode, now: 200, reconcile: "landed",
      }).result();
      expect(resumed.pid).not.toBe(firstPid);
      expect(resumed).toMatchObject({ ok: true, value: { jobId: RESTART_JOB_ID, outcome: "completed" } });
      expect(await h.count()).toBe(1);
      expect(await h.count("session-settle")).toBe(1);
      expect(await h.count("session-resume")).toBe(point === "before-outcome" ? 1 : 0);
      expect(await h.count("reconciles")).toBe(point === "before-outcome" ? 1 : 0);
      // x402 went through its own client, and the restart signed no fresh nonce.
      expect(await h.count("payloads")).toBe(mode === "x402" ? 1 : 0);
      expect(existsSync(evidence)).toBe(true);
      const completed = await sessionStore.load(RESTART_JOB_ID);
      expect(completed.status).toBe("ok");
      if (completed.status !== "ok") throw new Error("missing completed session");
      expect(completed.record.phase).toBe("completed");
      expect(completed.record.agreementHash).toBe(originalAgreementHash);
      expect(completed.record.receipts.map((receipt) => receipt.kind).sort()).toEqual(["agreement", "bundle", "settlement"]);

      const repeated = await h.start("repeated", { action: "session", mode, now: 300, reconcile: "throws" }).result();
      expect(repeated).toMatchObject({ ok: true, value: resumed.value });
      expect(await h.count()).toBe(1);
      expect(await h.count("session-settle")).toBe(1);
      expect(await h.count("session-resume")).toBe(point === "before-outcome" ? 1 : 0);
    }, 30_000,
  );

  // Direct ERC-20 keeps no submission reference before the crash window, so its
  // landed transfer cannot be attributed: resume stops for an operator, unpaid twice.
  // The refusal text is the test worker's reconcile policy (its `lookup`), not SDK
  // code: this pins that a refusing reconcile stops resume with one payment.
  test("evm: resume after before-outcome stops for an operator with no second payment", async () => {
    const { h, firstPid, sessionStore } = await interrupt("evm", "before-outcome");
    for (const [id, now] of [["resumed", 200], ["again", 300]] as const) {
      const resumed = await h.start(id, { action: "session", mode: "evm", now, reconcile: "landed" }).result();
      expect(resumed.pid).not.toBe(firstPid);
      expect(resumed).toMatchObject({ ok: false, error: { name: "DacsError" } });
      expect(resumed.error?.message).toMatch(/direct ERC-20 retained no submission reference.*operator action/);
    }
    expect(await h.count()).toBe(1);
    expect(await h.count("session-settle")).toBe(1);
    expect(await h.count("session-resume")).toBe(2);
    expect(await h.count("reconciles")).toBe(2);
    expect(existsSync(evidencePath(h))).toBe(false);
    const stopped = await sessionStore.load(RESTART_JOB_ID);
    expect(stopped.status).toBe("ok");
    if (stopped.status !== "ok") throw new Error("missing stopped session");
    expect(stopped.record.phase).not.toBe("completed");
    expect(stopped.record.checkpoints.filter((cp) => cp.key === "settle:0").map((cp) => cp.stage)).toEqual(["intent"]);
  }, 30_000);
});
