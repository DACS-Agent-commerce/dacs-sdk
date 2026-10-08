import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { sessionAnchorName } from "../../src/agent/runSessionCore.js";
import { createFsSessionStore } from "../../src/agent/sessionStoreFs.js";
import { sha256Hex } from "../../src/canonical/index.js";
import {
  createSettlementProcessHarness, type SettlementProcessHarness,
} from "../fixtures/settlementProcess.js";

const harnesses: SettlementProcessHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((value) => value.cleanup()));
});

describe("runSessionCore with filesystem stores across SIGKILL (#43)", () => {
  test.each(["before-outcome", "before-anchor"] as const)(
    "resume after %s rebuilds evidence with no second payment",
    async (point) => {
      const h = await createSettlementProcessHarness();
      harnesses.push(h);
      const first = h.start("first", { action: "session", crash: point });
      await first.wait([`${point}-first`]);
      expect(first.child.kill("SIGKILL")).toBe(true);
      expect(await first.exit).toMatchObject({ code: null, signal: "SIGKILL" });
      expect(await h.count()).toBe(1);

      const evidencePath = join(h.root, "anchors", `${sha256Hex(sessionAnchorName.evidence("job-restart"))}.json`);
      expect(existsSync(evidencePath)).toBe(false);
      const sessionStore = await createFsSessionStore({ dir: join(h.root, "sessions") });
      const interrupted = await sessionStore.load("job-restart");
      expect(interrupted.status).toBe("ok");
      if (interrupted.status !== "ok") throw new Error("missing interrupted session");
      const checkpoints = interrupted.record.checkpoints.filter((cp) => cp.key === "settle:0");
      expect(checkpoints.map((cp) => cp.stage)).toEqual(
        point === "before-outcome" ? ["intent"] : ["intent", "outcome"],
      );
      const originalAgreementHash = interrupted.record.agreementHash;

      const resumed = await h.start("resumed", {
        action: "session", now: 200, reconcile: "landed",
      }).result();
      expect(resumed.pid).not.toBe(first.child.pid);
      expect(resumed).toMatchObject({ ok: true, value: { jobId: "job-restart", outcome: "completed" } });
      expect(await h.count()).toBe(1);
      expect(await h.count("session-settle")).toBe(1);
      expect(await h.count("session-resume")).toBe(point === "before-outcome" ? 1 : 0);
      expect(await h.count("reconciles")).toBe(point === "before-outcome" ? 1 : 0);
      expect(existsSync(evidencePath)).toBe(true);
      const completed = await sessionStore.load("job-restart");
      expect(completed.status).toBe("ok");
      if (completed.status !== "ok") throw new Error("missing completed session");
      expect(completed.record.phase).toBe("completed");
      expect(completed.record.agreementHash).toBe(originalAgreementHash);
      expect(completed.record.receipts.map((receipt) => receipt.kind).sort()).toEqual(["agreement", "bundle", "settlement"]);

      const repeated = await h.start("repeated", { action: "session", now: 300, reconcile: "throws" }).result();
      expect(repeated).toMatchObject({ ok: true, value: resumed.value });
      expect(await h.count()).toBe(1);
      expect(await h.count("session-settle")).toBe(1);
      expect(await h.count("session-resume")).toBe(point === "before-outcome" ? 1 : 0);
    }, 30_000,
  );
});
