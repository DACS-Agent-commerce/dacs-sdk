import { describe, expect, test } from "vitest";

import { signComponentArtifact } from "../../src/artifacts/signatures.js";
import type {
  AnchorReceipt,
  ComponentSignature,
} from "../../src/artifacts/types.js";
import { canonicalize, contentHash } from "../../src/canonical/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";
import {
  RECIPE_REGISTRY_INDEX_ADDRESS,
  authenticateRecipeRegistrySnapshot,
  isAuthenticatedRecipeRegistrySnapshot,
  isHistoricalRecipeResolution,
  isLatestRecipeSelection,
  resolveHistoricalRecipeFromSnapshot,
  selectLatestRecipeAtSessionStart,
  type CurrentRecipeRegistryIndex,
  type RecipeDescriptor,
  type RecipeRegistryAuthorityInput,
  type RecipeRegistryAuthorityVerification,
  type RecipeRegistryIndexDocument,
  type RecipeRegistryRecipeRef,
  type RecipeRegistrySelectionProvider,
} from "../../src/registry/index.js";

const STEWARD_SEED = Uint8Array.from(Buffer.alloc(32, 42));
const IMPOSTOR_SEED = Uint8Array.from(Buffer.alloc(32, 99));
// The provider boundary accepts one owned canonical key, not Node's Buffer
// view into a larger exported-key backing allocation.
const stewardPublicKey = Uint8Array.from(
  rawPublicKey(publicKeyFromSeed(STEWARD_SEED)),
);
const stewardSigner =
  `did:demos:recipe-steward:${Buffer.from(stewardPublicKey).toString("hex")}`;
const stewardWriter = stewardSigner;
const verify = (bytes: Uint8Array, signature: Uint8Array, key: Uint8Array) =>
  ed25519Verify(bytes, signature, publicKeyFromRaw(key));

type SignedRecipe = RecipeDescriptor & { signature: ComponentSignature };

function recipe(
  recipeVersion: number,
  patch: Partial<RecipeDescriptor> = {},
): RecipeDescriptor {
  return {
    recipeVersion,
    scheme: "key",
    defaultMethod: { kind: "self-signed" },
    defaultMaxAgeSec: 3_600,
    parserRules: { format: "raw", matcher: "present" },
    retryClass: "permanent",
    availability: "live",
    governance: {
      proposedBy: stewardSigner,
      acceptedAt: 1_780_000_000_000 + recipeVersion,
      anchoring: "single-signer",
      ...(recipeVersion > 1 ? { supersedes: recipeVersion - 1 } : {}),
    },
    ...patch,
  };
}

async function signedRecipe(
  descriptor: RecipeDescriptor,
  seed = STEWARD_SEED,
): Promise<SignedRecipe> {
  return signComponentArtifact(descriptor, "dacs-recipe:v1:", {
    algorithm: "ed25519",
    signer: stewardSigner,
    sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(seed)),
  });
}

function refFor(locator: string, value: Record<string, unknown>): RecipeRegistryRecipeRef {
  return {
    anchor: { kind: "storage-program", locator },
    contentHash: contentHash(value),
  };
}

function receiptFor(
  ref: RecipeRegistryRecipeRef,
  patch: Partial<AnchorReceipt> = {},
): AnchorReceipt {
  return {
    receiptVersion: "1",
    substrate: "test-substrate",
    finalityProfile: "instant-finality",
    logicalAddress: RECIPE_REGISTRY_INDEX_ADDRESS,
    nativeAddress: ref.anchor.locator,
    contentHash: ref.contentHash,
    transactionRef: { kind: "test", value: `tx:${ref.contentHash}` },
    writer: stewardWriter,
    state: "finalized",
    observationDisposition: "established",
    observedAt: 1_780_000_100_000,
    blockRef: { id: "block:1", height: "1", timestamp: 1_780_000_100_000 },
    evidence: { kind: "test-proof", value: `proof:${ref.contentHash}` },
    ...patch,
  };
}

interface RegistryFixture {
  provider: RecipeRegistrySelectionProvider;
  current: CurrentRecipeRegistryIndex;
  index: RecipeRegistryIndexDocument;
  indexRef: RecipeRegistryRecipeRef;
  documents: Map<string, Record<string, unknown>>;
  recipeRefs: RecipeRegistryRecipeRef[];
}

