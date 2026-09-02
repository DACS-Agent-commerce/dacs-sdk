import { types as nodeTypes } from "node:util";

import { DacsError } from "../errors.js";

/** DACS-2 §7.4.4 PA-1..PA-3 closed progressive-anchoring phases. */
export const RECIPE_ANCHORING_PHASES = Object.freeze([
  "in-code",
  "single-signer",
  "multisig",
] as const);

export type RecipeAnchoringPhase =
  (typeof RECIPE_ANCHORING_PHASES)[number];

export interface RecipeAnchoringPhaseClassification {
  phase: RecipeAnchoringPhase;
  progressivePhase: "PA-1" | "PA-2" | "PA-3";
  /** PA-1 is disclosed bootstrap configuration, not a canonical anchor. */
  canonicallyAnchored: boolean;
  /** Monotonic ordering used only for a consumer's explicit GOV-3 trust floor. */
  trustRank: 0 | 1 | 2;
}

const PHASE_CLASSIFICATION: Readonly<
  Record<RecipeAnchoringPhase, RecipeAnchoringPhaseClassification>
> = Object.freeze({
  "in-code": Object.freeze({
    phase: "in-code",
    progressivePhase: "PA-1",
    canonicallyAnchored: false,
    trustRank: 0,
  }),
  "single-signer": Object.freeze({
    phase: "single-signer",
    progressivePhase: "PA-2",
    canonicallyAnchored: true,
    trustRank: 1,
  }),
  multisig: Object.freeze({
    phase: "multisig",
    progressivePhase: "PA-3",
    canonicallyAnchored: true,
    trustRank: 2,
  }),
});

/** GOV-2 classifier. Unknown phases fail closed instead of inheriting PA-2/PA-3 trust. */
export function classifyRecipeAnchoringPhase(
  value: unknown,
): Readonly<RecipeAnchoringPhaseClassification> {
  if (
    typeof value !== "string" ||
    !Object.prototype.hasOwnProperty.call(PHASE_CLASSIFICATION, value)
  ) {
    throw new DacsError("unknown DACS-2 recipe anchoring phase");
  }
  return PHASE_CLASSIFICATION[value as RecipeAnchoringPhase];
}

export type RegistryGovernanceRepresentation =
  | "single-steward"
  | "constituted-body";

export interface RegistryGovernanceDisclosureInput {
  /** Public key material or a stable public key identifier disclosed to the consumer. */
  authoritativeSigningKey?: string;
  actualPhase: RecipeAnchoringPhase;
  /** Verifier-local presentation hint; it is not a DACS wire field. */
  represents: RegistryGovernanceRepresentation;
}

export type RegistryGovernanceDisclosureDecision =
  | {
      ok: true;
      actualPhase: RecipeAnchoringPhase;
      canonicallyAnchored: boolean;
      authoritativeSigningKey: string;
      represents: RegistryGovernanceRepresentation;
    }
  | {
      ok: false;
      actualPhase: RecipeAnchoringPhase;
      canonicallyAnchored: boolean;
      reason:
        | "missing-authoritative-signing-key"
        | "governance-representation-mismatch";
    };

export interface PinnedRecipeGovernanceInput {
  /** Exact version named by the VerifyResult/session pin. */
  recipeVersion: number;
  /** Phase read from that exact resolved recipeVersion, never from the current head. */
  pinnedPhase: RecipeAnchoringPhase;
  /** Consumer-local minimum accepted progressive-anchoring phase. */
  minimumPhase: RecipeAnchoringPhase;
}

export interface PinnedRecipeGovernanceDecision {
  recipeVersion: number;
  evaluatedPhase: RecipeAnchoringPhase;
  minimumPhase: RecipeAnchoringPhase;
  canonicallyAnchored: boolean;
  ok: boolean;
}

