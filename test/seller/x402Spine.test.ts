import { describe, expect, it } from "vitest";

import type {
  AnchorReceipt,
  AttestationRef,
  IdentityBundle,
  Listing,
  PaymentRailRef,
} from "../../src/artifacts/index.js";
import { isListing } from "../../src/artifacts/validators.js";
import { createInMemoryFencedSessionStore } from "../../src/agent/fencedSessionStore.js";
import type {
  DurableSellerFulfilmentDeps,
  SellerFinalSessionReceiptResult,
  SellerFulfilmentDurability,
} from "../../src/agent/runDurableFulfilmentCore.js";
import type {
  SellerDeliveredArtifact,
  SellerFulfilmentAgreement,
  SellerFulfilmentListing,
  SellerFulfilmentSessionRecord,
  SignedSellerDeliveryEvidence,
} from "../../src/agent/runFulfilmentCore.js";
import { canonicalize, contentHash, sha256Hex } from "../../src/canonical/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromSeed,
} from "../../src/crypto/index.js";
import { identityBundleHash } from "../../src/identity/index.js";
import type {
  X402PaywallAuthorizationContext,
  X402PaywallExpectedTerms,
  X402PaywallFulfilmentContext,
  X402PaywallHttpAdapter,
  X402PaywallPaymentPayload,
  X402PaywallPaymentRequirements,
  X402PaywallPreSettlementContext,
  X402PaywallSettlementIntent,
  X402PaywallSettlementLoad,
  X402PaywallSettlementOutcome,
  X402PaywallSettlementResult,
  X402PaywallSettlementStore,
} from "../../src/rails/x402Paywall.js";
import {
  x402PaywallCore,
  x402PaywallSettlementKey,
} from "../../src/rails/x402Paywall.js";
import {
  createInMemorySellerReceiptStore,
  x402Eip3009Nonce,
  type CommittedAgreementResolution,
  type SellerListingAtCommitResolution,
  type SellerPaymentAuthorization,
  type SellerPaymentIntakeDeps,
  type SellerX402RailDefinition,
  type X402TransferObservation,
} from "../../src/seller/paymentIntake.js";
import {
  createX402SellerSpine,
  type X402SellerCommittedSessionScope,
  type X402SellerPaymentPermitAuthorization,
  type X402SellerSpine,
} from "../../src/seller/x402Spine.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const PAYMENT_PHASE_INDEX = 2;
const DELIVERY_PHASE_INDEX = 3;
const BUYER = "did:example:buyer";
const SELLER = "did:example:seller";
const PAYER = `0x${"11".repeat(20)}`;
const PAYEE = `0x${"22".repeat(20)}`;
const ASSET = `0x${"33".repeat(20)}`;
const EVM_TX = `0x${"cd".repeat(32)}`;
const HTTP_RESOURCE = "https://seller.example/pay/order";
const NOW = 6_000;
const SELLER_SEED = new Uint8Array(32).fill(17);

const expected: X402PaywallExpectedTerms = {
  network: "eip155:84532",
  payTo: PAYEE,
  amount: "2500000",
  asset: ASSET,
  eip712: { name: "USD Coin", version: "2" },
};

const requirements: X402PaywallPaymentRequirements = {
  scheme: "exact",
  network: expected.network,
  asset: expected.asset,
  amount: expected.amount,
  payTo: expected.payTo,
  maxTimeoutSeconds: 60,
  extra: { name: expected.eip712.name, version: expected.eip712.version },
};

const paymentPayload: X402PaywallPaymentPayload = {
  x402Version: 2,
  accepted: structuredClone(requirements),
  payload: {
    authorization: {
      from: PAYER,
      to: PAYEE,
      value: expected.amount,
      nonce: x402Eip3009Nonce(JOB_ID, PAYMENT_PHASE_INDEX),
    },
  },
};

function identity(primary: string, extraClaim?: string): IdentityBundle {
  const refs = extraClaim ? [primary, extraClaim] : [primary];
  return {
    bundleVersion: "1",
    presentedBy: primary,
    presentedAt: 100,
    claims: refs.map((ref) => ({ ref })),
    presentation: {
      kind: "per-claim",
      signatures: refs.map((ref) => ({ ref, signature: "c2ln" })),
    },
  };
}

function adapter(): X402PaywallHttpAdapter {
  return Object.freeze({
    getHeader: () => "payment-header",
    getMethod: () => "GET",
    getPath: () => `/deliver/${JOB_ID}`,
    getUrl: () => HTTP_RESOURCE,
    getAcceptHeader: () => "application/json",
    getUserAgent: () => "x402-spine-test",
  });
}

function anchorReceipt(logicalAddress: string, hash: string): AnchorReceipt {
  return {
    receiptVersion: "1",
    substrate: "test-sr2",
    finalityProfile: "test-final",
    logicalAddress,
    nativeAddress: `native:${logicalAddress}`,
    contentHash: hash,
    transactionRef: { kind: "test", value: `tx:${hash}` },
    writer: SELLER,
    state: "included",
    observationDisposition: "established",
    observedAt: NOW,
    blockRef: { id: `block:${hash}`, height: "100", timestamp: NOW },
    evidence: { kind: "test-proof", value: `proof:${hash}` },
  };
}

