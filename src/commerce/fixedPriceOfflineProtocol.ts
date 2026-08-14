import { types as nodeTypes } from "node:util";

import { canonicalize, sha256Hex } from "../canonical/index.js";
import { DacsError } from "../errors.js";
import { FIXED_PRICE_X402_STANDARD_REVISION } from "./fixedPriceX402Protocol.js";

/** Exact Standard revision supported by the first deterministic offline profile. */
export const FIXED_PRICE_OFFLINE_STANDARD_REVISION =
  FIXED_PRICE_X402_STANDARD_REVISION;

/** Non-production profile used only by deterministic local quickstarts. */
export const FIXED_PRICE_OFFLINE_COMMERCE_PROFILE =
  "dacs-sdk:fixed-price-offline:v1" as const;

/** Explicit domain used to isolate offline bindings and effect identities. */
export const FIXED_PRICE_OFFLINE_COORDINATOR_DOMAIN =
  "dacs-sdk:fixed-price-offline:coordinator:v1" as const;

/**
 * Operational binding for deterministic offline execution. It is not a DACS
 * artifact and deliberately contains no x402, registry, network, or live-rail
 * claim.
 */
export interface FixedPriceOfflineProtocolBinding {
  commerceProfile: typeof FIXED_PRICE_OFFLINE_COMMERCE_PROFILE;
  standardRevision: typeof FIXED_PRICE_OFFLINE_STANDARD_REVISION;
  mode: "offline";
  orchestratorTopology: "seller-as-phase-orchestrator-v1";
  orchestrator: string;
  settlement: Readonly<{
    adapter: "deterministic-offline";
    version: 1;
    disposition: "mocked";
  }>;
}

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

export function fixedPriceOfflineProtocolBindingViolation(value: unknown): string | null {
  if (!plainRecord(value) || !exactKeys(value, [
    "commerceProfile",
    "standardRevision",
    "mode",
    "orchestratorTopology",
    "orchestrator",
    "settlement",
  ])) return "fixed-price offline protocol binding fields are malformed";
  if (value.commerceProfile !== FIXED_PRICE_OFFLINE_COMMERCE_PROFILE ||
      value.standardRevision !== FIXED_PRICE_OFFLINE_STANDARD_REVISION ||
      value.mode !== "offline" ||
      value.orchestratorTopology !== "seller-as-phase-orchestrator-v1" ||
      !nonEmpty(value.orchestrator)) {
    return "fixed-price offline protocol profile, revision, mode, or orchestrator is unsupported";
  }
  if (!plainRecord(value.settlement) || !exactKeys(value.settlement, [
    "adapter",
    "version",
    "disposition",
  ]) || value.settlement.adapter !== "deterministic-offline" ||
      value.settlement.version !== 1 || value.settlement.disposition !== "mocked") {
    return "fixed-price offline settlement binding is unsupported";
  }
  return null;
}

export function captureFixedPriceOfflineProtocolBinding(
  value: unknown,
): FixedPriceOfflineProtocolBinding {
  const violation = fixedPriceOfflineProtocolBindingViolation(value);
  if (violation) throw new DacsError(violation);
  try {
    return structuredClone(value as FixedPriceOfflineProtocolBinding);
  } catch {
    throw new DacsError("fixed-price offline protocol binding must be structured-cloneable data");
  }
}

export function fixedPriceOfflineProtocolBindingHash(
  value: Readonly<FixedPriceOfflineProtocolBinding>,
): string {
  return sha256Hex(canonicalize({
    domain: FIXED_PRICE_OFFLINE_COORDINATOR_DOMAIN,
    protocol: captureFixedPriceOfflineProtocolBinding(value),
  }));
}
