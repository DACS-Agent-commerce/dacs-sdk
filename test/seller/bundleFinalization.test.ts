import { readFileSync } from "node:fs";

import { describe, expect, test, vi } from "vitest";

import {
  BUNDLE_BINDING_SEPARATOR,
  ARTIFACT_SEPARATORS,
  type AnchorReceipt,
  type AttestationRef,
  type BundleBinding,
  type ComponentSignature,
  type CompositeVerificationRecord,
  type FaultAttestationBundle,
  type Listing,
  type VerifyResult,
  isFaultAttestationBundle,
} from "../../src/artifacts/index.js";
import {
  bundleAddress,
  canonicalize,
  contentHash,
  listingAddress,
  sha256Hex,
} from "../../src/canonical/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
  signedBytes,
} from "../../src/crypto/index.js";
import { identityBundleHash } from "../../src/identity/bundle.js";
import {
  attestationBundleHash,
} from "../../src/agent/twoSidedBundle.js";
import {
  sellerFulfilmentId,
  type SellerFulfilmentAgreement,
  type SellerFulfilmentResult,
} from "../../src/agent/runFulfilmentCore.js";
import type { SellerPaymentEvidenceInput } from "../../src/seller/paymentIntake.js";
import type { RecipeDescriptor } from "../../src/registry/types.js";
import {
  finalizeCompletedSellerBundleCore,
  prepareCompletedSellerBundleCounterSignatureRequest,
  verifyCompletedSellerBundleCounterSignatureRequest,
  verifyFinalizedSellerBundleReadOnly,
  type AnchoredSellerBundle,
  type CompletedSellerBundleCounterSignatureRequest,
  type FinalizeCompletedSellerBundleInput,
  type FinalizedSellerBundle,
  type SellerBundleDependencySource,
  type SellerBundleFinalizationProvider,
  type SellerBundleFinalizationReadProvider,
  type VerifyCompletedSellerBundleCounterSignatureRequestInput,
  type VerifyFinalizedSellerBundleInput,
} from "../../src/seller/bundleFinalization.js";
import { isBundleBinding } from "../../src/artifacts/validators.js";

const NOW = 1_786_000_000_000;
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = `did:demos:agent:${"1".repeat(64)}`;
const SELLER = `did:demos:agent:${"2".repeat(64)}`;
const OUTSIDER = "did:demos:outsider";
const BUYER_SEED = new Uint8Array(32).fill(31);
const SELLER_SEED = new Uint8Array(32).fill(32);

function signTestComponent<T extends Record<string, unknown>>(
  unsigned: T,
  separator: Parameters<typeof signedBytes>[0],
): T & { signature: ComponentSignature } {
  return {
    ...unsigned,
    signature: {
      algorithm: "ed25519",
      signer: SELLER,
      value: Buffer.from(
        ed25519Sign(
          signedBytes(separator, contentHash(unsigned)),
          privateKeyFromSeed(SELLER_SEED),
        ),
      ).toString("base64url"),
    },
  };
}

function residualPadBitAlias(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const decoded = Buffer.from(value, "base64url");
  for (const replacement of alphabet) {
    const candidate = `${value.slice(0, -1)}${replacement}`;
    if (
      candidate !== value &&
      Buffer.from(candidate, "base64url").equals(decoded) &&
      Buffer.from(candidate, "base64url").toString("base64url") !== candidate
    ) {
      return candidate;
    }
  }
  throw new Error("fixture signature has no residual-pad-bit alias");
}

const ref = (name: string, value: Record<string, unknown>): AttestationRef => ({
  anchor: { kind: "storage-program", locator: `dacs-test:${name}` },
  contentHash: contentHash(value),
});

function receipt(
  contentHashValue: string,
  logicalAddress = `dacs-test:${contentHashValue.slice(0, 12)}`,
  nativeAddress = `stor-${contentHashValue.slice(0, 40)}`,
  writer = "test-writer",
): AnchorReceipt {
  return {
    receiptVersion: "1",
    substrate: "test:final",
    finalityProfile: "test-final",
    logicalAddress,
    nativeAddress,
    contentHash: contentHashValue,
    transactionRef: { kind: "test", value: `tx-${contentHashValue.slice(0, 16)}` },
    writer,
    state: "finalized",
    observationDisposition: "established",
    observedAt: NOW,
    blockRef: { id: `block-${contentHashValue.slice(0, 8)}`, timestamp: NOW - 1_000 },
    evidence: { kind: "test-finality", value: `proof-${contentHashValue.slice(0, 16)}` },
  };
}

function bindingSignatureVerifies(binding: BundleBinding): boolean {
  return (
    binding.signer === SELLER &&
    binding.signature.signer === SELLER &&
    binding.signature.algorithm === "ed25519" &&
    ed25519Verify(
      signedBytes(
        BUNDLE_BINDING_SEPARATOR,
        contentHash(binding as unknown as Record<string, unknown>),
      ),
      Buffer.from(binding.signature.value, "base64url"),
      publicKeyFromSeed(SELLER_SEED),
    )
  );
}

