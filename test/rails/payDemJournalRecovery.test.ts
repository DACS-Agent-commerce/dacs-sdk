import { beforeEach, describe, expect, test, vi } from "vitest";

import type { SettleRequest } from "../../src/agent/runSessionCore.js";
import { createIdempotencyStore, createInMemorySettlementLog } from "../../src/rails/idempotency.js";
import {
  payDemSettle,
  type PayDemPreparedTransfer,
  type PayDemSettlementReconcile,
} from "../../src/rails/payDem.js";
import { demosNode, resetDemosNode, sdkRail, sdkTransfers } from "../fixtures/demosNodeMock.js";

vi.mock("@kynesyslabs/demosdk/websdk", async () => (await import("../fixtures/demosNodeMock.js")).demosSdkModule());

const txHash = "12".repeat(32);
const payer = "ab".repeat(32);
const payee = "cd".repeat(32);
const request = (): SettleRequest => ({
  rail: "pay-dem", phase: "pay-dem", phaseIndex: 0, jobId: "journal-recovery",
  amount: "1", asset: "DEM", payee: `did:demos:agent:${payee}`, expectedPayee: payee,
});

beforeEach(() => resetDemosNode({ payer, txHash }));

describe("recovery of the SDK's own prepared-transfer journal", () => {
  test.each([
    { railNetwork: undefined, invocationNetwork: undefined, expectedNetwork: "demos" },
    { railNetwork: undefined, invocationNetwork: "demos:testnet", expectedNetwork: "demos:testnet" },
    { railNetwork: "demos:mainnet", invocationNetwork: "demos:testnet", expectedNetwork: "demos:testnet" },
  ])("journals the effective network $expectedNetwork (rail=$railNetwork, invocation=$invocationNetwork)",
    async ({ railNetwork, invocationNetwork, expectedNetwork }) => {
      const journal: Readonly<PayDemPreparedTransfer>[] = [];
      const log = createInMemorySettlementLog();
      const config = { network: invocationNetwork };
      const rail = await sdkRail({
        network: railNetwork,
        journalPreparedTransfer: async (prepared) => { journal.push(prepared); },
      });
      const first = await payDemSettle(rail, config, { store: createIdempotencyStore(log) })(request());
      expect(first).toMatchObject({ ok: true, txHash, chainId: expectedNetwork });
      expect(journal).toHaveLength(1);
      expect(journal[0]!.network).toBe(expectedNetwork);
      expect(journal[0]!.recovery).toMatchObject({ network: expectedNetwork });
      const reconcile: PayDemSettlementReconcile = vi.fn(async () => ({
        ...first, amountOs: "1000000000", execution: "executed" as const, preparedTransfer: journal[0],
      }));

      // A new store and bridge simulate restart using only state this version wrote.
      for (const withHistory of [false, true]) {
        const restarted = payDemSettle(await sdkRail(), config, {
          store: createIdempotencyStore(log), reconcile,
        });
        const req = { ...request(), ...(withHistory ? {
          priorAttempts: [{ txHash, chainId: expectedNetwork, ok: true }],
        } : {}) };
        await expect(restarted(req)).resolves.toEqual(first);
        await expect(restarted(req)).resolves.toEqual(first);
      }
      expect(sdkTransfers()).toBe(1);
      expect(demosNode.broadcast).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    { railNetwork: undefined, invocationNetwork: undefined, expectedNetwork: "demos" },
    { railNetwork: "demos:mainnet", invocationNetwork: undefined, expectedNetwork: "demos:mainnet" },
    { railNetwork: "demos:mainnet", invocationNetwork: "demos:testnet", expectedNetwork: "demos:testnet" },
  ])("direct rail journals $expectedNetwork without a bridge recovery tuple",
    async ({ railNetwork, invocationNetwork, expectedNetwork }) => {
      const journal: Readonly<PayDemPreparedTransfer>[] = [];
      const rail = await sdkRail({ network: railNetwork,
        journalPreparedTransfer: async (prepared) => { journal.push(prepared); },
      });
      await expect(rail.settle({ recipient: payee, amount: "1000000000", network: invocationNetwork }))
        .resolves.toMatchObject({ ok: true, chainId: expectedNetwork, txHash });
      expect(journal).toHaveLength(1);
      expect(journal[0]!.network).toBe(expectedNetwork);
      expect(journal[0]!.recovery).toBeUndefined();
      expect(demosNode.broadcast).toHaveBeenCalledTimes(1);
    },
  );

  test("still refuses a journal for a different network", async () => {
    let prepared: Readonly<PayDemPreparedTransfer> | undefined;
    const log = createInMemorySettlementLog();
    const first = await payDemSettle(await sdkRail({
      journalPreparedTransfer: async (entry) => { prepared = entry; },
    }), {}, { store: createIdempotencyStore(log) })(request());
    const reconcile: PayDemSettlementReconcile = async () => ({
      ...first, amountOs: "1000000000", execution: "executed",
      preparedTransfer: { ...prepared!, network: "demos:other" },
    });
    const restarted = payDemSettle(await sdkRail(), {}, { store: createIdempotencyStore(log), reconcile });
    await expect(restarted({ ...request(), priorAttempts: [{ txHash, chainId: "demos", ok: true }] }))
      .rejects.toThrow(/journal does not bind the retained transaction/);
    expect(sdkTransfers()).toBe(1);
  });
});

describe("returned failed-record proofs cannot change recovery state", () => {
  test.each(["fresh", "restart", "audit"] as const)("isolates the proof returned by %s", async (entry) => {
    resetDemosNode({ payer, txHash, recordStatus: "failed" });
    const log = createInMemorySettlementLog();
    const fresh = payDemSettle(await sdkRail(), {}, { store: createIdempotencyStore(log) });
    const first = await fresh(request());
    expect(first).toMatchObject({ ok: false, errorClass: "permanent", failureProof: { nonce: 9 } });
    const observation = {
      ...first, ok: false as const, errorClass: "permanent" as const,
      failureProof: { ...first.failureProof! }, amountOs: "1000000000",
    };
    const reconcile: PayDemSettlementReconcile = vi.fn(async () => observation);
    const audit = { ...request(), priorAttempts: [{ txHash, chainId: "demos", ok: false }] };
    const settle = entry === "fresh" ? fresh : payDemSettle(await sdkRail(), {}, {
      store: createIdempotencyStore(log), reconcile,
    });
    const result = entry === "fresh" ? first : await settle(entry === "audit" ? audit : request());
    // Reflect.set also works when the public proof is deliberately immutable.
    Reflect.set(result.failureProof!, "nonce", 999);
    Reflect.set(result.failureProof!, "amountOs", "2");
    const expected = { ok: false, txHash, errorClass: "permanent", failureProof: { nonce: 9, amountOs: "1000000000" } };
    await expect(settle(audit)).resolves.toMatchObject(expected);
    await expect(settle(request())).resolves.toMatchObject(expected);
    await expect(payDemSettle(await sdkRail(), {}, {
      store: createIdempotencyStore(log), reconcile,
    })(audit)).resolves.toMatchObject(expected);
    expect(sdkTransfers()).toBe(1);
    expect(demosNode.broadcast).toHaveBeenCalledTimes(1);
  });
});
