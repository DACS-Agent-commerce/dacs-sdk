/**
 * Steward registries (T12/T13). A registry is an anchored, versioned list of
 * entries — each entry steward-signed under its domain separator. The steward
 * key (PA-2) is the trust root: a rail/recipe is honoured only because the
 * steward signed it, so the SDK pins the steward public key and rejects any
 * entry whose signature doesn't verify (recipe-poisoning is the headline
 * threat). Registries are append-only: a published entry version is never
 * mutated, only superseded.
 */

import type { ParserSpec } from "../agent/parserSpec.js";

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
  /**
   * DACS-2 §7.4.1 ParserSpec — the signed rules a `consensus-backed-proxy`
   * applies to the attested body (PSP-1..5), so the content verdict is
   * deterministic from the recipe rather than a caller callback.
   */
  parserRules?: ParserSpec;
  /** PSP-2: a match means "listed" — invert the outcome (e.g. ofac-clear). */
  negativeMatch?: boolean;
  /**
   * PSP-5: this negative-match recipe decides on ABSENCE from a full-list
   * download, so a `pass` requires a provably-complete response (else
   * `indeterminate`). Only meaningful with `negativeMatch: true`.
   */
  requiresListCompleteness?: boolean;
}

/** An anchored registry document: a versioned list of steward-signed entries. */
export interface Registry<T> {
  registryId: string;
  version: string;
  entries: Array<T & { signature: string }>;
}
