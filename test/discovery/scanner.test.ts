import { describe, expect, test } from "vitest";

import {
  classifyAnchor,
  scanAllAnchors,
  scanAnchorPage,
  type RawScanPage,
} from "../../src/discovery/index.js";

describe("classifyAnchor (§6.3.4 logical-address kinds)", () => {
  test("classifies each dacsN kind by structural prefix", () => {
    expect(classifyAnchor("dacs1:0xseller:svc:v1")).toBe("listing");
    expect(classifyAnchor("dacs1-revoked:0xseller:svc:v1")).toBe("listing-revocation");
    expect(classifyAnchor("dacs2:verifyrecord:job-1")).toBe("verification");
    expect(classifyAnchor("dacs3:agreement:job-1")).toBe("agreement");
    expect(classifyAnchor("dacs4:evidence:job-1")).toBe("settlement-evidence");
    expect(classifyAnchor("dacs5:bundle:job-1")).toBe("bundle");
  });

  test("revocation is not misread as a listing (prefix order matters)", () => {
    // `dacs1-revoked:` must win over the `dacs1:` check.
    expect(classifyAnchor("dacs1-revoked:x:y:v1")).toBe("listing-revocation");
  });

  test("a non-DACS / unknown address is `unknown`", () => {
    expect(classifyAnchor("stor-abc")).toBe("unknown");
    expect(classifyAnchor("dacs9:whatever")).toBe("unknown");
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
          entry("stor-3", "dacs5:bundle:j1"),
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
      { entries: [entry("stor-1", "dacs1:s:svc:v1"), entry("stor-2", "dacs5:bundle:j1")], nextCursor: null },
    ]);
    const p1 = await scanAnchorPage(fetch, null, { seen });
    const p2 = await scanAnchorPage(fetch, "1", { seen });
    const got = [...(p1.status === "page" ? p1.anchors : []), ...(p2.status === "page" ? p2.anchors : [])];
    expect(got.map((a) => a.nativeAddress)).toEqual(["stor-1", "stor-2"]); // stor-1 only once
  });

  test("NO SKIPPED PAGES: a fetch that throws → indeterminate carrying the SAME cursor", async () => {
    const fetch = async (): Promise<RawScanPage> => {
      throw new Error("rpc timeout");
    };
    const res = await scanAnchorPage(fetch, "cursor-7");
    expect(res).toMatchObject({ status: "indeterminate", cursor: "cursor-7" });
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
      { entries: [entry("b", "dacs3:agreement:j1"), entry("a", "dacs1:s:svc:v1")], nextCursor: "2" },
      { entries: [entry("c", "dacs5:bundle:j1")], nextCursor: null },
    ]);
    const res = await scanAllAnchors(fetch);
    expect(res.status).toBe("complete");
    if (res.status === "complete") {
      expect(res.anchors.map((x) => x.nativeAddress)).toEqual(["a", "b", "c"]); // dedup across pages
      expect(res.anchors.map((x) => x.kind)).toEqual(["listing", "agreement", "bundle"]);
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
});
