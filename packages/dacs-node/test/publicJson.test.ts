import { describe, expect, it, vi } from "vitest";

import { readDacsPublicJsonV1 } from "../src/publicJson.js";

describe("public JSON reader", () => {
  it("pins an all-public DNS set and returns bounded HTTPS JSON", async () => {
    const request = vi.fn(async (input: { approvedAddresses: readonly string[] }) => ({
      status: 200,
      contentType: "application/json; charset=utf-8",
      bytes: new TextEncoder().encode(JSON.stringify({ ok: true })),
      redirected: false,
      observed: input.approvedAddresses,
    }));
    await expect(readDacsPublicJsonV1("https://seller.example/index.json", {
      dependencies: {
        resolveHost: async () => ["8.8.8.8", "2606:4700:4700::1111"],
        request,
      },
    })).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      approvedAddresses: ["8.8.8.8", "2606:4700:4700::1111"],
      maxBytes: 1_048_576,
    }));
  });

  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "::1",
    "fc00::1",
  ])("rejects non-public DNS result %s before opening a request", async (address) => {
    const request = vi.fn();
    await expect(readDacsPublicJsonV1("https://seller.example/index.json", {
      dependencies: { resolveHost: async () => [address], request },
    })).rejects.toMatchObject({ reasonCode: "public-json-address-unsafe" });
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses redirects, non-JSON media, oversized bodies and invalid UTF-8", async () => {
    const dependencies = (response: object) => ({
      resolveHost: async () => ["8.8.8.8"],
      request: async () => response as never,
    });
    await expect(readDacsPublicJsonV1("https://seller.example/a", {
      dependencies: dependencies({ status: 302, contentType: "application/json", bytes: new Uint8Array([123]), redirected: true }),
    })).rejects.toMatchObject({ reasonCode: "public-json-redirect-refused" });
    await expect(readDacsPublicJsonV1("https://seller.example/a", {
      dependencies: dependencies({ status: 200, contentType: "text/html", bytes: new Uint8Array([123]) }),
    })).rejects.toMatchObject({ reasonCode: "public-json-content-type-invalid" });
    await expect(readDacsPublicJsonV1("https://seller.example/a", {
      maxBytes: 1,
      dependencies: dependencies({ status: 200, contentType: "application/json", bytes: new Uint8Array([123, 125]) }),
    })).rejects.toMatchObject({ reasonCode: "public-json-response-size-invalid" });
    await expect(readDacsPublicJsonV1("https://seller.example/a", {
      dependencies: dependencies({ status: 200, contentType: "application/json", bytes: new Uint8Array([0xff]) }),
    })).rejects.toMatchObject({ reasonCode: "public-json-body-invalid" });
  });
});
