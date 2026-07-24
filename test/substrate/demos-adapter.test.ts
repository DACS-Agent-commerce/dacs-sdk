import { describe, expect, it, vi } from "vitest";

// DemosAdapter lives on the substrate subpath, not the top-level barrel (the
// barrel stays demosdk-free for plain-Node-ESM consumers — #1/F1).
import { createHash } from "node:crypto";
import { DemosAdapter } from "../../src/substrate/index.js";
import { confirmWithRetry, ensureUtf8TransactionHash } from "../../src/substrate/DemosAdapter.js";

const RPC = "https://node2.demos.sh";

describe("DemosAdapter", () => {
  function connectedAdapter(options: {
    reads?: Array<unknown>;
    broadcasts?: Array<unknown>;
  } = {}) {
    const adapter = new DemosAdapter({ rpc: RPC });
    (adapter as unknown as { connected: boolean }).connected = true;
    const raw = adapter.raw as any;
    raw.getAddress = vi.fn(() => "0x" + "a".repeat(64));
    const reads = [...(options.reads ?? [])];
    raw.storagePrograms.read = vi.fn(async () => reads.shift() ?? { success: false });
    raw.storagePrograms.sign = vi.fn(async (payload: unknown, signOptions?: { nonce?: number }) => {
      const content = { nonce: signOptions?.nonce ?? 7, payload };
      return {
        content,
        hash: createHash("sha256").update(JSON.stringify(content), "utf8").digest("hex"),
      };
    });
    raw.tx.confirm = vi.fn(async (signed: unknown) => signed);
    const broadcasts = [...(options.broadcasts ?? [{
      result: 200,
      response: { hash: "b".repeat(64) },
    }])];
    raw.tx.broadcast = vi.fn(async () => broadcasts.shift());
    return { adapter, raw };
  }

  it("bounds a stalled confirmTx attempt and retries without waiting indefinitely", async () => {
    let calls = 0;
    const result = await confirmWithRetry(async () => {
      calls += 1;
      if (calls === 1) return new Promise<string>(() => undefined);
      return "confirmed";
    }, { attempts: 2, timeoutMs: 5, retryDelayMs: 0 });
    expect(result).toBe("confirmed");
    expect(calls).toBe(2);
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

  it("re-hashes and re-signs non-ASCII transaction content as UTF-8", async () => {
    const content = { data: ["storageProgram", { report: "eval() — dynamic code execution" }] };
    const transaction = {
      content,
      hash: "legacy-single-byte-hash",
      signature: { type: "ed25519", data: "old" },
    };
    const signed: Array<{ algorithm: string; bytes: Uint8Array }> = [];
    const signer = {
      algorithm: "ed25519",
      crypto: {
        async sign(algorithm: string, bytes: Uint8Array) {
          signed.push({ algorithm, bytes });
          return { signature: new Uint8Array([0xab, 0xcd]) };
        },
      },
    };

    const repaired = await ensureUtf8TransactionHash(transaction, signer);
    const expected = createHash("sha256")
      .update(JSON.stringify(content), "utf8")
      .digest("hex");
    expect(repaired.hash).toBe(expected);
    expect(repaired.signature).toEqual({ type: "ed25519", data: "abcd" });
    expect(signed).toHaveLength(1);
    expect(new TextDecoder().decode(signed[0]!.bytes)).toBe(expected);
  });

  it("does not re-sign a transaction whose UTF-8 hash is already correct", async () => {
    const content = { value: "ASCII-only anchor" };
    const hash = createHash("sha256").update(JSON.stringify(content), "utf8").digest("hex");
    let signCalls = 0;
    const transaction = { content, hash, signature: { type: "ed25519", data: "existing" } };
    const repaired = await ensureUtf8TransactionHash(transaction, {
      algorithm: "ed25519",
      crypto: {
        async sign() {
          signCalls += 1;
          return { signature: new Uint8Array() };
        },
      },
    });
    expect(repaired).toBe(transaction);
    expect(signCalls).toBe(0);
  });

  it("creates a known-new slot without waiting for a storage read", async () => {
    const { adapter, raw } = connectedAdapter();
    const result = await adapter.anchor("fresh-job-slot", { result: 42 }, {
      nonce: 11,
      writeMode: "known-new",
    });
    expect(result.nonce).toBe(11);
    expect(result.transactionContent?.nonce).toBe(11);
    expect(raw.storagePrograms.read).not.toHaveBeenCalled();
    expect(raw.tx.broadcast).toHaveBeenCalledTimes(1);
  });

  it("recovers a create collision only when existing content is identical", async () => {
    const value = { result: 42, source: "oracle" };
    const { adapter, raw } = connectedAdapter({
      reads: [{ success: true, data: { source: "oracle", result: 42 } }],
      broadcasts: [
        { result: 409, response: { message: "storage program exists" } },
        { result: 200, response: { hash: "c".repeat(64) } },
      ],
    });
    const result = await adapter.anchor("replayed-job-slot", value, {
      nonce: 12,
      writeMode: "known-new",
    });
    expect(result.nonce).toBe(12);
    expect(raw.storagePrograms.read).toHaveBeenCalledTimes(1);
    expect(raw.storagePrograms.sign).toHaveBeenCalledTimes(2);
    expect(raw.tx.broadcast).toHaveBeenCalledTimes(2);
  });

  it("fails closed when a known-new slot contains different content", async () => {
    const { adapter, raw } = connectedAdapter({
      reads: [{ success: true, data: { result: "different" } }],
      broadcasts: [{ result: 409, response: { message: "storage program exists" } }],
    });
    await expect(adapter.anchor("colliding-job-slot", { result: 42 }, {
      nonce: 13,
      writeMode: "known-new",
    })).rejects.toThrow(/anchor failed/);
    expect(raw.tx.broadcast).toHaveBeenCalledTimes(1);
  });
});
