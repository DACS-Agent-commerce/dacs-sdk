import { describe, expect, test } from "vitest";

import {
  runSessionCore,
  type SessionDeps,
  type SessionTerms,
} from "../../src/agent/runSessionCore.js";
import { contentHash } from "../../src/canonical/index.js";
import { UnsupportedCapabilityError } from "../../src/errors.js";

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

const normativeListing = () => ({
  dacsVersion: "1" as const,
  listingVersion: 7,
  listingId: "market-data-vendor",
  seller: {
    identity: {
      bundleVersion: "1" as const,
      presentedBy: "did:demos:agent:alice",
      presentedAt: 1_770_000_000_000,
      claims: [{ ref: "did:demos:agent:alice" }],
      presentation: {
        kind: "per-claim" as const,
        signatures: [
          { ref: "did:demos:agent:alice", signature: "presentation" },
        ],
      },
    },
    displayName: "Alice",
    publicEndpoint: "https://alice.example/dacs",
  },
  offering: {
    title: "Market Data",
    description: "Pinned listing",
    category: "data.finance",
    tags: ["market"],
    deliverable: {
      kind: "attested-payload" as const,
      payloadFormat: "application/json",
    },
  },
  buyerRequirement: { requirementVersion: "1" as const, required: [] },
  pipeline: [
    { kind: "negotiate-fixed-price" as const },
    { kind: "commit-agreement" as const },
    { kind: "pay-x402" as const, parameters: { rail: "x402:default" } },
    { kind: "deliver-attested-payload" as const },
  ],
  pricing: {
    kind: "fixed" as const,
    price: { amount: "1", currency: "USDC" },
  },
  acceptedRails: [{ railId: "x402:default" }],
  terms: { deadlineSecAfterCommit: 3_600 },
  validity: { notBefore: 1_770_000_000_000 },
  signature: {
    algorithm: "ed25519" as const,
    signer: "did:demos:agent:alice",
    value: "AQ",
  },
});

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

