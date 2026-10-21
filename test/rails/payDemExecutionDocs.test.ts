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

  it("states the attempt-record contract for the SDK's rails and durable logs", () => {
    const doc = read("docs/pay-dem-execution.md").replace(/\s+/g, " ");
    const readme = read("README.md").replace(/\s+/g, " ");
    for (const text of [doc, readme]) {
      // #370 sweep: only the SDK's own signing writes a record; a payment
      // that predates records is finished through the store's own generation.
      expect(text).toContain("`createPayDemRail` signs the hash itself");
      expect(text).toContain("leaves a retained hash no record names");
      expect(text).not.toContain("is not recorded and stays unbound");
      expect(text).not.toContain("record the exact hash they will return before they broadcast");
      expect(text).not.toContain("through the journal hook the SDK hands");
      // A log that can start a transfer reads outcomes without a claim, and
      // the lookup of an older log refuses rather than claims.
      expect(text).toContain("that keeps attempt records must implement `readOutcome`");
      expect(text).toContain("`createIdempotencyStore` lookup never claims, leases or binds a key");
      expect(text).not.toContain("so it is not read-only");
      expect(text).not.toContain("records that hash again");
      expect(text).toContain("does not write it again after the payment is final");
      expect(text).not.toContain("never claims a submit generation");
    }
    for (const text of [doc, readme]) {
      expect(text).not.toContain("keeps working for fresh settlement");
      expect(text).toContain("starts no new transfer through a `createIdempotencyStore` store over a log without it");
      expect(text).toContain("backfill each outcome that names a transaction as its attempt record");
      expect(text).toContain("Once the log keeps attempts, an outcome without a record never counts.");
    }
    for (const text of [doc, readme]) {
      expect(text).toContain("records the canonical form (64 lower-case hex digits, no `0x`) whichever form the rail passes");
    }
    // #370 sweep: the audit writes through the store's generation in one place,
    // the gate is per key, and the upgrade is stated.
    for (const text of [doc, readme]) {
      expect(text).not.toContain("is a read-only audit");
      expect(text).toContain("that never submits");
      expect(text).not.toContain("acquires submit authority");
      expect(text).toContain("returned by that same");
      expect(text).toContain("own `once` (not a wrapper's, nor another");
      expect(text).toContain("It reads only, except to finish a retained hash that no record names");
      expect(text).toContain("This is the one place an audit changes the log");
      expect(text).toContain("It never submits.");
      expect(text).toContain("that store's own fence for this key and these terms");
      expect(text).toContain("finishes a retained hash only through the store's expired generation");
      expect(text).toContain("Upgrading: this is a breaking change for stores and logs that paid before.");
      expect(text).toContain("`createIdempotencyStore` also throws for a log that provides only one of the attempt pair");
      expect(text).toContain("it writes only when the SDK rail returned a hash its own pre-broadcast write did not report");
    }
    for (const text of [doc, readme]) {
      expect(text).toContain("Nor does it start one through any other store, wrapper or fence");
      expect(text).toContain("whose own `readOutcome` and `readAttempt` it carries");
      expect(text).not.toContain("lookup reads through `claimIntent`");
      expect(text).toContain("over an older log without `readOutcome` it refuses");
      expect(text).not.toContain("is never recorded");
      expect(text).not.toContain("saved before attempt records existed");
      expect(text).not.toContain("also records any hash a rail returns");
      expect(text).not.toContain("must therefore implement the optional `readOutcome` method");
    }
  });

  it("says a failure proof from outside createPayDemRail never becomes the recorded outcome", () => {
    const doc = read("docs/pay-dem-execution.md").replace(/\s+/g, " ");
    expect(doc).toContain(
      "A failure proof from any other source, including a custom rail, a rail that wraps the SDK rail's `settle`, or a reconciler, leaves the intent held",
    );
  });

  it("says only the SDK's own record read is final and nothing exports a way to vouch", () => {
    const doc = read("docs/pay-dem-execution.md").replace(/\s+/g, " ");
    expect(doc).toContain("Only the SDK's own read of the node makes a fresh payment's verdict final, inside `createPayDemRail`.");
    // Recovery is the rail's own read of the node's record, not a statement.
    expect(doc).not.toContain("the SDK checks only that statement's shape and bindings");
    expect(doc).toContain("the rail's own read of the node's record decides it");
    expect(doc).toContain("No file in the package exports a way to add to it");
  });

  it("says a client or rail the SDK cannot finalise is refused before its effect, and why", () => {
    const doc = read("docs/pay-dem-execution.md").replace(/\s+/g, " ");
    expect(doc).toContain("`payDemSettleCore` refuses any client except the one `createPayDemRail` builds, before its `transfer` runs: its result could never be final");
    expect(doc).toContain("any other rail, including a wrapper around it, is refused on a fresh attempt before its `settle` runs");
    expect(doc).toContain("so an attempt it made before reconciles through `reconcile` without calling it");
    expect(doc).not.toContain("refused when the bridge is built");
    // Sweep 10 (#369 review): a record read after another party's broadcast
    // cannot bind that transfer to the call, its ordering or its fee.
    expect(doc).toContain("not that this call made it, that it came after the journal and the fence, or what fee it paid");
    expect(doc).not.toMatch(/createPayDemRecordReader|createPayDemClientRail|recordReader/);
    const source = read("src/rails/payDem.ts");
    expect(source).toMatch(/refusing transfer/);
    expect(source).not.toMatch(/createPayDemRecordReader|createPayDemClientRail|recordReader/);
    expect(read("README.md")).not.toMatch(/createPayDemRecordReader|createPayDemClientRail|recordReader/);
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

  it("says a recovered verdict is the SDK's own node read and a native session calls only the adapter", () => {
    const doc = read("docs/pay-dem-execution.md").replace(/\s+/g, " ");
    const readme = read("README.md").replace(/\s+/g, " ");
    expect(doc).toContain("is then decided by the rail's own read of the node's record for that hash");
    // Every rail that may pay can read its payment again (sweep P1-A).
    expect(doc).toContain("through the connection `createPayDemRail` opened: one bounded");
    expect(doc).toContain("Only a rail with such a read may make a fresh payment");
    expect(readme).toContain("the adapter reads the record through that rail's own connection, for that rail's wallet only");
    expect(readme).toContain("so a session paid through it can be resumed or repeated");
    expect(doc).toContain("including a `networkFeeOs` the record does not carry");
    expect(doc).toContain("A failure found by a lookup by key is never final");
    expect(doc).not.toMatch(/wire one that reads the node you trust/);
    // No custom settle or recovery is called for native DEM, so no run can
    // complete on a success that a re-run could not read again.
    expect(doc).toContain("as `settle` and as `resumeSettlement`");
    expect(doc).toContain("Any other implementation is refused before it is called, so it makes no payment");
    expect(readme).toContain("A native DEM session calls only that adapter, as `settle` and as `resumeSettlement`");
    expect(readme).toContain("is refused before it is called, so it makes no payment");
    expect(readme).toContain("the session binds it and saves it as an unresolved attempt");
    expect(doc).not.toContain("caller's own payment code");
    expect(readme).not.toContain("caller's own payment code");
    expect(doc).not.toContain("takes a native success or permanent failure as final only from");
    expect(readme).not.toContain("A native success or permanent failure is final only when the SDK read");
  });

  it("says the store keeps a reconciled failure held and a by-key success relies on the reconciler", () => {
    const doc = read("docs/pay-dem-execution.md").replace(/\s+/g, " ");
    expect(doc).toContain("The store records no reconciled failure as the definitive outcome");
    expect(doc).not.toContain("a failure the SDK read for that hash is final");
    expect(doc).toContain("a success found that way relies on the reconciler to look up this exact payment");
  });

  it("says the fork state that bounds a recovered read is read afresh", () => {
    const doc = read("docs/pay-dem-execution.md").replace(/\s+/g, " ");
    const readme = read("README.md").replace(/\s+/g, " ");
    expect(doc).toContain("The SDK reads that fork state from the node for each recovery (`nodeCall(\"getNetworkInfo\")`)");
    expect(readme).toContain("is read from the node afresh for each recovery");
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
