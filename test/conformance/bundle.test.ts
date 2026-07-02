import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { verifyBundleCore } from "../../src/agent/verifyBundleCore.js";
import { contentHash, stripSignature } from "../../src/canonical/index.js";
import {
  ed25519Verify,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";

/**
 * DACS-Standard §14 conformance — the `bundle` area (§10.4). Drives the real
 * reference attestation-bundle fixtures through verifyBundleCore + our
 * canonical hashing, asserting the golden bundle hashes (byte-stability) and the
 * §10.4.1 signature decisions (pass / fail / error) the spec's reference
 * verifier produces. Signer keys are derived from the golden seeds, so this
 * checks our Ed25519 + canonicalisation against the spec oracle, not a fixture
 * we authored.
 */

const VENDOR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/DACS-Standard",
);
const GOLDEN = join(VENDOR, "conformance/vectors/golden.json");
const haveVectors = existsSync(GOLDEN);

const load = (rel: string) => JSON.parse(readFileSync(join(VENDOR, rel), "utf8"));

/** §10.4.1 signed scope: canonical form omitting signatures + anchoredByRole. */
function bundleHash(fixture: Record<string, unknown>): string {
  const scope = { ...stripSignature(fixture) };
  delete (scope as Record<string, unknown>)["anchoredByRole"];
  return contentHash(scope);
}

const verify = (b: Uint8Array, s: Uint8Array, p: Uint8Array) =>
  ed25519Verify(b, s, publicKeyFromRaw(p));

/** Map signature verdicts to the §10.4.1 composite decision the golden asserts. */
function decisionOf(verdicts: Array<{ verdict: string }>): string {
  if (verdicts.some((v) => v.verdict === "error")) return "error";
  if (verdicts.some((v) => v.verdict === "invalid")) return "fail";
  if (verdicts.length > 0 && verdicts.every((v) => v.verdict === "valid"))
    return "pass";
  return "unverified";
}

describe.skipIf(!haveVectors)("§14 conformance — bundle (§10.4)", () => {
  const golden = load("conformance/vectors/golden.json").bundle as {
    fixture: string;
    bundleHash: string;
    decisions: Record<string, string>;
    seeds: Record<string, string>;
    divergentSellerFixture: string;
    divergentSeller: { bundleHash: string; decision: string; outcome: string };
    htlc9Fixture: string;
    htlc9: { bundleHash: string; decision: string };
  };

  // Signer keys derived from the golden seeds, keyed by party DID.
  const keyByDid: Record<string, Uint8Array> = {};
  for (const [who, seedHex] of Object.entries(golden.seeds)) {
    keyByDid[`did:demos:${who}`] = rawPublicKey(
      publicKeyFromSeed(Uint8Array.from(Buffer.from(seedHex, "hex"))),
    );
  }
  const resolveCorrect = async (did: string) => keyByDid[did] ?? null;

  const runFixture = (rel: string, resolve = resolveCorrect) => {
    const fixture = load(rel);
    return verifyBundleCore("ref", {
      readArtifact: async () => fixture,
      resolvePublicKey: resolve,
      verify,
    });
  };

  it("bundle-0004: byte-stable signed-scope hash matches the golden", () => {
    expect(bundleHash(load(golden.fixture))).toBe(golden.bundleHash);
  });

  it("bundle-0004-pass: all required signatures verify → pass", async () => {
    const res = await runFixture(golden.fixture);
    expect(decisionOf(res.signatures)).toBe(golden.decisions.pass);
  });

  it("bundle-required-signer-fail: a wrong key for a required signer → fail", async () => {
    // Resolve the seller to the buyer's key — its signature won't verify.
    const wrong = async (did: string) =>
      did === "did:demos:seller"
        ? keyByDid["did:demos:buyer"]!
        : (keyByDid[did] ?? null);
    const res = await runFixture(golden.fixture, wrong);
    expect(decisionOf(res.signatures)).toBe(golden.decisions.requiredSignerReject);
  });

  it("bundle-malformed-key-error: a malformed signer key → error", async () => {
    const malformed = async (did: string) =>
      did === "did:demos:seller" ? new Uint8Array(16) : (keyByDid[did] ?? null);
    const res = await runFixture(golden.fixture, malformed);
    expect(decisionOf(res.signatures)).toBe(golden.decisions.malformedKey);
  });

  it("divergent-seller fixture: golden hash + pass decision", async () => {
    expect(bundleHash(load(golden.divergentSellerFixture))).toBe(
      golden.divergentSeller.bundleHash,
    );
    const res = await runFixture(golden.divergentSellerFixture);
    expect(decisionOf(res.signatures)).toBe(golden.divergentSeller.decision);
    expect(res.bundle?.outcome).toBe(golden.divergentSeller.outcome);
  });

  it("htlc9 fixture: golden hash + pass decision", async () => {
    expect(bundleHash(load(golden.htlc9Fixture))).toBe(golden.htlc9.bundleHash);
    const res = await runFixture(golden.htlc9Fixture);
    expect(decisionOf(res.signatures)).toBe(golden.htlc9.decision);
  });
});