function fixture(
  mapping: "pure" | "write-input" = "pure",
  deliveryMode: "storage" | "attested" = "storage",
  includeDeclinedRate = false,
  repeatDelivery = false,
  extraAgreementSigner = false,
  options: {
    procurement?: boolean;
    listingPublisherOverride?: string;
    sellerVerifyDecision?: "pass" | "fail" | "indeterminate" | "error";
    sellerVetDecision?: "pass" | "fail" | "indeterminate" | "error";
    resolvedPayment?: boolean;
    repeatedPayment?: boolean;
  } = {},
) {
  const attested = deliveryMode === "attested";
  const procurement = options.procurement === true;
  const listingPublisher =
    options.listingPublisherOverride ?? (procurement ? BUYER : SELLER);
  const repeatedPayment = options.repeatedPayment === true;
  const buyerRequirement = {
    requirementVersion: "1" as const,
    required: [{ scheme: "did", verificationRequired: true }],
  };
  const sellerRequirement = {
    requirementVersion: "1" as const,
    required: [
      {
        scheme: "did",
        verificationRequired: true,
        parameters: { counterpartyRequirement: "seller" },
      },
    ],
  };
  const verificationRecipe = signTestComponent(
    {
      recipeVersion: 1,
      scheme: "did",
      defaultMethod: { kind: "self-signed" as const },
      defaultMaxAgeSec: 3_600,
      parserRules: { format: "raw" as const, matcher: "identity" },
      retryClass: "permanent" as const,
      availability: "live" as const,
      governance: {
        proposedBy: SELLER,
        acceptedAt: NOW - 30_000,
        anchoring: "single-signer" as const,
      },
    },
    "dacs-recipe:v1:",
  ) satisfies RecipeDescriptor & { signature: ComponentSignature };
  const deliverable: Listing["offering"]["deliverable"] = attested
    ? {
        kind: "attested-payload",
        payloadFormat: "application/octet-stream",
        verificationMethod: { kind: "self-signed" },
      }
    : { kind: "storage-program", accessModel: "public" };
  const deliveryStep = attested
    ? ({ kind: "deliver-attested-payload" as const })
    : ({ kind: "deliver-storage-program" as const });
  const pipeline = [
    ...(procurement
      ? ([{
          kind: "negotiate-sealed-envelope-procurement" as const,
          parameters: {
            commitDeadline: NOW + 120_000,
            revealWindow: 60,
            selectionRule: "lowest-price" as const,
            auctionMode: "procurement" as const,
          },
        }] as const)
      : ([{ kind: "negotiate-fixed-price" as const }] as const)),
    { kind: "commit-payee-bound-agreement" as const },
    { kind: "pay-x402" as const, parameters: { rail: "x402:default" } },
    ...(repeatedPayment
      ? ([{
          kind: "pay-x402" as const,
          parameters: { rail: "x402:default" },
        }] as const)
      : []),
    deliveryStep,
    ...(repeatDelivery ? [deliveryStep] : []),
    ...(includeDeclinedRate ? ([{ kind: "rate" as const }] as const) : []),
  ];
  const deliveryIndex = repeatedPayment ? 4 : 3;
  const repeatedDeliveryIndex = deliveryIndex + 1;
  const rateIndex = repeatedDeliveryIndex + (repeatDelivery ? 1 : 0);
  const listingArtifact: Listing = {
    dacsVersion: "1",
    listingVersion: 4,
    listingId: "listing-finalization-17",
    seller: {
      identity: {
        bundleVersion: "1",
        presentedBy: listingPublisher,
        presentedAt: NOW - 30_000,
        claims: [{ ref: listingPublisher }],
        presentation: {
          kind: "per-claim",
          signatures: [{ ref: listingPublisher, signature: "publisher-identity-proof" }],
        },
      },
      displayName: "Seller",
      publicEndpoint: "https://seller.example/dacs",
    },
    offering: {
      title: "Stored result",
      description: "One storage-program result",
      category: "software",
      tags: ["test"],
      deliverable,
    },
    buyerRequirement,
    pipeline,
    pricing: procurement
      ? { kind: "auction", selectionRule: "lowest-price" }
      : { kind: "fixed", price: { amount: "2", currency: "USDC" } },
    acceptedRails: [{ railId: "x402:default", railVersion: 1 }],
    terms: {},
    validity: { notBefore: NOW - 100_000, notAfter: NOW + 100_000 },
    signature: {
      algorithm: "ed25519",
      signer: listingPublisher,
      value: Buffer.alloc(64, 5).toString("base64url"),
    },
  };
  const listingHash = contentHash(listingArtifact as unknown as Record<string, unknown>);
  const sellerIdentityHash = identityBundleHash(listingArtifact.seller.identity);
  // A post-Vet session bundle is distinct from the published Listing bundle
  // (for example because it carries a fresh sessionNonce).
  const sellerSessionBundleHash = "c".repeat(64);
  const buyerAuthority = {
    authorityEvidenceVersion: "1",
    claim: BUYER,
    decision: "pass",
  };
  const sellerAuthority = {
    authorityEvidenceVersion: "1",
    claim: SELLER,
    decision: "pass",
  };
  const buyerAuthorityRef = {
    ...ref("buyer-authority", buyerAuthority),
    signer: SELLER,
  };
  const sellerAuthorityRef = {
    ...ref("seller-authority", sellerAuthority),
    signer: SELLER,
  };
  const makeVerifyResult = (
    party: string,
    authority: AttestationRef,
    decision: "pass" | "fail" | "indeterminate" | "error" = "pass",
  ): VerifyResult =>
    signTestComponent(
      {
        resultVersion: "1" as const,
        scheme: "did",
        identifier: party.slice("did:".length),
        recipeVersion: 1,
        method: "self-signed" as const,
        decision,
        reason: "deterministic identity proof passed",
        attestation: authority,
        fetchedAt: NOW - 19_000,
        verifiedAt: NOW - 18_000,
        validUntil: NOW + 60_000,
      },
      "dacs-verifyresult:v1:",
    );
  const buyerVerifyResult = makeVerifyResult(BUYER, buyerAuthorityRef);
  const sellerVerifyResult = makeVerifyResult(
    SELLER,
    sellerAuthorityRef,
    options.sellerVerifyDecision,
  );
  const buyerVerifyAttestationRef = ref(
    "buyer-verify-result",
    buyerVerifyResult as unknown as Record<string, unknown>,
  );
  const sellerVerifyAttestationRef = ref(
    "seller-verify-result",
    sellerVerifyResult as unknown as Record<string, unknown>,
  );
  const buyerVerifyRef = {
    ...buyerVerifyAttestationRef,
    recipeVersion: 1,
  };
  const sellerVerifyRef = {
    ...sellerVerifyAttestationRef,
    recipeVersion: 1,
  };
  const buyerVetRequirement = procurement ? sellerRequirement : buyerRequirement;
  const sellerVetRequirement = procurement ? buyerRequirement : sellerRequirement;
  const makeVetRecord = (
    party: string,
    bundleHash: string,
    verifyRef: typeof buyerVerifyRef,
    requirement: typeof buyerRequirement,
    overallDecision: CompositeVerificationRecord["overallDecision"] = "pass",
  ): CompositeVerificationRecord =>
    signTestComponent(
      {
        recordVersion: "1" as const,
        jobId: JOB_ID,
        evaluatedParty: party,
        bundleHash,
        requirementHash: sha256Hex(
          canonicalize(requirement as unknown as Record<string, unknown>),
        ),
        freshness: [],
        supplementary: [],
        dealSpecific: [verifyRef],
        overallDecision,
        generatedAt: NOW - 16_000,
      },
      "dacs-composite:v1:",
    );
  const buyerVet = makeVetRecord(
    BUYER,
    "b".repeat(64),
    buyerVerifyRef,
    buyerVetRequirement,
  );
  const sellerVet = makeVetRecord(
    SELLER,
    sellerSessionBundleHash,
    sellerVerifyRef,
    sellerVetRequirement,
    options.sellerVetDecision,
  );
  const buyerVetRef = ref(
    "buyer-vet",
    buyerVet as unknown as Record<string, unknown>,
  );
  const sellerVetRef = ref(
    "seller-vet",
    sellerVet as unknown as Record<string, unknown>,
  );
  const listingPin = {
    listingId: listingArtifact.listingId,
    version: listingArtifact.listingVersion,
    contentHash: listingHash,
  };
  const agreementArtifact = {
    payeeBoundAgreementVersion: "1" as const,
    jobId: JOB_ID,
    listingRef: listingPin,
    parties: [
      {
        role: "buyer" as const,
        bundleHash: "b".repeat(64),
        primaryClaim: BUYER,
        vetRecordRef: buyerVetRef,
      },
      {
        role: "seller" as const,
        bundleHash: sellerSessionBundleHash,
        primaryClaim: SELLER,
        vetRecordRef: sellerVetRef,
      },
    ],
    terms: {
      deliverable: {
        deliverableType: deliverable.kind,
        hash: sha256Hex(
          canonicalize(deliverable as unknown as Record<string, unknown>),
        ),
      },
      price: { amount: "2", currency: "USDC" },
      rail: { railId: "x402:default", railVersion: 1 },
      deadline: NOW + 60_000,
      payoutBindings: [
        {
          railId: "x402:default",
          phaseIndex: 2,
          payeeAddress: SELLER,
        },
        ...(repeatedPayment
          ? [{
              railId: "x402:default",
              phaseIndex: 3,
              payeeAddress: SELLER,
            }]
          : []),
      ],
    },
    derivedFromPattern: procurement ? ("sealed-envelope" as const) : ("fixed-price" as const),
    generatedAt: NOW - 15_000,
    signatures: [
      {
        party: BUYER,
        algorithm: "ed25519" as const,
        value: Buffer.alloc(64, 6).toString("base64url"),
      },
      {
        party: SELLER,
        algorithm: "ed25519" as const,
        value: Buffer.alloc(64, 7).toString("base64url"),
      },
      ...(extraAgreementSigner
        ? [{
            party: OUTSIDER,
            algorithm: "ed25519" as const,
            value: Buffer.alloc(64, 13).toString("base64url"),
          }]
        : []),
    ],
  };
  const agreementRef = ref("agreement", agreementArtifact);
  const commitmentArtifact = {
    finalityCommitmentVersion: "1" as const,
    jobId: JOB_ID,
    agreementHash: agreementRef.contentHash,
    listingRef: listingPin,
    parties: [BUYER, SELLER, ...(extraAgreementSigner ? [OUTSIDER] : [])],
    pattern: procurement ? ("sealed-envelope" as const) : ("fixed-price" as const),
    createdAt: NOW - 12_000,
    signature: {
      algorithm: "ed25519" as const,
      signer: SELLER,
      value: Buffer.alloc(64, 8).toString("base64url"),
    },
  };
  const commitmentRef = ref("commitment", commitmentArtifact);
  const interimPaymentArtifact = options.resolvedPayment
    ? {
        evidenceVersion: "1" as const,
        jobId: JOB_ID,
        phase: "pay-x402" as const,
        outcome: "failure" as const,
        reason: "recovery-pending",
        paymentTxRefs: [
          {
            kind: "x402" as const,
            httpResource: "https://seller.example/pay",
            paymentReceiptHash: "3".repeat(64),
            settlementTxHash: `0x${"4".repeat(64)}`,
            chainId: 8453,
            protocolVersion: "1",
          },
        ],
        observedAt: NOW - 4_500,
        signature: {
          algorithm: "ed25519" as const,
          signer: SELLER,
          value: Buffer.alloc(64, 14).toString("base64url"),
        },
      }
    : undefined;
  const interimPaymentRef = interimPaymentArtifact
    ? ref("payment-interim", interimPaymentArtifact)
    : undefined;
  const paymentEvidenceInput = {
    evidenceVersion: "1" as const,
    jobId: JOB_ID,
    phase: "pay-x402" as const,
    outcome: "success" as const,
    paymentTxRefs: [
      {
        kind: "x402" as const,
        httpResource: "https://seller.example/pay",
        paymentReceiptHash: "1".repeat(64),
        settlementTxHash: `0x${"2".repeat(64)}`,
        chainId: 8453,
        protocolVersion: "1",
      },
    ],
    paymentAmount: { amount: "2", currency: "USDC" },
    settlementFinality: {
      model: "block-depth" as const,
      finalityBlocks: 2,
      finalityObservedAt: NOW - 4_000,
    },
    observedAt: NOW - 4_000,
  } satisfies SellerPaymentEvidenceInput;
  const paymentArtifact = {
    ...paymentEvidenceInput,
    ...(interimPaymentRef ? { supersedesEvidenceRef: interimPaymentRef } : {}),
    signature: {
      algorithm: "ed25519" as const,
      signer: SELLER,
      value: Buffer.alloc(64, 9).toString("base64url"),
    },
  };
  const paymentRef = ref("payment", paymentArtifact);
  const repeatedPaymentEvidenceInput = repeatedPayment
    ? ({
        ...paymentEvidenceInput,
        settlementFinality: {
          ...paymentEvidenceInput.settlementFinality,
          finalityObservedAt: NOW - 3_500,
        },
        observedAt: NOW - 3_500,
      } satisfies SellerPaymentEvidenceInput)
    : undefined;
  const repeatedPaymentArtifact = repeatedPaymentEvidenceInput
    ? {
        ...repeatedPaymentEvidenceInput,
        signature: {
          algorithm: "ed25519" as const,
          signer: SELLER,
          value: Buffer.alloc(64, 15).toString("base64url"),
        },
      }
    : undefined;
  const repeatedPaymentRef = repeatedPaymentArtifact
    ? ref("payment-repeat", repeatedPaymentArtifact)
    : undefined;
  const deliveryPayload = { result: "delivered" };
  const deliveryBytes = Uint8Array.from(Buffer.from("exact-attested-payload"));
  const deliveredHash = attested
    ? sha256Hex(deliveryBytes)
    : sha256Hex(canonicalize(deliveryPayload));
  const methodEvidence = {
    methodEvidenceVersion: "1",
    payloadContentHash: deliveredHash,
    proof: "self-signed-payload-proof",
  };
  const methodEvidenceRef = ref("payload-method-evidence", methodEvidence);
  const verificationMethod =
    deliverable.kind === "attested-payload" ? deliverable.verificationMethod : undefined;
  const verificationMethodHash = verificationMethod
    ? sha256Hex(
        canonicalize(verificationMethod as unknown as Record<string, unknown>),
      )
    : "0".repeat(64);
  const payloadAttestation = {
    payloadAttestationVersion: "1" as const,
    jobId: JOB_ID,
    agreementHash: agreementRef.contentHash,
    deliverableSpecHash: sha256Hex(
      canonicalize(deliverable as unknown as Record<string, unknown>),
    ),
    payloadFormat:
      deliverable.kind === "attested-payload"
        ? deliverable.payloadFormat
        : "application/octet-stream",
    payloadContentHash: deliveredHash,
    verificationMethod: verificationMethod?.kind ?? "self-signed",
    verificationMethodHash,
    attempt: 0,
    decision: "pass" as const,
    reason: "method proof verified",
    methodEvidenceRef,
    verifiedAt: NOW - 2_500,
    signature: {
      algorithm: "ed25519" as const,
      signer: SELLER,
      value: Buffer.alloc(64, 11).toString("base64url"),
    },
  };
  const payloadAttestationRef: AttestationRef = {
    anchor: {
      kind: "storage-program",
      locator: `dacs4:payload-attestation:${JOB_ID}:${verificationMethodHash}:0`,
    },
    contentHash: contentHash(payloadAttestation),
  };

  const deliveryEvidence = {
    evidenceVersion: "1" as const,
    jobId: JOB_ID,
    phase: attested
      ? ("deliver-attested-payload" as const)
      : ("deliver-storage-program" as const),
    observedAt: NOW - 2_000,
    outcome: "success" as const,
    deliverableContentHash: deliveredHash,
    deliverableAnchor: {
      kind: "storage-program",
      locator: `dacs4:deliverable:${JOB_ID}`,
    },
    ...(attested ? { attestationRef: payloadAttestationRef } : {}),
    signature: {
      algorithm: "ed25519" as const,
      signer: SELLER,
      value: Buffer.alloc(64, 10).toString("base64url"),
    },
  };
  const deliveryHash = contentHash(deliveryEvidence);
  const deliveryRef: AttestationRef = {
    anchor: {
      kind: "storage-program",
      locator: `dacs4:delivery:${JOB_ID}:${deliveryIndex}`,
    },
    contentHash: deliveryHash,
  };
  const repeatedDeliveryEvidence = repeatDelivery
    ? {
        ...deliveryEvidence,
        observedAt: NOW - 1_500,
        signature: {
          algorithm: "ed25519" as const,
          signer: SELLER,
          value: Buffer.alloc(64, 12).toString("base64url"),
        },
      }
    : undefined;
  const repeatedDeliveryRef: AttestationRef | undefined = repeatedDeliveryEvidence
    ? {
        anchor: {
          kind: "storage-program",
          locator: `dacs4:delivery:${JOB_ID}:${repeatedDeliveryIndex}`,
        },
        contentHash: contentHash(repeatedDeliveryEvidence),
      }
    : undefined;
  const fulfilment: Extract<SellerFulfilmentResult, { decision: "completed" }> = {
    decision: "completed",
    fulfilmentId: sellerFulfilmentId({
      jobId: JOB_ID,
      paymentPhaseIndex: 2,
      deliveryPhaseIndex: deliveryIndex,
      settlementId: `evm:8453:${"2".repeat(64)}:0`,
      agreementHash: agreementRef.contentHash,
      paymentEvidenceHash: sha256Hex(canonicalize(paymentEvidenceInput)),
    }),
    evidence: structuredClone(deliveryEvidence),
    evidenceHash: deliveryHash,
    evidenceRef: deliveryRef,
    evidenceAnchorReceipt: receipt(deliveryHash, deliveryRef.anchor.locator),
    consumedPaymentAuthorization: {
      jobId: JOB_ID,
      phaseIndex: 2,
      agreementHash: agreementRef.contentHash,
      listingRef: listingPin,
      railId: "x402:default",
      railRegistryVersion: 7,
      commitment: {
        ref: `commitment:${JOB_ID}`,
        contentHash: commitmentRef.contentHash,
        finalizedAt: NOW - 11_000,
        signer: SELLER,
      },
      settlementIdentity: {
        kind: "evm",
        chainId: 8453,
        txHash: `0x${"2".repeat(64)}`,
        logIndex: 0,
        includedAt: NOW - 4_500,
      },
      settlementId: `evm:8453:${"2".repeat(64)}:0`,
      evidenceHash: sha256Hex(canonicalize(paymentEvidenceInput)),
      evidenceInput: structuredClone(paymentEvidenceInput),
      payoutBindingTier: 1,
      sessionBinding: "established",
      ...(attested
        ? {
            payloadVerificationProducerAdmission: {
              operation: "produce" as const,
              disposition: "supported" as const,
              listingRef: listingPin,
              verificationMethodKind: verificationMethod!.kind,
              verificationMethodHash: sha256Hex(
                canonicalize(
                  verificationMethod as unknown as Record<string, unknown>,
                ),
              ),
              deliverableSpecHash: sha256Hex(
                canonicalize(deliverable as unknown as Record<string, unknown>),
              ),
              admittedAt: NOW - 13_000,
            },
          }
        : {}),
    },
    bundleContribution: {
      phaseSummary: {
        index: deliveryIndex,
        kind: deliveryEvidence.phase,
        outcome: "ok",
        attestationRef: deliveryRef,
      },
      settlementEvidence: deliveryRef,
    },
  };
  const agreement: SellerFulfilmentAgreement = {
    artifactKind: "payee-bound",
    ref: `agreement:${JOB_ID}`,
    contentHash: agreementRef.contentHash,
    jobId: JOB_ID,
    listingPin,
    buyer: {
      primaryClaim: BUYER,
      bundleHash: "b".repeat(64),
      vetRecordRef: buyerVetRef,
    },
    seller: {
      primaryClaim: SELLER,
      bundleHash: sellerSessionBundleHash,
      vetRecordRef: sellerVetRef,
    },
    deliverableRef: {
      deliverableType: deliverable.kind,
      hash: sha256Hex(
        canonicalize(deliverable as unknown as Record<string, unknown>),
      ),
    },
    commitment: {
      status: "finalized",
      ref: `commitment:${JOB_ID}`,
      agreementHash: agreementRef.contentHash,
      recordContentHash: commitmentRef.contentHash,
      finalizedAt: NOW - 11_000,
      signer: SELLER,
    },
  };

  const buyerSign = vi.fn((bytes: Uint8Array) =>
    ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED)),
  );
  const sellerSign = vi.fn((bytes: Uint8Array) =>
    ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
  );
  const bindingSign = vi.fn((bytes: Uint8Array) =>
    ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
  );
  const input: FinalizeCompletedSellerBundleInput = {
    agreement,
    agreementRef,
    fulfilment,
    session: {
      recordVersion: "1",
      jobId: agreement.jobId,
      state: "audit-pending",
      listingRef: listingPin,
      parties: [
        {
          role: "buyer",
          bundleHash: agreement.buyer.bundleHash,
          primaryClaim: BUYER,
          vetRecordRef: buyerVetRef,
        },
        {
          role: "seller",
          bundleHash: agreement.seller.bundleHash,
          primaryClaim: SELLER,
          vetRecordRef: sellerVetRef,
        },
      ],
      pipeline,
      phaseResults: [
        {
          index: 0,
          step: pipeline[0]!,
          invokedAt: NOW - 12_000,
          result: {
            ok: true,
            contextDelta: procurement
              ? {
                  "negotiate-sealed-envelope-procurement": {
                    agreementHash: agreementRef.contentHash,
                    agreementRef,
                    winningBidderClaim: SELLER,
                    revealedBidRefs: [],
                    losingBidderClaims: [],
                  },
                }
              : {
                  "negotiate-fixed-price": {
                    agreementHash: agreementRef.contentHash,
                    agreementRef,
                  },
                },
          },
          contextDelta: procurement
            ? {
                "negotiate-sealed-envelope-procurement": {
                  agreementHash: agreementRef.contentHash,
                  agreementRef,
                  winningBidderClaim: SELLER,
                  revealedBidRefs: [],
                  losingBidderClaims: [],
                },
              }
            : {
                "negotiate-fixed-price": {
                  agreementHash: agreementRef.contentHash,
                  agreementRef,
                },
              },
        },
        {
          index: 1,
          step: pipeline[1]!,
          invokedAt: NOW - 10_000,
          result: { ok: true, attestationRef: commitmentRef, contextDelta: {} },
          contextDelta: {},
        },
        {
          index: 2,
          step: pipeline[2]!,
          invokedAt: NOW - 5_000,
          result: {
            ok: true,
            txRefs: structuredClone(paymentEvidenceInput.paymentTxRefs),
            attestationRef: paymentRef,
            contextDelta: {},
          },
          contextDelta: {},
        },
        {
          ...(repeatedPaymentRef
            ? {
                index: 3,
                step: pipeline[3]!,
                invokedAt: NOW - 3_500,
                result: {
                  ok: true,
                  txRefs: structuredClone(
                    repeatedPaymentEvidenceInput!.paymentTxRefs,
                  ),
                  attestationRef: repeatedPaymentRef,
                  contextDelta: {},
                },
                contextDelta: {},
              }
            : {
                index: deliveryIndex,
                step: pipeline[deliveryIndex]!,
                invokedAt: NOW - 3_000,
                result: {
                  ok: true,
                  ...(!repeatDelivery ? { attestationRef: deliveryRef } : {}),
                  contextDelta: {},
                },
                contextDelta: {},
              }),
        },
        ...(repeatedPaymentRef
          ? [{
              index: deliveryIndex,
              step: pipeline[deliveryIndex]!,
              invokedAt: NOW - 3_000,
              result: {
                ok: true,
                ...(!repeatDelivery ? { attestationRef: deliveryRef } : {}),
                contextDelta: {},
              },
              contextDelta: {},
            }]
          : []),
        ...(repeatDelivery
          ? [{
              index: repeatedDeliveryIndex,
              step: pipeline[repeatedDeliveryIndex]!,
              invokedAt: NOW - 2_750,
              result: { ok: true, contextDelta: {} },
              contextDelta: {},
            }]
          : []),
        ...(includeDeclinedRate
          ? [
              {
                step: pipeline[rateIndex]!,
                index: rateIndex,
                invokedAt: NOW - 2_500,
                result: {
                  ok: false,
                  reason: "buyer declined to rate",
                  errorClass: "counterparty" as const,
                  contextDelta: {},
                },
                contextDelta: {},
              },
            ]
          : []),
      ],
      startedAt: NOW - 20_000,
      lastUpdatedAt: NOW - 2_000,
      recipeRegistryVersion: 4,
      railRegistryVersion: 7,
    },
    sessionArtifacts: {
      agreementCommitment: commitmentRef,
      vetRecords: [buyerVetRef, sellerVetRef],
      vetRequirements: [
        {
          vetRecordRef: buyerVetRef,
          evaluatedParty: BUYER,
          requirement: buyerVetRequirement,
          verifier: SELLER,
          freshness: [],
          dealSpecific: [
            {
              ref: buyerVerifyRef,
              scheme: "did",
              identifier: BUYER.slice("did:".length),
              method: "self-signed",
              requirement: buyerVetRequirement.required[0]!,
            },
          ],
        },
        {
          vetRecordRef: sellerVetRef,
          evaluatedParty: SELLER,
          requirement: sellerVetRequirement,
          verifier: SELLER,
          freshness: [],
          dealSpecific: [
            {
              ref: sellerVerifyRef,
              scheme: "did",
              identifier: SELLER.slice("did:".length),
              method: "self-signed",
              requirement: sellerVetRequirement.required[0]!,
            },
          ],
        },
      ],
      settlementEvidence: [
        paymentRef,
        ...(repeatedPaymentRef ? [repeatedPaymentRef] : []),
        deliveryRef,
        ...(repeatedDeliveryRef ? [repeatedDeliveryRef] : []),
      ],
    },
    finalisedAt: NOW,
    seller: {
      primaryClaim: SELLER,
      bundleHash: agreement.seller.bundleHash,
      signer: sellerSign,
    },
    counterSignatures: [],
    dependencies: [],
    bindingSigner: {
      algorithm: "ed25519",
      signer: SELLER,
      sign: bindingSign,
    },
  };

  const artifacts = new Map<
    string,
    { artifact?: Record<string, unknown>; bytes?: Uint8Array }
  >([
    [listingHash, { artifact: listingArtifact as unknown as Record<string, unknown> }],
    [agreementRef.contentHash, { artifact: agreementArtifact as unknown as Record<string, unknown> }],
    [commitmentRef.contentHash, { artifact: commitmentArtifact as unknown as Record<string, unknown> }],
    [paymentRef.contentHash, { artifact: paymentArtifact as unknown as Record<string, unknown> }],
    ...(interimPaymentRef && interimPaymentArtifact
      ? [[
          interimPaymentRef.contentHash,
          { artifact: interimPaymentArtifact as unknown as Record<string, unknown> },
        ] as const]
      : []),
    ...(repeatedPaymentRef && repeatedPaymentArtifact
      ? [[
          repeatedPaymentRef.contentHash,
          { artifact: repeatedPaymentArtifact as unknown as Record<string, unknown> },
        ] as const]
      : []),
    [deliveryRef.contentHash, { artifact: deliveryEvidence as unknown as Record<string, unknown> }],
    ...(repeatedDeliveryRef && repeatedDeliveryEvidence
      ? [[
          repeatedDeliveryRef.contentHash,
          { artifact: repeatedDeliveryEvidence as unknown as Record<string, unknown> },
        ] as const]
      : []),
    [buyerVetRef.contentHash, { artifact: buyerVet as unknown as Record<string, unknown> }],
    [sellerVetRef.contentHash, { artifact: sellerVet as unknown as Record<string, unknown> }],
    [
      buyerVerifyAttestationRef.contentHash,
      { artifact: buyerVerifyResult as unknown as Record<string, unknown> },
    ],
    [
      sellerVerifyAttestationRef.contentHash,
      { artifact: sellerVerifyResult as unknown as Record<string, unknown> },
    ],
    [buyerAuthorityRef.contentHash, { artifact: buyerAuthority }],
    [sellerAuthorityRef.contentHash, { artifact: sellerAuthority }],
    [
      deliveryEvidence.deliverableContentHash,
      attested
        ? { bytes: deliveryBytes }
        : { artifact: deliveryPayload as Record<string, unknown> },
    ],
    [payloadAttestationRef.contentHash, { artifact: payloadAttestation }],
    [methodEvidenceRef.contentHash, { artifact: methodEvidence }],
  ]);
  const dependency = (
    source: SellerBundleDependencySource,
    hash: string,
    logicalAddress?: string,
  ) => ({
    source,
    anchorReceipt: receipt(hash, logicalAddress),
  });
  input.dependencies = [
    dependency(
      { kind: "listing", listingRef: listingPin },
      listingHash,
      listingAddress(listingPublisher, listingPin.listingId, listingPin.version),
    ),
    ...[
      agreementRef,
      commitmentRef,
      paymentRef,
      ...(repeatedPaymentRef ? [repeatedPaymentRef] : []),
      ...(interimPaymentRef ? [interimPaymentRef] : []),
      deliveryRef,
      ...(repeatedDeliveryRef ? [repeatedDeliveryRef] : []),
      buyerVetRef,
      sellerVetRef,
      buyerVerifyAttestationRef,
      sellerVerifyAttestationRef,
      buyerAuthorityRef,
      sellerAuthorityRef,
      ...(attested ? [payloadAttestationRef, methodEvidenceRef] : []),
    ].map((artifactRef) =>
      dependency(
        { kind: "attestation-ref", ref: artifactRef },
        artifactRef.contentHash,
        artifactRef.anchor.locator,
      ),
    ),
    dependency(
      {
        kind: "deliverable",
        anchor: deliveryEvidence.deliverableAnchor,
        contentHash: deliveryEvidence.deliverableContentHash,
        encoding: attested ? "bytes" : "jcs",
      },
      deliveryEvidence.deliverableContentHash,
      deliveryEvidence.deliverableAnchor.locator,
    ),
  ];
  const commitmentDependency = input.dependencies.find(
    (candidate) =>
      candidate.source.kind === "attestation-ref" &&
      candidate.source.ref.contentHash === commitmentRef.contentHash,
  )!;
  commitmentDependency.anchorReceipt.blockRef!.timestamp =
    agreement.commitment.finalizedAt;
  const request = prepareCompletedSellerBundleCounterSignatureRequest(input);
  input.counterSignatures = [
    {
      party: BUYER,
      algorithm: "ed25519",
      value: Buffer.from(buyerSign(request.signedBytes)).toString("base64url"),
    },
  ];

  const state: {
    anchored?: AnchoredSellerBundle;
    binding?: BundleBinding;
  } = {};
  const anchor = (logicalAddress: string, bundle: FaultAttestationBundle): void => {
    const hash = attestationBundleHash(bundle);
    const nativeAddress = `stor-${"7".repeat(40)}`;
    state.anchored = {
      bundle,
      nativeAddress,
      anchorTx: "test:bundle-anchor-tx",
      anchorReceipt: receipt(hash, logicalAddress, nativeAddress, SELLER),
    };
  };

  const provider: SellerBundleFinalizationProvider = {
    mapping,
    bundleCopyVerifier: {
      resolvePublicKey: async (claim) =>
        claim === BUYER
          ? rawPublicKey(publicKeyFromSeed(BUYER_SEED))
          : claim === SELLER
            ? rawPublicKey(publicKeyFromSeed(SELLER_SEED))
            : null,
      verify: async (message, signature, key) =>
        ed25519Verify(message, signature, publicKeyFromRaw(key)),
    },
    compositeVerificationDeps: {
      resolveRecipe: vi.fn(async (selector, registryVersion) =>
        registryVersion === 4 &&
        selector.scheme === "did" &&
        selector.method === "self-signed" &&
        selector.recipeVersion === 1
          ? verificationRecipe
          : null,
      ),
      isRecipeSignerAuthorized: (_recipe, signature) =>
        signature.signer === SELLER,
      isVerifyResultSignerAuthorized: (_result, signature) =>
        signature.signer === SELLER,
      resolvePublicKey: async (signature) =>
        signature.signer === SELLER && signature.algorithm === "ed25519"
          ? rawPublicKey(publicKeyFromSeed(SELLER_SEED))
          : null,
      verify: ({ signedBytes: payload, signature, publicKey }) =>
        ed25519Verify(
          payload,
          Uint8Array.from(Buffer.from(signature.value, "base64url")),
          publicKeyFromRaw(publicKey),
        ),
      verifyAuthorityAttestation: ({ expected, content }) =>
        content.encoding === "canonical-json" &&
        content.value.claim === `did:${expected.identifier}` &&
        content.value.decision === "pass"
          ? "valid" as const
          : "invalid" as const,
      verifyRequirementParameters: () => true,
    },
    resolveDependency: vi.fn((dependency) => {
      const resolved = artifacts.get(dependency.anchorReceipt.contentHash);
      return resolved?.bytes
        ? { disposition: "present" as const, bytes: resolved.bytes }
        : { disposition: "present" as const, artifact: resolved?.artifact };
    }),
    verifyDependencyReceipt: vi.fn(() => "valid" as const),
    verifyDependencyBinding: vi.fn(() => "valid" as const),
    verifyListingPublisherIdentityLinkage: vi.fn(() => "valid" as const),
    verifyVetRequirementProvenance: vi.fn(() => "valid" as const),
    resolvePaymentPhaseIndex: vi.fn(({ dependency, evidence }) => ({
      disposition: "valid" as const,
      jobId: String(evidence.jobId),
      railId: "x402:default",
      phaseIndex:
        repeatedPaymentRef &&
        dependency.source.kind === "attestation-ref" &&
        dependency.source.ref.contentHash === repeatedPaymentRef.contentHash
          ? 3
          : 2,
      resolved: evidence.supersedesEvidenceRef !== undefined,
    })),
    verifyPayloadMethodProof: vi.fn((verification) => {
      const method = verification.methodEvidence as Record<string, unknown>;
      return method.payloadContentHash === sha256Hex(verification.deliveredPayload)
        ? "valid" as const
        : "invalid" as const;
    }),
    resolveSellerBundle: vi.fn(() =>
      state.anchored
        ? { disposition: "present" as const, anchored: state.anchored }
        : { disposition: "absent" as const },
    ),
    submitSellerBundle: vi.fn((logicalAddress, bundle) => anchor(logicalAddress, bundle)),
    verifyBundleAnchorReceipt: vi.fn(() => "valid" as const),
    resolveBundleBinding: vi.fn(() =>
      state.binding
        ? { disposition: "present" as const, binding: state.binding }
        : { disposition: "absent" as const },
    ),
    publishBundleBinding: vi.fn((binding) => {
      state.binding = binding;
      return { disposition: "published" as const };
    }),
    verifyBundleBinding: vi.fn((binding) =>
      bindingSignatureVerifies(binding) ? "valid" as const : "invalid" as const,
    ),
  };
  return {
    input,
    provider,
    state,
    anchor,
    buyerSign,
    sellerSign,
    bindingSign,
    sellerIdentityHash,
    sellerSessionBundleHash,
    listingPublisher,
    paymentEvidenceInput,
    repeatedPaymentEvidenceInput,
    paymentRef,
    repeatedPaymentRef,
  };
}

