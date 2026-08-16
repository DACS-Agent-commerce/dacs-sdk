import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createPayDemRail: vi.fn(),
  payDemSettle: vi.fn(),
  createX402Rail: vi.fn(),
  x402Settle: vi.fn(),
  createEvmErc20Rail: vi.fn(),
  evmErc20Settle: vi.fn(),
  createPayD402Rail: vi.fn(),
  payD402Settle: vi.fn(),
}));

vi.mock("../../src/rails/payDem.js", () => ({
  createPayDemRail: mocks.createPayDemRail,
  payDemSettle: mocks.payDemSettle,
}));
vi.mock("../../src/rails/x402.js", () => ({
  createX402Rail: mocks.createX402Rail,
  x402Settle: mocks.x402Settle,
}));
vi.mock("../../src/rails/evmErc20.js", () => ({
  createEvmErc20Rail: mocks.createEvmErc20Rail,
  evmErc20Settle: mocks.evmErc20Settle,
}));
vi.mock("../../src/rails/payD402.js", () => ({
  createPayD402Rail: mocks.createPayD402Rail,
  payD402Settle: mocks.payD402Settle,
}));

import type { SettlementIdempotencyStore } from "../../src/rails/idempotency.js";
import {
  settleFromRail,
  type RailDispatchOptions,
} from "../../src/registry/dispatch.js";
import type { RailDescriptor } from "../../src/registry/types.js";

const DESCRIPTOR = {
  id: "demos-native:DEM",
  kind: "dem" as const,
  availability: "live" as const,
  params: {},
};

const request = (over: Record<string, unknown> = {}) => ({
  rail: DESCRIPTOR.id,
  phase: "pay-dem",
  amount: "1",
  asset: "DEM",
  payee: `did:demos:agent:${"bb".repeat(32)}`,
  expectedPayee: "bb".repeat(32),
  jobId: "job-1",
  phaseIndex: 4,
  ...over,
});

