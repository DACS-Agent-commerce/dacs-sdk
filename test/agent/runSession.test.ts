import { describe, expect, test } from "vitest";

import {
  runSessionCore,
  type SessionDeps,
  type SessionTerms,
} from "../../src/agent/runSessionCore.js";
import type { SettlementFinalityParameters } from "../../src/artifacts/types.js";

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
    signBytes: async () => new Uint8Array(64),
    anchor: async (name) => `stor-${name}`,
    resolveAnchor: async () => ({ status: "absent" as const }),
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
    // These fixtures exercise ORCHESTRATION, not listing signatures — the #41
    // gate itself is covered by its own cases below and in discover.test.ts.
    trustListing: true,
    ...overrides,
  };
}

const VALID_FINALITIES = [
  { name: "block-depth without echo", finality: { model: "block-depth" } },
  {
    name: "block-depth with echo",
    finality: { model: "block-depth", finalityBlocks: 12 },
  },
  {
    name: "commitment-level without echo",
    finality: { model: "commitment-level" },
  },
  {
    name: "commitment-level processed",
    finality: {
      model: "commitment-level",
      finalityCommitmentLevel: "processed",
    },
  },
  {
    name: "commitment-level confirmed",
    finality: {
      model: "commitment-level",
      finalityCommitmentLevel: "confirmed",
    },
  },
  {
    name: "commitment-level finalized",
    finality: {
      model: "commitment-level",
      finalityCommitmentLevel: "finalized",
    },
  },
  { name: "provider-receipt", finality: { model: "provider-receipt" } },
  { name: "htlc-reveal", finality: { model: "htlc-reveal" } },
  { name: "liquidity-tank", finality: { model: "liquidity-tank" } },
  { name: "bft-final", finality: { model: "bft-final" } },
] satisfies ReadonlyArray<{
  name: string;
  finality: SettlementFinalityParameters;
}>;

