import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageProgram } from "@kynesyslabs/demosdk/storage";
import { Identities } from "@kynesyslabs/demosdk/abstraction";

// DemosAdapter lives on the substrate subpath, not the top-level barrel (the
// barrel stays demosdk-free for plain-Node-ESM consumers — #1/F1).
import {
  DemosAdapter,
  createInMemoryDemosWriteJournal,
} from "../../src/substrate/index.js";
import {
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";

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

  it("rejects an invalid confirmed-fee ceiling", () => {
    expect(() => new DemosAdapter({
      rpc: RPC,
      maximumFeeOs: -1n,
    })).toThrow(/maximumFeeOs/);
  });

  it("constructs and exposes the raw demosdk instance", () => {
    const adapter = makeAdapter();
    expect(adapter.raw).toBeDefined();
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

  it("signs arbitrary binary bytes without demosdk UTF-8 coercion", async () => {
    const adapter = makeAdapter();
    Object.assign(adapter, { connected: true });
    const seed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const publicKey = rawPublicKey(publicKeyFromSeed(seed));
    const privateKey = Buffer.concat([Buffer.from(seed), Buffer.from(publicKey)]);
    const crypto = (adapter.raw as unknown as {
      crypto: {
        getIdentity(algorithm: string): Promise<unknown>;
        sign(algorithm: string, bytes: Uint8Array): Promise<unknown>;
      };
    }).crypto;
    vi.spyOn(crypto, "getIdentity").mockResolvedValue({ privateKey, publicKey });
    const sdkSign = vi.spyOn(crypto, "sign");
    const bytes = Uint8Array.from([0xff, 0x00, 0x80, 0x61, 0xc3, 0x28]);

    const signature = await adapter.sign(bytes);

    expect(signature).toHaveLength(64);
    expect(ed25519Verify(bytes, signature, privateKeyFromSeed(seed))).toBe(true);
    expect(sdkSign).not.toHaveBeenCalled();
  });

  it("fails closed when the Demos private and public signing keys disagree", async () => {
    const adapter = makeAdapter();
    Object.assign(adapter, { connected: true });
    const seed = new Uint8Array(32).fill(7);
    const publicKey = rawPublicKey(publicKeyFromSeed(new Uint8Array(32).fill(8)));
    const crypto = (adapter.raw as unknown as {
      crypto: { getIdentity(algorithm: string): Promise<unknown> };
    }).crypto;
    vi.spyOn(crypto, "getIdentity").mockResolvedValue({
      privateKey: Buffer.concat([Buffer.from(seed), Buffer.from(publicKey)]),
      publicKey,
    });

    await expect(adapter.sign(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /does not match its public key/,
    );
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
      adapter.findSubjectsByClaim("web2:twitter:alice"),
    ).rejects.toThrow(/not connected/);
  });

  it("resolves a primary Demos agent DID from its self-certifying key", async () => {
    const adapter = makeAdapter();
    Object.assign(adapter, { connected: true });
    const registryLookup = vi.spyOn(Identities.prototype, "getIdentities");
    const publicKey = "ab".repeat(32);
    const ref = `did:demos:agent:${publicKey}`;

    await expect(adapter.resolveIdentity(ref)).resolves.toEqual({
      ref,
      boundTo: ref,
      raw: {
        profile: "demos-primary-self-certifying:v1",
        publicKey,
      },
    });
    expect(registryLookup).not.toHaveBeenCalled();
  });

  it("retains GCR resolution for identities that are not self-certifying", async () => {
    const adapter = makeAdapter();
    Object.assign(adapter, { connected: true });
    const raw = { result: 200, response: { web2: {} } };
    const registryLookup = vi.spyOn(Identities.prototype, "getIdentities")
      .mockResolvedValue(raw as never);

    await expect(adapter.resolveIdentity("legacy-demos-address")).resolves.toEqual({
      ref: "legacy-demos-address",
      boundTo: "legacy-demos-address",
      raw,
    });
    expect(registryLookup).toHaveBeenCalledWith(
      adapter.raw,
      "getIdentities",
      "legacy-demos-address",
    );
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
    const owner = "ab".repeat(32);
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
