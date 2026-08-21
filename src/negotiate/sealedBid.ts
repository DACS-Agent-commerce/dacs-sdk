import { randomBytes } from "node:crypto";

import { canonicalize } from "../canonical/jcs.js";
import { sha256Hex } from "../canonical/hash.js";
import { assertPositiveAmount, canonicalizeDecimal } from "../canonical/decimal.js";
import { DacsError } from "../errors.js";
import type { PriceTerm } from "../artifacts/types.js";

/**
 * negotiate-sealed-envelope (DACS-3 §8.4.3) — the pure sealed-bid core:
 * commitment hashing, reveal verification, deadline gating, and winner
 * selection. Everything here is deterministic and substrate-free (so it's
 * unit-tested without a node); the L2PS channel transport and SR-2 anchoring of
 * commits/reveals are the orchestration layer wired on top.
 *
 * Commitment (SE-7): a bidder commits to `bid` under a fresh ≥256-bit salt as
 *   bidHash = sha256("dacs-sealed-bid:v1:" || sha256(JCS(bid)) || saltBytes)
 * as a lowercase hex string. The bid is hashed to a fixed 32-byte digest before
 * concatenation so the bid/salt boundary is unambiguous; the salt travels as
 * base64url and the *raw decoded bytes* are what's hashed.
 */

/**
 * The bid amount + currency. Canonical home is the DACS-4 primitive
 * {@link PriceTerm} in artifacts/types; re-exported here for negotiate callers.
 */
export type { PriceTerm };

/** The sealed bid body (the object `bidHash` commits to). */
export interface SealedBid {
  price: PriceTerm;
  deliverable?: unknown;
  terms?: Record<string, unknown>;
}

/** A bidder's SR-2-anchored commit. */
export interface AnchoredCommit {
  /** The authenticated channel sender (CH-3); identity is the signer, not a body field. */
  bidderClaim: string;
  /** lowercase-hex bidHash. */
  bidHash: string;
  /**
   * Objective SR-2 anchor timestamp (unix ms) — authoritative for SE-2/SE-5.
   * `null` means the anchor exists but its authoritative timestamp could not be
   * resolved yet; SE-9 requires the orchestrator to pause rather than choose a
   * different same-bidder commit.
   */
  anchorTs: number | null;
}

/** Commit whose SR-2 timestamp has been resolved and validated. */
export type ResolvedAnchoredCommit = AnchoredCommit & { anchorTs: number };

/** A bidder's SR-2-anchored reveal (the openable {bid, salt}). */
export interface AnchoredReveal {
  bidderClaim: string;
  bid: SealedBid;
  /** base64url salt (SE-7). */
  salt: string;
  /** Objective SR-2 anchor timestamp (unix ms) — authoritative for SE-3. */
  anchorTs: number;
}

export type SelectionRule =
  | "lowest-price"
  | "highest-price"
  | "first-acceptable"
  | `rule-ref:${string}`;

/** The commitment-hash domain tag (§8.4.3) — NOT a signature separator. */
export const SEALED_BID_HASH_TAG = "dacs-sealed-bid:v1:";
/** SE-7 minimum salt entropy. */
export const MIN_SALT_BYTES = 32;
/** SE-1 minimum lead before commitDeadline. */
export const MIN_COMMIT_LEAD_MS = 60_000;
/** §8.4.3 minimum reveal window. */
export const MIN_REVEAL_WINDOW_SECONDS = 60;

// ── Commitment / reveal ─────────────────────────────────────────────────────

/** 32-byte digest of the bid's JCS canonical form (the bidHash's middle term). */
function bidDigest(bid: SealedBid): Buffer {
  return Buffer.from(sha256Hex(canonicalize(bid)), "hex");
}

/**
 * Compute the lowercase-hex bidHash (§8.4.3 / SE-7). `salt` is base64url; its
 * raw decoded bytes are hashed.
 */
export function computeBidHash(bid: SealedBid, salt: string): string {
  const saltBytes = Buffer.from(salt, "base64url");
  const preimage = Buffer.concat([
    Buffer.from(SEALED_BID_HASH_TAG, "utf8"),
    bidDigest(bid),
    saltBytes,
  ]);
  return sha256Hex(preimage);
}

/** A fresh ≥256-bit base64url salt (SE-7). */
export function generateSalt(): string {
  return randomBytes(MIN_SALT_BYTES).toString("base64url");
}

/** Does a base64url salt carry the SE-7 minimum entropy (≥32 raw bytes)? */
export function saltHasEnoughEntropy(salt: string): boolean {
  return Buffer.from(salt, "base64url").length >= MIN_SALT_BYTES;
}

export interface SealedCommitment {
  bid: SealedBid;
  salt: string;
  bidHash: string;
}

