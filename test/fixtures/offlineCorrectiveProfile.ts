import { vi } from "vitest";

// Offline conformance and crash-recovery fixtures exercise the candidate's
// mechanics. This substitution lives only in the test runner; it grants no
// release/admission authority to a built SDK. Production-policy tests unmock it.
vi.mock("../../src/negotiate/correctiveProfileRelease.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/negotiate/correctiveProfileRelease.js")>();
  return { ...actual, requireReleasedCorrectiveProfile: () => {
    // Live integrations must always exercise the production release policy.
    if (Object.entries(process.env).some(([key, value]) => /LIVE|FUNDED/.test(key) && value && value !== "0" && value !== "false")) {
      actual.requireReleasedCorrectiveProfile();
    }
  } };
});
