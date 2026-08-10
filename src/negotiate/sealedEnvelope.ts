import { baseUnits } from "../canonical/decimal.js";
import { canonicalize } from "../canonical/jcs.js";
import { sha256Hex } from "../canonical/hash.js";
import { DacsError } from "../errors.js";
import type { LegacyMvpAgreementDocument as AgreementDocument } from "../artifacts/legacyMvp.js";
import {
  commitsInWindow,
  matchRevealsToCommits,
  parseRuleRef,
  revealsInWindow,
  resolveCommitWindow,
  selectSealedWinner,
  validateSealedParams,
  type AnchoredCommit,
  type AnchoredReveal,
  type PriceTerm,
  type RuleRef,
  type SealedBid,
  type SealedEnvelopeParams,
  type SelectionRule,
} from "./sealedBid.js";

const VERIFIED_RULE: unique symbol = Symbol("verified-sealed-selection-rule");

/**
 * A selection rule whose resolved content has been canonicalised and matched
 * to its listing-pinned hash by this core. The private brand prevents this from
 * being confused at type level with arbitrary fetched content or a bare bid
 * predicate.
 */
export interface VerifiedSelectionRule {
  readonly ref: Readonly<RuleRef>;
  readonly content: unknown;
  readonly canonical: string;
  readonly [VERIFIED_RULE]: true;
}

export interface SealedRuleEvaluationInput {
  rule: VerifiedSelectionRule;
  bid: Readonly<SealedBid>;
  /** Authoritative matched bid set in SE-5 commit order. */
  bids: readonly Readonly<SealedBid>[];
}

/**
 * negotiate-sealed-envelope orchestrator (DACS-3 §8.4.3). Composes the pure
 * sealed-bid primitives into the phase handler an orchestrator (seller side)
 * runs after the reveal window closes: gate commits (SE-2) + reveals (SE-3),
 * build the authoritative anchored candidate set, select the winner, and hand
 * the winning bid to the injected `commitAgreement` (which builds/signs/anchors
 * the AgreementDocument — kept out of here so this stays substrate-agnostic and
 * testable, exactly like runSessionCore's injected settle/anchor).
 *
 * The channel transport (L2PS / SR-4) and the SR-2 anchoring of commits/reveals
 * are the caller's concern; this consumes their *anchored* outputs (the
 * authoritative set per §8.4.3 step 4) via `readAnchoredCommits` /
 * `readAnchoredReveals`.
 */

/** §8.3.3 channel message envelope (substrate-independent). */
export interface SealedChannelMessage {
  type: "sealed-envelope-commit" | "sealed-envelope-reveal";
  jobId: string;
  /** Authenticated channel sender (CH-3) — bidder identity is the signer. */
  sender: string;
  body: unknown;
  /** Self-reported send time; informational only (never a deadline/tie-break input). */
  sentAt: number;
}

/** Build a `sealed-envelope-commit` channel message. */
export function buildCommitMessage(
  jobId: string,
  sender: string,
  bidHash: string,
  commitTimestamp: number,
): SealedChannelMessage {
  return {
    type: "sealed-envelope-commit",
    jobId,
    sender,
    // bidderClaim MUST equal the sender (CH-3); carried for the on-chain record.
    body: { bidHash, bidderClaim: sender, commitTimestamp },
    sentAt: commitTimestamp,
  };
}

/** Build a `sealed-envelope-reveal` channel message carrying the openable {bid, salt}. */
export function buildRevealMessage(
  jobId: string,
  sender: string,
  bid: SealedBid,
  salt: string,
  sentAt: number,
): SealedChannelMessage {
  return {
    type: "sealed-envelope-reveal",
    jobId,
    sender,
    body: { bid, salt },
    sentAt,
  };
}

/** Context the injected agreement builder needs to construct the AgreementDocument. */
export interface SealedWinnerContext {
  jobId: string;
  seller: string;
  winningBidderClaim: string;
  winningBid: SealedBid;
  losingBidderClaims: string[];
}

