import {
  ARTIFACT_SEPARATORS,
  isAgreementArtifact,
  isSettlementEvidence,
  type AttestationRef,
  type ComponentSignature,
  type IdentityBundle,
  type Listing,
} from "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
  signedBytes,
} from "@kynesyslabs/dacs/crypto";
import { identityBundleHash } from "@kynesyslabs/dacs/identity";
import {
  deriveFixedPriceAgreement,
  signFixedPriceAgreement,
} from "@kynesyslabs/dacs/negotiate";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agreement: vi.fn(),
  payment: vi.fn(),
  verifySettlementEvidence: vi.fn(),
  realVerifySettlementEvidence: undefined as unknown as
    typeof import("@kynesyslabs/dacs").verifySettlementEvidence,
}));

// The real SettlementEvidence verifier runs behind a call-through spy so each
// test observes both the exact authenticated context and the real verdict.
vi.mock("@kynesyslabs/dacs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kynesyslabs/dacs")>();
  mocks.realVerifySettlementEvidence = actual.verifySettlementEvidence;
  return { ...actual, verifySettlementEvidence: mocks.verifySettlementEvidence };
});

vi.mock("../src/fixedPricePayDemProfile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/fixedPricePayDemProfile.js")>()),
  loadDacsFixedPricePayDemBuyerAgreementPublicationV1: mocks.agreement,
}));

vi.mock("../src/payDemPayment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/payDemPayment.js")>()),
  loadDacsPayDemBuyerPaymentForOrderV1: mocks.payment,
}));

import { createDacsFixedPricePayDemBuyerCommerceV1 } from
  "../src/fixedPricePayDemBuyerCommerce.js";

const NOW = 1_786_000_000_000;
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER_SEED = Uint8Array.from(Buffer.alloc(32, 61));
const SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 62));
const BUYER_HEX = Buffer.from(rawPublicKey(publicKeyFromSeed(BUYER_SEED))).toString("hex");
const SELLER_HEX = Buffer.from(rawPublicKey(publicKeyFromSeed(SELLER_SEED))).toString("hex");
const BUYER = `did:demos:agent:${BUYER_HEX}`;
const SELLER = `did:demos:agent:${SELLER_HEX}`;
const RAIL_ID = "demos-native:DEM";
const TX_HASH = "f".repeat(64);
const BLOCK_NUMBER = 123;
const INCLUDED_AT = NOW - 3_000;
const PAYMENT_ADDRESS = `dacs4:payment:${JOB_ID}:demos-native%3ADEM:2`;
const EVIDENCE_ADDRESS = `dacs4:delivery-evidence:${JOB_ID}`;
const DELIVERABLE_ADDRESS = `dacs4:deliverable:${JOB_ID}`;
const EMPTY_REQUIREMENT = Object.freeze({ requirementVersion: "1" as const, required: [] });
const SIGNATURE_REASON = "evidence signature does not verify under the signer's key";

function signComponent<T extends Record<string, unknown>>(
  unsigned: T,
  separator: Parameters<typeof signedBytes>[0],
  signer: string,
  seed: Uint8Array = signer === BUYER ? BUYER_SEED : SELLER_SEED,
): T & { signature: ComponentSignature } {
  return {
    ...unsigned,
    signature: {
      algorithm: "ed25519",
      signer,
      value: Buffer.from(ed25519Sign(
        signedBytes(separator, contentHash(unsigned)),
        privateKeyFromSeed(seed),
      )).toString("base64url"),
    },
  };
}

function identity(claim: string, evm: string): IdentityBundle {
  const signature = Buffer.alloc(64, claim === BUYER ? 7 : 8).toString("base64url");
  return {
    bundleVersion: "1",
    presentedBy: claim,
    presentedAt: NOW - 20_000,
    claims: [{ ref: claim }, { ref: `cci-xm:evm:84532:${evm}` }],
    presentation: {
      kind: "per-claim",
      signatures: [{ ref: claim, signature },
        { ref: `cci-xm:evm:84532:${evm}`, signature }],
    },
  };
}

function ref(
  logicalAddress: string,
  artifact: Readonly<Record<string, unknown>>,
  signer: string,
): AttestationRef {
  return {
    anchor: { kind: "storage-program", locator: logicalAddress },
    contentHash: contentHash(artifact),
    signer,
  };
}

