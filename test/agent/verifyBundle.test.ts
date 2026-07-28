import { describe, expect, test } from "vitest";

import type { Signer } from "../../src/agent/signedArtifact.js";
import {
  verifyBundleCore,
  type VerifyBundleDeps,
} from "../../src/agent/verifyBundleCore.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import { contentHash } from "../../src/canonical/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
  signedBytes,
} from "../../src/crypto/index.js";

const BUYER_SEED = Uint8Array.from(Buffer.alloc(32, 9));
const SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 10));

function signerFor(seed: Uint8Array): Signer {
  const priv = privateKeyFromSeed(seed);
  return (bytes) => ed25519Sign(bytes, priv);
}
function didFor(seed: Uint8Array): string {
  return `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
}

const buyerDid = didFor(BUYER_SEED);
const signBuyer = signerFor(BUYER_SEED);
const sellerDid = didFor(SELLER_SEED);
const signSeller = signerFor(SELLER_SEED);

// Mirrors Agent's production wiring: CCI == ed25519 pubkey hex embedded in DID.
const verify = (bytes: Uint8Array, sig: Uint8Array, pub: Uint8Array) =>
  ed25519Verify(bytes, sig, publicKeyFromRaw(pub));
function resolveFromDid(did: string): Uint8Array | null {
  const hex = did.match(/(?:^|:)(?:0x)?([0-9a-fA-F]{64})$/)?.[1];
  return hex ? Uint8Array.from(Buffer.from(hex, "hex")) : null;
}

const h = (c: string) => c.repeat(64);
const LISTING_ADDR = "stor-listing";

/** The session artifacts a real bundle references. */
function buildArtifacts() {
  const listing = {
    agentId: sellerDid,
    serviceId: "svc",
    name: "n",
    description: "d",
    claimRequirements: [],
    supportedNegotiation: ["negotiate-fixed-price"],
    supportedPaymentRails: ["pay-x402"],
    supportedDelivery: ["deliver-attested-payload"],
  };
  const agreement = {
    jobId: "j1",
    pattern: "negotiate-fixed-price",
    buyer: buyerDid,
    seller: sellerDid,
    listingRef: LISTING_ADDR,
    price: { amount: "1000000", asset: "USDC", decimals: 6, rail: "pay-x402" },
    delivery: { phase: "deliver-attested-payload", format: "application/json" },
    expiresAt: "2026-01-01T00:00:00Z",
  };
  const evidence = {
    evidenceVersion: "1",
    jobId: "j1",
    phase: "pay-x402",
    phaseIndex: 0,
    outcome: "success",
    paymentTxRefs: [{ rail: "eip155:84532", txHash: "0xabc", kind: "payment" }],
    paymentAmount: { amount: "1000000", currency: "USDC" },
    settlementFinality: {
      model: "provider-receipt",
      finalityBlocks: 0,
      finalityObservedAt: 1780000000000,
    },
    observedAt: 1780000000000,
  };
  return { listing, agreement, evidence };
}

interface Fixture {
  bundle: Record<string, unknown>;
  listing: Record<string, unknown>;
  agreement: Record<string, unknown>;
  evidence: Record<string, unknown>;
}

/** Build a spec bundle whose refs content-address the resolvable artifacts. */
async function buildFixture(party: string, sign: Signer): Promise<Fixture> {
  const { listing, agreement, evidence } = buildArtifacts();
  const body: Record<string, unknown> = {
    bundleVersion: "1",
    jobId: "j1",
    outcome: "completed",
    anchoredByRole: "buyer",
    listingRef: {
      listingId: listing.serviceId,
      version: 1,
      contentHash: contentHash(listing),
    },
    agreementRef: {
      kind: "dacs-3-agreement",
      id: "agreement-j1",
      contentHash: contentHash(agreement),
    },
    parties: [
      { role: "buyer", bundleHash: h("c"), primaryClaim: party },
      { role: "seller", bundleHash: h("d"), primaryClaim: sellerDid },
    ],
    phaseSummary: [],
    vetRecords: [],
    settlementEvidence: [
      {
        kind: "dacs-4-evidence",
        id: "settlement-j1",
        contentHash: contentHash(evidence),
      },
    ],
    recipeRegistryVersion: 1,
    railRegistryVersion: 1,
    finalisedAt: 1780000000000,
  };
  const scope = { ...body };
  delete scope["anchoredByRole"];
  const sig = await sign(
    signedBytes(ARTIFACT_SEPARATORS.AttestationBundle, contentHash(scope)),
  );
  const sellerSig = await signSeller(
    signedBytes(ARTIFACT_SEPARATORS.AttestationBundle, contentHash(scope)),
  );
  const bundle = {
    ...body,
    signatures: [
      { party, algorithm: "ed25519", value: Buffer.from(sig).toString("base64url") },
      { party: sellerDid, algorithm: "ed25519", value: Buffer.from(sellerSig).toString("base64url") },
    ],
  };
  return { bundle, listing, agreement, evidence };
}

async function resignFixture(fx: Fixture, signers: Array<{ party: string; sign: Signer }>): Promise<void> {
  const scope = { ...fx.bundle };
  delete scope["signatures"];
  delete scope["anchoredByRole"];
  fx.bundle.signatures = await Promise.all(
    signers.map(async ({ party, sign }) => ({
      party,
      algorithm: "ed25519",
      value: Buffer.from(
        await sign(signedBytes(ARTIFACT_SEPARATORS.AttestationBundle, contentHash(scope))),
      ).toString("base64url"),
    })),
  );
}

/** Wire deps that resolve the fixture's artifacts (overridable per test). */
function depsFor(
  fx: Fixture,
  opts: {
    resolve?: (did: string) => Uint8Array | null;
    resolveRef?: VerifyBundleDeps["resolveRef"];
    listing?: Record<string, unknown> | null;
    verifyEvidence?: VerifyBundleDeps["verifyEvidence"];
  } = {},
): VerifyBundleDeps {
  const listing = opts.listing === undefined ? fx.listing : opts.listing;
  return {
    readArtifact: async (ref) =>
      ref === LISTING_ADDR ? listing : fx.bundle,
    resolveRef:
      opts.resolveRef ??
      (async (kind) =>
        kind === "dacs-3-agreement"
          ? fx.agreement
          : kind === "dacs-4-evidence"
            ? fx.evidence
            : null),
    resolvePublicKey: async (did) => (opts.resolve ?? resolveFromDid)(did),
    verify,
    ...(opts.verifyEvidence ? { verifyEvidence: opts.verifyEvidence } : {}),
  };
}

describe("verifyBundleCore (DACS-5 bundle signature + ref integrity)", () => {
  test("happy path: signature verifies and every ref resolves + hash-matches", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const res = await verifyBundleCore("ref", depsFor(fx));
    expect(res.ok).toBe(true);
    expect(res.fullyVerified).toBe(true);
    expect(res.signatures).toEqual([
      { party: buyerDid, verdict: "valid" },
      { party: sellerDid, verdict: "valid" },
    ]);
    expect(res.refs.every((r) => r.verdict === "ok")).toBe(true);
    expect(res.bundle?.outcome).toBe("completed");
  });

  test("tampered bundle body => signature invalid, not ok", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    fx.bundle.outcome = "failed-substrate"; // mutate a signed-scope field after signing
    const res = await verifyBundleCore("ref", depsFor(fx));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/signature/);
    expect(res.signatures[0]?.verdict).toBe("invalid");
  });

  test("unresolvable signer => unverified, not ok (never falsely valid)", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const res = await verifyBundleCore("ref", depsFor(fx, { resolve: () => null }));
    expect(res.ok).toBe(false);
    expect(res.fullyVerified).toBe(false);
    expect(res.signatures[0]?.verdict).toBe("unverified");
  });

  test("malformed signer key => error, not a false-negative invalid (§10.4.1)", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const res = await verifyBundleCore(
      "ref",
      depsFor(fx, { resolve: () => new Uint8Array(16) }),
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/malformed/);
    expect(res.signatures[0]?.verdict).toBe("error");
  });

  test("tampered referenced artifact => hash-mismatch, not ok", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    // The signed evidence the bundle points at is altered after the fact: its
    // content hash no longer matches the ref, even though the bundle signature
    // is still valid.
    fx.evidence.outcome = "failure";
    const res = await verifyBundleCore("ref", depsFor(fx));
    expect(res.signatures[0]?.verdict).toBe("valid");
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/referenced artifact/);
    const ev = res.refs.find((r) => r.kind === "dacs-4-evidence");
    expect(ev?.verdict).toBe("hash-mismatch");
  });

  test("optional verifyEvidence: a hash-matched but semantically-invalid evidence => invalid-evidence, not ok", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    // The evidence hash-matches (bundle signature valid), but the wired §9.7
    // verifier rejects it — e.g. wrong finality model — so the ref is downgraded.
    const res = await verifyBundleCore(
      "ref",
      depsFor(fx, { verifyEvidence: async () => ({ decision: "fail" }) }),
    );
    expect(res.signatures[0]?.verdict).toBe("valid");
    expect(res.ok).toBe(false);
    const ev = res.refs.find((r) => r.kind === "dacs-4-evidence");
    expect(ev?.verdict).toBe("invalid-evidence");
    expect(res.reason).toMatch(/invalid-evidence/);
  });

  test("optional verifyEvidence: a passing evidence keeps the bundle ok", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const res = await verifyBundleCore(
      "ref",
      depsFor(fx, { verifyEvidence: async () => ({ decision: "pass" }) }),
    );
    expect(res.ok).toBe(true);
    expect(res.refs.every((r) => r.verdict === "ok")).toBe(true);
  });

  test("missing referenced artifact => not ok", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const res = await verifyBundleCore(
      "ref",
      depsFor(fx, { resolveRef: async () => null }),
    );
    expect(res.ok).toBe(false);
    const agr = res.refs.find((r) => r.kind === "dacs-3-agreement");
    expect(agr?.verdict).toBe("missing");
  });

  test("missing listing (resolves via the agreement chain) => not ok", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const res = await verifyBundleCore("ref", depsFor(fx, { listing: null }));
    expect(res.ok).toBe(false);
    const lst = res.refs.find((r) => r.kind === "dacs-1-listing");
    expect(lst?.verdict).toBe("missing");
  });

  test("no resolver => refs unresolved, cannot be ok", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const res = await verifyBundleCore("ref", {
      readArtifact: async () => fx.bundle,
      resolvePublicKey: async (did) => resolveFromDid(did),
      verify,
    });
    expect(res.ok).toBe(false);
    expect(res.refs.every((r) => r.verdict === "unresolved")).toBe(true);
  });

  test("pre-commit bundle without agreementRef resolves listing directly", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    delete fx.bundle.agreementRef;
    fx.bundle.outcome = "aborted-by-other";
    fx.bundle.settlementEvidence = [];
    const scope = { ...fx.bundle };
    delete scope["signatures"];
    delete scope["anchoredByRole"];
    const sig = await signBuyer(
      signedBytes(ARTIFACT_SEPARATORS.AttestationBundle, contentHash(scope)),
    );
    fx.bundle.signatures = [
      { party: buyerDid, algorithm: "ed25519", value: Buffer.from(sig).toString("base64url") },
    ];

    const res = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        resolveRef: async (kind) =>
          kind === "dacs-1-listing" ? fx.listing : null,
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.refs.find((r) => r.kind === "dacs-1-listing")?.verdict).toBe("ok");
  });

  test("completed or post-commit bundle without agreementRef fails verification", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    delete fx.bundle.agreementRef;
    await resignFixture(fx, [
      { party: buyerDid, sign: signBuyer },
      { party: sellerDid, sign: signSeller },
    ]);

    const res = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        resolveRef: async (kind) =>
          kind === "dacs-1-listing" ? fx.listing : null,
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.refs.find((r) => r.kind === "dacs-3-agreement")?.verdict).toBe("missing");
  });

  test("single-signed completed bundle fails even when refs resolve", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    await resignFixture(fx, [{ party: buyerDid, sign: signBuyer }]);
    const res = await verifyBundleCore("ref", depsFor(fx));
    expect(res.ok).toBe(false);
    expect(res.fullyVerified).toBe(false);
    expect(res.reason).toMatch(/missing required signature/i);
  });

  test("completed bundle that omits the seller party fails even when refs resolve", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    fx.bundle.parties = (fx.bundle.parties as Array<{ role: string }>).filter((party) => party.role !== "seller");
    await resignFixture(fx, [{ party: buyerDid, sign: signBuyer }]);
    const res = await verifyBundleCore("ref", depsFor(fx));
    expect(res.ok).toBe(false);
    expect(res.reason).toContain(sellerDid);
  });

  test("completed bundle cannot satisfy seller signature by spoofing the seller party claim", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    fx.bundle.parties = (fx.bundle.parties as Array<Record<string, unknown>>).map((party) =>
      party.role === "seller" ? { ...party, primaryClaim: buyerDid } : party,
    );
    await resignFixture(fx, [{ party: buyerDid, sign: signBuyer }]);
    const res = await verifyBundleCore("ref", depsFor(fx));
    expect(res.ok).toBe(false);
    expect(res.reason).toContain(sellerDid);
  });

  test("unknown bundle outcomes fail closed", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    fx.bundle.outcome = "failed";
    await resignFixture(fx, [{ party: buyerDid, sign: signBuyer }]);
    const res = await verifyBundleCore("ref", depsFor(fx));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/unsupported DACS-5 bundle outcome/i);
  });

  test("pre-commit phase names do not trigger the agreementRef requirement", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    delete fx.bundle.agreementRef;
    fx.bundle.outcome = "aborted-by-other";
    fx.bundle.settlementEvidence = [];
    fx.bundle.phaseSummary = [{ index: 0, kind: "pre-commit-check", outcome: "ok" }];
    await resignFixture(fx, [
      { party: buyerDid, sign: signBuyer },
      { party: sellerDid, sign: signSeller },
    ]);

    const res = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        resolveRef: async (kind) =>
          kind === "dacs-1-listing" ? fx.listing : null,
      }),
    );
    expect(res.ok).toBe(true);
  });

  test("amendment and rating refs must resolve and hash-match", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const amendment = { amendmentVersion: "1", jobId: "j1", reason: "refund" };
    const rating = { ratingVersion: "1", jobId: "j1", value: 5 };
    fx.bundle.amendments = [
      { kind: "dacs-4-amendment", id: "amendment-j1", contentHash: contentHash(amendment) },
    ];
    fx.bundle.ratingRefs = [
      { kind: "dacs-5-rating", id: "rating-j1", contentHash: contentHash(rating) },
    ];
    await resignFixture(fx, [
      { party: buyerDid, sign: signBuyer },
      { party: sellerDid, sign: signSeller },
    ]);

    const ok = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        resolveRef: async (kind) =>
          kind === "dacs-3-agreement"
            ? fx.agreement
            : kind === "dacs-4-evidence"
              ? fx.evidence
              : kind === "dacs-4-amendment"
                ? amendment
                : kind === "dacs-5-rating"
                  ? rating
                  : null,
      }),
    );
    expect(ok.ok).toBe(true);

    const bad = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        resolveRef: async (kind) =>
          kind === "dacs-3-agreement"
            ? fx.agreement
            : kind === "dacs-4-evidence"
              ? fx.evidence
              : kind === "dacs-4-amendment"
                ? { ...amendment, reason: "tampered" }
                : kind === "dacs-5-rating"
                  ? rating
                  : null,
      }),
    );
    expect(bad.ok).toBe(false);
    expect(bad.refs.find((r) => r.kind === "dacs-4-amendment")?.verdict).toBe(
      "hash-mismatch",
    );
  });

  test("ref that isn't a bundle => rejected", async () => {
    const res = await verifyBundleCore("ref", {
      readArtifact: async () => ({ not: "a bundle" }),
      resolvePublicKey: async () => null,
      verify,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not an attestation bundle/);
  });

  test("passes the bundle's parties to resolveRef so resolution can owner-bind to the anchoring party (#70)", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const seen: Array<readonly unknown[]> = [];
    const res = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        resolveRef: async (kind, jobId, parties) => {
          seen.push([kind, jobId, parties]);
          return kind === "dacs-3-agreement"
            ? fx.agreement
            : kind === "dacs-4-evidence"
              ? fx.evidence
              : null;
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    for (const [, , parties] of seen) {
      expect(parties).toEqual(fx.bundle.parties);
    }
  });
});
