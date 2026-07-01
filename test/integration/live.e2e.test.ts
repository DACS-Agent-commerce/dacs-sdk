import { describe, expect, it } from "vitest";

import { createAgent, createX402Rail, x402Settle } from "../../src/index.js";

/**
 * LIVE on-chain end-to-end gate (the path unit tests + the in-memory e2e can't
 * cover): runs the real lifecycle against a Demos node + an x402 paywall.
 *
 * Skipped unless the full set of env vars below is present, so CI / `npm test`
 * stay offline. Run it as the pre-publish gate once a node + funded agents are
 * available:
 *
 *   DEMOS_RPC=… SELLER_WALLET=… SELLER_DID=… BUYER_WALLET=… BUYER_DID=… \
 *   BUYER_EVM_KEY=0x… PAYWALL_URL=… PAY_NETWORK=eip155:84532 SELLER_EVM=0x… \
 *   PAY_TOKEN=0x…(ERC-20 contract) npx vitest run test/integration/live.e2e.test.ts
 */

const ENV = [
  "DEMOS_RPC",
  "SELLER_WALLET",
  "SELLER_DID",
  "BUYER_WALLET",
  "BUYER_DID",
  "BUYER_EVM_KEY",
  "PAYWALL_URL",
  "PAY_NETWORK",
  "SELLER_EVM",
  "PAY_TOKEN",
] as const;

const env = Object.fromEntries(ENV.map((k) => [k, process.env[k]])) as Record<
  (typeof ENV)[number],
  string | undefined
>;
const missing = ENV.filter((k) => !env[k]);
const ready = missing.length === 0;

describe("LIVE on-chain lifecycle (publish → settle → verify)", () => {
  if (!ready) {
    it.skip(`needs a live node + creds — set ${missing.join(", ")}`, () => {});
    return;
  }

  it(
    "publishes, runs a session, settles on x402, and the bundle verifies on-chain",
    async () => {
      const seller = await createAgent({
        demosRpc: env.DEMOS_RPC!,
        wallet: env.SELLER_WALLET!,
        identity: { agentId: env.SELLER_DID! },
      });
      const published = await seller.publishListing({
        agentId: env.SELLER_DID!,
        serviceId: "live-e2e",
        name: "Live E2E",
        description: "integration test listing",
        claimRequirements: [],
        supportedNegotiation: ["negotiate-fixed-price"],
        supportedPaymentRails: ["pay-x402"],
        supportedDelivery: ["deliver-attested-payload"],
      });
      expect(published.ref).toBeTruthy();

      const buyer = await createAgent({
        demosRpc: env.DEMOS_RPC!,
        wallet: env.BUYER_WALLET!,
        identity: { agentId: env.BUYER_DID! },
      });
      const rail = await createX402Rail({ evmPrivateKey: env.BUYER_EVM_KEY! });

      const session = await buyer.runSession(published.ref, {
        terms: {
          price: { amount: "1000000", asset: "USDC", decimals: 6, rail: "pay-x402" },
          deliveryPhase: "deliver-attested-payload",
          deliveryFormat: "application/json",
        },
        settle: x402Settle(rail, {
          url: env.PAYWALL_URL!,
          network: env.PAY_NETWORK!,
          recipientEvm: env.SELLER_EVM!,
          asset: env.PAY_TOKEN!,
        }),
      });
      expect(session.outcome).toBe("completed");

      // Anyone can re-verify the anchored bundle from scratch.
      const verdict = await buyer.verifyBundle(session.bundleRef);
      expect(verdict.ok).toBe(true);
      expect(verdict.signatures.some((s) => s.verdict === "valid")).toBe(true);
    },
    120_000,
  );
});
