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
import type { AnchorReceipt } from "../../src/artifacts/types.js";
import { contentHash } from "../../src/canonical/index.js";
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
  RAIL_REGISTRY_INDEX_ADDRESS,
  resolveRail,
  type AuthenticatedRailDefinition,
  type RailRegistryDefinitionRef,
  type RailRegistryIndexDocument,
  type RailRegistrySelectionProvider,
} from "../../src/registry/index.js";
import type { RailDefinition } from "../../src/registry/types.js";

const STEWARD_SEED = Uint8Array.from(Buffer.alloc(32, 42));
const stewardPrivateKey = privateKeyFromSeed(STEWARD_SEED);
const stewardPublicKey = rawPublicKey(publicKeyFromSeed(STEWARD_SEED));
const stewardSigner = `did:demos:agent:${Buffer.from(stewardPublicKey).toString("hex")}`;
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
    parameters: { authorization: "eip-3009", finalityBlocks: 1 },
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
  const definitionRef: RailRegistryDefinitionRef = {
    logicalAddress: `dacs4:rail:${definition.railId}:${definition.railVersion}`,
    anchor: { kind: "storage-program", locator: `rail:${definition.railId}` },
    contentHash: contentHash(entry as unknown as Record<string, unknown>),
  };
  const index: RailRegistryIndexDocument = {
    registryId: RAIL_REGISTRY_INDEX_ADDRESS,
    entries: [definitionRef],
  };
  const indexRef: RailRegistryDefinitionRef = {
    logicalAddress: RAIL_REGISTRY_INDEX_ADDRESS,
    anchor: { kind: "storage-program", locator: "rail:index:7" },
    contentHash: contentHash(index as unknown as Record<string, unknown>),
  };
  const receipt: AnchorReceipt = {
    receiptVersion: "1",
    substrate: "test-substrate",
    finalityProfile: "instant-finality",
    logicalAddress: RAIL_REGISTRY_INDEX_ADDRESS,
    nativeAddress: indexRef.anchor.locator,
    contentHash: indexRef.contentHash,
    transactionRef: { kind: "test", value: `tx:${indexRef.contentHash}` },
    writer: stewardSigner,
    state: "finalized",
    observationDisposition: "established",
    observedAt: 1_780_000_100_000,
    blockRef: { id: "block:7", height: "7" },
    evidence: { kind: "test-proof", value: `proof:${indexRef.contentHash}` },
  };
  const definitionReceipt: AnchorReceipt = {
    ...receipt,
    logicalAddress: definitionRef.logicalAddress,
    nativeAddress: definitionRef.anchor.locator,
    contentHash: definitionRef.contentHash,
    transactionRef: { kind: "test", value: `tx:${definitionRef.contentHash}` },
    evidence: { kind: "test-proof", value: `proof:${definitionRef.contentHash}` },
  };
  const deps: RailRegistrySelectionProvider = {
    resolveCurrentIndex: async () => ({
      registryVersion: 7,
      indexRef,
      receipt,
    }),
    authenticateCurrentIndex: () => "valid",
    readAnchoredJson: async (ref) => {
      if (ref.anchor.locator === indexRef.anchor.locator) {
        return index as unknown as Record<string, unknown>;
      }
      return ref.anchor.locator === definitionRef.anchor.locator
        ? entry as unknown as Record<string, unknown>
        : null;
    },
    resolveDefinitionReceipt: async (ref) =>
      ref.anchor.locator === definitionRef.anchor.locator
        ? definitionReceipt
        : null,
    authenticateDefinition: () => "valid",
    stewardWriter: stewardSigner,
    stewardPublicKey,
    stewardSigner,
    verify: (bytes, signature, publicKey) =>
      ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
  };
  return resolveRail(RAIL_REGISTRY_INDEX_ADDRESS, {
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
      journalPreparedTransfer: expect.any(Function),
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
      {
        store: expect.objectContaining({ once: expect.any(Function) }),
        reconcile: expect.any(Function),
      },
    );
    const capturedRailConfig = mocks.createPayDemRail.mock.calls[0]![0];
    expect(capturedRailConfig.journalPreparedTransfer)
      .not.toBe(journalPreparedTransfer);
    await capturedRailConfig.journalPreparedTransfer({} as never);
    expect(journalPreparedTransfer).toHaveBeenCalledTimes(1);
    const capturedRecovery = mocks.payDemSettle.mock.calls[0]![2];
    expect(capturedRecovery.store).not.toBe(settlementStore);
    expect(Object.isFrozen(capturedRecovery.store)).toBe(true);
    expect(capturedRecovery.reconcile).not.toBe(reconcile);
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
    class ReceiverStore implements SettlementIdempotencyStore {
      readonly calls: string[] = [];
      async once(
        key: string,
        submit: () => Promise<Awaited<ReturnType<SettlementIdempotencyStore["once"]>>>,
      ) {
        this.calls.push(key);
        return submit();
      }
    }
    const firstStore = new ReceiverStore();
    const secondStore: SettlementIdempotencyStore = { once: vi.fn() };
    const firstJournal = vi.fn(async () => undefined);
    const secondJournal = vi.fn(async () => undefined);
    const firstReconcile = vi.fn(async () => null);
    const secondReconcile = vi.fn(async () => null);
    const options: RailDispatchOptions = {
      demosRpc: "https://demos.example",
      demosSecret: "test-secret",
      payment: { network: "demos", recipient: "aa".repeat(32) },
      payDem: {
        maxTotalDebitOs: 10n,
        journalPreparedTransfer: firstJournal,
        settlementStore: firstStore,
        reconcile: firstReconcile,
      },
    };

    const descriptor = await authenticatedDefinition();
    const pending = settleFromRail(descriptor, options);
    firstStore.once = vi.fn(async () => ({
      ok: false,
      rail: DEM_RAIL_ID,
      txHash: "mutated",
      amount: "1",
      asset: "DEM",
      chainId: "demos",
      payer: "cc".repeat(32),
      payee: "aa".repeat(32),
      settlementFinality: "bft-final" as const,
    }));
    options.payDem!.maxTotalDebitOs = 20n;
    options.payDem!.journalPreparedTransfer = secondJournal;
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
      journalPreparedTransfer: expect.any(Function),
      network: "demos",
    }));
    expect(mocks.payDemSettle).toHaveBeenCalledWith(
      rail,
      {
        network: "demos",
        recipient: "aa".repeat(32),
        railId: DEM_RAIL_ID,
      },
      {
        store: expect.objectContaining({ once: expect.any(Function) }),
        reconcile: expect.any(Function),
      },
    );
    const capturedRecovery = mocks.payDemSettle.mock.calls[0]![2];
    const capturedRailConfig = mocks.createPayDemRail.mock.calls[0]![0];
    await capturedRailConfig.journalPreparedTransfer({} as never);
    expect(firstJournal).toHaveBeenCalledTimes(1);
    expect(secondJournal).not.toHaveBeenCalled();
    const submitted = {
      ok: true,
      rail: DEM_RAIL_ID,
      txHash: "tx-original",
      amount: "1",
      asset: "DEM",
      chainId: "demos",
      payer: "cc".repeat(32),
      payee: "aa".repeat(32),
      settlementFinality: "bft-final" as const,
    };
    await expect(capturedRecovery.store!.once(
      "demos-native:DEM:job-1:4",
      async () => submitted,
    )).resolves.toEqual(submitted);
    expect(firstStore.calls).toEqual(["demos-native:DEM:job-1:4"]);
    expect(secondStore.once).not.toHaveBeenCalled();
    await capturedRecovery.reconcile!({} as never);
    expect(firstReconcile).toHaveBeenCalledTimes(1);
    expect(secondReconcile).not.toHaveBeenCalled();
  });

  test("ignores a poisoned method bind while preserving the store receiver", async () => {
    class ReceiverStore implements SettlementIdempotencyStore {
      readonly keys: string[] = [];
      async once(
        key: string,
        submit: Parameters<SettlementIdempotencyStore["once"]>[1],
      ) {
        this.keys.push(key);
        return submit();
      }
    }
    const store = new ReceiverStore();
    const poison = vi.fn(() => vi.fn(async () => {
      throw new Error("poisoned bind callback executed");
    }));
    Object.defineProperty(store.once, "bind", {
      configurable: true,
      value: poison,
    });
    mocks.createPayDemRail.mockResolvedValue({});
    mocks.payDemSettle.mockReturnValue(vi.fn());
    const descriptor = await authenticatedDefinition();

    await settleFromRail(descriptor, {
      demosRpc: "https://demos.example",
      demosSecret: "test-secret",
      payDem: { settlementStore: store },
    });
    const captured = mocks.payDemSettle.mock.calls[0]![2].store!;
    const outcome = {
      ok: true,
      rail: DEM_RAIL_ID,
      txHash: "tx-safe-bind",
      amount: "1",
      asset: "DEM",
      chainId: "demos",
      payer: "cc".repeat(32),
      payee: "aa".repeat(32),
      settlementFinality: "bft-final" as const,
    };
    await expect(captured.once("rail:job:4", async () => outcome))
      .resolves.toEqual(outcome);
    expect(poison).not.toHaveBeenCalled();
    expect(store.keys).toEqual(["rail:job:4"]);
  });

  test("retains a class store receiver across restart-style dispatch reconstruction", async () => {
    class DurableClassStore implements SettlementIdempotencyStore {
      readonly keys: string[] = [];
      readonly #outcomes = new Map<string, Awaited<ReturnType<
        SettlementIdempotencyStore["once"]
      >>>();

      async once(
        key: string,
        submit: Parameters<SettlementIdempotencyStore["once"]>[1],
      ) {
        this.keys.push(key);
        const retained = this.#outcomes.get(key);
        if (retained !== undefined) return retained;
        const result = await submit();
        this.#outcomes.set(key, result);
        return result;
      }
    }
    const store = new DurableClassStore();
    mocks.createPayDemRail.mockResolvedValue({});
    mocks.payDemSettle.mockReturnValue(vi.fn());
    const descriptor = await authenticatedDefinition();
    const options: RailDispatchOptions = {
      demosRpc: "https://demos.example",
      demosSecret: "test-secret",
      payDem: { settlementStore: store },
    };
    await settleFromRail(descriptor, options);
    await settleFromRail(descriptor, options);
    const firstStore = mocks.payDemSettle.mock.calls[0]![2].store!;
    const restartedStore = mocks.payDemSettle.mock.calls[1]![2].store!;
    const result = {
      ok: true,
      rail: DEM_RAIL_ID,
      txHash: "tx-retained",
      amount: "1",
      asset: "DEM",
      chainId: "demos",
      payer: "cc".repeat(32),
      payee: "aa".repeat(32),
      settlementFinality: "bft-final" as const,
    };
    const firstSubmit = vi.fn(async () => result);
    const forbiddenResubmit = vi.fn(async () => ({ ...result, txHash: "tx-2" }));

    await expect(firstStore.once("rail:job:4", firstSubmit)).resolves.toEqual(result);
    await expect(restartedStore.once("rail:job:4", forbiddenResubmit))
      .resolves.toEqual(result);
    expect(firstSubmit).toHaveBeenCalledTimes(1);
    expect(forbiddenResubmit).not.toHaveBeenCalled();
    expect(store.keys).toEqual(["rail:job:4", "rail:job:4"]);
  });

  test("rejects an accessor-backed store without invoking it or loading a rail", async () => {
    const once = vi.fn();
    const getter = vi.fn(() => once);
    const store = {} as SettlementIdempotencyStore;
    Object.defineProperty(store, "once", {
      enumerable: true,
      get: getter,
    });
    const descriptor = await authenticatedDefinition();

    await expect(settleFromRail(descriptor, {
      demosRpc: "https://demos.example",
      demosSecret: "test-secret",
      payDem: { settlementStore: store },
    })).rejects.toThrow(/settlement store once must be stable data/);
    expect(getter).not.toHaveBeenCalled();
    expect(mocks.createPayDemRail).not.toHaveBeenCalled();
  });

  test("rejects accessor-backed payment authority without invoking caller code", async () => {
    const descriptor = await authenticatedDefinition();
    const urlGetter = vi.fn(() => "https://attacker.example/pay");
    const payment = {
      network: "demos",
      recipient: "aa".repeat(32),
    } as RailDispatchOptions["payment"] & { url?: string };
    Object.defineProperty(payment, "url", {
      enumerable: true,
      get: urlGetter,
    });

    await expect(settleFromRail(descriptor, {
      demosRpc: "https://demos.example",
      demosSecret: "test-secret",
      payment,
    })).rejects.toThrow(/rail payment url must be stable data/);
    expect(urlGetter).not.toHaveBeenCalled();
    expect(mocks.createPayDemRail).not.toHaveBeenCalled();
  });

  test("rejects accessor-backed credentials and limits without invoking them", async () => {
    const descriptor = await authenticatedDefinition();
    const secretGetter = vi.fn(() => "attacker-secret");
    const options = {
      demosRpc: "https://demos.example",
      payDem: {},
    } as RailDispatchOptions;
    Object.defineProperty(options, "demosSecret", {
      enumerable: true,
      get: secretGetter,
    });
    await expect(settleFromRail(descriptor, options))
      .rejects.toThrow(/Demos wallet secret must be stable data/);
    expect(secretGetter).not.toHaveBeenCalled();

    const debitGetter = vi.fn(() => 1n);
    const payDem = {} as NonNullable<RailDispatchOptions["payDem"]>;
    Object.defineProperty(payDem, "maxTotalDebitOs", {
      enumerable: true,
      get: debitGetter,
    });
    await expect(settleFromRail(descriptor, {
      demosRpc: "https://demos.example",
      demosSecret: "test-secret",
      payDem,
    })).rejects.toThrow(/maximum total debit must be stable data/);
    expect(debitGetter).not.toHaveBeenCalled();
    expect(mocks.createPayDemRail).not.toHaveBeenCalled();
  });

  test("rejects proxy dispatch options without invoking proxy traps", async () => {
    const descriptor = await authenticatedDefinition();
    const get = vi.fn(Reflect.get);
    const options = new Proxy<RailDispatchOptions>({
      demosRpc: "https://demos.example",
      demosSecret: "test-secret",
    }, { get });

    await expect(settleFromRail(descriptor, options))
      .rejects.toThrow(/rail availability policy must be stable data/);
    expect(get).not.toHaveBeenCalled();
    expect(mocks.createPayDemRail).not.toHaveBeenCalled();
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

  test("captures x402 fetch before the first dispatch await", async () => {
    const firstFetch = vi.fn(async () => new Response("first")) as unknown as typeof fetch;
    const secondFetch = vi.fn(async () => new Response("second")) as unknown as typeof fetch;
    mocks.createX402Rail.mockResolvedValue({});
    mocks.x402Settle.mockReturnValue(vi.fn());
    const descriptor = await authenticatedDefinition(x402Definition());
    const options: RailDispatchOptions = {
      evmPrivateKey: "0x" + "11".repeat(32),
      payment: {
        url: "https://seller.example/pay",
        network: "eip155:84532",
        recipient: "0x2222222222222222222222222222222222222222",
      },
      rpcUrl: "https://rpc.example",
      fetchImpl: firstFetch,
    };

    const pending = settleFromRail(descriptor, options);
    options.fetchImpl = secondFetch;
    await pending;
    const capturedFetch = mocks.createX402Rail.mock.calls[0]![0].fetchImpl!;
    await capturedFetch("https://seller.example/pay");
    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(secondFetch).not.toHaveBeenCalled();
  });

  test("captures the availability authority before awaiting its decision", async () => {
    let decide!: (approved: boolean) => void;
    const firstAuthorize = vi.fn(() => new Promise<boolean>((resolve) => {
      decide = resolve;
    }));
    const secondAuthorize = vi.fn(async () => false);
    mocks.createPayDemRail.mockResolvedValue({});
    mocks.payDemSettle.mockReturnValue(vi.fn());
    const descriptor = await authenticatedDefinition(demDefinition({
      availability: "operator_gated",
    }));
    const options: RailDispatchOptions = {
      demosRpc: "https://demos.example",
      demosSecret: "test-secret",
      availabilityPolicy: {
        environment: "production",
        authorize: firstAuthorize,
      },
    };

    const pending = settleFromRail(descriptor, options);
    options.availabilityPolicy!.authorize = secondAuthorize;
    decide(true);
    await expect(pending).resolves.toEqual(expect.any(Function));
    expect(firstAuthorize).toHaveBeenCalledTimes(1);
    expect(secondAuthorize).not.toHaveBeenCalled();
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
        rpcUrl: "https://rpc.example",
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