async function registryFixture(
  descriptors: RecipeDescriptor[],
  options: {
    seeds?: Uint8Array[];
    registryVersion?: number;
    authenticate?: (
      input: Readonly<RecipeRegistryAuthorityInput>,
    ) => RecipeRegistryAuthorityVerification | Promise<RecipeRegistryAuthorityVerification>;
  } = {},
): Promise<RegistryFixture> {
  const signed = await Promise.all(
    descriptors.map((descriptor, index) =>
      signedRecipe(
        descriptor,
        Uint8Array.from(options.seeds?.[index] ?? STEWARD_SEED),
      ),
    ),
  );
  const documents = new Map<string, Record<string, unknown>>();
  const recipeRefs = signed.map((entry, index) => {
    const locator = `recipe:${entry.scheme}:${entry.recipeVersion}:${index}`;
    documents.set(locator, entry as unknown as Record<string, unknown>);
    return refFor(locator, entry as unknown as Record<string, unknown>);
  });
  const index: RecipeRegistryIndexDocument = {
    registryId: RECIPE_REGISTRY_INDEX_ADDRESS,
    entries: recipeRefs,
  };
  const registryVersion = options.registryVersion ?? 7;
  const indexRef = refFor(
    `registry:index:${registryVersion}:${contentHash(index as unknown as Record<string, unknown>)}`,
    index as unknown as Record<string, unknown>,
  );
  documents.set(indexRef.anchor.locator, index as unknown as Record<string, unknown>);
  const current: CurrentRecipeRegistryIndex = {
    registryVersion,
    indexRef,
    receipt: receiptFor(indexRef),
  };
  const provider: RecipeRegistrySelectionProvider = {
    resolveCurrentIndex: async () => structuredClone(current),
    authenticateCurrentIndex: options.authenticate ?? (() => "valid"),
    readAnchoredJson: async (ref) => {
      const value = documents.get(ref.anchor.locator);
      return value ? (value as Record<string, unknown>) : null;
    },
    stewardWriter,
    stewardSigner,
    stewardPublicKey,
    verify,
  };
  return { provider, current, index, indexRef, documents, recipeRefs };
}

