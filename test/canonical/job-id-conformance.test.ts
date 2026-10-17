import { describe, expect, test } from "vitest";
import { attestationAddress, paymentEvidenceAddress, ratingAddress, bundleAddress } from "../../src/canonical/addressing.js";

// Enable when current-profile builders and their explicit legacy interface are split.
describe.skip("JID-3 builder conformance pending legacy migration", () => {
  test.each([
    ["attestation", () => attestationAddress("job-abc", "lei", "id", 1)],
    ["payment", () => paymentEvidenceAddress("job-abc", "rail", 0)],
    ["rating", () => ratingAddress("job-abc", "key:public")],
    ["bundle", () => bundleAddress("job-abc", "buyer")],
  ])("%s rejects a non-JID-1 job", (_name, build) => {
    expect(build).toThrow();
  });
});
