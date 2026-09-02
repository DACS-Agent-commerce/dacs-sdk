import { types as nodeTypes } from "node:util";

import { canonicalize, sha256Hex } from "../canonical/index.js";
import { DacsError } from "../errors.js";
import {
  isCanonicalClaimReference,
  parseCanonicalClaimReference,
} from "../identity/claimReference.js";
import { DACS_STANDARD_PIN } from "../version.js";

/**
 * Exact DACS-Standard revision supported by this coordinator slice. This is
 * intentionally the same immutable revision used by scripts/sync-vectors.mjs.
 * A Standard upgrade is a reviewed SDK change, never counterparty input.
 */
export const FIXED_PRICE_PAY_DEM_STANDARD_REVISION = DACS_STANDARD_PIN;

/** Operational SDK profile; this is not a normative DACS artifact field. */
export const FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE =
  "dacs-sdk:fixed-price-pay-dem:v1" as const;

export const FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF =
  "dacs4:registry:v0.1" as const;

export interface FixedPricePayDemProtocolBinding {
  commerceProfile: typeof FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE;
  standardRevision: typeof FIXED_PRICE_PAY_DEM_STANDARD_REVISION;
  phase: "pay-dem";
  /** The seller remains the DACS phase orchestrator; the buyer owns payment. */
  orchestratorTopology: "seller-as-phase-orchestrator-v1";
  orchestrator: string;
  rail: Readonly<{
    registryIndexRef: typeof FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF;
    registryIndexHash: string;
    railDefinitionRef: string;
    railDefinitionHash: string;
    railId: string;
    railVersion: number;
    railType: "demos-native";
    phaseHandler: "pay-dem";
    network: "demos";
    availability: "live";
  }>;
}

const HASH_RE = /^[0-9a-f]{64}$/;

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.trim() === value && !value.includes("\0");
}

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

export function fixedPricePayDemProtocolBindingViolation(value: unknown): string | null {
  if (!plainRecord(value) || !exactKeys(value, [
    "commerceProfile",
    "standardRevision",
    "phase",
    "orchestratorTopology",
    "orchestrator",
    "rail",
  ])) return "fixed-price pay-dem protocol binding fields are malformed";
  if (value.commerceProfile !== FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE ||
      value.standardRevision !== FIXED_PRICE_PAY_DEM_STANDARD_REVISION ||
      value.phase !== "pay-dem" ||
      value.orchestratorTopology !== "seller-as-phase-orchestrator-v1" ||
      !isCanonicalClaimReference(value.orchestrator)) {
    return "fixed-price pay-dem protocol profile, revision, phase, or orchestrator is unsupported";
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
  ])) return "fixed-price pay-dem rail binding fields are malformed";
  const rail = value.rail;
  if (rail.registryIndexRef !== FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF ||
      typeof rail.registryIndexHash !== "string" || !HASH_RE.test(rail.registryIndexHash) ||
      !nonEmpty(rail.railDefinitionRef) ||
      typeof rail.railDefinitionHash !== "string" ||
      !HASH_RE.test(rail.railDefinitionHash) || !nonEmpty(rail.railId) ||
      !Number.isSafeInteger(rail.railVersion) || (rail.railVersion as number) <= 0 ||
      rail.railType !== "demos-native" || rail.phaseHandler !== "pay-dem" ||
      rail.network !== "demos" || rail.availability !== "live") {
    return "fixed-price pay-dem rail binding is unsupported or not production-live";
  }
  return null;
}

export function captureFixedPricePayDemProtocolBinding(
  value: unknown,
): FixedPricePayDemProtocolBinding {
  const violation = fixedPricePayDemProtocolBindingViolation(value);
  if (violation) throw new DacsError(violation);
  try {
    return structuredClone(value as FixedPricePayDemProtocolBinding);
  } catch {
    throw new DacsError(
      "fixed-price pay-dem protocol binding must be structured-cloneable data",
    );
  }
}

export function fixedPricePayDemProtocolBindingHash(
  value: Readonly<FixedPricePayDemProtocolBinding>,
): string {
  const captured = captureFixedPricePayDemProtocolBinding(value);
  return sha256Hex(canonicalize({
    ...captured,
    orchestrator: parseCanonicalClaimReference(captured.orchestrator)!.identity,
  }));
}
