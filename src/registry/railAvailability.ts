import { types as nodeTypes } from "node:util";

import { contentHash, stripSignature } from "../canonical/index.js";
import {
  snapshotCanonicalJsonRead,
} from "../canonical/snapshot.js";
import {
  ed25519Verify,
  publicKeyFromRaw,
} from "../crypto/index.js";
import { isCanonicalBase64Url } from "../artifacts/signatures.js";
import { isRailDefinitionWire } from "./resolve.js";

/** DACS-2 §7.5.1 decision vocabulary used by RAV-R1..RAV-R5. */
export type RailAvailabilityDecision =
  | "pass"
  | "fail"
  | "error"
  | "indeterminate";

export type RailSessionState = "new" | "in-flight";

export interface TrustedRailOperatorContext {
  /** This literal makes the local trust boundary explicit and non-interchangeable. */
  source: "local-operator-policy";
  production: boolean;
}

/**
 * Independently acquired rail-selection authority. Discovery/counterparty hints
 * deliberately do not appear in this type because LRR-6/RAV-R5 make them inert.
 */
export interface RailAvailabilityAuthority {
  stewardClaim: string | null;
  /** Canonical unpadded Base64URL raw Ed25519 public key. */
  stewardPublicKey: string | null;
  /** Exact digest pinned by authenticated session/registry state. */
  pinnedRailDigest: string | null;
  sessionState: RailSessionState;
  operatorContext?: TrustedRailOperatorContext;
  /** Trusted result of the local RAV-R3 preflight. */
  operatorPreflightOk: boolean;
}

export interface RailAvailabilityEvaluation {
  decision: RailAvailabilityDecision;
  reason:
    | "ok"
    | "malformed-rail"
    | "malformed-authority"
    | "signature-missing"
    | "signature-invalid"
    | "steward-unavailable"
    | "pin-unavailable"
    | "pin-mismatch"
    | "disabled"
    | "failed"
    | "mocked-in-production"
    | "operator-preflight-required";
  /** Present only after a well-shaped rail can be hashed without rewriting it. */
  railDigest?: string;
}

