import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// The execution gate's prose must say what the code does. These pin the claims
// an integrator acts on and the node source the gate was verified against.

const read = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url)).toString("utf8");

const fixture = JSON.parse(read("test/fixtures/demos-node2-records.json")) as {
  source: {
    reportedCommit: string;
    versionEnvelope: { commit: string };
    networkInfoEnvelope: { response: { nodeVersion: { commit: string; dirty: boolean } } };
  };
};

describe("pay-dem execution docs match the code (#338)", () => {
  it("cites the node commit node2 reported in the recorded envelopes", () => {
    const commit = /stabilisation@([0-9a-f]{40})/.exec(fixture.source.reportedCommit)?.[1];
    expect(commit).toBeDefined();
    expect(fixture.source.versionEnvelope.commit).toContain(commit!);
    expect(fixture.source.networkInfoEnvelope.response.nodeVersion.commit).toContain(commit!.slice(0, 7));
    // A rebuilt or clean node2 changes these envelopes; re-verify the semantics
    // the observer documents against that source before updating the pin.
    expect(read("src/rails/payDem.ts")).toContain(`stabilisation@${commit}`);
    expect(read("docs/pay-dem-execution.md")).toContain(`stabilisation@${commit!.slice(0, 7)}`);
    expect(fixture.source.networkInfoEnvelope.response.nodeVersion.dirty).toBe(true);
    expect(read("docs/pay-dem-execution.md")).toMatch(/marks the build `dirty`/);
  });

  it("states the reconciler contract in the README and links the gate", () => {
    const readme = read("README.md").replace(/\s+/g, " ");
    expect(readme).toContain(
      "`PayDemReconciledSettlement` (including the observed `amountOs`) with `execution: \"executed\"`",
    );
    expect(readme).toContain("`PayDemReconciledFailure` for a bound `failed` record");
    expect(readme).toContain("(docs/pay-dem-execution.md)");
  });

  it("states the attempt-record contract for custom rails and durable logs", () => {
    const doc = read("docs/pay-dem-execution.md").replace(/\s+/g, " ");
    const readme = read("README.md").replace(/\s+/g, " ");
    expect(doc).toContain("A custom rail must record the exact hash it will return before it broadcasts");
    expect(readme).toContain("A custom rail must call `fence.recordAttempt` with the exact hash it will return before it broadcasts");
    expect(doc).toContain("A durable log needs the pair");
    expect(readme).toContain("A durable log needs the attempt pair for restart audits");
    expect(doc).toContain("a refused write fails the call and leaves the hash unbound");
  });

  it("says a failure proof from outside createPayDemRail never becomes the recorded outcome", () => {
    const doc = read("docs/pay-dem-execution.md").replace(/\s+/g, " ");
    expect(doc).toContain(
      "A failure proof from any other source, including a custom rail, a rail that wraps the SDK rail's `settle`, or a reconciler, leaves the intent held",
    );
  });

  it("says only createPayDemRail's verdicts are final and nothing exports a way to vouch", () => {
    const doc = read("docs/pay-dem-execution.md").replace(/\s+/g, " ");
    expect(doc).toContain("The SDK reads the node itself only inside `createPayDemRail`, so only that rail's verdicts are final.");
    expect(doc).toContain("is held: `ok: false` with the signed hash and nothing else.");
    expect(doc).toContain("No file in the package exports a way to add to it");
    expect(doc).not.toMatch(/vouch/i);
  });

  it("says the buyer track settles only an SDK record-verified success", () => {
    const doc = read("docs/pay-dem-execution.md").replace(/\s+/g, " ");
    expect(doc).toContain(
      "only when `payDemRecordVerifiedTransfer` lists it with this payment's payer, payee, amount, network and settlement key, and its hash is the one this invocation journaled",
    );
    expect(doc).not.toContain("the host's statement");
    expect(read("packages/dacs-node/src/payDemPayment.ts"))
      .toMatch(/payDemRecordVerifiedTransfer\(raw\)/);
  });

  it("says a recovered verdict is the SDK's own node read and only the adapter re-reads a saved one", () => {
    const doc = read("docs/pay-dem-execution.md").replace(/\s+/g, " ");
    const readme = read("README.md").replace(/\s+/g, " ");
    expect(doc).toContain("is then decided by the SDK rail's own read of the node's record for that hash");
    expect(doc).toContain("A failure found by a lookup by key is never final");
    expect(doc).toContain("does not call any other `resumeSettlement` for it");
    expect(doc).not.toMatch(/wire one that reads the node you trust/);
    expect(readme).toContain("so it is not called and the payment stays indeterminate");
    expect(readme).toContain("the session binds its hash and saves it as an unresolved attempt");
    // A fresh success from a custom settle is not demoted; only recovered
    // successes and every permanent failure need the adapter's read.
    expect(doc).toContain("A fresh success from a custom `settle` is the caller's own payment code");
    expect(readme).toContain("A fresh success that a custom `settle` reports is the caller's own payment code");
    expect(doc).not.toContain("takes a native success or permanent failure as final only from");
    expect(readme).not.toContain("A native success or permanent failure is final only when the SDK read");
  });

  it("says the recovered fee is read in the numeric form node2's record serves", () => {
    const doc = read("docs/pay-dem-execution.md").replace(/\s+/g, " ");
    const node2 = JSON.parse(read("test/fixtures/demos-node2-records.json")) as {
      getTxByHash: Record<string, { response: { content: { transaction_fee: Record<string, unknown> } } }>;
    };
    for (const envelope of Object.values(node2.getTxByHash)) {
      expect(envelope.response.content.transaction_fee).toMatchObject({ network_fee: 1000000000 });
    }
    expect(doc).toContain(
      "the transaction query serves each component as an OS number up to `Number.MAX_SAFE_INTEGER` and as a decimal string above it",
    );
    expect(doc).toContain("node2's recorded envelopes carry `network_fee: 1000000000`");
    expect(doc).toContain("one with a fee in any other form (`null`, `{}`, an array, a fraction, a negative)");
  });

  it("says a recovered record is read in the denomination it was signed in", () => {
    const doc = read("docs/pay-dem-execution.md").replace(/\s+/g, " ");
    expect(doc).toContain(
      "the SDK reads a record in the denomination its signed payload carries, not the node's current one",
    );
    expect(doc).toContain("A payment saved before the fork therefore still completes after it activates.");
    const readme = read("README.md").replace(/\s+/g, " ");
    expect(readme).toContain("It reads the amount and fee in the denomination the record's signed payload carries");
    expect(doc).not.toContain("a fee in any other form leaves the read indeterminate");
  });

  it("dates the node2 build claims and keeps the fixture historical", () => {
    const doc = read("docs/pay-dem-execution.md").replace(/\s+/g, " ");
    const source = read("src/rails/payDem.ts").replace(/\s*\*\s*/g, " ");
    expect(doc).not.toMatch(/node2 reports [0-9a-f]{7}/);
    expect(source).not.toMatch(/node2 reports [0-9a-f]{7}/);
    expect(doc).toContain("Later on 2026-10-20 node2 reported `11e7c8207732e25035de5a04cab25c5346046493`");
    expect(doc).toContain("`stabilisation@52e2e5698bd9785ddd709de33e4709d5dd7bc308`");
    expect(source).toContain("stabilisation@52e2e5698bd9785ddd709de33e4709d5dd7bc308");
  });
});
