import { describe, expect, test } from "vitest";

import { buildSignedArtifact, type Signer } from "../../src/agent/signedArtifact.js";
import {
  verifyBundleCore,
  type VerifyBundleDeps,
} from "../../src/agent/verifyBundleCore.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";

const SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 7));
const BUYER_SEED = Uint8Array.from(Buffer.alloc(32, 9));

function signerFor(seed: Uint8Array): Signer {
  const priv = privateKeyFromSeed(seed);
  return (bytes) => ed25519Sign(bytes, priv);
}
function didFor(seed: Uint8Array): string {
  const hex = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex");
  return `did:demos:agent:${hex}`;
}

const sellerDid = didFor(SELLER_SEED);
const buyerDid = didFor(BUYER_SEED);
const signSeller = signerFor(SELLER_SEED);
const signBuyer = signerFor(BUYER_SEED);

// Mirrors Agent's production wiring: CCI == ed25519 pubkey hex embedded in DID.
const verify = (bytes: Uint8Array, sig: Uint8Array, pub: Uint8Array) =>
  ed25519Verify(bytes, sig, publicKeyFromRaw(pub));
function resolveFromDid(did: string): Uint8Array | null {
  const hex = did.match(/(?:^|:)(?:0x)?([0-9a-fA-F]{64})$/)?.[1];
  return hex ? Uint8Array.from(Buffer.from(hex, "hex")) : null;
}

async function buildStore(): Promise<Map<string, Record<string, unknown>>> {
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
  const agreement = await buildSignedArtifact(
    {
      jobId: "j1",
      pattern: "negotiate-fixed-price",
      buyer: buyerDid,
      seller: sellerDid,
      listingRef: "ref:listing",
      price: { amount: "1000000", asset: "USDC", decimals: 6, rail: "pay-x402" },
      delivery: { phase: "deliver-attested-payload", format: "application/json" },
      expiresAt: "2026-01-01T00:00:00Z",
    },
    ARTIFACT_SEPARATORS.AgreementDocument,
    signBuyer,
  );
  const evidence = await buildSignedArtifact(
    {
      jobId: "j1",
      rail: "pay-x402",
      chainId: "eip155:84532",
      txHash: "0xabc",
      payer: "0xbob",
      payee: "0xalice",
      amount: "1000000",
      asset: "USDC",
      ok: true,
      observedAt: "2026-01-01T00:00:00Z",
    },
    ARTIFACT_SEPARATORS.SettlementEvidence,
    signBuyer,
  );
  const bundle = await buildSignedArtifact(
    {
      jobId: "j1",
      state: "completed",
      primaryClaim: sellerDid,
      artifactRefs: ["ref:listing", "ref:agreement", "ref:evidence"],
      ratings: [],
      signedBy: [buyerDid],
      completedAt: "2026-01-01T00:00:00Z",
    },
    ARTIFACT_SEPARATORS.AttestationBundle,
    signBuyer,
  );
  return new Map<string, Record<string, unknown>>([
    ["ref:listing", listing],
    ["ref:agreement", agreement],
    ["ref:evidence", evidence],
    ["ref:bundle", bundle],
  ]);
}

function depsFor(
  store: Map<string, Record<string, unknown>>,
  resolve = resolveFromDid,
): VerifyBundleDeps {
  return {
    readArtifact: async (ref) => store.get(ref) ?? null,
    resolvePublicKey: async (did) => resolve(did),
    verify,
  };
}

describe("verifyBundleCore (full per-artifact signature verification)", () => {
  test("happy path: every signature valid, bundle fully verified", async () => {
    const res = await verifyBundleCore("ref:bundle", depsFor(await buildStore()));
    expect(res.ok).toBe(true);
    expect(res.fullyVerified).toBe(true);
    expect(res.bundleSignature).toBe("valid");
    expect(res.artifacts.map((a) => a.signature)).toEqual(["valid", "valid", "valid"]);
    expect(res.artifacts.map((a) => a.kind)).toEqual([
      "Listing",
      "AgreementDocument",
      "SettlementEvidence",
    ]);
    // Listing verifies against the seller; agreement/evidence against the buyer.
    expect(res.artifacts[0]?.signer).toBe(sellerDid);
    expect(res.artifacts[1]?.signer).toBe(buyerDid);
  });

  test("tampered artifact => signature invalid, bundle not ok", async () => {
    const store = await buildStore();
    const agreement = { ...store.get("ref:agreement")! };
    agreement.price = { amount: "9999999", asset: "USDC", decimals: 6, rail: "pay-x402" };
    store.set("ref:agreement", agreement);

    const res = await verifyBundleCore("ref:bundle", depsFor(store));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/signature/);
    expect(res.artifacts[1]?.signature).toBe("invalid");
  });

  test("missing referenced artifact => not ok", async () => {
    const store = await buildStore();
    store.delete("ref:evidence");
    const res = await verifyBundleCore("ref:bundle", depsFor(store));
    expect(res.ok).toBe(false);
    expect(res.artifacts[2]?.resolved).toBe(false);
    expect(res.reason).toMatch(/resolve/);
  });

  test("unresolvable signer => unverified (not falsely valid), still ok structurally", async () => {
    const res = await verifyBundleCore(
      "ref:bundle",
      depsFor(await buildStore(), () => null),
    );
    expect(res.ok).toBe(true); // no invalid signatures
    expect(res.fullyVerified).toBe(false);
    expect(res.bundleSignature).toBe("unverified");
    expect(res.artifacts.every((a) => a.signature === "unverified")).toBe(true);
  });

  test("ref that isn't a bundle => rejected", async () => {
    const res = await verifyBundleCore("ref:listing", depsFor(await buildStore()));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not an attestation bundle/);
  });
});