async function signedPayDemAgreement() {
  const buyerIdentity = identity(BUYER, `0x${"1".repeat(40)}`);
  const sellerIdentity = identity(SELLER, `0x${"2".repeat(40)}`);
  const listing = signComponent({
    dacsVersion: "1" as const,
    listingVersion: 1,
    listingId: "pay-dem-buyer-commerce-test",
    seller: {
      identity: sellerIdentity,
      displayName: "Seller",
      publicEndpoint: "https://seller.example",
    },
    offering: {
      title: "Stored result",
      description: "One public result",
      category: "data.test",
      tags: ["test"],
      deliverable: { kind: "storage-program" as const, accessModel: "public" as const },
    },
    buyerRequirement: EMPTY_REQUIREMENT,
    pipeline: [
      { kind: "negotiate-fixed-price" as const },
      { kind: "commit-payee-bound-agreement" as const },
      { kind: "pay-dem" as const, parameters: { rail: RAIL_ID } },
      { kind: "deliver-storage-program" as const },
    ],
    pricing: { kind: "fixed" as const, price: { amount: "1", currency: "DEM" } },
    acceptedRails: [{
      railId: RAIL_ID,
      railVersion: 1,
      parameters: { network: "demos", payTo: SELLER_HEX },
    }],
    terms: { deadlineSecAfterCommit: 600 },
    validity: { notBefore: NOW - 60_000, notAfter: NOW + 60_000 },
  } as unknown as Record<string, unknown>, ARTIFACT_SEPARATORS.Listing, SELLER) as
    unknown as Listing;
  const listingPin = {
    listingId: listing.listingId,
    version: listing.listingVersion,
    contentHash: contentHash(listing as unknown as Record<string, unknown>),
  };
  const buyerVet = signComponent({
    recordVersion: "1" as const,
    jobId: JOB_ID,
    evaluatedParty: BUYER,
    bundleHash: identityBundleHash(buyerIdentity),
    requirementHash: sha256Hex(canonicalize(EMPTY_REQUIREMENT)),
    freshness: [],
    supplementary: [],
    dealSpecific: [],
    overallDecision: "pass" as const,
    generatedAt: NOW - 16_000,
  }, ARTIFACT_SEPARATORS.CompositeVerificationRecord, SELLER);
  const sellerVet = signComponent({
    recordVersion: "1" as const,
    jobId: JOB_ID,
    evaluatedParty: SELLER,
    bundleHash: identityBundleHash(sellerIdentity),
    requirementHash: sha256Hex(canonicalize(EMPTY_REQUIREMENT)),
    freshness: [],
    supplementary: [],
    dealSpecific: [],
    overallDecision: "pass" as const,
    generatedAt: NOW - 16_000,
  }, ARTIFACT_SEPARATORS.CompositeVerificationRecord, BUYER);
  const unsignedAgreement = deriveFixedPriceAgreement({
    jobId: JOB_ID,
    verifiedListing: { disposition: "verified", listing: structuredClone(listing),
      pin: structuredClone(listingPin) },
    buyer: { identityBundle: structuredClone(buyerIdentity),
      vetRecordRef: ref(`dacs2:vet:${JOB_ID}:buyer`, buyerVet, SELLER) },
    seller: { identityBundle: structuredClone(sellerIdentity),
      vetRecordRef: ref(`dacs2:vet:${JOB_ID}:seller`, sellerVet, BUYER) },
    selectedRail: structuredClone(listing.acceptedRails![0]!),
    payoutBindings: [{ railId: RAIL_ID, phaseIndex: 2, payeeAddress: SELLER_HEX }],
    generatedAt: NOW - 15_000,
  });
  return signFixedPriceAgreement(
    unsignedAgreement,
    { party: BUYER, algorithm: "ed25519", sign: (bytes) =>
      ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED)) },
    { party: SELLER, algorithm: "ed25519", sign: (bytes) =>
      ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)) },
  );
}

