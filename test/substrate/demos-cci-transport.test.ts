import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Identities } from "@kynesyslabs/demosdk/abstraction";
import type { Demos } from "@kynesyslabs/demosdk/websdk";

import { sha256Hex } from "../../src/canonical/index.js";
import { DacsError, SubstrateError, TransientError, faultCategory } from "../../src/errors.js";
import { DEMOS_CCI_RESPONSE_LIMITS, parseCciRecord } from "../../src/identity/cci.js";
import { DemosAdapter, type DemosAdapterConfig } from "../../src/substrate/index.js";
import { fetchIgnoresEnvironmentProxy } from "../../src/substrate/demosCciTransport.js";

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
    expect(error).toMatchObject({ message: "Demos GCR identity response is not valid UTF-8 JSON" });
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

describe("Demos CCI environment proxy detection (proxy-from-env rules)", () => {
  const HTTPS = "https://node.example:8443/rpc";
  it.each([
    { env: {}, rpc: HTTPS, ignored: false },
    { env: { HTTPS_PROXY: "http://proxy:3128" }, rpc: HTTPS, ignored: true },
    { env: { https_proxy: "proxy:3128" }, rpc: HTTPS, ignored: true },
    { env: { ALL_PROXY: "http://proxy:3128" }, rpc: HTTPS, ignored: true },
    { env: { all_proxy: "http://proxy:3128" }, rpc: "http://node.example/", ignored: true },
    // Like Axios, an HTTPS URL does not fall back to HTTP_PROXY.
    { env: { HTTP_PROXY: "http://proxy:3128" }, rpc: HTTPS, ignored: false },
    { env: { HTTP_PROXY: "http://proxy:3128" }, rpc: "http://node.example/", ignored: true },
    { env: { HTTPS_PROXY: "http://proxy:3128", NODE_USE_ENV_PROXY: "1" }, rpc: HTTPS, ignored: false },
    { env: { HTTPS_PROXY: "http://proxy:3128", NODE_USE_ENV_PROXY: "0" }, rpc: HTTPS, ignored: true },
    { env: { HTTPS_PROXY: "p", NODE_OPTIONS: "--max-old-space-size=64 --use-env-proxy" }, rpc: HTTPS, ignored: false },
    { env: { HTTPS_PROXY: "p", NO_PROXY: "*" }, rpc: HTTPS, ignored: false },
    { env: { HTTPS_PROXY: "p", no_proxy: "other.example, node.example" }, rpc: HTTPS, ignored: false },
    { env: { HTTPS_PROXY: "p", NO_PROXY: "NODE.EXAMPLE" }, rpc: HTTPS, ignored: false },
    { env: { HTTPS_PROXY: "p", NO_PROXY: ".example" }, rpc: HTTPS, ignored: false },
    { env: { HTTPS_PROXY: "p", NO_PROXY: "*.example" }, rpc: HTTPS, ignored: false },
    { env: { HTTPS_PROXY: "p", NO_PROXY: "node.example:8443" }, rpc: HTTPS, ignored: false },
    { env: { HTTPS_PROXY: "p", NO_PROXY: "node.example:443" }, rpc: HTTPS, ignored: true },
    { env: { HTTPS_PROXY: "p", NO_PROXY: "node.example:443" }, rpc: "https://node.example/", ignored: false },
    { env: { HTTPS_PROXY: "p", NO_PROXY: "de.example" }, rpc: HTTPS, ignored: true },
    { env: { HTTPS_PROXY: "p", NO_PROXY: "other.example" }, rpc: HTTPS, ignored: true },
    { env: { HTTPS_PROXY: "p" }, rpc: "not a url", ignored: false },
  ])("$env for $rpc: ignored=$ignored", ({ env, rpc, ignored }) => {
    expect(fetchIgnoresEnvironmentProxy(rpc, env, [])).toBe(ignored);
  });

  it("honours --use-env-proxy on the command line", () => {
    expect(fetchIgnoresEnvironmentProxy(HTTPS, { HTTPS_PROXY: "p" }, ["--use-env-proxy"])).toBe(false);
  });
});

