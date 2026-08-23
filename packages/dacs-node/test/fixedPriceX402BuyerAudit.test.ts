import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ARTIFACT_SEPARATORS,
  FINALITY_COMMITMENT_SEPARATOR,
  finalityCommitmentAddress,
  fixedPriceAgreementLogicalAddress,
  isSettlementEvidence,
  prepareCompletedSellerBundleCounterSignatureRequest,
  verifyCompletedSellerBundleCounterSignatureRequest,
  x402Eip3009Nonce,
} from "@kynesyslabs/dacs";
import type {
  AnchorReceipt,
  AttestationRef,
  ComponentSignature,
  IdentityBundle,
  Listing,
} from "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash, listingAddress, sha256Hex } from
  "@kynesyslabs/dacs/canonical";
import {
  FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
  FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
  FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  fixedPricePayDemOrderBindingHash,
  fixedPricePayDemOrderLocalBindingHash,
  fixedPriceX402OrderBindingHash,
  fixedPriceX402OrderLocalBindingHash,
} from "@kynesyslabs/dacs/commerce";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
  signedBytes,
} from "@kynesyslabs/dacs/crypto";
import { identityBundleHash } from "@kynesyslabs/dacs/identity";
import {
  deriveFixedPriceAgreement,
  signFixedPriceAgreement,
} from "@kynesyslabs/dacs/negotiate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agreementPublication: vi.fn(),
  nativeAgreementPublication: vi.fn(),
  nativeSessionFacts: vi.fn(),
  observeX402Transfer: vi.fn(),
  provenance: vi.fn(),
  sessionFacts: vi.fn(),
}));

vi.mock("@kynesyslabs/dacs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kynesyslabs/dacs")>()),
  getAuthenticatedRailProvenance: mocks.provenance,
}));

vi.mock("../src/fixedPriceX402Profile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/fixedPriceX402Profile.js")>()),
  loadDacsFixedPriceX402BuyerAgreementPublicationV1:
    mocks.agreementPublication,
}));

vi.mock("../src/fixedPricePayDemProfile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/fixedPricePayDemProfile.js")>()),
  loadDacsFixedPricePayDemBuyerAgreementPublicationV1:
    mocks.nativeAgreementPublication,
}));

vi.mock("../src/sessionBootstrapAgreementRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/sessionBootstrapAgreementRuntime.js")
  >()),
  loadDacsBuyerSessionAgreementFactsForOrderV1: mocks.sessionFacts,
  loadDacsPayDemBuyerSessionAgreementFactsForOrderV1: mocks.nativeSessionFacts,
}));

vi.mock("../src/x402SellerEvm.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/x402SellerEvm.js")>()),
  createDacsX402SellerEvmObserverV1: () => ({
    observeX402Transfer: mocks.observeX402Transfer,
  }),
}));

import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import {
  createDacsFixedPricePayDemBuyerAuditV1,
  createDacsFixedPriceX402BuyerAuditV1,
} from
  "../src/fixedPriceX402BuyerAudit.js";
import {
  createDacsFixedPricePayDemOrderPairV1,
  createDacsFixedPriceX402OrderPairV1,
} from "../src/liveOrder.js";
import { putDacsLiveOrderInputV1 } from "../src/orderInput.js";
import type { DacsLiveRoleOperationContextV1 } from "../src/roleRuntime.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";

const NOW = 1_786_000_000_000;
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER_SEED = Uint8Array.from(Buffer.alloc(32, 51));
const SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 52));
const BUYER_KEY = rawPublicKey(publicKeyFromSeed(BUYER_SEED));
const SELLER_KEY = rawPublicKey(publicKeyFromSeed(SELLER_SEED));
const BUYER = `did:demos:agent:${Buffer.from(BUYER_KEY).toString("hex")}`;
const SELLER = `did:demos:agent:${Buffer.from(SELLER_KEY).toString("hex")}`;
const BUYER_EVM = `0x${"1".repeat(40)}`;
const SELLER_EVM = `0x${"2".repeat(40)}`;
const ASSET = `0x${"3".repeat(40)}`;
const RESOURCE = "https://seller.example/dacs/x402";
const EMPTY_REQUIREMENT = Object.freeze({ requirementVersion: "1" as const, required: [] });
const roots: string[] = [];
const databases: DacsNodeSqliteDatabase[] = [];

