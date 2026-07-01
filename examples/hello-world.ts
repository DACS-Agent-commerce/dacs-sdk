/**
 * DACS SDK — hello-world (T5)
 *
 * The whole fixed-price + x402 lifecycle through the public API only:
 *   seller publishes a listing  →  buyer runs a session
 *   (negotiate → settle on x402 → verify)  →  anyone verifies the bundle.
 *
 * Run against a Demos node with two funded agents. Env:
 *   DEMOS_RPC          Demos node RPC URL (e.g. https://node2.demos.sh)
 *   SELLER_WALLET      seller agent mnemonic / private key
 *   BUYER_WALLET       buyer agent mnemonic / private key
 *   SELLER_DID         seller agent id (CCI / did embedding its ed25519 pubkey)
 *   BUYER_DID          buyer agent id
 *   BUYER_EVM_KEY      buyer EVM private key (0x…) used to sign the x402 payment
 *   PAYWALL_URL        seller's paywalled delivery URL (returns HTTP 402)
 *   PAY_NETWORK        CAIP-2 network, e.g. eip155:84532 (Base Sepolia)
 *   SELLER_EVM         seller EVM address that x402 pays
 *
 *   npx tsx examples/hello-world.ts
 */

import { createAgent, createX402Rail, vetCore, x402Settle } from "../src/index.js";

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

async function main(): Promise<void> {
  // ── Seller: publish a signed, anchored fixed-price listing ──
  const seller = await createAgent({
    demosRpc: env("DEMOS_RPC"),
    wallet: env("SELLER_WALLET"),
    identity: { agentId: env("SELLER_DID") },
  });

  const published = await seller.publishListing({
    agentId: env("SELLER_DID"),
    serviceId: "market-data",
    name: "Market Data",
    description: "End-of-day prices, JSON.",
    claimRequirements: [],
    supportedNegotiation: ["negotiate-fixed-price"],
    supportedPaymentRails: ["pay-x402"],
    supportedDelivery: ["deliver-attested-payload"],
  });
  console.log("listing anchored at", published.ref);

  // ── Buyer: run the session, settling via the x402 rail ──
  const buyer = await createAgent({
    demosRpc: env("DEMOS_RPC"),
    wallet: env("BUYER_WALLET"),
    identity: { agentId: env("BUYER_DID") },
  });

  const rail = await createX402Rail({ evmPrivateKey: env("BUYER_EVM_KEY") });

  const session = await buyer.runSession(published.ref, {
    terms: {
      // amount is integer base units (USDC has 6 decimals → 1000000 = 1.0 USDC)
      price: { amount: "1000000", asset: "USDC", decimals: 6, rail: "pay-x402" },
      deliveryPhase: "deliver-attested-payload",
      deliveryFormat: "application/json",
    },
    // Optional Vet step: verify the seller before paying. The session aborts
    // before settlement if it fails. In production resolve the recipe from the
    // steward registry (resolveRecipe) instead of inlining it.
    vet: (subject) =>
      vetCore(
        { subject, recipe: { id: "self-signed", method: "self-signed", availability: "live", params: {} } },
        { proxyFetch: (r) => buyer.adapter.proxyFetch({ url: r.url }), now: () => new Date().toISOString() },
      ),
    settle: x402Settle(rail, {
      url: env("PAYWALL_URL"),
      network: env("PAY_NETWORK"),
      recipientEvm: env("SELLER_EVM"),
    }),
  });
  console.log("session", session.outcome, "→ bundle", session.bundleRef);

  // ── Anyone: independently verify the attestation bundle ──
  const verdict = await buyer.verifyBundle(session.bundleRef);
  console.log("bundle ok:", verdict.ok, "| fully verified:", verdict.fullyVerified);
  for (const a of verdict.artifacts) {
    console.log(`  ${a.kind}: ${a.signature}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
