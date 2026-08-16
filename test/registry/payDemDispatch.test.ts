import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createPayDemRail: vi.fn(),
  payDemSettle: vi.fn(),
  createX402Rail: vi.fn(),
  x402Settle: vi.fn(),
  createEvmErc20Rail: vi.fn(),
  evmErc20Settle: vi.fn(),
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

import type { SettlementIdempotencyStore } from "../../src/rails/idempotency.js";
import { signComponentArtifact } from "../../src/artifacts/signatures.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";
import {
  settleFromRail,
  type RailDispatchOptions,
} from "../../src/registry/dispatch.js";
import {
  resolveRail,
  type AuthenticatedRailDefinition,
  type RegistryResolveDeps,
} from "../../src/registry/index.js";
import type { RailDefinition } from "../../src/registry/types.js";

const STEWARD_SEED = Uint8Array.from(Buffer.alloc(32, 42));
const stewardPrivateKey = privateKeyFromSeed(STEWARD_SEED);
const stewardPublicKey = rawPublicKey(publicKeyFromSeed(STEWARD_SEED));
const stewardSigner = `did:demos:steward:${Buffer.from(stewardPublicKey).toString("hex")}`;
const DEM_RAIL_ID = "demos-native:DEM";

type UnsignedRailDefinition = Omit<RailDefinition, "signature">;

function demDefinition(
  over: Partial<UnsignedRailDefinition> = {},
): UnsignedRailDefinition {
  return {
    railVersion: 1,
    railId: DEM_RAIL_ID,
    railType: "demos-native",
    asset: { kind: "native-dem", symbol: "DEM", decimals: 9 },
    network: { kind: "demos" },
    phaseHandler: "pay-dem",
    parameters: {},
    availability: "live",
    governance: {
      proposedBy: stewardSigner,
      acceptedAt: 1_780_000_000_000,
      anchoring: "single-signer",
    },
    ...over,
  };
}

function x402Definition(): UnsignedRailDefinition {
  return {
    railVersion: 1,
    railId: "x402:default",
    railType: "x402",
    asset: {
      kind: "erc20",
      chainId: 84532,
      contract: "0x1111111111111111111111111111111111111111",
      symbol: "USDC",
      decimals: 6,
    },
    network: {
      kind: "x402-resource",
      resourceBaseUrl: "https://seller.example",
    },
    phaseHandler: "pay-x402",
    parameters: { authorization: "eip-3009" },
    availability: "live",
    governance: demDefinition().governance,
  };
}

function evmDefinition(): UnsignedRailDefinition {
  return {
    railVersion: 1,
    railId: "evm-erc20:84532:USDC",
    railType: "evm-erc20",
    asset: {
      kind: "erc20",
      chainId: 84532,
      contract: "0x1111111111111111111111111111111111111111",
      symbol: "USDC",
      decimals: 6,
    },
    network: {
      kind: "evm",
      chainId: 84532,
      rpcAttestation: "evm-rpc",
    },
    phaseHandler: "pay-evm-erc20",
    parameters: { finalityBlocks: 1 },
    availability: "live",
    governance: demDefinition().governance,
  };
}

async function authenticatedDefinition(
  definition: UnsignedRailDefinition = demDefinition(),
): Promise<AuthenticatedRailDefinition> {
  const entry = await signComponentArtifact(definition, "dacs-rail:v1:", {
    algorithm: "ed25519",
    signer: stewardSigner,
    sign: (bytes) => ed25519Sign(bytes, stewardPrivateKey),
  });
  const deps: RegistryResolveDeps = {
    readRegistry: async () => ({ entries: [entry] }),
    stewardPublicKey,
    stewardSigner,
    verify: (bytes, signature, publicKey) =>
      ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
  };
  return resolveRail("dacs4:registry:v0.1", {
    railId: definition.railId,
    railVersion: definition.railVersion,
  }, deps);
}

