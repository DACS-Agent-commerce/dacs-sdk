import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";

const FACTS_DOMAIN = "dacs-live-session-agreement-facts:v1:" as const;

/**
 * Durable session-effect id of one role's retained pre-agreement facts. Shared
 * by the session bootstrap, which writes the facts once every Vet it needs has
 * passed, and the Vet terminal transport, which must not finalize a Vet failure
 * those facts contradict.
 */
export function dacsSessionAgreementFactsIdV1(
  role: "buyer" | "seller",
  jobId: string,
): string {
  return sha256Hex(`${FACTS_DOMAIN}${canonicalize({ role, jobId })}`);
}
