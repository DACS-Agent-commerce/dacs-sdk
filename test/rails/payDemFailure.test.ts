import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SettleResult } from "../../src/agent/runSessionCore.js";
import { createIdempotencyStore, createInMemorySettlementLog,
  type SettlementBinding } from "../../src/rails/idempotency.js";
import { observeDemosExecutionByHash, payDemSettle, payDemSettleCore } from "../../src/rails/payDem.js";

const txHash = "ab".repeat(32);
const payer = "11".repeat(32);
const payee = "22".repeat(32);
const proof = { kind: "demos-failed-record" as const, txHash, payer, payee,
  nonce: 9, blockNumber: 42, amountOs: "1000000000" };
const failure: SettleResult = { ok: false, txHash, payer, payee, chainId: "demos",
  errorClass: "permanent", failureProof: proof, blockNumber: 42, txRefKind: "demos" };
const binding: SettlementBinding = { bindingVersion: "1", railId: "pay-dem",
  jobId: "failure-proof", phaseIndex: 0, phase: "pay-dem", amount: proof.amountOs,
  agreementAsset: "DEM", settlementAsset: "DEM", payer, payee, network: "demos",
  finality: { model: "bft-final" } };
const key = "pay-dem:failure-proof:0";

describe("terminal failed Demos record", () => {
  const vectors: { vectors: Array<{ name: string; input: {
    recordStatus: string; recordNonce: number | null; recordBlock: number;
  }; executionState: string }> } = JSON.parse(readFileSync(new URL("../fixtures/standard-next/pay-dem-execution-v0.1.json", import.meta.url), "utf8"));
  it.each(vectors.vectors)("replays execution conformance vector $name", async (vector) => {
    const input = vector.input;
    const record = { hash: txHash, status: input.recordStatus,
      blockNumber: input.recordBlock, content: {
        type: "native", from: payer, to: payee, amount: proof.amountOs,
        ...(input.recordNonce === null ? {} : { nonce: String(input.recordNonce) }),
        data: ["native", { nativeOperation: "send", args: [payee, proof.amountOs] }],
      } };
    const result = await observeDemosExecutionByHash(txHash, async () => record, {
      blockNumber: 42, transfer: { payer, payee, nonce: 9,
        amountOs: BigInt(proof.amountOs), postFork: true },
    }, { transactionRecordTimeoutMs: 5, inclusionPollIntervalMs: 1, statusRequestTimeoutMs: 5 });
    expect(result.state).toBe(vector.executionState);
  });

  it("persists a permanent result and reuses it after a store restart without submission", async () => {
    const log = createInMemorySettlementLog();
    const submit = vi.fn(async () => failure);
    await expect(createIdempotencyStore(log).once(key, binding, submit)).resolves.toEqual(failure);
    const forbidden = vi.fn(async () => { throw new Error("must not submit or reconcile"); });
    await expect(createIdempotencyStore(log).once(key, binding, forbidden, forbidden))
      .resolves.toEqual(failure);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("authenticates terminal failure when recovering an ambiguous intent without replacement", async () => {
    const log = createInMemorySettlementLog();
    const before = createIdempotencyStore(log, { owner: "before", now: () => 1, leaseDurationMs: 1 });
    await expect(before.once(key, binding, async () => { throw new Error("lost response"); }))
      .rejects.toThrow("lost response");
    const after = createIdempotencyStore(log, { owner: "after", now: () => 3, leaseDurationMs: 1 });
    const submit = vi.fn(async () => failure);
    await expect(after.once(key, binding, submit, async () => failure)).resolves.toEqual(failure);
    expect(submit).not.toHaveBeenCalled();
  });

  it("reconciles a permanent failure through the pay-dem bridge after restart", async () => {
    const log = createInMemorySettlementLog();
    const submit = vi.fn(async () => { throw new Error("lost transfer response"); });
    const rail = { address: payer, settle: submit };
    const request = { rail: "pay-dem", phase: "pay-dem", amount: "1", asset: "DEM",
      payee: `did:demos:agent:${payee}`, expectedPayee: `did:demos:agent:${payee}`,
      jobId: "failure-proof", phaseIndex: 0 };
    const first = payDemSettle(rail, {}, { store: createIdempotencyStore(log,
      { owner: "before", now: () => 1, leaseDurationMs: 1 }) });
    await expect(first(request)).rejects.toThrow("lost transfer response");
    const reconcile = vi.fn(async () => ({ ...failure, amountOs: proof.amountOs, ok: false as const,
      errorClass: "permanent" as const, failureProof: proof }));
    const after = payDemSettle(rail, {}, { store: createIdempotencyStore(log,
      { owner: "after", now: () => 3, leaseDurationMs: 1 }), reconcile });
    await expect(after(request)).resolves.toEqual({ ...failure, payee: request.expectedPayee });
    await expect(after(request)).resolves.toEqual({ ...failure, payee: request.expectedPayee });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("refuses to promote a stored permanent failure to success on bridge restart", async () => {
    const log = createInMemorySettlementLog();
    const request = { rail: "pay-dem", phase: "pay-dem", amount: "1", asset: "DEM",
      payee: `did:demos:agent:${payee}`, expectedPayee: payee,
      jobId: "failure-proof", phaseIndex: 0 };
    const submit = vi.fn(async () => failure);
    await payDemSettle({ address: payer, settle: submit }, {},
      { store: createIdempotencyStore(log) })(request);
    const restarted = payDemSettle({ address: payer, settle: submit }, {}, {
      store: createIdempotencyStore(log),
      reconcile: async () => ({ ok: true, txHash, payer, payee, chainId: "demos",
        execution: "executed", amountOs: proof.amountOs, blockNumber: 42,
        finality: { model: "bft-final" }, txRefKind: "demos" }),
    });
    await expect(restarted(request)).rejects.toThrow(/contradicted a permanent/);
    expect(submit).toHaveBeenCalledTimes(1);
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
    ["class without proof", { ...failure, failureProof: undefined }],
    ["proof without class", { ...failure, errorClass: undefined }],
    ["wrong amount", { ...failure, failureProof: { ...proof, amountOs: "1" } }],
    ["success with failure proof", { ...failure, ok: true }],
    ["failure with success finality time", { ...failure, finalityObservedAt: 42 }],
  ])("refuses to persist %s", async (_label, value) => {
    const store = createIdempotencyStore();
    await expect(store.once(key, binding, async () => value as SettleResult))
      .rejects.toThrow(/terminal-failure proof|canonical/);
  });
});
