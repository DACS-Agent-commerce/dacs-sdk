import { describe, expect, test, vi } from "vitest";

import {
  authenticateReadableListingArtifact,
  discoverListings,
} from "../../src/agent/discover.js";
import {
  validateListingArtifact,
  type ListingValidationDeps,
} from "../../src/agent/listingValidation.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import { signComponentArtifact } from "../../src/artifacts/signatures.js";
import type { ListingDraft } from "../../src/artifacts/types.js";
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

const EARLIER_SHAPE_SCOPE = {
  agentId: "did:demos:alice",
  serviceId: "svc",
  name: "Market Data",
  description: "d",
  claimRequirements: [],
  supportedNegotiation: ["negotiate-fixed-price"],
  supportedPaymentRails: ["pay-x402"],
  supportedDelivery: ["deliver-attested-payload"],
};

const LISTING = { ...EARLIER_SHAPE_SCOPE, signature: "deadbeef" };

const store: Record<string, Record<string, unknown>> = {
  "ref:1": LISTING,
  "ref:2": { not: "a listing" },
  "ref:3": { ...LISTING, agentId: "did:demos:bob" },
};
const read = async (ref: string) => store[ref] ?? null;

const seller = (n: number) => {
  const seed = Uint8Array.from(Buffer.alloc(32, n));
  const priv = privateKeyFromSeed(seed);
  const raw = rawPublicKey(publicKeyFromSeed(seed));
  const hex = Buffer.from(raw).toString("hex");
  return { priv, raw, hex, did: `did:demos:agent:${hex}` };
};
const ALICE = seller(7);
const MALLORY = seller(9);
const NOW = 1_780_000_000_000;

/** A normative Listing presented by `presentedBy` and signed with `signer`. */
async function normativeListing(
  options: {
    presentedBy?: string;
    signer?: ReturnType<typeof seller>["priv"];
  } = {},
): Promise<Record<string, unknown>> {
  const presentedBy = options.presentedBy ?? ALICE.did;
  const draft: ListingDraft = {
    dacsVersion: "1",
    listingVersion: 1,
    listingId: "discovered-listing",
    seller: {
      identity: {
        bundleVersion: "1",
        presentedBy,
        presentedAt: 1_780_000_000_000,
        claims: [{ ref: presentedBy }],
        presentation: {
          kind: "per-claim",
          signatures: [{ ref: presentedBy, signature: "identity-presentation" }],
        },
      },
      displayName: "Market Data",
    },
    offering: {
      title: "Market Data",
      description: "Caller-supplied discovery",
      category: "data.finance",
      tags: ["market-data"],
      deliverable: {
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" },
      },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-agreement" },
      { kind: "pay-x402", parameters: { rail: "x402:default" } },
      { kind: "deliver-attested-payload" },
    ],
    pricing: { kind: "fixed", price: { amount: "1", currency: "USDC" } },
    acceptedRails: [{ railId: "x402:default" }],
    terms: { deadlineSecAfterCommit: 3_600 },
    validity: { notBefore: 1_700_000_000_000 },
  };
  return (await signComponentArtifact(draft, ARTIFACT_SEPARATORS.Listing, {
    algorithm: "ed25519",
    signer: presentedBy,
    sign: (bytes) => ed25519Sign(bytes, options.signer ?? ALICE.priv),
  })) as unknown as Record<string, unknown>;
}

/** An earlier-shape Listing: a hex string signature over its stripped scope. */
function earlierShapeListing(
  agentId: string,
  priv: ReturnType<typeof seller>["priv"],
): Record<string, unknown> {
  const scope = { ...EARLIER_SHAPE_SCOPE, agentId };
  const bytes = signedBytes(ARTIFACT_SEPARATORS.Listing, contentHash(scope));
  const signature = Buffer.from(ed25519Sign(bytes, priv)).toString("hex");
  return { ...scope, signature };
}