describe("authenticated latest-at-session recipe selection", () => {
  test("authenticates a complete v1/v2 family and selects the v2 head", async () => {
    const fixture = await registryFixture([
      recipe(1, { alternatives: [{ kind: "tlsnotary", endpoint: "https://v1" }] }),
      recipe(2, { alternatives: [{ kind: "tlsnotary", endpoint: "https://v2" }] }),
    ]);
    const snapshot = await authenticateRecipeRegistrySnapshot(fixture.provider);
    const selected = selectLatestRecipeAtSessionStart(snapshot, {
      scheme: "key",
      method: "tlsnotary",
      required: true,
    });

    expect(isAuthenticatedRecipeRegistrySnapshot(snapshot)).toBe(true);
    expect(isLatestRecipeSelection(selected)).toBe(true);
    expect(selected).toMatchObject({
      selectionKind: "latest-at-session-start",
      family: { scheme: "key", defaultMethod: "self-signed" },
      requestedMethod: "tlsnotary",
      required: true,
      recipe: { recipeVersion: 2 },
      registry: {
        logicalAddress: RECIPE_REGISTRY_INDEX_ADDRESS,
        registryVersion: 7,
        indexContentHash: fixture.indexRef.contentHash,
        writer: stewardWriter,
      },
    });
    expect(selected.recipeRef).toEqual(fixture.recipeRefs[1]);
    expect(selected.recipeContentHash).toBe(fixture.recipeRefs[1]!.contentHash);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected.registry.index)).toBe(true);
    expect(isLatestRecipeSelection(structuredClone(selected))).toBe(false);
  });

  test("rejects signed entries when completeness/currentness is unauthenticated or indeterminate", async () => {
    for (const disposition of ["invalid", "indeterminate"] as const) {
      const fixture = await registryFixture([recipe(1)], {
        authenticate: () => disposition,
      });
      await expect(
        authenticateRecipeRegistrySnapshot(fixture.provider),
      ).rejects.toThrow(
        disposition === "invalid" ? /invalid or unauthenticated/ : /indeterminate/,
      );
    }

    const truthy = await registryFixture([recipe(1)], {
      authenticate: () => true as never,
    });
    await expect(
      authenticateRecipeRegistrySnapshot(truthy.provider),
    ).rejects.toThrow(/invalid or unauthenticated/);
  });

  test("rejects a finalized but stale/omitted index view", async () => {
    const authoritative = await registryFixture([recipe(1), recipe(2)], {
      registryVersion: 2,
    });
    const stale = await registryFixture([recipe(1)], { registryVersion: 1 });
    stale.provider.authenticateCurrentIndex = (input) =>
      input.registryVersion === authoritative.current.registryVersion &&
      input.indexRef.contentHash === authoritative.indexRef.contentHash
        ? "valid"
        : "invalid";

    await expect(
      authenticateRecipeRegistrySnapshot(stale.provider),
    ).rejects.toThrow(/invalid or unauthenticated/);
  });

  test("selects the family head before checking its method and never falls back to v1", async () => {
    const fixture = await registryFixture([
      recipe(1, { alternatives: [{ kind: "tlsnotary", endpoint: "https://v1" }] }),
      recipe(2),
    ]);
    const snapshot = await authenticateRecipeRegistrySnapshot(fixture.provider);

    expect(
      () =>
        selectLatestRecipeAtSessionStart(snapshot, {
          scheme: "key",
          method: "tlsnotary",
          required: true,
        }),
    ).toThrow(/removed from its latest family head.*historical fallback/);
    expect(
      resolveHistoricalRecipeFromSnapshot(snapshot, {
        scheme: "key",
        method: "tlsnotary",
        recipeVersion: 1,
      }).recipe.recipeVersion,
    ).toBe(1);
  });

  test("keeps explicit historical resolution runtime-distinct from latest provenance", async () => {
    const fixture = await registryFixture([recipe(1), recipe(2)]);
    const snapshot = await authenticateRecipeRegistrySnapshot(fixture.provider);
    const historical = resolveHistoricalRecipeFromSnapshot(snapshot, {
      scheme: "key",
      method: "self-signed",
      recipeVersion: 1,
    });
    const latest = selectLatestRecipeAtSessionStart(snapshot, {
      scheme: "key",
      method: "self-signed",
      required: true,
    });

    expect(historical).toMatchObject({
      selectionKind: "explicit-historical",
      recipe: { recipeVersion: 1 },
    });
    expect(isHistoricalRecipeResolution(historical)).toBe(true);
    expect(isLatestRecipeSelection(historical)).toBe(false);
    expect(latest.recipe.recipeVersion).toBe(2);
    expect(isLatestRecipeSelection(latest)).toBe(true);
  });

  test("enforces the global scheme-version sequence and same-family supersedes chains", async () => {
    const duplicateVersion = await registryFixture([recipe(1), recipe(1)]);
    await expect(
      authenticateRecipeRegistrySnapshot(duplicateVersion.provider),
    ).rejects.toThrow(/repeats \(key, v1\)/);

    const duplicateAcrossFamilies = await registryFixture([
      recipe(1),
      recipe(1, {
        defaultMethod: { kind: "tlsnotary", endpoint: "https://default" },
        governance: {
          proposedBy: stewardSigner,
          acceptedAt: 1_780_000_000_002,
          anchoring: "single-signer",
        },
      }),
    ]);
    await expect(
      authenticateRecipeRegistrySnapshot(duplicateAcrossFamilies.provider),
    ).rejects.toThrow(/repeats \(key, v1\)/);

    // RA-3 versions are global to the scheme, while RA-4 supersedes links
    // remain within a family. Interleaving another family's v2 therefore
    // permits the original family to advance from v1 directly to v3.
    const interleavedFamilies = await registryFixture([
      recipe(1),
      recipe(2, {
        defaultMethod: { kind: "tlsnotary", endpoint: "https://default" },
        governance: {
          proposedBy: stewardSigner,
          acceptedAt: 1_780_000_000_002,
          anchoring: "single-signer",
        },
      }),
      recipe(3, {
        governance: {
          proposedBy: stewardSigner,
          acceptedAt: 1_780_000_000_003,
          anchoring: "single-signer",
          supersedes: 1,
        },
      }),
    ]);
    const interleavedSnapshot = await authenticateRecipeRegistrySnapshot(
      interleavedFamilies.provider,
    );
    expect(
      selectLatestRecipeAtSessionStart(interleavedSnapshot, {
        scheme: "key",
        method: "self-signed",
        required: true,
      }).recipe.recipeVersion,
    ).toBe(3);
    expect(
      selectLatestRecipeAtSessionStart(interleavedSnapshot, {
        scheme: "key",
        method: "tlsnotary",
        required: true,
      }).recipe.recipeVersion,
    ).toBe(2);

    const crossFamilySupersedes = await registryFixture([
      recipe(1),
      recipe(2, {
        defaultMethod: { kind: "tlsnotary", endpoint: "https://default" },
        governance: {
          proposedBy: stewardSigner,
          acceptedAt: 1_780_000_000_002,
          anchoring: "single-signer",
        },
      }),
      recipe(3, {
        defaultMethod: { kind: "tlsnotary", endpoint: "https://successor" },
        governance: {
          proposedBy: stewardSigner,
          acceptedAt: 1_780_000_000_003,
          anchoring: "single-signer",
          supersedes: 1,
        },
      }),
    ]);
    await expect(
      authenticateRecipeRegistrySnapshot(crossFamilySupersedes.provider),
    ).rejects.toThrow(/missing or cross-family/);

    const ambiguousHead = await registryFixture([
      recipe(1),
      recipe(2, {
        governance: {
          proposedBy: stewardSigner,
          acceptedAt: 1_780_000_000_002,
          anchoring: "single-signer",
        },
      }),
    ]);
    await expect(
      authenticateRecipeRegistrySnapshot(ambiguousHead.provider),
    ).rejects.toThrow(/has 2 roots/);

    const missingPredecessor = await registryFixture([
      recipe(2, {
        governance: {
          proposedBy: stewardSigner,
          acceptedAt: 1_780_000_000_002,
          anchoring: "single-signer",
          supersedes: 1,
        },
      }),
    ]);
    await expect(
      authenticateRecipeRegistrySnapshot(missingPredecessor.provider),
    ).rejects.toThrow(/has 0 roots|missing or cross-family/);

    const overlap = await registryFixture([
      recipe(1, {
        alternatives: [{ kind: "tlsnotary", endpoint: "https://alternative" }],
      }),
      recipe(2, {
        defaultMethod: { kind: "tlsnotary", endpoint: "https://default" },
        governance: {
          proposedBy: stewardSigner,
          acceptedAt: 1_780_000_000_002,
          anchoring: "single-signer",
        },
      }),
    ]);
    await expect(
      authenticateRecipeRegistrySnapshot(overlap.provider),
    ).rejects.toThrow(/overlap on method tlsnotary/);

    const reversedAcceptedAt = await registryFixture([
      recipe(1, {
        governance: {
          proposedBy: stewardSigner,
          acceptedAt: 1_780_000_000_010,
          anchoring: "single-signer",
        },
      }),
      recipe(2, {
        governance: {
          proposedBy: stewardSigner,
          acceptedAt: 1_780_000_000_009,
          anchoring: "single-signer",
          supersedes: 1,
        },
      }),
    ]);
    await expect(
      authenticateRecipeRegistrySnapshot(reversedAcceptedAt.provider),
    ).rejects.toThrow(/reverses signed acceptedAt ordering.*v1.*v2/);
  });

  test("rejects deprecated heads for required claims but preserves auditable optional selection", async () => {
    const fixture = await registryFixture([
      recipe(1, {
        governance: {
          proposedBy: stewardSigner,
          acceptedAt: 1_780_000_000_001,
          anchoring: "single-signer",
          deprecated: true,
          deprecationReason: "authority retired",
        },
      }),
    ]);
    const snapshot = await authenticateRecipeRegistrySnapshot(fixture.provider);
    expect(() =>
      selectLatestRecipeAtSessionStart(snapshot, {
        scheme: "key",
        method: "self-signed",
        required: true,
      }),
    ).toThrow(/deprecated recipe/);
    expect(
      selectLatestRecipeAtSessionStart(snapshot, {
        scheme: "key",
        method: "self-signed",
        required: false,
      }).recipe.governance.deprecated,
    ).toBe(true);
  });

  test("rejects disabled latest heads and preserves every other availability value", async () => {
    const disabled = await registryFixture([
      recipe(1, { availability: "disabled" }),
    ]);
    const disabledSnapshot = await authenticateRecipeRegistrySnapshot(
      disabled.provider,
    );
    for (const required of [true, false]) {
      expect(() =>
        selectLatestRecipeAtSessionStart(disabledSnapshot, {
          scheme: "key",
          method: "self-signed",
          required,
        }),
      ).toThrow(/disabled recipe cannot start a new session/);
    }

    for (const availability of [
      "operator_gated",
      "closed_data",
      "bilateral",
      "mocked",
      "failed",
    ] as const) {
      const fixture = await registryFixture([recipe(1, { availability })]);
      const snapshot = await authenticateRecipeRegistrySnapshot(fixture.provider);
      const selected = selectLatestRecipeAtSessionStart(snapshot, {
        scheme: "key",
        method: "self-signed",
        required: true,
      });
      expect(selected.recipe.availability).toBe(availability);
    }
  });

  test("authenticates every indexed recipe, including entries unrelated to selection", async () => {
    const fixture = await registryFixture(
      [
        recipe(1),
        recipe(2, {
          scheme: "domain",
          defaultMethod: { kind: "domain-tls-control", challengeType: "dns-01" },
          governance: {
            proposedBy: stewardSigner,
            acceptedAt: 1_780_000_000_002,
            anchoring: "single-signer",
          },
        }),
      ],
      { seeds: [STEWARD_SEED, IMPOSTOR_SEED] },
    );
    await expect(
      authenticateRecipeRegistrySnapshot(fixture.provider),
    ).rejects.toThrow(/signature is not valid under the steward key/);
  });

  test("binds exact address, ref, hash, version, writer, finality, and independent readback", async () => {
    const base = await registryFixture([recipe(1)]);
    let authenticatedInput: Readonly<RecipeRegistryAuthorityInput> | undefined;
    base.provider.authenticateCurrentIndex = (input) => {
      authenticatedInput = input;
      return "valid";
    };
    await authenticateRecipeRegistrySnapshot(base.provider);
    expect(authenticatedInput).toMatchObject({
      logicalAddress: RECIPE_REGISTRY_INDEX_ADDRESS,
      registryVersion: 7,
      indexRef: base.indexRef,
      receipt: {
        logicalAddress: RECIPE_REGISTRY_INDEX_ADDRESS,
        nativeAddress: base.indexRef.anchor.locator,
        contentHash: base.indexRef.contentHash,
        writer: stewardWriter,
        state: "finalized",
        observationDisposition: "established",
      },
    });
    expect(Object.isFrozen(authenticatedInput)).toBe(true);
    expect(Object.isFrozen(authenticatedInput!.index)).toBe(true);

    const wrongWriter = await registryFixture([recipe(1)]);
    wrongWriter.current.receipt.writer = "did:demos:attacker";
    await expect(
      authenticateRecipeRegistrySnapshot(wrongWriter.provider),
    ).rejects.toThrow(/finalized steward-owned binding/);

    const included = await registryFixture([recipe(1)]);
    included.current.receipt.state = "included";
    await expect(
      authenticateRecipeRegistrySnapshot(included.provider),
    ).rejects.toThrow(/finalized steward-owned binding/);

    const wrongReadback = await registryFixture([recipe(1)]);
    wrongReadback.documents.set(
      wrongReadback.indexRef.anchor.locator,
      {
        ...wrongReadback.index,
        entries: [
          {
            ...wrongReadback.recipeRefs[0]!,
            contentHash: "a".repeat(64),
          },
        ],
      },
    );
    await expect(
      authenticateRecipeRegistrySnapshot(wrongReadback.provider),
    ).rejects.toThrow(/readback hash does not match/);
  });

  test("rejects accessors/proxies before snapshot normalisation and isolates later mutation", async () => {
    const accessorCurrent = await registryFixture([recipe(1)]);
    let currentReads = 0;
    const hostileCurrent: Record<string, unknown> = {
      registryVersion: 7,
      receipt: accessorCurrent.current.receipt,
    };
    Object.defineProperty(hostileCurrent, "indexRef", {
      enumerable: true,
      get: () => {
        currentReads += 1;
        return accessorCurrent.indexRef;
      },
    });
    accessorCurrent.provider.resolveCurrentIndex = async () => hostileCurrent as never;
    await expect(
      authenticateRecipeRegistrySnapshot(accessorCurrent.provider),
    ).rejects.toThrow(/binding is malformed/);
    expect(currentReads).toBe(0);

    const accessorIndex = await registryFixture([recipe(1)]);
    let indexReads = 0;
    const hostileIndex: Record<string, unknown> = {
      registryId: RECIPE_REGISTRY_INDEX_ADDRESS,
    };
    Object.defineProperty(hostileIndex, "entries", {
      enumerable: true,
      get: () => {
        indexReads += 1;
        return accessorIndex.index.entries;
      },
    });
    accessorIndex.documents.set(accessorIndex.indexRef.anchor.locator, hostileIndex);
    await expect(
      authenticateRecipeRegistrySnapshot(accessorIndex.provider),
    ).rejects.toThrow(/not exact JSON/);
    expect(indexReads).toBe(0);

    const accessorRecipe = await registryFixture([recipe(1)]);
    let recipeReads = 0;
    const rawRecipe = accessorRecipe.documents.get(
      accessorRecipe.recipeRefs[0]!.anchor.locator,
    )!;
    Object.defineProperty(rawRecipe, "scheme", {
      configurable: true,
      enumerable: true,
      get: () => {
        recipeReads += 1;
        return "key";
      },
    });
    await expect(
      authenticateRecipeRegistrySnapshot(accessorRecipe.provider),
    ).rejects.toThrow(/not exact JSON/);
    expect(recipeReads).toBe(0);

    const callbackAccessor = await registryFixture([recipe(1)]);
    let callbackReads = 0;
    const hostileProvider = {
      ...callbackAccessor.provider,
    } as Record<string, unknown>;
    Object.defineProperty(hostileProvider, "authenticateCurrentIndex", {
      configurable: true,
      enumerable: true,
      get: () => {
        callbackReads += 1;
        return () => "valid";
      },
    });
    await expect(
      authenticateRecipeRegistrySnapshot(hostileProvider as never),
    ).rejects.toThrow(/exact own data callbacks/);
    expect(callbackReads).toBe(0);

    const proxiedIndex = await registryFixture([recipe(1)]);
    let proxyReads = 0;
    const proxy = new Proxy(proxiedIndex.index as unknown as Record<string, unknown>, {
      get(target, property, receiver) {
        proxyReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    proxiedIndex.documents.set(proxiedIndex.indexRef.anchor.locator, proxy);
    await expect(
      authenticateRecipeRegistrySnapshot(proxiedIndex.provider),
    ).rejects.toThrow(/not exact JSON/);
    // Promise resolution may probe `then` on a returned proxy, but the proxy is
    // never normalised into or accepted as authenticated JSON.
    expect(proxyReads).toBeGreaterThanOrEqual(1);

    const proxiedReceipt = await registryFixture([recipe(1)]);
    let receiptProxyReads = 0;
    const receipt = new Proxy(
      structuredClone(proxiedReceipt.current.receipt) as unknown as Record<
        string,
        unknown
      >,
      {
        get(target, property, receiver) {
          receiptProxyReads += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    );
    proxiedReceipt.provider.resolveCurrentIndex = async () => ({
      ...structuredClone(proxiedReceipt.current),
      receipt: receipt as unknown as AnchorReceipt,
    });
    await expect(
      authenticateRecipeRegistrySnapshot(proxiedReceipt.provider),
    ).rejects.toThrow(/current-index binding is malformed/);
    // Descriptor-first traversal detects a nested Proxy without invoking it.
    expect(receiptProxyReads).toBe(0);

    const mutation = await registryFixture([recipe(1)]);
    let mutationWasBlocked = false;
    mutation.provider.authenticateCurrentIndex = (input) => {
      try {
        (input.index.entries as RecipeRegistryRecipeRef[]).length = 0;
      } catch {
        mutationWasBlocked = true;
      }
      return "valid";
    };
    const snapshot = await authenticateRecipeRegistrySnapshot(mutation.provider);
    const mutationRecipe = mutation.documents.get(
      mutation.recipeRefs[0]!.anchor.locator,
    )!;
    mutationRecipe.scheme = "domain";
    mutation.index.entries.length = 0;
    expect(mutationWasBlocked).toBe(true);
    expect(snapshot.index.entries).toHaveLength(1);
    expect(snapshot.entries[0]!.recipe.scheme).toBe("key");

    let selectorReads = 0;
    const hostileSelector: Record<string, unknown> = {
      scheme: "key",
      required: true,
    };
    Object.defineProperty(hostileSelector, "method", {
      enumerable: true,
      get: () => {
        selectorReads += 1;
        return "self-signed";
      },
    });
    expect(() =>
      selectLatestRecipeAtSessionStart(snapshot, hostileSelector as never),
    ).toThrow(/selector must be exact/);
    expect(selectorReads).toBe(0);
  });

  test("captures callbacks with an inert receiver and rejects proxy capabilities or key views", async () => {
    const inert = await registryFixture([recipe(1)]);
    let observedReceiver: unknown;
    let release!: () => void;
    inert.provider.resolveCurrentIndex = function (this: unknown) {
      observedReceiver = this;
      return new Promise<CurrentRecipeRegistryIndex>((resolve) => {
        release = () => resolve(structuredClone(inert.current));
      });
    };
    const pending = authenticateRecipeRegistrySnapshot(inert.provider);
    // `authenticateRecipeRegistrySnapshot` captured every capability before its
    // first await. Later mutation of the provider object cannot redirect it.
    inert.provider.readAnchoredJson = async () => null;
    inert.provider.verify = () => false;
    release();
    await expect(pending).resolves.toMatchObject({ registryVersion: 7 });
    expect(observedReceiver).not.toBe(inert.provider);
    expect(Object.getPrototypeOf(observedReceiver)).toBe(null);
    expect(Object.isFrozen(observedReceiver)).toBe(true);

    const proxiedCallback = await registryFixture([recipe(1)]);
    proxiedCallback.provider.verify = new Proxy(
      proxiedCallback.provider.verify,
      {},
    );
    await expect(
      authenticateRecipeRegistrySnapshot(proxiedCallback.provider),
    ).rejects.toThrow(/trust material is malformed/);

    const proxiedProvider = await registryFixture([recipe(1)]);
    await expect(
      authenticateRecipeRegistrySnapshot(
        new Proxy(proxiedProvider.provider, {}),
      ),
    ).rejects.toThrow(/exact own data callbacks/);

    const keyView = await registryFixture([recipe(1)]);
    const backing = new Uint8Array(64);
    backing.set(stewardPublicKey, 16);
    keyView.provider.stewardPublicKey = backing.subarray(16, 48);
    await expect(
      authenticateRecipeRegistrySnapshot(keyView.provider),
    ).rejects.toThrow(/trust material is malformed/);

    const proxiedKey = await registryFixture([recipe(1)]);
    proxiedKey.provider.stewardPublicKey = new Proxy(
      proxiedKey.provider.stewardPublicKey,
      {},
    );
    await expect(
      authenticateRecipeRegistrySnapshot(proxiedKey.provider),
    ).rejects.toThrow(/trust material is malformed/);
  });

  test("rejects fabricated snapshots instead of trusting structural equality", async () => {
    const fixture = await registryFixture([recipe(1)]);
    const snapshot = await authenticateRecipeRegistrySnapshot(fixture.provider);
    const fabricated = structuredClone(snapshot);
    expect(isAuthenticatedRecipeRegistrySnapshot(fabricated)).toBe(false);
    expect(() =>
      selectLatestRecipeAtSessionStart(fabricated, {
        scheme: "key",
        method: "self-signed",
        required: true,
      }),
    ).toThrow(/authenticated registry snapshot/);
  });

  test("provenance contains canonical immutable index and recipe hashes", async () => {
    const fixture = await registryFixture([recipe(1)]);
    const snapshot = await authenticateRecipeRegistrySnapshot(fixture.provider);
    const selected = selectLatestRecipeAtSessionStart(snapshot, {
      scheme: "key",
      method: "self-signed",
      required: true,
    });
    expect(selected.registry.indexContentHash).toBe(
      contentHash(selected.registry.index as unknown as Record<string, unknown>),
    );
    expect(selected.recipeContentHash).toBe(
      contentHash(selected.recipe as unknown as Record<string, unknown>),
    );
    expect(canonicalize(selected.registry.indexRef)).toBe(
      canonicalize(fixture.indexRef),
    );
  });
});
