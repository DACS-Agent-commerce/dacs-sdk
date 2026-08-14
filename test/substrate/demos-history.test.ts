import { describe, expect, test, vi } from "vitest";

import {
  createDemosHistoryPageFetcher,
  type DemosHistoryClient,
} from "../../src/substrate/index.js";
import {
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
}

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

  test("uses an opaque offset cursor and verifies the previous raw boundary", async () => {
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
    expect(first.nextCursor).toMatch(/^dacs-demos-history-v1\./);

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
    expect(client.getTransactionHistory).toHaveBeenNthCalledWith(
      2,
      OWNER,
      "storageProgram",
      { start: 1, limit: 100 },
    );
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
    expect(page.nextCursor).toMatch(/^dacs-demos-history-v1\./);
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
    await expect(scanAnchorPage(fetchPage, first.nextCursor, { limit: 1 })).resolves.toMatchObject({
      status: "indeterminate",
      cursor: first.nextCursor,
      reason: expect.stringContaining("boundary is missing or duplicated"),
    });
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
