import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { demosAgentClaimRef } from "@kynesyslabs/dacs/identity";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DACS_NODE_LIVE_PROFILE,
  createDacsDemosActorRuntimeV1,
  createDacsDemosIdentityResolverV1,
  loadDacsSecretV1,
  type DacsDemosAdapterV1,
  type DacsDemosActorRuntimeV1,
} from "../src/index.js";

const PUBLIC_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const PEER_KEY = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const AUTHORITY = demosAgentClaimRef(PUBLIC_KEY);
const PEER = demosAgentClaimRef(PEER_KEY);

describe("role-owned Demos runtime", () => {
  const roots: string[] = [];

  function root(): string {
    const directory = mkdtempSync(join(tmpdir(), "dacs-demos-runtime-"));
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

  async function secret(directory: string) {
    const path = join(directory, "demos.secret");
    writeFileSync(path, "test-only-secret\n", { mode: 0o600 });
    return loadDacsSecretV1({
      name: "buyer-demos-identity",
      mode: "live-demos",
      filePath: path,
    });
  }

  function adapter(overrides: Partial<DacsDemosAdapterV1> = {}): DacsDemosAdapterV1 {
    return {
      raw: {
        getNetworkInfo: vi.fn(async () => ({ chain: "test" })),
        getAddressNonce: vi.fn(async () => 7),
        getAddressInfo: vi.fn(async () => ({ balance: "10" })),
      },
      connect: vi.fn(async () => undefined),
      getAddress: vi.fn(() => "0xactor"),
      getPublicKey: vi.fn(async () => Uint8Array.from(PUBLIC_KEY)),
      sign: vi.fn(async () => new Uint8Array(64).fill(7)),
      resolveIdentity: vi.fn(async (ref) => ({
        ref,
        boundTo: ref,
        raw: { identity: "authenticated-test-fixture" },
      })),
      readAnchor: vi.fn(async () => null),
      resolveAnchorByName: vi.fn(async () => ({ status: "absent" as const })),
      anchorWriteOnce: vi.fn(async () => ({ address: "stor:test" })),
      verifyDemosAnchorReceipt: vi.fn(async () => true),
      ...overrides,
    };
  }

  async function runtime(
    directory: string,
    mock = adapter(),
  ): Promise<Readonly<DacsDemosActorRuntimeV1>> {
    const loaded = await secret(directory);
    const opened = await createDacsDemosActorRuntimeV1({
      config: config(directory),
      role: "buyer",
      authority: AUTHORITY,
      demosIdentity: loaded,
      createAdapter: async ({ secret: captured }) => {
        expect(captured).toBe("test-only-secret");
        return mock;
      },
    });
    expect(loaded.destroyed).toBe(true);
    return opened;
  }

  afterEach(() => {
    for (const directory of roots.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("connects a journalled wallet and proves its exact primary authority", async () => {
    const directory = root();
    const mock = adapter();
    const opened = await runtime(directory, mock);

    expect(opened.authority).toBe(AUTHORITY);
    expect(opened.walletAddress).toBe("0xactor");
    expect(opened.publicKey).toEqual(PUBLIC_KEY);
    const detached = opened.publicKey;
    detached.fill(0);
    expect(opened.publicKey).toEqual(PUBLIC_KEY);
    await expect(opened.networkInfo()).resolves.toEqual({ chain: "test" });
    await expect(opened.addressNonce()).resolves.toBe(7);
    await expect(opened.signTransportEnvelope(new Uint8Array([1, 2, 3])))
      .resolves.toHaveLength(64);
    expect(mock.connect).toHaveBeenCalledTimes(1);
  });

  it("rejects a wallet whose derived primary ClaimRef differs", async () => {
    const directory = root();
    const loaded = await secret(directory);
    await expect(createDacsDemosActorRuntimeV1({
      config: config(directory),
      role: "buyer",
      authority: AUTHORITY,
      demosIdentity: loaded,
      createAdapter: async () => adapter({
        getPublicKey: vi.fn(async () => Uint8Array.from(PEER_KEY)),
      }),
    })).rejects.toMatchObject({ reasonCode: "demos-wallet-authority-mismatch" });
    expect(loaded.destroyed).toBe(true);
  });

  it("resolves the configured peer from Demos and binds its transport role", async () => {
    const directory = root();
    const mock = adapter();
    const opened = await runtime(directory, mock);
    const authorizeJob = vi.fn(async () => true);
    const resolveIdentity = createDacsDemosIdentityResolverV1({
      runtime: opened,
      peerAuthority: PEER,
      peerRole: "seller",
      authorizeJob,
    });

    await expect(resolveIdentity({
      sender: PEER,
      audience: AUTHORITY,
      keyId: PEER,
      jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
      messageType: "agreement-response",
      storeTime: 1_780_000_000_000,
    })).resolves.toMatchObject({
      status: "authenticated",
      principal: PEER,
      role: "seller",
      publicKey: PEER_KEY,
    });
    expect(mock.resolveIdentity).toHaveBeenCalledWith(PEER);
    expect(authorizeJob).toHaveBeenCalledTimes(1);
  });

  it("fails closed for wrong role direction, rejected jobs, and ambiguous identity data", async () => {
    const directory = root();
    const mock = adapter();
    const opened = await runtime(directory, mock);
    const wrongDirection = createDacsDemosIdentityResolverV1({
      runtime: opened,
      peerAuthority: PEER,
      peerRole: "seller",
    });
    await expect(wrongDirection({
      sender: PEER,
      audience: AUTHORITY,
      keyId: PEER,
      jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
      messageType: "agreement-proposal",
      storeTime: 1,
    })).resolves.toMatchObject({
      status: "rejected",
      reasonCode: "identity-role-incompatible",
    });

    const rejectedJob = createDacsDemosIdentityResolverV1({
      runtime: opened,
      peerAuthority: PEER,
      peerRole: "seller",
      authorizeJob: async () => false,
    });
    await expect(rejectedJob({
      sender: PEER,
      audience: AUTHORITY,
      keyId: PEER,
      jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
      messageType: "agreement-response",
      storeTime: 1,
    })).resolves.toMatchObject({ status: "rejected" });

    mock.resolveIdentity = vi.fn(async () => ({
      ref: AUTHORITY,
      boundTo: AUTHORITY,
      raw: {},
    }));
    const ambiguous = createDacsDemosIdentityResolverV1({
      runtime: opened,
      peerAuthority: PEER,
      peerRole: "seller",
    });
    await expect(ambiguous({
      sender: PEER,
      audience: AUTHORITY,
      keyId: PEER,
      jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
      messageType: "agreement-response",
      storeTime: 1,
    })).resolves.toMatchObject({
      status: "rejected",
      reasonCode: "identity-ambiguous",
    });
  });
});