const listingValidationDeps: ListingValidationDeps = {
  nowMs: () => NOW,
  verifyListingSignature: ({ signedBytes: bytes, signature }) =>
    signature.signer === ALICE.did &&
    ed25519Verify(
      bytes,
      Uint8Array.from(Buffer.from(signature.value, "base64url")),
      publicKeyFromRaw(ALICE.raw),
    ),
  revocation: {
    surfaces: [{ kind: "well-known", status: "active", integrity: "verified" }],
    readMarker: async () => null,
    verifyMarkerSignature: () => false,
  },
  verifyIdentityPresentation: () => true,
  loadRailResolution: () => ({
    trustPhase: "PA-1",
    trustPolicyAcceptsPA1: true,
    registry: { state: "not-used", entries: [], definitions: [] },
    inCodeDefinitions: [{
      railId: "x402:default",
      railVersion: 1,
      phaseHandler: "pay-x402",
      governanceAnchoring: "in-code",
      signatureValid: true,
    }],
  }),
  resolvePayloadVerificationCapability: () => ({ disposition: "supported" }),
  verifySellerControl: ({ signer }) => signer === ALICE.did,
};

const validateListing = (raw: Record<string, unknown>) =>
  validateListingArtifact(raw, listingValidationDeps);

// Resolution/structural behaviour — signatures covered in their own block below.
const TRUST = { trustListings: true } as const;
const TRUSTED_VALIDATED = { ...TRUST, validateListing, nowMs: () => NOW };

