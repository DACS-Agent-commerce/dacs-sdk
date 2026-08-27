import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { demosAgentClaimRef } from "@kynesyslabs/dacs/identity";
import type { DemosWriteJournal } from "@kynesyslabs/dacs/substrate";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

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

  function payDemConfig(directory: string) {
    const value = config(directory);
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
      getChainIdentity: vi.fn(async () => "test-chain"),
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
      scanOwnAnchorsByNamePrefix: vi.fn(async () => ({
        status: "ok" as const,
        anchors: [],
      })),
      anchorWriteOnce: vi.fn(async () => ({ address: "stor:test" })),
      verifyDemosAnchorReceipt: vi.fn(async () => true),
      resolveDemosAnchorReceipt: vi.fn(async () => null),
      reconcileNativeTransferJournal: vi.fn(async () => undefined),
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
    await expect(opened.signComponent(new Uint8Array([4, 5, 6]), {
      algorithm: "ed25519",
      signer: AUTHORITY,
    })).resolves.toHaveLength(64);
    await expect(opened.signComponent(new Uint8Array([4, 5, 6]), {
      algorithm: "ed25519",
      signer: PEER,
    })).rejects.toMatchObject({
      reasonCode: "demos-component-signature-authority-mismatch",
    });
    expect(mock.connect).toHaveBeenCalledTimes(1);
  });

  it("opens read-only probes without creating a durable write journal", async () => {
    const directory = root();
    const loaded = await secret(directory);
    let journal: DemosWriteJournal | undefined;
    let maximumFeeOs: bigint | undefined;
    await createDacsDemosActorRuntimeV1({
      config: config(directory),
      role: "buyer",
      authority: AUTHORITY,
      demosIdentity: loaded,
      writePolicy: "read-only",
      createAdapter: async (input) => {
        journal = input.writeJournal;
        maximumFeeOs = input.maximumFeeOs;
        return adapter();
      },
    });
    expect(maximumFeeOs).toBe(2_000_000_000n);
    expect(existsSync(join(directory, "demos-write-journal"))).toBe(false);
    await expect(journal!.acquire({ chainIdentity: "test", wallet: "0xactor" }))
      .rejects.toMatchObject({ reasonCode: "demos-write-disabled" });
  });

  it("creates and binds the native buyer rail before destroying wallet material", async () => {
    const directory = root();
    const loaded = await secret(directory);
    const wallet = Buffer.from(PUBLIC_KEY).toString("hex");
    const settle = vi.fn();
    const createPayDemRail = vi.fn(async ({ secret: captured }) => {
      expect(captured).toBe("test-only-secret");
      expect(loaded.destroyed).toBe(false);
      return Object.freeze({ address: wallet, settle });
    });
    const opened = await createDacsDemosActorRuntimeV1({
      config: payDemConfig(directory),
      role: "buyer",
      authority: AUTHORITY,
      demosIdentity: loaded,
      createAdapter: async () => adapter({ getAddress: vi.fn(() => wallet) }),
      createPayDemRail,
    });

    expect(loaded.destroyed).toBe(true);
    expect(opened.payDem?.rail.address).toBe(wallet);
    expect(opened.payDem?.rail.settle).not.toBe(settle);
    expect(createPayDemRail).toHaveBeenCalledWith({
      rpc: "http://127.0.0.1:5350",
      secret: "test-only-secret",
      network: "demos",
    });
  });

  it("holds the shared wallet lease across an ambiguous native broadcast", async () => {
    const directory = root();
    const loaded = await secret(directory);
    const wallet = Buffer.from(PUBLIC_KEY).toString("hex");
    const payee = "cd".repeat(32);
    const txHash = "12".repeat(32);
    const reachedBroadcast = deferred<void>();
    const releaseBroadcast = deferred<void>();
    let journal!: DemosWriteJournal;
    const mock = adapter({
      getAddress: vi.fn(() => wallet),
      reconcileNativeTransferJournal: vi.fn(async () => undefined),
    });
    const opened = await createDacsDemosActorRuntimeV1({
      config: payDemConfig(directory),
      role: "buyer",
      authority: AUTHORITY,
      demosIdentity: loaded,
      createAdapter: async (input) => {
        journal = input.writeJournal;
        return mock;
      },
      createPayDemRail: async () => ({
        address: wallet,
        async settle(input) {
          await input.journalPreparedTransfer!({
            txHash,
            nonce: 7,
            payer: wallet,
            payee,
            amountOs: "1000000000",
            denomination: "os",
            network: "demos",
            maxTotalDebitOs: "2000000000",
          });
          await input.assertCurrentBeforeBroadcast!();
          reachedBroadcast.resolve();
          await releaseBroadcast.promise;
          return {
            ok: false,
            txHash,
            chainId: "demos",
            payer: wallet,
            payee,
          };
        },
      }),
    });

    const payment = opened.payDem!.rail.settle({
      recipient: payee,
      amount: "1000000000",
      maxTotalDebitOs: "2000000000",
    });
    await reachedBroadcast.promise;
    const competing = journal.acquire({ chainIdentity: "test-chain", wallet });
    await expect(Promise.race([
      competing.then(() => "acquired"),
      new Promise<string>((resolve) => setTimeout(() => resolve("held"), 30)),
    ])).resolves.toBe("held");

    releaseBroadcast.resolve();
    await expect(payment).resolves.toMatchObject({ ok: false, txHash });
    const next = await competing;
    expect(next.snapshot.records).toMatchObject([
      {
        kind: "native-transfer",
        operation: "transfer",
        stage: "broadcast-intent",
        nonce: 7,
        txRef: txHash,
        transfer: { payer: wallet, payee, amountOs: "1000000000" },
      },
    ]);
    await next.release();
  });

  it("does not open a payment signer for a read-only native doctor", async () => {
    const directory = root();
    const loaded = await secret(directory);
    const createPayDemRail = vi.fn();
    const opened = await createDacsDemosActorRuntimeV1({
      config: payDemConfig(directory),
      role: "buyer",
      authority: AUTHORITY,
      demosIdentity: loaded,
      writePolicy: "read-only",
      createAdapter: async () => adapter(),
      createPayDemRail,
    });
    expect(opened.payDem).toBeUndefined();
    expect(createPayDemRail).not.toHaveBeenCalled();
  });

  it("rejects a native rail whose payer differs from the Demos actor wallet", async () => {
    const directory = root();
    const loaded = await secret(directory);
    const wallet = Buffer.from(PUBLIC_KEY).toString("hex");
    await expect(createDacsDemosActorRuntimeV1({
      config: payDemConfig(directory),
      role: "buyer",
      authority: AUTHORITY,
      demosIdentity: loaded,
      createAdapter: async () => adapter({ getAddress: vi.fn(() => wallet) }),
      createPayDemRail: async () => ({
        address: "ff".repeat(32),
        settle: vi.fn(),
      }),
    })).rejects.toMatchObject({
      reasonCode: "demos-pay-dem-wallet-authority-mismatch",
    });
    expect(loaded.destroyed).toBe(true);
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
