import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  isCanonicalJobId,
  requireCanonicalJobId,
} from "../../src/negotiate/jobId.js";

const VECTOR_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/DACS-Standard/conformance/vectors/security/job-id-grammar-v0.1.json",
);
const haveVector = existsSync(VECTOR_PATH);

interface JobIdVector {
  name: string;
  operation: string;
  expected: "pass" | "fail" | "error";
  jobId?: unknown;
  otherJobId?: unknown;
  want: Record<string, unknown>;
}

// CORE JID-1 (grammar, no repair) and JID-4 (a malformed comparison operand is
// an error, not a mismatch), replayed from the pinned Standard corpus. The
// derive-bundle, derive-logical and lookup-bundle cases exercise
// `bundleAddress` and `lookupBundleCopies`, and the profile-admit cases a
// release pin that does not exist yet; those are not replayed here.
describe.skipIf(!haveVector)("CORE JID-1/JID-4 job-id-grammar-v0.1 corpus", () => {
  const document = JSON.parse(readFileSync(VECTOR_PATH, "utf8")) as {
    count: number;
    vectors: JobIdVector[];
  };
  const byOperation = (operation: string) =>
    document.vectors.filter((vector) => vector.operation === operation);

  it("is the reviewed corpus", () => {
    expect(document.count).toBe(47);
    expect(document.vectors).toHaveLength(47);
    expect(byOperation("validate")).toHaveLength(3);
    expect(byOperation("compare")).toHaveLength(3);
  });

  it.each(byOperation("validate").map((vector) => [vector.name, vector] as const))(
    "validate %s",
    (_name, vector) => {
      expect(isCanonicalJobId(vector.jobId)).toBe(vector.expected === "pass");
      if (vector.expected === "pass") {
        expect(requireCanonicalJobId(vector.jobId)).toBe(vector.want.canonicalJobId);
      } else {
        expect(() => requireCanonicalJobId(vector.jobId)).toThrow(/canonical/);
      }
    },
  );

  it.each(byOperation("compare").map((vector) => [vector.name, vector] as const))(
    "compare %s",
    (_name, vector) => {
      // Validate both operands first; only then compare byte-exact.
      const valid = isCanonicalJobId(vector.jobId) && isCanonicalJobId(vector.otherJobId);
      if (vector.expected === "error") {
        expect(valid).toBe(false);
        expect(vector.want.failureStage).toBe("job-id-validation");
        return;
      }
      expect(valid).toBe(true);
      expect(vector.jobId === vector.otherJobId).toBe(vector.want.equal);
      expect(vector.expected).toBe(vector.want.equal ? "pass" : "fail");
    },
  );

  // Every malformed jobId in the corpus, whatever its operation, fails JID-1.
  it("refuses every jobId the corpus marks as failing job-id validation", () => {
    const malformed = document.vectors.filter((vector) =>
      vector.expected === "error" && vector.want.failureStage === "job-id-validation" &&
      vector.operation !== "compare");
    expect(malformed.length).toBeGreaterThan(0);
    for (const vector of malformed) {
      expect(isCanonicalJobId(vector.jobId), vector.name).toBe(false);
    }
  });
});
