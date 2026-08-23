import { describe, expect, test, vi } from "vitest";

import {
  createDacsPublicHttpsFetchV1,
  DacsPublicHttpsFetchError,
  type DacsPublicHttpsFetchDependenciesV1,
} from "../src/publicFetch.js";

function dependencies(addresses: readonly string[]) {
  const request = vi.fn(async (_input: Readonly<
    Parameters<DacsPublicHttpsFetchDependenciesV1["request"]>[0]
  >) => new Response("challenge", { status: 402 }));
  const value: DacsPublicHttpsFetchDependenciesV1 = {
    resolveHost: async () => addresses,
    request,
  };
  return { value, request };
}

describe("createDacsPublicHttpsFetchV1", () => {
  test.each([
    ["https://localhost/pay", ["127.0.0.1"]],
    ["https://127.0.0.1/pay", ["127.0.0.1"]],
    ["https://10.0.0.1/pay", ["10.0.0.1"]],
    ["https://169.254.169.254/latest/meta-data/", ["169.254.169.254"]],
    ["https://[::1]/pay", ["::1"]],
    ["https://[::ffff:127.0.0.1]/pay", ["::ffff:127.0.0.1"]],
    ["https://seller.example/pay", ["8.8.8.8", "10.0.0.1"]],
  ])("refuses unsafe target %s before request", async (url, addresses) => {
    const deps = dependencies(addresses);
    const fetchImpl = createDacsPublicHttpsFetchV1({ dependencies: deps.value });
    await expect(fetchImpl(url, { redirect: "error" })).rejects.toBeInstanceOf(
      DacsPublicHttpsFetchError,
    );
    expect(deps.request).not.toHaveBeenCalled();
  });

  test("passes only validated addresses, finite bounds, and non-ambient headers", async () => {
    const deps = dependencies(["8.8.8.8", "1.1.1.1"]);
    const fetchImpl = createDacsPublicHttpsFetchV1({
      timeoutMs: 2_000,
      maxBytes: 4_096,
      dependencies: deps.value,
    });
    const response = await fetchImpl("https://seller.example/pay", {
      method: "GET",
      headers: { accept: "application/json", "payment-signature": "retained" },
      redirect: "error",
    });
    expect(response.status).toBe(402);
    expect(deps.request).toHaveBeenCalledOnce();
    const input = deps.request.mock.calls[0]![0];
    expect(input.approvedAddresses).toEqual(["8.8.8.8", "1.1.1.1"]);
    expect(input.timeoutMs).toBe(2_000);
    expect(input.maxBytes).toBe(4_096);
    expect(input.headers.get("payment-signature")).toBe("retained");
    expect(input.headers.get("accept-encoding")).toBe("identity");
  });

  test.each(["authorization", "cookie", "proxy-authorization", "host"])(
    "refuses ambient or connection-authority header %s",
    async (name) => {
      const deps = dependencies(["8.8.8.8"]);
      const fetchImpl = createDacsPublicHttpsFetchV1({ dependencies: deps.value });
      await expect(fetchImpl("https://seller.example/pay", {
        headers: { [name]: "secret" },
        redirect: "error",
      })).rejects.toMatchObject({ reasonCode: "public-fetch-ambient-header-refused" });
      expect(deps.request).not.toHaveBeenCalled();
    },
  );
});
