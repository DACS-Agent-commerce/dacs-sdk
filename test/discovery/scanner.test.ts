import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";

import {
  AnchorHistoryRestartRequiredError,
  classifyAnchor,
  scanAllAnchors,
  scanAnchorPage,
  type RawScanPage,
} from "../../src/discovery/index.js";
import {
  classifyAnchor as classifyAnchorFromRoot,
  scanAllAnchors as scanAllAnchorsFromRoot,
  scanAnchorPage as scanAnchorPageFromRoot,
} from "../../src/index.js";
import { priorPaymentDispositionAddress } from "../../src/rails/payAlternative.js";

// A JID-1 canonical ULID (CORE §B.1).
const JOB = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const HASH = "ab".repeat(32);

describe("classifyAnchor (§6.3.4 logical-address kinds)", () => {
  test("classifies exact current-profile logical address structures", () => {
    expect(classifyAnchor("dacs1:0xseller:svc:v1")).toBe("listing");
    expect(classifyAnchor("dacs1-revoked:0xseller:svc:v1")).toBe("listing-revocation");
    expect(classifyAnchor(`dacs2:${JOB}:web2-domain:example.com:v1`)).toBe("verification-result");
    expect(classifyAnchor(`dacs2:composite:${JOB}:did%3Ademos%3Aagent%3Aabc`)).toBe("verification-composite");
    expect(classifyAnchor("dacs2:registry:v0.1")).toBe("verification-registry");
    expect(classifyAnchor(`dacs3:commit:${JOB}`)).toBe("agreement-commitment");
    expect(classifyAnchor("dacs4:registry:v0.1")).toBe("rail-registry");
    expect(classifyAnchor(`dacs4:payment:${JOB}:pay-x402:3`)).toBe("settlement-evidence");
    expect(classifyAnchor(`dacs4:payment:${JOB}:pay-x402:3:resolved`)).toBe("settlement-evidence");
    expect(classifyAnchor(`dacs4:deliverable:${JOB}`)).toBe("deliverable");
    expect(classifyAnchor(`dacs4:entitlement:${JOB}:0`)).toBe("entitlement");
    expect(classifyAnchor(`dacs4:amendment:${JOB}:${"a".repeat(64)}:0`)).toBe("settlement-amendment");
    expect(classifyAnchor(`stor-${"b".repeat(64)}`)).toBe("bundle");
    expect(classifyAnchor(`dacs5:rating:${JOB}:did%3Ademos%3Aagent%3Aabc`)).toBe("rating");
  });

  // Every row of the CF-4 table at the pinned DACS-Standard (CORE.md §B.1).
  test.each([
    ["dacs1:{sellerPrimaryClaim}:{listingId}:v{listingVersion}", "dacs1:cci-xm%3Aevm%3Amainnet%3A0x1234:my-listing:v3", "listing"],
    ["dacs1-revoked:{sellerPrimaryClaim}:{listingId}:v{listingVersion}", "dacs1-revoked:cci-xm%3Aevm%3Amainnet%3A0x1234:my-listing:v3", "listing-revocation"],
    ["dacs4:payment:{jobId}:{railId}:{phaseIndex}", `dacs4:payment:${JOB}:evm-erc20%3A1%3AUSDC:0`, "settlement-evidence"],
    ["dacs4:payment:{jobId}:{railId}:{phaseIndex}:resolved", `dacs4:payment:${JOB}:evm-erc20%3A1%3AUSDC:12:resolved`, "settlement-evidence"],
    ["dacs4:payment-disposition:{priorJobId}:{priorPhaseIndex}:{dispositionId}", `dacs4:payment-disposition:${JOB}:3:${HASH}`, "payment-disposition"],
    ["dacs4:payload-attestation:{jobId}:{verificationMethodHash}:{attempt}", `dacs4:payload-attestation:${JOB}:${HASH}:0`, "payload-attestation"],
    ["dacs2:{jobId}:{scheme}:{identifier}:v{recipeVersion}", `dacs2:${JOB}:cci-xm:evm%3Amainnet%3A0x1234:v1`, "verification-result"],
    ["dacs2:composite:{jobId}:{evaluatedParty}", `dacs2:composite:${JOB}:cci-xm%3Aevm%3Amainnet%3A0x1234`, "verification-composite"],
    ["dacs3:commit:{jobId}", `dacs3:commit:${JOB}`, "agreement-commitment"],
    ["dacs5:rating:{jobId}:{rater}", `dacs5:rating:${JOB}:cci-xm%3Aevm%3Amainnet%3A0x1234`, "rating"],
    ["stor-{sha256(...)}", `stor-${HASH}`, "bundle"],
  ])("CF-4 %s is classified", (_form, address, kind) => {
    expect(classifyAnchor(address)).toBe(kind);
  });

  test("the SDK's own payment-disposition and payload-attestation addresses are classified", () => {
    expect(classifyAnchor(priorPaymentDispositionAddress(JOB, 0, HASH))).toBe("payment-disposition");
    expect(classifyAnchor(`dacs4:payload-attestation:${JOB}:${HASH}:12`)).toBe("payload-attestation");
    // Distinct from settlement evidence, whose signed scope and admission differ.
    expect(classifyAnchor(`dacs4:payment-disposition:${JOB}:3:${HASH}`)).not.toBe("settlement-evidence");
  });

  test.each([
    ["dispositionId not 64 lowercase hex", `dacs4:payment-disposition:${JOB}:3:${HASH.toUpperCase()}`],
    ["non-minimal priorPhaseIndex", `dacs4:payment-disposition:${JOB}:03:${HASH}`],
    ["short verificationMethodHash", `dacs4:payload-attestation:${JOB}:${"a".repeat(63)}:0`],
    ["non-minimal attempt", `dacs4:payload-attestation:${JOB}:${HASH}:01`],
    ["negative attempt", `dacs4:payload-attestation:${JOB}:${HASH}:-1`],
  ])("a DACS-4 address with a %s is unknown", (_name, address) => {
    expect(classifyAnchor(address)).toBe("unknown");
  });

  // CORE JID-1: malformed job IDs are never repaired, so never classified.
  test.each([
    ["not a ULID", "not-a-ulid"],
    ["lowercase", JOB.toLowerCase()],
    ["alias I", `${JOB.slice(0, 25)}I`],
    ["alias L", `${JOB.slice(0, 25)}L`],
    ["alias O", `${JOB.slice(0, 25)}O`],
    ["excluded U", `${JOB.slice(0, 25)}U`],
    ["leading 8", `8${JOB.slice(1)}`],
    ["leading 9", `9${JOB.slice(1)}`],
    ["25 characters", JOB.slice(1)],
    ["27 characters", `${JOB}0`],
    ["percent encoding", `${JOB.slice(0, 23)}%41`],
    ["a trailing newline", `${JOB}\n`],
  ])("a job ID that is %s makes every job-scoped address unknown", (_name, jobId) => {
    for (const address of [
      `dacs2:${jobId}:web2-domain:example.com:v1`,
      `dacs2:composite:${jobId}:did%3Ademos%3Aagent%3Aabc`,
      `dacs3:commit:${jobId}`,
      `dacs4:payment:${jobId}:pay-x402:3`,
      `dacs4:payment-disposition:${jobId}:3:${HASH}`,
      `dacs4:payload-attestation:${jobId}:${HASH}:0`,
      `dacs4:deliverable:${jobId}`,
      `dacs4:entitlement:${jobId}:0`,
      `dacs4:amendment:${jobId}:${HASH}:0`,
      `dacs5:rating:${jobId}:did%3Ademos%3Aagent%3Aabc`,
    ]) {
      expect(classifyAnchor(address), address).toBe("unknown");
    }
  });

  test("revocation is not misread as a listing (prefix order matters)", () => {
    // `dacs1-revoked:` must win over the `dacs1:` check.
    expect(classifyAnchor("dacs1-revoked:x:y:v1")).toBe("listing-revocation");
  });

  test("a non-DACS / unknown address is `unknown`", () => {
    expect(classifyAnchor("stor-abc")).toBe("unknown");
    expect(classifyAnchor("dacs9:whatever")).toBe("unknown");
    expect(classifyAnchor("dacs5:bundle:job-1")).toBe("unknown");
    expect(classifyAnchor("dacs4:deliverable:job-1")).not.toBe("settlement-evidence");
  });

  test("the scanner is reachable from the supported package root", () => {
    expect(classifyAnchorFromRoot).toBe(classifyAnchor);
    expect(scanAnchorPageFromRoot).toBe(scanAnchorPage);
    expect(scanAllAnchorsFromRoot).toBe(scanAllAnchors);
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(packageJson.exports["./discovery"]).toBeDefined();
  });
});

