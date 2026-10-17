import { describe, expect, test, vi } from "vitest";

import {
  createDemosHistoryPageFetcher,
  type DemosHistoryClient,
} from "../../src/substrate/index.js";
import {
  AnchorHistoryRestartRequiredError,
  createDemosHistoryPageFetcher as createDemosHistoryPageFetcherFromRoot,
  scanAllAnchors,
  scanAnchorPage,
} from "../../src/index.js";

const OWNER = `0x${"a".repeat(64)}`;
const OTHER_OWNER = `0x${"b".repeat(64)}`;
const NATIVE_1 = `stor-${"1".repeat(40)}`;
const NATIVE_2 = `stor-${"2".repeat(40)}`;
const NATIVE_3 = `stor-${"3".repeat(40)}`;

interface RowOptions {
  hash: string;
  nativeAddress?: string;
  logicalAddress?: string;
  owner?: string;
  operation?: string;
  status?: string;
  metadata?: unknown;
  to?: string;
  timestamp?: number | string;
}

type Row = Record<string, unknown>;

// Rows are listed newest first, so each row built gets an older timestamp by default.
let nextTimestamp = 1_800_000_000_000;

function row(options: RowOptions): Record<string, unknown> {
  const nativeAddress = options.nativeAddress ?? NATIVE_1;
  const metadata =
    options.metadata !== undefined
      ? options.metadata
      : options.logicalAddress === undefined
        ? undefined
        : { logicalAddress: options.logicalAddress };
  return {
    hash: options.hash,
    status: options.status ?? "confirmed",
    blockNumber: options.status === "failed" ? null : 42,
    content: {
      timestamp: options.timestamp ?? nextTimestamp--,
      type: "storageProgram",
      from: options.owner ?? OWNER,
      to: options.to ?? nativeAddress,
      data: [
        "storageProgram",
        {
          operation: options.operation ?? "CREATE_STORAGE_PROGRAM",
          storageAddress: nativeAddress,
          programName: "opaque-base64-write-input",
          data: { signed: "artifact" },
          ...(metadata === undefined ? {} : { metadata }),
        },
      ],
    },
  };
}

function clientWith(
  implementation: DemosHistoryClient["getTransactionHistory"],
): DemosHistoryClient {
  return { getTransactionHistory: vi.fn(implementation) };
}

