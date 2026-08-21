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
        nativeAddress: "stor-listing",
        owner: OWNER,
        contentHash: HASH,
        version: 1,
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
      binding: { nativeAddress: "cid" },
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
});
