import { describe, expect, test } from "vitest";

import { discoverListings } from "../../src/agent/discover.js";
import { buildSignedArtifact } from "../../src/agent/signedArtifact.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";

const LISTING = {
  agentId: "did:demos:agent:alice",
  serviceId: "svc",
  name: "Market Data",
  description: "d",
  claimRequirements: [],
  supportedNegotiation: ["negotiate-fixed-price"],
  supportedPaymentRails: ["pay-x402"],
  supportedDelivery: ["deliver-attested-payload"],
  signature: "deadbeef",
};

const store: Record<string, Record<string, unknown>> = {
  "ref:1": LISTING,
  "ref:2": { not: "a listing" },
  "ref:3": { ...LISTING, agentId: "did:demos:agent:bob" },
};
const read = async (ref: string) => store[ref] ?? null;

// Resolution/structural behaviour — signatures covered in their own block below.
const TRUST = { trustListings: true } as const;

describe("discoverListings (resolve + validate caller-supplied refs)", () => {
  test("returns only refs that resolve to valid listings, with the signature stripped", async () => {
    const found = await discoverListings(["ref:1", "ref:2", "missing", "ref:3"], read, TRUST);
    expect(found.map((f) => f.ref)).toEqual(["ref:1", "ref:3"]);
    expect(found[0]!.compatibility).toBe("legacy-mvp");
    expect(
      found[0]!.compatibility === "legacy-mvp"
        ? found[0]!.listing.agentId
        : undefined,
    ).toBe("did:demos:agent:alice");
    // returned listing is the signed scope (signature omitted)
    expect("signature" in found[0]!.listing).toBe(false);
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
    const refs = ["ref:1"];
    const seen: string[] = [];
    const found = await discoverListings(
      refs,
      async (ref) => {
        seen.push(ref);
        refs.push("ref:3");
        await Promise.resolve();
        return store[ref] ?? null;
      },
      TRUST,
    );
    expect(seen).toEqual(["ref:1"]);
    expect(found.map((item) => item.ref)).toEqual(["ref:1"]);
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
          presentedBy: "did:demos:agent:seller",
          presentedAt: 1,
          claims: [{ ref: "did:demos:agent:seller" }],
          presentation: {
            kind: "per-claim",
            signatures: [{
              ref: "did:demos:agent:seller",
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
        signer: "did:demos:agent:seller",
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
  const seller = (n: number) => {
    const seed = Uint8Array.from(Buffer.alloc(32, n));
    const priv = privateKeyFromSeed(seed);
    const hex = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex");
    return { priv, hex, did: `did:demos:agent:${hex}` };
  };
  const ALICE = seller(7);
  const MALLORY = seller(9);
  const verify = (b: Uint8Array, s: Uint8Array, k: Uint8Array) =>
    ed25519Verify(b, s, publicKeyFromRaw(k));
  const deps = { verify };

  const signedBy = async (did: string, priv: ReturnType<typeof privateKeyFromSeed>) => {
    const { signature: _drop, ...body } = { ...LISTING, agentId: did };
    return (await buildSignedArtifact(body, ARTIFACT_SEPARATORS.Listing, (b) =>
      ed25519Sign(b, priv),
    )) as unknown as Record<string, unknown>;
  };

  test("a listing signed by its own agentId VERIFIES and is returned", async () => {
    const ok = await signedBy(ALICE.did, ALICE.priv);
    const found = await discoverListings(["a"], async () => ok, deps);
    expect(found).toHaveLength(1);
    expect(found[0]!.compatibility).toBe("legacy-mvp");
    expect(
      found[0]!.compatibility === "legacy-mvp"
        ? found[0]!.listing.agentId
        : undefined,
    ).toBe(ALICE.did);
  });

  test("WRONG KEY — signed by someone other than the advertised seller is dropped", async () => {
    // Mallory signs a listing that advertises Alice as the seller.
    const forged = await signedBy(ALICE.did, MALLORY.priv);
    expect(await discoverListings(["a"], async () => forged, deps)).toEqual([]);
  });

  test("TAMPERED — a field changed after signing is dropped", async () => {
    const ok = await signedBy(ALICE.did, ALICE.priv);
    const tampered = { ...ok, supportedPaymentRails: ["pay-attacker"] };
    expect(await discoverListings(["a"], async () => tampered, deps)).toEqual([]);
  });

  test("MISSING signature is dropped", async () => {
    const { signature: _drop, ...unsigned } = await signedBy(ALICE.did, ALICE.priv);
    expect(await discoverListings(["a"], async () => unsigned, deps)).toEqual([]);
  });

  test("MALFORMED signature is dropped, not thrown", async () => {
    const ok = await signedBy(ALICE.did, ALICE.priv);
    const bad = { ...ok, signature: "zzzz-not-hex" };
    expect(await discoverListings(["a"], async () => bad, deps)).toEqual([]);
  });

  test("a seller claim with no resolvable key is dropped (signer can't be established)", async () => {
    const ok = await signedBy(ALICE.did, ALICE.priv);
    const aliasOnly = { ...ok, agentId: "did:example:alias-only" };
    expect(await discoverListings(["a"], async () => aliasOnly, deps)).toEqual([]);
  });

  test("a THROWING key resolver drops only that listing, not the whole batch (#71)", async () => {
    const bad = await signedBy(ALICE.did, ALICE.priv);
    const good = await signedBy(ALICE.did, ALICE.priv);
    const store: Record<string, Record<string, unknown>> = { bad, good };
    // The resolver throws for the FIRST listing but works for the second.
    let seen = 0;
    const found = await discoverListings(["bad", "good"], async (r) => store[r] ?? null, {
      verify,
      resolvePublicKey: () => {
        seen += 1;
        if (seen === 1) throw new Error("resolver blew up");
        return Uint8Array.from(Buffer.from(ALICE.hex, "hex"));
      },
    });
    // The throw dropped only "bad"; "good" is still discovered.
    expect(found.map((f) => f.ref)).toEqual(["good"]);
  });

  test("copies resolver-owned key bytes before handing them to verification", async () => {
    const ok = await signedBy(ALICE.did, ALICE.priv);
    const retained = Uint8Array.from(Buffer.from(ALICE.hex, "hex"));
    const found = await discoverListings(["a"], async () => ok, {
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
