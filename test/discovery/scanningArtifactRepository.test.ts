import { admittedFixture } from "../helpers/admitted.js";
import { describe, expect, test, vi } from "vitest";
import { canonicalize, contentHash, sha256Hex } from "../../src/canonical/index.js";
import {
  createBoundArtifactRepository,
  createInMemoryBindingIndex,
  createInMemoryBindingStore,
  createScanningArtifactRepository,
  UnsupportedArtifactKindError,
  type AnchorBinding,
  type ArtifactScanDeferredRow,
  type ArtifactScanPage,
  type ArtifactScanRestartCode,
  type ArtifactScanState,
  type BoundArtifactAdapter,
  type RawAnchorEntry,
  type RawScanPage,
  type ScanningArtifactRepositoryDeps,
} from "../../src/discovery/index.js";
import {
  AnchorHistoryRestartRequiredError as restartErrorFromRoot,
  createScanningArtifactRepository as fromRoot,
  UnsupportedArtifactKindError as unsupportedErrorFromRoot,
} from "../../src/index.js";
import { AnchorHistoryRestartRequiredError } from "../../src/discovery/index.js";
import { createDemosHistoryPageFetcher } from "../../src/substrate/demosHistory.js";

const OWNER = "seller";
// A JID-1 canonical ULID (CORE §B.1).
const JOB = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
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
// A non-null cursor is the state after the initial null-cursor page.
const state = (cursor: string | null): ArtifactScanState => ({
  owner: OWNER,
  cursor,
  seen: new Map(),
  metadata: new Map(),
  consumedCursors: new Set(),
  pagesConsumed: cursor === null ? 0 : 1,
  exhausted: false,
  pendingRow: null,
  deferred: [],
});
const cursors = (count: number) => new Set(Array.from({ length: count }, (_, i) => `consumed-${i}`));
// A retry state keeps the failing row's logical metadata from the page.
const retrying = (input: ArtifactScanState, id: string, attempts = 1): ArtifactScanState => ({
  ...input,
  metadata: new Map([...input.metadata, [`stor-${id}`, logical(id)]]),
  pendingRow: { nativeAddress: `stor-${id}`, attempts },
});
const deferredRow = (id: string): ArtifactScanDeferredRow => ({
  anchor: { nativeAddress: `stor-${id}`, logicalAddress: logical(id), owner: OWNER, kind: "listing" },
  code: "read-indeterminate", reason: "r", attempts: 5,
});

