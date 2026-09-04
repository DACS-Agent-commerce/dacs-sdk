import type { BundlePhaseErrorClass } from "../artifacts/types.js";
import type { SessionOutcome } from "./reputationDerivation.js";

/** DACS-5 §10.3.1 session states, distinct from SR-2 transaction finality. */
export type Dacs5SessionState =
  | "draft"
  | "vet-pending"
  | "vet-completed"
  | "vet-failed"
  | "negotiate-pending"
  | "negotiate-completed"
  | "negotiate-failed"
  | "commit-pending"
  | "commit-completed"
  | "commit-failed"
  | "settle-pending"
  | "settle-asymmetric"
  | "settle-completed"
  | "settle-failed"
  | "rate-pending"
  | "rate-completed"
  | "audit-pending"
  | "finalised"
  | "aborted-by-self"
  | "aborted-by-other"
  | "substrate-failure-paused"
  | "failed-substrate";

export type Dacs5ResumableSessionState =
  | "vet-pending"
  | "negotiate-pending"
  | "commit-pending"
  | "settle-pending"
  | "settle-asymmetric"
  | "audit-pending";

export interface Dacs5SessionTransitionContext {
  /** ST-7 state recorded when entering a substrate-failure pause. */
  pausedFrom?: Dacs5ResumableSessionState;
  /**
   * ST-3 permits a settle-stage abort only before payment/delivery becomes
   * irreversible. It must be supplied explicitly for that conditional edge.
   */
  settlementIrreversible?: boolean;
}

const RESUMABLE = new Set<Dacs5SessionState>([
  "vet-pending",
  "negotiate-pending",
  "commit-pending",
  "settle-pending",
  "settle-asymmetric",
  "audit-pending",
]);

const NEXT: Readonly<Partial<Record<Dacs5SessionState, ReadonlySet<Dacs5SessionState>>>> = {
  draft: new Set(["vet-pending"]),
  "vet-pending": new Set([
    "vet-completed",
    "vet-failed",
    "aborted-by-self",
    "aborted-by-other",
  ]),
  "vet-completed": new Set(["negotiate-pending"]),
  "negotiate-pending": new Set([
    "negotiate-completed",
    "negotiate-failed",
    "aborted-by-self",
    "aborted-by-other",
  ]),
  "negotiate-completed": new Set(["commit-pending"]),
  "commit-pending": new Set([
    "commit-completed",
    "commit-failed",
    "aborted-by-self",
    "aborted-by-other",
  ]),
  "commit-completed": new Set(["settle-pending"]),
  "settle-pending": new Set([
    "settle-completed",
    "settle-asymmetric",
    "settle-failed",
    "aborted-by-self",
    "aborted-by-other",
  ]),
  "settle-asymmetric": new Set(["settle-completed", "settle-failed"]),
  "settle-completed": new Set(["rate-pending", "audit-pending"]),
  "rate-pending": new Set(["rate-completed", "audit-pending"]),
  "rate-completed": new Set(["audit-pending"]),
  "audit-pending": new Set(["finalised"]),
};

/**
 * DACS-5 ST-1/ST-7 exact transition-table predicate.
 *
 * A pause or resume is accepted only with the exact persisted `pausedFrom`
 * state. This prevents the table's one backward edge from becoming a generic
 * escape to a different pending phase.
 */
export function isDacs5SessionTransitionAllowed(
  from: Dacs5SessionState,
  to: Dacs5SessionState,
  context: Readonly<Dacs5SessionTransitionContext> = {},
): boolean {
  if (
    from === "settle-pending" &&
    (to === "aborted-by-self" || to === "aborted-by-other")
  ) {
    return context.settlementIrreversible === false;
  }
  if (to === "substrate-failure-paused") {
    return RESUMABLE.has(from) && context.pausedFrom === from;
  }
  if (from === "substrate-failure-paused") {
    return (
      context.pausedFrom !== undefined &&
      RESUMABLE.has(context.pausedFrom) &&
      (to === context.pausedFrom || to === "failed-substrate")
    );
  }
  return (
    Object.prototype.hasOwnProperty.call(NEXT, from) &&
    NEXT[from]?.has(to) === true
  );
}

/** DACS-5 §10.3.1 terminal-state → bundle-outcome projection. */
export function dacs5BundleOutcomeForTerminalState(
  state: Dacs5SessionState,
  errorClass?: BundlePhaseErrorClass,
): SessionOutcome | null {
  if (state === "finalised") {
    return errorClass === undefined ? "completed" : null;
  }
  if (state === "aborted-by-self" || state === "aborted-by-other") {
    return errorClass === undefined ? state : null;
  }
  if (state === "failed-substrate") {
    return errorClass === "substrate" ? "failed-substrate" : null;
  }
  if (
    state !== "vet-failed" &&
    state !== "negotiate-failed" &&
    state !== "commit-failed" &&
    state !== "settle-failed"
  ) {
    return null;
  }
  if (errorClass === "permanent" || errorClass === "transient") {
    return "failed-perm";
  }
  if (errorClass === "counterparty" || errorClass === "settlement-atomicity") {
    return "failed-counterparty";
  }
  return null;
}
