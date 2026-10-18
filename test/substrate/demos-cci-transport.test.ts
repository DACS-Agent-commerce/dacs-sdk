import { readFileSync } from "node:fs";
import nodeHttp, { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import nodeHttps from "node:https";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent as UndiciAgent } from "undici";
import { Identities } from "@kynesyslabs/demosdk/abstraction";
import type { Demos } from "@kynesyslabs/demosdk/websdk";

import { sha256Hex } from "../../src/canonical/index.js";
import { DacsError, SubstrateError, TransientError, faultCategory } from "../../src/errors.js";
import { DEMOS_CCI_RESPONSE_LIMITS, parseCciRecord } from "../../src/identity/cci.js";
import { DemosAdapter, type DemosAdapterConfig } from "../../src/substrate/index.js";
import {
  DEMOS_CCI_PROXY_BYPASS,
  DEMOS_CCI_ROUTE_UNVERIFIED,
  fetchProxyMismatch,
  readDemosCciResponse,
  type NodeRouteState,
} from "../../src/substrate/demosCciTransport.js";
import { isNodeBuiltinFetch, isNodeDefaultAgent, isNodeDefaultDispatcher } from "../../src/substrate/nodeDefaultDispatcher.js";

const RPC = "https://node.example/rpc";
const PRIMARY = `did:demos:agent:${"11".repeat(32)}`;
const GCR = {
  result: 200,
  response: {
    xm: { evm: { mainnet: [{ address: `0x${"22".repeat(20)}` }] } },
    web2: { github: [{ username: "alice", userId: "1" }] },
    ud: [],
    pqc: {},
  },
};
const TOO_LARGE = "Demos GCR identity response exceeds maxResponseBytes";
const TIMEOUT = "Demos GCR identity read timed out";

function adapterFor(response: Response, maxBytes?: number) {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(response);
  const adapter = new DemosAdapter({
    rpc: RPC,
    identityFetch: transport,
    ...(maxBytes === undefined ? {} : { identityMaxResponseBytes: maxBytes }),
  });
  Object.assign(adapter, { connected: true });
  return { adapter, transport };
}

// A local node needs no proxy. NO_PROXY must name it rather than be blank:
// Node's proxy agent, if the run started with one, re-reads NO_PROXY per request.
function stubLocalNodeEnvironment() {
  for (const name of ["http_proxy", "https_proxy", "all_proxy"]) {
    vi.stubEnv(name, "");
    vi.stubEnv(name.toUpperCase(), "");
  }
  vi.stubEnv("no_proxy", "127.0.0.1,localhost");
  vi.stubEnv("NO_PROXY", "127.0.0.1,localhost");
}

function streamedResponse(chunks: Uint8Array[], contentLength: string | null) {
  const cancel = vi.fn();
  let reads = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[reads++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
    cancel,
  }, { highWaterMark: 0 });
  const response = new Response(body, {
    headers: contentLength === null ? {} : { "Content-Length": contentLength },
  });
  return { response, cancel, reads: () => reads };
}

