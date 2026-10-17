import { describe, expect, it, vi } from "vitest";
import { CORRECTIVE_PROFILE, requireAdmissibleProfile } from "../../src/profile.js";
import { DACS_STANDARD_PIN } from "../../src/version.js";
import { createAgent } from "../../src/agent/Agent.js";
import { validateListingArtifact } from "../../src/agent/listingValidation.js";
import { runSessionCore } from "../../src/agent/runSessionCore.js";
import { discoverListings } from "../../src/agent/discover.js";
import { readListingByLogicalAddress, enumerateListingsForSeller } from "../../src/agent/listingDiscovery.js";
import { verifySellerPaymentIntake } from "../../src/seller/paymentIntake.js";
import { createFixedPricePayDemSellerCoordinator, createInMemoryFixedPricePayDemCoordinatorStore } from "../../src/commerce/index.js";

describe("unreleased corrective profile admission", () => {
  it.each(["live", "simulation"] as const)("refuses a %s label on a connected Demos factory before any node call", async (executionMode) => {
    await expect(createAgent({ demosRpc: "https://node.example", executionMode })).rejects.toThrow(/unreleased/);
  });

  it("pins the complete candidate tuple and has no live release to admit", () => {
    expect(CORRECTIVE_PROFILE).toEqual({ specificationCommit: DACS_STANDARD_PIN,
      coordinatedRelease: null, documents: { CORE: "0.3", "DACS-1": "0.7", "DACS-2": "0.6",
        "DACS-3": "0.5", "DACS-4": "0.8", "DACS-5": "0.5" } });
    expect(Object.isFrozen(CORRECTIVE_PROFILE.documents)).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["matching candidate", { ...CORRECTIVE_PROFILE, session: "session-a", participants: ["buyer", "seller"] }],
    ["duplicate participant", { session: "session-a", participants: ["buyer", "buyer"] }],
    ["session mismatch", { session: "session-b", participants: ["buyer", "seller"] }],
    ["identity mismatch", { session: "session-a", participants: ["buyer", "other-seller"] }],
    ["pin mismatch", { ...CORRECTIVE_PROFILE, specificationCommit: "0".repeat(40) }],
    ["unauthenticated label", "profile:current"],
  ])("refuses %s caller evidence: no assertion can release this candidate", (_name, profileAdmission) => {
    expect(() => requireAdmissibleProfile({ profileAdmission } as never)).toThrow(/unreleased/);
  });

  it("refuses live Listing/session/payment operations before any artifact or dependency callback", async () => {
    const called = vi.fn();
    const deps = { readListing: called, verifyListingSignature: called,
      resolveCommittedAgreement: called, readAnchor: called, index: { resolve: called },
      executionMode: "live" } as never;
    const input = { get executionMode() { called(); return "simulation"; } } as never;
    await expect(validateListingArtifact(input, deps)).rejects.toThrow(/unreleased/);
    await expect(runSessionCore("listing", input, deps)).rejects.toThrow(/unreleased/);
    await expect(verifySellerPaymentIntake(input, deps)).rejects.toThrow(/unreleased/);
    await expect(discoverListings(["listing"], called, deps)).rejects.toThrow(/unreleased/);
    await expect(readListingByLogicalAddress("listing", deps)).rejects.toThrow(/unreleased/);
    await expect(enumerateListingsForSeller("seller", deps)).rejects.toThrow(/unreleased/);
    expect(called).not.toHaveBeenCalled();
  });

  it("captures coordinator policy before caller mutation and refuses before signing or payment", async () => {
    const operation = vi.fn();
    const store = createInMemoryFixedPricePayDemCoordinatorStore();
    const create = vi.spyOn(store, "create");
    const options = { executionMode: "live" as "live" | "simulation", store,
      workerId: "profile-test", operations: { agreement: operation, payment: operation } };
    const coordinator = createFixedPricePayDemSellerCoordinator(options);
    options.executionMode = "simulation";
    await expect(coordinator.startOrder({ executionMode: "simulation" } as never)).rejects.toThrow(/unreleased/);
    await expect(coordinator.runPending()).rejects.toThrow(/unreleased/);
    expect(create).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
  });

  it("does not invoke policy accessors or proxy traps", () => {
    const getter = vi.fn(() => "simulation");
    expect(() => requireAdmissibleProfile(Object.defineProperty({}, "executionMode", { get: getter })))
      .toThrow(/stable data/);
    const trap = vi.fn();
    expect(() => requireAdmissibleProfile(new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap })))
      .toThrow(/stable data/);
    expect(getter).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
  });
});
