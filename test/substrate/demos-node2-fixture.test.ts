import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";

import { classifyAnchor } from "../../src/discovery/index.js";
import {
  createDemosHistoryPageFetcher,
  createInMemoryDemosWriteJournal,
  DemosAdapter,
  type DemosHistoryClient,
} from "../../src/substrate/index.js";

afterEach(() => vi.unstubAllGlobals());

type Row = Record<string, any>;

// Recorded responses captured on `capturedAt`; see the fixture's notes.
const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/demos-node2-history.json", import.meta.url), "utf8"),
) as {
  owner: string;
  historyRows: Row[];
  missingStorageProgram: { status: number; body: Record<string, unknown> };
};
const MISSING = "stor-0000000000000000000000000000000000000000";

function clientOver(rows: Row[]): DemosHistoryClient {
  return {
    getTransactionHistory: vi.fn(async (_owner, _type, { start, limit }) =>
      structuredClone(rows.slice(start, start + limit))),
  };
}

async function drain(rows: Row[], limit: number) {
  const fetchPage = createDemosHistoryPageFetcher(clientOver(rows), fixture.owner);
  const entries = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await fetchPage(cursor, limit);
    entries.push(...page.entries);
    cursor = page.nextCursor;
    pages++;
  } while (cursor !== null && pages < 20);
  return { entries, cursor, pages };
}

describe("the Demos history fetcher against recorded node2 responses", () => {
  // The last row is a real DACS settlement-evidence CREATE.
  const REAL_DACS = {
    nativeAddress: "stor-0c8a191536d3908a8816c2312bdb4cfcd316e513",
    logicalAddress: "dacs4:payment:01M0JS1ZPVGE2HJ3N83DVTPV8P:x402%3Abase-sepolia:2",
    owner: fixture.owner,
  };

  test("the fixture has confirmed and failed rows with decimal-string timestamps", () => {
    expect(fixture.historyRows.map((row) => row.status))
      .toEqual(["confirmed", "confirmed", "failed", "failed", "confirmed"]);
    for (const row of fixture.historyRows) expect(row.content.timestamp).toMatch(/^[1-9][0-9]*$/);
    expect(fixture.historyRows[0]!.content.transaction_fee).toHaveProperty("rpc_address");
  });

  test.each([1, 2, 3, 100])("pages every row at limit %i and emits only the real DACS CREATE row", async (limit) => {
    const { entries, cursor } = await drain(fixture.historyRows, limit);
    expect(cursor).toBeNull();
    expect(entries).toEqual([REAL_DACS]);
    expect(classifyAnchor(REAL_DACS.logicalAddress)).toBe("settlement-evidence");
  });

  test.each([1, 2, 100])("a non-DACS CREATE row given DACS metadata is emitted once at limit %i", async (limit) => {
    const rows = structuredClone(fixture.historyRows);
    const payload = rows.find((row) => row.content.data[1].operation === "CREATE_STORAGE_PROGRAM")!.content.data[1];
    payload.metadata = { ...payload.metadata, logicalAddress: "dacs3:commit:01J8ME0SXKQ4T9V2RC5HJ6WX7D" };
    const { entries, cursor } = await drain(rows, limit);
    expect(cursor).toBeNull();
    expect(entries).toEqual([{
      nativeAddress: payload.storageAddress,
      logicalAddress: "dacs3:commit:01J8ME0SXKQ4T9V2RC5HJ6WX7D",
      owner: fixture.owner,
    }, REAL_DACS]);
  });

  test("the recorded not-found body, returned or thrown as HTTP 404, reads as no record", async () => {
    const adapter = new DemosAdapter({
      rpc: "https://node2-fixture.test",
      chainIdentity: "test-chain",
      writeJournal: createInMemoryDemosWriteJournal(),
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify(fixture.missingStorageProgram.body), { status: 200 },
    )));
    await expect(adapter.readAnchor(MISSING)).resolves.toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify(fixture.missingStorageProgram.body), { status: 404 },
    )));
    await expect(adapter.readAnchor(MISSING)).resolves.toBeNull();
  });
});