describe("Demos CCI raw response boundary", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([null, "1", "invalid"])(
    "rejects before decoding and stops reading with content-length %s",
    async (contentLength) => {
      const stream = streamedResponse([
        new TextEncoder().encode("{\"ignored\":\""),
        new TextEncoder().encode("x".repeat(16)),
        new TextEncoder().encode("invalid JSON must never be read"),
      ], contentLength);
      const { adapter } = adapterFor(stream.response, 16);
      const utf8Decoder = vi.spyOn(TextDecoder.prototype, "decode");

      const error = await adapter.resolveIdentity("subject").catch((error: unknown) => error);

      expect(utf8Decoder).not.toHaveBeenCalled();
      expect(error).toBeInstanceOf(DacsError);
      expect(error).toMatchObject({ message: TOO_LARGE, category: "permanent" });
      expect(error).not.toHaveProperty("cause");
      expect(stream.cancel).toHaveBeenCalledOnce();
      expect(stream.reads()).toBe(2);
      expect(stream.response.body?.locked).toBe(false);
    },
  );

  it("rejects an excessive declared length without reading the body", async () => {
    const stream = streamedResponse([new TextEncoder().encode("invalid JSON")], "17");
    const { adapter } = adapterFor(stream.response, 16);
    const decoder = vi.spyOn(TextDecoder.prototype, "decode");
    await expect(adapter.resolveIdentity("subject")).rejects.toThrow(TOO_LARGE);
    expect(decoder).not.toHaveBeenCalled();
    expect(stream.reads()).toBe(0);
    expect(stream.cancel).toHaveBeenCalledOnce();
  });

  it("enforces the default 2 MiB ceiling without a length header", async () => {
    const stream = streamedResponse([
      new Uint8Array(DEMOS_CCI_RESPONSE_LIMITS.maxEncodedBytes),
      new Uint8Array(1),
      new Uint8Array(1),
    ], null);
    const { adapter } = adapterFor(stream.response);
    await expect(adapter.resolveIdentity("subject")).rejects.toThrow(TOO_LARGE);
    expect(stream.reads()).toBe(2);
    expect(stream.cancel).toHaveBeenCalledOnce();
  });

  it.each([false, true])("admits a valid GCR body exactly at the ceiling (default: %s)", async (useDefault) => {
    const json = JSON.stringify(GCR);
    const limit = useDefault ? DEMOS_CCI_RESPONSE_LIMITS.maxEncodedBytes : Buffer.byteLength(json);
    const text = json.padEnd(limit, " ");
    const bytes = new TextEncoder().encode(text);
    const stream = streamedResponse([bytes.subarray(0, 23), bytes.subarray(23)], String(limit));
    const { adapter, transport } = adapterFor(stream.response, useDefault ? undefined : limit);

    const result = await adapter.resolveIdentity("subject");

    expect(result).toEqual({ ref: "subject", boundTo: "subject", raw: GCR });
    const parsed = parseCciRecord(PRIMARY, result.raw);
    expect(parsed.wallets[0]?.ref).toBe(`cci-xm:evm:mainnet:0x${"22".repeat(20)}`);
    expect(parsed.web2[0]?.ref).toBe("cci-web2:github:alice");
    expect(stream.cancel).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledWith(RPC, {
      method: "POST",
      redirect: "manual",
      signal: expect.any(AbortSignal),
      headers: {
        "Content-Type": "application/json",
        identity: "ed25519:",
        signature: "",
        timestamp: "",
      },
      body: JSON.stringify({
        method: "gcr_routine",
        params: [{ method: "getIdentities", params: ["subject"] }],
      }),
    });
  });

  it("bounds retained allocations for one-byte and empty transport chunks", async () => {
    const limit = 32_768;
    const byte = Uint8Array.of(0x20);
    const empty = new Uint8Array();
    let delivered = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (delivered === 2 * limit) { controller.close(); return; }
        const index = delivered++;
        if (index % 2 === 0) { controller.enqueue(empty); return; }
        const offset = Math.floor(index / 2);
        byte[0] = offset === 0 ? 0x7b : offset === limit - 1 ? 0x7d : 0x20;
        controller.enqueue(byte);
      },
    }, { highWaterMark: 0 });
    const response = new Response(body);
    const allocations: number[] = [];
    vi.stubGlobal("Uint8Array", new Proxy(Uint8Array, {
      construct(target, args) {
        const buffer = Reflect.construct(target, args) as Uint8Array;
        allocations.push(buffer.byteLength);
        return buffer;
      },
    }));

    await expect(readDemosCciResponse(
      RPC, "subject", async () => ({}), async () => response, limit, 5_000, 12_000,
    )).resolves.toEqual({});

    expect(delivered).toBe(2 * limit);
    expect(allocations.length).toBeLessThanOrEqual(4);
    expect(allocations.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(2 * limit);
    expect(response.body?.locked).toBe(false);
  });

  const MiB2 = DEMOS_CCI_RESPONSE_LIMITS.maxEncodedBytes;
  it.each<[string, number, number[], number[]]>([
    ["a small body under the default ceiling", MiB2, [300], [65_536]],
    ["a ceiling below 64 KiB", 1_000, [300, 700], [1_000]],
    ["chunks that double it up to the default ceiling", MiB2,
      [...Array<number>(52).fill(40_000), MiB2 - 52 * 40_000],
      [65_536, 131_072, 262_144, 524_288, 1_048_576, MiB2]],
    ["a chunk larger than twice the buffer", MiB2, [10, 300_000, 1], [65_536, 300_010, 600_020]],
    ["a ceiling that is not a power of two", 100_000, [40_000, 40_000, 20_000], [65_536, 100_000]],
  ])("grows its body buffer only as bytes arrive: %s", async (_case, maxBytes, sizes, expected) => {
    const total = sizes.reduce((sum, size) => sum + size, 0);
    const text = "0123456789abcdef".repeat(Math.ceil(total / 16)).slice(0, total - 2);
    const bytes = new TextEncoder().encode(JSON.stringify(text));
    const chunks = sizes.map((size, index) => {
      const offset = sizes.slice(0, index).reduce((sum, earlier) => sum + earlier, 0);
      return bytes.subarray(offset, offset + size);
    });
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
    }, { highWaterMark: 0 }));
    const allocations: number[] = [];
    vi.stubGlobal("Uint8Array", new Proxy(Uint8Array, {
      construct(target, args) {
        const buffer = Reflect.construct(target, args) as Uint8Array;
        allocations.push(buffer.byteLength);
        return buffer;
      },
    }));

    await expect(readDemosCciResponse(
      RPC, "subject", async () => ({}), async () => response, maxBytes, 5_000, 12_000,
    )).resolves.toBe(text);

    expect(allocations).toEqual(expected);
  });

  it("counts UTF-8 bytes rather than characters", async () => {
    const json = JSON.stringify({ response: { web2: { github: [{ username: "é" }] } } });
    const { adapter } = adapterFor(new Response(json), json.length);
    await expect(adapter.resolveIdentity("subject")).rejects.toThrow(TOO_LARGE);
  });

  it("preserves demosdk wallet authentication headers and signed message", async () => {
    const { adapter, transport } = adapterFor(new Response(JSON.stringify(GCR)));
    const demos = adapter.raw as unknown as Demos;
    vi.spyOn(demos, "walletConnected", "get").mockReturnValue(true);
    const keypair = { publicKey: Buffer.alloc(32, 0xab), privateKey: Buffer.alloc(64) };
    vi.spyOn(demos, "keypair", "get").mockReturnValue(keypair);
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const sign = vi.spyOn(demos.crypto, "sign").mockResolvedValue({
      signature: new Uint8Array([1, 2, 3]),
    } as never);

    await adapter.resolveIdentity("subject");

    const identity = `ed25519:0x${"ab".repeat(32)}`;
    expect(sign).toHaveBeenCalledWith("ed25519", new TextEncoder().encode(
      sha256Hex(`${identity}:1700000000000`),
    ));
    expect(transport.mock.calls[0]?.[1]?.headers).toEqual({
      "Content-Type": "application/json",
      identity,
      signature: "0x010203",
      timestamp: "1700000000000",
    });
  });

  it("compares rpcCall parity against the locked demosdk version", () => {
    // Re-check the parity tests below, then update this pin, when bumping demosdk.
    const manifest = JSON.parse(readFileSync(new URL(
      "../../node_modules/@kynesyslabs/demosdk/package.json", import.meta.url,
    ), "utf8")) as { version: string };
    expect(manifest.version).toBe("4.0.16");
  });

  it.each([
    { walletConnected: false, algorithm: "ed25519" },
    { walletConnected: true, algorithm: "ed25519" },
    { walletConnected: true, algorithm: "falcon" },
  ])(
    "sends the same request and headers as demosdk's real rpcCall (wallet connected: $walletConnected, $algorithm)",
    async ({ walletConnected, algorithm }) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const { adapter, transport } = adapterFor(new Response(JSON.stringify(GCR)));
      const demos = adapter.raw as unknown as Demos;
      // connect() hands config.rpc to demosdk unchanged; mirror that here.
      Object.assign(demos, { rpc_url: RPC, algorithm });
      vi.spyOn(demos, "walletConnected", "get").mockReturnValue(walletConnected);
      const keypair = { publicKey: Buffer.alloc(32, 0xab), privateKey: Buffer.alloc(64) };
      vi.spyOn(demos, "keypair", "get").mockReturnValue(keypair);
      // The signature echoes part of the signed message, so it also pins the hash input.
      const sign = vi.spyOn(demos.crypto, "sign").mockImplementation((async (
        _algorithm: string,
        message: Uint8Array,
      ) => ({ signature: Uint8Array.from(message.subarray(0, 8)) })) as never);
      const doPost = vi.spyOn(
        demos as unknown as { _doPost: (...args: unknown[]) => Promise<unknown> },
        "_doPost",
      ).mockResolvedValue({ data: GCR });

      transport.mockImplementation(async (url, init) => {
        // Compare each attempt at its current timestamp to real rpcCall output.
        await expect(new Identities().getIdentities(demos, "getIdentities", "subject"))
          .resolves.toEqual(GCR);
        const [demosUrl, demosRequest, demosHeaders] = doPost.mock.calls.at(-1)!;
        expect(url).toBe(demosUrl);
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(JSON.stringify(demosRequest));
        expect(init?.headers).toEqual(demosHeaders);
        return transport.mock.calls.length < 3
          ? new Response("discarded", { status: 503 })
          : new Response(JSON.stringify(GCR));
      });
      const result = adapter.resolveIdentity("subject").catch(error => error);
      await vi.advanceTimersByTimeAsync(750);
      await expect(result).resolves.toHaveProperty("raw", GCR);

      expect(transport).toHaveBeenCalledTimes(3);
      expect(doPost).toHaveBeenCalledTimes(3);
      expect(sign).toHaveBeenCalledTimes(walletConnected ? 6 : 0);
      if (walletConnected) {
        expect(sign.mock.calls[0]?.[0]).toBe(algorithm);
        expect((transport.mock.calls[0]?.[1]?.headers as Record<string, string>).identity)
          .toBe(`${algorithm}:0x${"ab".repeat(32)}`);
        const timestamps = transport.mock.calls.map(([, init]) =>
          (init?.headers as Record<string, string>).timestamp);
        expect(timestamps).toEqual(["1700000000000", "1700000000250", "1700000000750"]);
        for (let i = 0; i < 6; i += 2) {
          expect(sign.mock.calls[i + 1]).toEqual(sign.mock.calls[i]);
        }
      }
    },
  );

  it.each([0, -1, 1.5, NaN, Infinity, 2_097_153, null, "16"])(
    "rejects an unsafe configured byte ceiling: %s", (value) => {
      expect(() => new DemosAdapter({
        rpc: RPC,
        identityMaxResponseBytes: value,
      } as DemosAdapterConfig)).toThrow(/identityMaxResponseBytes/);
    },
  );

  it("captures stable transport configuration at construction", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(GCR)));
    const config = { rpc: RPC, identityFetch: transport, identityMaxResponseBytes: 1_024 };
    const adapter = new DemosAdapter(config);
    config.identityMaxResponseBytes = 1;
    config.identityFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error("changed transport"));
    Object.assign(adapter, { connected: true });
    await expect(adapter.resolveIdentity("subject")).resolves.toHaveProperty("raw", GCR);
    expect(transport).toHaveBeenCalledOnce();

    const accessor = { rpc: RPC };
    const getter = vi.fn(() => transport);
    Object.defineProperty(accessor, "identityFetch", { get: getter });
    expect(() => new DemosAdapter(accessor)).toThrow(/identityFetch.*stable data/);
    expect(getter).not.toHaveBeenCalled();
    expect(() => new DemosAdapter({ rpc: RPC, identityFetch: 1 } as unknown as DemosAdapterConfig))
      .toThrow(/identityFetch must be a function/);
  });

  it("fails closed on invalid JSON without retaining decoder text", async () => {
    const { adapter, transport } = adapterFor(new Response("invalid-json-sentinel"));
    const error = await adapter.resolveIdentity("subject").catch((error: unknown) => error);
    expect(error).toBeInstanceOf(DacsError);
    expect(error).toMatchObject({ message: "Demos GCR identity response is not valid UTF-8 JSON", category: "permanent" });
    expect(error).not.toHaveProperty("cause");
    expect(transport).toHaveBeenCalledOnce();
  });

  it("cancels HTTP error bodies and returns a substrate failure", async () => {
    const stream = streamedResponse([new Uint8Array(1)], null);
    const response = new Response(stream.response.body, { status: 500 });
    const { adapter, transport } = adapterFor(response);
    await expect(adapter.resolveIdentity("subject")).rejects.toBeInstanceOf(SubstrateError);
    expect(transport).toHaveBeenCalledOnce();
    expect(stream.reads()).toBe(0);
    expect(stream.cancel).toHaveBeenCalledOnce();
  });

  it("keeps self-certifying DID resolution local", async () => {
    const { adapter, transport } = adapterFor(new Response("unused"), 1);
    await expect(adapter.resolveIdentity(PRIMARY)).resolves.toHaveProperty("boundTo", PRIMARY);
    expect(transport).not.toHaveBeenCalled();
  });

  it("bounds delayed headers and trickling bodies with five-second attempt deadlines", async () => {
    vi.useFakeTimers();
    const { adapter, transport } = adapterFor(new Response("unused"), 16);
    const cancel = vi.fn();
    let emittedBytes = 0;
    transport.mockImplementation(() => new Promise<Response>((resolve) => {
      setTimeout(() => {
        let ticker: ReturnType<typeof setInterval>;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            ticker = setInterval(() => {
              emittedBytes += 1;
              controller.enqueue(Uint8Array.of(32));
            }, 1_000);
          },
          cancel() {
            clearInterval(ticker);
            cancel();
          },
        });
        resolve(new Response(body));
      }, 2_000);
    }));
    const decoder = vi.spyOn(TextDecoder.prototype, "decode");
    const result = adapter.resolveIdentity("subject").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const signal = transport.mock.calls[0]?.[1]?.signal;

    await vi.advanceTimersByTimeAsync(4_999);
    expect(emittedBytes).toBe(2);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10_752);
    const error = await result;

    // errors.ts: a timeout is transient, so retry policy may try again.
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ message: TIMEOUT, category: "transient" });
    expect(faultCategory(error)).toBe("transient");
    expect(error).not.toHaveProperty("cause");
    expect(signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(3);
    expect(transport).toHaveBeenCalledTimes(3);
    expect(decoder).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds stalled headers even when the transport ignores abort, cancelling a late body", async () => {
    vi.useFakeTimers();
    const stream = streamedResponse([new TextEncoder().encode("invalid JSON")], null);
    const { adapter, transport } = adapterFor(stream.response);
    const releaseHeaders: Array<(response: Response) => void> = [];
    transport.mockImplementation(() => new Promise<Response>((resolve) => {
      releaseHeaders.push(resolve);
    }));
    const decoder = vi.spyOn(TextDecoder.prototype, "decode");
    const result = adapter.resolveIdentity("subject").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const signal = transport.mock.calls[0]?.[1]?.signal;

    // Default overall deadline: 12 s, inside dacs-node's 15 s request timeout.
    await vi.advanceTimersByTimeAsync(12_000);
    const error = await result;

    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ message: TIMEOUT, category: "transient" });
    expect(error).not.toHaveProperty("cause");
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(transport).toHaveBeenCalledTimes(3);
    releaseHeaders[0]?.(stream.response);
    for (const release of releaseHeaders.slice(1)) release(new Response("late"));
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.reads()).toBe(0);
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(decoder).not.toHaveBeenCalled();
  });

  it("rejects at the deadline even if body cancellation never settles", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const { adapter, transport } = adapterFor(response);
    transport.mockImplementation(() => Promise.resolve(new Response(
      new ReadableStream<Uint8Array>({ cancel }),
    )));
    const result = adapter.resolveIdentity("subject").catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(12_000);

    expect(await result).toMatchObject({ message: TIMEOUT, category: "transient" });
    expect(cancel).toHaveBeenCalledTimes(3);
    expect(transport).toHaveBeenCalledTimes(3);
    for (const returned of transport.mock.results) {
      expect((await returned.value).body?.locked).toBe(false);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("admits a normal body inside the deadline and clears the request timer", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(GCR)));
          controller.close();
        }, 250);
      },
      cancel,
    }));
    const { adapter, transport } = adapterFor(response);
    const result = adapter.resolveIdentity("subject");
    await vi.advanceTimersByTimeAsync(0);
    const signal = transport.mock.calls[0]?.[1]?.signal;

    await vi.advanceTimersByTimeAsync(250);

    expect(await result).toEqual({ ref: "subject", boundTo: "subject", raw: GCR });
    expect(cancel).not.toHaveBeenCalled();
    expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(signal?.aborted).toBe(false);
  });

  it.each([
    { status: 200, redirected: true },
    { status: 300, redirected: false },
    { status: 302, redirected: false },
    { status: 399, redirected: false },
  ])("refuses redirects before reading: $status / redirected=$redirected", async ({ status, redirected }) => {
    const stream = streamedResponse([new TextEncoder().encode("invalid JSON")], null);
    const response = new Response(stream.response.body, { status });
    vi.spyOn(response, "redirected", "get").mockReturnValue(redirected);
    const { adapter, transport } = adapterFor(response);
    const decoder = vi.spyOn(TextDecoder.prototype, "decode");

    const error = await adapter.resolveIdentity("subject").catch((error: unknown) => error);

    expect(error).toBeInstanceOf(DacsError);
    expect(error).toMatchObject({
      message: "Demos GCR identity response redirect refused",
      category: "permanent",
    });
    expect(error).not.toHaveProperty("cause");
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(stream.reads()).toBe(0);
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(decoder).not.toHaveBeenCalled();
  });

  it("reads a 299 response as a success, not a redirect", async () => {
    const { adapter } = adapterFor(new Response(JSON.stringify(GCR), { status: 299 }));
    await expect(adapter.resolveIdentity("subject")).resolves.toHaveProperty("raw", GCR);
  });

  it("replaces an ordinary transport failure with a fresh SubstrateError, without retrying", async () => {
    vi.useFakeTimers();
    const { adapter, transport } = adapterFor(new Response("unused"));
    transport.mockRejectedValue(new Error("transport failure"));

    const error = await adapter.resolveIdentity("subject").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SubstrateError);
    expect(error).toMatchObject({ message: "Demos GCR identity read failed", category: "substrate" });
    expect(error).not.toHaveProperty("cause");
    expect(transport).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails closed on invalid UTF-8 inside otherwise valid JSON", async () => {
    const bytes = Buffer.concat([
      Buffer.from('{"result":200,"response":{"web2":{"github":[{"username":"'),
      Buffer.from([0xff]),
      Buffer.from('","userId":"1"}]}}}'),
    ]);
    const { adapter } = adapterFor(new Response(bytes));
    const error = await adapter.resolveIdentity("subject").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DacsError);
    expect(error).toMatchObject({ message: "Demos GCR identity response is not valid UTF-8 JSON" });
  });

  it("sends the address byte-for-byte, as rpcCall does", async () => {
    const { adapter, transport } = adapterFor(new Response(JSON.stringify(GCR)));
    const address = `0x${"Ab".repeat(32)}`;
    await adapter.resolveIdentity(address);
    expect(transport.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({
      method: "gcr_routine", params: [{ method: "getIdentities", params: [address] }],
    }));
  });

  it("fails closed on a bodyless 204 response", async () => {
    const { adapter } = adapterFor(new Response(null, { status: 204 }));
    const error = await adapter.resolveIdentity("subject").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DacsError);
    expect(error).toMatchObject({ message: "Demos GCR identity response is not valid UTF-8 JSON" });
  });

  it.each(["1x", "x1", "1 2"])("ignores a non-numeric Content-Length %j and counts the body", async (length) => {
    const stream = streamedResponse([new TextEncoder().encode(JSON.stringify(GCR))], length);
    const { adapter } = adapterFor(stream.response);
    await expect(adapter.resolveIdentity("subject")).resolves.toHaveProperty("raw", GCR);
  });

  it("owns each chunk, so a transport that reuses its buffer cannot change retained bytes", async () => {
    const json = JSON.stringify(GCR);
    const text = json.padEnd(json.length + (json.length % 2), " ");
    const half = text.length / 2;
    const buffer = new Uint8Array(half);
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads === 2) return controller.close();
        buffer.set(new TextEncoder().encode(text.slice(reads * half, ++reads * half)));
        controller.enqueue(buffer);
      },
    }, { highWaterMark: 0 });
    const { adapter } = adapterFor(new Response(body));
    await expect(adapter.resolveIdentity("subject")).resolves.toHaveProperty("raw", GCR);
  });

  it.each([301, 302, 303, 307, 308])("refuses a bodyless %s redirect with the stable DacsError", async (status) => {
    const response = new Response(null, { status, headers: { Location: "https://elsewhere.example/" } });
    const { adapter, transport } = adapterFor(response);
    const error = await adapter.resolveIdentity("subject").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DacsError);
    expect(error).toMatchObject({ message: "Demos GCR identity response redirect refused" });
    expect(transport).toHaveBeenCalledOnce();
  });

  it("refuses an opaque redirect from a browser-style transport", async () => {
    const response = new Response(null, { status: 200 });
    vi.spyOn(response, "type", "get").mockReturnValue("opaqueredirect");
    const { adapter } = adapterFor(response);
    await expect(adapter.resolveIdentity("subject")).rejects.toMatchObject({
      message: "Demos GCR identity response redirect refused",
    });
  });

  it.each([
    { rpc: "https://user:secret-pass@node.example/rpc", credentials: "user:secret-pass" },
    // Axios percent-decodes each part before sending it.
    { rpc: "https://us%40er:p%3Ass%20w@node.example/rpc", credentials: "us@er:p:ss w" },
    { rpc: "https://user@node.example/rpc", credentials: "user:" },
    { rpc: "https://:secret@node.example/rpc", credentials: ":secret" },
    { rpc: "https://user:bad%ZZ@node.example/rpc", credentials: "user:bad%ZZ" },
  ])("sends RPC URL credentials $rpc as Basic auth on a credential-free URL", async ({ rpc, credentials }) => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(GCR)));
    const adapter = new DemosAdapter({ rpc, identityFetch: transport });
    Object.assign(adapter, { connected: true });
    await expect(adapter.resolveIdentity("subject")).resolves.toHaveProperty("raw", GCR);
    expect(transport.mock.calls[0]?.[0]).toBe(RPC);
    expect(transport.mock.calls[0]?.[1]?.headers).toEqual({
      "Content-Type": "application/json",
      identity: "ed25519:",
      signature: "",
      timestamp: "",
      Authorization: `Basic ${Buffer.from(credentials).toString("base64")}`,
    });
  });

  it.each([`0x${"Ab".repeat(32)}`, ` 0x${"ab".repeat(32)} `])(
    "sends ref %j byte for byte and returns it as ref and boundTo",
    async (ref) => {
      const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(GCR)));
      const adapter = new DemosAdapter({ rpc: RPC, identityFetch: transport });
      Object.assign(adapter, { connected: true });
      await expect(adapter.resolveIdentity(ref)).resolves.toMatchObject({ ref, boundTo: ref });
      expect(JSON.parse(transport.mock.calls[0]?.[1]?.body as string).params[0].params).toEqual([ref]);
    },
  );

  it("passes a credential-free RPC URL through unchanged, with no Authorization header", async () => {
    const rpc = "https://node.example";
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(GCR)));
    const adapter = new DemosAdapter({ rpc, identityFetch: transport });
    Object.assign(adapter, { connected: true });
    await adapter.resolveIdentity("subject");
    expect(transport.mock.calls[0]?.[0]).toBe(rpc);
    expect(transport.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");
  });
});

