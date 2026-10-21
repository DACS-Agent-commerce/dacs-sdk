import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettleResult } from "../../src/agent/runSessionCore.js";
import { hasDefinitiveDemosFailure } from "../../src/agent/settlementFailure.js";
import { createIdempotencyStore, createInMemorySettlementLog,
  type SettlementBinding } from "../../src/rails/idempotency.js";
import { payDemSettle, payDemSettleCore,
  type PayDemRailResult } from "../../src/rails/payDem.js";
import { demosNode, resetDemosNode, sdkRail, sdkTransfers, serveNodeRecord } from "../fixtures/demosNodeMock.js";

vi.mock("@kynesyslabs/demosdk/websdk", async () => (await import("../fixtures/demosNodeMock.js")).demosSdkModule());

const txHash = "ab".repeat(32);
const payer = "11".repeat(32);
const payee = "22".repeat(32);
const proof = { kind: "demos-failed-record" as const, txHash, payer, payee,
  nonce: 9, blockNumber: 42, amountOs: "1000000000" };
const failure: PayDemRailResult = { ok: false, txHash, payer, payee, chainId: "demos",
  errorClass: "permanent", failureProof: proof, blockNumber: 42, txRefKind: "demos" };
const binding: SettlementBinding = { bindingVersion: "1", railId: "pay-dem",
  jobId: "failure-proof", phaseIndex: 0, phase: "pay-dem", amount: proof.amountOs,
  agreementAsset: "DEM", settlementAsset: "DEM", payer, payee, network: "demos",
  finality: { model: "bft-final" } };
const key = "pay-dem:failure-proof:0";
// The node signs `txHash` at the proof's nonce and records it `failed` in the
// proof's block: createPayDemRail's own settle reads and binds that record, so
// its proof is the only one the store may keep as the definitive outcome.
beforeEach(() => resetDemosNode({ payer, txHash, nonce: proof.nonce, blockNumber: proof.blockNumber,
  recordStatus: "failed" }));

