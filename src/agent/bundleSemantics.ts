import type {
  AnyAttestationBundle,
  BundlePartyRole,
  AbsoluteFaultAttestationBundle,
  FaultAttestationBundle,
  FaultedParty,
} from "../artifacts/types.js";
import { faultedPartyIsPermitted } from "../artifacts/validators.js";

export { faultedPartyIsPermitted } from "../artifacts/validators.js";

export const BUNDLE_OUTCOMES = Object.freeze([
  "completed",
  "failed-perm",
  "failed-counterparty",
  "failed-substrate",
  "aborted-by-self",
  "aborted-by-other",
] as const);

export type BundleOutcome = (typeof BUNDLE_OUTCOMES)[number];
export type BundleOutcomeClass = "completed" | "failed-substrate" | "failure" | "abort";

export function isBundleOutcome(value: unknown): value is BundleOutcome {
  return typeof value === "string" && (BUNDLE_OUTCOMES as readonly string[]).includes(value);
}

export function bundleOutcomeClass(outcome: unknown): BundleOutcomeClass | null {
  if (outcome === "completed") return "completed";
  if (outcome === "failed-substrate") return "failed-substrate";
  if (outcome === "failed-perm" || outcome === "failed-counterparty") return "failure";
  if (outcome === "aborted-by-self" || outcome === "aborted-by-other") return "abort";
  return null;
}

export function isFaultBundle(
  bundle: AnyAttestationBundle | Record<string, unknown>,
): bundle is FaultAttestationBundle {
  return (
    bundle["faultBundleVersion"] === "1" &&
    bundle["bundleVersion"] === undefined &&
    bundle["evidenceBoundFaultBundleVersion"] === undefined
  );
}

export function isAbsoluteFaultBundle(
  bundle: AnyAttestationBundle | Record<string, unknown>,
): bundle is AbsoluteFaultAttestationBundle {
  return (
    bundle["bundleVersion"] === undefined &&
    ((bundle["faultBundleVersion"] === "1" &&
      bundle["evidenceBoundFaultBundleVersion"] === undefined) ||
      (bundle["evidenceBoundFaultBundleVersion"] === "1" &&
        bundle["faultBundleVersion"] === undefined))
  );
}

export function isEvidenceBoundFaultBundle(
  bundle: AnyAttestationBundle | Record<string, unknown>,
): bundle is import("../artifacts/types.js").EvidenceBoundFaultAttestationBundle {
  return (
    bundle["evidenceBoundFaultBundleVersion"] === "1" &&
    bundle["bundleVersion"] === undefined &&
    bundle["faultBundleVersion"] === undefined
  );
}

export type BundleArtifactType = "legacy" | "fault" | "evidence-bound";

/** Exact exclusive discriminator class, or null for stripped/ambiguous input. */
export function bundleArtifactType(
  bundle: AnyAttestationBundle | Record<string, unknown>,
): BundleArtifactType | null {
  const known = new Set([
    "bundleVersion",
    "faultBundleVersion",
    "evidenceBoundFaultBundleVersion",
  ]);
  if (Object.keys(bundle).some((key) => key.endsWith("BundleVersion") && !known.has(key))) {
    return null;
  }
  const legacy = bundle["bundleVersion"] === "1";
  const fault = bundle["faultBundleVersion"] === "1";
  const evidenceBound = bundle["evidenceBoundFaultBundleVersion"] === "1";
  if (Number(legacy) + Number(fault) + Number(evidenceBound) !== 1) return null;
  if (
    (bundle["bundleVersion"] !== undefined && !legacy) ||
    (bundle["faultBundleVersion"] !== undefined && !fault) ||
    (bundle["evidenceBoundFaultBundleVersion"] !== undefined && !evidenceBound)
  ) return null;
  if (evidenceBound) return "evidence-bound";
  if (fault) return "fault";
  return "legacy";
}

export function bundleArtifactTypeRank(
  bundle: AnyAttestationBundle | Record<string, unknown>,
): number {
  const type = bundleArtifactType(bundle);
  return type === "evidence-bound" ? 2 : type === "fault" ? 1 : type === "legacy" ? 0 : -1;
}

function partyRoles(bundle: AnyAttestationBundle | Record<string, unknown>): Set<BundlePartyRole> {
  const roles = new Set<BundlePartyRole>();
  const parties = bundle["parties"];
  if (!Array.isArray(parties)) return roles;
  for (const party of parties) {
    if (!party || typeof party !== "object" || Array.isArray(party)) continue;
    const role = (party as Record<string, unknown>)["role"];
    if (role === "buyer" || role === "seller" || role === "orchestrator") roles.add(role);
  }
  return roles;
}

/** Absolute roles a legacy role-relative copy permits. */
export function legacyImpliedFaultSet(
  bundle: AnyAttestationBundle | Record<string, unknown>,
): Set<FaultedParty> {
  const anchor = bundle["anchoredByRole"];
  const outcome = bundle["outcome"];
  if (outcome === "completed" || outcome === "failed-substrate") return new Set(["none"]);
  if (anchor !== "buyer" && anchor !== "seller" && anchor !== "orchestrator") return new Set();
  if (outcome === "failed-perm" || outcome === "aborted-by-self") return new Set([anchor]);
  if (outcome === "failed-counterparty" || outcome === "aborted-by-other") {
    const roles = partyRoles(bundle);
    roles.delete(anchor);
    return roles;
  }
  return new Set();
}

export function roleRelativeOutcome(
  outcomeClass: BundleOutcomeClass,
  faultedParty: FaultedParty,
  anchor: BundlePartyRole,
): BundleOutcome {
  if (outcomeClass === "completed") return "completed";
  if (outcomeClass === "failed-substrate") return "failed-substrate";
  const self = faultedParty === anchor;
  if (outcomeClass === "failure") return self ? "failed-perm" : "failed-counterparty";
  return self ? "aborted-by-self" : "aborted-by-other";
}

export function perspectiveFlip(outcome: unknown): BundleOutcome | null {
  if (outcome === "failed-perm") return "failed-counterparty";
  if (outcome === "failed-counterparty") return "failed-perm";
  if (outcome === "aborted-by-self") return "aborted-by-other";
  if (outcome === "aborted-by-other") return "aborted-by-self";
  return isBundleOutcome(outcome) ? outcome : null;
}

/** Outcome of one reconciled copy from a scored buyer/seller role. */
export function scoredBundleOutcome(
  bundle: AnyAttestationBundle,
  scoredRole: "buyer" | "seller",
): BundleOutcome | null {
  const outcomeClass = bundleOutcomeClass(bundle.outcome);
  if (!outcomeClass) return null;
  if (isAbsoluteFaultBundle(bundle)) {
    return roleRelativeOutcome(outcomeClass, bundle.faultedParty, scoredRole);
  }
  const implied = legacyImpliedFaultSet(bundle);
  if (outcomeClass === "completed" || outcomeClass === "failed-substrate") {
    return roleRelativeOutcome(outcomeClass, "none", scoredRole);
  }
  return roleRelativeOutcome(
    outcomeClass,
    implied.has(scoredRole) ? scoredRole : "orchestrator",
    scoredRole,
  );
}
