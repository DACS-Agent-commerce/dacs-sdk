import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  type DacsDemosAdapterV1,
} from "../src/index.js";

const SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const PEER_SEED = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const PRIVATE_KEY = privateKeyFromSeed(SEED);
const PUBLIC_KEY = rawPublicKey(publicKeyFromSeed(SEED));
const PEER_PUBLIC_KEY = rawPublicKey(publicKeyFromSeed(PEER_SEED));
const AUTHORITY = demosAgentClaimRef(PUBLIC_KEY);
const PEER_AUTHORITY = demosAgentClaimRef(PEER_PUBLIC_KEY);

describe("complete role-owned live runtime", () => {
  const roots: string[] = [];

  function root(): string {
    const directory = mkdtempSync(join(tmpdir(), "dacs-role-runtime-"));
    roots.push(directory);
    return directory;
  }

  function config(directory: string) {
    return {
      mode: "live-demos" as const,
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer" as const,
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

  function adapter(): DacsDemosAdapterV1 {
    return {
      raw: {
        getNetworkInfo: vi.fn(async () => ({ chain: "test" })),
        getAddressNonce: vi.fn(async () => 1),
        getAddressInfo: vi.fn(async () => ({ balance: "10" })),
      },
      connect: vi.fn(async () => undefined),
      getAddress: vi.fn(() => "0xactor"),
      getPublicKey: vi.fn(async () => Uint8Array.from(PUBLIC_KEY)),
      sign: vi.fn(async (bytes) => ed25519Sign(bytes, PRIVATE_KEY)),
      resolveIdentity: vi.fn(async (ref) => ({ ref, boundTo: ref, raw: { fixture: true } })),
      readAnchor: vi.fn(async () => null),
      resolveAnchorByName: vi.fn(async () => ({ status: "absent" as const })),
      anchorWriteOnce: vi.fn(async () => ({ address: "stor:test" })),
      verifyDemosAnchorReceipt: vi.fn(async () => true),
      resolveDemosAnchorReceipt: vi.fn(async () => null),
    };
  }

  afterEach(() => {
    for (const directory of roots.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("opens one wallet/store/service authority and gates HTTP on its signed latch", async () => {
    const directory = root();
    const secretPath = join(directory, "demos.secret");
    writeFileSync(secretPath, "test-only-secret\n", { mode: 0o600 });
    const runtime = await createDacsLiveRoleRuntimeV1({
      config: config(directory),
      role: "buyer",
      authority: AUTHORITY,
      peerAuthority: PEER_AUTHORITY,
      peerEndpoint: "http://127.0.0.1:39999/dacs-transport/v1/messages",
      workerId: "buyer-test-worker",
      demosIdentityFilePath: secretPath,
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
    await runtime.stop();
    await expect(runtime.start()).rejects.toMatchObject({ reasonCode: "role-runtime-closed" });

    const restarted = await createDacsLiveRoleRuntimeV1({
      config: config(directory),
      role: "buyer",
      authority: AUTHORITY,
      peerAuthority: PEER_AUTHORITY,
      peerEndpoint: "http://127.0.0.1:39999/dacs-transport/v1/messages",
      workerId: "buyer-restarted-worker",
      demosIdentityFilePath: secretPath,
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

  it("destroys loaded identity material and closes the database on adapter failure", async () => {
    const directory = root();
    const secretPath = join(directory, "demos.secret");
    writeFileSync(secretPath, "test-only-secret\n", { mode: 0o600 });
    const close = vi.fn();
    await expect(createDacsLiveRoleRuntimeV1({
      config: config(directory),
      role: "buyer",
      authority: AUTHORITY,
      peerAuthority: PEER_AUTHORITY,
      peerEndpoint: "http://127.0.0.1:39999/dacs-transport/v1/messages",
      workerId: "buyer-test-worker",
      demosIdentityFilePath: secretPath,
      openDatabase: async () => ({ close } as never),
      createDemosAdapter: async () => { throw new Error("private provider failure"); },
      createOperations: () => Object.freeze({}),
      validatePayload: () => Object.freeze({ status: "valid" as const }),
      handleMessage: () => Object.freeze({ disposition: "accepted" as const }),
    })).rejects.toMatchObject({ reasonCode: "role-demos-runtime-open-failed" });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
