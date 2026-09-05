import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, test, vi } from "vitest";

const httpsRequest = vi.fn();
const dnsLookup = vi.fn();

vi.mock("node:https", () => ({ request: httpsRequest }));
vi.mock("node:dns/promises", () => ({ lookup: dnsLookup }));

function failingRequest() {
  const request = new EventEmitter() as EventEmitter & {
    setTimeout: ReturnType<typeof vi.fn>;
    destroy: (error: Error) => void;
    end: () => void;
  };
  request.setTimeout = vi.fn();
  request.destroy = (error) => request.emit("error", error);
  request.end = () => queueMicrotask(() => request.emit("error", new Error("stop")));
  return request;
}

function informationalResponseRequest(callback: (response: unknown) => void) {
  const request = new EventEmitter() as EventEmitter & {
    setTimeout: ReturnType<typeof vi.fn>;
    destroy: (error: Error) => void;
    end: () => void;
  };
  const response = new EventEmitter() as EventEmitter & {
    statusCode: number;
    headers: Record<string, string>;
    destroy: (error: Error) => void;
  };
  response.statusCode = 199;
  response.headers = {};
  response.destroy = (error) => response.emit("error", error);
  request.setTimeout = vi.fn();
  request.destroy = (error) => request.emit("error", error);
  request.end = () => queueMicrotask(() => callback(response));
  return request;
}

describe("x402 pinned HTTPS socket isolation", () => {
  beforeEach(() => {
    httpsRequest.mockReset();
    httpsRequest.mockImplementation(() => failingRequest());
    dnsLookup.mockReset();
    dnsLookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  });

  test("disables shared-agent reuse and pins a validated IPv4 address", async () => {
    const { requestX402OutboundV1 } = await import("../../src/rails/x402Outbound.js");
    await expect(requestX402OutboundV1({
      url: "https://8.8.8.8/pay",
      paymentHeaderMode: "forbid",
    })).rejects.toThrow("x402-outbound-request-unavailable");
    expect(httpsRequest).toHaveBeenCalledOnce();
    const options = httpsRequest.mock.calls[0]![0] as {
      agent?: unknown;
      hostname?: string;
      lookup?: (...args: unknown[]) => void;
    };
    expect(options).toMatchObject({ agent: false, hostname: "8.8.8.8" });
    const callback = vi.fn();
    options.lookup?.("ignored", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
  });

  test("normalizes and pins an allocated public IPv6 literal", async () => {
    const { requestX402OutboundV1 } = await import("../../src/rails/x402Outbound.js");
    await expect(requestX402OutboundV1({
      url: "https://[2606:4700:4700::1111]/pay",
      paymentHeaderMode: "forbid",
    })).rejects.toThrow("x402-outbound-request-unavailable");
    expect(httpsRequest).toHaveBeenCalledOnce();
    const options = httpsRequest.mock.calls[0]![0] as {
      agent?: unknown;
      hostname?: string;
      lookup?: (...args: unknown[]) => void;
    };
    expect(options).toMatchObject({
      agent: false,
      hostname: "2606:4700:4700::1111",
    });
    const callback = vi.fn();
    options.lookup?.("ignored", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "2606:4700:4700::1111", 6);
  });

  test("preserves the original domain for SNI and certificate verification while pinning DNS", async () => {
    const { requestX402OutboundV1 } = await import("../../src/rails/x402Outbound.js");
    await expect(requestX402OutboundV1({
      url: "https://seller.example/pay",
      paymentHeaderMode: "forbid",
    })).rejects.toThrow("x402-outbound-request-unavailable");
    expect(dnsLookup).toHaveBeenCalledWith("seller.example", {
      all: true,
      verbatim: true,
    });
    const options = httpsRequest.mock.calls[0]![0] as {
      agent?: unknown;
      hostname?: string;
      servername?: string;
      rejectUnauthorized?: boolean;
      lookup?: (...args: unknown[]) => void;
    };
    expect(options).toMatchObject({
      agent: false,
      hostname: "seller.example",
      servername: "seller.example",
      rejectUnauthorized: true,
    });
    const callback = vi.fn();
    options.lookup?.("seller.example", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
  });

  test("rejects a raw terminal informational status without an uncaught callback exception", async () => {
    httpsRequest.mockImplementation((_options, callback) =>
      informationalResponseRequest(callback));
    const { requestX402OutboundV1 } = await import("../../src/rails/x402Outbound.js");
    await expect(requestX402OutboundV1({
      url: "https://8.8.8.8/pay",
      paymentHeaderMode: "forbid",
    })).rejects.toMatchObject({ reasonCode: "x402-response-status-invalid" });
  });
});