function signComponent<T extends Record<string, unknown>>(
  unsigned: T,
  separator: Parameters<typeof signedBytes>[0],
  signer: typeof BUYER | typeof SELLER,
): T & { signature: ComponentSignature } {
  const seed = signer === BUYER ? BUYER_SEED : SELLER_SEED;
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

function identity(
  claim: typeof BUYER | typeof SELLER,
  evm: string,
): IdentityBundle {
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

function receipt(
  logicalAddress: string,
  nativeAddress: string,
  artifact: Readonly<Record<string, unknown>>,
  writer: string,
  timestamp: number,
): AnchorReceipt {
  return {
    receiptVersion: "1",
    substrate: "demos",
    finalityProfile: "demos-bft-confirmed-native-read",
    logicalAddress,
    nativeAddress,
    contentHash: contentHash(artifact),
    transactionRef: { kind: "demos-storage-program", value: `tx:${nativeAddress}` },
    writer,
    state: "finalized",
    observationDisposition: "established",
    observedAt: timestamp,
    blockRef: { id: `block:${nativeAddress}`, height: "1", timestamp },
    evidence: { kind: "demos-bft-write-proof-v1", value: `proof:${nativeAddress}` },
  };
}

function protocol() {
  return {
    commerceProfile: FIXED_PRICE_X402_COMMERCE_PROFILE,
    standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
    phase: "pay-x402" as const,
    orchestratorTopology: "seller-as-phase-orchestrator-v1" as const,
    orchestrator: SELLER,
    rail: {
      registryIndexRef: FIXED_PRICE_X402_REGISTRY_INDEX_REF,
      registryIndexHash: "a".repeat(64),
      railDefinitionRef: "dacs4:rail:x402%3Atest:2",
      railDefinitionHash: "b".repeat(64),
      railId: "x402:test",
      railVersion: 2,
      railType: "x402" as const,
      phaseHandler: "pay-x402" as const,
      network: "eip155:84532" as const,
      availability: "live" as const,
    },
  };
}

function payDemProtocol() {
  return {
    commerceProfile: FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
    standardRevision: FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
    phase: "pay-dem" as const,
    orchestratorTopology: "seller-as-phase-orchestrator-v1" as const,
    orchestrator: SELLER,
    rail: {
      registryIndexRef: FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
      registryIndexHash: "a".repeat(64),
      railDefinitionRef: "dacs4:rail:demos-native%3ADEM:1",
      railDefinitionHash: "b".repeat(64),
      railId: "demos-native:DEM",
      railVersion: 1,
      railType: "demos-native" as const,
      phaseHandler: "pay-dem" as const,
      network: "demos" as const,
      availability: "live" as const,
    },
  };
}

async function fixture() {
  const buyerIdentity = identity(BUYER, BUYER_EVM);
  const sellerIdentity = identity(SELLER, SELLER_EVM);
  const listingUnsigned = {
    dacsVersion: "1" as const,
    listingVersion: 1,
    listingId: "buyer-audit-test",
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
      { kind: "pay-x402" as const, parameters: { rail: "x402:test" } },
      { kind: "deliver-storage-program" as const },
    ],
    pricing: { kind: "fixed" as const, price: { amount: "1", currency: "USDC" } },
    acceptedRails: [{
      railId: "x402:test",
      railVersion: 2,
      parameters: {
        network: "eip155:84532",
        payTo: SELLER_EVM,
        asset: ASSET,
        httpResource: RESOURCE,
      },
    }],
    terms: { deadlineSecAfterCommit: 600 },
    validity: { notBefore: NOW - 60_000, notAfter: NOW + 60_000 },
  };
  const listing = signComponent(
    listingUnsigned as unknown as Record<string, unknown>,
    ARTIFACT_SEPARATORS.Listing,
    SELLER,
  ) as unknown as Listing;
  const listingHash = contentHash(listing as unknown as Record<string, unknown>);
  const listingPin = {
    listingId: listing.listingId,
    version: listing.listingVersion,
    contentHash: listingHash,
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
  const buyerVetRef = ref(`dacs2:vet:${JOB_ID}:buyer`, buyerVet, SELLER);
  const sellerVetRef = ref(`dacs2:vet:${JOB_ID}:seller`, sellerVet, BUYER);
  const unsignedAgreement = deriveFixedPriceAgreement({
    jobId: JOB_ID,
    verifiedListing: { disposition: "verified", listing: structuredClone(listing),
      pin: structuredClone(listingPin) },
    buyer: { identityBundle: structuredClone(buyerIdentity),
      vetRecordRef: structuredClone(buyerVetRef) },
    seller: { identityBundle: structuredClone(sellerIdentity),
      vetRecordRef: structuredClone(sellerVetRef) },
    selectedRail: structuredClone(listing.acceptedRails![0]!),
    payoutBindings: [{ railId: "x402:test", phaseIndex: 2,
      payeeAddress: SELLER_EVM }],
    generatedAt: NOW - 15_000,
  });
  const agreement = await signFixedPriceAgreement(
    unsignedAgreement,
    { party: BUYER, algorithm: "ed25519", sign: (bytes) =>
      ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED)) },
    { party: SELLER, algorithm: "ed25519", sign: (bytes) =>
      ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)) },
  );
  const agreementRecord = agreement as unknown as Record<string, unknown>;
  const agreementHash = contentHash(agreementRecord);
  const agreementLogicalAddress = fixedPriceAgreementLogicalAddress(JOB_ID);
  const commitment = signComponent({
    finalityCommitmentVersion: "1" as const,
    jobId: JOB_ID,
    agreementHash,
    listingRef: listingPin,
    parties: [BUYER, SELLER],
    pattern: "fixed-price" as const,
    createdAt: NOW - 12_000,
  }, FINALITY_COMMITMENT_SEPARATOR, SELLER);
  const commitmentLogicalAddress = finalityCommitmentAddress(JOB_ID);
  const commitmentRef = ref(commitmentLogicalAddress, commitment, SELLER);
  const event = {
    kind: "x402-event" as const,
    httpResource: `${RESOURCE}/${JOB_ID}`,
    paymentReceiptHash: "c".repeat(64),
    settlementTxHash: "d".repeat(64),
    chainId: 84_532,
    logIndex: 0,
    protocolVersion: "2",
  };
  const paymentEvidence = signComponent({
    evidenceVersion: "1" as const,
    jobId: JOB_ID,
    phase: "pay-x402" as const,
    outcome: "success" as const,
    paymentTxRefs: [event],
    paymentAmount: { amount: "1", currency: "USDC" },
    settlementFinality: { model: "block-depth" as const, finalityBlocks: 2,
      finalityObservedAt: NOW - 3_000 },
    observedAt: NOW - 3_000,
  }, ARTIFACT_SEPARATORS.SettlementEvidence, SELLER);
  const paymentLogicalAddress = `dacs4:payment:${JOB_ID}:x402%3Atest:2`;
  const paymentRef = ref(paymentLogicalAddress, paymentEvidence, SELLER);
  const deliverable = { result: "delivered" };
  const deliverableHash = contentHash(deliverable);
  const deliverableLogicalAddress = `dacs4:deliverable:${JOB_ID}`;
  const deliveryEvidence = signComponent({
    evidenceVersion: "1" as const,
    jobId: JOB_ID,
    phase: "deliver-storage-program" as const,
    outcome: "success" as const,
    observedAt: NOW - 2_000,
    deliverableContentHash: deliverableHash,
    deliverableAnchor: { kind: "storage-program", locator: deliverableLogicalAddress },
  }, ARTIFACT_SEPARATORS.SettlementEvidence, SELLER);
  const deliveryLogicalAddress = `dacs4:delivery-evidence:${JOB_ID}`;
  const deliveryRef = ref(deliveryLogicalAddress, deliveryEvidence, SELLER);

  const artifacts = new Map<string, Readonly<Record<string, unknown>>>();
  const names = new Map<string, string>();
  const receipts = new Map<string, AnchorReceipt>();
  let nextAddress = 1;
  const add = (logicalAddress: string, artifact: Readonly<Record<string, unknown>>,
    writer: string, timestamp: number, nativeAddress?: string) => {
    const native = nativeAddress ?? `stor-${String(nextAddress++).padStart(40, "0")}`;
    artifacts.set(native, structuredClone(artifact));
    names.set(logicalAddress, native);
    receipts.set(native, receipt(logicalAddress, native, artifact, writer, timestamp));
    return native;
  };
  const listingRef = add(
    listingAddress(SELLER, listing.listingId, listing.listingVersion),
    listing as unknown as Record<string, unknown>,
    SELLER,
    NOW - 18_000,
  );
  add(agreementLogicalAddress, agreementRecord, BUYER, NOW - 14_000);
  add(commitmentLogicalAddress, commitment, SELLER, NOW - 11_000);
  const buyerVetNative = add(buyerVetRef.anchor.locator, buyerVet, SELLER, NOW - 16_000);
  const sellerVetNative = add(sellerVetRef.anchor.locator, sellerVet, BUYER, NOW - 16_000);
  add(paymentLogicalAddress, paymentEvidence, BUYER, NOW - 3_000);
  add(deliveryLogicalAddress, deliveryEvidence, SELLER, NOW - 2_000);
  add(deliverableLogicalAddress, deliverable, SELLER, NOW - 2_500);

  const phaseSummary = [
    { index: 0, kind: "negotiate-fixed-price", outcome: "ok" },
    { index: 1, kind: "commit-payee-bound-agreement", outcome: "ok",
      attestationRef: commitmentRef },
    { index: 2, kind: "pay-x402", outcome: "ok", txRefs: [event],
      attestationRef: paymentRef },
    { index: 3, kind: "deliver-storage-program", outcome: "ok",
      attestationRef: deliveryRef },
  ];
  const signedScope = {
    faultBundleVersion: "1",
    jobId: JOB_ID,
    outcome: "completed",
    faultedParty: "none",
    listingRef: listingPin,
    agreementRef: {
      anchor: { kind: "storage-program", locator: agreementLogicalAddress },
      contentHash: agreementHash,
      signer: BUYER,
    },
    parties: [
      { role: "buyer", bundleHash: identityBundleHash(buyerIdentity),
        primaryClaim: BUYER },
      { role: "seller", bundleHash: identityBundleHash(sellerIdentity),
        primaryClaim: SELLER },
    ],
    phaseSummary,
    vetRecords: [buyerVetRef, sellerVetRef],
    settlementEvidence: [paymentRef, deliveryRef],
    recipeRegistryVersion: 1,
    railRegistryVersion: 7,
    finalisedAt: NOW,
  };
  const preliminaryRequest = {
    bundleContentHash: "e".repeat(64),
    signedScope,
    signedBytes: Uint8Array.from([1]),
    requiredCounterSigners: [BUYER],
  };
  const application = {
    applicationVersion: "1" as const,
    listingRef,
    listingContentHash: listingHash,
    listingLogicalAddress: listingAddress(SELLER, listing.listingId,
      listing.listingVersion),
    listing,
    requestHash: sha256Hex(canonicalize({ query: "test" })),
    request: { query: "test" },
  };
  const rail = {
    railVersion: 2,
    railId: "x402:test",
    railType: "x402",
    asset: { kind: "erc20", chainId: 84_532, contract: ASSET,
      symbol: "USDC", decimals: 6 },
    network: { kind: "x402-resource", resourceBaseUrl: RESOURCE },
    phaseHandler: "pay-x402",
    parameters: { authorization: "eip-3009", finalityBlocks: 2 },
    availability: "live",
    governance: { proposedBy: SELLER, acceptedAt: NOW - 30_000,
      anchoring: "single-signer" },
    signature: { algorithm: "ed25519", signer: SELLER,
      value: Buffer.alloc(64, 9).toString("base64url") },
  };
  return { agreement, agreementHash, agreementLogicalAddress, application, artifacts,
    buyerIdentity, buyerVet, buyerVetNative, buyerVetRef, commitmentRef,
    deliveryEvidence, deliveryRef, event, names, paymentEvidence, paymentRef,
    preliminaryRequest, rail, receipts, sellerIdentity, sellerVet, sellerVetNative,
    sellerVetRef };
}