/** Listing-side context needed to turn a winning bid into an AgreementDocument. */
export interface SealedAgreementContext {
  seller: string;
  listingRef: string;
  /** Token decimals for the listing's rail (bid amount is a decimal → base units). */
  decimals: number;
  /** Payment rail id the agreement settles on. */
  rail: string;
  deliveryPhase: string;
  deliveryFormat: string;
  /** Agreement expiry / settle-by (ISO-8601). */
  expiresAt: string;
}

/**
 * Construct the AgreementDocument from the winning sealed bid (§8.4.3 step 6,
 * `derivedFromPattern: sealed-envelope`): the buyer is the winning bidder, the
 * price is the bid's amount converted to integer base units (matching the SDK's
 * base-unit Price.amount), the currency is the bid's currency, and the rail /
 * decimals / delivery come from the listing context. Pure — the caller signs +
 * anchors it. Throws if the bid amount carries more precision than the rail's
 * token supports.
 */
export function buildSealedAgreement(
  win: SealedWinnerContext,
  ctx: SealedAgreementContext,
): AgreementDocument {
  const amount = baseUnits(win.winningBid.price.amount, ctx.decimals);
  if (amount === "0") {
    throw new DacsError("winning sealed bid resolves to a zero base-unit amount");
  }
  return {
    jobId: win.jobId,
    pattern: "negotiate-sealed-envelope",
    buyer: win.winningBidderClaim,
    seller: ctx.seller,
    listingRef: ctx.listingRef,
    price: {
      amount,
      asset: win.winningBid.price.currency,
      decimals: ctx.decimals,
      rail: ctx.rail,
    },
    delivery: { phase: ctx.deliveryPhase, format: ctx.deliveryFormat },
    expiresAt: ctx.expiresAt,
  };
}

export interface SealedEnvelopeDeps {
  /** The anchored commit set (SR-2), read after commitDeadline. */
  readAnchoredCommits: () => Promise<AnchoredCommit[]>;
  /** The anchored reveal set (SR-2), read after the reveal window closes. */
  readAnchoredReveals: () => Promise<AnchoredReveal[]>;
  /**
   * Build + sign + anchor the AgreementDocument from the winning bid
   * (`derivedFromPattern: "sealed-envelope"`), collecting the seller + winner
   * co-signatures. Returns the anchored ref + its content hash.
   */
  commitAgreement: (
    ctx: SealedWinnerContext,
  ) => Promise<{ agreementRef: string; agreementHash: string }>;
  /** Fetch an anchored/HTTPS rule by the listing-pinned SE-6 reference. */
  resolveRuleContent?: (ref: Readonly<RuleRef>) => Promise<unknown>;
  /**
   * Deterministic interpreter capability for verified rule content. Unlike the
   * old caller predicate, this can only be invoked by the core with branded,
   * hash-checked content and the fixed authoritative bid set.
   */
  evaluateVerifiedRule?: (input: SealedRuleEvaluationInput) => boolean;
}

export interface SealedEnvelopeInput {
  jobId: string;
  seller: string;
  /** The listing-declared currency; bids in any other currency are excluded. */
  currency: string;
  params: SealedEnvelopeParams;
  /** Optional reserve (floor/ceiling per rule). */
  reservePrice?: PriceTerm;
  /**
   * SE-1 (commitDeadline ≥ start + 60s) is a session-OPEN check, but this core
   * runs AFTER the reveal window closes (it reads the final anchored sets), when
   * `commitDeadline < now` always. So SE-1 is NOT re-checked here against a live
   * clock — callers MUST run `validateSealedParams(params, sessionStartMs)` when
   * they OPEN the session. Optionally pass the recorded `sessionStartMs` and this
   * core re-validates SE-1 against that (the correct clock), not against now().
   */
  sessionStartMs?: number;
}

