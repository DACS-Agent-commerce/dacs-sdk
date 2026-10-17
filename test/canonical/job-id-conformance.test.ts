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