/**
 * Build a bidder's commitment: generate a fresh salt (unless supplied for
 * deterministic tests) and compute the bidHash. Rejects a supplied low-entropy
 * salt (SE-7).
 */
export function makeCommitment(bid: SealedBid, salt?: string): SealedCommitment {
  const s = salt ?? generateSalt();
  if (!saltHasEnoughEntropy(s)) {
    throw new DacsError(
      `sealed-bid salt must be ≥${MIN_SALT_BYTES} bytes of entropy (SE-7)`,
    );
  }
  return { bid, salt: s, bidHash: computeBidHash(bid, s) };
}

/** Verify a revealed {bid, salt} opens the committed bidHash. */
export function verifyReveal(
  bidHash: string,
  bid: SealedBid,
  salt: string,
): boolean {
  return computeBidHash(bid, salt) === bidHash;
}

// ── Session parameters + deadline gating ────────────────────────────────────

export interface SealedEnvelopeBaseParams {
  /** unix ms; MUST be ≥ now + 60s (SE-1). */
  commitDeadline: number;
  /** seconds after commitDeadline; MUST be ≥ 60. */
  revealWindow: number;
  selectionRule: SelectionRule;
  /**
   * Listing-bound criteria for `first-acceptable`, using the same SE-6
   * content-hash binding as a `rule-ref` selection rule.
   */
  acceptanceRule?: `rule-ref:${string}`;
}

/** Parameters for the backwards-compatible demand/default phase (SE-8). */
export interface DemandSealedEnvelopeParams extends SealedEnvelopeBaseParams {
  /** Optional no-op marker; absent and `demand` have identical semantics. */
  auctionMode?: "demand";
}

/** Parameters for the explicit procurement phase (SE-8). */
export interface ProcurementSealedEnvelopeParams extends SealedEnvelopeBaseParams {
  /** Required on `negotiate-sealed-envelope-procurement`; never inferred. */
  auctionMode: "procurement";
}

/** Runtime-validated phase parameter union. */
export type SealedEnvelopeParams =
  | DemandSealedEnvelopeParams
  | ProcurementSealedEnvelopeParams;

/** Validate session parameters (SE-1 + reveal-window floor). Throws on violation. */
export function validateSealedParams(
  params: SealedEnvelopeParams,
  nowMs: number,
): void {
  if (params.commitDeadline < nowMs + MIN_COMMIT_LEAD_MS) {
    throw new DacsError(
      "commitDeadline MUST be at least 60s in the future at session start (SE-1)",
    );
  }
  if (params.revealWindow < MIN_REVEAL_WINDOW_SECONDS) {
    throw new DacsError("revealWindow MUST be ≥ 60 seconds (§8.4.3)");
  }
}

/** SE-2: keep only commits anchored at or before commitDeadline. */
export function commitsInWindow(
  commits: AnchoredCommit[],
  commitDeadline: number,
): ResolvedAnchoredCommit[] {
  return commits.filter(
    (c): c is ResolvedAnchoredCommit =>
      typeof c.anchorTs === "number" &&
      Number.isSafeInteger(c.anchorTs) &&
      c.anchorTs >= 0 &&
      c.anchorTs <= commitDeadline,
  );
}

export interface CommitWindowResolution {
  /** Structurally valid commits with resolved, in-window SR-2 timestamps. */
  commits: ResolvedAnchoredCommit[];
  /** Bidders whose otherwise-valid commit has an unresolved timestamp. */
  unresolvedBidders: string[];
}

const structurallyValidCommit = (
  commit: AnchoredCommit,
): boolean =>
  typeof commit.bidderClaim === "string" &&
  commit.bidderClaim.length > 0 &&
  /^[0-9a-f]{64}$/.test(commit.bidHash);

/**
 * Resolve the SE-2 window without hiding SE-9 uncertainty. A structurally valid
 * commit whose anchor time is unavailable can be earlier than a resolved
 * same-bidder commit, so authority is indeterminate until it resolves.
 */
export function resolveCommitWindow(
  commits: AnchoredCommit[],
  commitDeadline: number,
): CommitWindowResolution {
  const unresolved = new Set<string>();
  const resolved: ResolvedAnchoredCommit[] = [];
  for (const commit of commits) {
    if (!structurallyValidCommit(commit)) continue;
    if (commit.anchorTs === null) {
      unresolved.add(commit.bidderClaim);
      continue;
    }
    // Other timestamp shapes are structurally malformed, not unresolved SR-2
    // state, and therefore cannot participate in authority selection.
    if (!Number.isSafeInteger(commit.anchorTs) || commit.anchorTs < 0) continue;
    if (commit.anchorTs <= commitDeadline) {
      resolved.push(commit as ResolvedAnchoredCommit);
    }
  }
  return {
    commits: resolved,
    unresolvedBidders: [...unresolved].sort(),
  };
}