export interface SealedEnvelopeResult {
  ok: boolean;
  winningBidderClaim?: string;
  agreementRef?: string;
  agreementHash?: string;
  losingBidderClaims: string[];
  /** Set when ok is false — why no winner. */
  reason?: string;
  /** Fault class for a failed phase (§8.4.3 step 6). */
  errorClass?: "counterparty" | "permanent" | "substrate";
  /** The full exclusion log from selection (currency / non-positive / reserve). */
  excluded: Array<{ bidderClaim: string; reason: string }>;
}

const isStructuralReason = (reason: string): boolean =>
  /non-conformant|acceptancePredicate|verified rule|rule-ref|acceptance rule|deterministic|reserve currency/.test(
    reason,
  );

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function immutableCanonicalValue(value: unknown): {
  canonical: string;
  value: unknown;
} {
  const canonical = canonicalize(value);
  return { canonical, value: deepFreeze(JSON.parse(canonical) as unknown) };
}

type RuleResolution =
  | { ok: true; rule: VerifiedSelectionRule }
  | { ok: false; reason: string };

async function resolveVerifiedRule(
  encodedRef: string | undefined,
  deps: SealedEnvelopeDeps,
): Promise<RuleResolution> {
  if (typeof encodedRef !== "string" || encodedRef.length === 0) {
    return { ok: false, reason: "selection requires a listing-bound acceptance rule" };
  }
  const ref = parseRuleRef(encodedRef);
  if (!ref) return { ok: false, reason: "malformed rule-ref selection rule" };
  if (!deps.resolveRuleContent || !deps.evaluateVerifiedRule) {
    return {
      ok: false,
      reason: "selection requires a verified rule resolver and deterministic evaluator",
    };
  }
  try {
    const resolved = await deps.resolveRuleContent(Object.freeze({ ...ref }));
    const normalized = immutableCanonicalValue(resolved);
    if (sha256Hex(normalized.canonical) !== ref.contentHash) {
      return { ok: false, reason: "rule-ref content hash mismatch (SE-6)" };
    }
    return {
      ok: true,
      rule: Object.freeze({
        ref: Object.freeze({ ...ref }),
        content: normalized.value,
        canonical: normalized.canonical,
        [VERIFIED_RULE]: true as const,
      }),
    };
  } catch {
    return { ok: false, reason: "rule-ref content is unresolvable or malformed" };
  }
}

function permanentFailure(reason: string): SealedEnvelopeResult {
  return {
    ok: false,
    losingBidderClaims: [],
    reason,
    errorClass: "permanent",
    excluded: [],
  };
}

/**
 * Run the sealed-envelope selection over the anchored commit/reveal sets and, on
 * a winner, commit the agreement. On no winner, returns a failed phase with the
 * §8.4.3 step-6 fault class.
 */
