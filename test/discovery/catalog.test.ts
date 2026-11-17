import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test, vi } from "vitest";

import {
  encodeAddressSegment,
  listingAddress,
} from "../../src/canonical/index.js";
import {
  createCatalogBindingIndex,
  queryListingCatalog,
  type CatalogListingSummary,
} from "../../src/discovery/index.js";

const OWNER = "ab".repeat(32);
const SELLER = `did:demos:agent:${OWNER}`;
const HASH = "cd".repeat(32);
const LISTING_ID = "weather-data";
const LOGICAL_ADDRESS = listingAddress(SELLER, LISTING_ID, 1);
const REVOCATION_LOGICAL_ADDRESS =
  `dacs1-revoked:${encodeAddressSegment(SELLER)}:` +
  `${LISTING_ID}:v1`;

function summary(
  overrides: Partial<CatalogListingSummary> = {},
): CatalogListingSummary {
  return {
    listingId: LISTING_ID,
    version: 1,
    contentHash: HASH,
    anchor: { kind: "storage-program", locator: "stor-listing" },
    seller: { primaryClaim: SELLER, displayName: "Weather Seller" },
    offering: {
      title: "Weather data",
      category: "data.weather",
      tags: ["weather", "hourly"],
    },
    pricing: { priceHint: "1.00", currency: "USDC" },
    status: "active",
    catalogObservedAt: 1_786_000_000_000,
    ...overrides,
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  return new Response(JSON.stringify(value), { ...init, headers });
}

function catalogConfig(fetchImpl: typeof fetch) {
  return {
    catalogUrl: "https://directory.example/api/dacs/listings",
    fetchImpl,
  } as const;
}

describe("queryListingCatalog (DACS-1 §6.3.6)", () => {
  test("serializes every standard filter, repeats tags, and omits ambient credentials", async () => {
    let requestedUrl: URL | undefined;
    let requestedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname === "/.well-known/dacs-directory.json") {
        return jsonResponse(directoryManifest("v1"));
      }
      requestedUrl = new URL(String(input));
      requestedInit = init;
      return jsonResponse({ listings: [summary()], total: 1 });
    };

    const result = await queryListingCatalog(
      catalogConfig(fetchImpl),
      {
        category: "data.weather",
        tag: ["hourly", "signed"],
        credential: "lei",
        primaryClaim: "did",
        rail: "x402:default",
        priceMax: "10.00",
        minCompletionRate: 0.8,
        minRating: 4,
        cursor: "opaque-cursor",
        limit: 25,
      },
    );

    expect(result.status).toBe("ok");
    expect(requestedUrl?.searchParams.get("category")).toBe("data.weather");
    expect(requestedUrl?.searchParams.getAll("tag")).toEqual(["hourly", "signed"]);
    expect(requestedUrl?.searchParams.get("credential")).toBe("lei");
    expect(requestedUrl?.searchParams.get("primaryClaim")).toBe("did");
    expect(requestedUrl?.searchParams.get("rail")).toBe("x402:default");
    expect(requestedUrl?.searchParams.get("priceMax")).toBe("10.00");
    expect(requestedUrl?.searchParams.get("minCompletionRate")).toBe("0.8");
    expect(requestedUrl?.searchParams.get("minRating")).toBe("4");
    expect(requestedUrl?.searchParams.get("cursor")).toBe("opaque-cursor");
    expect(requestedUrl?.searchParams.get("limit")).toBe("25");
    expect(requestedInit).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "error",
    });
    expect(new Headers(requestedInit?.headers).get("accept")).toBe("application/json");
  });

  test("accepts additive catalog metadata but does not promote the summary to verified", async () => {
    const candidate = { ...summary(), artifactProfile: "dacs-v0.1" };
    const result = await queryListingCatalog(
      catalogConfig(async () => jsonResponse({ listings: [candidate] })),
    );
    expect(result).toMatchObject({
      status: "ok",
      page: { listings: [{ listingId: LISTING_ID }] },
    });
    if (result.status === "ok") {
      expect(result.page.listings[0]).not.toHaveProperty("verified");
    }
  });

  test("distinguishes HTTP, transport, malformed, and oversized failures from absence", async () => {
    await expect(
      queryListingCatalog(
        catalogConfig(async () => jsonResponse({}, { status: 503 })),
      ),
    ).resolves.toMatchObject({ status: "indeterminate", reason: "catalog returned HTTP 503" });

    await expect(
      queryListingCatalog(
        catalogConfig(async () => { throw new Error("network unavailable"); }),
      ),
    ).resolves.toMatchObject({
      status: "indeterminate",
      reason: expect.stringContaining("network unavailable"),
    });

    await expect(
      queryListingCatalog(
        catalogConfig(async () => jsonResponse({ listings: [{ listingId: "partial" }] })),
      ),
    ).resolves.toMatchObject({
      status: "indeterminate",
      reason: expect.stringContaining("malformed"),
    });

    await expect(
      queryListingCatalog(
        {
          ...catalogConfig(async () => jsonResponse({ listings: [summary()] })),
          maxResponseBytes: 20,
        },
      ),
    ).resolves.toMatchObject({
      status: "indeterminate",
      reason: expect.stringContaining("maxResponseBytes"),
    });
  });

  test("cancels response bodies rejected before they are read", async () => {
    const httpCancel = vi.fn();
    const httpBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("untrusted error body"));
      },
      cancel: httpCancel,
    });
    await expect(queryListingCatalog(catalogConfig(async () => new Response(
      httpBody,
      { status: 503, headers: { "content-type": "application/json" } },
    )))).resolves.toMatchObject({ status: "indeterminate" });
    expect(httpCancel).toHaveBeenCalledTimes(1);

    const headerCancel = vi.fn();
    const invalidTypeBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("not catalog json"));
      },
      cancel: headerCancel,
    });
    await expect(queryListingCatalog(catalogConfig(async () => new Response(
      invalidTypeBody,
      { headers: { "content-type": "text/plain" } },
    )))).resolves.toMatchObject({
      status: "indeterminate",
      reason: expect.stringContaining("content type"),
    });
    expect(headerCancel).toHaveBeenCalledTimes(1);

    const thrownHeaderCancel = vi.fn();
    const thrownHeaderResponse = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("unread body"));
      },
      cancel: thrownHeaderCancel,
    }));
    Object.defineProperty(thrownHeaderResponse, "headers", {
      configurable: true,
      get() {
        throw new Error("header surface failed");
      },
    });
    await expect(queryListingCatalog(catalogConfig(async () =>
      thrownHeaderResponse))).resolves.toMatchObject({
        status: "indeterminate",
        reason: expect.stringContaining("headers could not be read"),
      });
    expect(thrownHeaderCancel).toHaveBeenCalledTimes(1);
  });

  test("fails closed on RB-3 status/revocation incoherence", async () => {
    const invalidActive = summary({
      revocation: {
        sellerPrimaryClaim: SELLER,
        listingId: LISTING_ID,
        listingVersion: 1,
        listingContentHash: HASH,
        logicalAddress: REVOCATION_LOGICAL_ADDRESS,
        markerAnchor: { kind: "storage-program", locator: "stor-marker" },
        markerContentHash: "ef".repeat(32),
      },
    });
    const result = await queryListingCatalog(
      catalogConfig(async () => jsonResponse({ listings: [invalidActive] })),
    );
    expect(result.status).toBe("indeterminate");
  });

  test("supports cooperative abort and bounded timeout", async () => {
    const pendingFetch: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });

    await expect(
      queryListingCatalog(
        { ...catalogConfig(pendingFetch), timeoutMs: 5 },
      ),
    ).resolves.toEqual({ status: "indeterminate", reason: "catalog request timed out" });

    const controller = new AbortController();
    controller.abort();
    await expect(
      queryListingCatalog(catalogConfig(pendingFetch), {}, { signal: controller.signal }),
    ).resolves.toEqual({ status: "indeterminate", reason: "catalog request was aborted" });
  });

  test("bounds non-cooperative fetches and stalled response bodies", async () => {
    const ignoredSignal: typeof fetch = async () =>
      new Promise<Response>(() => undefined);
    await expect(
      queryListingCatalog({ ...catalogConfig(ignoredSignal), timeoutMs: 5 }),
    ).resolves.toEqual({
      status: "indeterminate",
      reason: "catalog request timed out",
    });

    const never = new Promise<void>(() => undefined);
    const stalledBody: typeof fetch = async () => new Response(
      new ReadableStream<Uint8Array>({
        pull: () => never,
        cancel: () => never,
      }),
      { headers: { "content-type": "application/json" } },
    );
    await expect(
      queryListingCatalog({ ...catalogConfig(stalledBody), timeoutMs: 5 }),
    ).resolves.toEqual({
      status: "indeterminate",
      reason: "catalog request timed out",
    });
  });

  test("cancels a response body that arrives after the request timed out", async () => {
    let resolveFetch!: (response: Response) => void;
    const lateFetch: typeof fetch = async () => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const pending = queryListingCatalog({
      ...catalogConfig(lateFetch),
      timeoutMs: 5,
    });

    await expect(pending).resolves.toEqual({
      status: "indeterminate",
      reason: "catalog request timed out",
    });

    const cancel = vi.fn();
    resolveFetch(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("late response"));
      },
      cancel,
    }), { headers: { "content-type": "application/json" } }));

    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });

  test("rejects non-canonical ClaimReference bytes in catalog summaries", async () => {
    const unsortedParameters = await queryListingCatalog(catalogConfig(async () =>
      jsonResponse({
        listings: [summary({
          seller: {
            primaryClaim: `${SELLER}?z=last&a=first`,
            displayName: "Weather Seller",
          },
        })],
      })));
    expect(unsortedParameters).toMatchObject({
      status: "indeterminate",
      reason: expect.stringContaining("malformed"),
    });

    const malformedDemosProfile = await queryListingCatalog(catalogConfig(async () =>
      jsonResponse({
        listings: [summary({
          seller: {
            primaryClaim: `did:demos:agent:${OWNER.toUpperCase()}`,
            displayName: "Weather Seller",
          },
        })],
      })));
    expect(malformedDemosProfile).toMatchObject({
      status: "indeterminate",
      reason: expect.stringContaining("malformed"),
    });

    const parameterizedDemosProfile = await queryListingCatalog(catalogConfig(async () =>
      jsonResponse({
        listings: [summary({
          seller: {
            primaryClaim: `${SELLER}?jurisdiction=GB`,
            displayName: "Weather Seller",
          },
        })],
      })));
    expect(parameterizedDemosProfile).toMatchObject({ status: "ok" });
  });

  test("enforces DACS-5 rating boundaries independently", async () => {
    const hint = {
      categoryScope: "data.weather",
      completionRate: 1,
      averageSellerRating: 1,
      bundleCount: 1,
      windowStart: 1,
      windowEnd: 2,
      computedAt: 3,
    };
    for (const averageSellerRating of [1, 5]) {
      await expect(queryListingCatalog(catalogConfig(async () => jsonResponse({
        listings: [summary({ reputationHint: { ...hint, averageSellerRating } })],
      })))).resolves.toMatchObject({ status: "ok" });
    }
    for (const averageSellerRating of [0.999, 5.001]) {
      await expect(queryListingCatalog(catalogConfig(async () => jsonResponse({
        listings: [summary({ reputationHint: { ...hint, averageSellerRating } })],
      })))).resolves.toMatchObject({
        status: "indeterminate",
        reason: expect.stringContaining("malformed"),
      });
    }
  });

  test("requires null aggregate metrics independently when bundleCount is zero", async () => {
    const empty = {
      categoryScope: "data.weather",
      completionRate: null,
      averageSellerRating: null,
      bundleCount: 0,
      windowStart: 1,
      windowEnd: 2,
      computedAt: 3,
    };
    await expect(queryListingCatalog(catalogConfig(async () => jsonResponse({
      listings: [summary({ reputationHint: empty })],
    })))).resolves.toMatchObject({ status: "ok" });

    for (const reputationHint of [
      { ...empty, completionRate: 0 },
      { ...empty, averageSellerRating: 1 },
    ]) {
      await expect(queryListingCatalog(catalogConfig(async () => jsonResponse({
        listings: [summary({ reputationHint })],
      })))).resolves.toMatchObject({
        status: "indeterminate",
        reason: expect.stringContaining("malformed"),
      });
    }
  });

  test("rejects insecure or ambiguous client configuration and invalid filters before fetching", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ listings: [] })) as unknown as typeof fetch;
    await expect(
      queryListingCatalog({ catalogUrl: "http://directory.example/api/dacs/listings", fetchImpl }),
    ).rejects.toThrow("HTTPS");
    await expect(
      queryListingCatalog({
        catalogUrl: "https://user:pass@directory.example/api/dacs/listings",
        fetchImpl,
      }),
    ).rejects.toThrow("credentials");
    await expect(
      queryListingCatalog({
        catalogUrl: "https://directory.example/api/dacs/listings?limit=1",
        fetchImpl,
      }),
    ).rejects.toThrow("query or fragment");
    await expect(
      queryListingCatalog(catalogConfig(fetchImpl), { limit: 201 }),
    ).rejects.toThrow("between 1 and 200");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function directoryManifest(version: "v1" | "v2") {
  return JSON.parse(readFileSync(
    new URL(`./fixtures/directory-${version}.json`, import.meta.url), "utf8",
  )) as { dacsDirectoryVersion: string; catalog: string; filters: string[] };
}

