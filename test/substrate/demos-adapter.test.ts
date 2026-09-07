import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageProgram } from "@kynesyslabs/demosdk/storage";
import { Identities } from "@kynesyslabs/demosdk/abstraction";

// DemosAdapter lives on the substrate subpath, not the top-level barrel (the
// barrel stays demosdk-free for plain-Node-ESM consumers — #1/F1).
import {
  DemosAdapter,
  createInMemoryDemosWriteJournal,
  type DemosAdapterConfig,
} from "../../src/substrate/index.js";
import { DEMOS_CCI_RESPONSE_LIMITS } from "../../src/identity/index.js";

const RPC = "https://node2.demos.sh";
const makeAdapter = (
  writeJournal = createInMemoryDemosWriteJournal(),
) => new DemosAdapter({
  rpc: RPC,
  chainIdentity: "test-chain",
  writeJournal,
});

describe("DemosAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("requires an rpc url", () => {
    // @ts-expect-error — exercising the runtime guard
    expect(() => new DemosAdapter({})).toThrow(/rpc/);
  });

  it("rejects proxy and accessor-backed secret carriers", () => {
    expect(() => new DemosAdapter(new Proxy({ rpc: RPC }, {})))
      .toThrow(/stable data/);
    const accessor = { rpc: RPC } as DemosAdapterConfig;
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get: () => "wallet-secret-sentinel-never-expose",
    });
    expect(() => new DemosAdapter(accessor)).toThrow(/secret.*stable data/);
  });

  it("constructs and exposes the raw demosdk instance", () => {
    const adapter = makeAdapter();
    expect(adapter.raw).toBeDefined();
  });

  it("does not retain its config carrier or wallet secret in reflectable fields", async () => {
    const secret = "wallet-secret-sentinel-never-expose";
    const config = {
      rpc: RPC,
      secret,
      chainIdentity: "test-chain",
      writeJournal: createInMemoryDemosWriteJournal(),
    };
    const adapter = new DemosAdapter(config);
    const raw = adapter.raw;
    vi.spyOn(raw, "connect").mockResolvedValue(undefined as never);
    const connectWallet = vi.spyOn(raw, "connectWallet")
      .mockResolvedValue(undefined as never);

    const reflectedBefore = Reflect.ownKeys(adapter).flatMap((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(adapter, key);
      return descriptor && "value" in descriptor ? [descriptor.value] : [];
    });
    expect(reflectedBefore).not.toContain(config);
    expect(reflectedBefore).not.toContain(secret);

    await adapter.connect();
    expect(connectWallet).toHaveBeenCalledOnce();
    expect(connectWallet).toHaveBeenCalledWith(secret);
    expect(Reflect.ownKeys(adapter)).not.toContain("demos");
    expect(Reflect.ownKeys(adapter)).not.toContain("pendingWalletSecret");
  });

  it("fails closed after wallet initialization fails and the secret is discarded", async () => {
    const adapter = new DemosAdapter({
      rpc: RPC,
      secret: "wallet-secret-sentinel-never-expose",
    });
    const raw = adapter.raw;
    vi.spyOn(raw, "connect").mockResolvedValue(undefined as never);
    const connectWallet = vi.spyOn(raw, "connectWallet")
      .mockRejectedValueOnce(new Error("wallet initialization failed"));

    await expect(adapter.connect()).rejects.toThrow(/wallet initialization failed/);
    await expect(adapter.connect()).rejects.toThrow(/previously failed/);
    expect(connectWallet).toHaveBeenCalledOnce();
  });

  it("uses the directly queryable genesis block as the journal chain identity", async () => {
    const adapter = new DemosAdapter({
      rpc: RPC,
      writeJournal: createInMemoryDemosWriteJournal(),
    });
    const getBlock = vi.spyOn(adapter.raw, "getBlockByNumber").mockResolvedValue({
      number: 0,
      hash: "GENESIS-HASH",
      status: "confirmed",
    } as never);

    await expect(
      (adapter as unknown as { resolveChainIdentity(): Promise<string> })
        .resolveChainIdentity(),
    ).resolves.toBe("genesis-hash");
    expect(getBlock).toHaveBeenCalledTimes(1);
    expect(getBlock).toHaveBeenCalledWith(0);
  });

  it("derives the genesis identity from confirmed block one when block zero is not queryable", async () => {
    const adapter = new DemosAdapter({
      rpc: RPC,
      writeJournal: createInMemoryDemosWriteJournal(),
    });
    const getBlock = vi.spyOn(adapter.raw, "getBlockByNumber")
      .mockResolvedValueOnce("error" as never)
      .mockResolvedValueOnce({
        number: 1,
        hash: "BLOCK-ONE",
        status: "confirmed",
        content: { previousHash: "GENESIS-PREDECESSOR" },
      } as never);

    await expect(
      (adapter as unknown as { resolveChainIdentity(): Promise<string> })
        .resolveChainIdentity(),
    ).resolves.toBe("genesis-predecessor");
    expect(getBlock).toHaveBeenNthCalledWith(1, 0);
    expect(getBlock).toHaveBeenNthCalledWith(2, 1);
  });

  it("rejects an unauthenticated block-one genesis fallback", async () => {
    const adapter = new DemosAdapter({
      rpc: RPC,
      writeJournal: createInMemoryDemosWriteJournal(),
    });
    vi.spyOn(adapter.raw, "getBlockByNumber")
      .mockResolvedValueOnce("error" as never)
      .mockResolvedValueOnce({
        number: 1,
        hash: "BLOCK-ONE",
        status: "pending",
        content: { previousHash: "GENESIS-PREDECESSOR" },
      } as never);

    await expect(
      (adapter as unknown as { resolveChainIdentity(): Promise<string> })
        .resolveChainIdentity(),
    ).rejects.toThrow(/no valid chain identity/);
  });

  it("refuses a write before preparation when no durable journal is configured", async () => {
    const adapter = new DemosAdapter({ rpc: RPC, chainIdentity: "test-chain" });
    Object.assign(adapter, { connected: true });
    vi.spyOn(adapter.raw, "getAddress").mockReturnValue("0xWriter");
    const lookup = vi.spyOn(adapter, "resolveAnchorByName");
    const sign = vi.spyOn(adapter.raw.storagePrograms, "sign");
    const broadcast = vi.spyOn(adapter.raw.tx, "broadcast");

    await expect(
      adapter.anchorWriteOnce("listing-v1", { serviceId: "svc" }),
    ).rejects.toThrow(/durable writeJournal/);
    expect(lookup).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("getAddress throws before connect", () => {
    const adapter = makeAdapter();
    expect(() => adapter.getAddress()).toThrow(/not connected/);
  });

  it("substrate ops require a connection", async () => {
    const adapter = makeAdapter();
    await expect(adapter.anchor("dacs:test", { a: 1 })).rejects.toThrow(
      /not connected/,
    );
    await expect(
      adapter.anchorWriteOnce("dacs:test:immutable", { a: 1 }),
    ).rejects.toThrow(/not connected/);
    await expect(
      adapter.scanOwnAnchorsByNamePrefix("dacs:test:v"),
    ).rejects.toThrow(/not connected/);
    expect(() =>
      adapter.createAnchorHistoryPageFetcher("0xowner"),
    ).toThrow(/not connected/);
    await expect(adapter.sign(new Uint8Array())).rejects.toThrow(
      /not connected/,
    );
    await expect(
      adapter.proxyFetch({ url: "https://example.com" }),
    ).rejects.toThrow(/not connected/);
    await expect(adapter.resolveIdentity("ref")).rejects.toThrow(
      /not connected/,
    );
    await expect(
      adapter.findSubjectsByClaim("cci-web2:twitter:alice"),
    ).rejects.toThrow(/not connected/);
  });

  it("keeps Bearer credentials out of DAHR anchored request headers", async () => {
    const statusCredential = ["rk", "test", "StatusCredential456"].join("_");
    const adapter = makeAdapter();
    Object.assign(adapter, { connected: true });
    vi.spyOn(adapter.raw, "getAddress").mockReturnValue("0xWriter");
    const status = vi.spyOn(adapter.raw, "nodeCall").mockResolvedValue({
      state: "included",
      blockNumber: 7,
    } as never);
    const transaction = vi.spyOn(adapter.raw, "getTxByHash").mockResolvedValue({
      hash: "0xdahr",
      status: "confirmed",
      blockNumber: 7,
    } as never);
    const block = vi.spyOn(adapter.raw, "getBlockByNumber").mockResolvedValue({
      number: 7,
      status: "confirmed",
      content: { ordered_transactions: ["0xdahr"] },
      validation_data: { signature: "bft" },
    } as never);
    const startProxy = vi.fn(async () => ({
      data: "ok",
      status: 200,
      responseHash: "a".repeat(64),
      txHash: "0xdahr",
      timestamp: 1,
    }));
    const stopProxy = vi.fn(async () => undefined);
    vi.spyOn((adapter.raw as never as { web2: { createDahr(): Promise<unknown> } }).web2,
      "createDahr").mockResolvedValue({ startProxy, stopProxy });

    await adapter.proxyFetch({
      url: "https://api.stripe.com/v1/payment_intents/pi_test",
      headers: { Authorization: `Bearer ${statusCredential}`, Accept: "json" },
    });

    expect(startProxy).toHaveBeenCalledWith({
      url: "https://api.stripe.com/v1/payment_intents/pi_test",
      method: "GET",
      options: {
        headers: { Accept: "json" },
        authorization: statusCredential,
      },
    });
    expect(status).toHaveBeenCalledWith("getTransactionStatus", { hash: "0xdahr" });
    expect(transaction).toHaveBeenCalledWith("0xdahr");
    expect(block).toHaveBeenCalledWith(7);
    expect(stopProxy).toHaveBeenCalledOnce();
  });

  it("rejects a DAHR response whose anchor transaction failed", async () => {
    const adapter = makeAdapter();
    Object.assign(adapter, { connected: true });
    vi.spyOn(adapter.raw, "getAddress").mockReturnValue("0xWriter");
    vi.spyOn(adapter.raw, "nodeCall").mockResolvedValue({
      state: "failed",
      blockNumber: 8,
    } as never);
    vi.spyOn(adapter.raw, "getTxByHash").mockResolvedValue({
      hash: "0xdahr-failed",
      status: "failed",
      blockNumber: 8,
    } as never);
    const stopProxy = vi.fn(async () => undefined);
    vi.spyOn((adapter.raw as never as { web2: { createDahr(): Promise<unknown> } }).web2,
      "createDahr").mockResolvedValue({
        startProxy: async () => ({
          data: "error",
          status: 502,
          responseHash: "b".repeat(64),
          txHash: "0xdahr-failed",
          timestamp: 2,
        }),
        stopProxy,
      });

    await expect(
      adapter.proxyFetch({ url: "https://example.com/status" }),
    ).rejects.toThrow(/DAHR anchor transaction 0xdahr-failed failed on chain/);
    expect(stopProxy).toHaveBeenCalledOnce();
  });

  it("bounds decoded GCR responses at the Demos adapter boundary", async () => {
    const adapter = makeAdapter();
    Object.assign(adapter, { connected: true });
    vi.spyOn(Identities.prototype, "getIdentities").mockResolvedValue({
      response: {
        web2: {
          github: new Array(
            DEMOS_CCI_RESPONSE_LIMITS.maxArrayLength + 1,
          ).fill("alice"),
        },
      },
    } as never);

    await expect(adapter.resolveIdentity("subject")).rejects.toThrow(
      /maxArrayLength/,
    );
  });

  it("reverse-resolves canonical CCI web2 and chain/subchain wallet refs", async () => {
    const adapter = makeAdapter();
    Object.assign(adapter, { connected: true });
    const web2 = vi.spyOn(Identities.prototype, "getDemosIdsByWeb2Identity")
      .mockResolvedValue([{ pubkey: "subject-a" }, {}, { pubkey: "subject-b" }] as never);
    const wallet = vi.spyOn(Identities.prototype, "getDemosIdsByWeb3Identity")
      .mockResolvedValue([{ pubkey: "subject-c" }] as never);

    await expect(
      adapter.findSubjectsByClaim("cci-web2:twitter:alice"),
    ).resolves.toEqual(["subject-a", "subject-b"]);
    expect(web2).toHaveBeenCalledWith(adapter.raw, "twitter", "alice");

    await expect(
      adapter.findSubjectsByClaim(
        `cci-xm:evm:base-sepolia:0x${"11".repeat(20)}`,
      ),
    ).resolves.toEqual(["subject-c"]);
    expect(wallet).toHaveBeenCalledWith(
      adapter.raw,
      "evm.base-sepolia",
      `0x${"11".repeat(20)}`,
    );
  });

  it("fails closed when the current Demos SDK lacks a reverse resolver", async () => {
    const adapter = makeAdapter();
    Object.assign(adapter, { connected: true });

    await expect(
      adapter.findSubjectsByClaim("domain:alice.example"),
    ).rejects.toThrow(/domain reverse lookup is not exposed/);
    await expect(
      adapter.findSubjectsByClaim(`cci-nomis:0x${"11".repeat(20)}`),
    ).rejects.toThrow(/not a reverse-resolvable/);
  });

  it("anchorWriteOnce returns only an exact existing envelope", async () => {
    const adapter = makeAdapter();
    Object.assign(adapter, { connected: true });
    vi.spyOn(adapter.raw, "getAddress").mockReturnValue("0xWriter");
    vi.spyOn(adapter, "resolveAnchorByName").mockResolvedValue({
      status: "present",
      address: "stor-existing",
    });
    vi.spyOn(adapter, "readAnchor").mockResolvedValue({
      serviceId: "svc",
      description: "original",
      signature: "old-signature",
    });

    await expect(
      adapter.anchorWriteOnce("listing-v1", {
        serviceId: "svc",
        description: "original",
        signature: "old-signature",
      }),
    ).resolves.toEqual({ address: "stor-existing" });
    await expect(
      adapter.anchorWriteOnce("listing-v1", {
        serviceId: "svc",
        description: "original",
        signature: "retry-signature",
      }),
    ).rejects.toThrow(/different exact content/);
    await expect(
      adapter.anchorWriteOnce("listing-v1", {
        serviceId: "svc",
        description: "changed",
        signature: "new-signature",
      }),
    ).rejects.toThrow(/different exact content/);
  });

  it("anchorWriteOnce fails closed on indeterminate owner-bound lookup", async () => {
    const adapter = makeAdapter();
    Object.assign(adapter, { connected: true });
    vi.spyOn(adapter.raw, "getAddress").mockReturnValue("0xWriter");
    vi.spyOn(adapter, "resolveAnchorByName").mockResolvedValue({
      status: "indeterminate",
      reason: "candidate unreadable",
    });
    const read = vi.spyOn(adapter, "readAnchor");

    await expect(
      adapter.anchorWriteOnce("listing-v1", { serviceId: "svc" }),
    ).rejects.toThrow(/indeterminate/);
    expect(read).not.toHaveBeenCalled();
  });

  it("anchorWriteOnce compares requested descriptive metadata on retry", async () => {
    const adapter = makeAdapter();
    Object.assign(adapter, { connected: true });
    vi.spyOn(adapter.raw, "getAddress").mockReturnValue("0xWriter");
    vi.spyOn(adapter, "resolveAnchorByName").mockResolvedValue({
      status: "present",
      address: "stor-existing",
    });
    const readMetadata = vi.spyOn(
      adapter.raw.storagePrograms,
      "read",
    ).mockResolvedValue({
      success: true,
      data: { serviceId: "svc" },
      metadata: { logicalAddress: "dacs1:seller:svc:v1", source: "catalog" },
    } as never);

    await expect(
      adapter.anchorWriteOnce(
        "listing-v1",
        { serviceId: "svc" },
        {
          metadata: {
            source: "catalog",
            logicalAddress: "dacs1:seller:svc:v1",
          },
        },
      ),
    ).resolves.toEqual({ address: "stor-existing" });

    await expect(
      adapter.anchorWriteOnce(
        "listing-v1",
        { serviceId: "svc" },
        { metadata: { logicalAddress: "dacs1:seller:svc:v2" } },
      ),
    ).rejects.toThrow(/different descriptive metadata/);

    readMetadata.mockResolvedValueOnce({
      success: true,
      data: { serviceId: "svc" },
      metadata: null,
    } as never);
    await expect(
      adapter.anchorWriteOnce(
        "listing-v1",
        { serviceId: "svc" },
        { metadata: { logicalAddress: "dacs1:seller:svc:v1" } },
      ),
    ).rejects.toThrow(/different descriptive metadata/);

    readMetadata.mockResolvedValueOnce({
      success: true,
      data: { serviceId: "svc" },
      metadata: [],
    } as never);
    await expect(
      adapter.anchorWriteOnce(
        "listing-v1",
        { serviceId: "svc" },
        { metadata: { logicalAddress: "dacs1:seller:svc:v1" } },
      ),
    ).rejects.toThrow(/malformed metadata/);
  });

  it("anchorWriteOnce rejects array metadata at the runtime boundary", async () => {
    const adapter = makeAdapter();
    Object.assign(adapter, { connected: true });
    await expect(
      adapter.anchorWriteOnce(
        "listing-v1",
        { serviceId: "svc" },
        { metadata: [] as unknown as Record<string, unknown> },
      ),
    ).rejects.toThrow(/metadata must be a JSON object/);
  });

  it("serializes concurrent immutable publication through the full adapter seam", async () => {
    const adapter = makeAdapter();
    Object.assign(adapter, { connected: true });
    vi.spyOn(adapter.raw, "getAddress").mockReturnValue("0xWriter");
    const resolve = vi.spyOn(adapter, "resolveAnchorByName").mockResolvedValue({
      status: "present",
      address: "stor-existing",
    });

    let releaseFirstRead!: () => void;
    const firstReadBlocked = new Promise<Record<string, unknown>>(
      (resolveRead) => {
        releaseFirstRead = () =>
          resolveRead({ serviceId: "svc", signature: "old-signature" });
      },
    );
    vi.spyOn(adapter, "readAnchor")
      .mockReturnValueOnce(firstReadBlocked)
      .mockResolvedValue({ serviceId: "svc", signature: "old-signature" });

    const first = adapter.anchorWriteOnce("listing-v1", {
      serviceId: "svc",
      signature: "old-signature",
    });
    const second = adapter.anchorWriteOnce("listing-v1", {
      serviceId: "svc",
      signature: "old-signature",
    });

    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    releaseFirstRead();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { address: "stor-existing" },
      { address: "stor-existing" },
    ]);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("creates only, then waits for authenticated canonical native readback", async () => {
    const adapter = makeAdapter();
    Object.assign(adapter, { connected: true });
    const owner = "0xWriter";
    const name = "listing-v1";
    const value = { serviceId: "svc", signature: "sig" };
    const address = StorageProgram.deriveStorageAddress(owner, name, 1, "");

    vi.spyOn(adapter.raw, "getAddress").mockReturnValue(owner);
    vi.spyOn(
      adapter as unknown as { nextAnchorNonce(): Promise<number> },
      "nextAnchorNonce",
    ).mockResolvedValue(1);
    vi.spyOn(adapter, "resolveAnchorByName")
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValueOnce({ status: "present", address });
    vi.spyOn(adapter.raw, "getAddressNonce").mockResolvedValue(1);
    vi.spyOn(adapter.raw, "nodeCall").mockResolvedValue({
      state: "included",
    } as never);
    vi.spyOn(adapter.raw, "getTxByHash").mockResolvedValue({
      status: "confirmed",
      hash: "tx-create",
      blockNumber: 42,
    } as never);
    vi.spyOn(adapter.raw, "getBlockByNumber").mockResolvedValue({
      number: 42,
      hash: "block-42",
      status: "confirmed",
      content: { timestamp: 120, ordered_transactions: ["tx-create"] },
      validation_data: { signatures: ["validator-test-signature"] },
    } as never);
    vi.spyOn(adapter.raw.storagePrograms, "read").mockResolvedValue({
      success: true,
      storageAddress: address,
      owner,
      programName: name,
      data: value,
      metadata: { logicalAddress: "dacs1:seller:svc:v1" },
      createdByTx: "tx-create",
      interactionTxs: ["tx-create"],
    } as never);
    const sign = vi.spyOn(adapter.raw.storagePrograms, "sign").mockImplementation(
      async (payload: unknown) => {
        const write = payload as Record<string, unknown>;
        return {
          hash: "tx-create",
          content: {
            type: "storageProgram",
            from: owner,
            to: write.storageAddress,
            nonce: 1,
            data: ["storageProgram", write],
          },
        } as never;
      },
    );
    vi.spyOn(adapter.raw.tx, "confirm").mockImplementation(
      async (payload: unknown) => payload as never,
    );
    vi.spyOn(adapter.raw, "broadcastAndWait").mockResolvedValue({
      broadcast: { response: { hash: "tx-create" } },
      status: { state: "included", blockNumber: 42 },
    } as never);
    const progress: Array<{ state: string; timings: { elapsedMs: number } }> = [];

    await expect(
      adapter.anchorWriteOnce(name, value, {
        timeoutMs: 20,
        pollMs: 0,
        metadata: { logicalAddress: "dacs1:seller:svc:v1" },
        onProgress: (receipt) => progress.push({
          state: receipt.state,
          timings: { elapsedMs: receipt.timings.elapsedMs },
        }),
      }),
    ).resolves.toMatchObject({
      address,
      txRef: "tx-create",
      demosEvidence: {
        transactionRef: "tx-create",
        blockHash: "block-42",
        blockTimestamp: 120_000,
        nativeAddress: address,
      },
    });
    expect(sign).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { logicalAddress: "dacs1:seller:svc:v1" },
      }),
      { nonce: 1 },
    );
    expect(progress.at(-1)).toMatchObject({
      state: "read-visible",
      timings: { elapsedMs: expect.any(Number) },
    });
  });

  it("serializes two adapter instances sharing a wallet and rejects different content", async () => {
    const sharedJournal = createInMemoryDemosWriteJournal();
    const adapters = [
      makeAdapter(sharedJournal),
      makeAdapter(sharedJournal),
    ];
    const owner = "0xWriter";
    const name = "listing-v1";
    const address = StorageProgram.deriveStorageAddress(owner, name, 1, "");
    let winner: Record<string, unknown> | null = null;

    const resolveByName = async () =>
      winner
        ? { status: "present" as const, address }
        : { status: "absent" as const };
    const broadcast = async (validity: unknown) => {
      const candidate = (
        validity as {
          content: { data: [string, { data: Record<string, unknown> }] };
        }
      ).content.data[1].data;
      if (!winner) {
        winner = candidate;
        return {
          broadcast: { response: { hash: "tx-winner" } },
          status: { state: "included" as const },
        };
      }
      throw new Error("nonce already consumed by concurrent publisher");
    };

    for (const adapter of adapters) {
      Object.assign(adapter, { connected: true });
      vi.spyOn(adapter.raw, "getAddress").mockReturnValue(owner);
      vi.spyOn(
        adapter as unknown as { nextAnchorNonce(): Promise<number> },
        "nextAnchorNonce",
      ).mockResolvedValue(1);
      vi.spyOn(adapter, "resolveAnchorByName").mockImplementation(
        resolveByName,
      );
      vi.spyOn(adapter, "readAnchor").mockImplementation(async () => winner);
      vi.spyOn(adapter.raw.storagePrograms, "read").mockImplementation(
        async () => ({
          success: true,
          storageAddress: address,
          owner,
          programName: name,
          data: winner,
          createdByTx: "tx-winner",
          interactionTxs: ["tx-winner"],
        }) as never,
      );
      vi.spyOn(adapter.raw, "getAddressNonce").mockResolvedValue(1);
      vi.spyOn(adapter.raw, "nodeCall").mockResolvedValue({
        state: "included",
      } as never);
      vi.spyOn(adapter.raw, "getTxByHash").mockResolvedValue({
        status: "confirmed",
        hash: "tx-winner",
        blockNumber: 42,
      } as never);
      vi.spyOn(adapter.raw, "getBlockByNumber").mockResolvedValue({
        number: 42,
        hash: "block-42",
        status: "confirmed",
        content: { timestamp: 120, ordered_transactions: ["tx-winner"] },
        validation_data: { signatures: ["validator-test-signature"] },
      } as never);
      vi.spyOn(adapter.raw.storagePrograms, "sign").mockImplementation(
        async (payload: unknown) => {
          const write = payload as Record<string, unknown>;
          return {
            hash: "tx-winner",
            content: {
              type: "storageProgram",
              from: owner,
              to: write.storageAddress,
              nonce: 1,
              data: ["storageProgram", write],
            },
          } as never;
        },
      );
      vi.spyOn(adapter.raw.tx, "confirm").mockImplementation(
        async (payload: unknown) => payload as never,
      );
      vi.spyOn(adapter.raw.tx, "broadcast").mockImplementation(
        broadcast as never,
      );
    }

    const results = await Promise.allSettled([
      adapters[0]!.anchorWriteOnce(
        name,
        { serviceId: "svc", description: "first", signature: "sig-a" },
        { timeoutMs: 50, pollMs: 0 },
      ),
      adapters[1]!.anchorWriteOnce(
        name,
        { serviceId: "svc", description: "second", signature: "sig-b" },
        { timeoutMs: 50, pollMs: 0 },
      ),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: expect.stringMatching(/different exact content/),
      }),
    });
    expect(
      adapters.reduce(
        (count, adapter) =>
          count + vi.mocked(adapter.raw.tx.broadcast).mock.calls.length,
        0,
      ),
    ).toBe(1);
  });

  it("preserves lookup failure as indeterminate instead of false absence", async () => {
    const adapter = makeAdapter();
    Object.assign(adapter, { connected: true });
    vi.spyOn(adapter.raw, "getAddress").mockReturnValue("0xWriter");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("RPC connection reset")),
    );

    await expect(
      adapter.scanOwnAnchorsByNamePrefix("listing-prefix-v"),
    ).resolves.toEqual({
      status: "indeterminate",
      reason: expect.stringMatching(/RPC connection reset/),
    });
    await expect(
      adapter.resolveAnchorByName("listing-v1", "0xWriter"),
    ).resolves.toEqual({
      status: "indeterminate",
      reason: expect.stringMatching(/RPC connection reset/),
    });
  });

  it("scans the exact prefix and returns only readable anchors owned by this writer", async () => {
    const adapter = makeAdapter();
    Object.assign(adapter, { connected: true });
    vi.spyOn(adapter.raw, "getAddress").mockReturnValue("0xWriter");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          result: 200,
          response: [
            {
              storageAddress: "stor-mine",
              programName: "listing-prefix-v1",
            },
            {
              storageAddress: "stor-other",
              programName: "listing-prefix-v1",
            },
            {
              storageAddress: "stor-substring",
              programName: "not-listing-prefix-v1",
            },
          ],
        }),
      }),
    );
    vi.spyOn(adapter.raw.storagePrograms, "read").mockImplementation(
      async (address: string) =>
        ({
          success: true,
          owner: address === "stor-mine" ? "0xWriter" : "0xOther",
          programName:
            address === "stor-substring"
              ? "not-listing-prefix-v1"
              : "listing-prefix-v1",
          data: { listingVersion: 1 },
        }) as never,
    );

    await expect(
      adapter.scanOwnAnchorsByNamePrefix("listing-prefix-v"),
    ).resolves.toEqual({
      status: "ok",
      anchors: [
        {
          address: "stor-mine",
          programName: "listing-prefix-v1",
          value: { listingVersion: 1 },
        },
      ],
    });
  });
});
