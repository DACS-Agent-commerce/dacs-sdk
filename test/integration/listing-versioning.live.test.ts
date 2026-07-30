import { describe, expect, it } from "vitest";

import { createAgent } from "../../src/index.js";

/**
 * Live-node acceptance gate for #46.
 *
 * This writes two uniquely named listing versions, so it is gated on a funded
 * seller wallet and never runs in the offline/default suite:
 *
 *   DEMOS_RPC=… SELLER_WALLET=… SELLER_DID=… \
 *   npx vitest run test/integration/listing-versioning.live.test.ts
 */
const RPC = process.env["DEMOS_RPC"];
const WALLET = process.env["SELLER_WALLET"];
const DID = process.env["SELLER_DID"];
const ready = Boolean(RPC && WALLET && DID);

describe("LIVE listing version immutability + sequencing (#46)", () => {
  if (!ready) {
    it.skip("needs DEMOS_RPC, SELLER_WALLET, and SELLER_DID", () => {});
    return;
  }

  it(
    "creates v1/v2, reconciles an identical retry, and rejects overwrite/gap",
    async () => {
      const agent = await createAgent({
        demosRpc: RPC!,
        wallet: WALLET!,
        identity: { agentId: DID! },
      });
      const serviceId = `sdk-46-${Date.now()}`;
      const base = {
        agentId: DID!,
        serviceId,
        name: "SDK #46 live gate",
        description: "v1",
        claimRequirements: [],
        supportedNegotiation: ["negotiate-fixed-price"],
        supportedPaymentRails: ["pay-x402"],
        supportedDelivery: ["deliver-attested-payload"],
      };

      const v1 = await agent.publishListing({ ...base, listingVersion: 1 });
      const retry = await agent.publishListing({ ...base, listingVersion: 1 });
      expect(retry.ref).toBe(v1.ref);

      await expect(
        agent.publishListing({
          ...base,
          listingVersion: 1,
          description: "forbidden overwrite",
        }),
      ).rejects.toThrow(/different signed-scope content/);
      await expect(
        agent.publishListing({
          ...base,
          listingVersion: 3,
          description: "skipped v2",
        }),
      ).rejects.toThrow(/expected 2, got 3/);

      const v2 = await agent.publishListing({
        ...base,
        listingVersion: 2,
        description: "v2",
      });
      expect(v2.ref).not.toBe(v1.ref);
    },
    360_000,
  );
});