// Stand-ins named like the objects Node can have installed. Agent has the shape
// undici 6-8 leave on Node's default `new Agent()`: undici's default factory and
// options holding nothing but undefined values and undici 7-8's maxOrigins.
const kFactory = Symbol("factory");
const kOptions = Symbol("options");
// undici's defaultFactory as lib/dispatcher/agent.js writes it; the check reads
// only its source, so Client and Pool are never resolved.
const undiciDefaultFactory = new Function(
  "return function defaultFactory (origin, opts) {\n  return opts && opts.connections === 1\n" +
  "    ? new Client(origin, opts)\n    : new Pool(origin, opts)\n}",
)() as (...args: unknown[]) => unknown;
// A function with the source of Node 20-26's own global fetch, calling `impl`.
const nodeFetch = (impl: typeof fetch = vi.fn<typeof fetch>()): typeof fetch => new Function("fetchImpl",
  "return function fetch(input, init = undefined) {\n" +
  "    if (!fetchImpl) {\n      const undiciModule = require('internal/deps/undici/undici');\n" +
  "      fetchImpl = undiciModule.fetch;\n    }\n    return fetchImpl(input, init);\n  }",
)(impl) as typeof fetch;
class DispatcherBase {}
class Agent extends DispatcherBase {
  [kFactory]: unknown;
  [kOptions]: Record<string, unknown>;
  constructor({ factory = undiciDefaultFactory, maxOrigins = Infinity, connect = undefined,
    ...options }: Record<string, unknown> = {}) {
    super();
    this[kFactory] = factory;
    this[kOptions] = { ...options, maxOrigins, connect };
  }
}
class Dispatcher1Wrapper {}
class EnvHttpProxyAgent {}
class ProxyAgent {}
const plainAgents = () => [new nodeHttp.Agent(), new nodeHttps.Agent()];
// A global agent built under Node's proxy switch carries its startup snapshot.
const switchedAgent = (snapshot: Record<string, string> = {}) =>
  Object.assign(new Agent(), { options: { keepAlive: true, proxyEnv: snapshot } });