describe("Directory rate-filter negotiation (#591)", () => {
  const rates = { minCompletionRate: 0.8, minRating: 4 };
  const manifestUrl = "https://directory.example/.well-known/dacs-directory.json";
  const page = { listings: [summary({ reputationHint: {
    categoryScope: "data.weather", completionRate: null,
    averageSellerRating: null, bundleCount: 0,
    windowStart: 0, windowEnd: 1, computedAt: 1,
  } })] };

  function server(manifest: unknown, status = 200) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return calls.length === 1
        ? jsonResponse(manifest, { status })
        : jsonResponse(page);
    };
    return { calls, config: catalogConfig(fetchImpl) };
  }

  test("v1 sends the original query unchanged when both rates are advertised", async () => {
    const { calls, config } = server(directoryManifest("v1"));
    const query = { ...rates, category: "data.weather", tag: ["a", "b"], limit: 5, cursor: "next" };
    expect(await queryListingCatalog(config, query)).toMatchObject({ status: "ok" });
    expect(calls.map(c => c.url)).toEqual([
      manifestUrl,
      config.catalogUrl + "?category=data.weather&tag=a&tag=b&minCompletionRate=0.8&minRating=4&cursor=next&limit=5",
    ]);
    expect(calls[0]?.init?.signal).toBe(calls[1]?.init?.signal);
    for (const call of calls) {
      expect(call.init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
      expect(new Headers(call.init?.headers).get("accept")).toBe("application/json");
    }
  });

  test.each(["minCompletionRate", "minRating"] as const)(
    "v1 lists only the missing requested filter: %s", async missing => {
      const manifest = directoryManifest("v1");
      manifest.filters = manifest.filters.filter(f => f !== missing);
      const { calls, config } = server(manifest);
      expect(await queryListingCatalog(config, rates)).toEqual({
        status: "indeterminate", reason: expect.any(String),
        code: "unsupported-filter", filters: [missing],
      });
      expect(calls).toHaveLength(1);
    },
  );

  test.each([rates, { minRating: 0 }, { minCompletionRate: 0 }])(
    "v2/TP-1 refuses requested rates without reading listings: %j", async query => {
      const { calls, config } = server(directoryManifest("v2"));
      expect(await queryListingCatalog(config, query)).toEqual({
        status: "indeterminate", reason: expect.any(String),
        code: "unsupported-filter", filters: Object.keys(query),
      });
      expect(calls.map(c => c.url)).toEqual([manifestUrl]);
    },
  );

  test("queries without rates skip the manifest and accept null reputation hints", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(page));
    const result = await queryListingCatalog(catalogConfig(fetchImpl), { limit: 5 });
    expect(result).toMatchObject({ status: "ok", page });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/api/dacs/listings?limit=5");
  });

  test("404 preserves the requested filters without identifying a version", async () => {
    const { calls, config } = server({}, 404);
    expect(await queryListingCatalog(config, rates)).toMatchObject({ status: "ok", page });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe(config.catalogUrl + "?minCompletionRate=0.8&minRating=4");
  });

  test("uses an explicit manifest URL", async () => {
    const { calls, config } = server(directoryManifest("v1"));
    const directoryManifestUrl = "https://capabilities.example/directory.json";
    expect(await queryListingCatalog({ ...config, directoryManifestUrl }, rates))
      .toMatchObject({ status: "ok" });
    expect(calls[0]?.url).toBe(directoryManifestUrl);
  });

  test.each([
    ["null", null], ["array", []], ["empty", {}],
    ["null filters", { ...directoryManifest("v1"), filters: null }],
    ["non-string filter", { ...directoryManifest("v1"), filters: ["minRating", 1] }],
    ["mismatched catalog", { ...directoryManifest("v1"), catalog: "https://other.example/api/dacs/listings" }],
    ["relative catalog", { ...directoryManifest("v1"), catalog: "/api/dacs/listings" }],
    ["unknown version", { ...directoryManifest("v1"), dacsDirectoryVersion: "99" }],
    ["numeric version", { ...directoryManifest("v1"), dacsDirectoryVersion: 1 }],
  ])("malformed, mismatched or unknown manifest blocks listings: %s", async (_name, manifest) => {
    const { calls, config } = server(manifest);
    expect(await queryListingCatalog(config, rates)).toMatchObject({ status: "indeterminate" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(manifestUrl);
  });

  test.each(["json", "utf8", "http", "network", "content-type"])(
    "unreadable manifest blocks listings: %s", async failure => {
      const fetchImpl = vi.fn(async () => {
        if (failure === "network") throw new Error("offline");
        if (failure === "http") return jsonResponse({}, { status: 503 });
        if (failure === "utf8") return new Response(new Uint8Array([255]));
        return new Response(failure === "json" ? "{" : "<html/>", {
          headers: { "content-type": failure === "content-type" ? "text/html" : "application/json" },
        });
      });
      expect(await queryListingCatalog(catalogConfig(fetchImpl), rates))
        .toMatchObject({ status: "indeterminate" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  test("does not require unrequested rate capabilities", async () => {
    const manifest = directoryManifest("v1");
    manifest.filters = manifest.filters.filter(f => f !== "minCompletionRate");
    const { calls, config } = server(manifest);
    expect(await queryListingCatalog(config, { minRating: 0 })).toMatchObject({ status: "ok" });
    expect(calls[1]?.url).toBe(config.catalogUrl + "?minRating=0");
  });

  test.each(["headers", "body"] as const)(
    "the shared deadline bounds non-cooperative manifest %s", async stage => {
      vi.useFakeTimers();
      try {
        const fetchImpl = vi.fn<typeof fetch>(async () => stage === "headers"
          ? new Promise<Response>(() => {})
          : new Response(new ReadableStream({ start() {} })));
        const pending = queryListingCatalog({
          ...catalogConfig(fetchImpl), timeoutMs: 100,
        }, rates);
        await vi.advanceTimersByTimeAsync(100);
        expect(await pending).toMatchObject({
          status: "indeterminate", reason: "catalog request timed out",
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      } finally { vi.useRealTimers(); }
    },
  );

  test("a pre-aborted request performs no network I/O", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(directoryManifest("v1")));
    const controller = new AbortController();
    controller.abort();
    expect(await queryListingCatalog(catalogConfig(fetchImpl), rates, { signal: controller.signal }))
      .toMatchObject({ status: "indeterminate", reason: "catalog request was aborted" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([{ ...rates, limit: 0 }, { minRating: NaN }, { minCompletionRate: 2 }])(
    "validates the complete query before network I/O: %j", async query => {
      const fetchImpl = vi.fn(async () => jsonResponse(directoryManifest("v1")));
      await expect(queryListingCatalog(catalogConfig(fetchImpl), query)).rejects.toThrow(TypeError);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  test.each(["http://capabilities.example/manifest", "/manifest", "https://user:pass@example.test/manifest"])(
    "applies URL safeguards to the manifest override: %s", async directoryManifestUrl => {
      const fetchImpl = vi.fn(async () => jsonResponse(page));
      await expect(queryListingCatalog({
        ...catalogConfig(fetchImpl), directoryManifestUrl,
      }, rates)).rejects.toThrow(TypeError);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  test.each(["manifest", "listings"] as const)(
    "enforces the decoded response size bound for %s", async stage => {
      const manifest = directoryManifest("v1");
      const limit = JSON.stringify(manifest).length + 10;
      let calls = 0;
      const fetchImpl: typeof fetch = async () => {
        calls++;
        const value = stage === "manifest" || calls === 2
          ? { padding: "x".repeat(limit) } : manifest;
        // No Content-Length: exercise the streamed byte count.
        return jsonResponse(value);
      };
      expect(await queryListingCatalog({
        ...catalogConfig(fetchImpl), maxResponseBytes: limit,
      }, rates)).toMatchObject({
        status: "indeterminate", reason: expect.stringContaining("maxResponseBytes"),
      });
      expect(calls).toBe(stage === "manifest" ? 1 : 2);
    },
  );

  test.each(["headers", "body"] as const)(
    "negotiation and listings share one deadline across %s", async stage => {
      vi.useFakeTimers();
      try {
        const signals: (AbortSignal | null | undefined)[] = [];
        const fetchImpl: typeof fetch = async (_input, init) => {
          signals.push(init?.signal);
          if (signals.length === 1) {
            await new Promise(resolve => setTimeout(resolve, 60));
            return jsonResponse(directoryManifest("v1"));
          }
          if (stage === "headers") return new Promise<Response>(() => {});
          return new Response(new ReadableStream({ start() {} }));
        };
        const pending = queryListingCatalog({
          ...catalogConfig(fetchImpl), timeoutMs: 100,
        }, rates);
        await vi.advanceTimersByTimeAsync(60);
        expect(signals).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(40);
        expect(await pending).toMatchObject({
          status: "indeterminate", reason: "catalog request timed out",
        });
        expect(signals[0]).toBe(signals[1]);
        expect(signals[1]?.aborted).toBe(true);
      } finally { vi.useRealTimers(); }
    },
  );

  test.each(["manifest", "listings"] as const)(
    "cancellation bounds a non-cooperative %s body", async stage => {
      const controller = new AbortController();
      let notifyStarted!: () => void;
      const started = new Promise<void>(resolve => { notifyStarted = resolve; });
      const cancel = vi.fn();
      let calls = 0;
      const fetchImpl: typeof fetch = async () => {
        calls++;
        if (stage === "listings" && calls === 1) return jsonResponse(directoryManifest("v1"));
        notifyStarted();
        return new Response(new ReadableStream({ start() {}, cancel }));
      };
      const pending = queryListingCatalog(catalogConfig(fetchImpl), rates, { signal: controller.signal });
      await started;
      await Promise.resolve();
      controller.abort();
      expect(await pending).toMatchObject({
        status: "indeterminate", reason: "catalog request was aborted",
      });
      expect(calls).toBe(stage === "manifest" ? 1 : 2);
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );
});

describe("createCatalogBindingIndex (DACS-1 §6.3.6 catalog client)", () => {
  test("scans opaque pagination and maps a canonical Demos seller claim to its anchor owner", async () => {
    const unrelated = summary({ listingId: "other", anchor: { kind: "ipfs", locator: "cid" } });
    const fetchImpl: typeof fetch = async (input) => {
      const cursor = new URL(String(input)).searchParams.get("cursor");
      return cursor === null
        ? jsonResponse({ listings: [unrelated], cursor: "next-page", total: 2 })
        : jsonResponse({ listings: [summary()], total: 2 });
    };
    const index = createCatalogBindingIndex(catalogConfig(fetchImpl));

    await expect(index.resolve(LOGICAL_ADDRESS, OWNER)).resolves.toEqual({
      status: "present",
      binding: {
        logicalAddress: LOGICAL_ADDRESS,
        anchorKind: "storage-program",
        nativeAddress: "stor-listing",
        owner: OWNER,
        contentHash: HASH,
        version: 1,
      },
    });
  });

  test("maps a parameterized Demos ClaimReference by its CF-3 owner identity", async () => {
    const primaryClaim = `${SELLER}?jurisdiction=GB`;
    const logicalAddress = listingAddress(primaryClaim, LISTING_ID, 1);
    const index = createCatalogBindingIndex(catalogConfig(async () => jsonResponse({
      listings: [summary({
        seller: { primaryClaim, displayName: "Weather Seller" },
      })],
    })));

    await expect(index.resolve(logicalAddress, OWNER)).resolves.toMatchObject({
      status: "present",
      binding: {
        logicalAddress,
        anchorKind: "storage-program",
        owner: OWNER,
      },
    });
  });

  test("returns absent only after a complete, well-formed catalog traversal", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ listings: [] });
    const index = createCatalogBindingIndex(catalogConfig(fetchImpl));
    await expect(index.resolve(LOGICAL_ADDRESS, OWNER)).resolves.toEqual({ status: "absent" });
  });

  test("never guesses between conflicting exact candidates", async () => {
    const index = createCatalogBindingIndex(catalogConfig(async () =>
      jsonResponse({
        listings: [
          summary(),
          summary({ anchor: { kind: "storage-program", locator: "stor-conflict" } }),
        ],
      })));
    await expect(index.resolve(LOGICAL_ADDRESS, OWNER)).resolves.toMatchObject({
      status: "indeterminate",
      reason: expect.stringContaining("disagree"),
    });
  });

  test("deduplicates identical candidates", async () => {
    const index = createCatalogBindingIndex(catalogConfig(async () =>
      jsonResponse({ listings: [summary(), summary()] })));
    await expect(index.resolve(LOGICAL_ADDRESS, OWNER)).resolves.toMatchObject({
      status: "present",
      binding: { nativeAddress: "stor-listing" },
    });
  });

  test("a coherent revoked summary is not returned as a live binding", async () => {
    const revocation = {
      sellerPrimaryClaim: SELLER,
      listingId: LISTING_ID,
      listingVersion: 1,
      listingContentHash: HASH,
      logicalAddress: REVOCATION_LOGICAL_ADDRESS,
      markerAnchor: { kind: "storage-program", locator: "stor-marker" },
      markerContentHash: "ef".repeat(32),
    };
    const index = createCatalogBindingIndex(catalogConfig(async () =>
      jsonResponse({ listings: [summary({ status: "revoked", revocation })] })));
    await expect(index.resolve(LOGICAL_ADDRESS, OWNER)).resolves.toEqual({ status: "absent" });
  });

  test("an unsupported anchor kind on the exact candidate is indeterminate, not absent", async () => {
    const index = createCatalogBindingIndex(catalogConfig(async () =>
      jsonResponse({ listings: [summary({ anchor: { kind: "ipfs", locator: "cid" } })] })));
    await expect(index.resolve(LOGICAL_ADDRESS, OWNER)).resolves.toMatchObject({
      status: "indeterminate",
      reason: expect.stringContaining("unsupported anchor kind ipfs"),
    });
  });

  test("supports an explicitly configured additional anchor kind", async () => {
    const index = createCatalogBindingIndex({
      ...catalogConfig(async () =>
        jsonResponse({ listings: [summary({ anchor: { kind: "ipfs", locator: "cid" } })] })),
      supportedAnchorKinds: ["storage-program", "ipfs"],
    });
    await expect(index.resolve(LOGICAL_ADDRESS, OWNER)).resolves.toMatchObject({
      status: "present",
      binding: { anchorKind: "ipfs", nativeAddress: "cid" },
    });
  });

  test("cursor loops and pagination-bound exhaustion are indeterminate", async () => {
    const looping = createCatalogBindingIndex(catalogConfig(async () =>
      jsonResponse({ listings: [], cursor: "same" })));
    await expect(looping.resolve(LOGICAL_ADDRESS, OWNER)).resolves.toMatchObject({
      status: "indeterminate",
      reason: expect.stringContaining("did not make progress"),
    });

    const bounded = createCatalogBindingIndex({
      ...catalogConfig(async () => jsonResponse({ listings: [], cursor: "more" })),
      maxPages: 1,
    });
    await expect(bounded.resolve(LOGICAL_ADDRESS, OWNER)).resolves.toMatchObject({
      status: "indeterminate",
      reason: expect.stringContaining("1-page bound"),
    });
  });

  test("advertised totals cannot hide an incomplete or changing traversal", async () => {
    const incomplete = createCatalogBindingIndex(catalogConfig(async () =>
      jsonResponse({ listings: [], total: 1 })));
    await expect(incomplete.resolve(LOGICAL_ADDRESS, OWNER)).resolves.toMatchObject({
      status: "indeterminate",
      reason: expect.stringContaining("before the advertised total"),
    });

    const changing = createCatalogBindingIndex(catalogConfig(async (input) => {
      const cursor = new URL(String(input)).searchParams.get("cursor");
      return cursor === null
        ? jsonResponse({ listings: [], cursor: "next", total: 1 })
        : jsonResponse({ listings: [], total: 2 });
    }));
    await expect(changing.resolve(LOGICAL_ADDRESS, OWNER)).resolves.toMatchObject({
      status: "indeterminate",
      reason: expect.stringContaining("total changed"),
    });
  });

  test("catalog failure remains indeterminate through BindingIndex", async () => {
    const index = createCatalogBindingIndex(catalogConfig(async () =>
      jsonResponse({}, { status: 502 })));
    await expect(index.resolve(LOGICAL_ADDRESS, OWNER)).resolves.toEqual({
      status: "indeterminate",
      reason: "catalog returned HTTP 502",
    });
  });

  test("bounds the whole multi-page resolution, not just each request", async () => {
    const pendingFetch: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const index = createCatalogBindingIndex({
      ...catalogConfig(pendingFetch),
      timeoutMs: 1_000,
      resolutionTimeoutMs: 5,
    });
    await expect(index.resolve(LOGICAL_ADDRESS, OWNER)).resolves.toEqual({
      status: "indeterminate",
      reason: "catalog resolution timed out",
    });
  });

  test("does not return a binding that changes between validation scans", async () => {
    let request = 0;
    const index = createCatalogBindingIndex(catalogConfig(async () => {
      request += 1;
      return jsonResponse({
        listings: [summary({
          anchor: {
            kind: "storage-program",
            locator: request === 1 ? "stor-before" : "stor-after",
          },
        })],
      });
    }));
    await expect(index.resolve(LOGICAL_ADDRESS, OWNER)).resolves.toEqual({
      status: "indeterminate",
      reason: "catalog binding changed between bounded validation scans",
    });
  });

  test("does not erase an anchor-kind change when the locator stays the same", async () => {
    let request = 0;
    const index = createCatalogBindingIndex({
      ...catalogConfig(async () => {
        request += 1;
        return jsonResponse({
          listings: [summary({
            anchor: {
              kind: request === 1 ? "storage-program" : "ipfs",
              locator: "same-locator",
            },
          })],
        });
      }),
      supportedAnchorKinds: ["storage-program", "ipfs"],
    });
    await expect(index.resolve(LOGICAL_ADDRESS, OWNER)).resolves.toEqual({
      status: "indeterminate",
      reason: "catalog binding changed between bounded validation scans",
    });
  });
});

describe("catalog summary text bounds count NFC scalar values (DACS-1 §6.3.4)", () => {
  const { vectors } = JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../fixtures/standard-next/listing-string-length-v0.1.json",
      ),
      "utf8",
    ),
  ) as {
    vectors: Array<{
      name: string;
      field: string;
      expected: "pass" | "fail";
      value: string;
    }>;
  };
  // Summaries carry no description; every other vector field reaches a catalog
  // bound. Decomposed vectors arrive composed, see the NFC test at the end.
  const reachable = vectors.filter((v) => v.field !== "description");
  const withText = (field: string, value: string) =>
    field === "displayName"
      ? summary({ seller: { primaryClaim: SELLER, displayName: value } })
      : field === "title"
        ? summary({ offering: { title: value, category: "data.weather", tags: ["weather"] } })
        : summary({ offering: { title: "Weather data", category: "data.weather", tags: [value] } });
  const query = (row: CatalogListingSummary) =>
    queryListingCatalog(catalogConfig(async () => jsonResponse({ listings: [row] })));

  test("replays the ten Standard vectors that reach a catalog bound", () => {
    expect(reachable.map((v) => v.name)).toHaveLength(10);
  });

  for (const vector of reachable) {
    test(`${vector.expected === "pass" ? "admits" : "rejects"} ${vector.name}`, async () => {
      await expect(query(withText(vector.field, vector.value))).resolves.toMatchObject(
        vector.expected === "pass"
          ? { status: "ok" }
          : { status: "indeterminate", reason: expect.stringContaining("malformed") },
      );
    });
  }

  // Not Standard vectors: a pure supplementary-plane title at and over the bound.
  test("admits a 200-character title of supplementary-plane characters", async () => {
    await expect(query(withText("title", "\u{1F600}".repeat(200)))).resolves.toMatchObject({ status: "ok" });
  });
  test("rejects a 201-character title of supplementary-plane characters", async () => {
    await expect(query(withText("title", "\u{1F600}".repeat(201)))).resolves.toMatchObject({
      status: "indeterminate",
      reason: expect.stringContaining("malformed"),
    });
  });

  // Scalar values, not graphemes: one visible character, three scalar values each.
  test("admits 66 ZWJ emoji sequences in a title (198 scalars)", async () => {
    await expect(query(withText("title", "\u{1F469}\u200D\u{1F4BB}".repeat(66)))).resolves.toMatchObject({ status: "ok" });
  });
  test("rejects 67 ZWJ emoji sequences in a title (201 scalars)", async () => {
    await expect(query(withText("title", "\u{1F469}\u200D\u{1F4BB}".repeat(67)))).resolves.toMatchObject({
      status: "indeterminate",
      reason: expect.stringContaining("malformed"),
    });
  });

  // The page is owned through snapshotCanonicalJsonRead, which applies CF-1 NFC once
  // before validation, so decomposed wire text reaches the bound already composed.
  // The bound therefore sees canonically equivalent spellings as the same length.
  test("measures decomposed wire text by its NFC length", async () => {
    await expect(query(withText("title", "e\u0301".repeat(200)))).resolves.toMatchObject({ status: "ok" });
    await expect(query(withText("title", "e\u0301".repeat(201)))).resolves.toMatchObject({
      status: "indeterminate",
      reason: expect.stringContaining("malformed"),
    });
  });
});