interface TestSettlementStore extends X402PaywallSettlementStore {
  retain(
    intent: X402PaywallSettlementIntent,
    outcome: X402PaywallSettlementOutcome,
  ): void;
}

function settlementStore(): TestSettlementStore {
  let retained: X402PaywallSettlementLoad = { status: "absent" };
  return {
    load: async () => structuredClone(retained),
    claim: async (intent) => {
      if (retained.status === "absent") {
        retained = { status: "held", intent: structuredClone(intent) };
        return { status: "claimed", intent: structuredClone(intent) };
      }
      if (canonicalize(retained.intent) !== canonicalize(intent)) {
        return { status: "conflict" };
      }
      return retained.status === "held"
        ? { status: "held", intent: structuredClone(retained.intent) }
        : {
            status: retained.status,
            intent: structuredClone(retained.intent),
            outcome: structuredClone(retained.outcome),
          };
    },
    recordOutcome: async ({ settlementKey, bindingHash, outcome }) => {
      if (retained.status !== "held" ||
          retained.intent.settlementKey !== settlementKey ||
          retained.intent.bindingHash !== bindingHash) return { status: "conflict" };
      retained = outcome.status === "settled"
        ? {
            status: "settled",
            intent: structuredClone(retained.intent),
            outcome: structuredClone(outcome),
          }
        : {
            status: "failed",
            intent: structuredClone(retained.intent),
            outcome: structuredClone(outcome),
          };
      return {
        status: retained.status,
        intent: structuredClone(retained.intent),
        outcome: structuredClone(retained.outcome),
      };
    },
    retain(intent, outcome) {
      retained = {
        status: "settled",
        intent: structuredClone(intent),
        outcome: structuredClone(outcome) as Extract<
          X402PaywallSettlementOutcome,
          { status: "settled" }
        >,
      };
    },
  };
}

interface Harness {
  spine: X402SellerSpine<{ delivered: boolean }>;
  preContext: X402PaywallPreSettlementContext;
  authorizationContext(
    sessionAuthorization: unknown,
  ): X402PaywallAuthorizationContext;
  fulfilmentContext(
    authorization: X402SellerPaymentPermitAuthorization,
  ): X402PaywallFulfilmentContext<X402SellerPaymentPermitAuthorization>;
  resolvedScope: X402SellerCommittedSessionScope;
  installAuthorization(authorization: SellerPaymentAuthorization): void;
  retainSettlement(sessionAuthorization: unknown): void;
  runThroughPaywallCore(): Promise<unknown>;
  setObservation(observation: X402TransferObservation): void;
  counts: { delivery: number; evidence: number; final: number; render: number };
}

