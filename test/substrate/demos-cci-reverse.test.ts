import nodeHttp, { createServer, type Server } from "node:http";
import nodeHttps from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent as UndiciAgent } from "undici";
import { Identities } from "@kynesyslabs/demosdk/abstraction";
import type { Demos } from "@kynesyslabs/demosdk/websdk";

import { DacsError, SubstrateError, TransientError } from "../../src/errors.js";
import { DEMOS_CCI_RESPONSE_LIMITS } from "../../src/identity/cci.js";
import { DemosAdapter } from "../../src/substrate/index.js";

const RPC = "https://node.example/rpc";
const WALLET = `0x${"11".repeat(20)}`;
const TOO_LARGE = "Demos GCR identity response exceeds maxResponseBytes";
const TIMEOUT = "Demos GCR identity read timed out";
const accounts = (...pubkeys: unknown[]) => ({
  result: 200,
  response: pubkeys.map(pubkey => (pubkey === undefined ? {} : { pubkey })),
});

function withWallet(adapter: DemosAdapter, connected = true) {
  const demos = adapter.raw as unknown as Demos;
  vi.spyOn(demos, "walletConnected", "get").mockReturnValue(connected);
  vi.spyOn(demos, "keypair", "get").mockReturnValue(
    connected ? { publicKey: Buffer.alloc(32, 0xab), privateKey: Buffer.alloc(64) } : null as never,
  );
  // The signature echoes part of the signed message, so it also pins the hash input.
  const sign = vi.spyOn(demos.crypto, "sign").mockImplementation((async (
    _algorithm: string,
    message: Uint8Array,
  ) => ({ signature: Uint8Array.from(message.subarray(0, 8)) })) as never);
  return { demos, sign };
}

function setup(config: { identityMaxResponseBytes?: number } = {}, walletConnected = true) {
  const transport = vi.fn<typeof fetch>();
  const adapter = new DemosAdapter({ rpc: RPC, identityFetch: transport, ...config });
  Object.assign(adapter, { connected: true });
  return { adapter, transport, ...withWallet(adapter, walletConnected) };
}

function streamedResponse(chunks: Uint8Array[]) {
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
  return { response: new Response(body), cancel, reads: () => reads };
}

