import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "vitest";
// The probe exercises the built package, as the scheduled job does.
import { nodeRecord } from "../fixtures/demosNodeScript.js";

const expected = { hash: "12".repeat(32), payer: "ab".repeat(32), payee: "cd".repeat(32),
  amountOs: "1000000000", nonce: 9, blockNumber: 42, denomination: "os", state: "executed" };
const info = { forks: { osDenomination: { activated: true } }, nodeVersion: { commit: "test", dirty: true } };
test.skipIf(!existsSync(new URL("../../dist/rails/payDem.js", import.meta.url)))(
"deployment probe accepts a bound record and rejects changed status and amount", async () => {
  // @ts-expect-error the operational script is plain JavaScript
  const { probePayDemRecord } = await import("../../scripts/probe-pay-dem-record.mjs");
  for (const change of [undefined, "failed", "amount"] as const) {
    const record = nodeRecord({ txHash: expected.hash, payer: expected.payer, payee: expected.payee,
      amountOs: change === "amount" ? "2" : expected.amountOs, status: change === "failed" ? "failed" : "confirmed" });
    const node = { nodeCall: async () => info, getTxByHash: async () => record };
    if (change === undefined) assert.equal((await probePayDemRecord(node, expected, { dirty: true })).state, "executed");
    else await assert.rejects(probePayDemRecord(node, expected, { dirty: true }), /expected executed/);
  }
});
