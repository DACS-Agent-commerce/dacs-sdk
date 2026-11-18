import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
} from "@kynesyslabs/dacs/crypto";
import { demosAgentClaimRef } from "@kynesyslabs/dacs/identity";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DACS_NODE_LIVE_PROFILE,
  createDacsLiveRoleRuntimeV1,
  createDacsRoleServiceDoctorProbesV1,
  runDacsLiveDoctorV1,
  DacsHttpTransportError,
  DacsTransportDiagnosticError,
  runDacsRoleTransportDiagnosticV1,
  type DacsDemosAdapterV1,
} from "../src/index.js";
import * as secretLoader from "../src/secrets.js";

const SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const PEER_SEED = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const PRIVATE_KEY = privateKeyFromSeed(SEED);
const PEER_PRIVATE_KEY = privateKeyFromSeed(PEER_SEED);
const PUBLIC_KEY = rawPublicKey(publicKeyFromSeed(SEED));
const PEER_PUBLIC_KEY = rawPublicKey(publicKeyFromSeed(PEER_SEED));
const AUTHORITY = demosAgentClaimRef(PUBLIC_KEY);
const PEER_AUTHORITY = demosAgentClaimRef(PEER_PUBLIC_KEY);
const EVM_PRIVATE_KEY = `0x${"33".repeat(32)}`;

