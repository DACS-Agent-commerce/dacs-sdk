// A retained hash with no attempt record (a payment in flight across an
// upgrade, on a log that predates them) finishes only through the settlement store's
// own expired generation, as the key's restart without history would: held,
// it refuses; once the generation expires, the reconciliation of this key must
// name the retained hash, and that generation records and saves it.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createIdempotencyStore,
  createInMemorySettlementLog,
  settlementKey,
  type SettlementLog,
} from "../../src/rails/idempotency.js";
import {
  payDemSettle,
  type PayDemReconciledSettlement,
  type PayDemSettlementAuditContext,
  type PayDemSettlementReconcile,
} from "../../src/rails/payDem.js";
import { heldRail, resetDemosNode, sdkRail, sdkTransfers } from "../fixtures/demosNodeMock.js";

vi.mock("@kynesyslabs/demosdk/websdk", async () => (await import("../fixtures/demosNodeMock.js")).demosSdkModule());

const PAYER_HEX = "ab".repeat(32);
const PAYEE_HEX = "cd".repeat(32);
const TX_HASH = "7a".repeat(32);
const NONCE = 9;
const BLOCK = 480_877;
const AMOUNT_OS = "9500000000";
const LEASE_MS = 300_000;

beforeEach(() => resetDemosNode({ payer: PAYER_HEX, txHash: TX_HASH, nonce: NONCE, blockNumber: BLOCK }));

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

/**
 * A log that predates attempt records: while `predating` holds, a transfer the
 * SDK rail makes is recorded nowhere, as one in flight across an upgrade is.
 */
function logPredatingAttempts() {
  const backing = createInMemorySettlementLog();
  const state = { predating: true };
  const log: SettlementLog = {
    readOutcome: (key) => backing.readOutcome!(key),
    claimIntent: (input) => backing.claimIntent(input),
    isCurrent: (input) => backing.isCurrent(input),
    grantRecovery: (input) => backing.grantRecovery(input),
    putOutcome: (input) => backing.putOutcome(input),
    releaseIntent: (input) => backing.releaseIntent(input),
    putAttempt: async (input) => state.predating ? "recorded" : backing.putAttempt!(input),
    readAttempt: (key) => backing.readAttempt!(key),
  };
  return { log, state };
}

describe("pay-dem finishes a retained transfer no attempt record names through the store's expired generation", () => {
  it("refuses while held, then resolves after the lease expires and after a restart, with one transfer", async () => {
    const { log, state } = logPredatingAttempts();
    let clock = 1_000_000;
    const store = createIdempotencyStore(log, { now: () => clock, leaseDurationMs: LEASE_MS });
    const reconcile = vi.fn(async () => executed());
    const first = payDemSettle(await heldRail(), {}, { store, reconcile });
    // A resumed session reaches a bridge that did not make the payment.
    const settle = payDemSettle(await sdkRail(), {}, { store, reconcile });

    await expect(first(request("job-t"))).resolves.toMatchObject({ ok: false, txHash: TX_HASH });
    await expect(log.readAttempt!(settlementKey("pay-dem", "job-t", 0))).resolves.toBeNull();

    // The session resumes with the retained hash.
    await expect(settle(resumed("job-t"))).rejects.toThrow(/unresolved or in-flight current generation/);

    clock += LEASE_MS + 1_000;
    state.predating = false;
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
    const restarted = payDemSettle(await sdkRail(), {}, {
      store: createIdempotencyStore(log, { now: () => clock, leaseDurationMs: LEASE_MS }), reconcile,
    });
    await expect(restarted(resumed("job-t"))).resolves.toMatchObject({ ok: true, txHash: TX_HASH });
    expect(sdkTransfers()).toBe(1);
  });

  it("keeps refusing when the reconciliation of this key finds no payment, and records nothing", async () => {
    const { log } = logPredatingAttempts();
    let clock = 1_000_000;
    const store = createIdempotencyStore(log, { now: () => clock, leaseDurationMs: LEASE_MS });
    // Asked for the hash, it confirms the transfer; asked for this key, it
    // finds no payment of this key's (the hash was another job's).
    const reconcile = vi.fn(async (context: Readonly<PayDemSettlementAuditContext>) =>
      context.txHash === undefined ? null : executed());
    const first = payDemSettle(await heldRail(), {}, {
      store, reconcile: reconcile as PayDemSettlementReconcile,
    });
    const settle = payDemSettle(await sdkRail(), {}, {
      store, reconcile: reconcile as PayDemSettlementReconcile,
    });
    await expect(first(request("job-2"))).resolves.toMatchObject({ ok: false, txHash: TX_HASH });

    clock += LEASE_MS + 1_000;
    await expect(settle(resumed("job-2"))).rejects.toThrow(/contradicts reconciliation proof of absence/);
    await expect(log.readAttempt!(settlementKey("pay-dem", "job-2", 0))).resolves.toBeNull();
    await expect(log.readOutcome!(settlementKey("pay-dem", "job-2", 0))).resolves.toBeNull();
    expect(sdkTransfers()).toBe(1);
  });

  it("refuses when the reconciliation of this key names another transaction", async () => {
    const { log } = logPredatingAttempts();
    let clock = 1_000_000;
    const store = createIdempotencyStore(log, { now: () => clock, leaseDurationMs: LEASE_MS });
    const reconcile = vi.fn(async (context: Readonly<PayDemSettlementAuditContext>) =>
      context.txHash === undefined ? { ...executed(), txHash: "34".repeat(32) } : executed());
    const first = payDemSettle(await heldRail(), {}, {
      store, reconcile: reconcile as PayDemSettlementReconcile,
    });
    const settle = payDemSettle(await sdkRail(), {}, {
      store, reconcile: reconcile as PayDemSettlementReconcile,
    });
    await expect(first(request("job-2"))).resolves.toMatchObject({ ok: false, txHash: TX_HASH });

    clock += LEASE_MS + 1_000;
    await expect(settle(resumed("job-2"))).rejects.toThrow(/does not name the retained transaction/);
    await expect(log.readAttempt!(settlementKey("pay-dem", "job-2", 0))).resolves.toBeNull();
  });

  it("never finishes it through a store whose once is not the SDK store's", async () => {
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
    const settle = payDemSettle(await sdkRail(), {}, {
      store: store as unknown as ReturnType<typeof createIdempotencyStore>, reconcile,
    });
    await expect(settle(resumed("job-t")))
      .rejects.toThrow(/finished only through the settlement store's own expired generation/);
  });
});
