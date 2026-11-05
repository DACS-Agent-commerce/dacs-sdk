import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import vectors from "../fixtures/job-id-grammar-v0.1.json" with { type: "json" };
import * as root from "../../src/index.js";
import * as canonical from "../../src/canonical/index.js";
import * as hash from "../../src/canonical/hash.js";
import { DacsError } from "../../src/errors.js";

const JOB = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const builders = [
  ["attestationAddress", (job: string) => canonical.attestationAddress(job, "lei", "a:b", 2)],
  ["paymentEvidenceAddress", (job: string) => canonical.paymentEvidenceAddress(job, "rail:one", 3, true)],
  ["ratingAddress", (job: string) => canonical.ratingAddress(job, "rater:one")],
  ["bundleAddress", (job: string) => canonical.bundleAddress(job, "buyer")],
] as const;

// DACS-Standard next at 4206db3a994baf8c6a54505c10eaaf9b3302ce9b.
// conformance/vectors/security/job-id-grammar-v0.1.json.
// Only job-ID/address operations apply: comparison and profile admission have
// separate APIs and cannot be inferred from an address formatter's result.
const addressVectors = vectors.vectors.filter(v =>
  ["validate", "lookup-bundle", "derive-bundle", "derive-logical"].includes(v.operation));

describe.each(builders)("public %s JID-1 boundary", (_name, build) => {
  test("rejects the reported legacy job-abc ID", () => {
    expect(() => build("job-abc")).toThrow(/canonical uppercase ULID/);
  });

  test.each(addressVectors)("Standard vector: $name", vector => {
    const spy = vi.spyOn(hash, "sha256Hex");
    try {
      const jobId = vector.jobId as string;
      if (vector.expected === "error") {
        expect(() => build(jobId)).toThrow(DacsError);
        expect(spy).not.toHaveBeenCalled();
      } else {
        expect(build(jobId)).toEqual(expect.any(String));
      }
    } finally {
      spy.mockRestore();
    }
  });
});

test("canonical IDs preserve logical address bytes and CF-4 encoding", () => {
  expect(builders.map(([, build]) => build(JOB))).toEqual([
    `dacs2:${JOB}:lei:a%3Ab:v2`,
    `dacs4:payment:${JOB}:rail%3Aone:3:resolved`,
    `dacs5:rating:${JOB}:rater%3Aone`,
    "stor-" + createHash("sha256").update(`${JOB}-bundle-buyer`).digest("hex"),
  ]);
  expect(canonical.paymentEvidenceAddress(JOB, "rail:one", 0)).toBe(
    `dacs4:payment:${JOB}:rail%3Aone:0`);
});

test.each(vectors.vectors.filter(v => v.operation === "derive-bundle"))(
  "Standard bundle known answer: $name", vector => {
    expect(canonical.bundleAddress(vector.jobId as string,
      vector.role as "buyer" | "seller" | "orchestrator")).toBe(vector.want.logicalAddress);
  },
);

test("root and canonical entrypoints export current and explicit legacy builders", () => {
  for (const name of ["attestationAddress", "paymentEvidenceAddress", "ratingAddress", "bundleAddress",
    "legacyAttestationAddress", "legacyPaymentEvidenceAddress", "legacyRatingAddress", "legacyBundleAddress"] as const) {
    expect(root[name]).toBe(canonical[name]);
  }
});

test("other segment checks still reject invalid inputs after JID-1 admission", () => {
  expect(() => canonical.attestationAddress(JOB, "UPPER", "x", 1)).toThrow(/scheme/);
  expect(() => canonical.attestationAddress(JOB, "lei", "", 1)).toThrow(/identifier/);
  expect(() => canonical.attestationAddress(JOB, "lei", "x", 0)).toThrow(/recipeVersion/);
  expect(() => canonical.paymentEvidenceAddress(JOB, "", 0)).toThrow(/railId/);
  expect(() => canonical.paymentEvidenceAddress(JOB, "rail", -1)).toThrow(/phaseIndex/);
  expect(() => canonical.paymentEvidenceAddress(JOB, "rail", 0, "true" as unknown as boolean)).toThrow(/boolean/);
  expect(() => canonical.ratingAddress(JOB, "")).toThrow(/rater/);
  const spy = vi.spyOn(hash, "sha256Hex");
  try {
    expect(() => canonical.bundleAddress(JOB, "other" as "buyer")).toThrow(/role/);
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

test("explicit legacy builders retain historical addresses and validation", () => {
  expect(canonical.legacyAttestationAddress("job-abc", "lei", "a:b", 2)).toBe("dacs2:job-abc:lei:a%3Ab:v2");
  expect(canonical.legacyPaymentEvidenceAddress("job-abc", "rail:one", 3, true)).toBe(
    "dacs4:payment:job-abc:rail%3Aone:3:resolved");
  expect(canonical.legacyRatingAddress("job-abc", "rater:one")).toBe("dacs5:rating:job-abc:rater%3Aone");
  expect(canonical.legacyBundleAddress("job-abc", "buyer")).toBe(
    "stor-" + createHash("sha256").update("job-abc-bundle-buyer").digest("hex"));
  expect(() => canonical.legacyAttestationAddress("job:abc", "lei", "x", 1)).toThrow(/jobId/);
  expect(() => canonical.legacyAttestationAddress("job-abc", "UPPER", "x", 1)).toThrow(/scheme/);
  expect(() => canonical.legacyPaymentEvidenceAddress("job-abc", "rail", -1)).toThrow(/phaseIndex/);
  expect(() => canonical.legacyRatingAddress("job-abc", "")).toThrow(/rater/);
});