type Dispatchers = [unknown, unknown];
const routeState = (dispatchers: Dispatchers, agents: unknown[] = plainAgents(),
  execArgv: string[] = [], fetch: unknown = nodeFetch()): NodeRouteState => ({ fetch, dispatchers, agents, execArgv });
// Node's default dispatcher under undici.globalDispatcher.2 and .1, as each
// line leaves it once fetch has loaded (probed on 20.19, 22.23, 24.21, 26.11).
const DEFAULT_DISPATCHERS: Array<[string, Dispatchers]> = [
  ["before fetch loads", [undefined, undefined]],
  // undici 6 keeps no maxOrigins option.
  ["Node 20 and 22", [undefined, Object.assign(new Agent(), { [kOptions]: { connect: undefined, interceptors: undefined } })]],
  ["Node 24", [new Agent(), new Agent()]],
  ["Node 26", [new Agent(), new Dispatcher1Wrapper()]],
];

describe("Demos CCI proxy route: global fetch against demosdk's Axios", () => {
  const HTTPS = "https://node.example:8443/rpc";
  const P = "http://proxy:3128";
  const BYPASS = DEMOS_CCI_PROXY_BYPASS;
  const UNVERIFIED = DEMOS_CCI_ROUTE_UNVERIFIED;

  it("accepts actual Node Fetch and a bare Undici Agent without running custom factories", async () => {
    const agent = new UndiciAgent();
    const customFactory = vi.fn(function defaultFactory() { throw new Error("must not run"); });
    const custom = new UndiciAgent({ factory: customFactory });
    try {
      expect(() => isNodeBuiltinFetch(globalThis.fetch)).not.toThrow();
      expect(isNodeBuiltinFetch(globalThis.fetch)).toBe(true);
      expect(isNodeDefaultAgent(agent)).toBe(true);
      expect(isNodeDefaultDispatcher([undefined, agent])).toBe(true);
      expect(isNodeDefaultAgent(custom)).toBe(false);
      expect(customFactory).not.toHaveBeenCalled();
    } finally {
      await agent.destroy();
      await custom.destroy();
    }
  });

  // With Node's default dispatcher fetch connects directly, so only a read
  // that Axios would also send directly is allowed.
  it.each(DEFAULT_DISPATCHERS)("with Node's default dispatcher (%s)", (_line, dispatchers) => {
    const cases: Array<[Record<string, string>, string, string | undefined]> = [
      [{}, HTTPS, undefined],
      [{ HTTPS_PROXY: P }, HTTPS, BYPASS],
      [{ https_proxy: "proxy:3128" }, HTTPS, BYPASS],
      // Axios skips a blank lowercase variable.
      [{ https_proxy: "", HTTPS_PROXY: P }, HTTPS, BYPASS],
      [{ ALL_PROXY: P }, HTTPS, BYPASS],
      [{ all_proxy: P }, "http://node.example/", BYPASS],
      // Like Axios, an HTTPS URL does not fall back to HTTP_PROXY.
      [{ HTTP_PROXY: P }, HTTPS, undefined],
      [{ HTTP_PROXY: P }, "http://node.example/", BYPASS],
      [{ HTTPS_PROXY: P, NO_PROXY: "*" }, HTTPS, undefined],
      [{ HTTPS_PROXY: P, no_proxy: "other.example, node.example" }, HTTPS, undefined],
      [{ HTTPS_PROXY: P, NO_PROXY: "other.example, else.example" }, HTTPS, BYPASS],
      [{ HTTPS_PROXY: P, NO_PROXY: "NODE.EXAMPLE" }, HTTPS, undefined],
      [{ HTTPS_PROXY: P, NO_PROXY: ".example" }, HTTPS, undefined],
      [{ HTTPS_PROXY: P, NO_PROXY: "*.example" }, HTTPS, undefined],
      [{ HTTPS_PROXY: P, NO_PROXY: "*example" }, HTTPS, undefined],
      [{ HTTP_PROXY: P, NO_PROXY: ".example" }, "http://xexample/", BYPASS],
      [{ HTTP_PROXY: P, NO_PROXY: "*.example" }, "http://xexample/", BYPASS],
      [{ HTTPS_PROXY: P, NO_PROXY: "node.example:8443" }, HTTPS, undefined],
      [{ HTTPS_PROXY: P, NO_PROXY: "node.example:0" }, HTTPS, undefined],
      [{ HTTPS_PROXY: P, NO_PROXY: "node.example:443" }, HTTPS, BYPASS],
      [{ HTTPS_PROXY: P, NO_PROXY: "node.example:443" }, "https://node.example/", undefined],
      [{ HTTP_PROXY: P, NO_PROXY: "node.example:80" }, "http://node.example/", undefined],
      [{ HTTPS_PROXY: P, NO_PROXY: "de.example" }, HTTPS, BYPASS],
      [{ HTTPS_PROXY: P, NO_PROXY: "other.example" }, HTTPS, BYPASS],
      // axios 1.17's own bypass: loopback names are equivalent; trailing dots,
      // brackets and IPv4-mapped IPv6 are normalized.
      [{ HTTP_PROXY: P, NO_PROXY: "127.0.0.1" }, "http://localhost:8080/", undefined],
      [{ HTTP_PROXY: P, NO_PROXY: "localhost" }, "http://127.0.0.1:8080/", undefined],
      [{ HTTP_PROXY: P, NO_PROXY: "other.example,localhost" }, "http://127.0.0.1:8080/", undefined],
      [{ HTTP_PROXY: P, NO_PROXY: "localhost" }, "http://127.0.0.255/", undefined],
      [{ HTTP_PROXY: P, NO_PROXY: "127.0.0.1." }, "http://127.0.0.1:8080/", undefined],
      [{ HTTP_PROXY: P, NO_PROXY: "127.0.0.1:8080" }, "http://localhost:8080/", undefined],
      [{ HTTP_PROXY: P, NO_PROXY: "127.0.0.1:9090" }, "http://localhost:8080/", BYPASS],
      [{ HTTP_PROXY: P, NO_PROXY: "127.9.9.9" }, "http://[::1]:8080/", undefined],
      [{ HTTP_PROXY: P, NO_PROXY: "[::1]:8080" }, "http://localhost:8080/", undefined],
      [{ HTTP_PROXY: P, NO_PROXY: "[::1]:9090" }, "http://localhost:8080/", BYPASS],
      [{ HTTP_PROXY: P, NO_PROXY: "0:0:0:0:0:0:0:1" }, "http://127.0.0.1/", undefined],
      [{ HTTP_PROXY: P, NO_PROXY: "::ffff:7f00:1" }, "http://localhost/", undefined],
      [{ HTTP_PROXY: P, NO_PROXY: "10.0.0.1" }, "http://[::ffff:10.0.0.1]/", undefined],
      [{ HTTP_PROXY: P, NO_PROXY: "10.1.1.1" }, "http://[::ffff:10.1.1.1]/", undefined],
      [{ HTTP_PROXY: P, NO_PROXY: "::ffff:10.0.0.1" }, "http://10.0.0.1/", undefined],
      [{ HTTP_PROXY: P, NO_PROXY: "1::ffff:10.0.0.1" }, "http://10.0.0.1/", BYPASS],
      [{ HTTP_PROXY: P, NO_PROXY: "*.node.example." }, "http://a.node.example/", undefined],
      // Near misses of the loopback forms are not loopback.
      [{ HTTP_PROXY: P, NO_PROXY: "localhost" }, "http://[1:2:3:4:5:6:7:8]/", BYPASS],
      [{ HTTP_PROXY: P, NO_PROXY: "localhost" }, "http://[1:2:3:4:5:6:7:1]/", BYPASS],
      [{ HTTP_PROXY: P, NO_PROXY: "localhost" }, "http://[0:2:3:4:5:6:7:1]/", BYPASS],
      [{ HTTP_PROXY: P, NO_PROXY: "1:0:0:0:0:0:0:1" }, "http://localhost/", BYPASS],
      [{ HTTP_PROXY: P, NO_PROXY: "0:0:0:0:0:0:5:1" }, "http://localhost/", BYPASS],
      [{ HTTP_PROXY: P, NO_PROXY: "10:0:0:0:0:0:0:1" }, "http://localhost/", BYPASS],
      [{ HTTP_PROXY: P, NO_PROXY: "0a:0:0:0:0:0:0:1" }, "http://localhost/", BYPASS],
      [{ HTTP_PROXY: P, NO_PROXY: "0:0:0:0:0:0:0:21" }, "http://localhost/", BYPASS],
      [{ HTTP_PROXY: P, NO_PROXY: "0:0:0:0:0:0:0:10" }, "http://localhost/", BYPASS],
      [{ HTTP_PROXY: P, NO_PROXY: "0127.0.0.1" }, "http://localhost/", BYPASS],
      [{ HTTP_PROXY: P, NO_PROXY: "127.0.0.1.5" }, "http://localhost/", BYPASS],
      [{ HTTP_PROXY: P, NO_PROXY: "127.0.0.256" }, "http://localhost/", BYPASS],
      [{ HTTP_PROXY: P, NO_PROXY: "10.0.0.1" }, "http://localhost/", BYPASS],
      // Decided by the installed proxy-from-env 2.1.0 and axios 1.17.0.
      [{ HTTPS_PROXY: P, no_proxy: "other.example", NO_PROXY: "node.example" }, HTTPS, BYPASS],
      [{ HTTPS_PROXY: P, NO_PROXY: "other.test,*example" }, HTTPS, undefined],
      [{ HTTPS_PROXY: P, NO_PROXY: "*example:8443" }, HTTPS, undefined],
      [{ HTTP_PROXY: P, NO_PROXY: "localhost" }, "http://[1::ffff:7f00:1]/", BYPASS],
      [{ HTTP_PROXY: P, NO_PROXY: "0:0:0:0:0:0:0:1:5" }, "http://localhost/", BYPASS],
      [{ HTTP_PROXY: P, NO_PROXY: "0::0:0:0:0:0:1" }, "http://localhost/", BYPASS],
      [{ HTTP_PROXY: P, NO_PROXY: "0:0:0:0:0:ffff:10.0.0.1" }, "http://10.0.0.1/", undefined],
      [{ HTTP_PROXY: P, NO_PROXY: "10.0.0.200" }, "http://[::ffff:10.0.0.200]/", undefined],
      [{ HTTP_PROXY: P, NO_PROXY: "[::1]x:8080" }, "http://[::1]:8080/", undefined],
      // proxy-from-env strips only the trailing port from an IPv6 host.
      [{ HTTP_PROXY: P, NO_PROXY: "*1]" }, "http://[::1]:8080/", undefined],
      [{ HTTP_PROXY: P, NO_PROXY: "*:1]" }, "http://[::1]:8080/", undefined],
      [{ HTTPS_PROXY: P }, "not a url", undefined],
      // Node's proxy switch: Node may proxy Axios itself, from a startup
      // snapshot this check can't read. Node reads only NODE_USE_ENV_PROXY=1.
      [{ NODE_USE_ENV_PROXY: "1" }, HTTPS, UNVERIFIED],
      [{ HTTPS_PROXY: P, NODE_USE_ENV_PROXY: "1" }, HTTPS, UNVERIFIED],
      [{ NODE_OPTIONS: "--use-env-proxy" }, HTTPS, UNVERIFIED],
      [{ NODE_OPTIONS: "--max-old-space-size=64  --use-env-proxy" }, HTTPS, UNVERIFIED],
      [{ NODE_USE_ENV_PROXY: "0" }, HTTPS, undefined],
      [{ NODE_OPTIONS: "--no-use-env-proxy" }, HTTPS, undefined],
    ];
    for (const [env, rpc, expected] of cases) {
      expect([env, rpc, fetchProxyMismatch(rpc, env, routeState(dispatchers))]).toEqual([env, rpc, expected]);
    }
  });

  // Node's proxy agent (under either symbol), a Node 26 wrapper of something
  // else, or a dispatcher installed by other code: fetch's route is unknown.
  it.each<[string, Dispatchers]>([
    ["Node 20-22's proxy agent", [undefined, new EnvHttpProxyAgent()]],
    ["Node 24's proxy agent", [new EnvHttpProxyAgent(), new EnvHttpProxyAgent()]],
    ["Node 26's proxy agent", [new EnvHttpProxyAgent(), new Dispatcher1Wrapper()]],
    ["a newer undici's proxy agent", [new ProxyAgent(), new Dispatcher1Wrapper()]],
    ["an older undici's proxy agent", [new Agent(), new ProxyAgent()]],
    ["a proxy agent under .1", [undefined, new ProxyAgent()]],
    ["a wrapper with no current dispatcher", [undefined, new Dispatcher1Wrapper()]],
    ["a wrapper as the current dispatcher", [new Dispatcher1Wrapper(), new Dispatcher1Wrapper()]],
    ["null", [null, undefined]],
    ["null under .1", [undefined, null]],
    ["a plain object", [undefined, {}]],
    ["an object without a prototype", [Object.create(null) as unknown, undefined]],
    // An Agent that is not Node's bare `new Agent()` may route anywhere.
    ["fetch-socks' Agent with a proxying connector", [undefined, new Agent({ connect: () => undefined })]],
    ["fetch-socks' Agent under .2", [new Agent({ connect: () => undefined }), new Dispatcher1Wrapper()]],
    ["an Agent with a custom factory", [new Agent({ factory: () => undefined }), new Agent()]],
    ["an Agent with a socket path", [undefined, new Agent({ socketPath: "/run/proxy.sock" })]],
    ["an Agent with connect options", [undefined, new Agent({ connect: { socketPath: "/run/proxy.sock" } })]],
    ["an Agent with undici 6 interceptors", [undefined, new Agent({ interceptors: { Agent: [] } })]],
    ["an Agent with any other option", [undefined, new Agent({ keepAliveTimeout: 1 })]],
    ["an Agent with a lower maxOrigins", [new Agent({ maxOrigins: 1 }), new Agent({ maxOrigins: 1 })]],
    ["a composed Agent, which undici 7-8 return as a Proxy", [new Proxy(new Agent(), {}), new Dispatcher1Wrapper()]],
    ["a composed Agent under .1", [undefined, new Proxy(new Agent(), {})]],
    ["an Agent subclass named Agent", [undefined, new ({ Agent: class extends Agent {} }).Agent()]],
    ["an Agent with its own dispatch", [undefined, Object.assign(new Agent(), { dispatch() {} })]],
    ["another class named Agent", [undefined, new ({ Agent: class {} }).Agent()]],
    ["an Agent whose options are an accessor", [undefined, Object.defineProperty(new Agent(), kOptions, { get: () => ({}) })]],
    ["an Agent whose option is an accessor", [undefined,
      Object.assign(new Agent(), { [kOptions]: Object.defineProperty({}, "connect", { get: () => undefined }) })]],
    ["an Agent with a factory of another name", [undefined, Object.assign(new Agent(), { [kFactory]: () => undefined })]],
    ["an Agent without options", [undefined, Object.assign(new Agent(), { [kOptions]: null })]],
    // The factory's name proves nothing about where it connects.
    ["an Agent with a custom factory named defaultFactory",
      [undefined, new Agent({ factory: function defaultFactory() { return new ProxyAgent(); } })]],
    ["an Agent whose default factory was swapped for one of the same name", [undefined,
      Object.assign(new Agent(), { [kFactory]: function defaultFactory(...args: unknown[]) { return undiciDefaultFactory(...args); } })]],
    ["an Agent whose factory is a Proxy of undici's", [undefined, Object.assign(new Agent(), { [kFactory]: new Proxy(undiciDefaultFactory, {}) })]],
    ["an Agent without a factory", [undefined, (() => {
      const agent = new Agent();
      delete (agent as Partial<Agent>)[kFactory];
      return agent;
    })()]],
    ["an Agent whose factory is undefined", [undefined, Object.assign(new Agent(), { [kFactory]: undefined })]],
    ["an Agent with a non-function factory named defaultFactory",
      [undefined, Object.assign(new Agent(), { [kFactory]: { name: "defaultFactory" } })]],
    ["an Agent whose options are a Proxy", [undefined, Object.assign(new Agent(), { [kOptions]: new Proxy({}, {}) })]],
    ["an Agent with another option set to Infinity", [undefined, new Agent({ keepAliveTimeout: Infinity })]],
    ["an Agent whose prototype has no own constructor",
      [undefined, Object.setPrototypeOf(new Agent(), Object.create(Agent.prototype) as object)]],
    ["a look-alike whose constructor is not a function", [undefined, Object.setPrototypeOf(new Agent(),
      Object.create(DispatcherBase.prototype, { constructor: { value: { name: "Agent" } } }) as object)]],
  ])("refuses %s", (_kind, dispatchers) => {
    for (const env of [{}, { HTTP_PROXY: P }, { HTTPS_PROXY: P }]) {
      expect(fetchProxyMismatch(HTTPS, env, routeState(dispatchers))).toBe(UNVERIFIED);
    }
  });

  // Whatever dispatcher is installed, a global fetch other than Node's own may
  // route anywhere: a wrapper can pass its own proxy dispatcher.
  it.each<[string, unknown]>([
    ["a wrapper of Node's fetch", (input: string, init?: RequestInit) => nodeFetch()(input, init)],
    ["another function named fetch", function fetch() { return undefined; }],
    ["a bound Node fetch", nodeFetch().bind(globalThis)],
    ["a Proxy of Node's fetch", new Proxy(nodeFetch(), {})],
    ["a function that only mentions Node's undici loader",
      new Function("return function wrapped(input, init) { return \"require('internal/deps/undici/undici')\"; }")()],
    ["the Node Fetch signature without its loader",
      new Function("return function fetch(input, init = undefined) { return input; }")()],
    ["a Node-style wrapper retaining both old fingerprint markers with a custom dispatcher",
      new Function("require", "dispatcher", "return function fetch(input, init = undefined) {\n" +
        "  const undiciModule = require('internal/deps/undici/undici');\n" +
        "  return undiciModule.fetch(input, { ...init, dispatcher });\n}")(() => ({}), {})],
    ["no fetch", undefined],
    ["a non-function", {}],
  ])("refuses %s as global fetch", (_kind, globalFetch) => {
    for (const [, dispatchers] of DEFAULT_DISPATCHERS) {
      for (const env of [{}, { HTTP_PROXY: P }, { HTTPS_PROXY: P, NO_PROXY: "node.example" }]) {
        const state = { ...routeState(dispatchers), fetch: globalFetch };
        expect(fetchProxyMismatch(HTTPS, env, state)).toBe(UNVERIFIED);
        expect(fetchProxyMismatch("not a url", env, state)).toBe(UNVERIFIED);
      }
    }
  });

  class HttpsProxyAgent {}
  it.each<[string, unknown[], string[]]>([
    ["an http agent from Node's proxy switch", [switchedAgent(), new nodeHttps.Agent()], []],
    ["an https agent from Node's proxy switch", [new nodeHttp.Agent(), switchedAgent({ HTTPS_PROXY: P })], []],
    ["a replaced global agent", [new nodeHttp.Agent(), new HttpsProxyAgent()], []],
    ["a global agent without a prototype", [Object.create(null) as unknown, new nodeHttps.Agent()], []],
    ["--use-env-proxy on the command line", plainAgents(), ["--use-env-proxy"]],
  ])("refuses %s, through which Node may proxy Axios", (_kind, agents, execArgv) => {
    for (const [, dispatchers] of DEFAULT_DISPATCHERS) {
      for (const env of [{}, { HTTPS_PROXY: P }, { HTTP_PROXY: P, NO_PROXY: "node.example" }]) {
        expect(fetchProxyMismatch(HTTPS, env, routeState(dispatchers, agents, execArgv))).toBe(UNVERIFIED);
      }
    }
  });

  it.each([0, 1])("refuses customized native global Agent %s without calling its code", index => {
    const methods = ["createConnection", "createSocket", "addRequest", "getName"];
    for (const method of methods) {
      const agents = plainAgents();
      const custom = vi.fn(() => { throw new Error("must not run"); });
      Object.assign(agents[index]!, { [method]: custom });
      expect(fetchProxyMismatch(HTTPS, {}, routeState([undefined, undefined], agents)))
        .toBe(UNVERIFIED);
      expect(custom).not.toHaveBeenCalled();
    }
    for (const options of [
      { lookup: () => undefined }, { socketPath: "/run/custom.sock" },
      { host: "proxy.example" }, { port: 3128 }, { localAddress: "127.0.0.2" },
    ]) {
      const agents = plainAgents();
      Object.assign((agents[index]! as unknown as { options: object }).options, options);
      expect(fetchProxyMismatch(HTTPS, {}, routeState([undefined, undefined], agents)))
        .toBe(UNVERIFIED);
    }
  });

  it("allows native global Agents with ordinary pool settings", () => {
    const agents = [new nodeHttp.Agent({ keepAlive: true, timeout: 5000 }),
      new nodeHttps.Agent({ keepAlive: true, maxSockets: 10 })];
    expect(fetchProxyMismatch(HTTPS, {}, routeState([undefined, undefined], agents))).toBeUndefined();
  });

  it.each([nodeHttp.Agent.prototype, nodeHttps.Agent.prototype])(
    "refuses a native Agent prototype whose connector changed after import", prototype => {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "createConnection")!;
      const connect = vi.fn();
      try {
        Object.defineProperty(prototype, "createConnection", { ...descriptor, value: connect });
        expect(fetchProxyMismatch(HTTPS, {}, routeState([undefined, undefined]))).toBe(UNVERIFIED);
        expect(connect).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(prototype, "createConnection", descriptor);
      }
    },
  );

  // Each route the sweep saw fetch take apart from Axios, with the state Node
  // had installed: none is allowed.
  it.each<[string, Record<string, string>, string, Dispatchers, unknown[]]>([
    ["Node 24, NO_PROXY naming the parent domain", { HTTPS_PROXY: P, NO_PROXY: "example.test", NODE_USE_ENV_PROXY: "1" },
      "https://node.example.test/", [new EnvHttpProxyAgent(), new EnvHttpProxyAgent()], [switchedAgent(), switchedAgent()]],
    ["Node 24, a dotted NO_PROXY and the apex", { HTTPS_PROXY: P, NO_PROXY: ".example.test", NODE_USE_ENV_PROXY: "1" },
      "https://example.test/", [new EnvHttpProxyAgent(), new EnvHttpProxyAgent()], [switchedAgent(), switchedAgent()]],
    ["Node 24, * inside a NO_PROXY list", { HTTP_PROXY: P, NO_PROXY: "other.test,*", NODE_USE_ENV_PROXY: "1" },
      "http://127.0.0.1/", [new EnvHttpProxyAgent(), new EnvHttpProxyAgent()], [switchedAgent(), switchedAgent()]],
    ["Node 26, HTTPS with only HTTP_PROXY", { HTTP_PROXY: P, NODE_USE_ENV_PROXY: "1" },
      "https://node.example.test/", [new EnvHttpProxyAgent(), new Dispatcher1Wrapper()], [switchedAgent(), switchedAgent()]],
    ["Node 26, a blank lowercase no_proxy", { HTTP_PROXY: P, no_proxy: "", NO_PROXY: "127.0.0.1", NODE_USE_ENV_PROXY: "1" },
      "http://127.0.0.1/", [new EnvHttpProxyAgent(), new Dispatcher1Wrapper()], [switchedAgent(), switchedAgent()]],
    ["a space-separated NO_PROXY", { HTTP_PROXY: P, NO_PROXY: "other.test 127.0.0.1", NODE_USE_ENV_PROXY: "1" },
      "http://127.0.0.1/", [undefined, new EnvHttpProxyAgent()], [switchedAgent(), switchedAgent()]],
    ["NO_PROXY loaded after startup", { HTTP_PROXY: P, NO_PROXY: "127.0.0.1", NODE_USE_ENV_PROXY: "1" },
      "http://127.0.0.1/", [undefined, new EnvHttpProxyAgent()], [switchedAgent({ HTTP_PROXY: P }), switchedAgent()]],
    ["a proxy changed after startup", { HTTPS_PROXY: "http://new-proxy:3128" },
      "https://node.example.test/", [undefined, new EnvHttpProxyAgent()], [switchedAgent({ HTTPS_PROXY: P }), switchedAgent()]],
  ])("refuses the mismatched route of %s", (_kind, env, rpc, dispatchers, agents) => {
    const decision = fetchProxyMismatch(rpc, env, routeState(dispatchers, agents));
    expect(decision).toBe(UNVERIFIED);
    // Even if Node had left the environment variables behind, the state alone refuses.
    const { NODE_USE_ENV_PROXY: _switch, ...withoutSwitch } = env;
    expect(fetchProxyMismatch(rpc, withoutSwitch, routeState(dispatchers, agents))).toBe(UNVERIFIED);
  });
});

