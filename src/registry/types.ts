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
import type {
  ComponentSignature,
  VerificationMethodKind,
} from "../artifacts/types.js";

/**
 * §9.4.4 / §7.4.5 availability values — the CLOSED spec set (issue #5: the
 * previous `live|deprecated|planned` trio was an SDK invention; `mocked` in
 * particular must be expressible so RAV-3 can treat it as `error`). Rail
 * execution gates on exactly `"live"`; recipe resolution deliberately preserves
 * the authenticated value so RAV-2 can disclose it and RAV-3 can recompute an
 * effective `error` for mocked/disabled/failed evidence.
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

/** DACS-2 §7.4.1 closed verification-method configuration union. */
export type VerificationMethod =
  | {
      kind: "verifiable-credential";
      issuerAllowList?: string[];
      schemaUrl?: string;
    }
  | { kind: "tlsnotary"; endpoint: string; sessionTemplate?: string }
  | { kind: "zktls"; provider: string; programId: string }
  | {
      kind: "consensus-backed-proxy";
      endpoint: {
        method: "GET" | "POST";
        urlTemplate: string;
        headers?: Record<string, string>;
        body?: string;
      };
    }
  | {
      kind: "oauth-attested";
      provider: string;
      scopes: string[];
      maxTokenAgeSec: number;
    }
  | {
      kind: "evm-rpc";
      chainId: number;
      contract: string;
      method: string;
      args?: unknown[];
    }
  | {
      kind: "domain-tls-control";
      challengeType: "http-01" | "dns-01" | "tls-alpn-01";
    }
  | { kind: "self-signed" }
  | { kind: "demos-gcr-domain" };

export interface RecipeGovernance {
  proposedBy: string;
  acceptedAt: number;
  supersedes?: number;
  anchoring: "in-code" | "single-signer" | "multisig";
  emergency?: {
    isEmergency: true;
    failureObservation: string;
  };
  deprecated?: boolean;
  deprecationReason?: string;
}

/** A normative DACS-2 §7.4.1 recipe (signature added by Registry<T>). */
export interface RecipeDescriptor {
  recipeVersion: number;
  scheme: string;
  defaultMethod: VerificationMethod;
  alternatives?: VerificationMethod[];
  defaultMaxAgeSec: number;
  parserRules: ParserSpec;
  negativeMatch?: boolean;
  retryClass: "transient" | "permanent";
  retryOnIndeterminate?: boolean;
  retryBudget?: number;
  backoff?: { strategy: "exponential" | "fixed"; baseMs?: number };
  availability: Availability;
  governance: RecipeGovernance;
}

/** Exact recipe family/version selector used during authenticated resolution. */
export interface RecipeSelector {
  scheme: string;
  method: VerificationMethodKind;
  /** Exact version pinned by the session-start registry selection. */
  recipeVersion: number;
}

/** An anchored registry document: a versioned list of steward-signed entries. */
export interface Registry<T> {
  registryId: string;
  version: string;
  entries: Array<T & { signature: ComponentSignature }>;
}
