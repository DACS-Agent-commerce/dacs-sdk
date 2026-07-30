import { describe, expect, test } from "vitest";

import {
  createInMemoryBindingIndex,
  resolveBinding,
  resolveLatestVersion,
  type AnchorBinding,
} from "../../src/discovery/index.js";

const SELLER = "0xseller";
const OTHER = "0xsomeone-else";

const logicalFor = (v: number) => `dacs1:${SELLER}:market-data:v${v}`;

const binding = (over: Partial<AnchorBinding> = {}): AnchorBinding => ({
  logicalAddress: logicalFor(1),
  nativeAddress: "stor-aaa",
  owner: SELLER,
  ...over,
});

describe("resolveBinding (§6.3.4 (c) published logical→native binding)", () => {
  test("present: a live binding owned by the expected writer resolves", () => {
    const r = resolveBinding([binding()], logicalFor(1), SELLER);
    expect(r.status).toBe("present");
    if (r.status === "present") expect(r.binding.nativeAddress).toBe("stor-aaa");
  });

  test("owner match is case/space-insensitive", () => {
    const r = resolveBinding([binding({ owner: "  0XSELLER " })], logicalFor(1), SELLER);
    expect(r.status).toBe("present");
  });

  test("absent: no binding for that logical address", () => {
    expect(resolveBinding([binding()], logicalFor(2), SELLER)).toEqual({ status: "absent" });
  });

  test("owner filter: an entry claiming a DIFFERENT owner does not resolve for this writer", () => {
    // Filters out entries that don't even claim the expected writer.
    const squat = binding({ owner: OTHER, nativeAddress: "stor-evil" });
    expect(resolveBinding([squat], logicalFor(1), SELLER)).toEqual({ status: "absent" });
  });

  test("DISCOVERY-NOT-TRUST: a forged entry copying the real owner DOES resolve — the read must be verified", () => {
    // `owner` is self-asserted; a forger can set it to the real seller. Resolution
    // therefore returns the forged native address — the binding is a pointer, and
    // the security boundary is post-read signature + content-hash verification, NOT
    // this lookup. This test documents the limitation honestly so nobody mistakes
    // owner-binding for a trust check.
    const forged = binding({ owner: SELLER, nativeAddress: "stor-forged" });
    const r = resolveBinding([forged], logicalFor(1), SELLER);
    expect(r.status).toBe("present");
    if (r.status === "present") expect(r.binding.nativeAddress).toBe("stor-forged");
  });

  test("a squatted entry alongside the real one still resolves to the REAL native address", () => {
    const squat = binding({ owner: OTHER, nativeAddress: "stor-evil" });
    const r = resolveBinding([squat, binding()], logicalFor(1), SELLER);
    expect(r.status === "present" && r.binding.nativeAddress).toBe("stor-aaa");
  });

  test("REVOKED bindings never resolve", () => {
    const r = resolveBinding([binding({ revoked: true })], logicalFor(1), SELLER);
    expect(r).toEqual({ status: "absent" });
  });

  test("CONFLICT: two live bindings disagreeing on the native address ⇒ indeterminate, never a guess", () => {
    const a = binding({ nativeAddress: "stor-aaa" });
    const b = binding({ nativeAddress: "stor-bbb" });
    const r = resolveBinding([a, b], logicalFor(1), SELLER);
    expect(r.status).toBe("indeterminate");
  });

  test("duplicate identical bindings are NOT a conflict", () => {
    const r = resolveBinding([binding(), binding()], logicalFor(1), SELLER);
    expect(r.status).toBe("present");
  });
});

describe("resolveLatestVersion (#29/#46 version-aware lookup)", () => {
  const v1 = binding({ logicalAddress: logicalFor(1), nativeAddress: "stor-v1" });
  const v2 = binding({ logicalAddress: logicalFor(2), nativeAddress: "stor-v2" });
  const v3 = binding({ logicalAddress: logicalFor(3), nativeAddress: "stor-v3" });

  test("selects the highest live version", () => {
    const r = resolveLatestVersion([v1, v3, v2], logicalFor, SELLER, [1, 2, 3]);
    expect(r.status === "present" && r.binding.nativeAddress).toBe("stor-v3");
    expect(r.status === "present" && r.binding.version).toBe(3);
  });

  test("PRIOR VERSIONS REMAIN READABLE — latest selection never overwrites them", () => {
    // The whole point of versioned anchors (#29): a historical bundle pinning v1
    // must still resolve after v3 is published.
    const r = resolveBinding([v1, v2, v3], logicalFor(1), SELLER);
    expect(r.status === "present" && r.binding.nativeAddress).toBe("stor-v1");
  });

  test("a revoked latest falls back to the highest live version", () => {
    const r = resolveLatestVersion(
      [v1, v2, binding({ logicalAddress: logicalFor(3), revoked: true })],
      logicalFor,
      SELLER,
      [1, 2, 3],
    );
    expect(r.status === "present" && r.binding.version).toBe(2);
  });

  test("absent when no version resolves for this owner", () => {
    expect(resolveLatestVersion([v1], logicalFor, OTHER, [1, 2, 3])).toEqual({ status: "absent" });
  });

  test("a conflicting version makes 'latest' indeterminate, not a guess", () => {
    const conflict = binding({ logicalAddress: logicalFor(2), nativeAddress: "stor-other" });
    const r = resolveLatestVersion([v1, v2, conflict], logicalFor, SELLER, [1, 2]);
    expect(r.status).toBe("indeterminate");
  });
});

describe("createInMemoryBindingIndex", () => {
  test("resolves through the index surface", async () => {
    const index = createInMemoryBindingIndex([binding()]);
    const r = await index.resolve(logicalFor(1), SELLER);
    expect(r.status === "present" && r.binding.nativeAddress).toBe("stor-aaa");
  });

  test("snapshots its input — later mutation of the caller's array can't change resolution", async () => {
    const live: AnchorBinding[] = [binding()];
    const index = createInMemoryBindingIndex(live);
    live.push(binding({ nativeAddress: "stor-injected" })); // would otherwise conflict
    const r = await index.resolve(logicalFor(1), SELLER);
    expect(r.status).toBe("present");
  });
});
