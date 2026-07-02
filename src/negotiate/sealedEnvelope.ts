import { baseUnits } from "../canonical/decimal.js";
import { DacsError } from "../errors.js";
import type { AgreementDocument } from "../artifacts/types.js";
import {
  commitsInWindow,
  matchRevealsToCommits,
  revealsInWindow,
  selectSealedWinner,
  validateSealedParams,
  type AnchoredCommit,
  type AnchoredReveal,
  type PriceTerm,
  type SealedBid,
  type SealedEnvelopeParams,
  type SelectionRule,
} from "./sealedBid.js";

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
  /** Current unix-ms clock (for SE-1 validation at session start). */
  now: () => number;
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
   * Deterministic acceptance predicate — required for `first-acceptable` /
   * `rule-ref`. For `rule-ref` the caller MUST content-hash-verify the rule
   * (SE-6) before wrapping it here.
   */
  acceptancePredicate?: (bid: SealedBid) => boolean;
  /** Validate SE-1 against the session-start clock (default true). */
  validateAtStart?: boolean;
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
  errorClass?: "counterparty" | "permanent";
  /** The full exclusion log from selection (currency / non-positive / reserve). */
  excluded: Array<{ bidderClaim: string; reason: string }>;
}

const isStructuralReason = (reason: string): boolean =>
  /non-conformant|acceptancePredicate|reserve currency/.test(reason);

/**
 * Run the sealed-envelope selection over the anchored commit/reveal sets and, on
 * a winner, commit the agreement. On no winner, returns a failed phase with the
 * §8.4.3 step-6 fault class.
 */
export async function runSealedEnvelopeCore(
  input: SealedEnvelopeInput,
  deps: SealedEnvelopeDeps,
): Promise<SealedEnvelopeResult> {
  if (input.validateAtStart !== false) {
    validateSealedParams(input.params, deps.now());
  }

  // SE-2 / SE-3 gating, then the authoritative matched candidate set (step 4).
  const commits = commitsInWindow(
    await deps.readAnchoredCommits(),
    input.params.commitDeadline,
  );
  const reveals = revealsInWindow(await deps.readAnchoredReveals(), input.params);
  const candidates = matchRevealsToCommits(commits, reveals);
  const allBidders = [...new Set(candidates.map((c) => c.reveal.bidderClaim))];

  const selection = selectSealedWinner(candidates, {
    selectionRule: input.params.selectionRule as SelectionRule,
    currency: input.currency,
    reservePrice: input.reservePrice,
    acceptancePredicate: input.acceptancePredicate,
  });

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
