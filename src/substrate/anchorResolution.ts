/**
 * Typed result of resolving a logical program NAME to its storage address for a
 * given writer (#58 / #70). The physical address folds in the writer's create-
 * time nonce, so it can't be recomputed — the name must be resolved through the
 * node's name index. This type keeps a transient lookup failure DISTINCT from a
 * genuine absence, so a substrate hiccup is never read as "the program was never
 * created" (which, on the write path, would create a DUPLICATE, and on the read
 * path would defeat the resume/no-double-pay guard).
 */
export type AnchorResolution =
  | { status: "present"; address: string }
  | { status: "absent" }
  | { status: "indeterminate"; reason: string };

/** One name-index candidate's owner-confirmation outcome (an async read per candidate). */
export interface CandidateOutcome {
  address: string;
  /** The program's owner as read back, or null if the read succeeded but carried none. */
  owner: string | null;
  /** True if the confirming read FAILED (so ownership couldn't be established). */
  error: boolean;
}

/** One readable anchor confirmed as owned by the connected writer. */
export interface OwnedAnchor {
  address: string;
  programName: string;
  value: Record<string, unknown>;
}

/**
 * Fail-closed result of scanning the connected writer's anchors by an exact
 * program-name prefix. An RPC/read failure is never represented as an empty
 * successful result.
 */
export type OwnedAnchorScan =
  | { status: "ok"; anchors: OwnedAnchor[] }
  | { status: "indeterminate"; reason: string };

/**
 * Classify a name resolution from the per-candidate owner-confirmation outcomes.
 *
 *  - `present`       — a candidate is confirmed owned by `expectedOwner`.
 *  - `indeterminate` — no confirmed match, but at least one candidate couldn't be
 *                      read; we cannot rule out that the writer's own program is
 *                      among the unreadable ones, so we must NOT claim absence.
 *  - `absent`        — candidates were all readable and none is the writer's.
 *
 * (The search step itself can also fail; the caller passes that through as an
 * indeterminate before ever reaching this classifier.)
 */
export function classifyAnchorResolution(
  outcomes: CandidateOutcome[],
  expectedOwner: string,
): AnchorResolution {
  // Demos APIs are inconsistent about the cosmetic 0x prefix. Ownership is a
  // byte identity, so compare the canonical hex payload rather than its wire
  // spelling while retaining fail-closed behavior for unreadable candidates.
  const normalizeOwner = (owner: string) =>
    owner.trim().toLowerCase().replace(/^0x/, "");
  const want = normalizeOwner(expectedOwner);
  const matches = outcomes.filter(
    (o) =>
      !o.error &&
      o.owner != null &&
      normalizeOwner(o.owner) === want,
  );
  if (matches.length > 1) {
    return {
      status: "indeterminate",
      reason: "multiple programs with the same name are owned by the expected writer",
    };
  }
  if (outcomes.some((o) => o.error)) {
    return {
      status: "indeterminate",
      reason: "a candidate program could not be read to confirm ownership",
    };
  }
  if (matches.length === 1) {
    return { status: "present", address: matches[0]!.address };
  }
  return { status: "absent" };
}
