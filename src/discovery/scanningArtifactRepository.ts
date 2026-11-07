import { attestationBundleHash } from "../agent/twoSidedBundle.js";
import type { AnyAttestationBundle } from "../artifacts/types.js";
import type { AnchorBinding, BindingIndex } from "./binding.js";
import {
  artifactBindingHashOf,
  createBoundArtifactRepository,
  type BoundArtifactRepository,
  type BoundArtifactRepositoryDeps,
} from "./boundArtifactRepository.js";
import { normalizedBindingOwner } from "./owner.js";
import {
  classifyAnchor,
  scanAnchorPage,
  type AnchorHistoryPageFetcher,
  type ScannedAnchor,
  type ScanOptions,
} from "./scanner.js";
import { resolveAndRead, type VerifiedRead } from "./verifiedRead.js";

/**
 * Throw from `verifyArtifact` for a kind or version the verifier cannot check.
 * Only an instance of this class is final: an error that merely carries
 * `code: "unsupported-kind"`, such as a forwarded service error body, means
 * verification is unavailable.
 */
export class UnsupportedArtifactKindError extends Error {
  readonly code = "unsupported-kind" as const;

  constructor(message: string) {
    super(message);
    this.name = "UnsupportedArtifactKindError";
  }
}

export interface ScanningArtifactRepositoryDeps extends BoundArtifactRepositoryDeps {
  /** Explicit history seam; the helper never selects an RPC or connects itself. */
  fetchPage: AnchorHistoryPageFetcher;
  /** Expected publisher of the discovered artifacts, independent of the reader. */
  expectedOwner: string;
  /**
   * Must check signed scope, domain, version, signature, authorized signer and
   * expected owner/role/logical slot for this kind. Only literal true passes.
   * Return false only for a completed negative signature or authorization check,
   * which produces `signature-invalid`. Throw `UnsupportedArtifactKindError` for
   * an unsupported kind or version, which produces a final `unverifiable` with
   * `code: "unsupported-kind"`. Any other throw means verification is
   * unavailable and produces a retryable `indeterminate` with
   * `code: "verifier-unavailable"`; the row is not handled. That includes an
   * error that only carries `code: "unsupported-kind"`: the check is
   * `instanceof`, so throw the class exported by this package, from the same
   * installed copy as the repository. A non-function is refused at construction.
   * It is never called for an `unknown` row, which is `unclassified`, or for a
   * `bundle` row, which is a final `unsupported-kind` after its DACS-5 §10.4.1
   * hash check because the generic binding is not a DACS-5 BundleBinding.
   */
  verifyArtifact: (
    record: Record<string, unknown>,
    binding: AnchorBinding,
    anchor: ScannedAnchor,
  ) => Promise<boolean> | boolean;
  /**
   * Consecutive indeterminate attempts on one row before it is deferred and the
   * traversal moves on. Defaults to 5.
   */
  maxRowAttempts?: number;
}

/**
 * Retryable row diagnostics. The row is not handled and does not enter `seen`.
 * `record-not-yet-visible` is a read that found no record at the bound native
 * address: CORE SR-2 makes an ordinary not-found `indeterminate`, and a lagging
 * node reports a history-confirmed anchor that way. So does a deleted program;
 * the repository cannot tell the two apart, so such a row is eventually deferred.
 */
export type ArtifactRowIndeterminateCode =
  | "index-indeterminate"
  | "binding-not-yet-visible"
  | "read-indeterminate"
  | "record-not-yet-visible"
  | "verifier-unavailable";

/**
 * Retry the same state, with backoff: a row diagnostic or an unavailable page.
 * `page-limit-exceeded` and `invalid-limit` are fetcher or caller faults that
 * retrying cannot clear.
 */
export type ArtifactScanIndeterminateCode =
  | ArtifactRowIndeterminateCode
  | "history-unavailable"
  | "page-limit-exceeded"
  | "invalid-limit";

