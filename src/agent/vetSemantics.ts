import type {
  BundlePhaseErrorClass,
  VerificationDecision,
  VerificationMethodKind,
  VerifyResult,
} from "../artifacts/types.js";
import { isVerifyResult } from "../artifacts/validators.js";
import { DacsError } from "../errors.js";

const DECISIONS = new Set<unknown>([
  "pass",
  "fail",
  "indeterminate",
  "error",
]);

const METHODS = new Set<unknown>([
  "verifiable-credential",
  "tlsnotary",
  "zktls",
  "consensus-backed-proxy",
  "oauth-attested",
  "evm-rpc",
  "domain-tls-control",
  "self-signed",
  "demos-gcr-domain",
]);

/** DACS-2 §7.5.1 CM-4 closed decision classifier. */
export function classifyVerificationDecision(
  value: unknown,
): VerificationDecision {
  if (!DECISIONS.has(value)) {
    throw new DacsError("unknown DACS-2 verification decision");
  }
  return value as VerificationDecision;
}

/**
 * DACS-2 CM-1/CM-3/CM-5 structural and producing-method predicate.
 *
 * This deliberately validates the complete current VerifyResult before it
 * compares `method`; a partial record cannot become accepted merely because
 * its method string happens to match.
 */
export function isVerifyResultForMethod(
  value: unknown,
  expectedMethod: VerificationMethodKind,
): value is VerifyResult {
  return (
    METHODS.has(expectedMethod) &&
    isVerifyResult(value) &&
    value.method === expectedMethod
  );
}

export interface VerificationRetryPolicy {
  retryClass: "transient" | "permanent";
  /** Defaults to the VP-R1 limit of three attempts. */
  retryBudget?: number;
  /** Defaults to false per VP-R4. */
  retryOnIndeterminate?: boolean;
}

function isSafeAttempt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function captureRetryPolicy(
  value: Readonly<VerificationRetryPolicy>,
): Required<VerificationRetryPolicy> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DacsError("verification retry policy must be a plain record");
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.some((key) => typeof key !== "string") ||
      !keys.includes("retryClass") ||
      !keys.every((key) =>
        key === "retryClass" ||
        key === "retryBudget" ||
        key === "retryOnIndeterminate"
      ) ||
      keys.some((key) => {
        const descriptor = descriptors[key as string];
        return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
      })
    ) {
      throw new DacsError("verification retry policy must contain only data fields");
    }
    const retryClass = descriptors.retryClass!.value as unknown;
    const retryBudget = descriptors.retryBudget?.value as unknown;
    const retryOnIndeterminate = descriptors.retryOnIndeterminate?.value as unknown;
    if (
      (retryClass !== "transient" && retryClass !== "permanent") ||
      (retryBudget !== undefined && !isSafeAttempt(retryBudget)) ||
      (retryOnIndeterminate !== undefined && typeof retryOnIndeterminate !== "boolean")
    ) {
      throw new DacsError("verification retry policy is malformed");
    }
    return {
      retryClass,
      retryBudget: retryBudget === undefined ? 3 : retryBudget,
      retryOnIndeterminate: retryOnIndeterminate === true,
    };
  } catch (error) {
    if (error instanceof DacsError) throw error;
    throw new DacsError("verification retry policy could not be captured");
  }
}

/**
 * DACS-2 VP-R1/VP-R3/VP-R4 retry decision.
 *
 * `attempts` is the number of attempts already made. Both permitted retry
 * paths remain bounded by the recipe budget; the Standard permits but does not
 * require retry when VP-R1/VP-R4 applies, so this conservative cap cannot turn
 * a terminal answer into another authority call.
 */
export function shouldRetryVerification(
  decision: VerificationDecision,
  attempts: number,
  policy: Readonly<VerificationRetryPolicy>,
): boolean {
  const classified = classifyVerificationDecision(decision);
  if (!isSafeAttempt(attempts)) {
    throw new DacsError("verification attempts must be a non-negative safe integer");
  }
  const captured = captureRetryPolicy(policy);
  if (attempts >= captured.retryBudget) return false;
  if (classified === "error") return captured.retryClass === "transient";
  if (classified === "indeterminate") return captured.retryOnIndeterminate;
  return false;
}

export type VetPhaseFailureCause =
  | "authority-or-verifier"
  | "counterparty-malformed-presentation";

export type VetPhaseFailureClass = Extract<
  BundlePhaseErrorClass,
  "counterparty" | "permanent"
>;

/** DACS-2 VPC-4/§7.8.2 terminal decision-to-fault attribution. */
export function vetPhaseFailureClass(
  decision: VerificationDecision,
  cause: VetPhaseFailureCause = "authority-or-verifier",
): VetPhaseFailureClass | null {
  const classified = classifyVerificationDecision(decision);
  if (
    cause !== "authority-or-verifier" &&
    cause !== "counterparty-malformed-presentation"
  ) {
    throw new DacsError("unknown Vet phase failure cause");
  }
  if (classified === "pass") return null;
  if (
    classified === "fail" ||
    cause === "counterparty-malformed-presentation"
  ) {
    return "counterparty";
  }
  return "permanent";
}
