import { trustedSessionProfile } from "./helpers/sessionProfile.js";
import { admitDacsX402LiveGraph } from "../src/sessionProfileAdmission.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ARTIFACT_SEPARATORS,
  BUNDLE_BINDING_SEPARATOR,
  DacsError,
  FINALITY_COMMITMENT_SEPARATOR,
  SubstrateError,
  IndeterminateSubstrateError,
  attestationBundleHash,
  finalityCommitmentAddress,
  fixedPriceAgreementLogicalAddress,
  isSettlementEvidence,
  prepareCompletedSellerBundleCounterSignatureRequest,
  requireAuthenticatedSessionProfile,
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
import { bundleAddress, canonicalize, contentHash, listingAddress, sha256Hex } from
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
  type CompletedTwoSidedSessionDeadline,
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

// Explicitly non-live harness: the live paths here run against a released
// profile record; the real record at the pin refuses every admission.
vi.mock("../../../src/discovery/standardProfileRelease.js", () => ({ DACS_STANDARD_PROFILE_STATUS: "released" }));

const mocks = vi.hoisted(() => ({
  agreementPublication: vi.fn(),
  bundleRequest: vi.fn(),
  nativeAgreementPublication: vi.fn(),
  nativeSessionFacts: vi.fn(),
  observeX402Transfer: vi.fn(),
  provenance: vi.fn(),
  sessionFacts: vi.fn(),
  verifyCompleted: vi.fn(),
}));

vi.mock("@kynesyslabs/dacs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kynesyslabs/dacs")>()),
  getAuthenticatedRailProvenance: mocks.provenance,
  verifyCompletedTwoSidedSession: mocks.verifyCompleted,
}));

vi.mock("../src/fixedPriceX402Profile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/fixedPriceX402Profile.js")>()),
  loadDacsFixedPriceX402BuyerAgreementPublicationV1:
    mocks.agreementPublication,
}));

vi.mock("../src/bundleTransportRuntime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/bundleTransportRuntime.js")>()),
  loadDacsBuyerBundleSignatureRequestForOrderV1: mocks.bundleRequest,
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
import { createDacsDemosBundlePublicationV1 } from "../src/demosBundlePublication.js";
import { createClassifiedDemosSellerBundleReads } from "../src/demosSellerBundleReads.js";
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
    demosWriteFeeCeilings: { buyer: "2", seller: "2" },
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

async function x402AuditHarness() {
  const f = await fixture();
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
    authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
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
  return { audit, authenticated, database, f, observation, pair };
}

function requestWithFinality(
  f: Awaited<ReturnType<typeof fixture>>,
  finalityBlocks: number | undefined,
) {
  const { signature: _signature, ...unsigned } = structuredClone(f.paymentEvidence);
  const evidence = signComponent({
    ...unsigned,
    settlementFinality: {
      model: "block-depth" as const,
      ...(finalityBlocks === undefined ? {} : { finalityBlocks }),
      finalityObservedAt: NOW - 3_000,
    },
  }, ARTIFACT_SEPARATORS.SettlementEvidence, SELLER);
  const logicalAddress = f.paymentRef.anchor.locator;
  const nativeAddress = f.names.get(logicalAddress);
  if (nativeAddress === undefined) throw new Error("payment fixture anchor is missing");
  f.artifacts.set(nativeAddress, evidence);
  f.receipts.set(nativeAddress, receipt(
    logicalAddress,
    nativeAddress,
    evidence,
    BUYER,
    NOW - 3_000,
  ));
  const paymentRef = ref(logicalAddress, evidence, SELLER);
  const signedScope = structuredClone(f.preliminaryRequest.signedScope);
  signedScope.settlementEvidence[0] = paymentRef;
  signedScope.phaseSummary[2] = {
    ...signedScope.phaseSummary[2]!,
    attestationRef: paymentRef,
  };
  return { ...f.preliminaryRequest, signedScope };
}