describe("discoverListings (resolve + validate caller-supplied refs)", () => {
  test("returns only refs that resolve to verified normative Listings", async () => {
    const records: Record<string, Record<string, unknown>> = {
      ...store,
      "ref:n": await normativeListing(),
    };
    const found = await discoverListings(
      ["ref:1", "ref:2", "missing", "ref:3", "ref:n"],
      async (ref) => records[ref] ?? null,
      TRUSTED_VALIDATED,
    );
    expect(found.map((f) => f.ref)).toEqual(["ref:n"]);
    expect(found[0]!.compatibility).toBe("normative");
    expect(found[0]!.listing.listingId).toBe("discovered-listing");
  });

  test("drops an earlier-shape Listing even when trustListings is set", async () => {
    const validate = vi.fn(validateListing);
    const found = await discoverListings(["ref:1", "ref:3"], read, {
      ...TRUST,
      validateListing: validate,
    });
    expect(found).toEqual([]);
    expect(validate).not.toHaveBeenCalled();
  });

  test("skips missing refs without throwing", async () => {
    expect(await discoverListings(["missing", "also-missing"], read, TRUST)).toEqual([]);
  });

  test("empty input yields empty result", async () => {
    expect(await discoverListings([], read, TRUST)).toEqual([]);
  });

  test("requires an explicit gate — neither dep rejects (no fail-open)", async () => {
    await expect(discoverListings(["ref:1"], read)).rejects.toThrow(/verify|trustListings/);
  });

  test("owns the requested ref list before the first asynchronous read", async () => {
    const records: Record<string, Record<string, unknown>> = {
      "ref:n": await normativeListing(),
      "ref:3": LISTING,
    };
    const refs = ["ref:n"];
    const seen: string[] = [];
    const found = await discoverListings(
      refs,
      async (ref) => {
        seen.push(ref);
        refs.push("ref:3");
        await Promise.resolve();
        return records[ref] ?? null;
      },
      TRUSTED_VALIDATED,
    );
    expect(seen).toEqual(["ref:n"]);
    expect(found.map((item) => item.ref)).toEqual(["ref:n"]);
  });

  test("rejects accessor-backed gates without invoking dependency getters", async () => {
    let getterCalls = 0;
    const deps = {} as { trustListings: boolean };
    Object.defineProperty(deps, "trustListings", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return true;
      },
    });
    await expect(discoverListings(["ref:1"], read, deps)).rejects.toThrow(
      /dependency trustListings must be stable data/,
    );
    expect(getterCalls).toBe(0);
  });

  test("drops a proxy-backed resolver artifact without running its traps", async () => {
    let traps = 0;
    const live = new Proxy(LISTING, {
      get(target, key, receiver) {
        traps += 1;
        return Reflect.get(target, key, receiver);
      },
      ownKeys(target) {
        traps += 1;
        return Reflect.ownKeys(target);
      },
    });
    await expect(
      discoverListings(["ref:proxy"], async () => live, TRUST),
    ).resolves.toEqual([]);
    // Resolving any Promise-like value performs one unavoidable `then` probe;
    // the SDK itself must not traverse the proxy-backed artifact after that.
    expect(traps).toBe(1);
  });

  test("requires exact booleans and a safe unix-ms admission clock", async () => {
    await expect(
      discoverListings(["ref:1"], read, { trustListings: "yes" } as never),
    ).rejects.toThrow(/trustListings must be a boolean/);

    const normative = {
      dacsVersion: "1",
      listingVersion: 1,
      listingId: "clocked",
      seller: {
        identity: {
          bundleVersion: "1",
          presentedBy: "did:demos:seller",
          presentedAt: 1,
          claims: [{ ref: "did:demos:seller" }],
          presentation: {
            kind: "per-claim",
            signatures: [{
              ref: "did:demos:seller",
              signature: "presentation",
            }],
          },
        },
        displayName: "Seller",
      },
      offering: {
        title: "Clocked",
        description: "Clock validation",
        category: "test",
        tags: [],
        deliverable: {
          kind: "attested-payload",
          payloadFormat: "application/json",
        },
      },
      buyerRequirement: { requirementVersion: "1", required: [] },
      pipeline: [
        { kind: "negotiate-fixed-price" },
        { kind: "commit-agreement" },
        { kind: "pay-x402", parameters: { rail: "x402:default" } },
        { kind: "deliver-attested-payload" },
      ],
      pricing: { kind: "fixed", price: { amount: "1", currency: "USDC" } },
      acceptedRails: [{ railId: "x402:default" }],
      terms: { deadlineSecAfterCommit: 60 },
      validity: { notBefore: 0 },
      signature: {
        algorithm: "ed25519",
        signer: "did:demos:seller",
        value: "AA",
      },
    } as unknown as Record<string, unknown>;
    await expect(
      discoverListings(["normative"], async () => normative, {
        trustListings: true,
        nowMs: () => Number.NaN,
      }),
    ).rejects.toThrow(/clock must return unix-ms safe integer/);
  });
});