function paymentEvidenceInput(extra: Record<string, unknown> = {}) {
  return {
    evidenceVersion: "1" as const,
    jobId: JOB_ID,
    phase: "pay-dem" as const,
    outcome: "success" as const,
    paymentTxRefs: [{ kind: "demos" as const, txHash: TX_HASH, blockNumber: BLOCK_NUMBER }],
    paymentAmount: { amount: "1", currency: "DEM" },
    settlementFinality: { model: "bft-final" as const, finalityObservedAt: INCLUDED_AT },
    observedAt: INCLUDED_AT,
    ...extra,
  };
}

function deliveryEvidenceInput(deliverable: Readonly<Record<string, unknown>>) {
  return {
    evidenceVersion: "1" as const,
    jobId: JOB_ID,
    phase: "deliver-storage-program" as const,
    outcome: "success" as const,
    observedAt: NOW - 2_000,
    deliverableContentHash: contentHash(deliverable),
    deliverableAnchor: { kind: "storage-program", locator: DELIVERABLE_ADDRESS },
  };
}

async function fixture() {
  const agreement = await signedPayDemAgreement();
  const deliverable = { result: "native delivery" };
  const deliveryEvidence = signComponent(
    deliveryEvidenceInput(deliverable),
    ARTIFACT_SEPARATORS.SettlementEvidence,
    SELLER,
  );
  const paymentEvidence = signComponent(
    paymentEvidenceInput(),
    ARTIFACT_SEPARATORS.SettlementEvidence,
    SELLER,
  );
  const state = {
    coordinatorSeller: SELLER,
    anchors: new Map<string, Readonly<Record<string, unknown>>>([
      [EVIDENCE_ADDRESS, deliveryEvidence],
    ]),
    receipt: {} as Record<string, unknown>,
    receiptVerified: true,
    observed: {
      status: "included",
      txHash: TX_HASH,
      blockNumber: BLOCK_NUMBER,
      payer: BUYER_HEX,
      payee: SELLER_HEX,
      amountOs: "1000000000",
      includedAt: INCLUDED_AT,
    } as Record<string, unknown>,
  };
  mocks.agreement.mockResolvedValue({ artifact: agreement });
  mocks.payment.mockReturnValue({
    payment: { railId: RAIL_ID, phaseIndex: 2, payer: BUYER_HEX, payee: SELLER_HEX },
    result: { settlement: { txHash: TX_HASH, blockNumber: BLOCK_NUMBER } },
  });
  const observeDemosTransfer = vi.fn(async () => ({ ...state.observed }));
  const context = {
    role: "buyer",
    authority: BUYER,
    peerAuthority: SELLER,
    commerceStores: { role: "buyer" },
    database: {
      createPayDemCoordinatorStore: () => ({
        load: async (role: string, jobId: string) => role === "buyer" && jobId === JOB_ID
          ? { status: "ok", record: { jobId, buyer: BUYER, seller: state.coordinatorSeller } }
          : { status: "missing" },
      }),
    },
    demos: {
      adapter: {
        resolveAnchorByName: async (logicalAddress: string, owner: string) =>
          owner === SELLER_HEX && state.anchors.has(logicalAddress)
            ? { status: "present", address: `native:${logicalAddress}` }
            : { status: "absent" },
        readAnchor: async (address: string) =>
          state.anchors.get(address.replace(/^native:/, "")) ?? null,
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
          ...state.receipt,
        }),
        verifyDemosAnchorReceipt: async () => state.receiptVerified,
      },
    },
  };
  const commerce = createDacsFixedPricePayDemBuyerCommerceV1({
    context: context as never,
    rail: {
      railId: RAIL_ID,
      railType: "demos-native",
      phaseHandler: "pay-dem",
      asset: { kind: "native-dem", symbol: "DEM", decimals: 9 },
      network: { kind: "demos" },
    } as never,
    observeDemosTransfer: observeDemosTransfer as never,
  });
  const authorize = (
    payload: Readonly<Record<string, unknown>> = deliverable,
    record: Readonly<{ logicalAddress: string; contentHash: string }> = {
      logicalAddress: DELIVERABLE_ADDRESS,
      contentHash: contentHash(deliverable),
    },
  ) => commerce.buyerReceived.authorizeReceived({
    operation: { order: { jobId: JOB_ID } },
    record,
    payload,
  } as never);
  const verify = async (request: Readonly<Record<string, unknown>> = {}) =>
    commerce.paymentEvidence.verifyEvidence({
      jobId: JOB_ID,
      logicalAddress: PAYMENT_ADDRESS,
      evidenceHash: contentHash(paymentEvidence),
      evidence: paymentEvidence,
      ...request,
    } as never);
  return {
    agreement,
    authorize,
    deliverable,
    deliveryEvidence,
    observeDemosTransfer,
    paymentEvidence,
    state,
    verify,
  };
}

