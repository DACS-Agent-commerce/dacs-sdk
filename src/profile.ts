import { types as nodeTypes } from "node:util";
import { DacsError, UnsupportedCapabilityError } from "./errors.js";
import { DACS_STANDARD_PIN } from "./version.js";

/** Trusted local execution policy; artifact fields never select this mode. */
export interface ProfileExecutionPolicy {
  executionMode?: "live" | "simulation";
}

/** PROFILE.md at the SDK's immutable oracle pin declares this unreleased. */
export const CORRECTIVE_PROFILE = Object.freeze({
  specificationCommit: DACS_STANDARD_PIN,
  coordinatedRelease: null,
  documents: Object.freeze({
    CORE: "0.3", "DACS-1": "0.7", "DACS-2": "0.6",
    "DACS-3": "0.5", "DACS-4": "0.8", "DACS-5": "0.5",
  }),
});

/** Capture policy without invoking caller accessors or proxy traps. */
export function captureExecutionMode(policy: ProfileExecutionPolicy): "live" | "simulation" {
  if (policy === null || typeof policy !== "object" || nodeTypes.isProxy(policy)) {
    throw new DacsError("profile execution policy must be stable data");
  }
  const descriptor = Object.getOwnPropertyDescriptor(policy, "executionMode");
  if (descriptor) {
    if (!("value" in descriptor)) throw new DacsError("profile execution mode must be stable data");
    if (descriptor.value === undefined || descriptor.value === "live") return "live";
    if (descriptor.value === "simulation") return "simulation";
    throw new DacsError("profile execution mode must be live or simulation");
  }
  return "live";
}

/**
 * No live profile can be admitted at this pin, even with matching participant
 * assertions. Enabling a future release also requires an authenticated,
 * session/participant-bound admission mechanism; changing a pin alone is insufficient.
 * Simulation is explicit trusted local policy for injected, non-live dependencies.
 */
export function requireAdmissibleProfile(policy: ProfileExecutionPolicy): void {
  if (captureExecutionMode(policy) === "simulation") return;
  throw new UnsupportedCapabilityError(
    "the pinned JID-1 corrective profile is unreleased; live protocol action is unavailable " +
    "until a coordinated release and authenticated session/participant profile admission are implemented",
  );
}
