import { describe, expect, test, vi } from "vitest";

import {
  createDacsPublicHttpsFetchV1,
  requestX402OutboundV1,
  X402OutboundTransportError,
  type DacsPublicHttpsDependenciesV1,
} from "../../src/rails/x402Outbound.js";

function dependencies(
  addresses: readonly string[],
  response: () => Response = () => new Response("challenge", { status: 402 }),
) {
  const request = vi.fn(async (input: Readonly<
    Parameters<DacsPublicHttpsDependenciesV1["request"]>[0]
  >) => {
    await input.beforeConnect?.();
    return response();
  });
  const value: DacsPublicHttpsDependenciesV1 = {
    resolveHost: async () => addresses,
    request,
  };
  return { value, request };
}

describe("safe x402 outbound transport", () => {
  test.each([
    ["http://seller.example/pay", ["8.8.8.8"]],
    ["https://user:secret@seller.example/pay", ["8.8.8.8"]],
    ["https://seller.example/pay#fragment", ["8.8.8.8"]],
    ["https://localhost/pay", ["127.0.0.1"]],
    ["https://127.0.0.1/pay", ["127.0.0.1"]],
    ["https://169.254.169.254/latest/meta-data", ["169.254.169.254"]],
    ["https://[::1]/pay", ["::1"]],
    ["https://[::ffff:127.0.0.1]/pay", ["::ffff:127.0.0.1"]],
    ["https://seller.example/pay", ["8.8.8.8", "10.0.0.1"]],
  ])("refuses unsafe target %s before request", async (url, addresses) => {
    const deps = dependencies(addresses);
    await expect(requestX402OutboundV1({
      url,
      paymentHeaderMode: "forbid",
      dependencies: deps.value,
    })).rejects.toBeInstanceOf(X402OutboundTransportError);
    expect(deps.request).not.toHaveBeenCalled();
  });

  test("validates every answer, pins the set, then fences directly before request", async () => {
    const events: string[] = [];
    const request = vi.fn(async (input: Readonly<
      Parameters<DacsPublicHttpsDependenciesV1["request"]>[0]
    >) => {
      events.push("request-entered");
      await input.beforeConnect?.();
      events.push("socket-opened");
      return new Response("ok", { status: 200 });
    });
    const result = await requestX402OutboundV1({
      url: "https://seller.example/pay",
      headers: { accept: "application/json", "payment-signature": "retained" },
      paymentHeaderMode: "require-one",
      dependencies: {
        resolveHost: async () => {
          events.push("dns");
          return ["8.8.8.8", "1.1.1.1"];
        },
        request,
      },
      beforeConnect: async () => {
        events.push("fence");
      },
    });
    expect(events).toEqual(["dns", "request-entered", "fence", "socket-opened"]);
    expect(result.status).toBe(200);
    expect(new TextDecoder().decode(result.bytes)).toBe("ok");
    expect(request.mock.calls[0]![0].approvedAddresses).toEqual([
      "8.8.8.8",
      "1.1.1.1",
    ]);
  });

  test("refuses redirect responses and cancels their body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
    });
    const deps = dependencies(["8.8.8.8"], () => new Response(body, {
      status: 307,
      headers: { location: "https://attacker.example/steal" },
    }));
    await expect(requestX402OutboundV1({
      url: "https://seller.example/pay",
      headers: { "payment-signature": "secret" },
      paymentHeaderMode: "require-one",
      dependencies: deps.value,
    })).rejects.toMatchObject({ reasonCode: "x402-redirect-refused" });
    expect(cancelled).toBe(true);
    expect(deps.request).toHaveBeenCalledOnce();
  });

  test("counts streaming response bytes and cancels before retaining beyond the cap", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
      },
      cancel() {
        cancelled = true;
      },
    });
    const deps = dependencies(["8.8.8.8"], () => new Response(body));
    await expect(requestX402OutboundV1({
      url: "https://seller.example/pay",
      paymentHeaderMode: "forbid",
      policy: { maxResponseBytes: 10 },
      dependencies: deps.value,
    })).rejects.toMatchObject({ reasonCode: "x402-response-too-large" });
    expect(cancelled).toBe(true);
  });

  test("deadline starts before DNS and prevents a late socket", async () => {
    const request = vi.fn(async () => new Response("late"));
    await expect(requestX402OutboundV1({
      url: "https://seller.example/pay",
      paymentHeaderMode: "forbid",
      policy: { timeoutMs: 20 },
      dependencies: {
        resolveHost: () => new Promise<readonly string[]>(() => undefined),
        request,
      },
    })).rejects.toMatchObject({ reasonCode: "x402-outbound-timeout" });
    expect(request).not.toHaveBeenCalled();
  });

  test("deadline cancels a response body that stops producing bytes", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const deps = dependencies(["8.8.8.8"], () => new Response(body));
    await expect(requestX402OutboundV1({
      url: "https://seller.example/pay",
      paymentHeaderMode: "forbid",
      policy: { timeoutMs: 20 },
      dependencies: deps.value,
    })).rejects.toMatchObject({ reasonCode: "x402-outbound-timeout" });
    expect(cancelled).toBe(true);
  });

  test("refuses oversized response headers before consuming the body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
    });
    const deps = dependencies(["8.8.8.8"], () => new Response(body, {
      headers: { "x-large": "a".repeat(100) },
    }));
    await expect(requestX402OutboundV1({
      url: "https://seller.example/pay",
      paymentHeaderMode: "forbid",
      policy: { maxHeaderBytes: 64 },
      dependencies: deps.value,
    })).rejects.toMatchObject({ reasonCode: "x402-response-headers-too-large" });
    expect(cancelled).toBe(true);
  });

  test("refuses encoded response bodies and cancels them", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
    });
    const deps = dependencies(["8.8.8.8"], () => new Response(body, {
      headers: { "content-encoding": "gzip" },
    }));
    await expect(requestX402OutboundV1({
      url: "https://seller.example/pay",
      paymentHeaderMode: "forbid",
      dependencies: deps.value,
    })).rejects.toMatchObject({ reasonCode: "x402-response-encoding-refused" });
    expect(cancelled).toBe(true);
  });

  test("requires an explicit injected transport for insecure local development", async () => {
    const fetchImpl = vi.fn(async () => new Response("local"));
    const result = await requestX402OutboundV1({
      url: "http://127.0.0.1:8080/pay",
      paymentHeaderMode: "forbid",
      policy: { mode: "insecure-test" },
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledOnce();

    await expect(requestX402OutboundV1({
      url: "http://127.0.0.1:8080/pay",
      paymentHeaderMode: "forbid",
      policy: { mode: "insecure-test" },
    })).rejects.toMatchObject({
      reasonCode: "x402-insecure-mode-requires-fetch-override",
    });
  });

  test("never selects an injected fetch under the production policy", async () => {
    const fetchImpl = vi.fn(async () => new Response("must not run"));
    await expect(requestX402OutboundV1({
      url: "https://seller.example/pay",
      paymentHeaderMode: "forbid",
      fetchImpl: fetchImpl as typeof fetch,
    })).rejects.toMatchObject({
      reasonCode: "x402-fetch-override-requires-insecure-mode",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("accepts only stable Accept plus explicitly authorized payment headers", async () => {
    const deps = dependencies(["8.8.8.8"]);
    await expect(requestX402OutboundV1({
      url: "https://seller.example/pay",
      headers: { "x-api-key": "ambient-secret" },
      paymentHeaderMode: "forbid",
      dependencies: deps.value,
    })).rejects.toMatchObject({ reasonCode: "x402-outbound-header-refused" });
    await expect(requestX402OutboundV1({
      url: "https://seller.example/pay",
      headers: { accept: "application/json" },
      paymentHeaderMode: "require-one",
      dependencies: deps.value,
    })).rejects.toMatchObject({
      reasonCode: "x402-outbound-payment-header-invalid",
    });
    expect(deps.request).not.toHaveBeenCalled();
  });

  test("rejects proxy and accessor-backed header input without invoking getters", async () => {
    let reads = 0;
    const accessor = {} as Record<string, string>;
    Object.defineProperty(accessor, "accept", {
      enumerable: true,
      get() {
        reads += 1;
        return "application/json";
      },
    });
    const deps = dependencies(["8.8.8.8"]);
    for (const headers of [accessor, new Proxy({ accept: "application/json" }, {})]) {
      await expect(requestX402OutboundV1({
        url: "https://seller.example/pay",
        headers,
        paymentHeaderMode: "forbid",
        dependencies: deps.value,
      })).rejects.toMatchObject({ reasonCode: "x402-outbound-headers-unstable" });
    }
    expect(reads).toBe(0);
    expect(deps.request).not.toHaveBeenCalled();
  });

  test("captures header tuples without invoking caller-owned array methods or indices", async () => {
    let reads = 0;
    const ownMap = [["accept", "application/json"]] as Array<[string, string]>;
    Object.defineProperty(ownMap, "map", {
      get() {
        reads += 1;
        return Array.prototype.map;
      },
    });
    const accessor = [["accept", "application/json"]] as Array<[string, string]>;
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        reads += 1;
        return ["accept", "application/json"];
      },
    });
    const tupleAccessor = [["accept", "application/json"]] as Array<[string, string]>;
    Object.defineProperty(tupleAccessor[0]!, "1", {
      enumerable: true,
      get() {
        reads += 1;
        return "application/json";
      },
    });
    const symbol = [["accept", "application/json"]] as Array<[string, string]>;
    Object.defineProperty(symbol, Symbol("authority"), { value: "hidden" });
    const deps = dependencies(["8.8.8.8"]);
    for (const headers of [ownMap, accessor, tupleAccessor, symbol]) {
      await expect(requestX402OutboundV1({
        url: "https://seller.example/pay",
        headers,
        paymentHeaderMode: "forbid",
        dependencies: deps.value,
      })).rejects.toMatchObject({ reasonCode: "x402-outbound-headers-unstable" });
    }
    expect(reads).toBe(0);
    expect(deps.request).not.toHaveBeenCalled();
  });

  test("narrow public GET refuses broader fetch shapes and credential headers", async () => {
    const deps = dependencies(["8.8.8.8"]);
    const publicGet = createDacsPublicHttpsFetchV1({ dependencies: deps.value });
    await expect(publicGet("https://seller.example/pay", {
      method: "POST",
    } as never)).rejects.toMatchObject({
      reasonCode: "x402-outbound-request-shape-refused",
    });
    await expect(publicGet("https://seller.example/pay", {
      headers: { authorization: "Bearer ambient-secret" },
    })).rejects.toMatchObject({ reasonCode: "x402-outbound-header-refused" });
    expect(deps.request).not.toHaveBeenCalled();
  });

  test("narrow public GET retains the dacs-node maxBytes option", async () => {
    const deps = dependencies(["8.8.8.8"]);
    const fetchImpl = createDacsPublicHttpsFetchV1({
      maxBytes: 4_096,
      dependencies: deps.value,
    });
    await fetchImpl("https://seller.example/pay");
    expect(deps.request.mock.calls[0]![0].maxBytes).toBe(4_096);
  });

  test("narrow public GET binds resolver/request methods at creation", async () => {
    const first = dependencies(["8.8.8.8"]);
    const secondRequest = vi.fn(async () => new Response("substituted"));
    const mutable = first.value as {
      resolveHost: DacsPublicHttpsDependenciesV1["resolveHost"];
      request: DacsPublicHttpsDependenciesV1["request"];
    };
    const fetchImpl = createDacsPublicHttpsFetchV1({ dependencies: mutable });
    mutable.resolveHost = async () => ["127.0.0.1"];
    mutable.request = secondRequest;
    await expect(fetchImpl("https://seller.example/pay"))
      .resolves.toMatchObject({ status: 402 });
    expect(first.request).toHaveBeenCalledOnce();
    expect(secondRequest).not.toHaveBeenCalled();
  });

  test("generic public GET can never carry a payment bearer", async () => {
    const deps = dependencies(["8.8.8.8"]);
    const ordinary = createDacsPublicHttpsFetchV1({ dependencies: deps.value });
    await expect(ordinary("https://seller.example/pay", {
      headers: { "PAYMENT-SIGNATURE": "retained" },
    })).rejects.toMatchObject({ reasonCode: "x402-outbound-header-refused" });
    expect(deps.request).not.toHaveBeenCalled();
  });
});