function captureDataRecord(
  value: unknown,
  subject: string,
  required: readonly string[],
  optional: readonly string[] = [],
): ReadonlyMap<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  ) {
    throw new DacsError(`${subject} must be a plain data record`);
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowed = new Set([...required, ...optional]);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.some((key) => typeof key !== "string") ||
      required.some((key) => !keys.includes(key)) ||
      keys.some((key) => typeof key !== "string" || !allowed.has(key))
    ) {
      throw new DacsError(`${subject} has a non-canonical shape`);
    }
    const captured = new Map<string, unknown>();
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        throw new DacsError(`${subject} must contain only enumerable data fields`);
      }
      captured.set(key, descriptor.value);
    }
    return captured;
  } catch (error) {
    if (error instanceof DacsError) throw error;
    throw new DacsError(`${subject} could not be inspected safely`);
  }
}

function isCanonicalPublicKeyDisclosure(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    value.normalize("NFC") === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

/**
 * GOV-1 disclosure decision.
 *
 * This checks the consumer-visible authority claim only. Signature and registry
 * authentication remain the responsibility of the registry resolver.
 */
export function assessRegistryGovernanceDisclosure(
  input: Readonly<RegistryGovernanceDisclosureInput>,
): Readonly<RegistryGovernanceDisclosureDecision> {
  const captured = captureDataRecord(
    input,
    "registry governance disclosure",
    ["actualPhase", "represents"],
    ["authoritativeSigningKey"],
  );
  // Classify before considering the key or representation: an unknown actual
  // phase cannot be converted into a plausible GOV-1 answer.
  const phase = classifyRecipeAnchoringPhase(captured.get("actualPhase"));
  const represents = captured.get("represents");
  if (represents !== "single-steward" && represents !== "constituted-body") {
    throw new DacsError("registry governance representation is malformed");
  }
  const authoritativeSigningKey = captured.get("authoritativeSigningKey");
  if (authoritativeSigningKey === undefined) {
    return Object.freeze({
      ok: false,
      actualPhase: phase.phase,
      canonicallyAnchored: phase.canonicallyAnchored,
      reason: "missing-authoritative-signing-key",
    });
  }
  if (!isCanonicalPublicKeyDisclosure(authoritativeSigningKey)) {
    throw new DacsError("authoritative registry signing key disclosure is malformed");
  }
  const representsConstitutedBody = represents === "constituted-body";
  if (representsConstitutedBody !== (phase.phase === "multisig")) {
    return Object.freeze({
      ok: false,
      actualPhase: phase.phase,
      canonicallyAnchored: phase.canonicallyAnchored,
      reason: "governance-representation-mismatch",
    });
  }
  return Object.freeze({
    ok: true,
    actualPhase: phase.phase,
    canonicallyAnchored: phase.canonicallyAnchored,
    authoritativeSigningKey,
    represents,
  });
}

/**
 * GOV-3 pin-time trust decision.
 *
 * The API intentionally has no `currentPhase`: append-only re-anchoring of a
 * later registry head cannot retroactively upgrade the exact recipe version a
 * VerifyResult pinned.
 */
export function evaluatePinnedRecipeGovernance(
  input: Readonly<PinnedRecipeGovernanceInput>,
): Readonly<PinnedRecipeGovernanceDecision> {
  const captured = captureDataRecord(
    input,
    "pinned recipe governance input",
    ["recipeVersion", "pinnedPhase", "minimumPhase"],
  );
  const recipeVersion = captured.get("recipeVersion");
  if (
    typeof recipeVersion !== "number" ||
    !Number.isSafeInteger(recipeVersion) ||
    recipeVersion <= 0
  ) {
    throw new DacsError("pinned recipe version must be a positive safe integer");
  }
  const pinned = classifyRecipeAnchoringPhase(captured.get("pinnedPhase"));
  const minimum = classifyRecipeAnchoringPhase(captured.get("minimumPhase"));
  return Object.freeze({
    recipeVersion,
    evaluatedPhase: pinned.phase,
    minimumPhase: minimum.phase,
    canonicallyAnchored: pinned.canonicallyAnchored,
    ok: pinned.trustRank >= minimum.trustRank,
  });
}
