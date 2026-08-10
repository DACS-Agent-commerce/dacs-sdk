import { describe, expect, test } from "vitest";

import {
  buildAgent,
  type AgentListingValidationPolicy,
} from "../../src/agent/Agent.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import { signComponentArtifact } from "../../src/artifacts/signatures.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
  signedBytes,
} from "../../src/crypto/index.js";
import { contentHash } from "../../src/canonical/index.js";
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

function validationPolicy(): AgentListingValidationPolicy {
  return {
    nowMs: () => 1_800_000_000_000,
    verifyIdentityBundle: async (bundle) => ({
      status: "verified",
      controlledClaims: bundle.claims.map((claim) => claim.ref),
    }),
    readRevocationObservations: async () => [
      { source: "well-known", status: "active", integrity: "consistent" },
    ],
    readRevocationMarker: async () => null,
    resolveRail: async (ref) => {
      const definition = await signComponentArtifact(
        {
          railVersion: ref.railVersion ?? 1,
          railId: ref.railId,
          phaseHandler: "pay-x402",
        },
        "dacs-rail:v1:",
        {
          algorithm: "ed25519",
          signer: sellerDid,
          sign: (bytes) => ed25519Sign(bytes, sellerPriv),
        },
      );
      return {
        status: "resolved",
        authority: "pa1-in-code",
        authenticated: true,
        finalized: true,
        snapshotId: "test-registry-v1",
        index: {
          railId: ref.railId,
          railVersion: ref.railVersion ?? 1,
          contentHash: contentHash(
            definition as unknown as Record<string, unknown>,
          ),
        },
        definition,
      };
    },
    validateRailDefinition: async () => true,
    verifyArtifactSignature: async ({ artifact, separator, signature }) => {
      const hex = signature.signer.match(/(?:^|:)(?:0x)?([0-9a-fA-F]{64})$/)?.[1];
      if (!hex) return { status: "indeterminate", reason: "unresolved key" };
      const bytes = Uint8Array.from(Buffer.from(signature.value, "base64url"));
      const valid = bytes.length === 64 && ed25519Verify(
        signedBytes(separator, contentHash(artifact as Record<string, unknown>)),
        bytes,
        publicKeyFromRaw(Uint8Array.from(Buffer.from(hex, "hex"))),
      );
      return valid
        ? { status: "valid" }
        : { status: "invalid", reason: "bad signature" };
    },
  };
}

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
        description: "d",
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
  return "stor:listing";
}

describe("Agent.runSession wires the #41 listing verifier (public surface)", () => {
  test("refuses a public session when no complete Listing authority policy is configured", async () => {
    const { adapter, store } = memAdapter();
    const ref = await anchorListing(store);
    const agent = buildAgent(adapter as never, {
      demosRpc: "mem",
      wallet: "x",
      identity: { agentId: buyerDid },
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
    ).rejects.toThrow(/AgentConfig\.listingValidation/);
    expect(settled).toBe(false);
  });

  test("a genuinely signed listing settles through the public runSession", async () => {
    const { adapter, store } = memAdapter();
    const ref = await anchorListing(store);
    const agent = buildAgent(adapter as never, { demosRpc: "mem", wallet: "x", identity: { agentId: buyerDid }, listingValidation: validationPolicy() });

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
    const agent = buildAgent(adapter as never, { demosRpc: "mem", wallet: "x", identity: { agentId: buyerDid }, listingValidation: validationPolicy() });

    let settled = false;
    await expect(
      agent.runSession(ref, {
        terms: TERMS,
        settle: async () => {
          settled = true;
          return { ok: true, txHash: "0x", chainId: "c", payer: "p", payee: "q" };
        },
      }),
    ).rejects.toThrow(/listing-signature-unverified/);
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
      listingValidation: validationPolicy(),
    });
    await expect(agent.getReputation(buyerDid, ["stor:forged-bundle"]))
      .resolves.toMatchObject({ totalAgreements: 0, completed: 0 });
  });
});
