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
  type DemandSealedEnvelopeParams,
  type PriceTerm,
  type ProcurementSealedEnvelopeParams,
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
 * sealed-bid primitives into the phase handler a listing-publisher orchestrator
 * runs after the reveal window closes: gate commits (SE-2) + reveals (SE-3),
 * build the authoritative anchored candidate set, select the winner, and hand
 * the winning bid plus resolved SE-8 roles to the injected `commitAgreement`
 * (which builds/signs/anchors the AgreementDocument — kept out of here so this
 * stays substrate-agnostic and testable, exactly like runSessionCore's injected
 * settle/anchor).
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

/** The two sealed-envelope phase kinds defined by DACS-3 §8.4.3 / SE-8. */
export type SealedEnvelopePhaseKind =
  | "negotiate-sealed-envelope"
  | "negotiate-sealed-envelope-procurement";

export type SealedEnvelopeAuctionMode = "demand" | "procurement";

export const DEMAND_SEALED_ENVELOPE_PHASE = "negotiate-sealed-envelope" as const;
export const PROCUREMENT_SEALED_ENVELOPE_PHASE =
  "negotiate-sealed-envelope-procurement" as const;

export type SealedEnvelopeModeResolution =
  | {
      ok: true;
      phaseKind: SealedEnvelopePhaseKind;
      auctionMode: SealedEnvelopeAuctionMode;
    }
  | {
      ok: false;
      failedAt: "auctionMode";
      reason: "unresolvable-auctionMode";
    };

/**
 * Resolve the pinned phase kind + mode without inference (SE-8).
 *
 * Demand accepts an absent marker or the exact string `demand`. Procurement is
 * a separate phase and requires the exact string `procurement`. Every other
 * combination is unresolvable and MUST be rejected rather than defaulted.
 */
export function resolveSealedEnvelopeMode(
  phaseKind: unknown,
  auctionMode: unknown,
): SealedEnvelopeModeResolution {
  // Only true absence gets the backwards-compatible demand default. A present
  // malformed value such as null must not be collapsed into that safe-looking
  // branch.
  const kind =
    phaseKind === undefined ? DEMAND_SEALED_ENVELOPE_PHASE : phaseKind;
  if (
    kind === DEMAND_SEALED_ENVELOPE_PHASE &&
    (auctionMode === undefined || auctionMode === "demand")
  ) {
    return {
      ok: true,
      phaseKind: DEMAND_SEALED_ENVELOPE_PHASE,
      auctionMode: "demand",
    };
  }
  if (
    kind === PROCUREMENT_SEALED_ENVELOPE_PHASE &&
    auctionMode === "procurement"
  ) {
    return {
      ok: true,
      phaseKind: PROCUREMENT_SEALED_ENVELOPE_PHASE,
      auctionMode: "procurement",
    };
  }
  return {
    ok: false,
    failedAt: "auctionMode",
    reason: "unresolvable-auctionMode",
  };
}

export interface SealedAgreementParty {
  claim: string;
  role: "buyer" | "seller" | "bidder-non-winning";
  signatureRequired: boolean;
}

/** The role assignment that agreement construction and commit validation share. */
export interface SealedAgreementRoleAssignment {
  phaseKind: SealedEnvelopePhaseKind;
  auctionMode: SealedEnvelopeAuctionMode;
  buyer: string;
  seller: string;
  /** Agreement buyer + seller, in agreement-role order. */
  requiredSignerClaims: [string, string];
  parties: SealedAgreementParty[];
}

/**
 * Assign agreement roles from the pinned phase (SE-8). The bid price is payable
 * from the returned `buyer` to `seller`; selectionRule never determines roles.
 */