describe("runSession orchestration (T4)", () => {
  test("happy path anchors agreement+evidence+bundle and completes", async () => {
    const res = await runSessionCore("stor-listing", TERMS, makeDeps());
    expect(res.outcome).toBe("completed");
    expect(res.jobId).toBe("job-1");
    expect(res.agreementRef).toBe("stor-dacs3:agreement:job-1");
    expect(res.settlementRef).toBe("stor-dacs4:evidence:job-1");
    expect(res.bundleRef).toBe("stor-dacs5:bundle:job-1");
  });

  test("rail-reported finality flows onto the evidence (bft-final / demos / block), F7/#22", async () => {
    const anchored: Record<string, unknown> = {};
    await runSessionCore(
      "stor-listing",
      TERMS,
      makeDeps({
        settle: async () => ({
          ok: true,
          txHash: "demos:0xfeed",
          chainId: "demos",
          payer: "0xbob",
          payee: "0xalice",
          finality: { model: "bft-final" },
          blockNumber: 909,
          txRefKind: "demos",
        }),
        anchor: async (name: string, value: object) => {
          if (name.includes("evidence")) anchored.evidence = value;
          return `stor-${name}`;
        },
      }),
    );
    const ev = anchored.evidence as {
      settlementFinality: { model: string; finalityBlocks?: number };
      paymentTxRefs: Array<{ kind: string; blockNumber?: number }>;
    };
    expect(ev.settlementFinality.model).toBe("bft-final");
    expect(ev.settlementFinality.finalityBlocks).toBeUndefined();
    expect(ev.paymentTxRefs[0]!.kind).toBe("demos");
    expect(ev.paymentTxRefs[0]!.blockNumber).toBe(909);
  });

  test("evidence defaults to provider-receipt when the rail reports no finality", async () => {
    const anchored: Record<string, unknown> = {};
    await runSessionCore(
      "stor-listing",
      TERMS,
      makeDeps({
        anchor: async (name: string, value: object) => {
          if (name.includes("evidence")) anchored.evidence = value;
          return `stor-${name}`;
        },
      }),
    );
    const ev = anchored.evidence as {
      settlementFinality: { model: string; finalityBlocks?: number };
      paymentTxRefs: Array<{ kind: string; blockNumber?: number }>;
    };
    expect(ev.settlementFinality.model).toBe("provider-receipt");
    expect(ev.settlementFinality.finalityBlocks).toBeUndefined();
    expect(ev.paymentTxRefs[0]!.kind).toBe("payment");
    expect(ev.paymentTxRefs[0]!.blockNumber).toBeUndefined();
  });

  test("failed settlement yields outcome=failed", async () => {
    const anchored: Record<string, unknown> = {};
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
        anchor: async (name: string, value: object) => {
          if (name.includes("evidence")) anchored.evidence = value;
          return `stor-${name}`;
        },
      }),
    );
    expect(res.outcome).toBe("failed");
    expect(
      (anchored.evidence as { settlementFinality?: unknown }).settlementFinality,
    ).toBeUndefined();
  });

  test.each(VALID_FINALITIES)(
    "preserves $name finality through settlement and evidence production",
    async ({ finality }) => {
      const anchored: Record<string, unknown> = {};
      await runSessionCore(
        "stor-listing",
        TERMS,
        makeDeps({
          settle: async () => ({
            ok: true,
            txHash: "0xfinality",
            chainId: "test:1",
            payer: "0xbob",
            payee: "0xalice",
            finality,
          }),
          anchor: async (name: string, value: object) => {
            if (name.includes("evidence")) anchored.evidence = value;
            return `stor-${name}`;
          },
        }),
      );
      expect(
        (anchored.evidence as {
          settlementFinality: Record<string, unknown>;
        }).settlementFinality,
      ).toEqual({ ...finality, finalityObservedAt: 1780000000000 });
    },
  );

  test.each([
    { name: "unsupported model", finality: { model: "trust-me" } },
    {
      name: "negative block depth",
      finality: { model: "block-depth", finalityBlocks: -1 },
    },
    {
      name: "fractional block depth",
      finality: { model: "block-depth", finalityBlocks: 1.5 },
    },
    {
      name: "invalid commitment",
      finality: {
        model: "commitment-level",
        finalityCommitmentLevel: "kinda",
      },
    },
    {
      name: "block echo on commitment model",
      finality: { model: "commitment-level", finalityBlocks: 2 },
    },
    {
      name: "commitment echo on block model",
      finality: {
        model: "block-depth",
        finalityCommitmentLevel: "confirmed",
      },
    },
    {
      name: "parameter on provider-receipt",
      finality: { model: "provider-receipt", finalityBlocks: 2 },
    },
    {
      name: "parameter on htlc-reveal",
      finality: { model: "htlc-reveal", finalityBlocks: 2 },
    },
    {
      name: "parameter on liquidity-tank",
      finality: { model: "liquidity-tank", finalityBlocks: 2 },
    },
    {
      name: "parameter on bft-final",
      finality: { model: "bft-final", finalityBlocks: 2 },
    },
  ])("rejects $name from a settlement rail", async ({ finality }) => {
    await expect(
      runSessionCore(
        "stor-listing",
        TERMS,
        makeDeps({
          settle: async () => ({
            ok: true,
            txHash: "0xbad-finality",
            chainId: "test:1",
            payer: "0xbob",
            payee: "0xalice",
            finality: finality as never,
          }),
        }),
      ),
    ).rejects.toThrow(/finality/);
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
      resolveAnchor: async (name) => {
        const ref = `stor-${name}`;
        const value = store.get(ref);
        return value ? { status: "present" as const, ref, value } : { status: "absent" as const };
      },
      settle: async () => {
        settleCalls += 1;
        return { ok: true, txHash: "0x", chainId: "c", payer: "p", payee: "q" };
      },
      vet: async (subject) => ({
        subject,
        recipeId: "self-signed",
        recipeVersion: "0.1",
        results: [{ claimRef: subject, method: "self-signed", status: "pass" }],
        decision: "pass",
        verifiedAt: "2026-01-01T00:00:00Z",
      }),
    });

    const res = await runSessionCore("stor-listing", TERMS, deps, "job-VET");
    expect(res.outcome).toBe("completed");
    expect(res.vetRef).toBe("stor-dacs2:verifyrecord:job-VET");
    expect(settleCalls).toBe(1);
    // Spec bundle: vet record + settlement evidence are content-addressed refs,
    // a buyer party, and a signature.
    const bundle = store.get(res.bundleRef)! as Record<string, any>;
    expect(bundle.bundleVersion).toBe("1");
    expect(bundle.outcome).toBe("completed");
    expect(bundle.vetRecords).toHaveLength(1);
    expect(bundle.settlementEvidence).toHaveLength(1);
    expect(bundle.parties[0].primaryClaim).toBe("did:demos:agent:bob");
    expect(bundle.signatures[0].party).toBe("did:demos:agent:bob");
  });

  test("vet fail: aborts before settlement (never pays a failed seller)", async () => {
    let settleCalls = 0;
    const deps = makeDeps({
      anchor: async (name) => `stor-${name}`,
      resolveAnchor: async () => ({ status: "absent" as const }),
      settle: async () => {
        settleCalls += 1;
        return { ok: true, txHash: "0x", chainId: "c", payer: "p", payee: "q" };
      },
      vet: async (subject) => ({
        subject,
        recipeId: "domain-acme",
        recipeVersion: "0.1",
        results: [{ claimRef: subject, method: "consensus-backed-proxy", status: "fail" }],
        decision: "fail",
        verifiedAt: "2026-01-01T00:00:00Z",
      }),
    });

    await expect(runSessionCore("stor-listing", TERMS, deps, "job-VETFAIL")).rejects.toThrow(
      /did not pass verification/,
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
      resolveAnchor: async (name) => {
        const ref = `stor-${name}`;
        const value = store.get(ref);
        return value ? { status: "present" as const, ref, value } : { status: "absent" as const };
      },
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

  test("resume aborts when the anchored artifact is for a different deal", async () => {
    const store = new Map<string, Record<string, unknown>>();
    let settleCalls = 0;
    // A prior session at this jobId's address negotiated a DIFFERENT price.
    store.set("stor-dacs3:agreement:job-WRONG", {
      jobId: "job-WRONG",
      pattern: "negotiate-fixed-price",
      buyer: "did:demos:agent:bob",
      seller: "did:demos:agent:alice",
      listingRef: "stor-listing",
      price: { amount: "999", asset: "USDC", decimals: 6, rail: "pay-x402" },
      delivery: { phase: "deliver-attested-payload", format: "application/json" },
      expiresAt: "2026-01-01T00:00:00Z",
      signature: "sig",
    });
    const deps = makeDeps({
      anchor: async (name, value) => {
        const addr = `stor-${name}`;
        store.set(addr, value as Record<string, unknown>);
        return addr;
      },
      resolveAnchor: async (name) => {
        const ref = `stor-${name}`;
        const value = store.get(ref);
        return value ? { status: "present" as const, ref, value } : { status: "absent" as const };
      },
      settle: async () => {
        settleCalls += 1;
        return { ok: true, txHash: "0xabc", chainId: "c", payer: "p", payee: "q" };
      },
    });

    await expect(
      runSessionCore("stor-listing", TERMS, deps, "job-WRONG"),
    ).rejects.toThrow(/does not match the requested deal/);
    expect(settleCalls).toBe(0); // never paid against a mismatched session
  });

  // ── #41: a session must independently verify the listing ──

  test("requires an explicit listing-verification gate (no fail-open)", async () => {
    const { trustListing: _drop, ...deps } = makeDeps();
    await expect(
      runSessionCore("stor-listing", TERMS, deps as never),
    ).rejects.toThrow(/verifyListing|trustListing/);
  });

  test("an UNVERIFIED listing aborts before vetting or settlement — never pays", async () => {
    let settleCalls = 0;
    let vetCalls = 0;
    const deps = makeDeps({
      trustListing: undefined,
      verifyListing: () => false, // signature doesn't verify
      vet: async () => {
        vetCalls += 1;
        throw new Error("vet must not run on an unverified listing");
      },
      settle: async () => {
        settleCalls += 1;
        throw new Error("settle must not run on an unverified listing");
      },
    });
    await expect(runSessionCore("stor-listing", TERMS, deps)).rejects.toThrow(
      /failed signature verification/,
    );
    expect(vetCalls).toBe(0);
    expect(settleCalls).toBe(0);
  });

  test("a THROWING verifier is not a pass (fails closed)", async () => {
    let settleCalls = 0;
    const deps = makeDeps({
      trustListing: undefined,
      verifyListing: () => {
        throw new Error("verifier blew up");
      },
      settle: async () => {
        settleCalls += 1;
        throw new Error("must not settle");
      },
    });
    await expect(runSessionCore("stor-listing", TERMS, deps)).rejects.toThrow(
      /failed signature verification/,
    );
    expect(settleCalls).toBe(0);
  });

  test("the verifier receives the raw artifact and the ADVERTISED seller claim", async () => {
    let seenSeller = "";
    const deps = makeDeps({
      trustListing: undefined,
      verifyListing: (raw, seller) => {
        seenSeller = seller;
        return "signature" in raw; // proves the signature was NOT stripped first
      },
    });
    const res = await runSessionCore("stor-listing", TERMS, deps);
    expect(res.outcome).toBe("completed");
    expect(seenSeller).toBe("did:demos:agent:alice");
  });

  test("resume with an INDETERMINATE evidence lookup aborts — never re-settles (#70 double-pay)", async () => {
    let settleCalls = 0;
    // The agreement is already anchored (valid, matching); the evidence lookup
    // comes back INDETERMINATE (a substrate hiccup). Treating that as "absent"
    // would re-settle → double-pay. The session must fail closed instead.
    const agreement = {
      jobId: "job-DP",
      pattern: "negotiate-fixed-price",
      buyer: "did:demos:agent:bob",
      seller: "did:demos:agent:alice",
      listingRef: "stor-listing",
      price: TERMS.price,
      delivery: { phase: TERMS.deliveryPhase, format: TERMS.deliveryFormat },
      expiresAt: "2026-01-01T00:00:00Z",
      signature: "sig",
    };
    const deps = makeDeps({
      resolveAnchor: async (name) => {
        if (name === "dacs3:agreement:job-DP")
          return { status: "present" as const, ref: "stor-a", value: agreement };
        if (name === "dacs4:evidence:job-DP")
          return { status: "indeterminate" as const, reason: "rpc timeout" };
        return { status: "absent" as const };
      },
      settle: async () => {
        settleCalls += 1;
        return { ok: true, txHash: "0x", chainId: "c", payer: "p", payee: "q" };
      },
    });

    await expect(runSessionCore("stor-listing", TERMS, deps, "job-DP")).rejects.toThrow(
      /could not determine/,
    );
    expect(settleCalls).toBe(0); // a transient evidence-lookup failure must NOT re-settle
  });
});