function setup(ids: string[], over: Partial<ScanningArtifactRepositoryDeps> = {}) {
  const records = new Map(ids.map((id) => [`stor-${id}`, record(id)]));
  const store = createInMemoryBindingStore(ids.map(binding));
  const readAnchor = vi.fn(async (address: string) => admittedFixture(records.get(address) ?? null));
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
  test.each<ArtifactScanDeferredRow["code"]>([
    "index-indeterminate", "binding-not-yet-visible", "read-indeterminate",
    "record-not-yet-visible", "verifier-unavailable",
  ])("resumes persisted deferred code %s without discarding it", async (code) => {
    const fixture = setup(["a"]);
    const deferred = { ...deferredRow("z"), code };
    const input = {
      ...state("next"), metadata: new Map([["stor-z", logical("z")]]), deferred: [deferred],
    };
    const result = await fixture.repo.scanPage(input);
    expect(result.status).toBe("page");
    expect(result.state.exhausted).toBe(true);
    expect(result.state.deferred).toEqual([deferred]);
    expect(fixture.fetchPage).toHaveBeenCalledWith("next", expect.any(Number));
    expect(fixture.readAnchor).toHaveBeenCalledExactlyOnceWith("stor-a");
  });

  test("resumes a persisted deferred row without an owner and adds no owner key", async () => {
    const fixture = setup(["a"]);
    const { owner: _owner, ...ownerless } = deferredRow("z").anchor;
    const input = {
      ...state("next"), metadata: new Map([["stor-z", logical("z")]]),
      deferred: [{ ...deferredRow("z"), anchor: ownerless }],
    };
    const result = await fixture.repo.scanPage(input);
    expect(result.state.deferred).toEqual(input.deferred);
    expect(Object.keys(result.state.deferred[0]!.anchor)).not.toContain("owner");
  });

  test("the unsupported-kind error class carries its name and code", () => {
    const error = new UnsupportedArtifactKindError("v9");
    expect(error).toBeInstanceOf(Error);
    expect({ name: error.name, code: error.code, message: error.message }).toEqual({
      name: "UnsupportedArtifactKindError", code: "unsupported-kind", message: "v9",
    });
  });

  test("an unknown index status cannot admit a valid-looking binding", async () => {
    const fixture = setup(["a"], {
      index: { resolve: async () => ({ status: "unexpected", binding: binding("a") }) as never },
    });
    const result = await fixture.repo.scanPage();
    expect(result).toMatchObject({ status: "indeterminate", code: "index-indeterminate" });
    expect(result.results.map(({ outcome }) => outcome)).toEqual([{
      status: "indeterminate",
      code: "index-indeterminate",
      reason: "binding resolution failed: binding index returned an unknown status",
    }]);
    expect(result.state.seen.size).toBe(0);
    expect(fixture.readAnchor).not.toHaveBeenCalled();
    expect(fixture.verifyArtifact).not.toHaveBeenCalled();
  });

  test("resumes handled rows without redundant metadata and avoids duplicate reads", async () => {
    const fixture = setup(["a"]);
    const input = { ...state("next"), seen: new Map([["stor-a", logical("a")]]) };
    const result = await fixture.repo.scanPage(input);
    expect(result).toMatchObject({ status: "page", results: [], state: { exhausted: true, pagesConsumed: 2 } });
    expect(result.state.seen).toEqual(input.seen);
    expect(fixture.fetchPage).toHaveBeenCalledExactlyOnceWith("next", expect.any(Number));
    expect(fixture.readAnchor).not.toHaveBeenCalled();
    expect(fixture.verifyArtifact).not.toHaveBeenCalled();
  });

  test.each([undefined, null, 7, {}, ["disagree"]])(
    "malformed index reason (%j) preserves retry state without claiming conflict",
    async (reason) => {
      const fixture = setup(["a"], {
        index: { resolve: async () => ({ status: "indeterminate", reason, code: "binding-conflict" }) as never },
      });
      const input = state("retry");
      const result = await fixture.repo.scanPage(input);
      expect(result).toMatchObject({ status: "indeterminate", code: "index-indeterminate", state: retrying(input, "a") });
      expect(result.results.map(({ outcome }) => outcome)).toEqual([{
        status: "indeterminate",
        code: "index-indeterminate",
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
    const sources: [Partial<ScanningArtifactRepositoryDeps>, string, boolean][] = [
      [{ index: { resolve: async () => { throw make(); } } }, "index-indeterminate", true],
      [{ index: { resolve: async () => statusTrap as never } }, "index-indeterminate", true],
      [{ fetchPage: async () => { throw make(); } }, "history-unavailable", false],
    ];
    for (const [over, code, rowFailed] of sources) {
      const fixture = setup(["a"], over);
      const input = state("retry");
      const result = await fixture.repo.scanPage(input);
      expect(result).toMatchObject({
        status: "indeterminate", code, reason: expect.stringMatching(/: unknown error$/),
        state: rowFailed ? retrying(input, "a") : input,
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
      expect(result).toMatchObject({ status: "indeterminate", state: retrying(input, "a") });
      expect(result.results.map(({ outcome }) => outcome)).toEqual([{
        status: "indeterminate",
        code: "index-indeterminate",
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
  ])("invalid scalar scan state (%s) requires a restart without fetching", async (_name, bad) => {
    const fixture = setup(["a"]);
    const input = { ...state("next"), ...bad } as unknown as ArtifactScanState;
    const result = await fixture.repo.scanPage(input);
    expect(result).toEqual({
      status: "restart-required",
      code: "invalid-state",
      reason: "scan state has an invalid owner, cursor, collection, page count, row or exhaustion flag",
      results: [],
      deferred: [],
      state: state(null),
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
      pendingRow = null;
      deferred = [];
      get owner() { reads.owner++; return OWNER; }
      get cursor() { reads.cursor++; return "next"; }
      get pagesConsumed() { reads.pagesConsumed++; return 2; }
      get exhausted() { reads.exhausted++; return false; }
    }
    const fixture = setup(["a"]);
    const result = await fixture.repo.scanPage(new PersistedState());
    expect(result).toMatchObject({
      status: "page",
      state: { cursor: null, pagesConsumed: 3, exhausted: true },
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
        pagesConsumed: 2,
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
    expect(unsupportedErrorFromRoot).toBe(UnsupportedArtifactKindError);
    expect(restartErrorFromRoot).toBe(AnchorHistoryRestartRequiredError);
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
      adapter: { getAddress: () => OWNER, anchorWriteOnce: write, readAnchor: async (address) => admittedFixture(records.get(address) ?? null) },
      index: store, publisher: store,
    });
    const slots = [logical("v1"), `stor-${"a".repeat(64)}`, "dacs1-revoked:seller:v1:v1", `dacs3:commit:${JOB}`];
    for (const slot of slots) {
      expect((await writer.write(slot, { logicalAddress: slot, signatures: [{ signer: OWNER }] })).status).toBe("published");
    }
    const verify = vi.fn<ScanningArtifactRepositoryDeps["verifyArtifact"]>((value, resolved, anchor) =>
      (value.signatures as { signer: string }[])[0]?.signer === OWNER &&
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
        readAnchor: async (address) => admittedFixture(records.get(address) ?? null) } });
    const first = await buyer.repo.scanPage(undefined, { limit: 2 });
    const second = await buyer.repo.scanPage(first.state, { limit: 2 });
    expect(first.status).toBe("page");
    expect(first.state.cursor).toBe("second");
    expect(first.state.exhausted).toBe(false);
    expect(second.status).toBe("page");
    expect(second.state.exhausted).toBe(true);
    // A bundle needs DACS-5 BundleBinding verification, which a generic binding cannot give.
    expect([...first.results, ...second.results].map(({ anchor, outcome }) => [anchor.kind, outcome.status])).toEqual([
      ["listing", "verified"], ["bundle", "unverifiable"], ["listing-revocation", "verified"], ["agreement-commitment", "verified"],
    ]);
    expect(first.results[1]?.outcome).toMatchObject({
      code: "unsupported-kind",
      reason: "signature verification threw: bundle rows need DACS-5 BundleBinding verification",
    });
    expect(second.state.seen.size).toBe(4);
    expect(first.state.seen.size).toBe(2);
    expect(verify).toHaveBeenCalledTimes(3);
    expect(buyer.publisher.publish).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(4);
  });

  test("retries the failed row at the same cursor and skips only the handled prefix", async () => {
    const fixture = setup(["a", "b", "c"]);
    fixture.fetchPage.mockResolvedValue({ entries: [row("a"), row("b"), row("c")], nextCursor: "later" });
    let fail = true;
    fixture.readAnchor.mockImplementation(async (address) => {
      if (address === "stor-b" && fail) { fail = false; throw new Error("read unavailable"); }
      return admittedFixture(fixture.records.get(address) ?? null);
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
    expect(result.results[0]?.outcome).toEqual({
      status: "binding-mismatch", reason: "history row owner does not match expectedOwner",
    });
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
      { status: "indeterminate", code: "index-indeterminate", reason: "index unavailable" },
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
    expect(result.results.map(({ outcome }) => outcome)).toEqual([{
      status: "indeterminate",
      code: "binding-not-yet-visible",
      reason: "history row has no binding visible in the configured index yet",
    }]);
    expect(result.state.seen.size).toBe(0);
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

  test("preserves unverifiable and conflict diagnostics", async () => {
    const ids = ["hashless", "conflict", "different-native", "good"];
    const fixture = setup(ids, { index: createInMemoryBindingIndex([
      { ...binding("hashless"), contentHash: undefined },
      binding("conflict"), { ...binding("conflict"), nativeAddress: "stor-other" },
      { ...binding("different-native"), nativeAddress: "stor-other" }, binding("good"),
    ]) });
    const result = await fixture.repo.scanPage();
    expect(result.status).toBe("page");
    expect(result.results.map(({ outcome }) => outcome.status)).toEqual([
      "unverifiable", "conflict", "conflict", "verified",
    ]);
    expect(result.results[2]?.outcome).toMatchObject({
      reason: expect.stringContaining("published binding points at a different native address than the history row"),
    });
    expect(result.state.seen.size).toBe(ids.length);
    expect(fixture.verifyArtifact).toHaveBeenCalledOnce();
  });

  // CORE SR-2: an ordinary not-found is indeterminate, never authoritative absence.
  test("a history row whose record is not found yet is retried, then verified once visible", async () => {
    const fixture = setup(["a", "b"]);
    fixture.fetchPage.mockResolvedValue({ entries: [row("a"), row("b")], nextCursor: "later" });
    const lagging = fixture.records.get("stor-a")!;
    fixture.records.delete("stor-a");
    const first = await fixture.repo.scanPage();
    expect(first).toMatchObject({
      status: "indeterminate", code: "record-not-yet-visible",
      state: { cursor: null, pendingRow: { nativeAddress: "stor-a", attempts: 1 } },
    });
    expect(first.results.map(({ outcome }) => outcome)).toEqual([{
      status: "indeterminate", code: "record-not-yet-visible", reason: "no record is visible at stor-a yet",
    }]);
    expect(first.state.seen.size).toBe(0);
    fixture.records.set("stor-a", lagging); // The node catches up.
    const second = await fixture.repo.scanPage(first.state);
    expect(second.status).toBe("page");
    expect(second.results.map(({ outcome }) => outcome.status)).toEqual(["verified", "verified"]);
    expect([...second.state.seen.keys()]).toEqual(["stor-a", "stor-b"]);
  });

  test("a record that stays not found is deferred with its code, never handled", async () => {
    const fixture = setup(["a", "b"], { maxRowAttempts: 2 });
    fixture.records.delete("stor-a");
    const first = await fixture.repo.scanPage();
    const second = await fixture.repo.scanPage(first.state);
    expect(second.status).toBe("page");
    expect(second.deferred).toMatchObject([{ anchor: { nativeAddress: "stor-a" }, code: "record-not-yet-visible", attempts: 2 }]);
    expect(second.results.map(({ outcome }) => outcome.status)).toEqual(["indeterminate", "verified"]);
    expect(second.state.seen.has("stor-a")).toBe(false);
    // A persisted deferred row with this code is a valid state.
    const persisted: ArtifactScanState = {
      ...second.state, seen: new Map(second.state.seen), metadata: new Map(second.state.metadata),
      consumedCursors: new Set(second.state.consumedCursors),
      deferred: JSON.parse(JSON.stringify(second.state.deferred)) as ArtifactScanDeferredRow[],
    };
    expect(await fixture.repo.scanPage(persisted)).toMatchObject({ status: "page", results: [] });
  });

  // DACS-5 §10.4.1 omits `signatures` and `anchoredByRole`; BB-4 needs a BundleBinding.
  test("bundle role copies are bound by the §10.4.1 hash and are final unsupported-kind", async () => {
    const copy = (anchoredByRole: string) => ({
      bundleVersion: "1", jobId: JOB, outcome: "completed", anchoredByRole,
      signatures: [{ signer: OWNER, value: "public-test-signature" }],
    });
    const bundleHash = sha256Hex(canonicalize({ bundleVersion: "1", jobId: JOB, outcome: "completed" }));
    const buyer = { nativeAddress: "stor-buyer", logicalAddress: `stor-${"b".repeat(64)}`, owner: OWNER };
    const seller = { nativeAddress: "stor-seller", logicalAddress: `stor-${"c".repeat(64)}`, owner: OWNER };
    const wrong = { nativeAddress: "stor-wrong", logicalAddress: `stor-${"d".repeat(64)}`, owner: OWNER };
    const records = new Map<string, Record<string, unknown>>([
      ["stor-buyer", copy("buyer")], ["stor-seller", copy("seller")],
      ["stor-wrong", { ...copy("buyer"), outcome: "faulted" }],
    ]);
    const fixture = setup([], {
      index: createInMemoryBindingIndex([buyer, seller, wrong].map((entry) => ({ ...entry, contentHash: bundleHash }))),
      adapter: { getAddress: () => "buyer", anchorWriteOnce: async () => { throw new Error("unexpected write"); },
        readAnchor: async (address) => admittedFixture(records.get(address) ?? null) },
    });
    fixture.fetchPage.mockResolvedValue({ entries: [buyer, seller, wrong], nextCursor: null });
    const result = await fixture.repo.scanPage();
    expect(result.results.map(({ anchor, outcome }) => [anchor.kind, outcome.status, "code" in outcome ? outcome.code : undefined])).toEqual([
      ["bundle", "unverifiable", "unsupported-kind"],
      ["bundle", "unverifiable", "unsupported-kind"],
      ["bundle", "hash-mismatch", undefined],
    ]);
    expect(result.state.seen.size).toBe(3);
    expect(fixture.verifyArtifact).not.toHaveBeenCalled();
  });

  test.each([
    ["payment-disposition", `dacs4:payment-disposition:${JOB}:3:${"ab".repeat(32)}`],
    ["payload-attestation", `dacs4:payload-attestation:${JOB}:${"ab".repeat(32)}:0`],
  ])("a %s row reaches the artifact verifier and can verify", async (kind, logicalAddress) => {
    const value = { logicalAddress, signature: { signer: OWNER, value: "public-test-signature" } };
    const entry = { nativeAddress: "stor-dacs4", logicalAddress, owner: OWNER };
    const verifyArtifact = vi.fn<ScanningArtifactRepositoryDeps["verifyArtifact"]>((_value, _binding, anchor) => anchor.kind === kind);
    const fixture = setup([], {
      verifyArtifact,
      index: createInMemoryBindingIndex([{ ...entry, contentHash: contentHash(value) }]),
      adapter: { getAddress: () => "buyer", anchorWriteOnce: async () => { throw new Error("unexpected write"); },
        readAnchor: async () => admittedFixture(value) },
    });
    fixture.fetchPage.mockResolvedValue({ entries: [entry], nextCursor: null });
    const result = await fixture.repo.scanPage();
    expect(result.results).toMatchObject([{ anchor: { kind }, outcome: { status: "verified" } }]);
    expect(verifyArtifact).toHaveBeenCalledOnce();
  });

  // DACS-4 §9.6.1 DV-1: a deliverable is an unsigned payload hashed whole, so a
  // top-level `signature` member is data the binding commits to.
  test("a deliverable row binds its complete payload, including a signature member", async () => {
    const logicalAddress = `dacs4:deliverable:${JOB}`;
    const published = { report: "ok", signature: "A" };
    const entry = { nativeAddress: "stor-deliverable", logicalAddress, owner: OWNER };
    const scan = async (bound: string, stored: Record<string, unknown>) => {
      const verifyArtifact = vi.fn<ScanningArtifactRepositoryDeps["verifyArtifact"]>(() => true);
      const fixture = setup([], {
        verifyArtifact,
        index: createInMemoryBindingIndex([{ ...entry, contentHash: bound }]),
        adapter: { getAddress: () => "buyer", anchorWriteOnce: async () => { throw new Error("unexpected write"); },
          readAnchor: async () => admittedFixture(structuredClone(stored)) },
      });
      fixture.fetchPage.mockResolvedValue({ entries: [entry], nextCursor: null });
      const [result] = (await fixture.repo.scanPage()).results;
      expect(result?.anchor.kind).toBe("deliverable");
      return { status: result?.outcome.status, verifierCalls: verifyArtifact.mock.calls.length };
    };
    const payloadHash = sha256Hex(canonicalize(published));
    expect(payloadHash).not.toBe(contentHash(published));
    expect(await scan(payloadHash, published)).toEqual({ status: "verified", verifierCalls: 1 });
    // The same binding with a changed signature member never reaches the verifier.
    expect(await scan(payloadHash, { ...published, signature: "B" }))
      .toEqual({ status: "hash-mismatch", verifierCalls: 0 });
    // A signature-omitting hash does not bind a deliverable's payload.
    expect(await scan(contentHash(published), { ...published, signature: "B" }))
      .toEqual({ status: "hash-mismatch", verifierCalls: 0 });
  });

  // DACS-4 SB-1 / DPA-2: the repository adds no payment or delivery semantics.
  // A binding an attacker publishes for its own bytes always matches, so these
  // vectors pin that a strict verifier gets the exact record, binding and slot,
  // and that each of its refusals is final and never `verified`.
  describe("payment and delivery rows through a strict verifier", () => {
    const DIGEST = "ab".repeat(32);
    const kinds = [
      ["payment-disposition", `dacs4:payment-disposition:${JOB}:3:${DIGEST}`, "dacs-payment-disposition:v1"],
      ["payload-attestation", `dacs4:payload-attestation:${JOB}:${DIGEST}:0`, "dacs-payload-attestation:v1"],
    ] as const;
    const strict = (domain: string): ScanningArtifactRepositoryDeps["verifyArtifact"] =>
      (value, bound, anchor) => {
        if (value.version !== "1") throw new UnsupportedArtifactKindError("unsupported version");
        const signature = value.signature as { signer?: unknown; value?: unknown };
        return value.domain === domain && value.digest === DIGEST &&
          value.logicalAddress === anchor.logicalAddress && bound.logicalAddress === anchor.logicalAddress &&
          signature.signer === bound.owner && signature.value === "public-test-signature";
      };
    const valid = (logicalAddress: string, domain: string): Record<string, unknown> => ({
      version: "1", domain, logicalAddress, digest: DIGEST,
      signature: { signer: OWNER, value: "public-test-signature" },
    });
    async function scanOne(logicalAddress: string, domain: string, value: Record<string, unknown>) {
      const entry = { nativeAddress: "stor-dacs4", logicalAddress, owner: OWNER };
      const verifyArtifact = vi.fn(strict(domain));
      const fixture = setup([], {
        verifyArtifact,
        index: createInMemoryBindingIndex([{ ...entry, contentHash: contentHash(value) }]),
        adapter: { getAddress: () => "buyer", anchorWriteOnce: async () => { throw new Error("unexpected write"); },
          readAnchor: async () => admittedFixture(structuredClone(value)) },
      });
      fixture.fetchPage.mockResolvedValue({ entries: [entry], nextCursor: null });
      const { results } = await fixture.repo.scanPage();
      expect(results).toHaveLength(1);
      return { result: results[0]!, verifyArtifact, entry };
    }

    test.each(kinds)("%s: a valid record verifies with the exact record, binding and slot", async (kind, address, domain) => {
      const value = valid(address, domain);
      const { result, verifyArtifact, entry } = await scanOne(address, domain, value);
      expect(result).toMatchObject({ anchor: { kind }, outcome: { status: "verified", record: value } });
      expect(verifyArtifact).toHaveBeenCalledExactlyOnceWith(
        value,
        { ...entry, contentHash: contentHash(value) },
        { ...entry, kind },
      );
    });

    test.each(kinds)("%s: every malformed vector is signature-invalid, never verified", async (kind, address, domain) => {
      const base = valid(address, domain);
      const vectors: Array<[string, Record<string, unknown>]> = [
        ["signature", { ...base, signature: { signer: OWNER, value: "forged" } }],
        ["signer", { ...base, signature: { signer: "mallory", value: "public-test-signature" } }],
        ["domain", { ...base, domain: "dacs-other:v1" }],
        ["slot", { ...base, logicalAddress: address.replace(JOB, "01J8ME0SXKQ4T9V2RC5HJ6WX7E") }],
        ["digest", { ...base, digest: "cd".repeat(32) }],
      ];
      for (const [name, value] of vectors) {
        const { result, verifyArtifact } = await scanOne(address, domain, value);
        expect([name, result.anchor.kind, result.outcome.status]).toEqual([name, kind, "signature-invalid"]);
        expect(verifyArtifact).toHaveBeenCalledOnce();
      }
    });

    test.each(kinds)("%s: an unsupported version is a final unsupported-kind", async (kind, address, domain) => {
      const { result } = await scanOne(address, domain, { ...valid(address, domain), version: "2" });
      expect(result).toMatchObject({ anchor: { kind }, outcome: { status: "unverifiable", code: "unsupported-kind" } });
    });
  });

  // CORE JID-3: malformed job IDs reach no resolver or discovery surface.
  test("rows with malformed job IDs are never resolved or read", async () => {
    const malformed = ["dacs3:commit:not-a-ulid", `dacs3:commit:${JOB.toLowerCase()}`, "dacs4:deliverable:x"];
    const resolve = vi.fn(async () => ({ status: "absent" as const }));
    const fixture = setup([], { index: { resolve }, maxRowAttempts: 1 });
    const entries = malformed.map((logicalAddress, i) => ({ nativeAddress: `stor-${i}`, logicalAddress, owner: OWNER }));
    fixture.fetchPage.mockResolvedValue({ entries, nextCursor: null });
    const dropped = await fixture.repo.scanPage();
    expect(dropped).toMatchObject({ status: "page", results: [], state: { exhausted: true } });
    const included = await fixture.repo.scanPage(undefined, { includeUnknown: true });
    expect(included.results.map(({ anchor, outcome }) => [anchor.kind, outcome])).toEqual(malformed.map(() => [
      "unknown",
      { status: "unclassified", reason: "history row logical address is not an exact current-profile DACS address" },
    ]));
    expect(included.state.seen.size).toBe(3);
    expect(resolve).not.toHaveBeenCalled();
    expect(fixture.readAnchor).not.toHaveBeenCalled();
    expect(fixture.verifyArtifact).not.toHaveBeenCalled();
  });

  // DACS-4 SB-1: a non-CF-4 payment address is an error before any projection,
  // so a permissive payment verifier never sees it.
  test("non-canonical CF-4 rows are unclassified and never resolved, read or verified", async () => {
    const malformed = [
      `dacs4:payment:${JOB}:evm-erc20%3a1%3aUSDC:0`,
      `dacs4:payment:${JOB}:evm-erc20?asset=USDC:0`,
      `dacs1:${OWNER}:bad listing:v1`,
      `xdacs4:payment:${JOB}:evm-erc20%3A1%3AUSDC:0`,
    ];
    const resolve = vi.fn(async () => ({ status: "absent" as const }));
    const verifyArtifact = vi.fn(() => true);
    const fixture = setup([], { index: { resolve }, verifyArtifact });
    const entries = malformed.map((logicalAddress, i) => ({ nativeAddress: `stor-cf4-${i}`, logicalAddress, owner: OWNER }));
    fixture.fetchPage.mockResolvedValue({ entries, nextCursor: null });
    const included = await fixture.repo.scanPage(undefined, { includeUnknown: true });
    expect(included.results.map(({ anchor, outcome }) => [anchor.kind, outcome.status]))
      .toEqual(malformed.map(() => ["unknown", "unclassified"]));
    expect(resolve).not.toHaveBeenCalled();
    expect(fixture.readAnchor).not.toHaveBeenCalled();
    expect(verifyArtifact).not.toHaveBeenCalled();
  });

  test("a history row without an owner is still resolved against expectedOwner and verified", async () => {
    const fixture = setup(["a"]);
    fixture.fetchPage.mockResolvedValue({
      entries: [{ nativeAddress: "stor-a", logicalAddress: logical("a") }], nextCursor: null,
    });
    const result = await fixture.repo.scanPage();
    expect(result.results).toMatchObject([{
      anchor: { nativeAddress: "stor-a", logicalAddress: logical("a"), kind: "listing" },
      outcome: { status: "verified" },
    }]);
    expect("owner" in result.results[0]!.anchor).toBe(false);
  });

  test("a verifier that rewrites the anchor it receives cannot change the reported row", async () => {
    const fixture = setup(["a"], {
      verifyArtifact: (_value, _binding, anchor) => {
        Object.assign(anchor, { kind: "rating", logicalAddress: logical("forged") });
        return true;
      },
    });
    const result = await fixture.repo.scanPage();
    expect(result.results).toMatchObject([{ anchor: { ...row("a"), kind: "listing" }, outcome: { status: "verified" } }]);
    expect(result.state.seen).toEqual(new Map([["stor-a", logical("a")]]));
  });

  test.each([
    ["throw", "indeterminate"], ["truthy", "signature-invalid"],
  ])("fails closed when verifier is %s", async (mode, status) => {
    const verifyArtifact = mode === "truthy" ? () => ({})
      : () => { throw new Error("verification unavailable"); };
    const fixture = setup(["a"], { verifyArtifact: verifyArtifact as unknown as ScanningArtifactRepositoryDeps["verifyArtifact"] });
    const result = await fixture.repo.scanPage();
    expect(result.results[0]?.outcome.status).toBe(status);
    expect(result.state.seen.has("stor-a")).toBe(status !== "indeterminate");
  });

  // A configuration fault must not become a final unsupported-kind for every row.
  test.each([undefined, null, true, "verify", {}])(
    "refuses a non-function verifier (%j) at construction, before any fetch",
    (verifyArtifact) => {
      const fetchPage = vi.fn(async () => ({ entries: [row("a")], nextCursor: null }));
      expect(() => setup(["a"], {
        fetchPage, verifyArtifact: verifyArtifact as unknown as ScanningArtifactRepositoryDeps["verifyArtifact"],
      })).toThrow("verifyArtifact must be a function");
      expect(fetchPage).not.toHaveBeenCalled();
    },
  );

  test.each([
    { mode: "completed negative", verify: () => false, outcome: { status: "signature-invalid", nativeAddress: "stor-a" } },
    { mode: "unsupported", verify: () => { throw new UnsupportedArtifactKindError("unsupported version"); },
      outcome: { status: "unverifiable", code: "unsupported-kind", nativeAddress: "stor-a" } },
    { mode: "subclassed unsupported", verify: () => { throw new (class extends UnsupportedArtifactKindError {})("v9"); },
      outcome: { status: "unverifiable", code: "unsupported-kind", nativeAddress: "stor-a" } },
  ])("keeps $mode verification distinct and handled", async ({ verify, outcome }) => {
    const verifier = vi.fn(verify);
    const fixture = setup(["a"], { verifyArtifact: verifier });
    const result = await fixture.repo.scanPage();
    expect(result.results[0]?.outcome).toMatchObject(outcome);
    expect(result.status).toBe("page");
    expect(result.state.seen.has("stor-a")).toBe(true);
    expect(verifier).toHaveBeenCalledOnce();
  });

  test.each([
    ["an async throw", async () => { throw new Error("verification service unavailable"); }],
    ["a sync throw", () => { throw new Error("registry 503"); }],
    ["a hostile code getter", () => {
      throw Object.defineProperty(new Error("registry 503"), "code", { get() { throw new Error("trap"); } });
    }],
    // Only the class is final: a forwarded error body can carry the code.
    ["an error carrying the unsupported-kind code", () => {
      throw Object.assign(new Error("503"), { code: "unsupported-kind" });
    }],
    ["a plain object carrying the unsupported-kind code", () => { throw { code: "unsupported-kind" }; }],
    // Nor is the class name: only an instance from this package copy is final.
    ["an error merely named UnsupportedArtifactKindError", () => {
      throw Object.assign(new Error("v9"), { name: "UnsupportedArtifactKindError", code: "unsupported-kind" });
    }],
  ])("unavailable verification (%s) stays retryable at the same row", async (_name, verify) => {
    const verifier = vi.fn(verify);
    const fixture = setup(["a", "b"], { verifyArtifact: verifier });
    fixture.fetchPage.mockResolvedValue({ entries: [row("a"), row("b")], nextCursor: "later" });
    const result = await fixture.repo.scanPage(state("page"));
    expect(result).toMatchObject({
      status: "indeterminate", code: "verifier-unavailable",
      reason: expect.stringContaining("signature verification threw"),
      state: { cursor: "page", pendingRow: { nativeAddress: "stor-a", attempts: 1 } },
    });
    expect(result.results.map(({ outcome }) => outcome)).toEqual([{
      status: "indeterminate", code: "verifier-unavailable", reason: expect.any(String),
    }]);
    expect(result.state.seen.size).toBe(0);
    expect(verifier).toHaveBeenCalledOnce();
    expect(fixture.readAnchor.mock.calls).toEqual([["stor-a"]]);
  });

  test("a thrown value whose prototype trap throws stays retryable instead of final", async () => {
    // A plain function: vi.fn itself trips the trap and rethrows a plain Error.
    let calls = 0;
    const verifyArtifact = () => {
      calls++;
      throw new Proxy(new UnsupportedArtifactKindError("v9"), { getPrototypeOf() { throw new Error("trap"); } });
    };
    const fixture = setup(["a"], { verifyArtifact });
    const result = await fixture.repo.scanPage();
    expect(result).toMatchObject({
      status: "indeterminate", code: "verifier-unavailable", state: { pendingRow: { nativeAddress: "stor-a", attempts: 1 } },
    });
    expect(result.results.map(({ outcome }) => outcome)).toEqual([{
      status: "indeterminate", code: "verifier-unavailable", reason: "signature verification threw: unknown error",
    }]);
    expect(result.state.seen.size).toBe(0);
    expect(calls).toBe(1);
  });

  test("a forwarded error carrying code unsupported-kind is retried, then deferred, never final", async () => {
    const forwarded = vi.fn(() => { throw Object.assign(new Error("503 from verifier"), { code: "unsupported-kind" }); });
    const fixture = setup(["a", "b"], { verifyArtifact: forwarded, maxRowAttempts: 2 });
    const first = await fixture.repo.scanPage();
    expect(first).toMatchObject({
      status: "indeterminate", code: "verifier-unavailable", state: { pendingRow: { nativeAddress: "stor-a", attempts: 1 } },
    });
    const second = await fixture.repo.scanPage(first.state);
    expect(second.deferred).toMatchObject([{ anchor: { nativeAddress: "stor-a" }, code: "verifier-unavailable", attempts: 2 }]);
    expect(second.results.map(({ outcome }) => outcome.status)).toEqual(["indeterminate", "indeterminate"]);
    expect(second.state.seen.size).toBe(0);
    expect(second.results.some(({ outcome }) => outcome.status === "unverifiable")).toBe(false);
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
      expect(cycle).toMatchObject({ status: "restart-required", code: "cursor-cycle", results: [] });
      if (cycle.status === "restart-required") expect(cycle.reason).toContain("cursor cycle");
      expect(cycle.state).toEqual(state(null));
      expect(input).toEqual(before);
      expect(fixture.readAnchor).not.toHaveBeenCalled();
    },
  );

  test("rejects a previously consumed current cursor before fetching", async () => {
    const fixture = setup([]);
    const input = { ...state("A"), consumedCursors: new Set(["A"]), pagesConsumed: 2 };
    const result = await fixture.repo.scanPage(input);
    expect(result).toMatchObject({ status: "restart-required", code: "cursor-cycle", results: [], state: state(null) });
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
    expect(readFailure).toMatchObject({ status: "indeterminate", code: "read-indeterminate" });
    expect(readFailure.state).toEqual(retrying(first.state, "a"));
    fixture.fetchPage.mockResolvedValue({ entries: [row("a")], nextCursor: "B" });
    const retry = await fixture.repo.scanPage(readFailure.state);
    expect(retry).toMatchObject({ status: "page", state: { cursor: "B", pagesConsumed: 2, pendingRow: null } });
    expect(retry.results[0]?.outcome.status).toBe("verified");
  });

  test("bounds a traversal after 10000 consumed pages before fetching", async () => {
    const fixture = setup([]);
    const input = Object.assign(state("next"), { pagesConsumed: 10_000, consumedCursors: cursors(9_999) });
    const result = await fixture.repo.scanPage(input);
    expect(result).toMatchObject({ status: "restart-required", code: "page-bound", results: [], state: state(null) });
    if (result.status === "restart-required") expect(result.reason).toContain("10000 pages");
    expect(fixture.fetchPage).not.toHaveBeenCalled();
  });

  const keptRows = {
    seen: new Map([["stor-x", logical("x")]]),
    metadata: new Map([["stor-x", logical("x")], ["stor-y", logical("y")], ["stor-z", logical("z")]]),
    deferred: [deferredRow("y")],
    pendingRow: { nativeAddress: "stor-z", attempts: 2 },
  };
  // The third page: the null and "old" pages are consumed.
  const resumable = (over: Partial<ArtifactScanState> = {}): ArtifactScanState => ({
    ...state("cur"), ...keptRows, consumedCursors: new Set(["old"]), pagesConsumed: 2, ...over,
  });
  test.each<[string, ArtifactScanRestartCode, Partial<ArtifactScanState>, ScanningArtifactRepositoryDeps["fetchPage"]?]>([
    ["a consumed current cursor", "cursor-cycle", { consumedCursors: new Set(["cur", "old"]), pagesConsumed: 3 }],
    ["the page bound", "page-bound", { pagesConsumed: 10_000, consumedCursors: cursors(9_999) }],
    ["a cursor that did not advance", "cursor-cycle", {}, async () => ({ entries: [row("w")], nextCursor: "cur" })],
    ["a next cursor already consumed", "cursor-cycle", {}, async () => ({ entries: [row("w")], nextCursor: "old" })],
    ["a fetcher restart signal", "history-restart-required", {},
      async () => { throw new AnchorHistoryRestartRequiredError("restart from null"); }],
  ])("a restart from a valid state (%s) keeps handled, deferred and pending rows", async (_name, code, over, fetchPage) => {
    const fixture = setup(["w"], fetchPage === undefined ? {} : { fetchPage });
    const result = await fixture.repo.scanPage(resumable(over));
    expect(result).toMatchObject({ status: "restart-required", code, results: [], deferred: [] });
    // Only the cursor and page-cycle fields restart; the unconsumed page adds no metadata.
    expect(result.state).toEqual({ ...state(null), ...keptRows });
    expect(fixture.readAnchor).not.toHaveBeenCalled();
  });

  test.each<[string, ArtifactScanRestartCode, Partial<ArtifactScanState>]>([
    ["a foreign owner", "foreign-owner-state", { owner: "other" }],
    ["a contradictory state", "invalid-state", { exhausted: true }],
    ["a malformed state", "invalid-state", { pendingRow: { nativeAddress: "stor-z", attempts: 0 } }],
  ])("a restart from an untrusted state (%s) starts a fresh traversal", async (_name, code, over) => {
    const fixture = setup(["w"]);
    const result = await fixture.repo.scanPage(resumable(over));
    expect(result).toMatchObject({ status: "restart-required", code, results: [], deferred: [] });
    expect(result.state).toEqual(state(null));
    expect(fixture.fetchPage).not.toHaveBeenCalled();
  });

  test.each<[ArtifactScanRestartCode, Partial<ArtifactScanState>, string]>([
    ["foreign-owner-state", { owner: "other" }, "scan state belongs to a different owner"],
    ["cursor-cycle", { consumedCursors: new Set(["cur", "old"]), pagesConsumed: 3 },
      "history cursor cycle detected at cur"],
  ])("a %s restart names its cause", async (code, over, reason) => {
    const fixture = setup(["w"]);
    expect(await fixture.repo.scanPage(resumable(over))).toMatchObject({
      status: "restart-required", code, reason,
    });
  });

  test("a restart from a state saved before pendingRow and deferred reports earlier rows again", async () => {
    const fixture = setup(["a", "b", "c"]);
    fixture.fetchPage.mockImplementation(async (cursor) => cursor === null
      ? { entries: [row("a"), row("b")], nextCursor: "p2" }
      : { entries: [row("c")], nextCursor: null });
    const first = await fixture.repo.scanPage();
    const { pendingRow: _pendingRow, deferred: _deferred, ...legacy } = first.state;
    const restarted = await fixture.repo.scanPage(legacy as ArtifactScanState);
    expect(restarted).toMatchObject({ status: "restart-required", code: "invalid-state", state: state(null) });
    const again = await fixture.repo.scanPage(restarted.state);
    const last = await fixture.repo.scanPage(again.state);
    expect(last.state.exhausted).toBe(true);
    // An invalid (legacy) state redelivers: a and b are reported twice, with the same nativeAddress key.
    const reported = [...first.results, ...again.results, ...last.results]
      .map(({ anchor, outcome }) => [anchor.nativeAddress, outcome.status]);
    expect(reported).toEqual([
      ["stor-a", "verified"], ["stor-b", "verified"],
      ["stor-a", "verified"], ["stor-b", "verified"], ["stor-c", "verified"],
    ]);
  });

  test("a fetcher whose cursors cycle keeps restarting but reports a handled row once", async () => {
    const fixture = setup(["a"]);
    fixture.fetchPage.mockImplementation(async (cursor) => cursor === null
      ? { entries: [row("a")], nextCursor: "p1" }
      : { entries: [], nextCursor: cursor === "p1" ? "p2" : "p1" });
    let input: ArtifactScanState | undefined;
    const statuses: string[] = [];
    const verified: string[] = [];
    for (let call = 0; call < 9; call++) {
      const page = await fixture.repo.scanPage(input);
      statuses.push(page.status === "restart-required" ? `restart:${page.code}` : page.status);
      verified.push(...page.results.filter(({ outcome }) => outcome.status === "verified")
        .map(({ anchor }) => anchor.nativeAddress));
      input = page.state;
    }
    // The restarts do not stop by themselves, which is why the README says to alert on them.
    expect(statuses).toEqual([
      "page", "page", "restart:cursor-cycle", "page", "page", "restart:cursor-cycle",
      "page", "page", "restart:cursor-cycle",
    ]);
    expect(verified).toEqual(["stor-a"]);
    expect(fixture.readAnchor).toHaveBeenCalledOnce();
  });

  test("reports conflicting history metadata separately without advancing", async () => {
    const fixture = setup(["a"]);
    const first = await fixture.repo.scanPage();
    fixture.fetchPage.mockResolvedValue({ entries: [{ ...row("a"), logicalAddress: logical("other") }], nextCursor: null });
    const result = await fixture.repo.scanPage({ ...first.state, cursor: "second", exhausted: false });
    expect(result).toMatchObject({
      status: "conflict", code: "metadata-conflict", results: [], state: { cursor: "second", exhausted: false },
    });
    expect(fixture.readAnchor).toHaveBeenCalledOnce();
  });

  test("unknown candidates are final unclassified, never resolved, read or verified", async () => {
    const verifyArtifact = vi.fn(() => true);
    const index = createInMemoryBindingIndex([{ ...binding("a"), logicalAddress: "dacs9:unknown" }]);
    const resolve = vi.spyOn(index, "resolve");
    const fixture = setup(["a"], { index, verifyArtifact });
    fixture.fetchPage.mockResolvedValue({ entries: [{ ...row("a"), logicalAddress: "dacs9:unknown" }], nextCursor: null });
    const result = await fixture.repo.scanPage(undefined, { includeUnknown: true });
    expect(result.results[0]?.outcome).toEqual({
      status: "unclassified", reason: "history row logical address is not an exact current-profile DACS address",
    });
    expect(result.state.seen.has("stor-a")).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
    expect(fixture.readAnchor).not.toHaveBeenCalled();
    expect(verifyArtifact).not.toHaveBeenCalled();
  });

  test("reports an overlapping filtered row when includeUnknown is later enabled", async () => {
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
    expect(second.results).toMatchObject([{ anchor: unknown, outcome: { status: "unclassified" } }]);
    expect(second.state.seen.get("stor-a")).toBe(unknown.logicalAddress);
    expect(first.state.seen.size).toBe(0);
    expect(fixture.readAnchor).not.toHaveBeenCalled();
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

  test.each([null, "page-2"])(
    "a failing row rebound to another logical address before its retry is a conflict (cursor %s)",
    async (cursor) => {
      const fixture = setup(["a"], { verifyArtifact: () => { throw new Error("registry 503"); } });
      fixture.fetchPage.mockResolvedValue({ entries: [row("a")], nextCursor: "later" });
      const first = await fixture.repo.scanPage(cursor === null ? undefined : state(cursor));
      expect(first).toMatchObject({ status: "indeterminate", code: "verifier-unavailable" });
      expect(first.state.metadata).toEqual(new Map([["stor-a", logical("a")]]));
      expect(first.state.pendingRow).toEqual({ nativeAddress: "stor-a", attempts: 1 });

      fixture.fetchPage.mockResolvedValue({
        entries: [{ nativeAddress: "stor-a", logicalAddress: logical("rebound"), owner: OWNER }], nextCursor: "later",
      });
      const retried = await fixture.repo.scanPage(first.state);
      expect(retried).toMatchObject({
        status: "conflict", code: "metadata-conflict", results: [], state: first.state,
        reason: `conflicting logical metadata for stor-a: ${logical("a")} vs ${logical("rebound")}`,
      });
      expect(fixture.readAnchor).toHaveBeenCalledOnce();
    },
  );

  test("does not hide disagreeing seen and metadata in resumed state", async () => {
    const fixture = setup(["a"]);
    const input = {
      ...state("second"),
      seen: new Map([["stor-a", logical("a")]]),
      metadata: new Map([["stor-a", logical("other")]]),
    };
    const result = await fixture.repo.scanPage(input);
    // A contradictory state is refused before fetching, even if the row never reappears.
    expect(result).toEqual({
      status: "restart-required", code: "invalid-state",
      reason: "scan state has disagreeing seen and metadata entries for stor-a",
      results: [], deferred: [], state: state(null),
    });
    expect(fixture.fetchPage).not.toHaveBeenCalled();
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
    expect(result).toMatchObject({
      status: "restart-required", code: "foreign-owner-state", results: [], state: state(null),
    });
    expect(fixture.fetchPage).not.toHaveBeenCalled();
  });

  test("requires a nonempty expected owner", () => {
    const fixture = setup([]);
    expect(() => createScanningArtifactRepository({ ...fixture.deps, expectedOwner: "  " })).toThrow("expectedOwner");
  });

  test.each([0, -1, 1.5, Number.NaN, "5"])("rejects maxRowAttempts %j", (maxRowAttempts) => {
    const fixture = setup([]);
    expect(() => createScanningArtifactRepository({
      ...fixture.deps, maxRowAttempts: maxRowAttempts as number,
    })).toThrow("maxRowAttempts");
  });

  test("E1: a verifier outage is retried at the same row once the service recovers", async () => {
    let available = false;
    const verifier = vi.fn(() => { if (!available) throw new Error("registry 503"); return true; });
    const fixture = setup(["a", "b"], { verifyArtifact: verifier });
    fixture.fetchPage.mockImplementation(async (cursor) => cursor === null
      ? { entries: [row("a"), row("b")], nextCursor: "p2" }
      : { entries: [row("a")], nextCursor: null });
    const first = await fixture.repo.scanPage();
    expect(first).toMatchObject({
      status: "indeterminate", code: "verifier-unavailable", deferred: [],
      state: { cursor: null, pendingRow: { nativeAddress: "stor-a", attempts: 1 } },
    });
    expect(first.state.seen.size).toBe(0);
    available = true;
    const retry = await fixture.repo.scanPage(first.state);
    expect(retry.status).toBe("page");
    expect(retry.results.map(({ anchor, outcome }) => [anchor.nativeAddress, outcome.status])).toEqual([
      ["stor-a", "verified"], ["stor-b", "verified"],
    ]);
    expect(retry.state).toMatchObject({ cursor: "p2", pendingRow: null });
    expect(verifier).toHaveBeenCalledTimes(3);
  });

  test("E2: a binding published after its history row is retried, not recorded as absent", async () => {
    const fixture = setup([]);
    const store = createInMemoryBindingStore();
    fixture.records.set("stor-a", record("a"));
    const repo = createScanningArtifactRepository({ ...fixture.deps, index: store, publisher: store });
    fixture.fetchPage.mockImplementation(async (cursor) => cursor === null
      ? { entries: [row("a")], nextCursor: "p2" }
      : { entries: [row("a")], nextCursor: null });
    const first = await repo.scanPage();
    expect(first).toMatchObject({
      status: "indeterminate", code: "binding-not-yet-visible",
      state: { cursor: null, pendingRow: { nativeAddress: "stor-a", attempts: 1 } },
    });
    expect(first.results.map(({ outcome }) => outcome.status)).toEqual(["indeterminate"]);
    expect(first.state.seen.size).toBe(0);
    expect(fixture.readAnchor).not.toHaveBeenCalled();
    await store.publish(binding("a")); // write anchors first and publishes afterwards
    const retry = await repo.scanPage(first.state);
    expect(retry).toMatchObject({ status: "page", state: { cursor: "p2" } });
    expect(retry.results.map(({ outcome }) => outcome.status)).toEqual(["verified"]);
  });

  test("L1: a persistently indeterminate row is deferred and later rows and pages are read", async () => {
    const fixture = setup(["a", "b", "c", "d"]);
    const store = createInMemoryBindingStore(["a", "b", "c", "d"].map(binding));
    const resolve = vi.fn(async (logicalAddress: string, owner: string) => logicalAddress === logical("b")
      ? { status: "indeterminate" as const, reason: "catalog candidate uses unsupported anchor kind x" }
      : store.resolve(logicalAddress, owner));
    const repo = createScanningArtifactRepository({ ...fixture.deps, index: { resolve } });
    fixture.fetchPage.mockImplementation(async (cursor) => cursor === null
      ? { entries: [row("a"), row("b"), row("c")], nextCursor: "p2" }
      : { entries: [row("b"), row("d")], nextCursor: null });
    let page = await repo.scanPage();
    const statuses: string[] = [page.status];
    for (let attempt = 2; attempt <= 4; attempt++) {
      expect(page).toMatchObject({
        status: "indeterminate", code: "index-indeterminate", deferred: [],
        state: { cursor: null, pendingRow: { nativeAddress: "stor-b", attempts: attempt - 1 } },
      });
      page = await repo.scanPage(page.state);
      statuses.push(page.status);
    }
    page = await repo.scanPage(page.state);
    statuses.push(page.status);
    expect(statuses).toEqual(["indeterminate", "indeterminate", "indeterminate", "indeterminate", "page"]);
    const deferredRow = {
      anchor: { ...row("b"), kind: "listing" }, code: "index-indeterminate",
      reason: "catalog candidate uses unsupported anchor kind x", attempts: 5,
    };
    expect(page.deferred).toEqual([deferredRow]);
    expect(page.results.map(({ anchor, outcome }) => [anchor.nativeAddress, outcome.status])).toEqual([
      ["stor-b", "indeterminate"], ["stor-c", "verified"],
    ]);
    expect(page.state).toMatchObject({ cursor: "p2", pendingRow: null, deferred: [deferredRow] });
    expect([...page.state.seen.keys()]).toEqual(["stor-a", "stor-c"]);
    // The deferred row is skipped on an overlapping later page, never re-read.
    const later = await repo.scanPage(page.state);
    expect(later).toMatchObject({ status: "page", deferred: [], state: { exhausted: true, deferred: [deferredRow] } });
    expect(later.results.map(({ anchor }) => anchor.nativeAddress)).toEqual(["stor-d"]);
    expect(later.state.seen.has("stor-b")).toBe(false);
    expect(resolve.mock.calls.filter(([address]) => address === logical("b"))).toHaveLength(5);
    // Restarting from null retries it.
    resolve.mockImplementation((logicalAddress, owner) => store.resolve(logicalAddress, owner));
    const restarted = await repo.scanPage();
    expect(restarted.results.map(({ anchor, outcome }) => [anchor.nativeAddress, outcome.status])).toEqual([
      ["stor-a", "verified"], ["stor-b", "verified"], ["stor-c", "verified"],
    ]);
  });

  test("counts only consecutive indeterminate attempts on the same row, with a configurable bound", async () => {
    const fixture = setup(["a", "b"]);
    const outcomes: Record<string, string[]> = { a: ["fail", "ok"], b: ["fail", "fail"] };
    fixture.readAnchor.mockImplementation(async (address) => {
      const id = address.slice("stor-".length);
      if (outcomes[id]?.shift() === "fail") throw new Error(`read ${id} unavailable`);
      return admittedFixture(fixture.records.get(address) ?? null);
    });
    const repo = createScanningArtifactRepository({ ...fixture.deps, maxRowAttempts: 2 });
    fixture.fetchPage.mockResolvedValueOnce({ entries: [row("a"), row("b")], nextCursor: null })
      .mockRejectedValueOnce(new Error("history unavailable"))
      .mockResolvedValue({ entries: [row("a"), row("b")], nextCursor: null });
    const first = await repo.scanPage();
    expect(first.state.pendingRow).toEqual({ nativeAddress: "stor-a", attempts: 1 });
    // An unavailable page is not an attempt on the row and does not reset it.
    const fetchFailure = await repo.scanPage(first.state);
    expect(fetchFailure).toMatchObject({ status: "indeterminate", code: "history-unavailable" });
    expect(fetchFailure.state.pendingRow).toEqual({ nativeAddress: "stor-a", attempts: 1 });
    // stor-a recovers; stor-b's first failure starts its own count.
    const second = await repo.scanPage(fetchFailure.state);
    expect(second).toMatchObject({ status: "indeterminate", code: "read-indeterminate" });
    expect(second.state.pendingRow).toEqual({ nativeAddress: "stor-b", attempts: 1 });
    const third = await repo.scanPage(second.state);
    expect(third).toMatchObject({ status: "page", state: { exhausted: true, pendingRow: null } });
    expect(third.deferred).toMatchObject([{ anchor: { nativeAddress: "stor-b" }, code: "read-indeterminate", attempts: 2 }]);
    expect([...third.state.seen.keys()]).toEqual(["stor-a"]);
  });

  test("a row deferred earlier on a page survives a second failing row on the same page", async () => {
    const fixture = setup(["a", "b", "c", "d"]);
    const store = createInMemoryBindingStore(["a", "b", "c", "d"].map(binding));
    const repo = createScanningArtifactRepository({
      ...fixture.deps, maxRowAttempts: 2,
      index: { resolve: async (logicalAddress, owner) => logicalAddress === logical("b") || logicalAddress === logical("c")
        ? { status: "indeterminate", reason: "index down" } : store.resolve(logicalAddress, owner) },
    });
    fixture.fetchPage.mockResolvedValue({ entries: ["a", "b", "c", "d"].map(row), nextCursor: null });
    const first = await repo.scanPage();
    expect(first).toMatchObject({ status: "indeterminate", state: { pendingRow: { nativeAddress: "stor-b", attempts: 1 } } });
    // b is deferred on its second attempt, then c fails on the same page.
    const second = await repo.scanPage(first.state);
    expect(second).toMatchObject({ status: "indeterminate", state: { pendingRow: { nativeAddress: "stor-c", attempts: 1 } } });
    expect(second.deferred.map(({ anchor }) => anchor.nativeAddress)).toEqual(["stor-b"]);
    expect(second.state.deferred.map(({ anchor }) => anchor.nativeAddress)).toEqual(["stor-b"]);
    const third = await repo.scanPage(second.state);
    expect(third).toMatchObject({ status: "page", state: { exhausted: true, pendingRow: null } });
    expect(third.state.deferred.map(({ anchor }) => anchor.nativeAddress)).toEqual(["stor-b", "stor-c"]);
    expect([...third.state.seen.keys()]).toEqual(["stor-a", "stor-d"]);
  });

  test("S1: JSON-persisted Maps return a restart diagnostic instead of rejecting", async () => {
    const fixture = setup(["a"]);
    const first = await fixture.repo.scanPage();
    const naive = JSON.parse(JSON.stringify({ ...first.state, exhausted: false, cursor: "c" })) as ArtifactScanState;
    const result = await fixture.repo.scanPage(naive);
    expect(result).toMatchObject({ status: "restart-required", code: "invalid-state", results: [], state: state(null) });
    expect(fixture.fetchPage).toHaveBeenCalledOnce();
  });

  test.each<[string, Record<string, unknown>]>([
    ["missing seen", { seen: undefined }],
    ["object seen", { seen: {} }],
    ["string seen", { seen: "stor-a" }],
    ["non-pair seen entry", { seen: [["stor-a"]] }],
    ["non-string seen value", { seen: new Map([["stor-a", 7]]) }],
    ["string seen entries", { seen: ["stor-a"] }],
    ["a three-part seen entry", { seen: [["stor-a", logical("a"), "extra"]] }],
    ["null metadata", { metadata: null }],
    ["non-string metadata value", { metadata: new Map([["stor-a", 7]]) }],
    ["a two-character string metadata entry", { metadata: ["ab"] }],
    ["a numeric metadata key", { metadata: new Map([[7, logical("a")]]) }],
    // Otherwise consistent, so only the element check refuses it.
    ["non-string consumed cursor", { consumedCursors: new Set([7]), pagesConsumed: 2 }],
    ["throwing iterator", { consumedCursors: { [Symbol.iterator]() { throw new Error("trap"); } } }],
    ["missing pendingRow", { pendingRow: undefined }],
    ["zero pendingRow attempts", { pendingRow: { nativeAddress: "stor-a", attempts: 0 } }],
    ["a blank pendingRow address", { metadata: new Map([[" ", logical("a")]]), pendingRow: { nativeAddress: " ", attempts: 1 } }],
    ["missing deferred", { deferred: undefined }],
    ["a non-array deferred collection", { deferred: new Set() }],
    ["unknown deferred code", { deferred: [{ anchor: row("a"), code: "absent", reason: "", attempts: 1 }] }],
    ["deferred without anchor", { deferred: [{ code: "read-indeterminate", reason: "", attempts: 1 }] }],
    ["a deferred row with a blank native address",
      { deferred: [{ anchor: { ...row("a"), nativeAddress: " " }, code: "read-indeterminate", reason: "", attempts: 1 }] }],
    ["a deferred row with a blank logical address",
      { deferred: [{ anchor: { ...row("a"), logicalAddress: " " }, code: "read-indeterminate", reason: "", attempts: 1 }] }],
    ["a deferred row with a blank owner",
      { deferred: [{ anchor: { ...row("a"), owner: " " }, code: "read-indeterminate", reason: "", attempts: 1 }] }],
    ["a deferred row with a numeric reason",
      { deferred: [{ anchor: row("a"), code: "read-indeterminate", reason: 7, attempts: 1 }] }],
    ["a deferred row with zero attempts",
      { deferred: [{ anchor: row("a"), code: "read-indeterminate", reason: "", attempts: 0 }] }],
  ])("malformed persisted state (%s) requires a restart without fetching", async (_name, bad) => {
    const fixture = setup(["a"]);
    const input = { ...state("next"), ...bad } as unknown as ArtifactScanState;
    await expect(fixture.repo.scanPage(input)).resolves.toMatchObject({
      status: "restart-required", code: "invalid-state", results: [], state: state(null),
    });
    expect(fixture.fetchPage).not.toHaveBeenCalled();
  });

  const pending = { nativeAddress: "stor-a", attempts: 1 };
  const handledA = { seen: new Map([["stor-a", logical("a")]]), metadata: new Map([["stor-a", logical("a")]]) };
  const pendingA = { metadata: new Map([["stor-a", logical("a")]]), pendingRow: pending };
  // Each case breaks exactly one relationship, except the review's S2 state.
  test.each<[string, Partial<ArtifactScanState>, string]>([
    ["S2: exhausted with unread history and a pending row",
      { cursor: "more-history", pagesConsumed: 1, exhausted: true, pendingRow: pending },
      "scan state is exhausted but still has a cursor"],
    ["exhausted with a cursor", { cursor: "more-history", pagesConsumed: 1, exhausted: true },
      "scan state is exhausted but still has a cursor"],
    ["exhausted with a pending row", { cursor: null, pagesConsumed: 1, exhausted: true, pendingRow: pending },
      "scan state is exhausted but still has a pending row"],
    ["exhausted before consuming a page", { cursor: null, pagesConsumed: 0, exhausted: true },
      "scan state is exhausted before consuming a page"],
    // Review COUNTERS: resuming would skip every row before the cursor.
    ["a cursor before consuming a page", { cursor: "skip-first", pagesConsumed: 0 },
      "scan state has a cursor before consuming a page"],
    ["consumed cursors before consuming a page", { cursor: null, pagesConsumed: 0, consumedCursors: new Set(["c1"]) },
      "scan state has consumed cursors before consuming a page"],
    ["more pages than consumed cursors", { cursor: "third-page", pagesConsumed: 3, consumedCursors: new Set(["c1"]) },
      "scan state page count does not match its consumed cursors"],
    ["fewer pages than consumed cursors", { cursor: "next", pagesConsumed: 2, consumedCursors: new Set(["c1", "c2"]) },
      "scan state page count does not match its consumed cursors"],
    ["exhausted with an extra consumed cursor",
      { cursor: null, pagesConsumed: 1, exhausted: true, consumedCursors: new Set(["impossible-extra-cursor"]) },
      "scan state page count does not match its consumed cursors"],
    ["no cursor after a page but not exhausted", { cursor: null, pagesConsumed: 2, consumedCursors: new Set(["c1"]) },
      "scan state has no cursor after consuming a page but is not exhausted"],
    ["a row both seen and deferred", { ...handledA, deferred: [deferredRow("a")] },
      "scan state has stor-a both in seen and deferred"],
    ["a row deferred twice", { deferred: [deferredRow("a"), deferredRow("a")] },
      "scan state defers stor-a twice"],
    ["deferred and metadata disagree", { metadata: new Map([["stor-a", logical("other")]]), deferred: [deferredRow("a")] },
      "scan state has disagreeing deferred and metadata entries for stor-a"],
    ["a pending row already in seen", { ...handledA, pendingRow: pending },
      "scan state has pending row stor-a already in seen"],
    ["a pending row already deferred", { ...pendingA, deferred: [deferredRow("a")] },
      "scan state has pending row stor-a already deferred"],
    // A retry could not detect the row rebinding to another logical address.
    ["a pending row without its logical metadata", { pendingRow: pending },
      "scan state has pending row stor-a without its logical metadata"],
  ])("contradictory persisted state (%s) requires a restart without fetching", async (_name, contradiction, reason) => {
    const fixture = setup(["a"]);
    const result = await fixture.repo.scanPage({ ...state("next"), ...contradiction });
    expect(result).toEqual({
      status: "restart-required", code: "invalid-state", reason, results: [], deferred: [], state: state(null),
    });
    expect(fixture.fetchPage).not.toHaveBeenCalled();
    expect(fixture.readAnchor).not.toHaveBeenCalled();
  });

  // The other direction: every page-count, cursor and exhaustion shape scanPage returns.
  test.each<[string, Partial<ArtifactScanState>]>([
    ["a fresh traversal", { cursor: null, pagesConsumed: 0 }],
    ["a valid restart keeping rows", {
      cursor: null, pagesConsumed: 0, seen: handledA.seen,
      metadata: new Map([...handledA.metadata, ["stor-b", logical("b")]]),
      pendingRow: { nativeAddress: "stor-b", attempts: 2 },
    }],
    ["the second page", { cursor: "c1", pagesConsumed: 1 }],
    ["a later page", { cursor: "c3", pagesConsumed: 3, consumedCursors: new Set(["c1", "c2"]) }],
    ["a later page retrying a row", { cursor: "c3", pagesConsumed: 3, consumedCursors: new Set(["c1", "c2"]), ...pendingA }],
    ["one exhausted page", { cursor: null, pagesConsumed: 1, exhausted: true }],
    ["several exhausted pages", { cursor: null, pagesConsumed: 3, consumedCursors: new Set(["c1", "c2"]), exhausted: true }],
    // The owner is optional on a history row, so it is optional on a deferred one.
    ["a deferred row without an owner", {
      metadata: new Map([["stor-z", logical("z")]]),
      deferred: [{
        anchor: { nativeAddress: "stor-z", logicalAddress: logical("z"), kind: "listing" },
        code: "read-indeterminate", reason: "r", attempts: 5,
      }],
    }],
  ])("consistent persisted state (%s) is resumed", async (_name, consistent) => {
    const fixture = setup(["a"]);
    const input = { ...state("next"), ...consistent };
    const result = await fixture.repo.scanPage(input);
    expect(result.status).toBe("page");
    expect(fixture.fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual(input.exhausted ? [] : [input.cursor]);
  });

  test("a pending row at the largest attempt count is deferred into a state that is resumed", async () => {
    const fixture = setup(["a"], { verifyArtifact: () => { throw new Error("registry 503"); } });
    fixture.fetchPage.mockResolvedValue({ entries: [row("a")], nextCursor: "later" });
    const input = retrying(state("page"), "a", Number.MAX_SAFE_INTEGER);
    const page = await fixture.repo.scanPage(input);
    expect(page).toMatchObject({ status: "page", state: { cursor: "later", pendingRow: null } });
    expect(page.state.deferred.map(({ attempts }) => attempts)).toEqual([Number.MAX_SAFE_INTEGER]);
    fixture.fetchPage.mockResolvedValue({ entries: [], nextCursor: null });
    const next = await fixture.repo.scanPage(page.state);
    expect(next).toMatchObject({ status: "page", state: { exhausted: true, deferred: page.state.deferred } });
  });

  test("accepts state persisted as entries, values and plain JSON rows", async () => {
    const fixture = setup(["a", "b"]);
    fixture.fetchPage.mockResolvedValue({ entries: [row("a"), row("b")], nextCursor: null });
    const persisted = JSON.parse(JSON.stringify({
      ...state("next"),
      seen: [["stor-x", logical("x")]],
      metadata: [["stor-x", logical("x")], ["stor-a", logical("a")]],
      consumedCursors: ["earlier"],
      pagesConsumed: 2,
      pendingRow: { nativeAddress: "stor-a", attempts: 1 },
      deferred: [{ anchor: { ...row("b"), kind: "rating" }, code: "read-indeterminate", reason: "r", attempts: 5 }],
    })) as Omit<ArtifactScanState, "seen" | "metadata" | "consumedCursors"> & {
      seen: [string, string][]; metadata: [string, string][]; consumedCursors: string[];
    };
    const result = await fixture.repo.scanPage({
      ...persisted,
      seen: new Map(persisted.seen),
      metadata: new Map(persisted.metadata),
      consumedCursors: new Set(persisted.consumedCursors),
    });
    expect(result.status).toBe("page");
    expect(result.results.map(({ anchor }) => anchor.nativeAddress)).toEqual(["stor-a"]);
    // A persisted kind is reclassified, never trusted.
    expect(result.state.deferred).toEqual([{
      anchor: { ...row("b"), kind: "listing" }, code: "read-indeterminate", reason: "r", attempts: 5,
    }]);
  });

  test("refuses a custom fetcher page larger than the limit without reading it", async () => {
    const fixture = setup(["a", "b", "c"]);
    fixture.fetchPage.mockResolvedValue({ entries: [row("a"), row("b"), row("c")], nextCursor: "later" });
    const input = state("page");
    const result = await fixture.repo.scanPage(input, { limit: 2 });
    expect(result).toEqual({
      status: "indeterminate", code: "page-limit-exceeded",
      reason: "page fetch failed: history page returned 3 entries for limit 2",
      results: [], deferred: [], state: input,
    });
    expect(fixture.readAnchor).not.toHaveBeenCalled();
  });

  test("an invalid page limit is coded and never fetches", async () => {
    const fixture = setup(["a"]);
    await expect(fixture.repo.scanPage(undefined, { limit: 0 })).resolves.toMatchObject({
      status: "indeterminate", code: "invalid-limit",
    });
    expect(fixture.fetchPage).not.toHaveBeenCalled();
  });

  test("D1: composes with the Demos history fetcher and restarts when its boundary is lost", async () => {
    const ownerHex = "ab".repeat(32);
    const address = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;
    const logicalOf = (n: number) => `dacs1:${ownerHex}:l${n}:v1`;
    const tx = (n: number) => ({
      hash: `tx-${n}`, status: "confirmed", blockNumber: n,
      content: {
        // Newest first: rows 1..3, then the prepended rows from 1000 upwards above them.
        timestamp: n < 1000 ? 1000 - n : n,
        type: "storageProgram", from: `0x${ownerHex}`, to: address(n),
        data: ["storageProgram", {
          operation: "CREATE_STORAGE_PROGRAM", storageAddress: address(n),
          metadata: { logicalAddress: logicalOf(n) },
        }],
      },
    });
    let history = [tx(1), tx(2), tx(3)];
    const client = {
      getTransactionHistory: vi.fn(async (_owner: string, _type: string, { start, limit }: { start: number; limit: number }) =>
        history.slice(start, start + limit)),
    };
    const records = new Map<string, Record<string, unknown>>();
    const store = createInMemoryBindingStore();
    const publishAll = async (ids: number[]) => {
      for (const n of ids) {
        const value = { n };
        records.set(address(n), value);
        await store.publish({
          logicalAddress: logicalOf(n), nativeAddress: address(n),
          owner: `0x${ownerHex.toUpperCase()}`, contentHash: contentHash(value),
        });
      }
    };
    await publishAll([1, 2, 3]);
    const repo = createScanningArtifactRepository({
      expectedOwner: ownerHex, index: store, publisher: store,
      adapter: { getAddress: () => "reader", anchorWriteOnce: async () => { throw new Error("unexpected write"); },
        readAnchor: async (native) => admittedFixture(records.get(native) ?? null) },
      fetchPage: createDemosHistoryPageFetcher(client, ownerHex),
      verifyArtifact: () => true,
    });
    const verified = (page: ArtifactScanPage) => page.results
      .filter(({ outcome }) => outcome.status === "verified").map(({ anchor }) => anchor.nativeAddress);
    const first = await repo.scanPage(undefined, { limit: 2 });
    expect(first.status).toBe("page");
    expect(first.results.map(({ outcome }) => outcome.status)).toEqual(["verified", "verified"]);
    const reported = verified(first);
    // More than one overlap window of rows is prepended between pages.
    const prepended = Array.from({ length: 150 }, (_, i) => 1000 + i);
    history = [...prepended.map(tx).reverse(), ...history];
    await publishAll(prepended);
    const lost = await repo.scanPage(first.state, { limit: 2 });
    // The state was valid: only the cursor and page cycle restart.
    expect(lost).toMatchObject({
      status: "restart-required", code: "history-restart-required", results: [],
      state: { cursor: null, seen: first.state.seen, pagesConsumed: 0, pendingRow: null, deferred: [] },
    });
    if (lost.status === "restart-required") expect(lost.reason).toContain("restart from null");
    // Following the returned state restarts from null and completes the traversal.
    let page = await repo.scanPage(lost.state, { limit: 100 });
    const statuses = new Set<string>();
    while (page.status === "page") {
      reported.push(...verified(page));
      if (page.state.exhausted) break;
      page = await repo.scanPage(page.state, { limit: 100 });
      statuses.add(page.status);
    }
    expect(page.status).toBe("page");
    expect([...statuses]).toEqual(["page"]);
    // Each of the 153 rows is reported verified exactly once across the restart.
    expect(reported).toHaveLength(153);
    expect(new Set(reported).size).toBe(153);
  });

  test("R5: a persisted Demos cursor that cannot be decoded restarts instead of retrying forever", async () => {
    const ownerHex = "ab".repeat(32);
    const client = { getTransactionHistory: vi.fn(async () => []) };
    const fixture = setup([], { expectedOwner: ownerHex, fetchPage: createDemosHistoryPageFetcher(client, ownerHex) });
    const handled = new Map([["stor-x", logical("x")]]);
    for (const cursor of ["", "dacs-demos-history-v2.eyJ2IjoyfQ", "dacs-demos-history-v1.!!!"]) {
      const input = { ...state(cursor), owner: ownerHex, seen: handled, metadata: handled, pagesConsumed: 1 };
      const result = await fixture.repo.scanPage(input);
      expect(result).toMatchObject({ status: "restart-required", code: "history-restart-required" });
      expect(result.state).toEqual({ ...state(null), owner: ownerHex, seen: handled, metadata: handled });
    }
    expect(client.getTransactionHistory).not.toHaveBeenCalled();
  });

  test("conflicting logical metadata from the Demos fetcher is a conflict, not a retryable outage", async () => {
    const ownerHex = "ab".repeat(32);
    const native = `stor-${"1".repeat(40)}`;
    const listing = `dacs1:${ownerHex}:listing:v1`;
    const create = (hash: string, logicalAddress: string, timestamp: number) => ({
      hash, status: "confirmed", blockNumber: 1,
      content: {
        timestamp, type: "storageProgram", from: `0x${ownerHex}`, to: native,
        data: ["storageProgram", { operation: "CREATE_STORAGE_PROGRAM", storageAddress: native, metadata: { logicalAddress } }],
      },
    });
    // Newest first: an older create assigns another logical address to the same program.
    const history = [create("tx-2", listing, 2), create("tx-1", `dacs1:${ownerHex}:other:v1`, 1)];
    const client = {
      getTransactionHistory: vi.fn(async (_owner: string, _type: string, { start, limit }: { start: number; limit: number }) =>
        history.slice(start, start + limit)),
    };
    const value = { listing: 1 };
    const store = createInMemoryBindingStore([{
      logicalAddress: listing, nativeAddress: native, owner: `0x${ownerHex}`, contentHash: contentHash(value), version: 1,
    }]);
    const repo = createScanningArtifactRepository({
      expectedOwner: ownerHex, index: store, publisher: store,
      adapter: { getAddress: () => "reader", anchorWriteOnce: async () => { throw new Error("unexpected write"); },
        readAnchor: async () => admittedFixture(value) },
      fetchPage: createDemosHistoryPageFetcher(client, ownerHex),
      verifyArtifact: () => true,
    });
    const first = await repo.scanPage(undefined, { limit: 1 });
    expect(first.results.map(({ outcome }) => outcome.status)).toEqual(["verified"]);
    // The fetcher remembers the first assignment, so every retry gets the same conflict.
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(repo.scanPage(first.state, { limit: 1 })).resolves.toEqual({
        status: "conflict", code: "metadata-conflict",
        reason: `page fetch failed: Demos history assigns conflicting logical metadata to ${native}`,
        results: [], deferred: [], state: first.state,
      });
    }
  });

  test("a new traversal recovers from rewritten history through the same Demos fetcher", async () => {
    const ownerHex = "ab".repeat(32);
    const native = `stor-${"1".repeat(40)}`;
    const create = (logicalAddress: string) => ({
      hash: "tx-1", status: "confirmed", blockNumber: 1,
      content: {
        timestamp: 1, type: "storageProgram", from: `0x${ownerHex}`, to: native,
        data: ["storageProgram", { operation: "CREATE_STORAGE_PROGRAM", storageAddress: native, metadata: { logicalAddress } }],
      },
    });
    const before = `dacs1:${ownerHex}:before:v1`;
    const after = `dacs1:${ownerHex}:after:v1`;
    let history = [create(before)];
    const client = {
      getTransactionHistory: vi.fn(async (_owner: string, _type: string, { start, limit }: { start: number; limit: number }) =>
        history.slice(start, start + limit)),
    };
    const value = { listing: 1 };
    const store = createInMemoryBindingIndex([before, after].map((logicalAddress) => ({
      logicalAddress, nativeAddress: native, owner: `0x${ownerHex}`, contentHash: contentHash(value),
    })));
    const repo = createScanningArtifactRepository({
      expectedOwner: ownerHex, index: store, publisher: { publish: async () => { throw new Error("unexpected publish"); } },
      adapter: { getAddress: () => "reader", anchorWriteOnce: async () => { throw new Error("unexpected write"); },
        readAnchor: async () => admittedFixture(value) },
      fetchPage: createDemosHistoryPageFetcher(client, ownerHex),
      verifyArtifact: () => true,
    });
    const first = await repo.scanPage();
    expect(first).toMatchObject({ status: "page", state: { exhausted: true } });
    expect(first.results.map(({ anchor }) => anchor.logicalAddress)).toEqual([before]);
    history = [create(after)];
    // After operator review, scanPage() without state starts a new traversal.
    const recovered = await repo.scanPage();
    expect(recovered).toMatchObject({ status: "page", state: { exhausted: true } });
    expect(recovered.results.map(({ anchor, outcome }) => [anchor.logicalAddress, outcome.status])).toEqual([[after, "verified"]]);
  });

  test("the README example returns unverifiable, then an empty exhausted page", async () => {
    const expectedOwner = "offline-seller";
    const logicalAddress = "dacs1:offline-seller:example:v1";
    const nativeAddress = "stor-offline-example";
    const artifact = { listingVersion: 1 };
    const bindings = createInMemoryBindingStore([{
      logicalAddress, nativeAddress, owner: expectedOwner,
      contentHash: contentHash(artifact), version: 1,
    }]);
    const repository = createScanningArtifactRepository({
      expectedOwner, index: bindings, publisher: bindings,
      adapter: {
        getAddress: () => "offline-reader",
        anchorWriteOnce: async () => { throw new Error("read-only demo"); },
        readAnchor: async (address) => admittedFixture(address === nativeAddress ? artifact : null),
      },
      fetchPage: async (cursor) => cursor === null
        ? { entries: [{ logicalAddress, nativeAddress, owner: expectedOwner }], nextCursor: "second-page" }
        : { entries: [], nextCursor: null },
      verifyArtifact: () => {
        throw new UnsupportedArtifactKindError("no offline signature and authorization provider");
      },
    });
    const first = await repository.scanPage();
    expect(first.status).toBe("page");
    expect(first.results[0]?.outcome).toMatchObject({ status: "unverifiable", code: "unsupported-kind" });
    const second = await repository.scanPage(first.state);
    expect(second).toMatchObject({ status: "page", results: [], state: { exhausted: true } });
  });
});