async function onlyVerifierOutcome(): Promise<unknown> {
  expect(mocks.verifySettlementEvidence).toHaveBeenCalledTimes(1);
  return mocks.verifySettlementEvidence.mock.results[0]?.value;
}

beforeEach(() => {
  mocks.agreement.mockReset();
  mocks.payment.mockReset();
  mocks.verifySettlementEvidence.mockReset();
  mocks.verifySettlementEvidence.mockImplementation(mocks.realVerifySettlementEvidence);
});

describe("fixed-price native DEM buyer-received authorization", () => {
  it("uses an otherwise-valid signed agreement and evidence fixture", async () => {
    const f = await fixture();
    expect(isAgreementArtifact(f.agreement)).toBe(true);
    expect("payeeBoundAgreementVersion" in f.agreement).toBe(true);
    expect(isSettlementEvidence(f.deliveryEvidence)).toBe(true);
    expect(isSettlementEvidence(f.paymentEvidence)).toBe(true);
  });

  it("authorizes the payload bound by the seller's receipt-verified delivery evidence", async () => {
    const f = await fixture();

    await expect(f.authorize()).resolves.toBe(true);
    expect(mocks.verifySettlementEvidence).toHaveBeenCalledWith(f.deliveryEvidence, {
      orchestrator: SELLER,
      agreement: { amount: "1", currency: "DEM" },
      attestationRef: {
        anchor: { kind: "storage-program", locator: EVIDENCE_ADDRESS },
        contentHash: contentHash(f.deliveryEvidence),
        signer: SELLER,
      },
      result: { ok: true },
      expectedAnchorLocator: DELIVERABLE_ADDRESS,
    }, expect.anything());
    await expect(onlyVerifierOutcome()).resolves.toEqual({ decision: "pass", reasons: [] });
  });

  it.each([
    ["the evidence anchor is absent", (f: Awaited<ReturnType<typeof fixture>>) => {
      f.state.anchors.delete(EVIDENCE_ADDRESS);
    }],
    ["the anchor receipt does not verify", (f: Awaited<ReturnType<typeof fixture>>) => {
      f.state.receiptVerified = false;
    }],
    ["the anchor receipt names another writer", (f: Awaited<ReturnType<typeof fixture>>) => {
      f.state.receipt.writer = BUYER;
    }],
    ["the anchor receipt is not yet included", (f: Awaited<ReturnType<typeof fixture>>) => {
      f.state.receipt.state = "pending";
    }],
  ])("defers when %s", async (_label, change) => {
    const f = await fixture();
    change(f);

    await expect(f.authorize()).resolves.toBe("indeterminate");
    expect(mocks.verifySettlementEvidence).not.toHaveBeenCalled();
  });

  it("rejects a payload whose hash differs from the anchored deliverable commitment", async () => {
    const f = await fixture();

    await expect(f.authorize({ result: "substituted delivery" })).resolves.toBe(false);
    expect(mocks.verifySettlementEvidence).not.toHaveBeenCalled();
  });

  it("rejects evidence that commits to another deliverable locator", async () => {
    const f = await fixture();

    await expect(f.authorize(f.deliverable, {
      logicalAddress: `dacs4:deliverable:${JOB_ID}:other`,
      contentHash: contentHash(f.deliverable),
    })).resolves.toBe(false);
    expect(mocks.verifySettlementEvidence).not.toHaveBeenCalled();
  });

  it("rejects delivery evidence authored by the buyer rather than the seller", async () => {
    const f = await fixture();
    f.state.anchors.set(EVIDENCE_ADDRESS, signComponent(
      deliveryEvidenceInput(f.deliverable),
      ARTIFACT_SEPARATORS.SettlementEvidence,
      BUYER,
    ));

    await expect(f.authorize()).resolves.toBe(false);
    expect(mocks.verifySettlementEvidence).not.toHaveBeenCalled();
  });

  it("rejects seller-named delivery evidence whose signature does not verify", async () => {
    const f = await fixture();
    const forged = signComponent(
      deliveryEvidenceInput(f.deliverable),
      ARTIFACT_SEPARATORS.SettlementEvidence,
      SELLER,
      BUYER_SEED,
    );
    f.state.anchors.set(EVIDENCE_ADDRESS, forged);

    await expect(f.authorize()).resolves.toBe(false);
    await expect(onlyVerifierOutcome()).resolves.toEqual({
      decision: "fail",
      reasons: [SIGNATURE_REASON],
    });
  });

  it("rejects an agreement that is not payee-bound", async () => {
    const f = await fixture();
    const { payeeBoundAgreementVersion: _version, ...unbound } =
      f.agreement as unknown as Record<string, unknown>;
    mocks.agreement.mockResolvedValue({ artifact: unbound });

    await expect(f.authorize()).resolves.toBe(false);
    expect(mocks.verifySettlementEvidence).not.toHaveBeenCalled();
  });

  it("rejects a coordinator record bound to another seller", async () => {
    const f = await fixture();
    f.state.coordinatorSeller = BUYER;

    await expect(f.authorize()).resolves.toBe(false);
    expect(mocks.verifySettlementEvidence).not.toHaveBeenCalled();
  });

  it.each([
    ["indeterminate", "indeterminate"],
    ["error", false],
    ["fail", false],
  ] as const)("maps a %s verifier verdict to %s", async (decision, expected) => {
    const f = await fixture();
    mocks.verifySettlementEvidence.mockResolvedValueOnce({ decision, reasons: ["forced"] });

    await expect(f.authorize()).resolves.toBe(expected);
    expect(mocks.verifySettlementEvidence).toHaveBeenCalledTimes(1);
  });
});

