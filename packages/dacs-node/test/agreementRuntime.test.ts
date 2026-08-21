import { describe, expect, it, vi } from "vitest";

const advanceAgreement = vi.hoisted(() => vi.fn());
const respondAgreement = vi.hoisted(() => vi.fn());
const loadOrderInput = vi.hoisted(() => vi.fn());

vi.mock("@kynesyslabs/dacs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kynesyslabs/dacs")>()),
  advanceFixedPriceAgreementDurable: advanceAgreement,
  respondToFixedPriceAgreementProposalDurable: respondAgreement,
}));

vi.mock("../src/orderInput.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/orderInput.js")>()),
  loadDacsLiveOrderInputForTrackV1: loadOrderInput,
}));

import {
  createDacsBuyerAgreementTrackV1,
  createDacsSellerAgreementTrackV1,
} from "../src/agreementRuntime.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = `did:demos:agent:${"11".repeat(32)}`;
const SELLER = `did:demos:agent:${"22".repeat(32)}`;
const BINDING = "a".repeat(64);
const LOCAL_BINDING = "b".repeat(64);

function context(role: "buyer" | "seller") {
  return Object.freeze({
    role,
    authority: role === "buyer" ? BUYER : SELLER,
    peerAuthority: role === "buyer" ? SELLER : BUYER,
    sendMessage: vi.fn(),
    config: {},
    database: { readTime: () => 1_000 },
    demos: {
      role,
      adapter: { sign: vi.fn(async () => Uint8Array.from(Buffer.alloc(64, 1))) },
    },
    sessionStore: {},
    commerceStores: { role },
    evm: { role, address: `0x${"11".repeat(20)}` },
  });
}

function operation(role: "buyer" | "seller", track = "agreement") {
  const assertCurrent = vi.fn(async () => undefined);
  return {
    input: {
      order: {
        storeVersion: 3,
        revision: 1,
        role,
        jobId: JOB_ID,
        buyer: BUYER,
        seller: SELLER,
        protocol: {
          commerceProfile: "dacs-sdk:fixed-price-x402:v1",
          standardRevision: "965df755aba4ff392f1fb37a93d287242b177ba4",
          phase: "pay-x402",
          orchestratorTopology: "seller-as-phase-orchestrator-v1",
          orchestrator: SELLER,
          rail: {
            registryIndexRef: "dacs4:registry:v0.1",
            registryIndexHash: "1".repeat(64),
            railDefinitionRef: "dacs4:rail:x402%3Adefault:2",
            railDefinitionHash: "2".repeat(64),
            railId: "x402:default",
            railVersion: 2,
            railType: "x402",
            phaseHandler: "pay-x402",
            network: "eip155:84532",
            availability: "live",
          },
        },
        bindingHash: BINDING,
        localBindingHash: LOCAL_BINDING,
        sdkJobs: role === "buyer"
          ? {
              role,
              agreement: "buyer-agreement",
              payment: "buyer-payment",
              paymentEvidence: "buyer-payment-evidence",
              buyerReceived: "buyer-received",
              audit: "buyer-audit",
            }
          : {
              role,
              agreement: "seller-agreement",
              payment: "seller-payment",
              paymentEvidence: "seller-payment-evidence",
              fulfilment: "seller-fulfilment",
              deliveryEvidence: "seller-delivery-evidence",
              audit: "seller-audit",
            },
        tracks: {},
        createdAt: 1,
        updatedAt: 1,
      },
      fence: {
        role,
        jobId: JOB_ID,
        bindingHash: BINDING,
        localBindingHash: LOCAL_BINDING,
        track,
        owner: `${role}-worker`,
        generation: 1,
        idempotencyKey: `${role}-agreement-effect`,
        assertCurrent,
      },
    },
    assertCurrent,
  };
}

const resolution = { disposition: "absent" as const, reason: "not-used" };

