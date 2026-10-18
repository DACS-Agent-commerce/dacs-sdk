import { admittedFixture } from './helpers/admitted.js';
import { contentHash, sha256Hex, canonicalize } from "@kynesyslabs/dacs/canonical";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  loadAgreement: vi.fn(),
  verifySettlementEvidence: vi.fn(),
}));

vi.mock("@kynesyslabs/dacs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kynesyslabs/dacs")>();
  return { ...actual, verifySettlementEvidence: dependencies.verifySettlementEvidence };
});

vi.mock("@kynesyslabs/dacs/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kynesyslabs/dacs/artifacts")>()),
  isSettlementEvidence: () => true,
}));

vi.mock('../src/fixedPriceX402Profile.js', () => ({
  loadDacsFixedPriceX402BuyerAgreementPublicationV1: dependencies.loadAgreement,
}));

import { createDacsFixedPriceX402BuyerCommerceV1 } from
  '../src/fixedPriceX402BuyerCommerce.js';

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = `did:demos:agent:${"1".repeat(64)}`;
const SELLER = `did:demos:agent:${"2".repeat(64)}`;
const EVIDENCE_ADDRESS = `dacs4:delivery-evidence:${JOB_ID}`;
const DELIVERABLE_ADDRESS = `dacs4:deliverable:${JOB_ID}`;

function receivedFixture(
  signatureField = "signature",
  parameters: Readonly<Record<string, unknown>> = {
    authorization: "eip-3009",
    finalityBlocks: 2,
  },
) {
  const payload = { result: "authenticated delivery", [signatureField]: "public-report-signature-field" };
  const deliverableHash = sha256Hex(canonicalize(payload));
  const evidence = {
    jobId: JOB_ID,
    phase: "deliver-storage-program",
    outcome: "success",
    signature: { signer: SELLER },
    deliverableAnchor: {
      kind: "storage-program",
      locator: DELIVERABLE_ADDRESS,
    },
    deliverableContentHash: deliverableHash,
  };
  const artifacts = new Map<string, Readonly<Record<string, unknown>>>([
    [EVIDENCE_ADDRESS, evidence],
    [DELIVERABLE_ADDRESS, payload],
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
        readAnchor: async (address: string) => admittedFixture(artifacts.get(address) ?? null),
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
      parameters,
    } as never,
  });
  const authorizeBytes = (body: Uint8Array) => commerce.buyerReceived.authorizeReceived({
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
    body,
  } as never);
  const authorize = (body: unknown) => authorizeBytes(new TextEncoder().encode(JSON.stringify(body)));
  return { payload, evidence, authorize, authorizeBytes };
}

describe("complete unsigned delivery payload binding", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(["signature", "signatures"])("accepts an anchored complete-payload DV-1 digest with %s and rejects changes", async (field) => {
    const { payload, evidence, authorize } = receivedFixture(field);
    expect(evidence.deliverableContentHash).not.toBe(contentHash(payload));
    const observed = await authorize(payload);
    expect(observed).toBe(true);
    expect(await authorize({ ...payload, [field]: "changed" })).toBe(false);
  });
});
