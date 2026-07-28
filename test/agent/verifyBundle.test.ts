import { describe, expect, test } from "vitest";

import { buildSignedArtifact, type Signer } from "../../src/agent/signedArtifact.js";
import {
  verifyBundleCore,
  type VerifyBundleDeps,
} from "../../src/agent/verifyBundleCore.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import { contentHash, stripSignature } from "../../src/canonical/index.js";
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
const SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 21));

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
async function buildArtifacts() {
  // #38: the referenced listing must be signed by its seller, so sign it here.
  const listing = await buildSignedArtifact(
    {
      agentId: sellerDid,
      serviceId: "svc",
      name: "n",
      description: "d",
      claimRequirements: [],
      supportedNegotiation: ["negotiate-fixed-price"],
      supportedPaymentRails: ["pay-x402"],
      supportedDelivery: ["deliver-attested-payload"],
    },
    ARTIFACT_SEPARATORS.Listing,
    signSeller,
  );
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
  const { listing, agreement, evidence } = await buildArtifacts();
  const body: Record<string, unknown> = {
    bundleVersion: "1",
    jobId: "j1",
    outcome: "completed",
    anchoredByRole: "buyer",
    listingRef: {
      listingId: listing.serviceId,
      version: 1,
      contentHash: contentHash(stripSignature(listing)),
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
  const message = signedBytes(ARTIFACT_SEPARATORS.AttestationBundle, contentHash(scope));
  // §10.4.1: a completed bundle is two-signed (buyer + seller). The `party`/`sign`
  // params drive the BUYER signature (tests vary it); the seller always co-signs
  // validly, so signer-coverage (#39) is satisfied for the happy path.
  const sig = await sign(message);
  const sellerSig = await signSeller(message);
  const bundle = {
    ...body,
    signatures: [
      { party, algorithm: "ed25519", value: Buffer.from(sig).toString("base64url") },
      { party: sellerDid, algorithm: "ed25519", value: Buffer.from(sellerSig).toString("base64url") },
    ],
  };
  return { bundle, listing, agreement, evidence };
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
    // §10.4.1 two-signed completed bundle: buyer + seller both valid (#39).
    expect(res.signatures).toEqual([
      { party: buyerDid, verdict: "valid" },
      { party: sellerDid, verdict: "valid" },
    ]);
    expect(res.refs.every((r) => r.verdict === "ok")).toBe(true);
    expect(res.bundle?.outcome).toBe("completed");
  });

  test("tampered bundle body => signature invalid, not ok", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    fx.bundle.outcome = "failed"; // mutate a signed-scope field after signing
    const res = await verifyBundleCore("ref", depsFor(fx));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/signature/);
    expect(res.signatures[0]?.verdict).toBe("invalid");
  });

  test("#39: a completed bundle with ONLY the buyer signature is rejected (missing seller)", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    // Both parties still named (so the buyer sig stays valid over the scope), but
    // the SELLER signature is missing — a unilateral 'completed' bundle.
    (fx.bundle.signatures as unknown[]).splice(1, 1);
    const res = await verifyBundleCore("ref", depsFor(fx));
    expect(res.signatures[0]?.verdict).toBe("valid"); // the buyer sig itself is fine…
    expect(res.ok).toBe(false); // …but coverage fails
    expect(res.fullyVerified).toBe(false);
    expect(res.reason).toMatch(/buyer and seller|required party/);
  });

  test("#39: an abort bundle stands on a single valid signature (§10.11 carve-out)", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    // Single-signed abort: drop the seller, set an abort outcome, re-sign the buyer.
    (fx.bundle.parties as unknown[]).splice(1, 1);
    const body = { ...(fx.bundle as Record<string, unknown>) };
    delete body["signatures"];
    delete body["anchoredByRole"];
    body["outcome"] = "aborted-by-other";
    const { contentHash: ch } = await import("../../src/canonical/index.js");
    const msg = signedBytes(ARTIFACT_SEPARATORS.AttestationBundle, ch(body));
    const sig = await signBuyer(msg);
    fx.bundle = {
      ...body,
      anchoredByRole: "buyer",
      signatures: [{ party: buyerDid, algorithm: "ed25519", value: Buffer.from(sig).toString("base64url") }],
    };
    const res = await verifyBundleCore("ref", depsFor(fx));
    expect(res.bundle?.outcome).toBe("aborted-by-other");
    expect(res.ok).toBe(true); // one valid signature suffices for an abort
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

  test("#38: a referenced listing not validly signed by its seller => invalid-signature, not ok", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    // Same listing content (hash still matches the ref), but with the seller
    // signature stripped — a fabricated unsigned listing.
    fx.listing = stripSignature(fx.listing);
    const res = await verifyBundleCore("ref", depsFor(fx));
    expect(res.ok).toBe(false);
    const lst = res.refs.find((r) => r.kind === "dacs-1-listing");
    expect(lst?.verdict).toBe("invalid-signature");
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