describe("Demos CCI default transport and the environment proxy", () => {
  let server: Server | undefined;
  const requests: IncomingHttpHeaders[] = [];
  async function directRpc() {
    requests.length = 0;
    server = createServer((request, response) => {
      requests.push(request.headers);
      request.resume().on("end", () => response.writeHead(200, {
        "Content-Type": "application/json",
      }).end(JSON.stringify(GCR)));
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`;
  }

  afterEach(async () => {
    server?.closeAllConnections();
    if (server !== undefined) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const DISPATCHERS = [Symbol.for("undici.globalDispatcher.2"), Symbol.for("undici.globalDispatcher.1")];
  const globals = globalThis as Record<symbol, unknown>;
  const restores: Array<() => void> = [];

  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) restore();
  });

  // Pin the environment and the state Node would have installed: the global
  // fetch dispatchers, the http and https global agents, and execArgv. Unset
  // rather than blank: Node's own proxy agent treats a blank variable as set.
  function stubProxyEnvironment(
    values: Record<string, string | undefined>,
    dispatchers: Dispatchers,
    { agents = [new nodeHttp.Agent(), new nodeHttps.Agent()], execArgv = [] }:
      { agents?: unknown[]; execArgv?: string[] } = {},
  ) {
    for (const name of ["http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
      vi.stubEnv(name, undefined);
      vi.stubEnv(name.toUpperCase(), undefined);
    }
    vi.stubEnv("NODE_USE_ENV_PROXY", undefined);
    vi.stubEnv("NODE_OPTIONS", undefined);
    for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
    DISPATCHERS.forEach((symbol, index) => {
      const had = Object.hasOwn(globals, symbol);
      const previous = globals[symbol];
      globals[symbol] = dispatchers[index];
      restores.push(() => {
        if (had) globals[symbol] = previous;
        else delete globals[symbol];
      });
    });
    const [httpAgent, httpsAgent, argv] = [nodeHttp.globalAgent, nodeHttps.globalAgent, process.execArgv];
    nodeHttp.globalAgent = agents[0] as typeof httpAgent;
    nodeHttps.globalAgent = agents[1] as typeof httpsAgent;
    process.execArgv = execArgv;
    restores.push(() => {
      nodeHttp.globalAgent = httpAgent;
      nodeHttps.globalAgent = httpsAgent;
      process.execArgv = argv;
    });
  }

  const SECRET_PROXY = "http://user:proxy-secret@proxy.example:3128";
  it.each([0, 1])("refuses a custom native global connector %s before signing or connecting", async index => {
    const agents = plainAgents();
    const connect = vi.fn(() => { throw new Error("must not connect"); });
    Object.assign(agents[index]!, { createConnection: connect });
    stubProxyEnvironment({}, [undefined, undefined], { agents });
    const adapter = new DemosAdapter({ rpc: index === 0 ? "http://node.example/rpc" : RPC });
    Object.assign(adapter, { connected: true });
    const demos = adapter.raw as unknown as Demos;
    vi.spyOn(demos, "walletConnected", "get").mockReturnValue(true);
    const sign = vi.spyOn(demos.crypto, "sign");

    await expect(adapter.resolveIdentity("subject")).rejects.toMatchObject({
      message: DEMOS_CCI_ROUTE_UNVERIFIED, category: "permanent",
    });
    expect(sign).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it.each<{ kind: string; env: Record<string, string | undefined>; dispatchers: Dispatchers;
    agents?: unknown[]; execArgv?: string[]; message: string }>([
    { kind: "a proxy Axios uses", env: {}, dispatchers: [undefined, new Agent()], message: DEMOS_CCI_PROXY_BYPASS },
    // Node 20, or a switch read after startup: Node installed no proxy agent.
    { kind: "a switch Node did not apply", env: { NODE_USE_ENV_PROXY: "1", NODE_OPTIONS: "--use-env-proxy" },
      dispatchers: [undefined, undefined], message: DEMOS_CCI_ROUTE_UNVERIFIED },
    // Node's agent would send this HTTPS read to HTTP_PROXY; Axios connects directly.
    { kind: "Node 22's proxy agent", env: { HTTPS_PROXY: undefined, HTTP_PROXY: SECRET_PROXY },
      dispatchers: [undefined, new EnvHttpProxyAgent()], message: DEMOS_CCI_ROUTE_UNVERIFIED },
    { kind: "Node 26's proxy agent", env: { HTTPS_PROXY: undefined, HTTP_PROXY: SECRET_PROXY },
      dispatchers: [new EnvHttpProxyAgent(), new Dispatcher1Wrapper()], message: DEMOS_CCI_ROUTE_UNVERIFIED },
    { kind: "Node's proxy switch on the https agent alone", env: { HTTPS_PROXY: undefined },
      dispatchers: [undefined, undefined], agents: [new nodeHttp.Agent(), switchedAgent({ HTTPS_PROXY: SECRET_PROXY })],
      message: DEMOS_CCI_ROUTE_UNVERIFIED },
    { kind: "--use-env-proxy on the command line", env: { HTTPS_PROXY: undefined },
      dispatchers: [undefined, undefined], execArgv: ["--use-env-proxy"], message: DEMOS_CCI_ROUTE_UNVERIFIED },
  ])("refuses a route it can't match to Axios's ($kind), before signing or sending", async (row) => {
    stubProxyEnvironment({ HTTPS_PROXY: SECRET_PROXY, ...row.env }, row.dispatchers, row);
    const globalFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", nodeFetch(globalFetch));
    const adapter = new DemosAdapter({ rpc: "https://user:rpc-secret@node.example/rpc" });
    Object.assign(adapter, { connected: true });
    const demos = adapter.raw as unknown as Demos;
    vi.spyOn(demos, "walletConnected", "get").mockReturnValue(true);
    const sign = vi.spyOn(demos.crypto, "sign");

    const error = await adapter.resolveIdentity("subject").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DacsError);
    expect(error).toMatchObject({ message: row.message, category: "permanent" });
    expect(inspect(error)).not.toMatch(/secret|proxy\.example|node\.example/);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });

  it.each(["ordinary", "modified Node-style"])("refuses a %s replacement fetch before signing or sending", async (kind) => {
    stubProxyEnvironment({}, [undefined, new Agent()]);
    const replaced = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(GCR)));
    const replacement = kind === "ordinary" ? replaced : new Function("require", "dispatcher",
      "return function fetch(input, init = undefined) {\n" +
      "  const undiciModule = require('internal/deps/undici/undici');\n" +
      "  return undiciModule.fetch(input, { ...init, dispatcher });\n}",
    )(() => ({ fetch: replaced }), {});
    vi.stubGlobal("fetch", replacement);
    const adapter = new DemosAdapter({ rpc: RPC });
    Object.assign(adapter, { connected: true });
    const demos = adapter.raw as unknown as Demos;
    vi.spyOn(demos, "walletConnected", "get").mockReturnValue(true);
    const sign = vi.spyOn(demos.crypto, "sign");

    const error = await adapter.resolveIdentity("subject").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DacsError);
    expect(error).toMatchObject({ message: DEMOS_CCI_ROUTE_UNVERIFIED, category: "permanent" });
    expect(replaced).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });

  it("uses its private route when an exact-source Fetch is installed and globals change while signing", async () => {
    stubProxyEnvironment({}, [undefined, new Agent()]);
    const checked = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(GCR)));
    const late = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(GCR)));
    vi.stubGlobal("fetch", nodeFetch(checked));
    const adapter = new DemosAdapter({ rpc: await directRpc() });
    Object.assign(adapter, { connected: true });
    const demos = adapter.raw as unknown as Demos;
    vi.spyOn(demos, "walletConnected", "get").mockReturnValue(true);
    vi.spyOn(demos, "keypair", "get").mockReturnValue({ publicKey: Buffer.alloc(32, 0xab), privateKey: Buffer.alloc(64) });
    vi.spyOn(demos.crypto, "sign").mockImplementation(async () => {
      vi.stubGlobal("fetch", late);
      return { signature: new Uint8Array([1, 2, 3]) } as never;
    });

    await expect(adapter.resolveIdentity("subject")).resolves.toHaveProperty("raw", GCR);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ signature: "0x010203", timestamp: expect.any(String) });
    expect(checked).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
  });

  it("never invokes an exact-source global Agent factory with substituted closed-over constructors", async () => {
    const construct = vi.fn();
    const factory = new Function("Client", "Pool", `return ${undiciDefaultFactory.toString()}`)(construct, construct);
    const custom = new UndiciAgent({ factory });
    try {
      stubProxyEnvironment({}, [undefined, custom]);
      const copiedFetch = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", nodeFetch(copiedFetch));
      const rpc = await directRpc();
      // Both copied bodies pass the compatibility filter. Neither supplies the
      // read's transport: the request must reach the actual local origin.
      expect(fetchProxyMismatch(rpc)).toBeUndefined();
      const adapter = new DemosAdapter({ rpc });
      Object.assign(adapter, { connected: true });
      await expect(adapter.resolveIdentity("subject")).resolves.toHaveProperty("raw", GCR);
      expect(requests).toHaveLength(1);
      expect(construct).not.toHaveBeenCalled();
      expect(copiedFetch).not.toHaveBeenCalled();
    } finally {
      await custom.destroy();
    }
  });

  it("reads Node's live http.globalAgent as well as its https agent", () => {
    stubProxyEnvironment({}, [undefined, undefined],
      { agents: [switchedAgent({ HTTP_PROXY: SECRET_PROXY }), new nodeHttps.Agent()] });
    vi.stubGlobal("fetch", nodeFetch());
    expect(fetchProxyMismatch("http://node.example/")).toBe(DEMOS_CCI_ROUTE_UNVERIFIED);
    nodeHttp.globalAgent = new nodeHttp.Agent();
    expect(fetchProxyMismatch("http://node.example/")).toBeUndefined();
  });

  it("states the remedy in its stable messages", () => {
    expect(DEMOS_CCI_PROXY_BYPASS).toBe("Demos GCR identity read would bypass the environment proxy; inject identityFetch");
    expect(DEMOS_CCI_ROUTE_UNVERIFIED).toBe("Demos GCR identity read cannot verify its route with Node's proxy " +
      "switch or a custom global fetch, dispatcher or agent; inject identityFetch");
  });

  it.each([
    { kind: "NO_PROXY", env: { HTTP_PROXY: "http://proxy.example:3128", NO_PROXY: "127.0.0.1" },
      dispatchers: [undefined, new Agent()] as Dispatchers },
    { kind: "no proxy", env: {}, dispatchers: [undefined, new Agent()] as Dispatchers },
    { kind: "no proxy, before fetch loads its dispatcher", env: {}, dispatchers: [undefined, undefined] as Dispatchers },
    { kind: "Node 24's default dispatcher", env: {}, dispatchers: [new Agent(), new Agent()] as Dispatchers },
    { kind: "Node 26's default dispatcher", env: {}, dispatchers: [new Agent(), new Dispatcher1Wrapper()] as Dispatchers },
  ])("uses the private direct transport with $kind", async ({ env, dispatchers }) => {
    stubProxyEnvironment(env, dispatchers);
    const globalFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(GCR)));
    vi.stubGlobal("fetch", nodeFetch(globalFetch));
    const adapter = new DemosAdapter({ rpc: await directRpc() });
    Object.assign(adapter, { connected: true });
    await expect(adapter.resolveIdentity("subject")).resolves.toHaveProperty("raw", GCR);
    expect(requests).toHaveLength(1);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("fails an unparseable RPC URL with the stable error, never echoing its credentials", async () => {
    stubProxyEnvironment({}, [undefined, new Agent()]);
    const adapter = new DemosAdapter({ rpc: "http://user:secret-pass@[bad" });
    Object.assign(adapter, { connected: true });
    const error = await adapter.resolveIdentity("subject").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SubstrateError);
    expect(error).toMatchObject({ message: "Demos GCR identity read failed" });
    expect(inspect(error, { depth: 10 })).not.toMatch(/secret-pass/);
  });

  it("leaves routing to an injected transport", async () => {
    stubProxyEnvironment({ HTTPS_PROXY: "http://proxy.example:3128", NODE_USE_ENV_PROXY: "1" },
      [new EnvHttpProxyAgent(), new Dispatcher1Wrapper()], { agents: [switchedAgent(), switchedAgent()] });
    const { adapter, transport } = adapterFor(new Response(JSON.stringify(GCR)));
    await expect(adapter.resolveIdentity("subject")).resolves.toHaveProperty("raw", GCR);
    expect(transport).toHaveBeenCalledOnce();
  });
});

// Both supported Fetch transports, compared with demosdk's Axios over a real socket.
describe.each(["injected", "private default"])("Demos CCI %s transport against a real local HTTP server", mode => {
  let server: Server | undefined;
  let restoreRoute: () => Promise<void>;
  const transportConfig = () => mode === "injected" ? { identityFetch: fetch } : {};

  beforeEach(() => {
    const previous = [nodeHttp.globalAgent, nodeHttps.globalAgent, process.execArgv] as const;
    const globals = globalThis as Record<symbol, unknown>;
    const symbols = [Symbol.for("undici.globalDispatcher.2"), Symbol.for("undici.globalDispatcher.1")];
    const dispatchers = symbols.map(symbol => globals[symbol]);
    const directDispatcher = new UndiciAgent();
    nodeHttp.globalAgent = new nodeHttp.Agent();
    nodeHttps.globalAgent = new nodeHttps.Agent();
    process.execArgv = [];
    symbols.forEach(symbol => { globals[symbol] = directDispatcher; });
    vi.stubEnv("NODE_USE_ENV_PROXY", undefined);
    vi.stubEnv("NODE_OPTIONS", undefined);
    restoreRoute = async () => {
      [nodeHttp.globalAgent, nodeHttps.globalAgent, process.execArgv] = previous;
      symbols.forEach((symbol, index) => { globals[symbol] = dispatchers[index]; });
      await directDispatcher.destroy();
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    server?.closeAllConnections();
    await new Promise(resolve => (server ? server.close(resolve) : resolve(undefined)));
    server = undefined;
    await restoreRoute();
  });

  async function serve(reply: (headers: IncomingHttpHeaders, url: string) => [number, Record<string, string>, string]) {
    stubLocalNodeEnvironment();
    const seen: Array<{ url: string; authorization: string | undefined }> = [];
    server = createServer((request, response) => {
      seen.push({ url: request.url ?? "", authorization: request.headers.authorization });
      request.resume().on("end", () => {
        const [status, headers, body] = reply(request.headers, request.url ?? "");
        response.writeHead(status, headers).end(body);
      });
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    return { port: (server.address() as AddressInfo).port, seen };
  }

  it.each([301, 302, 303, 307, 308])("refuses a real %s redirect with the stable DacsError, without following it", async (status) => {
    const { port, seen } = await serve((_headers, url) => url === "/"
      ? [status, { Location: "/elsewhere" }, "redirect body"]
      : [200, { "Content-Type": "application/json" }, JSON.stringify(GCR)]);
    const adapter = new DemosAdapter({ rpc: `http://127.0.0.1:${port}/`, ...transportConfig() });
    Object.assign(adapter, { connected: true });
    const error = await adapter.resolveIdentity("subject").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DacsError);
    expect(error).toMatchObject({ message: "Demos GCR identity response redirect refused", category: "permanent" });
    expect(seen.map(({ url }) => url)).toEqual(["/"]);
  });

  it("encodes non-ASCII RPC URL credentials as UTF-8, exactly as demosdk's Axios rpcCall does", async () => {
    const { port, seen } = await serve(() => [200, { "Content-Type": "application/json" }, JSON.stringify(GCR)]);
    const rpc = `http://us%C3%A9r:p%C3%A4ss@127.0.0.1:${port}/`;
    const adapter = new DemosAdapter({ rpc, ...transportConfig() });
    Object.assign(adapter, { connected: true });
    Object.assign(adapter.raw as unknown as Demos, { rpc_url: rpc });

    await new Identities().getIdentities(adapter.raw as unknown as Demos, "getIdentities", "subject");
    await adapter.resolveIdentity("subject");

    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[1]?.authorization).toBe(`Basic ${Buffer.from("usér:päss", "utf8").toString("base64")}`);
  });

  it("sends RPC URL credentials exactly as demosdk's Axios rpcCall does, and never reports them", async () => {
    const { port, seen } = await serve(headers => headers.authorization === undefined
      ? [401, {}, "unauthorized"]
      : [200, { "Content-Type": "application/json" }, JSON.stringify(GCR)]);
    const rpc = `http://us%40er:secret%3Apass@127.0.0.1:${port}/`;
    const adapter = new DemosAdapter({ rpc, ...transportConfig() });
    Object.assign(adapter, { connected: true });
    const demos = adapter.raw as unknown as Demos;
    Object.assign(demos, { rpc_url: rpc });

    await expect(new Identities().getIdentities(demos, "getIdentities", "subject")).resolves.toEqual(GCR);
    await expect(adapter.resolveIdentity("subject")).resolves.toHaveProperty("raw", GCR);

    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[1]?.authorization).toBe(`Basic ${Buffer.from("us@er:secret:pass").toString("base64")}`);

    server?.closeAllConnections();
    await new Promise(resolve => server!.close(resolve));
    server = undefined;
    const error = await adapter.resolveIdentity("subject").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransientError);
    expect(inspect(error, { depth: 10 })).not.toMatch(/secret|us%40er|us@er/);
  });
});