describe("fixed-price x402 buyer audit reconstruction", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    for (const database of databases.splice(0).reverse()) database.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("independently reconstructs and verifies the exact seller review request", async () => {
    const { audit, authenticated, database, f, observation, pair } = await x402AuditHarness();
    for (const evidence of [f.paymentEvidence, f.deliveryEvidence]) {
      expect(isSettlementEvidence(evidence)).toBe(true);
      expect(ed25519Verify(
        signedBytes(ARTIFACT_SEPARATORS.SettlementEvidence, contentHash(evidence)),
        Uint8Array.from(Buffer.from(evidence.signature.value, "base64url")),
        publicKeyFromRaw(SELLER_KEY),
      )).toBe(true);
    }
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
    mocks.bundleRequest.mockResolvedValue(exactRequest);
    const material = await audit.audit.resolveMaterial({
      operation: { order: pair.buyer },
      retained: { application: f.application },
    } as never);
    expect(material.input.settlementContext.rail.finality).toEqual({
      model: "block-depth",
      finalityBlocks: 2,
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
    mocks.verifyCompleted.mockResolvedValue({
      state: "audit-complete",
      jobId: JOB_ID,
    });
    const buyerPublication = {
      role: "buyer" as const,
      logicalAddress: bundleAddress(JOB_ID, "buyer"),
      nativeAddress: "native:buyer-bundle",
      bundleContentHash: "c".repeat(64),
      anchorReceipt: { writer: BUYER },
    };
    const sellerPublication = {
      role: "seller" as const,
      logicalAddress: bundleAddress(JOB_ID, "seller"),
      nativeAddress: "native:seller-bundle",
      bundleContentHash: "d".repeat(64),
      anchorReceipt: { writer: SELLER },
    };
    const sellerClosure = {
      verificationInput: exact.input,
      result: {
        nativeAddress: sellerPublication.nativeAddress,
        sellerBundle: { jobId: JOB_ID },
      },
    };
    const lease = { ...AUDIT_LEASE, expiresAt: database.readTime() + 300_000 };
    await expect(audit.audit.authorizeFinalized({
      operation: {
        order: { ...pair.buyer, tracks: { audit: { state: "running", lease } } },
        fence: { owner: lease.owner, generation: lease.generation },
      },
      retained: { application: f.application },
      material: { provider: exact.provider },
      completion: { sellerClosure },
      result: {
        logicalAddress: buyerPublication.logicalAddress,
        nativeAddress: buyerPublication.nativeAddress,
        bundleContentHash: buyerPublication.bundleContentHash,
        buyerBundle: { jobId: JOB_ID },
        publications: { buyer: buyerPublication, seller: sellerPublication },
      },
    } as never)).resolves.toBe(true);
    expect(mocks.verifyCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: JOB_ID,
        buyer: BUYER,
        seller: SELLER,
        sellerClosure,
        copies: {
          buyer: expect.objectContaining({ nativeAddress: "native:buyer-bundle" }),
          seller: expect.objectContaining({ nativeAddress: "native:seller-bundle" }),
        },
      }),
      expect.objectContaining({
        sellerFinalizationProvider: exact.provider,
        readBundleCopy: expect.any(Function),
        verifyBundleAnchor: expect.any(Function),
        resolveBundleBinding: expect.any(Function),
        verifyBundleBinding: expect.any(Function),
      }),
    );
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

  it("rejects evidence whose finality echo differs from authenticated policy", async () => {
    const { audit, authenticated, f } = await x402AuditHarness();
    const observationCalls = mocks.observeX402Transfer.mock.calls.length;

    for (const finalityBlocks of [undefined, 1, 3]) {
      await expect(audit.bundleTransport.resolveVerification({
        authenticated,
        request: requestWithFinality(f, finalityBlocks),
      })).rejects.toMatchObject({ reasonCode: "buyer-audit-evidence-invalid" });
    }
    expect(mocks.observeX402Transfer).toHaveBeenCalledTimes(observationCalls);
  });

  it.each([
    {},
    { finalityBlocks: 0 },
    { finalityBlocks: 1.5 },
  ])("rejects an unavailable or invalid authenticated x402 finality depth", async (
    parameters,
  ) => {
    const f = await fixture();
    mocks.provenance.mockReturnValue({
      registryVersion: 7,
      indexContentHash: "a".repeat(64),
      definitionContentHash: "b".repeat(64),
    });

    expect(() => createDacsFixedPriceX402BuyerAuditV1({
      context: {
        authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
        role: "buyer",
        evm: { role: "buyer", address: BUYER_EVM },
      } as never,
      rail: { ...f.rail, parameters } as never,
      evmRpcUrl: "https://rpc.example",
      authorizationSearchFromBlock: 1,
      recipeRegistryVersion: 1,
    })).toThrow(TypeError);
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
    authenticateSessionProfile: () => trustedSessionProfile(JOB_ID, BUYER, SELLER),
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

type CompletionRole = "buyer" | "seller";
type CompletionDeps = {
  authenticateSessionProfile(): unknown | Promise<unknown>;
  sellerFinalizationProvider: unknown;
  readBundleCopy(nativeAddress: string, role: CompletionRole): Promise<unknown>;
  verifyBundleAnchor(copy: Record<string, unknown>): Promise<Record<string, unknown>>;
  resolveBundleBinding(logicalAddress: string, signer: string): Promise<Record<string, unknown>>;
  verifyBundleBinding(binding: Record<string, unknown>): Promise<Record<string, unknown>>;
};
type CompletionCopy = Record<string, unknown> & {
  nativeAddress: string;
  bundle: Record<string, unknown>;
  binding: Record<string, unknown> & { logicalAddress: string; signer: string };
};
type CompletionInput = { copies: Record<CompletionRole, CompletionCopy> };
type CompletionHarness = Awaited<ReturnType<typeof completionHarness>>;

// Co-signed by both parties, as a completed copy must be for BB-5 check 9.
function completedBundle(role: CompletionRole) {
  const unsigned = completedBundleScope();
  const sign = (party: typeof BUYER | typeof SELLER) => ({
    party,
    algorithm: "ed25519",
    value: Buffer.from(ed25519Sign(
      signedBytes(ARTIFACT_SEPARATORS.FaultAttestationBundle, contentHash(unsigned)),
      privateKeyFromSeed(party === BUYER ? BUYER_SEED : SELLER_SEED),
    )).toString("base64url"),
  });
  return { ...unsigned, anchoredByRole: role, signatures: [sign(BUYER), sign(SELLER)] };
}

function completedBundleScope() {
  return {
    faultBundleVersion: "1",
    jobId: JOB_ID,
    outcome: "completed",
    faultedParty: "none",
    listingRef: { listingId: "listing-completion", version: 1, contentHash: "e".repeat(64) },
    parties: [
      { role: "buyer", bundleHash: "1".repeat(64), primaryClaim: BUYER },
      { role: "seller", bundleHash: "2".repeat(64), primaryClaim: SELLER },
    ],
    phaseSummary: [],
    vetRecords: [],
    settlementEvidence: [],
    recipeRegistryVersion: 1,
    railRegistryVersion: 1,
    finalisedAt: NOW,
  };
}

// The audit track's coordinator lease as the coordinator hands it over, with
// the dacs-node service's default lease length.
type AuditLease = { owner: string; generation: number; expiresAt: number };
const AUDIT_LEASE: AuditLease = { owner: "buyer-audit-worker", generation: 3, expiresAt: NOW + 300_000 };

// Demos state for two published role copies, each with a signed BB-1 binding.
// The strict two-copy verifier is mocked in this file, so each test drives the
// adapter's own closures through it the way the verifier does. `readTime` is
// the role database's clock, on which the coordinator lease runs.
async function completionHarness(
  paymentProfile: "x402" | "pay-dem",
  completionDeadline?: Readonly<CompletedTwoSidedSessionDeadline>,
  readTime: () => number = () => NOW,
) {
  const f = paymentProfile === "x402" ? await fixture() : await payDemFixture();
  mocks.provenance.mockReturnValue({
    registryVersion: 7,
    indexContentHash: "a".repeat(64),
    definitionContentHash: "b".repeat(64),
  });
  const names = new Map<string, string>();
  const artifacts = new Map<string, Record<string, unknown>>();
  const receipts = new Map<string, AnchorReceipt>();
  const publications = {} as Record<CompletionRole, Record<string, unknown>>;
  const copies = {} as Record<CompletionRole, CompletionCopy>;
  for (const role of ["buyer", "seller"] as const) {
    const writer = role === "buyer" ? BUYER : SELLER;
    const bundle = completedBundle(role);
    const logicalAddress = bundleAddress(JOB_ID, role);
    const nativeAddress = `native:${role}-bundle`;
    const bundleContentHash = attestationBundleHash(bundle as never);
    const anchorReceipt = {
      ...receipt(logicalAddress, nativeAddress, bundle, writer, NOW),
      contentHash: bundleContentHash,
    };
    names.set(logicalAddress, nativeAddress);
    artifacts.set(nativeAddress, bundle);
    receipts.set(nativeAddress, anchorReceipt);
    const binding = signComponent({
      bindingVersion: "1",
      jobId: JOB_ID,
      role,
      logicalAddress,
      nativeAddress,
      bundleContentHash,
      signer: writer,
    }, BUNDLE_BINDING_SEPARATOR, writer);
    const bindingName = `dacs5:bundle-binding:${JOB_ID}:${role}`;
    const bindingNative = `native:${role}-binding`;
    names.set(bindingName, bindingNative);
    artifacts.set(bindingNative, binding);
    receipts.set(bindingNative, receipt(bindingName, bindingNative, binding, writer, NOW));
    publications[role] = {
      role, logicalAddress, nativeAddress, bundleContentHash, anchorReceipt, binding,
    };
    copies[role] = { role, nativeAddress, bundle, anchorReceipt, binding };
  }
  const adapter = {
    resolveAnchorByName: vi.fn(async (logicalAddress: string) => {
      const address = names.get(logicalAddress);
      return address === undefined
        ? { status: "absent" as const }
        : { status: "present" as const, address };
    }),
    readAnchor: vi.fn(async (address: string) => structuredClone(artifacts.get(address) ?? null)),
    resolveDemosAnchorReceipt: vi.fn(async (input: { nativeAddress: string }) =>
      structuredClone(receipts.get(input.nativeAddress) ?? null)),
    verifyDemosAnchorReceipt: vi.fn(async (_receipt: { nativeAddress: string }) => true),
    anchorWriteOnce: vi.fn(),
    sign: vi.fn(),
  };
  // Only the retained order identity is read from the coordinator stores here.
  const coordinatorStore = () => ({
    load: async () => ({
      status: "ok" as const,
      record: { jobId: JOB_ID, buyer: BUYER, seller: SELLER },
    }),
  });
  const authenticateSessionProfile = vi.fn((): unknown => trustedSessionProfile(JOB_ID, BUYER, SELLER));
  const context = {
    authenticateSessionProfile,
    role: "buyer",
    authority: BUYER,
    peerAuthority: SELLER,
    database: {
      readTime,
      createLiveCoordinatorStore: coordinatorStore,
      createPayDemCoordinatorStore: coordinatorStore,
    },
    demos: { publicKey: BUYER_KEY, adapter, signComponent: vi.fn() },
    ...(paymentProfile === "x402" ? { evm: { role: "buyer", address: BUYER_EVM } } : {}),
  } as unknown as DacsLiveRoleOperationContextV1;
  const audit = paymentProfile === "x402"
    ? createDacsFixedPriceX402BuyerAuditV1({
        context,
        rail: f.rail as never,
        evmRpcUrl: "https://rpc.example",
        authorizationSearchFromBlock: 1,
        recipeRegistryVersion: 1,
        ...(completionDeadline === undefined ? {} : { completionDeadline }),
      })
    : createDacsFixedPricePayDemBuyerAuditV1({
        context,
        rail: f.rail as never,
        observeDemosTransfer: vi.fn(),
        recipeRegistryVersion: 1,
        ...(completionDeadline === undefined ? {} : { completionDeadline }),
      });
  const sellerProvider = { mapping: "write-input", bundleCopyVerifier: {} };
  const sellerClosure = {
    verificationInput: { agreement: { jobId: JOB_ID } },
    result: {
      nativeAddress: copies.seller.nativeAddress,
      sellerBundle: copies.seller.bundle,
    },
  };
  const authorize = (overrides: { sellerNativeAddress?: string; lease?: AuditLease | null } = {}) =>
    audit.audit.authorizeFinalized({
      operation: {
        order: {
          jobId: JOB_ID, buyer: BUYER, seller: SELLER,
          tracks: {
            audit: overrides.lease === null ? { state: "running" }
              : { state: "running", lease: overrides.lease ?? AUDIT_LEASE },
          },
        },
        fence: { owner: AUDIT_LEASE.owner, generation: AUDIT_LEASE.generation },
      },
      retained: { application: f.application },
      material: { provider: sellerProvider },
      completion: {
        sellerClosure: overrides.sellerNativeAddress === undefined
          ? sellerClosure
          : {
              ...sellerClosure,
              result: { ...sellerClosure.result, nativeAddress: overrides.sellerNativeAddress },
            },
      },
      result: {
        logicalAddress: bundleAddress(JOB_ID, "buyer"),
        nativeAddress: copies.buyer.nativeAddress,
        bundleContentHash: publications.buyer.bundleContentHash,
        buyerBundle: copies.buyer.bundle,
        publications,
      },
    } as never);
  return { adapter, audit, authorize, context, copies, sellerProvider, authenticateSessionProfile };
}

// The strict verifier's use of the adapter: exact readback at each native
// address, receipt authentication, and BB-1 binding resolution/verification.
async function driveCopy(role: "buyer" | "seller", input: CompletionInput, deps: CompletionDeps) {
  const copy = input.copies[role];
  const readback = await deps.readBundleCopy(copy.nativeAddress, role);
  if (readback === null) throw new IndeterminateSubstrateError("bundle not yet readable");
  if (canonicalize(readback) !== canonicalize(copy.bundle)) {
    throw new DacsError(`completed ${role} bundle is not independently readable`);
  }
  const anchor = await deps.verifyBundleAnchor(structuredClone(copy));
  if (anchor.disposition === "indeterminate" || anchor.disposition === "error")
    throw new IndeterminateSubstrateError("anchor unavailable");
  if (anchor.disposition !== "valid") {
    throw new DacsError(`completed ${role} bundle anchor verification is ${anchor.disposition}`);
  }
  // As the gate: a lookup that does not show the carried binding gates
  // nothing (ST-11, BB-8); only a different binding it serves is an answer.
  const lookup = await deps.resolveBundleBinding(copy.binding.logicalAddress, copy.binding.signer);
  if (lookup.disposition === "present" &&
      canonicalize(lookup.binding) !== canonicalize(copy.binding)) {
    throw new DacsError(`completed ${role} BundleBinding is not independently resolvable and exact`);
  }
  const verified = await deps.verifyBundleBinding(structuredClone(copy.binding));
  if (verified.disposition === "indeterminate" || verified.disposition === "error")
    throw new IndeterminateSubstrateError("binding unavailable");
  if (verified.disposition !== "valid") {
    throw new DacsError(`completed ${role} BundleBinding verification is ${verified.disposition}`);
  }
}

async function driveStrictVerifier(input: CompletionInput, deps: CompletionDeps) {
  requireAuthenticatedSessionProfile(await deps.authenticateSessionProfile(), {
    jobId: JOB_ID, buyer: BUYER, seller: SELLER,
  });
  for (const role of ["buyer", "seller"] as const) await driveCopy(role, input, deps);
  return { state: "audit-complete" };
}

// A verifier that rejects as soon as either copy fails, while the other copy's
// read continues. The real verifier settles both copies first, and its own
// tests drive that order on both gates. Here the answer is already in flight
// when the audit sees the rejection, and the audit waits for it.
async function driveCopiesFailFast(input: CompletionInput, deps: CompletionDeps) {
  await Promise.all((["buyer", "seller"] as const).map((role) => driveCopy(role, input, deps)));
  return { state: "audit-complete" };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function capturedCompletionDeps(harness: CompletionHarness): Promise<CompletionDeps> {
  let deps: CompletionDeps | undefined;
  mocks.verifyCompleted.mockImplementationOnce(
    async (_input: unknown, captured: CompletionDeps) => {
      deps = captured;
      return { state: "audit-complete" };
    },
  );
  await expect(harness.authorize()).resolves.toBe(true);
  return deps!;
}

describe("buyer two-copy completion adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyCompleted.mockImplementation(driveStrictVerifier);
  });
  afterEach(() => {
    mocks.verifyCompleted.mockReset();
  });

  it("passes independent x402 admission to completion and refuses an unauthenticated reply", async () => {
    const harness = await completionHarness("x402");
    harness.authenticateSessionProfile.mockReturnValueOnce(undefined);
    await expect(harness.authorize()).resolves.toBe(false);
    expect(harness.authenticateSessionProfile).toHaveBeenCalledWith(JOB_ID);
    await expect(harness.authorize()).resolves.toBe(true);
  });

  it("re-admits a recovered paid x402 graph before verifying both published copies", async () => {
    const harness = await completionHarness("x402");
    const paidOperation = { order: { jobId: JOB_ID, tracks: { payment: { state: "final" } } } };
    const reopen = () => admitDacsX402LiveGraph({
      role: "buyer", operations: { audit: harness.authorize }, router: {},
    } as never, harness.context) as unknown as { operations: { audit(input: unknown): Promise<boolean> } };
    const first = reopen();
    harness.authenticateSessionProfile.mockReturnValueOnce(undefined);
    await expect(first.operations.audit(paidOperation)).rejects.toThrow(/session profile/);
    expect(harness.adapter.readAnchor).not.toHaveBeenCalled();
    expect(mocks.verifyCompleted).not.toHaveBeenCalled();

    // Reopening must preserve independently supplied authority, rather than a
    // saved successful admission. The real audit re-reads both published copies.
    const recovered = reopen();
    await expect(recovered.operations.audit(paidOperation)).resolves.toBe(true);
    expect(harness.authenticateSessionProfile).toHaveBeenCalledWith(JOB_ID);
    for (const role of ["buyer", "seller"] as const) {
      expect(harness.adapter.readAnchor).toHaveBeenCalledWith(harness.copies[role].nativeAddress);
    }
    const reads = harness.adapter.readAnchor.mock.calls.length;
    harness.authenticateSessionProfile.mockReturnValueOnce(undefined);
    await expect(recovered.operations.audit(paidOperation)).rejects.toThrow(/session profile/);
    expect(harness.adapter.readAnchor).toHaveBeenCalledTimes(reads);
  });

  it.each(["x402", "pay-dem"] as const)(
    "authorizes an authenticated %s completion through its own Demos closures",
    async (paymentProfile) => {
      const { adapter, authorize, copies, sellerProvider } =
        await completionHarness(paymentProfile);

      await expect(authorize()).resolves.toBe(true);
      expect(mocks.verifyCompleted).toHaveBeenCalledWith(
        expect.objectContaining({
          copies: {
            buyer: expect.objectContaining({ nativeAddress: copies.buyer.nativeAddress }),
            seller: expect.objectContaining({ nativeAddress: copies.seller.nativeAddress }),
          },
        }),
        expect.objectContaining({ sellerFinalizationProvider: sellerProvider }),
      );
      // Each copy, and the copy its binding names, is read at its native
      // address; the bundle name index is never consulted (BB-5, ST-11).
      for (const role of ["buyer", "seller"] as const) {
        expect(adapter.readAnchor).toHaveBeenCalledWith(copies[role].nativeAddress);
        expect(adapter.resolveAnchorByName).not.toHaveBeenCalledWith(
          bundleAddress(JOB_ID, role),
          expect.anything(),
        );
      }
    },
  );

  // DACS-5 BB-5 step 6, ST-11: the copy is read at the exact native
  // address the gate names, never through the name index.
  it("reads a role copy only at its exact native address", async () => {
    const harness = await completionHarness("x402");
    const deps = await capturedCompletionDeps(harness);
    harness.adapter.resolveAnchorByName.mockClear();

    await expect(deps.readBundleCopy(harness.copies.seller.nativeAddress, "seller"))
      .resolves.toEqual(harness.copies.seller.bundle);
    expect(harness.adapter.readAnchor).toHaveBeenLastCalledWith(harness.copies.seller.nativeAddress);
    // Nothing readable there yet is unanswered; other content is an answer.
    await expect(deps.readBundleCopy("native:other-seller-bundle", "seller")).resolves.toBeNull();
    harness.adapter.readAnchor.mockResolvedValueOnce({ not: "a bundle" } as never);
    await expect(deps.readBundleCopy(harness.copies.seller.nativeAddress, "seller"))
      .rejects.toThrow(/bundle-readback-invalid/);
    expect(harness.adapter.resolveAnchorByName).not.toHaveBeenCalled();
  });

  // DACS-5 ST-11: external index visibility never gates completion.
  // Demos's name index may lag finality by several blocks; a copy the gate
  // reads at its native address, with the binding it carries, completes
  // whether or not the index shows the copy or binding yet.
  it.each([
    ["the seller bundle", bundleAddress(JOB_ID, "seller")],
    ["the buyer bundle", bundleAddress(JOB_ID, "buyer")],
    ["the seller BundleBinding", `dacs5:bundle-binding:${JOB_ID}:seller`],
    ["the buyer BundleBinding", `dacs5:bundle-binding:${JOB_ID}:buyer`],
  ])("completes while Demos's name index does not show %s yet", async (_label, name) => {
    const harness = await completionHarness("x402");
    const resolve = harness.adapter.resolveAnchorByName.getMockImplementation()!;
    const other = name.endsWith("seller") ? harness.copies.buyer.nativeAddress
      : harness.copies.seller.nativeAddress;
    for (const [label, answer] of [
      ["absent", async () => ({ status: "absent" })],
      ["indeterminate", async () => ({ status: "indeterminate" })],
      ["unanswered", async () => { throw new Error("rpc unavailable"); }],
      ["the other role's copy", async () => ({ status: "present", address: other })],
    ] as const) {
      harness.adapter.resolveAnchorByName.mockImplementation(async (logicalAddress: string) =>
        logicalAddress === name ? await answer() as never : resolve(logicalAddress));
      await expect(harness.authorize(), label).resolves.toBe(true);
    }
  });

  it.each(["x402", "pay-dem"] as const)(
    "reports the %s seller's finalization as indeterminate while its bundle or binding is not in the name index yet",
    async (paymentProfile) => {
      for (const name of [bundleAddress(JOB_ID, "seller"), `dacs5:bundle-binding:${JOB_ID}:seller`]) {
        const harness = await completionHarness(paymentProfile);
        const resolve = harness.adapter.resolveAnchorByName.getMockImplementation()!;
        harness.adapter.resolveAnchorByName.mockImplementation(async (logicalAddress: string) =>
          logicalAddress === name ? { status: "absent" as const } : resolve(logicalAddress));
        const finalization = await harness.audit.bundleTransport.resolveSellerFinalization({
          identity: { jobId: JOB_ID, buyer: BUYER, seller: SELLER },
        } as never);
        expect(finalization.disposition, name).not.toBe("rejected");
      }
    },
  );

  it("returns the strict verifier's exact anchor and binding disposition shapes", async () => {
    const harness = await completionHarness("x402");
    const { adapter, copies } = harness;
    const deps = await capturedCompletionDeps(harness);

    await expect(deps.verifyBundleAnchor(copies.seller))
      .resolves.toStrictEqual({ disposition: "valid", mapping: "write-input" });
    adapter.verifyDemosAnchorReceipt.mockResolvedValueOnce(false);
    await expect(deps.verifyBundleAnchor(copies.seller)).resolves.toStrictEqual({
      disposition: "invalid",
      reason: "demos-seller-bundle-anchor-invalid",
    });
    adapter.verifyDemosAnchorReceipt.mockRejectedValueOnce(new Error("rpc unavailable"));
    await expect(deps.verifyBundleAnchor(copies.buyer)).resolves.toStrictEqual({
      disposition: "error",
      reason: "demos-buyer-bundle-anchor-error",
    });
    await expect(deps.verifyBundleBinding(copies.seller.binding))
      .resolves.toStrictEqual({ disposition: "valid" });
    await expect(deps.verifyBundleBinding({ ...copies.seller.binding, nativeAddress: "native:x" }))
      .resolves.toStrictEqual({ disposition: "invalid", reason: "demos-bundle-binding-invalid" });
    await expect(deps.resolveBundleBinding(
      copies.seller.binding.logicalAddress,
      copies.seller.binding.signer,
    )).resolves.toStrictEqual({ disposition: "present", binding: copies.seller.binding });
  });

  it("rejects a seller closure that names a different seller native address", async () => {
    const { authorize } = await completionHarness("x402");

    await expect(authorize({ sellerNativeAddress: "native:other-seller-bundle" }))
      .resolves.toBe(false);
    expect(mocks.verifyCompleted).not.toHaveBeenCalled();
  });

  it.each([
    ["the strict verifier rejects the session", () => {
      mocks.verifyCompleted.mockRejectedValueOnce(new DacsError("completed bundle pair is split"));
    }],
    ["a published copy is not a bundle", (h: CompletionHarness) => {
      h.adapter.readAnchor.mockImplementation(async () => ({ not: "a bundle" }) as never);
    }],
    ["a bundle receipt does not authenticate", (h: CompletionHarness) => {
      h.adapter.verifyDemosAnchorReceipt.mockResolvedValue(false);
    }],
  ])("returns false when %s", async (_label, arrange) => {
    const harness = await completionHarness("x402");
    arrange(harness);

    await expect(harness.authorize()).resolves.toBe(false);
  });

  it.each([
    ["a native bundle read finds nothing yet", (h: CompletionHarness) => {
      h.adapter.readAnchor.mockResolvedValueOnce(null);
    }],
    ["a native bundle read throws", (h: CompletionHarness) => {
      h.adapter.readAnchor.mockRejectedValueOnce(new Error("rpc unavailable"));
    }],
    ["receipt verification errors", (h: CompletionHarness) => {
      h.adapter.verifyDemosAnchorReceipt.mockRejectedValueOnce(new Error("rpc unavailable"));
    }],
    ["the seller closure read is indeterminate", () => {
      mocks.verifyCompleted.mockRejectedValueOnce(
        new IndeterminateSubstrateError("seller bundle lookup errored and is indeterminate"),
      );
    }],
  ])("stays retryable when %s", async (_label, arrange) => {
    const harness = await completionHarness("x402");
    arrange(harness);

    await expect(harness.authorize()).resolves.toBe("indeterminate");
  });

  it.each(["x402", "pay-dem"] as const)(
    "requires operator action for permanent %s seller closure failures",
    async (paymentProfile) => {
      const harness = await completionHarness(paymentProfile);
      for (const error of [
        new SubstrateError("retained seller bundle is authoritatively absent"),
        new SubstrateError("seller bundle lookup returned an invalid disposition"),
        new SubstrateError("dependency resolution returned an invalid indeterminate disposition"),
      ]) {
        mocks.verifyCompleted.mockRejectedValueOnce(error);
        await expect(harness.authorize()).resolves.toBe(false);
      }
    },
  );

  it.each(["x402", "pay-dem"] as const)(
    "retries only typed indeterminate %s seller closure reads",
    async (paymentProfile) => {
      const harness = await completionHarness(paymentProfile);
      mocks.verifyCompleted.mockRejectedValueOnce(new IndeterminateSubstrateError("read unavailable"));
      await expect(harness.authorize()).resolves.toBe("indeterminate");
    },
  );

  it("stays retryable for the pay-DEM buyer audit when Demos cannot answer", async () => {
    const harness = await completionHarness("pay-dem");
    harness.adapter.readAnchor.mockRejectedValueOnce(new Error("rpc unavailable"));

    await expect(harness.authorize()).resolves.toBe("indeterminate");
  });

  // Receipt verification answers `false` for one role's copy and goes
  // unanswered for the other's; the answer arrives 25 ms after the unanswered
  // read fails, or 25 ms before it.
  const splitReceiptAnswers = (h: CompletionHarness, answered: "buyer" | "seller", answerArrives: "last" | "first") => {
    h.adapter.verifyDemosAnchorReceipt.mockImplementation(async (receipt: { nativeAddress: string }) => {
      const isAnswered = receipt.nativeAddress === h.copies[answered].nativeAddress;
      if (isAnswered === (answerArrives === "last")) await pause(25);
      if (isAnswered) return false;
      throw new SubstrateError("Demos anchor receipt observation unavailable");
    });
  };

  for (const paymentProfile of ["x402", "pay-dem"] as const) {
    for (const answerArrives of ["last", "first"] as const) {
      it.each(["buyer", "seller"] as const)(
        `reports Demos's answer against the ${paymentProfile} %s copy, arriving ${answerArrives}, although the other copy's read went unanswered`,
        async (answered) => {
          const harness = await completionHarness(paymentProfile);
          mocks.verifyCompleted.mockImplementationOnce(driveCopiesFailFast);
          splitReceiptAnswers(harness, answered, answerArrives);
          await expect(harness.authorize()).resolves.toBe(false);
        },
      );
    }

    it(`reports a ${paymentProfile} anchor answer that arrives after an authentic readback`, async () => {
      // The answered copy's readback authenticates; only its anchor check gets
      // `false`, 25 ms after the other copy's read went unanswered.
      const harness = await completionHarness(paymentProfile);
      mocks.verifyCompleted.mockImplementationOnce(driveCopiesFailFast);
      let answeredCalls = 0;
      harness.adapter.verifyDemosAnchorReceipt.mockImplementation(async (receipt: { nativeAddress: string }) => {
        if (receipt.nativeAddress !== harness.copies.buyer.nativeAddress) {
          throw new SubstrateError("Demos anchor receipt observation unavailable");
        }
        answeredCalls += 1;
        if (answeredCalls === 2) await pause(25);
        return answeredCalls === 1;
      });
      await expect(harness.authorize()).resolves.toBe(false);
      // The anchor check, the binding discovery's native read (BB-6) and the
      // binding verification's native read.
      expect(answeredCalls).toBe(3);
    });

    it(`keeps ${paymentProfile} retryable when the only answered result is valid`, async () => {
      const harness = await completionHarness(paymentProfile);
      mocks.verifyCompleted.mockImplementationOnce(driveCopiesFailFast);
      harness.adapter.verifyDemosAnchorReceipt.mockImplementation(async (receipt: { nativeAddress: string }) => {
        if (receipt.nativeAddress !== harness.copies.buyer.nativeAddress) {
          throw new SubstrateError("Demos anchor receipt observation unavailable");
        }
        await pause(25);
        return true;
      });
      await expect(harness.authorize()).resolves.toBe("indeterminate");
    });

    it(`preserves ${paymentProfile} permanent rejection when it meets an unanswered read`, async () => {
      // A permanent gate rejection remains definitive alongside an outage.
      const harness = await completionHarness(paymentProfile);
      mocks.verifyCompleted.mockImplementationOnce(async (input: CompletionInput, deps: CompletionDeps) => {
        await driveCopiesFailFast(input, deps).catch(() => undefined);
        throw new DacsError("completed buyer bundle signature verification failed: forged");
      });
      harness.adapter.verifyDemosAnchorReceipt.mockRejectedValue(
        new SubstrateError("Demos anchor receipt observation unavailable"));
      await expect(harness.authorize()).resolves.toBe(false);
    });

    it(`preserves ${paymentProfile} permanent rejection when the unanswered read is a BundleBinding verification`, async () => {
      const harness = await completionHarness(paymentProfile);
      let verdict: unknown;
      mocks.verifyCompleted.mockImplementationOnce(async (input: CompletionInput, deps: CompletionDeps) => {
        verdict = await deps.verifyBundleBinding(structuredClone(input.copies.seller.binding!));
        throw new DacsError("completed buyer bundle signature verification failed: forged");
      });
      harness.adapter.verifyDemosAnchorReceipt.mockRejectedValue(
        new SubstrateError("Demos anchor receipt observation unavailable"));
      await expect(harness.authorize()).resolves.toBe(false);
      expect(verdict).toMatchObject({ disposition: expect.stringMatching(/^(?:indeterminate|error)$/) });
    });

    it(`preserves ${paymentProfile} permanent rejection when the unanswered read is a bundle anchor verification`, async () => {
      // The anchor verdict alone marks the read unanswered: the verifier then
      // fails with an error that names no answer from Demos.
      const harness = await completionHarness(paymentProfile);
      let verdict: unknown;
      mocks.verifyCompleted.mockImplementationOnce(async (input: CompletionInput, deps: CompletionDeps) => {
        verdict = await deps.verifyBundleAnchor(structuredClone(input.copies.seller));
        throw new DacsError("completed buyer bundle signature verification failed: forged");
      });
      harness.adapter.verifyDemosAnchorReceipt.mockRejectedValue(
        new IndeterminateSubstrateError("Demos anchor receipt observation unavailable"));
      await expect(harness.authorize()).resolves.toBe(false);
      expect(verdict).toMatchObject({ disposition: "error",
        reason: "demos-seller-bundle-anchor-error" });
    });
  }

  // One copy's Demos read never settles: the buyer copy's name lookup, or the
  // seller copy's receipt check. The other copy's receipt is answered `false`
  // or goes unanswered. Whether the verifier rejects at once or waits for both
  // copies, the audit decides at a deadline the test expires: Demos's answer
  // fails it, an unanswered read keeps it retryable, and the hanging read's
  // late answer changes nothing.
  for (const paymentProfile of ["x402", "pay-dem"] as const) {
    for (const hanging of ["buyer", "seller"] as const) {
      for (const verifier of ["fail-fast", "settling"] as const) {
        it.each(["answered", "unanswered"] as const)(
          `decides a ${paymentProfile} audit at the deadline when the ${hanging} copy's read never settles and the other copy's is %s (${verifier} verifier)`,
          async (other) => {
            const clock = manualDeadline();
            const harness = await completionHarness(paymentProfile, { timeoutMs: 5_000, start: clock.start });
            mocks.verifyCompleted.mockImplementationOnce(
              verifier === "fail-fast" ? driveCopiesFailFast : driveCopiesSettling);
            let reached = false;
            let answerLate = (): void => undefined;
            const resolveName = harness.adapter.resolveAnchorByName.getMockImplementation()!;
            harness.adapter.resolveAnchorByName.mockImplementation(async (name: string, ...rest: unknown[]) => {
              if (hanging !== "buyer" || name !== bundleAddress(JOB_ID, "buyer")) {
                return resolveName(name, ...(rest as []));
              }
              reached = true;
              return await new Promise((resolve) => {
                answerLate = () => { void resolveName(name, ...(rest as [])).then(resolve); };
              });
            });
            harness.adapter.verifyDemosAnchorReceipt.mockImplementation(async (receipt: { nativeAddress: string }) => {
              if (receipt.nativeAddress === harness.copies[hanging].nativeAddress) {
                reached = true;
                return await new Promise<boolean>((resolve) => { answerLate = () => resolve(true); });
              }
              if (other === "answered") return false;
              throw new SubstrateError("Demos anchor receipt observation unavailable");
            });

            const outcome = Promise.resolve(harness.authorize());
            let decided = false;
            void outcome.then(() => { decided = true; });
            await flush();
            expect(reached).toBe(true);
            expect(decided).toBe(false);
            expect(clock.armed()).toEqual([5_000]);

            clock.expire();
            const expected = other === "answered" ? false : "indeterminate";
            await expect(outcome).resolves.toBe(expected);
            answerLate();
            await flush();
            await expect(outcome).resolves.toBe(expected);
            expect(clock.armed()).toEqual([]);
          },
        );
      }
    }
  }

  it.each(["x402", "pay-dem"] as const)(
    "preserves a %s permanent audit rejection when it meets a read that never settles",
    async (paymentProfile) => {
      const clock = manualDeadline();
      const harness = await completionHarness(paymentProfile, { start: clock.start });
      mocks.verifyCompleted.mockImplementationOnce(async (input: CompletionInput, deps: CompletionDeps) => {
        void driveCopy("buyer", input, deps).catch(() => undefined);
        throw new DacsError("completed seller bundle signature verification failed: forged");
      });
      harness.adapter.verifyDemosAnchorReceipt.mockImplementation(() => new Promise(() => undefined));
      const outcome = Promise.resolve(harness.authorize());
      await flush();
      clock.expire();
      await expect(outcome).resolves.toBe(false);
    },
  );

  // The audit arms one deadline and hands the strict verifier that same
  // expiry: the verifier's own deadline arms no second timer, and it expires
  // with the audit's.
  it("hands the strict verifier its one expiry and disarms it once the audit decides", async () => {
    const clock = manualDeadline();
    const harness = await completionHarness("x402", { timeoutMs: 7_000, start: clock.start });
    let passed: CompletedTwoSidedSessionDeadline | undefined;
    let verifierExpired = false;
    mocks.verifyCompleted.mockImplementationOnce(
      async (_input: unknown, deps: { deadline: Required<CompletedTwoSidedSessionDeadline> }) => {
        passed = deps.deadline;
        await new Promise<void>((resolve) => {
          deps.deadline.start(() => { verifierExpired = true; resolve(); }, deps.deadline.timeoutMs);
        });
        throw new IndeterminateSubstrateError("completed buyer bundle copy verification did not settle");
      });
    const outcome = Promise.resolve(harness.authorize());
    await flush();
    expect(passed?.timeoutMs).toBe(7_000);
    expect(clock.armed()).toEqual([7_000]);

    clock.expire();
    await expect(outcome).resolves.toBe("indeterminate");
    expect(verifierExpired).toBe(true);
    expect(clock.armed()).toEqual([]);
  });

  // The coordinator records the audit's result only while the audit track's
  // lease is current, and nothing renews it during the check. With the core
  // coordinator's 30-second lease, claimed 2 seconds before the check starts,
  // the check ends 5 seconds before the lease: 23 seconds after it starts.
  for (const paymentProfile of ["x402", "pay-dem"] as const) {
    const lease = { ...AUDIT_LEASE, expiresAt: NOW + 30_000 };
    const started = NOW + 2_000;
    const leaseDeadline = lease.expiresAt - 5_000;
    // Demos answers the buyer copy's first native read only when the test says.
    const heldBuyerRead = (harness: CompletionHarness) => {
      let answer = (): void => undefined;
      let held = false;
      const read = harness.adapter.readAnchor.getMockImplementation()!;
      harness.adapter.readAnchor.mockImplementation(async (address: string) => {
        if (held || address !== harness.copies.buyer.nativeAddress) return read(address);
        held = true;
        return await new Promise((resolve) => {
          answer = () => { void read(address).then(resolve); };
        });
      });
      return () => answer();
    };

    it(`authorizes a ${paymentProfile} completion whose valid answer arrives just before the lease's deadline`, async () => {
      const clock = databaseClock(started);
      const harness = await completionHarness(paymentProfile, { start: clock.start }, clock.readTime);
      const answer = heldBuyerRead(harness);
      const outcome = Promise.resolve(harness.authorize({ lease }));
      await flush();
      expect(clock.armed()).toEqual([leaseDeadline]);

      clock.advance(leaseDeadline - 1);
      answer();
      await expect(outcome).resolves.toBe(true);
      expect(clock.readTime()).toBeLessThan(lease.expiresAt);
      expect(clock.armed()).toEqual([]);
    });

    it(`keeps a ${paymentProfile} audit retryable, while its lease is still current, when the valid answer would arrive after the lease`, async () => {
      const clock = databaseClock(started);
      const harness = await completionHarness(paymentProfile, { start: clock.start }, clock.readTime);
      const answer = heldBuyerRead(harness);
      const outcome = Promise.resolve(harness.authorize({ lease }));
      let decidedAt: number | undefined;
      void outcome.then(() => { decidedAt = clock.readTime(); });
      await flush();

      clock.advance(leaseDeadline);
      await flush();
      expect(decidedAt).toBe(leaseDeadline);
      await expect(outcome).resolves.toBe("indeterminate");
      // Demos answers validly 40 seconds after the claim: nothing changes.
      clock.advance(NOW + 40_000);
      answer();
      await flush();
      await expect(outcome).resolves.toBe("indeterminate");
      expect(clock.armed()).toEqual([]);
    });

    it(`keeps a ${paymentProfile} audit retryable without a read when no more than the margin is left on its lease`, async () => {
      const clock = databaseClock(leaseDeadline);
      const start = vi.fn(clock.start);
      const harness = await completionHarness(paymentProfile, { start }, clock.readTime);
      await expect(harness.authorize({ lease })).resolves.toBe("indeterminate");
      expect(mocks.verifyCompleted).not.toHaveBeenCalled();
      expect(harness.adapter.resolveAnchorByName).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    });
  }

  it.each([
    ["no audit lease", null],
    ["another owner's lease", { ...AUDIT_LEASE, owner: "other-worker" }],
    ["an earlier generation's lease", { ...AUDIT_LEASE, generation: AUDIT_LEASE.generation - 1 }],
  ] as const)("refuses an operation with %s before reading", async (_label, lease) => {
    const harness = await completionHarness("x402");
    await expect(harness.authorize({ lease })).rejects.toMatchObject({
      reasonCode: "buyer-audit-lease-invalid",
    });
    expect(mocks.verifyCompleted).not.toHaveBeenCalled();
    expect(harness.adapter.resolveAnchorByName).not.toHaveBeenCalled();
  });

  it("runs its default deadline on an unreferenced timer and clears it", async () => {
    const harness = await completionHarness("x402");
    const timers = vi.spyOn(globalThis, "setTimeout");
    const clears = vi.spyOn(globalThis, "clearTimeout");
    try {
      const deadlineTimer = () => timers.mock.results[timers.mock.calls.findIndex(
        ([, timeoutMs]) => timeoutMs === 60_000,
      )]?.value as ReturnType<typeof setTimeout> | undefined;
      let referenced: boolean | undefined;
      mocks.verifyCompleted.mockImplementationOnce(async () => {
        referenced = deadlineTimer()?.hasRef();
        return { state: "audit-complete" };
      });
      await expect(harness.authorize()).resolves.toBe(true);
      expect(referenced).toBe(false);
      expect(clears).toHaveBeenCalledWith(deadlineTimer());
    } finally {
      timers.mockRestore();
      clears.mockRestore();
    }
  });

  it.each([
    ["a zero timeout", { timeoutMs: 0 }],
    ["a fractional timeout", { timeoutMs: 1.5 }],
    ["a start that is not a function", { start: "soon" }],
    ["an unknown member", { timeoutMs: 1_000, retries: 3 }],
  ])("rejects a completion deadline with %s", async (_label, completionDeadline) => {
    await expect(completionHarness("x402", completionDeadline as never))
      .rejects.toThrow("fixed-price buyer audit completion deadline is invalid");
  });
});

// A deadline the test expires itself: no real waiting.
function manualDeadline() {
  const armed = new Map<number, Readonly<{ timeoutMs: number; expire: () => void }>>();
  let next = 0;
  return {
    start(expire: () => void, timeoutMs: number) {
      const id = next++;
      armed.set(id, { timeoutMs, expire });
      return () => { armed.delete(id); };
    },
    armed: () => [...armed.values()].map((timer) => timer.timeoutMs),
    expire() {
      for (const [id, timer] of [...armed]) {
        armed.delete(id);
        timer.expire();
      }
    },
  };
}

// The role database's clock, which the test advances, and deadlines on it: a
// deadline armed at `t` for `ms` expires when the clock reaches `t + ms`.
function databaseClock(start: number) {
  let now = start;
  const armed = new Set<{ at: number; expire: () => void }>();
  return {
    readTime: () => now,
    start(expire: () => void, timeoutMs: number) {
      const timer = { at: now + timeoutMs, expire };
      armed.add(timer);
      return () => { armed.delete(timer); };
    },
    armed: () => [...armed].map((timer) => timer.at),
    advance(to: number) {
      for (const timer of [...armed].sort((left, right) => left.at - right.at)) {
        if (timer.at > to) break;
        armed.delete(timer);
        now = timer.at;
        timer.expire();
      }
      now = to;
    },
  };
}

// Lets every promise that can settle without a timer settle.
async function flush() {
  for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

// The real verifier's order without its own deadline: both copies settle
// before the first rejection is reported, so a read that never settles holds it.
async function driveCopiesSettling(input: CompletionInput, deps: CompletionDeps) {
  const results = await Promise.allSettled(
    (["buyer", "seller"] as const).map((role) => driveCopy(role, input, deps)));
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected !== undefined) throw rejected.reason;
  return { state: "audit-complete" };
}

// Demos state changes that invalidate the seller's publication or leave a read
// unanswered. A consumer finds the seller's copy only through its signed
// BundleBinding and an exact native read, so every case leaves the seller's
// side `indeterminate`, never absent (DACS-5 BB-7, BB-8), and the reason says
// which BB-6 step stopped it.
const demosReadCases: Array<[string, string, (h: CompletionHarness) => void]> = [
  ["invalid seller bundle content", "bundle-binding-candidates-rejected", (h) => {
    const read = h.adapter.readAnchor.getMockImplementation()!;
    h.adapter.readAnchor.mockImplementation(async (address: string) =>
      address === h.copies.seller.nativeAddress ? { not: "a bundle" } as never : read(address));
  }],
  // DemosAdapter answers false only for a fetched record that contradicts the receipt.
  ["a seller bundle receipt that fetched Demos records contradict",
    "bundle-binding-candidates-rejected", (h) => {
      h.adapter.verifyDemosAnchorReceipt.mockResolvedValue(false);
    }],
  ["a seller copy whose signatures do not verify", "bundle-binding-candidates-rejected", (h) => {
    const read = h.adapter.readAnchor.getMockImplementation()!;
    h.adapter.readAnchor.mockImplementation(async (address: string) => {
      const value = await read(address);
      if (address !== h.copies.seller.nativeAddress || value === null) return value;
      const forged = structuredClone(value) as { signatures: Array<{ value: string }> };
      forged.signatures[0]!.value = Buffer.alloc(64, 9).toString("base64url");
      return forged as never;
    });
  }],
  ["invalid BundleBinding content", "bundle-binding-undiscovered", (h) => {
    const read = h.adapter.readAnchor.getMockImplementation()!;
    h.adapter.readAnchor.mockImplementation(async (address: string) =>
      address === "native:seller-binding" ? { not: "a binding" } as never : read(address));
  }],
  ["a BundleBinding that fails authentication", "bundle-binding-undiscovered", (h) => {
    const read = h.adapter.readAnchor.getMockImplementation()!;
    h.adapter.readAnchor.mockImplementation(async (address: string) => {
      if (address !== "native:seller-binding") return read(address);
      const forged = structuredClone(h.copies.seller.binding) as unknown as {
        signature: { value: string };
      };
      forged.signature.value = Buffer.alloc(64, 9).toString("base64url");
      return forged as never;
    });
  }],
  // What DemosAdapter throws when the node returns demosdk's bare "error" for
  // a finalized transaction it has not indexed yet, or hits a DB error.
  ["an unanswered receipt verification", "bundle-binding-candidates-unfetched", (h) => {
    h.adapter.verifyDemosAnchorReceipt.mockRejectedValue(
      new IndeterminateSubstrateError("Demos anchor receipt observation unavailable"));
  }],
  ["a plain SubstrateError from receipt verification", "bundle-binding-candidates-unfetched",
    (h) => {
      h.adapter.verifyDemosAnchorReceipt.mockRejectedValue(
        new SubstrateError("Demos anchor receipt observation unavailable"));
    }],
  // The bundle was just read at its address; a node that then finds no
  // program there has not caught up.
  ["a receipt lookup that no longer finds the program", "bundle-binding-candidates-unfetched",
    (h) => {
      h.adapter.resolveDemosAnchorReceipt.mockResolvedValue(null);
    }],
  // A binding names the copy's address before the node can read it there.
  ["a seller copy not readable yet at its address", "bundle-binding-candidates-unfetched",
    (h) => {
      const read = h.adapter.readAnchor.getMockImplementation()!;
      h.adapter.readAnchor.mockImplementation(async (address: string) =>
        address === h.copies.seller.nativeAddress ? null : read(address));
    }],
  ["Demos reads that cannot be answered", "bundle-binding-unanswered", (h) => {
    h.adapter.resolveAnchorByName.mockRejectedValue(new Error("rpc unavailable"));
  }],
  ["a binding program the name index does not show yet", "bundle-binding-undiscovered", (h) => {
    const resolve = h.adapter.resolveAnchorByName.getMockImplementation()!;
    h.adapter.resolveAnchorByName.mockImplementation(async (name: string) =>
      name === `dacs5:bundle-binding:${JOB_ID}:seller`
        ? { status: "absent" } as never : resolve(name));
  }],
];

describe("buyer audit classification of seller Demos reads", () => {
  for (const paymentProfile of ["x402", "pay-dem"] as const) {
    it.each(demosReadCases)(
      `classifies ${paymentProfile} %s through the Demos publication`,
      async (_label, reason, arrange) => {
        const harness = await completionHarness(paymentProfile);
        const publication = createDacsDemosBundlePublicationV1({
          context: harness.context, jobId: JOB_ID, buyer: BUYER, seller: SELLER,
        });
        const reads = createClassifiedDemosSellerBundleReads(publication, JOB_ID);
        await expect(reads.resolveSellerBundle(bundleAddress(JOB_ID, "seller")))
          .resolves.toMatchObject({ disposition: "present" });
        // Another address is a caller fault, not a substrate read to retry.
        const other = await Promise.resolve()
          .then(() => reads.resolveSellerBundle(bundleAddress(JOB_ID, "buyer")))
          .catch((error: unknown) => error);
        expect(other).toBeInstanceOf(DacsError);
        expect(other).not.toBeInstanceOf(SubstrateError);
        await expect(reads.resolveBundleBinding!(bundleAddress(JOB_ID, "seller"), SELLER))
          .resolves.toMatchObject({ disposition: "present" });
        arrange(harness);

        await expect(reads.resolveSellerBundle(bundleAddress(JOB_ID, "seller")))
          .resolves.toEqual({ disposition: "indeterminate", reason });
        await expect(reads.resolveBundleBinding!(bundleAddress(JOB_ID, "seller"), SELLER))
          .resolves.toEqual({ disposition: "indeterminate", reason });
        const finalization = await harness.audit.bundleTransport.resolveSellerFinalization({
          identity: { jobId: JOB_ID, buyer: BUYER, seller: SELLER },
        } as never);
        // Every surface answering without a binding is a lagging index, which
        // waits outside the ST-7 pause bound; everything else is indeterminate.
        expect(finalization).toEqual(reason === "bundle-binding-undiscovered"
          ? { disposition: "absent", reason: "seller-binding-pending" }
          : { disposition: "indeterminate", reason });
      },
    );
  }

  // ST-11: a name index that lags for longer than the ST-7 pause bound never
  // ends the audit; the buyer waits and finds the seller's copy once it shows.
  it("waits for a lagging seller binding index and resolves the copy once it catches up", async () => {
    const harness = await completionHarness("x402");
    const resolve = harness.adapter.resolveAnchorByName.getMockImplementation()!;
    let indexed = false;
    harness.adapter.resolveAnchorByName.mockImplementation(async (name: string) =>
      name === `dacs5:bundle-binding:${JOB_ID}:seller` && !indexed
        ? { status: "absent" } as never : resolve(name));
    const finalize = () => harness.audit.bundleTransport.resolveSellerFinalization({
      identity: { jobId: JOB_ID, buyer: BUYER, seller: SELLER },
    } as never);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(finalize()).resolves.toEqual({
        disposition: "absent", reason: "seller-binding-pending" });
    }
    indexed = true;
    await expect(finalize()).resolves.toMatchObject({ disposition: "present",
      value: { nativeAddress: harness.copies.seller.nativeAddress,
        binding: harness.copies.seller.binding } });
  });

  // The seller copy's storage-program name is never a consumer resolution key.
  it.each([
    ["absent", { status: "absent" }],
    ["indeterminate", { status: "indeterminate" }],
    ["at another address", { status: "present", address: "native:elsewhere" }],
  ])("finds the seller's copy through its binding when its name lookup is %s", async (_label, answer) => {
    const harness = await completionHarness("x402");
    const resolve = harness.adapter.resolveAnchorByName.getMockImplementation()!;
    harness.adapter.resolveAnchorByName.mockImplementation(async (name: string) =>
      name === bundleAddress(JOB_ID, "seller") ? answer as never : resolve(name));
    const finalization = await harness.audit.bundleTransport.resolveSellerFinalization({
      identity: { jobId: JOB_ID, buyer: BUYER, seller: SELLER },
    } as never);
    expect(finalization).toMatchObject({ disposition: "present",
      value: { nativeAddress: harness.copies.seller.nativeAddress } });
    expect(harness.adapter.resolveAnchorByName).not.toHaveBeenCalledWith(
      bundleAddress(JOB_ID, "seller"), expect.anything());
  });

  it("refuses to resolve another role's copy by its storage-program name", async () => {
    const harness = await completionHarness("x402");
    const publication = createDacsDemosBundlePublicationV1({
      context: harness.context, jobId: JOB_ID, buyer: BUYER, seller: SELLER,
    });
    await expect(publication.resolveRoleBundle("seller")).rejects.toMatchObject({
      reasonCode: "bundle-resolution-role-invalid" });
  });

  it("keeps the BundleBinding of a valid seller publication readable", async () => {
    const harness = await completionHarness("x402");
    const finalization = await harness.audit.bundleTransport.resolveSellerFinalization({
      identity: { jobId: JOB_ID, buyer: BUYER, seller: SELLER },
    } as never);
    expect(finalization).toMatchObject({ disposition: "present" });
  });
});
