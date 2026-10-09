import { x402BuyerSettlementKey } from "@kynesyslabs/dacs";
import { ARTIFACT_SEPARATORS, type ComponentSignature } from "@kynesyslabs/dacs/artifacts";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
  signedBytes,
} from "@kynesyslabs/dacs/crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  loadAgreement: vi.fn(),
  verifySettlementEvidence: vi.fn(),
  realVerifySettlementEvidence: undefined as unknown as
    typeof import("@kynesyslabs/dacs").verifySettlementEvidence,
}));

vi.mock("@kynesyslabs/dacs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kynesyslabs/dacs")>();
  dependencies.realVerifySettlementEvidence = actual.verifySettlementEvidence;
  return { ...actual, verifySettlementEvidence: dependencies.verifySettlementEvidence };
});

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
const EVIDENCE_ADDRESS = `dacs4:delivery-evidence:${JOB_ID}`;
const DELIVERABLE_ADDRESS = `dacs4:deliverable:${JOB_ID}`;

function receivedFixture(
  parameters: Readonly<Record<string, unknown>> = {
    authorization: "eip-3009",
    finalityBlocks: 2,
  },
) {
  const payload = { result: "authenticated delivery" };
  const deliverableHash = contentHash(payload);
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
      parameters,
    } as never,
  });
  const authorize = (body: unknown) => commerce.buyerReceived.authorizeReceived({
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
    body: new TextEncoder().encode(JSON.stringify(body)),
  } as never);
  return { payload, evidence, authorize };
}

describe("fixed-price x402 buyer commerce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a valid response matching the independently anchored deliverable", async () => {
    const { payload, evidence, authorize } = receivedFixture();

    await expect(authorize(payload)).resolves.toBe(true);
    expect(dependencies.verifySettlementEvidence).toHaveBeenCalledTimes(1);
    expect(dependencies.verifySettlementEvidence).toHaveBeenCalledWith(evidence, {
      orchestrator: SELLER,
      agreement: { amount: "1", currency: "USDC" },
      attestationRef: {
        anchor: { kind: "storage-program", locator: EVIDENCE_ADDRESS },
        contentHash: contentHash(evidence),
        signer: SELLER,
      },
      result: { ok: true },
      expectedAnchorLocator: DELIVERABLE_ADDRESS,
    }, expect.anything());
  });

  it("rejects a response that differs from the anchored deliverable outside its signed scope", async () => {
    const { payload, authorize } = receivedFixture();
    const unanchored = { ...payload, signature: "not-anchored" };
    expect(contentHash(unanchored)).toBe(contentHash(payload));

    await expect(authorize(unanchored)).resolves.toBe(false);
    expect(dependencies.verifySettlementEvidence).toHaveBeenCalledTimes(1);
  });
});

const EVIDENCE_BUYER_SEED = Uint8Array.from(Buffer.alloc(32, 71));
const EVIDENCE_SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 72));
const EVIDENCE_BUYER = `did:demos:agent:${Buffer.from(
  rawPublicKey(publicKeyFromSeed(EVIDENCE_BUYER_SEED)),
).toString("hex")}`;
const EVIDENCE_SELLER = `did:demos:agent:${Buffer.from(
  rawPublicKey(publicKeyFromSeed(EVIDENCE_SELLER_SEED)),
).toString("hex")}`;
const X402_RAIL_ID = "x402:test";
const PAYMENT_ADDRESS = `dacs4:payment:${JOB_ID}:x402%3Atest:2`;
const OBSERVED_AT = 1_786_000_000_000;
const CAPTURED_EVENT = Object.freeze({
  kind: "x402-event" as const,
  httpResource: `https://seller.example/dacs/x402/${JOB_ID}`,
  paymentReceiptHash: "c".repeat(64),
  settlementTxHash: "d".repeat(64),
  chainId: 84_532,
  logIndex: 0,
  protocolVersion: "2",
});

