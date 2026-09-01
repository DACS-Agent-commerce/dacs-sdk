import { describe, expect, test } from "vitest";

import {
  runSessionCore,
  type SessionDeps,
  type SessionTerms,
} from "../../src/agent/runSessionCore.js";
import type {
  CompositeVerificationRecord,
  IdentityBundle,
  Listing,
  ListingPin,
  SettlementFinalityParameters,
  VerificationDecision,
} from "../../src/artifacts/types.js";
import {
  canonicalize,
  contentHash,
  encodeAddressSegment,
  sha256Hex,
} from "../../src/canonical/index.js";
import { UnsupportedCapabilityError } from "../../src/errors.js";
import { identityBundleHash } from "../../src/identity/index.js";
import { signedBytes } from "../../src/crypto/index.js";
import type {
  FinalizedVetAnchor,
  VetProduction,
} from "../../src/agent/vetCore.js";

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

const BUYER_ID = "did:demos:agent:bob";
const BUYER_IDENTITY: IdentityBundle = {
  bundleVersion: "1",
  presentedBy: BUYER_ID,
  presentedAt: 1_780_000_000_000,
  claims: [{ ref: BUYER_ID }],
  presentation: {
    kind: "per-claim",
    signatures: [{ ref: BUYER_ID, signature: "test-presentation" }],
  },
};
const BUYER_IDENTITY_HASH = identityBundleHash(BUYER_IDENTITY);

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
  ...(["processed", "confirmed", "finalized"] as const).map(
    (finalityCommitmentLevel) => ({
      name: `commitment-level ${finalityCommitmentLevel}`,
      finality: { model: "commitment-level" as const, finalityCommitmentLevel },
    }),
  ),
  { name: "provider-receipt", finality: { model: "provider-receipt" } },
  { name: "htlc-reveal", finality: { model: "htlc-reveal" } },
  { name: "liquidity-tank", finality: { model: "liquidity-tank" } },
  { name: "bft-final", finality: { model: "bft-final" } },
] satisfies ReadonlyArray<{
  name: string;
  finality: SettlementFinalityParameters;
}>;

function currentVet(
  evaluatedParty: string,
  jobId: string,
  overallDecision: VerificationDecision,
): CompositeVerificationRecord {
  return {
    recordVersion: "1",
    jobId,
    evaluatedParty,
    bundleHash: "a".repeat(64),
    requirementHash: "b".repeat(64),
    freshness: [],
    supplementary: [],
    dealSpecific: [],
    overallDecision,
    generatedAt: 1780000000000,
    signature: {
      algorithm: "ed25519",
      signer: "did:demos:verifier:carol",
      value: "AA",
    },
  };
}

function currentVetProduction(
  evaluatedParty: string,
  jobId: string,
  overallDecision: VerificationDecision,
  store?: Map<string, Record<string, unknown>>,
): VetProduction {
  const record = currentVet(evaluatedParty, jobId, overallDecision);
  const logicalAddress =
    `dacs2:composite:${encodeAddressSegment(jobId)}:` +
    encodeAddressSegment(evaluatedParty);
  const nativeAddress = `stor-${logicalAddress}`;
  const hash = contentHash(record as unknown as Record<string, unknown>);
  store?.set(nativeAddress, structuredClone(record) as unknown as Record<string, unknown>);
  return {
    record,
    recordRef: {
      anchor: { kind: "storage-program", locator: nativeAddress },
      contentHash: hash,
    },
    anchorReceipt: {
      receiptVersion: "1",
      substrate: "test",
      finalityProfile: "instant",
      logicalAddress,
      nativeAddress,
      contentHash: hash,
      transactionRef: { kind: "test", value: `tx:${jobId}` },
      writer: "test-writer",
      state: "finalized",
      observationDisposition: "established",
      observedAt: 1780000000000,
      blockRef: { id: `block:${jobId}` },
      evidence: { kind: "test-proof", value: "authenticated" },
    },
  };
}

const authenticateClaimedVetFinality: NonNullable<
  SessionDeps["authenticateVetFinality"]
> = async ({ claimed }) => claimed ? structuredClone(claimed) : null;