async function payDemFixture() {
  const base = await fixture();
  const railId = "demos-native:DEM";
  const sellerPayee = Buffer.from(SELLER_KEY).toString("hex");
  const listingUnsigned = {
    ...structuredClone(base.application.listing),
    pipeline: [
      { kind: "negotiate-fixed-price" as const },
      { kind: "commit-payee-bound-agreement" as const },
      { kind: "pay-dem" as const, parameters: { rail: railId } },
      { kind: "deliver-storage-program" as const },
    ],
    pricing: { kind: "fixed" as const,
      price: { amount: "1", currency: "DEM" } },
    acceptedRails: [{
      railId,
      railVersion: 1,
      parameters: { network: "demos", payTo: sellerPayee },
    }],
  } as Record<string, unknown>;
  delete listingUnsigned.signature;
  const listing = signComponent(
    listingUnsigned,
    ARTIFACT_SEPARATORS.Listing,
    SELLER,
  ) as unknown as Listing;
  const listingHash = contentHash(listing as unknown as Record<string, unknown>);
  const listingPin = {
    listingId: listing.listingId,
    version: listing.listingVersion,
    contentHash: listingHash,
  };
  const unsignedAgreement = deriveFixedPriceAgreement({
    jobId: JOB_ID,
    verifiedListing: { disposition: "verified", listing: structuredClone(listing),
      pin: structuredClone(listingPin) },
    buyer: { identityBundle: structuredClone(base.buyerIdentity),
      vetRecordRef: structuredClone(base.buyerVetRef) },
    seller: { identityBundle: structuredClone(base.sellerIdentity),
      vetRecordRef: structuredClone(base.sellerVetRef) },
    selectedRail: structuredClone(listing.acceptedRails![0]!),
    payoutBindings: [{ railId, phaseIndex: 2, payeeAddress: sellerPayee }],
    generatedAt: NOW - 15_000,
  });
  const agreement = await signFixedPriceAgreement(
    unsignedAgreement,
    { party: BUYER, algorithm: "ed25519", sign: (bytes) =>
      ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED)) },
    { party: SELLER, algorithm: "ed25519", sign: (bytes) =>
      ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)) },
  );
  const agreementHash = contentHash(agreement as unknown as Record<string, unknown>);
  const commitment = signComponent({
    finalityCommitmentVersion: "1" as const,
    jobId: JOB_ID,
    agreementHash,
    listingRef: listingPin,
    parties: [BUYER, SELLER],
    pattern: "fixed-price" as const,
    createdAt: NOW - 12_000,
  }, FINALITY_COMMITMENT_SEPARATOR, SELLER);
  const commitmentRef = ref(base.commitmentRef.anchor.locator, commitment, SELLER);
  const event = {
    kind: "demos" as const,
    txHash: "f".repeat(64),
    blockNumber: 123,
  };
  const paymentEvidence = signComponent({
    evidenceVersion: "1" as const,
    jobId: JOB_ID,
    phase: "pay-dem" as const,
    outcome: "success" as const,
    paymentTxRefs: [event],
    paymentAmount: { amount: "1", currency: "DEM" },
    settlementFinality: { model: "bft-final" as const,
      finalityObservedAt: NOW - 3_000 },
    observedAt: NOW - 3_000,
  }, ARTIFACT_SEPARATORS.SettlementEvidence, SELLER);
  const paymentLogicalAddress = `dacs4:payment:${JOB_ID}:demos-native%3ADEM:2`;
  const paymentRef = ref(paymentLogicalAddress, paymentEvidence, SELLER);

  const artifacts = new Map(base.artifacts);
  const names = new Map(base.names);
  const receipts = new Map(base.receipts);
  const replace = (logicalAddress: string, artifact: Readonly<Record<string, unknown>>,
    writer: string, timestamp: number, nativeAddress: string) => {
    artifacts.set(nativeAddress, structuredClone(artifact));
    names.set(logicalAddress, nativeAddress);
    receipts.set(nativeAddress, receipt(
      logicalAddress,
      nativeAddress,
      artifact,
      writer,
      timestamp,
    ));
  };
  replace(base.application.listingLogicalAddress,
    listing as unknown as Record<string, unknown>, SELLER, NOW - 18_000,
    base.application.listingRef);
  replace(base.agreementLogicalAddress,
    agreement as unknown as Record<string, unknown>, BUYER, NOW - 14_000,
    names.get(base.agreementLogicalAddress)!);
  replace(commitmentRef.anchor.locator, commitment, SELLER, NOW - 11_000,
    names.get(commitmentRef.anchor.locator)!);
  const oldPaymentNative = names.get(base.paymentRef.anchor.locator)!;
  names.delete(base.paymentRef.anchor.locator);
  replace(paymentLogicalAddress, paymentEvidence, BUYER, NOW - 3_000,
    oldPaymentNative);

  const phaseSummary = [
    { index: 0, kind: "negotiate-fixed-price", outcome: "ok" },
    { index: 1, kind: "commit-payee-bound-agreement", outcome: "ok",
      attestationRef: commitmentRef },
    { index: 2, kind: "pay-dem", outcome: "ok", txRefs: [event],
      attestationRef: paymentRef },
    { index: 3, kind: "deliver-storage-program", outcome: "ok",
      attestationRef: base.deliveryRef },
  ];
  const preliminaryRequest = {
    bundleContentHash: "e".repeat(64),
    signedScope: {
      ...structuredClone(base.preliminaryRequest.signedScope),
      listingRef: listingPin,
      agreementRef: {
        anchor: { kind: "storage-program", locator: base.agreementLogicalAddress },
        contentHash: agreementHash,
        signer: BUYER,
      },
      phaseSummary,
      settlementEvidence: [paymentRef, base.deliveryRef],
    },
    signedBytes: Uint8Array.from([1]),
    requiredCounterSigners: [BUYER],
  };
  const application = {
    ...structuredClone(base.application),
    listingContentHash: listingHash,
    listing,
  };
  const rail = {
    railVersion: 1,
    railId,
    railType: "demos-native",
    asset: { kind: "native-dem", symbol: "DEM", decimals: 9 },
    network: { kind: "demos" },
    phaseHandler: "pay-dem",
    parameters: {},
    availability: "live",
    governance: { proposedBy: SELLER, acceptedAt: NOW - 30_000,
      anchoring: "single-signer" },
    signature: { algorithm: "ed25519", signer: SELLER,
      value: Buffer.alloc(64, 9).toString("base64url") },
  };
  return { ...base, agreement, agreementHash, application, artifacts,
    commitmentRef, event, names, paymentEvidence, paymentRef,
    preliminaryRequest, rail, receipts };
}