export function assignSealedEnvelopeRoles(input: {
  phaseKind?: unknown;
  auctionMode?: unknown;
  listingPublisher: string;
  winningBidderClaim: string;
  losingBidderClaims?: string[];
}): SealedAgreementRoleAssignment {
  const resolved = resolveSealedEnvelopeMode(
    input.phaseKind,
    input.auctionMode,
  );
  if (!resolved.ok) {
    throw new DacsError(resolved.reason);
  }

  const buyer =
    resolved.auctionMode === "procurement"
      ? input.listingPublisher
      : input.winningBidderClaim;
  const seller =
    resolved.auctionMode === "procurement"
      ? input.winningBidderClaim
      : input.listingPublisher;

  return {
    ...resolved,
    buyer,
    seller,
    requiredSignerClaims: [buyer, seller],
    parties: [
      { claim: buyer, role: "buyer", signatureRequired: true },
      { claim: seller, role: "seller", signatureRequired: true },
      ...(input.losingBidderClaims ?? []).map((claim) => ({
        claim,
        role: "bidder-non-winning" as const,
        signatureRequired: false,
      })),
    ],
  };
}

/** Context the injected agreement builder needs to construct the AgreementDocument. */
export interface SealedWinnerContext {
  jobId: string;
  /**
   * @deprecated This is the listing publisher, not necessarily the agreement
   * seller. Use `listingPublisher` / `agreementSeller` for mode-safe code.
   */
  seller: string;
  /** Listing publisher (seller in demand, buyer in procurement). */
  listingPublisher?: string;
  winningBidderClaim: string;
  winningBid: SealedBid;
  losingBidderClaims: string[];
  /** Defaults to the legacy demand phase when absent. */
  phaseKind?: SealedEnvelopePhaseKind;
  /** Defaults to demand only for the demand phase; required for procurement. */
  auctionMode?: SealedEnvelopeAuctionMode;
  /** Populated by `runSealedEnvelopeCore`; consumers should use these roles. */
  agreementBuyer?: string;
  agreementSeller?: string;
  requiredSignerClaims?: [string, string];
  parties?: SealedAgreementParty[];
}