describe("createDemosHistoryPageFetcher (#54)", () => {
  test("rejects a confirmed READ_STORAGE query presented as a transaction", async () => {
    const fetchPage = createDemosHistoryPageFetcher(clientWith(async () => [
      row({ hash: "read-query", operation: "READ_STORAGE" }),
    ]), OWNER);
    await expect(fetchPage(null, 2)).rejects.toThrow(/inconsistent storage metadata/);
  });

  test.each([" 1", "1 ", "0x10", "01", "-1"])(
    "rejects nondecimal transaction timestamp %j", async (timestamp) => {
      const fetchPage = createDemosHistoryPageFetcher(clientWith(async () => [
        row({ hash: "bad-timestamp", timestamp }),
      ]), OWNER);
      await expect(fetchPage(null, 2)).rejects.toThrow(/no transaction timestamp/);
    },
  );

  test("is exported publicly and extracts logical metadata, never programName", async () => {
    expect(createDemosHistoryPageFetcherFromRoot).toBe(
      createDemosHistoryPageFetcher,
    );
    const client = clientWith(async (_owner, _type, options) =>
      options.limit === 1
        ? []
        : [
            row({
              hash: "tx-1",
              logicalAddress: "dacs1:seller:service:v1",
            }),
            row({
              hash: "tx-2",
              nativeAddress: NATIVE_2,
              metadata: { logical_address: "dacs3:commit:job-1" },
            }),
          ],
    );

    const page = await createDemosHistoryPageFetcher(client, OWNER)(null, 5);
    expect(page).toEqual({
      entries: [
        {
          nativeAddress: NATIVE_1,
          logicalAddress: "dacs1:seller:service:v1",
          owner: OWNER,
        },
        {
          nativeAddress: NATIVE_2,
          logicalAddress: "dacs3:commit:job-1",
          owner: OWNER,
        },
      ],
      nextCursor: null,
    });
    expect(client.getTransactionHistory).toHaveBeenNthCalledWith(
      1,
      OWNER,
      "storageProgram",
      { start: 0, limit: 5 },
    );
    expect(client.getTransactionHistory).toHaveBeenNthCalledWith(
      2,
      OWNER,
      "storageProgram",
      { start: 2, limit: 1 },
    );
  });

  test("uses an opaque cursor and re-reads the boundary group from the row before it", async () => {
    const rows = [
      row({ hash: "tx-1", logicalAddress: "dacs1:s:svc:v1" }),
      row({
        hash: "tx-2",
        nativeAddress: NATIVE_2,
        logicalAddress: "dacs1:s:svc:v2",
      }),
      row({
        hash: "tx-3",
        nativeAddress: NATIVE_3,
        logicalAddress: "dacs3:commit:job-1",
      }),
    ];
    const client = clientWith(async (_owner, _type, { start, limit }) => {
      return rows.slice(start, start + limit);
    });
    const fetchPage = createDemosHistoryPageFetcher(client, OWNER);

    const first = await fetchPage(null, 2);
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).toMatch(/^dacs-demos-history-v2\./);

    const second = await fetchPage(first.nextCursor, 2);
    expect(second).toEqual({
      entries: [
        {
          nativeAddress: NATIVE_3,
          logicalAddress: "dacs3:commit:job-1",
          owner: OWNER,
        },
      ],
      nextCursor: null,
    });
    // tx-2 is the boundary group; the window starts at tx-1, the row before it.
    expect(client.getTransactionHistory).toHaveBeenNthCalledWith(
      2,
      OWNER,
      "storageProgram",
      { start: 0, limit: 100 },
    );
  });

  // The node orders by timestamp alone, so a tie group can come back in another order.
  test("a tie group reordered between queries loses no row (A t9, B C D t5, E t1)", async () => {
    const tx = (hash: string, timestamp: number, n: number) => row({
      hash, timestamp, nativeAddress: `stor-${n.toString(16).padStart(40, "0")}`, logicalAddress: `dacs1:s:${hash}:v1`,
    });
    const [a, b, c, d, e] = [tx("A", 9, 1), tx("B", 5, 2), tx("C", 5, 3), tx("D", 5, 4), tx("E", 1, 5)];
    let calls = 0;
    // Each query returns the tie group in a different order.
    const orders = [[a, b, c, d, e], [a, c, b, d, e], [a, d, c, b, e], [a, b, d, c, e]];
    const client = clientWith(async (_owner, _type, { start, limit }) =>
      orders[calls++ % orders.length]!.slice(start, start + limit));
    const fetchPage = createDemosHistoryPageFetcher(client, OWNER);
    const emitted: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const result = await fetchPage(cursor, 2);
      emitted.push(...result.entries.map((entry) => entry.logicalAddress!.split(":")[2]!));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect([...emitted].sort()).toEqual(["A", "B", "C", "D", "E"]);
    expect(new Set(emitted).size).toBe(5);
  });

  test("a row confirmed later into the boundary's timestamp group is still emitted", async () => {
    const tx = (hash: string, timestamp: number, n: number) => row({
      hash, timestamp, nativeAddress: `stor-${n.toString(16).padStart(40, "0")}`, logicalAddress: `dacs1:s:${hash}:v1`,
    });
    const [a, b, c, d] = [tx("A", 9, 1), tx("B", 5, 2), tx("C", 5, 3), tx("D", 1, 4)];
    let history = [a, b, d];
    const client = clientWith(async (_owner, _type, { start, limit }) => history.slice(start, start + limit));
    const fetchPage = createDemosHistoryPageFetcher(client, OWNER);
    const first = await fetchPage(null, 2);
    history = [a, c, b, d];
    const second = await fetchPage(first.nextCursor, 2);
    expect(second.entries.map((entry) => entry.logicalAddress)).toEqual(["dacs1:s:C:v1", "dacs1:s:D:v1"]);
    expect(second.nextCursor).toBeNull();
  });

  test("a tie group that runs past the overlap window restarts instead of guessing", async () => {
    const tied = Array.from({ length: 101 }, (_, n) => row({
      hash: `tied-${n}`, timestamp: 5, nativeAddress: `stor-${n.toString(16).padStart(40, "0")}`,
    }));
    const client = clientWith(async (_owner, _type, { start, limit }) => tied.slice(start, start + limit));
    const fetchPage = createDemosHistoryPageFetcher(client, OWNER);
    const first = await fetchPage(null, 2);
    await expect(fetchPage(first.nextCursor, 2)).rejects.toBeInstanceOf(AnchorHistoryRestartRequiredError);
  });

  // Boundary guards. Each history changes between the first and second page.
  const tied = (hash: string, timestamp: number, n: number) => row({
    hash, timestamp, nativeAddress: `stor-${n.toString(16).padStart(40, "0")}`, logicalAddress: `dacs1:s:${hash}:v1`,
  });
  async function drain(fetchPage: ReturnType<typeof createDemosHistoryPageFetcher>, limit: number) {
    const emitted: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const result = await fetchPage(cursor, limit);
      emitted.push(...result.entries.map((entry) => entry.logicalAddress!.split(":")[2]!));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    return emitted;
  }
  function changingClient(first: Record<string, unknown>[], later: Record<string, unknown>[]) {
    let calls = 0;
    return clientWith(async (_owner, _type, { start, limit }) =>
      (calls++ === 0 ? first : later).slice(start, start + limit));
  }

  test("a window that starts inside the boundary group restarts instead of skipping a tied row", async () => {
    // Page 1 sees X2 X1 A B. The newest rows then vanish (a lagging backend or a
    // rollback), so the window starts at B and cannot show C was before it.
    const [x2, x1, a, b, c, d] = [
      tied("X2", 12, 1), tied("X1", 11, 2), tied("A", 9, 3), tied("B", 5, 4), tied("C", 5, 5), tied("D", 1, 6),
    ];
    const client = changingClient([x2, x1, a, b, c, d], [a, c, b, d]);
    const fetchPage = createDemosHistoryPageFetcher(client, OWNER);
    await expect(drain(fetchPage, 4)).rejects.toBeInstanceOf(AnchorHistoryRestartRequiredError);
    expect(client.getTransactionHistory).toHaveBeenLastCalledWith(OWNER, "storageProgram", { start: 2, limit: 100 });
    // The restart from null reads C.
    await expect(drain(fetchPage, 4)).resolves.toEqual(["A", "C", "B", "D"]);
  });

  test.each([
    ["a duplicated boundary row", (a: Row, b: Row, c: Row, d: Row) => [a, b, c, c, d]],
    ["exactly one emitted row missing", (a: Row, b: Row, _c: Row, d: Row) => [a, b, d]],
    ["every emitted row missing", (a: Row, _b: Row, _c: Row, d: Row) => [a, d]],
  ])("a boundary group with %s restarts and emits nothing", async (_name, later) => {
    const [a, b, c, d] = [tied("A", 9, 1), tied("B", 5, 2), tied("C", 5, 3), tied("D", 1, 4)];
    const fetchPage = createDemosHistoryPageFetcher(changingClient([a, b, c, d], later(a, b, c, d)), OWNER);
    const first = await fetchPage(null, 3);
    expect(first.entries.map((entry) => entry.logicalAddress)).toEqual(["dacs1:s:A:v1", "dacs1:s:B:v1", "dacs1:s:C:v1"]);
    await expect(fetchPage(first.nextCursor, 3)).rejects.toBeInstanceOf(AnchorHistoryRestartRequiredError);
  });

  // Admission guards: a malformed row fails the page; it is never skipped silently.
  const edited = (edit: (value: Row) => void): Row => {
    const value = row({ hash: "tx-edit", logicalAddress: "dacs1:s:svc:v1" });
    edit(value);
    return value;
  };
  const payloadOf = (value: Row) => ((value.content as Row).data as [string, Row])[1];
  const setStorage = (value: Row, address: string) => {
    (value.content as Row).to = address;
    payloadOf(value).storageAddress = address;
  };
  test.each<[string, (value: Row) => void, RegExp]>([
    ["a blank hash", (v) => { v.hash = " "; }, /no transaction hash/],
    ["no status", (v) => { delete v.status; }, /no transaction status/],
    ["a pending status in a block", (v) => { v.status = "pending"; }, /unsupported status pending/],
    ["a confirmed status without a block", (v) => { v.blockNumber = null; }, /not block-confirmed/],
    ["a negative block", (v) => { v.blockNumber = -1; }, /not block-confirmed/],
    ["a decimal-string block", (v) => { v.blockNumber = "42"; }, /not block-confirmed/],
    ["another transaction type", (v) => { (v.content as Row).type = "native"; }, /malformed storage content/],
    ["a blank sender", (v) => { (v.content as Row).from = " "; }, /malformed storage content/],
    ["a sender with leading junk", (v) => { (v.content as Row).from = `x${OWNER}`; }, /32-byte hex address/],
    ["a sender with trailing junk", (v) => { (v.content as Row).from = `${OWNER}00`; }, /32-byte hex address/],
    ["a three-part payload", (v) => { ((v.content as Row).data as unknown[]).push({}); }, /malformed storage payload/],
    ["a one-part payload", (v) => { ((v.content as Row).data as unknown[]).pop(); }, /malformed storage payload/],
    ["an array-like payload tuple", (v) => {
      (v.content as Row).data = { length: 2, 0: "storageProgram", 1: payloadOf(v) };
    }, /malformed storage payload/],
    ["another payload tag", (v) => { ((v.content as Row).data as unknown[])[0] = "native"; }, /malformed storage payload/],
    ["an unknown operation", (v) => { payloadOf(v).operation = "CREATE_STORAGE"; }, /inconsistent storage metadata/],
    ["a storage address with leading junk", (v) => setStorage(v, `x${NATIVE_1}`), /inconsistent storage metadata/],
    ["a storage address with trailing junk", (v) => setStorage(v, `${NATIVE_1}0`), /inconsistent storage metadata/],
    ["an uppercase storage address", (v) => setStorage(v, NATIVE_1.toUpperCase()), /inconsistent storage metadata/],
    ["array metadata", (v) => { payloadOf(v).metadata = ["dacs1:s:svc:v1"]; }, /malformed record metadata/],
    ["string metadata", (v) => { payloadOf(v).metadata = "dacs1:s:svc:v1"; }, /malformed record metadata/],
    ["a blank logical_address", (v) => { payloadOf(v).metadata = { logical_address: " " }; }, /invalid logical_address metadata/],
    ["a numeric logical_address", (v) => { payloadOf(v).metadata = { logical_address: 7 }; }, /invalid logical_address metadata/],
  ])("a row with %s fails the page", async (_name, edit, error) => {
    const client = clientWith(async (_owner, _type, { start }) => start === 0 ? [edited(edit)] : []);
    await expect(createDemosHistoryPageFetcher(client, OWNER)(null, 2)).rejects.toThrow(error);
  });

  test.each<[string, (value: Row) => void, boolean]>([
    ["an update carrying logical metadata", (v) => { payloadOf(v).operation = "WRITE_STORAGE"; }, false],
    ["a DELETE_ITEM operation", (v) => { payloadOf(v).operation = "DELETE_ITEM"; }, false],
    ["null metadata", (v) => { payloadOf(v).metadata = null; }, false],
    ["a confirmation in block 0", (v) => { v.blockNumber = 0; }, true],
    ["a timestamp of 0", (v) => { (v.content as Row).timestamp = 0; }, true],
    ["a decimal-string timestamp of 0", (v) => { (v.content as Row).timestamp = "0"; }, true],
    ["equal camelCase and snake_case logical metadata", (v) => {
      payloadOf(v).metadata = { logicalAddress: "dacs1:s:svc:v1", logical_address: "dacs1:s:svc:v1" };
    }, true],
  ])("a row with %s is well formed (emitted: %s)", async (_name, edit, emitted) => {
    const client = clientWith(async (_owner, _type, { start }) => start === 0 ? [edited(edit)] : []);
    await expect(createDemosHistoryPageFetcher(client, OWNER)(null, 2)).resolves.toEqual({
      entries: emitted ? [{ nativeAddress: NATIVE_1, logicalAddress: "dacs1:s:svc:v1", owner: OWNER }] : [],
      nextCursor: null,
    });
  });

  test("an RPC result longer than the requested page fails instead of being consumed", async () => {
    const rows = [1, 2, 3].map((n) => tied(`R${n}`, 10 - n, n));
    const fetchPage = createDemosHistoryPageFetcher(clientWith(async () => rows), OWNER);
    await expect(fetchPage(null, 2)).rejects.toThrow(/exceeded the requested page size/);
  });

  test.each([`x${OWNER}`, `${OWNER}00`, "not-an-owner"])("the owner %s is refused before any node call", (owner) => {
    const client = clientWith(async () => []);
    expect(() => createDemosHistoryPageFetcher(client, owner)).toThrow(/32-byte hex address/);
    expect(client.getTransactionHistory).not.toHaveBeenCalled();
  });

  test("rows out of timestamp order, or without a timestamp, are malformed", async () => {
    const outOfOrder = createDemosHistoryPageFetcher(clientWith(async () => [
      row({ hash: "older", timestamp: 1 }), row({ hash: "newer", timestamp: 2 }),
    ]), OWNER);
    await expect(outOfOrder(null, 2)).rejects.toThrow(/out of timestamp order/);
    for (const timestamp of [-1, 1.5, 2 ** 60, "01", "x", null]) {
      const bad = row({ hash: "bad" });
      (bad.content as Record<string, unknown>).timestamp = timestamp;
      await expect(createDemosHistoryPageFetcher(clientWith(async () => [bad]), OWNER)(null, 1))
        .rejects.toThrow(/no transaction timestamp/);
    }
    // Postgres returns the bigint column as a decimal string.
    const decimal = createDemosHistoryPageFetcher(clientWith(async (_owner, _type, { start }) => start === 0
      ? [row({ hash: "s", timestamp: "1800000000000", logicalAddress: "dacs1:s:svc:v1" })]
      : []), OWNER);
    await expect(decimal(null, 2)).resolves.toMatchObject({ entries: [{ logicalAddress: "dacs1:s:svc:v1" }], nextCursor: null });
  });

  // Every continuation re-reads a full 100-row window; only a boundary group that
  // fills it may restart, never an ordinary long history.
  test.each([7, 50, 99])("a 150-row history drains at limit %i: every row once, in order", async (limit) => {
    const history = Array.from({ length: 150 }, (_, n) => row({
      hash: `tx-${n}`, timestamp: 2_000_000 - n, nativeAddress: `stor-${n.toString(16).padStart(40, "0")}`,
      logicalAddress: `dacs1:s:l${n}:v1`,
    }));
    const client = clientWith(async (_owner, _type, { start, limit: size }) => history.slice(start, start + size));
    const result = await scanAllAnchors(createDemosHistoryPageFetcher(client, OWNER), { limit, includeUnknown: true });
    expect(result.status).toBe("complete");
    expect(result.anchors.map((anchor) => anchor.logicalAddress)).toEqual(history.map((_, n) => `dacs1:s:l${n}:v1`));
  });

  // Buffered overlap: more rows after the boundary than `limit` in a short window.
  test("five rows at limit 2 are all returned across pages", async () => {
    const history = [1, 2, 3, 4, 5].map((n) => row({
      hash: `tx-${n}`, nativeAddress: `stor-${n.toString(16).padStart(40, "0")}`, logicalAddress: `dacs1:s:l${n}:v1`,
    }));
    const fetchPage = createDemosHistoryPageFetcher(
      clientWith(async (_owner, _type, { start, limit }) => history.slice(start, start + limit)), OWNER);
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const result = await fetchPage(cursor, 2);
      seen.push(...result.entries.map((entry) => entry.nativeAddress));
      sizes.push(result.entries.length);
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5].map((n) => `stor-${n.toString(16).padStart(40, "0")}`));
    // Each page honours the limit even when the window holds more rows.
    expect(sizes).toEqual([2, 2, 1]);
  });

  test("a new traversal forgets the previous traversal's logical metadata", async () => {
    let history = [row({ hash: "tx-1", logicalAddress: "dacs1:s:before:v1" })];
    const fetchPage = createDemosHistoryPageFetcher(
      clientWith(async (_owner, _type, { start, limit }) => history.slice(start, start + limit)), OWNER);
    await expect(fetchPage(null, 5)).resolves.toMatchObject({ nextCursor: null });
    history = [row({ hash: "tx-1", logicalAddress: "dacs1:s:after:v1" })];
    await expect(fetchPage(null, 5)).resolves.toMatchObject({
      entries: [{ logicalAddress: "dacs1:s:after:v1" }], nextCursor: null,
    });
  });

  test("restarting a separate fetcher does not clear an active traversal's conflict memory", async () => {
    const rows = [
      row({ hash: "tx-first", nativeAddress: NATIVE_1, logicalAddress: "dacs1:s:before:v1" }),
      row({ hash: "tx-other", nativeAddress: NATIVE_1, logicalAddress: "dacs1:s:after:v1" }),
    ];
    const client = clientWith(async (_owner, _type, { start, limit }) => rows.slice(start, start + limit));
    const active = createDemosHistoryPageFetcher(client, OWNER);
    const independent = createDemosHistoryPageFetcher(client, OWNER);
    const first = await active(null, 1);
    await independent(null, 1);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(scanAnchorPage(active, first.nextCursor, { limit: 1 })).resolves.toMatchObject({
        status: "indeterminate",
        code: "metadata-conflict",
        cursor: first.nextCursor,
      });
    }
  });

  test("failed, updated, foreign-owner, and legacy records advance but emit nothing", async () => {
    const client = clientWith(async () => [
      row({ hash: "failed", status: "failed" }),
      row({ hash: "update", operation: "WRITE_STORAGE" }),
      row({ hash: "foreign", owner: OTHER_OWNER, logicalAddress: "dacs1:x:y:v1" }),
      row({ hash: "legacy-without-metadata" }),
    ]);

    const page = await createDemosHistoryPageFetcher(client, OWNER)(null, 4);
    expect(page.entries).toEqual([]);
    expect(page.nextCursor).toMatch(/^dacs-demos-history-v2\./);
  });

  test("non-array RPC failures and malformed rows preserve the scanner cursor", async () => {
    let fail = false;
    const rpcFailure = createDemosHistoryPageFetcher(
      clientWith(async () =>
        fail
          ? { result: 500, response: "node unavailable" }
          : [row({ hash: "tx-cursor", logicalAddress: "dacs1:s:svc:v1" })],
      ),
      OWNER,
    );
    const first = await rpcFailure(null, 1);
    fail = true;
    await expect(scanAnchorPage(rpcFailure, first.nextCursor, { limit: 1 })).resolves.toMatchObject({
      status: "indeterminate",
      cursor: first.nextCursor,
      reason: expect.stringContaining("non-array"),
    });

    const malformed = createDemosHistoryPageFetcher(
      clientWith(async (_owner, _type, options) =>
        options.limit === 1
          ? []
          : [
              row({
                hash: "bad-metadata",
                metadata: { logicalAddress: 42 },
              }),
            ],
      ),
      OWNER,
    );
    await expect(scanAnchorPage(malformed, null, { limit: 2 })).resolves.toMatchObject({
      status: "indeterminate",
      cursor: null,
      reason: expect.stringContaining("invalid logicalAddress metadata"),
    });
  });

  test("a short page with a non-empty lookahead is incomplete, not end-of-history", async () => {
    const client = clientWith(async (_owner, _type, { start, limit }) => {
      if (start === 0 && limit === 3) {
        return [row({ hash: "tx-1", logicalAddress: "dacs1:s:svc:v1" })];
      }
      return [
        row({
          hash: "tx-hidden",
          nativeAddress: NATIVE_2,
          logicalAddress: "dacs1:s:svc:v2",
        }),
      ];
    });
    const fetchPage = createDemosHistoryPageFetcher(client, OWNER);
    await expect(scanAnchorPage(fetchPage, null, { limit: 3 })).resolves.toMatchObject({
      status: "indeterminate",
      cursor: null,
      reason: expect.stringContaining("incomplete page"),
    });
  });

  test("owner-bound cursors reject reuse and changed history fails closed", async () => {
    let changed = false;
    const client = clientWith(async (_owner, _type, { start, limit }) => {
      if (start === 0 && limit === 1 && !changed) {
        return [row({ hash: "tx-boundary", logicalAddress: "dacs1:s:svc:v1" })];
      }
      if (start === 0 && limit === 1 && changed) {
        return [row({ hash: "tx-prepended", logicalAddress: "dacs1:s:new:v1" })];
      }
      return [];
    });
    const fetchPage = createDemosHistoryPageFetcher(client, OWNER);
    const first = await fetchPage(null, 1);
    expect(first.nextCursor).not.toBeNull();

    const foreign = createDemosHistoryPageFetcher(client, OTHER_OWNER);
    await expect(foreign(first.nextCursor, 1)).rejects.toThrow(/different owner/);

    changed = true;
    await expect(fetchPage(first.nextCursor, 1)).rejects.toBeInstanceOf(AnchorHistoryRestartRequiredError);
    await expect(scanAnchorPage(fetchPage, first.nextCursor, { limit: 1 })).resolves.toMatchObject({
      status: "indeterminate",
      code: "history-restart-required",
      cursor: first.nextCursor,
      reason: expect.stringContaining("boundary is missing, duplicated or outside the overlap window"),
    });
  });

  test("a boundary hash moved to an older timestamp cannot authorize continuation", async () => {
    let rows = [
      row({ hash: "tx-head", timestamp: 9 }),
      row({ hash: "tx-boundary", timestamp: 5 }),
      row({ hash: "tx-older", timestamp: 1 }),
    ];
    const fetchPage = createDemosHistoryPageFetcher(
      clientWith(async (_owner, _type, { start, limit }) => rows.slice(start, start + limit)),
      OWNER,
    );
    const first = await fetchPage(null, 2);
    expect(first.nextCursor).not.toBeNull();
    rows = [
      rows[0]!,
      row({ hash: "tx-replacement", timestamp: 5 }),
      row({ hash: "tx-boundary", timestamp: 1 }),
    ];
    expect(await scanAnchorPage(fetchPage, first.nextCursor, { limit: 2 })).toMatchObject({
      status: "indeterminate", code: "history-restart-required", cursor: first.nextCursor,
    });
  });

  test("an older row reusing an emitted hash still exposes conflicting metadata", async () => {
    const rows = [
      row({ hash: "tx-head", timestamp: 9, nativeAddress: NATIVE_2 }),
      row({ hash: "tx-reused", timestamp: 5, logicalAddress: "dacs1:s:svc:v1" }),
      row({ hash: "tx-reused", timestamp: 1, logicalAddress: "dacs1:s:other:v1" }),
    ];
    const fetchPage = createDemosHistoryPageFetcher(
      clientWith(async (_owner, _type, { start, limit }) => rows.slice(start, start + limit)),
      OWNER,
    );
    const first = await fetchPage(null, 2);
    expect(first.nextCursor).not.toBeNull();
    expect(await scanAnchorPage(fetchPage, first.nextCursor, { limit: 2 })).toEqual({
      status: "indeterminate", code: "metadata-conflict", cursor: first.nextCursor,
      reason: `page fetch failed: Demos history assigns conflicting logical metadata to ${NATIVE_1}`,
    });
  });

  const v2 = (payload: Record<string, unknown>) =>
    `dacs-demos-history-v2.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  const valid = { v: 2, owner: OWNER, offset: 2, boundaryTimestamp: "5", boundaryTxHashes: ["tx-a", "tx-b"] };
  test.each([
    ["no prefix", ""],
    // A v1 cursor persisted by an earlier release names a single boundary row.
    ["an earlier version's cursor", `dacs-demos-history-v1.${Buffer.from(JSON.stringify({
      v: 1, owner: OWNER, offset: 1, boundaryTxHash: "tx-boundary",
    })).toString("base64url")}`],
    ["an undecodable encoding", "dacs-demos-history-v2.!!!"],
    ["an incomplete payload", v2({ v: 2 })],
    ["a null payload", `dacs-demos-history-v2.${Buffer.from("null").toString("base64url")}`],
    ["an array payload", `dacs-demos-history-v2.${Buffer.from("[2]").toString("base64url")}`],
    ["a non-array boundary list", v2({ ...valid, boundaryTxHashes: { 0: "tx-a", length: 1 } })],
    ["another version number", v2({ ...valid, v: 1 })],
    ["another owner's cursor", v2({ ...valid, owner: OTHER_OWNER })],
    ["a non-decimal timestamp", v2({ ...valid, boundaryTimestamp: "05" })],
    ["a numeric timestamp", v2({ ...valid, boundaryTimestamp: 5 })],
    ["no boundary rows", v2({ ...valid, boundaryTxHashes: [] })],
    ["a duplicated boundary row", v2({ ...valid, boundaryTxHashes: ["tx-a", "tx-a"] })],
    ["a blank boundary row", v2({ ...valid, boundaryTxHashes: ["tx-a", " "] })],
    ["a non-string boundary row", v2({ ...valid, boundaryTxHashes: ["tx-a", 7] })],
    ["more boundary rows than a window", v2({
      ...valid, offset: 101, boundaryTxHashes: Array.from({ length: 101 }, (_, n) => `tx-${n}`),
    })],
    ["an offset before its boundary rows", v2({ ...valid, offset: 1 })],
    ["a fractional offset", v2({ ...valid, offset: 2.5 })],
  ])("a cursor with %s requires a restart from null without a node call", async (_name, cursor) => {
    const client = clientWith(async () => []);
    const fetchPage = createDemosHistoryPageFetcher(client, OWNER);
    await expect(fetchPage(cursor, 1)).rejects.toBeInstanceOf(AnchorHistoryRestartRequiredError);
    await expect(scanAnchorPage(fetchPage, cursor, { limit: 1 })).resolves.toMatchObject({
      status: "indeterminate", code: "history-restart-required", cursor,
    });
    expect(client.getTransactionHistory).not.toHaveBeenCalled();
  });

  test("normal newest-first prepends do not invalidate a continuation", async () => {
    const original = [
      row({ hash: "tx-a", logicalAddress: "dacs1:s:a:v1" }),
      row({
        hash: "tx-b",
        nativeAddress: NATIVE_2,
        logicalAddress: "dacs1:s:b:v1",
      }),
      row({
        hash: "tx-c",
        nativeAddress: NATIVE_3,
        logicalAddress: "dacs1:s:c:v1",
      }),
    ];
    let active = original;
    const client = clientWith(async (_owner, _type, { start, limit }) =>
      active.slice(start, start + limit),
    );
    const fetchPage = createDemosHistoryPageFetcher(client, OWNER);
    const first = await fetchPage(null, 2);

    active = [
      row({
        hash: "tx-new-head",
        nativeAddress: `stor-${"4".repeat(40)}`,
        logicalAddress: "dacs1:s:new:v1",
        timestamp: 1_900_000_000_000,
      }),
      ...original,
    ];
    await expect(fetchPage(first.nextCursor, 2)).resolves.toMatchObject({
      entries: [
        {
          nativeAddress: NATIVE_3,
          logicalAddress: "dacs1:s:c:v1",
        },
      ],
      nextCursor: null,
    });
  });

  test("canonicalizes bare Demos owners before querying and matching rows", async () => {
    const client = clientWith(async (_owner, _type, options) =>
      options.limit === 1
        ? []
        : [row({ hash: "tx-owner", logicalAddress: "dacs1:s:svc:v1" })],
    );
    const page = await createDemosHistoryPageFetcher(
      client,
      OWNER.slice(2).toUpperCase(),
    )(null, 2);
    expect(page.entries).toHaveLength(1);
    expect(client.getTransactionHistory).toHaveBeenNthCalledWith(
      1,
      OWNER,
      "storageProgram",
      { start: 0, limit: 2 },
    );
  });

  test("conflicting logical metadata for one native address fails across pages", async () => {
    const rows = [
      row({
        hash: "tx-first",
        nativeAddress: NATIVE_1,
        logicalAddress: "dacs1:s:svc:v1",
      }),
      row({
        hash: "tx-conflict",
        nativeAddress: NATIVE_1,
        logicalAddress: "dacs1:s:other:v1",
      }),
    ];
    const client = clientWith(async (_owner, _type, { start, limit }) =>
      rows.slice(start, start + limit),
    );
    const fetchPage = createDemosHistoryPageFetcher(client, OWNER);
    const first = await fetchPage(null, 1);
    await expect(fetchPage(first.nextCursor, 1)).rejects.toThrow(
      /conflicting logical metadata/,
    );
  });

  test("conflicting logical metadata is coded metadata-conflict, which no retry clears", async () => {
    const rows = [
      row({ hash: "tx-first", nativeAddress: NATIVE_1, logicalAddress: "dacs1:s:svc:v1" }),
      row({ hash: "tx-conflict", nativeAddress: NATIVE_1, logicalAddress: "dacs1:s:other:v1" }),
    ];
    const fetchPage = createDemosHistoryPageFetcher(
      clientWith(async (_owner, _type, { start, limit }) => rows.slice(start, start + limit)),
      OWNER,
    );
    const first = await fetchPage(null, 1);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(scanAnchorPage(fetchPage, first.nextCursor, { limit: 1 })).resolves.toEqual({
        status: "indeterminate",
        code: "metadata-conflict",
        reason: `page fetch failed: Demos history assigns conflicting logical metadata to ${NATIVE_1}`,
        cursor: first.nextCursor,
      });
    }

    const inOneRow = createDemosHistoryPageFetcher(
      clientWith(async () => [row({
        hash: "tx-conflict",
        metadata: { logicalAddress: "dacs1:s:svc:v1", logical_address: "dacs1:s:svc:v2" },
      })]),
      OWNER,
    );
    await expect(scanAnchorPage(inOneRow, null, { limit: 1 })).resolves.toEqual({
      status: "indeterminate",
      code: "metadata-conflict",
      reason: "page fetch failed: Demos history row 0 has conflicting logical metadata",
      cursor: null,
    });

    // Only the fetcher's own error is coded: the same message from elsewhere stays retryable.
    const lookalike = await scanAnchorPage(async () => {
      throw new Error(`Demos history assigns conflicting logical metadata to ${NATIVE_1}`);
    }, null);
    expect(lookalike).toEqual({
      status: "indeterminate",
      reason: `page fetch failed: Demos history assigns conflicting logical metadata to ${NATIVE_1}`,
      cursor: null,
    });
  });

  test("an exact-full terminal page completes via one explicit empty page", async () => {
    const rows = [row({ hash: "tx-only", logicalAddress: "dacs1:s:svc:v1" })];
    const client = clientWith(async (_owner, _type, { start, limit }) =>
      rows.slice(start, start + limit),
    );
    const fetchPage = createDemosHistoryPageFetcher(client, OWNER);
    const first = await fetchPage(null, 1);
    const second = await fetchPage(first.nextCursor, 1);
    expect(second).toEqual({ entries: [], nextCursor: null });
  });

  test("rejects invalid limits, conflicting metadata, and native-address mismatch", async () => {
    const client = clientWith(async () => []);
    const fetchPage = createDemosHistoryPageFetcher(client, OWNER);
    await expect(fetchPage(null, 0)).rejects.toThrow(/integer from 1 to 100/);
    await expect(fetchPage(null, 101)).rejects.toThrow(/integer from 1 to 100/);
    await expect(fetchPage(null, 1.5)).rejects.toThrow(/integer from 1 to 100/);

    const conflict = createDemosHistoryPageFetcher(
      clientWith(async () => [
        row({
          hash: "tx-conflict",
          metadata: {
            logicalAddress: "dacs1:s:svc:v1",
            logical_address: "dacs1:s:svc:v2",
          },
        }),
      ]),
      OWNER,
    );
    await expect(conflict(null, 1)).rejects.toThrow(/conflicting logical metadata/);

    const mismatch = createDemosHistoryPageFetcher(
      clientWith(async () => [
        row({
          hash: "tx-mismatch",
          logicalAddress: "dacs1:s:svc:v1",
          to: NATIVE_2,
        }),
      ]),
      OWNER,
    );
    await expect(mismatch(null, 1)).rejects.toThrow(/inconsistent storage metadata/);
  });
});
