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

  it("says a failure proof from outside createPayDemRail never becomes the recorded outcome", () => {
    const doc = read("docs/pay-dem-execution.md").replace(/\s+/g, " ");
    expect(doc).toContain(
      "A failure proof from any other source, including a custom rail, a rail that wraps the SDK rail's `settle`, or a reconciler, leaves the intent held",
    );
  });

  it("says only the SDK's own record read is final and nothing exports a way to vouch", () => {
    const doc = read("docs/pay-dem-execution.md").replace(/\s+/g, " ");
    expect(doc).toContain("Only the SDK's own read of the node makes a fresh payment's verdict final: inside `createPayDemRail`, or through a record reader `createPayDemRecordReader` built.");
    // P2-5 (#369 review): recovery is the reconciler's statement, not a read.
    expect(doc).toContain("the SDK checks only that statement's shape and bindings");
    expect(doc).toContain("The client's `ok`, `state`, `execution`, `blockNumber` and `failureProof` are ignored");
    expect(doc).toContain("is held: `ok: false` with the signed hash and nothing else, when it has no signed nonce, when it is not bound to a transfer this call journaled and signed");
    expect(doc).toContain("No file in the package exports a way to add to it");
  });

  it("says a client or rail the SDK cannot finalise is refused before its effect, and how a transfer is bound to the call", () => {
    const doc = read("docs/pay-dem-execution.md").replace(/\s+/g, " ");
    expect(doc).toContain("before its `transfer` runs: its result could never be final");
    expect(doc).toContain("any other rail, including a wrapper around one of these, is refused on a fresh attempt before its `settle` runs");
    expect(doc).toContain("so an attempt it made before reconciles through `reconcile` without calling it");
    expect(doc).not.toContain("refused when the bridge is built");
    expect(doc).toContain("whose signed nonce is above that account nonce");
    expect(doc).toContain("in one process a hash settles at most one payment");
    // P1-1 (#369 review): the signed time, not the lagging nonce, binds a
    // transfer to the call across a restart.
    expect(doc).toContain("its signed `content.timestamp` (milliseconds, as demosdk sets it when it signs) is not earlier than the SDK's clock when the call began");
    expect(doc).toContain("in any process and after any restart");
    expect(doc).toContain("must carry its `confirmedTotalDebitOs`, at least the amount and within that ceiling");
    const source = read("src/rails/payDem.ts");
    expect(source).toMatch(/"getAddressNonce"/);
    expect(source).toMatch(/signedNonce > nonceFloor/);
    expect(source).toMatch(/signedAt < expected\.signedNotBeforeMs/);
    expect(source).toMatch(/refusing transfer/);
    expect(doc).not.toMatch(/vouch/i);
  });

  it("says the buyer track settles only an SDK record-verified success", () => {
    const doc = read("docs/pay-dem-execution.md").replace(/\s+/g, " ");
    expect(doc).toContain(
      "only when `payDemRecordVerifiedTransfer` lists it with this payment's payer, payee, amount, network and settlement key, and its hash is the one this invocation journaled",
    );
    expect(doc).not.toContain("the host's statement");
    expect(doc).toContain(
      "With any other rail a fresh payment stops for operator action (`pay-dem-rail-not-record-verifying`) before any wallet reservation.",
    );
    expect(doc).toContain(
      "so a payment it made before reconciles through the operator reconciler without calling it",
    );
    expect(doc).not.toContain("refused when the track is built");
    expect(read("packages/dacs-node/src/payDemPayment.ts"))
      .toMatch(/payDemRecordVerifiedTransfer\(raw\)/);
    expect(read("packages/dacs-node/src/payDemPayment.ts"))
      .toMatch(/"pay-dem-rail-not-record-verifying"/);
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
