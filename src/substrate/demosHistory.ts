import type {
  AnchorHistoryPageFetcher,
  RawAnchorEntry,
} from "../discovery/scanner.js";

const CURSOR_PREFIX = "dacs-demos-history-v1.";
const MAX_PAGE_SIZE = 100;
const NATIVE_ADDRESS = /^stor-[0-9a-f]{40}$/;
const DEMOS_OWNER = /^(?:0x)?[0-9a-f]{64}$/i;
const STORAGE_OPERATIONS = new Set([
  "CREATE_STORAGE_PROGRAM",
  "WRITE_STORAGE",
  "READ_STORAGE",
  "UPDATE_ACCESS_CONTROL",
  "DELETE_STORAGE_PROGRAM",
  "SET_FIELD",
  "SET_ITEM",
  "APPEND_ITEM",
  "DELETE_FIELD",
  "DELETE_ITEM",
]);

/** Narrow demosdk seam used by the history adapter. Its result is untrusted. */
export interface DemosHistoryClient {
  getTransactionHistory(
    address: string,
    type: "storageProgram",
    options: { start: number; limit: number },
  ): Promise<unknown>;
}

interface HistoryCursor {
  v: 1;
  owner: string;
  offset: number;
  boundaryTxHash: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedOwner(owner: string): string {
  const normalized = owner.trim().toLowerCase();
  if (!DEMOS_OWNER.test(normalized)) {
    throw new Error("Demos history owner must be a 32-byte hex address");
  }
  return normalized.startsWith("0x") ? normalized : `0x${normalized}`;
}

function encodeCursor(cursor: HistoryCursor): string {
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")}`;
}

function decodeCursor(value: string, owner: string): HistoryCursor {
  if (!value.startsWith(CURSOR_PREFIX)) {
    throw new Error("invalid Demos history cursor prefix");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(value.slice(CURSOR_PREFIX.length), "base64url").toString(
        "utf8",
      ),
    ) as unknown;
  } catch {
    throw new Error("invalid Demos history cursor encoding");
  }
  if (
    !isRecord(decoded) ||
    decoded.v !== 1 ||
    typeof decoded.owner !== "string" ||
    !Number.isSafeInteger(decoded.offset) ||
    (decoded.offset as number) <= 0 ||
    typeof decoded.boundaryTxHash !== "string" ||
    decoded.boundaryTxHash.trim().length === 0
  ) {
    throw new Error("invalid Demos history cursor payload");
  }
  if (decoded.owner !== normalizedOwner(owner)) {
    throw new Error("Demos history cursor belongs to a different owner");
  }
  return decoded as unknown as HistoryCursor;
}

function transactionHash(value: unknown, index: number): string {
  if (
    !isRecord(value) ||
    typeof value.hash !== "string" ||
    value.hash.trim().length === 0
  ) {
    throw new Error(`Demos history row ${index} has no transaction hash`);
  }
  return value.hash;
}

function logicalAddressFromMetadata(
  metadata: Record<string, unknown>,
  index: number,
): string | undefined {
  const camel = metadata.logicalAddress;
  const snake = metadata.logical_address;
  if (camel === undefined && snake === undefined) return undefined;
  if (
    camel !== undefined &&
    (typeof camel !== "string" || camel.trim().length === 0)
  ) {
    throw new Error(`Demos history row ${index} has invalid logicalAddress metadata`);
  }
  if (
    snake !== undefined &&
    (typeof snake !== "string" || snake.trim().length === 0)
  ) {
    throw new Error(`Demos history row ${index} has invalid logical_address metadata`);
  }
  if (camel !== undefined && snake !== undefined && camel !== snake) {
    throw new Error(`Demos history row ${index} has conflicting logical metadata`);
  }
  return (camel ?? snake) as string;
}

function parseHistoryEntry(
  value: unknown,
  index: number,
  expectedOwner: string,
): RawAnchorEntry | null {
  transactionHash(value, index);
  if (!isRecord(value) || typeof value.status !== "string") {
    throw new Error(`Demos history row ${index} has no transaction status`);
  }
  if (value.status === "failed") return null;
  if (value.status !== "confirmed") {
    throw new Error(`Demos history row ${index} has unsupported status ${value.status}`);
  }
  if (!Number.isSafeInteger(value.blockNumber) || (value.blockNumber as number) < 0) {
    throw new Error(`Demos history row ${index} is not block-confirmed`);
  }

  const content = value.content;
  if (
    !isRecord(content) ||
    content.type !== "storageProgram" ||
    typeof content.from !== "string" ||
    content.from.trim().length === 0
  ) {
    throw new Error(`Demos history row ${index} has malformed storage content`);
  }
  if (normalizedOwner(content.from) !== normalizedOwner(expectedOwner)) {
    return null;
  }
  if (
    typeof content.to !== "string" ||
    !Array.isArray(content.data) ||
    content.data.length !== 2 ||
    content.data[0] !== "storageProgram" ||
    !isRecord(content.data[1])
  ) {
    throw new Error(`Demos history row ${index} has malformed storage payload`);
  }

  const payload = content.data[1];
  if (
    typeof payload.operation !== "string" ||
    !STORAGE_OPERATIONS.has(payload.operation) ||
    typeof payload.storageAddress !== "string" ||
    !NATIVE_ADDRESS.test(payload.storageAddress) ||
    content.to !== payload.storageAddress
  ) {
    throw new Error(`Demos history row ${index} has inconsistent storage metadata`);
  }
  if (payload.operation !== "CREATE_STORAGE_PROGRAM") return null;
  if (payload.metadata === undefined || payload.metadata === null) return null;
  if (!isRecord(payload.metadata)) {
    throw new Error(`Demos history row ${index} has malformed record metadata`);
  }

  const logicalAddress = logicalAddressFromMetadata(payload.metadata, index);
  if (logicalAddress === undefined) return null;
  return {
    nativeAddress: payload.storageAddress,
    logicalAddress,
    owner: content.from,
  };
}

