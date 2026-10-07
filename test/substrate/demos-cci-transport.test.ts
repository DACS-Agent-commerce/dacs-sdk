import { afterEach, describe, expect, it, vi } from "vitest";
import type { Demos } from "@kynesyslabs/demosdk/websdk";

import { sha256Hex } from "../../src/canonical/index.js";
import { DacsError, SubstrateError } from "../../src/errors.js";
import { DEMOS_CCI_RESPONSE_LIMITS, parseCciRecord } from "../../src/identity/cci.js";
import { DemosAdapter, type DemosAdapterConfig } from "../../src/substrate/index.js";

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
      redirect: "error",
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

    const identity = `ed25519:${"ab".repeat(32)}`;
    expect(sign).toHaveBeenCalledWith("ed25519", new TextEncoder().encode(
      sha256Hex(`${identity}:1700000000000`),
    ));
    expect(transport.mock.calls[0]?.[1]?.headers).toEqual({
      "Content-Type": "application/json",
      identity,
      signature: "010203",
      timestamp: "1700000000000",
    });
  });

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
    const { adapter } = adapterFor(new Response("invalid-json-sentinel"));
    const error = await adapter.resolveIdentity("subject").catch((error: unknown) => error);
    expect(error).toBeInstanceOf(DacsError);
    expect(error).toMatchObject({ message: "Demos GCR identity response is not valid UTF-8 JSON" });
    expect(error).not.toHaveProperty("cause");
  });

  it("cancels HTTP error bodies and returns a substrate failure", async () => {
    const stream = streamedResponse([new Uint8Array(1)], null);
    const response = new Response(stream.response.body, { status: 503 });
    const { adapter } = adapterFor(response);
    await expect(adapter.resolveIdentity("subject")).rejects.toBeInstanceOf(SubstrateError);
    expect(stream.reads()).toBe(0);
    expect(stream.cancel).toHaveBeenCalledOnce();
  });

  it("keeps self-certifying DID resolution local", async () => {
    const { adapter, transport } = adapterFor(new Response("unused"), 1);
    await expect(adapter.resolveIdentity(PRIMARY)).resolves.toHaveProperty("boundTo", PRIMARY);
    expect(transport).not.toHaveBeenCalled();
  });

  it("bounds delayed headers and a trickling body with one five-second deadline", async () => {
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
    const signal = transport.mock.calls[0]?.[1]?.signal;

    await vi.advanceTimersByTimeAsync(4_999);
    expect(emittedBytes).toBe(2);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const error = await result;

    expect(error).toBeInstanceOf(DacsError);
    expect(error).toMatchObject({ message: TIMEOUT, category: "permanent" });
    expect(error).not.toHaveProperty("cause");
    expect(signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(decoder).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds stalled headers even when the transport ignores abort, cancelling a late body", async () => {
    vi.useFakeTimers();
    const stream = streamedResponse([new TextEncoder().encode("invalid JSON")], null);
    const { adapter, transport } = adapterFor(stream.response);
    let releaseHeaders: ((response: Response) => void) | undefined;
    transport.mockImplementation(() => new Promise<Response>((resolve) => {
      releaseHeaders = resolve;
    }));
    const decoder = vi.spyOn(TextDecoder.prototype, "decode");
    const result = adapter.resolveIdentity("subject").catch((error: unknown) => error);
    const signal = transport.mock.calls[0]?.[1]?.signal;

    await vi.advanceTimersByTimeAsync(5_000);
    const error = await result;

    expect(error).toBeInstanceOf(DacsError);
    expect(error).toMatchObject({ message: TIMEOUT, category: "permanent" });
    expect(error).not.toHaveProperty("cause");
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    releaseHeaders?.(stream.response);
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.reads()).toBe(0);
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(decoder).not.toHaveBeenCalled();
  });

  it("rejects at the deadline even if body cancellation never settles", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const { adapter } = adapterFor(response);
    const result = adapter.resolveIdentity("subject").catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(await result).toMatchObject({ message: TIMEOUT, category: "permanent" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
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
    expect(transport.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(stream.reads()).toBe(0);
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(decoder).not.toHaveBeenCalled();
  });

  it("preserves an ordinary transport failure without retrying", async () => {
    vi.useFakeTimers();
    const { adapter, transport } = adapterFor(new Response("unused"));
    const error = new Error("transport failure");
    transport.mockRejectedValue(error);

    await expect(adapter.resolveIdentity("subject")).rejects.toBe(error);
    expect(transport).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
