import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";

import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";

const PHASE_DECISION_VERSION = "1" as const;
const PHASE_DECISION_ID_DOMAIN = "dacs-live-pre-agreement-phase:v1:" as const;
const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * The one path a role may sign on for a job: the agreement, or a
 * pre-agreement Vet terminal. Signing on both would hand the counterparty
 * contradictory evidence for the same job.
 */
export type DacsPreAgreementPhaseV1 = "agreement" | "vet-terminal";

/** Operator-action reason when the other path already owns the job. */
export const DACS_PRE_AGREEMENT_PHASE_CONFLICT = "agreement-vet-terminal-phase-conflict";

interface DacsPreAgreementPhaseDecisionV1 {
  decisionVersion: typeof PHASE_DECISION_VERSION;
  localBindingHash: string;
  phase: DacsPreAgreementPhaseV1;
}

type PhaseScope = Readonly<{ jobId: string; localBindingHash: string }>;

export class DacsPreAgreementPhaseError extends Error {
  override readonly name = "DacsPreAgreementPhaseError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function decisionId(role: "buyer" | "seller", jobId: string): string {
  return sha256Hex(`${PHASE_DECISION_ID_DOMAIN}${canonicalize({ role, jobId })}`);
}

function captureDecision(
  value: unknown,
  scope: PhaseScope,
): Readonly<DacsPreAgreementPhaseDecisionV1> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DacsPreAgreementPhaseError("pre-agreement-phase-corrupt");
  }
  const decision = value as Record<string, unknown>;
  if (Object.keys(decision).length !== 3 ||
      decision.decisionVersion !== PHASE_DECISION_VERSION ||
      typeof decision.localBindingHash !== "string" ||
      !HASH_RE.test(decision.localBindingHash) ||
      (decision.phase !== "agreement" && decision.phase !== "vet-terminal") ||
      decision.localBindingHash !== scope.localBindingHash) {
    throw new DacsPreAgreementPhaseError("pre-agreement-phase-corrupt");
  }
  return decision as unknown as Readonly<DacsPreAgreementPhaseDecisionV1>;
}

/** The durable phase this role has committed the job to, if any. */
export function loadDacsPreAgreementPhaseV1(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  scope: PhaseScope,
): DacsPreAgreementPhaseV1 | undefined {
  const value = context.database.loadEffectInput("session", decisionId(context.role, scope.jobId));
  return value === undefined ? undefined : captureDecision(value, scope).phase;
}

/**
 * Commit the job to `phase` for this role before it retains or signs anything
 * on that path. The write is an insert-once compare-and-swap: the first phase
 * written wins, and a later claim for the other phase throws
 * `agreement-vet-terminal-phase-conflict`, which needs an operator.
 */
export function claimDacsPreAgreementPhaseV1(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  scope: PhaseScope,
  phase: DacsPreAgreementPhaseV1,
): void {
  const id = decisionId(context.role, scope.jobId);
  const decision: DacsPreAgreementPhaseDecisionV1 = {
    decisionVersion: PHASE_DECISION_VERSION,
    localBindingHash: scope.localBindingHash,
    phase,
  };
  context.database.putEffectIntent({
    kind: "session",
    effectId: id,
    bindingHash: scope.localBindingHash,
    input: decision,
    idempotencyKey: id,
    jobId: scope.jobId,
  });
  const retained = captureDecision(context.database.loadEffectInput("session", id), scope);
  if (retained.phase !== phase) {
    throw new DacsPreAgreementPhaseError(DACS_PRE_AGREEMENT_PHASE_CONFLICT);
  }
}
