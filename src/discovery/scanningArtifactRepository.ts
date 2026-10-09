import { contentHash } from "../canonical/index.js";
import type { AnchorBinding, BindingIndex } from "./binding.js";
import {
  createBoundArtifactRepository,
  type BoundArtifactRepository,
  type BoundArtifactRepositoryDeps,
} from "./boundArtifactRepository.js";
import { normalizedBindingOwner } from "./owner.js";
import {
  scanAnchorPage,
  type AnchorHistoryPageFetcher,
  type ScannedAnchor,
  type ScanOptions,
} from "./scanner.js";
import { resolveAndRead, type VerifiedRead } from "./verifiedRead.js";

export interface ScanningArtifactRepositoryDeps extends BoundArtifactRepositoryDeps {
  /** Explicit history seam; the helper never selects an RPC or connects itself. */
  fetchPage: AnchorHistoryPageFetcher;
  /** Expected publisher of the discovered artifacts, independent of the reader. */
  expectedOwner: string;
  /**
   * Must check signed scope, domain, version, signature, authorized signer and
   * expected owner/role/logical slot for this kind. Only literal true passes.
   * Unsupported kinds or unavailable verification must throw.
   * Throws produce `unverifiable`. Return false only for a completed negative
   * signature or authorization check, which produces `signature-invalid`.
   */
  verifyArtifact: (
    record: Record<string, unknown>,
    binding: AnchorBinding,
    anchor: ScannedAnchor,
  ) => Promise<boolean> | boolean;
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
}

/** Existing read diagnostics are preserved; known binding disagreements are explicit. */
export interface ScannedArtifactRead {
  anchor: ScannedAnchor;
  outcome: VerifiedRead | { status: "conflict"; reason: string };
}

export type ArtifactScanPage =
  | { status: "page"; results: ScannedArtifactRead[]; state: ArtifactScanState }
  | {
      status: "indeterminate" | "conflict";
      reason: string;
      /** Handled prefix plus the failing row, when it was classified. */
      results: ScannedArtifactRead[];
      state: ArtifactScanState;
    };

export interface ScanningArtifactRepository extends BoundArtifactRepository {
  /**
   * Scan, resolve, read and verify one page. Reuse the returned state, including
   * on indeterminate results. Only fully handled rows enter dedup state. An
   * untagged indeterminate read stops the page at its original cursor so retry
   * re-fetches that page and re-reads the failing row, skipping the handled prefix.
   * Other diagnostics are handled candidates; restart with fresh state to revisit
   * repaired bindings or bytes. Input state is never mutated.
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

/**
 * Compose the bound repository with incremental verified history reads (#54).
 * The adapter, consumer index, authorized publisher, owner, fetcher and verifier
 * are injected. Scanning only reads; publication occurs only through explicit
 * repository.write calls. History and bindings remain untrusted discovery hints.
 */
export function createScanningArtifactRepository(
  deps: ScanningArtifactRepositoryDeps,
): ScanningArtifactRepository {
  const { adapter, index, fetchPage, verifyArtifact } = deps;
  const owner = normalizedBindingOwner(deps.expectedOwner);
  if (owner.length === 0) throw new Error("expectedOwner must not be empty");

  return {
    ...createBoundArtifactRepository(deps),
    async scanPage(input, options = {}) {
      let state: ArtifactScanState;
      if (input === undefined) {
        state = { owner, cursor: null, seen: new Map(), metadata: new Map(), consumedCursors: new Set(), pagesConsumed: 0, exhausted: false };
      } else {
        // Read each field once, inherited getters included; never spread input.
        const { owner: stateOwner, cursor, seen, metadata, consumedCursors, pagesConsumed, exhausted } = input;
        state = { owner: stateOwner, cursor, seen: new Map(seen), metadata: new Map(metadata), consumedCursors: new Set(consumedCursors), pagesConsumed, exhausted };
        if (
          typeof stateOwner !== "string" ||
          (cursor !== null && typeof cursor !== "string") ||
          !Number.isSafeInteger(pagesConsumed) ||
          pagesConsumed < 0 ||
          typeof exhausted !== "boolean"
        ) {
          return {
            status: "indeterminate",
            reason: "scan state has an invalid owner, cursor, page count or exhaustion flag",
            results: [],
            state,
          };
        }
      }
      if (normalizedBindingOwner(state.owner) !== owner) {
        return {
          status: "indeterminate",
          reason: "scan state belongs to a different owner",
          results: [],
          state,
        };
      }
      if (state.exhausted) return { status: "page", results: [], state };
      if (state.cursor !== null && state.consumedCursors.has(state.cursor)) {
        return { status: "indeterminate", reason: `history cursor cycle detected at ${state.cursor}`, results: [], state };
      }
      if (state.pagesConsumed >= 10_000) {
        return { status: "indeterminate", reason: "stopped after 10000 pages (page-count bound)", results: [], state };
      }

      // scanAnchorPage eagerly deduplicates classification. Stage that mutation
      // separately; a classified row has not yet been fully handled by a reader.
      const handled = new Map(state.seen);
      const staged = new Map(handled);
      // Kept apart from handled rows so the scanner checks both for disagreement.
      const metadata = new Map(state.metadata);
      const page = await scanAnchorPage(fetchPage, state.cursor, {
        ...options,
        seen: staged,
        logicalMetadata: metadata,
      });
      if (page.status === "indeterminate") {
        return {
          status: page.code === "metadata-conflict" ? "conflict" : "indeterminate",
          reason: page.reason,
          results: [],
          state,
        };
      }
      if (page.nextCursor !== null && state.consumedCursors.has(page.nextCursor)) {
        return { status: "indeterminate", reason: `history cursor cycle detected at ${page.nextCursor}`, results: [], state };
      }

      const results: ScannedArtifactRead[] = [];
      for (const anchor of page.anchors) {
        let outcome: ScannedArtifactRead["outcome"];
        if (
          anchor.owner !== undefined &&
          normalizedBindingOwner(anchor.owner) !== owner
        ) {
          outcome = {
            status: "binding-mismatch",
            reason: "history row owner does not match expectedOwner",
          };
        } else {
          const rowIndex: BindingIndex = {
            async resolve(logicalAddress, expectedOwner) {
              const resolution = await index.resolve(logicalAddress, expectedOwner);
              // Read the untrusted discriminator once and return owned results,
              // so a later read cannot skip the native-address check below.
              const { status } = resolution;
              if (status === "absent") return { status };
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
            read: (address) => adapter.readAnchor(address),
            contentHashOf: contentHash,
            verifySignature: async (record, binding) => {
              if (anchor.kind === "unknown" || typeof verifyArtifact !== "function") {
                throw new Error("no artifact verifier for this anchor kind");
              }
              return verifyArtifact(record, binding, { ...anchor });
            },
          });
          outcome = read.status === "indeterminate" && read.code === "binding-conflict"
            ? { status: "conflict", reason: read.reason }
            : read;
        }
        results.push({ anchor, outcome });
        if (outcome.status === "indeterminate") {
          return {
            status: "indeterminate",
            reason: outcome.reason,
            results,
            state: { ...state, seen: handled },
          };
        }
        handled.set(anchor.nativeAddress, anchor.logicalAddress);
      }
      return {
        status: "page",
        results,
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
        },
      };
    },
  };
}
