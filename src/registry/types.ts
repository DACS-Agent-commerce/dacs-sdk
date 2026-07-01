/**
 * Steward registries (T12/T13). A registry is an anchored, versioned list of
 * entries — each entry steward-signed under its domain separator. The steward
 * key (PA-2) is the trust root: a rail/recipe is honoured only because the
 * steward signed it, so the SDK pins the steward public key and rejects any
 * entry whose signature doesn't verify (recipe-poisoning is the headline
 * threat). Registries are append-only: a published entry version is never
 * mutated, only superseded.
 */

export type Availability = "live" | "deprecated" | "planned";

/** A payment-rail descriptor (steward-signed under `dacs-rail:v1:`). */
export interface RailDescriptor {
  id: string;
  /** Dispatch type the SDK switches on (x402, evm-erc20, …). */
  kind: string;
  availability: Availability;
  /** Rail-type static config (e.g. supported networks, facilitator). */
  params: Record<string, unknown>;
}

/** A verification-recipe descriptor (steward-signed under `dacs-recipe:v1:`). */
export interface RecipeDescriptor {
  id: string;
  /** Verification method the recipe drives (self-signed, consensus-backed-proxy, …). */
  method: string;
  availability: Availability;
  params: Record<string, unknown>;
}

/** An anchored registry document: a versioned list of steward-signed entries. */
export interface Registry<T> {
  registryId: string;
  version: string;
  entries: Array<T & { signature: string }>;
}