/**
 * Retrying the same state cannot succeed; continue with the returned state,
 * which restarts from a null cursor. `cursor-cycle`, `page-bound` and
 * `history-restart-required` come from a valid state and keep its handled rows;
 * `foreign-owner-state` and `invalid-state` start a fresh traversal.
 */
export type ArtifactScanRestartCode =
  | "cursor-cycle"
  | "page-bound"
  | "foreign-owner-state"
  | "invalid-state"
  | "history-restart-required";

/** A row given up on after repeated indeterminate attempts; never `seen`. */
export interface ArtifactScanDeferredRow {
  anchor: ScannedAnchor;
  code: ArtifactRowIndeterminateCode;
  reason: string;
  /** Consecutive indeterminate attempts when the row was deferred. */
  attempts: number;
}

/** Carry this state between pages of the same owner's traversal. */
export interface ArtifactScanState {
  owner: string;
  cursor: string | null;
  /** Fully handled native addresses and their logical metadata. */
  seen: ReadonlyMap<string, string>;
  /** Observed logical metadata, including filtered rows, for conflict detection. */
  metadata: ReadonlyMap<string, string>;
  /** Non-null cursors of fully consumed pages; transient retries are not consumed. */
  consumedCursors: ReadonlySet<string>;
  /** Fully consumed pages, including the initial null cursor; bounded at 10,000. */
  pagesConsumed: number;
  /** RPC traversal exhaustion only; never completeness or non-revocation proof. */
  exhausted: boolean;
  /** Row the next retry re-reads and its consecutive indeterminate attempts. */
  pendingRow: { nativeAddress: string; attempts: number } | null;
  /**
   * Rows deferred in this traversal, kept across a restart from a valid state;
   * skipped until a new traversal (`scanPage()` without state).
   */
  deferred: readonly ArtifactScanDeferredRow[];
}

/**
 * Row outcome. Existing read diagnostics are preserved, except that a missing
 * binding is `indeterminate` (`binding-not-yet-visible`), as in `write`, and a
 * record that cannot be found is `indeterminate` (`record-not-yet-visible`).
 * `unclassified` is a row whose logical address is not an exact current-profile
 * address, including one with a malformed job ID or a non-canonical CF-4
 * segment; it is neither resolved nor read.
 */
export type ScannedArtifactOutcome =
  | Exclude<VerifiedRead, { status: "unverifiable" | "indeterminate" | "absent" | "unreadable" }>
  | (Extract<VerifiedRead, { status: "unverifiable" }> & { code?: "unsupported-kind" })
  | { status: "indeterminate"; reason: string; code: ArtifactRowIndeterminateCode }
  | { status: "unclassified"; reason: string }
  | { status: "conflict"; reason: string };

/** Known binding disagreements are explicit. */
export interface ScannedArtifactRead {
  anchor: ScannedAnchor;
  outcome: ScannedArtifactOutcome;
}

/**
 * `results` holds the rows read by this call, including the failing row.
 * `deferred` holds the rows deferred by this call; `state.deferred` holds all.
 */
export type ArtifactScanPage =
  | {
      status: "page";
      results: ScannedArtifactRead[];
      deferred: ArtifactScanDeferredRow[];
      state: ArtifactScanState;
    }
  | {
      status: "indeterminate";
      code: ArtifactScanIndeterminateCode;
      reason: string;
      results: ScannedArtifactRead[];
      deferred: ArtifactScanDeferredRow[];
      state: ArtifactScanState;
    }
  | {
      status: "conflict";
      code: "metadata-conflict";
      reason: string;
      results: ScannedArtifactRead[];
      deferred: ArtifactScanDeferredRow[];
      state: ArtifactScanState;
    }
  | {
      status: "restart-required";
      code: ArtifactScanRestartCode;
      reason: string;
      results: ScannedArtifactRead[];
      deferred: ArtifactScanDeferredRow[];
      /**
       * Restarts from a null cursor; the pages are fetched again. After
       * `cursor-cycle`, `page-bound` or `history-restart-required` it keeps
       * `seen`, `metadata`, `deferred` and `pendingRow`: each native address is
       * handled at most once per valid traversal, and a binding rewritten for a
       * handled address is seen only by a new traversal. After `invalid-state`
       * or `foreign-owner-state` nothing is trusted: it is a fresh traversal that
       * reports every row again. A failing row is reported on every retry, so
       * deduplicate final outcomes only, or keep the latest result per
       * `anchor.nativeAddress`.
       */
      state: ArtifactScanState;
    };

