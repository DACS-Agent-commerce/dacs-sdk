/**
 * Steward registries (T12/T13). A registry is an anchored, versioned list of
 * entries — each entry steward-signed under its domain separator. The steward
 * key (PA-2) is the trust root: a rail/recipe is honoured only because the
 * steward signed it, so the SDK pins the steward public key and rejects any
 * entry whose signature doesn't verify (recipe-poisoning is the headline
 * threat). Registries are append-only: a published entry version is never
 * mutated, only superseded.
 */

import type {
  CompleteParserSpec,
  ParserSpec,
} from "../agent/parserSpec.js";

/**
 * §9.4.4 / §7.4.5 availability values — the CLOSED spec set (issue #5: the
 * previous `live|deprecated|planned` trio was an SDK invention; `mocked` in
 * particular must be expressible so RAV-3 can treat it as `error`). Resolution
 * gates on exactly `"live"` (registry/resolve.ts), so every other value stays
 * fail-closed by construction.
 */
export type Availability =
  | "live"
  | "operator_gated"
  | "closed_data"
  | "bilateral"
  | "mocked"
  | "disabled"
  | "failed";

/** A payment-rail descriptor (steward-signed under `dacs-rail:v1:`). */
export interface RailDescriptor {
  id: string;
  /** Dispatch type the SDK switches on (x402, evm-erc20, …). */
  kind: string;
  availability: Availability;
  /** Rail-type static config (e.g. supported networks, facilitator). */
  params: Record<string, unknown>;
}

interface RecipeDescriptorBase {
  id: string;
  /** Verification method the recipe drives (self-signed, consensus-backed-proxy, …). */
  method: string;
  availability: Availability;
  params: Record<string, unknown>;
}

/**
 * A verification-recipe descriptor (steward-signed under `dacs-recipe:v1:`).
 * Negative-match recipes are completeness-gated by construction: omitting the
 * signed PSP-5 basis is a type error and registry resolution rejects it at runtime.
 */
export type RecipeDescriptor = RecipeDescriptorBase &
  (
    | {
        /** PSP-2: presence means "listed", so the match outcome is inverted. */
        negativeMatch: true;
        /** PSP-1..5 parser rules, including the required completeness basis. */
        parserRules: CompleteParserSpec;
      }
    | {
        negativeMatch?: false;
        /**
         * DACS-2 §7.4.1 ParserSpec — signed deterministic response rules.
         * Required at runtime for `consensus-backed-proxy` recipes.
         */
        parserRules?: ParserSpec;
      }
  );

/** An anchored registry document: a versioned list of steward-signed entries. */
export interface Registry<T> {
  registryId: string;
  version: string;
  entries: Array<T & { signature: string }>;
}
