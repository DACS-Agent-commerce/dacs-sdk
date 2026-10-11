import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DacsError, SubstrateError, TransientError, faultCategory } from "../../src/errors.js";
import { DemosAdapter, type DemosAdapterConfig } from "../../src/substrate/index.js";

const GCR = { result: 200, response: { xm: {}, web2: {}, ud: [], pqc: {} } };
const TIMEOUT = "Demos GCR identity read timed out";
const FAILED = "Demos GCR identity read failed after transient transport errors";
const success = () => new Response(JSON.stringify(GCR));

function setup(timeoutMs = 5_000, totalTimeoutMs?: number) {
  vi.useFakeTimers();
  const transport = vi.fn<typeof fetch>();
  const adapter = new DemosAdapter({
    rpc: "https://node.example/rpc", identityFetch: transport, identityTimeoutMs: timeoutMs,
    ...(totalTimeoutMs === undefined ? {} : { identityTotalTimeoutMs: totalTimeoutMs }),
  });
  Object.assign(adapter, { connected: true });
  return { adapter, transport };
}

function stalledBody() {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
  return { response, cancel };
}

async function recover503() {
  const { adapter, transport } = setup();
  transport.mockResolvedValueOnce(new Response("discarded", { status: 503 }))
    .mockImplementationOnce(async () => success());
  const result = adapter.resolveIdentity("subject").catch(error => error);
  await vi.advanceTimersByTimeAsync(250);
  await expect(result).resolves.toHaveProperty("raw", GCR);
  expect(transport).toHaveBeenCalledTimes(2);
}