describe("runSession orchestration (T4)", () => {
  test("happy path anchors agreement+evidence+bundle and completes", async () => {
    const res = await runSessionCore("stor-listing", TERMS, makeDeps());
    expect(res.outcome).toBe("completed");
    expect(res.jobId).toBe("job-1");
    expect(res.agreementRef).toBe("stor-dacs3:agreement:job-1");
    expect(res.settlementRef).toBe("stor-dacs4:evidence:job-1");
    expect(res.bundleRef).toBe("stor-dacs5:bundle:job-1");
  });

  test("pins the exact normative Listing tuple once for the whole session (LR-1)", async () => {
    const normative = normativeListing();
    let evidence: Record<string, unknown> | undefined;
    let selectedRail: string | undefined;
    const res = await runSessionCore(
      "stor-normative-v7",
      {
        ...TERMS,
        price: { ...TERMS.price, rail: "x402:default" },
      },
      makeDeps({
        readListing: async () => normative,
        settle: async (request) => {
          selectedRail = request.rail;
          return {
            ok: true,
            txHash: "0xabc",
            chainId: "eip155:8453",
            payer: "0xbob",
            payee: "0xalice",
          };
        },
        anchor: async (name, value) => {
          if (name.includes("evidence")) {
            evidence = value as Record<string, unknown>;
          }
          return `stor-${name}`;
        },
      }),
    );
    expect(res.listingPin).toEqual({
      listingId: "market-data-vendor",
      version: 7,
      contentHash: contentHash(normative),
    });
    expect(selectedRail).toBe("x402:default");
    expect(evidence?.phase).toBe("pay-x402");
  });

  test("treats notAfter as inclusive but never bypasses a future notBefore on resume", async () => {
    const boundary = 1_780_000_000_000;
    const atExpiry = {
      ...normativeListing(),
      validity: { notBefore: boundary - 1, notAfter: boundary },
    };
    const terms = {
      ...TERMS,
      price: { ...TERMS.price, rail: "x402:default" },
    };
    await expect(
      runSessionCore(
        "stor-valid-through-boundary",
        terms,
        makeDeps({ readListing: async () => atExpiry, nowMs: () => boundary }),
      ),
    ).resolves.toMatchObject({ outcome: "completed" });

    const future = {
      ...normativeListing(),
      validity: { notBefore: boundary + 1, notAfter: boundary + 10_000 },
    };
    let effects = 0;
    await expect(
      runSessionCore(
        "stor-not-yet-valid",
        terms,
        makeDeps({
          readListing: async () => future,
          nowMs: () => boundary,
          resolveAnchor: async () => {
            effects += 1;
            return { status: "absent" as const };
          },
          anchor: async () => {
            effects += 1;
            throw new Error("must not anchor");
          },
          settle: async () => {
            effects += 1;
            throw new Error("must not settle");
          },
        }),
        "job-FUTURE",
      ),
    ).rejects.toThrow(/outside.*validity window/i);
    expect(effects).toBe(0);
  });

  test("refuses unsupported PIPE-5 repetition before settlement or anchoring", async () => {
    const normative = normativeListing();
    normative.pipeline.splice(3, 0, {
      kind: "pay-x402",
      parameters: { rail: "x402:default" },
    });
    let settles = 0;
    let anchors = 0;

    const attempt = runSessionCore(
      "stor-repeated-payment-phase",
      {
        ...TERMS,
        price: { ...TERMS.price, rail: "x402:default" },
      },
      makeDeps({
        readListing: async () => normative,
        settle: async () => {
          settles += 1;
          throw new Error("must not settle");
        },
        anchor: async () => {
          anchors += 1;
          throw new Error("must not anchor");
        },
      }),
    );

    await expect(attempt).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(attempt).rejects.toMatchObject({
      name: "UnsupportedCapabilityError",
      category: "permanent",
      message: expect.stringMatching(
        /PIPE-5 repetition is valid.*single-settle orchestrator supports one/i,
      ),
    });

    expect(settles).toBe(0);
    expect(anchors).toBe(0);
  });

  test("refuses payment phases on different rails before selecting only one", async () => {
    const normative = normativeListing();
    normative.acceptedRails.push({ railId: "evm:secondary" });
    normative.pipeline.splice(3, 0, {
      kind: "pay-x402",
      parameters: { rail: "evm:secondary" },
    });
    let settles = 0;
    let anchors = 0;

    const attempt = runSessionCore(
      "stor-multi-rail-payment-phases",
      {
        ...TERMS,
        price: { ...TERMS.price, rail: "x402:default" },
      },
      makeDeps({
        readListing: async () => normative,
        settle: async () => {
          settles += 1;
          throw new Error("must not settle");
        },
        anchor: async () => {
          anchors += 1;
          throw new Error("must not anchor");
        },
      }),
    );

    await expect(attempt).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(attempt).rejects.toThrow(/2 pay-\* invocations.*single-settle/i);
    expect(settles).toBe(0);
    expect(anchors).toBe(0);
  });

  test("refuses to pay presentedBy when a different carried claim signed", async () => {
    const normative = normativeListing();
    normative.seller.identity.claims.push({ ref: "did:demos:agent:signer" });
    normative.signature.signer = "did:demos:agent:signer";
    let settles = 0;

    await expect(
      runSessionCore(
        "stor-unbound-payee",
        {
          ...TERMS,
          price: { ...TERMS.price, rail: "x402:default" },
        },
        makeDeps({
          readListing: async () => normative,
          settle: async () => {
            settles += 1;
            throw new Error("must not settle");
          },
        }),
      ),
    ).rejects.toThrow(/not payee-bound|signer must equal/i);
    expect(settles).toBe(0);
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

  test("block-depth success requires and records finalityBlocks", async () => {
    const anchored: Record<string, unknown> = {};
    await runSessionCore(
      "stor-listing",
      TERMS,
      makeDeps({
        settle: async () => ({
          ok: true,
          txHash: "0xdepth",
          chainId: "eip155:1",
          payer: "0xbob",
          payee: "0xalice",
          finality: { model: "block-depth", finalityBlocks: 12 },
        }),
        anchor: async (name: string, value: object) => {
          if (name.includes("evidence")) anchored.evidence = value;
          return `stor-${name}`;
        },
      }),
    );
    expect(
      (anchored.evidence as {
        settlementFinality: { model: string; finalityBlocks: number };
      }).settlementFinality,
    ).toMatchObject({ model: "block-depth", finalityBlocks: 12 });
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

  test("finishes an admitted session after Listing expiry but rejects an arbitrary resume id", async () => {
    const expiry = 1_780_000_000_100;
    const normative = {
      ...normativeListing(),
      validity: { notBefore: 1_770_000_000_000, notAfter: expiry },
    };
    const store = new Map<string, Record<string, unknown>>();
    let now = 1_780_000_000_000;
    let failBundleOnce = true;
    let settleCalls = 0;
    let anchorCalls = 0;
    const deps = makeDeps({
      readListing: async () => normative,
      nowMs: () => now,
      anchor: async (name, value) => {
        anchorCalls += 1;
        if (name === "dacs5:bundle:job-EXPIRES" && failBundleOnce) {
          failBundleOnce = false;
          throw new Error("simulated crash before bundle publication");
        }
        const ref = `stor-${name}`;
        store.set(ref, value as Record<string, unknown>);
        return ref;
      },
      resolveAnchor: async (name) => {
        const ref = `stor-${name}`;
        const value = store.get(ref);
        return value
          ? { status: "present" as const, ref, value }
          : { status: "absent" as const };
      },
      settle: async () => {
        settleCalls += 1;
        return {
          ok: true,
          txHash: "0xexpiry",
          chainId: "eip155:8453",
          payer: "0xbob",
          payee: "0xalice",
        };
      },
    });
    const terms = {
      ...TERMS,
      price: { ...TERMS.price, rail: "x402:default" },
    };

    await expect(
      runSessionCore("stor-expiring-listing", terms, deps, "job-EXPIRES"),
    ).rejects.toThrow(/simulated crash/);
    expect(settleCalls).toBe(1);

    now = expiry + 1;
    await expect(
      runSessionCore("stor-expiring-listing", terms, deps, "job-EXPIRES"),
    ).resolves.toMatchObject({ outcome: "completed", jobId: "job-EXPIRES" });
    expect(settleCalls).toBe(1);

    const callsBeforeRejectedResume = anchorCalls;
    await expect(
      runSessionCore("stor-expiring-listing", terms, deps, "job-NOT-ADMITTED"),
    ).rejects.toThrow(/outside.*validity window.*no prior Agreement/i);
    expect(settleCalls).toBe(1);
    expect(anchorCalls).toBe(callsBeforeRejectedResume);

    let freshIds = 0;
    await expect(
      runSessionCore(
        "stor-expiring-listing",
        terms,
        { ...deps, newJobId: () => `fresh-${++freshIds}` },
      ),
    ).rejects.toThrow(/outside.*validity window/i);
    expect(freshIds).toBe(0);
    expect(settleCalls).toBe(1);
    expect(anchorCalls).toBe(callsBeforeRejectedResume);

    store.set("stor-dacs3:agreement:job-AGREEMENT-ONLY", {
      jobId: "job-AGREEMENT-ONLY",
      pattern: "negotiate-fixed-price",
      buyer: "did:demos:agent:bob",
      seller: "did:demos:agent:alice",
      listingRef: "stor-expiring-listing",
      price: terms.price,
      delivery: { phase: terms.deliveryPhase, format: terms.deliveryFormat },
      expiresAt: "2026-01-01T00:00:00Z",
      signature: "sig",
    });
    await expect(
      runSessionCore(
        "stor-expiring-listing",
        terms,
        deps,
        "job-AGREEMENT-ONLY",
      ),
    ).rejects.toThrow(/no prior SettlementEvidence/i);
    expect(settleCalls).toBe(1);
    expect(anchorCalls).toBe(callsBeforeRejectedResume);
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
