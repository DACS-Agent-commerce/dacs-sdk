import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  requestX402OutboundV1,
  resolveDacsPublicHostV1,
  X402OutboundTransportError,
} from "../../src/rails/x402Outbound.js";

// Only the operating-system boundaries are replaced. The built-in DNS-pinned
// HTTPS transport (the default production dependency) runs unchanged.
const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: network.lookup }));
vi.mock("node:https", () => ({ request: network.request }));

const URL_PAID = "https://seller.example/deliver?job=1";
const PUBLIC_V4 = "93.184.216.34";
const OTHER_PUBLIC_V4 = "8.8.8.8";
const PUBLIC_V6 = "2606:4700:4700::1111";

class FakeClientRequest extends EventEmitter {
  destroyed = false;
  destroyError: unknown;
  timeoutMs: number | undefined;
  onTimeout: (() => void) | undefined;
  onEnd: (() => void) | undefined;

  setTimeout(timeoutMs: number, callback: () => void): this {
    this.timeoutMs = timeoutMs;
    this.onTimeout = callback;
    return this;
  }

  destroy(error?: unknown): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.destroyError = error;
    queueMicrotask(() => {
      if (error !== undefined) this.emit("error", error);
      this.emit("close");
    });
    return this;
  }

  end(): this {
    queueMicrotask(() => this.onEnd?.());
    return this;
  }
}

interface Exchange {
  options: Record<string, unknown>;
  request: FakeClientRequest;
  respond(input: {
    status: number;
    headers?: Record<string, string | string[]>;
    chunks?: Array<string | Uint8Array>;
  }): void;
}

/** Install the fake socket; `onRequest` runs once the request is sent. */
function serve(onRequest?: (exchange: Exchange) => void): Exchange[] {
  const exchanges: Exchange[] = [];
  network.request.mockImplementation((
    options: Record<string, unknown>,
    onResponse: (response: unknown) => void,
  ) => {
    const request = new FakeClientRequest();
    const exchange: Exchange = {
      options,
      request,
      respond({ status, headers = {}, chunks = [] }) {
        const response = Object.assign(new PassThrough(), { statusCode: status, headers });
        onResponse(response);
        for (const chunk of chunks) {
          if (response.destroyed || request.destroyed) return;
          response.write(chunk);
        }
        if (!response.destroyed && !request.destroyed) response.end();
      },
    };
    request.onEnd = () => onRequest?.(exchange);
    exchanges.push(exchange);
    return request;
  });
  return exchanges;
}

function pinnedLookup(options: Record<string, unknown>) {
  const lookup = options.lookup as (
    hostname: string,
    lookupOptions: unknown,
    callback: (error: unknown, ...answer: unknown[]) => void,
  ) => void;
  return {
    all: () => new Promise((resolve) => {
      lookup("seller.example", { all: true }, (_error, addresses) => resolve(addresses));
    }),
    one: () => new Promise((resolve) => {
      lookup("seller.example", {}, (_error, address, family) => resolve([address, family]));
    }),
  };
}

function reasonOf(error: unknown): string | undefined {
  return error instanceof X402OutboundTransportError ? error.reasonCode : undefined;
}

beforeEach(() => {
  network.lookup.mockReset();
  network.request.mockReset();
  network.lookup.mockImplementation(async () => [{ address: PUBLIC_V4, family: 4 }]);
});

