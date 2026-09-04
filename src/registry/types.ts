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
  PhaseType,
  VerificationMethodKind,
} from "../artifacts/types.js";

/**
 * §9.4.4 / §7.4.5 availability values — the CLOSED spec set (issue #5: the
 * previous `live|deprecated|planned` trio was an SDK invention). Resolution
 * preserves the authenticated value; point-of-use policy applies DACS-4
 * RAV-R1..RAV-R5 and the corresponding DACS-2 recipe rules.
 */
export type Availability =
  | "live"
  | "operator_gated"
  | "closed_data"
  | "bilateral"
  | "mocked"
  | "disabled"
  | "failed";

/** DACS-4 §9.4.1 closed rail types. */
export type RailType =
  | "evm-erc20"
  | "solana-spl"
  | "cross-chain-htlc"
  | "cross-chain-liquidity-tank"
  | "ap2"
  | "x402"
  | "demos-native";

/** DACS-4 §9.4.1 cross-chain route. */
export interface CrossChainRoute {
  sourceChainId: number | string;
  destChainId: number | string;
  htlcContracts?: { source: string; dest: string };
  liquidityTankIds?: string[];
}

/** DACS-4 §9.4.1 asset definition. */
export type AssetSpec =
  | {
      kind: "erc20";
      chainId: number;
      contract: string;
      symbol: string;
      decimals: number;
    }
  | {
      kind: "spl";
      cluster: "mainnet" | "devnet" | "testnet";
      mint: string;
      symbol: string;
      decimals: number;
    }
  | { kind: "native-evm"; chainId: number; symbol: string; decimals: number }
  | {
      kind: "native-solana";
      cluster: "mainnet" | "devnet" | "testnet";
      symbol: "SOL";
      decimals: 9;
    }
  | { kind: "native-dem"; symbol: "DEM"; decimals: 9 }
  | { kind: "fiat-via-ap2"; isoCurrency: string; provider: string }
  | {
      kind: "stablecoin-cross-chain";
      canonicalSymbol: string;
      routes: CrossChainRoute[];
    };

/** DACS-4 §9.4.1 settlement network definition. */
export type NetworkSpec =
  | {
      kind: "evm";
      chainId: number;
      rpcAttestation: "consensus-backed-proxy" | "evm-rpc";
    }
  | { kind: "solana"; cluster: "mainnet" | "devnet" | "testnet" }
  | { kind: "demos" }
  | { kind: "ap2-provider"; providerEndpoint: string }
  | { kind: "x402-resource"; resourceBaseUrl: string }
  | {
      kind: "cross-chain";
      mechanism: "htlc" | "liquidity-tank" | "substrate-native";
    };

/** DACS-4 §9.4.1 rail governance record. */
export interface RailGovernance {
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

/**
 * Exact DACS-4 §9.4.1 steward-signed rail definition. This is the signed wire
 * record; producer APIs additionally require resolver provenance at runtime.
 */
export interface RailDefinition {
  railVersion: number;
  railId: string;
  railType: RailType;
  asset: AssetSpec;
  network: NetworkSpec;
  phaseHandler: PhaseType;
  parameters: Record<string, unknown>;
  availability: Availability;
  governance: RailGovernance;
  signature: ComponentSignature;
}

/** DACS-4 §9.4.3 rail selection pinned at session start. */
export interface RailSelector {
  railId: string;
  /** Omit to select and pin the latest registry version at session start. */
  railVersion?: number;
}

/** @deprecated Use {@link RailDefinition}. */
export type RailDescriptor = RailDefinition;

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
