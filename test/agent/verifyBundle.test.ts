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

function signerFor(seed: Uint8Array): Signer {
  const priv = privateKeyFromSeed(seed);
  return (bytes) => ed25519Sign(bytes, priv);
}
function didFor(seed: Uint8Array): string {
  return `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
}

const buyerDid = didFor(BUYER_SEED);
const signBuyer = signerFor(BUYER_SEED);

// Mirrors Agent's production wiring: CCI == ed25519 pubkey hex embedded in DID.
const verify = (bytes: Uint8Array, sig: Uint8Array, pub: Uint8Array) =>
  ed25519Verify(bytes, sig, publicKeyFromRaw(pub));
function resolveFromDid(did: string): Uint8Array | null {
  const hex = did.match(/(?:^|:)(?:0x)?([0-9a-fA-F]{64})$/)?.[1];
  return hex ? Uint8Array.from(Buffer.from(hex, "hex")) : null;
}

const h = (c: string) => c.repeat(64);

/** Build a spec bundle signed by `party` (mirrors runSession's bundle signing). */
async function signedBundle(party: string, sign: Signer): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    bundleVersion: "1",
    jobId: "j1",
    outcome: "completed",
    anchoredByRole: "buyer",
    listingRef: { listingId: "svc", version: 1, contentHash: h("a") },
    agreementRef: { kind: "dacs-3-agreement", id: "agreement-j1", contentHash: h("b") },
    parties: [{ role: "buyer", bundleHash: h("c"), primaryClaim: party }],
    phaseSummary: [],
    vetRecords: [],
    settlementEvidence: [
      { kind: "dacs-4-evidence", id: "settlement-j1", contentHash: h("d") },
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
  return {
    ...body,
    signatures: [
      { party, algorithm: "ed25519", value: Buffer.from(sig).toString("base64url") },
    ],
  };
}

function depsFor(
  bundle: Record<string, unknown> | null,
  resolve = resolveFromDid,
): VerifyBundleDeps {
  return {
    readArtifact: async () => bundle,
    resolvePublicKey: async (did) => resolve(did),
    verify,
  };
}

describe("verifyBundleCore (DACS-5 bundle signature verification)", () => {
  test("happy path: the bundle signature verifies", async () => {
    const res = await verifyBundleCore("ref", depsFor(await signedBundle(buyerDid, signBuyer)));
    expect(res.ok).toBe(true);
    expect(res.fullyVerified).toBe(true);
    expect(res.signatures).toEqual([{ party: buyerDid, verdict: "valid" }]);
    expect(res.bundle?.outcome).toBe("completed");
  });

  test("tampered bundle body => signature invalid, not ok", async () => {
    const bundle = await signedBundle(buyerDid, signBuyer);
    bundle.outcome = "failed"; // mutate a signed-scope field after signing
    const res = await verifyBundleCore("ref", depsFor(bundle));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/signature/);
    expect(res.signatures[0]?.verdict).toBe("invalid");
  });

  test("unresolvable signer => unverified, not ok (never falsely valid)", async () => {
    const res = await verifyBundleCore(
      "ref",
      depsFor(await signedBundle(buyerDid, signBuyer), () => null),
    );
    expect(res.ok).toBe(false);
    expect(res.fullyVerified).toBe(false);
    expect(res.signatures[0]?.verdict).toBe("unverified");
  });

  test("malformed signer key => error, not a false-negative invalid (§10.4.1)", async () => {
    const res = await verifyBundleCore(
      "ref",
      depsFor(await signedBundle(buyerDid, signBuyer), () => new Uint8Array(16)),
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/malformed/);
    expect(res.signatures[0]?.verdict).toBe("error");
  });

  test("ref that isn't a bundle => rejected", async () => {
    const res = await verifyBundleCore("ref", depsFor({ not: "a bundle" }));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not an attestation bundle/);
  });
});