export interface ScanningArtifactRepository extends BoundArtifactRepository {
  /**
   * Scan, resolve, read and verify one page. Reuse the returned state. Only
   * fully handled rows enter dedup state. An indeterminate row stops the page at
   * its original cursor, so retry re-fetches that page and re-reads the failing
   * row, skipping the handled prefix. After `maxRowAttempts` consecutive
   * indeterminate attempts the row is deferred and the page continues; start a
   * new traversal (`scanPage()` without state), or read it with `read`, to retry
   * it. Other diagnostics are handled candidates; start a new traversal to
   * revisit repaired bindings or bytes.
   * `restart-required` returns a state that restarts from a null cursor and,
   * unless the old state was invalid or foreign, keeps its handled rows. Input
   * state is never mutated.
   *
   * Classification and RPC exhaustion prove neither completeness nor absence of
   * revocation. Even a verified artifact needs its protocol-specific admission,
   * freshness and revocation checks before use.
   */
  scanPage(
    state?: ArtifactScanState,
    options?: Pick<ScanOptions, "limit" | "includeUnknown">,
  ): Promise<ArtifactScanPage>;
}

const DEFAULT_MAX_ROW_ATTEMPTS = 5;
const MAX_PAGES = 10_000;
const ROW_CODES: ReadonlySet<string> = new Set<ArtifactRowIndeterminateCode>([
  "index-indeterminate",
  "binding-not-yet-visible",
  "read-indeterminate",
  "record-not-yet-visible",
  "verifier-unavailable",
]);

/**
 * DACS-5 §10.4.1 `attestation_bundle_hash`, through the bundle producer's own
 * omission set so the two cannot drift. The scope is not shape-checked here.
 */
function bundleRecordHash(record: Record<string, unknown>): string {
  return attestationBundleHash(record as unknown as AnyAttestationBundle);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/**
 * Only the class is final; a merely coded value stays retryable. `instanceof`
 * can hit a throwing Proxy trap, which also counts as unavailable.
 */
function isUnsupportedKind(e: unknown): boolean {
  try {
    return e instanceof UnsupportedArtifactKindError;
  } catch {
    return false;
  }
}

/**
 * Own persisted collections and rows. Any malformed or throwing value returns
 * undefined; persisted state is never trusted to have the declared shape.
 */
function ownedStringMap(value: unknown): Map<string, string> | undefined {
  const owned = new Map<string, string>();
  for (const entry of value as Iterable<unknown>) {
    if (!Array.isArray(entry) || entry.length !== 2) return undefined;
    const [key, logical] = entry as unknown[];
    if (typeof key !== "string" || typeof logical !== "string") return undefined;
    owned.set(key, logical);
  }
  return owned;
}

function ownedStringSet(value: unknown): Set<string> | undefined {
  const owned = new Set<string>();
  for (const item of value as Iterable<unknown>) {
    if (typeof item !== "string") return undefined;
    owned.add(item);
  }
  return owned;
}

function ownedPendingRow(value: unknown): ArtifactScanState["pendingRow"] | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { nativeAddress, attempts } = value;
  if (!isNonEmptyString(nativeAddress) || !isPositiveInteger(attempts)) return undefined;
  return { nativeAddress, attempts };
}