const AVAILABILITIES = new Set([
  "live",
  "operator_gated",
  "closed_data",
  "bilateral",
  "mocked",
  "disabled",
  "failed",
]);
const GATED_AVAILABILITIES = new Set([
  "operator_gated",
  "closed_data",
  "bilateral",
]);
const REQUIRED_RAIL_FIELDS = [
  "railVersion",
  "railId",
  "railType",
  "asset",
  "network",
  "phaseHandler",
  "parameters",
  "availability",
  "governance",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function hasStableRequiredFields(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || nodeTypes.isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return REQUIRED_RAIL_FIELDS.every((key) => {
      const descriptor = descriptors[key];
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function malformedRail(value: unknown): boolean {
  if (!hasStableRequiredFields(value)) return true;
  return (
    !Number.isSafeInteger(value.railVersion) ||
    (value.railVersion as number) <= 0 ||
    typeof value.railId !== "string" ||
    value.railId.length === 0 ||
    typeof value.railType !== "string" ||
    value.railType.length === 0 ||
    !isRecord(value.asset) ||
    !isRecord(value.network) ||
    typeof value.phaseHandler !== "string" ||
    value.phaseHandler.length === 0 ||
    !isRecord(value.parameters) ||
    typeof value.availability !== "string" ||
    !AVAILABILITIES.has(value.availability) ||
    !isRecord(value.governance)
  );
}

function malformedAuthority(value: unknown): boolean {
  if (!isRecord(value) || nodeTypes.isProxy(value)) return true;
  const sessionState = value.sessionState;
  const operatorContext = value.operatorContext;
  return (
    (value.stewardClaim !== null &&
      (typeof value.stewardClaim !== "string" || value.stewardClaim.length === 0)) ||
    (value.stewardPublicKey !== null &&
      !isCanonicalBase64Url(value.stewardPublicKey)) ||
    (value.pinnedRailDigest !== null &&
      (typeof value.pinnedRailDigest !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.pinnedRailDigest))) ||
    (sessionState !== "new" && sessionState !== "in-flight") ||
    typeof value.operatorPreflightOk !== "boolean" ||
    !isRecord(operatorContext) ||
    operatorContext.source !== "local-operator-policy" ||
    typeof operatorContext.production !== "boolean"
  );
}

function result(
  decision: RailAvailabilityDecision,
  reason: RailAvailabilityEvaluation["reason"],
  railDigest?: string,
): RailAvailabilityEvaluation {
  return railDigest === undefined
    ? { decision, reason }
    : { decision, reason, railDigest };
}

/**
 * Evaluate DACS-4 RAV-R1..RAV-R5 against one complete signed RailDefinition.
 *
 * The caller supplies only independently authenticated local authority. The
 * complete rail, including unknown members, remains in the signed/pinned scope;
 * this function never normalizes, projects, or repairs it before hashing.
 */
export function evaluateRailAvailabilitySelection(
  railSource: unknown,
  authoritySource: unknown,
): RailAvailabilityEvaluation {
  let rail: Record<string, unknown>;
  let authority: RailAvailabilityAuthority;
  try {
    rail = snapshotCanonicalJsonRead(
      railSource,
      "rail availability RailDefinition",
    ) as Record<string, unknown>;
    authority = snapshotCanonicalJsonRead(
      authoritySource,
      "rail availability authority",
    ) as RailAvailabilityAuthority;
  } catch {
    return result("error", "malformed-authority");
  }
  if (malformedRail(rail)) return result("error", "malformed-rail");
  if (malformedAuthority(authority)) return result("error", "malformed-authority");

  const signature = rail.signature;
  if (signature === undefined) return result("fail", "signature-missing");
  if (
    !isRecord(signature) ||
    Reflect.ownKeys(signature).length !== 3 ||
    signature.algorithm !== "ed25519" ||
    typeof signature.signer !== "string" ||
    !isCanonicalBase64Url(signature.value)
  ) {
    return result("fail", "signature-invalid");
  }

  const railDigest = contentHash(
    stripSignature(rail) as Record<string, unknown>,
  );
  if (authority.stewardClaim === null || authority.stewardPublicKey === null) {
    return result("indeterminate", "steward-unavailable", railDigest);
  }
  if (signature.signer !== authority.stewardClaim) {
    return result("fail", "signature-invalid", railDigest);
  }
  try {
    const publicKeyBytes = Uint8Array.from(
      Buffer.from(authority.stewardPublicKey, "base64url"),
    );
    const signatureBytes = Uint8Array.from(
      Buffer.from(signature.value, "base64url"),
    );
    if (
      publicKeyBytes.length !== 32 ||
      signatureBytes.length !== 64 ||
      !ed25519Verify(
        Uint8Array.from(Buffer.from(`dacs-rail:v1:${railDigest}`, "ascii")),
        signatureBytes,
        publicKeyFromRaw(publicKeyBytes),
      )
    ) {
      return result("fail", "signature-invalid", railDigest);
    }
  } catch {
    return result("fail", "signature-invalid", railDigest);
  }

  if (authority.pinnedRailDigest === null) {
    return result("indeterminate", "pin-unavailable", railDigest);
  }
  if (authority.pinnedRailDigest !== railDigest) {
    return result("fail", "pin-mismatch", railDigest);
  }
  // RAV authenticates the complete signed bytes first. Only then interpret the
  // current closed wire schema, so a mutation of any known or unknown member is
  // a signature failure rather than an attacker-selected shape projection.
  if (!isRailDefinitionWire(rail)) {
    return result("error", "malformed-rail", railDigest);
  }

  const availability = rail.availability as string;
  if (availability === "disabled") return result("fail", "disabled", railDigest);
  if (availability === "failed") return result("fail", "failed", railDigest);
  if (availability === "mocked" && authority.operatorContext!.production) {
    return result("fail", "mocked-in-production", railDigest);
  }
  if (
    GATED_AVAILABILITIES.has(availability) &&
    authority.operatorPreflightOk !== true
  ) {
    return result("fail", "operator-preflight-required", railDigest);
  }
  return result("pass", "ok", railDigest);
}
