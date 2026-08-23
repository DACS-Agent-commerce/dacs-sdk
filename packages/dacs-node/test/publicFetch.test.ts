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
    expect(input.signal.aborted).toBe(false);
    expect(input.headers.get("payment-signature")).toBe("retained");
    expect(input.headers.get("accept-encoding")).toBe("identity");
  });

  test("absolute deadline starts before DNS and never begins a late request", async () => {
    const request = vi.fn(async () => new Response("late", { status: 200 }));
    const fetchImpl = createDacsPublicHttpsFetchV1({
      timeoutMs: 50,
      dependencies: {
        resolveHost: () => new Promise<readonly string[]>(() => undefined),
        request,
      },
    });
    await expect(fetchImpl("https://seller.example/pay", {
      redirect: "error",
    })).rejects.toMatchObject({ reasonCode: "public-fetch-timeout" });
    expect(request).not.toHaveBeenCalled();
  });

  test("absolute deadline aborts a slow-drip request despite continuing activity", async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = createDacsPublicHttpsFetchV1({
      timeoutMs: 50,
      dependencies: {
        resolveHost: async () => ["8.8.8.8"],
        request: async (input) => {
          observedSignal = input.signal;
          return new Promise<Response>((_resolve, reject) => {
            const activity = setInterval(() => undefined, 1);
            input.signal.addEventListener("abort", () => {
              clearInterval(activity);
              reject(input.signal.reason);
            }, { once: true });
          });
        },
      },
    });
    await expect(fetchImpl("https://seller.example/pay", {
      redirect: "error",
    })).rejects.toMatchObject({ reasonCode: "public-fetch-timeout" });
    expect(observedSignal?.aborted).toBe(true);
  });

  test("refuses redirects even when a custom adapter returns one", async () => {
    const deps = dependencies(["8.8.8.8"]);
    deps.request.mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { location: "https://attacker.example/pay" },
    }));
    const fetchImpl = createDacsPublicHttpsFetchV1({ dependencies: deps.value });
    await expect(fetchImpl("https://seller.example/pay", {
      redirect: "error",
    })).rejects.toMatchObject({ reasonCode: "public-fetch-redirect-refused" });
    expect(deps.request).toHaveBeenCalledOnce();
  });

  test("preserves a finite caller-declared delivery bound above one MiB", async () => {
    const deps = dependencies(["8.8.8.8"]);
    const fetchImpl = createDacsPublicHttpsFetchV1({
      maxBytes: 8 * 1_048_576,
      dependencies: deps.value,
    });
    await fetchImpl("https://seller.example/pay", { redirect: "error" });
    expect(deps.request.mock.calls[0]![0].maxBytes).toBe(8 * 1_048_576);
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
