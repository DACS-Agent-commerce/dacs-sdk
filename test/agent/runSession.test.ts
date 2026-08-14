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
    expectedSettlementPayee: "0xalice",
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

  test("rejects dependency accessors without invoking them or reading the Listing", async () => {
    const deps = makeDeps();
    let getterCalls = 0;
    let listingReads = 0;
    deps.readListing = async () => {
      listingReads += 1;
      return LISTING;
    };
    Object.defineProperty(deps, "settle", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return async () => ({
          ok: true,
          txHash: "0xgetter",
          chainId: "chain",
          payer: "payer",
          payee: "payee",
        });
      },
    });
    await expect(runSessionCore("stor-listing", TERMS, deps)).rejects.toThrow(
      /deps\.settle must be stable data/,
    );
    expect(getterCalls).toBe(0);
    expect(listingReads).toBe(0);
  });

  test("pins the signer, anchor, and rail callbacks before Listing resolution", async () => {
    const deps = makeDeps();
    const originalSettle = deps.settle;
    const originalSign = deps.sign;
    const originalAnchor = deps.anchor;
    let replacementCalls = 0;
    deps.readListing = async () => {
      deps.settle = async () => {
        replacementCalls += 1;
        throw new Error("replacement rail must not run");
      };
      deps.sign = async () => {
        replacementCalls += 1;
        throw new Error("replacement signer must not run");
      };
      deps.anchor = async () => {
        replacementCalls += 1;
        throw new Error("replacement anchor must not run");
      };
      await Promise.resolve();
      return LISTING;
    };
    await expect(runSessionCore("stor-listing", TERMS, deps)).resolves.toMatchObject({
      outcome: "completed",
    });
    expect(deps.settle).not.toBe(originalSettle);
    expect(deps.sign).not.toBe(originalSign);
    expect(deps.anchor).not.toBe(originalAnchor);
    expect(replacementCalls).toBe(0);
  });

  test("rejects a newly signed Agreement that changes the authenticated deal", async () => {
    const deps = makeDeps({
      sign: async (artifact) => ({
        ...artifact,
        buyer: "did:demos:agent:attacker",
        signature: "sig",
      }),
    });
    let settles = 0;
    deps.settle = async () => {
      settles += 1;
      throw new Error("must not settle");
    };
    await expect(runSessionCore("stor-listing", TERMS, deps)).rejects.toThrow(
      /new artifact.*does not match.*buyer/i,
    );
    expect(settles).toBe(0);
  });

  test("rejects non-boolean or aliased rail results before evidence publication", async () => {
    const nonBoolean = makeDeps({
      settle: async () => ({
        ok: "yes",
        txHash: "0xpaid",
        chainId: "chain",
        payer: "payer",
        payee: "payee",
      } as never),
    });
    await expect(
      runSessionCore("stor-listing", TERMS, nonBoolean),
    ).rejects.toThrow(/settlement rail returned a malformed result/);

    const retained = {
      ok: true,
      txHash: "0xowned",
      chainId: "chain",
      payer: "payer",
      payee: "0xalice",
    };
    const anchored: Record<string, unknown> = {};
    const aliased = makeDeps({
      settle: async () => retained,
      anchor: async (name, value) => {
        if (name.includes("evidence")) {
          retained.txHash = "0xmutated-after-return";
          anchored.evidence = value;
        }
        return `stor-${name}`;
      },
    });
    await expect(
      runSessionCore("stor-listing", TERMS, aliased),
    ).resolves.toMatchObject({ outcome: "completed" });
    expect(
      ((anchored.evidence as { paymentTxRefs: Array<{ txHash: string }> })
        .paymentTxRefs[0]!.txHash),
    ).toBe("0xowned");
  });

  test("requires an exact 64-byte buyer signature before any artifact is anchored", async () => {
    let anchors = 0;
    await expect(
      runSessionCore(
        "stor-listing",
        TERMS,
        makeDeps({
          signBytes: async () => new Uint8Array(63),
          anchor: async () => {
            anchors += 1;
            return "stor-unexpected";
          },
        }),
      ),
    ).rejects.toThrow(/exactly 64 bytes/);
    // The reduced Agreement is anchored first; the invalid component signature
    // is rejected before SettlementEvidence or bundle publication.
    expect(anchors).toBe(1);
  });

  test("pins the exact normative Listing tuple once for the whole session (LR-1)", async () => {
    const normative = normativeListing();
    let evidence: Record<string, unknown> | undefined;
    let selectedRail: string | undefined;
    let selectedPhase: string | undefined;
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
          selectedPhase = request.phase;
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
    expect(selectedPhase).toBe("pay-x402");
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
          payee: "0xalice",
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
      authenticateRecoveredArtifact: () => true,
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
        return { ok: true, txHash: "0x", chainId: "c", payer: "p", payee: "0xalice" };
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
      authenticateRecoveredArtifact: () => true,
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
        return { ok: true, txHash: "0xabc", chainId: "c", payer: "p", payee: "0xalice" };
      },
    });

    const first = await runSessionCore("stor-listing", TERMS, deps, "job-RESUME");
    expect(first.outcome).toBe("completed");
    expect(settleCalls).toBe(1);

    // Re-drive the same jobId (as after a crash) — everything is already anchored.
    const second = await runSessionCore("stor-listing", TERMS, deps, "job-RESUME");
    expect(second).toEqual(first); // identical refs
    expect(settleCalls).toBe(1); // settlement NOT executed again

    deps.expectedSettlementPayee = "0xattacker";
    await expect(
      runSessionCore("stor-listing", TERMS, deps, "job-RESUME"),
    ).rejects.toThrow(/signed settlement destination/);
    expect(settleCalls).toBe(1);
  });

  test("proves exact paid state before authenticating an expired Listing", async () => {
    const expiry = 1_780_000_000_100;
    const normative = {
      ...normativeListing(),
      validity: { notBefore: 1_770_000_000_000, notAfter: expiry },
    };
    const exactPin = {
      listingId: normative.listingId,
      version: normative.listingVersion,
      contentHash: contentHash(normative),
    };
    const store = new Map<string, Record<string, unknown>>();
    let now = 1_780_000_000_000;
    let failBundleOnce = true;
    let settleCalls = 0;
    let anchorCalls = 0;
    let observeRecoveryOrder = false;
    const recoveryOrder: string[] = [];
    const deps = makeDeps({
      readListing: async () => normative,
      verifyListing: () => {
        if (observeRecoveryOrder) recoveryOrder.push("listing");
        return true;
      },
      authenticateRecoveredAgreement: () => {
        if (observeRecoveryOrder) recoveryOrder.push("agreement");
        return true;
      },
      authenticateRecoveredSettlementEvidence: () => {
        if (observeRecoveryOrder) recoveryOrder.push("evidence");
        return true;
      },
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
    observeRecoveryOrder = true;
    await expect(
      runSessionCore("stor-expiring-listing", terms, deps, "job-EXPIRES"),
    ).resolves.toMatchObject({ outcome: "completed", jobId: "job-EXPIRES" });
    expect(settleCalls).toBe(1);
    expect(recoveryOrder).toEqual(["agreement", "evidence", "listing"]);

    const callsBeforeRejectedResume = anchorCalls;
    recoveryOrder.length = 0;
    await expect(
      runSessionCore("stor-expiring-listing", terms, deps, "job-NOT-ADMITTED"),
    ).rejects.toThrow(/outside.*validity window.*no prior Agreement/i);
    expect(settleCalls).toBe(1);
    expect(anchorCalls).toBe(callsBeforeRejectedResume);
    expect(recoveryOrder).toEqual([]);

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
      dacsSdkExpectedSettlementPayee: "0xalice",
      dacsSdkListingPin: exactPin,
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

  test("retains an immutable recovered-evidence snapshot across async authentication", async () => {
    const expiry = 1_780_000_000_100;
    const listing = {
      ...normativeListing(),
      validity: { notBefore: 1_770_000_000_000, notAfter: expiry },
    };
    const terms = {
      ...TERMS,
      price: { ...TERMS.price, rail: "x402:default" },
    };
    const store = new Map<string, Record<string, unknown>>();
    let now = expiry - 1;
    let failBundleOnce = true;
    let settleCalls = 0;
    let listingAuthentications = 0;
    const jobId = "job-EVIDENCE-SNAPSHOT";
    const evidenceRef = `stor-dacs4:evidence:${jobId}`;
    const deps = makeDeps({
      readListing: async () => listing,
      nowMs: () => now,
      verifyListing: () => {
        listingAuthentications += 1;
        return true;
      },
      authenticateRecoveredAgreement: () => true,
      authenticateRecoveredSettlementEvidence: async (raw) => {
        // Model an authenticator that verified the resolver-returned failure,
        // then yielded while the resolver owner mutated its retained alias.
        const authenticatedFailure = raw.outcome === "failure";
        await Promise.resolve();
        // Publication now freezes the value passed to the adapter. Replace the
        // resolver's retained entry to model an independently mutable backing
        // cache rather than attempting to mutate that protected publication.
        store.set(evidenceRef, {
          ...structuredClone(store.get(evidenceRef)!),
          outcome: "success",
          settlementFinality: {
            model: "provider-receipt",
            finalityObservedAt: now,
          },
        });
        return authenticatedFailure;
      },
      anchor: async (name, value) => {
        if (name === `dacs5:bundle:${jobId}` && failBundleOnce) {
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
          ok: false,
          // Empty tx + ok:false is a definitive no-payment result. A
          // transaction-bearing failure is intentionally left unresolved and
          // must never mint terminal failure evidence.
          txHash: "",
          chainId: "eip155:8453",
          payer: "0xbob",
          payee: "0xalice",
        };
      },
    });

    await expect(
      runSessionCore("stor-expiring-listing", terms, deps, jobId),
    ).rejects.toThrow(/simulated crash/);
    expect(settleCalls).toBe(1);
    expect(store.get(evidenceRef)?.outcome).toBe("failure");

    now = expiry + 1;
    await expect(
      runSessionCore("stor-expiring-listing", terms, deps, jobId),
    ).rejects.toThrow(/not successful/i);
    expect(settleCalls).toBe(1);
    // The expired Listing is never authenticated because retained payment
    // state remains the failure that was actually authenticated.
    expect(listingAuthentications).toBe(1);
  });

  test("pins recovery authenticators before a resolver can swap the dependency", async () => {
    const expiry = 1_780_000_000_100;
    const listing = {
      ...normativeListing(),
      validity: { notBefore: 1_770_000_000_000, notAfter: expiry },
    };
    const terms = {
      ...TERMS,
      price: { ...TERMS.price, rail: "x402:default" },
    };
    const store = new Map<string, Record<string, unknown>>();
    let now = expiry - 1;
    let failBundleOnce = true;
    let swapAuthenticator = false;
    let settleCalls = 0;
    const jobId = "job-AUTH-SWAP";
    const deps = makeDeps({
      readListing: async () => listing,
      nowMs: () => now,
      verifyListing: () => true,
      authenticateRecoveredAgreement: () => false,
      authenticateRecoveredSettlementEvidence: () => true,
      anchor: async (name, value) => {
        if (name === `dacs5:bundle:${jobId}` && failBundleOnce) {
          failBundleOnce = false;
          throw new Error("simulated crash before bundle publication");
        }
        const ref = `stor-${name}`;
        store.set(ref, value as Record<string, unknown>);
        return ref;
      },
      resolveAnchor: async (name) => {
        if (swapAuthenticator && name === `dacs3:agreement:${jobId}`) {
          deps.authenticateRecoveredAgreement = () => true;
        }
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
          txHash: "0xauth-swap",
          chainId: "eip155:8453",
          payer: "0xbob",
          payee: "0xalice",
        };
      },
    });

    await expect(
      runSessionCore("stor-expiring-listing", terms, deps, jobId),
    ).rejects.toThrow(/simulated crash/);
    expect(settleCalls).toBe(1);

    now = expiry + 1;
    swapAuthenticator = true;
    deps.authenticateRecoveredAgreement = () => false;
    await expect(
      runSessionCore("stor-expiring-listing", terms, deps, jobId),
    ).rejects.toThrow(/cryptographic Agreement authentication/i);
    expect(settleCalls).toBe(1);
    expect(deps.authenticateRecoveredAgreement?.({}, deps.buyerId)).toBe(true);
  });

  test("authenticates the immutable Listing snapshot read at session entry", async () => {
    const expiry = 1_780_000_000_100;
    const listing = {
      ...normativeListing(),
      validity: { notBefore: 1_770_000_000_000, notAfter: expiry },
    };
    const exactListingHash = contentHash(listing);
    const terms = {
      ...TERMS,
      price: { ...TERMS.price, rail: "x402:default" },
    };
    const store = new Map<string, Record<string, unknown>>();
    const authenticatedHashes: string[] = [];
    let now = expiry - 1;
    let failBundleOnce = true;
    let mutateListing = false;
    let settleCalls = 0;
    const jobId = "job-LISTING-SNAPSHOT";
    const deps = makeDeps({
      readListing: async () => listing,
      nowMs: () => now,
      verifyListing: (raw) => {
        authenticatedHashes.push(contentHash(raw));
        return true;
      },
      authenticateRecoveredAgreement: () => true,
      authenticateRecoveredSettlementEvidence: () => true,
      anchor: async (name, value) => {
        if (name === `dacs5:bundle:${jobId}` && failBundleOnce) {
          failBundleOnce = false;
          throw new Error("simulated crash before bundle publication");
        }
        const ref = `stor-${name}`;
        store.set(ref, value as Record<string, unknown>);
        return ref;
      },
      resolveAnchor: async (name) => {
        if (mutateListing && name === `dacs3:agreement:${jobId}`) {
          listing.offering.description =
            "resolver-owned alias mutated after the Listing read";
        }
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
          txHash: "0xlisting-snapshot",
          chainId: "eip155:8453",
          payer: "0xbob",
          payee: "0xalice",
        };
      },
    });

    await expect(
      runSessionCore("stor-expiring-listing", terms, deps, jobId),
    ).rejects.toThrow(/simulated crash/);
    expect(settleCalls).toBe(1);

    now = expiry + 1;
    mutateListing = true;
    await expect(
      runSessionCore("stor-expiring-listing", terms, deps, jobId),
    ).resolves.toMatchObject({ outcome: "completed", jobId });
    expect(settleCalls).toBe(1);
    expect(authenticatedHashes).toEqual([exactListingHash, exactListingHash]);
    expect(contentHash(listing)).not.toBe(exactListingHash);
  });

  test("signed Agreement pin rejects same-ref substitutions across normative and legacy formats", async () => {
    const normative = normativeListing();
    normative.listingId = "svc-1";
    normative.listingVersion = 1;
    normative.acceptedRails = [{ railId: "pay-x402" }];
    normative.pipeline[2] = {
      kind: "pay-x402",
      parameters: { rail: "pay-x402" },
    };
    const legacy = structuredClone(LISTING);

    for (const direction of [
      { name: "normative-to-legacy", first: normative, replacement: legacy },
      { name: "legacy-to-normative", first: legacy, replacement: normative },
    ]) {
      let current = structuredClone(direction.first) as Record<string, unknown>;
      const store = new Map<string, Record<string, unknown>>();
      let failBundleOnce = true;
      let settleCalls = 0;
      const jobId = `job-${direction.name}`;
      const deps = makeDeps({
        readListing: async () => current,
        verifyListing: () => true,
        authenticateRecoveredAgreement: () => true,
        anchor: async (name, value) => {
          if (name === `dacs5:bundle:${jobId}` && failBundleOnce) {
            failBundleOnce = false;
            throw new Error("simulated crash before bundle publication");
          }
          const ref = `stor-${name}`;
          store.set(ref, structuredClone(value) as Record<string, unknown>);
          return ref;
        },
        resolveAnchor: async (name) => {
          const ref = `stor-${name}`;
          const value = store.get(ref);
          return value
            ? { status: "present" as const, ref, value: structuredClone(value) }
            : { status: "absent" as const };
        },
        settle: async () => {
          settleCalls += 1;
          return {
            ok: true,
            txHash: `0x${direction.name}`,
            chainId: "eip155:8453",
            payer: "0xbob",
            payee: "0xalice",
          };
        },
      });

      await expect(
        runSessionCore("stor-reusable-listing", TERMS, deps, jobId),
      ).rejects.toThrow(/simulated crash/);
      expect(settleCalls).toBe(1);

      current = structuredClone(direction.replacement) as Record<
        string,
        unknown
      >;
      await expect(
        runSessionCore("stor-reusable-listing", TERMS, deps, jobId),
      ).rejects.toThrow(/signed Listing pin/i);
      expect(settleCalls).toBe(1);
    }
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

  test("a truthy non-boolean listing-verifier result is not a pass", async () => {
    let settleCalls = 0;
    await expect(
      runSessionCore(
        "stor-listing",
        TERMS,
        makeDeps({
          trustListing: undefined,
          verifyListing: (() => "yes") as never,
          settle: async () => {
            settleCalls += 1;
            throw new Error("must not settle");
          },
        }),
      ),
    ).rejects.toThrow(/failed signature verification/);
    expect(settleCalls).toBe(0);
  });

  test("rejects NFD job identifiers instead of normalizing them into an existing namespace", async () => {
    let listingReads = 0;
    const nfdJobId = "job-e\u0301";
    await expect(
      runSessionCore(
        "stor-listing",
        TERMS,
        makeDeps({
          readListing: async () => {
            listingReads += 1;
            return LISTING;
          },
        }),
        nfdJobId,
      ),
    ).rejects.toThrow(/canonical protocol string/);
    expect(listingReads).toBe(0);
  });

  test("rejects a fresh rail result for a different request-bound destination before evidence", async () => {
    let evidenceAnchors = 0;
    await expect(
      runSessionCore(
        "stor-listing",
        TERMS,
        makeDeps({
          settle: async () => ({
            ok: true,
            txHash: "0xpaid-wrong",
            chainId: "eip155:1",
            payer: "0xbuyer",
            payee: "0xattacker",
          }),
          anchor: async (name) => {
            if (name.includes("evidence")) evidenceAnchors += 1;
            return `stor-${name}`;
          },
        }),
      ),
    ).rejects.toThrow(/request-bound destination/);
    expect(evidenceAnchors).toBe(0);
  });

  test("keeps a transaction-bearing ok:false result unresolved and mints no failure evidence", async () => {
    let evidenceAnchors = 0;
    await expect(
      runSessionCore(
        "stor-listing",
        TERMS,
        makeDeps({
          settle: async () => ({
            ok: false,
            txHash: "0xpossibly-landed",
            chainId: "eip155:1",
            payer: "0xbuyer",
            payee: "0xalice",
          }),
          anchor: async (name) => {
            if (name.includes("evidence")) evidenceAnchors += 1;
            return `stor-${name}`;
          },
        }),
      ),
    ).rejects.toThrow(/remains indeterminate/);
    expect(evidenceAnchors).toBe(0);
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
      dacsSdkExpectedSettlementPayee: "0xalice",
      price: TERMS.price,
      delivery: { phase: TERMS.deliveryPhase, format: TERMS.deliveryFormat },
      expiresAt: "2026-01-01T00:00:00Z",
      signature: "sig",
    };
    const deps = makeDeps({
      authenticateRecoveredArtifact: () => true,
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