function signEvidence<T extends Record<string, unknown>>(
  unsigned: T,
  signer: string,
  seed: Uint8Array = signer === EVIDENCE_BUYER ? EVIDENCE_BUYER_SEED : EVIDENCE_SELLER_SEED,
): T & { signature: ComponentSignature } {
  return {
    ...unsigned,
    signature: {
      algorithm: "ed25519",
      signer,
      value: Buffer.from(ed25519Sign(
        signedBytes(ARTIFACT_SEPARATORS.SettlementEvidence, contentHash(unsigned)),
        privateKeyFromSeed(seed),
      )).toString("base64url"),
    },
  };
}

function x402EvidenceInput(extra: Record<string, unknown> = {}) {
  return {
    evidenceVersion: "1" as const,
    jobId: JOB_ID,
    phase: "pay-x402" as const,
    outcome: "success" as const,
    paymentTxRefs: [{ ...CAPTURED_EVENT }],
    paymentAmount: { amount: "1", currency: "USDC" },
    settlementFinality: { model: "block-depth" as const, finalityBlocks: 2,
      finalityObservedAt: OBSERVED_AT },
    observedAt: OBSERVED_AT,
    ...extra,
  };
}

function paymentEvidenceFixture() {
  dependencies.verifySettlementEvidence.mockReset();
  dependencies.verifySettlementEvidence.mockImplementation(
    dependencies.realVerifySettlementEvidence,
  );
  dependencies.loadAgreement.mockResolvedValue({
    artifact: { terms: { price: { amount: "1", currency: "USDC" } } },
  });
  const evidence = signEvidence(x402EvidenceInput(), EVIDENCE_SELLER);
  const state = {
    seller: EVIDENCE_SELLER,
    settlement: {
      status: "captured",
      outcome: { status: "captured", settlement: { signedEvent: { ...CAPTURED_EVENT } } },
      intent: { amount: "1000000" },
    } as Record<string, unknown> & {
      outcome: { settlement: { signedEvent: Record<string, unknown> } };
      intent: { amount: string };
    },
  };
  const settlementKey = x402BuyerSettlementKey({
    railId: X402_RAIL_ID,
    jobId: JOB_ID,
    phaseIndex: 2,
  });
  const settlementLoad = vi.fn(async (key: string) =>
    key === settlementKey ? state.settlement : { status: "missing" });
  const context = {
    role: "buyer",
    authority: EVIDENCE_BUYER,
    peerAuthority: EVIDENCE_SELLER,
    evm: { role: "buyer" },
    commerceStores: { role: "buyer", x402Settlement: { load: settlementLoad } },
    database: {
      createLiveCoordinatorStore: () => ({
        load: async () => ({
          status: "ok",
          record: {
            jobId: JOB_ID,
            buyer: EVIDENCE_BUYER,
            seller: state.seller,
            protocol: { rail: { railId: X402_RAIL_ID } },
          },
        }),
      }),
    },
    demos: { adapter: {} },
  };
  const commerce = createDacsFixedPriceX402BuyerCommerceV1({
    context: context as never,
    rail: {
      railId: X402_RAIL_ID,
      railType: "x402",
      phaseHandler: "pay-x402",
      asset: { kind: "erc20", symbol: "USDC", chainId: 84_532, decimals: 6 },
      parameters: { authorization: "eip-3009", finalityBlocks: 2 },
    } as never,
  });
  const verify = async (request: Readonly<Record<string, unknown>> = {}) =>
    commerce.paymentEvidence.verifyEvidence({
      jobId: JOB_ID,
      logicalAddress: PAYMENT_ADDRESS,
      evidenceHash: contentHash(evidence),
      evidence,
      ...request,
    } as never);
  return { evidence, settlementKey, settlementLoad, state, verify };
}

async function onlyVerifierOutcome(): Promise<unknown> {
  expect(dependencies.verifySettlementEvidence).toHaveBeenCalledTimes(1);
  return dependencies.verifySettlementEvidence.mock.results[0]?.value;
}

