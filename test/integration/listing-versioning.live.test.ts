import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createAgent,
  createFsDemosWriteJournal,
  createInMemoryBindingStore,
} from "../../src/index.js";

/**
 * Live-node acceptance gate for #46.
 *
 * This writes two uniquely named listing versions, so it is gated on a funded
 * seller wallet and never runs in the offline/default suite:
 *
 *   DEMOS_RPC=… SELLER_WALLET=… SELLER_DID=… DACS_STATE_DIR=… \
 *   npx vitest run test/integration/listing-versioning.live.test.ts
 */
const RPC = process.env["DEMOS_RPC"];
const WALLET = process.env["SELLER_WALLET"];
const DID = process.env["SELLER_DID"];
const STATE_DIR = process.env["DACS_STATE_DIR"];
const ready = Boolean(RPC && WALLET && DID && STATE_DIR);

describe("LIVE listing version immutability + sequencing (#46)", () => {
  if (!ready) {
    it.skip(
      "needs DEMOS_RPC, SELLER_WALLET, SELLER_DID, and DACS_STATE_DIR",
      () => {},
    );
    return;
  }

  it(
    "creates v1/v2, reconciles an identical retry, and rejects overwrite/gap",
    async () => {
      const bindings = createInMemoryBindingStore();
      const writeJournal = await createFsDemosWriteJournal({
        dir: join(STATE_DIR!, "listing-versioning-demos-writes"),
      });
      const agent = await createAgent({
        demosRpc: RPC!,
        wallet: WALLET!,
        demosWriteJournal: writeJournal,
        identity: { agentId: DID! },
        bindings: { index: bindings, publisher: bindings },
      });
      const serviceId = `sdk-46-${Date.now()}`;
      const base = {
        dacsVersion: "1" as const,
        listingId: serviceId,
        seller: {
          identity: {
            bundleVersion: "1" as const,
            presentedBy: DID!,
            presentedAt: Date.now(),
            claims: [{ ref: DID! }],
            presentation: {
              kind: "per-claim" as const,
              signatures: [{ ref: DID!, signature: "live-wallet-presentation" }],
            },
          },
          displayName: "SDK #46 live gate",
        },
        offering: {
          title: "SDK #46 live gate",
          description: "v1",
          category: "sdk.conformance",
          tags: ["versioning"],
          deliverable: {
            kind: "attested-payload" as const,
            payloadFormat: "application/json",
            verificationMethod: { kind: "self-signed" as const },
          },
        },
        buyerRequirement: { requirementVersion: "1" as const, required: [] },
        pipeline: [
          { kind: "negotiate-fixed-price" as const },
          { kind: "commit-agreement" as const },
          { kind: "pay-x402" as const, parameters: { rail: "x402:default" } },
          { kind: "deliver-attested-payload" as const },
        ],
        pricing: {
          kind: "fixed" as const,
          price: { amount: "1", currency: "USDC" },
        },
        acceptedRails: [{ railId: "x402:default" }],
        terms: { deadlineSecAfterCommit: 3_600 },
        validity: { notBefore: Date.now() - 1_000 },
      };

      const v1 = await agent.publishListing({ ...base, listingVersion: 1 });
      const retry = await agent.publishListing({ ...base, listingVersion: 1 });
      expect(v1.status).toBe("published");
      expect(retry.status).toBe("already-published");
      if (v1.status !== "published" || retry.status !== "already-published") {
        throw new Error("listing binding publication failed");
      }
      expect(retry.ref).toBe(v1.ref);

      await expect(
        agent.publishListing({
          ...base,
          listingVersion: 1,
          offering: { ...base.offering, description: "forbidden overwrite" },
        }),
      ).rejects.toThrow(/different signed-scope content/);
      await expect(
        agent.publishListing({
          ...base,
          listingVersion: 3,
          offering: { ...base.offering, description: "skipped v2" },
        }),
      ).rejects.toThrow(/expected 2, got 3/);

      const v2 = await agent.publishListing({
        ...base,
        listingVersion: 2,
        offering: { ...base.offering, description: "v2" },
      });
      expect(v2.status).toBe("published");
      if (v2.status !== "published") {
        throw new Error("v2 listing binding publication failed");
      }
      expect(v2.ref).not.toBe(v1.ref);
    },
    360_000,
  );
});