export async function runSealedEnvelopeCore(
  input: SealedEnvelopeInput,
  deps: SealedEnvelopeDeps,
): Promise<SealedEnvelopeResult> {
  // SE-1 is a session-open check (see SealedEnvelopeInput.sessionStartMs) — only
  // re-validated here if the caller supplied the recorded session-start clock.
  // It is NEVER checked against now(): this core runs post-close, so a live-clock
  // check would always (and wrongly) throw.
  if (input.sessionStartMs !== undefined) {
    validateSealedParams(input.params, input.sessionStartMs);
  }

  const rawSelectionRule = input.params.selectionRule as unknown;
  if (
    typeof rawSelectionRule !== "string" ||
    !(
      rawSelectionRule === "lowest-price" ||
      rawSelectionRule === "highest-price" ||
      rawSelectionRule === "first-acceptable" ||
      rawSelectionRule.startsWith("rule-ref:")
    )
  ) {
    return permanentFailure("unrecognized sealed-envelope selection rule");
  }
  const selectionRule = rawSelectionRule as SelectionRule;
  const encodedRule = selectionRule.startsWith("rule-ref:")
    ? selectionRule
    : selectionRule === "first-acceptable"
      ? input.params.acceptanceRule
      : undefined;
  let verifiedRule: VerifiedSelectionRule | undefined;
  if (selectionRule.startsWith("rule-ref:") || selectionRule === "first-acceptable") {
    const resolvedRule = await resolveVerifiedRule(encodedRule, deps);
    if (!resolvedRule.ok) return permanentFailure(resolvedRule.reason);
    verifiedRule = resolvedRule.rule;
  }

  // SE-2 / SE-3 gating, then the authoritative matched candidate set (step 4).
  const commitWindow = resolveCommitWindow(
    await deps.readAnchoredCommits(),
    input.params.commitDeadline,
  );
  if (commitWindow.unresolvedBidders.length > 0) {
    return {
      ok: false,
      losingBidderClaims: [],
      reason:
        "authoritative SR-2 commit timestamp unresolved for: " +
        commitWindow.unresolvedBidders.join(", "),
      errorClass: "substrate",
      excluded: [],
    };
  }
  const commits = commitsInWindow(
    commitWindow.commits,
    input.params.commitDeadline,
  );
  const reveals = revealsInWindow(await deps.readAnchoredReveals(), input.params);
  const candidates = matchRevealsToCommits(commits, reveals);
  const allBidders = [
    ...new Set(candidates.map((c) => c.reveal.bidderClaim)),
  ].sort();

  let evaluationFailure: string | undefined;
  let acceptancePredicate: ((bid: SealedBid) => boolean) | undefined;
  if (verifiedRule && deps.evaluateVerifiedRule) {
    const ordered = [...candidates].sort((a, b) =>
      a.commit.anchorTs !== b.commit.anchorTs
        ? a.commit.anchorTs - b.commit.anchorTs
        : a.commit.bidHash < b.commit.bidHash
          ? -1
          : a.commit.bidHash > b.commit.bidHash
            ? 1
            : 0,
    );
    const immutableBids = Object.freeze(
      ordered.map(({ reveal }) =>
        immutableCanonicalValue(reveal.bid).value as Readonly<SealedBid>,
      ),
    );
    acceptancePredicate = (bid) => {
      try {
        const immutableBid = immutableCanonicalValue(bid).value as Readonly<SealedBid>;
        const context = Object.freeze({
          rule: verifiedRule,
          bid: immutableBid,
          bids: immutableBids,
        });
        const first = deps.evaluateVerifiedRule!(context);
        const second = deps.evaluateVerifiedRule!(context);
        if (typeof first !== "boolean" || first !== second) {
          evaluationFailure = "verified rule evaluator is non-deterministic";
          return false;
        }
        return first;
      } catch {
        evaluationFailure = "verified rule evaluator failed";
        return false;
      }
    };
  }

  const selection = selectSealedWinner(candidates, {
    selectionRule,
    currency: input.currency,
    reservePrice: input.reservePrice,
    acceptancePredicate,
  });

  if (evaluationFailure) return permanentFailure(evaluationFailure);

  if (!selection.winner) {
    const reason = selection.reason ?? "no winning bid";
    return {
      ok: false,
      losingBidderClaims: allBidders,
      reason,
      errorClass: isStructuralReason(reason) ? "permanent" : "counterparty",
      excluded: selection.excluded,
    };
  }

  const winningBidderClaim = selection.winner.bidderClaim;
  const losingBidderClaims = allBidders.filter((b) => b !== winningBidderClaim);

  const { agreementRef, agreementHash } = await deps.commitAgreement({
    jobId: input.jobId,
    seller: input.seller,
    winningBidderClaim,
    winningBid: selection.winner.bid,
    losingBidderClaims,
  });

  return {
    ok: true,
    winningBidderClaim,
    agreementRef,
    agreementHash,
    losingBidderClaims,
    excluded: selection.excluded,
  };
}