describe("pay-DEM registry dispatch recovery wiring", () => {
  beforeEach(() => {
    mocks.createPayDemRail.mockReset();
    mocks.payDemSettle.mockReset();
    mocks.createX402Rail.mockReset();
    mocks.x402Settle.mockReset();
    mocks.createEvmErc20Rail.mockReset();
    mocks.evmErc20Settle.mockReset();
    mocks.createPayD402Rail.mockReset();
    mocks.payD402Settle.mockReset();
  });

  test("threads debit, preparation, durable idempotency, and reconciliation options", async () => {
    const rail = { address: "aa".repeat(32), settle: vi.fn() };
    const executor = vi.fn();
    const journalPreparedTransfer = vi.fn(async () => undefined);
    const reconcile = vi.fn(async () => null);
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

    expect(typeof result).toBe("function");
    expect(result).not.toBe(executor);
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
        railId: DESCRIPTOR.id,
        phaseIndex: 4,
      },
      { store: settlementStore, reconcile },
    );
  });

  test("keeps the documented process-local compatibility defaults explicit", async () => {
    const rail = { address: "aa".repeat(32), settle: vi.fn() };
    const executor = vi.fn();
    mocks.createPayDemRail.mockResolvedValue(rail);
    mocks.payDemSettle.mockReturnValue(executor);

    const dispatched = await settleFromRail(DESCRIPTOR, {
      demosRpc: "https://demos.example",
      demosSecret: "test-secret",
    });
    expect(typeof dispatched).toBe("function");

    expect(mocks.createPayDemRail).toHaveBeenCalledWith({
      rpc: "https://demos.example",
      secret: "test-secret",
      network: "demos",
    });
    expect(mocks.payDemSettle).toHaveBeenCalledWith(
      rail,
      { network: "demos", railId: DESCRIPTOR.id },
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
    const firstReconcile = vi.fn(async () => null);
    const secondReconcile = vi.fn(async () => null);
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
      {
        network: "demos-testnet",
        recipient: "aa".repeat(32),
        railId: DESCRIPTOR.id,
      },
      { store: firstStore, reconcile: firstReconcile },
    );
  });

  test("owns the authenticated descriptor before constructing the rail", async () => {
    let finishConnect!: (rail: unknown) => void;
    mocks.createPayDemRail.mockReturnValue(new Promise((resolve) => {
      finishConnect = resolve;
    }));
    const executor = vi.fn(async () => ({ ok: true }));
    mocks.payDemSettle.mockReturnValue(executor);
    const descriptor: RailDescriptor = {
      ...DESCRIPTOR,
      params: {},
    };

    const pending = settleFromRail(descriptor, {
      demosRpc: "https://demos.example",
      demosSecret: "test-secret",
      payment: { phaseIndex: 4 },
    });
    descriptor.id = "demos-native:MUTATED";
    descriptor.kind = "x402";
    descriptor.availability = "failed";
    const rail = { address: "aa".repeat(32), settle: vi.fn() };
    finishConnect(rail);
    const dispatched = await pending;

    await expect(dispatched(request())).resolves.toEqual({ ok: true });
    await expect(dispatched(request({ rail: descriptor.id })))
      .rejects.toThrow(/does not match authenticated descriptor/);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["wrong descriptor", { rail: "demos-native:OTHER" }, /does not match authenticated descriptor/],
    ["wrong phase", { phase: "pay-x402" }, /does not match descriptor kind/],
  ])("rejects a %s before invoking the rail", async (_label, override, pattern) => {
    const rail = { address: "aa".repeat(32), settle: vi.fn() };
    const executor = vi.fn();
    mocks.createPayDemRail.mockResolvedValue(rail);
    mocks.payDemSettle.mockReturnValue(executor);
    const dispatched = await settleFromRail(DESCRIPTOR, {
      demosRpc: "https://demos.example",
      demosSecret: "test-secret",
      payment: { phaseIndex: 4 },
    });

    await expect(dispatched(request(override))).rejects.toThrow(pattern);
    expect(executor).not.toHaveBeenCalled();
  });

  test.each(["operator_gated", "closed_data", "bilateral", "mocked", "disabled", "failed"] as const)(
    "refuses non-live availability %s before constructing a rail",
    async (availability) => {
      await expect(settleFromRail({ ...DESCRIPTOR, availability }, {
        demosRpc: "https://demos.example",
        demosSecret: "test-secret",
      })).rejects.toThrow(/is not live/);
      expect(mocks.createPayDemRail).not.toHaveBeenCalled();
      expect(mocks.payDemSettle).not.toHaveBeenCalled();
    },
  );

  test("an experimental opt-in cannot bypass authenticated availability", async () => {
    await expect(settleFromRail({
      id: "d402:preview",
      kind: "d402",
      availability: "operator_gated",
      params: {},
    }, {
      demosRpc: "https://demos.example",
      demosSecret: "test-secret",
      allowExperimentalRails: true,
      payment: {
        url: "https://seller.example/pay",
        network: "demos",
        recipient: "bb".repeat(32),
      },
    })).rejects.toThrow(/is not live/);
    expect(mocks.createPayD402Rail).not.toHaveBeenCalled();
    expect(mocks.payD402Settle).not.toHaveBeenCalled();
  });

  test.each([
    {
      label: "pay-dem",
      descriptor: DESCRIPTOR,
      expectedPhase: "pay-dem",
      options: {
        demosRpc: "https://demos.example",
        demosSecret: "test-secret",
        payment: { phaseIndex: 4 },
      },
      create: mocks.createPayDemRail,
      bridge: mocks.payDemSettle,
    },
    {
      label: "x402",
      descriptor: {
        id: "x402:default",
        kind: "x402",
        availability: "live" as const,
        params: { tokenAddress: "0x1111111111111111111111111111111111111111" },
      },
      expectedPhase: "pay-x402",
      options: {
        evmPrivateKey: "0x" + "11".repeat(32),
        payment: {
          url: "https://seller.example/pay",
          network: "eip155:84532",
          recipient: "0x2222222222222222222222222222222222222222",
        },
      },
      create: mocks.createX402Rail,
      bridge: mocks.x402Settle,
    },
    {
      label: "evm-erc20",
      descriptor: {
        id: "evm-erc20:84532:USDC",
        kind: "evm-erc20",
        availability: "live" as const,
        params: { tokenAddress: "0x1111111111111111111111111111111111111111" },
      },
      expectedPhase: "pay-evm-erc20",
      options: {
        evmPrivateKey: "0x" + "11".repeat(32),
        rpcUrl: "https://rpc.example",
        payment: {
          network: "eip155:84532",
          recipient: "0x2222222222222222222222222222222222222222",
        },
      },
      create: mocks.createEvmErc20Rail,
      bridge: mocks.evmErc20Settle,
    },
    {
      label: "d402 preview",
      descriptor: {
        id: "d402:preview",
        kind: "d402",
        availability: "live" as const,
        params: {},
      },
      expectedPhase: "pay-d402",
      options: {
        demosRpc: "https://demos.example",
        demosSecret: "secret",
        allowExperimentalRails: true,
        payment: {
          url: "https://seller.example/pay",
          network: "demos",
          recipient: "bb".repeat(32),
        },
      },
      create: mocks.createPayD402Rail,
      bridge: mocks.payD402Settle,
    },
  ])("binds $label requests to exact descriptor id and phase", async ({
    descriptor,
    expectedPhase,
    options,
    create,
    bridge,
  }) => {
    const executor = vi.fn(async () => ({ ok: true }));
    create.mockResolvedValue({});
    bridge.mockReturnValue(executor);
    const dispatched = await settleFromRail(descriptor, options);
    const valid = request({ rail: descriptor.id, phase: expectedPhase });

    await expect(dispatched(valid)).resolves.toEqual({ ok: true });
    await expect(dispatched({ ...valid, rail: `${descriptor.id}:other` }))
      .rejects.toThrow(/does not match authenticated descriptor/);
    const wrongPhase = expectedPhase === "pay-dem" ? "pay-x402" : "pay-dem";
    await expect(dispatched({ ...valid, phase: wrongPhase }))
      .rejects.toThrow(/does not match descriptor kind/);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  test("passes the same rail and phase values that the descriptor gate checked", async () => {
    const executor = vi.fn(async () => ({ ok: true }));
    mocks.createPayDemRail.mockResolvedValue({});
    mocks.payDemSettle.mockReturnValue(executor);
    const changing = request();
    let railReads = 0;
    let phaseReads = 0;
    Object.defineProperty(changing, "rail", {
      enumerable: true,
      get: () => railReads++ === 0 ? DESCRIPTOR.id : "demos-native:OTHER",
    });
    Object.defineProperty(changing, "phase", {
      enumerable: true,
      get: () => phaseReads++ === 0 ? "pay-dem" : "pay-x402",
    });
    const dispatched = await settleFromRail(DESCRIPTOR, {
      demosRpc: "https://demos.example",
      demosSecret: "test-secret",
      payment: { phaseIndex: 4 },
    });

    await expect(dispatched(changing)).resolves.toEqual({ ok: true });
    expect(executor).toHaveBeenCalledWith(expect.objectContaining({
      rail: DESCRIPTOR.id,
      phase: "pay-dem",
    }));
  });
});