describe("Demos identity transient retries", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each([502, 503, 504])("recovers from HTTP %s with exactly one 250 ms backoff", async (status) => {
    const { adapter, transport } = setup();
    const failed = stalledBody();
    transport.mockResolvedValueOnce(new Response(failed.response.body, { status }))
      .mockImplementationOnce(async () => success());
    const start = Date.now();
    const result = adapter.resolveIdentity("subject").catch(error => error);
    await vi.advanceTimersByTimeAsync(249);
    expect(transport).toHaveBeenCalledOnce();
    expect(failed.cancel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toHaveProperty("raw", GCR);
    expect(Date.now() - start).toBe(250);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers from a timeout using a fresh, live AbortController", async () => {
    const { adapter, transport } = setup(100);
    const failed = stalledBody();
    transport.mockResolvedValueOnce(failed.response).mockImplementationOnce(async (_url, init) => {
      expect(init?.signal?.aborted).toBe(false);
      init?.signal?.throwIfAborted();
      return success();
    });
    const result = adapter.resolveIdentity("subject").catch(error => error);
    await vi.advanceTimersByTimeAsync(349);
    expect(transport).toHaveBeenCalledOnce();
    expect(failed.cancel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toHaveProperty("raw", GCR);
    const signals = transport.mock.calls.map(([, init]) => init?.signal);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(signals[0]).not.toBe(signals[1]);
  });

  it.each([
    ...["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"].flatMap(code => [
      { code, fetchCause: false }, { code, fetchCause: true },
    ]),
    // Fetch-only codes: a socket closed before any response, and connect timeout.
    { code: "UND_ERR_SOCKET", fetchCause: true },
    { code: "UND_ERR_CONNECT_TIMEOUT", fetchCause: true },
  ])("recovers from $code (Fetch cause: $fetchCause)", async ({ code, fetchCause }) => {
    const { adapter, transport } = setup();
    const cause = Object.assign(new Error("discarded transport details"), { code });
    transport.mockRejectedValueOnce(fetchCause ? new TypeError("fetch failed", { cause }) : cause)
      .mockImplementationOnce(async () => success());
    const result = adapter.resolveIdentity("subject").catch(error => error);
    await vi.advanceTimersByTimeAsync(249);
    expect(transport).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toHaveProperty("raw", GCR);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("exhausts three timeouts within 3 × timeout + 2,750 ms and cancels every body", async () => {
    const { adapter, transport } = setup(100);
    const bodies = Array.from({ length: 3 }, stalledBody);
    bodies.forEach(body => transport.mockResolvedValueOnce(body.response));
    const start = Date.now();
    const result = adapter.resolveIdentity("subject").catch(error => error);
    await vi.advanceTimersByTimeAsync(1_049);
    expect(transport).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    const error = await result;
    expect(Date.now() - start).toBe(3 * 100 + 250 + 500);
    expect(Date.now() - start).toBeLessThan(3 * 100 + 2_750);
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ message: TIMEOUT, category: "transient" });
    expect(faultCategory(error)).toBe("transient");
    expect(error).not.toHaveProperty("cause");
    bodies.forEach(({ cancel, response }) => {
      expect(cancel).toHaveBeenCalledOnce();
      expect(response.body?.locked).toBe(false);
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["60", "Thu, 01 Jan 2099 00:00:00 GMT"])("caps Retry-After %s at 2 seconds", async (retryAfter) => {
    const { adapter, transport } = setup();
    transport.mockResolvedValueOnce(new Response("discarded", {
      status: 503, headers: { "Retry-After": retryAfter },
    })).mockImplementationOnce(async () => success());
    const result = adapter.resolveIdentity("subject").catch(error => error);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(transport).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toHaveProperty("raw", GCR);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("enforces the overall deadline when two Retry-After waits consume the budget", async () => {
    // A large total leaves 3 × timeout + 2,750 ms as the binding bound.
    const { adapter, transport } = setup(5_000, 90_000);
    const bodies = Array.from({ length: 3 }, stalledBody);
    transport.mockImplementation((_url, init) => new Promise(resolve => {
      const index = transport.mock.calls.length - 1;
      if (index < 2) {
        setTimeout(() => resolve(new Response(bodies[index]!.response.body, {
          status: 503, headers: { "Retry-After": "60" },
        })), 4_999);
      } else {
        expect(init?.signal?.aborted).toBe(false);
        resolve(bodies[index]!.response);
      }
    }));
    const start = Date.now();
    let settled = false;
    const result = adapter.resolveIdentity("subject").catch(error => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(17_749);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await result;
    expect(Date.now() - start).toBe(3 * 5_000 + 2_750);
    expect(error).toBeInstanceOf(TransientError);
    expect(error.message).toBe(TIMEOUT);
    expect(transport).toHaveBeenCalledTimes(3);
    bodies.forEach(({ cancel }) => expect(cancel).toHaveBeenCalledOnce());
    expect(transport.mock.calls[2]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    // Date.parse accepts these leniently; most become past dates.
    "-1", "5, 5", "foo 2", "1.2.3",
    // Not delay-seconds or an exact IMF-fixdate.
    "", "junk", "1.5", "+5",
    // Future dates in the wrong format: they would cap at 2 s if accepted.
    "Sat, 06 Nov 2099 08:49:37 GMT", "Fri, 6 Nov 2099 08:49:37 GMT", "Fri Nov  6 08:49:37 2099",
    // Valid, but shorter than the backoff.
    "0", "Sun, 06 Nov 1994 08:49:37 GMT",
  ])("never waits less or more than the 250 ms backoff for Retry-After %j", async (retryAfter) => {
    const { adapter, transport } = setup();
    transport.mockResolvedValueOnce(new Response("discarded", {
      status: 503, headers: { "Retry-After": retryAfter },
    })).mockImplementationOnce(async () => success());
    const result = adapter.resolveIdentity("subject").catch(error => error);
    await vi.advanceTimersByTimeAsync(249);
    expect(transport).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toHaveProperty("raw", GCR);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each([
    { retryAfter: ["1", "0"], calls: [1_000, 1_500] },
    { retryAfter: ["Sun, 06 Nov 1994 08:49:38 GMT", "1"], calls: [1_000, 2_000] },
  ])("waits max(backoff, Retry-After) for $retryAfter", async ({ retryAfter, calls }) => {
    const { adapter, transport } = setup();
    vi.setSystemTime(Date.UTC(1994, 10, 6, 8, 49, 37));
    for (const value of retryAfter) {
      transport.mockResolvedValueOnce(new Response("discarded", {
        status: 503, headers: { "Retry-After": value },
      }));
    }
    transport.mockImplementationOnce(async () => success());
    const result = adapter.resolveIdentity("subject").catch(error => error);
    for (const [index, at] of calls.entries()) {
      await vi.advanceTimersByTimeAsync(at - 1 - (index === 0 ? 0 : calls[index - 1]!));
      expect(transport).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(transport).toHaveBeenCalledTimes(index + 2);
    }
    await expect(result).resolves.toHaveProperty("raw", GCR);
  });

  it.each([
    { timeoutMs: 5_000, totalTimeoutMs: undefined, endMs: 12_000, attempts: 3 },
    { timeoutMs: 8_000, totalTimeoutMs: undefined, endMs: 12_000, attempts: 2 },
    { timeoutMs: 100, totalTimeoutMs: undefined, endMs: 1_050, attempts: 3 },
    { timeoutMs: 5_000, totalTimeoutMs: 4_000, endMs: 4_000, attempts: 1 },
    { timeoutMs: 5_000, totalTimeoutMs: 90_000, endMs: 15_750, attempts: 3 },
    { timeoutMs: 30_000, totalTimeoutMs: 90_000, endMs: 90_000, attempts: 3 },
  ])("ends a silent lookup at $endMs ms (timeout $timeoutMs, total $totalTimeoutMs)", async ({
    timeoutMs, totalTimeoutMs, endMs, attempts,
  }) => {
    const { adapter, transport } = setup(timeoutMs, totalTimeoutMs);
    transport.mockImplementation(() => new Promise<Response>(() => {}));
    const start = Date.now();
    let settled = false;
    const result = adapter.resolveIdentity("subject").catch(error => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(endMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const error = await result;
    expect(Date.now() - start).toBe(endMs);
    // The documented bound: min(3 × identityTimeoutMs + 2.75 s, identityTotalTimeoutMs).
    expect(endMs).toBeLessThanOrEqual(Math.min(3 * timeoutMs + 2_750, totalTimeoutMs ?? 12_000));
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ message: TIMEOUT, category: "transient" });
    expect(error).not.toHaveProperty("cause");
    expect(transport).toHaveBeenCalledTimes(attempts);
    transport.mock.calls.forEach(([, init]) => expect(init?.signal?.aborted).toBe(true));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts no wait the overall deadline would cut short, ending inside dacs-node's 15 s", async () => {
    const { adapter, transport } = setup();
    const bodies = Array.from({ length: 2 }, stalledBody);
    transport.mockImplementation(() => new Promise(resolve => {
      const body = bodies[transport.mock.calls.length - 1]!;
      setTimeout(() => resolve(new Response(body.response.body, {
        status: 503, headers: { "Retry-After": "60" },
      })), 4_999);
    }));
    const start = Date.now();
    let settled = false;
    const result = adapter.resolveIdentity("subject").catch(error => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(11_997);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const error = await result;
    // 503 at 4,999 ms, 2 s wait, 503 at 11,998 ms: a second 2 s wait would pass 12 s.
    expect(Date.now() - start).toBe(11_998);
    expect(Date.now() - start).toBeLessThan(15_000);
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ message: FAILED, category: "transient" });
    expect(error).not.toHaveProperty("cause");
    expect(transport).toHaveBeenCalledTimes(2);
    bodies.forEach(({ cancel }) => expect(cancel).toHaveBeenCalledOnce());
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([502, 503, 504, "ECONNRESET"])("sanitizes exhausted transient failure %s", async (failure) => {
    const { adapter, transport } = setup();
    const cancellations = [vi.fn(), vi.fn(), vi.fn()];
    transport.mockImplementation(async () => {
      if (typeof failure === "string") {
        throw new TypeError("response-sentinel", { cause: { code: failure } });
      }
      return new Response(new ReadableStream({ cancel: cancellations[transport.mock.calls.length - 1] }), {
        status: failure,
      });
    });
    const result = adapter.resolveIdentity("subject").catch(error => error);
    await vi.advanceTimersByTimeAsync(750);
    const error = await result;
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ message: FAILED, category: "transient" });
    expect(error).not.toHaveProperty("cause");
    expect(transport).toHaveBeenCalledTimes(3);
    if (typeof failure === "number") cancellations.forEach(cancel => expect(cancel).toHaveBeenCalledOnce());
  });

  it.each([
    { kind: "overflow", response: () => new Response("discarded", { headers: { "Content-Length": "2097153" } }), message: "exceeds maxResponseBytes", errorClass: DacsError },
    { kind: "redirect", response: () => new Response("discarded", { status: 302 }), message: "redirect refused", errorClass: DacsError },
    { kind: "JSON", response: () => new Response("invalid-json-sentinel"), message: "not valid UTF-8 JSON", errorClass: DacsError },
    { kind: "UTF-8", response: () => new Response(Uint8Array.of(255)), message: "not valid UTF-8 JSON", errorClass: DacsError },
    { kind: "400", response: () => new Response("discarded", { status: 400 }), message: "HTTP 400", errorClass: SubstrateError },
    { kind: "500", response: () => new Response("discarded", { status: 500 }), message: "HTTP 500", errorClass: SubstrateError },
  ])("retries 503 but never retries $kind", async ({ response, message, errorClass }) => {
    // Positive control makes each regression case fail on the no-retry PR.
    await recover503();
    const { adapter, transport } = setup();
    transport.mockImplementation(async () => response());
    const result = adapter.resolveIdentity("subject").catch(error => error);
    await vi.advanceTimersByTimeAsync(17_750);
    const error = await result;
    expect(error).toBeInstanceOf(errorClass);
    expect(error.message).toContain(message);
    expect(error).not.toHaveProperty("cause");
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 1.5, 30_001, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "8000"])(
    "rejects unsafe identityTimeoutMs %s", value => {
      expect(() => new DemosAdapter({ rpc: "https://node.example/rpc", identityTimeoutMs: value } as DemosAdapterConfig))
        .toThrow(/identityTimeoutMs must be a positive safe integer at most 30000/);
    },
  );

  it("accepts 30,000 ms and lets a six-second reply succeed within a configured eight seconds", async () => {
    expect(() => new DemosAdapter({ rpc: "https://node.example/rpc", identityTimeoutMs: 30_000 })).not.toThrow();
    const { adapter, transport } = setup(8_000);
    transport.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(success()), 6_000)));
    const result = adapter.resolveIdentity("subject").catch(error => error);
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(result).resolves.toHaveProperty("raw", GCR);
    expect(transport).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("captures the timeout as stable data at construction", async () => {
    vi.useFakeTimers();
    const transport = vi.fn<typeof fetch>().mockImplementation(() =>
      new Promise(resolve => setTimeout(() => resolve(success()), 6_000)));
    const config = { rpc: "https://node.example/rpc", identityFetch: transport, identityTimeoutMs: 8_000 };
    const adapter = new DemosAdapter(config);
    config.identityTimeoutMs = 1;
    Object.assign(adapter, { connected: true });
    const result = adapter.resolveIdentity("subject").catch(error => error);
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(result).resolves.toHaveProperty("raw", GCR);
    expect(transport).toHaveBeenCalledOnce();
    const getter = vi.fn(() => 8_000);
    const accessor = { rpc: config.rpc };
    Object.defineProperty(accessor, "identityTimeoutMs", { get: getter });
    expect(() => new DemosAdapter(accessor)).toThrow(/identityTimeoutMs.*stable data/);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, 90_001, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "12000"])(
    "rejects unsafe identityTotalTimeoutMs %s", value => {
      expect(() => new DemosAdapter({ rpc: "https://node.example/rpc", identityTotalTimeoutMs: value } as DemosAdapterConfig))
        .toThrow(/identityTotalTimeoutMs must be a positive safe integer at most 90000/);
    },
  );

  it("accepts 90,000 ms and captures identityTotalTimeoutMs as stable data at construction", async () => {
    expect(() => new DemosAdapter({ rpc: "https://node.example/rpc", identityTotalTimeoutMs: 90_000 })).not.toThrow();
    vi.useFakeTimers();
    const transport = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => {}));
    const config = { rpc: "https://node.example/rpc", identityFetch: transport, identityTotalTimeoutMs: 1_000 };
    const adapter = new DemosAdapter(config);
    config.identityTotalTimeoutMs = 90_000;
    Object.assign(adapter, { connected: true });
    let settled = false;
    const result = adapter.resolveIdentity("subject").catch(error => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(true);
    expect(await result).toMatchObject({ message: TIMEOUT, category: "transient" });
    expect(transport).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const getter = vi.fn(() => 12_000);
    const accessor = { rpc: config.rpc };
    Object.defineProperty(accessor, "identityTotalTimeoutMs", { get: getter });
    expect(() => new DemosAdapter(accessor)).toThrow(/identityTotalTimeoutMs.*stable data/);
    expect(getter).not.toHaveBeenCalled();
  });
});

// Node's own fetch against a real socket: these are the errors a restarting node produces.
describe("Demos identity reads against a real local HTTP server", () => {
  let server: Server | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    server?.closeAllConnections();
    await new Promise(resolve => (server ? server.close(resolve) : resolve(undefined)));
    server = undefined;
  });

  async function serve(handler: (request: IncomingMessage, response: ServerResponse, connection: number) => void) {
    let connections = 0;
    let requests = 0;
    server = createServer((request, response) => {
      requests++;
      handler(request, response, connections);
    });
    server.on("connection", () => { connections++; });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const adapter = new DemosAdapter({ rpc: `http://127.0.0.1:${port}/` });
    Object.assign(adapter, { connected: true });
    return { adapter, counts: () => ({ connections, requests }) };
  }

  // Read the whole request first so the close is a clean FIN, not a reset.
  const closeCleanly = (request: IncomingMessage) => {
    request.resume().on("end", () => request.socket.destroy());
  };

  it("retries a connection the node closes before responding", async () => {
    const { adapter, counts } = await serve((request, response, connection) => {
      if (connection === 1) return closeCleanly(request);
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(GCR));
    });
    await expect(adapter.resolveIdentity("subject")).resolves.toHaveProperty("raw", GCR);
    expect(counts()).toEqual({ connections: 2, requests: 2 });
  });

  it("ends repeated closes in the stable TransientError, without the Fetch error or its cause", async () => {
    const { adapter, counts } = await serve(request => closeCleanly(request));
    const error = await adapter.resolveIdentity("subject").catch(caught => caught);
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ message: FAILED, category: "transient" });
    expect(error).not.toHaveProperty("cause");
    expect(inspect(error)).not.toMatch(/127\.0\.0\.1|UND_ERR_SOCKET|fetch failed/);
    expect(counts()).toEqual({ connections: 3, requests: 3 });
  });

  it("does not retry a connection closed mid-body, and drops the Fetch error", async () => {
    const { adapter, counts } = await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": "4096" });
      response.write(JSON.stringify(GCR).slice(0, 10), () => response.socket?.destroy());
    });
    const error = await adapter.resolveIdentity("subject").catch(caught => caught);
    expect(error).toBeInstanceOf(TransientError);
    expect(error).toMatchObject({ message: FAILED, category: "transient" });
    expect(error).not.toHaveProperty("cause");
    expect(inspect(error)).not.toMatch(/127\.0\.0\.1|UND_ERR_SOCKET|terminated/);
    expect(counts()).toEqual({ connections: 1, requests: 1 });
  });
});
