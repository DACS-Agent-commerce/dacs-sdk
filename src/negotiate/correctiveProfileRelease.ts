import { DacsError } from "../errors.js";

/** Immutable source of the implemented, still unreleased JID-1 candidate. */
export const CORRECTIVE_PROFILE_CANDIDATE_PIN = "d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20";

/**
 * PROFILE.md at the pin above records no admissible coordinated JID-1 release.
 * CORE §11.1.2(3) does not permit a caller-selected resolver or profile label to
 * change this. There is deliberately no runtime override or test-mode option.
 * A future coordinated release needs orchestrator-owned, session/participant
 * admission at these boundaries before this policy can be enabled.
 */
export function requireReleasedCorrectiveProfile(): void {
  throw new DacsError("DACS corrective profile is not released; live JID-1 protocol action is unavailable");
}
