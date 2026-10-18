import { requireCurrentJobId } from "../canonical/addressing.js";
import { assertCurrentDacsProfileAdmission } from "../version.js";

/**
 * SDK-owned release guard; caller-supplied rails, stores and fences cannot admit
 * a release. Read caller-owned job data only after release admission.
 */
export function assertDacsRailEffectAdmission(readJobId?: () => unknown): void {
  assertCurrentDacsProfileAdmission();
  if (readJobId) requireCurrentJobId(readJobId());
}