function ownedDeferred(value: unknown): ArtifactScanDeferredRow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const owned: ArtifactScanDeferredRow[] = [];
  for (const row of value as unknown[]) {
    if (!isRecord(row)) return undefined;
    const { anchor, code, reason, attempts } = row;
    if (!isRecord(anchor)) return undefined;
    const { nativeAddress, logicalAddress, owner } = anchor;
    if (
      !isNonEmptyString(nativeAddress) ||
      !isNonEmptyString(logicalAddress) ||
      (owner !== undefined && !isNonEmptyString(owner)) ||
      typeof code !== "string" ||
      !ROW_CODES.has(code) ||
      typeof reason !== "string" ||
      !isPositiveInteger(attempts)
    ) {
      return undefined;
    }
    owned.push({
      // Reclassify rather than trust a persisted kind.
      anchor: {
        nativeAddress,
        logicalAddress,
        ...(owner === undefined ? {} : { owner }),
        kind: classifyAnchor(logicalAddress),
      },
      code: code as ArtifactRowIndeterminateCode,
      reason,
      attempts,
    });
  }
  return owned;
}

/**
 * Relationships that every state returned by scanPage keeps. A persisted state
 * that breaks one is never resumed: its fields cannot all be true.
 */
function stateContradiction(state: ArtifactScanState): string | undefined {
  const {
    cursor, seen, metadata, consumedCursors, pagesConsumed, exhausted, pendingRow, deferred,
  } = state;
  // Each consumed page after the first adds the cursor it was fetched at.
  if (pagesConsumed === 0) {
    if (cursor !== null) return "scan state has a cursor before consuming a page";
    if (consumedCursors.size > 0) return "scan state has consumed cursors before consuming a page";
    if (exhausted) return "scan state is exhausted before consuming a page";
  } else {
    if (pagesConsumed !== consumedCursors.size + 1) {
      return "scan state page count does not match its consumed cursors";
    }
    if (exhausted !== (cursor === null)) {
      return exhausted
        ? "scan state is exhausted but still has a cursor"
        : "scan state has no cursor after consuming a page but is not exhausted";
    }
  }
  if (exhausted && pendingRow !== null) return "scan state is exhausted but still has a pending row";
  for (const [nativeAddress, logicalAddress] of seen) {
    const observed = metadata.get(nativeAddress);
    if (observed !== undefined && observed !== logicalAddress) {
      return `scan state has disagreeing seen and metadata entries for ${nativeAddress}`;
    }
  }
  const deferredRows = new Set<string>();
  for (const { anchor: { nativeAddress, logicalAddress } } of deferred) {
    if (seen.has(nativeAddress)) return `scan state has ${nativeAddress} both in seen and deferred`;
    if (deferredRows.has(nativeAddress)) return `scan state defers ${nativeAddress} twice`;
    const observed = metadata.get(nativeAddress);
    if (observed !== undefined && observed !== logicalAddress) {
      return `scan state has disagreeing deferred and metadata entries for ${nativeAddress}`;
    }
    deferredRows.add(nativeAddress);
  }
  // A retry must find the failing row's logical address it saw first.
  if (pendingRow !== null && !metadata.has(pendingRow.nativeAddress)) {
    return `scan state has pending row ${pendingRow.nativeAddress} without its logical metadata`;
  }
  if (pendingRow !== null && seen.has(pendingRow.nativeAddress)) {
    return `scan state has pending row ${pendingRow.nativeAddress} already in seen`;
  }
  if (pendingRow !== null && deferredRows.has(pendingRow.nativeAddress)) {
    return `scan state has pending row ${pendingRow.nativeAddress} already deferred`;
  }
  return undefined;
}

/**
 * Compose the bound repository with incremental verified history reads (#54).
 * The adapter, consumer index, authorized publisher, owner, fetcher and verifier
 * are injected. Scanning only reads; publication occurs only through explicit
 * repository.write calls. History and bindings remain untrusted discovery hints.
 * The history-owner check applies only to rows whose fetcher reports `owner`.
 */