/** §8.4.3 / SE-3: reveal window is inclusive from commitDeadline through expiry. */
export function revealsInWindow(
  reveals: AnchoredReveal[],
  params: SealedEnvelopeParams,
): AnchoredReveal[] {
  const expiry = params.commitDeadline + params.revealWindow * 1000;
  return reveals.filter(
    (r) => r.anchorTs >= params.commitDeadline && r.anchorTs <= expiry,
  );
}

/**
 * Build the authoritative candidate set (§8.4.3 step 4): an in-window reveal
 * counts only if the same bidder anchored an in-window commit whose bidHash the
 * reveal opens. Returns the surviving reveals paired with their commit.
 */
export function matchRevealsToCommits(
  commits: AnchoredCommit[],
  reveals: AnchoredReveal[],
): Array<{ reveal: AnchoredReveal; commit: ResolvedAnchoredCommit }> {
  const resolved = commits
    .filter(
      (commit): commit is ResolvedAnchoredCommit =>
        structurallyValidCommit(commit) &&
        typeof commit.anchorTs === "number" &&
        Number.isSafeInteger(commit.anchorTs) &&
        commit.anchorTs >= 0,
    )
    .sort((a, b) =>
      a.anchorTs !== b.anchorTs
        ? a.anchorTs - b.anchorTs
        : a.bidHash < b.bidHash
          ? -1
          : a.bidHash > b.bidHash
            ? 1
            : 0,
    );

  const byBidder = new Map<string, ResolvedAnchoredCommit>();
  const exactDuplicates = new Set<string>();
  for (const commit of resolved) {
    // SE-9: exact duplicates collapse, then the ascending
    // (anchorTimestamp, bidHash) order makes the first record authoritative.
    const tuple = `${commit.bidderClaim}\u0000${commit.anchorTs}\u0000${commit.bidHash}`;
    if (exactDuplicates.has(tuple)) continue;
    exactDuplicates.add(tuple);
    if (!byBidder.has(commit.bidderClaim)) {
      byBidder.set(commit.bidderClaim, commit);
    }
  }
  const out: Array<{
    reveal: AnchoredReveal;
    commit: ResolvedAnchoredCommit;
  }> = [];
  for (const r of reveals) {
    const commit = byBidder.get(r.bidderClaim);
    if (!commit) continue; // no matching in-window commit → excluded
    if (!verifyReveal(commit.bidHash, r.bid, r.salt)) continue; // mismatch → excluded
    out.push({ reveal: r, commit });
  }
  return out;
}

// ── rule-ref binding (SE-6) ─────────────────────────────────────────────────

export interface RuleRef {
  /** The authoritative sha256 (lowercase hex) the fetched rule MUST hash to. */
  contentHash: string;
  /** Where to fetch the rule — informational only; the contentHash is the binding. */
  uri: string;
}

/**
 * Parse a `rule-ref:<contentHash>:<uri>` selection rule. The URI may itself
 * contain colons (e.g. `https://…`), so only the first `:` after the hash is a
 * delimiter. Returns null for the non-rule-ref rules.
 */
