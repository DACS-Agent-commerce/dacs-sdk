import { describe, expect, test } from "vitest";

import { buildSignedArtifact, type Signer } from "../../src/agent/signedArtifact.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";
import {
  resolveRail,
  resolveRecipe,
  settleFromRail,
  type RecipeDescriptor,
  type RegistryResolveDeps,
} from "../../src/registry/index.js";

const STEWARD_SEED = Uint8Array.from(Buffer.alloc(32, 42));
const IMPOSTOR_SEED = Uint8Array.from(Buffer.alloc(32, 99));
const HARDHAT_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function signerFor(seed: Uint8Array): Signer {
  const priv = privateKeyFromSeed(seed);
  return (bytes) => ed25519Sign(bytes, priv);
}
const stewardPublicKey = rawPublicKey(publicKeyFromSeed(STEWARD_SEED));
const verify = (b: Uint8Array, s: Uint8Array, p: Uint8Array) =>
  ed25519Verify(b, s, publicKeyFromRaw(p));

async function railRegistry() {
  const sign = signerFor(STEWARD_SEED);
  const imposter = signerFor(IMPOSTOR_SEED);
  const x402 = await buildSignedArtifact(
    { id: "x402:default", kind: "x402", availability: "live", params: { network: "eip155:84532" } },
    "dacs-rail:v1:",
    sign,
  );
  const deprecated = await buildSignedArtifact(
    { id: "x402:old", kind: "x402", availability: "deprecated", params: {} },
    "dacs-rail:v1:",
    sign,
  );
  // Signed by an impostor, not the steward — must be rejected.
  const forged = await buildSignedArtifact(
    { id: "evm-erc20:usdc", kind: "evm-erc20", availability: "live", params: {} },
    "dacs-rail:v1:",
    imposter,
  );
  return {
    registryId: "dacs4:registry:v0.1",
    version: "0.1",
    entries: [x402, deprecated, forged],
  } as Record<string, unknown>;
}

function depsFor(doc: Record<string, unknown> | null): RegistryResolveDeps {
  return {
    readRegistry: async () => doc,
    stewardPublicKey,
    verify,
  };
}

describe("registry resolution (T12/T13)", () => {
  test("the public recipe type requires PSP-5 completeness for negative matches", () => {
    const acceptsRecipe = (_recipe: RecipeDescriptor) => true;
    expect(
      acceptsRecipe({
        id: "safe-negative",
        method: "consensus-backed-proxy",
        availability: "live",
        params: {},
        negativeMatch: true,
        parserRules: {
          format: "raw",
          matcher: "BLOCKED",
          completeness: { kind: "sentinel", expression: "END-OF-LIST" },
        },
      }),
    ).toBe(true);
    // @ts-expect-error PSP-5 completeness is required by the negative-match arm.
    acceptsRecipe({
      id: "unsafe-negative",
      method: "consensus-backed-proxy",
      availability: "live",
      params: {},
      negativeMatch: true,
      parserRules: { format: "raw", matcher: "BLOCKED" },
    });
  });

  test("resolves a live, steward-signed rail by id", async () => {
    const desc = await resolveRail("anchor", "x402:default", depsFor(await railRegistry()));
    expect(desc).toMatchObject({ id: "x402:default", kind: "x402", availability: "live" });
    expect(desc.params).toEqual({ network: "eip155:84532" });
  });

  test("rejects a deprecated (not live) entry", async () => {
    await expect(
      resolveRail("anchor", "x402:old", depsFor(await railRegistry())),
    ).rejects.toThrow(/not live/);
  });

  test("rejects an entry not signed by the steward (recipe-poisoning)", async () => {
    await expect(
      resolveRail("anchor", "evm-erc20:usdc", depsFor(await railRegistry())),
    ).rejects.toThrow(/steward key/);
  });

  test("rejects an unknown id", async () => {
    await expect(
      resolveRail("anchor", "nope", depsFor(await railRegistry())),
    ).rejects.toThrow(/not found in registry/);
  });

  test("rejects a missing registry", async () => {
    await expect(resolveRail("anchor", "x402:default", depsFor(null))).rejects.toThrow(
      /registry not found/,
    );
  });

  test("tampered entry params fail steward verification", async () => {
    const doc = await railRegistry();
    const entries = doc["entries"] as Array<Record<string, unknown>>;
    entries[0]!.params = { network: "eip155:1" }; // mutate after signing
    await expect(resolveRail("anchor", "x402:default", depsFor(doc))).rejects.toThrow(
      /steward key/,
    );
  });

  test("resolveRecipe verifies under the recipe separator", async () => {
    const recipe = await buildSignedArtifact(
      { id: "self-signed", method: "self-signed", availability: "live", params: {} },
      "dacs-recipe:v1:",
      signerFor(STEWARD_SEED),
    );
    const doc = {
      registryId: "dacs2:registry:v0.1",
      version: "0.1",
      entries: [recipe],
    } as Record<string, unknown>;
    const desc = await resolveRecipe("anchor", "self-signed", depsFor(doc));
    expect(desc).toMatchObject({ id: "self-signed", method: "self-signed" });
  });

  test("resolveRecipe rejects a signed negative-match recipe with no PSP-5 basis", async () => {
    const recipe = await buildSignedArtifact(
      {
        id: "unsafe-negative",
        method: "consensus-backed-proxy",
        availability: "live",
        params: { authorityUrl: "https://example.com/full-list" },
        negativeMatch: true,
        parserRules: { format: "json", successJsonPath: "$.listed" },
      },
      "dacs-recipe:v1:",
      signerFor(STEWARD_SEED),
    );
    const doc = { entries: [recipe] } as Record<string, unknown>;
    await expect(
      resolveRecipe("anchor", "unsafe-negative", depsFor(doc)),
    ).rejects.toThrow(/invalid descriptor shape/);
  });

  test("resolveRecipe accepts a negative-match recipe with a signed completeness check", async () => {
    const recipe = await buildSignedArtifact(
      {
        id: "safe-negative",
        method: "consensus-backed-proxy",
        availability: "live",
        params: { authorityUrl: "https://example.com/full-list" },
        negativeMatch: true,
        parserRules: {
          format: "json",
          successJsonPath: "$.listed",
          completeness: {
            kind: "record-count",
            declaredCountExpression: "$.count",
            recordsExpression: "$.records[*]",
          },
        },
      },
      "dacs-recipe:v1:",
      signerFor(STEWARD_SEED),
    );
    const doc = { entries: [recipe] } as Record<string, unknown>;
    await expect(
      resolveRecipe("anchor", "safe-negative", depsFor(doc)),
    ).resolves.toMatchObject({ id: "safe-negative", negativeMatch: true });
  });

  test("resolveRecipe rejects the retired requiresListCompleteness Boolean", async () => {
    const recipe = await buildSignedArtifact(
      {
        id: "legacy-negative",
        method: "consensus-backed-proxy",
        availability: "live",
        params: { authorityUrl: "https://example.com/full-list" },
        negativeMatch: true,
        requiresListCompleteness: true,
        parserRules: {
          format: "raw",
          matcher: "BLOCKED",
          completeness: { kind: "sentinel", expression: "END-OF-LIST" },
        },
      },
      "dacs-recipe:v1:",
      signerFor(STEWARD_SEED),
    );
    const doc = { entries: [recipe] } as Record<string, unknown>;
    await expect(
      resolveRecipe("anchor", "legacy-negative", depsFor(doc)),
    ).rejects.toThrow(/invalid descriptor shape/);
  });
});

