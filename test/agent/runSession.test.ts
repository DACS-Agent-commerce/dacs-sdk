import { describe, expect, test } from "vitest";

import {
  runSessionCore,
  type SessionDeps,
  type SessionTerms,
} from "../../src/agent/runSessionCore.js";

const LISTING = {
  agentId: "did:demos:agent:alice",
  serviceId: "svc-1",
  name: "Market Data",
  description: "d",
  claimRequirements: [],
  supportedNegotiation: ["negotiate-fixed-price"],
  supportedPaymentRails: ["pay-x402"],
  supportedDelivery: ["deliver-attested-payload"],
  signature: "deadbeef", // stored as a signed envelope
};

const TERMS: SessionTerms = {
  price: { amount: "1000000", asset: "USDC", decimals: 6, rail: "pay-x402" },
  deliveryPhase: "deliver-attested-payload",
  deliveryFormat: "application/json",
};

function makeDeps(overrides: Partial<SessionDeps> = {}): SessionDeps {
  return {
    buyerId: "did:demos:agent:bob",
    readListing: async () => LISTING,
    sign: async (a, sep) => ({ ...a, signature: "sig", _sep: sep }),
    anchor: async (name) => `stor-${name}`,
    anchorAddress: async (name) => `stor-${name}`,
    readAnchor: async () => null,
    settle: async () => ({
      ok: true,
      txHash: "0xabc",
      chainId: "eip155:11155111",
      payer: "0xbob",
      payee: "0xalice",
    }),
    newJobId: () => "job-1",
    now: () => "2026-01-01T00:00:00Z",
    nowMs: () => 1780000000000,
    ...overrides,
  };
}

describe("runSession orchestration (T4)", () => {
  test("happy path anchors agreement+evidence+bundle and completes", async () => {
    const res = await runSessionCore("stor-listing", TERMS, makeDeps());
    expect(res.outcome).toBe("completed");
    expect(res.jobId).toBe("job-1");
    expect(res.agreementRef).toBe("stor-dacs3:agreement:job-1");
    expect(res.settlementRef).toBe("stor-dacs4:evidence:job-1");
    expect(res.bundleRef).toBe("stor-dacs5:bundle:job-1");
  });

  test("failed settlement yields outcome=failed", async () => {
    const res = await runSessionCore(
      "stor-listing",
      TERMS,
      makeDeps({
        settle: async () => ({
          ok: false,
          txHash: "",
          chainId: "x",
          payer: "p",
          payee: "q",
        }),
      }),
    );
    expect(res.outcome).toBe("failed");
  });

  test("rejects a rail the listing doesn't offer", async () => {
    await expect(
      runSessionCore(
        "stor-listing",
        { ...TERMS, price: { ...TERMS.price, rail: "pay-evm-erc20" } },
        makeDeps(),
      ),
    ).rejects.toThrow(/rail/);
  });

  test("rejects an invalid listing", async () => {
    await expect(
      runSessionCore("stor-x", TERMS, makeDeps({ readListing: async () => ({ not: "a listing" }) })),
    ).rejects.toThrow(/listing/);
  });

  test("vet pass: anchors the CVR, includes it in the bundle, then settles", async () => {
    const store = new Map<string, Record<string, unknown>>();
    let settleCalls = 0;
    const deps = makeDeps({
      anchor: async (name, value) => {
        const addr = `stor-${name}`;
        store.set(addr, value as Record<string, unknown>);
        return addr;
      },
      anchorAddress: async (name) => `stor-${name}`,
      readAnchor: async (addr) => store.get(addr) ?? null,
      settle: async () => {
        settleCalls += 1;
        return { ok: true, txHash: "0x", chainId: "c", payer: "p", payee: "q" };
      },
      vet: async (subject) => ({
        subject,
        recipeId: "self-signed",
        recipeVersion: "0.1",
        results: [{ claimRef: subject, method: "self-signed", status: "pass" }],
        requiredPassed: true,
        verifiedAt: "2026-01-01T00:00:00Z",
      }),
    });

    const res = await runSessionCore("stor-listing", TERMS, deps, "job-VET");
    expect(res.outcome).toBe("completed");
    expect(res.vetRef).toBe("stor-dacs2:verifyrecord:job-VET");
    expect(settleCalls).toBe(1);
    // The CVR ref sits between the listing and the agreement in the bundle.
    const bundle = store.get(res.bundleRef)!;
    expect(bundle.artifactRefs).toEqual([
      "stor-listing",
      res.vetRef,
      res.agreementRef,
      res.settlementRef,
    ]);
  });

  test("vet fail: aborts before settlement (never pays a failed seller)", async () => {
    let settleCalls = 0;
    const deps = makeDeps({
      anchor: async (name) => `stor-${name}`,
      anchorAddress: async (name) => `stor-${name}`,
      readAnchor: async () => null,
      settle: async () => {
        settleCalls += 1;
        return { ok: true, txHash: "0x", chainId: "c", payer: "p", payee: "q" };
      },
      vet: async (subject) => ({
        subject,
        recipeId: "domain-acme",
        recipeVersion: "0.1",
        results: [{ claimRef: subject, method: "consensus-backed-proxy", status: "fail" }],
        requiredPassed: false,
        verifiedAt: "2026-01-01T00:00:00Z",
      }),
    });

    await expect(runSessionCore("stor-listing", TERMS, deps, "job-VETFAIL")).rejects.toThrow(
      /failed verification/,
    );
    expect(settleCalls).toBe(0);
  });

  test("resume with the same jobId reuses artifacts and never re-pays", async () => {
    const store = new Map<string, Record<string, unknown>>();
    let settleCalls = 0;
    const deps = makeDeps({
      anchor: async (name, value) => {
        const addr = `stor-${name}`;
        store.set(addr, value as Record<string, unknown>);
        return addr;
      },
      anchorAddress: async (name) => `stor-${name}`,
      readAnchor: async (addr) => store.get(addr) ?? null,
      settle: async () => {
        settleCalls += 1;
        return { ok: true, txHash: "0xabc", chainId: "c", payer: "p", payee: "q" };
      },
    });

    const first = await runSessionCore("stor-listing", TERMS, deps, "job-RESUME");
    expect(first.outcome).toBe("completed");
    expect(settleCalls).toBe(1);

    // Re-drive the same jobId (as after a crash) — everything is already anchored.
    const second = await runSessionCore("stor-listing", TERMS, deps, "job-RESUME");
    expect(second).toEqual(first); // identical refs
    expect(settleCalls).toBe(1); // settlement NOT executed again
  });
});