describe("default DNS-pinned public HTTPS transport", () => {
  test("pins TLS to the first approved address and keeps hostname verification", async () => {
    network.lookup.mockImplementation(async () => [
      { address: PUBLIC_V4, family: 4 },
      { address: OTHER_PUBLIC_V4, family: 4 },
    ]);
    const exchanges = serve((exchange) => exchange.respond({
      status: 200,
      headers: { "content-type": "application/json", "x-multi": ["a", "b"] },
      chunks: ["{\"ok\":", "true}"],
    }));

    const response = await requestX402OutboundV1({
      url: URL_PAID,
      headers: { accept: "application/json" },
      paymentHeaderMode: "forbid",
    });

    expect(network.lookup).toHaveBeenCalledWith("seller.example", {
      all: true,
      verbatim: true,
    });
    expect(exchanges).toHaveLength(1);
    const options = exchanges[0]!.options;
    expect(options).toMatchObject({
      protocol: "https:",
      hostname: "seller.example",
      servername: "seller.example",
      port: 443,
      path: "/deliver?job=1",
      method: "GET",
      agent: false,
      rejectUnauthorized: true,
      maxHeaderSize: 32 * 1_024,
      headers: {
        accept: "application/json",
        "accept-encoding": "identity",
        "user-agent": "dacs-x402-public-https/v1",
      },
    });
    // Whatever Node asks the connection lookup, only the pinned address answers.
    const lookup = pinnedLookup(options);
    await expect(lookup.all()).resolves.toEqual([{ address: PUBLIC_V4, family: 4 }]);
    await expect(lookup.one()).resolves.toEqual([PUBLIC_V4, 4]);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-multi")).toBe("a, b");
    expect(new TextDecoder().decode(response.bytes)).toBe("{\"ok\":true}");
  });

  test("connects to an IP literal without DNS or SNI", async () => {
    const exchanges = serve((exchange) => exchange.respond({ status: 204 }));
    const response = await requestX402OutboundV1({
      url: `https://[${PUBLIC_V6}]:8443/pay`,
      paymentHeaderMode: "forbid",
    });
    expect(network.lookup).not.toHaveBeenCalled();
    expect(exchanges[0]!.options).toMatchObject({
      hostname: PUBLIC_V6,
      servername: undefined,
      port: 8443,
    });
    await expect(pinnedLookup(exchanges[0]!.options).one())
      .resolves.toEqual([PUBLIC_V6, 6]);
    expect(response.status).toBe(204);
    expect(response.bytes.byteLength).toBe(0);
  });

  test("resolves names through DNS and literals without it", async () => {
    await expect(resolveDacsPublicHostV1(`[${PUBLIC_V6}]`)).resolves.toEqual([PUBLIC_V6]);
    await expect(resolveDacsPublicHostV1(PUBLIC_V4)).resolves.toEqual([PUBLIC_V4]);
    expect(network.lookup).not.toHaveBeenCalled();
    await expect(resolveDacsPublicHostV1("seller.example")).resolves.toEqual([PUBLIC_V4]);
    expect(network.lookup).toHaveBeenCalledOnce();
  });

  test.each([
    [["10.0.0.1"]],
    [[PUBLIC_V4, "127.0.0.1"]],
    [["169.254.169.254"]],
  ])("never opens a socket when DNS answers %j", async (answers) => {
    network.lookup.mockImplementation(async () =>
      answers.map((address) => ({ address, family: 4 })));
    serve();
    const error = await requestX402OutboundV1({
      url: URL_PAID,
      paymentHeaderMode: "forbid",
    }).catch((caught: unknown) => caught);
    expect(reasonOf(error)).toBe("x402-outbound-address-unsafe");
    expect(network.request).not.toHaveBeenCalled();
  });

  test("runs the paid-effect fence after DNS and immediately before connecting", async () => {
    const order: string[] = [];
    network.lookup.mockImplementation(async () => {
      order.push("dns");
      return [{ address: PUBLIC_V4, family: 4 }];
    });
    const served = serve((exchange) => exchange.respond({ status: 200, chunks: ["ok"] }));
    const servedImplementation = network.request.getMockImplementation()!;
    network.request.mockImplementation((...args: unknown[]) => {
      order.push("connect");
      return servedImplementation(...args);
    });

    await requestX402OutboundV1({
      url: URL_PAID,
      headers: { "payment-signature": "signed" },
      paymentHeaderMode: "require-one",
      beforeConnect: async () => {
        order.push("fence");
      },
    });
    expect(order).toEqual(["dns", "fence", "connect"]);
    expect(served).toHaveLength(1);

    const stale = new Error("stale effect generation");
    network.request.mockClear();
    await expect(requestX402OutboundV1({
      url: URL_PAID,
      headers: { "payment-signature": "signed" },
      paymentHeaderMode: "require-one",
      beforeConnect: async () => {
        throw stale;
      },
    })).rejects.toBe(stale);
    expect(network.request).not.toHaveBeenCalled();
  });

  test("refuses request headers that exceed the bound once fixed headers are added", async () => {
    serve();
    // 26 caller bytes fit a 60-byte policy; the two fixed headers do not.
    const error = await requestX402OutboundV1({
      url: URL_PAID,
      headers: { accept: "application/json" },
      paymentHeaderMode: "forbid",
      policy: { maxHeaderBytes: 60 },
    }).catch((caught: unknown) => caught);
    expect(reasonOf(error)).toBe("x402-outbound-headers-too-large");
    expect(network.request).not.toHaveBeenCalled();
  });

  test.each<[string, Parameters<Exchange["respond"]>[0], string]>([
    ["a declared length over the bound", {
      status: 200,
      headers: { "content-length": "17" },
      chunks: ["x".repeat(17)],
    }, "x402-response-too-large"],
    ["a streamed body over the bound", {
      status: 200,
      chunks: ["0123456789", "0123456789"],
    }, "x402-response-too-large"],
    ["a compressed body", {
      status: 200,
      headers: { "content-encoding": "gzip" },
      chunks: ["zz"],
    }, "x402-response-encoding-refused"],
    ["a redirect", {
      status: 302,
      headers: { location: "https://elsewhere.example/" },
    }, "x402-redirect-refused"],
    ["an informational status", { status: 101 }, "x402-response-status-invalid"],
    ["oversized response headers", {
      status: 200,
      headers: { "x-padding": "p".repeat(200) },
    }, "x402-response-headers-too-large"],
  ])("aborts the pinned exchange on %s", async (_label, reply, reason) => {
    serve((exchange) => exchange.respond(reply));
    const error = await requestX402OutboundV1({
      url: URL_PAID,
      paymentHeaderMode: "forbid",
      policy: { maxResponseBytes: 16, maxHeaderBytes: 160 },
    }).catch((caught: unknown) => caught);
    expect(reasonOf(error)).toBe(reason);
  });

  test("destroys a stalled socket on its idle timeout", async () => {
    const exchanges = serve((exchange) => exchange.request.onTimeout?.());
    const error = await requestX402OutboundV1({
      url: URL_PAID,
      paymentHeaderMode: "forbid",
      policy: { timeoutMs: 4_000 },
    }).catch((caught: unknown) => caught);
    expect(reasonOf(error)).toBe("x402-outbound-timeout");
    expect(exchanges[0]!.request.timeoutMs).toBe(4_000);
    expect(exchanges[0]!.request.destroyed).toBe(true);
  });

  test("destroys the socket when the whole-request deadline expires", async () => {
    const exchanges = serve();
    const error = await requestX402OutboundV1({
      url: URL_PAID,
      paymentHeaderMode: "forbid",
      policy: { timeoutMs: 30 },
    }).catch((caught: unknown) => caught);
    expect(reasonOf(error)).toBe("x402-outbound-timeout");
    expect(exchanges[0]!.request.destroyed).toBe(true);
    expect(reasonOf(exchanges[0]!.request.destroyError)).toBe("x402-outbound-timeout");
  });
});
