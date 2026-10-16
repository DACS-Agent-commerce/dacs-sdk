import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { legacyMvpSessionAnchorName } from "../../src/agent/runSessionCore.js";
import { createFsSessionStore } from "../../src/agent/sessionStoreFs.js";
import { sha256Hex } from "../../src/canonical/index.js";
import {
  createSettlementProcessHarness, RESTART_JOB_ID, type SettlementProcessHarness,
} from "../fixtures/settlementProcess.js";

const harnesses: SettlementProcessHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((value) => value.cleanup()));
});

// runSessionCore anchors at the quarantined legacy MVP names, so this proves the
// PC-7 no-resubmission rule on that path, not PC-7(b)'s per-phase payment anchor.
describe("runSessionCore with filesystem stores across SIGKILL (#43)", () => {
  // generic: the store's own effect path; x402: the real x402Settle wrapper and
  // v2 HTTP client, recovered by its SB-3 nonce.
  test.each([
    ["generic", "before-outcome"], ["generic", "before-anchor"],
    ["x402", "before-outcome"], ["x402", "before-anchor"],
  ] as const)(
    "%s: resume after %s rebuilds evidence with no second payment",
    async (mode, point) => {
      const h = await createSettlementProcessHarness();
      harnesses.push(h);
      const first = h.start("first", { action: "session", mode, crash: point });
      await first.wait([`${point}-first`]);
      expect(first.child.kill("SIGKILL")).toBe(true);
      expect(await first.exit).toMatchObject({ code: null, signal: "SIGKILL" });
      expect(await h.count()).toBe(1);

      const evidencePath = join(h.root, "anchors", `${sha256Hex(legacyMvpSessionAnchorName.evidence(RESTART_JOB_ID))}.json`);
      expect(existsSync(evidencePath)).toBe(false);
      const sessionStore = await createFsSessionStore({ dir: join(h.root, "sessions") });
      const interrupted = await sessionStore.load(RESTART_JOB_ID);
      expect(interrupted.status).toBe("ok");
      if (interrupted.status !== "ok") throw new Error("missing interrupted session");
      const checkpoints = interrupted.record.checkpoints.filter((cp) => cp.key === "settle:0");
      expect(checkpoints.map((cp) => cp.stage)).toEqual(
        point === "before-outcome" ? ["intent"] : ["intent", "outcome"],
      );
      const originalAgreementHash = interrupted.record.agreementHash;

      const resumed = await h.start("resumed", {
        action: "session", mode, now: 200, reconcile: "landed",
      }).result();
      expect(resumed.pid).not.toBe(first.child.pid);
      expect(resumed).toMatchObject({ ok: true, value: { jobId: RESTART_JOB_ID, outcome: "completed" } });
      expect(await h.count()).toBe(1);
      expect(await h.count("session-settle")).toBe(1);
      expect(await h.count("session-resume")).toBe(point === "before-outcome" ? 1 : 0);
      expect(await h.count("reconciles")).toBe(point === "before-outcome" ? 1 : 0);
      // x402 went through its own client, and the restart signed no fresh nonce.
      expect(await h.count("payloads")).toBe(mode === "x402" ? 1 : 0);
      expect(existsSync(evidencePath)).toBe(true);
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
});