function makeHarness(): Harness {
  const buyerBundle = identity(BUYER, `cci-xm:evm:base:${PAYER}`);
  const sellerBundle = identity(SELLER);
  const railRef: PaymentRailRef = {
    railId: "x402:default",
    railVersion: 1,
    parameters: { httpResource: HTTP_RESOURCE },
  };
  const rail: SellerX402RailDefinition = {
    railVersion: 1,
    railId: railRef.railId,
    railType: "x402",
    asset: {
      kind: "erc20",
      chainId: 84532,
      contract: ASSET,
      symbol: "USDC",
      decimals: 6,
    },
    network: { kind: "x402-resource", resourceBaseUrl: "https://seller.example/pay" },
    phaseHandler: "pay-x402",
    parameters: { finalityBlocks: 3 },
    availability: "live",
  };
  const deliverable = { kind: "storage-program", accessModel: "public" } as const;
  const listing: Listing = {
    dacsVersion: "1",
    listingVersion: 4,
    listingId: "listing-x402-spine",
    seller: {
      identity: sellerBundle,
      displayName: "Seller",
      publicEndpoint: "https://seller.example/engage",
    },
    offering: {
      title: "Atomic delivery",
      description: "One verified deliverable",
      category: "software",
      tags: ["test"],
      deliverable,
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-payee-bound-agreement" },
      { kind: "pay-x402", parameters: { rail: railRef.railId } },
      { kind: "deliver-storage-program" },
    ],
    pricing: { kind: "fixed", price: { amount: "2.5", currency: "USDC" } },
    acceptedRails: [railRef],
    terms: { deadlineSecAfterCommit: 9 },
    validity: { notBefore: 0, notAfter: 20_000 },
    signature: { algorithm: "ed25519", signer: SELLER, value: "c2ln" },
  };
  if (!isListing(listing)) throw new Error("x402 spine fixture Listing is malformed");
  const listingRef = {
    listingId: listing.listingId,
    version: listing.listingVersion,
    contentHash: contentHash(listing as unknown as Record<string, unknown>),
  };
  const agreement: Record<string, unknown> = {
    payeeBoundAgreementVersion: "1",
    jobId: JOB_ID,
    listingRef,
    parties: [
      {
        role: "buyer",
        bundleHash: identityBundleHash(buyerBundle),
        primaryClaim: BUYER,
        vetRecordRef: {
          anchor: {
            kind: "storage-program",
            locator: `dacs2:composite:${JOB_ID}:did%3Aexample%3Abuyer`,
          },
          contentHash: "01".repeat(32),
        },
      },
      {
        role: "seller",
        bundleHash: identityBundleHash(sellerBundle),
        primaryClaim: SELLER,
        vetRecordRef: {
          anchor: {
            kind: "storage-program",
            locator: `dacs2:composite:${JOB_ID}:did%3Aexample%3Aseller`,
          },
          contentHash: "02".repeat(32),
        },
      },
    ],
    terms: {
      deliverable: {
        deliverableType: deliverable.kind,
        hash: sha256Hex(canonicalize(deliverable)),
      },
      price: { amount: "2.5", currency: "USDC" },
      rail: railRef,
      deadline: 10_000,
      payoutBindings: [{
        railId: railRef.railId,
        phaseIndex: PAYMENT_PHASE_INDEX,
        payeeAddress: PAYEE,
      }],
    },
    derivedFromPattern: "fixed-price",
    generatedAt: 500,
    signatures: [
      {
        party: BUYER,
        algorithm: "ed25519",
        value: Buffer.alloc(64, 1).toString("base64url"),
      },
      {
        party: SELLER,
        algorithm: "ed25519",
        value: Buffer.alloc(64, 2).toString("base64url"),
      },
    ],
  };
  const buyerVetRef = structuredClone(
    (agreement.parties as Array<{ vetRecordRef: AttestationRef }>)[0]!.vetRecordRef,
  );
  const sellerVetRef = structuredClone(
    (agreement.parties as Array<{ vetRecordRef: AttestationRef }>)[1]!.vetRecordRef,
  );
  const agreementHash = contentHash(agreement);
  const commitmentRef = `dacs3:commit:${JOB_ID}`;
  const commitmentContentHash = "cd".repeat(32);
  const committed: Extract<CommittedAgreementResolution, { disposition: "verified" }> = {
    disposition: "verified",
    agreement,
    agreementHash,
    commitment: {
      finality: "finalized",
      ref: commitmentRef,
      contentHash: commitmentContentHash,
      jobId: JOB_ID,
      agreementHash,
      listingRef,
      committedAt: 1_000,
      signer: SELLER,
    },
    railRegistryVersion: 7,
  };

  const receiptObject = {
    success: true,
    transaction: EVM_TX,
    network: expected.network,
    payer: PAYER,
    amount: expected.amount,
  };
  const responseHeader = Buffer.from(JSON.stringify(receiptObject)).toString("base64");
  const paymentReceiptHash = sha256Hex(canonicalize(receiptObject));
  const paymentClaim = {
    kind: "pay-x402" as const,
    protocolVersion: "2",
    responseHeader: { name: "PAYMENT-RESPONSE" as const, value: responseHeader },
    httpResource: HTTP_RESOURCE,
    paymentReceiptHash,
    settlementTxHash: EVM_TX,
    chainId: 84532,
  };
  let observation: X402TransferObservation = {
    status: "finalized",
    chainId: 84532,
    txHash: EVM_TX,
    logIndex: 2,
    payer: PAYER,
    payee: PAYEE,
    amountBaseUnits: expected.amount,
    asset: { contract: ASSET, symbol: "USDC", decimals: 6 },
    confirmations: 3,
    includedAt: 4_000,
    finalityObservedAt: 5_000,
    sessionBinding: {
      kind: "eip3009",
      nonce: x402Eip3009Nonce(JOB_ID, PAYMENT_PHASE_INDEX),
    },
  };
  const listingResolution: SellerListingAtCommitResolution = {
    rawListing: listing as unknown as Record<string, unknown>,
    validation: {
      disposition: "verified",
      step: 9,
      reason: "verified",
      listing,
      listingContentHash: listingRef.contentHash,
      revocation: "absent",
      railResolution: { disposition: "verified", reason: "verified" },
    },
  };
  const receiptStore = createInMemorySellerReceiptStore();
  const paymentIntakeDeps: Omit<SellerPaymentIntakeDeps, "receiptStore"> = {
    resolveCommittedAgreement: async () => committed,
    resolveListingAtCommit: async () => listingResolution,
    resolveRail: async ({ railRegistryVersion }) => ({
      disposition: "verified",
      rail,
      railRegistryVersion,
    }),
    resolveIdentityBundle: async (hash) => ({
      disposition: "verified",
      bundle: hash === identityBundleHash(buyerBundle) ? buyerBundle : sellerBundle,
    }),
    resolvePayerAddress: async () => ({ disposition: "verified", address: PAYER }),
    resolvePayeeDestination: async () => ({
      disposition: "bound",
      address: PAYEE,
      tier: 3,
    }),
    observeDemosTransfer: async () => ({ status: "not-found" }),
    observeX402Transfer: async () => observation,
    verifyX402ReceiptExtensions: async () => ({ disposition: "pass" }),
    classifyX402SettlementChain: async () => ({ disposition: "l2" }),
  };

  const fulfilmentListing: SellerFulfilmentListing = {
    pin: structuredClone(listingRef),
    sellerPrimaryClaim: SELLER,
    pipeline: structuredClone(listing.pipeline),
    deliverable,
    buyerRequirement: structuredClone(listing.buyerRequirement),
  };
  const fulfilmentAgreement: SellerFulfilmentAgreement = {
    artifactKind: "payee-bound",
    ref: `agreement:${JOB_ID}`,
    contentHash: agreementHash,
    jobId: JOB_ID,
    listingPin: structuredClone(listingRef),
    buyer: {
      primaryClaim: BUYER,
      bundleHash: identityBundleHash(buyerBundle),
      vetRecordRef: structuredClone(buyerVetRef),
      storageAddress: "demos-address-buyer",
    },
    seller: {
      primaryClaim: SELLER,
      bundleHash: identityBundleHash(sellerBundle),
      vetRecordRef: structuredClone(sellerVetRef),
    },
    deliverableRef: {
      deliverableType: deliverable.kind,
      hash: sha256Hex(canonicalize(deliverable)),
    },
    commitment: {
      status: "finalized",
      ref: commitmentRef,
      agreementHash,
      recordContentHash: commitmentContentHash,
      finalizedAt: 1_000,
      signer: SELLER,
    },
  };
  const artifact: SellerDeliveredArtifact = {
    kind: "deliver-storage-program",
    cleartextPayload: { answer: 42 },
    anchoredValue: { answer: 42 },
    access: { model: "public" },
  };
  const logicalAddress = `dacs4:deliverable:${JOB_ID}`;
  const deliveredHash = sha256Hex(canonicalize(artifact.anchoredValue));
  let activeAuthorization: SellerPaymentAuthorization | undefined;
  let submitted = false;
  let anchoredEvidence: SignedSellerDeliveryEvidence | undefined;
  const counts = { delivery: 0, evidence: 0, final: 0, render: 0 };

  function sessionRecord(): SellerFulfilmentSessionRecord {
    const paymentTxRefs = activeAuthorization?.evidenceInput.paymentTxRefs ?? [{
      kind: "x402-event" as const,
      httpResource: HTTP_RESOURCE,
      paymentReceiptHash,
      settlementTxHash: EVM_TX.slice(2),
      chainId: 84532,
      logIndex: 2,
      protocolVersion: "2",
    }];
    const paymentEvidenceHash = activeAuthorization?.evidenceHash ?? sha256Hex(
      canonicalize({
        evidenceVersion: "1",
        jobId: JOB_ID,
        phase: "pay-x402",
        outcome: "success",
        paymentTxRefs,
        paymentAmount: { amount: "2.5", currency: "USDC" },
        settlementFinality: {
          model: "block-depth",
          finalityBlocks: 3,
          finalityObservedAt:
            observation.status === "finalized" ? observation.finalityObservedAt : 5_000,
        },
        observedAt:
          observation.status === "finalized" ? observation.finalityObservedAt : 5_000,
      }),
    );
    const agreementAttestationRef: AttestationRef = {
      anchor: { kind: "storage-program", locator: fulfilmentAgreement.ref },
      contentHash: agreementHash,
    };
    const commitmentAttestationRef: AttestationRef = {
      anchor: { kind: "storage-program", locator: commitmentRef },
      contentHash: commitmentContentHash,
    };
    const paymentAttestationRef: AttestationRef = {
      anchor: {
        kind: "storage-program",
        locator: `dacs4:payment:${JOB_ID}:x402%3Adefault:${PAYMENT_PHASE_INDEX}`,
      },
      contentHash: paymentEvidenceHash,
    };
    const negotiationContext = {
      "negotiate-fixed-price": {
        agreementHash,
        agreementRef: agreementAttestationRef,
      },
    };
    const commitmentReceipt = anchorReceipt(commitmentRef, commitmentContentHash);
    commitmentReceipt.state = "finalized";
    commitmentReceipt.blockRef!.timestamp = 1_000;
    const commitmentContext = {
      "commit-payee-bound-agreement": {
        agreementHash,
        anchorTxRef: {
          kind: "storage-program" as const,
          address: `native:${commitmentRef}`,
          writeTxHash: "7".repeat(64),
        },
        anchorReceipt: commitmentReceipt,
        committedAt: 1_000,
      },
    };
    return {
      recordVersion: "1",
      jobId: JOB_ID,
      state: "settle-pending",
      listingRef: structuredClone(listingRef),
      parties: [
        {
          role: "buyer",
          bundleHash: identityBundleHash(buyerBundle),
          primaryClaim: BUYER,
          vetRecordRef: structuredClone(buyerVetRef),
        },
        {
          role: "seller",
          bundleHash: identityBundleHash(sellerBundle),
          primaryClaim: SELLER,
          vetRecordRef: structuredClone(sellerVetRef),
        },
        {
          role: "orchestrator",
          bundleHash: identityBundleHash(sellerBundle),
          primaryClaim: SELLER,
        },
      ],
      pipeline: structuredClone(listing.pipeline),
      phaseResults: [
        {
          index: 0,
          step: structuredClone(listing.pipeline[0]!),
          invokedAt: 500,
          result: {
            ok: true,
            contextDelta: structuredClone(negotiationContext),
            attestationRef: agreementAttestationRef,
          },
          contextDelta: structuredClone(negotiationContext),
        },
        {
          index: 1,
          step: structuredClone(listing.pipeline[1]!),
          invokedAt: 1_000,
          result: {
            ok: true,
            contextDelta: structuredClone(commitmentContext),
            attestationRef: commitmentAttestationRef,
            anchorReceipt: commitmentReceipt,
            txRefs: [structuredClone(commitmentContext["commit-payee-bound-agreement"].anchorTxRef)],
          },
          contextDelta: structuredClone(commitmentContext),
        },
        {
          index: PAYMENT_PHASE_INDEX,
          step: structuredClone(listing.pipeline[PAYMENT_PHASE_INDEX]!),
          invokedAt: 5_000,
          result: {
            ok: true,
            txRefs: structuredClone(paymentTxRefs),
            contextDelta: {},
            attestationRef: paymentAttestationRef,
          },
          contextDelta: {},
        },
      ],
      startedAt: 100,
      lastUpdatedAt: 5_500,
      recipeRegistryVersion: 3,
      railRegistryVersion: 7,
    };
  }

  function auditSource() {
    const session = sessionRecord();
    const paymentRef = session.phaseResults[PAYMENT_PHASE_INDEX]!.result.attestationRef!;
    return {
      status: "verified" as const,
      value: {
        sourceVersion: "1" as const,
        session,
        artifacts: {
          agreementCommitment: {
            anchor: { kind: "storage-program" as const, locator: commitmentRef },
            contentHash: commitmentContentHash,
          },
          vetRecords: [structuredClone(buyerVetRef), structuredClone(sellerVetRef)],
          vetRequirements: [
            {
              vetRecordRef: structuredClone(buyerVetRef),
              evaluatedParty: BUYER,
              requirement: structuredClone(listing.buyerRequirement),
              verifier: SELLER,
              freshness: [],
              dealSpecific: [],
            },
            {
              vetRecordRef: structuredClone(sellerVetRef),
              evaluatedParty: SELLER,
              requirement: { requirementVersion: "1" as const, required: [] },
              verifier: SELLER,
              freshness: [],
              dealSpecific: [],
            },
          ],
          settlementEvidence: [structuredClone(paymentRef)],
        },
        provenanceProfile: "dacs-sdk-operational-v1" as const,
      },
    };
  }

  const baseFulfilmentDeps = {
    auditSourceProfile: "v2" as const,
    resolveAgreement: async () => ({ status: "verified" as const, value: fulfilmentAgreement }),
    resolveListing: async () => ({ status: "verified" as const, value: fulfilmentListing }),
    resolveAuditSource: async () => auditSource(),
    prepareDelivery: async () => ({
      status: "prepared" as const,
      delivery: { artifact: structuredClone(artifact) },
    }),
    submitDelivery: async (
      _input: Parameters<DurableSellerFulfilmentDeps["submitDelivery"]>[0],
    ) => {
      counts.delivery += 1;
      submitted = true;
      return { status: "accepted" as const, reconciliationId: `delivery:${JOB_ID}` };
    },
    reconcileDelivery: async () => submitted
      ? { status: "complete" as const, reconciliationId: `delivery:${JOB_ID}`, observedAt: NOW }
      : { status: "absent" as const, reason: "authoritative absence" },
    resolveDelivery: async () => ({
      status: "verified" as const,
      value: {
        artifact: structuredClone(artifact),
        anchorReceipt: anchorReceipt(logicalAddress, deliveredHash),
      },
    }),
    verifyAnchorReceipt: async () => ({ disposition: "valid" as const }),
    verifyDeliverySchema: async () => ({ disposition: "valid" as const }),
    verifyEncryptedDelivery: async () => ({ disposition: "valid" as const }),
    verifyEntitlementSignature: async () => ({ disposition: "valid" as const }),
    evidenceSigner: {
      algorithm: "ed25519" as const,
      signer: SELLER,
      sign: (bytes: Uint8Array) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
    },
    auditSourceCommitmentSigner: {
      algorithm: "ed25519" as const,
      signer: SELLER,
      sign: (bytes: Uint8Array) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
    },
    verifyEvidenceSignature: async ({
      signedBytes,
      signature,
      expectedSigner,
    }: Parameters<DurableSellerFulfilmentDeps["verifyEvidenceSignature"]>[0]) => {
      if (signature.algorithm !== "ed25519" || signature.signer !== expectedSigner) {
        return { disposition: "invalid" as const, reason: "unexpected evidence signer" };
      }
      return ed25519Verify(
        signedBytes,
        Uint8Array.from(Buffer.from(signature.value, "base64url")),
        publicKeyFromSeed(SELLER_SEED),
      )
        ? { disposition: "valid" as const }
        : { disposition: "invalid" as const, reason: "evidence signature mismatch" };
    },
    verifyAuditSourceCommitmentSignature: async ({
      signedBytes,
      signature,
      expectedSigner,
    }: Parameters<
      DurableSellerFulfilmentDeps["verifyAuditSourceCommitmentSignature"]
    >[0]) => {
      if (signature.algorithm !== "ed25519" || signature.signer !== expectedSigner) {
        return { disposition: "invalid" as const, reason: "unexpected audit signer" };
      }
      return ed25519Verify(
        signedBytes,
        Uint8Array.from(Buffer.from(signature.value, "base64url")),
        publicKeyFromSeed(SELLER_SEED),
      )
        ? { disposition: "valid" as const }
        : { disposition: "invalid" as const, reason: "audit signature mismatch" };
    },
    anchorEvidence: async ({ evidence, evidenceHash }: Parameters<
      DurableSellerFulfilmentDeps["anchorEvidence"]
    >[0]) => {
      counts.evidence += 1;
      anchoredEvidence = structuredClone(evidence);
      const locator = `dacs4:delivery-evidence:${JOB_ID}`;
      return {
        status: "anchored" as const,
        ref: { anchor: { kind: "storage-program" as const, locator }, contentHash: evidenceHash },
        anchorReceipt: anchorReceipt(locator, evidenceHash),
      };
    },
    resolveEvidence: async () => anchoredEvidence
      ? { status: "verified" as const, value: structuredClone(anchoredEvidence) }
      : { status: "indeterminate" as const, reason: "evidence unavailable" },
    nowMs: () => NOW,
  } satisfies Omit<DurableSellerFulfilmentDeps, "receiptStore">;

  let durableDelivery: Awaited<ReturnType<DurableSellerFulfilmentDeps["submitDelivery"]>>;
  let durableEvidence: Awaited<ReturnType<DurableSellerFulfilmentDeps["anchorEvidence"]>>;
  let durableFinal: SellerFinalSessionReceiptResult | undefined;
  const durability: SellerFulfilmentDurability = {
    store: createInMemoryFencedSessionStore(),
    workerId: "seller-spine-worker",
    leaseTtlMs: 60_000,
    leaseNowMs: () => NOW,
    reconcilePayloadAttestation: async () => ({
      status: "absent",
      reason: "payload publication is not used",
    }),
    reconcileDeliverySubmission: async () => durableDelivery ?? {
      status: "absent",
      reason: "delivery was not submitted",
    },
    reconcileEvidencePublication: async () => durableEvidence ?? {
      status: "absent",
      reason: "evidence was not published",
    },
    publishFinalSessionReceipt: async () => {
      counts.final += 1;
      durableFinal = { status: "recorded", receipt: { id: `final:${JOB_ID}` } };
      return durableFinal;
    },
    reconcileFinalSessionReceipt: async () => durableFinal ?? {
      status: "absent",
      reason: "final receipt was not published",
    },
  };
  const fulfilmentDeps: Omit<DurableSellerFulfilmentDeps, "receiptStore"> = {
    ...baseFulfilmentDeps,
    submitDelivery: async (input) => {
      const result = await baseFulfilmentDeps.submitDelivery(input);
      durableDelivery = structuredClone(result);
      return result;
    },
    anchorEvidence: async (input) => {
      const result = await baseFulfilmentDeps.anchorEvidence(input);
      durableEvidence = structuredClone(result);
      return result;
    },
  };

  const resolvedScope: X402SellerCommittedSessionScope = {
    scopeVersion: "1",
    jobId: JOB_ID,
    paymentPhaseIndex: PAYMENT_PHASE_INDEX,
    deliveryPhaseIndex: DELIVERY_PHASE_INDEX,
    payer: PAYER,
    payerPayingKey: `cci-xm:evm:base:${PAYER}`,
    httpResource: HTTP_RESOURCE,
    railId: railRef.railId,
    railRegistryVersion: 7,
    agreementRef: fulfilmentAgreement.ref,
    agreementHash,
    listingRef: structuredClone(listingRef),
    commitmentRef,
    commitmentContentHash,
    commitmentFinalizedAt: 1_000,
    expected: structuredClone(expected),
  };
  const retainedSettlementStore = settlementStore();
  const spine = createX402SellerSpine({
    settlementStore: retainedSettlementStore,
    reconcileSettlement: async () => ({ status: "pending", reason: "not used" }),
    receiptStore,
    resolveCommittedSession: async () => ({
      disposition: "verified",
      session: structuredClone(resolvedScope),
    }),
    paymentIntakeDeps,
    fulfilmentDeps,
    fulfilmentDurability: durability,
    renderResponse: async () => {
      counts.render += 1;
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { delivered: true },
      };
    },
  });
  const request = adapter();
  const preContext: X402PaywallPreSettlementContext = {
    jobId: JOB_ID,
    phaseIndex: PAYMENT_PHASE_INDEX,
    payer: PAYER,
    request,
    paymentPayload: structuredClone(paymentPayload),
    paymentRequirements: structuredClone(requirements),
    expected: structuredClone(expected),
  };
  const settlement: X402PaywallSettlementResult & { success: true } = {
    success: true,
    transaction: EVM_TX,
    network: expected.network,
    payer: PAYER,
    amount: expected.amount,
    headers: { "PAYMENT-RESPONSE": responseHeader },
    requirements: structuredClone(requirements),
  };
  return {
    spine,
    preContext,
    authorizationContext: (sessionAuthorization) => ({
      jobId: JOB_ID,
      phaseIndex: PAYMENT_PHASE_INDEX,
      payer: PAYER,
      request,
      sessionAuthorization,
      paymentClaim: structuredClone(paymentClaim),
      settlement: structuredClone(settlement),
    }),
    fulfilmentContext: (authorization) => ({
      jobId: JOB_ID,
      phaseIndex: PAYMENT_PHASE_INDEX,
      idempotencyKey: "transport-only-key",
      payer: PAYER,
      request,
      paymentPayload: structuredClone(paymentPayload),
      paymentRequirements: structuredClone(requirements),
      paymentClaim: structuredClone(paymentClaim),
      settlement: structuredClone(settlement),
      authorization,
    }),
    resolvedScope,
    installAuthorization(value) {
      activeAuthorization = structuredClone(value);
    },
    retainSettlement(sessionAuthorization) {
      const intentCore = {
        intentVersion: "2" as const,
        settlementKey: x402PaywallSettlementKey({
          jobId: JOB_ID,
          phaseIndex: PAYMENT_PHASE_INDEX,
        }),
        jobId: JOB_ID,
        phaseIndex: PAYMENT_PHASE_INDEX,
        httpResource: HTTP_RESOURCE,
        payer: PAYER,
        paymentHeader: "payment-header",
        paymentPayload: structuredClone(paymentPayload),
        paymentRequirements: structuredClone(requirements),
        sessionAuthorization: structuredClone(sessionAuthorization),
      };
      const intent: X402PaywallSettlementIntent = {
        ...intentCore,
        bindingHash: sha256Hex(canonicalize(intentCore)),
      };
      retainedSettlementStore.retain(intent, {
        status: "settled",
        settlement: structuredClone(settlement),
      });
    },
    runThroughPaywallCore() {
      const encodedPayload = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
      const request: X402PaywallHttpAdapter = Object.freeze({
        getHeader: (name: string) => name.toUpperCase() === "PAYMENT-SIGNATURE"
          ? encodedPayload
          : undefined,
        getMethod: () => "GET",
        getPath: () => new URL(HTTP_RESOURCE).pathname,
        getUrl: () => HTTP_RESOURCE,
        getAcceptHeader: () => "application/json",
        getUserAgent: () => "x402-spine-core-integration",
      });
      return x402PaywallCore({
        jobId: JOB_ID,
        phaseIndex: PAYMENT_PHASE_INDEX,
        request,
      }, {
        server: {
          initialize: async () => undefined,
          processHTTPRequest: async () => ({
            type: "payment-verified" as const,
            cancellationDispatcher: { cancel: async () => undefined },
            paymentPayload: structuredClone(paymentPayload),
            paymentRequirements: structuredClone(requirements),
          }),
          processSettlement: async () => structuredClone(settlement),
        },
        expected: structuredClone(expected),
        ...spine,
      });
    },
    setObservation(value) {
      observation = structuredClone(value);
    },
    counts,
  };
}

