import {
  AnchorHistoryRestartRequiredError,
  historyMetadataConflictError,
  type AnchorHistoryPageFetcher,
  type RawAnchorEntry,
} from "../discovery/scanner.js";

const CURSOR_PREFIX = "dacs-demos-history-v2.";
export const DEMOS_HISTORY_MAX_PAGE_SIZE = 100;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const NATIVE_ADDRESS = /^stor-[0-9a-f]{40}$/;
const DEMOS_OWNER = /^(?:0x)?[0-9a-f]{64}$/i;
const STORAGE_OPERATIONS = new Set([
  "CREATE_STORAGE_PROGRAM",
  "WRITE_STORAGE",
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

/**
 * The node orders history by transaction timestamp only, so rows that share a
 * timestamp may come back in any order on each query. The cursor therefore names
 * the last emitted timestamp and every row emitted with it, not one row.
 */
interface HistoryCursor {
  v: 2;
  owner: string;
  /** Raw offset of the boundary group's start plus its emitted rows. */
  offset: number;
  /** Timestamp of the last emitted row, as a decimal string. */
  boundaryTimestamp: string;
  /** Every row emitted so far with the boundary timestamp. */
  boundaryTxHashes: string[];
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

/** A cursor that cannot be decoded for this owner never resumes; restart from null. */
function decodeCursor(value: string, owner: string): HistoryCursor {
  if (!value.startsWith(CURSOR_PREFIX)) {
    throw new AnchorHistoryRestartRequiredError("invalid Demos history cursor prefix");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(value.slice(CURSOR_PREFIX.length), "base64url").toString(
        "utf8",
      ),
    ) as unknown;
  } catch {
    throw new AnchorHistoryRestartRequiredError("invalid Demos history cursor encoding");
  }
  const hashes = isRecord(decoded) ? decoded.boundaryTxHashes : undefined;
  if (
    !isRecord(decoded) ||
    decoded.v !== 2 ||
    typeof decoded.owner !== "string" ||
    !Number.isSafeInteger(decoded.offset) ||
    typeof decoded.boundaryTimestamp !== "string" ||
    !DECIMAL.test(decoded.boundaryTimestamp) ||
    !Array.isArray(hashes) ||
    hashes.length === 0 ||
    hashes.length > DEMOS_HISTORY_MAX_PAGE_SIZE ||
    (decoded.offset as number) < hashes.length ||
    hashes.some((hash) => typeof hash !== "string" || hash.trim().length === 0) ||
    new Set(hashes).size !== hashes.length
  ) {
    throw new AnchorHistoryRestartRequiredError("invalid Demos history cursor payload");
  }
  if (decoded.owner !== normalizedOwner(owner)) {
    throw new AnchorHistoryRestartRequiredError("Demos history cursor belongs to a different owner");
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

/** The node's ordering key; Postgres may return its bigint as a decimal string. */
function transactionTimestamp(value: unknown, index: number): bigint {
  const timestamp = isRecord(value) && isRecord(value.content) ? value.content.timestamp : undefined;
  if (Number.isSafeInteger(timestamp) && (timestamp as number) >= 0) return BigInt(timestamp as number);
  if (typeof timestamp === "string" && DECIMAL.test(timestamp)) return BigInt(timestamp);
  throw new Error(`Demos history row ${index} has no transaction timestamp`);
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
    throw historyMetadataConflictError(`Demos history row ${index} has conflicting logical metadata`);
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
 * The node pages history by offset, ordered by transaction timestamp alone, so
 * rows that share a timestamp can change places between queries. The cursor is
 * owner-bound and names the last emitted timestamp and every row emitted with
 * it. A continuation re-reads a bounded window that starts just before that
 * timestamp group, emits the group's rows not yet emitted, then older rows. A
 * group whose emitted rows are missing or duplicated, that does not fit in the
 * window, or a cursor that cannot be decoded for this owner, fails closed with
 * {@link AnchorHistoryRestartRequiredError}; the caller must restart from a null
 * cursor against a fresh snapshot. Rows prepended at the head after a traversal
 * starts, and rows confirmed later with a timestamp newer than the cursor's
 * group, are behind the cursor: only a new traversal sees them.
 *
 * Conflicting logical metadata for one native address is remembered from the
 * first page (null cursor) of a traversal, so a new traversal starts clean.
 * Use a separate fetcher instance for each concurrent traversal: a null-cursor
 * call resets this instance's metadata memory. Callers sharing an instance must
 * retain their own traversal-specific logical metadata in the scanner.
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
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > DEMOS_HISTORY_MAX_PAGE_SIZE
    ) {
      throw new Error(
        `Demos history limit must be an integer from 1 to ${DEMOS_HISTORY_MAX_PAGE_SIZE}`,
      );
    }

    const cursor =
      cursorValue === null ? null : decodeCursor(cursorValue, owner);
    // A null cursor begins a traversal; earlier traversals' metadata is not kept.
    if (cursor === null) logicalByNativeAddress.clear();
    // Fetch the overlap and new rows in ONE node call. Splitting the boundary
    // check and page fetch would permit a history change between calls to skip
    // a row. The window starts one row before the boundary group, so the row
    // at its head shows that the whole group is inside it.
    const windowStart = cursor === null
      ? 0
      : Math.max(0, cursor.offset - cursor.boundaryTxHashes.length - 1);
    const requested = cursor === null ? limit : DEMOS_HISTORY_MAX_PAGE_SIZE;
    const window = await fetchRows(client, owner, windowStart, requested);
    const hashes = window.map((row, index) => transactionHash(row, windowStart + index));
    const timestamps = window.map((row, index) => transactionTimestamp(row, windowStart + index));
    for (let index = 1; index < timestamps.length; index++) {
      if (timestamps[index]! > timestamps[index - 1]!) {
        throw new Error("Demos transaction-history RPC returned rows out of timestamp order");
      }
    }
    const windowWasShort = window.length < requested;

    let candidates: number[];
    if (cursor === null) {
      candidates = window.map((_row, index) => index);
    } else {
      const boundary = BigInt(cursor.boundaryTimestamp);
      let groupStart = timestamps.findIndex((timestamp) => timestamp <= boundary);
      if (groupStart === -1) groupStart = window.length;
      let groupEnd = groupStart;
      while (groupEnd < window.length && timestamps[groupEnd] === boundary) groupEnd++;
      const group = hashes.slice(groupStart, groupEnd);
      if (
        (groupStart === 0 && windowStart > 0) ||
        (groupEnd === window.length && !windowWasShort) ||
        new Set(group).size !== group.length ||
        cursor.boundaryTxHashes.some((hash) => !group.includes(hash))
      ) {
        throw new AnchorHistoryRestartRequiredError(
          "Demos transaction history boundary is missing, duplicated or outside the overlap window; restart from null",
        );
      }
      const emitted = new Set(cursor.boundaryTxHashes);
      candidates = [];
      for (let index = groupStart; index < window.length; index++) {
        if (index >= groupEnd || !emitted.has(hashes[index]!)) candidates.push(index);
      }
    }
    const taken = candidates.slice(0, limit);
    const bufferedRowsRemain = candidates.length > taken.length;

    const entries: RawAnchorEntry[] = [];
    for (const index of taken) {
      const entry = parseHistoryEntry(window[index], windowStart + index, owner);
      if (!entry?.logicalAddress) continue;
      const previous = logicalByNativeAddress.get(entry.nativeAddress);
      if (previous !== undefined && previous !== entry.logicalAddress) {
        // Remembered for the traversal, so no retry of its cursors clears it.
        throw historyMetadataConflictError(
          `Demos history assigns conflicting logical metadata to ${entry.nativeAddress}`,
        );
      }
      logicalByNativeAddress.set(entry.nativeAddress, entry.logicalAddress);
      entries.push(entry);
    }

    if (windowWasShort && !bufferedRowsRemain) {
      // The node has no total/count marker. Probe the next raw offset so a short,
      // incomplete page is not silently mistaken for the end of history.
      const lookahead = await fetchRows(client, owner, windowStart + window.length, 1);
      if (lookahead.length !== 0) {
        throw new Error("Demos transaction-history RPC returned an incomplete page");
      }
      return { entries, nextCursor: null };
    }

    // A full window always yields a row: a group reaching its end restarts above.
    const last = taken[taken.length - 1]!;
    const lastTimestamp = timestamps[last]!;
    const carried = cursor !== null && lastTimestamp === BigInt(cursor.boundaryTimestamp)
      ? cursor.boundaryTxHashes
      : [];
    const boundaryTxHashes = [
      ...carried,
      ...taken.filter((index) => timestamps[index] === lastTimestamp).map((index) => hashes[index]!),
    ];
    return {
      entries,
      nextCursor: encodeCursor({
        v: 2,
        owner,
        offset: windowStart + timestamps.indexOf(lastTimestamp) + boundaryTxHashes.length,
        boundaryTimestamp: lastTimestamp.toString(),
        boundaryTxHashes,
      }),
    };
  };
}
