// A retained hash with no attempt record (a client rail records none for a
// result the SDK did not read) finishes only through the settlement store's
// own expired generation, as the key's restart without history would: held,
// it refuses; once the generation expires, the reconciliation of this key must
// name the retained hash, and that generation records and saves it.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createIdempotencyStore,
  createInMemorySettlementLog,
  settlementKey,
} from "../../src/rails/idempotency.js";
import {
  createPayDemClientRail,
  createPayDemRecordReader,
  payDemSettle,
  type DemosNativeClient,
  type DemosTransferResult,
  type PayDemReconciledSettlement,
  type PayDemSettlementAuditContext,
  type PayDemSettlementReconcile,
} from "../../src/rails/payDem.js";

const PAYER_HEX = "ab".repeat(32);
const WALLET = `0x${PAYER_HEX}`;
const PAYEE_HEX = "cd".repeat(32);
const TX_HASH = "7a".repeat(32);
const NONCE = 9;
const BLOCK = 480_877;
const AMOUNT_OS = "9500000000";
const LEASE_MS = 300_000;

const sdk = vi.hoisted(() => ({
  connect: vi.fn(), getNetworkInfo: vi.fn(), getTxByHash: vi.fn(), nodeCall: vi.fn(),
}));
vi.mock("@kynesyslabs/demosdk/websdk", () => ({
  Demos: class MockDemos {
    readonly connect = sdk.connect;
    readonly getNetworkInfo = sdk.getNetworkInfo;
    readonly getTxByHash = sdk.getTxByHash;
    readonly nodeCall = sdk.nodeCall;
  },
}));

let status: unknown;
beforeEach(() => {
  status = { state: "unknown" };
  sdk.connect.mockResolvedValue(true);
  sdk.getNetworkInfo.mockResolvedValue({ forks: { osDenomination: { activated: true } } });
  sdk.nodeCall.mockImplementation(async (method: string) => method === "getAddressNonce" ? NONCE - 1 : status);
  sdk.getTxByHash.mockResolvedValue(null);
});

const request = (jobId: string) => ({
  rail: "pay-dem", phase: "pay-dem" as const, amount: "9.5", asset: "DEM",
  payee: `did:demos:agent:${PAYEE_HEX}`, expectedPayee: PAYEE_HEX, jobId, phaseIndex: 0,
});
const resumed = (jobId: string) => ({
  ...request(jobId), priorAttempts: [{ txHash: TX_HASH, chainId: "demos", ok: false }],
});
const executed = (): PayDemReconciledSettlement => ({
  ok: true, execution: "executed", txHash: TX_HASH, chainId: "demos", payer: PAYER_HEX,
  payee: PAYEE_HEX, finality: { model: "bft-final" }, blockNumber: BLOCK, txRefKind: "demos",
  amountOs: AMOUNT_OS,
}) as PayDemReconciledSettlement;

/** A client whose transfer the SDK's bounded read has not seen land yet. */
async function timingOutClient() {
  const recordReader = await createPayDemRecordReader({
    rpc: "https://node.test", inclusionTimeoutMs: 20, inclusionPollIntervalMs: 1,
    statusRequestTimeoutMs: 5, transactionRecordTimeoutMs: 20,
  });
  const transfer = vi.fn(async (args: Parameters<DemosNativeClient["transfer"]>[0]): Promise<DemosTransferResult> => {
    await args.journalPreparedTransfer?.({
      txHash: TX_HASH, nonce: NONCE, payer: PAYER_HEX, payee: PAYEE_HEX, amountOs: AMOUNT_OS,
      denomination: "os", network: "demos",
      ...(args.recovery === undefined ? {} : { recovery: args.recovery }),
    });
    return { ok: false, state: "timeout", hash: TX_HASH, nonce: NONCE } as DemosTransferResult;
  });
  return { client: { address: WALLET, recordReader, transfer } as DemosNativeClient, transfer };
}