async function fetchRows(
  client: DemosHistoryClient,
  owner: string,
  start: number,
  limit: number,
): Promise<unknown[]> {
  const result: unknown = await client.getTransactionHistory(
    owner,
    "storageProgram",
    { start, limit },
  );
  if (!Array.isArray(result)) {
    throw new Error("Demos transaction-history RPC returned a non-array response");
  }
  if (result.length > limit) {
    throw new Error("Demos transaction-history RPC exceeded the requested page size");
  }
  return result;
}

/**
 * Bind Demos address-history paging to the substrate-neutral discovery scanner.
 *
 * The cursor is owner-bound and locates the previous raw transaction in a
 * bounded overlap window before advancing. This tolerates normal prepends to
 * Demos' newest-first, confirmed history. A missing/duplicated boundary fails
 * closed; the caller can restart from a null cursor against a fresh snapshot.
 *
 * Only confirmed CREATE_STORAGE_PROGRAM transactions carrying explicit logical
 * metadata are candidates. Program names are deliberately ignored: DACS makes
 * them opaque write inputs, not consumer resolution keys.
 */
export function createDemosHistoryPageFetcher(
  client: DemosHistoryClient,
  expectedOwner: string,
): AnchorHistoryPageFetcher {
  const owner = normalizedOwner(expectedOwner);
  const logicalByNativeAddress = new Map<string, string>();

  return async (cursorValue, limit) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new Error(`Demos history limit must be an integer from 1 to ${MAX_PAGE_SIZE}`);
    }

    const cursor =
      cursorValue === null ? null : decodeCursor(cursorValue, owner);
    const start = cursor?.offset ?? 0;
    let rows: unknown[];
    let rowsStart: number;
    let pageWasShort: boolean;
    let pageEndOffset: number;
    let bufferedRowsRemain = false;
    if (cursor === null) {
      rows = await fetchRows(client, owner, 0, limit);
      rowsStart = 0;
      pageWasShort = rows.length < limit;
      pageEndOffset = rows.length;
    } else {
      // Fetch the overlap and new rows in ONE node call. Splitting the boundary
      // check and page fetch would permit a history change between calls to skip
      // a row. Searching the bounded window also tolerates normal head prepends.
      const pageStart = start - 1;
      const overlapAndRows = await fetchRows(
        client,
        owner,
        pageStart,
        MAX_PAGE_SIZE,
      );
      const boundaryIndexes = overlapAndRows.flatMap((row, index) =>
        transactionHash(row, pageStart + index) === cursor.boundaryTxHash
          ? [index]
          : [],
      );
      if (boundaryIndexes.length !== 1) {
        throw new Error(
          "Demos transaction history boundary is missing or duplicated; restart from null",
        );
      }
      const boundaryIndex = boundaryIndexes[0]!;
      const afterBoundary = overlapAndRows.slice(boundaryIndex + 1);
      rows = afterBoundary.slice(0, limit);
      rowsStart = pageStart + boundaryIndex + 1;
      bufferedRowsRemain = afterBoundary.length > rows.length;
      pageWasShort = overlapAndRows.length < MAX_PAGE_SIZE;
      pageEndOffset = pageStart + overlapAndRows.length;
    }

    const entries: RawAnchorEntry[] = [];
    for (const [index, row] of rows.entries()) {
      const entry = parseHistoryEntry(row, rowsStart + index, owner);
      if (!entry?.logicalAddress) continue;
      const previous = logicalByNativeAddress.get(entry.nativeAddress);
      if (previous !== undefined && previous !== entry.logicalAddress) {
        throw new Error(
          `Demos history assigns conflicting logical metadata to ${entry.nativeAddress}`,
        );
      }
      logicalByNativeAddress.set(entry.nativeAddress, entry.logicalAddress);
      entries.push(entry);
    }

    if (pageWasShort && !bufferedRowsRemain) {
      // The node has no total/count marker. Probe the next raw offset so a short,
      // incomplete page is not silently mistaken for the end of history.
      const lookahead = await fetchRows(client, owner, pageEndOffset, 1);
      if (lookahead.length !== 0) {
        throw new Error("Demos transaction-history RPC returned an incomplete page");
      }
      return { entries, nextCursor: null };
    }

    const boundaryTxHash =
      rows.length === 0
        ? cursor!.boundaryTxHash
        : transactionHash(
            rows[rows.length - 1],
            rowsStart + rows.length - 1,
          );
    return {
      entries,
      nextCursor: encodeCursor({
        v: 1,
        owner: normalizedOwner(owner),
        offset: rowsStart + rows.length,
        boundaryTxHash,
      }),
    };
  };
}