describe("complete role-owned live runtime", () => {
  const roots: string[] = [];

  function root(): string {
    const directory = mkdtempSync(join(tmpdir(), "dacs-role-runtime-"));
    roots.push(directory);
    return directory;
  }

  function config(directory: string, role: "buyer" | "seller" = "buyer") {
    return {
      mode: "live-demos" as const,
      profile: DACS_NODE_LIVE_PROFILE,
      role,
      dataDirectory: directory,
      demos: { rpcUrl: "http://127.0.0.1:5350" },
      rail: {
        registryIndexRef: "dacs4:registry:v0.1",
        requestedNetwork: "eip155:84532",
      },
      limits: {
        maxServiceAmount: { asset: "USDC", amount: "1" },
        maxSetupSpendDem: "10",
        maxDemosNetworkFeeDem: "2",
        maxEvmNetworkFeeEth: "0.001",
      },
    };
  }

  function payDemConfig(directory: string, role: "buyer" | "seller" = "buyer") {
    const value = config(directory, role);
    return {
      ...value,
      rail: {
        ...value.rail,
        requestedNetwork: "demos",
        enabledProfiles: ["pay-dem"] as const,
      },
      limits: {
        ...value.limits,
        maxServiceAmount: { asset: "DEM", amount: "1" },
        maxEvmNetworkFeeEth: "0",
      },
    };
  }

  function bothConfig(directory: string, role: "buyer" | "seller" = "buyer") {
    const value = config(directory, role);
    return {
      ...value,
      rail: {
        ...value.rail,
        enabledProfiles: ["pay-dem", "x402"] as const,
      },
    };
  }

  function buyerOperations() {
    const pending = vi.fn(async () => ({
      status: "pending-retry" as const,
      reasonCode: "fixture-pending",
      retryAt: 1,
    }));
    return Object.freeze({
      agreement: pending,
      payment: pending,
      "payment-evidence": pending,
      "buyer-received": pending,
      audit: pending,
    });
  }

  function adapter(
    publicKey = PUBLIC_KEY,
    privateKey = PRIVATE_KEY,
  ): DacsDemosAdapterV1 {
    return {
      raw: {
        getNetworkInfo: vi.fn(async () => ({ chain: "test" })),
        getAddressNonce: vi.fn(async () => 1),
        getAddressInfo: vi.fn(async () => ({ balance: "10" })),
      },
      connect: vi.fn(async () => undefined),
      getChainIdentity: vi.fn(async () => "test-chain"),
      getAddress: vi.fn(() => "0xactor"),
      getPublicKey: vi.fn(async () => Uint8Array.from(publicKey)),
      sign: vi.fn(async (bytes) => ed25519Sign(bytes, privateKey)),
      resolveIdentity: vi.fn(async (ref) => ({ ref, boundTo: ref, raw: { fixture: true } })),
      readAnchor: vi.fn(async () => null),
      resolveAnchorByName: vi.fn(async () => ({ status: "absent" as const })),
      scanOwnAnchorsByNamePrefix: vi.fn(async () => ({ status: "ok" as const, anchors: [] })),
      anchorWriteOnce: vi.fn(async () => ({ address: "stor:test" })),
      verifyDemosAnchorReceipt: vi.fn(async () => true),
      resolveDemosAnchorReceipt: vi.fn(async () => null),
      reconcileWalletJournal: vi.fn(async () => undefined),
      reconcileNativeTransferJournal: vi.fn(async () => undefined),
    };
  }

  afterEach(() => {
    for (const directory of roots.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("awaits one complete async commerce graph before creating the role service", async () => {
    const directory = root();
    const secretPath = join(directory, "demos.secret");
    const evmSecretPath = join(directory, "evm.secret");
    writeFileSync(secretPath, "test-only-secret\n", { mode: 0o600 });
    writeFileSync(evmSecretPath, `${EVM_PRIVATE_KEY}\n`, { mode: 0o600 });
    const graphContexts: unknown[] = [];
    const pending = vi.fn(async () => ({
      status: "pending-retry" as const,
      reasonCode: "fixture-pending",
      retryAt: 1,
    }));
    const validatePayload = vi.fn(() => Object.freeze({ status: "valid" as const }));
    const handleMessage = vi.fn(() => Object.freeze({ disposition: "accepted" as const }));
    const runtime = await createDacsLiveRoleRuntimeV1({
      config: config(directory),
      role: "buyer",
      authority: AUTHORITY,
      peerAuthority: PEER_AUTHORITY,
      peerEndpoint: "http://127.0.0.1:39999/dacs-transport/v1/messages",
      workerId: "buyer-graph-worker",
      demosIdentityFilePath: secretPath,
      evmPrivateKeyFilePath: evmSecretPath,
      evmRpcUrl: "http://127.0.0.1:8545",
      createDemosAdapter: async () => adapter(),
      async createCommerceGraph(context) {
        await Promise.resolve();
        graphContexts.push(context);
        return Object.freeze({
          role: "buyer" as const,
          availability: Object.freeze({ status: "configured" as const }),
          operations: Object.freeze({
            agreement: pending,
            payment: pending,
            "payment-evidence": pending,
            "buyer-received": pending,
            audit: pending,
          }),
          router: Object.freeze({}),
          validatePayload,
          handleMessage,
        }) as never;
      },
      server: { hostname: "127.0.0.1", port: 0 },
    });
    expect(graphContexts).toHaveLength(1);
    expect(graphContexts[0]).toMatchObject({
      role: "buyer",
      authority: AUTHORITY,
      peerAuthority: PEER_AUTHORITY,
      database: runtime.database,
      demos: runtime.demos,
    });
    expect(typeof (graphContexts[0] as { sendMessage?: unknown }).sendMessage).toBe("function");
    await runtime.start();
    await runtime.stop();
  });

  it("rejects an unknown buyer EVM finality tag before opening authority", async () => {
    const directory = root();
    await expect(createDacsLiveRoleRuntimeV1({
      config: config(directory),
      role: "buyer",
      authority: AUTHORITY,
      peerAuthority: PEER_AUTHORITY,
      peerEndpoint: "http://127.0.0.1:39999/dacs-transport/v1/messages",
      workerId: "buyer-invalid-finality-worker",
      demosIdentityFilePath: join(directory, "missing-demos.secret"),
      evmPrivateKeyFilePath: join(directory, "missing-evm.secret"),
      evmRpcUrl: "http://127.0.0.1:8545",
      evmFinalityTag: "optimistic" as never,
      createDemosAdapter: async () => adapter(),
      createOperations: () => Object.freeze({}),
      validatePayload: () => Object.freeze({ status: "valid" as const }),
      handleMessage: () => Object.freeze({ disposition: "accepted" as const }),
    })).rejects.toBeInstanceOf(TypeError);
  });

  it("opens a native DEM role without an EVM key, RPC, or x402 store", async () => {
    const directory = root();
    const secretPath = join(directory, "demos.secret");
    writeFileSync(secretPath, "test-only-secret\n", { mode: 0o600 });
    const runtime = await createDacsLiveRoleRuntimeV1({
      config: payDemConfig(directory),
      role: "buyer",
      authority: AUTHORITY,
      peerAuthority: PEER_AUTHORITY,
      peerEndpoint: "http://127.0.0.1:39999/dacs-transport/v1/messages",
      workerId: "buyer-pay-dem-worker",
      demosIdentityFilePath: secretPath,
      createDemosAdapter: async () => ({
        ...adapter(),
        getAddress: vi.fn(() => Buffer.from(PUBLIC_KEY).toString("hex")),
      }),
      createPayDemRail: async () => ({
        address: Buffer.from(PUBLIC_KEY).toString("hex"),
        settle: vi.fn(),
      }),
      createPayDemOperations: () => Object.freeze({}),
      validatePayload: () => Object.freeze({ status: "valid" as const }),
      handleMessage: () => Object.freeze({ disposition: "accepted" as const }),
      server: { hostname: "127.0.0.1", port: 0 },
    });
    try {
      expect(runtime.evm).toBeUndefined();
      expect(runtime.demos.payDem?.rail.address).toBe(
        Buffer.from(PUBLIC_KEY).toString("hex"),
      );
      expect(runtime.service.coordinator.profiles).toEqual(["pay-dem"]);
      expect(runtime.commerceStores).toEqual({ role: "buyer" });
      await runtime.start();
      expect(runtime.service.endpoint).toEqual(expect.any(String));
    } finally {
      await runtime.stop();
    }
  });

  it("admits a role-closed native DEM commerce graph", async () => {
    const directory = root();
    const secretPath = join(directory, "demos.secret");
    const wallet = Buffer.from(PUBLIC_KEY).toString("hex");
    writeFileSync(secretPath, "test-only-secret\n", { mode: 0o600 });
    const runtime = await createDacsLiveRoleRuntimeV1({
      config: payDemConfig(directory),
      role: "buyer",
      authority: AUTHORITY,
      peerAuthority: PEER_AUTHORITY,
      peerEndpoint: "http://127.0.0.1:39999/dacs-transport/v1/messages",
      workerId: "buyer-pay-dem-graph-worker",
      demosIdentityFilePath: secretPath,
      createDemosAdapter: async () => ({
        ...adapter(),
        getAddress: vi.fn(() => wallet),
      }),
      createPayDemRail: async () => ({ address: wallet, settle: vi.fn() }),
      createCommerceGraph: async () => Object.freeze({
        role: "buyer" as const,
        availability: Object.freeze({ status: "configured" as const }),
        payDemOperations: buyerOperations(),
        validatePayload: vi.fn(() => Object.freeze({ status: "valid" as const })),
        handleMessage: vi.fn(async () => Object.freeze({
          disposition: "accepted" as const,
        })),
      }),
      server: { hostname: "127.0.0.1", port: 0 },
    });
    try {
      expect(runtime.service.coordinator.profiles).toEqual(["pay-dem"]);
      await runtime.start();
    } finally {
      await runtime.stop();
    }
  });

  it("admits both complete rail graphs without sharing EVM requirements with DEM-only", async () => {
    const directory = root();
    const secretPath = join(directory, "demos.secret");
    const evmSecretPath = join(directory, "evm.secret");
    const wallet = Buffer.from(PUBLIC_KEY).toString("hex");
    writeFileSync(secretPath, "test-only-secret\n", { mode: 0o600 });
    writeFileSync(evmSecretPath, `${EVM_PRIVATE_KEY}\n`, { mode: 0o600 });
    const runtime = await createDacsLiveRoleRuntimeV1({
      config: bothConfig(directory),
      role: "buyer",
      authority: AUTHORITY,
      peerAuthority: PEER_AUTHORITY,
      peerEndpoint: "http://127.0.0.1:39999/dacs-transport/v1/messages",
      workerId: "buyer-both-graph-worker",
      demosIdentityFilePath: secretPath,
      evmPrivateKeyFilePath: evmSecretPath,
      evmRpcUrl: "http://127.0.0.1:8545",
      createDemosAdapter: async () => ({
        ...adapter(),
        getAddress: vi.fn(() => wallet),
      }),
      createPayDemRail: async () => ({ address: wallet, settle: vi.fn() }),
      createCommerceGraph: async () => Object.freeze({
        role: "buyer" as const,
        availability: Object.freeze({ status: "configured" as const }),
        operations: buyerOperations(),
        payDemOperations: buyerOperations(),
        validatePayload: vi.fn(() => Object.freeze({ status: "valid" as const })),
        handleMessage: vi.fn(async () => Object.freeze({
          disposition: "accepted" as const,
        })),
      }),
      server: { hostname: "127.0.0.1", port: 0 },
    });
    try {
      expect(runtime.service.coordinator.profiles).toEqual(["x402", "pay-dem"]);
      expect(runtime.evm?.role).toBe("buyer");
      expect(runtime.demos.payDem?.rail.address).toBe(wallet);
      await runtime.start();
    } finally {
      await runtime.stop();
    }
  });

  it("rejects a partial async commerce graph before service creation", async () => {
    const directory = root();
    const secretPath = join(directory, "demos.secret");
    const evmSecretPath = join(directory, "evm.secret");
    writeFileSync(secretPath, "test-only-secret\n", { mode: 0o600 });
    writeFileSync(evmSecretPath, `${EVM_PRIVATE_KEY}\n`, { mode: 0o600 });
    await expect(createDacsLiveRoleRuntimeV1({
      config: config(directory),
      role: "buyer",
      authority: AUTHORITY,
      peerAuthority: PEER_AUTHORITY,
      peerEndpoint: "http://127.0.0.1:39999/dacs-transport/v1/messages",
      workerId: "buyer-partial-graph-worker",
      demosIdentityFilePath: secretPath,
      evmPrivateKeyFilePath: evmSecretPath,
      evmRpcUrl: "http://127.0.0.1:8545",
      createDemosAdapter: async () => adapter(),
      createCommerceGraph: async () => ({
        role: "buyer",
        operations: { agreement: vi.fn() },
        validatePayload: vi.fn(),
        handleMessage: vi.fn(),
      }) as never,
    })).rejects.toMatchObject({ reasonCode: "role-commerce-graph-invalid" });
  });

  it("opens one wallet/store/service authority and gates HTTP on its signed latch", async () => {
    const directory = root();
    const secretPath = join(directory, "demos.secret");
    const evmSecretPath = join(directory, "evm.secret");
    writeFileSync(secretPath, "test-only-secret\n", { mode: 0o600 });
    writeFileSync(evmSecretPath, `${EVM_PRIVATE_KEY}\n`, { mode: 0o600 });
    const operationContexts: unknown[] = [];
    const applicationContexts: unknown[] = [];
    const runtime = await createDacsLiveRoleRuntimeV1({
      config: config(directory),
      role: "buyer",
      authority: AUTHORITY,
      peerAuthority: PEER_AUTHORITY,
      peerEndpoint: "http://127.0.0.1:39999/dacs-transport/v1/messages",
      workerId: "buyer-test-worker",
      demosIdentityFilePath: secretPath,
      evmPrivateKeyFilePath: evmSecretPath,
      evmRpcUrl: "http://127.0.0.1:8545",
      createDemosAdapter: async () => adapter(),
      createOperations: (context) => {
        operationContexts.push(context);
        return Object.freeze({});
      },
      validatePayload: () => Object.freeze({
        status: "invalid" as const,
        reasonCode: "application-payload-not-configured",
      }),
      handleMessage: () => Object.freeze({
        disposition: "rejected" as const,
        reasonCode: "application-handler-not-configured",
      }),
      handleApplicationRequest: (_request, response, context) => {
        applicationContexts.push(context);
        response.statusCode = 204;
        response.end();
        return true;
      },
      server: { hostname: "127.0.0.1", port: 0 },
    });
    expect(operationContexts).toHaveLength(1);
    expect(operationContexts[0]).toMatchObject({
      role: "buyer",
      authority: AUTHORITY,
      peerAuthority: PEER_AUTHORITY,
      config: runtime.config,
      database: runtime.database,
      demos: runtime.demos,
      sessionStore: runtime.sessionStore,
      commerceStores: runtime.commerceStores,
      evm: runtime.evm,
    });
    expect(runtime.commerceStores).toMatchObject({ role: "buyer" });
    expect(runtime.evm).toMatchObject({
      role: "buyer",
      address: expect.stringMatching(/^0x[0-9A-Fa-f]{40}$/),
    });
    const buyerEvm = runtime.evm;
    expect(buyerEvm?.role === "buyer" && buyerEvm.runtime.destroyed).toBe(false);
    if (runtime.commerceStores.role === "buyer") {
      await expect(runtime.commerceStores.x402Settlement!.load("missing"))
        .resolves.toMatchObject({ status: "absent" });
    }
    await runtime.start();
    const endpoint = runtime.service.endpoint!;
    await expect(fetch(new URL("/health", endpoint)).then((response) => response.json()))
      .resolves.toMatchObject({ status: "healthy" });
    await expect(fetch(new URL("/ready", endpoint))).resolves.toMatchObject({ status: 503 });

    await runtime.readinessLatch.commit(
      "a".repeat(64),
      runtime.demos.signTransportEnvelope,
    );
    await expect(fetch(new URL("/ready", endpoint))).resolves.toMatchObject({ status: 200 });
    await expect(fetch(new URL("/application", endpoint))).resolves.toMatchObject({ status: 204 });
    expect(applicationContexts).toHaveLength(1);
    expect(applicationContexts[0]).toMatchObject({
      role: "buyer",
      database: runtime.database,
      demos: runtime.demos,
      coordinator: runtime.service.coordinator,
    });
    await runtime.stop();
    expect(buyerEvm?.role === "buyer" && buyerEvm.runtime.destroyed).toBe(true);
    await expect(runtime.start()).rejects.toMatchObject({ reasonCode: "role-runtime-closed" });

    const restarted = await createDacsLiveRoleRuntimeV1({
      config: config(directory),
      role: "buyer",
      authority: AUTHORITY,
      peerAuthority: PEER_AUTHORITY,
      peerEndpoint: "http://127.0.0.1:39999/dacs-transport/v1/messages",
      workerId: "buyer-restarted-worker",
      demosIdentityFilePath: secretPath,
      evmPrivateKeyFilePath: evmSecretPath,
      evmRpcUrl: "http://127.0.0.1:8545",
      createDemosAdapter: async () => adapter(),
      createOperations: () => Object.freeze({}),
      validatePayload: () => Object.freeze({
        status: "invalid" as const,
        reasonCode: "application-payload-not-configured",
      }),
      handleMessage: () => Object.freeze({
        disposition: "rejected" as const,
        reasonCode: "application-handler-not-configured",
      }),
      server: { hostname: "127.0.0.1", port: 0 },
    });
    await expect(restarted.readinessLatch.readiness()).resolves.toMatchObject({ ready: true });
    await restarted.start();
    await expect(fetch(new URL("/ready", restarted.service.endpoint!)))
      .resolves.toMatchObject({ status: 503 });
    await restarted.stop();
  });

  it.each([
    ["database-directory-owner-mismatch", "database-directory-owner-mismatch"],
    [undefined, "unknown"],
  ])("reports a database-open cause %s and destroys the loaded identity", async (reasonCode, expected) => {
    const directory = root();
    const destroy = vi.fn();
    const loaded = vi.spyOn(secretLoader, "loadDacsSecretV1")
      .mockResolvedValue({ destroy } as never);
    const cause = Object.assign(new Error("fixture internal database detail"), { reasonCode });
    const openDatabase = vi.fn(async () => { throw cause; });
    const createDemosAdapter = vi.fn(async () => adapter());
    try {
      const failure = await createDacsLiveRoleRuntimeV1({
        config: payDemConfig(directory),
        role: "buyer",
        authority: AUTHORITY,
        peerAuthority: PEER_AUTHORITY,
        peerEndpoint: "http://127.0.0.1:39999/dacs-transport/v1/messages",
        workerId: "database-refusal-worker",
        demosIdentityFilePath: join(directory, "unused-fixture"),
        openDatabase,
        createDemosAdapter,
        createCommerceGraph: () => { throw new Error("must not create commerce"); },
      }).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        reasonCode: "role-database-open-failed",
        message: "role-database-open-failed",
        causeCode: expected,
      });
      expect((failure as Error).cause).toBe(cause);
      expect(openDatabase).toHaveBeenCalledTimes(1);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(createDemosAdapter).not.toHaveBeenCalled();
    } finally {
      loaded.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")(
    "reports the default opener's location refusal as the cause code",
    async () => {
      const directory = root();
      const dataDirectory = join(directory, "data");
      mkdirSync(dataDirectory, { mode: 0o700 });
      chmodSync(dataDirectory, 0o777);
      const destroy = vi.fn();
      const loaded = vi.spyOn(secretLoader, "loadDacsSecretV1")
        .mockResolvedValue({ destroy } as never);
      const createDemosAdapter = vi.fn(async () => adapter());
      try {
        const failure = await createDacsLiveRoleRuntimeV1({
          config: payDemConfig(dataDirectory),
          role: "buyer",
          authority: AUTHORITY,
          peerAuthority: PEER_AUTHORITY,
          peerEndpoint: "http://127.0.0.1:39999/dacs-transport/v1/messages",
          workerId: "database-location-worker",
          demosIdentityFilePath: join(directory, "unused-fixture"),
          createDemosAdapter,
          createCommerceGraph: () => { throw new Error("must not create commerce"); },
        }).catch((error: unknown) => error);
        expect(failure).toMatchObject({
          reasonCode: "role-database-open-failed",
          causeCode: "database-directory-permissions-unsafe",
        });
        expect((failure as Error).cause).toMatchObject({
          name: "DacsNodeSqliteError",
          reasonCode: "database-directory-permissions-unsafe",
        });
        expect(destroy).toHaveBeenCalledTimes(1);
        expect(createDemosAdapter).not.toHaveBeenCalled();
      } finally {
        loaded.mockRestore();
      }
    },
  );

  it("destroys loaded identity material and closes the database on adapter failure", async () => {
    const directory = root();
    const secretPath = join(directory, "demos.secret");
    const evmSecretPath = join(directory, "evm.secret");
    writeFileSync(secretPath, "test-only-secret\n", { mode: 0o600 });
    writeFileSync(evmSecretPath, `${EVM_PRIVATE_KEY}\n`, { mode: 0o600 });
    const close = vi.fn();
    await expect(createDacsLiveRoleRuntimeV1({
      config: config(directory),
      role: "buyer",
      authority: AUTHORITY,
      peerAuthority: PEER_AUTHORITY,
      peerEndpoint: "http://127.0.0.1:39999/dacs-transport/v1/messages",
      workerId: "buyer-test-worker",
      demosIdentityFilePath: secretPath,
      evmPrivateKeyFilePath: evmSecretPath,
      evmRpcUrl: "http://127.0.0.1:8545",
      openDatabase: async () => ({ close } as never),
      createDemosAdapter: async () => { throw new Error("private provider failure"); },
      createOperations: () => Object.freeze({}),
      validatePayload: () => Object.freeze({ status: "valid" as const }),
      handleMessage: () => Object.freeze({ disposition: "accepted" as const }),
    })).rejects.toMatchObject({ reasonCode: "role-demos-runtime-open-failed" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reports an outbox lease race through the final doctor report", async () => {
    const directory = root();
    const secretPath = join(directory, "demos.secret");
    writeFileSync(secretPath, "test-only-secret\n", { mode: 0o600 });
    const runtime = await createDacsLiveRoleRuntimeV1({
      config: payDemConfig(directory), role: "buyer", authority: AUTHORITY,
      peerAuthority: PEER_AUTHORITY,
      peerEndpoint: "http://127.0.0.1:39999/dacs-transport/v1/messages",
      workerId: "lease-race-worker", demosIdentityFilePath: secretPath,
      createDemosAdapter: async () => ({
        ...adapter(), getAddress: () => Buffer.from(PUBLIC_KEY).toString("hex"),
      }),
      createPayDemRail: async () => ({
        address: Buffer.from(PUBLIC_KEY).toString("hex"), settle: vi.fn(),
      }),
      createPayDemOperations: () => Object.freeze({}),
      validatePayload: () => Object.freeze({ status: "valid" as const }),
      handleMessage: () => Object.freeze({ disposition: "accepted" as const }),
    });
    try {
      const outbox = runtime.database.createHttpOutboxStore();
      const staleLease = vi.fn(async () => false);
      const fetcher = vi.fn();
      const diagnostic = () => runDacsRoleTransportDiagnosticV1({
        role: "buyer", demos: runtime.demos,
        database: {
          metadata: runtime.database.metadata,
          createHttpOutboxStore: () => ({ ...outbox, isCurrent: staleLease }),
        } as never,
        peerAuthority: PEER_AUTHORITY,
        peerEndpoint: "http://127.0.0.1:39999/dacs-transport/v1/messages",
        workerId: "lease-race-doctor", fetch: fetcher,
      });
      const failure = await diagnostic().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DacsTransportDiagnosticError);
      expect(failure).toMatchObject({ reasonCode: "transport-diagnostic-unavailable",
        causeCode: "outbox-lease-stale" });
      expect((failure as Error).cause).toBeInstanceOf(DacsHttpTransportError);
      const probes = createDacsRoleServiceDoctorProbesV1({
        targets: [{ role: "buyer", endpoint: "http://127.0.0.1:3101" },
          { role: "seller", endpoint: "http://127.0.0.1:3102" }],
        sdkVersion: "sdk-v1", standardRevision: "standard-v1", profile: DACS_NODE_LIVE_PROFILE,
        transportDiagnostic: diagnostic,
      });
      const report = await runDacsLiveDoctorV1({
        phase: "post-start", scope: "start", sdkVersion: "sdk-v1",
        standardRevision: "standard-v1", profile: DACS_NODE_LIVE_PROFILE,
        probes: { "service.transport-roundtrip": probes["service.transport-roundtrip"]! },
      });
      expect(report.checks.find((check) => check.id === "service.transport-roundtrip"))
        .toMatchObject({ status: "fail", reasonCode: "transport-diagnostic-unavailable",
          facts: { causeCode: "outbox-lease-stale" } });
      expect(staleLease).toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await runtime.stop();
    }
  });

  it("proves both durable authenticated no-action transport directions", async () => {
    const buyerDirectory = root();
    const sellerDirectory = root();
    const buyerSecret = join(buyerDirectory, "demos.secret");
    const sellerSecret = join(sellerDirectory, "demos.secret");
    const buyerEvmSecret = join(buyerDirectory, "evm.secret");
    const sellerEvmSecret = join(sellerDirectory, "evm.secret");
    writeFileSync(buyerSecret, "buyer-test-secret\n", { mode: 0o600 });
    writeFileSync(sellerSecret, "seller-test-secret\n", { mode: 0o600 });
    writeFileSync(buyerEvmSecret, `${EVM_PRIVATE_KEY}\n`, { mode: 0o600 });
    writeFileSync(sellerEvmSecret, `0x${"44".repeat(32)}\n`, { mode: 0o600 });
    const buyerApplication = vi.fn(() => Object.freeze({ disposition: "accepted" as const }));
    const sellerApplication = vi.fn(() => Object.freeze({ disposition: "accepted" as const }));
    const buyer = await createDacsLiveRoleRuntimeV1({
      config: config(buyerDirectory, "buyer"),
      role: "buyer",
      authority: AUTHORITY,
      peerAuthority: PEER_AUTHORITY,
      peerEndpoint: "http://127.0.0.1:39998/dacs-transport/v1/messages",
      workerId: "buyer-service-worker",
      demosIdentityFilePath: buyerSecret,
      evmPrivateKeyFilePath: buyerEvmSecret,
      evmRpcUrl: "http://127.0.0.1:8545",
      createDemosAdapter: async () => adapter(PUBLIC_KEY, PRIVATE_KEY),
      createOperations: () => Object.freeze({}),
      validatePayload: () => Object.freeze({ status: "valid" as const }),
      handleMessage: buyerApplication,
      server: { hostname: "127.0.0.1", port: 0 },
    });
    const seller = await createDacsLiveRoleRuntimeV1({
      config: config(sellerDirectory, "seller"),
      role: "seller",
      authority: PEER_AUTHORITY,
      peerAuthority: AUTHORITY,
      peerEndpoint: "http://127.0.0.1:39997/dacs-transport/v1/messages",
      workerId: "seller-service-worker",
      demosIdentityFilePath: sellerSecret,
      evmPrivateKeyFilePath: sellerEvmSecret,
      evmRpcUrl: "http://127.0.0.1:8545",
      createDemosAdapter: async () => adapter(PEER_PUBLIC_KEY, PEER_PRIVATE_KEY),
      createOperations: () => Object.freeze({}),
      validatePayload: () => Object.freeze({ status: "valid" as const }),
      handleMessage: sellerApplication,
      server: { hostname: "127.0.0.1", port: 0 },
    });
    try {
      await Promise.all([buyer.start(), seller.start()]);
      await expect(Promise.all([
        runDacsRoleTransportDiagnosticV1({
          role: "buyer",
          database: buyer.database,
          demos: buyer.demos,
          peerAuthority: PEER_AUTHORITY,
          peerEndpoint: seller.service.endpoint!,
          workerId: "buyer-doctor-worker",
        }),
        runDacsRoleTransportDiagnosticV1({
          role: "seller",
          database: seller.database,
          demos: seller.demos,
          peerAuthority: AUTHORITY,
          peerEndpoint: buyer.service.endpoint!,
          workerId: "seller-doctor-worker",
        }),
      ])).resolves.toEqual([
        { authenticated: true, durable: true, acknowledged: true, noAction: true },
        { authenticated: true, durable: true, acknowledged: true, noAction: true },
      ]);
      expect(buyerApplication).not.toHaveBeenCalled();
      expect(sellerApplication).not.toHaveBeenCalled();
    } finally {
      await Promise.all([buyer.stop(), seller.stop()]);
    }
  });
});