function bindConsumedAuthorizationToRepeatedPayment(
  f: ReturnType<typeof fixture>,
): void {
  const evidenceInput = structuredClone(f.repeatedPaymentEvidenceInput!);
  const authorization = f.input.fulfilment.consumedPaymentAuthorization;
  authorization.phaseIndex = 3;
  authorization.evidenceInput = evidenceInput;
  authorization.evidenceHash = f.repeatedPaymentRef!.contentHash;
  f.input.fulfilment.fulfilmentId = sellerFulfilmentId({
    jobId: authorization.jobId,
    paymentPhaseIndex: authorization.phaseIndex,
    deliveryPhaseIndex: f.input.fulfilment.bundleContribution.phaseSummary.index,
    settlementId: authorization.settlementId,
    agreementHash: authorization.agreementHash,
    paymentEvidenceHash: authorization.evidenceHash,
  });
}

function mutateResolvedArtifact(
  f: ReturnType<typeof fixture>,
  targetHash: string,
  mutate: (artifact: Record<string, unknown>) => Record<string, unknown>,
): void {
  const resolve = f.provider.resolveDependency.bind(f.provider);
  f.provider.resolveDependency = vi.fn(async (dependency, requirement) => {
    const lookup = await resolve(dependency, requirement);
    if (
      dependency.anchorReceipt.contentHash !== targetHash ||
      lookup.disposition !== "present" ||
      lookup.artifact === undefined
    ) {
      return lookup;
    }
    return {
      disposition: "present" as const,
      artifact: mutate(
        structuredClone(lookup.artifact as Record<string, unknown>),
      ),
    };
  });
}

