import { describe, expect, test, vi } from "vitest";

import { buildAgent } from "../../src/agent/Agent.js";
import { buildSignedArtifact } from "../../src/agent/signedArtifact.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import {
  signComponentArtifact,
  verifyComponentSignature,
} from "../../src/artifacts/signatures.js";
import { contentHash, stripSignature } from "../../src/canonical/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
  signedBytes,
} from "../../src/crypto/index.js";
import type { SubstrateAdapter } from "../../src/substrate/SubstrateAdapter.js";

// Regression for #71: the PUBLIC Agent.runSession() path must wire the #41
// listing verifier. Previously createAgent() supplied neither verifyListing nor
// trustListing, so every real runSession threw before vetting or settling — and
// no non-live test covered it (the only Agent lifecycle test is env-skipped).

const SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 3));
const BUYER_SEED = Uint8Array.from(Buffer.alloc(32, 7));
const sellerPriv = privateKeyFromSeed(SELLER_SEED);
const buyerPriv = privateKeyFromSeed(BUYER_SEED);
const sellerPublicKey = rawPublicKey(publicKeyFromSeed(SELLER_SEED));
const sellerHex = Buffer.from(sellerPublicKey).toString("hex");
const sellerDid = `did:demos:agent:${sellerHex}`;
const buyerPublicKey = rawPublicKey(publicKeyFromSeed(BUYER_SEED));
const buyerDid = `did:demos:agent:${Buffer.from(buyerPublicKey).toString("hex")}`;

/** In-memory adapter — just the surface buildAgent's runSession path touches. */
function memAdapter(options: { failBundleOnce?: boolean } = {}) {
  const store = new Map<string, Record<string, unknown>>();
  let bundleFailed = false;
  const getPublicKey = vi.fn(async () => Uint8Array.from(buyerPublicKey));
  const maybeFailBundle = (name: string) => {
    if (
      options.failBundleOnce &&
      !bundleFailed &&
      name.startsWith("dacs5:bundle:")
    ) {
      bundleFailed = true;
      throw new Error("simulated process failure before bundle anchor");
    }
  };
  const adapter = {
    store,
    sign: async (bytes: Uint8Array) => ed25519Sign(bytes, buyerPriv),
    anchor: async (name: string, value: object) => {
      maybeFailBundle(name);
      const address = `stor:${name}`;
      store.set(address, value as Record<string, unknown>);
      return { address, txRef: `tx:${address}` };
    },
    anchorAndWait: async (name: string, value: object) => {
      maybeFailBundle(name);
      const address = `stor:${name}`;
      store.set(address, value as Record<string, unknown>);
      return {
        address,
        txRef: `tx:${address}`,
        completion: "read-visible" as const,
      };
    },
    anchorAddress: async (name: string) => `stor:${name}`,
    readAnchor: async (address: string) => store.get(address) ?? null,
    // #70 surface: resume resolution is BY NAME, owner-bound. The mem adapter's
    // addresses are deterministic (`stor:<name>`), so resolution is a lookup.
    getAddress: () => buyerDid,
    getPublicKey,
    resolveAnchorByName: async (name: string) => {
      const address = `stor:${name}`;
      return store.has(address)
        ? { status: "present" as const, address }
        : { status: "absent" as const };
    },
  } as unknown as SubstrateAdapter;
  return { adapter, store, getPublicKey };
}

const TERMS = {
  price: {
    amount: "1000000",
    asset: "USDC",
    decimals: 6,
    rail: "x402:default",
  },
  deliveryPhase: "deliver-attested-payload",
  deliveryFormat: "application/json",
};