const request = (over: Record<string, unknown> = {}) => ({
  rail: DEM_RAIL_ID,
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
    const descriptor = await authenticatedDefinition();

    const result = await settleFromRail(descriptor, {
      demosRpc: "https://demos.example",
      demosSecret: "test-secret",
      payment: {
        network: "demos",
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
      network: "demos",
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
        network: "demos",
        railId: DEM_RAIL_ID,
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
    const descriptor = await authenticatedDefinition();

    const dispatched = await settleFromRail(descriptor, {
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
      { network: "demos", railId: DEM_RAIL_ID },
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
      payment: { network: "demos", recipient: "aa".repeat(32) },
      payDem: {
        maxTotalDebitOs: 10n,
        settlementStore: firstStore,
        reconcile: firstReconcile,
      },
    };

    const descriptor = await authenticatedDefinition();
    const pending = settleFromRail(descriptor, options);
    options.payDem!.maxTotalDebitOs = 20n;
    options.payDem!.settlementStore = secondStore;
    options.payDem!.reconcile = secondReconcile;
    options.demosRpc = "https://attacker.example";
    options.demosSecret = "mutated-secret";
    options.payment!.network = "mutated";
    options.payment!.recipient = "bb".repeat(32);
    const rail = { address: "cc".repeat(32), settle: vi.fn() };
    finishConnect(rail);
    await pending;

    expect(mocks.createPayDemRail).toHaveBeenCalledWith(expect.objectContaining({
      rpc: "https://demos.example",
      secret: "test-secret",
      maxTotalDebitOs: 10n,
      network: "demos",
    }));
    expect(mocks.payDemSettle).toHaveBeenCalledWith(
      rail,
      {
        network: "demos",
        recipient: "aa".repeat(32),
        railId: DEM_RAIL_ID,
      },
      { store: firstStore, reconcile: firstReconcile },
    );
  });

  test("requires resolver provenance and freezes the authenticated definition", async () => {
    const descriptor = await authenticatedDefinition();
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.asset)).toBe(true);
    expect(() => {
      (descriptor as { railId: string }).railId = "demos-native:MUTATED";
    }).toThrow(TypeError);
    await expect(settleFromRail(structuredClone(descriptor) as never, {
      demosRpc: "https://demos.example",
      demosSecret: "test-secret",
    })).rejects.toThrow(/resolveRail \(RAV-R5\)/);
  });

  test.each([
    ["wrong descriptor", { rail: "demos-native:OTHER" }, /does not match authenticated definition/],
    ["wrong phase", { phase: "pay-x402" }, /does not match definition railType/],
  ])("rejects a %s before invoking the rail", async (_label, override, pattern) => {
    const rail = { address: "aa".repeat(32), settle: vi.fn() };
    const executor = vi.fn();
    mocks.createPayDemRail.mockResolvedValue(rail);
    mocks.payDemSettle.mockReturnValue(executor);
    const descriptor = await authenticatedDefinition();
    const dispatched = await settleFromRail(descriptor, {
      demosRpc: "https://demos.example",
      demosSecret: "test-secret",
      payment: { phaseIndex: 4 },
    });

    await expect(dispatched(request(override))).rejects.toThrow(pattern);
    expect(executor).not.toHaveBeenCalled();
  });

  test.each(["disabled", "failed"] as const)(
    "RAV-R2 refuses availability %s before constructing a rail",
    async (availability) => {
      const descriptor = await authenticatedDefinition(demDefinition({
        availability,
      }));
      await expect(settleFromRail(descriptor, {
        demosRpc: "https://demos.example",
        demosSecret: "test-secret",
      })).rejects.toThrow(/RAV-R2 forbids/);
      expect(mocks.createPayDemRail).not.toHaveBeenCalled();
      expect(mocks.payDemSettle).not.toHaveBeenCalled();
    },
  );

  test.each(["operator_gated", "closed_data", "bilateral"] as const)(
    "RAV-R3 requires and accepts trusted local preflight for %s",
    async (availability) => {
      const rail = { address: "aa".repeat(32), settle: vi.fn() };
      mocks.createPayDemRail.mockResolvedValue(rail);
      mocks.payDemSettle.mockReturnValue(vi.fn());
      const descriptor = await authenticatedDefinition(demDefinition({
        availability,
      }));

      await expect(settleFromRail(descriptor, {
        demosRpc: "https://demos.example",
        demosSecret: "test-secret",
      })).rejects.toThrow(/trusted local RAV-R3 preflight/);

      const authorize = vi.fn(async () => true);
      await expect(settleFromRail(descriptor, {
        demosRpc: "https://demos.example",
        demosSecret: "test-secret",
        availabilityPolicy: { environment: "production", authorize },
      })).resolves.toEqual(expect.any(Function));
      expect(authorize).toHaveBeenCalledWith({
        railId: DEM_RAIL_ID,
        railVersion: 1,
        railType: "demos-native",
        availability,
      });
    },
  );

  test("mocked rails require an approving non-production policy", async () => {
    const rail = { address: "aa".repeat(32), settle: vi.fn() };
    mocks.createPayDemRail.mockResolvedValue(rail);
    mocks.payDemSettle.mockReturnValue(vi.fn());
    const descriptor = await authenticatedDefinition(demDefinition({
      availability: "mocked",
    }));

    await expect(settleFromRail(descriptor, {
      demosRpc: "https://demos.example",
      demosSecret: "test-secret",
      availabilityPolicy: {
        environment: "production",
        authorize: async () => true,
      },
    })).rejects.toThrow(/forbidden in production/);
    await expect(settleFromRail(descriptor, {
      demosRpc: "https://demos.example",
      demosSecret: "test-secret",
      availabilityPolicy: {
        environment: "non-production",
        authorize: async () => false,
      },
    })).rejects.toThrow(/did not authorize/);
    await expect(settleFromRail(descriptor, {
      demosRpc: "https://demos.example",
      demosSecret: "test-secret",
      availabilityPolicy: {
        environment: "non-production",
        authorize: async () => true,
      },
    })).resolves.toEqual(expect.any(Function));
  });

  test.each([
    {
      label: "pay-dem",
      definition: demDefinition,
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
      definition: x402Definition,
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
      definition: evmDefinition,
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
  ])("binds $label requests to exact definition id and phase", async ({
    definition,
    expectedPhase,
    options,
    create,
    bridge,
  }) => {
    const executor = vi.fn(async () => ({ ok: true }));
    create.mockResolvedValue({});
    bridge.mockReturnValue(executor);
    const descriptor = await authenticatedDefinition(definition());
    const dispatched = await settleFromRail(descriptor, options);
    const valid = request({ rail: descriptor.railId, phase: expectedPhase });

    await expect(dispatched(valid)).resolves.toEqual({ ok: true });
    await expect(dispatched({ ...valid, rail: `${descriptor.railId}:other` }))
      .rejects.toThrow(/does not match authenticated definition/);
    const wrongPhase = expectedPhase === "pay-dem" ? "pay-x402" : "pay-dem";
    await expect(dispatched({ ...valid, phase: wrongPhase }))
      .rejects.toThrow(/does not match definition railType/);
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
      get: () => railReads++ === 0 ? DEM_RAIL_ID : "demos-native:OTHER",
    });
    Object.defineProperty(changing, "phase", {
      enumerable: true,
      get: () => phaseReads++ === 0 ? "pay-dem" : "pay-x402",
    });
    const descriptor = await authenticatedDefinition();
    const dispatched = await settleFromRail(descriptor, {
      demosRpc: "https://demos.example",
      demosSecret: "test-secret",
      payment: { phaseIndex: 4 },
    });

    await expect(dispatched(changing)).resolves.toEqual({ ok: true });
    expect(executor).toHaveBeenCalledWith(expect.objectContaining({
      rail: DEM_RAIL_ID,
      phase: "pay-dem",
    }));
  });
});