describe("terminal failed Demos record", () => {
  it.each(["", " demos", "demos ", "de\u0301mos"])(
    "refuses noncanonical failure-proof network %j", (chainId) => {
      expect(hasDefinitiveDemosFailure({ ...failure, chainId }, proof.amountOs, "demos")).toBe(false);
    },
  );
  it("binds failure proof to the configured network", () => {
    expect(hasDefinitiveDemosFailure(failure, proof.amountOs, "demos")).toBe(true);
    expect(hasDefinitiveDemosFailure(failure, proof.amountOs, "demos:testnet")).toBe(false);
  });
  it.each([`z${txHash}`, `${txHash}z`])("refuses extra transaction-hash bytes %s", (hash) => {
    expect(hasDefinitiveDemosFailure({ ...failure, txHash: hash,
      failureProof: { ...proof, txHash: hash } }, proof.amountOs, "demos")).toBe(false);
  });
  it.each(["demos", "demos:testnet"])("classifies and persists a record-verified failed record on %s and reuses it after a store restart without submission", async (network) => {
    const log = createInMemorySettlementLog();
    const request = { rail: "pay-dem", phase: "pay-dem", amount: "1", asset: "DEM",
      payee: `did:demos:agent:${payee}`, expectedPayee: payee, jobId: "failure-proof", phaseIndex: 0 };
    const rail = await sdkRail();
    const result = await payDemSettle(rail, { network }, { store: createIdempotencyStore(log) })(request);
    expect(result).toMatchObject({ ...failure, chainId: network });
    await expect(createIdempotencyStore(log).readOutcome!(key, { ...binding, network }))
      .resolves.toMatchObject({ ...failure, chainId: network });
    // A restarted bridge authenticates the durable outcome by reconciliation.
    const reconcile = vi.fn(async () => ({ ...failure, chainId: network, amountOs: proof.amountOs,
      ok: false as const, errorClass: "permanent" as const, failureProof: proof }));
    const restarted = payDemSettle(rail, { network },
      { store: createIdempotencyStore(log), reconcile });
    await expect(restarted(request)).resolves.toEqual(result);
    expect(sdkTransfers()).toBe(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("refuses failure reconciliation from a different configured network", async () => {
    const log = createInMemorySettlementLog();
    demosNode.transfer.mockRejectedValue(new Error("lost response"));
    const rail = await sdkRail({ network: "demos:testnet" });
    const request = { rail: "pay-dem", phase: "pay-dem", amount: "1", asset: "DEM",
      payee: `did:demos:agent:${payee}`, expectedPayee: payee, jobId: "failure-proof", phaseIndex: 0 };
    await expect(payDemSettle(rail, { network: "demos:testnet" }, {
      store: createIdempotencyStore(log, { owner: "before", now: () => 1, leaseDurationMs: 1 }),
    })(request)).rejects.toThrow("lost response");
    await expect(payDemSettle(rail, { network: "demos:testnet" }, {
      store: createIdempotencyStore(log, { owner: "after", now: () => 3, leaseDurationMs: 1 }),
      reconcile: async () => ({ ...failure, ok: false as const, errorClass: "permanent" as const,
        amountOs: proof.amountOs, failureProof: proof }),
    })(request)).rejects.toThrow(/network/);
    expect(sdkTransfers()).toBe(1);
  });

  // A reconciler is the caller's statement, so its failure never becomes the
  // definitive outcome; the intent stays held and nothing is resubmitted.
  it("keeps an ambiguous intent held when reconciliation reports a bound failure", async () => {
    const log = createInMemorySettlementLog();
    const before = createIdempotencyStore(log, { owner: "before", now: () => 1, leaseDurationMs: 1 });
    await expect(before.once(key, binding, async () => { throw new Error("lost response"); }))
      .rejects.toThrow("lost response");
    const after = createIdempotencyStore(log, { owner: "after", now: () => 3, leaseDurationMs: 1 });
    const submit = vi.fn(async () => failure);
    await expect(after.once(key, binding, submit, async () => failure))
      .rejects.toThrow(/reconciliation was not definitive/);
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(["demos", "demos:testnet"])("holds a reconciled permanent failure on %s through the pay-dem bridge after restart", async (network) => {
    const log = createInMemorySettlementLog();
    demosNode.transfer.mockRejectedValue(new Error("lost transfer response"));
    const rail = await sdkRail({ network });
    const request = { rail: "pay-dem", phase: "pay-dem", amount: "1", asset: "DEM",
      payee: `did:demos:agent:${payee}`, expectedPayee: `did:demos:agent:${payee}`,
      jobId: "failure-proof", phaseIndex: 0 };
    const first = payDemSettle(rail, { network }, { store: createIdempotencyStore(log,
      { owner: "before", now: () => 1, leaseDurationMs: 1 }) });
    await expect(first(request)).rejects.toThrow("lost transfer response");
    // The node's failed record of the hash the reconciler names, which the SDK reads itself.
    serveNodeRecord(txHash, { payer, payee, nonce: proof.nonce, blockNumber: proof.blockNumber, status: "failed" });
    const reconcile = vi.fn(async () => ({ ...failure, chainId: network, amountOs: proof.amountOs, ok: false as const,
      errorClass: "permanent" as const, failureProof: proof }));
    const after = payDemSettle(rail, { network }, { store: createIdempotencyStore(log,
      { owner: "after", now: () => 3, leaseDurationMs: 1 }), reconcile });
    await expect(after(request)).rejects.toThrow(/reconciliation was not definitive/);
    expect(sdkTransfers()).toBe(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("refuses to promote a stored permanent failure to success on bridge restart", async () => {
    const log = createInMemorySettlementLog();
    const request = { rail: "pay-dem", phase: "pay-dem", amount: "1", asset: "DEM",
      payee: `did:demos:agent:${payee}`, expectedPayee: payee,
      jobId: "failure-proof", phaseIndex: 0 };
    const rail = await sdkRail();
    await payDemSettle(rail, { network: "demos" }, { store: createIdempotencyStore(log) })(request);
    const restarted = payDemSettle(rail, { network: "demos" }, {
      store: createIdempotencyStore(log),
      reconcile: async () => ({ ok: true, txHash, payer, payee, chainId: "demos",
        execution: "executed", amountOs: proof.amountOs, blockNumber: 42,
        finality: { model: "bft-final" }, txRefKind: "demos" }),
    });
    await expect(restarted(request)).rejects.toThrow(/contradicts the authoritative reconciled outcome/);
    expect(sdkTransfers()).toBe(1);
  });

  it.each([
    ["missing", undefined], ["wrong amount", { ...proof, amountOs: "1" }],
    ["wrong hash", { ...proof, txHash: "cd".repeat(32) }],
    ["wrong block", { ...proof, blockNumber: 43 }],
    ["wrong payer", { ...proof, payer: payee }],
    ["wrong payee", { ...proof, payee: payer }],
    ["missing nonce", Object.fromEntries(Object.entries(proof).filter(([key]) => key !== "nonce"))],
    ["invalid nonce", { ...proof, nonce: -1 }],
  ])("does not promote %s proof to a permanent outcome", async (_label, value) => {
    // A client's own failure statement is never a proof: the SDK reads the
    // record only for the client createPayDemRail built, so any other client
    // is refused before its transfer runs.
    const transfer = vi.fn(async (args: { to: string; amountOs: bigint;
      journalPreparedTransfer?: (entry: object) => Promise<void> }) => {
      await args.journalPreparedTransfer?.({ txHash, nonce: proof.nonce, payer, payee: args.to,
        amountOs: args.amountOs.toString(), network: "demos" });
      return { ok: false, hash: txHash, nonce: proof.nonce,
        state: "failed", blockNumber: 42, ...(value === undefined ? {} : { failureProof: value }) };
    });
    await expect(payDemSettleCore({ recipient: payee, amount: proof.amountOs },
      { address: payer, transfer } as never)).rejects.toThrow(/could never be final/);
    expect(transfer).not.toHaveBeenCalled();
  });

  it.each([
    ["class without proof", Object.fromEntries(Object.entries(failure).filter(([key]) => key !== "failureProof"))],
    ["proof without class", Object.fromEntries(Object.entries(failure).filter(([key]) => key !== "errorClass"))],
    ["wrong amount", { ...failure, failureProof: { ...proof, amountOs: "1" } }],
    ["success with failure proof", { ...failure, ok: true, finality: { model: "bft-final" } }],
    ["failure with success finality time", { ...failure, finalityObservedAt: 42 }],
  ])("refuses to persist %s", async (_label, value) => {
    const store = createIdempotencyStore();
    await expect(store.once(key, binding, async () => value as SettleResult))
      .rejects.toThrow(/terminal-failure proof|canonical/);
  });
});
