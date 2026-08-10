import { describe, expect, test } from "vitest";

import {
  discoverListings,
  discoverValidatedListings,
  inspectListings,
} from "../../src/agent/discover.js";
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
});

describe("explicit Listing disposition discovery", () => {
  test("inspection retains failures while discovery returns verified normative listings only", async () => {
    const normative = {
      dacsVersion: "1",
      listingId: "verified",
    } as never;
    const records: Record<string, Record<string, unknown>> = {
      good: { result: "verified" },
      revoked: { result: "revoked" },
      legacy: { result: "legacy" },
    };
    const validate = async (raw: Readonly<Record<string, unknown>>) => {
      const disposition = raw.result === "verified"
        ? "verified" as const
        : raw.result === "revoked"
          ? "revoked" as const
          : "rejected" as const;
      return {
        disposition,
        reasons: disposition === "verified"
          ? []
          : [{ step: "schema" as const, code: String(raw.result), message: "not eligible" }],
        evidence: [],
        ...(disposition === "verified" ? { listing: normative } : {}),
      };
    };
    const read = async (ref: string) => records[ref] ?? null;

    const inspected = await inspectListings(["good", "revoked", "legacy"], read, validate);
    expect(inspected.map((entry) => entry.validation.disposition)).toEqual([
      "verified",
      "revoked",
      "rejected",
    ]);

    const discovered = await discoverValidatedListings(
      ["good", "revoked", "legacy"],
      read,
      validate,
    );
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      ref: "good",
      compatibility: "normative",
      validation: { disposition: "verified" },
    });
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
});