describe("Demos CCI reverse lookup over the bounded transport", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    {
      ref: "cci-web2:twitter:alice",
      demosdk: (demos: Demos) => new Identities().getDemosIdsByWeb2Identity(demos, "twitter", "alice"),
    },
    {
      ref: `cci-xm:evm:base-sepolia:${WALLET}`,
      demosdk: (demos: Demos) => new Identities().getDemosIdsByWeb3Identity(demos, "evm.base-sepolia", WALLET),
    },
  ])("sends demosdk's own request and headers for $ref, on every attempt", async ({ ref, demosdk }) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const { adapter, transport, demos, sign } = setup();
    Object.assign(demos, { rpc_url: RPC });
    const reply = accounts("subject-a", undefined, "subject-b");
    const doPost = vi.spyOn(
      demos as unknown as { _doPost: (...args: unknown[]) => Promise<unknown> },
      "_doPost",
    ).mockResolvedValue({ data: reply });
    transport.mockImplementation(async (url, init) => {
      await expect(demosdk(demos)).resolves.toEqual(reply.response);
      const [demosUrl, demosRequest, demosHeaders] = doPost.mock.calls.at(-1)!;
      expect(url).toBe(demosUrl);
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify(demosRequest));
      expect(init?.headers).toEqual(demosHeaders);
      return transport.mock.calls.length < 2
        ? new Response("discarded", { status: 503 })
        : new Response(JSON.stringify(reply));
    });

    const result = adapter.findSubjectsByClaim(ref);
    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toEqual(["subject-a", "subject-b"]);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(sign).toHaveBeenCalledTimes(4);
    expect((transport.mock.calls[0]?.[1]?.headers as Record<string, string>).identity)
      .toBe(`ed25519:0x${"ab".repeat(32)}`);
  });

  it.each([16, undefined])("rejects a body over the raw ceiling (%s) before decoding it", async (limit) => {
    const maxBytes = limit ?? DEMOS_CCI_RESPONSE_LIMITS.maxEncodedBytes;
    const { adapter, transport } = setup(limit === undefined ? {} : { identityMaxResponseBytes: limit });
    const stream = streamedResponse([
      new TextEncoder().encode("[".padEnd(maxBytes, " ")),
      new Uint8Array(1),
      new TextEncoder().encode("never read"),
    ]);
    transport.mockResolvedValue(stream.response);
    const decoder = vi.spyOn(TextDecoder.prototype, "decode");

    const error = await adapter.findSubjectsByClaim("cci-web2:github:alice").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DacsError);
    expect(error).toMatchObject({ message: TOO_LARGE, category: "permanent" });
    expect(decoder).not.toHaveBeenCalled();
    expect(stream.reads()).toBe(2);
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
  });

  it("caps the decoded account list at maxArrayLength", async () => {
    const limit = DEMOS_CCI_RESPONSE_LIMITS.maxArrayLength;
    const { adapter, transport } = setup();
    const pubkeys = Array.from({ length: limit }, (_, index) => `subject-${index}`);
    transport.mockResolvedValueOnce(new Response(JSON.stringify(accounts(...pubkeys))));
    await expect(adapter.findSubjectsByClaim("cci-web2:github:alice")).resolves.toEqual(pubkeys);

    transport.mockResolvedValueOnce(new Response(JSON.stringify(accounts(...pubkeys, "one-more"))));
    const error = await adapter.findSubjectsByClaim("cci-web2:github:alice").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DacsError);
    expect(error).toMatchObject({
      message: "Demos GCR identity response exceeds maxArrayLength",
      category: "permanent",
    });
  });

  it("bounds a slow response with the attempt and lookup deadlines", async () => {
    vi.useFakeTimers();
    const { adapter, transport } = setup();
    const cancel = vi.fn();
    transport.mockImplementation(() => new Promise<Response>((resolve) => {
      setTimeout(() => {
        let ticker: ReturnType<typeof setInterval>;
        resolve(new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            ticker = setInterval(() => controller.enqueue(Uint8Array.of(32)), 1_000);
          },
          cancel() {
            clearInterval(ticker);
            cancel();
          },
        })));
      }, 2_000);
    }));
    const decoder = vi.spyOn(TextDecoder.prototype, "decode");
    const result = adapter.findSubjectsByClaim("cci-web2:github:alice").catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(0);
    const signal = transport.mock.calls[0]?.[1]?.signal;

    await vi.advanceTimersByTimeAsync(4_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    // The 12 s lookup deadline ends the third attempt; its late body is cancelled.
    await vi.advanceTimersByTimeAsync(10_751);
    const error = await result;

    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ message: TIMEOUT, category: "transient" });
    expect(error).not.toHaveProperty("cause");
    expect(transport).toHaveBeenCalledTimes(3);
    expect(cancel).toHaveBeenCalledTimes(3);
    expect(decoder).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses a redirect without following or decoding it", async () => {
    const { adapter, transport } = setup();
    transport.mockResolvedValue(new Response("[]", { status: 302, headers: { Location: "/elsewhere" } }));
    await expect(adapter.findSubjectsByClaim("cci-web2:github:alice")).rejects.toMatchObject({
      message: "Demos GCR identity response redirect refused", category: "permanent",
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  it("needs a connected wallet, as demosdk's authenticated rpcCall does, and sends nothing without one", async () => {
    const { adapter, transport, sign } = setup({}, false);
    const error = await adapter.findSubjectsByClaim("cci-web2:github:alice").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DacsError);
    expect(error).toMatchObject({ message: "Demos GCR reverse identity lookup requires a connected wallet" });
    expect(transport).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });

  it.each([
    { reply: { result: 200, response: null }, outcome: [] as string[] },
    { reply: { result: 200 }, outcome: [] as string[] },
    { reply: { result: 200, response: [null, 5, "subject", { pubkey: 7 }, { pubkey: "kept" }] }, outcome: ["kept"] },
  ])("reads only string pubkeys from a 200 result: $reply", async ({ reply, outcome }) => {
    const { adapter, transport } = setup();
    transport.mockResolvedValue(new Response(JSON.stringify(reply)));
    await expect(adapter.findSubjectsByClaim("cci-web2:github:alice")).resolves.toEqual(outcome);
  });

  it.each([
    { reply: { result: 404, response: "not found" }, type: SubstrateError, message: "Demos GCR reverse identity lookup failed" },
    { reply: { result: "200", response: [] }, type: SubstrateError, message: "Demos GCR reverse identity lookup failed" },
    { reply: [], type: SubstrateError, message: "Demos GCR reverse identity lookup failed" },
    { reply: { result: 200, response: { pubkey: "subject" } }, type: DacsError,
      message: "Demos GCR reverse identity response is not an account list" },
  ])("fails closed on an RPC failure or a non-list response: $reply", async ({ reply, type, message }) => {
    const { adapter, transport } = setup();
    transport.mockResolvedValue(new Response(JSON.stringify(reply)));
    const error = await adapter.findSubjectsByClaim("cci-web2:github:alice").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(type);
    expect(error).toMatchObject({ message });
    expect(transport).toHaveBeenCalledOnce();
  });
});

describe("Demos CCI reverse lookup through the private default transport", () => {
  let server: Server | undefined;
  let restoreRoute: () => Promise<void>;

  // Pin the state where demosdk's Axios connects directly, so the adapter
  // takes its private Undici route without an injected identityFetch.
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
    for (const name of ["http_proxy", "https_proxy", "all_proxy"]) {
      vi.stubEnv(name, "");
      vi.stubEnv(name.toUpperCase(), "");
    }
    vi.stubEnv("no_proxy", "127.0.0.1,localhost");
    vi.stubEnv("NO_PROXY", "127.0.0.1,localhost");
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

  async function serve(write: (response: nodeHttp.ServerResponse) => void) {
    const bodies: string[] = [];
    server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8").on("data", (chunk: string) => { body += chunk; }).on("end", () => {
        bodies.push(body);
        write(response);
      });
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const adapter = new DemosAdapter({
      rpc: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
      identityMaxResponseBytes: 1_024,
    });
    Object.assign(adapter, { connected: true });
    withWallet(adapter);
    return { adapter, bodies };
  }

  it("reads a reverse lookup from a real node", async () => {
    const { adapter, bodies } = await serve(response => response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify(accounts("subject-a"))));
    await expect(adapter.findSubjectsByClaim("cci-web2:github:alice")).resolves.toEqual(["subject-a"]);
    expect(bodies.map(body => JSON.parse(body))).toEqual([{
      method: "gcr_routine",
      params: [{ method: "getAccountByIdentity", params: [{ type: "web2", context: "github", username: "alice" }] }],
    }]);
  });

  it("stops reading an endless chunked body from a real node at the raw ceiling", async () => {
    const { adapter } = await serve((response) => {
      let closed = false;
      response.on("close", () => { closed = true; });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write("[");
      const pump = () => {
        while (!closed && response.write(" ".repeat(512))) { /* until backpressure */ }
        if (!closed) response.once("drain", pump);
      };
      pump();
    });
    const error = await adapter.findSubjectsByClaim("cci-web2:github:alice").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DacsError);
    expect(error).toMatchObject({ message: TOO_LARGE, category: "permanent" });
  });
});
