import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageProgram } from "@kynesyslabs/demosdk/storage";

// DemosAdapter lives on the substrate subpath, not the top-level barrel (the
// barrel stays demosdk-free for plain-Node-ESM consumers — #1/F1).
import { DemosAdapter } from "../../src/substrate/index.js";

const RPC = "https://node2.demos.sh";

describe("DemosAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("requires an rpc url", () => {
    // @ts-expect-error — exercising the runtime guard
    expect(() => new DemosAdapter({})).toThrow(/rpc/);
  });

  it("constructs and exposes the raw demosdk instance", () => {
    const adapter = new DemosAdapter({ rpc: RPC });
    expect(adapter.raw).toBeDefined();
  });

  it("getAddress throws before connect", () => {
    const adapter = new DemosAdapter({ rpc: RPC });
    expect(() => adapter.getAddress()).toThrow(/not connected/);
  });

  it("substrate ops require a connection", async () => {
    const adapter = new DemosAdapter({ rpc: RPC });
    await expect(adapter.anchor("dacs:test", { a: 1 })).rejects.toThrow(
      /not connected/,
    );
    await expect(
      adapter.anchorWriteOnce("dacs:test:immutable", { a: 1 }),
    ).rejects.toThrow(/not connected/);
    await expect(
      adapter.scanOwnAnchorsByNamePrefix("dacs:test:v"),
    ).rejects.toThrow(/not connected/);
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

  it("anchorWriteOnce returns only a signed-scope-identical existing value", async () => {
    const adapter = new DemosAdapter({ rpc: RPC });
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
        signature: "retry-signature",
      }),
    ).resolves.toEqual({ address: "stor-existing" });
    await expect(
      adapter.anchorWriteOnce("listing-v1", {
        serviceId: "svc",
        description: "changed",
        signature: "new-signature",
      }),
    ).rejects.toThrow(/different signed-scope content/);
  });

  it("anchorWriteOnce fails closed on indeterminate owner-bound lookup", async () => {
    const adapter = new DemosAdapter({ rpc: RPC });
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

  it("serializes concurrent immutable publication through the full adapter seam", async () => {
    const adapter = new DemosAdapter({ rpc: RPC });
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
      signature: "first-retry",
    });
    const second = adapter.anchorWriteOnce("listing-v1", {
      serviceId: "svc",
      signature: "second-retry",
    });

    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    releaseFirstRead();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { address: "stor-existing" },
      { address: "stor-existing" },
    ]);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("creates only, then waits for exact bytes and unique name-index visibility", async () => {
    const adapter = new DemosAdapter({ rpc: RPC });
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
    vi.spyOn(adapter, "readAnchor").mockResolvedValue(value);
    vi.spyOn(adapter.raw, "getAddressNonce").mockResolvedValue(1);
    vi.spyOn(adapter.raw, "nodeCall").mockResolvedValue({
      state: "included",
    } as never);
    vi.spyOn(adapter.raw.storagePrograms, "sign").mockImplementation(
      async (payload: unknown) =>
        ({
          ...(payload as Record<string, unknown>),
          hash: "tx-create",
          content: { nonce: 1 },
        }) as never,
    );
    vi.spyOn(adapter.raw.tx, "confirm").mockImplementation(
      async (payload: unknown) => payload as never,
    );
    vi.spyOn(adapter.raw, "broadcastAndWait").mockResolvedValue({
      broadcast: { response: { hash: "tx-create" } },
      status: { state: "included", blockNumber: 42 },
    } as never);

    await expect(
      adapter.anchorWriteOnce(name, value, { timeoutMs: 20, pollMs: 0 }),
    ).resolves.toEqual({ address, txRef: "tx-create" });
  });

  it("serializes two adapter instances sharing a wallet and rejects different content", async () => {
    const adapters = [
      new DemosAdapter({ rpc: RPC }),
      new DemosAdapter({ rpc: RPC }),
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
      const candidate = (validity as { data: Record<string, unknown> }).data;
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
      vi.spyOn(adapter.raw, "getAddressNonce").mockResolvedValue(1);
      vi.spyOn(adapter.raw, "nodeCall").mockResolvedValue({
        state: "included",
      } as never);
      vi.spyOn(adapter.raw.storagePrograms, "sign").mockImplementation(
        async (payload: unknown) =>
          ({
            ...(payload as Record<string, unknown>),
            hash: "tx-winner",
            content: { nonce: 1 },
          }) as never,
      );
      vi.spyOn(adapter.raw.tx, "confirm").mockImplementation(
        async (payload: unknown) => payload as never,
      );
      vi.spyOn(adapter.raw, "broadcastAndWait").mockImplementation(
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
        message: expect.stringMatching(/different signed-scope content/),
      }),
    });
    expect(
      adapters.reduce(
        (count, adapter) =>
          count + vi.mocked(adapter.raw.broadcastAndWait).mock.calls.length,
        0,
      ),
    ).toBe(1);
  });

  it("preserves lookup failure as indeterminate instead of false absence", async () => {
    const adapter = new DemosAdapter({ rpc: RPC });
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
    const adapter = new DemosAdapter({ rpc: RPC });
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