export function parseRuleRef(rule: SelectionRule | string): RuleRef | null {
  if (!rule.startsWith("rule-ref:")) return null;
  const rest = rule.slice("rule-ref:".length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  const contentHash = rest.slice(0, sep);
  const uri = rest.slice(sep + 1);
  if (!/^[0-9a-f]{64}$/.test(contentHash) || !uri) return null;
  return { contentHash, uri };
}

/**
 * SE-6: verify fetched rule content is the one the selection rule commits to —
 * sha256 of its canonical form MUST equal the ref's contentHash. A mismatch
 * MUST exclude the rule and fail selection (`errorClass: permanent`), so a
 * seller can't swap the algorithm after bids are in.
 */
export function verifyRuleRefContent(
  rule: SelectionRule | string,
  ruleContent: unknown,
): boolean {
  const parsed = parseRuleRef(rule);
  if (!parsed) return false;
  return sha256Hex(canonicalize(ruleContent)) === parsed.contentHash;
}

// ── Decimal comparison + selection ──────────────────────────────────────────

/** Compare two non-negative CD-1 decimals full-precision: -1 / 0 / 1. */
export function compareDecimal(a: string, b: string): number {
  const [ai, af = ""] = canonicalizeDecimal(a).split(".");
  const [bi, bf = ""] = canonicalizeDecimal(b).split(".");
  if (ai!.length !== bi!.length) return ai!.length < bi!.length ? -1 : 1;
  if (ai !== bi) return ai! < bi! ? -1 : 1;
  const len = Math.max(af.length, bf.length);
  const pa = af.padEnd(len, "0");
  const pb = bf.padEnd(len, "0");
  return pa === pb ? 0 : pa < pb ? -1 : 1;
}

export interface SelectionOptions {
  selectionRule: SelectionRule;
  /** The listing-declared currency — bids in any other currency are excluded. */
  currency: string;
  /** Optional reserve (floor for highest/first/rule-ref, ceiling for lowest); inclusive. */
  reservePrice?: PriceTerm;
  /**
   * Deterministic acceptance predicate — REQUIRED for `first-acceptable` and
   * `rule-ref` (for rule-ref the caller must have content-hash-verified the rule
   * before passing it, per SE-6).
   */
  acceptancePredicate?: (bid: SealedBid) => boolean;
}

export interface SelectionResult {
  /** The winning reveal, or null if no bid wins. */
  winner: AnchoredReveal | null;
  /** Why there's no winner (only set when winner is null). */
  reason?: string;
  /** Excluded bids with the reason (currency / non-positive / reserve). */
  excluded: Array<{ bidderClaim: string; reason: string }>;
}

/**
 * Select the winning bid (§8.4.3 step 5) over an already gated + matched
 * candidate set. Order: currency + non-positive exclusions, then reserve, then
 * the selection rule, with the SE-5 tie-break ladder (earliest commit anchor
 * timestamp, then ascending lowercase-hex bidHash). Pass the candidates from
 * {@link matchRevealsToCommits} so each reveal carries its authoritative commit.
 */
export function selectSealedWinner(
  candidates: Array<{
    reveal: AnchoredReveal;
    commit: ResolvedAnchoredCommit;
  }>,
  opts: SelectionOptions,
): SelectionResult {
  const excluded: Array<{ bidderClaim: string; reason: string }> = [];

  // Exclusions first (§9.3): wrong currency, then non-positive/invalid amount.
  let pool = candidates.filter(({ reveal }) => {
    if (reveal.bid.price.currency !== opts.currency) {
      excluded.push({ bidderClaim: reveal.bidderClaim, reason: "currency mismatch" });
      return false;
    }
    try {
      assertPositiveAmount(reveal.bid.price.amount);
    } catch {
      excluded.push({
        bidderClaim: reveal.bidderClaim,
        reason: "non-positive or invalid amount",
      });
      return false;
    }
    return true;
  });

  // Reserve (inclusive bound): floor for highest/first/rule-ref, ceiling for lowest.
  if (opts.reservePrice) {
    if (opts.reservePrice.currency !== opts.currency) {
      return {
        winner: null,
        excluded,
        reason: "reserve currency ≠ listing currency (non-conformant listing)",
      };
    }
    const isLowest = opts.selectionRule === "lowest-price";
    pool = pool.filter(({ reveal }) => {
      const cmp = compareDecimal(reveal.bid.price.amount, opts.reservePrice!.amount);
      const fails = isLowest ? cmp > 0 : cmp < 0;
      if (fails)
        excluded.push({ bidderClaim: reveal.bidderClaim, reason: "fails reserve" });
      return !fails;
    });
  }

  if (pool.length === 0) {
    return { winner: null, excluded, reason: "no candidate bids after exclusions" };
  }

  const bidHashOf = (c: { reveal: AnchoredReveal }) =>
    computeBidHash(c.reveal.bid, c.reveal.salt);
  const tieBreak = (
    a: { reveal: AnchoredReveal; commit: ResolvedAnchoredCommit },
    b: { reveal: AnchoredReveal; commit: ResolvedAnchoredCommit },
  ): number => {
    if (a.commit.anchorTs !== b.commit.anchorTs)
      return a.commit.anchorTs - b.commit.anchorTs;
    const ha = bidHashOf(a);
    const hb = bidHashOf(b);
    return ha < hb ? -1 : ha > hb ? 1 : 0;
  };

  if (opts.selectionRule === "lowest-price" || opts.selectionRule === "highest-price") {
    const dir = opts.selectionRule === "lowest-price" ? 1 : -1;
    const sorted = [...pool].sort((a, b) => {
      const c = compareDecimal(a.reveal.bid.price.amount, b.reveal.bid.price.amount) * dir;
      return c !== 0 ? c : tieBreak(a, b);
    });
    return { winner: sorted[0]!.reveal, excluded };
  }

  // first-acceptable / rule-ref: evaluate in commit-anchor order, take the first
  // that satisfies the (content-hash-bound, deterministic) acceptance predicate.
  if (!opts.acceptancePredicate) {
    return {
      winner: null,
      excluded,
      reason: `selection rule "${opts.selectionRule}" requires an acceptancePredicate`,
    };
  }
  const ordered = [...pool].sort(tieBreak);
  const win = ordered.find((c) => opts.acceptancePredicate!(c.reveal.bid));
  return win
    ? { winner: win.reveal, excluded }
    : { winner: null, excluded, reason: "no bid satisfied the acceptance predicate" };
}