describe("discoverListings signature verification (#41)", () => {
  const verify = (b: Uint8Array, s: Uint8Array, k: Uint8Array) =>
    ed25519Verify(b, s, publicKeyFromRaw(k));
  const validate = vi.fn(validateListing);
  const deps = { verify, validateListing: validate, nowMs: () => NOW };
  const discoverOne = (record: Record<string, unknown>) =>
    discoverListings(["a"], async () => record, deps);

  test("a normative Listing signed by its presenting seller VERIFIES and is returned", async () => {
    const found = await discoverOne(await normativeListing());
    expect(found).toHaveLength(1);
    expect(found[0]!.compatibility).toBe("normative");
    expect(found[0]!.listing.seller.identity.presentedBy).toBe(ALICE.did);
  });

  test("an earlier-shape Listing signed by its own canonical agentId is dropped", async () => {
    const record = earlierShapeListing(ALICE.did, ALICE.priv);
    const unvalidated = vi.fn(validateListing);
    await expect(
      discoverListings(["a"], async () => record, { ...deps, validateListing: unvalidated }),
    ).resolves.toEqual([]);
    expect(unvalidated).not.toHaveBeenCalled();
  });

  test("authenticateReadableListingArtifact refuses an earlier-shape Listing under every gate", async () => {
    const record = earlierShapeListing(ALICE.did, ALICE.priv);
    await expect(authenticateReadableListingArtifact(record, { verify })).resolves.toBeNull();
    await expect(authenticateReadableListingArtifact(record, TRUST)).resolves.toBeNull();
    await expect(authenticateReadableListingArtifact(record, {})).resolves.toBeNull();
  });

  test.each([
    (key: string) => `did:ethr:${key}`,
    (key: string) => key,
    (key: string) => `0x${key}`,
    (key: string) => `demos:0x${key}`,
    (key: string) => `DID:demos:agent:${key}`,
  ])("the default resolver never suffix-decodes a non-canonical signer", async (alias) => {
    validate.mockClear();
    const signed = await normativeListing({ presentedBy: alias(ALICE.hex) });
    await expect(discoverOne(signed)).resolves.toEqual([]);
    expect(validate).not.toHaveBeenCalled();
  });

  test("WRONG KEY — signed by someone other than the presenting seller is dropped", async () => {
    validate.mockClear();
    const forged = await normativeListing({ signer: MALLORY.priv });
    expect(await discoverOne(forged)).toEqual([]);
    expect(validate).not.toHaveBeenCalled();
  });

  test("a signer other than the presenting seller is dropped", async () => {
    const ok = await normativeListing();
    const swapped = {
      ...ok,
      signature: {
        ...(ok["signature"] as Record<string, unknown>),
        signer: MALLORY.did,
      },
    };
    expect(await discoverOne(swapped)).toEqual([]);
  });

  test("TAMPERED — a field changed after signing is dropped", async () => {
    validate.mockClear();
    const ok = await normativeListing();
    const tampered = {
      ...ok,
      acceptedRails: [{ railId: "x402:attacker" }],
    };
    expect(await discoverOne(tampered)).toEqual([]);
    expect(validate).not.toHaveBeenCalled();
  });

  test("MISSING signature is dropped", async () => {
    const { signature: _drop, ...unsigned } = await normativeListing();
    expect(await discoverOne(unsigned)).toEqual([]);
  });

  test("MALFORMED signature is dropped, not thrown", async () => {
    const ok = await normativeListing();
    const bad = {
      ...ok,
      signature: { ...(ok["signature"] as Record<string, unknown>), value: "zzzz-not-base64url" },
    };
    expect(await discoverOne(bad)).toEqual([]);
  });

  test("a seller claim with no resolvable key is dropped (signer can't be established)", async () => {
    validate.mockClear();
    const aliasOnly = await normativeListing({ presentedBy: "did:example:alias-only" });
    expect(await discoverOne(aliasOnly)).toEqual([]);
    expect(validate).not.toHaveBeenCalled();
  });

  test("a THROWING key resolver drops only that listing, not the whole batch", async () => {
    const records: Record<string, Record<string, unknown>> = {
      bad: await normativeListing(),
      good: await normativeListing(),
    };
    // The resolver throws for the FIRST listing but works for the second.
    let seen = 0;
    const found = await discoverListings(["bad", "good"], async (r) => records[r] ?? null, {
      ...deps,
      resolvePublicKey: () => {
        seen += 1;
        if (seen === 1) throw new Error("resolver blew up");
        return Uint8Array.from(ALICE.raw);
      },
    });
    // The throw dropped only "bad"; "good" is still discovered.
    expect(found.map((f) => f.ref)).toEqual(["good"]);
  });

  test("copies resolver-owned key bytes before handing them to verification", async () => {
    const ok = await normativeListing();
    const retained = Uint8Array.from(ALICE.raw);
    const found = await discoverListings(["a"], async () => ok, {
      validateListing,
      nowMs: () => NOW,
      resolvePublicKey: () => retained,
      verify: (bytes, signature, publicKey) => {
        retained.fill(0);
        return ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey));
      },
    });
    expect(found).toHaveLength(1);
    expect(retained.every((byte) => byte === 0)).toBe(true);
  });
});
