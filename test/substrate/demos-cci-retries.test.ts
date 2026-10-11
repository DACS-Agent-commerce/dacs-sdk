import { afterEach, describe, expect, it, vi } from "vitest";
import { DacsError, SubstrateError, TransientError, faultCategory } from "../../src/errors.js";
import { DemosAdapter, type DemosAdapterConfig } from "../../src/substrate/index.js";

const GCR = { result: 200, response: { xm: {}, web2: {}, ud: [], pqc: {} } };
const TIMEOUT = "Demos GCR identity read timed out";
const FAILED = "Demos GCR identity read failed after transient transport errors";
const success = () => new Response(JSON.stringify(GCR));

function setup(timeoutMs = 5_000) {
  vi.useFakeTimers();
  const transport = vi.fn<typeof fetch>();
  const adapter = new DemosAdapter({
    rpc: "https://node.example/rpc", identityFetch: transport, identityTimeoutMs: timeoutMs,
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

  it.each(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"].flatMap(code => [
    { code, fetchCause: false }, { code, fetchCause: true },
  ]))("recovers from $code (Fetch cause: $fetchCause)", async ({ code, fetchCause }) => {
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
    const { adapter, transport } = setup(5_000);
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
});
