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
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
const OTHER_JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7F";

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
    agreementVersion: "1",
    jobId: JOB_ID,
    listingRef: {
      listingId: listing.serviceId,
      version: 1,
      contentHash: contentHash(listing),
    },
    parties: [
      {
        role: "buyer",
        bundleHash: h("c"),
        primaryClaim: buyerDid,
        vetRecordRef: {
          anchor: { kind: "storage-program", locator: "buyer-vet-j1" },
          contentHash: h("1"),
        },
      },
      {
        role: "seller",
        bundleHash: h("d"),
        primaryClaim: sellerDid,
        vetRecordRef: {
          anchor: { kind: "storage-program", locator: "seller-vet-j1" },
          contentHash: h("2"),
        },
      },
    ],
    terms: {
      deliverable: { deliverableType: "attested-payload", hash: h("3") },
      price: { amount: "1", currency: "USDC" },
      rail: { railId: "x402:default" },
      deadline: 1780000600000,
    },
    derivedFromPattern: "fixed-price",
    generatedAt: 1780000000000,
    signatures: [
      { party: buyerDid, algorithm: "ed25519", value: Buffer.alloc(64, 5).toString("base64url") },
      { party: sellerDid, algorithm: "ed25519", value: Buffer.alloc(64, 6).toString("base64url") },
    ],
  };
  const evidence = {
    evidenceVersion: "1",
    jobId: JOB_ID,
    phase: "pay-x402",
    outcome: "success",
    paymentTxRefs: [
      {
        kind: "x402",
        httpResource: "https://seller.example/pay",
        paymentReceiptHash: h("e"),
        settlementTxHash: "0xabc",
        chainId: 84532,
        protocolVersion: "1",
      },
    ],
    paymentAmount: { amount: "1000000", currency: "USDC" },
    settlementFinality: {
      model: "provider-receipt",
      finalityObservedAt: 1780000000000,
    },
    observedAt: 1780000000000,
    signature: {
      algorithm: "ed25519",
      signer: buyerDid,
      value: Buffer.alloc(64, 4).toString("base64url"),
    },
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
    jobId: JOB_ID,
    outcome: "completed",
    anchoredByRole: "buyer",
    listingRef: {
      listingId: listing.serviceId,
      version: 1,
      contentHash: contentHash(listing),
    },
    agreementRef: {
      anchor: { kind: "storage-program", locator: "agreement-j1" },
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
        anchor: { kind: "storage-program", locator: "settlement-j1" },
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
  const separator = fx.bundle.faultBundleVersion === "1"
    ? ARTIFACT_SEPARATORS.FaultAttestationBundle
    : ARTIFACT_SEPARATORS.AttestationBundle;
  fx.bundle.signatures = await Promise.all(
    signers.map(async ({ party, sign }) => ({
      party,
      algorithm: "ed25519",
      value: Buffer.from(
        await sign(signedBytes(separator, contentHash(scope))),
      ).toString("base64url"),
    })),
  );
}

/** Wire deps that resolve the fixture's artifacts (overridable per test). */
function depsFor(
  fx: Fixture,
  opts: {
    resolve?: (did: string) => Uint8Array | null;
    resolveAttestationRef?: VerifyBundleDeps["resolveAttestationRef"];
    resolveRef?: VerifyBundleDeps["resolveRef"];
    listing?: Record<string, unknown> | null;
    verifyEvidence?: VerifyBundleDeps["verifyEvidence"];
  } = {},
): VerifyBundleDeps {
  const listing = opts.listing === undefined ? fx.listing : opts.listing;
  return {
    readArtifact: async (ref) =>
      ref === LISTING_ADDR ? listing : fx.bundle,
    resolveAttestationRef:
      opts.resolveAttestationRef ??
      (async (ref) =>
        ref.anchor.locator === "agreement-j1"
          ? fx.agreement
          : ref.anchor.locator === "settlement-j1"
            ? fx.evidence
            : null),
    resolveListingRef: async () => listing,
    ...(opts.resolveRef ? { resolveRef: opts.resolveRef } : {}),
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

  test("v0.3 FaultAttestationBundle verifies under its distinct domain", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    delete fx.bundle.bundleVersion;
    fx.bundle.faultBundleVersion = "1";
    fx.bundle.faultedParty = "none";
    await resignFixture(fx, [
      { party: buyerDid, sign: signBuyer },
      { party: sellerDid, sign: signSeller },
    ]);
    const res = await verifyBundleCore("ref", depsFor(fx));
    expect(res.ok).toBe(true);
    expect(res.bundle).toMatchObject({ faultBundleVersion: "1", faultedParty: "none" });
  });

  test("fault-bundle discriminator and permissible fault fail closed", async () => {
    const both = await buildFixture(buyerDid, signBuyer);
    both.bundle.faultBundleVersion = "1";
    expect((await verifyBundleCore("ref", depsFor(both))).reason).toMatch(/not an attestation bundle/i);

    const invalid = await buildFixture(buyerDid, signBuyer);
    delete invalid.bundle.bundleVersion;
    invalid.bundle.faultBundleVersion = "1";
    invalid.bundle.faultedParty = "buyer";
    await resignFixture(invalid, [
      { party: buyerDid, sign: signBuyer },
      { party: sellerDid, sign: signSeller },
    ]);
    const result = await verifyBundleCore("ref", depsFor(invalid));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/faultedParty/);
  });

  test("legacy-domain signatures cannot replay as fault-bundle signatures", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    delete fx.bundle.bundleVersion;
    fx.bundle.faultBundleVersion = "1";
    fx.bundle.faultedParty = "none";
    const scope = { ...fx.bundle };
    delete scope.signatures;
    delete scope.anchoredByRole;
    const legacyMessage = signedBytes(ARTIFACT_SEPARATORS.AttestationBundle, contentHash(scope));
    fx.bundle.signatures = [
      { party: buyerDid, algorithm: "ed25519", value: Buffer.from(await signBuyer(legacyMessage)).toString("base64url") },
      { party: sellerDid, algorithm: "ed25519", value: Buffer.from(await signSeller(legacyMessage)).toString("base64url") },
    ];
    const result = await verifyBundleCore("ref", depsFor(fx));
    expect(result.ok).toBe(false);
    expect(result.signatures.every((entry) => entry.verdict === "invalid")).toBe(true);
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
    // is still valid. Tamper a benign field (observedAt) so the artifact stays a
    // structurally-valid SettlementEvidence and the mismatch surfaces as a
    // hash-mismatch — NOT invalid-shape (flipping outcome→failure would also
    // strip the required finality and trip the shape check first, §9.7).
    fx.evidence.observedAt = 1780000000001;
    const res = await verifyBundleCore("ref", depsFor(fx));
    expect(res.signatures[0]?.verdict).toBe("valid");
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/referenced artifact/);
    const ev = res.refs.find((r) => r.kind === "dacs-4-evidence");
    expect(ev?.verdict).toBe("hash-mismatch");
  });

  test("hash-matched agreements must preserve bundle job and party bindings", async () => {
    for (const variant of ["job", "buyer-claim", "seller-bundle"] as const) {
      const fx = await buildFixture(buyerDid, signBuyer);
      const parties = fx.agreement.parties as Array<Record<string, unknown>>;
      const agreementSignatures = fx.agreement.signatures as Array<
        Record<string, unknown>
      >;
      if (variant === "job") {
        fx.agreement.jobId = OTHER_JOB_ID;
      } else if (variant === "buyer-claim") {
        const substitute = didFor(Uint8Array.from(Buffer.alloc(32, 11)));
        parties[0]!.primaryClaim = substitute;
        agreementSignatures[0]!.party = substitute;
      } else {
        parties[1]!.bundleHash = h("e");
      }
      (
        fx.bundle.agreementRef as {
          contentHash: string;
        }
      ).contentHash = contentHash(fx.agreement);
      await resignFixture(fx, [
        { party: buyerDid, sign: signBuyer },
        { party: sellerDid, sign: signSeller },
      ]);

      const result = await verifyBundleCore("ref", depsFor(fx));
      expect(result.ok, variant).toBe(false);
      expect(
        result.refs.find((ref) => ref.kind === "dacs-3-agreement")?.verdict,
        variant,
      ).toBe("incoherent");
      expect(result.reason, variant).toMatch(
        /agreement.*incoherent|missing required signature/i,
      );
    }
  });

  test("rejects accessor-backed resolver results without invoking getters", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const liveAgreement = structuredClone(fx.agreement);
    let reads = 0;
    Object.defineProperty(liveAgreement, "jobId", {
      enumerable: true,
      get: () => {
        reads += 1;
        return JOB_ID;
      },
    });
    const result = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        resolveAttestationRef: async (ref) =>
          ref.anchor.locator === "agreement-j1"
            ? liveAgreement
            : ref.anchor.locator === "settlement-j1"
              ? fx.evidence
              : null,
      }),
    );
    expect(result.ok).toBe(false);
    expect(
      result.refs.find((ref) => ref.kind === "dacs-3-agreement")?.verdict,
    ).toBe("invalid-shape");
    expect(reads).toBe(0);
  });

  test("owns callback results, captures deps, and isolates resolver/verifier inputs", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const deps = depsFor(fx);
    let firstKeyResolution = true;

    deps.resolveAttestationRef = async (ref, _jobId, parties) => {
      const locator = ref.anchor.locator;
      (ref as { contentHash: string }).contentHash = h("0");
      (parties[0] as { primaryClaim: string }).primaryClaim =
        "did:demos:agent:callback-mutation";
      if (locator === "agreement-j1") return fx.agreement;
      if (locator === "settlement-j1") {
        (
          fx.agreement.listingRef as {
            contentHash: string;
          }
        ).contentHash = h("f");
        return fx.evidence;
      }
      return null;
    };
    deps.resolvePublicKey = async (did) => {
      if (firstKeyResolution) {
        firstKeyResolution = false;
        const signatures = fx.bundle.signatures as Array<
          Record<string, unknown>
        >;
        signatures[1]!.value = Buffer.alloc(64).toString("base64url");
      }
      return resolveFromDid(did);
    };
    deps.verify = (bytes, signature, publicKey) => {
      const result = verify(bytes, signature, publicKey);
      bytes.fill(0);
      signature.fill(0);
      publicKey.fill(0);
      return result;
    };
    const capturedRead = deps.readArtifact;
    deps.readArtifact = async function (ref) {
      expect(this).toBe(deps);
      deps.resolveAttestationRef = async () => null;
      deps.resolvePublicKey = async () => null;
      deps.verify = () => false;
      return capturedRead(ref);
    };

    const result = await verifyBundleCore("ref", deps);
    expect(result.ok).toBe(true);
    expect(result.signatures.every(({ verdict }) => verdict === "valid")).toBe(
      true,
    );
    expect(result.refs.every(({ verdict }) => verdict === "ok")).toBe(true);
  });

  test("rejects accessor and Proxy dependency bags before reading artifacts", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const deps = depsFor(fx);
    let getterReads = 0;
    let artifactReads = 0;
    const originalRead = deps.readArtifact;
    deps.readArtifact = async (ref) => {
      artifactReads += 1;
      return originalRead(ref);
    };
    Object.defineProperty(deps, "resolvePublicKey", {
      enumerable: true,
      configurable: true,
      get: () => {
        getterReads += 1;
        fx.bundle.jobId = OTHER_JOB_ID;
        return async () => null;
      },
    });
    await expect(verifyBundleCore("ref", deps)).rejects.toThrow(
      /resolvePublicKey dependency must be an enumerable data property/,
    );
    expect(getterReads).toBe(0);
    expect(artifactReads).toBe(0);
    expect(fx.bundle.jobId).toBe(JOB_ID);

    const proxyDeps = new Proxy(depsFor(fx), {
      get() {
        throw new Error("Proxy trap must not run");
      },
    });
    await expect(verifyBundleCore("ref", proxyDeps)).rejects.toThrow(
      /plain data object/,
    );

    const callbackProxyDeps = depsFor(fx);
    callbackProxyDeps.readArtifact = new Proxy(
      callbackProxyDeps.readArtifact,
      {},
    );
    await expect(
      verifyBundleCore("ref", callbackProxyDeps),
    ).rejects.toThrow(/readArtifact dependency must be a non-Proxy function/);
  });

  test.each(["fail", "error", "indeterminate"] as const)(
    "optional verifyEvidence: %s fails closed and receives the signed record",
    async (decision) => {
      const fx = await buildFixture(buyerDid, signBuyer);
      const res = await verifyBundleCore(
        "ref",
        depsFor(fx, {
          verifyEvidence: async (evidence) => {
            expect(evidence.signature).toEqual(fx.evidence.signature);
            return { decision };
          },
        }),
      );
      expect(res.signatures[0]?.verdict).toBe("valid");
      expect(res.ok).toBe(false);
      const ev = res.refs.find((r) => r.kind === "dacs-4-evidence");
      expect(ev?.verdict).toBe("invalid-evidence");
      expect(res.reason).toMatch(/invalid-evidence/);
    },
  );

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
      depsFor(fx, { resolveAttestationRef: async () => null }),
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
    expect(res.reason).toMatch(/not an attestation bundle/i);
  });

  test("pre-commit phase names do not trigger the agreementRef requirement", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    delete fx.bundle.agreementRef;
    fx.bundle.outcome = "aborted-by-other";
    fx.bundle.settlementEvidence = [];
    fx.bundle.phaseSummary = [
      { index: 0, kind: "vet-credentials", outcome: "ok" },
    ];
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
      {
        anchor: { kind: "storage-program", locator: "amendment-j1" },
        contentHash: contentHash(amendment),
      },
    ];
    fx.bundle.ratingRefs = [
      {
        anchor: { kind: "storage-program", locator: "rating-j1" },
        contentHash: contentHash(rating),
      },
    ];
    await resignFixture(fx, [
      { party: buyerDid, sign: signBuyer },
      { party: sellerDid, sign: signSeller },
    ]);

    const ok = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        resolveAttestationRef: async (ref) =>
          ref.anchor.locator === "agreement-j1"
            ? fx.agreement
            : ref.anchor.locator === "settlement-j1"
              ? fx.evidence
              : ref.anchor.locator === "amendment-j1"
                ? amendment
                : ref.anchor.locator === "rating-j1"
                  ? rating
                  : null,
      }),
    );
    expect(ok.ok).toBe(true);

    const bad = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        resolveAttestationRef: async (ref) =>
          ref.anchor.locator === "agreement-j1"
            ? fx.agreement
            : ref.anchor.locator === "settlement-j1"
              ? fx.evidence
              : ref.anchor.locator === "amendment-j1"
                ? { ...amendment, reason: "tampered" }
                : ref.anchor.locator === "rating-j1"
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

  test("passes the exact ref and bundle parties to resolution for owner binding (#70)", async () => {
    const fx = await buildFixture(buyerDid, signBuyer);
    const seen: Array<readonly unknown[]> = [];
    const res = await verifyBundleCore(
      "ref",
      depsFor(fx, {
        resolveAttestationRef: async (ref, jobId, parties) => {
          seen.push([ref, jobId, parties]);
          return ref.anchor.locator === "agreement-j1"
            ? fx.agreement
            : ref.anchor.locator === "settlement-j1"
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