describe("fixed-price x402 buyer audit reconstruction", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    for (const database of databases.splice(0).reverse()) database.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("independently reconstructs and verifies the exact seller review request", async () => {
    const f = await fixture();
    for (const evidence of [f.paymentEvidence, f.deliveryEvidence]) {
      expect(isSettlementEvidence(evidence)).toBe(true);
      expect(ed25519Verify(
        signedBytes(ARTIFACT_SEPARATORS.SettlementEvidence, contentHash(evidence)),
        Uint8Array.from(Buffer.from(evidence.signature.value, "base64url")),
        publicKeyFromRaw(SELLER_KEY),
      )).toBe(true);
    }
    const root = mkdtempSync(join(tmpdir(), "dacs-buyer-audit-"));
    roots.push(root);
    const database = await openDacsNodeSqliteDatabase({
      databasePath: join(root, "buyer.sqlite"),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      authority: BUYER,
    });
    databases.push(database);
    const pair = createDacsFixedPriceX402OrderPairV1({
      jobId: JOB_ID,
      buyer: BUYER,
      seller: SELLER,
      protocol: protocol(),
    });
    await database.createLiveCoordinatorStore("buyer").create({
      role: "buyer",
      order: pair.buyer,
      bindingHash: fixedPriceX402OrderBindingHash(pair.buyer),
      localBindingHash: fixedPriceX402OrderLocalBindingHash(pair.buyer),
    });
    expect(putDacsLiveOrderInputV1({
      database,
      order: pair.buyer,
      application: f.application,
    }).status).toBe("created");
    mocks.provenance.mockReturnValue({
      registryVersion: 7,
      indexContentHash: "a".repeat(64),
      definitionContentHash: "b".repeat(64),
    });
    mocks.sessionFacts.mockReturnValue({
      factsVersion: "1",
      role: "buyer",
      jobId: JOB_ID,
      localBindingHash: fixedPriceX402OrderLocalBindingHash(pair.buyer),
      buyerIdentity: f.buyerIdentity,
      sellerIdentity: f.sellerIdentity,
      buyerRequirementHash: sha256Hex(canonicalize(EMPTY_REQUIREMENT)),
      buyerVetRecord: f.buyerVet,
      buyerVetRef: f.buyerVetRef,
      buyerVetReceipt: f.receipts.get(f.buyerVetNative),
      sellerRequirementHash: sha256Hex(canonicalize(EMPTY_REQUIREMENT)),
      sellerVetRecord: f.sellerVet,
      sellerVetRef: f.sellerVetRef,
      sellerVetReceipt: f.receipts.get(f.sellerVetNative),
    });
    mocks.agreementPublication.mockReturnValue({
      publicationVersion: "1",
      jobId: JOB_ID,
      localBindingHash: fixedPriceX402OrderLocalBindingHash(pair.buyer),
      writer: BUYER,
      logicalAddress: f.agreementLogicalAddress,
      agreementHash: f.agreementHash,
      artifact: f.agreement,
    });
    const observation = {
      status: "finalized" as const,
      chainId: 84_532,
      txHash: `0x${f.event.settlementTxHash}`,
      logIndex: 0,
      payer: BUYER_EVM,
      payee: SELLER_EVM,
      amountBaseUnits: "1000000",
      asset: { contract: ASSET, symbol: "USDC", decimals: 6 },
      confirmations: 3,
      includedAt: NOW - 5_000,
      finalityObservedAt: NOW - 3_000,
      sessionBinding: { kind: "eip3009" as const,
        nonce: x402Eip3009Nonce(JOB_ID, 2) },
    };
    mocks.observeX402Transfer.mockResolvedValue(observation);
    const adapter = {
      resolveAnchorByName: vi.fn(async (logicalAddress: string) => {
        const address = f.names.get(logicalAddress);
        return address === undefined
          ? { status: "absent" as const }
          : { status: "present" as const, address };
      }),
      readAnchor: vi.fn(async (address: string) =>
        structuredClone(f.artifacts.get(address) ?? null)),
      resolveDemosAnchorReceipt: vi.fn(async (input: { nativeAddress: string }) =>
        structuredClone(f.receipts.get(input.nativeAddress) ?? null)),
      verifyDemosAnchorReceipt: vi.fn(async () => true),
      anchorWriteOnce: vi.fn(),
      sign: vi.fn(),
    };
    const context = {
      role: "buyer",
      authority: BUYER,
      peerAuthority: SELLER,
      database,
      demos: { publicKey: BUYER_KEY, adapter,
        signComponent: vi.fn(async () => Uint8Array.from(Buffer.alloc(64, 4))) },
      evm: { role: "buyer", address: BUYER_EVM },
    } as unknown as DacsLiveRoleOperationContextV1;
    const audit = createDacsFixedPriceX402BuyerAuditV1({
      context,
      rail: f.rail as never,
      evmRpcUrl: "https://rpc.example",
      authorizationSearchFromBlock: 1,
      recipeRegistryVersion: 1,
    });
    const authenticated = {
      envelope: { sender: SELLER, audience: BUYER, jobId: JOB_ID },
    } as never;
    const preliminary = await audit.bundleTransport.resolveVerification({
      authenticated,
      request: f.preliminaryRequest,
    });
    const exactRequest = prepareCompletedSellerBundleCounterSignatureRequest({
      ...preliminary.input,
      seller: {
        ...preliminary.input.seller,
        signer: async (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
      },
    });
    const exact = await audit.bundleTransport.resolveVerification({
      authenticated,
      request: exactRequest,
    });
    await expect(verifyCompletedSellerBundleCounterSignatureRequest(
      exact.input,
      exactRequest,
      exact.provider,
    )).resolves.toEqual(exactRequest);
    expect(mocks.observeX402Transfer).toHaveBeenLastCalledWith({
      chainId: observation.chainId,
      txHash: observation.txHash,
    });

    mocks.observeX402Transfer.mockResolvedValueOnce({
      ...observation,
      amountBaseUnits: "1000001",
    });
    await expect(audit.bundleTransport.resolveVerification({
      authenticated,
      request: exactRequest,
    })).rejects.toMatchObject({ reasonCode: "buyer-audit-native-finality-invalid" });
  });

  it("independently re-observes native DEM before accepting the audit request", async () => {
    const f = await payDemFixture();
    const root = mkdtempSync(join(tmpdir(), "dacs-pay-dem-buyer-audit-"));
    roots.push(root);
    const database = await openDacsNodeSqliteDatabase({
      databasePath: join(root, "buyer.sqlite"),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      authority: BUYER,
    });
    databases.push(database);
    const pair = createDacsFixedPricePayDemOrderPairV1({
      jobId: JOB_ID,
      buyer: BUYER,
      seller: SELLER,
      protocol: payDemProtocol(),
    });
    await database.createPayDemCoordinatorStore("buyer").create({
      role: "buyer",
      order: pair.buyer,
      bindingHash: fixedPricePayDemOrderBindingHash(pair.buyer),
      localBindingHash: fixedPricePayDemOrderLocalBindingHash(pair.buyer),
    });
    expect(putDacsLiveOrderInputV1({
      database,
      order: pair.buyer,
      application: f.application,
    }).status).toBe("created");
    mocks.provenance.mockReturnValue({
      registryVersion: 7,
      indexContentHash: "a".repeat(64),
      definitionContentHash: "b".repeat(64),
    });
    mocks.nativeSessionFacts.mockReturnValue({
      factsVersion: "1",
      role: "buyer",
      jobId: JOB_ID,
      localBindingHash: fixedPricePayDemOrderLocalBindingHash(pair.buyer),
      buyerIdentity: f.buyerIdentity,
      sellerIdentity: f.sellerIdentity,
      buyerRequirementHash: sha256Hex(canonicalize(EMPTY_REQUIREMENT)),
      buyerVetRecord: f.buyerVet,
      buyerVetRef: f.buyerVetRef,
      buyerVetReceipt: f.receipts.get(f.buyerVetNative),
      sellerRequirementHash: sha256Hex(canonicalize(EMPTY_REQUIREMENT)),
      sellerVetRecord: f.sellerVet,
      sellerVetRef: f.sellerVetRef,
      sellerVetReceipt: f.receipts.get(f.sellerVetNative),
    });
    mocks.nativeAgreementPublication.mockReturnValue({
      publicationVersion: "1",
      jobId: JOB_ID,
      localBindingHash: fixedPricePayDemOrderLocalBindingHash(pair.buyer),
      writer: BUYER,
      logicalAddress: f.agreementLogicalAddress,
      agreementHash: f.agreementHash,
      artifact: f.agreement,
    });
    const observation = {
      status: "included" as const,
      txHash: f.event.txHash,
      blockNumber: f.event.blockNumber,
      payer: Buffer.from(BUYER_KEY).toString("hex"),
      payee: Buffer.from(SELLER_KEY).toString("hex"),
      amountOs: "1000000000",
      includedAt: NOW - 3_000,
    };
    const observeDemosTransfer = vi.fn(async () => observation);
    const adapter = {
      resolveAnchorByName: vi.fn(async (logicalAddress: string) => {
        const address = f.names.get(logicalAddress);
        return address === undefined
          ? { status: "absent" as const }
          : { status: "present" as const, address };
      }),
      readAnchor: vi.fn(async (address: string) =>
        structuredClone(f.artifacts.get(address) ?? null)),
      resolveDemosAnchorReceipt: vi.fn(async (input: { nativeAddress: string }) =>
        structuredClone(f.receipts.get(input.nativeAddress) ?? null)),
      verifyDemosAnchorReceipt: vi.fn(async () => true),
      anchorWriteOnce: vi.fn(),
      sign: vi.fn(),
    };
    const context = {
      role: "buyer",
      authority: BUYER,
      peerAuthority: SELLER,
      database,
      demos: { publicKey: BUYER_KEY, adapter,
        signComponent: vi.fn(async () => Uint8Array.from(Buffer.alloc(64, 4))) },
    } as unknown as DacsLiveRoleOperationContextV1;
    const audit = createDacsFixedPricePayDemBuyerAuditV1({
      context,
      rail: f.rail as never,
      observeDemosTransfer,
      recipeRegistryVersion: 1,
    });
    const authenticated = {
      envelope: { sender: SELLER, audience: BUYER, jobId: JOB_ID },
    } as never;
    const preliminary = await audit.bundleTransport.resolveVerification({
      authenticated,
      request: f.preliminaryRequest as never,
    });
    const exactRequest = prepareCompletedSellerBundleCounterSignatureRequest({
      ...preliminary.input,
      seller: {
        ...preliminary.input.seller,
        signer: async (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
      },
    });
    const exact = await audit.bundleTransport.resolveVerification({
      authenticated,
      request: exactRequest,
    });
    await expect(verifyCompletedSellerBundleCounterSignatureRequest(
      exact.input,
      exactRequest,
      exact.provider,
    )).resolves.toEqual(exactRequest);
    expect(observeDemosTransfer).toHaveBeenLastCalledWith(f.event.txHash);

    observeDemosTransfer.mockResolvedValueOnce({
      ...observation,
      payee: "0".repeat(64),
    });
    await expect(audit.bundleTransport.resolveVerification({
      authenticated,
      request: exactRequest,
    })).rejects.toMatchObject({ reasonCode: "buyer-audit-native-finality-invalid" });
  });
});
