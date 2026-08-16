import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createPayDemRail: vi.fn(),
  payDemSettle: vi.fn(),
}));

vi.mock("../../src/rails/payDem.js", () => ({
  createPayDemRail: mocks.createPayDemRail,
  payDemSettle: mocks.payDemSettle,
}));

import type { SettleResult } from "../../src/agent/runSessionCore.js";
import type { SettlementIdempotencyStore } from "../../src/rails/idempotency.js";
import {
  settleFromRail,
  type RailDispatchOptions,
} from "../../src/registry/dispatch.js";

const DESCRIPTOR = {
  id: "demos-native:DEM",
  kind: "dem" as const,
  availability: "live" as const,
  params: {},
};

describe("pay-DEM registry dispatch recovery wiring", () => {
  beforeEach(() => {
    mocks.createPayDemRail.mockReset();
    mocks.payDemSettle.mockReset();
  });

  test("threads debit, preparation, durable idempotency, and reconciliation options", async () => {
    const rail = { address: "aa".repeat(32), settle: vi.fn() };
    const executor = vi.fn();
    const journalPreparedTransfer = vi.fn(async () => undefined);
    const reconcile = vi.fn(async (): Promise<SettleResult | null> => null);
    const settlementStore: SettlementIdempotencyStore = {
      once: vi.fn(),
    };
    mocks.createPayDemRail.mockResolvedValue(rail);
    mocks.payDemSettle.mockReturnValue(executor);

    const result = await settleFromRail(DESCRIPTOR, {
      demosRpc: "https://demos.example",
      demosSecret: "test-secret",
      payment: {
        network: "demos-testnet",
        recipient: `did:demos:agent:${"bb".repeat(32)}`,
        phaseIndex: 4,
      },
      payDem: {
        maxTotalDebitOs: 3_000_000_000n,
        journalPreparedTransfer,
        settlementStore,
        reconcile,
        inclusionTimeoutMs: 61_000,
        inclusionPollIntervalMs: 700,
        statusRequestTimeoutMs: 4_000,
        nonceVisibilityTimeoutMs: 62_000,
      },
    });

    expect(result).toBe(executor);
    expect(mocks.createPayDemRail).toHaveBeenCalledWith({
      rpc: "https://demos.example",
      secret: "test-secret",
      network: "demos-testnet",
      maxTotalDebitOs: 3_000_000_000n,
      journalPreparedTransfer,
      inclusionTimeoutMs: 61_000,
      inclusionPollIntervalMs: 700,
      statusRequestTimeoutMs: 4_000,
      nonceVisibilityTimeoutMs: 62_000,
    });
    expect(mocks.payDemSettle).toHaveBeenCalledWith(
      rail,
      {
        recipient: `did:demos:agent:${"bb".repeat(32)}`,
        network: "demos-testnet",
      },
      { store: settlementStore, reconcile },
    );
  });

  test("keeps the documented process-local compatibility defaults explicit", async () => {
    const rail = { address: "aa".repeat(32), settle: vi.fn() };
    const executor = vi.fn();
    mocks.createPayDemRail.mockResolvedValue(rail);
    mocks.payDemSettle.mockReturnValue(executor);

    await expect(settleFromRail(DESCRIPTOR, {
      demosRpc: "https://demos.example",
      demosSecret: "test-secret",
    })).resolves.toBe(executor);

    expect(mocks.createPayDemRail).toHaveBeenCalledWith({
      rpc: "https://demos.example",
      secret: "test-secret",
      network: "demos",
    });
    expect(mocks.payDemSettle).toHaveBeenCalledWith(
      rail,
      { network: "demos" },
      {},
    );
  });

  test("captures recovery authorities before the optional peer connects", async () => {
    let finishConnect!: (rail: unknown) => void;
    mocks.createPayDemRail.mockReturnValue(new Promise((resolve) => {
      finishConnect = resolve;
    }));
    mocks.payDemSettle.mockReturnValue(vi.fn());
    const firstStore: SettlementIdempotencyStore = { once: vi.fn() };
    const secondStore: SettlementIdempotencyStore = { once: vi.fn() };
    const firstReconcile = vi.fn(async (): Promise<SettleResult | null> => null);
    const secondReconcile = vi.fn(async (): Promise<SettleResult | null> => null);
    const options: RailDispatchOptions = {
      demosRpc: "https://demos.example",
      demosSecret: "test-secret",
      payment: { network: "demos-testnet", recipient: "aa".repeat(32) },
      payDem: {
        maxTotalDebitOs: 10n,
        settlementStore: firstStore,
        reconcile: firstReconcile,
      },
    };

    const pending = settleFromRail(DESCRIPTOR, options);
    options.payDem!.maxTotalDebitOs = 20n;
    options.payDem!.settlementStore = secondStore;
    options.payDem!.reconcile = secondReconcile;
    options.payment!.network = "mutated";
    options.payment!.recipient = "bb".repeat(32);
    const rail = { address: "cc".repeat(32), settle: vi.fn() };
    finishConnect(rail);
    await pending;

    expect(mocks.createPayDemRail).toHaveBeenCalledWith(expect.objectContaining({
      maxTotalDebitOs: 10n,
      network: "demos-testnet",
    }));
    expect(mocks.payDemSettle).toHaveBeenCalledWith(
      rail,
      { network: "demos-testnet", recipient: "aa".repeat(32) },
      { store: firstStore, reconcile: firstReconcile },
    );
  });
});