describe("fixed-price x402 buyer payment-evidence verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts seller evidence bound to the captured settlement and unresolved PC-2 address", async () => {
    const f = paymentEvidenceFixture();

    await expect(f.verify()).resolves.toEqual({ disposition: "valid" });
    expect(f.settlementLoad).toHaveBeenCalledWith(f.settlementKey);
    expect(dependencies.verifySettlementEvidence).toHaveBeenCalledWith(f.evidence, {
      orchestrator: EVIDENCE_SELLER,
      agreement: { amount: "1", currency: "USDC" },
      rail: {
        railId: X402_RAIL_ID,
        railType: "x402",
        asset: "USDC",
        network: "eip155:84532",
        handler: "pay-x402",
      },
      attestationRef: {
        anchor: { kind: "storage-program", locator: PAYMENT_ADDRESS },
        contentHash: contentHash(f.evidence),
        signer: EVIDENCE_SELLER,
      },
      paymentAddress: { railId: X402_RAIL_ID, phaseIndex: 2, resolved: false },
      result: { ok: true, txRefs: [CAPTURED_EVENT] },
    }, expect.anything());
    await expect(onlyVerifierOutcome()).resolves.toEqual({ decision: "pass", reasons: [] });
  });

  it("accepts seller evidence that omits the optional finality-depth echo", async () => {
    const f = paymentEvidenceFixture();
    const withoutEcho = signEvidence(x402EvidenceInput({
      settlementFinality: {
        model: "block-depth",
        finalityObservedAt: OBSERVED_AT,
      },
    }), EVIDENCE_SELLER);

    await expect(f.verify({
      evidence: withoutEcho,
      evidenceHash: contentHash(withoutEcho),
    })).resolves.toEqual({ disposition: "valid" });
    await expect(onlyVerifierOutcome()).resolves.toEqual({ decision: "pass", reasons: [] });
  });

  it("rejects correctly signed evidence echoing a smaller finality depth", async () => {
    const f = paymentEvidenceFixture();
    const smaller = signEvidence(x402EvidenceInput({
      settlementFinality: {
        model: "block-depth",
        finalityBlocks: 1,
        finalityObservedAt: OBSERVED_AT,
      },
    }), EVIDENCE_SELLER);

    await expect(f.verify({
      evidence: smaller,
      evidenceHash: contentHash(smaller),
    })).resolves.toEqual({
      disposition: "invalid",
      reason: "payment evidence settlement binding invalid",
    });
    expect(dependencies.verifySettlementEvidence).not.toHaveBeenCalled();
  });

  it("rejects correctly signed evidence echoing a larger finality depth", async () => {
    const f = paymentEvidenceFixture();
    const larger = signEvidence(x402EvidenceInput({
      settlementFinality: {
        model: "block-depth",
        finalityBlocks: 3,
        finalityObservedAt: OBSERVED_AT,
      },
    }), EVIDENCE_SELLER);

    await expect(f.verify({
      evidence: larger,
      evidenceHash: contentHash(larger),
    })).resolves.toEqual({
      disposition: "invalid",
      reason: "payment evidence settlement binding invalid",
    });
    expect(dependencies.verifySettlementEvidence).not.toHaveBeenCalled();
  });

  it("rejects payment evidence authored by the buyer", async () => {
    const f = paymentEvidenceFixture();
    const buyerAuthored = signEvidence(x402EvidenceInput(), EVIDENCE_BUYER);

    await expect(f.verify({
      evidence: buyerAuthored,
      evidenceHash: contentHash(buyerAuthored),
    })).resolves.toEqual({
      disposition: "invalid",
      reason: "payment evidence actor binding invalid",
    });
    expect(f.settlementLoad).not.toHaveBeenCalled();
    expect(dependencies.verifySettlementEvidence).not.toHaveBeenCalled();
  });

  it("waits for the buyer's own captured settlement before verifying", async () => {
    const f = paymentEvidenceFixture();
    f.state.settlement = {
      ...f.state.settlement,
      status: "pending",
    };

    await expect(f.verify()).resolves.toEqual({
      disposition: "indeterminate",
      reason: "buyer settlement finality is unavailable",
    });
    expect(dependencies.verifySettlementEvidence).not.toHaveBeenCalled();
  });

  it.each([
    ["another log index", (f: ReturnType<typeof paymentEvidenceFixture>) => {
      f.state.settlement.outcome.settlement.signedEvent.logIndex = 1;
    }],
    ["another receipt hash", (f: ReturnType<typeof paymentEvidenceFixture>) => {
      f.state.settlement.outcome.settlement.signedEvent.paymentReceiptHash = "e".repeat(64);
    }],
    ["a smaller retained intent", (f: ReturnType<typeof paymentEvidenceFixture>) => {
      f.state.settlement.intent.amount = "999999";
    }],
    ["a different agreed price", (_f: ReturnType<typeof paymentEvidenceFixture>) => {
      dependencies.loadAgreement.mockResolvedValue({
        artifact: { terms: { price: { amount: "2", currency: "USDC" } } },
      });
    }],
  ])("rejects evidence that disagrees with %s", async (_label, change) => {
    const f = paymentEvidenceFixture();
    change(f);

    await expect(f.verify()).resolves.toEqual({
      disposition: "invalid",
      reason: "payment evidence settlement binding invalid",
    });
    expect(dependencies.verifySettlementEvidence).not.toHaveBeenCalled();
  });

  it("rejects evidence anchored at the resolved PC-2 discriminator", async () => {
    const f = paymentEvidenceFixture();

    await expect(f.verify({ logicalAddress: `${PAYMENT_ADDRESS}:resolved` })).resolves.toEqual({
      disposition: "invalid",
      reason: "payment evidence cryptographic verification failed",
    });
    await expect(onlyVerifierOutcome()).resolves.toEqual({
      decision: "fail",
      reasons: [
        "attestationRef locator does not match the complete authenticated PC-2 payment address",
      ],
    });
  });

  it("rejects a request whose evidence hash is not the signed-scope hash", async () => {
    const f = paymentEvidenceFixture();

    await expect(f.verify({ evidenceHash: "e".repeat(64) })).resolves.toEqual({
      disposition: "invalid",
      reason: "payment evidence cryptographic verification failed",
    });
    await expect(onlyVerifierOutcome()).resolves.toEqual({
      decision: "fail",
      reasons: ["attestationRef.contentHash does not match the evidence's signed-scope hash"],
    });
  });

  it("rejects seller-named payment evidence whose signature does not verify", async () => {
    const f = paymentEvidenceFixture();
    const forged = signEvidence(x402EvidenceInput(), EVIDENCE_SELLER, EVIDENCE_BUYER_SEED);

    await expect(f.verify({
      evidence: forged,
      evidenceHash: contentHash(forged),
    })).resolves.toEqual({
      disposition: "invalid",
      reason: "payment evidence cryptographic verification failed",
    });
    await expect(onlyVerifierOutcome()).resolves.toEqual({
      decision: "fail",
      reasons: ["evidence signature does not verify under the signer's key"],
    });
  });

  it("rejects a superseding resolution record at the unresolved payment address", async () => {
    const f = paymentEvidenceFixture();
    const superseding = signEvidence(x402EvidenceInput({
      supersedesEvidenceRef: {
        anchor: { kind: "storage-program", locator: PAYMENT_ADDRESS },
        contentHash: contentHash(f.evidence),
        signer: EVIDENCE_SELLER,
      },
    }), EVIDENCE_SELLER);

    await expect(f.verify({
      evidence: superseding,
      evidenceHash: contentHash(superseding),
    })).resolves.toEqual({
      disposition: "invalid",
      reason: "payment evidence cryptographic verification failed",
    });
    await expect(onlyVerifierOutcome()).resolves.toEqual({
      decision: "fail",
      reasons: [
        "paymentAddress resolved discriminator contradicts SettlementEvidence supersession",
      ],
    });
  });
});

describe("fixed-price x402 buyer authenticated finality policy", () => {
  it.each([
    {},
    { finalityBlocks: 0 },
    { finalityBlocks: 1.5 },
  ])("rejects an unavailable or invalid authenticated finality depth", (parameters) => {
    expect(() => receivedFixture(parameters)).toThrow(TypeError);
  });
});
