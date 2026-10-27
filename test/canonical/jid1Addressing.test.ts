import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import * as canonical from "../../src/canonical/index.js";
import * as hash from "../../src/canonical/hash.js";
import { DacsError } from "../../src/errors.js";

// CORE §B.1 prose: 26 uppercase ASCII Crockford characters, first 0..7.
const JOB = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BAD: unknown[] = ["", "job-abc", JOB.toLowerCase(), "8" + "0".repeat(25),
 "9" + "0".repeat(25), "0".repeat(25), "0".repeat(27), ...["I","L","O","U","é","１"].map(c => "0" + c.repeat(25)),
 " " + JOB, JOB + " ", JOB + "\n", JOB + "\r\n", JOB + "\t", JOB + "\u2028",
 JOB + "\0", JOB.replace("0", "%30"), JOB.slice(0, 5) + ":" + JOB.slice(6), null, undefined, 123];
const api = () => canonical as unknown as Record<string, (...args: any[]) => string>;
const calls = (job: unknown) => [
 () => api().jid1AttestationAddress!(job, "lei", "a:b", 2),
 () => api().jid1PaymentEvidenceAddress!(job, "rail:one", 3, true),
 () => api().jid1RatingAddress!(job, "rater:one"),
 () => api().jid1BundleAddress!(job, "buyer"),
];
describe("current-only JID-3 address derivation", () => {
 test("exports four explicit current helpers from canonical and root", async () => {
  const root = await import("../../src/index.js");
  for (const name of ["jid1AttestationAddress", "jid1PaymentEvidenceAddress", "jid1RatingAddress", "jid1BundleAddress"]) {
   expect(typeof api()[name]).toBe("function");
   expect((root as unknown as Record<string, unknown>)[name]).toBe(api()[name]);
  }
 });
 test("uses exact admitted bytes and CF-4 encoding", () => {
  const results = calls(JOB).map(f => f());
  expect(results).toEqual([`dacs2:${JOB}:lei:a%3Ab:v2`, `dacs4:payment:${JOB}:rail%3Aone:3:resolved`,
   `dacs5:rating:${JOB}:rater%3Aone`, "stor-" + createHash("sha256").update(JOB + "-bundle-buyer").digest("hex")]);
 });
 test.each(BAD.map((value, i) => [i, value] as const))("rejects spec-malformed case %s before hashing", (_i, value) => {
  const spy = vi.spyOn(hash, "sha256Hex");
  try { for (const call of calls(value)) expect(call).toThrow(DacsError); expect(spy).not.toHaveBeenCalled(); }
  finally { spy.mockRestore(); }
 });
 test("validates jobId before other arguments", () => {
  expect(() => api().jid1AttestationAddress!("bad", "UPPER", "", 0)).toThrow(/jobId/);
 });
 test("delegates other segment validation and preserves historical API", () => {
  expect(() => api().jid1AttestationAddress!(JOB, "UPPER", "x", 1)).toThrow(/scheme/);
  expect(canonical.attestationAddress("job-abc", "lei", "x", 1)).toBe("dacs2:job-abc:lei:x:v1");
  for (const role of ["buyer","seller","orchestrator"] as const)
   expect(api().jid1BundleAddress!(JOB, role)).toBe(canonical.bundleAddress(JOB, role));
 });
});

// Positive spy control: prove this hook observes valid bundle hashing too.
test("hash spy observes a valid bundle derivation", () => {
 const spy = vi.spyOn(hash, "sha256Hex");
 try { api().jid1BundleAddress!(JOB, "buyer"); expect(spy).toHaveBeenCalledOnce(); }
 finally { spy.mockRestore(); }
});
test.each(["7" + "Z".repeat(25), ...["H","J","K","M","N","P","T","V"].map(c => "0" + c.repeat(25))])("accepts spec alphabet edge %s", (job) => {
 expect(api().jid1RatingAddress!(job, "rater")).toBe(`dacs5:rating:${job}:rater`);
});
test("current bundle helper refuses an unknown role before hashing", () => {
 const spy = vi.spyOn(hash, "sha256Hex");
 try { expect(() => api().jid1BundleAddress!(JOB, "unknown")).toThrow(DacsError); expect(spy).not.toHaveBeenCalled(); }
 finally { spy.mockRestore(); }
});
