import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettleResult } from "../../src/agent/runSessionCore.js";
import { hasDefinitiveDemosFailure } from "../../src/agent/settlementFailure.js";
import { createIdempotencyStore, createInMemorySettlementLog,
  type SettlementBinding } from "../../src/rails/idempotency.js";
import { payDemSettle, payDemSettleCore,
  type PayDemRailResult } from "../../src/rails/payDem.js";
import { demosNode, nodeRecord, sdkPayDemRail } from "../fixtures/demosNodeMock.js";

vi.mock("@kynesyslabs/demosdk/websdk", async () =>
  (await import("../fixtures/demosNodeMock.js")).demosWebsdkMock);

const txHash = "ab".repeat(32);
const payer = "11".repeat(32);
const payee = "22".repeat(32);
// The SDK rail's wallet signs `txHash` at nonce 9; the node records it failed at block 42.
beforeEach(() => {
  demosNode.reset();
  Object.assign(demosNode, { address: payer, nextHash: txHash, recordStatus: "failed" });
});
const request = { rail: "pay-dem", phase: "pay-dem", amount: "1", asset: "DEM",
  payee: `did:demos:agent:${payee}`, expectedPayee: `did:demos:agent:${payee}`,
  jobId: "failure-proof", phaseIndex: 0 };
const proof = { kind: "demos-failed-record" as const, txHash, payer, payee,
  nonce: 9, blockNumber: 42, amountOs: "1000000000" };
const failure: PayDemRailResult = { ok: false, txHash, payer, payee, chainId: "demos",
  errorClass: "permanent", failureProof: proof, blockNumber: 42, txRefKind: "demos" };
const binding: SettlementBinding = { bindingVersion: "1", railId: "pay-dem",
  jobId: "failure-proof", phaseIndex: 0, phase: "pay-dem", amount: proof.amountOs,
  agreementAsset: "DEM", settlementAsset: "DEM", payer, payee, network: "demos",
  finality: { model: "bft-final" } };
const key = "pay-dem:failure-proof:0";

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
  it("persists the SDK rail's failed record and reuses it after a store restart without submission", async () => {
    const log = createInMemorySettlementLog();
    const settle = payDemSettle(await sdkPayDemRail(), {}, { store: createIdempotencyStore(log) });
    await expect(settle(request)).resolves.toEqual({ ...failure, payee: request.expectedPayee });
    const forbidden = vi.fn(async () => { throw new Error("must not submit or reconcile"); });
    await expect(createIdempotencyStore(log).once(key, binding, forbidden, forbidden))
      .resolves.toEqual(failure);
    expect(demosNode.transfers).toBe(1);
    expect(forbidden).not.toHaveBeenCalled();
    // The same proof from any other submission is never persisted.
    const other = createInMemorySettlementLog();
    await expect(createIdempotencyStore(other).once(key, binding, async () => failure))
      .resolves.toEqual(failure);
    await expect(createIdempotencyStore(other).readOutcome!(key, binding)).resolves.toBeNull();
  });

  it.each(["demos", "demos:testnet"])("classifies and persists a bound failed record on %s", async (network) => {
    const rail = await sdkPayDemRail(network);
    await expect(rail.settle({ recipient: payee, amount: proof.amountOs, network }))
      .resolves.toEqual({ ...failure, chainId: network });
    const log = createInMemorySettlementLog();
    await expect(payDemSettle(rail, { network }, { store: createIdempotencyStore(log) })(request))
      .resolves.toEqual({ ...failure, chainId: network, payee: request.expectedPayee });
    const forbidden = vi.fn(async () => { throw new Error("must not submit"); });
    await expect(createIdempotencyStore(log).once(key, { ...binding, network }, forbidden))
      .resolves.toEqual({ ...failure, chainId: network });
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("refuses failure reconciliation from a different configured network", async () => {
    const log = createInMemorySettlementLog();
    const submit = vi.fn(async () => { throw new Error("lost response"); });
    const rail = { address: payer, settle: submit };
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
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("never takes a reconciled failure as the outcome of an ambiguous intent, nor resubmits", async () => {
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

  // A lookup by key never ties a hash to this key: its failed record may be
  // another job's, so it never ends this payment, even from the SDK rail.
  it.each(["demos", "demos:testnet"])("holds a failed record a lookup by key reports on %s after restart", async (network) => {
    const log = createInMemorySettlementLog();
    const submit = vi.fn(async () => { throw new Error("lost transfer response"); });
    const rail = { address: payer, settle: submit };
    const request = { rail: "pay-dem", phase: "pay-dem", amount: "1", asset: "DEM",
      payee: `did:demos:agent:${payee}`, expectedPayee: `did:demos:agent:${payee}`,
      jobId: "failure-proof", phaseIndex: 0 };
    const first = payDemSettle(rail, { network }, { store: createIdempotencyStore(log,
      { owner: "before", now: () => 1, leaseDurationMs: 1 }) });
    await expect(first(request)).rejects.toThrow("lost transfer response");
    const reconcile = vi.fn(async () => ({ ...failure, chainId: network, amountOs: proof.amountOs, ok: false as const,
      errorClass: "permanent" as const, failureProof: proof }));
    demosNode.records.set(txHash, nodeRecord({ txHash, payer, payee, amountOs: proof.amountOs, status: "failed" }));
    const after = payDemSettle(await sdkPayDemRail(network), { network }, { store: createIdempotencyStore(log,
      { owner: "after", now: () => 3, leaseDurationMs: 1 }), reconcile });
    await expect(after(request)).rejects.toThrow(/reconciliation was not definitive/);
    // The intent stays held: a repeat neither records the failure nor resubmits.
    await expect(after(request)).rejects.toThrow(/in-flight current generation; refusing to resubmit/);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(demosNode.reads).toEqual([txHash]);
    expect(demosNode.transfers).toBe(0);
  });

  it("refuses to promote a stored permanent failure to success on bridge restart", async () => {
    const log = createInMemorySettlementLog();
    const request = { rail: "pay-dem", phase: "pay-dem", amount: "1", asset: "DEM",
      payee: `did:demos:agent:${payee}`, expectedPayee: payee,
      jobId: "failure-proof", phaseIndex: 0 };
    const submit = vi.fn();
    await payDemSettle(await sdkPayDemRail(), {}, { store: createIdempotencyStore(log) })(request);
    const restarted = payDemSettle({ address: payer, settle: submit }, {}, {
      store: createIdempotencyStore(log),
      reconcile: async () => ({ ok: true, txHash, payer, payee, chainId: "demos",
        execution: "executed", amountOs: proof.amountOs, blockNumber: 42,
        finality: { model: "bft-final" }, txRefKind: "demos" }),
    });
    await expect(restarted(request)).rejects.toThrow(/contradicts the authoritative reconciled outcome/);
    expect(demosNode.transfers).toBe(1);
    expect(submit).not.toHaveBeenCalled();
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
    const transfer = vi.fn(async () => ({ ok: false, hash: txHash,
      state: "failed", blockNumber: 42, ...(value === undefined ? {} : { failureProof: value }) }));
    const result = await payDemSettleCore({ recipient: payee, amount: proof.amountOs },
      { address: payer, transfer } as never);
    expect(result).toEqual({ ok: false, txHash, chainId: "demos", payer, payee });
    expect(transfer).toHaveBeenCalledTimes(1);
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
