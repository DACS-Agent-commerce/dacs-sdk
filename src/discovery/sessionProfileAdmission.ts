import { snapshotCanonicalJsonRead } from "../canonical/snapshot.js";
import { canonicalize } from "../canonical/index.js";
import { DacsError, IndeterminateSubstrateError } from "../errors.js";
import { isCanonicalClaimReference, sameCanonicalClaimIdentity } from "../identity/claimReference.js";
import { requireCanonicalJobId } from "../negotiate/jobId.js";
import { DACS_STANDARD_PIN } from "../version.js";
import { DACS_STANDARD_PROFILE_STATUS } from "./standardProfileRelease.js";

export { DACS_STANDARD_PROFILE_STATUS, type DacsStandardProfileStatus } from "./standardProfileRelease.js";

/**
 * CORE §11.1.2 module tuple at `DACS_STANDARD_PIN`. At that pin PROFILE.md
 * lists this tuple as the unreleased JID-1 corrective candidate, which is not
 * an admissible live profile until a coordinated release records its tag or
 * merge commit. Admission refuses it until then (`DACS_STANDARD_PROFILE_STATUS`);
 * move the pin to the release identifier when it is cut.
 */
export const COMPLETED_SESSION_MODULE_VERSIONS = Object.freeze({
  core: "0.3", dacs1: "0.7", dacs2: "0.6", dacs3: "0.5", dacs4: "0.8", dacs5: "0.5",
} as const);

/** Verifier-owned deployment authority, independent of the session's wire artifacts. */
export type AuthenticateSessionProfile = () => Promise<unknown> | unknown;
type Role = "buyer" | "seller" | "orchestrator";
type Roles = Partial<Record<Role, string>>;

/**
 * Refuse every admission while the pinned profile is unreleased. This is a
 * fact of the pinned Standard, so no authority reply or deployment label can
 * open it.
 */
function requireReleasedStandardProfile(): void {
  if (DACS_STANDARD_PROFILE_STATUS !== "released") {
    throw new DacsError(`the DACS Standard profile at ${DACS_STANDARD_PIN} is an unreleased candidate ` +
      "and is not an admissible live session profile");
  }
}

/**
 * Validate an independently authenticated exact pin, profile status and session
 * role map. Every admission path (resolver, completion gates, live graphs,
 * publication) goes through this one check, which refuses everything while the
 * pinned profile is unreleased.
 */
export function requireAuthenticatedSessionProfile(
  source: unknown,
  expected: Readonly<{ jobId: string; buyer?: string; seller?: string }>,
  requestedRole?: Role,
): Readonly<Roles> {
  requireCanonicalJobId(expected.jobId, "profile admission jobId");
  requireReleasedStandardProfile();
  const admission = snapshotCanonicalJsonRead(source, "trusted session profile admission") as Record<string, unknown>;
  const reject = (): never => { throw new DacsError("session profile admission lacks authenticated role authority"); };
  if (admission !== null && typeof admission === "object" && !Array.isArray(admission) &&
      admission.status === "valid" && admission.profileStatus !== DACS_STANDARD_PROFILE_STATUS) {
    throw new DacsError(`session profile admission does not state the pinned Standard profile status "${
      DACS_STANDARD_PROFILE_STATUS}"`);
  }
  if (admission === null || typeof admission !== "object" || Array.isArray(admission) ||
      Object.keys(admission).sort().join() !== "moduleVersions,profileStatus,releasePin,roles,status" ||
      admission.status !== "valid" || admission.releasePin !== DACS_STANDARD_PIN ||
      canonicalize(admission.moduleVersions) !== canonicalize(COMPLETED_SESSION_MODULE_VERSIONS) ||
      !Array.isArray(admission.roles) || (requestedRole === undefined
        ? admission.roles.length !== 2 : admission.roles.length < 1 || admission.roles.length > 3)) return reject();
  const parties = {} as Roles;
  for (const raw of admission.roles) {
    const entry = raw as Record<string, unknown>;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).sort().join() !== "jobId,participant,role" ||
        !["buyer", "seller", "orchestrator"].includes(entry.role as string) ||
        (requestedRole === undefined && entry.role === "orchestrator") ||
        Object.hasOwn(parties, entry.role as string) ||
        entry.jobId !== expected.jobId || !isCanonicalClaimReference(entry.participant)) return reject();
    const role = entry.role as Role;
    const expectedParticipant = role === "orchestrator" ? undefined : expected[role];
    if (expectedParticipant !== undefined && !sameCanonicalClaimIdentity(entry.participant, expectedParticipant)) return reject();
    parties[role] = entry.participant;
  }
  if (requestedRole === undefined ? parties.buyer === undefined || parties.seller === undefined
    : parties[requestedRole] === undefined) return reject();
  return Object.freeze(parties);
}

/** Bound admission before any address derivation, discovery or protocol effect. */
export async function authenticateSessionProfile(
  authenticate: AuthenticateSessionProfile | undefined,
  expected: Readonly<{ jobId: string; buyer?: string; seller?: string }>,
  requestedRole?: Role,
): Promise<Readonly<Roles>> {
  requireCanonicalJobId(expected.jobId, "profile admission jobId");
  requireReleasedStandardProfile();
  if (typeof authenticate !== "function") throw new DacsError("session profile admission requires independent authority");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(authenticate),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new IndeterminateSubstrateError("session profile admission timed out")), 60_000);
        timer.unref?.();
      }),
    ]);
    return requireAuthenticatedSessionProfile(result, expected, requestedRole);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
