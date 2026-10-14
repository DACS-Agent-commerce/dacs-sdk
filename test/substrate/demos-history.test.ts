import { describe, expect, test, vi } from "vitest";

import {
  createDemosHistoryPageFetcher,
  type DemosHistoryClient,
} from "../../src/substrate/index.js";
import {
  AnchorHistoryRestartRequiredError,
  createDemosHistoryPageFetcher as createDemosHistoryPageFetcherFromRoot,
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

  test("rows out of timestamp order, or without a timestamp, are malformed", async () => {
    const outOfOrder = createDemosHistoryPageFetcher(clientWith(async () => [
      row({ hash: "older", timestamp: 1 }), row({ hash: "newer", timestamp: 2 }),
    ]), OWNER);
    await expect(outOfOrder(null, 2)).rejects.toThrow(/out of timestamp order/);
    for (const timestamp of [-1, 1.5, "01", "x", null]) {
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