describe("pay-dem finishes a retained client transfer the SDK's read missed through the store's expired generation", () => {
  it("refuses while held, then resolves after the lease expires and after a restart, with one transfer", async () => {
    const { client, transfer } = await timingOutClient();
    let clock = 1_000_000;
    const log = createInMemorySettlementLog();
    const store = createIdempotencyStore(log, { now: () => clock, leaseDurationMs: LEASE_MS });
    const reconcile = vi.fn(async () => executed());
    const settle = payDemSettle(createPayDemClientRail(client), {}, { store, reconcile });

    await expect(settle(request("job-t"))).resolves.toMatchObject({ ok: false, txHash: TX_HASH });
    await expect(log.readAttempt!(settlementKey("pay-dem", "job-t", 0))).resolves.toBeNull();

    // The node now has it; the session resumes with the retained hash.
    status = { state: "included", blockNumber: BLOCK };
    await expect(settle(resumed("job-t"))).rejects.toThrow(/unresolved or in-flight current generation/);

    clock += LEASE_MS + 1_000;
    await expect(settle(resumed("job-t")))
      .resolves.toMatchObject({ ok: true, txHash: TX_HASH, blockNumber: BLOCK });
    // That generation recorded the hash as the key's attempt and saved the outcome.
    await expect(log.readAttempt!(settlementKey("pay-dem", "job-t", 0)))
      .resolves.toMatchObject({ txHash: TX_HASH });
    await expect(log.readOutcome!(settlementKey("pay-dem", "job-t", 0)))
      .resolves.toMatchObject({ result: { ok: true, txHash: TX_HASH } });
    // The store's reconciliation asked for this key's payment, not for the hash.
    expect(reconcile).toHaveBeenCalledWith(expect.not.objectContaining({ txHash: expect.anything() }));

    await expect(settle(resumed("job-t"))).resolves.toMatchObject({ ok: true, txHash: TX_HASH });
    const restarted = payDemSettle(createPayDemClientRail(client), {}, {
      store: createIdempotencyStore(log, { now: () => clock, leaseDurationMs: LEASE_MS }), reconcile,
    });
    await expect(restarted(resumed("job-t"))).resolves.toMatchObject({ ok: true, txHash: TX_HASH });
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it("keeps refusing when the reconciliation of this key finds no payment, and records nothing", async () => {
    const { client, transfer } = await timingOutClient();
    let clock = 1_000_000;
    const log = createInMemorySettlementLog();
    const store = createIdempotencyStore(log, { now: () => clock, leaseDurationMs: LEASE_MS });
    // Asked for the hash, it confirms the transfer; asked for this key, it
    // finds no payment of this key's (the hash was another job's).
    const reconcile = vi.fn(async (context: Readonly<PayDemSettlementAuditContext>) =>
      context.txHash === undefined ? null : executed());
    const settle = payDemSettle(createPayDemClientRail(client), {}, {
      store, reconcile: reconcile as PayDemSettlementReconcile,
    });
    await expect(settle(request("job-2"))).resolves.toMatchObject({ ok: false, txHash: TX_HASH });

    status = { state: "included", blockNumber: BLOCK };
    clock += LEASE_MS + 1_000;
    await expect(settle(resumed("job-2"))).rejects.toThrow(/contradicts reconciliation proof of absence/);
    await expect(log.readAttempt!(settlementKey("pay-dem", "job-2", 0))).resolves.toBeNull();
    await expect(log.readOutcome!(settlementKey("pay-dem", "job-2", 0))).resolves.toBeNull();
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it("refuses when the reconciliation of this key names another transaction", async () => {
    const { client } = await timingOutClient();
    let clock = 1_000_000;
    const log = createInMemorySettlementLog();
    const store = createIdempotencyStore(log, { now: () => clock, leaseDurationMs: LEASE_MS });
    const reconcile = vi.fn(async (context: Readonly<PayDemSettlementAuditContext>) =>
      context.txHash === undefined ? { ...executed(), txHash: "34".repeat(32) } : executed());
    const settle = payDemSettle(createPayDemClientRail(client), {}, {
      store, reconcile: reconcile as PayDemSettlementReconcile,
    });
    await expect(settle(request("job-2"))).resolves.toMatchObject({ ok: false, txHash: TX_HASH });

    status = { state: "included", blockNumber: BLOCK };
    clock += LEASE_MS + 1_000;
    await expect(settle(resumed("job-2"))).rejects.toThrow(/does not name the retained transaction/);
    await expect(log.readAttempt!(settlementKey("pay-dem", "job-2", 0))).resolves.toBeNull();
  });

  it("never finishes it through a store whose once is not the SDK store's", async () => {
    const { client } = await timingOutClient();
    const inner = createIdempotencyStore(createInMemorySettlementLog());
    const reconcile = vi.fn(async () => executed());
    // A wrapper keeps the SDK lookups but asks the bridge to reconcile with
    // no generation of its own.
    const store = {
      once: vi.fn(async (key: string, _binding: unknown, _submit: unknown, reconcileKey?: (key: string) => Promise<unknown>) =>
        reconcileKey!(key)),
      readOutcome: inner.readOutcome,
      readAttempt: inner.readAttempt,
    };
    const settle = payDemSettle(createPayDemClientRail(client), {}, {
      store: store as unknown as ReturnType<typeof createIdempotencyStore>, reconcile,
    });
    status = { state: "included", blockNumber: BLOCK };
    await expect(settle(resumed("job-t")))
      .rejects.toThrow(/finished only through the settlement store's own expired generation/);
  });
});
