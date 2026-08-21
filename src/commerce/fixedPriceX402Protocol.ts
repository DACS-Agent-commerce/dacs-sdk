import { types as nodeTypes } from "node:util";

import { canonicalize, sha256Hex } from "../canonical/index.js";
import { DacsError } from "../errors.js";
import {
  isCanonicalClaimReference,
  parseCanonicalClaimReference,
} from "../identity/claimReference.js";

/**
 * Exact DACS-Standard revision supported by this coordinator slice. This is
 * intentionally the same immutable revision used by scripts/sync-vectors.mjs.
 * A Standard upgrade is a reviewed SDK change, never counterparty input.
 */
export const FIXED_PRICE_X402_STANDARD_REVISION =
  "965df755aba4ff392f1fb37a93d287242b177ba4" as const;

/** Operational SDK profile; this is not a normative DACS artifact field. */
export const FIXED_PRICE_X402_COMMERCE_PROFILE =
  "dacs-sdk:fixed-price-x402:v1" as const;

export const FIXED_PRICE_X402_REGISTRY_INDEX_REF = "dacs4:registry:v0.1" as const;

export interface FixedPriceX402ProtocolBinding {
  commerceProfile: typeof FIXED_PRICE_X402_COMMERCE_PROFILE;
  standardRevision: typeof FIXED_PRICE_X402_STANDARD_REVISION;
  phase: "pay-x402";
  /** Initial supported topology: the seller is the DACS phase orchestrator. */
  orchestratorTopology: "seller-as-phase-orchestrator-v1";
  orchestrator: string;
  rail: Readonly<{
    registryIndexRef: typeof FIXED_PRICE_X402_REGISTRY_INDEX_REF;
    registryIndexHash: string;
    railDefinitionRef: string;
    railDefinitionHash: string;
    railId: string;
    railVersion: number;
    railType: "x402";
    phaseHandler: "pay-x402";
    network: `eip155:${number}`;
    /** This production coordinator deliberately admits only authoritative live rails. */
    availability: "live";
  }>;
}

const HASH_RE = /^[0-9a-f]{64}$/;
const EIP155_RE = /^eip155:([1-9][0-9]*)$/;

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);
const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      nodeTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
): boolean {
  const allowed = new Set(required);
  return required.every((key) => hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function validNetwork(value: unknown): value is `eip155:${number}` {
  if (typeof value !== "string") return false;
  const match = EIP155_RE.exec(value);
  if (!match) return false;
  const chainId = Number(match[1]);
  return Number.isSafeInteger(chainId) && chainId > 0 && String(chainId) === match[1];
}

export function fixedPriceX402ProtocolBindingViolation(value: unknown): string | null {
  if (!plainRecord(value) || !exactKeys(value, [
    "commerceProfile",
    "standardRevision",
    "phase",
    "orchestratorTopology",
    "orchestrator",
    "rail",
  ])) return "fixed-price x402 protocol binding fields are malformed";
  if (value.commerceProfile !== FIXED_PRICE_X402_COMMERCE_PROFILE ||
      value.standardRevision !== FIXED_PRICE_X402_STANDARD_REVISION ||
      value.phase !== "pay-x402" ||
      value.orchestratorTopology !== "seller-as-phase-orchestrator-v1" ||
      !isCanonicalClaimReference(value.orchestrator)) {
    return "fixed-price x402 protocol profile, revision, phase, or orchestrator is unsupported";
  }
  if (!plainRecord(value.rail) || !exactKeys(value.rail, [
    "registryIndexRef",
    "registryIndexHash",
    "railDefinitionRef",
    "railDefinitionHash",
    "railId",
    "railVersion",
    "railType",
    "phaseHandler",
    "network",
    "availability",
  ])) return "fixed-price x402 rail binding fields are malformed";
  const rail = value.rail;
  if (rail.registryIndexRef !== FIXED_PRICE_X402_REGISTRY_INDEX_REF ||
      typeof rail.registryIndexHash !== "string" || !HASH_RE.test(rail.registryIndexHash) ||
      !nonEmpty(rail.railDefinitionRef) || typeof rail.railDefinitionHash !== "string" ||
      !HASH_RE.test(rail.railDefinitionHash) || !nonEmpty(rail.railId) ||
      !Number.isSafeInteger(rail.railVersion) || (rail.railVersion as number) <= 0 ||
      rail.railType !== "x402" ||
      rail.phaseHandler !== "pay-x402" || !validNetwork(rail.network) ||
      rail.availability !== "live") {
    return "fixed-price x402 rail binding is unsupported or not production-live";
  }
  return null;
}

export function captureFixedPriceX402ProtocolBinding(
  value: unknown,
): FixedPriceX402ProtocolBinding {
  const violation = fixedPriceX402ProtocolBindingViolation(value);
  if (violation) throw new DacsError(violation);
  try {
    return structuredClone(value as FixedPriceX402ProtocolBinding);
  } catch {
    throw new DacsError("fixed-price x402 protocol binding must be structured-cloneable data");
  }
}

export function fixedPriceX402ProtocolBindingHash(
  value: Readonly<FixedPriceX402ProtocolBinding>,
): string {
  const captured = captureFixedPriceX402ProtocolBinding(value);
  // CORE B.1 CF-3: the orchestrator is an actor identity, so advisory
  // ClaimReference parameters cannot split an otherwise exact rail binding.
  return sha256Hex(canonicalize({
    ...captured,
    orchestrator: parseCanonicalClaimReference(captured.orchestrator)!.identity,
  }));
}
