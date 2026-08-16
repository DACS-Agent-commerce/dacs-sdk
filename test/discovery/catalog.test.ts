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