/** Listing-side context needed to turn a winning bid into an AgreementDocument. */
export interface SealedAgreementContext {
  /** Listing publisher; historical field name retained for compatibility. */
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
 * `derivedFromPattern: sealed-envelope`). SE-8 assigns the winning bidder as
 * buyer for demand and seller for procurement; the listing publisher takes the
 * opposite role. The bid amount is converted to integer base units (matching
 * the SDK's base-unit Price.amount), and is always payable by the resulting
 * agreement buyer to its seller. Pure — the caller signs + anchors it. Throws
 * if the bid amount carries more precision than the rail's token supports.
 */
export function buildSealedAgreement(
  win: SealedWinnerContext,
  ctx: SealedAgreementContext,
): AgreementDocument {
  if (
    win.listingPublisher !== undefined &&
    win.listingPublisher !== ctx.seller
  ) {
    throw new DacsError(
      "sealed-envelope listing publisher does not match the pinned listing context",
    );
  }
  const roles = assignSealedEnvelopeRoles({
    phaseKind: win.phaseKind,
    auctionMode: win.auctionMode,
    listingPublisher: ctx.seller,
    winningBidderClaim: win.winningBidderClaim,
    losingBidderClaims: win.losingBidderClaims,
  });
  const amount = baseUnits(win.winningBid.price.amount, ctx.decimals);
  if (amount === "0") {
    throw new DacsError("winning sealed bid resolves to a zero base-unit amount");
  }
  return {
    jobId: win.jobId,
    pattern: "negotiate-sealed-envelope",
    buyer: roles.buyer,
    seller: roles.seller,
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

export type SealedAgreementRoleValidation =
  | { ok: true; assignment: SealedAgreementRoleAssignment }
  | {
      ok: false;
      failedAt: "auctionMode" | "sealed-envelope-role-direction";
      reason: string;
    };

/**
 * Commit-time SE-8 teeth: validate an agreement against the pinned listing
 * phase before any settlement action is allowed.
 */
export function validateSealedAgreementRoleAssignment(
  agreement: AgreementDocument,
  input: {
    phaseKind?: unknown;
    auctionMode?: unknown;
    listingPublisher: string;
    winningBidderClaim: string;
    losingBidderClaims?: string[];
  },
): SealedAgreementRoleValidation {
  const resolved = resolveSealedEnvelopeMode(
    input.phaseKind,
    input.auctionMode,
  );
  if (!resolved.ok) return resolved;

  const assignment = assignSealedEnvelopeRoles(input);
  if (
    agreement.pattern !== "negotiate-sealed-envelope" ||
    agreement.buyer !== assignment.buyer ||
    agreement.seller !== assignment.seller
  ) {
    return {
      ok: false,
      failedAt: "sealed-envelope-role-direction",
      reason: `sealed-envelope roles do not match ${assignment.phaseKind}: expected buyer=${assignment.buyer}, seller=${assignment.seller}`,
    };
  }
  return { ok: true, assignment };
}

export type SealedAgreementCommitValidation =
  | { ok: true; assignment: SealedAgreementRoleAssignment }
  | {
      ok: false;
      failedAt:
        | "auctionMode"
        | "sealed-envelope-role-direction"
        | "required-signature";
      reason: string;
      missingSigner?: string;
    };

/**
 * Full SE-8 commit gate after cryptographic signature verification. Callers
 * pass the claims whose agreement signatures have already verified; this gate
 * checks that both assigned agreement parties are among them. Non-winning
 * bidders are recorded as parties but are never required signers.
 */
export function validateSealedAgreementForCommit(
  agreement: AgreementDocument,
  input: {
    phaseKind?: unknown;
    auctionMode?: unknown;
    listingPublisher: string;
    winningBidderClaim: string;
    losingBidderClaims?: string[];
    verifiedSignerClaims: Iterable<string>;
  },
): SealedAgreementCommitValidation {
  const roles = validateSealedAgreementRoleAssignment(agreement, input);
  if (!roles.ok) return roles;

  const verified = new Set(input.verifiedSignerClaims);
  const missingSigner = roles.assignment.requiredSignerClaims.find(
    (claim) => !verified.has(claim),
  );
  if (missingSigner) {
    return {
      ok: false,
      failedAt: "required-signature",
      reason: `missing verified agreement signature for ${missingSigner}`,
      missingSigner,
    };
  }
  return roles;
}

/** Fully resolved context passed to the build/sign/commit boundary. */
export interface SealedCommitContext extends SealedWinnerContext {
  listingPublisher: string;
  phaseKind: SealedEnvelopePhaseKind;
  auctionMode: SealedEnvelopeAuctionMode;
  agreementBuyer: string;
  agreementSeller: string;
  requiredSignerClaims: [string, string];
  parties: SealedAgreementParty[];
  /** Run after cryptographic checks and before anchoring or settlement. */
  validateAgreementForCommit: (
    agreement: AgreementDocument,
    verifiedSignerClaims: Iterable<string>,
  ) => SealedAgreementCommitValidation;
}

export interface VerifiedSealedAgreementCommitResult {
  /** The exact agreement that was signed and anchored. */
  agreement: AgreementDocument;
  /** Claims whose agreement signatures were cryptographically verified. */
  verifiedSignerClaims: string[];
  agreementRef: string;
  agreementHash: string;
}

/**
 * Legacy demand-only result retained so existing `negotiate-sealed-envelope`
 * integrations remain source-compatible. Procurement requires the verified
 * form above because SE-8 cannot be enforced from an opaque ref/hash pair.
 */
export interface LegacySealedAgreementCommitResult {
  agreementRef: string;
  agreementHash: string;
  agreement?: never;
  verifiedSignerClaims?: never;
}

export type SealedAgreementCommitResult =
  | VerifiedSealedAgreementCommitResult
  | LegacySealedAgreementCommitResult;

function hasCommitProof(
  result: SealedAgreementCommitResult,
): result is VerifiedSealedAgreementCommitResult {
  return (
    "agreement" in result &&
    result.agreement !== undefined &&
    Array.isArray(result.verifiedSignerClaims)
  );
}

export interface SealedEnvelopeDeps {
  /** The anchored commit set (SR-2), read after commitDeadline. */
  readAnchoredCommits: () => Promise<AnchoredCommit[]>;
  /** The anchored reveal set (SR-2), read after the reveal window closes. */
  readAnchoredReveals: () => Promise<AnchoredReveal[]>;
  /**
   * Build + sign + anchor the AgreementDocument from the winning bid
   * (`derivedFromPattern: "sealed-envelope"`), collecting the agreement buyer
   * + seller signatures. Procurement callers MUST call
   * `ctx.validateAgreementForCommit(...)` after cryptographic verification and
   * before anchoring, then return the agreement and verified signer claims so
   * the core can independently repeat the gate. The legacy opaque ref/hash
   * result remains valid only for the backwards-compatible demand phase.
   */
  commitAgreement: (
    ctx: SealedCommitContext,
  ) => Promise<SealedAgreementCommitResult>;
  /** Fetch an anchored/HTTPS rule by the listing-pinned SE-6 reference. */
  resolveRuleContent?: (ref: Readonly<RuleRef>) => Promise<unknown>;
  /**
   * Deterministic interpreter capability for verified rule content. Unlike the
   * old caller predicate, this can only be invoked by the core with branded,
   * hash-checked content and the fixed authoritative bid set.
   */
  evaluateVerifiedRule?: (input: SealedRuleEvaluationInput) => boolean;
}

interface SealedEnvelopeInputBase {
  jobId: string;
  /** Listing publisher; retained as `seller` for SDK backwards compatibility. */
  seller: string;
  /** The listing-declared currency; bids in any other currency are excluded. */
  currency: string;
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

/**
 * The phase kind and auction mode are correlated at the type level and checked
 * again at runtime for JavaScript / untyped callers.
 */
export type SealedEnvelopeInput = SealedEnvelopeInputBase &
  (
    | {
        phaseKind?: typeof DEMAND_SEALED_ENVELOPE_PHASE;
        params: DemandSealedEnvelopeParams;
      }
    | {
        phaseKind: typeof PROCUREMENT_SEALED_ENVELOPE_PHASE;
        params: ProcurementSealedEnvelopeParams;
      }
  );

export interface SealedEnvelopeResult {
  ok: boolean;
  /** Pinned phase kind; success context must be consumed under this exact key. */
  phaseKind?: SealedEnvelopePhaseKind;
  /** Present on success and equal to `phaseKind` (§8.4.3). */
  contextDeltaKey?: SealedEnvelopePhaseKind;
  auctionMode?: SealedEnvelopeAuctionMode;
  winningBidderClaim?: string;
  agreementRef?: string;
  agreementHash?: string;
  losingBidderClaims: string[];
  /** Set when ok is false — why no winner. */
  reason?: string;
  /** Stable conformance failure location for SE-8 rejection. */
  failedAt?:
    | "auctionMode"
    | "sealed-envelope-role-direction"
    | "required-signature"
    | "agreement-validation";
  missingSigner?: string;
  /** Fault class for a failed phase (§8.4.3 step 6). */
  errorClass?: "counterparty" | "permanent" | "substrate";
  /** The full exclusion log from selection (currency / non-positive / reserve). */
  excluded: Array<{ bidderClaim: string; reason: string }>;
  /** Agreement buyer + seller; non-winning bidders never appear here. */
  requiredSignerClaims?: [string, string];
  parties?: SealedAgreementParty[];
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
  const mode = resolveSealedEnvelopeMode(
    input.phaseKind,
    (input.params as SealedEnvelopeParams & { auctionMode?: unknown }).auctionMode,
  );
  if (!mode.ok) {
    const phaseKind =
      input.phaseKind === DEMAND_SEALED_ENVELOPE_PHASE ||
      input.phaseKind === PROCUREMENT_SEALED_ENVELOPE_PHASE
        ? input.phaseKind
        : undefined;
    return {
      ok: false,
      phaseKind,
      losingBidderClaims: [],
      reason: mode.reason,
      failedAt: mode.failedAt,
      errorClass: "permanent",
      excluded: [],
    };
  }

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
      phaseKind: mode.phaseKind,
      auctionMode: mode.auctionMode,
      losingBidderClaims: allBidders,
      reason,
      errorClass: isStructuralReason(reason) ? "permanent" : "counterparty",
      excluded: selection.excluded,
    };
  }

  const winningBidderClaim = selection.winner.bidderClaim;
  const losingBidderClaims = allBidders.filter((b) => b !== winningBidderClaim);
  const roles = assignSealedEnvelopeRoles({
    ...mode,
    listingPublisher: input.seller,
    winningBidderClaim,
    losingBidderClaims,
  });

  const commitContext: SealedCommitContext = {
    jobId: input.jobId,
    seller: input.seller,
    listingPublisher: input.seller,
    winningBidderClaim,
    winningBid: selection.winner.bid,
    losingBidderClaims,
    phaseKind: mode.phaseKind,
    auctionMode: mode.auctionMode,
    agreementBuyer: roles.buyer,
    agreementSeller: roles.seller,
    requiredSignerClaims: roles.requiredSignerClaims,
    parties: roles.parties,
    validateAgreementForCommit: (agreement, verifiedSignerClaims) =>
      validateSealedAgreementForCommit(agreement, {
        phaseKind: mode.phaseKind,
        auctionMode: mode.auctionMode,
        listingPublisher: input.seller,
        winningBidderClaim,
        losingBidderClaims,
        verifiedSignerClaims,
      }),
  };
  const committed = await deps.commitAgreement(commitContext);
  if (!hasCommitProof(committed)) {
    if (mode.auctionMode === "procurement") {
      return {
        ok: false,
        phaseKind: mode.phaseKind,
        auctionMode: mode.auctionMode,
        winningBidderClaim,
        losingBidderClaims,
        reason:
          "procurement agreement commit must return the agreement and verified signer claims",
        failedAt: "agreement-validation",
        errorClass: "permanent",
        excluded: selection.excluded,
        requiredSignerClaims: roles.requiredSignerClaims,
        parties: roles.parties,
      };
    }
    return {
      ok: true,
      phaseKind: mode.phaseKind,
      contextDeltaKey: mode.phaseKind,
      auctionMode: mode.auctionMode,
      winningBidderClaim,
      agreementRef: committed.agreementRef,
      agreementHash: committed.agreementHash,
      losingBidderClaims,
      excluded: selection.excluded,
      requiredSignerClaims: roles.requiredSignerClaims,
      parties: roles.parties,
    };
  }
  const commitValidation = commitContext.validateAgreementForCommit(
    committed.agreement,
    committed.verifiedSignerClaims,
  );
  if (!commitValidation.ok) {
    return {
      ok: false,
      phaseKind: mode.phaseKind,
      auctionMode: mode.auctionMode,
      winningBidderClaim,
      losingBidderClaims,
      reason: commitValidation.reason,
      failedAt: commitValidation.failedAt,
      missingSigner: commitValidation.missingSigner,
      errorClass: "permanent",
      excluded: selection.excluded,
      requiredSignerClaims: roles.requiredSignerClaims,
      parties: roles.parties,
    };
  }

  return {
    ok: true,
    phaseKind: mode.phaseKind,
    contextDeltaKey: mode.phaseKind,
    auctionMode: mode.auctionMode,
    winningBidderClaim,
    agreementRef: committed.agreementRef,
    agreementHash: committed.agreementHash,
    losingBidderClaims,
    excluded: selection.excluded,
    requiredSignerClaims: roles.requiredSignerClaims,
    parties: roles.parties,
  };
}
