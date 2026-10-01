import { contentHash } from "@kynesyslabs/dacs/canonical";
import { describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  loadAgreement: vi.fn(),
  verifySettlementEvidence: vi.fn(),
}));

vi.mock("@kynesyslabs/dacs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kynesyslabs/dacs")>()),
  verifySettlementEvidence: dependencies.verifySettlementEvidence,
}));

vi.mock("@kynesyslabs/dacs/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kynesyslabs/dacs/artifacts")>()),
  isSettlementEvidence: () => true,
}));

vi.mock("../src/fixedPriceX402Profile.js", () => ({
  loadDacsFixedPriceX402BuyerAgreementPublicationV1: dependencies.loadAgreement,
}));

import { createDacsFixedPriceX402BuyerCommerceV1 } from
  "../src/fixedPriceX402BuyerCommerce.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = `did:demos:agent:${"1".repeat(64)}`;
const SELLER = `did:demos:agent:${"2".repeat(64)}`;

describe("fixed-price x402 buyer commerce", () => {
  it("accepts a valid response matching the independently anchored deliverable", async () => {
    const payload = { result: "authenticated delivery" };
    const deliverableHash = contentHash(payload);
    const evidence = {
      jobId: JOB_ID,
      phase: "deliver-storage-program",
      outcome: "success",
      signature: { signer: SELLER },
      deliverableAnchor: {
        kind: "storage-program",
        locator: `dacs4:deliverable:${JOB_ID}`,
      },
      deliverableContentHash: deliverableHash,
    };
    const artifacts = new Map<string, Readonly<Record<string, unknown>>>([
      [`dacs4:delivery-evidence:${JOB_ID}`, evidence],
      [`dacs4:deliverable:${JOB_ID}`, payload],
    ]);
    dependencies.loadAgreement.mockResolvedValue({
      artifact: { terms: { price: { amount: "1", currency: "USDC" } } },
    });
    dependencies.verifySettlementEvidence.mockResolvedValue({ decision: "pass" });

    const context = {
      role: "buyer",
      authority: BUYER,
      peerAuthority: SELLER,
      evm: { role: "buyer" },
      commerceStores: {
        role: "buyer",
        x402Settlement: { load: vi.fn() },
      },
      database: {
        createLiveCoordinatorStore: () => ({
          load: async () => ({
            status: "ok",
            record: { buyer: BUYER, seller: SELLER },
          }),
        }),
      },
      demos: {
        adapter: {
          resolveAnchorByName: async (logicalAddress: string) =>
            artifacts.has(logicalAddress)
              ? { status: "present", address: logicalAddress }
              : { status: "absent" },
          readAnchor: async (address: string) => artifacts.get(address) ?? null,
          resolveDemosAnchorReceipt: async (input: {
            logicalAddress: string;
            nativeAddress: string;
            contentHash: string;
          }) => ({
            writer: SELLER,
            logicalAddress: input.logicalAddress,
            nativeAddress: input.nativeAddress,
            contentHash: input.contentHash,
            observationDisposition: "established",
            state: "finalized",
          }),
          verifyDemosAnchorReceipt: async () => true,
        },
      },
    };
    const commerce = createDacsFixedPriceX402BuyerCommerceV1({
      context: context as never,
      rail: {
        railId: "x402:test",
        railType: "x402",
        phaseHandler: "pay-x402",
        asset: { kind: "erc20", symbol: "USDC", chainId: 84532 },
      } as never,
    });

    await expect(commerce.buyerReceived.authorizeReceived({
      operation: { order: { jobId: JOB_ID } },
      intent: {
        jobId: JOB_ID,
        phaseIndex: 2,
        httpResource: "https://seller.example/delivery",
      },
      settlement: {
        signedEvent: { httpResource: "https://seller.example/delivery" },
      },
      response: { contentType: "application/json; charset=utf-8" },
      body: new TextEncoder().encode(JSON.stringify(payload)),
    } as never)).resolves.toBe(true);
  });
});
