import { describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { contentHash } from "../../src/canonical/index.js";
import {
  createBoundArtifactRepository,
  createInMemoryBindingIndex,
  createInMemoryBindingStore,
  createScanningArtifactRepository,
  type AnchorBinding,
  type ArtifactScanState,
  type BoundArtifactAdapter,
  type RawAnchorEntry,
  type RawScanPage,
  type ScanningArtifactRepositoryDeps,
} from "../../src/discovery/index.js";
import { createScanningArtifactRepository as fromRoot } from "../../src/index.js";

const OWNER = "seller";
const logical = (id: string) => `dacs1:${OWNER}:${id}:v1`;
const row = (id: string): RawAnchorEntry => ({
  nativeAddress: `stor-${id}`,
  logicalAddress: logical(id),
  owner: OWNER,
});
// Public synthetic records and injected verifiers exercise composition only;
// they assert no protocol conformance and contain no keys or credentials.
const record = (id: string): Record<string, unknown> => ({
  logicalAddress: logical(id),
  owner: OWNER,
  version: 1,
  signature: { signer: OWNER, value: "public-test-signature" },
});
const binding = (id: string): AnchorBinding => ({
  logicalAddress: logical(id),
  nativeAddress: `stor-${id}`,
  owner: OWNER,
  contentHash: contentHash(record(id)),
  version: 1,
});
const state = (cursor: string | null): ArtifactScanState => ({
  owner: OWNER,
  cursor,
  seen: new Map(),
  metadata: new Map(),
  consumedCursors: new Set(),
  pagesConsumed: 0,
  exhausted: false,
});

function setup(ids: string[], over: Partial<ScanningArtifactRepositoryDeps> = {}) {
  const records = new Map(ids.map((id) => [`stor-${id}`, record(id)]));
  const store = createInMemoryBindingStore(ids.map(binding));
  const readAnchor = vi.fn(async (address: string) => records.get(address) ?? null);
  const publisher = { publish: vi.fn(store.publish) };
  const adapter: BoundArtifactAdapter = {
    getAddress: vi.fn(() => "buyer"),
    anchorWriteOnce: vi.fn(async () => { throw new Error("unexpected write"); }),
    readAnchor,
  };
  const verifyArtifact = vi.fn<ScanningArtifactRepositoryDeps["verifyArtifact"]>(
    (value, resolved, anchor) => {
      const signature = value.signature as { signer: string; value: string };
      return anchor.kind === "listing" && value.owner === OWNER &&
        value.version === resolved.version &&
        value.logicalAddress === resolved.logicalAddress &&
        signature.signer === OWNER && signature.value === "public-test-signature";
    },
  );
  const fetchPage = vi.fn(async (_cursor: string | null, _limit: number): Promise<RawScanPage> => ({
    entries: ids.map(row), nextCursor: null,
  }));
  const deps: ScanningArtifactRepositoryDeps = {
    adapter, index: store, publisher, expectedOwner: OWNER, fetchPage, verifyArtifact, ...over,
  };
  return { repo: createScanningArtifactRepository(deps), deps, records,
    readAnchor, publisher, adapter, fetchPage, verifyArtifact };
}

describe("createScanningArtifactRepository (#54)", () => {
  test.each([undefined, null, 7, {}, ["disagree"]])(
    "malformed index reason (%j) preserves retry state without claiming conflict",
    async (reason) => {
      const fixture = setup(["a"], {
        index: { resolve: async () => ({ status: "indeterminate", reason, code: "binding-conflict" }) as never },
      });
      const input = state("retry");
      const result = await fixture.repo.scanPage(input);
      expect(result).toMatchObject({ status: "indeterminate", state: input });
      expect(result.results.map(({ outcome }) => outcome)).toEqual([{
        status: "indeterminate",
        reason: "binding resolution failed: binding index returned an invalid reason",
      }]);
      expect(fixture.readAnchor).not.toHaveBeenCalled();
      expect(fixture.verifyArtifact).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["a null-prototype object", () => Object.create(null)],
    ["an Error with a throwing message getter", () =>
      Object.defineProperty(new Error("hidden"), "message", {
        get() { throw new Error("message trap"); },
      })],
  ])("hostile thrown value (%s) keeps retry state instead of rejecting", async (_name, make) => {
    const statusTrap = new Proxy({}, {
      get(_target, key) { if (key === "status") throw make(); return undefined; },
    });
    const sources: Partial<ScanningArtifactRepositoryDeps>[] = [
      { index: { resolve: async () => { throw make(); } } },
      { index: { resolve: async () => statusTrap as never } },
      { fetchPage: async () => { throw make(); } },
    ];
    for (const over of sources) {
      const fixture = setup(["a"], over);
      const input = state("retry");
      const result = await fixture.repo.scanPage(input);
      expect(result).toMatchObject({
        status: "indeterminate", reason: expect.stringMatching(/: unknown error$/), state: input,
      });
      expect(result.state.seen.size).toBe(0);
      expect(fixture.readAnchor).not.toHaveBeenCalled();
      expect(fixture.verifyArtifact).not.toHaveBeenCalled();
    }
  });

  test.each(["stor-a", 7, null, ["stor-a"], {}, { nativeAddress: 7 }])(
    "malformed present binding (%j) is retryable, not a handled conflict",
    async (malformed) => {
      const fixture = setup(["a"], {
        index: { resolve: async () => ({ status: "present", binding: malformed }) as never },
      });
      const input = state("retry");
      const result = await fixture.repo.scanPage(input);
      expect(result).toMatchObject({ status: "indeterminate", state: input });
      expect(result.results.map(({ outcome }) => outcome)).toEqual([{
        status: "indeterminate",
        reason: "binding resolution failed: binding index returned a malformed binding",
      }]);
      expect(result.state.seen.size).toBe(0);
      expect(fixture.readAnchor).not.toHaveBeenCalled();
      expect(fixture.verifyArtifact).not.toHaveBeenCalled();
    },
  );

  test.each<[string, Record<string, unknown>]>([
    ["missing owner", { owner: undefined }],
    ["non-string owner", { owner: 7 }],
    ["missing cursor", { cursor: undefined }],
    ["non-string cursor", { cursor: 7 }],
    ["missing pagesConsumed", { pagesConsumed: undefined }],
    ["NaN pagesConsumed", { pagesConsumed: Number.NaN }],
    ["string pagesConsumed", { pagesConsumed: "9999" }],
    ["negative pagesConsumed", { pagesConsumed: -1 }],
    ["fractional pagesConsumed", { pagesConsumed: 1.5 }],
    ["infinite pagesConsumed", { pagesConsumed: Number.POSITIVE_INFINITY }],
    ["missing exhausted", { exhausted: undefined }],
    ["string exhausted", { exhausted: "false" }],
  ])("invalid scalar scan state (%s) is indeterminate without fetching", async (_name, bad) => {
    const fixture = setup(["a"]);
    const input = { ...state("next"), ...bad } as unknown as ArtifactScanState;
    const result = await fixture.repo.scanPage(input);
    expect(result).toMatchObject({
      status: "indeterminate",
      reason: "scan state has an invalid owner, cursor, page count or exhaustion flag",
      results: [],
    });
    expect(fixture.fetchPage).not.toHaveBeenCalled();
    expect(fixture.readAnchor).not.toHaveBeenCalled();
  });

  test("accepts scan state whose scalar fields are inherited getters, reading each once", async () => {
    const reads = { owner: 0, cursor: 0, pagesConsumed: 0, exhausted: 0 };
    class PersistedState {
      seen = new Map<string, string>();
      metadata = new Map<string, string>();
      consumedCursors = new Set<string>(["earlier"]);
      get owner() { reads.owner++; return OWNER; }
      get cursor() { reads.cursor++; return "next"; }
      get pagesConsumed() { reads.pagesConsumed++; return 9_999; }
      get exhausted() { reads.exhausted++; return false; }
    }
    const fixture = setup(["a"]);
    const result = await fixture.repo.scanPage(new PersistedState());
    expect(result).toMatchObject({
      status: "page",
      state: { cursor: null, pagesConsumed: 10_000, exhausted: true },
    });
    expect(result.state.consumedCursors).toEqual(new Set(["earlier", "next"]));
    expect(fixture.fetchPage).toHaveBeenCalledWith("next", expect.any(Number));
    expect(reads).toEqual({ owner: 1, cursor: 1, pagesConsumed: 1, exhausted: 1 });
  });

  test("snapshots input collections once before cloning scan state", async () => {
    for (const enumerable of [true, false]) {
      const fixture = setup(["a"]);
      const retained = {
        seen: new Map([["stor-a", logical("a")]]),
        metadata: new Map([["stor-a", logical("a")]]),
        consumedCursors: new Set(["earlier"]),
      };
      const fieldReads = { seen: 0, metadata: 0, consumedCursors: 0 };
      const input: ArtifactScanState = {
        ...state("next"),
        get seen() { return ++fieldReads.seen === 1 ? retained.seen : new Map(); },
        get metadata() { return ++fieldReads.metadata === 1 ? retained.metadata : new Map(); },
        get consumedCursors() { return ++fieldReads.consumedCursors === 1 ? retained.consumedCursors : new Set<string>(); },
      };
      for (const field of ["seen", "metadata", "consumedCursors"] as const) {
        Object.defineProperty(input, field, { enumerable });
      }
      const result = await fixture.repo.scanPage(input);
      expect(result.results).toEqual([]);
      expect(fieldReads).toEqual({ seen: 1, metadata: 1, consumedCursors: 1 });
      expect(result.state.seen).toEqual(retained.seen);
      expect(result.state.metadata).toEqual(retained.metadata);
      expect(result.state.consumedCursors).toEqual(new Set(["earlier", "next"]));
      expect(result.state.seen).not.toBe(retained.seen);
      expect(retained.consumedCursors).toEqual(new Set(["earlier"]));
      expect(fixture.readAnchor).not.toHaveBeenCalled();
      expect(fixture.verifyArtifact).not.toHaveBeenCalled();
    }
  });

  test("is exported through discovery and the package root", () => {
    expect(fromRoot).toBe(createScanningArtifactRepository);
  });

  test("composes independent publication and verified reads across two pages", async () => {
    const records = new Map<string, Record<string, unknown>>();
    const history: RawAnchorEntry[] = [];
    const store = createInMemoryBindingStore();
    const write = vi.fn(async (_name: string, value: object, options?: Parameters<BoundArtifactAdapter["anchorWriteOnce"]>[2]) => {
      const address = `stor-${history.length}`;
      records.set(address, structuredClone(value) as Record<string, unknown>);
      history.push({ nativeAddress: address, logicalAddress: options?.metadata?.logicalAddress as string, owner: OWNER });
      return { address, txRef: `tx-${history.length}` };
    });
    const writer = createBoundArtifactRepository({
      adapter: { getAddress: () => OWNER, anchorWriteOnce: write, readAnchor: async (address) => records.get(address) ?? null },
      index: store, publisher: store,
    });
    const slots = [logical("v1"), `stor-${"a".repeat(64)}`, "dacs1-revoked:seller:v1:v1", "dacs3:commit:job-1"];
    for (const slot of slots) {
      expect((await writer.write(slot, { logicalAddress: slot, signature: { signer: OWNER } })).status).toBe("published");
    }
    const verify = vi.fn<ScanningArtifactRepositoryDeps["verifyArtifact"]>((value, resolved, anchor) =>
      (value.signature as { signer: string }).signer === OWNER &&
      value.logicalAddress === resolved.logicalAddress && anchor.logicalAddress === resolved.logicalAddress,
    );
    const fetchPage = vi.fn(async (cursor: string | null, limit: number): Promise<RawScanPage> => {
      expect(limit).toBe(2);
      return cursor === null
        ? { entries: history.slice(0, 2), nextCursor: "second" }
        : { entries: history.slice(2), nextCursor: null };
    });
    const buyer = setup([], { index: store, fetchPage, verifyArtifact: verify,
      adapter: { getAddress: () => "buyer", anchorWriteOnce: async () => { throw new Error("unexpected buyer write"); },
        readAnchor: async (address) => records.get(address) ?? null } });
    const first = await buyer.repo.scanPage(undefined, { limit: 2 });
    const second = await buyer.repo.scanPage(first.state, { limit: 2 });
    expect(first.status).toBe("page");
    expect(first.state.cursor).toBe("second");
    expect(first.state.exhausted).toBe(false);
    expect(second.status).toBe("page");
    expect(second.state.exhausted).toBe(true);
    expect([...first.results, ...second.results].map(({ anchor, outcome }) => [anchor.kind, outcome.status])).toEqual([
      ["listing", "verified"], ["bundle", "verified"], ["listing-revocation", "verified"], ["agreement-commitment", "verified"],
    ]);
    expect(second.state.seen.size).toBe(4);
    expect(first.state.seen.size).toBe(2);
    expect(verify).toHaveBeenCalledTimes(4);
    expect(buyer.publisher.publish).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(4);
  });

  test("retries the failed row at the same cursor and skips only the handled prefix", async () => {
    const fixture = setup(["a", "b", "c"]);
    fixture.fetchPage.mockResolvedValue({ entries: [row("a"), row("b"), row("c")], nextCursor: "later" });
    let fail = true;
    fixture.readAnchor.mockImplementation(async (address) => {
      if (address === "stor-b" && fail) { fail = false; throw new Error("read unavailable"); }
      return fixture.records.get(address) ?? null;
    });
    const input = state("retry-page");
    const first = await fixture.repo.scanPage(input);
    expect(first).toMatchObject({ status: "indeterminate", state: { cursor: "retry-page", exhausted: false } });
    expect(first.results.map(({ outcome }) => outcome.status)).toEqual(["verified", "indeterminate"]);
    expect([...first.state.seen.keys()]).toEqual(["stor-a"]);
    expect(input.seen.size).toBe(0);
    expect(fixture.readAnchor.mock.calls.map(([address]) => address)).toEqual(["stor-a", "stor-b"]);
    const retry = await fixture.repo.scanPage(first.state);
    expect(retry.status).toBe("page");
    expect(retry.results.map(({ anchor, outcome }) => [anchor.nativeAddress, outcome.status])).toEqual([
      ["stor-b", "verified"], ["stor-c", "verified"],
    ]);
    expect(retry.state.cursor).toBe("later");
    expect([...retry.state.seen.keys()]).toEqual(["stor-a", "stor-b", "stor-c"]);
    expect(fixture.fetchPage.mock.calls).toEqual([["retry-page", 100], ["retry-page", 100]]);
  });

  test("deduplicates within and across pages, including diagnosed rows", async () => {
    const fixture = setup(["a", "b"]);
    fixture.records.set("stor-a", { ...record("a"), owner: "other" });
    fixture.fetchPage.mockImplementation(async (cursor) => cursor === null
      ? { entries: [row("a"), row("a")], nextCursor: "second" }
      : { entries: [row("a"), row("b")], nextCursor: null });
    const first = await fixture.repo.scanPage();
    const second = await fixture.repo.scanPage(first.state);
    expect(first.results.map(({ outcome }) => outcome.status)).toEqual(["hash-mismatch"]);
    expect(second.results.map(({ anchor }) => anchor.nativeAddress)).toEqual(["stor-b"]);
    expect(fixture.readAnchor).toHaveBeenCalledTimes(2);
  });

  test("rejects a wrong history owner before resolution or read", async () => {
    const resolve = vi.fn(async () => ({ status: "present" as const, binding: binding("a") }));
    const fixture = setup(["a"], { index: { resolve } });
    fixture.fetchPage.mockResolvedValue({ entries: [{ ...row("a"), owner: "other" }], nextCursor: null });
    const result = await fixture.repo.scanPage();
    expect(result.results[0]?.outcome.status).toBe("binding-mismatch");
    expect(resolve).not.toHaveBeenCalled();
    expect(fixture.readAnchor).not.toHaveBeenCalled();
    expect(fixture.verifyArtifact).not.toHaveBeenCalled();
  });

  test("keeps a wrong binding owner distinct from absence", async () => {
    const fixture = setup(["a"], { index: { resolve: async () => ({ status: "present", binding: { ...binding("a"), owner: "other" } }) } });
    expect((await fixture.repo.scanPage()).results[0]?.outcome.status).toBe("binding-mismatch");
    expect(fixture.readAnchor).not.toHaveBeenCalled();
  });

  test("owns the binding before checking the history address across a queued mutation", async () => {
    const shared = binding("history");
    let address = shared.nativeAddress;
    Object.defineProperty(shared, "nativeAddress", {
      enumerable: true,
      get() {
        queueMicrotask(() => { address = "stor-substitute"; });
        return address;
      },
    });
    const fixture = setup(["history"], {
      index: { resolve: async () => ({ status: "present", binding: shared }) },
    });
    fixture.records.set("stor-substitute", record("history"));
    const result = await fixture.repo.scanPage();
    expect(address).toBe("stor-substitute");
    expect(result.results[0]?.outcome).toMatchObject({
      status: "verified", nativeAddress: "stor-history",
    });
    expect(fixture.readAnchor.mock.calls).toEqual([["stor-history"]]);
    expect(fixture.verifyArtifact.mock.calls[0]?.[1].nativeAddress).toBe("stor-history");
  });

  test("an index status getter cannot forge a verified candidate", async () => {
    let statusReads = 0;
    const forged = {
      // The row index and resolveAndRead each check once; the spread reads again.
      get status() { return statusReads++ < 2 ? "indeterminate" : "verified"; },
      reason: "index unavailable",
      nativeAddress: "stor-attacker",
      record: { forged: true },
    };
    const fixture = setup(["a"], { index: { resolve: async () => forged as never } });
    const result = await fixture.repo.scanPage();
    expect(result).toMatchObject({ status: "indeterminate", state: { cursor: null, exhausted: false } });
    expect(result.results.map(({ outcome }) => outcome)).toEqual([
      { status: "indeterminate", reason: "index unavailable" },
    ]);
    expect(result.state.seen.size).toBe(0);
    expect(fixture.readAnchor).not.toHaveBeenCalled();
    expect(fixture.verifyArtifact).not.toHaveBeenCalled();
  });

  test("an index conflict-code getter is read once with status and reason", async () => {
    const fieldReads = { status: 0, reason: 0, code: 0 };
    const resolution = {
      get status() { return fieldReads.status++ === 0 ? "indeterminate" : "verified"; },
      get reason() { return fieldReads.reason++ === 0 ? "disagree" : "attacker-reason"; },
      get code() { return fieldReads.code++ === 0 ? "binding-conflict" : "attacker-value"; },
    };
    const fixture = setup(["a"], { index: { resolve: async () => resolution as never } });
    const result = await fixture.repo.scanPage();
    expect(result).toMatchObject({ status: "page", state: { exhausted: true } });
    expect(result.results.map(({ outcome }) => outcome)).toEqual([
      { status: "conflict", reason: "disagree" },
    ]);
    expect(fieldReads).toEqual({ status: 1, reason: 1, code: 1 });
    expect(result.state.seen.has("stor-a")).toBe(true);
    expect(fixture.readAnchor).not.toHaveBeenCalled();
    expect(fixture.verifyArtifact).not.toHaveBeenCalled();
  });

  test("an index status getter cannot skip the history native-address check", async () => {
    let statusReads = 0;
    const flipping = {
      get status() { return statusReads++ === 0 ? "absent" : "present"; },
      binding: { ...binding("a"), nativeAddress: "stor-other" },
    };
    const fixture = setup(["a"], { index: { resolve: async () => flipping as never } });
    fixture.records.set("stor-other", record("a"));
    const result = await fixture.repo.scanPage();
    expect(result.results.map(({ outcome }) => outcome)).toEqual([{ status: "absent" }]);
    expect(fixture.readAnchor).not.toHaveBeenCalled();
    expect(fixture.verifyArtifact).not.toHaveBeenCalled();
  });

  test("rejects wrong bytes before invoking the artifact verifier", async () => {
    const fixture = setup(["a"]);
    fixture.records.set("stor-a", { ...record("a"), version: 2 });
    expect((await fixture.repo.scanPage()).results[0]?.outcome.status).toBe("hash-mismatch");
    expect(fixture.verifyArtifact).not.toHaveBeenCalled();
  });

  test("rejects a wrong signer even when the binding hash matches", async () => {
    const fixture = setup(["a"]);
    fixture.records.set("stor-a", { ...record("a"), signature: { signer: "other", value: "public-test-signature" } });
    expect(contentHash(fixture.records.get("stor-a")!)).toBe(binding("a").contentHash);
    expect((await fixture.repo.scanPage()).results[0]?.outcome.status).toBe("signature-invalid");
    expect(fixture.verifyArtifact).toHaveBeenCalledOnce();
  });

  test("preserves absent, unreadable, unverifiable and conflict diagnostics", async () => {
    const ids = ["absent", "unreadable", "hashless", "conflict", "different-native", "good"];
    const fixture = setup(ids, { index: createInMemoryBindingIndex([
      binding("unreadable"), { ...binding("hashless"), contentHash: undefined },
      binding("conflict"), { ...binding("conflict"), nativeAddress: "stor-other" },
      { ...binding("different-native"), nativeAddress: "stor-other" }, binding("good"),
    ]) });
    fixture.records.delete("stor-unreadable");
    const result = await fixture.repo.scanPage();
    expect(result.status).toBe("page");
    expect(result.results.map(({ outcome }) => outcome.status)).toEqual([
      "absent", "unreadable", "unverifiable", "conflict", "conflict", "verified",
    ]);
    expect(result.state.seen.size).toBe(ids.length);
    expect(fixture.verifyArtifact).toHaveBeenCalledOnce();
  });

  test.each(["throw", "missing", "truthy"])("fails closed when verifier is %s", async (mode) => {
    const verifyArtifact = mode === "missing" ? undefined
      : mode === "truthy" ? () => ({})
      : () => { throw new Error("verification unavailable"); };
    const fixture = setup(["a"], { verifyArtifact: verifyArtifact as unknown as ScanningArtifactRepositoryDeps["verifyArtifact"] });
    expect((await fixture.repo.scanPage()).results[0]?.outcome.status).toBe(mode === "truthy" ? "signature-invalid" : "unverifiable");
  });

  test("documents thrown unavailable verification separately from completed false results", () => {
    const source = readFileSync(new URL("../../src/discovery/scanningArtifactRepository.ts", import.meta.url), "utf8");
    const tsdoc = source.split("verifyArtifact:")[0]!.replace(/\s*\*\s*/g, " ").replace(/\s+/g, " ");
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8").replace(/\s+/g, " ");
    for (const documentation of [tsdoc, readme]) {
      expect(documentation).toMatch(/Unsupported kinds or unavailable verification must throw\./);
      expect(documentation).toMatch(/false`? only for a completed.*signature-invalid/);
      expect(documentation).toContain("unverifiable");
    }
  });

  test.each([
    { mode: "completed negative", verify: () => false, status: "signature-invalid" },
    { mode: "unsupported", verify: () => { throw new Error("unsupported version"); }, status: "unverifiable" },
    { mode: "unavailable", verify: async () => { throw new Error("verification service unavailable"); }, status: "unverifiable" },
  ])("keeps $mode verification distinct", async ({ verify, status }) => {
    const verifier = vi.fn(verify);
    const fixture = setup(["a"], { verifyArtifact: verifier });
    const result = await fixture.repo.scanPage();
    expect(result.results[0]?.outcome).toMatchObject({ status, nativeAddress: "stor-a" });
    expect(result.status).toBe("page");
    expect(result.state.seen.has("stor-a")).toBe(true);
    expect(verifier).toHaveBeenCalledOnce();
  });

  test("an indeterminate index leaves the row retryable even on the last page", async () => {
    const resolve = vi.fn().mockResolvedValueOnce({ status: "indeterminate", reason: "index unavailable" })
      .mockResolvedValueOnce({ status: "present", binding: binding("a") });
    const fixture = setup(["a"], { index: { resolve } });
    const first = await fixture.repo.scanPage();
    expect(first).toMatchObject({ status: "indeterminate", state: { cursor: null, exhausted: false } });
    expect(first.state.seen.size).toBe(0);
    expect((await fixture.repo.scanPage(first.state)).results[0]?.outcome.status).toBe("verified");
  });

  test("an unavailable page preserves state without reads or publication", async () => {
    const fixture = setup(["a"]);
    fixture.fetchPage.mockRejectedValue(new Error("history unavailable"));
    const input = state("page-2");
    const result = await fixture.repo.scanPage(input);
    expect(result).toMatchObject({ status: "indeterminate", results: [], state: { cursor: "page-2", exhausted: false } });
    expect(result.state.seen).toEqual(input.seen);
    expect(fixture.readAnchor).not.toHaveBeenCalled();
    expect(fixture.publisher.publish).not.toHaveBeenCalled();
    expect(fixture.adapter.anchorWriteOnce).not.toHaveBeenCalled();
  });

  test.each([{ cursors: ["A", "B"] }, { cursors: ["A", "B", "C"] }])(
    "rejects a cursor cycle through $cursors without advancing or reading the cyclic page",
    async ({ cursors }) => {
      const fixture = setup(["a"]);
      fixture.fetchPage.mockImplementation(async (cursor) => {
        const position = cursor === null ? -1 : cursors.indexOf(cursor);
        return {
          entries: position === cursors.length - 1 ? [row("a")] : [],
          nextCursor: cursors[(position + 1) % cursors.length]!,
        };
      });
      let input = state(null);
      for (let i = 0; i < cursors.length; i++) {
        const page = await fixture.repo.scanPage(input);
        expect(page.status).toBe("page");
        input = page.state;
      }
      const before = structuredClone(input);
      const cycle = await fixture.repo.scanPage(input);
      expect(cycle).toMatchObject({ status: "indeterminate", results: [] });
      if (cycle.status === "indeterminate") expect(cycle.reason).toContain("cursor cycle");
      expect(cycle.state).toEqual(before);
      expect(input).toEqual(before);
      expect(fixture.readAnchor).not.toHaveBeenCalled();
    },
  );

  test("rejects a previously consumed current cursor before fetching", async () => {
    const fixture = setup([]);
    const input = { ...state("A"), consumedCursors: new Set(["A"]) };
    const result = await fixture.repo.scanPage(input);
    expect(result).toMatchObject({ status: "indeterminate", results: [], state: input });
    expect(fixture.fetchPage).not.toHaveBeenCalled();
  });

  test("a transient failure does not consume a cursor or count a page on retry", async () => {
    const fixture = setup(["a"]);
    fixture.fetchPage.mockResolvedValueOnce({ entries: [], nextCursor: "A" })
      .mockRejectedValueOnce(new Error("history unavailable"))
      .mockResolvedValueOnce({ entries: [row("a")], nextCursor: "B" });
    fixture.readAnchor.mockRejectedValueOnce(new Error("read unavailable"));
    const first = await fixture.repo.scanPage();
    const fetchFailure = await fixture.repo.scanPage(first.state);
    expect(fetchFailure.status).toBe("indeterminate");
    expect(fetchFailure.state).toEqual(first.state);
    const readFailure = await fixture.repo.scanPage(fetchFailure.state);
    expect(readFailure.status).toBe("indeterminate");
    expect(readFailure.state).toEqual(first.state);
    fixture.fetchPage.mockResolvedValue({ entries: [row("a")], nextCursor: "B" });
    const retry = await fixture.repo.scanPage(readFailure.state);
    expect(retry).toMatchObject({ status: "page", state: { cursor: "B", pagesConsumed: 2 } });
    expect(retry.results[0]?.outcome.status).toBe("verified");
  });

  test("bounds a traversal after 10000 consumed pages before fetching", async () => {
    const fixture = setup([]);
    const input = Object.assign(state("next"), { pagesConsumed: 10_000 });
    const result = await fixture.repo.scanPage(input);
    expect(result).toMatchObject({ status: "indeterminate", results: [], state: input });
    if (result.status === "indeterminate") expect(result.reason).toContain("10000 pages");
    expect(fixture.fetchPage).not.toHaveBeenCalled();
  });

  test("reports conflicting history metadata separately without advancing", async () => {
    const fixture = setup(["a"]);
    const first = await fixture.repo.scanPage();
    fixture.fetchPage.mockResolvedValue({ entries: [{ ...row("a"), logicalAddress: logical("other") }], nextCursor: null });
    const result = await fixture.repo.scanPage({ ...first.state, cursor: "second", exhausted: false });
    expect(result).toMatchObject({ status: "conflict", results: [], state: { cursor: "second", exhausted: false } });
    expect(fixture.readAnchor).toHaveBeenCalledOnce();
  });

  test("unknown candidates remain unverifiable even with an accepting verifier", async () => {
    const fixture = setup(["a"], { index: createInMemoryBindingIndex([{ ...binding("a"), logicalAddress: "dacs9:unknown" }]),
      verifyArtifact: () => true });
    fixture.fetchPage.mockResolvedValue({ entries: [{ ...row("a"), logicalAddress: "dacs9:unknown" }], nextCursor: null });
    expect((await fixture.repo.scanPage(undefined, { includeUnknown: true })).results[0]?.outcome.status).toBe("unverifiable");
  });

  test("reads an overlapping filtered row when includeUnknown is later enabled", async () => {
    const unknown = { ...row("a"), logicalAddress: "dacs9:unknown" };
    const fixture = setup(["a"], {
      index: createInMemoryBindingIndex([{ ...binding("a"), logicalAddress: unknown.logicalAddress }]),
    });
    fixture.fetchPage.mockImplementation(async (cursor) => ({
      entries: [unknown], nextCursor: cursor === null ? "second" : null,
    }));
    const first = await fixture.repo.scanPage();
    expect(first.results).toEqual([]);
    expect(first.state.seen.size).toBe(0);
    const second = await fixture.repo.scanPage(first.state, { includeUnknown: true });
    expect(second.results).toMatchObject([{ anchor: unknown, outcome: { status: "unverifiable" } }]);
    expect(second.state.seen.get("stor-a")).toBe(unknown.logicalAddress);
    expect(first.state.seen.size).toBe(0);
    expect(fixture.readAnchor.mock.calls).toEqual([["stor-a"]]);
    expect(fixture.verifyArtifact).not.toHaveBeenCalled();
  });

  test("retains filtered logical metadata for conflict detection across pages", async () => {
    const fixture = setup(["a"]);
    fixture.fetchPage.mockResolvedValueOnce({
      entries: [{ ...row("a"), logicalAddress: "dacs9:unknown" }], nextCursor: "second",
    }).mockResolvedValueOnce({ entries: [row("a")], nextCursor: null });
    const first = await fixture.repo.scanPage();
    const second = await fixture.repo.scanPage(first.state, { includeUnknown: true });
    expect(second).toMatchObject({ status: "conflict", results: [], state: { cursor: "second" } });
    expect(second.state).toEqual(first.state);
    expect(fixture.readAnchor).not.toHaveBeenCalled();
  });

  test("does not hide disagreeing seen and metadata in resumed state", async () => {
    const fixture = setup(["a"]);
    const input = {
      ...state("second"),
      seen: new Map([["stor-a", logical("a")]]),
      metadata: new Map([["stor-a", logical("other")]]),
    };
    const result = await fixture.repo.scanPage(input);
    expect(result).toMatchObject({ status: "conflict", results: [], state: { cursor: "second" } });
    expect(result.state).toEqual(input);
    expect(fixture.readAnchor).not.toHaveBeenCalled();
  });

  test("an empty page marks only traversal exhaustion and does not restart at null", async () => {
    const fixture = setup([]);
    const first = await fixture.repo.scanPage();
    expect(first).toMatchObject({ status: "page", results: [], state: { cursor: null, exhausted: true } });
    expect(await fixture.repo.scanPage(first.state)).toEqual(first);
    expect(fixture.fetchPage).toHaveBeenCalledOnce();
    expect(fixture.readAnchor).not.toHaveBeenCalled();
    expect(fixture.verifyArtifact).not.toHaveBeenCalled();
  });

  test("rejects reuse of another owner's state before fetching", async () => {
    const fixture = setup([]);
    const result = await fixture.repo.scanPage({ ...state("foreign"), owner: "other" });
    expect(result).toMatchObject({ status: "indeterminate", results: [], state: { cursor: "foreign" } });
    expect(fixture.fetchPage).not.toHaveBeenCalled();
  });

  test("requires a nonempty expected owner", () => {
    const fixture = setup([]);
    expect(() => createScanningArtifactRepository({ ...fixture.deps, expectedOwner: "  " })).toThrow("expectedOwner");
  });
});