describe("Demos CCI default transport and the environment proxy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function stubProxyEnvironment(values: Record<string, string | undefined>) {
    for (const name of ["http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
      vi.stubEnv(name, "");
      vi.stubEnv(name.toUpperCase(), "");
    }
    vi.stubEnv("NODE_USE_ENV_PROXY", "");
    for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
  }

  it("refuses to bypass a proxy the environment names, before signing or sending", async () => {
    stubProxyEnvironment({ HTTPS_PROXY: "http://user:proxy-secret@proxy.example:3128" });
    const globalFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", globalFetch);
    const adapter = new DemosAdapter({ rpc: "https://user:rpc-secret@node.example/rpc" });
    Object.assign(adapter, { connected: true });
    const demos = adapter.raw as unknown as Demos;
    vi.spyOn(demos, "walletConnected", "get").mockReturnValue(true);
    const sign = vi.spyOn(demos.crypto, "sign");

    const error = await adapter.resolveIdentity("subject").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DacsError);
    expect(error).toMatchObject({
      message: "Demos GCR identity read would bypass the environment proxy; " +
        "set NODE_USE_ENV_PROXY=1 or inject identityFetch",
      category: "permanent",
    });
    expect(inspect(error)).not.toMatch(/secret|proxy\.example|node\.example/);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "NODE_USE_ENV_PROXY=1", env: { HTTPS_PROXY: "http://proxy.example:3128", NODE_USE_ENV_PROXY: "1" } },
    { kind: "NO_PROXY", env: { HTTPS_PROXY: "http://proxy.example:3128", NO_PROXY: "node.example" } },
    { kind: "no proxy", env: {} },
  ])("uses global fetch with $kind", async ({ env }) => {
    stubProxyEnvironment(env);
    const globalFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(GCR)));
    vi.stubGlobal("fetch", globalFetch);
    const adapter = new DemosAdapter({ rpc: RPC });
    Object.assign(adapter, { connected: true });
    await expect(adapter.resolveIdentity("subject")).resolves.toHaveProperty("raw", GCR);
    expect(globalFetch).toHaveBeenCalledOnce();
  });

  it("leaves routing to an injected transport", async () => {
    stubProxyEnvironment({ HTTPS_PROXY: "http://proxy.example:3128" });
    const { adapter, transport } = adapterFor(new Response(JSON.stringify(GCR)));
    await expect(adapter.resolveIdentity("subject")).resolves.toHaveProperty("raw", GCR);
    expect(transport).toHaveBeenCalledOnce();
  });
});

// Node's own fetch, and demosdk's Axios transport for comparison, against a real socket.
describe("Demos CCI default transport against a real local HTTP server", () => {
  let server: Server | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    server?.closeAllConnections();
    await new Promise(resolve => (server ? server.close(resolve) : resolve(undefined)));
    server = undefined;
  });

  async function serve(reply: (headers: IncomingHttpHeaders, url: string) => [number, Record<string, string>, string]) {
    for (const name of ["http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
      vi.stubEnv(name, "");
      vi.stubEnv(name.toUpperCase(), "");
    }
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
    const adapter = new DemosAdapter({ rpc: `http://127.0.0.1:${port}/` });
    Object.assign(adapter, { connected: true });
    const error = await adapter.resolveIdentity("subject").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DacsError);
    expect(error).toMatchObject({ message: "Demos GCR identity response redirect refused", category: "permanent" });
    expect(seen.map(({ url }) => url)).toEqual(["/"]);
  });

  it("sends RPC URL credentials exactly as demosdk's Axios rpcCall does, and never reports them", async () => {
    const { port, seen } = await serve(headers => headers.authorization === undefined
      ? [401, {}, "unauthorized"]
      : [200, { "Content-Type": "application/json" }, JSON.stringify(GCR)]);
    const rpc = `http://us%40er:secret%3Apass@127.0.0.1:${port}/`;
    const adapter = new DemosAdapter({ rpc });
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