describe("durable agreement role tracks", () => {
  it("maps an independently authorized anchored buyer result", async () => {
    const retained = { application: { request: true } };
    loadOrderInput.mockReturnValue(retained);
    advanceAgreement.mockResolvedValue({
      disposition: "anchored",
      recovered: false,
      result: {
        agreement: { jobId: JOB_ID },
        agreementHash: "c".repeat(64),
        agreementRef: {
          anchor: { kind: "storage-program", locator: "dacs3:agreement:test" },
          contentHash: "c".repeat(64),
        },
        anchorReceipt: {},
      },
    });
    const authorizeAnchored = vi.fn(async () => true);
    const track = createDacsBuyerAgreementTrackV1({
      context: context("buyer") as never,
      workerId: "buyer-worker",
      buildDraft: () => ({ jobId: JOB_ID } as never),
      verifyContribution: vi.fn(),
      reconcileBuyerSignature: vi.fn(async () => resolution),
      transport: {
        publishProposal: vi.fn(async () => ({ disposition: "submitted" })),
        reconcileProposalPublication: vi.fn(async () => resolution),
        resolveSellerContributions: vi.fn(async () => resolution),
      },
      anchor: {
        anchorAgreement: vi.fn(async () => ({ disposition: "submitted" })),
        reconcileAgreementAnchor: vi.fn(async () => resolution),
        verifyAnchorReceipt: vi.fn(async () => "valid"),
      },
      authorizeAnchored,
    });
    const run = operation("buyer");

    await expect(track(run.input as never)).resolves.toEqual({
      status: "final",
      outcome: "success",
      reference: "dacs3:agreement:test",
      authenticationHash: "c".repeat(64),
    });
    expect(loadOrderInput).toHaveBeenCalled();
    expect(authorizeAnchored).toHaveBeenCalledWith(expect.objectContaining({ retained }));
    expect(run.assertCurrent).toHaveBeenCalled();
  });

  it("maps the seller responder only after exact role/job authorization", async () => {
    const retained = { application: { proposal: true } };
    loadOrderInput.mockReturnValue(retained);
    const response = {
      responseVersion: "1",
      transportIdentity: {
        jobId: JOB_ID,
        planHash: "1".repeat(64),
        agreementHash: "2".repeat(64),
        buyer: BUYER,
        seller: SELLER,
        proposalHash: "3".repeat(64),
      },
      sellerContribution: {},
    };
    respondAgreement.mockResolvedValue({
      disposition: "complete",
      recovered: false,
      result: response,
    });
    const track = createDacsSellerAgreementTrackV1({
      context: context("seller") as never,
      workerId: "seller-worker",
      resolveProposal: () => ({ proposal: {} as never, transportIdentity: response.transportIdentity }),
      resolveAuthenticatedAgreementContext: vi.fn(async () => resolution),
      verifyContribution: vi.fn(),
      reconcileSellerSignature: vi.fn(async () => resolution),
      transport: {
        publishSellerContribution: vi.fn(async () => ({ disposition: "submitted" })),
        reconcileSellerContributionPublication: vi.fn(async () => resolution),
      },
      authorizeComplete: async () => true,
    });

    await expect(track(operation("seller").input as never)).resolves.toMatchObject({
      status: "final",
      outcome: "success",
      reference: `agreement-response:${"3".repeat(64)}`,
      authenticationHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("fails closed on cross-track invocation and unauthorized terminal readback", async () => {
    loadOrderInput.mockReturnValue({ application: {} });
    advanceAgreement.mockResolvedValue({
      disposition: "anchored",
      recovered: true,
      result: {
        agreement: { jobId: JOB_ID },
        agreementHash: "c".repeat(64),
        agreementRef: { anchor: { locator: "agreement" } },
      },
    });
    const track = createDacsBuyerAgreementTrackV1({
      context: context("buyer") as never,
      workerId: "buyer-worker",
      buildDraft: () => ({} as never),
      verifyContribution: vi.fn(),
      reconcileBuyerSignature: vi.fn(async () => resolution),
      transport: {
        publishProposal: vi.fn(),
        reconcileProposalPublication: vi.fn(),
        resolveSellerContributions: vi.fn(),
      },
      anchor: {
        anchorAgreement: vi.fn(),
        reconcileAgreementAnchor: vi.fn(),
        verifyAnchorReceipt: vi.fn(),
      },
      authorizeAnchored: async () => false,
    });

    await expect(track(operation("buyer", "payment").input as never)).resolves.toEqual({
      status: "operator-action",
      reasonCode: "buyer-agreement-track-binding-mismatch",
    });
    await expect(track(operation("buyer").input as never)).resolves.toEqual({
      status: "operator-action",
      reasonCode: "buyer-agreement-result-unauthorized",
    });
  });
});
