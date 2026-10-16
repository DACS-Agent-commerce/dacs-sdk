import { UnsupportedCapabilityError } from "../errors.js";

/**
 * PROFILE at the SDK's d45c0a2 Standard pin has no coordinated JID-1 release.
 * No caller-controlled artifact, option, environment flag or participant label
 * can supply the missing authority. Keep live x402 actions unavailable until a
 * later implementation can authenticate the recorded release and complete
 * module tuple for every participant in the exact session.
 *
 * Offline protocol tests mock this module; there is no production opt-in.
 */
export function requireJid1LiveProfile(): void {
  throw new UnsupportedCapabilityError(
    "Live JID-1 actions are unavailable: the pinned Standard has no coordinated corrective release",
  );
}
