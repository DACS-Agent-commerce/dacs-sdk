import { describe, expect, test, vi } from "vitest";

import { buildSignedArtifact, type Signer } from "../../src/agent/signedArtifact.js";
import { signComponentArtifact } from "../../src/artifacts/signatures.js";
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
const stewardSigner = `did:demos:steward:${Buffer.from(stewardPublicKey).toString("hex")}`;
const verify = (b: Uint8Array, s: Uint8Array, p: Uint8Array) =>
  ed25519Verify(b, s, publicKeyFromRaw(p));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function railRegistry() {
  const sign = signerFor(STEWARD_SEED);
  const imposter = signerFor(IMPOSTOR_SEED);
  const x402 = await signComponentArtifact(
    { id: "x402:default", kind: "x402", availability: "live", params: { network: "eip155:84532" } },
    "dacs-rail:v1:",
    { algorithm: "ed25519", signer: stewardSigner, sign },
  );
  const deprecated = await signComponentArtifact(
    { id: "x402:old", kind: "x402", availability: "disabled", params: {} },
    "dacs-rail:v1:",
    { algorithm: "ed25519", signer: stewardSigner, sign },
  );
  // Signed by an impostor, not the steward — must be rejected.
  const forged = await signComponentArtifact(
    { id: "evm-erc20:usdc", kind: "evm-erc20", availability: "live", params: {} },
    "dacs-rail:v1:",
    { algorithm: "ed25519", signer: stewardSigner, sign: imposter },
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
    stewardSigner,
    verify,
  };
}

function normativeRecipe(
  over: Partial<RecipeDescriptor> = {},
): RecipeDescriptor {
  return {
    recipeVersion: 1,
    scheme: "key",
    defaultMethod: { kind: "self-signed" },
    defaultMaxAgeSec: 3_600,
    parserRules: { format: "raw", matcher: "present" },
    retryClass: "permanent",
    availability: "live",
    governance: {
      proposedBy: stewardSigner,
      acceptedAt: 1_780_000_000_000,
      anchoring: "single-signer",
    },
    ...over,
  };
}

async function signedRecipe(
  descriptor: object,
  seed = STEWARD_SEED,
) {
  return signComponentArtifact(descriptor, "dacs-recipe:v1:", {
    algorithm: "ed25519",
    signer: stewardSigner,
    sign: signerFor(seed),
  });
}

async function expectRecipeEntryRejected(
  entry: object,
  method: Parameters<typeof resolveRecipe>[1]["method"] = "self-signed",
) {
  const doc = {
    registryId: "dacs2:registry:v0.1",
    version: "0.1",
    entries: [entry],
  } as Record<string, unknown>;
  await expect(
    resolveRecipe(
      "anchor",
      { scheme: "key", method, recipeVersion: 1 },
      depsFor(doc),
    ),
  ).rejects.toThrow();
}

