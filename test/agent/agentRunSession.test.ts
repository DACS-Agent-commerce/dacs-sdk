import { describe, expect, test } from "vitest";

import { buildAgent } from "../../src/agent/Agent.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import {
  signComponentArtifact,
  verifyComponentSignature,
} from "../../src/artifacts/signatures.js";
import type {
  CompositeVerificationRecord,
  IdentityBundle,
} from "../../src/artifacts/types.js";
import {
  contentHash,
  encodeAddressSegment,
  listingAddress,
  logicalToStorageProgramName,
  stripSignature,
} from "../../src/canonical/index.js";
import { isListing } from "../../src/artifacts/validators.js";
import type { VetProduction } from "../../src/agent/vetCore.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
  signedBytes,
} from "../../src/crypto/index.js";
import { identityBundleHash } from "../../src/identity/bundle.js";
import type { ListingValidationDeps } from "../../src/agent/listingValidation.js";
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
function memAdapter() {
  const store = new Map<string, Record<string, unknown>>();
  const adapter = {
    store,
    sign: async (bytes: Uint8Array) => ed25519Sign(bytes, buyerPriv),
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
  price: {
    amount: "1000000",
    asset: "USDC",
    decimals: 6,
    rail: "x402:default",
  },
  deliveryPhase: "deliver-attested-payload",
  deliveryFormat: "application/json",
};

async function anchorListing(store: Map<string, Record<string, unknown>>, priv = sellerPriv, agentId = sellerDid) {
  const identity: IdentityBundle = {
    bundleVersion: "1",
    presentedBy: agentId,
    presentedAt: 1_780_000_000_000,
    claims: [{ ref: agentId }],
    presentation: {
      kind: "per-claim",
      signatures: [{ ref: agentId, signature: "pending" }],
    },
  };
  if (identity.presentation.kind !== "per-claim") {
    throw new Error("fixture drift");
  }
  identity.presentation.signatures[0]!.signature = Buffer.from(
    ed25519Sign(
      signedBytes("dacs-bundle-presentation:v1:", identityBundleHash(identity)),
      priv,
    ),
  ).toString("base64url");
  const signed = await signComponentArtifact(
    {
      dacsVersion: "1",
      listingVersion: 1,
      listingId: "svc",
      seller: {
        identity,
        displayName: "Market Data",
        publicEndpoint: "https://seller.example/dacs",
      },
      offering: {
        title: "Market Data",
        description: "d",
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
      pricing: {
        kind: "fixed",
        price: { amount: "1", currency: "USDC" },
      },
      acceptedRails: [{ railId: "x402:default" }],
      terms: { deadlineSecAfterCommit: 3_600 },
      validity: { notBefore: 1_700_000_000_000 },
    },
    ARTIFACT_SEPARATORS.Listing,
    {
      algorithm: "ed25519",
      signer: agentId,
      sign: (bytes) => ed25519Sign(bytes, priv),
    },
  );
  store.set("stor:listing", signed as Record<string, unknown>);
  store.set(
    `stor:${logicalToStorageProgramName(listingAddress(agentId, "svc", 1))}`,
    signed as Record<string, unknown>,
  );
  return "stor:listing";
}

function listingValidationDeps(): ListingValidationDeps {
  return {
    nowMs: () => 1_780_000_000_000,
    verifyListingSignature: ({ signedBytes: bytes, signature }) =>
      signature.signer === sellerDid &&
      ed25519Verify(
        bytes,
        Uint8Array.from(Buffer.from(signature.value, "base64url")),
        publicKeyFromRaw(sellerPublicKey),
      ),
    revocation: {
      surfaces: [{
        kind: "well-known",
        status: "active",
        integrity: "verified",
      }],
      readMarker: async () => null,
      verifyMarkerSignature: () => false,
    },
    verifyIdentityPresentation: ({ bundle, signedBytes: bytes }) => {
      if (bundle.presentation.kind !== "per-claim") return false;
      const proof = bundle.presentation.signatures.find(
        (candidate) => candidate.ref === bundle.presentedBy,
      );
      return bundle.presentedBy === sellerDid && !!proof &&
        ed25519Verify(
          bytes,
          Uint8Array.from(Buffer.from(proof.signature, "base64url")),
          publicKeyFromRaw(sellerPublicKey),
        );
    },
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
    resolvePayloadVerificationCapability: () => ({
      disposition: "supported",
    }),
    verifySellerControl: ({ bundle, signer }) =>
      bundle.presentedBy === sellerDid && signer === sellerDid,
  };
}

describe("Agent.runSession wires the #41 listing verifier (public surface)", () => {
  test("a genuinely signed listing settles through the public runSession", async () => {
    const { adapter, store } = memAdapter();
    const ref = await anchorListing(store);
    const agent = buildAgent(adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: { agentId: buyerDid },
      listingValidationDeps: listingValidationDeps(),
    });

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

  test("a listing signed by the WRONG key aborts before settlement — never pays", async () => {
    const { adapter, store } = memAdapter();
    // Signed by a different key than the advertised sellerDid.
    const ref = await anchorListing(store, privateKeyFromSeed(Uint8Array.from(Buffer.alloc(32, 9))));
    const agent = buildAgent(adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: { agentId: buyerDid },
      listingValidationDeps: listingValidationDeps(),
    });

    let settled = false;
    await expect(
      agent.runSession(ref, {
        terms: TERMS,
        settle: async () => {
          settled = true;
          return { ok: true, txHash: "0x", chainId: "c", payer: "p", payee: "q" };
        },
      }),
    ).rejects.toThrow(/reader step 4 \(listing-signature-invalid\)/);
    expect(settled).toBe(false);
  });

  test("public RunSessionOptions wires caller-held Vet finality authentication", async () => {
    const { adapter, store } = memAdapter();
    const ref = await anchorListing(store);
    const agent = buildAgent(adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: { agentId: buyerDid },
    });
    let finalityCalls = 0;
    let settleCalls = 0;

    await expect(
      agent.runSession(ref, {
        terms: TERMS,
        jobId: "public-vet-finality",
        validateListing: verifiedAdmission,
        vet: async ({ jobId, evaluatedParty }): Promise<VetProduction> => {
          const record: CompositeVerificationRecord = {
            recordVersion: "1",
            jobId,
            evaluatedParty,
            bundleHash: "a".repeat(64),
            requirementHash: "b".repeat(64),
            freshness: [],
            supplementary: [],
            dealSpecific: [],
            overallDecision: "pass",
            generatedAt: 1780000000000,
            signature: {
              algorithm: "ed25519",
              signer: buyerDid,
              value: "AA",
            },
          };
          const logicalAddress =
            `dacs2:composite:${encodeAddressSegment(jobId)}:` +
            encodeAddressSegment(evaluatedParty);
          const nativeAddress = `stor:${logicalAddress}`;
          const hash = contentHash(
            record as unknown as Record<string, unknown>,
          );
          store.set(
            nativeAddress,
            structuredClone(record) as unknown as Record<string, unknown>,
          );
          return {
            record,
            recordRef: {
              anchor: { kind: "storage-program", locator: nativeAddress },
              contentHash: hash,
            },
            anchorReceipt: {
              receiptVersion: "1",
              substrate: "test",
              finalityProfile: "instant",
              logicalAddress,
              nativeAddress,
              contentHash: hash,
              transactionRef: { kind: "test", value: "tx:vet" },
              writer: buyerDid,
              state: "finalized",
              observationDisposition: "established",
              observedAt: 1780000000000,
              blockRef: { id: "block:vet" },
              evidence: { kind: "test-proof", value: "authenticated" },
            },
          };
        },
        verifyVetRecord: async (record) => ({
          status: "valid",
          record: record as CompositeVerificationRecord,
          freshness: [],
          dealSpecific: [],
          freshnessRecipes: [],
          dealSpecificRecipes: [],
        }),
        authenticateVetFinality: async ({ claimed }) => {
          finalityCalls += 1;
          return claimed ? structuredClone(claimed) : null;
        },
        settle: async () => {
          settleCalls += 1;
          return {
            ok: true,
            txHash: "0xpublicvet",
            chainId: "test",
            payer: buyerDid,
            payee: sellerDid,
          };
        },
      }),
    ).resolves.toMatchObject({ outcome: "completed" });
    expect(finalityCalls).toBe(1);
    expect(settleCalls).toBe(1);
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

  test("public verifyBundle/getReputation require the configured strict verifier for normative vet records", async () => {
    const { adapter, store } = memAdapter();
    const listingRef = await anchorListing(store);
    const listing = store.get(listingRef)!;

    const buyerSeed = Uint8Array.from(Buffer.alloc(32, 7));
    const buyerPriv = privateKeyFromSeed(buyerSeed);
    const buyerHex = Buffer.from(rawPublicKey(publicKeyFromSeed(buyerSeed))).toString("hex");
    const normativeBuyerDid = `did:demos:agent:${buyerHex}`;
    const agreement = {
      agreementVersion: "1",
      jobId: "normative-ref-job",
      listingRef: {
        listingId: "svc",
        version: 1,
        contentHash: contentHash(stripSignature(listing)),
      },
      parties: [
        {
          role: "buyer",
          bundleHash: "a".repeat(64),
          primaryClaim: normativeBuyerDid,
          vetRecordRef: {
            anchor: { kind: "storage-program", locator: "stor:buyer-vet" },
            contentHash: "c".repeat(64),
          },
        },
        {
          role: "seller",
          bundleHash: "b".repeat(64),
          primaryClaim: sellerDid,
          vetRecordRef: {
            anchor: { kind: "storage-program", locator: "stor:seller-vet" },
            contentHash: "d".repeat(64),
          },
        },
      ],
      terms: {
        deliverable: { deliverableType: "attested-payload", hash: "e".repeat(64) },
        price: { amount: "1", currency: "USDC" },
        rail: { railId: "x402:default" },
        deadline: 1786366800000,
      },
      derivedFromPattern: "fixed-price",
      generatedAt: 1786363200000,
      signatures: [
        {
          party: normativeBuyerDid,
          algorithm: "ed25519",
          value: Buffer.alloc(64, 7).toString("base64url"),
        },
        {
          party: sellerDid,
          algorithm: "ed25519",
          value: Buffer.alloc(64, 8).toString("base64url"),
        },
      ],
    };
    store.set("stor:agreement", agreement as Record<string, unknown>);

    const composite: CompositeVerificationRecord = {
      recordVersion: "1",
      jobId: "normative-ref-job",
      evaluatedParty: sellerDid,
      bundleHash: "b".repeat(64),
      requirementHash: "f".repeat(64),
      freshness: [],
      supplementary: [],
      dealSpecific: [],
      overallDecision: "pass",
      generatedAt: 1786363100000,
      signature: {
        algorithm: "ed25519",
        signer: normativeBuyerDid,
        value: "AA",
      },
    };
    store.set(
      "stor:composite",
      composite as unknown as Record<string, unknown>,
    );

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
      vetRecords: [
        {
          anchor: {
            kind: "storage-program" as const,
            locator: "stor:composite",
          },
          contentHash: contentHash(
            composite as unknown as Record<string, unknown>,
          ),
        },
      ],
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

    const unconfiguredAgent = buildAgent(adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: { agentId: normativeBuyerDid },
    });
    const unconfiguredVerdict = await unconfiguredAgent.verifyBundle(
      "stor:bundle",
    );
    expect(unconfiguredVerdict.ok).toBe(false);
    expect(
      unconfiguredVerdict.refs.find(
        (entry) => entry.kind === "dacs-2-composite",
      ),
    ).toMatchObject({ verdict: "invalid-vet-record" });
    await expect(
      unconfiguredAgent.getReputation(normativeBuyerDid, ["stor:bundle"]),
    ).resolves.toMatchObject({ totalAgreements: 0, completed: 0 });

    let verifierCalls = 0;
    const agent = buildAgent(adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: { agentId: normativeBuyerDid },
      verifyCompositeRecord: async (record, bundle) => {
        verifierCalls += 1;
        expect(bundle.jobId).toBe("normative-ref-job");
        expect(record.evaluatedParty).toBe(sellerDid);
        return {
          status: "valid",
          record: structuredClone(record),
          freshness: [],
          dealSpecific: [],
          freshnessRecipes: [],
          dealSpecificRecipes: [],
        };
      },
    });
    await expect(agent.verifyBundle("stor:bundle")).resolves.toMatchObject({
      ok: true,
      fullyVerified: true,
    });
    await expect(agent.getReputation(normativeBuyerDid, ["stor:bundle"]))
      .resolves.toMatchObject({ totalAgreements: 1, completed: 1 });
    expect(verifierCalls).toBe(2);
  });
});