function makeDeps(overrides: Partial<SessionDeps> = {}): SessionDeps {
  return {
    buyerId: BUYER_ID,
    buyerIdentityBundle: BUYER_IDENTITY,
    authenticateBuyerIdentityBundle: () => true,
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
    validateListing: (raw) => verifiedAdmissionFor(raw as unknown as Listing),
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

const normativeListing = normativeDpaListing;

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

function listingPinFor(listing: Listing): ListingPin {
  return {
    listingId: listing.listingId,
    version: listing.listingVersion,
    contentHash: contentHash(listing as unknown as Record<string, unknown>),
  };
}

describe("runSession orchestration (T4)", () => {
  test("happy path anchors agreement+evidence+bundle and completes", async () => {
    const res = await runSessionCore("stor-listing", TERMS, makeDeps());
    expect(res.profile).toBe("legacy-mvp-settlement-only");
    expect(res.commerceComplete).toBe(false);
    expect(res.outcome).toBe("completed");
    expect(res.jobId).toBe("job-1");
    expect(res.agreementRef).toBe("stor-dacs3:agreement:job-1");
    expect(res.settlementRef).toBe("stor-dacs4:evidence:job-1");
    expect(res.bundleRef).toBe("stor-dacs5:bundle:job-1");
  });

  test("binds the exact authenticated buyer IdentityBundle hash before payment", async () => {
    const anchored = new Map<string, Record<string, unknown>>();
    let authenticatedInput:
      | Parameters<SessionDeps["authenticateBuyerIdentityBundle"]>[0]
      | undefined;
    let settleCalls = 0;
    await runSessionCore(
      "stor-listing",
      TERMS,
      makeDeps({
        authenticateBuyerIdentityBundle: (input) => {
          authenticatedInput = input;
          return true;
        },
        anchor: async (name, value) => {
          anchored.set(name, structuredClone(value) as Record<string, unknown>);
          return `stor-${name}`;
        },
        settle: async () => {
          settleCalls += 1;
          return {
            ok: true,
            txHash: "0xidentity",
            chainId: "eip155:11155111",
            payer: "0xbob",
            payee: "0xalice",
          };
        },
      }),
    );

    expect(settleCalls).toBe(1);
    expect(authenticatedInput).toMatchObject({
      buyerId: BUYER_ID,
      jobId: "job-1",
      bundleHash: BUYER_IDENTITY_HASH,
      bundle: BUYER_IDENTITY,
    });
    expect(Buffer.from(authenticatedInput!.signedBytes)).toEqual(
      Buffer.from(
        signedBytes("dacs-bundle-presentation:v1:", BUYER_IDENTITY_HASH),
      ),
    );
    const agreement = anchored.get("dacs3:agreement:job-1")!;
    expect(agreement.dacsSdkBuyerIdentityBundleHash).toBe(BUYER_IDENTITY_HASH);
    const bundle = anchored.get("dacs5:bundle:job-1")! as {
      parties: Array<{ role: string; bundleHash: string; primaryClaim: string }>;
    };
    expect(bundle.parties.find((party) => party.role === "buyer")).toEqual({
      role: "buyer",
      bundleHash: BUYER_IDENTITY_HASH,
      primaryClaim: BUYER_ID,
    });
    expect(BUYER_IDENTITY_HASH).not.toBe(sha256Hex(BUYER_ID));
  });

  test("fails closed on an unauthenticated buyer IdentityBundle before any effect", async () => {
    let anchorCalls = 0;
    let settleCalls = 0;
    await expect(
      runSessionCore(
        "stor-listing",
        TERMS,
        makeDeps({
          authenticateBuyerIdentityBundle: () => false,
          anchor: async () => {
            anchorCalls += 1;
            return "stor-unexpected";
          },
          settle: async () => {
            settleCalls += 1;
            throw new Error("must not settle");
          },
        }),
      ),
    ).rejects.toThrow(/IdentityBundle presentation could not be authenticated/);
    expect(anchorCalls).toBe(0);
    expect(settleCalls).toBe(0);
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

  test("a live or proxied anchor lookup fails closed before write or payment", async () => {
    let anchorCalls = 0;
    let settleCalls = 0;
    await expect(
      runSessionCore(
        "stor-listing",
        TERMS,
        makeDeps({
          resolveAnchor: async () => new Proxy({ status: "absent" as const }, {}),
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
    ).rejects.toThrow(/unstable or non-wire result/);
    expect(anchorCalls).toBe(0);
    expect(settleCalls).toBe(0);
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
    const normative = normativeDpaListing();
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
        validateListing: () => verifiedAdmissionFor(normative),
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
      contentHash: contentHash(
        normative as unknown as Record<string, unknown>,
      ),
    });
    expect(selectedRail).toBe("x402:default");
    expect(selectedPhase).toBe("pay-x402");
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
      let vetted = false;
      let anchored = false;
      const attempt = runSessionCore(
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
            vet: async () => {
              vetted = true;
              throw new Error("must not vet");
            },
            anchor: async () => {
              anchored = true;
              throw new Error("must not anchor");
            },
          }),
        );
      await expect(attempt).rejects.toThrow(new RegExp(`${disposition}.*LR-3`));
      await expect(attempt).rejects.toMatchObject({
        category: disposition === "indeterminate" ? "substrate" : "counterparty",
      });
      expect(settled).toBe(false);
      expect(vetted).toBe(false);
      expect(anchored).toBe(false);
    }
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

  test("rejects a substituted Listing against the caller-held pin before Vet or payment", async () => {
    const selected = normativeDpaListing();
    const expectedListingPin = listingPinFor(selected);
    const substituted = structuredClone(selected);
    substituted.offering.title = "Substituted after buyer selection";
    let vetCalls = 0;
    let anchorCalls = 0;
    let settleCalls = 0;

    await expect(
      runSessionCore(
        "stor-normative-v7",
        {
          ...TERMS,
          price: { ...TERMS.price, rail: "x402:default" },
        },
        makeDeps({
          expectedListingPin,
          readListing: async () => substituted,
          validateListing: () => verifiedAdmissionFor(substituted),
          vet: async () => {
            vetCalls += 1;
            throw new Error("must not Vet a substituted Listing");
          },
          anchor: async (name) => {
            anchorCalls += 1;
            return `stor-${name}`;
          },
          settle: async () => {
            settleCalls += 1;
            throw new Error("must not pay a substituted Listing");
          },
        }),
      ),
    ).rejects.toThrow(/caller-held expected Listing pin/);

    expect(vetCalls).toBe(0);
    expect(anchorCalls).toBe(0);
    expect(settleCalls).toBe(0);
  });

  test("snapshots the caller-held Listing pin before the first listing-read await", async () => {
    const normative = normativeDpaListing();
    const expectedListingPin = listingPinFor(normative);
    const selectedPin = structuredClone(expectedListingPin);

    const result = await runSessionCore(
      "stor-normative-v7",
      {
        ...TERMS,
        price: { ...TERMS.price, rail: "x402:default" },
      },
      makeDeps({
        expectedListingPin,
        readListing: async () => {
          expectedListingPin.contentHash = "0".repeat(64);
          expectedListingPin.listingId = "mutated-selection";
          return normative;
        },
        validateListing: () => verifiedAdmissionFor(normative),
      }),
    );

    expect(result.listingPin).toEqual(selectedPin);
    expect(expectedListingPin).not.toEqual(selectedPin);
  });

  test("admits PIPE-5 repetitions of the same payment phase kind", async () => {
    const normative = normativeDpaListing();
    normative.pipeline.splice(3, 0, {
      kind: "pay-x402",
      parameters: { rail: "x402:default" },
    });
    let settles = 0;
    let evidence: Record<string, unknown> | undefined;

    const result = await runSessionCore(
      "stor-repeated-payment-phase",
      {
        ...TERMS,
        price: { ...TERMS.price, rail: "x402:default" },
      },
      makeDeps({
        readListing: async () => normative,
        validateListing: () => verifiedAdmissionFor(normative),
        settle: async () => {
          settles += 1;
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

    expect(result.outcome).toBe("completed");
    expect(settles).toBe(1);
    expect(evidence?.phase).toBe("pay-x402");
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

  test("failed settlement rail results cannot assert success-only finality", async () => {
    await expect(
      runSessionCore(
        "stor-listing",
        TERMS,
        makeDeps({
          settle: async () => ({
            ok: false,
            txHash: "",
            chainId: "test:1",
            payer: "0xbob",
            payee: "0xalice",
            finality: { model: "bft-final" },
          }),
        }),
      ),
    ).rejects.toThrow(/finality/);
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
      finality: { model: "commitment-level", finalityCommitmentLevel: "kinda" },
    },
    {
      name: "block echo on commitment model",
      finality: { model: "commitment-level", finalityBlocks: 2 },
    },
    {
      name: "commitment echo on block model",
      finality: { model: "block-depth", finalityCommitmentLevel: "confirmed" },
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
    {
      name: "extra finality field",
      finality: { model: "bft-final", extra: true },
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

  test("rejects a non-wire listing before snapshot normalisation can reach payment", async () => {
    let settleCalls = 0;
    const inheritedListing = Object.assign(
      Object.create({ inherited: true }) as Record<string, unknown>,
      LISTING,
    );
    await expect(
      runSessionCore(
        "stor-listing",
        TERMS,
        makeDeps({
          readListing: async () => inheritedListing,
          settle: async () => {
            settleCalls += 1;
            throw new Error("must not settle");
          },
        }),
      ),
    ).rejects.toThrow(/listing/);
    expect(settleCalls).toBe(0);
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
      vet: async ({ evaluatedParty, jobId }) =>
        currentVetProduction(evaluatedParty, jobId, "pass", store),
      verifyVetRecord: async (record) => ({
        status: "valid",
        record: record as CompositeVerificationRecord,
        freshness: [],
        dealSpecific: [],
        freshnessRecipes: [],
        dealSpecificRecipes: [],
      }),
      authenticateVetFinality: authenticateClaimedVetFinality,
    });

    const res = await runSessionCore(
      "stor-listing",
      TERMS,
      deps,
      "01J8ME0SXKQ4T9V2RC5HJ6WX7F",
    );
    expect(res.outcome).toBe("completed");
    expect(res.vetRef).toBe(
      "stor-dacs2:composite:01J8ME0SXKQ4T9V2RC5HJ6WX7F:did%3Ademos%3Aagent%3Aalice",
    );
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

  test("rejects a non-wire Vet production before snapshot normalisation", async () => {
    const store = new Map<string, Record<string, unknown>>();
    let settleCalls = 0;
    const deps = makeDeps({
      resolveAnchor: async (name) => {
        const ref = `stor-${name}`;
        const value = store.get(ref);
        return value
          ? { status: "present" as const, ref, value }
          : { status: "absent" as const };
      },
      vet: async ({ evaluatedParty, jobId }) =>
        Object.assign(
          Object.create({ inherited: true }),
          currentVetProduction(evaluatedParty, jobId, "pass", store),
        ) as VetProduction,
      verifyVetRecord: async (record) => ({
        status: "valid",
        record: record as CompositeVerificationRecord,
        freshness: [],
        dealSpecific: [],
        freshnessRecipes: [],
        dealSpecificRecipes: [],
      }),
      authenticateVetFinality: authenticateClaimedVetFinality,
      settle: async () => {
        settleCalls += 1;
        throw new Error("must not settle");
      },
    });

    await expect(
      runSessionCore("stor-listing", TERMS, deps, "01J8ME0SXKQ4T9V2RC5HJ6WX7G"),
    ).rejects.toThrow(/Vet production is not an exact JSON wire record/);
    expect(settleCalls).toBe(0);
  });

  test("vet fail: aborts before settlement (never pays a failed seller)", async () => {
    const store = new Map<string, Record<string, unknown>>();
    let settleCalls = 0;
    const deps = makeDeps({
      anchor: async (name) => `stor-${name}`,
      resolveAnchor: async (name) => {
        const ref = `stor-${name}`;
        const value = store.get(ref);
        return value
          ? { status: "present" as const, ref, value }
          : { status: "absent" as const };
      },
      settle: async (request) => {
        settleCalls += 1;
        return {
          ok: true,
          txHash: "0x",
          chainId: "c",
          payer: "p",
          payee: request.expectedPayee,
        };
      },
      vet: async ({ evaluatedParty, jobId }) =>
        currentVetProduction(evaluatedParty, jobId, "fail", store),
      verifyVetRecord: async (record) => ({
        status: "valid",
        record: record as CompositeVerificationRecord,
        freshness: [],
        dealSpecific: [],
        freshnessRecipes: [],
        dealSpecificRecipes: [],
      }),
      authenticateVetFinality: authenticateClaimedVetFinality,
    });

    await expect(runSessionCore("stor-listing", TERMS, deps, "01J8ME0SXKQ4T9V2RC5HJ6WX7H")).rejects.toThrow(
      /did not pass verification/,
    );
    expect(settleCalls).toBe(0);
  });

  test("resume accepts a strict CVR signed by the verifier rather than the buyer", async () => {
    const store = new Map<string, Record<string, unknown>>();
    let vetCalls = 0;
    let settleCalls = 0;
    const authenticatedFinality = new Map<string, FinalizedVetAnchor>();
    let finalityCalls = 0;
    const deps = makeDeps({
      authenticateRecoveredArtifact: () => true,
      anchor: async (name, value) => {
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
      vet: async ({ evaluatedParty, jobId }) => {
        vetCalls += 1;
        const production = currentVetProduction(
          evaluatedParty,
          jobId,
          "pass",
          store,
        );
        authenticatedFinality.set(production.anchorReceipt.logicalAddress, {
          ref: structuredClone(production.recordRef),
          receipt: structuredClone(production.anchorReceipt),
        });
        return production;
      },
      verifyVetRecord: async (record) => ({
        status: "valid",
        record: record as CompositeVerificationRecord,
        freshness: [],
        dealSpecific: [],
        freshnessRecipes: [],
        dealSpecificRecipes: [],
      }),
      authenticateVetFinality: async ({ logicalAddress, claimed }) => {
        finalityCalls += 1;
        const established = authenticatedFinality.get(logicalAddress);
        expect(established).toBeDefined();
        if (claimed) expect(claimed).toEqual(established);
        return established ? structuredClone(established) : null;
      },
      settle: async (request) => {
        settleCalls += 1;
        return {
          ok: true,
          txHash: "0x",
          chainId: "c",
          payer: "p",
          payee: request.expectedPayee,
        };
      },
    });

    await runSessionCore("stor-listing", TERMS, deps, "01J8ME0SXKQ4T9V2RC5HJ6WX7J");
    await runSessionCore("stor-listing", TERMS, deps, "01J8ME0SXKQ4T9V2RC5HJ6WX7J");

    expect(vetCalls).toBe(1);
    expect(finalityCalls).toBe(2);
    expect(settleCalls).toBe(1);
  });

  test("legacy shape-only vet input is refused before settlement/finalisation", async () => {
    let settleCalls = 0;
    await expect(
      runSessionCore(
        "stor-listing",
        TERMS,
        makeDeps({
          vet: async ({ evaluatedParty }) =>
            ({
              subject: evaluatedParty,
              recipeId: "legacy-self-signed",
              recipeVersion: "0.1",
              results: [
                {
                  claimRef: evaluatedParty,
                  method: "self-signed",
                  status: "pass",
                },
              ],
              decision: "pass",
              verifiedAt: "2026-01-01T00:00:00Z",
            }) as unknown as VetProduction,
          verifyVetRecord: async (record) => ({
            status: "valid",
            record: record as CompositeVerificationRecord,
            freshness: [],
            dealSpecific: [],
            freshnessRecipes: [],
            dealSpecificRecipes: [],
          }),
          authenticateVetFinality: authenticateClaimedVetFinality,
          settle: async () => {
            settleCalls += 1;
            return { ok: true, txHash: "0x", chainId: "c", payer: "p", payee: "q" };
          },
        }),
        "job-LEGACY-VET",
      ),
    ).rejects.toThrow(/exact finalized record\/ref\/receipt binding/);
    expect(settleCalls).toBe(0);
  });

  test("authorizes only the exact durable Vet readback, never a mutable producer return", async () => {
    const store = new Map<string, Record<string, unknown>>();
    let settleCalls = 0;
    const deps = makeDeps({
      resolveAnchor: async (name) => {
        const ref = `stor-${name}`;
        const value = store.get(ref);
        return value
          ? { status: "present" as const, ref, value }
          : { status: "absent" as const };
      },
      vet: async ({ evaluatedParty, jobId }) => {
        const production = currentVetProduction(
          evaluatedParty,
          jobId,
          "pass",
          store,
        );
        const durable = structuredClone(production.record);
        durable.overallDecision = "fail";
        store.set(production.recordRef.anchor.locator, durable as unknown as Record<string, unknown>);
        return production;
      },
      verifyVetRecord: async (record) => ({
        status: "valid",
        record: record as CompositeVerificationRecord,
        freshness: [],
        dealSpecific: [],
        freshnessRecipes: [],
        dealSpecificRecipes: [],
      }),
      authenticateVetFinality: authenticateClaimedVetFinality,
      settle: async () => {
        settleCalls += 1;
        return { ok: true, txHash: "0x", chainId: "c", payer: "p", payee: "q" };
      },
    });
    await expect(
      runSessionCore("stor-listing", TERMS, deps, "01J8ME0SXKQ4T9V2RC5HJ6WX7K"),
    ).rejects.toThrow(/durable Vet readback differs/);
    expect(settleCalls).toBe(0);
  });

  test("a strict-verifier callback cannot mutate a signed fail into payment authorization", async () => {
    const store = new Map<string, Record<string, unknown>>();
    let settleCalls = 0;
    const deps = makeDeps({
      resolveAnchor: async (name) => {
        const ref = `stor-${name}`;
        const value = store.get(ref);
        return value
          ? { status: "present" as const, ref, value }
          : { status: "absent" as const };
      },
      vet: ({ evaluatedParty, jobId }) =>
        Promise.resolve(
          currentVetProduction(evaluatedParty, jobId, "fail", store),
        ),
      verifyVetRecord: async (record) => {
        try {
          (record as CompositeVerificationRecord).overallDecision = "pass";
        } catch {
          // The callback receives a private frozen snapshot.
        }
        return {
          status: "valid" as const,
          record: structuredClone(record) as CompositeVerificationRecord,
          freshness: [],
          dealSpecific: [],
          freshnessRecipes: [],
          dealSpecificRecipes: [],
        };
      },
      authenticateVetFinality: authenticateClaimedVetFinality,
      settle: async () => {
        settleCalls += 1;
        return { ok: true, txHash: "0x", chainId: "c", payer: "p", payee: "q" };
      },
    });
    await expect(
      runSessionCore("stor-listing", TERMS, deps, "01J8ME0SXKQ4T9V2RC5HJ6WX7M"),
    ).rejects.toThrow(/did not pass verification/);
    expect(settleCalls).toBe(0);
  });

  test("a strict verifier cannot mutate resolver-owned bytes after verifying a private fail snapshot", async () => {
    const store = new Map<string, Record<string, unknown>>();
    const resumedProduction = currentVetProduction(
      LISTING.agentId,
      "01J8ME0SXKQ4T9V2RC5HJ6WX7N",
      "fail",
      store,
    );
    const logicalAddress =
      "dacs2:composite:01J8ME0SXKQ4T9V2RC5HJ6WX7N:" +
      encodeAddressSegment(LISTING.agentId);
    const durableRecord = store.get(`stor-${logicalAddress}`)!;
    let settleCalls = 0;
    const deps = makeDeps({
      resolveAnchor: async (name) => {
        const ref = `stor-${name}`;
        const value = store.get(ref);
        return value
          ? { status: "present" as const, ref, value }
          : { status: "absent" as const };
      },
      vet: async () => {
        throw new Error("resume must not re-run Vet");
      },
      verifyVetRecord: async (record) => {
        // This is the old TOCTOU: mutate the resolver's outer object while the
        // callback returns a valid verdict for its distinct private snapshot.
        durableRecord.overallDecision = "pass";
        return {
          status: "valid" as const,
          record: structuredClone(record) as CompositeVerificationRecord,
          freshness: [],
          dealSpecific: [],
          freshnessRecipes: [],
          dealSpecificRecipes: [],
        };
      },
      authenticateVetFinality: async () => ({
        ref: structuredClone(resumedProduction.recordRef),
        receipt: structuredClone(resumedProduction.anchorReceipt),
      }),
      settle: async () => {
        settleCalls += 1;
        return { ok: true, txHash: "0x", chainId: "c", payer: "p", payee: "q" };
      },
    });

    await expect(
      runSessionCore(
        "stor-listing",
        TERMS,
        deps,
        "01J8ME0SXKQ4T9V2RC5HJ6WX7N",
      ),
    ).rejects.toThrow(/did not pass verification \(decision=fail\)/);
    expect(durableRecord.overallDecision).toBe("pass");
    expect(settleCalls).toBe(0);
  });

  test("a current Vet producer without recursive verification cannot authorize payment", async () => {
    await expect(
      runSessionCore(
        "stor-listing",
        TERMS,
        makeDeps({
          vet: async ({ evaluatedParty, jobId }) =>
            currentVetProduction(evaluatedParty, jobId, "pass"),
        }),
        "01J8ME0SXKQ4T9V2RC5HJ6WX7P",
      ),
    ).rejects.toThrow(/requires verifyVetRecord/);
  });

  test("a current Vet producer without caller-held finality authentication cannot authorize payment", async () => {
    let settleCalls = 0;
    await expect(
      runSessionCore(
        "stor-listing",
        TERMS,
        makeDeps({
          vet: async ({ evaluatedParty, jobId }) =>
            currentVetProduction(evaluatedParty, jobId, "pass"),
          verifyVetRecord: async (record) => ({
            status: "valid",
            record: record as CompositeVerificationRecord,
            freshness: [],
            dealSpecific: [],
            freshnessRecipes: [],
            dealSpecificRecipes: [],
          }),
          settle: async () => {
            settleCalls += 1;
            throw new Error("must not settle");
          },
        }),
        "01J8ME0SXKQ4T9V2RC5HJ6WX7Q",
      ),
    ).rejects.toThrow(/requires authenticateVetFinality/);
    expect(settleCalls).toBe(0);
  });

  test("a fabricated shape-valid producer receipt is rejected against independently authenticated finality", async () => {
    const store = new Map<string, Record<string, unknown>>();
    let settleCalls = 0;
    const deps = makeDeps({
      resolveAnchor: async (name) => {
        const ref = `stor-${name}`;
        const value = store.get(ref);
        return value
          ? { status: "present" as const, ref, value }
          : { status: "absent" as const };
      },
      vet: async ({ evaluatedParty, jobId }) => {
        const production = currentVetProduction(
          evaluatedParty,
          jobId,
          "pass",
          store,
        );
        production.anchorReceipt.evidence.value = "fabricated-shape-only-proof";
        return production;
      },
      verifyVetRecord: async (record) => ({
        status: "valid",
        record: record as CompositeVerificationRecord,
        freshness: [],
        dealSpecific: [],
        freshnessRecipes: [],
        dealSpecificRecipes: [],
      }),
      authenticateVetFinality: async ({ claimed }) => {
        if (!claimed) return null;
        const independentlyAuthenticated = structuredClone(claimed);
        independentlyAuthenticated.receipt.evidence.value = "authenticated";
        return independentlyAuthenticated;
      },
      settle: async () => {
        settleCalls += 1;
        throw new Error("must not settle");
      },
    });

    await expect(
      runSessionCore("stor-listing", TERMS, deps, "01J8ME0SXKQ4T9V2RC5HJ6WX7R"),
    ).rejects.toThrow(/differs from the independently authenticated receipt/);
    expect(settleCalls).toBe(0);
  });

  test("resume refuses a present passing CVR when finalized receipt recovery cannot authenticate it", async () => {
    const store = new Map<string, Record<string, unknown>>();
    currentVetProduction(
      LISTING.agentId,
      "01J8ME0SXKQ4T9V2RC5HJ6WX7S",
      "pass",
      store,
    );
    let settleCalls = 0;
    const deps = makeDeps({
      resolveAnchor: async (name) => {
        const ref = `stor-${name}`;
        const value = store.get(ref);
        return value
          ? { status: "present" as const, ref, value }
          : { status: "absent" as const };
      },
      vet: async () => {
        throw new Error("resume must not re-run Vet");
      },
      verifyVetRecord: async (record) => ({
        status: "valid",
        record: record as CompositeVerificationRecord,
        freshness: [],
        dealSpecific: [],
        freshnessRecipes: [],
        dealSpecificRecipes: [],
      }),
      authenticateVetFinality: async ({ claimed }) => {
        expect(claimed).toBeUndefined();
        return null;
      },
      settle: async () => {
        settleCalls += 1;
        throw new Error("must not settle");
      },
    });

    await expect(
      runSessionCore(
        "stor-listing",
        TERMS,
        deps,
        "01J8ME0SXKQ4T9V2RC5HJ6WX7S",
      ),
    ).rejects.toThrow(/was not independently authenticated/);
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
      dacsSdkBuyerIdentityBundleHash: BUYER_IDENTITY_HASH,
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

  test("resume rejects a bundle carrying a stale Listing pin before another payment", async () => {
    const normative = normativeDpaListing();
    const expectedListingPin = listingPinFor(normative);
    const store = new Map<string, Record<string, unknown>>();
    let settleCalls = 0;
    const deps = makeDeps({
      expectedListingPin,
      readListing: async () => normative,
      validateListing: () => verifiedAdmissionFor(normative),
      anchor: async (name, value) => {
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
          txHash: "0xabc",
          chainId: "eip155:8453",
          payer: "0xbob",
          payee: "0xalice",
        };
      },
      authenticateRecoveredAgreement: async () => true,
    });
    const terms = {
      ...TERMS,
      price: { ...TERMS.price, rail: "x402:default" },
    };

    const first = await runSessionCore(
      "stor-normative-v7",
      terms,
      deps,
      "job-STALE-BUNDLE-PIN",
    );
    expect(settleCalls).toBe(1);

    const staleBundle = structuredClone(store.get(first.bundleRef)!);
    staleBundle.listingRef = {
      ...expectedListingPin,
      contentHash: "0".repeat(64),
    };
    store.set(first.bundleRef, staleBundle);

    await expect(
      runSessionCore(
        "stor-normative-v7",
        terms,
        deps,
        "job-STALE-BUNDLE-PIN",
      ),
    ).rejects.toThrow(/listing pin .* ≠/);
    expect(settleCalls).toBe(1);
  });

  test("resume aborts when the anchored agreement binds another Listing ref", async () => {
    const store = new Map<string, Record<string, unknown>>();
    let settleCalls = 0;
    // The compatibility agreement cannot carry an LR-1 tuple, but its native
    // Listing binding must still be exact on resume.
    store.set("stor-dacs3:agreement:job-WRONG", {
      jobId: "job-WRONG",
      pattern: "negotiate-fixed-price",
      buyer: "did:demos:agent:bob",
      seller: "did:demos:agent:alice",
      listingRef: "stor-another-listing",
      dacsSdkBuyerIdentityBundleHash: BUYER_IDENTITY_HASH,
      price: TERMS.price,
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

  test("listing verification requires exact boolean true", async () => {
    let settleCalls = 0;
    const deps = makeDeps({
      trustListing: undefined,
      verifyListing: (() => 1) as unknown as NonNullable<
        SessionDeps["verifyListing"]
      >,
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

  test("snapshots terms before any await so a hostile listing reader cannot redirect payment", async () => {
    const mutableTerms = structuredClone(TERMS);
    let settledRequest: Parameters<SessionDeps["settle"]>[0] | undefined;
    const deps = makeDeps({
      readListing: async () => {
        mutableTerms.price.amount = "999999999";
        mutableTerms.price.rail = "pay-attacker";
        mutableTerms.deliveryPhase = "deliver-attacker";
        return LISTING;
      },
      settle: async (request) => {
        settledRequest = structuredClone(request);
        return {
          ok: true,
          txHash: "0xterms",
          chainId: "test",
          payer: "buyer",
          payee: request.expectedPayee,
        };
      },
    });

    await expect(
      runSessionCore("stor-listing", mutableTerms, deps, "job-TERMS-SNAPSHOT"),
    ).resolves.toMatchObject({ outcome: "completed" });
    expect(settledRequest).toMatchObject({
      rail: TERMS.price.rail,
      amount: TERMS.price.amount,
      asset: TERMS.price.asset,
      payee: LISTING.agentId,
    });
  });

  test("snapshots and freezes the resolved listing before verifier awaits", async () => {
    const mutableListing = structuredClone(LISTING);
    let settledPayee = "";
    const deps = makeDeps({
      trustListing: undefined,
      readListing: async () => mutableListing,
      verifyListing: async (raw) => {
        expect(Object.isFrozen(raw)).toBe(true);
        expect(Object.isFrozen(raw.supportedPaymentRails)).toBe(true);
        mutableListing.agentId = "did:demos:agent:attacker";
        mutableListing.supportedPaymentRails.splice(
          0,
          mutableListing.supportedPaymentRails.length,
          "pay-attacker",
        );
        expect(Reflect.set(raw, "agentId", "did:demos:agent:attacker")).toBe(
          false,
        );
        return true;
      },
      settle: async (request) => {
        settledPayee = request.payee;
        return {
          ok: true,
          txHash: "0xlisting",
          chainId: "test",
          payer: "buyer",
          payee: request.expectedPayee,
        };
      },
    });

    await expect(
      runSessionCore("stor-listing", TERMS, deps, "job-LISTING-SNAPSHOT"),
    ).resolves.toMatchObject({ outcome: "completed" });
    expect(settledPayee).toBe(LISTING.agentId);
  });

  test("captures dependency callables/config before await and preserves adapter this binding", async () => {
    let originalSettleCalls = 0;
    let swappedSettleCalls = 0;
    const deps = makeDeps();
    deps.settle = async function (request) {
      originalSettleCalls += 1;
      expect(this).toBe(deps);
      expect(this.buyerId).toBe("did:demos:agent:attacker");
      return {
        ok: true,
        txHash: "0xdeps",
        chainId: "test",
        payer: "buyer",
        payee: request.expectedPayee,
      };
    };
    deps.readListing = async function () {
      expect(this).toBe(deps);
      deps.buyerId = "did:demos:agent:attacker";
      deps.settle = async () => {
        swappedSettleCalls += 1;
        throw new Error("swapped settle must not run");
      };
      deps.nowMs = () => 1;
      return LISTING;
    };

    const result = await runSessionCore(
      "stor-listing",
      TERMS,
      deps,
      "job-DEPS-SNAPSHOT",
    );
    expect(result.outcome).toBe("completed");
    expect(originalSettleCalls).toBe(1);
    expect(swappedSettleCalls).toBe(0);
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
      dacsSdkBuyerIdentityBundleHash: BUYER_IDENTITY_HASH,
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
