import { describe, expect, test } from "vitest";

import { buildAgent } from "../../src/agent/Agent.js";
import { buildSignedArtifact } from "../../src/agent/signedArtifact.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import { contentHash, stripSignature } from "../../src/canonical/index.js";
import {
  ed25519Sign,
  privateKeyFromSeed,
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
const sellerPriv = privateKeyFromSeed(SELLER_SEED);
const sellerHex = Buffer.from(rawPublicKey(publicKeyFromSeed(SELLER_SEED))).toString("hex");
const sellerDid = `did:demos:agent:${sellerHex}`;
const buyerDid = "did:demos:agent:buyer";

/** In-memory adapter — just the surface buildAgent's runSession path touches. */
function memAdapter() {
  const store = new Map<string, Record<string, unknown>>();
  const adapter = {
    store,
    sign: async () => new Uint8Array(64), // buyer's artifact/bundle signature (not verified here)
    anchor: async (name: string, value: object) => {
      const address = `stor:${name}`;
      store.set(address, value as Record<string, unknown>);
      return { address, txRef: `tx:${address}` };
    },
    anchorAddress: async (name: string) => `stor:${name}`,
    readAnchor: async (address: string) => store.get(address) ?? null,
    // #70 surface: resume resolution is BY NAME, owner-bound. The mem adapter's
    // addresses are deterministic (`stor:<name>`), so resolution is a lookup.
    getAddress: () => buyerDid,
    resolveAnchorByName: async (name: string) => {
      const address = `stor:${name}`;
      return store.has(address)
        ? { status: "present" as const, address }
        : { status: "absent" as const };
    },
  } as unknown as SubstrateAdapter;
  return { adapter, store };
}

const TERMS = {
  price: { amount: "1000000", asset: "USDC", decimals: 6, rail: "pay-x402" },
  deliveryPhase: "deliver-attested-payload",
  deliveryFormat: "application/json",
};

async function anchorListing(store: Map<string, Record<string, unknown>>, priv = sellerPriv, agentId = sellerDid) {
  const signed = await buildSignedArtifact(
    {
      agentId,
      serviceId: "svc",
      name: "Market Data",
      description: "d",
      claimRequirements: [],
      supportedNegotiation: ["negotiate-fixed-price"],
      supportedPaymentRails: ["pay-x402"],
      supportedDelivery: ["deliver-attested-payload"],
    },
    ARTIFACT_SEPARATORS.Listing,
    (b) => ed25519Sign(b, priv),
  );
  store.set("stor:listing", signed as Record<string, unknown>);
  return "stor:listing";
}

async function anchorReputationBundle(
  store: Map<string, Record<string, unknown>>,
  input: {
    ref: string;
    jobId: string;
    observedAt: number;
    buyerDid: string;
    buyerPriv: ReturnType<typeof privateKeyFromSeed>;
    listingRef: string;
    listing: Record<string, unknown>;
  },
): Promise<void> {
  const agreement = await buildSignedArtifact(
    {
      jobId: input.jobId,
      pattern: "fixed-price",
      buyer: input.buyerDid,
      seller: sellerDid,
      listingRef: input.listingRef,
      price: TERMS.price,
      delivery: {
        phase: TERMS.deliveryPhase,
        format: TERMS.deliveryFormat,
      },
      expiresAt: "2026-08-10T12:00:00.000Z",
    },
    ARTIFACT_SEPARATORS.AgreementDocument,
    (bytes) => ed25519Sign(bytes, input.buyerPriv),
  );
  const evidence = {
    evidenceVersion: "1",
    jobId: input.jobId,
    phase: "pay-x402",
    outcome: "success",
    paymentTxRefs: [
      {
        kind: "x402",
        httpResource: "https://seller.example/pay",
        paymentReceiptHash: "c".repeat(64),
        settlementTxHash: `0x${"ab".repeat(32)}`,
        chainId: 84532,
        logIndex: 2,
        protocolVersion: "1",
      },
    ],
    paymentAmount: { amount: "1000000", currency: "USDC" },
    settlementFinality: {
      model: "provider-receipt",
      finalityObservedAt: input.observedAt,
    },
    observedAt: input.observedAt,
    signature: {
      algorithm: "ed25519",
      signer: input.buyerDid,
      value: "AA",
    },
  };
  const agreementLocator = `stor:agreement:${input.jobId}`;
  const evidenceLocator = `stor:evidence:${input.jobId}`;
  const agreementRef = {
    anchor: { kind: "storage-program" as const, locator: agreementLocator },
    contentHash: contentHash(agreement),
  };
  const evidenceRef = {
    anchor: { kind: "storage-program" as const, locator: evidenceLocator },
    contentHash: contentHash(evidence),
  };
  store.set(agreementLocator, agreement as Record<string, unknown>);
  store.set(evidenceLocator, evidence);

  const unsigned = {
    faultBundleVersion: "1" as const,
    faultedParty: "none" as const,
    jobId: input.jobId,
    outcome: "completed" as const,
    anchoredByRole: "buyer" as const,
    listingRef: {
      listingId: "svc",
      version: 1,
      contentHash: contentHash(input.listing),
    },
    agreementRef,
    parties: [
      {
        role: "buyer",
        bundleHash: "a".repeat(64),
        primaryClaim: input.buyerDid,
      },
      {
        role: "seller",
        bundleHash: "b".repeat(64),
        primaryClaim: sellerDid,
      },
    ],
    phaseSummary: [
      {
        index: 0,
        kind: "pay-x402" as const,
        outcome: "ok" as const,
        attestationRef: evidenceRef,
      },
    ],
    vetRecords: [],
    settlementEvidence: [evidenceRef],
    recipeRegistryVersion: 1,
    railRegistryVersion: 1,
    finalisedAt: input.observedAt,
  };
  const signedScope: Record<string, unknown> = { ...unsigned };
  delete signedScope.anchoredByRole;
  const payload = signedBytes(
    ARTIFACT_SEPARATORS.FaultAttestationBundle,
    contentHash(signedScope),
  );
  store.set(input.ref, {
    ...unsigned,
    signatures: [
      {
        party: input.buyerDid,
        algorithm: "ed25519",
        value: Buffer.from(ed25519Sign(payload, input.buyerPriv)).toString("base64url"),
      },
      {
        party: sellerDid,
        algorithm: "ed25519",
        value: Buffer.from(ed25519Sign(payload, sellerPriv)).toString("base64url"),
      },
    ],
  });
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

  test("getReputation excludes the later session that reuses a settlement transaction", async () => {
    const { adapter, store } = memAdapter();
    const listingRef = await anchorListing(store);
    const listing = store.get(listingRef)!;
    const buyerPriv = privateKeyFromSeed(Uint8Array.from(Buffer.alloc(32, 11)));
    const buyerHex = Buffer.from(
      rawPublicKey(publicKeyFromSeed(Uint8Array.from(Buffer.alloc(32, 11)))),
    ).toString("hex");
    const reputationBuyerDid = `did:demos:agent:${buyerHex}`;

    await anchorReputationBundle(store, {
      ref: "stor:bundle:early",
      jobId: "job-early",
      observedAt: 100,
      buyerDid: reputationBuyerDid,
      buyerPriv,
      listingRef,
      listing,
    });
    await anchorReputationBundle(store, {
      ref: "stor:bundle:late",
      jobId: "job-late",
      observedAt: 200,
      buyerDid: reputationBuyerDid,
      buyerPriv,
      listingRef,
      listing,
    });

    const agent = buildAgent(adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: { agentId: reputationBuyerDid },
    });
    await expect(
      agent.getReputation(reputationBuyerDid, [
        "stor:bundle:late",
        "stor:bundle:early",
      ]),
    ).resolves.toMatchObject({ totalAgreements: 1, completed: 1 });
  });
});