async function authorize(harness: Harness): Promise<X402SellerPaymentPermitAuthorization> {
  const pre = await harness.spine.authorizeSettlement(harness.preContext);
  if (pre.disposition !== "authorized") {
    throw new Error(`pre-settlement authorization failed: ${pre.reason}`);
  }
  const post = await harness.spine.authorizePayment(
    harness.authorizationContext(pre.authorization),
  );
  if (post.disposition !== "authorized") {
    throw new Error(`post-settlement authorization failed: ${post.reason}`);
  }
  harness.installAuthorization(post.authorization.paymentAuthorization);
  harness.retainSettlement(pre.authorization);
  return post.authorization;
}

describe("createX402SellerSpine", () => {
  it("runs the real x402 paywall WAL shape through the seller compositor", async () => {
    const harness = makeHarness();

    await expect(harness.runThroughPaywallCore()).resolves.toMatchObject({
      disposition: "settled",
      settled: true,
      reason: "verified-authorized-fulfilled-settled",
      response: {
        status: 200,
        body: { delivered: true },
      },
    });
    expect(harness.counts.delivery).toBe(1);
    expect(harness.counts.evidence).toBe(1);
    expect(harness.counts.final).toBe(1);
    expect(harness.counts.render).toBe(1);
  });

  it("runs real #119 and generation-fenced #120/#121 with one irreversible delivery", async () => {
    const harness = makeHarness();
    const authorization = await authorize(harness);
    const context = harness.fulfilmentContext(authorization);

    const concurrent = await Promise.all([
      harness.spine.fulfil(context),
      harness.spine.fulfil(context),
    ]);
    const replay = await harness.spine.fulfil(context);

    expect([...concurrent, replay].some((result) => result.disposition === "fulfilled")).toBe(true);
    expect(replay).toMatchObject({
      disposition: "fulfilled",
      status: 200,
      body: { delivered: true },
    });
    expect(harness.counts.delivery).toBe(1);
    expect(harness.counts.evidence).toBe(1);
    expect(harness.counts.final).toBe(1);
  });

  it("rejects an authenticated pre-settlement scope for another payer", async () => {
    const harness = makeHarness();
    harness.resolvedScope.payer = `0x${"44".repeat(20)}`;

    await expect(harness.spine.authorizeSettlement(harness.preContext)).resolves.toEqual({
      disposition: "rejected",
      reason: "seller-session-scope-mismatch",
    });
    expect(harness.counts.delivery).toBe(0);
  });

  it("stops at #119 while x402 settlement finality is pending", async () => {
    const harness = makeHarness();
    const pre = await harness.spine.authorizeSettlement(harness.preContext);
    if (pre.disposition !== "authorized") throw new Error(pre.reason);
    harness.setObservation({ status: "pending", reason: "confirmations pending" });

    await expect(harness.spine.authorizePayment(
      harness.authorizationContext(pre.authorization),
    )).resolves.toMatchObject({
      disposition: "indeterminate",
      reason: "x402-pending",
    });
    expect(harness.counts.delivery).toBe(0);
    expect(harness.counts.render).toBe(0);
  });

  it("rejects a settlement transaction or receipt header mixed with another claim", async () => {
    const harness = makeHarness();
    const pre = await harness.spine.authorizeSettlement(harness.preContext);
    if (pre.disposition !== "authorized") throw new Error(pre.reason);

    const mixedTransaction = harness.authorizationContext(pre.authorization);
    mixedTransaction.settlement.transaction = `0x${"ef".repeat(32)}`;
    await expect(harness.spine.authorizePayment(mixedTransaction)).resolves.toEqual({
      disposition: "indeterminate",
      reason: "seller-settlement-session-mismatch",
    });

    const mixedHeader = harness.authorizationContext(pre.authorization);
    mixedHeader.settlement.headers["PAYMENT-RESPONSE"] = "another-receipt";
    await expect(harness.spine.authorizePayment(mixedHeader)).resolves.toEqual({
      disposition: "indeterminate",
      reason: "seller-settlement-session-mismatch",
    });
    expect(harness.counts.delivery).toBe(0);
  });

  it("does not deliver when the retained #119 permit is substituted", async () => {
    const harness = makeHarness();
    const authorization = await authorize(harness);
    const substituted = structuredClone(authorization);
    substituted.paymentPermitId = "seller-payment:attacker-permit";

    await expect(harness.spine.fulfil(
      harness.fulfilmentContext(substituted),
    )).resolves.not.toMatchObject({ disposition: "fulfilled" });
    expect(harness.counts.delivery).toBe(0);
    expect(harness.counts.evidence).toBe(0);
    expect(harness.counts.render).toBe(0);
  });

  it("does not trust a mixed response header under the retained receipt hash", async () => {
    const harness = makeHarness();
    const authorization = await authorize(harness);
    const context = harness.fulfilmentContext(authorization);
    const mixedHeader = Buffer.from(JSON.stringify({
      success: true,
      transaction: EVM_TX,
      network: expected.network,
      payer: `0x${"44".repeat(20)}`,
      amount: expected.amount,
    })).toString("base64");
    context.paymentClaim.responseHeader.value = mixedHeader;
    context.settlement.headers["PAYMENT-RESPONSE"] = mixedHeader;

    await expect(harness.spine.fulfil(context)).resolves.toEqual({
      disposition: "indeterminate",
      reason: "seller-fulfilment-session-mismatch",
    });
    expect(harness.counts.delivery).toBe(0);
    expect(harness.counts.evidence).toBe(0);
    expect(harness.counts.render).toBe(0);
  });

  it("does not let a direct caller substitute the payer retained beside a valid permit", async () => {
    const harness = makeHarness();
    const authorization = await authorize(harness);
    const substituted = structuredClone(authorization);
    const attacker = `0x${"44".repeat(20)}`;
    substituted.sessionAuthorization.payer = attacker;
    const context = harness.fulfilmentContext(substituted);
    context.payer = attacker;
    delete context.settlement.payer;

    await expect(harness.spine.fulfil(context)).resolves.toEqual({
      disposition: "indeterminate",
      reason: "seller-fulfilment-session-mismatch",
    });
    expect(harness.counts.delivery).toBe(0);
    expect(harness.counts.evidence).toBe(0);
    expect(harness.counts.render).toBe(0);
  });

  it("binds the caller authorization to the same permit before any delivery effect", async () => {
    const harness = makeHarness();
    const authorization = await authorize(harness);
    const substituted = structuredClone(authorization);
    substituted.paymentAuthorization.sessionBinding = "not-established";

    await expect(harness.spine.fulfil(
      harness.fulfilmentContext(substituted),
    )).resolves.toEqual({
      disposition: "indeterminate",
      reason: "seller-consumed-payment-authorization-mismatch",
    });
    expect(harness.counts.delivery).toBe(0);
    expect(harness.counts.evidence).toBe(0);
    expect(harness.counts.render).toBe(0);
  });

  it("binds session-only fulfilment scope to the exact pre-settlement WAL intent", async () => {
    const harness = makeHarness();
    const authorization = await authorize(harness);
    const substituted = structuredClone(authorization);
    substituted.sessionAuthorization.payerPayingKey =
      "cci-xm:evm:base:attacker-substitution";

    await expect(harness.spine.fulfil(
      harness.fulfilmentContext(substituted),
    )).resolves.toEqual({
      disposition: "indeterminate",
      reason: "seller-settlement-session-authorization-mismatch",
    });
    expect(harness.counts.delivery).toBe(0);
    expect(harness.counts.evidence).toBe(0);
    expect(harness.counts.render).toBe(0);
  });
});
