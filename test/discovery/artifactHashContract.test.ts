import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { canonicalize, contentHash, sha256Hex } from "../../src/canonical/index.js";
import { createBoundArtifactRepository, createInMemoryBindingStore } from "../../src/discovery/index.js";
import { isAgreementArtifact, isIdentityBundle } from "../../src/artifacts/index.js";
import { identityBundleHash } from "../../src/identity/bundle.js";
import { publicKeyFromSeed, rawPublicKey, signArtifact, verifyArtifact } from "../../src/crypto/index.js";

describe("explicit repository hash contracts", () => {
  test.each(["agreement", "identity"] as const)("keeps an overlapping envelope on its selected %s contract", async (kind) => {
    const corpus = JSON.parse(readFileSync(new URL(
      "../../vendor/DACS-Standard/conformance/vectors/security/identity-bundle-hash-binding-v0.1.json", import.meta.url,
    ), "utf8"));
    const scenario = corpus.scenarios.agreement;
    const artifact = { ...scenario.agreement, ...scenario.listing.seller.identity };
    const seeds = [new Uint8Array(32).fill(7), new Uint8Array(32).fill(8)];
    const keys = seeds.map((seed) => rawPublicKey(publicKeyFromSeed(seed)));
    const claims = keys.map((key) => `key:${Buffer.from(key).toString("hex")}`);
    artifact.parties.forEach((party: { primaryClaim: string }, index: number) => { party.primaryClaim = claims[index]!; });
    artifact.signatures = seeds.map((seed, index) => ({
      party: claims[index], algorithm: "ed25519",
      value: Buffer.from(signArtifact("dacs-agreement:v1:", artifact, seed)).toString("base64url"),
    }));
    expect(isAgreementArtifact(artifact)).toBe(true);
    expect(isIdentityBundle(artifact)).toBe(true);
    const hashOf = kind === "agreement"
      ? (record: Record<string, unknown>) => contentHash(record, "signatures")
      : (record: Record<string, unknown>) => identityBundleHash(record as unknown as Parameters<typeof identityBundleHash>[0]);
    const omitted = kind === "agreement" ? "signatures" : "presentation";
    const expected = sha256Hex(canonicalize(Object.fromEntries(Object.entries(artifact).filter(([key]) => key !== omitted))));
    let stored: Record<string, unknown> = artifact;
    const logicalAddress = `dacs3:${artifact.jobId}:agreement`;
    const bindings = createInMemoryBindingStore([{
      logicalAddress, nativeAddress: "native", owner: "owner", contentHash: expected,
    }]);
    const repository = createBoundArtifactRepository({
      contentHashOf: hashOf,
      adapter: { getAddress: () => "owner", anchorWriteOnce: async (_name, value) => {
        stored = value as Record<string, unknown>;
        return { address: "native", txRef: "tx" };
      }, readAnchor: async () => stored },
      index: bindings, publisher: bindings,
    });
    const verify = (record: Record<string, unknown>) => kind === "identity" ||
      verifyArtifact("dacs-agreement:v1:", record,
        Buffer.from((record.signatures as Array<{ value: string }>)[0]!.value, "base64url"), keys[0]!);
    expect((await repository.read(logicalAddress, "owner", verify)).status).toBe("verified");
    expect((await repository.write(logicalAddress, artifact)).binding.contentHash).toBe(expected);
    expect((await repository.read(logicalAddress, "owner", verify)).status).toBe("verified");
    if (kind === "agreement") {
      stored = structuredClone(artifact);
      (stored.signatures as Array<{ value: string }>)[0]!.value = "AA";
      expect((await repository.read(logicalAddress, "owner", verify)).status).toBe("signature-invalid");
    }
    stored = structuredClone(artifact);
    if (kind === "agreement") stored.presentation = { changed: true };
    else stored.signatures = [];
    expect((await repository.read(logicalAddress, "owner", verify)).status).toBe("hash-mismatch");
  });
});
