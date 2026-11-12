import { describe, expect, test, vi } from "vitest";

import {
  buildAgent,
} from "../../src/agent/Agent.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import {
  signComponentArtifact,
} from "../../src/artifacts/signatures.js";
import type {
  CompositeVerificationRecord,
  IdentityBundle,
} from "../../src/artifacts/types.js";
import {
  contentHash,
  listingAddress,
  logicalToStorageProgramName,
  stripSignature,
} from "../../src/canonical/index.js";
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
import type { SubstrateAdapter } from "../../src/substrate/SubstrateAdapter.js";
import { verifySettlementEvidence } from "../../src/agent/verifySettlementEvidence.js";

// The public Agent reads listings and verifies bundles through the listing
// verifier that createAgent() wires from its configuration.

const SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 3));
const BUYER_SEED = Uint8Array.from(Buffer.alloc(32, 7));
const sellerPriv = privateKeyFromSeed(SELLER_SEED);
const buyerPriv = privateKeyFromSeed(BUYER_SEED);
const sellerPublicKey = rawPublicKey(publicKeyFromSeed(SELLER_SEED));
const sellerHex = Buffer.from(sellerPublicKey).toString("hex");
const sellerDid = `did:demos:agent:${sellerHex}`;
const buyerPublicKey = rawPublicKey(publicKeyFromSeed(BUYER_SEED));
const buyerHex = Buffer.from(buyerPublicKey).toString("hex");
const buyerDid = `did:demos:agent:${buyerHex}`;

function signedIdentityBundle(
  presentedBy: string,
  privateKey: typeof buyerPriv,
): IdentityBundle {
  const bundle: IdentityBundle = {
    bundleVersion: "1",
    presentedBy,
    presentedAt: 1_780_000_000_000,
    claims: [{ ref: presentedBy }],
    presentation: {
      kind: "per-claim",
      signatures: [{ ref: presentedBy, signature: "pending" }],
    },
  };
  if (bundle.presentation.kind !== "per-claim") throw new Error("fixture drift");
  bundle.presentation.signatures[0]!.signature = Buffer.from(
    ed25519Sign(
      signedBytes("dacs-bundle-presentation:v1:", identityBundleHash(bundle)),
      privateKey,
    ),
  ).toString("base64url");
  return bundle;
}

const buyerIdentity = signedIdentityBundle(buyerDid, buyerPriv);

/** In-memory adapter — just the surface the public Agent reads touch. */
function memAdapter(options: { failBundleOnce?: boolean } = {}) {
  const store = new Map<string, Record<string, unknown>>();
  let bundleFailed = false;
  const getPublicKey = vi.fn(async () => Uint8Array.from(buyerPublicKey));
  const resolveAnchorByName = vi.fn(async (name: string) => {
    const address = `stor:${name}`;
    return store.has(address)
      ? { status: "present" as const, address }
      : { status: "absent" as const };
  });
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
    resolveAnchorByName,
  } as unknown as SubstrateAdapter;
  return { adapter, store, getPublicKey, resolveAnchorByName };
}

