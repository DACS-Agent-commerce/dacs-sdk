import { describe, expect, test } from "vitest";

import {
  runSessionCore,
  type SessionDeps,
  type SessionTerms,
} from "../../src/agent/runSessionCore.js";
import type { Listing } from "../../src/artifacts/types.js";
import {
  canonicalize,
  contentHash,
  sha256Hex,
} from "../../src/canonical/index.js";

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

function normativeDpaListing(): Listing {
  return {
    dacsVersion: "1",
    listingVersion: 7,
    listingId: "market-data-vendor",
    seller: {
      identity: {
        bundleVersion: "1",
        presentedBy: "did:demos:agent:alice",
        presentedAt: 1_770_000_000_000,
        claims: [{ ref: "did:demos:agent:alice" }],
        presentation: {
          kind: "per-claim",
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
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" },
      },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-agreement" },
      { kind: "pay-x402", parameters: { rail: "x402:default" } },
      { kind: "deliver-attested-payload" },
    ],
    pricing: {
      kind: "fixed",
      price: { amount: "1", currency: "USDC" },
    },
    acceptedRails: [{ railId: "x402:default" }],
    terms: { deadlineSecAfterCommit: 3_600 },
    validity: { notBefore: 1_770_000_000_000 },
    signature: {
      algorithm: "ed25519",
      signer: "did:demos:agent:alice",
      value: "AQ",
    },
  };
}

function verifiedAdmissionFor(listing: Listing) {
  const deliverable = listing.offering.deliverable;
  if (
    deliverable.kind !== "attested-payload" ||
    !deliverable.verificationMethod
  ) {
    throw new Error("fixture drift");
  }
  return {
    disposition: "verified" as const,
    step: 9 as const,
    reason: "verified",
    listing,
    listingContentHash: contentHash(
      listing as unknown as Record<string, unknown>,
    ),
    payloadVerificationCapability: {
      operation: "verify" as const,
      disposition: "supported" as const,
      reason: "supported",
      verificationMethodKind: deliverable.verificationMethod.kind,
      verificationMethodHash: sha256Hex(
        canonicalize(deliverable.verificationMethod),
      ),
      deliverableSpecHash: sha256Hex(canonicalize(deliverable)),
    },
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

  test("snapshots caller-owned fixed terms before any awaited dependency", async () => {
    const terms = structuredClone(TERMS);
    let settled: Parameters<SessionDeps["settle"]>[0] | undefined;
    const result = await runSessionCore(
      "stor-listing",
      terms,
      makeDeps({
        readListing: async () => {
          terms.price.rail = "pay-evil";
          terms.price.amount = "999999999";
          terms.deliveryPhase = "deliver-evil";
          return LISTING;
        },
        settle: async (request) => {
          settled = request;
          return {
            ok: true,
            txHash: "0xabc",
            chainId: "eip155:11155111",
            payer: "0xbob",
            payee: "0xalice",
          };
        },
      }),
    );

    expect(result.outcome).toBe("completed");
    expect(settled).toMatchObject({
      rail: "pay-x402",
      amount: "1000000",
      asset: "USDC",
    });
  });

  test("rejects a signer that rewrites admitted agreement terms before anchor or payment", async () => {
    let anchorCalls = 0;
    let settleCalls = 0;

    await expect(
      runSessionCore(
        "stor-listing",
        TERMS,
        makeDeps({
          sign: async (artifact) => {
            const agreement = artifact as {
              price: { rail: string; amount: string };
            };
            agreement.price.rail = "pay-evil";
            agreement.price.amount = "999999999";
            return { ...agreement, signature: "sig" };
          },
          anchor: async (name) => {
            anchorCalls += 1;
            return `stor-${name}`;
          },
          settle: async () => {
            settleCalls += 1;
            throw new Error("must not settle");
          },
        }),
      ),
    ).rejects.toThrow(/new artifact.*does not match.*price mismatch/);

    expect(anchorCalls).toBe(0);
    expect(settleCalls).toBe(0);
    expect(TERMS.price).toMatchObject({ rail: "pay-x402", amount: "1000000" });
  });

  test("an anchor adapter cannot rewrite the retained signed agreement", async () => {
    let settleCalls = 0;

    await expect(
      runSessionCore(
        "stor-listing",
        TERMS,
        makeDeps({
          anchor: async (name, value) => {
            if (name.startsWith("dacs3:agreement:")) {
              const agreement = value as {
                price: { rail: string; amount: string };
              };
              agreement.price.rail = "pay-evil";
              agreement.price.amount = "999999999";
            }
            return `stor-${name}`;
          },
          settle: async () => {
            settleCalls += 1;
            throw new Error("must not settle");
          },
        }),
      ),
    ).rejects.toThrow();

    expect(settleCalls).toBe(0);
    expect(TERMS.price).toMatchObject({ rail: "pay-x402", amount: "1000000" });
  });

  test("a live or proxied anchor lookup fails closed before write or payment", async () => {
    let anchorCalls = 0;
    let settleCalls = 0;

    await expect(
      runSessionCore(
        "stor-listing",
        TERMS,
        makeDeps({
          resolveAnchor: async () =>
            new Proxy({ status: "absent" as const }, {}),
          anchor: async (name) => {
            anchorCalls += 1;
            return `stor-${name}`;
          },
          settle: async () => {
            settleCalls += 1;
            throw new Error("must not settle");
          },
        }),
      ),
    ).rejects.toThrow(/live, malformed, or non-canonical/);

    expect(anchorCalls).toBe(0);
    expect(settleCalls).toBe(0);
  });

  test("pins the exact normative Listing tuple once for the whole session (LR-1)", async () => {
    const normative = normativeDpaListing();
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
        validateListing: () => verifiedAdmissionFor(normative),
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
      contentHash: contentHash(normative as unknown as Record<string, unknown>),
    });
    expect(selectedRail).toBe("x402:default");
    expect(evidence?.phase).toBe("pay-x402");

    await expect(
      runSessionCore(
        "stor-normative-v7",
        {
          ...TERMS,
          price: { ...TERMS.price, rail: "x402:default" },
        },
        makeDeps({
          readListing: async () => normative,
          validateListing: () => ({
            disposition: "verified",
            step: 9,
            reason: "verified-different-content",
            listingContentHash: "0".repeat(64),
          }),
        }),
      ),
    ).rejects.toThrow(/not bound to the exact LR-1 content hash/);

    for (const disposition of [
      "rejected",
      "revoked",
      "indeterminate",
    ] as const) {
      let settled = false;
      await expect(
        runSessionCore(
          "stor-normative-v7",
          {
            ...TERMS,
            price: { ...TERMS.price, rail: "x402:default" },
          },
          makeDeps({
            readListing: async () => normative,
            validateListing: () => ({
              disposition,
              step: disposition === "revoked" ? 5 : 8,
              reason: `test-${disposition}`,
            }),
            settle: async () => {
              settled = true;
              throw new Error("must not settle");
            },
          }),
        ),
      ).rejects.toThrow(new RegExp(`${disposition}.*LR-3`));
      expect(settled).toBe(false);
    }
  });

  test("refuses to pay presentedBy when a different carried claim signed", async () => {
    const normative = normativeDpaListing();
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
          validateListing: () => verifiedAdmissionFor(normative),
          settle: async () => {
            settles += 1;
            throw new Error("must not settle");
          },
        }),
      ),
    ).rejects.toThrow(/not payee-bound|signer must equal/i);
    expect(settles).toBe(0);
  });

  test("a readable missing-method envelope reaches ordered DPA-1 step 7 and never pays", async () => {
    const envelope = normativeDpaListing();
    delete (envelope.offering.deliverable as { verificationMethod?: unknown })
      .verificationMethod;
    let validationCalls = 0;
    let settled = false;

    await expect(
      runSessionCore(
        "stor-missing-method",
        {
          ...TERMS,
          price: { ...TERMS.price, rail: "x402:default" },
        },
        makeDeps({
          readListing: async () => envelope,
          validateListing: () => {
            validationCalls += 1;
            return {
              disposition: "rejected",
              step: 7,
              reason: "pipeline-invalid",
            };
          },
          settle: async () => {
            settled = true;
            throw new Error("must not settle");
          },
        }),
      ),
    ).rejects.toThrow(/rejected at DACS-1 reader step 7.*LR-3/);
    expect(validationCalls).toBe(1);
    expect(settled).toBe(false);
  });

  test.each(["absent", "mismatched", "wrong-operation"] as const)(
    "a stale verified result with %s DPA capability never reaches payment",
    async (capabilityCase) => {
      const listing = normativeDpaListing();
      const admission = verifiedAdmissionFor(listing);
      if (capabilityCase === "absent") {
        delete (
          admission as {
            payloadVerificationCapability?: unknown;
          }
        ).payloadVerificationCapability;
      } else if (capabilityCase === "mismatched") {
        admission.payloadVerificationCapability.verificationMethodHash =
          "0".repeat(64);
      } else {
        (
          admission.payloadVerificationCapability as {
            operation: "produce" | "verify";
          }
        ).operation = "produce";
      }
      let settled = false;

      await expect(
        runSessionCore(
          "stor-stale-capability",
          {
            ...TERMS,
            price: { ...TERMS.price, rail: "x402:default" },
          },
          makeDeps({
            readListing: async () => listing,
            validateListing: () => admission,
            settle: async () => {
              settled = true;
              throw new Error("must not settle");
            },
          }),
        ),
      ).rejects.toThrow(/capability-incomplete.*DPA-1/);
      expect(settled).toBe(false);
    },
  );

  test("a live or proxied Listing admission result never reaches payment", async () => {
    const listing = normativeDpaListing();
    const admission = verifiedAdmissionFor(listing);
    let settled = false;

    await expect(
      runSessionCore(
        "stor-live-admission",
        {
          ...TERMS,
          price: { ...TERMS.price, rail: "x402:default" },
        },
        makeDeps({
          readListing: async () => listing,
          validateListing: () => new Proxy(admission, {}),
          settle: async () => {
            settled = true;
            throw new Error("must not settle");
          },
        }),
      ),
    ).rejects.toThrow(/validation was indeterminate \(validator threw\)/);
    expect(settled).toBe(false);
  });

  test("a validator cannot rewrite the signed Listing baseline before payment", async () => {
    const listing = normativeDpaListing();
    let settled = false;

    await expect(
      runSessionCore(
        "stor-validator-rewrite",
        {
          ...TERMS,
          price: { ...TERMS.price, rail: "x402:default" },
        },
        makeDeps({
          readListing: async () => listing,
          validateListing: (candidate) => {
            const rewritten = candidate as unknown as Listing;
            const deliverable = rewritten.offering.deliverable;
            if (deliverable.kind !== "attested-payload") {
              throw new Error("fixture drift");
            }
            deliverable.payloadFormat = "text/plain";
            return verifiedAdmissionFor(rewritten);
          },
          settle: async () => {
            settled = true;
            throw new Error("must not settle");
          },
        }),
      ),
    ).rejects.toThrow(/not bound to the exact LR-1 content hash|stale, substituted/);
    expect(settled).toBe(false);
    expect(listing.offering.deliverable).toMatchObject({
      payloadFormat: "application/json",
    });
  });

  test("an unknown delivery envelope cannot be admitted by a stale verified result", async () => {
    const listing = normativeDpaListing();
    listing.pipeline[3] = { kind: "deliver-future" as never };
    let settled = false;

    await expect(
      runSessionCore(
        "stor-unknown-delivery",
        {
          ...TERMS,
          price: { ...TERMS.price, rail: "x402:default" },
          deliveryPhase: "deliver-future",
        },
        makeDeps({
          readListing: async () => listing,
          validateListing: () => ({
            disposition: "verified",
            step: 9,
            reason: "stale-validator-pass",
            listing,
            listingContentHash: contentHash(
              listing as unknown as Record<string, unknown>,
            ),
          }),
          settle: async () => {
            settled = true;
            throw new Error("must not settle");
          },
        }),
      ),
    ).rejects.toThrow(/stale, substituted, or capability-incomplete/);
    expect(settled).toBe(false);
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
