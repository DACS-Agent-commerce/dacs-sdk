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
 *   SELLER_IDENTITY_BUNDLE_JSON  verified DACS-1 §6.3.2 IdentityBundle JSON
 *   BUYER_DID          buyer agent id
 *   BUYER_EVM_KEY      buyer EVM private key (0x…) used to sign the x402 payment
 *   PAYWALL_URL        seller's paywalled delivery URL (returns HTTP 402)
 *   PAY_NETWORK        CAIP-2 network, e.g. eip155:84532 (Base Sepolia)
 *   SELLER_EVM         seller EVM address that x402 pays
 *   PAY_ASSET          canonical ERC-20 contract address advertised by the paywall
 *
 *   npx tsx examples/hello-world.ts
 */

import {
  createAgent,
  createX402Rail,
  vetCore,
  x402Settle,
  type IdentityBundle,
} from "../src/index.js";

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

  const sellerIdentity = JSON.parse(
    env("SELLER_IDENTITY_BUNDLE_JSON"),
  ) as IdentityBundle;
  const published = await seller.publishListing({
    dacsVersion: "1",
    listingVersion: 1,
    listingId: "market-data",
    seller: {
      identity: sellerIdentity,
      displayName: "Market Data",
      publicEndpoint: env("PAYWALL_URL"),
    },
    offering: {
      title: "Market Data",
      description: "End-of-day prices, JSON.",
      category: "data.finance.market",
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
    validity: { notBefore: Date.now() },
  });
  console.log("listing anchored at", published.ref, published.listingPin);

  // ── Buyer: run the session, settling via the x402 rail ──
  const buyer = await createAgent({
    demosRpc: env("DEMOS_RPC"),
    wallet: env("BUYER_WALLET"),
    identity: { agentId: env("BUYER_DID") },
  });

  const rail = await createX402Rail({ evmPrivateKey: env("BUYER_EVM_KEY") });
  const sellerEvm = env("SELLER_EVM");

  const session = await buyer.runSession(published.ref, {
    terms: {
      // amount is integer base units (USDC has 6 decimals → 1000000 = 1.0 USDC)
      price: {
        amount: "1000000",
        asset: "USDC",
        decimals: 6,
        rail: "x402:default",
      },
      deliveryPhase: "deliver-attested-payload",
      deliveryFormat: "application/json",
    },
    expectedSettlementPayee: sellerEvm,
    // A production Vet configuration supplies `vet` (which emits signed,
    // anchored DACS-2 §7.5/§7.7 records), `verifyVetRecord` (which verifies
    // their complete caller-held reference closure), and
    // `authenticateVetFinality` (which authenticates the exact finalized
    // record/ref/receipt binding). This minimal funded x402 example omits Vet
    // rather than demonstrating a shape-only trust shortcut.
    settle: x402Settle(rail, {
      url: env("PAYWALL_URL"),
      network: env("PAY_NETWORK"),
      recipientEvm: sellerEvm,
      asset: env("PAY_ASSET"),
    }),
  });
  console.log("session", session.outcome, "→ bundle", session.bundleRef);

  // ── Anyone: independently verify the attestation bundle ──
  const verdict = await buyer.verifyBundle(session.bundleRef);
  console.log("bundle ok:", verdict.ok, "| fully verified:", verdict.fullyVerified);
  for (const signature of verdict.signatures) {
    console.log(`  signer ${signature.party}: ${signature.verdict}`);
  }
  for (const ref of verdict.refs) {
    console.log(`  ${ref.kind} ${ref.id}: ${ref.verdict}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