describe("fixed-price native DEM buyer payment-evidence verification", () => {
  it("accepts seller evidence bound to the observed transfer and unresolved PC-2 address", async () => {
    const f = await fixture();

    await expect(f.verify()).resolves.toEqual({ disposition: "valid" });
    expect(f.observeDemosTransfer).toHaveBeenCalledWith(TX_HASH);
    expect(mocks.verifySettlementEvidence).toHaveBeenCalledWith(f.paymentEvidence, {
      orchestrator: SELLER,
      agreement: { amount: "1", currency: "DEM" },
      rail: {
        railId: RAIL_ID,
        railType: "demos-native",
        asset: "DEM",
        network: "demos",
        handler: "pay-dem",
      },
      attestationRef: {
        anchor: { kind: "storage-program", locator: PAYMENT_ADDRESS },
        contentHash: contentHash(f.paymentEvidence),
        signer: SELLER,
      },
      paymentAddress: { railId: RAIL_ID, phaseIndex: 2, resolved: false },
      result: {
        ok: true,
        txRefs: [{ kind: "demos", txHash: TX_HASH, blockNumber: BLOCK_NUMBER }],
      },
    }, expect.anything());
    await expect(onlyVerifierOutcome()).resolves.toEqual({ decision: "pass", reasons: [] });
  });

  it("rejects payment evidence authored by the buyer before observing settlement", async () => {
    const f = await fixture();
    const buyerAuthored = signComponent(
      paymentEvidenceInput(),
      ARTIFACT_SEPARATORS.SettlementEvidence,
      BUYER,
    );

    await expect(f.verify({
      evidence: buyerAuthored,
      evidenceHash: contentHash(buyerAuthored),
    })).resolves.toEqual({
      disposition: "invalid",
      reason: "payment evidence actor binding invalid",
    });
    expect(f.observeDemosTransfer).not.toHaveBeenCalled();
    expect(mocks.verifySettlementEvidence).not.toHaveBeenCalled();
  });

  it("rejects a coordinator record bound to another seller", async () => {
    const f = await fixture();
    f.state.coordinatorSeller = BUYER;

    await expect(f.verify()).resolves.toEqual({
      disposition: "invalid",
      reason: "payment evidence actor binding invalid",
    });
    expect(mocks.verifySettlementEvidence).not.toHaveBeenCalled();
  });

  it("rejects an agreement that is not payee-bound", async () => {
    const f = await fixture();
    const { payeeBoundAgreementVersion: _version, ...unbound } =
      f.agreement as unknown as Record<string, unknown>;
    mocks.agreement.mockResolvedValue({ artifact: unbound });

    await expect(f.verify()).resolves.toEqual({
      disposition: "invalid",
      reason: "payment evidence agreement invalid",
    });
    expect(mocks.verifySettlementEvidence).not.toHaveBeenCalled();
  });

  it.each([
    ["a failed transfer", { status: "failed" }, "invalid"],
    ["an underpaid transfer", { amountOs: "999999999" }, "indeterminate"],
    ["a transfer to another payee", { payee: BUYER_HEX }, "indeterminate"],
    ["a transfer from another payer", { payer: SELLER_HEX }, "indeterminate"],
  ] as const)("does not verify evidence against %s", async (_label, observed, disposition) => {
    const f = await fixture();
    Object.assign(f.state.observed, observed);

    await expect(f.verify()).resolves.toEqual({
      disposition,
      reason: "payment evidence settlement binding invalid",
    });
    expect(mocks.verifySettlementEvidence).not.toHaveBeenCalled();
  });

  it("does not verify evidence whose finality time differs from the observed inclusion", async () => {
    const f = await fixture();
    const shifted = signComponent(paymentEvidenceInput({
      settlementFinality: { model: "bft-final", finalityObservedAt: INCLUDED_AT - 1 },
    }), ARTIFACT_SEPARATORS.SettlementEvidence, SELLER);

    await expect(f.verify({
      evidence: shifted,
      evidenceHash: contentHash(shifted),
    })).resolves.toEqual({
      disposition: "indeterminate",
      reason: "payment evidence settlement binding invalid",
    });
    expect(mocks.verifySettlementEvidence).not.toHaveBeenCalled();
  });

  it.each([
    ["another phase index", `dacs4:payment:${JOB_ID}:demos-native%3ADEM:3`],
    ["the resolved discriminator", `${PAYMENT_ADDRESS}:resolved`],
  ])("rejects evidence anchored at %s", async (_label, logicalAddress) => {
    const f = await fixture();

    await expect(f.verify({ logicalAddress })).resolves.toEqual({
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
    const f = await fixture();

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
    const f = await fixture();
    const forged = signComponent(
      paymentEvidenceInput(),
      ARTIFACT_SEPARATORS.SettlementEvidence,
      SELLER,
      BUYER_SEED,
    );

    await expect(f.verify({
      evidence: forged,
      evidenceHash: contentHash(forged),
    })).resolves.toEqual({
      disposition: "invalid",
      reason: "payment evidence cryptographic verification failed",
    });
    await expect(onlyVerifierOutcome()).resolves.toEqual({
      decision: "fail",
      reasons: [SIGNATURE_REASON],
    });
  });

  it("rejects a superseding resolution record at the unresolved payment address", async () => {
    const f = await fixture();
    const superseding = signComponent(paymentEvidenceInput({
      supersedesEvidenceRef: ref(PAYMENT_ADDRESS, f.paymentEvidence, SELLER),
    }), ARTIFACT_SEPARATORS.SettlementEvidence, SELLER);
    expect(isSettlementEvidence(superseding)).toBe(true);

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

  it("maps an indeterminate verifier verdict without treating it as invalid", async () => {
    const f = await fixture();
    mocks.verifySettlementEvidence.mockResolvedValueOnce({
      decision: "indeterminate",
      reasons: ["forced"],
    });

    await expect(f.verify()).resolves.toEqual({
      disposition: "indeterminate",
      reason: "payment evidence cryptographic verification failed",
    });
  });

  it("reports an unavailable transfer observation as indeterminate", async () => {
    const f = await fixture();
    f.observeDemosTransfer.mockRejectedValueOnce(new Error("rpc unavailable"));

    await expect(f.verify()).resolves.toEqual({
      disposition: "indeterminate",
      reason: "payment evidence verification unavailable",
    });
    expect(mocks.verifySettlementEvidence).not.toHaveBeenCalled();
  });
});