function counterSignatureVerificationInput(
  f: ReturnType<typeof fixture>,
): VerifyCompletedSellerBundleCounterSignatureRequestInput {
  const {
    seller,
    counterSignatures: _counterSignatures,
    bindingSigner: _bindingSigner,
    ...data
  } = f.input;
  return {
    ...data,
    seller: {
      primaryClaim: seller.primaryClaim,
      bundleHash: seller.bundleHash,
    },
  };
}

describe("DACS-5 ST-11 seller completed-bundle finalization", () => {
  test("exports one transport-neutral signed scope and ingests only buyer-produced signatures", () => {
    const f = fixture();
    const request = prepareCompletedSellerBundleCounterSignatureRequest(f.input);

    expect(request.requiredCounterSigners).toEqual([BUYER]);
    expect(request.bundleContentHash).toBe(
      sha256Hex(canonicalize(request.signedScope)),
    );
    expect(Buffer.from(request.signedBytes).subarray(0, 21).toString()).toBe(
      ARTIFACT_SEPARATORS.FaultAttestationBundle,
    );
    expect("buyer" in f.input).toBe(false);
  });

  test("rejects an operational agreement whose Vet references differ from the session", () => {
    const f = fixture();
    f.input.agreement.buyer.vetRecordRef = structuredClone(
      f.input.agreement.seller.vetRecordRef,
    );

    expect(() => prepareCompletedSellerBundleCounterSignatureRequest(f.input)).toThrow(
      /SessionRecord\/signing parties do not match the verified agreement/,
    );
  });

  test("binds the consumed authorization to the authenticated commitment signer", async () => {
    const f = fixture();
    f.input.fulfilment.consumedPaymentAuthorization.commitment.signer = OUTSIDER;

    await expect(
      finalizeCompletedSellerBundleCore(f.input, f.provider),
    ).rejects.toThrow(/consumed payment authorization does not bind the exact agreement/);
  });

  test("binds the operational commitment signer to the resolved finality record", async () => {
    const f = fixture();
    f.input.agreement.commitment.signer = OUTSIDER;
    f.input.fulfilment.consumedPaymentAuthorization.commitment.signer = OUTSIDER;

    await expect(
      finalizeCompletedSellerBundleCore(f.input, f.provider),
    ).rejects.toThrow(/agreement commitment fails CA-3\/CA-7\/CA-8 session binding/);
  });

  test("independently authenticates the current counter-sign request without any signing capability", async () => {
    const f = fixture();
    const request = prepareCompletedSellerBundleCounterSignatureRequest(f.input);
    const verified = await verifyCompletedSellerBundleCounterSignatureRequest(
      counterSignatureVerificationInput(f),
      request,
      f.provider,
    );

    expect(verified).toEqual(request);
    expect(verified).not.toBe(request);
    expect(verified.signedScope).not.toBe(request.signedScope);
    expect(verified.signedBytes).not.toBe(request.signedBytes);
    expect(verified.requiredCounterSigners).not.toBe(
      request.requiredCounterSigners,
    );
    expect(f.sellerSign).not.toHaveBeenCalled();
    expect(f.bindingSign).not.toHaveBeenCalled();
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
    expect(f.provider.publishBundleBinding).not.toHaveBeenCalled();
  });

  test.each<[
    string,
    (request: CompletedSellerBundleCounterSignatureRequest) => void,
  ]>([
    ["bundle hash", (request) => {
      request.bundleContentHash = "0".repeat(64);
    }],
    ["signed scope", (request) => {
      request.signedScope.jobId = "substituted-job";
    }],
    ["signed bytes", (request) => {
      const last = request.signedBytes.length - 1;
      request.signedBytes[last] = request.signedBytes[last]! ^ 1;
    }],
    ["required signer", (request) => {
      request.requiredCounterSigners = [OUTSIDER];
    }],
  ])("rejects a substituted counter-sign request %s", async (_name, mutate) => {
    const f = fixture();
    const request = structuredClone(
      prepareCompletedSellerBundleCounterSignatureRequest(f.input),
    );
    mutate(request);

    await expect(
      verifyCompletedSellerBundleCounterSignatureRequest(
        counterSignatureVerificationInput(f),
        request,
        f.provider,
      ),
    ).rejects.toThrow(/authenticated buyer signer|does not exactly match/);
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("requires the complete current dependency closure before approving review bytes", async () => {
    const f = fixture();
    const request = prepareCompletedSellerBundleCounterSignatureRequest(f.input);
    const input = counterSignatureVerificationInput(f);
    input.dependencies = input.dependencies.filter(
      (dependency) => dependency.source.kind !== "listing",
    );

    await expect(
      verifyCompletedSellerBundleCounterSignatureRequest(
        input,
        request,
        f.provider,
      ),
    ).rejects.toThrow(/is missing|exactly one supplied dependency|exactly cover/);
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("rejects stale Listing content and unauthenticated Listing/session identities", async () => {
    const staleListing = fixture();
    const staleListingRequest =
      prepareCompletedSellerBundleCounterSignatureRequest(staleListing.input);
    const listingDependency = staleListing.input.dependencies.find(
      (dependency) => dependency.source.kind === "listing",
    )!;
    mutateResolvedArtifact(
      staleListing,
      listingDependency.anchorReceipt.contentHash,
      (listing) => ({
        ...listing,
        listingVersion: Number(listing.listingVersion) + 1,
      }),
    );
    await expect(
      verifyCompletedSellerBundleCounterSignatureRequest(
        counterSignatureVerificationInput(staleListing),
        staleListingRequest,
        staleListing.provider,
      ),
    ).rejects.toThrow(/different canonical content hash|canonical negotiation\/session/);

    const staleIdentity = fixture();
    const staleIdentityRequest =
      prepareCompletedSellerBundleCounterSignatureRequest(staleIdentity.input);
    staleIdentity.provider.verifyListingPublisherIdentityLinkage = vi.fn(
      () => "invalid" as const,
    );
    await expect(
      verifyCompletedSellerBundleCounterSignatureRequest(
        counterSignatureVerificationInput(staleIdentity),
        staleIdentityRequest,
        staleIdentity.provider,
      ),
    ).rejects.toThrow(/IdentityBundle claim and key linkage is invalid/);
  });

  test("rejects accessors, exotic scope objects, aliased byte views, and live seller capabilities", async () => {
    const accessorFixture = fixture();
    const ordinaryRequest =
      prepareCompletedSellerBundleCounterSignatureRequest(accessorFixture.input);
    let getterInvoked = false;
    const accessorRequest = {
      bundleContentHash: ordinaryRequest.bundleContentHash,
      signedBytes: ordinaryRequest.signedBytes,
      requiredCounterSigners: ordinaryRequest.requiredCounterSigners,
    } as Record<string, unknown>;
    Object.defineProperty(accessorRequest, "signedScope", {
      enumerable: true,
      get: () => {
        getterInvoked = true;
        return ordinaryRequest.signedScope;
      },
    });
    await expect(
      verifyCompletedSellerBundleCounterSignatureRequest(
        counterSignatureVerificationInput(accessorFixture),
        accessorRequest,
        accessorFixture.provider,
      ),
    ).rejects.toThrow(/non-canonical data-only shape/);
    expect(getterInvoked).toBe(false);

    const exoticFixture = fixture();
    const exoticRequest = structuredClone(
      prepareCompletedSellerBundleCounterSignatureRequest(exoticFixture.input),
    );
    Object.setPrototypeOf(exoticRequest.signedScope, { live: true });
    await expect(
      verifyCompletedSellerBundleCounterSignatureRequest(
        counterSignatureVerificationInput(exoticFixture),
        exoticRequest,
        exoticFixture.provider,
      ),
    ).rejects.toThrow(/non-canonical data-only shape/);

    const aliasedFixture = fixture();
    const aliasedRequest = structuredClone(
      prepareCompletedSellerBundleCounterSignatureRequest(aliasedFixture.input),
    );
    const backing = new Uint8Array(aliasedRequest.signedBytes.length + 2);
    backing.set(aliasedRequest.signedBytes, 1);
    aliasedRequest.signedBytes = backing.subarray(1, -1);
    await expect(
      verifyCompletedSellerBundleCounterSignatureRequest(
        counterSignatureVerificationInput(aliasedFixture),
        aliasedRequest,
        aliasedFixture.provider,
      ),
    ).rejects.toThrow(/non-canonical data-only shape/);

    const liveSellerFixture = fixture();
    const liveSellerRequest =
      prepareCompletedSellerBundleCounterSignatureRequest(liveSellerFixture.input);
    const liveInput = counterSignatureVerificationInput(liveSellerFixture) as
      VerifyCompletedSellerBundleCounterSignatureRequestInput & {
        seller: { signer?: () => never };
      };
    liveInput.seller.signer = () => {
      throw new Error("must not be callable");
    };
    await expect(
      verifyCompletedSellerBundleCounterSignatureRequest(
        liveInput,
        liveSellerRequest,
        liveSellerFixture.provider,
      ),
    ).rejects.toThrow(/canonical data only|live seller signer/);
  });

  test("captures provider, session, dependencies, and request once and returns an isolated copy", async () => {
    const f = fixture();
    const input = counterSignatureVerificationInput(f);
    const request = prepareCompletedSellerBundleCounterSignatureRequest(f.input);
    const expected = structuredClone(request);
    const ordinaryResolve = f.provider.resolveDependency.bind(f.provider);
    let releaseFirstResolution!: () => void;
    const firstResolutionGate = new Promise<void>((resolve) => {
      releaseFirstResolution = resolve;
    });
    let first = true;
    f.provider.resolveDependency = vi.fn(async (dependency, requirement) => {
      if (first) {
        first = false;
        await firstResolutionGate;
      }
      return ordinaryResolve(dependency, requirement);
    });

    const pending = verifyCompletedSellerBundleCounterSignatureRequest(
      input,
      request,
      f.provider,
    );
    request.signedScope.jobId = "mutated-after-capture";
    request.requiredCounterSigners[0] = OUTSIDER;
    request.signedBytes.fill(0);
    input.session.jobId = "mutated-after-capture";
    input.dependencies.length = 0;
    f.provider.resolveDependency = vi.fn(() => ({
      disposition: "absent" as const,
    }));
    releaseFirstResolution();

    const verified = await pending;
    expect(verified).toEqual(expected);
    verified.signedScope.jobId = "mutated-return";
    verified.requiredCounterSigners[0] = OUTSIDER;
    verified.signedBytes.fill(0);
    expect(expected.signedScope.jobId).toBe(JOB_ID);
    expect(expected.requiredCounterSigners).toEqual([BUYER]);
    expect(expected.signedBytes.some((byte) => byte !== 0)).toBe(true);
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("does not invent a third bundle party when the seller is also the orchestrator", async () => {
    const f = fixture();
    f.input.session.parties.push({
      role: "orchestrator",
      primaryClaim: SELLER,
      bundleHash: f.input.agreement.seller.bundleHash,
    });

    const request = prepareCompletedSellerBundleCounterSignatureRequest(f.input);
    expect(request.requiredCounterSigners).toEqual([BUYER]);

    const result = await finalizeCompletedSellerBundleCore(f.input, f.provider);
    expect(result.sellerBundle.parties.map((party) => party.role)).toEqual([
      "buyer",
      "seller",
    ]);
    expect(result.orchestratorBundle).toBeUndefined();
  });

  test("audits every dependency, co-signs both copies, and finalizes only the seller copy", async () => {
    const f = fixture();
    const result = await finalizeCompletedSellerBundleCore(f.input, f.provider);

    expect(result).toMatchObject({
      state: "finalised",
      logicalAddress: bundleAddress(JOB_ID, "seller"),
      nativeAddress: `stor-${"7".repeat(40)}`,
      resumedBundle: false,
      resumedBinding: false,
      sellerBundle: { anchoredByRole: "seller", outcome: "completed", faultedParty: "none" },
      buyerBundle: { anchoredByRole: "buyer", outcome: "completed", faultedParty: "none" },
    });
    expect(result.binding).toBeUndefined();
    expect(result.sellerBundle.phaseSummary.map((phase) => phase.index)).toEqual([0, 1, 2, 3]);
    expect(result.sellerBundle.settlementEvidence).toHaveLength(2);
    expect(attestationBundleHash(result.sellerBundle)).toBe(
      attestationBundleHash(result.buyerBundle),
    );
    expect(f.provider.verifyDependencyReceipt).toHaveBeenCalledTimes(12);
    expect(f.provider.resolveDependency).toHaveBeenCalledTimes(12);
    expect(
      f.provider.compositeVerificationDeps.resolveRecipe,
    ).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(f.provider.compositeVerificationDeps.resolveRecipe).mock.calls
        .map(([, registryVersion]) => registryVersion),
    ).toEqual([4, 4]);
    expect(f.provider.submitSellerBundle).toHaveBeenCalledOnce();
    expect(f.provider.resolveBundleBinding).not.toHaveBeenCalled();
    expect(f.provider.publishBundleBinding).not.toHaveBeenCalled();
    expect(f.buyerSign).toHaveBeenCalled();
    expect(f.sellerSign).toHaveBeenCalled();
  });

  test("advances an included fulfilment handoff receipt to the same finalized publication", async () => {
    const f = fixture();
    f.input.fulfilment.evidenceAnchorReceipt = {
      ...f.input.fulfilment.evidenceAnchorReceipt,
      state: "included",
      observedAt: NOW - 1_750,
      evidence: {
        kind: "test-inclusion",
        value: "proof-included-before-finality",
      },
      blockRef: {
        id: "block-included-before-finality",
        timestamp: NOW - 1_750,
      },
    };

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).resolves.toMatchObject({
      state: "finalised",
    });
  });

  test("rejects a handoff receipt that has not reached authenticated inclusion", async () => {
    const f = fixture();
    f.input.fulfilment.evidenceAnchorReceipt.state = "accepted";

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /seller fulfilment is not the exact delivery PhaseEntry/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("rejects a terminal contribution that points away from its exact evidence", async () => {
    const f = fixture();
    f.input.fulfilment.bundleContribution.phaseSummary.attestationRef =
      structuredClone(f.paymentRef);

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /seller fulfilment is not the exact delivery PhaseEntry/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("rejects a handoff evidence signature that differs from the resolved artifact", async () => {
    const f = fixture();
    f.input.fulfilment.evidence.signature.value =
      Buffer.alloc(64, 98).toString("base64url");

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /resolved fulfilment evidence differs from the exact durable handoff artifact/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("accepts a nonce-distinct post-Vet publisher bundle only through authenticated claim/key linkage", async () => {
    const f = fixture();
    expect(f.sellerIdentityHash).not.toBe(f.sellerSessionBundleHash);

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).resolves.toMatchObject({
      state: "finalised",
    });
    expect(f.provider.verifyListingPublisherIdentityLinkage).toHaveBeenCalledWith({
      listingIdentity: expect.objectContaining({ presentedBy: SELLER }),
      listingBundleHash: f.sellerIdentityHash,
      sessionBundleHash: f.sellerSessionBundleHash,
      primaryClaim: SELLER,
    });
  });

  test("fails closed when the Listing/session primary-claim key linkage is invalid", async () => {
    const f = fixture();
    f.provider.verifyListingPublisherIdentityLinkage = vi.fn(() => "invalid" as const);

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /IdentityBundle claim and key linkage is invalid/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("maps a procurement Listing publisher to agreement buyer and winning supplier to seller", async () => {
    const f = fixture("pure", "storage", false, false, false, {
      procurement: true,
    });

    const result = await finalizeCompletedSellerBundleCore(f.input, f.provider);
    expect(result.sellerBundle.parties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "buyer", primaryClaim: BUYER }),
        expect.objectContaining({ role: "seller", primaryClaim: SELLER }),
      ]),
    );
    expect(f.provider.verifyListingPublisherIdentityLinkage).toHaveBeenCalledWith(
      expect.objectContaining({ primaryClaim: BUYER, sessionBundleHash: "b".repeat(64) }),
    );
    expect(f.provider.verifyVetRequirementProvenance).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({ evaluatedParty: BUYER }),
        listingOwned: false,
      }),
    );
    expect(f.provider.verifyVetRequirementProvenance).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({ evaluatedParty: SELLER }),
        listingOwned: true,
      }),
    );
  });

  test("rejects an inverted procurement Listing publisher", async () => {
    const f = fixture("pure", "storage", false, false, false, {
      procurement: true,
      listingPublisherOverride: SELLER,
    });

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /canonical negotiation\/session/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("rejects procurement context naming the publisher rather than the winning supplier", async () => {
    const f = fixture("pure", "storage", false, false, false, {
      procurement: true,
    });
    const phase = f.input.session.phaseResults[0]!;
    for (const delta of [phase.contextDelta, phase.result.contextDelta!]) {
      const result = delta["negotiate-sealed-envelope-procurement"] as Record<string, unknown>;
      result.winningBidderClaim = BUYER;
    }

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /winner\/role binding/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("rejects a procurement Listing receipt addressed under the agreement seller", async () => {
    const f = fixture("pure", "storage", false, false, false, {
      procurement: true,
    });
    const listingDependency = f.input.dependencies.find(
      (dependency) => dependency.source.kind === "listing",
    )!;
    listingDependency.anchorReceipt.logicalAddress = listingAddress(
      SELLER,
      f.input.session.listingRef.listingId,
      f.input.session.listingRef.version,
    );

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /different logical address/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("rejects a forged detached buyer signature before anchoring", async () => {
    const f = fixture();
    f.input.counterSignatures = [
      {
        ...f.input.counterSignatures![0]!,
        value: Buffer.alloc(64, 99).toString("base64url"),
      },
    ];

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /signature verification failed/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("rejects payment evidence bound to a different authenticated phase index", async () => {
    const f = fixture();
    f.provider.resolvePaymentPhaseIndex = vi.fn(() => ({
      disposition: "valid" as const,
      jobId: JOB_ID,
      railId: "x402:default",
      phaseIndex: 3,
      resolved: false,
    }));

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /authenticated job\/rail\/phase\/resolved binding|authenticated phase index/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("rejects a consumed payment authorization rebound to another agreement", async () => {
    const f = fixture();
    f.input.fulfilment.consumedPaymentAuthorization.agreementHash = "f".repeat(64);

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /consumed payment authorization does not bind the exact agreement/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("rejects a missing consumed payment authorization", async () => {
    const f = fixture();
    delete (
      f.input.fulfilment as unknown as {
        consumedPaymentAuthorization?: unknown;
      }
    ).consumedPaymentAuthorization;

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /exact valid consumed payment authorization/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("rejects a fulfilment envelope with a non-derived identifier", async () => {
    const f = fixture();
    f.input.fulfilment.fulfilmentId = "f".repeat(64);

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /seller fulfilment is not the exact delivery PhaseEntry/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("requires the consumed payment phase to retain its exact rail txRefs", async () => {
    const f = fixture();
    delete f.input.session.phaseResults[2]!.result.txRefs;

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /consumed payment authorization does not bind the exact agreement/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("rejects a validly shaped consumed authorization without exact signed payment evidence", async () => {
    const f = fixture();
    f.input.fulfilment.consumedPaymentAuthorization.evidenceInput.paymentAmount.amount = "3";
    f.input.fulfilment.consumedPaymentAuthorization.evidenceHash = sha256Hex(
      canonicalize(
        f.input.fulfilment.consumedPaymentAuthorization.evidenceInput,
      ),
    );
    const authorization = f.input.fulfilment.consumedPaymentAuthorization;
    f.input.fulfilment.fulfilmentId = sellerFulfilmentId({
      jobId: authorization.jobId,
      paymentPhaseIndex: authorization.phaseIndex,
      deliveryPhaseIndex: f.input.fulfilment.bundleContribution.phaseSummary.index,
      settlementId: authorization.settlementId,
      agreementHash: authorization.agreementHash,
      paymentEvidenceHash: authorization.evidenceHash,
    });

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /does not bind exactly one authenticated SettlementEvidence payment phase/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("rejects x402 supersession outside the exact consumed-authorization scope", async () => {
    const f = fixture("pure", "storage", false, false, false, {
      resolvedPayment: true,
      repeatedPayment: true,
    });

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /does not bind exactly one authenticated SettlementEvidence payment phase/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("requires attested delivery to retain the exact pre-commit DPA-1 admission", async () => {
    const missing = fixture("pure", "attested");
    delete missing.input.fulfilment.consumedPaymentAuthorization
      .payloadVerificationProducerAdmission;
    await expect(
      finalizeCompletedSellerBundleCore(missing.input, missing.provider),
    ).rejects.toThrow(/exact store-retained pre-commit DPA-1 producer admission/);

    const rebound = fixture("pure", "attested");
    rebound.input.fulfilment.consumedPaymentAuthorization
      .payloadVerificationProducerAdmission!.verificationMethodHash = "f".repeat(64);
    await expect(
      finalizeCompletedSellerBundleCore(rebound.input, rebound.provider),
    ).rejects.toThrow(/exact store-retained pre-commit DPA-1 producer admission/);
  });

  test("forbids DPA-1 producer authority on a non-attested delivery", async () => {
    const f = fixture();
    f.input.fulfilment.consumedPaymentAuthorization
      .payloadVerificationProducerAdmission = {
        operation: "produce",
        disposition: "supported",
        listingRef: structuredClone(f.input.session.listingRef),
        verificationMethodKind: "self-signed",
        verificationMethodHash: "d".repeat(64),
        deliverableSpecHash: "e".repeat(64),
        admittedAt: NOW - 13_000,
      };

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /non-attested delivery cannot carry DPA-1 producer admission authority/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("rejects ST-8 supersession authenticated to another same-kind repeated payment index", async () => {
    const f = fixture("pure", "storage", false, false, false, {
      resolvedPayment: true,
      repeatedPayment: true,
    });
    bindConsumedAuthorizationToRepeatedPayment(f);
    const ordinary = f.provider.resolvePaymentPhaseIndex!;
    f.provider.resolvePaymentPhaseIndex = vi.fn(async (input) => {
      const resolved = await ordinary(input);
      return input.evidence.outcome === "failure" && resolved.disposition === "valid"
        ? { ...resolved, phaseIndex: 3 }
        : resolved;
    });

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /exact job\/rail\/phase tuple/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("requires an exact one-per-Vet requirement inventory", async () => {
    const missing = fixture();
    missing.input.sessionArtifacts.vetRequirements.pop();
    await expect(
      finalizeCompletedSellerBundleCore(missing.input, missing.provider),
    ).rejects.toThrow(/one requirement invocation per Vet record/);

    const duplicate = fixture();
    duplicate.input.sessionArtifacts.vetRequirements[1] = structuredClone(
      duplicate.input.sessionArtifacts.vetRequirements[0]!,
    );
    await expect(
      finalizeCompletedSellerBundleCore(duplicate.input, duplicate.provider),
    ).rejects.toThrow(/malformed or not one-per-record/);
  });

  test("rejects swapped or malformed retained Vet requirements", async () => {
    const swapped = fixture();
    const invocations = swapped.input.sessionArtifacts.vetRequirements;
    const first = invocations[0]!.requirement;
    invocations[0]!.requirement = invocations[1]!.requirement;
    invocations[1]!.requirement = first;
    await expect(
      finalizeCompletedSellerBundleCore(swapped.input, swapped.provider),
    ).rejects.toThrow(/Vet record\/requirement invocation/);

    const malformed = fixture();
    malformed.input.sessionArtifacts.vetRequirements[0]!.requirement.required[0]!.scheme =
      "DID";
    await expect(
      finalizeCompletedSellerBundleCore(malformed.input, malformed.provider),
    ).rejects.toThrow(/requirement invocation inventory is malformed/);
  });

  test.each(["invalid", "indeterminate", "error"] as const)(
    "fails closed when Vet requirement provenance is %s",
    async (disposition) => {
      const f = fixture();
      f.provider.verifyVetRequirementProvenance = vi.fn(() => disposition);

      await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
        /Vet requirement invocation provenance/,
      );
      expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
    },
  );

  test("fails closed when the Vet requirement provenance verifier is unavailable", async () => {
    const f = fixture();
    f.provider.verifyVetRequirementProvenance = undefined as never;

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /Vet requirement provenance verifier is unavailable \(#331\)/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("recomputes DACS-2 aggregation instead of accepting a provider pass assertion", async () => {
    const f = fixture("pure", "storage", false, false, false, {
      sellerVerifyDecision: "fail",
    });

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /strict verification failed \(aggregation-mismatch\)/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("rejects a cryptographically valid composite whose authenticated decision is not pass", async () => {
    const f = fixture("pure", "storage", false, false, false, {
      sellerVerifyDecision: "fail",
      sellerVetDecision: "fail",
    });

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /does not establish a pass decision/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("cryptographically verifies composite and VerifyResult signatures", async () => {
    const badRecord = fixture();
    const recordHash = badRecord.input.sessionArtifacts.vetRecords[0]!.contentHash;
    mutateResolvedArtifact(badRecord, recordHash, (artifact) => ({
      ...artifact,
      signature: {
        ...(artifact.signature as ComponentSignature),
        value: Buffer.alloc(64, 99).toString("base64url"),
      },
    }));
    await expect(
      finalizeCompletedSellerBundleCore(badRecord.input, badRecord.provider),
    ).rejects.toThrow(/strict verification failed \(record-signature\)/);
    expect(badRecord.provider.submitSellerBundle).not.toHaveBeenCalled();

    const badResult = fixture();
    const resultHash = badResult.input.sessionArtifacts.vetRequirements[0]!
      .dealSpecific[0]!.ref.contentHash;
    mutateResolvedArtifact(badResult, resultHash, (artifact) => ({
      ...artifact,
      signature: {
        ...(artifact.signature as ComponentSignature),
        value: Buffer.alloc(64, 98).toString("base64url"),
      },
    }));
    await expect(
      finalizeCompletedSellerBundleCore(badResult.input, badResult.provider),
    ).rejects.toThrow(/strict verification failed \(verify-result-signature\)/);
    expect(badResult.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("binds the exact retained result classification and method-native authority", async () => {
    const substituted = fixture();
    const invocation = substituted.input.sessionArtifacts.vetRequirements[0]!;
    invocation.freshness = invocation.dealSpecific;
    invocation.dealSpecific = [];
    await expect(
      finalizeCompletedSellerBundleCore(substituted.input, substituted.provider),
    ).rejects.toThrow(/strict verification failed \(freshness-substitution\)/);

    const invalidAuthority = fixture();
    invalidAuthority.provider.compositeVerificationDeps.verifyAuthorityAttestation =
      vi.fn(() => "invalid" as const);
    await expect(
      finalizeCompletedSellerBundleCore(
        invalidAuthority.input,
        invalidAuthority.provider,
      ),
    ).rejects.toThrow(/strict verification failed \(authority-signature\)/);
    expect(invalidAuthority.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("fails closed when strict composite verification dependencies are unavailable", async () => {
    const f = fixture();
    f.provider.compositeVerificationDeps = undefined as never;

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /strict CompositeVerificationRecord verifier is unavailable/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("rejects hostile resolver response fields before snapshotting", async () => {
    const f = fixture();
    const targetHash = f.input.sessionArtifacts.vetRecords[0]!.contentHash;
    const resolve = f.provider.resolveDependency.bind(f.provider);
    f.provider.resolveDependency = vi.fn(async (dependency, requirement) => {
      const lookup = await resolve(dependency, requirement);
      if (
        dependency.anchorReceipt.contentHash !== targetHash ||
        lookup.disposition !== "present" ||
        lookup.artifact === undefined
      ) {
        return lookup;
      }
      return {
        disposition: "present" as const,
        artifact: Object.create(lookup.artifact) as Record<string, unknown>,
      };
    });

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /resolved to a non-artifact value/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();

    const hostile = fixture();
    const hostileHash = hostile.input.sessionArtifacts.vetRecords[0]!.contentHash;
    const ordinary = hostile.provider.resolveDependency.bind(hostile.provider);
    const toString = vi.fn(() => "present");
    hostile.provider.resolveDependency = vi.fn(async (dependency, requirement) => {
      const lookup = await ordinary(dependency, requirement);
      if (dependency.anchorReceipt.contentHash !== hostileHash) return lookup;
      return {
        disposition: { toString },
        ...("artifact" in lookup ? { artifact: lookup.artifact } : {}),
      } as never;
    });
    await expect(
      finalizeCompletedSellerBundleCore(hostile.input, hostile.provider),
    ).rejects.toThrow(/invalid disposition/);
    expect(toString).not.toHaveBeenCalled();
  });

  test("rejects residual-pad-bit aliases during detached assembly and resumed validation", async () => {
    const detached = fixture();
    const buyerSignature = detached.input.counterSignatures![0]!;
    const alias = residualPadBitAlias(buyerSignature.value);
    expect(Buffer.from(alias, "base64url")).toEqual(
      Buffer.from(buyerSignature.value, "base64url"),
    );
    buyerSignature.value = alias;
    await expect(
      finalizeCompletedSellerBundleCore(detached.input, detached.provider),
    ).rejects.toThrow(/canonical Base64URL|normative FaultAttestationBundle/);

    const resumed = fixture();
    await finalizeCompletedSellerBundleCore(resumed.input, resumed.provider);
    const stored = resumed.state.anchored!.bundle as FaultAttestationBundle;
    stored.signatures[0]!.value = residualPadBitAlias(stored.signatures[0]!.value);
    expect(isFaultAttestationBundle(stored)).toBe(false);
    await expect(
      finalizeCompletedSellerBundleCore(resumed.input, resumed.provider),
    ).rejects.toThrow(/non-canonical Base64URL/);
  });

  test("returns role copies with no mutable nested aliases on new and resumed flows", async () => {
    const f = fixture();
    const fresh = await finalizeCompletedSellerBundleCore(f.input, f.provider);
    fresh.sellerBundle.parties[0]!.primaryClaim = OUTSIDER;
    fresh.sellerBundle.phaseSummary[0]!.kind = "rate";
    expect(fresh.buyerBundle.parties[0]!.primaryClaim).toBe(BUYER);
    expect(fresh.buyerBundle.phaseSummary[0]!.kind).toBe("negotiate-fixed-price");

    const resumed = await finalizeCompletedSellerBundleCore(f.input, f.provider);
    resumed.buyerBundle.parties[0]!.primaryClaim = OUTSIDER;
    resumed.buyerBundle.phaseSummary[0]!.kind = "rate";
    expect(resumed.sellerBundle.parties[0]!.primaryClaim).toBe(BUYER);
    expect(resumed.sellerBundle.phaseSummary[0]!.kind).toBe("negotiate-fixed-price");
  });

  test("rejects a fixed-price agreement carrying an extra non-party signer", async () => {
    const f = fixture("pure", "storage", false, false, true);

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /resolved agreement|unauthorized or incomplete signer set/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("locally rejects a resumed completed bundle missing the seller signature", async () => {
    const f = fixture();
    await finalizeCompletedSellerBundleCore(f.input, f.provider);
    f.state.anchored!.bundle = {
      ...(f.state.anchored!.bundle as FaultAttestationBundle),
      signatures: (f.state.anchored!.bundle as FaultAttestationBundle).signatures.filter(
        (signature) => signature.party === BUYER,
      ),
    };
    vi.mocked(f.provider.submitSellerBundle).mockClear();

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /exact required party signature set/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("walks the complete DPA payload, method-evidence, and exact-byte closure", async () => {
    const f = fixture("pure", "attested");
    const result = await finalizeCompletedSellerBundleCore(f.input, f.provider);

    expect(result.state).toBe("finalised");
    expect(f.provider.resolveDependency).toHaveBeenCalledTimes(14);
    const requirements = vi.mocked(f.provider.resolveDependency).mock.calls.map(
      (call) => call[1].kinds,
    );
    expect(requirements.some((kinds) => kinds.includes("payload-attestation"))).toBe(true);
    expect(requirements.some((kinds) => kinds.includes("method-evidence"))).toBe(true);
    expect(requirements.some((kinds) => kinds.includes("delivered-payload"))).toBe(true);
    expect(f.provider.verifyPayloadMethodProof).toHaveBeenCalledOnce();
  });

  test("fails closed when a composite Vet record's authority chain is incomplete", async () => {
    const f = fixture();
    f.input.dependencies = f.input.dependencies.filter(
      (dependency) =>
        dependency.source.kind !== "attestation-ref" ||
        !dependency.source.ref.anchor.locator.includes("buyer-authority"),
    );

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /authority attestation|recursive ST-11 closure|typed dependency source/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("fails closed when the DPA method-native proof does not bind the delivered bytes", async () => {
    const f = fixture("pure", "attested");
    f.provider.verifyPayloadMethodProof = vi.fn(() => "invalid" as const);

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /payload method proof is invalid/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("fails closed when no DPA method-native proof verifier is installed", async () => {
    const f = fixture("pure", "attested");
    f.provider.verifyPayloadMethodProof = undefined;

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /method-proof verifier is unavailable/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("fails closed when a DPA method proof is omitted from the recursive closure", async () => {
    const f = fixture("pure", "attested");
    f.input.dependencies = f.input.dependencies.filter(
      (dependency) =>
        dependency.source.kind !== "attestation-ref" ||
        !dependency.source.ref.anchor.locator.includes("payload-method-evidence"),
    );

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /exactly one typed dependency source/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("fails closed when independently fetched DPA payload bytes differ", async () => {
    const f = fixture("pure", "attested");
    const ordinary = f.provider.resolveDependency;
    f.provider.resolveDependency = vi.fn((dependency, requirement) =>
      requirement.kinds.includes("delivered-payload")
        ? { disposition: "present" as const, bytes: Uint8Array.of(1, 2, 3) }
        : ordinary(dependency, requirement),
    );

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /different raw-byte hash/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("derives phase coverage from the canonical SessionRecord without gap tolerance", async () => {
    const f = fixture();
    f.input.session.phaseResults.splice(2, 1);

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /one PhaseEntry per executed pipeline phase/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("accepts omitted per-phase pointers while verifying the authoritative top-level sets", async () => {
    const f = fixture();
    for (const index of [1, 2, 3]) {
      delete f.input.session.phaseResults[index]!.result.attestationRef;
    }
    const request = prepareCompletedSellerBundleCounterSignatureRequest(f.input);
    f.input.counterSignatures = [{
      party: BUYER,
      algorithm: "ed25519",
      value: Buffer.from(f.buyerSign(request.signedBytes)).toString("base64url"),
    }];

    const result = await finalizeCompletedSellerBundleCore(f.input, f.provider);
    expect(result.sellerBundle.phaseSummary.slice(1, 4)).toEqual([
      { index: 1, kind: "commit-payee-bound-agreement", outcome: "ok" },
      {
        index: 2,
        kind: "pay-x402",
        outcome: "ok",
        txRefs: f.paymentEvidenceInput.paymentTxRefs,
      },
      { index: 3, kind: "deliver-storage-program", outcome: "ok" },
    ]);
    expect(result.sellerBundle.settlementEvidence).toEqual(
      f.input.sessionArtifacts.settlementEvidence,
    );
  });

  test("never assigns repeated pointerless delivery evidence by inventory order", async () => {
    const first = fixture("pure", "storage", false, true);
    await expect(
      finalizeCompletedSellerBundleCore(first.input, first.provider),
    ).rejects.toThrow(/ambiguous pointerless repeated phases/);

    const reordered = fixture("pure", "storage", false, true);
    const [payment, deliveryA, deliveryB] =
      reordered.input.sessionArtifacts.settlementEvidence;
    reordered.input.sessionArtifacts.settlementEvidence = [
      payment!,
      deliveryB!,
      deliveryA!,
    ];
    await expect(
      finalizeCompletedSellerBundleCore(reordered.input, reordered.provider),
    ).rejects.toThrow(/ambiguous pointerless repeated phases/);
    expect(first.provider.submitSellerBundle).not.toHaveBeenCalled();
    expect(reordered.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("accepts a declined rate outcome without inventing a required phase pointer", async () => {
    const f = fixture("pure", "storage", true);
    const result = await finalizeCompletedSellerBundleCore(f.input, f.provider);

    expect(result.sellerBundle.phaseSummary.at(-1)).toEqual({
      index: 4,
      kind: "rate",
      outcome: "fail",
      errorClass: "counterparty",
    });
    expect(result.sellerBundle.ratingRefs).toBeUndefined();
  });

  test("publishes an exact seller-signed BundleBinding on write-input mappings", async () => {
    const f = fixture("write-input");
    const result = await finalizeCompletedSellerBundleCore(f.input, f.provider);

    expect(result.binding).toMatchObject({
      bindingVersion: "1",
      jobId: JOB_ID,
      role: "seller",
      logicalAddress: bundleAddress(JOB_ID, "seller"),
      nativeAddress: `stor-${"7".repeat(40)}`,
      bundleContentHash: result.bundleContentHash,
      anchorTx: "test:bundle-anchor-tx",
      signer: SELLER,
      signature: { signer: SELLER, algorithm: "ed25519" },
    });
    expect(isBundleBinding(result.binding)).toBe(true);
    expect(bindingSignatureVerifies(result.binding!)).toBe(true);
    expect(f.provider.publishBundleBinding).toHaveBeenCalledOnce();
    expect(f.bindingSign).toHaveBeenCalledOnce();
  });

  test("resumes an existing verified seller copy without invoking either party signer", async () => {
    const f = fixture();
    await finalizeCompletedSellerBundleCore(f.input, f.provider);
    f.buyerSign.mockClear();
    f.sellerSign.mockClear();
    f.input.counterSignatures = undefined;
    vi.mocked(f.provider.submitSellerBundle).mockClear();

    const resumed = await finalizeCompletedSellerBundleCore(f.input, f.provider);
    expect(resumed.resumedBundle).toBe(true);
    expect(f.buyerSign).not.toHaveBeenCalled();
    expect(f.sellerSign).not.toHaveBeenCalled();
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
    expect(attestationBundleHash(resumed.buyerBundle)).toBe(resumed.bundleContentHash);
  });

  test("resumes an existing verified BundleBinding without signing or publishing again", async () => {
    const f = fixture("write-input");
    await finalizeCompletedSellerBundleCore(f.input, f.provider);
    f.buyerSign.mockClear();
    f.sellerSign.mockClear();
    f.bindingSign.mockClear();
    vi.mocked(f.provider.submitSellerBundle).mockClear();
    vi.mocked(f.provider.publishBundleBinding!).mockClear();

    const resumed = await finalizeCompletedSellerBundleCore(f.input, f.provider);
    expect(resumed).toMatchObject({ resumedBundle: true, resumedBinding: true });
    expect(f.buyerSign).not.toHaveBeenCalled();
    expect(f.sellerSign).not.toHaveBeenCalled();
    expect(f.bindingSign).not.toHaveBeenCalled();
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
    expect(f.provider.publishBundleBinding).not.toHaveBeenCalled();
  });

  test("never overwrites an existing seller-role copy that binds different session facts", async () => {
    const f = fixture();
    await finalizeCompletedSellerBundleCore(f.input, f.provider);
    f.state.anchored = {
      ...f.state.anchored!,
      bundle: {
        ...(f.state.anchored!.bundle as FaultAttestationBundle),
        finalisedAt: NOW + 1,
      },
    };
    vi.mocked(f.provider.submitSellerBundle).mockClear();
    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /binds different session content/,
    );
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("reconciles a thrown submission when the exact bundle became readable", async () => {
    const f = fixture();
    f.provider.submitSellerBundle = vi.fn((logicalAddress, bundle) => {
      f.anchor(logicalAddress, bundle);
      throw new Error("HTTP response stalled after inclusion");
    });
    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).resolves.toMatchObject({
      state: "finalised",
      resumedBundle: false,
    });
  });

  test("does not sign or submit while any referenced artifact is unaudited", async () => {
    const f = fixture();
    f.input.dependencies.pop();
    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /missing from the recursive ST-11 closure/,
    );
    expect(f.sellerSign).not.toHaveBeenCalled();
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("rejects a dependency receipt that differs from the durable fulfilment handoff", async () => {
    const f = fixture();
    const deliveryDependency = f.input.dependencies.find(
      (dependency) =>
        dependency.source.kind === "attestation-ref" &&
        dependency.source.ref.contentHash === f.input.fulfilment.evidenceHash,
    )!;
    deliveryDependency.anchorReceipt.transactionRef = {
      kind: "test",
      value: "tx-different-finalized-write",
    };

    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /fulfilment handoff receipt does not match/,
    );
    expect(f.sellerSign).not.toHaveBeenCalled();
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("fails closed on an indeterminate dependency read before any bundle side effect", async () => {
    const f = fixture();
    f.provider.resolveDependency = vi.fn(() => ({
      disposition: "indeterminate" as const,
      reason: "read quorum unavailable",
    }));
    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /resolution is indeterminate/,
    );
    expect(f.sellerSign).not.toHaveBeenCalled();
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("treats an indeterminate bundle lookup as not-absent and never overwrites", async () => {
    const f = fixture();
    f.provider.resolveSellerBundle = vi.fn(() => ({
      disposition: "indeterminate" as const,
      reason: "ordinary not found is not authoritative absence",
    }));
    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /lookup is indeterminate/,
    );
    expect(f.sellerSign).not.toHaveBeenCalled();
    expect(f.provider.submitSellerBundle).not.toHaveBeenCalled();
  });

  test("requires reconciliation after an ambiguous submission that remains unreadable", async () => {
    const f = fixture();
    f.provider.submitSellerBundle = vi.fn(() => {
      throw new Error("timeout");
    });
    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /resolve before any retry/,
    );
    expect(f.provider.submitSellerBundle).toHaveBeenCalledOnce();
  });

  test("rejects a finalized receipt whose bundle hash binding is wrong", async () => {
    const f = fixture();
    f.provider.submitSellerBundle = vi.fn((logicalAddress, bundle) => {
      f.anchor(logicalAddress, bundle);
      f.state.anchored!.anchorReceipt = {
        ...f.state.anchored!.anchorReceipt,
        contentHash: "f".repeat(64),
      };
    });
    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /exact established finalized AnchorReceipt/,
    );
  });

  test("write-input mapping fails closed when binding discovery is indeterminate", async () => {
    const f = fixture("write-input");
    f.provider.resolveBundleBinding = vi.fn(() => ({
      disposition: "indeterminate" as const,
      reason: "catalog unavailable",
    }));
    await expect(finalizeCompletedSellerBundleCore(f.input, f.provider)).rejects.toThrow(
      /BundleBinding lookup is indeterminate/,
    );
    expect(f.bindingSign).not.toHaveBeenCalled();
    expect(f.provider.publishBundleBinding).not.toHaveBeenCalled();
  });
});

function terminalVerificationInput(
  f: ReturnType<typeof fixture>,
): VerifyFinalizedSellerBundleInput {
  const { seller, bindingSigner: _bindingSigner, ...data } = f.input;
  return {
    ...structuredClone(data),
    seller: {
      primaryClaim: seller.primaryClaim,
      bundleHash: seller.bundleHash,
    },
  };
}

function terminalReadProvider(
  f: ReturnType<typeof fixture>,
): SellerBundleFinalizationReadProvider {
  const {
    submitSellerBundle: _submitSellerBundle,
    publishBundleBinding: _publishBundleBinding,
    ...provider
  } = f.provider;
  return provider;
}

async function finalizedForReadVerification(
  mapping: "pure" | "write-input",
): Promise<{
  fixture: ReturnType<typeof fixture>;
  input: VerifyFinalizedSellerBundleInput;
  provider: SellerBundleFinalizationReadProvider;
  result: FinalizedSellerBundle;
}> {
  const f = fixture(mapping);
  const result = await finalizeCompletedSellerBundleCore(f.input, f.provider);
  return {
    fixture: f,
    input: terminalVerificationInput(f),
    provider: terminalReadProvider(f),
    result,
  };
}

function attackerReencode(result: FinalizedSellerBundle): FinalizedSellerBundle {
  return JSON.parse(canonicalize(result)) as FinalizedSellerBundle;
}

function providerWriteCounts(f: ReturnType<typeof fixture>): {
  submit: number;
  publish: number;
} {
  return {
    submit: vi.mocked(f.provider.submitSellerBundle).mock.calls.length,
    publish: f.provider.publishBundleBinding
      ? vi.mocked(f.provider.publishBundleBinding).mock.calls.length
      : 0,
  };
}

describe("read-only authentication of retained finalized seller bundles", () => {
  test.each(["pure", "write-input"] as const)(
    "accepts a real cryptographically verified %s finalization",
    async (mapping) => {
      const retained = await finalizedForReadVerification(mapping);
      const writesBefore = providerWriteCounts(retained.fixture);
      await expect(
        verifyFinalizedSellerBundleReadOnly(
          retained.input,
          attackerReencode(retained.result),
          retained.provider,
        ),
      ).resolves.toEqual(retained.result);
      expect(providerWriteCounts(retained.fixture)).toEqual(writesBefore);
    },
  );

  test("captures caller data and binds a prototype-based read provider before the first await", async () => {
    const retained = await finalizedForReadVerification("pure");
    const expected = structuredClone(retained.result);
    let enterResolution!: () => void;
    const resolutionEntered = new Promise<void>((resolve) => {
      enterResolution = resolve;
    });
    let releaseResolution!: () => void;
    const resolutionGate = new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });

    class PrototypeReadProvider {
      readonly #base: SellerBundleFinalizationReadProvider;
      readonly mapping: SellerBundleFinalizationReadProvider["mapping"];
      readonly bundleCopyVerifier: SellerBundleFinalizationReadProvider["bundleCopyVerifier"];
      readonly compositeVerificationDeps:
        SellerBundleFinalizationReadProvider["compositeVerificationDeps"];
      #paused = false;

      constructor(base: SellerBundleFinalizationReadProvider) {
        this.#base = base;
        this.mapping = base.mapping;
        this.bundleCopyVerifier = base.bundleCopyVerifier;
        this.compositeVerificationDeps = base.compositeVerificationDeps;
      }

      async resolveDependency(
        ...args: Parameters<SellerBundleFinalizationReadProvider["resolveDependency"]>
      ) {
        if (!this.#paused) {
          this.#paused = true;
          enterResolution();
          await resolutionGate;
        }
        return await this.#base.resolveDependency(...args);
      }

      verifyDependencyReceipt(
        ...args: Parameters<SellerBundleFinalizationReadProvider["verifyDependencyReceipt"]>
      ) {
        return this.#base.verifyDependencyReceipt(...args);
      }

      verifyDependencyBinding(
        ...args: Parameters<SellerBundleFinalizationReadProvider["verifyDependencyBinding"]>
      ) {
        return this.#base.verifyDependencyBinding(...args);
      }

      verifyListingPublisherIdentityLinkage(
        ...args: Parameters<
          SellerBundleFinalizationReadProvider["verifyListingPublisherIdentityLinkage"]
        >
      ) {
        return this.#base.verifyListingPublisherIdentityLinkage(...args);
      }

      verifyVetRequirementProvenance(
        ...args: Parameters<
          SellerBundleFinalizationReadProvider["verifyVetRequirementProvenance"]
        >
      ) {
        return this.#base.verifyVetRequirementProvenance(...args);
      }

      resolvePaymentPhaseIndex(
        ...args: Parameters<
          NonNullable<SellerBundleFinalizationReadProvider["resolvePaymentPhaseIndex"]>
        >
      ) {
        return this.#base.resolvePaymentPhaseIndex!(...args);
      }

      resolveSellerBundle(
        ...args: Parameters<SellerBundleFinalizationReadProvider["resolveSellerBundle"]>
      ) {
        return this.#base.resolveSellerBundle(...args);
      }

      verifyBundleAnchorReceipt(
        ...args: Parameters<
          SellerBundleFinalizationReadProvider["verifyBundleAnchorReceipt"]
        >
      ) {
        return this.#base.verifyBundleAnchorReceipt(...args);
      }
    }

    const classProvider = new PrototypeReadProvider(retained.provider);
    const verification = verifyFinalizedSellerBundleReadOnly(
      retained.input,
      retained.result,
      classProvider,
    );
    await resolutionEntered;

    retained.input.agreement.jobId = "caller-mutated-job";
    retained.input.seller.primaryClaim = OUTSIDER;
    retained.result.sellerBundle.anchoredByRole = "buyer";
    Object.defineProperty(classProvider, "mapping", { value: "write-input" });
    Object.defineProperty(classProvider, "resolveSellerBundle", {
      value: () => {
        throw new Error("mutated provider method must not be observed");
      },
    });
    Object.defineProperty(classProvider, "verifyBundleAnchorReceipt", {
      value: () => "invalid",
    });
    releaseResolution();

    await expect(verification).resolves.toEqual(expected);
  });

  test("captures nested verifier accessors once and bypasses an overridden bind", async () => {
    const retained = await finalizedForReadVerification("pure");
    const reads = new Map<string, number>();
    const accessorMethods = <T extends object>(
      subject: string,
      base: T,
      names: readonly string[],
    ): T => {
      const captured = Object.create(null) as T;
      for (const name of names) {
        const original = Reflect.get(base, name);
        if (typeof original !== "function") {
          throw new Error(`${subject}.${name} fixture method is unavailable`);
        }
        const callback = function (this: unknown, ...args: unknown[]): unknown {
          if (this !== captured) {
            throw new Error(`${subject}.${name} lost its nested provider receiver`);
          }
          return Reflect.apply(original, base, args);
        };
        Object.defineProperty(callback, "bind", {
          value: () => {
            throw new Error(`${subject}.${name} used the callback's overridable bind`);
          },
        });
        Object.defineProperty(captured, name, {
          enumerable: true,
          get: () => {
            const key = `${subject}.${name}`;
            reads.set(key, (reads.get(key) ?? 0) + 1);
            return callback;
          },
        });
      }
      return captured;
    };

    const provider: SellerBundleFinalizationReadProvider = {
      ...retained.provider,
      bundleCopyVerifier: accessorMethods(
        "bundleCopyVerifier",
        retained.provider.bundleCopyVerifier,
        ["resolvePublicKey", "verify"],
      ),
      compositeVerificationDeps: accessorMethods(
        "compositeVerificationDeps",
        retained.provider.compositeVerificationDeps,
        [
          "resolveRecipe",
          "isRecipeSignerAuthorized",
          "isVerifyResultSignerAuthorized",
          "resolvePublicKey",
          "verify",
          "verifyAuthorityAttestation",
          "verifyRequirementParameters",
        ],
      ),
    };

    await expect(
      verifyFinalizedSellerBundleReadOnly(
        retained.input,
        retained.result,
        provider,
      ),
    ).resolves.toEqual(retained.result);
    expect(reads.size).toBe(9);
    expect([...reads.values()]).toEqual(new Array(9).fill(1));
  });

  const roleAndSignatureForgeries: Array<{
    name: string;
    mapping: "pure" | "write-input";
    mutate: (result: FinalizedSellerBundle) => void;
    expectedError: RegExp;
  }> = [
    {
      name: "swapped seller and buyer role copies",
      mapping: "pure",
      mutate: (result) => {
        const seller = result.sellerBundle;
        result.sellerBundle = result.buyerBundle;
        result.buyerBundle = seller;
      },
      expectedError: /seller|role copy|anchored/i,
    },
    {
      name: "seller signature substitution in every role copy",
      mapping: "pure",
      mutate: (result) => {
        for (const bundle of [result.sellerBundle, result.buyerBundle]) {
          const signature = bundle.signatures.find((candidate) => candidate.party === SELLER);
          if (!signature) throw new Error("seller signature fixture missing");
          signature.value = Buffer.alloc(64, 41).toString("base64url");
        }
      },
      expectedError: /signature/i,
    },
    {
      name: "buyer signature substitution in every role copy",
      mapping: "pure",
      mutate: (result) => {
        for (const bundle of [result.sellerBundle, result.buyerBundle]) {
          const signature = bundle.signatures.find((candidate) => candidate.party === BUYER);
          if (!signature) throw new Error("buyer signature fixture missing");
          signature.value = Buffer.alloc(64, 42).toString("base64url");
        }
      },
      expectedError: /signature/i,
    },
    {
      name: "an extra unreviewed signer in every role copy",
      mapping: "pure",
      mutate: (result) => {
        for (const bundle of [result.sellerBundle, result.buyerBundle]) {
          bundle.signatures.push({
            algorithm: "ed25519",
            party: OUTSIDER,
            value: Buffer.alloc(64, 43).toString("base64url"),
          });
        }
      },
      expectedError: /signature/i,
    },
    {
      name: "a forged BundleBinding algorithm",
      mapping: "write-input",
      mutate: (result) => {
        if (!result.binding) throw new Error("binding fixture missing");
        result.binding.signature.algorithm = "ecdsa-secp256k1";
      },
      expectedError: /BundleBinding|signature|algorithm/i,
    },
    {
      name: "a rebound BundleBinding signer",
      mapping: "write-input",
      mutate: (result) => {
        if (!result.binding) throw new Error("binding fixture missing");
        result.binding.signer = OUTSIDER;
        result.binding.signature.signer = OUTSIDER;
      },
      expectedError: /BundleBinding|signer|content/i,
    },
    {
      name: "a forged BundleBinding signature",
      mapping: "write-input",
      mutate: (result) => {
        if (!result.binding) throw new Error("binding fixture missing");
        result.binding.signature.value = Buffer.alloc(64, 44).toString("base64url");
      },
      expectedError: /BundleBinding|signature/i,
    },
  ];

  for (const forgery of roleAndSignatureForgeries) {
    test(`rejects a re-encoded terminal result with ${forgery.name}`, async () => {
      const retained = await finalizedForReadVerification(forgery.mapping);
      const writesBefore = providerWriteCounts(retained.fixture);
      await expect(
        verifyFinalizedSellerBundleReadOnly(
          retained.input,
          retained.result,
          retained.provider,
        ),
      ).resolves.toEqual(retained.result);
      const forged = attackerReencode(retained.result);
      forgery.mutate(forged);
      const reencoded = attackerReencode(forged);

      await expect(
        verifyFinalizedSellerBundleReadOnly(
          retained.input,
          reencoded,
          retained.provider,
        ),
      ).rejects.toThrow(forgery.expectedError);
      expect(providerWriteCounts(retained.fixture)).toEqual(writesBefore);
    });
  }

  test("rejects a forged finalized anchor proof", async () => {
    const retained = await finalizedForReadVerification("pure");
    await expect(
      verifyFinalizedSellerBundleReadOnly(
        retained.input,
        retained.result,
        retained.provider,
      ),
    ).resolves.toEqual(retained.result);
    const authenticReceipt = canonicalize(retained.result.anchorReceipt);
    const provider: SellerBundleFinalizationReadProvider = {
      ...retained.provider,
      verifyBundleAnchorReceipt: vi.fn((anchored) =>
        canonicalize(anchored.anchorReceipt) === authenticReceipt
          ? "valid" as const
          : "invalid" as const,
      ),
    };
    const forged = attackerReencode(retained.result);
    if (!forged.anchorReceipt.evidence) throw new Error("anchor proof fixture missing");
    forged.anchorReceipt.evidence.value = "forged-finality-proof";

    await expect(
      verifyFinalizedSellerBundleReadOnly(
        retained.input,
        attackerReencode(forged),
        provider,
      ),
    ).rejects.toThrow(/anchor receipt|verification/i);
  });

  test("rejects BundleBinding presence that contradicts the mapping", async () => {
    const pure = await finalizedForReadVerification("pure");
    const write = await finalizedForReadVerification("write-input");
    await expect(
      verifyFinalizedSellerBundleReadOnly(pure.input, pure.result, pure.provider),
    ).resolves.toEqual(pure.result);
    await expect(
      verifyFinalizedSellerBundleReadOnly(write.input, write.result, write.provider),
    ).resolves.toEqual(write.result);
    if (!write.result.binding) throw new Error("write-input binding fixture missing");
    const inventedBinding = attackerReencode(pure.result);
    inventedBinding.binding = structuredClone(write.result.binding);
    await expect(
      verifyFinalizedSellerBundleReadOnly(
        pure.input,
        attackerReencode(inventedBinding),
        pure.provider,
      ),
    ).rejects.toThrow(/inapplicable BundleBinding/);

    const missingBinding = attackerReencode(write.result);
    delete missingBinding.binding;
    await expect(
      verifyFinalizedSellerBundleReadOnly(
        write.input,
        attackerReencode(missingBinding),
        write.provider,
      ),
    ).rejects.toThrow(/lacks.*BundleBinding/);
  });

  test.each(["logical", "native"] as const)(
    "rejects a retained %s address mismatch",
    async (kind) => {
      const retained = await finalizedForReadVerification("pure");
      await expect(
        verifyFinalizedSellerBundleReadOnly(
          retained.input,
          retained.result,
          retained.provider,
        ),
      ).resolves.toEqual(retained.result);
      const mismatched = attackerReencode(retained.result);
      if (kind === "logical") {
        mismatched.logicalAddress = bundleAddress("another-job", "seller");
      } else {
        mismatched.nativeAddress = "stor-forged-native-address";
        mismatched.anchorReceipt.nativeAddress = mismatched.nativeAddress;
      }
      await expect(
        verifyFinalizedSellerBundleReadOnly(
          retained.input,
          attackerReencode(mismatched),
          retained.provider,
        ),
      ).rejects.toThrow(/scope|anchor|readback|address|differs/i);
    },
  );

  test.each(["mismatch", "absence", "indeterminate"] as const)(
    "rejects seller-bundle readback %s",
    async (disposition) => {
      const retained = await finalizedForReadVerification("pure");
      await expect(
        verifyFinalizedSellerBundleReadOnly(
          retained.input,
          retained.result,
          retained.provider,
        ),
      ).resolves.toEqual(retained.result);
      const resolveSellerBundle: SellerBundleFinalizationReadProvider["resolveSellerBundle"] =
        disposition === "absence"
          ? () => ({ disposition: "absent" })
          : disposition === "indeterminate"
            ? () => ({ disposition: "indeterminate", reason: "directory unavailable" })
            : () => {
                const anchored = structuredClone(retained.fixture.state.anchored!);
                anchored.nativeAddress = "stor-mismatched-readback";
                anchored.anchorReceipt.nativeAddress = anchored.nativeAddress;
                return { disposition: "present", anchored };
              };
      const provider: SellerBundleFinalizationReadProvider = {
        ...retained.provider,
        resolveSellerBundle,
      };
      await expect(
        verifyFinalizedSellerBundleReadOnly(
          retained.input,
          retained.result,
          provider,
        ),
      ).rejects.toThrow(/absent|indeterminate|differs|readback|anchor/i);
    },
  );

  test.each(["mismatch", "absence", "indeterminate"] as const)(
    "rejects BundleBinding readback %s",
    async (disposition) => {
      const retained = await finalizedForReadVerification("write-input");
      if (!retained.result.binding) throw new Error("write-input binding fixture missing");
      await expect(
        verifyFinalizedSellerBundleReadOnly(
          retained.input,
          retained.result,
          retained.provider,
        ),
      ).resolves.toEqual(retained.result);
      const resolveBundleBinding: NonNullable<
        SellerBundleFinalizationReadProvider["resolveBundleBinding"]
      > = disposition === "absence"
        ? () => ({ disposition: "absent" })
        : disposition === "indeterminate"
          ? () => ({ disposition: "indeterminate", reason: "catalog unavailable" })
          : () => {
              const binding = structuredClone(retained.result.binding!);
              binding.nativeAddress = "stor-mismatched-binding";
              return { disposition: "present", binding };
            };
      const provider: SellerBundleFinalizationReadProvider = {
        ...retained.provider,
        resolveBundleBinding,
      };
      await expect(
        verifyFinalizedSellerBundleReadOnly(
          retained.input,
          retained.result,
          provider,
        ),
      ).rejects.toThrow(/BundleBinding|readable|exact|binding/i);
    },
  );
});

describe("DACS-5 §10.4.2 BundleBinding Standard vectors", () => {
  test("derives vector logical addresses and rejects the internally inconsistent tuple", () => {
    const vectorSet = JSON.parse(
      readFileSync(
        "vendor/DACS-Standard/conformance/vectors/security/bundle-binding-v0.1.json",
        "utf8",
      ),
    ) as {
      vectors: Array<{
        name: string;
        request: { jobId: string; role: "buyer" | "seller" | "orchestrator" };
        bindings: BundleBinding[];
      }>;
    };
    for (const vector of vectorSet.vectors) {
      const requestedAddress = bundleAddress(vector.request.jobId, vector.request.role);
      for (const binding of vector.bindings) {
        expect(binding.logicalAddress === requestedAddress).toBe(
          vector.name !== "bb-missing-binding",
        );
        expect(binding.logicalAddress).toBe(
          vector.name === "bb-tuple-mismatch"
            ? requestedAddress
            : bundleAddress(binding.jobId, binding.role),
        );
        expect(isBundleBinding(binding)).toBe(vector.name !== "bb-tuple-mismatch");
      }
    }
  });
});