describe("rail dispatch by kind (T6)", () => {
  const paywall = {
    url: "https://seller.example/deliver",
    network: "eip155:84532",
    recipientEvm: "0x1111111111111111111111111111111111111111",
  };

  test("x402 descriptor dispatches to a settle executor", async () => {
    const settle = await settleFromRail(
      {
        id: "x402:default",
        kind: "x402",
        availability: "live",
        params: { tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
      },
      { evmPrivateKey: HARDHAT_KEY, paywall },
    );
    expect(typeof settle).toBe("function");
  });

  test("x402 without a token address in the descriptor is rejected", async () => {
    await expect(
      settleFromRail(
        { id: "x402:default", kind: "x402", availability: "live", params: {} },
        { evmPrivateKey: HARDHAT_KEY, paywall },
      ),
    ).rejects.toThrow(/tokenAddress/);
  });

  test("evm-erc20 dispatches when token + rpc are supplied", async () => {
    const settle = await settleFromRail(
      {
        id: "evm-erc20:usdc",
        kind: "evm-erc20",
        availability: "live",
        params: { tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
      },
      { evmPrivateKey: HARDHAT_KEY, paywall, rpcUrl: "https://sepolia.base.org" },
    );
    expect(typeof settle).toBe("function");
  });

  test("evm-erc20 without a token address in the descriptor is rejected", async () => {
    await expect(
      settleFromRail(
        { id: "evm-erc20:usdc", kind: "evm-erc20", availability: "live", params: {} },
        { evmPrivateKey: HARDHAT_KEY, paywall, rpcUrl: "https://sepolia.base.org" },
      ),
    ).rejects.toThrow(/tokenAddress/);
  });

  test("evm-erc20 without an rpc url is rejected", async () => {
    await expect(
      settleFromRail(
        {
          id: "evm-erc20:usdc",
          kind: "evm-erc20",
          availability: "live",
          params: { tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
        },
        { evmPrivateKey: HARDHAT_KEY, paywall },
      ),
    ).rejects.toThrow(/rpcUrl/);
  });

  test("unknown kind is rejected", async () => {
    await expect(
      settleFromRail(
        { id: "x", kind: "bogus", availability: "live", params: {} },
        { evmPrivateKey: HARDHAT_KEY, paywall },
      ),
    ).rejects.toThrow(/unknown rail kind/);
  });
});