async function anchorListing(
  store: Map<string, Record<string, unknown>>,
  priv = sellerPriv,
  agentId = sellerDid,
  validity: { notBefore: number; notAfter?: number } = {
    notBefore: 1_700_000_000_000,
  },
  description = "d",
) {
  const signed = await signComponentArtifact(
    {
      dacsVersion: "1",
      listingVersion: 1,
      listingId: "svc",
      seller: {
        identity: {
          bundleVersion: "1",
          presentedBy: agentId,
          presentedAt: 1_780_000_000_000,
          claims: [{ ref: agentId }],
          presentation: {
            kind: "per-claim",
            signatures: [{ ref: agentId, signature: "identity-presentation" }],
          },
        },
        displayName: "Market Data",
        publicEndpoint: "https://seller.example/dacs",
      },
      offering: {
        title: "Market Data",
        description,
        category: "data.finance",
        tags: ["market-data"],
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
      pricing: {
        kind: "fixed",
        price: { amount: "1", currency: "USDC" },
      },
      acceptedRails: [{ railId: "x402:default" }],
      terms: { deadlineSecAfterCommit: 3_600 },
      validity,
    },
    ARTIFACT_SEPARATORS.Listing,
    {
      algorithm: "ed25519",
      signer: agentId,
      sign: (bytes) => ed25519Sign(bytes, priv),
    },
  );
  store.set("stor:listing", signed as Record<string, unknown>);
  return "stor:listing";
}

describe("Agent.runSession wires the #41 listing verifier (public surface)", () => {
  test("a genuinely signed listing settles through the public runSession", async () => {
    const { adapter, store } = memAdapter();
    const ref = await anchorListing(store);
    const agent = buildAgent(adapter as never, { demosRpc: "mem", wallet: "x", identity: { agentId: buyerDid } });

    let settled = false;
    const res = await agent.runSession(ref, {
      terms: TERMS,
      settle: async () => {
        settled = true;
        return { ok: true, txHash: "0xpaid", chainId: "c", payer: buyerDid, payee: sellerDid };
      },
    });
    expect(res.outcome).toBe("completed");
    expect(settled).toBe(true);

    await expect(
      verifyComponentSignature(
        store.get(res.settlementRef)!,
        ARTIFACT_SEPARATORS.SettlementEvidence,
        {
          isSignerAuthorized: (_artifact, signature) =>
            signature.signer === buyerDid,
          resolvePublicKey: () => buyerPublicKey,
          verify: ({ signedBytes, signature, publicKey }) =>
            ed25519Verify(
              signedBytes,
              Uint8Array.from(Buffer.from(signature.value, "base64url")),
              publicKeyFromRaw(publicKey),
            ),
        },
      ),
    ).resolves.toMatchObject({ status: "valid" });
  });

  test("a completed public retry authenticates the exact legacy one-sided bundle", async () => {
    const { adapter, store } = memAdapter();
    const ref = await anchorListing(store);
    const agent = buildAgent(adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: { agentId: buyerDid },
    });
    let settleCalls = 0;
    const settle = async () => {
      settleCalls += 1;
      return {
        ok: true,
        txHash: "0xbundle-retry",
        chainId: "demos",
        payer: buyerDid,
        payee: sellerDid,
      };
    };

    const first = await agent.runSession(ref, {
      jobId: "completed-bundle-retry",
      terms: TERMS,
      settle,
    });
    await expect(
      agent.runSession(ref, {
        jobId: "completed-bundle-retry",
        terms: TERMS,
        settle,
      }),
    ).resolves.toEqual(first);
    expect(settleCalls).toBe(1);

    const bundle = structuredClone(store.get(first.bundleRef)!);
    const signature = (bundle.signatures as Array<{ value: string }>)[0]!;
    // Padding is a decodable alias in permissive codecs, but is not canonical
    // Base64URL and therefore must not authenticate on resume.
    signature.value += "=";
    store.set(first.bundleRef, bundle);
    await expect(
      agent.runSession(ref, {
        jobId: "completed-bundle-retry",
        terms: TERMS,
        settle,
      }),
    ).rejects.toThrow(/cryptographic authentication/);
    expect(settleCalls).toBe(1);
  });

  test("a listing signed by the WRONG key aborts before settlement — never pays", async () => {
    const { adapter, store } = memAdapter();
    // Signed by a different key than the advertised sellerDid.
    const ref = await anchorListing(store, privateKeyFromSeed(Uint8Array.from(Buffer.alloc(32, 9))));
    const agent = buildAgent(adapter as never, { demosRpc: "mem", wallet: "x", identity: { agentId: buyerDid } });

    let settled = false;
    await expect(
      agent.runSession(ref, {
        terms: TERMS,
        settle: async () => {
          settled = true;
          return { ok: true, txHash: "0x", chainId: "c", payer: "p", payee: "q" };
        },
      }),
    ).rejects.toThrow(/failed signature verification/);
    expect(settled).toBe(false);
  });

  test("public recovery authenticates exact Listing, Agreement, and evidence without paying twice", async () => {
    vi.useFakeTimers();
    try {
      const admittedAt = 1_800_000_000_000;
      vi.setSystemTime(admittedAt);
      const { adapter, store, getPublicKey } = memAdapter({
        failBundleOnce: true,
      });
      const ref = await anchorListing(store, sellerPriv, sellerDid, {
        notBefore: admittedAt - 1_000,
        notAfter: admittedAt + 1_000,
      });
      const originalListing = structuredClone(store.get(ref)!);
      const agent = buildAgent(adapter as never, {
        demosRpc: "mem",
        wallet: "x",
        identity: { agentId: buyerDid },
      });
      let settleCalls = 0;
      const settle = async () => {
        settleCalls += 1;
        return {
          ok: true,
          txHash: "0xpaid-once",
          chainId: "c",
          payer: buyerDid,
          payee: sellerDid,
        };
      };

      await expect(
        agent.runSession(ref, { jobId: "job-expiry", terms: TERMS, settle }),
      ).rejects.toThrow(/simulated process failure/);
      expect(settleCalls).toBe(1);
      // Fresh execution never acquires a recovery-only key.
      expect(getPublicKey).not.toHaveBeenCalled();

      vi.setSystemTime(admittedAt + 2_000);

      await anchorListing(
        store,
        sellerPriv,
        sellerDid,
        { notBefore: admittedAt - 1_000, notAfter: admittedAt + 1_000 },
        "same address, substituted Listing bytes",
      );
      await expect(
        agent.runSession(ref, { jobId: "job-expiry", terms: TERMS, settle }),
      ).rejects.toThrow(/signed Listing pin/i);
      expect(settleCalls).toBe(1);
      expect(getPublicKey).not.toHaveBeenCalled();
      store.set(ref, originalListing);

      const agreementAddress = "stor:dacs3:agreement:job-expiry";
      const evidenceAddress = "stor:dacs4:evidence:job-expiry";
      const agreement = structuredClone(store.get(agreementAddress)!);
      const evidence = structuredClone(store.get(evidenceAddress)!);
      expect(typeof agreement.signature).toBe("string");
      expect(typeof (evidence.signature as { value?: unknown })?.value).toBe(
        "string",
      );

      getPublicKey.mockResolvedValueOnce(Uint8Array.from(sellerPublicKey));
      await expect(
        agent.runSession(ref, { jobId: "job-expiry", terms: TERMS, settle }),
      ).rejects.toThrow(/cryptographic Agreement authentication/i);
      expect(settleCalls).toBe(1);
      expect(getPublicKey).toHaveBeenCalledTimes(1);

      const agreementSignature = agreement.signature as string;
      store.set(agreementAddress, {
        ...agreement,
        signature: `${agreementSignature.startsWith("0") ? "1" : "0"}${agreementSignature.slice(1)}`,
      });
      await expect(
        agent.runSession(ref, { jobId: "job-expiry", terms: TERMS, settle }),
      ).rejects.toThrow(/cryptographic Agreement authentication/i);
      expect(settleCalls).toBe(1);
      expect(getPublicKey).toHaveBeenCalledTimes(2);
      store.set(agreementAddress, agreement);

      const evidenceSignature = evidence.signature as { value: string };
      store.set(evidenceAddress, {
        ...evidence,
        signature: {
          ...(evidence.signature as Record<string, unknown>),
          value: `${evidenceSignature.value.startsWith("A") ? "B" : "A"}${evidenceSignature.value.slice(1)}`,
        },
      });
      await expect(
        agent.runSession(ref, { jobId: "job-expiry", terms: TERMS, settle }),
      ).rejects.toThrow(/cryptographic SettlementEvidence authentication/i);
      expect(settleCalls).toBe(1);
      // One key lookup serves both Agreement and evidence checks in this run.
      expect(getPublicKey).toHaveBeenCalledTimes(3);
      store.set(evidenceAddress, evidence);

      await expect(
        agent.runSession(ref, { jobId: "job-expiry", terms: TERMS, settle }),
      ).resolves.toMatchObject({ outcome: "completed", jobId: "job-expiry" });
      expect(settleCalls).toBe(1);
      expect(getPublicKey).toHaveBeenCalledTimes(4);

      await expect(
        agent.runSession(ref, { jobId: "job-arbitrary", terms: TERMS, settle }),
      ).rejects.toThrow(/outside.*validity window.*no prior Agreement/i);
      expect(settleCalls).toBe(1);
      // Missing recovery state is rejected before key acquisition or Listing auth.
      expect(getPublicKey).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  test("getReputation ignores a structurally plausible but unverified bundle", async () => {
    const { adapter, store } = memAdapter();
    store.set("stor:forged-bundle", {
      bundleVersion: "1",
      jobId: "forged",
      outcome: "completed",
      anchoredByRole: "buyer",
      listingRef: { listingId: "svc", version: 1, contentHash: "h" },
      parties: [
        { role: "buyer", bundleHash: "h", primaryClaim: buyerDid },
        { role: "seller", bundleHash: "h", primaryClaim: sellerDid },
      ],
      phaseSummary: [],
      vetRecords: [],
      settlementEvidence: [],
      recipeRegistryVersion: 1,
      railRegistryVersion: 1,
      finalisedAt: Date.now(),
      // Deliberately unsigned: the old getReputation path counted this anyway.
    });
    const agent = buildAgent(adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: { agentId: buyerDid },
    });
    await expect(agent.getReputation(buyerDid, ["stor:forged-bundle"]))
      .resolves.toMatchObject({ totalAgreements: 0, completed: 0 });
  });

  test("getReputation resolves normative storage-program AttestationRefs by locator", async () => {
    const { adapter, store } = memAdapter();
    const listingRef = await anchorListing(store);
    const listing = store.get(listingRef)!;

    const buyerSeed = Uint8Array.from(Buffer.alloc(32, 7));
    const buyerPriv = privateKeyFromSeed(buyerSeed);
    const buyerHex = Buffer.from(rawPublicKey(publicKeyFromSeed(buyerSeed))).toString("hex");
    const normativeBuyerDid = `did:demos:agent:${buyerHex}`;
    const agreement = await buildSignedArtifact(
      {
        jobId: "normative-ref-job",
        pattern: "fixed-price",
        buyer: normativeBuyerDid,
        seller: sellerDid,
        listingRef,
        price: TERMS.price,
        delivery: { phase: TERMS.deliveryPhase, format: TERMS.deliveryFormat },
        expiresAt: "2026-08-10T12:00:00.000Z",
      },
      ARTIFACT_SEPARATORS.AgreementDocument,
      (bytes) => ed25519Sign(bytes, buyerPriv),
    );
    store.set("stor:agreement", agreement as Record<string, unknown>);

    const unsigned = {
      faultBundleVersion: "1" as const,
      faultedParty: "none" as const,
      jobId: "normative-ref-job",
      outcome: "completed" as const,
      anchoredByRole: "buyer" as const,
      listingRef: {
        listingId: "svc",
        version: 1,
        contentHash: contentHash(stripSignature(listing)),
      },
      agreementRef: {
        anchor: { kind: "storage-program" as const, locator: "stor:agreement" },
        contentHash: contentHash(stripSignature(agreement)),
      },
      parties: [
        { role: "buyer", bundleHash: "a".repeat(64), primaryClaim: normativeBuyerDid },
        { role: "seller", bundleHash: "b".repeat(64), primaryClaim: sellerDid },
      ],
      phaseSummary: [],
      vetRecords: [],
      settlementEvidence: [],
      recipeRegistryVersion: 1,
      railRegistryVersion: 1,
      finalisedAt: 1786363200000,
    };
    const signedScope: Record<string, unknown> = { ...unsigned };
    delete signedScope.anchoredByRole;
    const hash = contentHash(signedScope);
    const payload = signedBytes(ARTIFACT_SEPARATORS.FaultAttestationBundle, hash);
    store.set("stor:bundle", {
      ...unsigned,
      signatures: [
        {
          party: normativeBuyerDid,
          algorithm: "ed25519",
          value: Buffer.from(ed25519Sign(payload, buyerPriv)).toString("base64url"),
        },
        {
          party: sellerDid,
          algorithm: "ed25519",
          value: Buffer.from(ed25519Sign(payload, sellerPriv)).toString("base64url"),
        },
      ],
    });

    const agent = buildAgent(adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: { agentId: normativeBuyerDid },
    });
    await expect(agent.getReputation(normativeBuyerDid, ["stor:bundle"]))
      .resolves.toMatchObject({ totalAgreements: 1, completed: 1 });
  });
});