describe("registry resolution (T12/T13)", () => {
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

  test("resolveRecipe verifies and pins the exact normative family", async () => {
    const recipe = await signedRecipe(normativeRecipe());
    const doc = {
      registryId: "dacs2:registry:v0.1",
      version: "0.1",
      entries: [recipe],
    } as Record<string, unknown>;
    const desc = await resolveRecipe(
      "anchor",
      { scheme: "key", method: "self-signed", recipeVersion: 1 },
      depsFor(doc),
    );
    expect(desc).toMatchObject({
      scheme: "key",
      recipeVersion: 1,
      defaultMethod: { kind: "self-signed" },
      availability: "live",
    });
    expect(Object.isFrozen(desc)).toBe(true);
  });

  test("resolveRecipe requires the session-start version pin", async () => {
    const v1 = await signedRecipe(normativeRecipe());
    const v2 = await signedRecipe(normativeRecipe({
      recipeVersion: 2,
      governance: {
        proposedBy: stewardSigner,
        acceptedAt: 1_780_000_001_000,
        anchoring: "single-signer",
        supersedes: 1,
      },
    }));
    const doc = {
      registryId: "dacs2:registry:v0.1",
      version: "0.1",
      entries: [v1, v2],
    } as Record<string, unknown>;

    await expect(
      resolveRecipe(
        "anchor",
        { scheme: "key", method: "self-signed" } as never,
        depsFor(doc),
      ),
    ).rejects.toThrow(/exact canonical scheme, method and version/);
    const pinned = await resolveRecipe(
      "anchor",
      { scheme: "key", method: "self-signed", recipeVersion: 1 },
      depsFor(doc),
    );
    expect(pinned.recipeVersion).toBe(1);
  });

  test("resolveRecipe accepts every exact VerificationMethod variant", async () => {
    const methods: RecipeDescriptor["defaultMethod"][] = [
      {
        kind: "verifiable-credential",
        issuerAllowList: ["did:demos:issuer"],
        schemaUrl: "https://schemas.example/credential",
      },
      {
        kind: "tlsnotary",
        endpoint: "https://authority.example/status",
        sessionTemplate: "authority-v1",
      },
      { kind: "zktls", provider: "reclaim", programId: "program-1" },
      {
        kind: "consensus-backed-proxy",
        endpoint: {
          method: "POST",
          urlTemplate: "https://authority.example/{identifier}",
          headers: { accept: "application/json" },
          body: "{\"id\":\"{identifier}\"}",
        },
      },
      {
        kind: "oauth-attested",
        provider: "stripe",
        scopes: ["read_profile"],
        maxTokenAgeSec: 300,
      },
      {
        kind: "evm-rpc",
        chainId: 1,
        contract: "0x1111111111111111111111111111111111111111",
        method: "ownerOf",
        args: [1, { blockTag: "latest", proof: [true, null] }],
      },
      { kind: "domain-tls-control", challengeType: "dns-01" },
      { kind: "self-signed" },
      { kind: "demos-gcr-domain" },
    ];

    for (const defaultMethod of methods) {
      const recipe = await signedRecipe(normativeRecipe({ defaultMethod }));
      const resolved = await resolveRecipe(
        "anchor",
        {
          scheme: "key",
          method: defaultMethod.kind,
          recipeVersion: 1,
        },
        depsFor({ entries: [recipe] }),
      );
      expect(resolved.defaultMethod).toEqual(defaultMethod);
    }
  });

  test("resolveRecipe accepts exact ParserSpec variants and non-live recipes for RAV audit", async () => {
    const parserRules: RecipeDescriptor["parserRules"][] = [
      {
        format: "json",
        successJsonPath: "$.data[0]",
        indeterminateOn: [{ jsonPath: "$.pending" }],
        dataMap: { name: "$.data[0].name" },
      },
      {
        format: "html",
        successSelector: ".active",
        indeterminateOn: [{ selector: ".pending" }],
        dataMap: { name: "h1" },
      },
      {
        format: "xml",
        successXPath: "/record/active",
        indeterminateOn: [{ xPath: "/record/pending" }],
        dataMap: { name: "/record/name" },
      },
      {
        format: "raw",
        matcher: "active",
        indeterminateOn: [{ matcher: "pending" }],
      },
    ];

    for (const parser of parserRules) {
      const recipe = await signedRecipe(
        normativeRecipe({ parserRules: parser, availability: "mocked" }),
      );
      const resolved = await resolveRecipe(
        "anchor",
        { scheme: "key", method: "self-signed", recipeVersion: 1 },
        depsFor({ entries: [recipe] }),
      );
      expect(resolved.parserRules).toEqual(parser);
      expect(resolved.availability).toBe("mocked");
    }
  });

  test("resolveRecipe rejects the auditor's combined validly-signed malformed recipe", async () => {
    const recipe = await signedRecipe({
      ...normativeRecipe(),
      defaultMethod: { kind: "self-signed", unexpected: "signed-extra" },
      parserRules: {
        format: "raw",
        matcher: "present",
        dataMap: { illegal: "$.x" },
        indeterminateOn: [null],
      },
      governance: {
        proposedBy: stewardSigner,
        acceptedAt: 1_780_000_000_000,
        anchoring: "single-signer",
        emergency: "malformed",
      },
    });

    await expectRecipeEntryRejected(recipe);
  });

  test("resolveRecipe rejects signed extras on every VerificationMethod variant", async () => {
    const methods: Array<
      [Parameters<typeof resolveRecipe>[1]["method"], Record<string, unknown>]
    > = [
      ["verifiable-credential", { kind: "verifiable-credential", unexpected: true }],
      ["tlsnotary", { kind: "tlsnotary", endpoint: "https://example", unexpected: true }],
      ["zktls", { kind: "zktls", provider: "reclaim", programId: "p", unexpected: true }],
      [
        "consensus-backed-proxy",
        {
          kind: "consensus-backed-proxy",
          endpoint: { method: "GET", urlTemplate: "https://example" },
          unexpected: true,
        },
      ],
      [
        "oauth-attested",
        {
          kind: "oauth-attested",
          provider: "p",
          scopes: [],
          maxTokenAgeSec: 1,
          unexpected: true,
        },
      ],
      [
        "evm-rpc",
        {
          kind: "evm-rpc",
          chainId: 1,
          contract: "0x1",
          method: "ownerOf",
          unexpected: true,
        },
      ],
      [
        "domain-tls-control",
        {
          kind: "domain-tls-control",
          challengeType: "http-01",
          unexpected: true,
        },
      ],
      ["self-signed", { kind: "self-signed", unexpected: true }],
      ["demos-gcr-domain", { kind: "demos-gcr-domain", unexpected: true }],
    ];

    for (const [method, defaultMethod] of methods) {
      const recipe = await signedRecipe({
        ...normativeRecipe(),
        defaultMethod,
      });
      await expectRecipeEntryRejected(recipe, method);
    }
  });

  test("resolveRecipe rejects wrong signed field types on every configured method", async () => {
    const methods: Array<
      [Parameters<typeof resolveRecipe>[1]["method"], Record<string, unknown>]
    > = [
      [
        "verifiable-credential",
        { kind: "verifiable-credential", issuerAllowList: [42] },
      ],
      ["tlsnotary", { kind: "tlsnotary", endpoint: 42 }],
      ["zktls", { kind: "zktls", provider: "reclaim", programId: 42 }],
      [
        "consensus-backed-proxy",
        {
          kind: "consensus-backed-proxy",
          endpoint: { method: "PUT", urlTemplate: "https://example" },
        },
      ],
      [
        "oauth-attested",
        {
          kind: "oauth-attested",
          provider: "p",
          scopes: [42],
          maxTokenAgeSec: 1,
        },
      ],
      [
        "evm-rpc",
        {
          kind: "evm-rpc",
          chainId: 1,
          contract: 42,
          method: "ownerOf",
        },
      ],
      [
        "domain-tls-control",
        { kind: "domain-tls-control", challengeType: "email-01" },
      ],
    ];

    for (const [method, defaultMethod] of methods) {
      const recipe = await signedRecipe({
        ...normativeRecipe(),
        defaultMethod,
      });
      await expectRecipeEntryRejected(recipe, method);
    }
  });

  test("resolveRecipe rejects malformed signed parser, retry and governance fields", async () => {
    const malformed: object[] = [
      { ...normativeRecipe(), unexpected: "signed-extra" },
      { ...normativeRecipe(), parserRules: { format: "raw", matcher: "ok", dataMap: {} } },
      {
        ...normativeRecipe(),
        parserRules: {
          format: "json",
          successJsonPath: "$.ok",
          indeterminateOn: [{ selector: ".wrong-kind" }],
        },
      },
      {
        ...normativeRecipe(),
        parserRules: {
          format: "html",
          successSelector: ".ok",
          indeterminateOn: [{ selector: ".pending", extra: true }],
        },
      },
      {
        ...normativeRecipe(),
        backoff: { strategy: "fixed", baseMs: 1, extra: true },
      },
      {
        ...normativeRecipe(),
        defaultMethod: {
          kind: "consensus-backed-proxy",
          endpoint: {
            method: "GET",
            urlTemplate: "https://example",
            extra: true,
          },
        },
      },
      { ...normativeRecipe(), retryBudget: -1 },
      { ...normativeRecipe(), scheme: "Key" },
      {
        ...normativeRecipe(),
        governance: {
          proposedBy: "not-a-claim-reference",
          acceptedAt: 1_780_000_000_000,
          anchoring: "single-signer",
        },
      },
      {
        ...normativeRecipe(),
        governance: {
          proposedBy: stewardSigner,
          acceptedAt: 1_780_000_000_000,
          anchoring: "single-signer",
          emergency: { isEmergency: false, failureObservation: "https://example" },
        },
      },
      {
        ...normativeRecipe(),
        governance: {
          proposedBy: stewardSigner,
          acceptedAt: 1_780_000_000_000,
          anchoring: "single-signer",
          extra: true,
        },
      },
      {
        ...normativeRecipe(),
        governance: {
          proposedBy: stewardSigner,
          acceptedAt: 1_780_000_000_000,
          anchoring: "single-signer",
          deprecated: true,
        },
      },
      {
        ...normativeRecipe(),
        governance: {
          proposedBy: stewardSigner,
          acceptedAt: 1_780_000_000_000,
          anchoring: "single-signer",
          deprecated: true,
          deprecationReason: "",
        },
      },
      {
        ...normativeRecipe(),
        governance: {
          proposedBy: stewardSigner,
          acceptedAt: 1_780_000_000_000,
          anchoring: "single-signer",
          supersedes: 1,
        },
      },
      {
        ...normativeRecipe(),
        alternatives: [{ kind: "self-signed" }],
      },
    ];

    for (const descriptor of malformed) {
      await expectRecipeEntryRejected(await signedRecipe(descriptor));
    }
  });

  test("resolveRecipe rejects wire-shape smuggling before snapshot normalisation", async () => {
    const mutations: Array<(entry: Record<string | symbol, unknown>) => void> = [
      (entry) => Object.setPrototypeOf(entry, { inherited: "poison" }),
      (entry) =>
        Object.defineProperty(entry, "scheme", {
          configurable: true,
          enumerable: true,
          get: () => "key",
        }),
      (entry) => {
        entry[Symbol("hidden")] = "poison";
      },
      (entry) =>
        Object.defineProperty(entry, "hidden", {
          configurable: true,
          enumerable: false,
          value: "poison",
        }),
      (entry) => {
        entry.alternatives = undefined;
      },
      (entry) => {
        entry.alternatives = new Array(1);
      },
      (entry) => {
        const method = entry.defaultMethod as Record<string, unknown>;
        Object.setPrototypeOf(method, { inherited: "poison" });
      },
      (entry) => {
        const signature = entry.signature as Record<string, unknown>;
        signature.unexpected = "signed-extra";
      },
    ];

    for (const mutate of mutations) {
      const recipe = (await signedRecipe(normativeRecipe())) as Record<
        string | symbol,
        unknown
      >;
      mutate(recipe);
      await expectRecipeEntryRejected(recipe);
    }
  });

  test("resolveRecipe rejects a hostile selector without invoking accessors", async () => {
    const recipe = await signedRecipe(normativeRecipe());
    const doc = {
      registryId: "dacs2:registry:v0.1",
      version: "0.1",
      entries: [recipe],
    } as Record<string, unknown>;
    let methodReads = 0;
    const selector: Record<string, unknown> = {
      scheme: "key",
      recipeVersion: 1,
    };
    Object.defineProperty(selector, "method", {
      enumerable: true,
      get: () => {
        methodReads += 1;
        return "self-signed";
      },
    });

    await expect(
      resolveRecipe(
        "anchor",
        selector as never,
        depsFor(doc),
      ),
    ).rejects.toThrow(/selector must be an exact canonical/);
    expect(methodReads).toBe(0);
    await expect(
      resolveRecipe(
        "anchor",
        {
          scheme: "key",
          method: "self-signed",
          recipeVersion: 1,
          trusted: true,
        } as never,
        depsFor(doc),
      ),
    ).rejects.toThrow(/selector must be an exact canonical/);
  });

  test("resolveRecipe rejects a selector pinned to another version", async () => {
    const recipe = await signedRecipe(normativeRecipe());
    const doc = {
      registryId: "dacs2:registry:v0.1",
      version: "0.1",
      entries: [recipe],
    } as Record<string, unknown>;

    await expect(
      resolveRecipe(
        "anchor",
        { scheme: "key", method: "self-signed", recipeVersion: 2 },
        depsFor(doc),
      ),
    ).rejects.toThrow(/resolved 0 exact entries; unambiguous family required/);
  });

  test("resolveRecipe rejects an entry not authenticated by the steward", async () => {
    const forged = await signedRecipe(normativeRecipe(), IMPOSTOR_SEED);
    const doc = {
      registryId: "dacs2:registry:v0.1",
      version: "0.1",
      entries: [forged],
    } as Record<string, unknown>;

    await expect(
      resolveRecipe(
        "anchor",
        { scheme: "key", method: "self-signed", recipeVersion: 1 },
        depsFor(doc),
      ),
    ).rejects.toThrow(/signature is not valid under the steward key/);
  });

  test("legacy registry signatures require an explicit policy and are normalised", async () => {
    const legacy = await buildSignedArtifact(
      { id: "legacy", kind: "x402", availability: "live", params: {} },
      "dacs-rail:v1:",
      signerFor(STEWARD_SEED),
    );
    const doc = { entries: [legacy] } as Record<string, unknown>;

    await expect(resolveRail("anchor", "legacy", depsFor(doc))).rejects.toThrow(
      /legacy signature is rejected/,
    );
    const resolved = await resolveRail("anchor", "legacy", {
      ...depsFor(doc),
      legacySignatures: "verify-with-pinned-key",
    });
    expect(resolved.signature).toMatchObject({
      algorithm: "ed25519",
      signer: stewardSigner,
    });
    expect(resolved.signature.value).not.toMatch(/=/);
  });

  test("authenticates and returns one owned registry snapshot across async verification", async () => {
    const doc = await railRegistry();
    const entries = doc["entries"] as Array<Record<string, unknown>>;
    const sourceEntry = entries[0]!;
    const sourceParams = sourceEntry["params"] as Record<string, unknown>;
    const resolutionDeps = depsFor(doc);
    resolutionDeps.verify = async (bytes, signature, key) => {
      sourceParams["network"] = "caller-mutated";
      return verify(bytes, signature, key);
    };

    const resolved = await resolveRail(
      "anchor",
      "x402:default",
      resolutionDeps,
    );
    expect(resolved.params).toEqual({ network: "eip155:84532" });
    expect(resolved).not.toBe(sourceEntry);
    expect(resolved.params).not.toBe(sourceParams);

    resolved.params["network"] = "consumer-mutated";
    expect(sourceParams["network"]).toBe("caller-mutated");
  });

  test("pins trust-root dependencies and key bytes before a delayed registry read", async () => {
    const doc = await railRegistry();
    const gate = deferred();
    const resolutionDeps: RegistryResolveDeps = {
      ...depsFor(doc),
      stewardPublicKey: Uint8Array.from(stewardPublicKey),
      readRegistry: async () => {
        await gate.promise;
        return doc;
      },
    };
    const pending = resolveRail("anchor", "x402:default", resolutionDeps);

    resolutionDeps.stewardPublicKey.fill(0);
    resolutionDeps.stewardSigner = "did:demos:attacker";
    resolutionDeps.verify = () => false;
    resolutionDeps.legacySignatures = "reject";
    gate.resolve();

    await expect(pending).resolves.toMatchObject({ id: "x402:default" });
  });

  test("normalises the configured steward signer under CF-1", async () => {
    const nfdSigner = "did:demos:steward:cafe\u0301";
    const nfcSigner = "did:demos:steward:caf\u00e9";
    const entry = await signComponentArtifact(
      {
        id: "x402:nfc-steward",
        kind: "x402",
        availability: "live",
        params: {},
      },
      "dacs-rail:v1:",
      {
        algorithm: "ed25519",
        signer: nfcSigner,
        sign: signerFor(STEWARD_SEED),
      },
    );
    const doc = { entries: [entry] } as Record<string, unknown>;

    await expect(
      resolveRail("anchor", "x402:nfc-steward", {
        ...depsFor(doc),
        stewardSigner: nfdSigner,
      }),
    ).resolves.toMatchObject({ id: "x402:nfc-steward" });
  });

  test("normalises the requested registry entry id under CF-1", async () => {
    const nfdId = "x402:cafe\u0301";
    const nfcId = "x402:caf\u00e9";
    const entry = await signComponentArtifact(
      { id: nfcId, kind: "x402", availability: "live", params: {} },
      "dacs-rail:v1:",
      {
        algorithm: "ed25519",
        signer: stewardSigner,
        sign: signerFor(STEWARD_SEED),
      },
    );
    const doc = { entries: [entry] } as Record<string, unknown>;

    await expect(
      resolveRail("anchor", nfdId, depsFor(doc)),
    ).resolves.toMatchObject({ id: nfcId });
  });

  test("rejects accessor and proxy registry views without invoking their traps", async () => {
    const accessor = vi.fn(() => []);
    const accessorDoc = {} as Record<string, unknown>;
    Object.defineProperty(accessorDoc, "entries", {
      configurable: true,
      enumerable: true,
      get: accessor,
    });
    await expect(
      resolveRail("anchor", "x402:default", depsFor(accessorDoc)),
    ).rejects.toThrow("not stable canonical JSON");
    expect(accessor).not.toHaveBeenCalled();

    const ownKeys = vi.fn(() => ["entries"]);
    const proxyDoc = new Proxy({ entries: [] }, { ownKeys });
    await expect(
      resolveRail("anchor", "x402:default", depsFor(proxyDoc)),
    ).rejects.toThrow("not stable canonical JSON");
    expect(ownKeys).not.toHaveBeenCalled();
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

  test("pay-DEM dispatch does not require EVM credentials or HTTP paywall coordinates", async () => {
    const descriptor = {
      id: "demos-native:DEM",
      kind: "dem" as const,
      availability: "live" as const,
      params: {},
    };
    await expect(settleFromRail(descriptor, {})).rejects.toThrow(/demosRpc/);
    await expect(
      settleFromRail(descriptor, { demosRpc: "https://node.example" }),
    ).rejects.toThrow(/demosSecret/);
  });

  test("rail-neutral payment coordinates work for EVM rails", async () => {
    const settle = await settleFromRail(
      {
        id: "evm-erc20:usdc",
        kind: "evm-erc20",
        availability: "live",
        params: { tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
      },
      {
        evmPrivateKey: HARDHAT_KEY,
        payment: {
          network: paywall.network,
          recipient: paywall.recipientEvm,
        },
        rpcUrl: "https://sepolia.base.org",
      },
    );
    expect(typeof settle).toBe("function");
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