/** A paged fake history from a flat list of pages. */
function pagedFetcher(pages: RawScanPage[]) {
  return async (cursor: string | null): Promise<RawScanPage> => {
    const idx = cursor === null ? 0 : Number(cursor);
    return pages[idx] ?? { entries: [], nextCursor: null };
  };
}

const entry = (n: string, logical?: string, owner = "0xseller") => ({
  nativeAddress: n,
  ...(logical !== undefined ? { logicalAddress: logical } : {}),
  owner,
});

describe("scanAnchorPage (#54 paged discovery)", () => {
  test("classifies a page and drops entries with no logical metadata", async () => {
    const fetch = pagedFetcher([
      {
        entries: [
          entry("stor-1", "dacs1:s:svc:v1"),
          entry("stor-2"), // no logical metadata → not a DACS anchor
          entry("stor-3", `stor-${"3".repeat(64)}`),
        ],
        nextCursor: null,
      },
    ]);
    const res = await scanAnchorPage(fetch, null);
    expect(res.status).toBe("page");
    if (res.status === "page") {
      expect(res.anchors.map((a) => a.nativeAddress)).toEqual(["stor-1", "stor-3"]);
      expect(res.anchors.map((a) => a.kind)).toEqual(["listing", "bundle"]);
    }
  });

  test("DEDUP: the same native address across pages is yielded once", async () => {
    const seen = new Set<string>();
    const fetch = pagedFetcher([
      { entries: [entry("stor-1", "dacs1:s:svc:v1")], nextCursor: "1" },
      { entries: [entry("stor-1", "dacs1:s:svc:v1"), entry("stor-2", `stor-${"2".repeat(64)}`)], nextCursor: null },
    ]);
    const p1 = await scanAnchorPage(fetch, null, { seen });
    const p2 = await scanAnchorPage(fetch, "1", { seen });
    const got = [...(p1.status === "page" ? p1.anchors : []), ...(p2.status === "page" ? p2.anchors : [])];
    expect(got.map((a) => a.nativeAddress)).toEqual(["stor-1", "stor-2"]); // stor-1 only once
  });

  test("the same native address cannot change logical metadata across pages", async () => {
    const seen = new Map<string, string>();
    const fetch = pagedFetcher([
      { entries: [entry("stor-1", "dacs1:s:svc:v1")], nextCursor: "1" },
      { entries: [entry("stor-1", "dacs1:s:other:v1")], nextCursor: null },
    ]);
    expect(await scanAnchorPage(fetch, null, { seen })).toMatchObject({
      status: "page",
    });
    expect(await scanAnchorPage(fetch, "1", { seen })).toMatchObject({
      status: "indeterminate",
      cursor: "1",
      reason: expect.stringContaining("conflicting logical metadata"),
      code: "metadata-conflict",
    });
  });

  test("separate logical metadata still conflicts with existing dedup metadata", async () => {
    const seen = new Map([["stor-a", "dacs1:s:a:v1"]]);
    const logicalMetadata = new Map<string, string>();
    const fetch = pagedFetcher([
      { entries: [entry("stor-a", "dacs1:s:b:v1")], nextCursor: null },
    ]);
    expect(await scanAnchorPage(fetch, null, { seen, logicalMetadata })).toMatchObject({
      status: "indeterminate",
      cursor: null,
      code: "metadata-conflict",
    });
    expect(seen).toEqual(new Map([["stor-a", "dacs1:s:a:v1"]]));
    expect(logicalMetadata.size).toBe(0);
  });

  test.each([
    ["a null-prototype object", () => Object.create(null)],
    ["an Error with a throwing message getter", () =>
      Object.defineProperty(new Error("hidden"), "message", {
        get() { throw new Error("message trap"); },
      })],
    ["a Proxy whose prototype lookup throws", () =>
      new Proxy(new Error("hidden"), {
        getPrototypeOf() { throw new Error("prototype trap"); },
      })],
  ])("a fetch rejecting with %s stays indeterminate at the same cursor", async (_name, make) => {
    await expect(scanAnchorPage(async () => { throw make(); }, "start")).resolves.toEqual({
      status: "indeterminate",
      reason: "page fetch failed: unknown error",
      cursor: "start",
    });
  });

  test("snapshots logicalMetadata once before checking and retaining metadata", async () => {
    const retained = new Map([["stor-a", "dacs1:s:a:v1"]]);
    const empty = new Map<string, string>();
    const seen = new Map<string, string>();
    const metadataGetter = vi.fn(() => metadataGetter.mock.calls.length === 1 ? retained : empty);
    const result = await scanAnchorPage(
      async () => ({ entries: [entry("stor-a", "dacs1:s:b:v1")], nextCursor: null }),
      "start", { seen, get logicalMetadata() { return metadataGetter(); } },
    );
    expect(result).toMatchObject({ status: "indeterminate", code: "metadata-conflict", cursor: "start" });
    expect(metadataGetter).toHaveBeenCalledOnce();
    expect(retained).toEqual(new Map([["stor-a", "dacs1:s:a:v1"]]));
    expect(seen.size).toBe(0);
    expect(empty.size).toBe(0);
  });

  test.each(["dacs1:s:a:v1", "dacs1:s:b:v1"])(
    "a row cannot hide disagreeing dedup and separate metadata (%s)",
    async (logical) => {
      const seen = new Map([["stor-a", "dacs1:s:a:v1"]]);
      const logicalMetadata = new Map([["stor-a", "dacs1:s:b:v1"]]);
      const fetch = pagedFetcher([
        { entries: [entry("stor-a", logical)], nextCursor: null },
      ]);
      expect(await scanAnchorPage(fetch, null, { seen, logicalMetadata })).toMatchObject({
        status: "indeterminate",
        code: "metadata-conflict",
      });
      expect(logicalMetadata.get("stor-a")).toBe("dacs1:s:b:v1");
    },
  );

  test("NO SKIPPED PAGES: a fetch that throws → indeterminate carrying the SAME cursor", async () => {
    const fetch = async (): Promise<RawScanPage> => {
      throw new Error("rpc timeout");
    };
    const res = await scanAnchorPage(fetch, "cursor-7");
    expect(res).toMatchObject({ status: "indeterminate", cursor: "cursor-7" });
  });

  test("malformed pages and non-advancing cursors fail closed at the same cursor", async () => {
    const malformed = await scanAnchorPage(
      // @ts-expect-error — exercise the runtime boundary against an RPC adapter.
      async () => ({ entries: "not-an-array", nextCursor: null }),
      "cursor-2",
    );
    expect(malformed).toMatchObject({
      status: "indeterminate",
      cursor: "cursor-2",
      reason: expect.stringContaining("entries array"),
    });

    const stuck = await scanAnchorPage(
      async () => ({ entries: [], nextCursor: "cursor-2" }),
      "cursor-2",
    );
    expect(stuck).toMatchObject({
      status: "indeterminate",
      code: "cursor-cycle",
      cursor: "cursor-2",
      reason: expect.stringContaining("did not advance"),
    });
  });

  test("codes a page larger than the limit and a fetcher's restart signal", async () => {
    const oversized = await scanAnchorPage(
      async () => ({ entries: [entry("stor-a", "dacs1:s:a:v1"), entry("stor-b", "dacs1:s:b:v1")], nextCursor: null }),
      "cursor-1",
      { limit: 1 },
    );
    expect(oversized).toEqual({
      status: "indeterminate",
      code: "page-limit-exceeded",
      reason: "page fetch failed: history page returned 2 entries for limit 1",
      cursor: "cursor-1",
    });

    const seen = new Map<string, string>();
    const restart = await scanAnchorPage(
      async () => { throw new AnchorHistoryRestartRequiredError("boundary lost; restart from null"); },
      "cursor-1",
      { seen },
    );
    expect(restart).toEqual({
      status: "indeterminate",
      code: "history-restart-required",
      reason: "page fetch failed: boundary lost; restart from null",
      cursor: "cursor-1",
    });
    expect(seen.size).toBe(0);

    const plain = await scanAnchorPage(async () => { throw new Error("rpc 503"); }, "cursor-1");
    expect(plain).toEqual({ status: "indeterminate", reason: "page fetch failed: rpc 503", cursor: "cursor-1" });
  });

  test("invalid page limits are indeterminate and never call the RPC seam", async () => {
    const fetch = vi.fn(async (): Promise<RawScanPage> => ({
      entries: [],
      nextCursor: null,
    }));
    await expect(scanAnchorPage(fetch, null, { limit: 0 })).resolves.toMatchObject({
      status: "indeterminate",
      code: "invalid-limit",
      cursor: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("unknown kinds are dropped by default, kept with includeUnknown", async () => {
    const fetch = pagedFetcher([{ entries: [entry("stor-x", "dacs9:weird")], nextCursor: null }]);
    const dropped = await scanAnchorPage(fetch, null);
    expect(dropped.status === "page" && dropped.anchors).toEqual([]);
    const kept = await scanAnchorPage(fetch, null, { includeUnknown: true });
    expect(kept.status === "page" && kept.anchors[0]?.kind).toBe("unknown");
  });
});

describe("scanAllAnchors (drain the whole history)", () => {
  test("accumulates every page, deduped, until nextCursor is null", async () => {
    const fetch = pagedFetcher([
      { entries: [entry("a", "dacs1:s:svc:v1")], nextCursor: "1" },
      { entries: [entry("b", `dacs3:commit:${JOB}`), entry("a", "dacs1:s:svc:v1")], nextCursor: "2" },
      { entries: [entry("c", `stor-${"c".repeat(64)}`)], nextCursor: null },
    ]);
    const res = await scanAllAnchors(fetch);
    expect(res.status).toBe("complete");
    if (res.status === "complete") {
      expect(res.anchors.map((x) => x.nativeAddress)).toEqual(["a", "b", "c"]); // dedup across pages
      expect(res.anchors.map((x) => x.kind)).toEqual(["listing", "agreement-commitment", "bundle"]);
    }
  });

  test("a mid-scan fetch failure ABORTS with partial results + a resume cursor (nothing dropped)", async () => {
    let calls = 0;
    const fetch = async (cursor: string | null): Promise<RawScanPage> => {
      calls += 1;
      if (calls === 1) return { entries: [entry("a", "dacs1:s:svc:v1")], nextCursor: "1" };
      throw new Error("rpc down on page 2");
    };
    const res = await scanAllAnchors(fetch);
    expect(res.status).toBe("aborted");
    if (res.status === "aborted") {
      expect(res.anchors.map((x) => x.nativeAddress)).toEqual(["a"]); // page 1 kept
      expect(res.resumeCursor).toBe("1"); // resume exactly where it failed
    }
  });

  test("maxPages bounds an adversarial/never-ending history", async () => {
    // Every page points to a fresh next cursor forever.
    const fetch = async (cursor: string | null): Promise<RawScanPage> => ({
      entries: [entry(`n-${cursor}`, "dacs1:s:svc:v1")],
      nextCursor: `${cursor ?? 0}x`,
    });
    const res = await scanAllAnchors(fetch, { maxPages: 3 });
    expect(res.status).toBe("aborted");
    if (res.status === "aborted") expect(res.reason).toMatch(/maxPages/);
  });

  test("maxPages is exact: it fetches that many pages, and a history of that length completes", async () => {
    const endless = vi.fn(async (cursor: string | null): Promise<RawScanPage> => ({
      entries: [], nextCursor: `${cursor ?? 0}x`,
    }));
    expect(await scanAllAnchors(endless, { maxPages: 3 })).toMatchObject({ status: "aborted", resumeCursor: "0xxx" });
    expect(endless).toHaveBeenCalledTimes(3);
    const threePages = pagedFetcher([
      { entries: [], nextCursor: "1" }, { entries: [], nextCursor: "2" }, { entries: [], nextCursor: null },
    ]);
    expect(await scanAllAnchors(threePages, { maxPages: 3 })).toEqual({ status: "complete", anchors: [] });
  });

  test("a reused legacy Set keeps logical metadata, so a later page still conflicts", async () => {
    const seen = new Set<string>();
    const fetch = pagedFetcher([
      { entries: [entry("stor-1", "dacs1:s:svc:v1")], nextCursor: "1" },
      { entries: [entry("stor-1", "dacs1:s:other:v1")], nextCursor: null },
    ]);
    expect(await scanAnchorPage(fetch, null, { seen })).toMatchObject({ status: "page" });
    expect(await scanAnchorPage(fetch, "1", { seen })).toMatchObject({
      status: "indeterminate", code: "metadata-conflict", cursor: "1",
    });
  });

  test("a Map seen with separate logicalMetadata still records yielded rows", async () => {
    const seen = new Map<string, string>();
    const logicalMetadata = new Map<string, string>();
    const fetch = pagedFetcher([
      { entries: [entry("stor-1", "dacs1:s:svc:v1")], nextCursor: "1" },
      { entries: [entry("stor-1", "dacs1:s:svc:v1")], nextCursor: null },
    ]);
    const first = await scanAnchorPage(fetch, null, { seen, logicalMetadata });
    const second = await scanAnchorPage(fetch, "1", { seen, logicalMetadata });
    expect(first).toMatchObject({ status: "page", anchors: [{ nativeAddress: "stor-1" }] });
    expect(second).toMatchObject({ status: "page", anchors: [] });
    expect(seen).toEqual(new Map([["stor-1", "dacs1:s:svc:v1"]]));
  });

  test("aborts a multi-page cursor cycle instead of spinning", async () => {
    const fetch = async (cursor: string | null): Promise<RawScanPage> => ({
      entries: [],
      nextCursor: cursor === null ? "a" : cursor === "a" ? "b" : "a",
    });
    await expect(scanAllAnchors(fetch)).resolves.toMatchObject({
      status: "aborted",
      reason: expect.stringContaining("cursor cycle"),
    });
  });
});
