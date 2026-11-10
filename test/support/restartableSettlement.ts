import type { SessionDeps } from "../../src/agent/runSessionCore.js";
import { declareSettlementBridge } from "../../src/rails/idempotency.js";

/**
 * `runSession` recovers only through an SDK settle bridge. A fixture that scripts
 * its own `resumeSettlement` declares that seam the way the SDK bridges do. Only
 * the seams the test supplies are registered: there is no default resume seam and
 * no default SessionStore, so a test that omits one still sees the refusal.
 */
export function registerResumeSeam<T extends Partial<SessionDeps>>(deps: T): T {
  const resume = deps.resumeSettlement;
  if (typeof resume === "function") declareSettlementBridge(resume);
  return deps;
}