export function createScanningArtifactRepository(
  deps: ScanningArtifactRepositoryDeps,
): ScanningArtifactRepository {
  const { adapter, index, fetchPage, verifyArtifact } = deps;
  // A missing verifier is a configuration fault, never a row verdict.
  if (typeof verifyArtifact !== "function") throw new Error("verifyArtifact must be a function");
  const owner = normalizedBindingOwner(deps.expectedOwner);
  if (owner.length === 0) throw new Error("expectedOwner must not be empty");
  const maxRowAttempts = deps.maxRowAttempts ?? DEFAULT_MAX_ROW_ATTEMPTS;
  if (!isPositiveInteger(maxRowAttempts)) {
    throw new Error("maxRowAttempts must be a positive safe integer");
  }

  const freshState = (): ArtifactScanState => ({
    owner,
    cursor: null,
    seen: new Map(),
    metadata: new Map(),
    consumedCursors: new Set(),
    pagesConsumed: 0,
    exhausted: false,
    pendingRow: null,
    deferred: [],
  });
  // From a valid state, only the cursor and page-cycle fields restart, so rows
  // already handled or deferred are not reported again. Without one, nothing
  // can be trusted and the traversal starts over.
  const restart = (
    code: ArtifactScanRestartCode,
    reason: string,
    valid?: ArtifactScanState,
  ): ArtifactScanPage => ({
    status: "restart-required",
    code,
    reason,
    results: [],
    deferred: [],
    state: valid === undefined
      ? freshState()
      : {
          ...freshState(),
          seen: valid.seen,
          metadata: valid.metadata,
          pendingRow: valid.pendingRow,
          deferred: valid.deferred,
        },
  });

  async function readRow(anchor: ScannedAnchor): Promise<ScannedArtifactOutcome> {
    if (
      anchor.owner !== undefined &&
      normalizedBindingOwner(anchor.owner) !== owner
    ) {
      return {
        status: "binding-mismatch",
        reason: "history row owner does not match expectedOwner",
      };
    }
    // CORE JID-3: a malformed address reaches no resolver, and no verifier can
    // be selected for an unknown kind, so neither is consulted.
    if (anchor.kind === "unknown") {
      return {
        status: "unclassified",
        reason: "history row logical address is not an exact current-profile DACS address",
      };
    }
    // The stage reached explains a retryable result; resolveAndRead keeps reasons.
    const row: { code: ArtifactRowIndeterminateCode; unsupported: boolean } = {
      code: "index-indeterminate",
      unsupported: false,
    };
    const rowIndex: BindingIndex = {
      async resolve(logicalAddress, expectedOwner) {
        const resolution = await index.resolve(logicalAddress, expectedOwner);
        // Read the untrusted discriminator once and return owned results,
        // so a later read cannot skip the native-address check below.
        const { status } = resolution;
        if (status === "absent") {
          // write anchors before publishing, so the binding may not be visible yet.
          row.code = "binding-not-yet-visible";
          return {
            status: "indeterminate",
            reason: "history row has no binding visible in the configured index yet",
          };
        }
        if (status === "indeterminate") {
          const { reason, code } = resolution;
          if (typeof reason !== "string") throw new Error("binding index returned an invalid reason");
          return {
            status: "indeterminate",
            reason,
            ...(code === "binding-conflict" ? { code: "binding-conflict" as const } : {}),
          };
        }
        if (status !== "present") throw new Error("binding index returned an unknown status");
        // Own the binding before checking it: the index may return shared
        // data that changes while resolveAndRead awaits this resolution.
        const snapshot: unknown = structuredClone(resolution.binding);
        // Malformed index data is retryable, as in resolveAndRead, not a conflict.
        if (
          typeof snapshot !== "object" ||
          snapshot === null ||
          Array.isArray(snapshot) ||
          typeof (snapshot as Partial<AnchorBinding>).nativeAddress !== "string"
        ) {
          throw new Error("binding index returned a malformed binding");
        }
        const binding = snapshot as AnchorBinding;
        if (
          binding.nativeAddress !== anchor.nativeAddress
        ) {
          return {
            status: "indeterminate",
            code: "binding-conflict",
            reason: "published binding points at a different native address than the history row",
          };
        }
        return { status: "present", binding };
      },
    };
    const read = await resolveAndRead(rowIndex, anchor.logicalAddress, owner, {
      read: (address) => {
        row.code = "read-indeterminate";
        return adapter.readAnchor(address);
      },
      // A bundle binding commits to the DACS-5 §10.4.1 hash, which role copies
      // share; a deliverable binding to its complete payload (DACS-4 DV-1).
      contentHashOf: anchor.kind === "bundle"
        ? bundleRecordHash
        : artifactBindingHashOf(anchor.logicalAddress),
      verifySignature: async (record, binding) => {
        try {
          // DACS-5 BB-4/BB-5 require a BundleBinding, which the generic binding
          // lacks; refuse through the same class as a verifier's.
          if (anchor.kind === "bundle") {
            throw new UnsupportedArtifactKindError("bundle rows need DACS-5 BundleBinding verification");
          }
          return await verifyArtifact(record, binding, { ...anchor });
        } catch (e) {
          if (isUnsupportedKind(e)) row.unsupported = true;
          else row.code = "verifier-unavailable";
          throw e;
        }
      },
    });
    if (read.status === "indeterminate") {
      return read.code === "binding-conflict"
        ? { status: "conflict", reason: read.reason }
        : { status: "indeterminate", reason: read.reason, code: row.code };
    }
    if (read.status === "absent") {
      // Unreachable: the row index never reports absent. Fail closed regardless.
      return {
        status: "indeterminate",
        reason: "history row has no binding visible in the configured index yet",
        code: "binding-not-yet-visible",
      };
    }
    if (read.status === "unreadable") {
      // CORE SR-2: not-found is never authoritative absence; keep it retryable.
      return {
        status: "indeterminate",
        reason: `no record is visible at ${read.nativeAddress} yet`,
        code: "record-not-yet-visible",
      };
    }
    if (read.status === "unverifiable") {
      if (row.unsupported) return { ...read, code: "unsupported-kind" };
      // An unavailable verifier is not a verdict; the row stays retryable.
      if (row.code === "verifier-unavailable") {
        return { status: "indeterminate", reason: read.reason, code: row.code };
      }
    }
    return read;
  }

  return {
    ...createBoundArtifactRepository(deps),
    async scanPage(input, options = {}) {
      let state: ArtifactScanState;
      if (input === undefined) {
        state = freshState();
      } else {
        let owned: ArtifactScanState | undefined;
        try {
          // Read each field once, inherited getters included; never spread input.
          const {
            owner: stateOwner, cursor, seen, metadata, consumedCursors,
            pagesConsumed, exhausted, pendingRow, deferred,
          } = input;
          const ownedSeen = ownedStringMap(seen);
          const ownedMetadata = ownedStringMap(metadata);
          const ownedCursors = ownedStringSet(consumedCursors);
          const ownedPending = ownedPendingRow(pendingRow);
          const ownedDeferredRows = ownedDeferred(deferred);
          if (
            typeof stateOwner === "string" &&
            (cursor === null || typeof cursor === "string") &&
            Number.isSafeInteger(pagesConsumed) &&
            pagesConsumed >= 0 &&
            typeof exhausted === "boolean" &&
            ownedSeen !== undefined &&
            ownedMetadata !== undefined &&
            ownedCursors !== undefined &&
            ownedPending !== undefined &&
            ownedDeferredRows !== undefined
          ) {
            owned = {
              owner: stateOwner, cursor, seen: ownedSeen, metadata: ownedMetadata,
              consumedCursors: ownedCursors, pagesConsumed, exhausted,
              pendingRow: ownedPending, deferred: ownedDeferredRows,
            };
          }
        } catch {
          // A throwing getter or non-iterable collection is an invalid state.
        }
        if (owned === undefined) {
          return restart(
            "invalid-state",
            "scan state has an invalid owner, cursor, collection, page count, row or exhaustion flag",
          );
        }
        // Before the exhausted fast path, which would otherwise end the traversal.
        const contradiction = stateContradiction(owned);
        if (contradiction !== undefined) return restart("invalid-state", contradiction);
        state = owned;
      }
      if (normalizedBindingOwner(state.owner) !== owner) {
        return restart("foreign-owner-state", "scan state belongs to a different owner");
      }
      if (state.exhausted) return { status: "page", results: [], deferred: [], state };
      if (state.cursor !== null && state.consumedCursors.has(state.cursor)) {
        return restart("cursor-cycle", `history cursor cycle detected at ${state.cursor}`, state);
      }
      if (state.pagesConsumed >= MAX_PAGES) {
        return restart("page-bound", "stopped after 10000 pages (page-count bound)", state);
      }

      // scanAnchorPage eagerly deduplicates classification. Stage that mutation
      // separately; a classified row has not yet been fully handled by a reader.
      // Deferred rows are skipped like handled rows but never enter `seen`.
      const handled = new Map(state.seen);
      const deferred = [...state.deferred];
      const staged = new Map(handled);
      for (const { anchor } of deferred) staged.set(anchor.nativeAddress, anchor.logicalAddress);
      // Kept apart from handled rows so the scanner checks both for disagreement.
      const metadata = new Map(state.metadata);
      const page = await scanAnchorPage(fetchPage, state.cursor, {
        ...options,
        seen: staged,
        logicalMetadata: metadata,
      });
      if (page.status === "indeterminate") {
        if (page.code === "cursor-cycle" || page.code === "history-restart-required") {
          return restart(page.code, page.reason, state);
        }
        if (page.code === "metadata-conflict") {
          return { status: "conflict", code: page.code, reason: page.reason, results: [], deferred: [], state };
        }
        return {
          status: "indeterminate",
          code: page.code ?? "history-unavailable",
          reason: page.reason,
          results: [],
          deferred: [],
          state,
        };
      }
      if (page.nextCursor !== null && state.consumedCursors.has(page.nextCursor)) {
        return restart("cursor-cycle", `history cursor cycle detected at ${page.nextCursor}`, state);
      }

      const results: ScannedArtifactRead[] = [];
      const newlyDeferred: ArtifactScanDeferredRow[] = [];
      for (const anchor of page.anchors) {
        const outcome = await readRow(anchor);
        results.push({ anchor, outcome });
        if (outcome.status === "indeterminate") {
          // Saturate so a persisted count at the limit still yields a valid state.
          const attempts = state.pendingRow?.nativeAddress === anchor.nativeAddress
            ? Math.min(state.pendingRow.attempts + 1, Number.MAX_SAFE_INTEGER)
            : 1;
          if (attempts < maxRowAttempts) {
            return {
              status: "indeterminate",
              code: outcome.code,
              reason: outcome.reason,
              results,
              deferred: newlyDeferred,
              state: {
                ...state,
                seen: handled,
                // Keep the page's observed metadata: the failing row is not in
                // `seen`, so only this binds its logical address for the retry.
                metadata,
                deferred,
                pendingRow: { nativeAddress: anchor.nativeAddress, attempts },
              },
            };
          }
          const row = { anchor, code: outcome.code, reason: outcome.reason, attempts };
          deferred.push(row);
          newlyDeferred.push(row);
          continue;
        }
        handled.set(anchor.nativeAddress, anchor.logicalAddress);
      }
      return {
        status: "page",
        results,
        deferred: newlyDeferred,
        state: {
          owner,
          cursor: page.nextCursor,
          seen: handled,
          metadata,
          consumedCursors: new Set([
            ...state.consumedCursors,
            ...(state.cursor === null ? [] : [state.cursor]),
          ]),
          pagesConsumed: state.pagesConsumed + 1,
          exhausted: page.nextCursor === null,
          pendingRow: null,
          deferred,
        },
      };
    },
  };
}
