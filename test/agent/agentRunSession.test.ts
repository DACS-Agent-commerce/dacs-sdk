import { describe, expect, test } from "vitest";

import { buildAgent } from "../../src/agent/Agent.js";
import { buildSignedArtifact } from "../../src/agent/signedArtifact.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
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
});
