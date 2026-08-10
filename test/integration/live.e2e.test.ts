import { describe, expect, it } from "vitest";
import { createPublicClient, erc20Abi, http } from "viem";

import {
  createAgent,
  createInMemoryBindingStore,
  createX402Rail,
  x402Settle,
} from "../../src/index.js";
import { startLiveX402Paywall } from "./live-x402-paywall.js";

/**
 * LIVE on-chain end-to-end gate: real Demos anchors plus an x402 settlement.
 * CI remains offline unless every credential and the explicit spend
 * acknowledgement are supplied.
 *
 *   DEMOS_RPC=… SELLER_WALLET=… SELLER_DID=… BUYER_WALLET=… BUYER_DID=… \
 *   BUYER_EVM_KEY=0x… PAYWALL_URL=local PAY_NETWORK=eip155:84532 \
 *   SELLER_EVM=0x… PAY_TOKEN=0x… LIVE_E2E_CONFIRM=1 \
 *   npx vitest run test/integration/live.e2e.test.ts
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
  "LIVE_E2E_CONFIRM",
] as const;

const env = Object.fromEntries(ENV.map((key) => [key, process.env[key]])) as Record<
  (typeof ENV)[number],
  string | undefined
>;
const missing = ENV.filter((key) => !env[key]);
const ready = missing.length === 0;

const OS_PER_DEM = 1_000_000_000n;
// One seller listing and three buyer session anchors currently cost 2 DEM each.
// The extra DEM is deliberate live-test headroom, not a general fee estimator.
const SELLER_MINIMUM_OS = 3n * OS_PER_DEM;
const BUYER_MINIMUM_OS = 7n * OS_PER_DEM;
const PAYMENT_AMOUNT = 1_000_000n;

function formatDem(os: bigint): string {
  const whole = os / OS_PER_DEM;
  const fraction = (os % OS_PER_DEM)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

async function balanceInOs(agent: Awaited<ReturnType<typeof createAgent>>) {
  const network = await agent.adapter.raw.getNetworkInfo();
  if (!network) {
    throw new Error(
      "balance preflight could not determine denomination fork status; refusing to spend",
    );
  }
  const info = await agent.adapter.raw.getAddressInfo(agent.adapter.getAddress());
  if (!info) {
    throw new Error(`balance preflight found no account for ${agent.adapter.getAddress()}`);
  }
  return network.forks.osDenomination.activated
    ? info.balance
    : info.balance * OS_PER_DEM;
}

function requireBalance(label: string, actualOs: bigint, minimumOs: bigint) {
  if (actualOs < minimumOs) {
    throw new Error(
      `${label} has ${actualOs} OS (${formatDem(actualOs)} DEM), but this E2E requires ` +
        `at least ${minimumOs} OS (${formatDem(minimumOs)} DEM) including fee headroom`,
    );
  }
}

function requireIdentity(label: string, address: string, did: string) {
  const expected = `did:demos:agent:${address.replace(/^0x/, "")}`.toLowerCase();
  if (did.toLowerCase() !== expected) {
    throw new Error(`${label} DID does not match its wallet address; refusing all writes`);
  }
}

async function tokenBalance(address: string): Promise<bigint> {
  const rpc =
    process.env.PAY_RPC ??
    (env.PAY_NETWORK === "eip155:84532" ? "https://sepolia.base.org" : undefined);
  if (!rpc) {
    throw new Error("PAY_RPC is required to preflight token funds on this network");
  }
  const client = createPublicClient({ transport: http(rpc) });
  return client.readContract({
    address: env.PAY_TOKEN! as `0x${string}`,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address as `0x${string}`],
  });
}

describe("LIVE on-chain lifecycle (publish → settle → verify)", () => {
  if (!ready) {
    it.skip(`needs a live node + creds — set ${missing.join(", ")}`, () => {});
    return;
  }

  it(
    "anchors a paid buyer session and verifies every available artifact",
    async () => {
      if (env.LIVE_E2E_CONFIRM !== "1") {
        throw new Error(
          "set LIVE_E2E_CONFIRM=1 to acknowledge the Demos writes and x402 payment",
        );
      }
      if (
        env.PAY_NETWORK === "eip155:8453" &&
        process.env.LIVE_E2E_ALLOW_MAINNET !== "1"
      ) {
        throw new Error(
          "refusing a Base mainnet payment; set LIVE_E2E_ALLOW_MAINNET=1 after explicit review",
        );
      }

      const sellerBindings = createInMemoryBindingStore();
      const seller = await createAgent({
        demosRpc: env.DEMOS_RPC!,
        wallet: env.SELLER_WALLET!,
        identity: { agentId: env.SELLER_DID! },
        bindings: { index: sellerBindings, publisher: sellerBindings },
      });
      const buyer = await createAgent({
        demosRpc: env.DEMOS_RPC!,
        wallet: env.BUYER_WALLET!,
        identity: { agentId: env.BUYER_DID! },
      });
      const rail = await createX402Rail({ evmPrivateKey: env.BUYER_EVM_KEY! });

      const [sellerBalanceOs, buyerBalanceOs, buyerTokenBalance] = await Promise.all([
        balanceInOs(seller),
        balanceInOs(buyer),
        tokenBalance(rail.address),
      ]);
      requireIdentity("seller", seller.adapter.getAddress(), env.SELLER_DID!);
      requireIdentity("buyer", buyer.adapter.getAddress(), env.BUYER_DID!);
      requireBalance("seller", sellerBalanceOs, SELLER_MINIMUM_OS);
      requireBalance("buyer", buyerBalanceOs, BUYER_MINIMUM_OS);
      if (buyerTokenBalance < PAYMENT_AMOUNT) {
        throw new Error(
          `x402 buyer has ${buyerTokenBalance} token base units, but the E2E ` +
            `requires ${PAYMENT_AMOUNT}; refusing all Demos writes`,
        );
      }

      console.info("LIVE E2E preflight", {
        rpc: env.DEMOS_RPC,
        sellerAddress: seller.adapter.getAddress(),
        sellerBalanceDem: formatDem(sellerBalanceOs),
        buyerAddress: buyer.adapter.getAddress(),
        buyerBalanceDem: formatDem(buyerBalanceOs),
        payNetwork: env.PAY_NETWORK,
        x402BuyerAddress: rail.address,
        x402BuyerTokenBalance: buyerTokenBalance.toString(),
      });

      const localPaywall =
        env.PAYWALL_URL === "local"
          ? await startLiveX402Paywall({
              network: env.PAY_NETWORK! as `${string}:${string}`,
              payTo: env.SELLER_EVM!,
              asset: env.PAY_TOKEN!,
              amount: PAYMENT_AMOUNT.toString(),
              facilitatorUrl:
                process.env.X402_FACILITATOR ?? "https://x402.org/facilitator",
            })
          : undefined;

      try {
        const published = await seller.publishListing({
          agentId: env.SELLER_DID!,
          serviceId: `live-e2e-${Date.now()}`,
          name: "Live E2E",
          description: "integration test listing",
          claimRequirements: [],
          supportedNegotiation: ["negotiate-fixed-price"],
          supportedPaymentRails: ["pay-x402"],
          supportedDelivery: ["deliver-attested-payload"],
        });
        expect(published.status).toBe("published");
        if (published.status !== "published") {
          throw new Error("live listing binding publication failed");
        }
        expect(published.ref).toBeTruthy();

        const session = await buyer.runSession(published.ref, {
          terms: {
            price: {
              amount: PAYMENT_AMOUNT.toString(),
              asset: "USDC",
              decimals: 6,
              rail: "pay-x402",
            },
            deliveryPhase: "deliver-attested-payload",
            deliveryFormat: "application/json",
          },
          settle: x402Settle(rail, {
            url: localPaywall?.url ?? env.PAYWALL_URL!,
            network: env.PAY_NETWORK!,
            recipientEvm: env.SELLER_EVM!,
            asset: env.PAY_TOKEN!,
          }),
        });
        expect(session.outcome).toBe("completed");

        const verdict = await buyer.verifyBundle(session.bundleRef);
        expect(verdict.signatures.some((item) => item.verdict === "valid")).toBe(true);
        expect(verdict.refs.length).toBeGreaterThan(0);
        expect(verdict.refs.every((item) => item.verdict === "ok")).toBe(true);
        // runSessionCore still emits its documented buyer-only MVP bundle.
        // Strict two-sided finality must honestly remain false until the seller
        // co-signature is wired into orchestration.
        expect(verdict.ok).toBe(false);
        // The SDK names the missing co-signer by its ClaimReference (DID), so
        // assert the reason is a missing-required-signature verdict AND that it
        // is specifically the seller's DID that is missing.
        expect(verdict.reason).toMatch(/missing required signature/i);
        expect(verdict.reason).toContain(env.SELLER_DID!);
      } finally {
        await localPaywall?.close();
      }
    },
    360_000,
  );
});
