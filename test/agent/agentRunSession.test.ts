import { describe, expect, test, vi } from "vitest";

import {
  buildAgent,
  type AuthenticatedListing,
} from "../../src/agent/Agent.js";
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
import {
  isVerifiedListingAdmission,
  validateListingArtifact,
  type ListingValidationDeps,
} from "../../src/agent/listingValidation.js";
import type { SubstrateAdapter } from "../../src/substrate/SubstrateAdapter.js";
import { x402Settle, type X402Rail } from "../../src/rails/x402.js";
import { payDemSettle, type PayDemRail } from "../../src/rails/payDem.js";
import { verifySettlementEvidence } from "../../src/agent/verifySettlementEvidence.js";

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

/** In-memory adapter — just the surface buildAgent's runSession path touches. */
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
) {
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

function listingValidationDeps(
  nowMs: () => number = () => 1_780_000_000_000,
): ListingValidationDeps {
  return {
    nowMs,
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
      const publicKey = bundle.presentedBy === sellerDid
        ? sellerPublicKey
        : bundle.presentedBy === buyerDid
          ? buyerPublicKey
          : null;
      return publicKey !== null && !!proof &&
        ed25519Verify(
          bytes,
          Uint8Array.from(Buffer.from(proof.signature, "base64url")),
          publicKeyFromRaw(publicKey),
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
  test("rejects a configured bundle for a different agent at construction", () => {
    const { adapter } = memAdapter();
    expect(() => buildAgent(adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: { agentId: sellerDid, bundle: buyerIdentity },
    })).toThrow(/bundle\.presentedBy must equal/);
  });

  test("binds a cross-namespace x402 recipient explicitly and rejects omission before rail submission", async () => {
    const recipientEvm = "0x1111111111111111111111111111111111111111";
    const asset = "0x2222222222222222222222222222222222222222";
    const makeRail = () => {
      const settle = vi.fn(async () => ({
        ok: true,
        txHash: "0xx402-paid",
        chainId: "eip155:84532",
        payer: "0xbuyer",
        payee: recipientEvm,
      }));
      return {
        settle,
        rail: { address: "0xbuyer", settle } as X402Rail,
      };
    };

    const boundAdapter = memAdapter();
    const boundRef = await anchorListing(boundAdapter.store);
    const verifyBuyerPresentation = vi.fn(
      ({ bundle, signedBytes: bytes }: {
        bundle: Readonly<IdentityBundle>;
        signedBytes: Uint8Array;
      }) => {
        if (
          bundle.presentedBy !== buyerDid ||
          bundle.presentation.kind !== "per-claim"
        ) return false;
        const proof = bundle.presentation.signatures.find(
          (candidate) => candidate.ref === buyerDid,
        );
        return !!proof && ed25519Verify(
          bytes,
          Uint8Array.from(Buffer.from(proof.signature, "base64url")),
          publicKeyFromRaw(buyerPublicKey),
        );
      },
    );
    const sellerOnlyValidation = listingValidationDeps();
    sellerOnlyValidation.verifyIdentityPresentation = ({ bundle, signedBytes: bytes }) => {
      if (
        bundle.presentedBy !== sellerDid ||
        bundle.presentation.kind !== "per-claim"
      ) return false;
      const proof = bundle.presentation.signatures.find(
        (candidate) => candidate.ref === sellerDid,
      );
      return !!proof && ed25519Verify(
        bytes,
        Uint8Array.from(Buffer.from(proof.signature, "base64url")),
        publicKeyFromRaw(sellerPublicKey),
      );
    };
    const boundAgent = buildAgent(boundAdapter.adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: {
        agentId: buyerDid,
        bundle: buyerIdentity,
        verifyPresentation: verifyBuyerPresentation,
      },
      listingValidationDeps: sellerOnlyValidation,
    });
    const boundRail = makeRail();
    await expect(
      boundAgent.runSession(boundRef, {
        terms: TERMS,
        expectedSettlementPayee: recipientEvm,
        settle: x402Settle(boundRail.rail, {
          url: "https://seller.example/paywall",
          network: "eip155:84532",
          recipientEvm,
          asset,
        }),
      }),
    ).resolves.toMatchObject({ outcome: "completed" });
    expect(boundRail.settle).toHaveBeenCalledTimes(1);
    expect(verifyBuyerPresentation).toHaveBeenCalledTimes(1);

    const omittedAdapter = memAdapter();
    const omittedRef = await anchorListing(omittedAdapter.store);
    const omittedAgent = buildAgent(omittedAdapter.adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: { agentId: buyerDid, bundle: buyerIdentity },
      listingValidationDeps: listingValidationDeps(),
    });
    const omittedRail = makeRail();
    await expect(
      omittedAgent.runSession(omittedRef, {
        terms: TERMS,
        settle: x402Settle(omittedRail.rail, {
          url: "https://seller.example/paywall",
          network: "eip155:84532",
          recipientEvm,
          asset,
        }),
      }),
    ).rejects.toThrow(/x402 destination mismatch/);
    expect(omittedRail.settle).not.toHaveBeenCalled();
  });

  test("rejects an unauthenticated configured buyer bundle before settlement", async () => {
    const { adapter, store } = memAdapter();
    const ref = await anchorListing(store);
    const settle = vi.fn(async () => ({
      ok: true,
      txHash: "tx-must-not-run",
      chainId: "demos:testnet",
      payer: buyerDid,
      payee: sellerDid,
    }));
    const agent = buildAgent(adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: {
        agentId: buyerDid,
        bundle: buyerIdentity,
        verifyPresentation: () => false,
      },
      listingValidationDeps: listingValidationDeps(),
    });
    const anchorsBefore = store.size;

    await expect(
      agent.runSession(ref, { terms: TERMS, settle }),
    ).rejects.toThrow(/presentation could not be authenticated/);
    expect(settle).not.toHaveBeenCalled();
    expect(store.size).toBe(anchorsBefore);
  });

  test("defaults a normative pay-dem session to the seller Demos claim", async () => {
    const { adapter, store } = memAdapter();
    const ref = await anchorListing(
      store,
      sellerPriv,
      sellerDid,
      { notBefore: 1_700_000_000_000 },
      "native DEM listing",
      {
        phase: "pay-dem",
        railId: "demos:native",
        currency: "DEM",
        price: "1",
      },
    );
    const agent = buildAgent(adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: { agentId: buyerDid, bundle: buyerIdentity },
      listingValidationDeps: {
        ...listingValidationDeps(),
        loadRailResolution: () => ({
          trustPhase: "PA-1" as const,
          trustPolicyAcceptsPA1: true,
          registry: {
            state: "not-used" as const,
            entries: [],
            definitions: [],
          },
          inCodeDefinitions: [{
            railId: "demos:native",
            railVersion: 1,
            phaseHandler: "pay-dem",
            governanceAnchoring: "in-code" as const,
            signatureValid: true,
          }],
        }),
      },
    });
    const transfer = vi.fn(
      async ({ recipient, network }: { recipient: string; network?: string }) => ({
        ok: true,
        txHash: "demos:paid",
        chainId: network ?? "demos",
        payer: buyerDid,
        payee: recipient,
        finality: { model: "bft-final" as const },
        blockNumber: 42,
        txRefKind: "demos",
      }),
    );
    const rail: PayDemRail = { address: buyerDid, settle: transfer };

    await expect(
      agent.runSession(ref, {
        terms: {
          price: {
            amount: "1",
            asset: "DEM",
            decimals: 9,
            rail: "demos:native",
          },
          deliveryPhase: "deliver-attested-payload",
          deliveryFormat: "application/json",
        },
        settle: payDemSettle(rail, { network: "demos:testnet" }),
      }),
    ).resolves.toMatchObject({ outcome: "completed" });
    expect(transfer).toHaveBeenCalledWith({
      recipient: sellerHex,
      amount: "1000000000",
      network: "demos:testnet",
    });
  });

  test("a genuinely signed listing settles through the public runSession", async () => {
    const { adapter, store } = memAdapter();
    const ref = await anchorListing(store);
    const agent = buildAgent(adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: { agentId: buyerDid, bundle: buyerIdentity },
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
    expect(res.profile).toBe("legacy-mvp-settlement-only");
    expect(res.commerceComplete).toBe(false);
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
      identity: { agentId: buyerDid, bundle: buyerIdentity },
      listingValidationDeps: listingValidationDeps(),
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
    const agent = buildAgent(adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: { agentId: buyerDid, bundle: buyerIdentity },
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
        identity: { agentId: buyerDid, bundle: buyerIdentity },
        listingValidationDeps: listingValidationDeps(() => Date.now()),
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

  test("an authenticated normative selection pins content across the pre-payment reread", async () => {
    const { adapter, store } = memAdapter();
    const ref = await anchorListing(store);
    const original = store.get(ref)!;
    if (!isListing(original)) throw new Error("fixture is not a Listing");
    const validation = await validateListingArtifact(
      original,
      listingValidationDeps(),
    );
    if (!isVerifiedListingAdmission(original, validation)) {
      throw new Error("fixture did not pass ordered Listing validation");
    }
    const selected: AuthenticatedListing = {
      status: "verified",
      compatibility: "normative",
      ref,
      logicalAddress: listingAddress(sellerDid, "svc", 1),
      version: 1,
      contentHash: contentHash(original),
      listingPin: {
        listingId: "svc",
        version: 1,
        contentHash: contentHash(original),
      },
      listing: validation.listing,
      validation,
    };

    // A valid, same-seller replacement at the same native ref must not change
    // the exact Listing the buyer selected through the logical index.
    await anchorListing(
      store,
      sellerPriv,
      sellerDid,
      { notBefore: 1_700_000_000_000 },
      "substituted listing",
    );
    const agent = buildAgent(adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: { agentId: buyerDid, bundle: buyerIdentity },
      listingValidationDeps: listingValidationDeps(),
    });

    let settled = false;
    await expect(
      agent.runSession(selected, {
        terms: TERMS,
        settle: async () => {
          settled = true;
          return {
            ok: true,
            txHash: "0x",
            chainId: "c",
            payer: buyerDid,
            payee: sellerDid,
          };
        },
      }),
    ).rejects.toThrow(/does not match the caller-held expected Listing pin/);
    expect(settled).toBe(false);
  });

  test("public RunSessionOptions wires caller-held Vet finality authentication", async () => {
    const { adapter, store } = memAdapter();
    const ref = await anchorListing(store);
    const agent = buildAgent(adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: { agentId: buyerDid, bundle: buyerIdentity },
    });
    let finalityCalls = 0;
    let settleCalls = 0;

    await expect(
      agent.runSession(ref, {
        terms: TERMS,
        jobId: "public-vet-finality",
        listingValidationDeps: listingValidationDeps(),
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
        locator: "stor:settlement-evidence",
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
    store.set(
      evidenceRef.anchor.locator,
      evidence as unknown as Record<string, unknown>,
    );

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
});
