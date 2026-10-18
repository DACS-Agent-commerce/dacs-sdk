import { describe, expect, test } from "vitest";
import { attestationAddress, paymentEvidenceAddress, ratingAddress, bundleAddress } from "../../src/canonical/addressing.js";

describe("JID-3 current-profile builder conformance", () => {
  test.each([
    ["attestation", () => attestationAddress("job-abc", "lei", "id", 1)],
    ["payment", () => paymentEvidenceAddress("job-abc", "rail", 0)],
    ["rating", () => ratingAddress("job-abc", "key:public")],
    ["bundle", () => bundleAddress("job-abc", "buyer")],
  ])("%s rejects a non-JID-1 job", (_name, build) => {
    expect(build).toThrow();
  });
});

describe("JID-1 exact grammar at every current builder", () => {
  const job = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
  const builders = (id: string) => [
    () => attestationAddress(id, "lei", "id", 1),
    () => paymentEvidenceAddress(id, "rail", 0),
    () => ratingAddress(id, "key:public"),
    () => bundleAddress(id, "buyer"),
  ];
  test.each([job.toLowerCase(), ` ${job}`, `${job}\n`, `${job}X`, `8${job.slice(1)}`, job.replace("J", "I"), "job-abc"])(
    "rejects %j without normalization or repair", (id) => {
      for (const build of builders(id)) expect(build).toThrow(/JID-1/);
    },
  );
  test("accepts a canonical ULID at all four builders", () => {
    for (const build of builders(job)) expect(build).not.toThrow();
  });
});

test("archival builders retain historical address bytes only by explicit selection", async () => {
  const { legacyJobAddressing } = await import("../../src/canonical/index.js");
  expect(legacyJobAddressing.paymentEvidenceAddress("job-abc", "rail", 0))
    .toBe("dacs4:payment:job-abc:rail:0");
  expect(legacyJobAddressing.attestationAddress("job-abc", "lei", "id", 1))
    .toBe("dacs2:job-abc:lei:id:v1");
  expect(legacyJobAddressing.ratingAddress("job-abc", "key:public"))
    .toBe("dacs5:rating:job-abc:key%3Apublic");
  expect(legacyJobAddressing.bundleAddress("job-abc", "buyer")).toMatch(/^stor-[a-f0-9]{64}$/);
});

test("current bundle lookup rejects a legacy job before resolver calls", async () => {
  const { lookupBundleCopies } = await import("../../src/agent/bundleConsistency.js");
  let reads = 0;
  await expect(lookupBundleCopies("job-abc", async () => {
    reads++;
    return { disposition: "absent" };
  })).rejects.toThrow(/JID-1/);
  expect(reads).toBe(0);
});

test("fixed-slot discovery regexes consume the complete address", async () => {
  const { classifyAnchor } = await import("../../src/discovery/scanner.js");
  const jobId = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
  for (const address of [`dacs3:commit:${jobId}`, `dacs4:deliverable:${jobId}`, `dacs4:payment:${jobId}:rail:0`]) {
    expect(classifyAnchor(address)).not.toBe("unknown");
    expect(classifyAnchor(`${address}\n`)).toBe("unknown");
  }
});

import { readFileSync } from "node:fs";
import { isCurrentJobId, requireCurrentJobId } from "../../src/canonical/addressing.js";
import { lookupBundleCopies } from "../../src/agent/bundleConsistency.js";
import { finalityCommitmentAddress } from "../../src/negotiate/index.js";
import { classifyAnchor } from "../../src/discovery/scanner.js";
import { verifyConstructedSettlementEvidence } from "../../src/agent/verifySettlementEvidence.js";
import { DACS_CURRENT_PROFILE_ADMISSION_ERROR } from "../../src/version.js";

const corpus = JSON.parse(readFileSync(new URL(
  "../../vendor/DACS-Standard/conformance/vectors/security/job-id-grammar-v0.1.json", import.meta.url,
), "utf8"));

describe("complete pinned JID-1 corpus", () => {
  test("loads the complete 47-case oracle", () => {
    expect(corpus.count).toBe(47);
    expect(corpus.vectors).toHaveLength(corpus.count);
    expect(corpus.hash).toBe("59aa84253caf029ff38e18df3529f8a078fa721afa33c2c08f969589b3b1e598");
  });
  for (const vector of corpus.vectors) {
    test(`${vector.operation}: ${vector.name}`, async () => {
      switch (vector.operation) {
        case "validate":
          expect(isCurrentJobId(vector.jobId)).toBe(vector.expected === "pass");
          break;
        case "lookup-bundle": {
          let calls = 0;
          const lookup = () => lookupBundleCopies(vector.jobId, async () => {
            calls++;
            return { disposition: "absent" };
          });
          if (vector.expected === "error") {
            await expect(lookup()).rejects.toThrow(/JID-1/);
            expect(calls).toBe(0);
            for (const build of [
              () => bundleAddress(vector.jobId, vector.role),
              () => paymentEvidenceAddress(vector.jobId, "rail", 0),
              () => finalityCommitmentAddress(vector.jobId),
            ]) expect(build).toThrow(/JID-1|ULID/);
          } else {
            await lookup();
            expect(calls).toBeGreaterThan(0);
          }
          break;
        }
        case "derive-bundle":
          expect(bundleAddress(vector.jobId, vector.role)).toBe(vector.want.logicalAddress);
          break;
        case "derive-logical": {
          const address = vector.template.startsWith("dacs3:commit:")
            ? finalityCommitmentAddress(vector.jobId)
            : paymentEvidenceAddress(vector.jobId, "evm-erc20:1:USDC", 3);
          expect(address).toBe(vector.want.logicalAddress);
          expect(classifyAnchor(address)).not.toBe("unknown");
          break;
        }
        case "compare":
          if (vector.expected === "error") {
            expect(() => requireCurrentJobId(vector.otherJobId)).toThrow(/JID-1/);
          } else {
            requireCurrentJobId(vector.jobId);
            requireCurrentJobId(vector.otherJobId);
            expect(vector.jobId === vector.otherJobId).toBe(vector.want.equal);
          }
          break;
        case "profile-admit": {
          // The corpus's synthetic positive release is deliberately not production authority.
          const result = await verifyConstructedSettlementEvidence(
            { jobId: vector.sessionId }, vector, {} as never,
          );
          expect(result).toEqual({ decision: "error", reasons: [DACS_CURRENT_PROFILE_ADMISSION_ERROR] });
          break;
        }
        default: throw new Error(`unhandled pinned operation ${vector.operation}`);
      }
    });
  }
});