async function anchorListing(
  store: Map<string, Record<string, unknown>>,
  priv = sellerPriv,
  agentId = sellerDid,
  validity: { notBefore: number; notAfter?: number } = {
    notBefore: 1_700_000_000_000,
  },
  description = "d",
  payment: {
    phase: "pay-x402" | "pay-dem";
    railId: string;
    currency: string;
    price: string;
  } = {
    phase: "pay-x402",
    railId: "x402:default",
    currency: "USDC",
    price: "1",
  },
  additionalClaims: string[] = [],
) {
  const identity: IdentityBundle = {
    bundleVersion: "1",
    presentedBy: agentId,
    presentedAt: 1_780_000_000_000,
    claims: [{ ref: agentId }, ...additionalClaims.map((ref) => ({ ref }))],
    presentation: {
      kind: "per-claim",
      signatures: [
        { ref: agentId, signature: "pending" },
        ...additionalClaims.map((ref) => ({
          ref,
          signature: "additional-claim-proof",
        })),
      ],
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
        description,
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
        { kind: payment.phase, parameters: { rail: payment.railId } },
        { kind: "deliver-attested-payload" },
      ],
      pricing: {
        kind: "fixed",
        price: { amount: payment.price, currency: payment.currency },
      },
      acceptedRails: [{ railId: payment.railId }],
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
  store.set(
    `stor:${logicalToStorageProgramName(listingAddress(agentId, "svc", 1))}`,
    signed as Record<string, unknown>,
  );
  return "stor:listing";
}

describe("public Agent surface: listing discovery, bundle verification and reputation", () => {
  test("rejects a configured bundle for a different agent at construction", () => {
    const { adapter } = memAdapter();
    expect(() => buildAgent(adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: { agentId: sellerDid, bundle: buyerIdentity },
    })).toThrow(/bundle\.presentedBy must equal/);
  });

  test("public discovery rejects a foreign DID that only ends in the seller key", async () => {
    const { adapter, store } = memAdapter();
    const lookalike = `did:ethr:${sellerHex}`;
    const ref = await anchorListing(store, sellerPriv, lookalike);
    const agent = buildAgent(adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: { agentId: buyerDid, bundle: buyerIdentity },
    });

    await expect(agent.discover([ref])).resolves.toEqual([]);
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
      identity: { agentId: buyerDid, bundle: buyerIdentity },
    });
    await expect(agent.getReputation(buyerDid, ["stor:forged-bundle"]))
      .resolves.toMatchObject({ totalAgreements: 0, completed: 0 });
  });

  test("public verifyBundle/getReputation require authenticated vet and settlement context", async () => {
    const { adapter, store } = memAdapter();
    const listingRef = await anchorListing(store);
    const listing = store.get(listingRef)!;

    const buyerSeed = Uint8Array.from(Buffer.alloc(32, 7));
    const buyerPriv = privateKeyFromSeed(buyerSeed);
    const buyerHex = Buffer.from(rawPublicKey(publicKeyFromSeed(buyerSeed))).toString("hex");
    const normativeBuyerDid = `did:demos:agent:${buyerHex}`;
    const agreementScope = {
      agreementVersion: "1",
      jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7E",
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
    };
    const agreementPayload = signedBytes(
      ARTIFACT_SEPARATORS.AgreementDocument,
      contentHash(agreementScope),
    );
    const agreement = {
      ...agreementScope,
      signatures: [
        {
          party: normativeBuyerDid,
          algorithm: "ed25519",
          value: Buffer.from(
            ed25519Sign(agreementPayload, buyerPriv),
          ).toString("base64url"),
        },
        {
          party: sellerDid,
          algorithm: "ed25519",
          value: Buffer.from(
            ed25519Sign(agreementPayload, sellerPriv),
          ).toString("base64url"),
        },
      ],
    };
    store.set("stor:agreement", agreement as Record<string, unknown>);

    const evidence = await signComponentArtifact(
      {
        evidenceVersion: "1" as const,
        jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7E",
        phase: "pay-x402" as const,
        outcome: "success" as const,
        paymentTxRefs: [
          {
            kind: "x402" as const,
            httpResource: "https://seller.example/pay",
            paymentReceiptHash: "1".repeat(64),
            settlementTxHash: "0xabc",
            chainId: 84532,
            protocolVersion: "1",
          },
        ],
        paymentAmount: { amount: "1", currency: "USDC" },
        settlementFinality: {
          model: "block-depth" as const,
          finalityBlocks: 1,
          finalityObservedAt: 1786363150000,
        },
        observedAt: 1786363150000,
      },
      ARTIFACT_SEPARATORS.SettlementEvidence,
      {
        algorithm: "ed25519",
        signer: sellerDid,
        sign: (bytes) => ed25519Sign(bytes, sellerPriv),
      },
    );
    const evidenceRef = {
      anchor: {
        kind: "storage-program" as const,
        locator:
          "dacs4:payment:01J8ME0SXKQ4T9V2RC5HJ6WX7E:x402%3Adefault:0",
      },
      contentHash: contentHash(stripSignature(evidence)),
    };
    const directEvidenceVerdict = await verifySettlementEvidence(
      evidence,
      {
        orchestrator: sellerDid,
        agreement: { amount: "1", currency: "USDC" },
        rail: {
          railId: "x402:default",
          railType: "x402",
          asset: "USDC",
          handler: "pay-x402",
          network: "eip155:84532",
        },
        attestationRef: evidenceRef,
        paymentAddress: {
          railId: "x402:default",
          phaseIndex: 0,
        },
        result: { ok: true, txRefs: evidence.paymentTxRefs },
      },
      {
        resolvePublicKey: async () => sellerPublicKey,
        verify: (bytes, signature, publicKey) =>
          ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
      },
    );
    expect(
      directEvidenceVerdict.decision,
      directEvidenceVerdict.reasons.join("; "),
    ).toBe("pass");
    const nativeEvidence = "stor-" + "e".repeat(40);
    store.set(nativeEvidence, evidence as unknown as Record<string, unknown>);
    // Verified SR-2 receipt for the PC-2 anchor, written by the pay-phase
    // orchestrator (the seller), as DACS-5 SEB-3 requires.
    const resolveAttestationAnchorReceipt = () => ({
      receiptVersion: "1" as const,
      substrate: "demos",
      finalityProfile: "demos-bft-confirmed-native-read",
      logicalAddress: evidenceRef.anchor.locator,
      nativeAddress: nativeEvidence,
      contentHash: evidenceRef.contentHash,
      transactionRef: { kind: "demos-storage-program", value: "0x" + "7".repeat(64) },
      writer: sellerDid,
      nonce: "3",
      state: "finalized" as const,
      observationDisposition: "established" as const,
      observedAt: 1786363150000,
      blockRef: { id: "0x" + "8".repeat(64), height: "12", timestamp: 1786363150000 },
      evidence: { kind: "demos-bft-write-proof-v1", value: "e30" },
    });

    const composite: CompositeVerificationRecord = {
      recordVersion: "1",
      jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7E",
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
      jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7E",
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
      phaseSummary: [
        {
          index: 0,
          kind: "pay-x402" as const,
          outcome: "ok" as const,
          txRefs: structuredClone(evidence.paymentTxRefs),
          attestationRef: evidenceRef,
        },
      ],
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
      settlementEvidence: [evidenceRef],
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
      resolveAttestationAnchorReceipt,
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
    expect(
      unconfiguredVerdict.refs.find(
        (entry) => entry.kind === "dacs-4-evidence",
      ),
    ).toMatchObject({ verdict: "signature-unresolved" });
    await expect(
      unconfiguredAgent.getReputation(normativeBuyerDid, ["stor:bundle"]),
    ).resolves.toMatchObject({ totalAgreements: 0, completed: 0 });

    let verifierCalls = 0;
    let evidenceContextCalls = 0;
    const agent = buildAgent(adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: { agentId: normativeBuyerDid },
      resolveAttestationAnchorReceipt,
      verifyCompositeRecord: async (record, bundle) => {
        verifierCalls += 1;
        expect(bundle.jobId).toBe("01J8ME0SXKQ4T9V2RC5HJ6WX7E");
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
      resolveSettlementEvidenceContext: async (input) => {
        evidenceContextCalls += 1;
        expect(input.evidence.phase).toBe("pay-x402");
        expect(input.bundle.jobId).toBe("01J8ME0SXKQ4T9V2RC5HJ6WX7E");
        expect(input.agreement.jobId).toBe("01J8ME0SXKQ4T9V2RC5HJ6WX7E");
        expect(input.evidenceRef).toEqual(evidenceRef);
        return {
          orchestrator: sellerDid,
          rail: {
            railId: "x402:default",
            railType: "x402",
            asset: "USDC",
            handler: "pay-x402",
            network: "eip155:84532",
          },
        };
      },
    });
    const configuredVerdict = await agent.verifyBundle("stor:bundle");
    expect(evidenceContextCalls).toBe(1);
    expect(configuredVerdict.reason).toBeUndefined();
    expect(configuredVerdict).toMatchObject({
      ok: true,
      fullyVerified: true,
    });
    await expect(agent.getReputation(normativeBuyerDid, ["stor:bundle"]))
      .resolves.toMatchObject({ totalAgreements: 1, completed: 1 });
    expect(verifierCalls).toBe(2);
    expect(evidenceContextCalls).toBe(2);

    // CORE §5.1 SR2-12: an otherwise fully configured Agent whose host holds
    // no receipt reports the PC-2 anchor unresolved, not missing, and excludes it.
    const noReceiptAgent = buildAgent(adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: { agentId: normativeBuyerDid },
      resolveAttestationAnchorReceipt: () => null,
      verifyCompositeRecord: async (record) => ({
        status: "valid",
        record: structuredClone(record),
        freshness: [],
        dealSpecific: [],
        freshnessRecipes: [],
        dealSpecificRecipes: [],
      }),
      resolveSettlementEvidenceContext: async () => ({
        orchestrator: sellerDid,
        rail: {
          railId: "x402:default",
          railType: "x402",
          asset: "USDC",
          handler: "pay-x402",
          network: "eip155:84532",
        },
      }),
    });
    const noReceiptVerdict = await noReceiptAgent.verifyBundle("stor:bundle");
    expect(noReceiptVerdict.ok).toBe(false);
    expect(
      noReceiptVerdict.refs.find((entry) => entry.kind === "dacs-4-evidence"),
    ).toMatchObject({ verdict: "unresolved" });
    await expect(
      noReceiptAgent.getReputation(normativeBuyerDid, ["stor:bundle"]),
    ).resolves.toMatchObject({ totalAgreements: 0, completed: 0 });

    const suffixAlias = `did:ethr:${sellerHex}`;
    const { signature: _originalEvidenceSignature, ...evidenceBody } = evidence;
    const aliasedEvidence = await signComponentArtifact(
      evidenceBody,
      ARTIFACT_SEPARATORS.SettlementEvidence,
      {
        algorithm: "ed25519",
        signer: suffixAlias,
        sign: (bytes) => ed25519Sign(bytes, sellerPriv),
      },
    );
    const aliasedEvidenceRef = {
      anchor: {
        kind: "storage-program" as const,
        locator: "stor:aliased-settlement-evidence",
      },
      contentHash: contentHash(stripSignature(aliasedEvidence)),
    };
    store.set(
      aliasedEvidenceRef.anchor.locator,
      aliasedEvidence as unknown as Record<string, unknown>,
    );
    const aliasedUnsigned = {
      ...unsigned,
      settlementEvidence: [aliasedEvidenceRef],
    };
    const aliasedSignedScope: Record<string, unknown> = { ...aliasedUnsigned };
    delete aliasedSignedScope.anchoredByRole;
    const aliasedPayload = signedBytes(
      ARTIFACT_SEPARATORS.FaultAttestationBundle,
      contentHash(aliasedSignedScope),
    );
    store.set("stor:aliased-bundle", {
      ...aliasedUnsigned,
      signatures: [
        {
          party: normativeBuyerDid,
          algorithm: "ed25519",
          value: Buffer.from(ed25519Sign(aliasedPayload, buyerPriv))
            .toString("base64url"),
        },
        {
          party: sellerDid,
          algorithm: "ed25519",
          value: Buffer.from(ed25519Sign(aliasedPayload, sellerPriv))
            .toString("base64url"),
        },
      ],
    });
    let aliasKeyResolutions = 0;
    const aliasAgent = buildAgent(adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: { agentId: normativeBuyerDid },
      resolveIdentitySigningPublicKey: async (claim) => {
        if (claim !== suffixAlias) return null;
        aliasKeyResolutions += 1;
        return aliasKeyResolutions === 1 ? sellerPublicKey : null;
      },
      verifyCompositeRecord: async (record) => ({
        status: "valid",
        record: structuredClone(record),
        freshness: [],
        dealSpecific: [],
        freshnessRecipes: [],
        dealSpecificRecipes: [],
      }),
      resolveSettlementEvidenceContext: async () => ({
        orchestrator: suffixAlias,
        rail: {
          railId: "x402:default",
          railType: "x402",
          asset: "USDC",
          handler: "pay-x402",
          network: "eip155:84532",
        },
      }),
    });
    const aliasVerdict = await aliasAgent.verifyBundle("stor:aliased-bundle");
    // Suffix-key aliases are rejected before the external resolver is invoked.
    expect(aliasKeyResolutions).toBe(0);
    expect(aliasVerdict.ok).toBe(false);
    expect(
      aliasVerdict.refs.find((entry) => entry.kind === "dacs-4-evidence"),
    ).toMatchObject({ verdict: "signature-unresolved" });
  });

  test("public verifyBundle owner-resolves a normative pre-commit abort Listing", async () => {
    const { adapter, store, resolveAnchorByName } = memAdapter();
    const listingAddressRef = await anchorListing(store);
    const listing = store.get(listingAddressRef)!;
    const listingRef = {
      listingId: "svc",
      version: 1,
      contentHash: contentHash(stripSignature(listing)),
    };
    const unsigned = {
      bundleVersion: "1" as const,
      jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7E",
      outcome: "aborted-by-self" as const,
      anchoredByRole: "buyer" as const,
      listingRef,
      cancellation: { claimedPolicy: "pre-commit" },
      parties: [
        {
          role: "buyer" as const,
          bundleHash: "a".repeat(64),
          primaryClaim: buyerDid,
        },
        {
          role: "seller" as const,
          bundleHash: "b".repeat(64),
          primaryClaim: sellerDid,
        },
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
    const signature = ed25519Sign(
      signedBytes(
        ARTIFACT_SEPARATORS.AttestationBundle,
        contentHash(signedScope),
      ),
      buyerPriv,
    );
    store.set("stor:pre-commit-bundle", {
      ...unsigned,
      signatures: [
        {
          party: buyerDid,
          algorithm: "ed25519",
          value: Buffer.from(signature).toString("base64url"),
        },
      ],
    });

    const agent = buildAgent(adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: { agentId: buyerDid, bundle: buyerIdentity },
    });
    const result = await agent.verifyBundle("stor:pre-commit-bundle");
    expect(result.ok).toBe(true);
    expect(
      result.refs.find((ref) => ref.kind === "dacs-1-listing")?.verdict,
    ).toBe("ok");
    expect(resolveAnchorByName).toHaveBeenCalledWith(
      logicalToStorageProgramName(listingAddress(sellerDid, "svc", 1)),
      sellerHex,
    );
  });

  test("bundle verification and reputation reject non-canonical signer aliases", async () => {
    const { adapter, store } = memAdapter();
    const listingAddressRef = await anchorListing(store);
    const listing = store.get(listingAddressRef)!;
    const agent = buildAgent(adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: { agentId: buyerDid },
    });
    for (const [index, buyerLookalike, reputationClaim] of [
      [0, `did:ethr:${buyerHex}`, `did:ethr:${buyerHex}`],
      [1, `DID:demos:agent:${buyerHex}`, buyerDid],
    ] as const) {
      const ref = `stor:noncanonical-signer-bundle:${index}`;
      const unsigned = {
        bundleVersion: "1" as const,
        jobId: index === 0
          ? "01J8ME0SXKQ4T9V2RC5HJ6WX7F"
          : "01J8ME0SXKQ4T9V2RC5HJ6WX7G",
        outcome: "aborted-by-self" as const,
        anchoredByRole: "buyer" as const,
        listingRef: {
          listingId: "svc",
          version: 1,
          contentHash: contentHash(stripSignature(listing)),
        },
        cancellation: { claimedPolicy: "pre-commit" },
        parties: [
          {
            role: "buyer" as const,
            bundleHash: "a".repeat(64),
            primaryClaim: buyerLookalike,
          },
          {
            role: "seller" as const,
            bundleHash: "b".repeat(64),
            primaryClaim: sellerDid,
          },
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
      const signature = ed25519Sign(
        signedBytes(
          ARTIFACT_SEPARATORS.AttestationBundle,
          contentHash(signedScope),
        ),
        buyerPriv,
      );
      store.set(ref, {
        ...unsigned,
        signatures: [{
          party: buyerLookalike,
          algorithm: "ed25519",
          value: Buffer.from(signature).toString("base64url"),
        }],
      });

      const verification = await agent.verifyBundle(ref);
      expect(verification.ok).toBe(false);
      expect(verification.fullyVerified).toBe(false);
      expect(verification.signatures).toContainEqual({
        party: buyerLookalike,
        verdict: "unverified",
      });
      await expect(agent.getReputation(reputationClaim, [ref]))
        .resolves.toMatchObject({ totalAgreements: 0, completed: 0 });
    }
  });
});

// These unit tests exercise settlement rules with injected capabilities.
vi.mock("../../src/rails/payDemExecutionAuthority.js", async () =>
  import("../support/payDemExecutionAuthority.js"));
