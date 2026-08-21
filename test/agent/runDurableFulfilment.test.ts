import { readFileSync } from "node:fs";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

import type {
  AnchorReceipt,
  BundlePartyRole,
  IdentityBundle,
} from "../../src/artifacts/index.js";
import { canonicalize, contentHash, sha256Hex } from "../../src/canonical/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
  signedBytes,
} from "../../src/crypto/index.js";
import {
  runFulfilmentCore,
  sellerFulfilmentId,
  type SellerDeliveredArtifact,
  type SellerDeliverableSpec,
  type SellerFulfilmentAgreement,
  type SellerFulfilmentDeps,
  type SellerFulfilmentListing,
  type SellerFulfilmentRequest,
  type SellerFulfilmentResult,
  type SellerFulfilmentSessionRecord,
  type SellerPayloadAttestationRecord,
  type SignedSellerDeliveryEvidence,
} from "../../src/agent/runFulfilmentCore.js";
import { verifySettlementEvidence } from "../../src/agent/verifySettlementEvidence.js";
import {
  advanceDeliveryFinalisation,
  getDeliveryFinalisationStatus,
  getSellerFulfilmentStatus,
  projectDurableSellerAuditPending,
  resumeDeliveryFinalisation,
  runDurableFulfilmentCore,
  runDurableFulfilmentToDeliveryReady,
  sellerFulfilmentCheckpointKey,
  verifyDurableSellerTerminalResult,
  type DurableSellerFulfilmentDeps,
  type SellerEffectFence,
  type SellerFinalSessionReceiptResult,
  type SellerFulfilmentDurability,
} from "../../src/agent/runDurableFulfilmentCore.js";
import {
  advanceTerminalBundleDurable,
  type DurableTerminalBundleProvider,
  type TerminalBundleAnchorPublication,
  type TerminalBundleTransport,
} from "../../src/agent/durableTerminalBundleFinalization.js";
import {
  createTerminalBundleAuthority,
  createTerminalBundlePlan,
  createTerminalBundleSignatureContribution,
  terminalBundleSignedBytes,
} from "../../src/agent/terminalBundleFinalization.js";
import { createInMemoryFencedSessionStore, type FencedSessionStoreV2 } from "../../src/agent/fencedSessionStore.js";
import { createFsFencedSessionStore } from "../../src/agent/fencedSessionStoreFs.js";
import { createInMemorySessionStore } from "../../src/agent/sessionStore.js";
import type {
  SellerFulfilmentHandoff,
  SellerFulfilmentReceiptStore,
  SellerPaymentAuthorization,
  SellerPaymentEvidenceInput,
  SellerReceiptClaim,
} from "../../src/seller/paymentIntake.js";
import { sellerFulfilmentCandidateHash } from "../../src/seller/paymentIntake.js";
import {
  sellerFulfilmentAuditSourceHash,
  type SellerFulfilmentAuditSourceV1,
} from "../../src/seller/fulfilmentAuditSource.js";

const NOW = 1_780_000_000_000;
const SELLER = "did:demos:seller";
const BUYER = "did:demos:buyer";
const ORCHESTRATOR = "did:demos:orchestrator";
const SELLER_SEED = new Uint8Array(32).fill(17);
const ROTATED_SELLER_SEED = new Uint8Array(32).fill(23);
const H = {
  agreement: "a".repeat(64),
  commitment: "b".repeat(64),
  listing: "c".repeat(64),
  buyerBundle: "d".repeat(64),
  sellerBundle: "e".repeat(64),
  paymentTx: "f".repeat(64),
  attestation: "1".repeat(64),
};
const BUYER_REQUIREMENT = {
  requirementVersion: "1" as const,
  required: [{ scheme: "did", verificationRequired: true }],
};
const COMMITMENT_ADDRESS = "dacs3:commit:01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const AUDIT_SOURCE_COMMITMENT_SEPARATOR =
  "dacs-x-seller-fulfilment-audit-source:v1:";

function anchorReceipt(
  logicalAddress: string,
  hash: string,
  state: AnchorReceipt["state"] = "included",
): AnchorReceipt {
  return {
    receiptVersion: "1",
    substrate: "test-sr2",
    finalityProfile: "test-final",
    logicalAddress,
    nativeAddress: `native:${logicalAddress}`,
    contentHash: hash,
    transactionRef: { kind: "test", value: `tx:${hash}` },
    writer: SELLER,
    state,
    observationDisposition: "established",
    observedAt: NOW,
    ...(state === "included" || state === "finalized"
      ? { blockRef: { id: `block:${hash}`, height: "100", timestamp: NOW } }
      : {}),
    evidence: { kind: "test-proof", value: `proof:${hash}` },
  };
}

const TERMINAL_ROLES = ["buyer", "seller", "orchestrator"] as const;
const TERMINAL_CLAIMS: Record<BundlePartyRole, string> = {
  buyer: BUYER,
  seller: SELLER,
  orchestrator: ORCHESTRATOR,
};
const TERMINAL_SEED_BYTE: Record<BundlePartyRole, number> = {
  buyer: 31,
  seller: 17,
  orchestrator: 33,
};

function terminalIdentity(role: BundlePartyRole): IdentityBundle {
  return {
    bundleVersion: "1",
    presentedBy: TERMINAL_CLAIMS[role],
    presentedAt: NOW - 10,
    sessionNonce: `failed-replay-${role}`,
    claims: [{ ref: TERMINAL_CLAIMS[role], metadata: { role } }],
    presentation: {
      kind: "session-key",
      key: `failed-replay-key-${role}`,
      signature: `failed-replay-presentation-${role}`,
    },
  };
}

async function publishFailedTerminalBundle(
  store: FencedSessionStoreV2,
  result: Extract<SellerFulfilmentResult, { decision: "failed" }>,
  options: { sourcePhaseIndex?: number } = {},
): Promise<void> {
  const jobId = result.consumedPaymentAuthorization.jobId;
  const loaded = await store.load(jobId);
  if (loaded.status !== "ok") throw new Error("failed terminal source record missing");
  const source = {
    ...result.bundleContribution.phaseSummary,
    index: options.sourcePhaseIndex ?? result.bundleContribution.phaseSummary.index,
  };
  const authority = createTerminalBundleAuthority({
    jobId,
    terminalClass: result.errorClass === "substrate" ? "failed-substrate" : "failure",
    faultedParty: result.errorClass === "substrate" ? "none" : "seller",
    terminalPhase: {
      index: source.index,
      kind: source.kind,
      state: "failed",
      ...(source.errorClass ? { errorClass: source.errorClass } : {}),
    },
    sessionRecordHash: sha256Hex(canonicalize(loaded.record)),
    terminalEvidenceHash: result.evidenceHash,
    dependencySetHash: "3".repeat(64),
    listingRef: result.consumedPaymentAuthorization.listingRef,
    agreementRef: {
      anchor: {
        kind: "storage-program",
        locator: result.consumedPaymentAuthorization.commitment.ref,
      },
      contentHash: result.consumedPaymentAuthorization.commitment.contentHash,
    },
    parties: TERMINAL_ROLES.map((role) => ({
      role,
      identityBundle: terminalIdentity(role),
    })),
    phaseSummary: [source],
    vetRecords: [],
    settlementEvidence: [result.bundleContribution.settlementEvidence],
    recipeRegistryVersion: 1,
    railRegistryVersion: result.consumedPaymentAuthorization.railRegistryVersion,
    finalisedAt: result.evidence.observedAt,
  });
  const signingMode = { kind: "co-signed" } as const;
  const plan = createTerminalBundlePlan(authority, signingMode);
  const seed = (role: BundlePartyRole) =>
    new Uint8Array(32).fill(TERMINAL_SEED_BYTE[role]);
  const contributions = new Map<
    BundlePartyRole,
    ReturnType<typeof createTerminalBundleSignatureContribution>
  >();
  for (const role of ["buyer", "orchestrator"] as const) {
    contributions.set(role, createTerminalBundleSignatureContribution(
      plan,
      role,
      plan.copies.map((copy) => ({
        copyRole: copy.role,
        value: Buffer.from(ed25519Sign(
          terminalBundleSignedBytes(copy),
          privateKeyFromSeed(seed(role)),
        )).toString("base64url"),
      })),
    ));
  }

  const transport: TerminalBundleTransport = {
    resolveProposal: () => ({ disposition: "present", value: plan }),
    publishProposal: () => {
      throw new Error("the authenticated terminal proposal is already present");
    },
    resolveContribution: ({ signerRole }) => {
      const contribution = contributions.get(signerRole);
      return contribution
        ? { disposition: "present", value: contribution }
        : { disposition: "authoritatively-absent", reason: "local row not published" };
    },
    publishContribution: ({ contribution }) => {
      contributions.set(contribution.signerRole, contribution);
    },
  };
  let publication: TerminalBundleAnchorPublication | undefined;
  let binding: Parameters<DurableTerminalBundleProvider["publishOwnBundleBinding"]>[0] |
    undefined;
  const provider: DurableTerminalBundleProvider = {
    resolveOwnBundle: () => publication
      ? { disposition: "present", value: publication }
      : { disposition: "authoritatively-absent", reason: "bundle not published" },
    submitOwnBundle: ({ logicalAddress, bundle }) => {
      const bundleContentHash = plan.copies.find(
        (copy) => copy.role === "seller",
      )!.bundleContentHash;
      const nativeAddress = "native:failed-replay:seller";
      const anchorTx = "tx:failed-replay:seller";
      publication = {
        role: "seller",
        logicalAddress,
        nativeAddress,
        bundleContentHash,
        bundle,
        anchorTx,
        anchorReceipt: {
          receiptVersion: "1",
          substrate: "test",
          finalityProfile: "test-finality",
          logicalAddress,
          nativeAddress,
          contentHash: bundleContentHash,
          transactionRef: { kind: "test", value: anchorTx },
          writer: SELLER,
          state: "finalized",
          observationDisposition: "established",
          observedAt: NOW + 2,
          blockRef: { id: "block:failed-replay", height: "1", timestamp: NOW + 2 },
          evidence: { kind: "test", value: "proof:failed-replay" },
        },
      };
    },
    verifyOwnBundlePublication: () => ({ disposition: "valid" }),
    resolveOwnBundleBinding: () => binding
      ? { disposition: "present", value: binding }
      : { disposition: "authoritatively-absent", reason: "binding not published" },
    publishOwnBundleBinding: (value) => {
      binding = value;
    },
    verifyOwnBundleBinding: () => ({ disposition: "valid" }),
  };
  const signatures = new Map<string, string>();
  const outcome = await advanceTerminalBundleDurable(
    {
      authority,
      signingMode,
      local: {
        role: "seller",
        primaryClaim: SELLER,
        signer: (bytes, fence) => {
          const value = Buffer.from(ed25519Sign(
            bytes,
            privateKeyFromSeed(seed("seller")),
          )).toString("base64url");
          signatures.set(fence.idempotencyKey, value);
          return value;
        },
      },
      signerKeys: plan.requiredSigners.map(({ role, primaryClaim }) => ({
        role,
        primaryClaim,
        algorithm: "ed25519" as const,
        publicKey: new Uint8Array(rawPublicKey(publicKeyFromSeed(seed(role)))),
      })),
    },
    provider,
    {
      store,
      workerId: "failed-terminal-publisher",
      leaseTtlMs: 1_000,
      leaseNowMs: () => NOW + 1,
      transport,
      reconcileSignature: (_input, fence) => {
        const value = signatures.get(fence.idempotencyKey);
        return value
          ? { disposition: "present", value }
          : { disposition: "authoritatively-absent", reason: "signature absent" };
      },
    },
  );
  if (outcome.disposition !== "finalised") {
    throw new Error(
      `failed-session terminal publication stopped at ${outcome.stage}: ${outcome.reason}`,
    );
  }
}

function paymentAuthorization(): SellerPaymentAuthorization {
  const evidenceInput: SellerPaymentEvidenceInput = {
    evidenceVersion: "1",
    jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
    phase: "pay-x402",
    paymentTxRefs: [{
      kind: "x402",
      httpResource: "https://seller.example/pay",
      paymentReceiptHash: "9".repeat(64),
      settlementTxHash: H.paymentTx,
      chainId: 8453,
      protocolVersion: "2",
    }],
    observedAt: NOW - 2_000,
    outcome: "success",
    paymentAmount: { amount: "10", currency: "USDC" },
    settlementFinality: {
      model: "block-depth",
      finalityBlocks: 12,
      finalityObservedAt: NOW - 2_000,
    },
  };
  return {
    jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
    phaseIndex: 1,
    agreementHash: H.agreement,
    listingRef: { listingId: "listing-17", version: 4, contentHash: H.listing },
    railId: "x402-test",
    railRegistryVersion: 7,
    commitment: {
      ref: COMMITMENT_ADDRESS,
      contentHash: H.commitment,
      finalizedAt: NOW - 3_000,
      signer: SELLER,
    },
    settlementIdentity: {
      kind: "evm",
      chainId: 8453,
      txHash: H.paymentTx,
      logIndex: 0,
      includedAt: NOW - 2_500,
    },
    settlementId: `evm:8453:${H.paymentTx}:0`,
    evidenceInput,
    evidenceHash: sha256Hex(canonicalize(evidenceInput)),
    payoutBindingTier: 1,
    sessionBinding: "established",
  };
}

function receiptClaim(authorization = paymentAuthorization()): SellerReceiptClaim {
  return {
    settlementId: authorization.settlementId,
    jobId: authorization.jobId,
    phaseIndex: authorization.phaseIndex,
    observedAt: authorization.evidenceInput.observedAt,
    evidenceHash: authorization.evidenceHash,
    authorization,
  };
}

interface ControlledStore extends SellerFulfilmentReceiptStore {
  consumed: boolean;
  claimValue: SellerReceiptClaim;
  handoffValue?: SellerFulfilmentHandoff;
}

function controlledStore(
  claimValue = receiptClaim(),
  initiallyConsumed = false,
): ControlledStore {
  return {
    consumed: initiallyConsumed,
    claimValue,
    async claim(input) {
      return { status: "claimed", permitId: "permit-17", claim: input };
    },
    async inspectPermit(permitId) {
      if (permitId !== "permit-17") return { status: "invalid" };
      if (!this.consumed) {
        return { status: "available", claim: structuredClone(this.claimValue) };
      }
      if (!this.handoffValue) throw new Error("consumed fixture lacks handoff");
      return {
        status: "already-consumed",
        claim: structuredClone(this.claimValue),
        handoff: structuredClone(this.handoffValue),
      };
    },
    async consumePermit(permitId, handoff) {
      if (permitId !== "permit-17") return { status: "invalid" };
      if (this.consumed) {
        if (!this.handoffValue) throw new Error("consumed fixture lacks handoff");
        return {
          status: "already-consumed",
          claim: structuredClone(this.claimValue),
          handoff: structuredClone(this.handoffValue),
        };
      }
      this.handoffValue = structuredClone(handoff);
      this.consumed = true;
      return {
        status: "consumed",
        claim: structuredClone(this.claimValue),
        handoff: structuredClone(this.handoffValue),
      };
    },
  };
}

function payloadAttestationRecord(
  spec: Extract<SellerDeliverableSpec, { kind: "attested-payload" }>,
  bytes: Uint8Array,
): SellerPayloadAttestationRecord {
  const methodHash = sha256Hex(canonicalize(spec.verificationMethod!));
  return {
    payloadAttestationVersion: "1",
    jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
    agreementHash: H.agreement,
    deliverableSpecHash: sha256Hex(canonicalize(spec)),
    payloadFormat: spec.payloadFormat,
    payloadContentHash: sha256Hex(bytes),
    verificationMethod: spec.verificationMethod!.kind,
    verificationMethodHash: methodHash,
    attempt: 0,
    decision: "pass",
    reason: "method proof verified",
    methodEvidenceRef: {
      anchor: { kind: "https", locator: "https://proof.example/evidence" },
      contentHash: H.attestation,
    },
    verifiedAt: NOW - 500,
    signature: { algorithm: "ed25519", signer: SELLER, value: "c2ln" },
  };
}

function defaultArtifact(spec: SellerDeliverableSpec): SellerDeliveredArtifact {
  if (spec.kind === "entitlement") {
    const record = {
      entitlementVersion: "1",
      jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
      grantee: BUYER,
      grantor: SELLER,
      startsAt: NOW - 1_000,
      endsAt: NOW - 1_000 + spec.durationSec * 1_000,
      scope: { service: "analysis", tier: "pro", quotas: { calls: 100 } },
      serviceEndpoint: "https://seller.example/use",
      renewable: spec.renewable,
      renewalSeq: 0,
      signature: { algorithm: "ed25519" as const, signer: SELLER, value: "c2ln" },
    };
    return {
      kind: "deliver-entitlement",
      cleartextPayload: record,
      anchoredValue: structuredClone(record),
    };
  }
  if (spec.kind === "attested-payload") {
    const bytes = Uint8Array.from(Buffer.from('{"result":"attested"}', "utf8"));
    const record = payloadAttestationRecord(spec, bytes);
    const methodHash = sha256Hex(canonicalize(spec.verificationMethod!));
    return {
      kind: "deliver-attested-payload",
      cleartextBytes: bytes,
      anchoredValue: bytes.slice(),
      attestationRef: {
        anchor: {
          kind: "storage-program",
          locator: `dacs4:payload-attestation:01J8ME0SXKQ4T9V2RC5HJ6WX7D:${methodHash}:0`,
        },
        contentHash: contentHash(record as unknown as Record<string, unknown>),
      },
    };
  }
  const payload = { answer: 42 };
  const access = spec.accessModel === "buyer-only"
    ? { model: "buyer-only" as const, allowed: ["demos-address-buyer"] }
    : spec.accessModel === "encrypt-to-buyer"
      ? {
          model: "encrypt-to-buyer" as const,
          encryptionRecipient: "demos-encryption-key-buyer",
        }
      : { model: "public" as const };
  return {
    kind: "deliver-storage-program",
    cleartextPayload: payload,
    anchoredValue: structuredClone(payload),
    access,
  };
}

function handoffArtifactHash(artifact: SellerDeliveredArtifact): string {
  if (artifact.kind !== "deliver-attested-payload") {
    return sha256Hex(canonicalize(artifact));
  }
  const cleartextBytes = artifact.cleartextBytes!;
  const anchoredValue = artifact.anchoredValue as Uint8Array;
  return sha256Hex(canonicalize({
    kind: artifact.kind,
    cleartextBytes: {
      length: cleartextBytes.byteLength,
      sha256: sha256Hex(cleartextBytes),
    },
    anchoredValue: {
      length: anchoredValue.byteLength,
      sha256: sha256Hex(anchoredValue),
    },
    attestationRef: artifact.attestationRef,
  }));
}

interface Fixture {
  authorization: SellerPaymentAuthorization;
  claim: SellerReceiptClaim;
  store: ControlledStore;
  agreement: SellerFulfilmentAgreement;
  listing: SellerFulfilmentListing;
  session: SellerFulfilmentSessionRecord;
  auditSource: SellerFulfilmentAuditSourceV1;
  artifact: SellerDeliveredArtifact;
  request: SellerFulfilmentRequest;
  deps: SellerFulfilmentDeps;
}

function fixture(
  spec: SellerDeliverableSpec = { kind: "storage-program", accessModel: "public" },
  initiallyConsumed = false,
): Fixture {
  const authorization = paymentAuthorization();
  const phase = spec.kind === "storage-program"
    ? "deliver-storage-program"
    : spec.kind === "entitlement"
      ? "deliver-entitlement"
      : "deliver-attested-payload";
  if (spec.kind === "attested-payload") {
    authorization.payloadVerificationProducerAdmission = {
      operation: "produce",
      disposition: "supported",
      listingRef: structuredClone(authorization.listingRef),
      verificationMethodKind: spec.verificationMethod!.kind,
      verificationMethodHash: sha256Hex(canonicalize(spec.verificationMethod!)),
      deliverableSpecHash: sha256Hex(canonicalize(spec)),
      admittedAt: authorization.commitment.finalizedAt,
    };
  }
  const claim = receiptClaim(authorization);
  const store = controlledStore(claim, false);
  const buyerVetRef = {
    anchor: {
      kind: "storage-program" as const,
      locator: "dacs2:composite:01J8ME0SXKQ4T9V2RC5HJ6WX7D:did%3Ademos%3Abuyer",
    },
    contentHash: "2".repeat(64),
  };
  const sellerVetRef = {
    anchor: {
      kind: "storage-program" as const,
      locator: "dacs2:composite:01J8ME0SXKQ4T9V2RC5HJ6WX7D:did%3Ademos%3Aseller",
    },
    contentHash: "3".repeat(64),
  };
  const commitmentRef = {
    anchor: { kind: "storage-program" as const, locator: COMMITMENT_ADDRESS },
    contentHash: H.commitment,
  };
  const listing: SellerFulfilmentListing = {
    pin: { ...authorization.listingRef },
    sellerPrimaryClaim: SELLER,
    buyerRequirement: structuredClone(BUYER_REQUIREMENT),
    pipeline: [
      { kind: "commit-payee-bound-agreement" },
      { kind: "pay-x402", parameters: { rail: authorization.railId } },
      { kind: phase },
    ],
    deliverable: spec,
  };
  const agreement: SellerFulfilmentAgreement = {
    artifactKind: "payee-bound",
    ref: "agreement:01J8ME0SXKQ4T9V2RC5HJ6WX7D",
    contentHash: H.agreement,
    jobId: authorization.jobId,
    listingPin: { ...authorization.listingRef },
    buyer: {
      primaryClaim: BUYER,
      bundleHash: H.buyerBundle,
      vetRecordRef: structuredClone(buyerVetRef),
      storageAddress: "demos-address-buyer",
      encryptionKey: "demos-encryption-key-buyer",
    },
    seller: {
      primaryClaim: SELLER,
      bundleHash: H.sellerBundle,
      vetRecordRef: structuredClone(sellerVetRef),
    },
    deliverableRef: {
      deliverableType: spec.kind,
      hash: sha256Hex(canonicalize(spec)),
      ...(spec.kind === "storage-program" && spec.schemaUrl ? { schemaUrl: spec.schemaUrl } : {}),
    },
    commitment: {
      status: "finalized",
      ref: COMMITMENT_ADDRESS,
      agreementHash: H.agreement,
      recordContentHash: H.commitment,
      finalizedAt: NOW - 3_000,
      signer: SELLER,
    },
  };
  const paymentRef = {
    anchor: {
      kind: "storage-program" as const,
      locator: `dacs4:payment:${authorization.jobId}:${authorization.railId}:1`,
    },
    contentHash: authorization.evidenceHash,
  };
  const session: SellerFulfilmentSessionRecord = {
    recordVersion: "1",
    jobId: authorization.jobId,
    state: "settle-pending",
    listingRef: { ...authorization.listingRef },
    parties: [
      {
        role: "buyer",
        bundleHash: H.buyerBundle,
        primaryClaim: BUYER,
        vetRecordRef: structuredClone(buyerVetRef),
      },
      {
        role: "seller",
        bundleHash: H.sellerBundle,
        primaryClaim: SELLER,
        vetRecordRef: structuredClone(sellerVetRef),
      },
      { role: "orchestrator", bundleHash: H.sellerBundle, primaryClaim: SELLER },
    ],
    pipeline: structuredClone(listing.pipeline),
    phaseResults: [
      {
        index: 0,
        step: structuredClone(listing.pipeline[0]!),
        invokedAt: NOW - 4_000,
        result: {
          ok: true,
          txRefs: [{
            kind: "storage-program",
            address: "stor-commitment-01J8ME0SXKQ4T9V2RC5HJ6WX7D",
            writeTxHash: "5".repeat(64),
          }],
          contextDelta: {},
          attestationRef: structuredClone(commitmentRef),
        },
        contextDelta: {},
      },
      {
        index: 1,
        step: structuredClone(listing.pipeline[1]!),
        invokedAt: NOW - 2_100,
        result: {
          ok: true,
          txRefs: structuredClone(authorization.evidenceInput.paymentTxRefs),
          contextDelta: {},
          attestationRef: paymentRef,
        },
        contextDelta: {},
      },
    ],
    startedAt: NOW - 10_000,
    lastUpdatedAt: NOW - 2_000,
    recipeRegistryVersion: 3,
    railRegistryVersion: authorization.railRegistryVersion,
  };
  const commitmentAnchorReceipt = anchorReceipt(
    COMMITMENT_ADDRESS,
    H.commitment,
    "finalized",
  );
  commitmentAnchorReceipt.blockRef!.timestamp = authorization.commitment.finalizedAt;
  const commitmentContext = {
    "commit-payee-bound-agreement": {
      agreementHash: authorization.agreementHash,
      anchorTxRef: structuredClone(session.phaseResults[0]!.result.txRefs![0]!),
      anchorReceipt: commitmentAnchorReceipt,
      committedAt: authorization.commitment.finalizedAt,
    },
  };
  session.phaseResults[0]!.result.contextDelta = structuredClone(commitmentContext);
  session.phaseResults[0]!.contextDelta = structuredClone(commitmentContext);
  const auditSource: SellerFulfilmentAuditSourceV1 = {
    sourceVersion: "1",
    session: structuredClone(session),
    artifacts: {
      agreementCommitment: structuredClone(commitmentRef),
      vetRecords: [structuredClone(buyerVetRef), structuredClone(sellerVetRef)],
      vetRequirements: [
        {
          vetRecordRef: structuredClone(buyerVetRef),
          evaluatedParty: BUYER,
          requirement: structuredClone(BUYER_REQUIREMENT),
          verifier: SELLER,
          freshness: [{
            ref: {
              anchor: {
                kind: "storage-program",
                locator: "dacs2:01J8ME0SXKQ4T9V2RC5HJ6WX7D:did:demos%3Abuyer:v1",
              },
              contentHash: "4".repeat(64),
              recipeVersion: 1,
            },
            sourceJobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
            scheme: "did",
            identifier: "demos:buyer",
            method: "self-signed",
            requirement: structuredClone(BUYER_REQUIREMENT.required[0]!),
          }],
          dealSpecific: [],
        },
        {
          vetRecordRef: structuredClone(sellerVetRef),
          evaluatedParty: SELLER,
          requirement: { requirementVersion: "1", required: [] },
          verifier: BUYER,
          freshness: [],
          dealSpecific: [],
        },
      ],
      settlementEvidence: [structuredClone(paymentRef)],
    },
    provenanceProfile: "dacs-sdk-operational-v1",
  };
  const artifact = defaultArtifact(spec);
  const preparedPayloadRecord = spec.kind === "attested-payload" && artifact.cleartextBytes
    ? payloadAttestationRecord(spec, artifact.cleartextBytes)
    : undefined;
  const logicalAddress = phase === "deliver-entitlement"
    ? "dacs4:entitlement:01J8ME0SXKQ4T9V2RC5HJ6WX7D:0"
    : "dacs4:deliverable:01J8ME0SXKQ4T9V2RC5HJ6WX7D";
  if (initiallyConsumed) {
    const fulfilmentId = sellerFulfilmentId({
      jobId: authorization.jobId,
      paymentPhaseIndex: authorization.phaseIndex,
      deliveryPhaseIndex: 2,
      settlementId: authorization.settlementId,
      agreementHash: authorization.agreementHash,
      paymentEvidenceHash: authorization.evidenceHash,
    });
    const authorizationHash = sha256Hex(canonicalize(authorization));
    const auditSourceHash = sellerFulfilmentAuditSourceHash(auditSource);
    const candidate: SellerFulfilmentHandoff["candidate"] = {
      status: "prepared",
      validatedAt: NOW,
      artifactHash: handoffArtifactHash(artifact),
      delivery: {
        artifact: structuredClone(artifact),
        ...(preparedPayloadRecord
          ? { payloadAttestationRecord: structuredClone(preparedPayloadRecord) }
          : {}),
      },
    };
    const unsignedCommitment = {
      commitmentVersion: "1" as const,
      fulfilmentId,
      jobId: authorization.jobId,
      agreementRef: agreement.ref,
      agreementHash: authorization.agreementHash,
      commitmentRef: agreement.commitment.ref,
      authorizationHash,
      paymentPhaseIndex: authorization.phaseIndex,
      deliveryPhaseIndex: 2,
      phase: phase as SellerFulfilmentHandoff["phase"],
      logicalAddress,
      deliverableSpecHash: sha256Hex(canonicalize(spec)),
      auditSourceHash,
      candidateHash: sellerFulfilmentCandidateHash(candidate),
      deliveryInvokedAt: session.lastUpdatedAt,
    };
    store.consumed = true;
    store.handoffValue = {
      handoffVersion: "2",
      fulfilmentId,
      jobId: authorization.jobId,
      agreementRef: agreement.ref,
      agreementHash: authorization.agreementHash,
      commitmentRef: agreement.commitment.ref,
      authorizationHash,
      settlementId: authorization.settlementId,
      paymentEvidenceHash: authorization.evidenceHash,
      paymentPhaseIndex: authorization.phaseIndex,
      deliveryPhaseIndex: 2,
      phase,
      logicalAddress,
      deliverableSpecHash: sha256Hex(canonicalize(spec)),
      agreementViewHash: sha256Hex(canonicalize(agreement)),
      validationFloorAt: Math.max(
        agreement.commitment.finalizedAt,
        authorization.evidenceInput.observedAt,
        session.lastUpdatedAt,
      ),
      deliveryInvokedAt: session.lastUpdatedAt,
      evidenceAuthority: { primaryClaim: SELLER, algorithm: "ed25519" },
      auditSource: structuredClone(auditSource),
      auditSourceHash,
      auditSourceCommitment: {
        ...unsignedCommitment,
        signature: {
          algorithm: "ed25519",
          signer: SELLER,
          value: Buffer.from(ed25519Sign(
            signedBytes(
              AUDIT_SOURCE_COMMITMENT_SEPARATOR,
              contentHash(unsignedCommitment as unknown as Record<string, unknown>),
            ),
            privateKeyFromSeed(SELLER_SEED),
          )).toString("base64url"),
        },
      },
      candidate,
    };
  }
  const anchoredHash = phase === "deliver-attested-payload"
    ? sha256Hex(artifact.cleartextBytes!)
    : phase === "deliver-entitlement"
      ? contentHash(artifact.cleartextPayload as Record<string, unknown>)
      : sha256Hex(canonicalize(artifact.anchoredValue));
  let reconciliationCount = 0;
  let anchoredEvidence: unknown;
  const request: SellerFulfilmentRequest = {
    agreementRef: agreement.ref,
    agreementHash: agreement.contentHash,
    commitmentRef: agreement.commitment.ref,
    deliveryPhaseIndex: 2,
    paymentPermitId: "permit-17",
    ...(authorization.payloadVerificationProducerAdmission
      ? {
          payloadVerificationProducerAdmission: structuredClone(
            authorization.payloadVerificationProducerAdmission,
          ),
        }
      : {}),
  };
  const deps: SellerFulfilmentDeps = {
    receiptStore: store,
    auditSourceProfile: "v2",
    resolveAgreement: async () => ({ status: "verified", value: agreement }),
    resolveListing: async () => ({ status: "verified", value: listing }),
    resolveAuditSource: async () => ({
      status: "verified",
      value: { ...structuredClone(auditSource), session: structuredClone(session) },
    }),
    prepareDelivery: async () => ({
      status: "prepared",
      delivery: {
        artifact,
        ...(preparedPayloadRecord
          ? { payloadAttestationRecord: preparedPayloadRecord }
          : {}),
      },
    }),
    submitDelivery: async () => ({ status: "accepted", reconciliationId: "delivery:01J8ME0SXKQ4T9V2RC5HJ6WX7D:1" }),
    reconcileDelivery: vi.fn(async () => {
      reconciliationCount += 1;
      return reconciliationCount === 1 && !initiallyConsumed
        ? { status: "absent" as const, reason: "authoritative absence" }
        : {
            status: "complete" as const,
            reconciliationId: "delivery:01J8ME0SXKQ4T9V2RC5HJ6WX7D:1",
            observedAt: NOW,
          };
    }),
    resolveDelivery: async () => ({
      status: "verified",
      value: { artifact, anchorReceipt: anchorReceipt(logicalAddress, anchoredHash) },
    }),
    verifyAnchorReceipt: async () => ({ disposition: "valid" }),
    verifyDeliverySchema: async () => ({ disposition: "valid" }),
    verifyEncryptedDelivery: async () => ({ disposition: "valid" }),
    resolvePayloadAttestation: async () => {
      if (spec.kind !== "attested-payload" || !artifact.cleartextBytes) {
        return { status: "rejected", reason: "not an attested payload" };
      }
      const record = payloadAttestationRecord(spec, artifact.cleartextBytes);
      const ref = artifact.attestationRef!;
      return {
        status: "verified",
        value: {
          record,
          anchorReceipt: anchorReceipt(ref.anchor.locator, contentHash(record)),
        },
      };
    },
    resolvePayloadVerificationCapability: async () => ({ disposition: "supported" }),
    anchorPayloadAttestation: async ({ ref, recordHash }) => ({
      status: "anchored",
      ref: structuredClone(ref),
      anchorReceipt: anchorReceipt(ref.anchor.locator, recordHash),
    }),
    verifyPayloadAttestationSignature: async () => ({ disposition: "valid" }),
    verifyPayloadMethodProof: async () => ({ disposition: "valid" }),
    verifyEntitlementSignature: async () => ({ disposition: "valid" }),
    evidenceSigner: {
      algorithm: "ed25519",
      signer: SELLER,
      sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
    },
    auditSourceCommitmentSigner: {
      algorithm: "ed25519",
      signer: SELLER,
      sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
    },
    verifyEvidenceSignature: async ({ signedBytes, signature, expectedSigner }) => {
      if (signature.algorithm !== "ed25519" || signature.signer !== expectedSigner) {
        return { disposition: "invalid", reason: "unexpected signer or algorithm" };
      }
      const signatureBytes = Uint8Array.from(Buffer.from(signature.value, "base64url"));
      return ed25519Verify(
        signedBytes,
        signatureBytes,
        publicKeyFromSeed(SELLER_SEED),
      )
        ? { disposition: "valid" }
        : { disposition: "invalid", reason: "signature mismatch" };
    },
    verifyAuditSourceCommitmentSignature: async ({
      signedBytes: commitmentBytes,
      signature,
      expectedSigner,
    }) => {
      if (signature.algorithm !== "ed25519" || signature.signer !== expectedSigner) {
        return { disposition: "invalid", reason: "unexpected signer or algorithm" };
      }
      return ed25519Verify(
        commitmentBytes,
        Uint8Array.from(Buffer.from(signature.value, "base64url")),
        publicKeyFromSeed(SELLER_SEED),
      )
        ? { disposition: "valid" }
        : { disposition: "invalid", reason: "signature mismatch" };
    },
    anchorEvidence: async ({ evidence, evidenceHash }) => {
      anchoredEvidence = structuredClone(evidence);
      const locator = "dacs4:test-delivery-evidence:01J8ME0SXKQ4T9V2RC5HJ6WX7D";
      return {
        status: "anchored",
        ref: { anchor: { kind: "storage-program", locator }, contentHash: evidenceHash },
        anchorReceipt: anchorReceipt(locator, evidenceHash, "included"),
      };
    },
    resolveEvidence: async () => anchoredEvidence === undefined
      ? { status: "indeterminate", reason: "evidence is not readable" }
      : { status: "verified", value: structuredClone(anchoredEvidence) },
    nowMs: () => NOW,
  };
  return {
    authorization,
    claim,
    store,
    agreement,
    listing,
    session,
    auditSource,
    artifact,
    request,
    deps,
  };
}

function singularSignatureHash(record: Record<string, unknown>): string {
  return sha256Hex(canonicalize(Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== "signature"),
  )));
}

function installPayloadRecord(
  f: Fixture,
  spec: Extract<SellerDeliverableSpec, { kind: "attested-payload" }>,
  record: SellerPayloadAttestationRecord,
): void {
  if (!(f.artifact.cleartextBytes instanceof Uint8Array)) throw new Error("DPA fixture required");
  const recordHash = singularSignatureHash(record as unknown as Record<string, unknown>);
  const methodHash = sha256Hex(canonicalize(spec.verificationMethod!));
  f.artifact.attestationRef = {
    anchor: {
      kind: "storage-program",
      locator: `dacs4:payload-attestation:01J8ME0SXKQ4T9V2RC5HJ6WX7D:${methodHash}:${record.attempt}`,
    },
    contentHash: recordHash,
  };
  f.deps.prepareDelivery = async () => ({
    status: "prepared",
    delivery: {
      artifact: f.artifact,
      payloadAttestationRecord: record,
    },
  });
  f.deps.anchorPayloadAttestation = async ({ ref, recordHash: anchoredHash }) => ({
    status: "anchored",
    ref: structuredClone(ref),
    anchorReceipt: anchorReceipt(ref.anchor.locator, anchoredHash),
  });
  f.deps.resolvePayloadAttestation = async () => ({
    status: "verified",
    value: {
      record: structuredClone(record),
      anchorReceipt: anchorReceipt(f.artifact.attestationRef!.anchor.locator, recordHash),
    },
  });
}

type EffectName = "payload" | "delivery" | "evidence" | "final";

interface DurableHarness {
  fixture: Fixture;
  deps: DurableSellerFulfilmentDeps;
  durability: SellerFulfilmentDurability;
  store: FencedSessionStoreV2;
  counts: Record<EffectName, number>;
  fences: Record<EffectName, SellerEffectFence[]>;
  loseAfter: Set<EffectName>;
  committed: Partial<Record<EffectName, unknown>>;
  finalReceipt: { exact: string; bytes: Uint8Array };
}

type FencedStoreLoad = Awaited<ReturnType<FencedSessionStoreV2["load"]>>;
type FencedStoreRecord = Extract<FencedStoreLoad, { status: "ok" }>["record"];

function proxyFencedStore(
  source: FencedSessionStoreV2,
  overrides: Partial<Pick<
    FencedSessionStoreV2,
    "load" | "transition" | "claimCheckpoint" | "bindSessionAuthorization"
  >> = {},
): FencedSessionStoreV2 {
  return {
    apiVersion: source.apiVersion,
    create: (input) => source.create(input),
    load: overrides.load ?? ((jobId) => source.load(jobId)),
    transition: overrides.transition ?? ((input) => source.transition(input)),
    claimCheckpoint: overrides.claimCheckpoint ?? ((input) => source.claimCheckpoint(input)),
    acquireLease: (input) => source.acquireLease(input),
    renewLease: (input) => source.renewLease(input),
    bindSessionAuthorization: overrides.bindSessionAuthorization ??
      ((input) => source.bindSessionAuthorization(input)),
    bindHash: (input) => source.bindHash(input),
    list: (filter) => source.list(filter),
  };
}

function proxyRecordView(
  source: FencedSessionStoreV2,
  transform: (record: FencedStoreRecord) => FencedStoreRecord,
): FencedSessionStoreV2 {
  const mapRecord = (record: FencedStoreRecord): FencedStoreRecord =>
    transform(structuredClone(record));
  return proxyFencedStore(source, {
    load: async (jobId): Promise<FencedStoreLoad> => {
      const loaded = await source.load(jobId);
      return loaded.status === "ok"
        ? { status: "ok", record: mapRecord(loaded.record) }
        : loaded;
    },
    bindSessionAuthorization: async (input) => {
      const result = await source.bindSessionAuthorization(input);
      return result.record === undefined
        ? result
        : { ...result, record: mapRecord(result.record) };
    },
  });
}

type TestDurableNode =
  | { t: "null" | "undefined" }
  | { t: "boolean"; v: boolean }
  | { t: "number"; v: number }
  | { t: "string" | "bytes"; v: string }
  | { t: "array"; v: TestDurableNode[] }
  | { t: "object"; v: Array<[string, TestDurableNode]> };

function isRecordForTest(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function durableNodeForTest(value: unknown, seen = new Set<object>()): TestDurableNode {
  if (value === null) return { t: "null" };
  if (value === undefined) return { t: "undefined" };
  if (typeof value === "boolean") return { t: "boolean", v: value };
  if (typeof value === "string") return { t: "string", v: value };
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return { t: "number", v: value };
  }
  if (value instanceof Uint8Array) {
    return { t: "bytes", v: Buffer.from(value).toString("base64url") };
  }
  if (typeof value !== "object") throw new TypeError("unsupported durable test value");
  if (seen.has(value)) throw new TypeError("cyclic durable test value");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return { t: "array", v: value.map((item) => durableNodeForTest(item, seen)) };
    }
    return {
      t: "object",
      v: Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          durableNodeForTest((value as Record<string, unknown>)[key], seen),
        ]),
    };
  } finally {
    seen.delete(value);
  }
}

function encodeDurableForTest(value: unknown): string {
  return Buffer.from(JSON.stringify(durableNodeForTest(value)), "utf8").toString("base64url");
}

function valueFromDurableNodeForTest(node: TestDurableNode): unknown {
  if (!("v" in node)) {
    return node.t === "null" ? null : undefined;
  }
  if (node.t === "boolean" || node.t === "number" || node.t === "string") {
    return node.v;
  }
  if (node.t === "bytes") {
    return Uint8Array.from(Buffer.from(node.v, "base64url"));
  }
  if (node.t === "array") return node.v.map(valueFromDurableNodeForTest);
  if (node.t !== "object") throw new TypeError("unsupported durable test node");
  return Object.fromEntries(node.v.map(([key, value]): [string, unknown] => [
    key,
    valueFromDurableNodeForTest(value),
  ]));
}

function decodeDurableForTest(value: string): unknown {
  return valueFromDurableNodeForTest(
    JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as TestDurableNode,
  );
}

function durableHashForTest(encoded: string): string {
  return sha256Hex(Buffer.from(encoded, "utf8"));
}

function terminalEffectSnapshotHashForTest(record: FencedStoreRecord): string {
  const keys = new Set([
    sellerFulfilmentCheckpointKey.payloadPublication(2),
    sellerFulfilmentCheckpointKey.payloadReadback(2),
    sellerFulfilmentCheckpointKey.delivery(2),
    sellerFulfilmentCheckpointKey.deliveryReconciliation(2),
    sellerFulfilmentCheckpointKey.deliveryReadback(2),
    sellerFulfilmentCheckpointKey.dpaTerminalFailure(2),
  ]);
  return durableHashForTest(encodeDurableForTest(record.checkpoints
    .filter((checkpoint) => keys.has(checkpoint.key))
    .map((checkpoint) => ({
      key: checkpoint.key,
      stage: checkpoint.stage,
      ...(checkpoint.data ? { data: checkpoint.data } : {}),
    }))));
}

const terminalTamperCases: Array<{
  label: string;
  tamper(record: FencedStoreRecord): void;
}> = [
  {
    label: "consumed authorization binding",
    tamper(record) {
      const binding = record.paymentAuthorizations[0];
      if (!binding) throw new Error("authorization binding missing");
      binding.authorizationHash = "0".repeat(64);
    },
  },
  {
    label: "final receipt intent",
    tamper(record) {
      const checkpoint = record.checkpoints.find(
        (item) => item.key === sellerFulfilmentCheckpointKey.finalReceipt(2) &&
          item.stage === "intent",
      );
      if (typeof checkpoint?.data?.input !== "string") {
        throw new Error("final receipt intent missing");
      }
      checkpoint.data.input = `${checkpoint.data.input}A`;
    },
  },
  {
    label: "final receipt outcome",
    tamper(record) {
      const checkpoint = [...record.checkpoints].reverse().find(
        (item) => item.key === sellerFulfilmentCheckpointKey.finalReceipt(2) &&
          item.stage === "outcome",
      );
      if (typeof checkpoint?.data?.output !== "string") {
        throw new Error("final receipt outcome missing");
      }
      checkpoint.data.output = `${checkpoint.data.output}A`;
    },
  },
  {
    label: "deleted consumed handoff history",
    tamper(record) {
      record.checkpoints = record.checkpoints.filter(
        (item) => item.key !== sellerFulfilmentCheckpointKey.handoff(2),
      );
    },
  },
  {
    label: "coherently rehashed consumed handoff",
    tamper(record) {
      const checkpoints = record.checkpoints.filter(
        (item) => item.key === sellerFulfilmentCheckpointKey.handoff(2),
      );
      if (checkpoints.length !== 2 || checkpoints.some(
        (checkpoint) => typeof checkpoint.data?.handoff !== "string",
      )) {
        throw new Error("consumed handoff history missing");
      }
      for (const checkpoint of checkpoints) {
        const rebound = `${String(checkpoint.data!.handoff)}A`;
        checkpoint.data!.handoff = rebound;
        checkpoint.data!.handoffBindingHash = durableHashForTest(rebound);
      }
    },
  },
  {
    label: "deleted evidence-publication history",
    tamper(record) {
      record.checkpoints = record.checkpoints.filter(
        (item) => item.key !== sellerFulfilmentCheckpointKey.evidencePublication(2),
      );
    },
  },
  {
    label: "deleted evidence-readback history",
    tamper(record) {
      record.checkpoints = record.checkpoints.filter(
        (item) => item.key !== sellerFulfilmentCheckpointKey.evidenceReadback(2),
      );
    },
  },
  {
    label: "deleted delivery-submission history",
    tamper(record) {
      record.checkpoints = record.checkpoints.filter(
        (item) => item.key !== sellerFulfilmentCheckpointKey.delivery(2),
      );
    },
  },
  {
    label: "deleted delivery-reconciliation history",
    tamper(record) {
      record.checkpoints = record.checkpoints.filter(
        (item) => item.key !== sellerFulfilmentCheckpointKey.deliveryReconciliation(2),
      );
    },
  },
  {
    label: "deleted delivery-readback history",
    tamper(record) {
      record.checkpoints = record.checkpoints.filter(
        (item) => item.key !== sellerFulfilmentCheckpointKey.deliveryReadback(2),
      );
    },
  },
  {
    label: "coherently rehashed delivery agreement parties",
    tamper(record) {
      const checkpoints = record.checkpoints.filter(
        (item) => item.key === sellerFulfilmentCheckpointKey.delivery(2),
      );
      if (checkpoints.length !== 2) throw new Error("delivery WAL history missing");
      for (const checkpoint of checkpoints) {
        if (typeof checkpoint.data?.input !== "string") {
          throw new Error("delivery WAL input missing");
        }
        const input = decodeDurableForTest(checkpoint.data.input);
        if (!isRecordForTest(input) || !isRecordForTest(input.agreement) ||
            !isRecordForTest(input.agreement.buyer)) {
          throw new Error("delivery agreement buyer missing");
        }
        input.agreement.buyer.primaryClaim = "did:demos:attacker";
        const encoded = encodeDurableForTest(input);
        checkpoint.data.input = encoded;
        checkpoint.data.inputHash = durableHashForTest(encoded);
      }
    },
  },
  {
    label: "indexed agreement receipt",
    tamper(record) {
      const receipt = record.receipts.find((item) => item.kind === "agreement");
      if (!receipt) throw new Error("indexed agreement receipt missing");
      receipt.ref = "agreement:attacker";
    },
  },
  {
    label: "indexed settlement receipt",
    tamper(record) {
      const binding = record.paymentAuthorizations[0];
      if (!binding) throw new Error("payment authorization binding missing");
      const receipt = record.receipts.find(
        (item) =>
          item.kind === "settlement" &&
          item.phaseIndex === binding.paymentPhaseIndex,
      );
      if (!receipt) throw new Error("indexed settlement receipt missing");
      receipt.ref = `evm:8453:${"0".repeat(64)}:0`;
    },
  },
  {
    label: "indexed delivery/evidence receipt",
    tamper(record) {
      const binding = record.paymentAuthorizations[0];
      if (!binding) throw new Error("payment authorization binding missing");
      const receipt = record.receipts.find(
        (item) =>
          item.kind === "delivery" &&
          item.phaseIndex === binding.deliveryPhaseIndex,
      );
      if (!receipt) throw new Error("indexed delivery receipt missing");
      receipt.ref = "dacs4:test-delivery-evidence:attacker";
    },
  },
  {
    label: "indexed fulfilment receipt",
    tamper(record) {
      const binding = record.paymentAuthorizations[0];
      if (!binding) throw new Error("payment authorization binding missing");
      const receipt = record.receipts.find(
        (item) =>
          item.kind === "fulfilment" &&
          item.phaseIndex === binding.deliveryPhaseIndex,
      );
      if (!receipt) throw new Error("indexed fulfilment receipt missing");
      receipt.ref = "0".repeat(64);
    },
  },
  {
    label: "oversized reserved seller phase index",
    tamper(record) {
      record.phase = "seller:delivery-completed:9007199254740992";
    },
  },
];

function withoutFence<T extends object>(input: T & { fence: SellerEffectFence }): T {
  const { fence: _fence, ...rest } = input;
  return rest as T;
}

function durableHarness(
  spec: SellerDeliverableSpec = { kind: "storage-program", accessModel: "public" },
  options: { initiallyConsumed?: boolean; store?: FencedSessionStoreV2; workerId?: string } = {},
): DurableHarness {
  const f = fixture(spec, options.initiallyConsumed ?? false);
  const store = options.store ?? createInMemoryFencedSessionStore();
  const counts: Record<EffectName, number> = {
    payload: 0,
    delivery: 0,
    evidence: 0,
    final: 0,
  };
  const fences: Record<EffectName, SellerEffectFence[]> = {
    payload: [],
    delivery: [],
    evidence: [],
    final: [],
  };
  const loseAfter = new Set<EffectName>();
  const committed: Partial<Record<EffectName, unknown>> = {};
  const finalReceipt = {
    exact: "final-receipt:01J8ME0SXKQ4T9V2RC5HJ6WX7D:1",
    bytes: Uint8Array.from([0, 1, 2, 253, 254, 255]),
  };
  const maybeLose = (name: EffectName): void => {
    if (loseAfter.delete(name)) throw new Error(`${name} response lost after commit`);
  };

  const deps = {
    ...f.deps,
    submitDelivery: async (input) => {
      counts.delivery += 1;
      fences.delivery.push(structuredClone(input.fence));
      const output = await f.deps.submitDelivery(withoutFence(input));
      committed.delivery = structuredClone(output);
      maybeLose("delivery");
      return output;
    },
    ...(f.deps.anchorPayloadAttestation
      ? {
          anchorPayloadAttestation: async (input) => {
            counts.payload += 1;
            fences.payload.push(structuredClone(input.fence));
            const output = await f.deps.anchorPayloadAttestation!(withoutFence(input));
            committed.payload = structuredClone(output);
            maybeLose("payload");
            return output;
          },
        }
      : {}),
    anchorEvidence: async (input) => {
      counts.evidence += 1;
      fences.evidence.push(structuredClone(input.fence));
      const output = await f.deps.anchorEvidence(withoutFence(input));
      committed.evidence = structuredClone(output);
      maybeLose("evidence");
      return output;
    },
  } as DurableSellerFulfilmentDeps;

  const durability: SellerFulfilmentDurability = {
    store,
    workerId: options.workerId ?? "worker-a",
    leaseTtlMs: 60_000,
    leaseNowMs: () => NOW,
    reconcilePayloadAttestation: async () =>
      committed.payload as Awaited<ReturnType<NonNullable<SellerFulfilmentDeps["anchorPayloadAttestation"]>>> ??
        { status: "indeterminate", reason: "payload publication is not yet visible" },
    reconcileDeliverySubmission: async () =>
      committed.delivery as Awaited<ReturnType<SellerFulfilmentDeps["submitDelivery"]>> ??
        { status: "indeterminate", reason: "delivery submission is not yet visible" },
    reconcileEvidencePublication: async () =>
      committed.evidence as Awaited<ReturnType<SellerFulfilmentDeps["anchorEvidence"]>> ??
        { status: "indeterminate", reason: "evidence publication is not yet visible" },
    publishFinalSessionReceipt: async (input) => {
      counts.final += 1;
      fences.final.push(structuredClone(input.fence));
      const output: SellerFinalSessionReceiptResult = {
        status: "recorded",
        receipt: structuredClone(finalReceipt),
      };
      committed.final = structuredClone(output);
      maybeLose("final");
      return output;
    },
    reconcileFinalSessionReceipt: async () =>
      committed.final as SellerFinalSessionReceiptResult ??
        { status: "indeterminate", reason: "final receipt is not yet visible" },
  };
  return {
    fixture: f,
    deps,
    durability,
    store,
    counts,
    fences,
    loseAfter,
    committed,
    finalReceipt,
  };
}

describe("runDurableFulfilmentCore on repaired #120", () => {
  test("returns a durable delivery-ready result and resumes without a background promise", async () => {
    const h = durableHarness();

    const ready = await runDurableFulfilmentToDeliveryReady(
      h.fixture.request,
      h.deps,
      h.durability,
    );

    expect(ready.status).toBe("delivery-ready");
    if (ready.status !== "delivery-ready") throw new Error("delivery was not ready");
    expect(ready.result).toMatchObject({
      jobId: h.fixture.authorization.jobId,
      fulfilmentId: ready.finalisation.fulfilmentId,
      deliveryPhaseIndex: 2,
      logicalAddress: "dacs4:deliverable:01J8ME0SXKQ4T9V2RC5HJ6WX7D",
      evidence: { outcome: "success", signature: { signer: SELLER } },
      evidenceHash: ready.finalisation.evidenceHash,
    });
    expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 0, final: 0 });
    expect(await getDeliveryFinalisationStatus(
      h.store,
      h.fixture.authorization.jobId,
      2,
    )).toMatchObject({
      status: "ok",
      milestone: "delivery-ready",
      deliveryReady: "outcome",
      publicationStarted: "not-started",
      evidence: "intent",
      finalReceipt: "not-started",
      result: "not-started",
    });

    const completed = await advanceDeliveryFinalisation(
      ready.finalisation,
      h.fixture.request,
      h.deps,
      { ...h.durability, workerId: "delivery-finaliser-b" },
    );
    expect(completed, JSON.stringify(completed)).toMatchObject({ decision: "completed" });
    expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 1, final: 1 });
    expect(await getDeliveryFinalisationStatus(
      h.store,
      h.fixture.authorization.jobId,
      2,
    )).toMatchObject({
      status: "ok",
      milestone: "fulfilment-finalised",
      deliveryReady: "outcome",
      publicationStarted: "outcome",
      evidence: "outcome",
      finalReceipt: "outcome",
      result: "outcome",
    });
    const terminal = await h.store.load(h.fixture.authorization.jobId);
    if (terminal.status !== "ok") throw new Error("delivery-ready terminal WAL missing");
    await expect(projectDurableSellerAuditPending({
      record: terminal.record,
      verifiedAgreement: h.fixture.agreement,
      verifiedListing: h.fixture.listing,
      expectedDeliveryWriter: { role: "seller", primaryClaim: SELLER },
      verifyEvidenceSignature: h.deps.verifyEvidenceSignature,
      verifyAuditSourceCommitmentSignature:
        h.deps.verifyAuditSourceCommitmentSignature,
      verifyAnchorReceipt: h.deps.verifyAnchorReceipt,
    })).resolves.toMatchObject({
      terminal: { result: { decision: "completed" } },
      session: { state: "audit-pending" },
    });

    const replay = await resumeDeliveryFinalisation(
      h.fixture.authorization.jobId,
      h.fixture.request,
      h.deps,
      { ...h.durability, workerId: "delivery-finaliser-c" },
    );
    expect(replay).toEqual(completed);
    expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 1, final: 1 });
  });

  test("rejects rebound finalisation authority before publishing evidence", async () => {
    const h = durableHarness();
    const ready = await runDurableFulfilmentToDeliveryReady(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    if (ready.status !== "delivery-ready") throw new Error("delivery was not ready");

    const rebound = await advanceDeliveryFinalisation(
      { ...ready.finalisation, evidenceHash: "0".repeat(64) },
      h.fixture.request,
      h.deps,
      { ...h.durability, workerId: "rebound-finaliser" },
    );
    expect(rebound).toMatchObject({
      decision: "indeterminate",
      code: "durable-finalisation-authority-invalid",
      safeToRetryDelivery: false,
    });
    expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 0, final: 0 });

    const wrongJob = await resumeDeliveryFinalisation(
      "01J8ME0SXKQ4T9V2RC5HJ6WX7E",
      h.fixture.request,
      h.deps,
      { ...h.durability, workerId: "wrong-job-finaliser" },
    );
    expect(wrongJob).toMatchObject({
      decision: "indeterminate",
      code: "durable-finalisation-authority-invalid",
    });
    expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 0, final: 0 });
  });

  test("resumes the delivery-ready handoff from a reopened filesystem store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dacs-delivery-ready-restart-"));
    try {
      const processAStore = await createFsFencedSessionStore({ dir });
      const h = durableHarness(undefined, { store: processAStore });
      const ready = await runDurableFulfilmentToDeliveryReady(
        h.fixture.request,
        h.deps,
        h.durability,
      );
      if (ready.status !== "delivery-ready") throw new Error("delivery was not ready");
      expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 0, final: 0 });

      const processBStore = await createFsFencedSessionStore({ dir });
      const completed = await resumeDeliveryFinalisation(
        h.fixture.authorization.jobId,
        h.fixture.request,
        h.deps,
        {
          ...h.durability,
          store: processBStore,
          workerId: "restarted-delivery-finaliser",
        },
      );
      expect(completed, JSON.stringify(completed)).toMatchObject({ decision: "completed" });
      expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 1, final: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fences concurrent finalisers and preserves exactly-once effects", async () => {
    const h = durableHarness();
    const ready = await runDurableFulfilmentToDeliveryReady(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    if (ready.status !== "delivery-ready") throw new Error("delivery was not ready");

    const attempts = await Promise.all([
      advanceDeliveryFinalisation(
        ready.finalisation,
        h.fixture.request,
        h.deps,
        { ...h.durability, workerId: "concurrent-finaliser-a" },
      ),
      advanceDeliveryFinalisation(
        ready.finalisation,
        h.fixture.request,
        h.deps,
        { ...h.durability, workerId: "concurrent-finaliser-b" },
      ),
    ]);
    expect(attempts.some((value) => value.decision === "completed")).toBe(true);
    const terminal = await resumeDeliveryFinalisation(
      h.fixture.authorization.jobId,
      h.fixture.request,
      h.deps,
      { ...h.durability, workerId: "concurrent-finaliser-c" },
    );
    expect(terminal).toMatchObject({ decision: "completed" });
    expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 1, final: 1 });
  });

  test("reconciles ambiguity after finaliser activation instead of reusing the deferral", async () => {
    const h = durableHarness();
    const ready = await runDurableFulfilmentToDeliveryReady(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    if (ready.status !== "delivery-ready") throw new Error("delivery was not ready");
    h.loseAfter.add("evidence");

    const ambiguous = await advanceDeliveryFinalisation(
      ready.finalisation,
      h.fixture.request,
      h.deps,
      { ...h.durability, workerId: "ambiguous-finaliser-a" },
    );
    expect(ambiguous).toMatchObject({
      decision: "indeterminate",
      code: "delivery-evidence-publication-pending",
    });
    expect(h.counts.evidence).toBe(1);

    const recovered = await resumeDeliveryFinalisation(
      h.fixture.authorization.jobId,
      h.fixture.request,
      h.deps,
      { ...h.durability, workerId: "ambiguous-finaliser-b" },
    );
    expect(recovered).toMatchObject({ decision: "completed" });
    expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 1, final: 1 });
  });

  test.each(["intent", "outcome"] as const)(
    "recovers a lost delivery-ready %s store response without publishing early",
    async (lostStage) => {
      const baseStore = createInMemoryFencedSessionStore();
      let loseResponse = true;
      const unstableStore = proxyFencedStore(baseStore, {
        claimCheckpoint: async (input) => {
          const claimed = await baseStore.claimCheckpoint(input);
          if (loseResponse && lostStage === "intent" && claimed.ok &&
              input.key === sellerFulfilmentCheckpointKey.deliveryReady(2)) {
            loseResponse = false;
            throw new Error("delivery-ready intent response lost");
          }
          return claimed;
        },
        transition: async (input) => {
          const transitioned = await baseStore.transition(input);
          if (loseResponse && lostStage === "outcome" && transitioned.ok &&
              input.checkpoint?.key === sellerFulfilmentCheckpointKey.deliveryReady(2) &&
              input.checkpoint.stage === "outcome") {
            loseResponse = false;
            throw new Error("delivery-ready outcome response lost");
          }
          return transitioned;
        },
      });
      const h = durableHarness(undefined, { store: unstableStore });
      const interrupted = await runDurableFulfilmentToDeliveryReady(
        h.fixture.request,
        h.deps,
        h.durability,
      );
      expect(interrupted).toMatchObject({
        status: "not-ready",
        result: {
          decision: "indeterminate",
          code: "durable-delivery-ready-projection-failed",
        },
      });
      expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 0, final: 0 });

      const recovered = await runDurableFulfilmentToDeliveryReady(
        h.fixture.request,
        h.deps,
        { ...h.durability, store: baseStore, workerId: `ready-${lostStage}-recovery` },
      );
      expect(recovered.status).toBe("delivery-ready");
      expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 0, final: 0 });
    },
  );

  test.each(["intent", "outcome"] as const)(
    "recovers a lost finalisation-activation %s store response without duplicate evidence",
    async (lostStage) => {
      const baseStore = createInMemoryFencedSessionStore();
      let loseResponse = true;
      const activationKey = sellerFulfilmentCheckpointKey
        .deliveryFinalisationStarted(2);
      const unstableStore = proxyFencedStore(baseStore, {
        claimCheckpoint: async (input) => {
          const claimed = await baseStore.claimCheckpoint(input);
          if (loseResponse && lostStage === "intent" && claimed.ok &&
              input.key === activationKey) {
            loseResponse = false;
            throw new Error("finalisation activation intent response lost");
          }
          return claimed;
        },
        transition: async (input) => {
          const transitioned = await baseStore.transition(input);
          if (loseResponse && lostStage === "outcome" && transitioned.ok &&
              input.checkpoint?.key === activationKey &&
              input.checkpoint.stage === "outcome") {
            loseResponse = false;
            throw new Error("finalisation activation outcome response lost");
          }
          return transitioned;
        },
      });
      const h = durableHarness(undefined, { store: unstableStore });
      const ready = await runDurableFulfilmentToDeliveryReady(
        h.fixture.request,
        h.deps,
        h.durability,
      );
      if (ready.status !== "delivery-ready") throw new Error("delivery was not ready");

      const interrupted = await advanceDeliveryFinalisation(
        ready.finalisation,
        h.fixture.request,
        h.deps,
        { ...h.durability, workerId: `activation-${lostStage}-interrupted` },
      );
      expect(interrupted).toMatchObject({
        decision: "indeterminate",
        code: "delivery-evidence-publication-pending",
      });
      expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 0, final: 0 });
      expect(await getDeliveryFinalisationStatus(
        baseStore,
        h.fixture.authorization.jobId,
        2,
      )).toMatchObject({
        status: "ok",
        milestone: "delivery-ready",
        publicationStarted: lostStage,
        evidence: "intent",
      });

      const reconcileAuthoritativeAbsence = vi.fn(async () => ({
        status: "absent" as const,
        reason: "fenced evidence slot is authoritatively absent",
      }));
      if (lostStage === "outcome") {
        // Once activation itself is durable, a restart cannot infer whether the
        // old worker reached the publisher. The binding-owned reconciler must
        // fence the old generation and prove absence before the retained input
        // can be invoked.
        h.durability.reconcileEvidencePublication = reconcileAuthoritativeAbsence;
      }
      const recovered = await resumeDeliveryFinalisation(
        h.fixture.authorization.jobId,
        h.fixture.request,
        h.deps,
        {
          ...h.durability,
          store: baseStore,
          workerId: `activation-${lostStage}-recovery`,
        },
      );
      expect(recovered).toMatchObject({ decision: "completed" });
      expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 1, final: 1 });
      expect(reconcileAuthoritativeAbsence).toHaveBeenCalledTimes(
        lostStage === "outcome" ? 1 : 0,
      );
    },
  );

  test("captures optional effects and durability authority exactly once before the first await", async () => {
    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;
    const h = durableHarness(spec);
    const dependencyReads = new Map<PropertyKey, number>();
    const durabilityReads = new Map<PropertyKey, number>();
    let crossedAwaitBoundary = false;
    const receiptSource = h.deps.receiptStore;
    const inspectPermit = receiptSource.inspectPermit.bind(receiptSource);
    const receiptProxy = new Proxy(receiptSource, {
      get(target, property, receiver) {
        if (property === "inspectPermit") {
          return async (permitId: string) => {
            crossedAwaitBoundary = true;
            return inspectPermit(permitId);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const safeAnchor = h.deps.anchorPayloadAttestation!;
    const maliciousAnchor = vi.fn(async () => ({
      status: "rejected" as const,
      reason: "late dependency getter replaced the captured publisher",
    }));
    const proxiedDeps = new Proxy(h.deps, {
      get(target, property, receiver) {
        if (crossedAwaitBoundary) {
          throw new Error(`dependency ${String(property)} was dereferenced after the first await`);
        }
        const reads = (dependencyReads.get(property) ?? 0) + 1;
        dependencyReads.set(property, reads);
        if (property === "receiptStore") return receiptProxy;
        if (property === "anchorPayloadAttestation") {
          return reads === 1 ? safeAnchor : maliciousAnchor;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const safeLeaseClock = vi.fn(() => NOW);
    const maliciousLeaseClock = vi.fn(() => 0);
    const proxiedDurability = new Proxy(h.durability, {
      get(target, property, receiver) {
        if (crossedAwaitBoundary) {
          throw new Error(`durability ${String(property)} was dereferenced after the first await`);
        }
        const reads = (durabilityReads.get(property) ?? 0) + 1;
        durabilityReads.set(property, reads);
        if (property === "workerId") {
          return reads === 1 ? "snapshot-worker" : "late-worker";
        }
        if (property === "leaseTtlMs") return reads === 1 ? 60_000 : -1;
        if (property === "leaseNowMs") {
          return reads === 1 ? safeLeaseClock : maliciousLeaseClock;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const completed = await runDurableFulfilmentCore(
      h.fixture.request,
      proxiedDeps,
      proxiedDurability,
    );
    expect(completed, JSON.stringify(completed)).toMatchObject({ decision: "completed" });
    expect(dependencyReads.get("anchorPayloadAttestation")).toBe(1);
    expect(durabilityReads.get("store")).toBe(1);
    expect(durabilityReads.get("workerId")).toBe(1);
    expect(durabilityReads.get("leaseTtlMs")).toBe(1);
    expect(durabilityReads.get("leaseNowMs")).toBe(1);
    expect(maliciousAnchor).not.toHaveBeenCalled();
    expect(maliciousLeaseClock).not.toHaveBeenCalled();
    expect(safeLeaseClock).toHaveBeenCalled();
    expect(Object.values(h.fences).flat().every(
      (fence) => fence.owner === "snapshot-worker",
    )).toBe(true);
  });

  test("does not create or reserve a session while the permit remains available", async () => {
    const h = durableHarness();
    h.fixture.deps.prepareDelivery = async () => ({
      status: "indeterminate",
      reason: "candidate preparation is still reversible",
    });
    h.deps.prepareDelivery = h.fixture.deps.prepareDelivery;

    const result = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );

    expect(result.decision).toBe("indeterminate");
    expect(await h.store.load(h.fixture.authorization.jobId)).toEqual({ status: "missing" });
    expect(h.counts).toEqual({ payload: 0, delivery: 0, evidence: 0, final: 0 });
  });

  test.each(["lease-contention", "corrupt-load"] as const)(
    "includes exact consumed authority on $failure initialization failure",
    async (failure) => {
      const h = durableHarness(undefined, { initiallyConsumed: true });
      let store = h.store;
      if (failure === "lease-contention") {
        await store.create({
          jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
          agreementHash: h.fixture.authorization.agreementHash,
          phase: "created",
          now: NOW,
        });
        const held = await store.acquireLease({
          jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
          owner: "another-live-worker",
          ttlMs: 60_000,
          sellerPhaseIndex: 1,
          now: NOW,
        });
        if (!held.ok) throw new Error("failed to create lease-contention fixture");
      } else {
        store = proxyFencedStore(store, {
          load: async () => ({ status: "corrupt", reason: "synthetic corrupt history" }),
        });
      }

      const result = await runDurableFulfilmentCore(
        h.fixture.request,
        h.deps,
        { ...h.durability, store },
      );
      expect(result).toMatchObject({
        decision: "indeterminate",
        code: "durable-permit-inspection-failed",
        safeToRetryDelivery: false,
        consumedPaymentAuthorization: h.fixture.authorization,
      });
      expect(h.counts).toEqual({ payload: 0, delivery: 0, evidence: 0, final: 0 });
    },
  );

  test("retains consumed authority when initialization fails after atomic consumption", async () => {
    const h = durableHarness();
    const unavailable = proxyFencedStore(h.store, {
      load: async () => {
        throw new Error("durable store unavailable after permit consumption");
      },
    });
    const consume = vi.spyOn(h.fixture.store, "consumePermit");

    const result = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      { ...h.durability, store: unavailable },
    );
    expect(result).toMatchObject({
      decision: "indeterminate",
      code: "durable-fulfilment-failed",
      safeToRetryDelivery: false,
      consumedPaymentAuthorization: h.fixture.authorization,
    });
    expect(consume).toHaveBeenCalledTimes(1);
    expect(h.fixture.store.consumed).toBe(true);
    expect(h.counts).toEqual({ payload: 0, delivery: 0, evidence: 0, final: 0 });
  });

  test("never exposes a plain rejection after durable inspection proves consumption", async () => {
    const h = durableHarness(undefined, { initiallyConsumed: true });
    h.deps.resolveAgreement = async () => ({
      status: "rejected",
      reason: "agreement resolver rejected a paid restart",
    });
    const result = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    expect(result).toMatchObject({
      decision: "indeterminate",
      safeToRetryDelivery: false,
      consumedPaymentAuthorization: h.fixture.authorization,
    });
    expect(result.decision).not.toBe("rejected");
  });

  test("derives the complete immutable binding only from the consumed handoff", async () => {
    const h = durableHarness();
    const result = await runDurableFulfilmentCore(h.fixture.request, h.deps, h.durability);
    expect(result.decision).toBe("completed");
    const loaded = await h.store.load(h.fixture.authorization.jobId);
    if (loaded.status !== "ok") throw new Error("session missing");
    const [binding] = loaded.record.paymentAuthorizations;
    expect(binding).toMatchObject({
      authorizationHash: sha256Hex(canonicalize(h.fixture.authorization)),
      agreementHash: h.fixture.authorization.agreementHash,
      paymentEvidenceHash: h.fixture.authorization.evidenceHash,
      settlementId: h.fixture.authorization.settlementId,
      paymentPhaseIndex: 1,
      deliveryPhaseIndex: 2,
    });
    expect(binding?.fulfilmentId).toMatch(/^[0-9a-f]{64}$/);
    expect(binding?.handoffBindingHash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 1, final: 1 });
    for (const name of ["delivery", "evidence", "final"] as const) {
      expect(h.fences[name]).toEqual([{
        owner: "worker-a",
        generation: 1,
        idempotencyKey: expect.any(String),
      }]);
    }
  });

  test("authenticates an actual durable completion through every bundle phase", async () => {
    const h = durableHarness();
    const completed = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    if (completed.decision !== "completed") throw new Error("expected completion");
    const loaded = await h.store.load(h.fixture.authorization.jobId);
    if (loaded.status !== "ok") throw new Error("session missing");
    const binding = loaded.record.paymentAuthorizations[0];
    if (!binding) throw new Error("payment authorization binding missing");
    const resultCheckpoint = loaded.record.checkpoints.find(
      (checkpoint) =>
        checkpoint.key === sellerFulfilmentCheckpointKey.result(
          binding.deliveryPhaseIndex,
        ) &&
        checkpoint.stage === "outcome",
    );
    const verifyEvidenceSignature = vi.fn(h.deps.verifyEvidenceSignature);
    const verifyAnchorReceipt = vi.fn(h.deps.verifyAnchorReceipt);
    const phases = [
      "seller:bundle-signing",
      "seller:bundle-anchor-pending",
      "seller:bundle-binding-signing",
      "seller:bundle-binding-publication-pending",
      "seller:finalised",
    ] as const;

    let lastVerified: Awaited<ReturnType<typeof verifyDurableSellerTerminalResult>> | undefined;
    for (const phase of phases) {
      const record = structuredClone(loaded.record);
      record.phase = phase;
      lastVerified = await verifyDurableSellerTerminalResult({
        record,
        suppliedResult: completed,
        expectedDeliveryWriter: { role: "seller", primaryClaim: SELLER },
        verifyEvidenceSignature,
        verifyAuditSourceCommitmentSignature:
          h.deps.verifyAuditSourceCommitmentSignature,
        verifyAnchorReceipt,
      });
      expect(lastVerified.result).toEqual(completed);
      expect(lastVerified.binding).toEqual(binding);
      expect(lastVerified.resultHash).toBe(resultCheckpoint?.data?.resultHash);
      expect(lastVerified.finalReceiptHash).toBe(resultCheckpoint?.data?.finalReceiptHash);
    }

    expect(verifyEvidenceSignature).toHaveBeenCalledTimes(phases.length);
    // Each read-only pass authenticates both the evidence publication and the
    // independently read delivery anchor retained in the WAL.
    expect(verifyAnchorReceipt).toHaveBeenCalledTimes(phases.length * 2);
    if (!lastVerified) throw new Error("terminal verification missing");
    lastVerified.result.evidence.signature.value = "mutated";
    lastVerified.binding.authorizationHash = "0".repeat(64);
    lastVerified.handoff.jobId = "mutated";
    expect(completed.evidence.signature.value).not.toBe("mutated");
    expect(loaded.record.paymentAuthorizations[0]?.authorizationHash).not.toBe(
      "0".repeat(64),
    );
    expect(loaded.record.jobId).toBe(h.fixture.authorization.jobId);
  });

  test("rejects every retained terminal tamper case through the read-only verifier", async () => {
    const h = durableHarness();
    const completed = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    if (completed.decision !== "completed") throw new Error("expected completion");
    const loaded = await h.store.load(h.fixture.authorization.jobId);
    if (loaded.status !== "ok") throw new Error("session missing");
    for (const tamperCase of terminalTamperCases) {
      const record = structuredClone(loaded.record);
      tamperCase.tamper(record);
      await expect(verifyDurableSellerTerminalResult({
        record,
        suppliedResult: completed,
        expectedDeliveryWriter: { role: "seller", primaryClaim: SELLER },
        verifyEvidenceSignature: h.deps.verifyEvidenceSignature,
        verifyAuditSourceCommitmentSignature:
          h.deps.verifyAuditSourceCommitmentSignature,
        verifyAnchorReceipt: h.deps.verifyAnchorReceipt,
      }), tamperCase.label).rejects.toThrow();
    }

    const reboundResult = structuredClone(completed);
    reboundResult.bundleContribution.phaseSummary.attestationRef.anchor.locator =
      "dacs4:test-delivery-evidence:rebound-result";
    await expect(verifyDurableSellerTerminalResult({
      record: loaded.record,
      suppliedResult: reboundResult,
      expectedDeliveryWriter: { role: "seller", primaryClaim: SELLER },
      verifyEvidenceSignature: h.deps.verifyEvidenceSignature,
      verifyAuditSourceCommitmentSignature:
        h.deps.verifyAuditSourceCommitmentSignature,
      verifyAnchorReceipt: h.deps.verifyAnchorReceipt,
    })).rejects.toThrow("supplied completion is not the exact durable terminal result");
  });

  test.each(["signature", "anchor-receipt"] as const)(
    "read-only terminal verification rejects an unauthenticated %s",
    async (target) => {
      const h = durableHarness();
      const completed = await runDurableFulfilmentCore(
        h.fixture.request,
        h.deps,
        h.durability,
      );
      if (completed.decision !== "completed") throw new Error("expected completion");
      const loaded = await h.store.load(h.fixture.authorization.jobId);
      if (loaded.status !== "ok") throw new Error("session missing");
      const rejected = vi.fn(async () => ({
        disposition: "invalid" as const,
        reason: `${target} is not authentic`,
      }));

      await expect(verifyDurableSellerTerminalResult({
        record: loaded.record,
        suppliedResult: completed,
        expectedDeliveryWriter: { role: "seller", primaryClaim: SELLER },
        verifyEvidenceSignature: target === "signature"
          ? rejected
          : h.deps.verifyEvidenceSignature,
        verifyAuditSourceCommitmentSignature:
          h.deps.verifyAuditSourceCommitmentSignature,
        verifyAnchorReceipt: target === "anchor-receipt"
          ? rejected
          : h.deps.verifyAnchorReceipt,
      })).rejects.toThrow(/not authenticated/);
      expect(rejected).toHaveBeenCalledTimes(1);
    },
  );

  test("terminal replay is exact, clone-isolated, and invokes no effect twice", async () => {
    const h = durableHarness();
    const first = await runDurableFulfilmentCore(h.fixture.request, h.deps, h.durability);
    const firstSnapshot = structuredClone(first);
    if (first.decision !== "completed") throw new Error("expected completion");
    first.evidence.signature.value = "mutated";
    first.evidenceAnchorReceipt.evidence.value = "mutated";
    first.bundleContribution.phaseSummary.attestationRef.anchor.locator = "mutated";
    h.finalReceipt.bytes[0] = 99;

    const second = await runDurableFulfilmentCore(h.fixture.request, h.deps, h.durability);
    expect(second).toEqual(firstSnapshot);
    expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 1, final: 1 });
    expect(second).not.toBe(first);
  });

  test.each(["signature", "anchor-receipt"] as const)(
    "terminal replay re-authenticates the evidence %s before returning success",
    async (target) => {
      const h = durableHarness();
      const completed = await runDurableFulfilmentCore(
        h.fixture.request,
        h.deps,
        h.durability,
      );
      expect(completed.decision).toBe("completed");
      const rejected = vi.fn(async () => ({
        disposition: "invalid" as const,
        reason: `${target} no longer authenticates`,
      }));
      if (target === "signature") {
        h.deps.verifyEvidenceSignature = rejected;
      } else {
        h.deps.verifyAnchorReceipt = rejected;
      }

      const replay = await runDurableFulfilmentCore(
        h.fixture.request,
        h.deps,
        { ...h.durability, workerId: "worker-reauth" },
      );
      expect(replay).toMatchObject({
        decision: "indeterminate",
        code: "durable-permit-inspection-failed",
        safeToRetryDelivery: false,
      });
      expect(rejected).toHaveBeenCalledTimes(1);
      expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 1, final: 1 });
    },
  );

  test.each(["memory", "filesystem"] as const)(
    "replays an earlier completed phase after later progress and finalisation in %s",
    async (backend) => {
      const dir = backend === "filesystem"
        ? await mkdtemp(join(tmpdir(), "dacs-pr121-phase-replay-"))
        : undefined;
      try {
        const store = dir
          ? await createFsFencedSessionStore({ dir })
          : createInMemoryFencedSessionStore();
        const h = durableHarness(undefined, { store });
        const completed = await runDurableFulfilmentCore(
          h.fixture.request,
          h.deps,
          h.durability,
        );
        expect(completed.decision).toBe("completed");

        const laterLease = await store.acquireLease({
          jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
          owner: "later-phase-worker",
          ttlMs: 1_000,
          sellerPhaseIndex: 3,
          now: NOW + 1,
        });
        if (!laterLease.ok) throw new Error("later phase lease missing");
        const pending = await store.transition({
          jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
          expectedRevision: laterLease.record.revision,
          leaseToken: laterLease.lease,
          phase: "seller:validation-pending:3",
          now: NOW + 2,
        });
        if (!pending.ok) throw new Error(`later pending phase failed: ${pending.reason}`);
        expect(await runDurableFulfilmentCore(
          h.fixture.request,
          h.deps,
          { ...h.durability, store, workerId: "prior-replay-pending" },
        )).toEqual(completed);

        const laterComplete = await store.transition({
          jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
          expectedRevision: pending.record.revision,
          leaseToken: laterLease.lease,
          phase: "seller:delivery-completed:3",
          lease: null,
          now: NOW + 3,
        });
        if (!laterComplete.ok) {
          throw new Error(`later completion failed: ${laterComplete.reason}`);
        }
        expect(await runDurableFulfilmentCore(
          h.fixture.request,
          h.deps,
          { ...h.durability, store, workerId: "prior-replay-complete" },
        )).toEqual(completed);

        const finaliseLease = await store.acquireLease({
          jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
          owner: "bundle-finaliser",
          ttlMs: 1_000,
          now: NOW + 4,
        });
        if (!finaliseLease.ok) throw new Error("finalisation lease missing");
        const finalised = await store.transition({
          jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
          expectedRevision: finaliseLease.record.revision,
          leaseToken: finaliseLease.lease,
          phase: "seller:finalised",
          lease: null,
          now: NOW + 5,
        });
        if (!finalised.ok) throw new Error(`finalisation failed: ${finalised.reason}`);
        expect(await runDurableFulfilmentCore(
          h.fixture.request,
          h.deps,
          { ...h.durability, store, workerId: "prior-replay-finalised" },
        )).toEqual(completed);
        expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 1, final: 1 });
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test("replays a failed phase after the session is globally finalised", async () => {
    const h = durableHarness();
    let reconciliationCalls = 0;
    h.deps.reconcileDelivery = async () => {
      reconciliationCalls += 1;
      return reconciliationCalls === 1
        ? { status: "absent", reason: "authoritative absence" }
        : {
            status: "failed",
            reason: "delivery substrate recorded failure",
            reconciliationId: "delivery:01J8ME0SXKQ4T9V2RC5HJ6WX7D:1",
            observedAt: NOW,
          };
    };
    const failed = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    expect(failed.decision).toBe("failed");
    if (failed.decision !== "failed") throw new Error("failed result missing");
    await publishFailedTerminalBundle(h.store, failed);
    expect(await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      { ...h.durability, workerId: "failed-replay" },
    )).toEqual(failed);
  });

  test("does not rebind a failed replay to a terminal bundle for another phase index", async () => {
    const h = durableHarness();
    let reconciliationCalls = 0;
    h.deps.reconcileDelivery = async () => {
      reconciliationCalls += 1;
      return reconciliationCalls === 1
        ? { status: "absent", reason: "authoritative absence" }
        : {
            status: "failed",
            reason: "delivery substrate recorded failure",
            reconciliationId: "delivery:01J8ME0SXKQ4T9V2RC5HJ6WX7D:1",
            observedAt: NOW,
          };
    };
    const failed = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    if (failed.decision !== "failed") throw new Error("failed result missing");
    await publishFailedTerminalBundle(h.store, failed, {
      sourcePhaseIndex: failed.bundleContribution.phaseSummary.index + 1,
    });

    expect(await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      { ...h.durability, workerId: "wrong-source-replay" },
    )).toMatchObject({
      decision: "indeterminate",
      code: "durable-permit-inspection-failed",
      reasons: [expect.stringContaining("missing or rebound receipt/phase")],
      safeToRetryDelivery: false,
    });
  });

  test("status projects the indexed terminal spine without exposing mutable store state", async () => {
    const h = durableHarness();
    const result = await runDurableFulfilmentCore(h.fixture.request, h.deps, h.durability);
    expect(result.decision).toBe("completed");

    const status = await getSellerFulfilmentStatus(h.store, "01J8ME0SXKQ4T9V2RC5HJ6WX7D", 2);
    expect(status).toMatchObject({
      status: "ok",
      jobId: "01J8ME0SXKQ4T9V2RC5HJ6WX7D",
      phase: "seller:delivery-completed:2",
      delivery: "outcome",
      evidence: "outcome",
      receipts: {
        agreement: "agreement:01J8ME0SXKQ4T9V2RC5HJ6WX7D",
        "settlement:1": h.fixture.authorization.settlementId,
        "delivery:2": "dacs4:test-delivery-evidence:01J8ME0SXKQ4T9V2RC5HJ6WX7D",
        "fulfilment:2": expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    if (status.status !== "ok") throw new Error("status missing");
    status.receipts["fulfilment:2"] = "mutated";
    status.receipts["delivery:2"] = "mutated";
    const reloaded = await getSellerFulfilmentStatus(h.store, "01J8ME0SXKQ4T9V2RC5HJ6WX7D", 2);
    expect(reloaded).toMatchObject({
      status: "ok",
      receipts: {
        agreement: "agreement:01J8ME0SXKQ4T9V2RC5HJ6WX7D",
        "settlement:1": h.fixture.authorization.settlementId,
        "delivery:2": "dacs4:test-delivery-evidence:01J8ME0SXKQ4T9V2RC5HJ6WX7D",
        "fulfilment:2": expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
  });

  test.each(["delivery", "evidence", "final"] as const)(
    "recovers %s response loss without repeating application work",
    async (lostEffect) => {
      const h = durableHarness();
      h.loseAfter.add(lostEffect);
      const first = await runDurableFulfilmentCore(h.fixture.request, h.deps, h.durability);
      expect(first.decision).toBe("indeterminate");

      const second = await runDurableFulfilmentCore(h.fixture.request, h.deps, {
        ...h.durability,
        workerId: "worker-b",
      });
      expect(second.decision).toBe("completed");
      expect(h.counts[lostEffect]).toBe(1);
      expect(h.fences[lostEffect][0]).toMatchObject({ owner: "worker-a", generation: 1 });
      const status = await getSellerFulfilmentStatus(h.store, "01J8ME0SXKQ4T9V2RC5HJ6WX7D", 2);
      expect(status).toMatchObject({
        status: "ok",
        receipts: {
          agreement: "agreement:01J8ME0SXKQ4T9V2RC5HJ6WX7D",
          "settlement:1": h.fixture.authorization.settlementId,
          "delivery:2": "dacs4:test-delivery-evidence:01J8ME0SXKQ4T9V2RC5HJ6WX7D",
          "fulfilment:2": expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      });
    },
  );

  test("replays a committed terminal delivery reconciliation after its store response is lost", async () => {
    const baseStore = createInMemoryFencedSessionStore();
    let crashAfterReconciliation = true;
    const unstableStore = proxyFencedStore(baseStore, {
      transition: async (input) => {
        const transitioned = await baseStore.transition(input);
        if (crashAfterReconciliation && transitioned.ok &&
            input.checkpoint?.key ===
              sellerFulfilmentCheckpointKey.deliveryReconciliation(2) &&
            input.checkpoint.stage === "outcome") {
          crashAfterReconciliation = false;
          throw new Error("delivery reconciliation response lost after durable commit");
        }
        return transitioned;
      },
    });
    const h = durableHarness(undefined, { store: unstableStore });
    const interruptedRecovery = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    expect(interruptedRecovery.decision).toBe("indeterminate");
    const committed = await baseStore.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (committed.status !== "ok") throw new Error("reconciliation session missing");
    const reconciliationOutcome = committed.record.checkpoints.find(
      (checkpoint) => checkpoint.key ===
          sellerFulfilmentCheckpointKey.deliveryReconciliation(2) &&
        checkpoint.stage === "outcome",
    );
    expect(reconciliationOutcome?.data).toMatchObject({
      observationHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      observation: expect.any(String),
    });
    const deliveryOutcome = committed.record.checkpoints.find(
      (checkpoint) => checkpoint.key === sellerFulfilmentCheckpointKey.delivery(2) &&
        checkpoint.stage === "outcome",
    );
    expect(deliveryOutcome?.data).toMatchObject({
      outputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      output: expect.any(String),
    });

    const unavailable = vi.fn(async () => {
      throw new Error("delivery reconciler unavailable after durable terminal observation");
    });
    h.deps.reconcileDelivery = unavailable;
    const recovered = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      { ...h.durability, store: baseStore, workerId: "worker-reconciliation-replay" },
    );
    expect(recovered.decision).toBe("completed");
    expect(unavailable).not.toHaveBeenCalled();
    expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 1, final: 1 });
  });

  test("promotes a terminal reconciliation whose intent response was lost", async () => {
    const baseStore = createInMemoryFencedSessionStore();
    let crashAfterObservationIntent = true;
    const unstableStore = proxyFencedStore(baseStore, {
      claimCheckpoint: async (input) => {
        const claimed = await baseStore.claimCheckpoint(input);
        if (crashAfterObservationIntent && claimed.ok && input.key ===
            sellerFulfilmentCheckpointKey.deliveryReconciliation(2)) {
          crashAfterObservationIntent = false;
          throw new Error("reconciliation intent response lost after durable commit");
        }
        return claimed;
      },
    });
    const h = durableHarness(undefined, { store: unstableStore });
    const interrupted = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    expect(interrupted.decision).toBe("indeterminate");
    const committed = await baseStore.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (committed.status !== "ok") throw new Error("reconciliation session missing");
    const observationIntent = committed.record.checkpoints.find(
      (checkpoint) => checkpoint.key ===
          sellerFulfilmentCheckpointKey.deliveryReconciliation(2) &&
        checkpoint.stage === "intent",
    );
    expect(observationIntent?.data).toMatchObject({
      observationHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      observation: expect.any(String),
    });

    const unavailable = vi.fn(async () => {
      throw new Error("delivery reconciler unavailable after retained observation");
    });
    h.deps.reconcileDelivery = unavailable;
    const recovered = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      { ...h.durability, store: baseStore, workerId: "worker-observation-intent" },
    );
    expect(recovered.decision).toBe("completed");
    expect(unavailable).not.toHaveBeenCalled();
    expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 1, final: 1 });
  });

  test("does not durably poison recovery with an out-of-bounds terminal reconciliation", async () => {
    const h = durableHarness();
    let reconciliationCalls = 0;
    h.deps.reconcileDelivery = vi.fn(async () => {
      reconciliationCalls += 1;
      if (reconciliationCalls === 1) {
        return { status: "absent" as const, reason: "authoritative absence" };
      }
      return {
        status: "complete" as const,
        reconciliationId: "delivery:01J8ME0SXKQ4T9V2RC5HJ6WX7D:1",
        observedAt: reconciliationCalls === 2 ? NOW - 20_000 : NOW,
      };
    });

    const invalid = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    expect(invalid).toMatchObject({ decision: "indeterminate", code: "clock-invalid" });
    const afterInvalid = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (afterInvalid.status !== "ok") throw new Error("session missing");
    expect(afterInvalid.record.checkpoints.some(
      (checkpoint) => checkpoint.key ===
        sellerFulfilmentCheckpointKey.deliveryReconciliation(2),
    )).toBe(false);

    const recovered = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      { ...h.durability, workerId: "worker-reconciliation-time-retry" },
    );
    expect(recovered.decision).toBe("completed");
    expect(reconciliationCalls).toBe(3);
    expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 1, final: 1 });
  });

  test("recovers payload-publication response loss from exact raw-record readback", async () => {
    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;
    const h = durableHarness(spec);
    h.loseAfter.add("payload");

    const result = await runDurableFulfilmentCore(h.fixture.request, h.deps, h.durability);
    expect(result.decision).toBe("completed");
    expect(h.counts).toEqual({ payload: 1, delivery: 1, evidence: 1, final: 1 });
    const loaded = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (loaded.status !== "ok") throw new Error("session missing");
    const publication = loaded.record.checkpoints.filter(
      (checkpoint) => checkpoint.key === sellerFulfilmentCheckpointKey.payloadPublication(2),
    );
    const readback = loaded.record.checkpoints.filter(
      (checkpoint) => checkpoint.key === sellerFulfilmentCheckpointKey.payloadReadback(2),
    );
    expect(publication.map((checkpoint) => checkpoint.stage)).toEqual(["intent", "outcome"]);
    expect(readback.map((checkpoint) => checkpoint.stage)).toEqual(["intent", "outcome"]);
  });

  test.each(["payload", "delivery", "evidence"] as const)(
    "does not persist a malformed %s readback and completes after a healthy restart",
    async (target) => {
      const spec = target === "payload"
        ? {
            kind: "attested-payload" as const,
            payloadFormat: "application/json",
            verificationMethod: { kind: "self-signed" as const },
          }
        : { kind: "storage-program" as const, accessModel: "public" as const };
      const h = durableHarness(spec);
      h.deps.reconcileDelivery = async () => h.committed.delivery
        ? { status: "complete", reconciliationId: "delivery:01J8ME0SXKQ4T9V2RC5HJ6WX7D:1", observedAt: NOW }
        : { status: "absent", reason: "authoritative delivery absence" };
      let resolverCalls = 0;
      if (target === "payload") {
        h.loseAfter.add("payload");
        const healthy = h.deps.resolvePayloadAttestation!;
        h.deps.resolvePayloadAttestation = async (ref) => {
          resolverCalls += 1;
          const result = await healthy(ref);
          if (resolverCalls !== 1 || result.status !== "verified") return result;
          const malformed = structuredClone(result);
          malformed.value.anchorReceipt.logicalAddress = "dacs4:payload-attestation:attacker";
          return malformed;
        };
      } else if (target === "delivery") {
        const healthy = h.deps.resolveDelivery;
        h.deps.resolveDelivery = async (input) => {
          resolverCalls += 1;
          const result = await healthy(input);
          if (resolverCalls !== 1 || result.status !== "verified") return result;
          const malformed = structuredClone(result);
          malformed.value.anchorReceipt.logicalAddress = "dacs4:deliverable:attacker";
          return malformed;
        };
      } else {
        const healthy = h.deps.resolveEvidence;
        h.deps.resolveEvidence = async (ref) => {
          resolverCalls += 1;
          const result = await healthy(ref);
          if (resolverCalls !== 1 || result.status !== "verified") return result;
          const malformed = structuredClone(result);
          (malformed.value as SignedSellerDeliveryEvidence).jobId = "job-attacker";
          return malformed;
        };
      }

      const first = await runDurableFulfilmentCore(h.fixture.request, h.deps, h.durability);
      expect(first.decision).toBe("indeterminate");
      expect(resolverCalls).toBe(1);
      const readbackKey = target === "payload"
        ? sellerFulfilmentCheckpointKey.payloadReadback(2)
        : target === "delivery"
          ? sellerFulfilmentCheckpointKey.deliveryReadback(2)
          : sellerFulfilmentCheckpointKey.evidenceReadback(2);
      const afterMalformed = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
      if (afterMalformed.status !== "ok") throw new Error("readback session missing");
      expect(afterMalformed.record.checkpoints.filter(
        (checkpoint) => checkpoint.key === readbackKey,
      ).map((checkpoint) => checkpoint.stage)).toEqual(["intent"]);
      if (target === "payload") {
        expect(afterMalformed.record.checkpoints.filter(
          (checkpoint) => checkpoint.key ===
            sellerFulfilmentCheckpointKey.payloadPublication(2),
        ).map((checkpoint) => checkpoint.stage)).toEqual(["intent"]);
        expect(h.counts).toEqual({ payload: 1, delivery: 0, evidence: 0, final: 0 });
      } else if (target === "delivery") {
        expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 0, final: 0 });
      } else {
        expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 1, final: 0 });
      }

      const recovered = await runDurableFulfilmentCore(h.fixture.request, h.deps, {
        ...h.durability,
        workerId: "worker-healthy-readback",
      });
      expect(recovered, JSON.stringify(recovered)).toMatchObject({ decision: "completed" });
      expect(resolverCalls).toBe(2);
      expect(h.counts).toEqual(target === "payload"
        ? { payload: 1, delivery: 1, evidence: 1, final: 1 }
        : { payload: 0, delivery: 1, evidence: 1, final: 1 });
      const terminal = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
      if (terminal.status !== "ok") throw new Error("recovered readback session missing");
      expect(terminal.record.checkpoints.filter(
        (checkpoint) => checkpoint.key === readbackKey,
      ).map((checkpoint) => checkpoint.stage)).toEqual(["intent", "outcome"]);
      if (target === "payload") {
        expect(terminal.record.checkpoints.filter(
          (checkpoint) => checkpoint.key ===
            sellerFulfilmentCheckpointKey.payloadPublication(2),
        ).map((checkpoint) => checkpoint.stage)).toEqual(["intent", "outcome"]);
      }
    },
  );

  test("recovers consume response loss and never prepares the retained handoff twice", async () => {
    const h = durableHarness();
    const originalConsume = h.fixture.store.consumePermit.bind(h.fixture.store);
    let lose = true;
    h.fixture.store.consumePermit = async (permitId, handoff) => {
      const result = await originalConsume(permitId, handoff);
      if (lose) {
        lose = false;
        throw new Error("consume response lost after atomic handoff commit");
      }
      return result;
    };
    const prepare = vi.fn(h.fixture.deps.prepareDelivery);
    h.fixture.deps.prepareDelivery = prepare;
    h.deps.prepareDelivery = prepare;
    h.deps.reconcileDelivery = async () => h.committed.delivery
      ? { status: "complete", reconciliationId: "delivery:01J8ME0SXKQ4T9V2RC5HJ6WX7D:1", observedAt: NOW }
      : { status: "absent", reason: "authoritative absence" };

    const first = await runDurableFulfilmentCore(h.fixture.request, h.deps, h.durability);
    expect(first).toMatchObject({
      decision: "completed",
      consumedPaymentAuthorization: h.fixture.authorization,
    });
    expect((await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D")).status).toBe("ok");

    const second = await runDurableFulfilmentCore(h.fixture.request, h.deps, {
      ...h.durability,
      workerId: "worker-b",
    });
    expect(second).toEqual(first);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(h.counts.delivery).toBe(1);
  });

  test("finishes a consumed handoff whose durable outcome response was lost", async () => {
    const baseStore = createInMemoryFencedSessionStore();
    let loseHandoffOutcome = true;
    const unstableStore = proxyFencedStore(baseStore, {
      transition: async (input) => {
        if (
          loseHandoffOutcome &&
          input.checkpoint?.key === sellerFulfilmentCheckpointKey.handoff(2) &&
          input.checkpoint.stage === "outcome"
        ) {
          loseHandoffOutcome = false;
          throw new Error("handoff outcome response lost after intent");
        }
        return baseStore.transition(input);
      },
    });
    const h = durableHarness(undefined, { store: unstableStore });
    const prepare = vi.fn(h.fixture.deps.prepareDelivery);
    h.fixture.deps.prepareDelivery = prepare;
    h.deps.prepareDelivery = prepare;
    h.deps.reconcileDelivery = async () => h.committed.delivery
      ? { status: "complete", reconciliationId: "delivery:01J8ME0SXKQ4T9V2RC5HJ6WX7D:1", observedAt: NOW }
      : { status: "absent", reason: "authoritative absence" };

    const first = await runDurableFulfilmentCore(h.fixture.request, h.deps, h.durability);
    expect(first).toMatchObject({
      decision: "completed",
      consumedPaymentAuthorization: h.fixture.authorization,
    });
    expect(h.fixture.store.consumed).toBe(true);
    const afterLoss = await baseStore.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (afterLoss.status !== "ok") throw new Error("session missing after handoff intent");
    expect(afterLoss.record.checkpoints.filter(
      (checkpoint) => checkpoint.key === sellerFulfilmentCheckpointKey.handoff(2),
    ).map((checkpoint) => checkpoint.stage)).toEqual(["intent", "outcome"]);

    const recovered = await runDurableFulfilmentCore(h.fixture.request, h.deps, {
      ...h.durability,
      store: baseStore,
      workerId: "worker-b",
    });
    expect(recovered).toEqual(first);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(h.counts.delivery).toBe(1);
    const afterRecovery = await baseStore.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (afterRecovery.status !== "ok") throw new Error("session missing after recovery");
    expect(afterRecovery.record.checkpoints.filter(
      (checkpoint) => checkpoint.key === sellerFulfilmentCheckpointKey.handoff(2),
    ).map((checkpoint) => checkpoint.stage)).toEqual(["intent", "outcome"]);
  });

  test("a bad retry cannot terminal-poison an ambiguous irreversible delivery", async () => {
    const h = durableHarness();
    h.loseAfter.add("delivery");
    const first = await runDurableFulfilmentCore(h.fixture.request, h.deps, h.durability);
    expect(first).toMatchObject({
      decision: "indeterminate",
      safeToRetryDelivery: false,
    });
    expect(h.counts.delivery).toBe(1);

    const invalidRetry = await runDurableFulfilmentCore({
      ...h.fixture.request,
      agreementHash: "0".repeat(64),
    }, h.deps, {
      ...h.durability,
      workerId: "worker-bad-retry",
    });
    expect(invalidRetry).toMatchObject({
      decision: "indeterminate",
      code: "durable-permit-inspection-failed",
    });
    expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 0, final: 0 });
    const afterBadRetry = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (afterBadRetry.status !== "ok") throw new Error("session missing after bad retry");
    expect(checkpointStateForTest(
      afterBadRetry.record,
      sellerFulfilmentCheckpointKey.result(2),
    )).toBeUndefined();
    expect(afterBadRetry.record.phase).not.toMatch(/delivery-(completed|failed):1$/);

    const recovered = await runDurableFulfilmentCore(h.fixture.request, h.deps, {
      ...h.durability,
      workerId: "worker-valid-retry",
    });
    expect(recovered.decision).toBe("completed");
    expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 1, final: 1 });
    const finalRecord = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (finalRecord.status !== "ok") throw new Error("terminal session missing");
    expect(checkpointStateForTest(
      finalRecord.record,
      sellerFulfilmentCheckpointKey.delivery(2),
    )).toBe("outcome");
    expect(checkpointStateForTest(
      finalRecord.record,
      sellerFulfilmentCheckpointKey.result(2),
    )).toBe("outcome");
  });

  test("rejects mutation of the retained handoff after it has been bound", async () => {
    const h = durableHarness();
    h.loseAfter.add("delivery");
    expect((await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    )).decision).toBe("indeterminate");
    if (!h.fixture.store.handoffValue) throw new Error("handoff missing");
    h.fixture.store.handoffValue.logicalAddress = "dacs4:deliverable:attacker";

    const replay = await runDurableFulfilmentCore(h.fixture.request, h.deps, {
      ...h.durability,
      workerId: "worker-b",
    });
    expect(replay).toMatchObject({
      decision: "indeterminate",
      code: "durable-permit-inspection-failed",
    });
    expect(h.counts.delivery).toBe(1);
  });

  test("stale generation cannot commit or repeat an in-flight delivery effect", async () => {
    const h = durableHarness();
    let now = 0;
    h.durability.leaseTtlMs = 10;
    h.durability.leaseNowMs = () => now;
    h.deps.reconcileDelivery = async () => h.committed.delivery
      ? { status: "complete", reconciliationId: "delivery:01J8ME0SXKQ4T9V2RC5HJ6WX7D:1", observedAt: NOW }
      : { status: "absent", reason: "authoritative absence" };
    let started!: () => void;
    let unblock!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const originalSubmit = h.deps.submitDelivery;
    h.deps.submitDelivery = async (input) => {
      started();
      await blocked;
      return originalSubmit(input);
    };

    const firstPromise = runDurableFulfilmentCore(h.fixture.request, h.deps, h.durability);
    await didStart;
    now = 20;
    const second = await runDurableFulfilmentCore(h.fixture.request, h.deps, {
      ...h.durability,
      workerId: "worker-b",
    });
    expect(second.decision).toBe("indeterminate");
    unblock();
    const first = await firstPromise;
    expect(first.decision).toBe("indeterminate");

    now = 40;
    const third = await runDurableFulfilmentCore(h.fixture.request, h.deps, {
      ...h.durability,
      workerId: "worker-c",
    });
    expect(third.decision).toBe("completed");
    expect(h.counts.delivery).toBe(1);
    expect(h.fences.delivery).toEqual([{
      owner: "worker-a",
      generation: 1,
      idempotencyKey: expect.any(String),
    }]);
    const loaded = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (loaded.status !== "ok") throw new Error("session missing");
    expect(loaded.record.leaseGeneration).toBe(3);
  });

  test.each(["payload", "evidence", "final"] as const)(
    "stale-generation takeover during %s await reconciles without a second effect call",
    async (target) => {
      const spec = target === "payload"
        ? {
            kind: "attested-payload" as const,
            payloadFormat: "application/json",
            verificationMethod: { kind: "self-signed" as const },
          }
        : { kind: "storage-program" as const, accessModel: "public" as const };
      const h = durableHarness(spec);
      let now = 0;
      h.durability.leaseTtlMs = 10;
      h.durability.leaseNowMs = () => now;
      h.deps.reconcileDelivery = async () => h.committed.delivery
        ? { status: "complete", reconciliationId: "delivery:01J8ME0SXKQ4T9V2RC5HJ6WX7D:1", observedAt: NOW }
        : { status: "absent", reason: "authoritative absence" };
      let started!: () => void;
      let unblock!: () => void;
      const didStart = new Promise<void>((resolve) => { started = resolve; });
      const blocked = new Promise<void>((resolve) => { unblock = resolve; });
      if (target === "payload") {
        const original = h.deps.anchorPayloadAttestation!;
        const originalReadback = h.deps.resolvePayloadAttestation!;
        h.deps.resolvePayloadAttestation = async (ref) => h.committed.payload
          ? originalReadback(ref)
          : { status: "indeterminate", reason: "payload publication is not yet visible" };
        h.deps.anchorPayloadAttestation = async (input) => {
          started();
          await blocked;
          return original(input);
        };
      } else if (target === "evidence") {
        const original = h.deps.anchorEvidence;
        h.deps.anchorEvidence = async (input) => {
          started();
          await blocked;
          return original(input);
        };
      } else {
        const original = h.durability.publishFinalSessionReceipt;
        h.durability.publishFinalSessionReceipt = async (input) => {
          started();
          await blocked;
          return original(input);
        };
      }

      const firstPromise = runDurableFulfilmentCore(h.fixture.request, h.deps, h.durability);
      await didStart;
      now = 20;
      const second = await runDurableFulfilmentCore(h.fixture.request, h.deps, {
        ...h.durability,
        workerId: "worker-b",
      });
      expect(second.decision).toBe("indeterminate");
      unblock();
      expect((await firstPromise).decision).toBe("indeterminate");
      now = 40;
      const third = await runDurableFulfilmentCore(h.fixture.request, h.deps, {
        ...h.durability,
        workerId: "worker-c",
      });
      expect(third.decision).toBe("completed");
      expect(h.counts[target]).toBe(1);
      expect(h.fences[target]).toEqual([{
        owner: "worker-a",
        generation: 1,
        idempotencyKey: expect.any(String),
      }]);
    },
  );

  test.each(["payload", "delivery", "evidence", "final"] as const)(
    "recovers a %s crash after intent commit but before invocation",
    async (target) => {
      const spec = target === "payload"
        ? {
            kind: "attested-payload" as const,
            payloadFormat: "application/json",
            verificationMethod: { kind: "self-signed" as const },
          }
        : { kind: "storage-program" as const, accessModel: "public" as const };
      const targetKey = target === "payload"
        ? sellerFulfilmentCheckpointKey.payloadPublication(2)
        : target === "delivery"
          ? sellerFulfilmentCheckpointKey.delivery(2)
          : target === "evidence"
            ? sellerFulfilmentCheckpointKey.evidencePublication(2)
            : sellerFulfilmentCheckpointKey.finalReceipt(2);
      const baseStore = createInMemoryFencedSessionStore();
      let crashAfterClaim = true;
      const crashedStore = proxyFencedStore(baseStore, {
        claimCheckpoint: async (input) => {
          const claimed = await baseStore.claimCheckpoint(input);
          if (crashAfterClaim && input.key === targetKey && claimed.ok) {
            crashAfterClaim = false;
            throw new Error(`${target} process crashed after committing its intent`);
          }
          return claimed;
        },
        transition: async (input) => {
          if (!crashAfterClaim && input.lease === null) {
            throw new Error("crashed worker cannot release its lease");
          }
          return baseStore.transition(input);
        },
      });
      const h = durableHarness(spec, { store: crashedStore });
      let now = NOW;
      h.durability.leaseTtlMs = 10;
      h.durability.leaseNowMs = () => now;
      if (target === "payload") {
        const resolvePayload = h.deps.resolvePayloadAttestation!;
        h.deps.resolvePayloadAttestation = async (ref) =>
          h.committed.payload === undefined
            ? { status: "indeterminate", reason: "payload is authoritatively absent" }
            : resolvePayload(ref);
      }
      h.deps.reconcileDelivery = async () => h.committed.delivery
        ? { status: "complete", reconciliationId: "delivery:01J8ME0SXKQ4T9V2RC5HJ6WX7D:1", observedAt: NOW }
        : { status: "absent", reason: "authoritative delivery absence" };
      const absent = {
        status: "absent" as const,
        reason: `authoritative ${target} idempotency-key absence`,
      };
      if (target === "payload") {
        h.durability.reconcilePayloadAttestation = async () =>
          h.committed.payload === undefined
            ? absent
            : structuredClone(h.committed.payload) as never;
      } else if (target === "delivery") {
        h.durability.reconcileDeliverySubmission = async () =>
          h.committed.delivery === undefined
            ? absent
            : structuredClone(h.committed.delivery) as never;
      } else if (target === "evidence") {
        h.durability.reconcileEvidencePublication = async () =>
          h.committed.evidence === undefined
            ? absent
            : structuredClone(h.committed.evidence) as never;
      } else {
        h.durability.reconcileFinalSessionReceipt = async () =>
          h.committed.final === undefined
            ? absent
            : structuredClone(h.committed.final) as never;
      }

      const interrupted = await runDurableFulfilmentCore(
        h.fixture.request,
        h.deps,
        h.durability,
      );
      expect(interrupted.decision).toBe("indeterminate");
      expect(h.counts[target]).toBe(0);
      const afterCrash = await baseStore.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
      if (afterCrash.status !== "ok") throw new Error("crashed session missing");
      expect(afterCrash.record.lease).toMatchObject({
        owner: "worker-a",
        generation: 1,
        expiresAt: NOW + 10,
      });
      expect(afterCrash.record.checkpoints.filter(
        (checkpoint) => checkpoint.key === targetKey,
      ).map((checkpoint) => checkpoint.stage)).toEqual(["intent"]);

      now = NOW + 20;
      const recovered = await runDurableFulfilmentCore(h.fixture.request, h.deps, {
        ...h.durability,
        store: baseStore,
        workerId: "worker-b",
      });
      expect(recovered.decision).toBe("completed");
      expect(h.counts[target]).toBe(1);
      expect(h.fences[target]).toEqual([{
        owner: "worker-b",
        generation: 2,
        idempotencyKey: expect.any(String),
      }]);
      expect(h.counts).toEqual(target === "payload"
        ? { payload: 1, delivery: 1, evidence: 1, final: 1 }
        : { payload: 0, delivery: 1, evidence: 1, final: 1 });
      const terminal = await baseStore.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
      if (terminal.status !== "ok") throw new Error("recovered session missing");
      expect(terminal.record.leaseGeneration).toBe(2);
      expect(terminal.record.lease).toBeUndefined();
      const targetHistory = terminal.record.checkpoints.filter(
        (checkpoint) => checkpoint.key === targetKey,
      );
      expect(targetHistory.map((checkpoint) => checkpoint.stage))
        .toEqual(["intent", "outcome"]);
      expect(targetHistory[0]?.data).toMatchObject({ intentGeneration: 1 });
      expect(targetHistory[1]?.data).toMatchObject({
        intentGeneration: 1,
        outcomeGeneration: 2,
      });
      await expect(projectDurableSellerAuditPending({
        record: terminal.record,
        verifiedAgreement: h.fixture.agreement,
        verifiedListing: h.fixture.listing,
        expectedDeliveryWriter: { role: "seller", primaryClaim: SELLER },
        verifyEvidenceSignature: h.deps.verifyEvidenceSignature,
        verifyAuditSourceCommitmentSignature:
          h.deps.verifyAuditSourceCommitmentSignature,
        verifyAnchorReceipt: h.deps.verifyAnchorReceipt,
      })).resolves.toMatchObject({
        session: { state: "audit-pending" },
        terminal: { result: { decision: "completed" } },
      });
    },
  );

  test("evidence response loss survives signer rotation and returns the original signature", async () => {
    const h = durableHarness();
    h.loseAfter.add("evidence");
    let firstSignature: string | undefined;
    let firstPublicationInput: unknown;
    const firstAnchor = h.deps.anchorEvidence;
    h.deps.anchorEvidence = async (input) => {
      firstPublicationInput = structuredClone(withoutFence(input));
      firstSignature = input.evidence.signature.value;
      return firstAnchor(input);
    };
    expect((await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    )).decision).toBe("indeterminate");
    if (!firstSignature) throw new Error("first signature missing");
    const afterLoss = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (afterLoss.status !== "ok") throw new Error("session missing after evidence loss");
    const intent = afterLoss.record.checkpoints.find(
      (checkpoint) => checkpoint.key ===
          sellerFulfilmentCheckpointKey.evidencePublication(2) &&
        checkpoint.stage === "intent",
    );
    if (typeof intent?.data?.input !== "string" ||
        typeof intent.data.inputHash !== "string") {
      throw new Error("evidence intent is incomplete");
    }
    const retainedInput = intent.data.input;
    const retainedInputHash = intent.data.inputHash;
    expect(retainedInputHash).toBe(sha256Hex(Buffer.from(retainedInput, "utf8")));

    h.deps.evidenceSigner = {
      algorithm: "ed25519",
      signer: SELLER,
      sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(ROTATED_SELLER_SEED)),
    };
    h.deps.verifyEvidenceSignature = async ({ signedBytes, signature }) => {
      const bytes = Uint8Array.from(Buffer.from(signature.value, "base64url"));
      return ed25519Verify(signedBytes, bytes, publicKeyFromSeed(SELLER_SEED)) ||
          ed25519Verify(signedBytes, bytes, publicKeyFromSeed(ROTATED_SELLER_SEED))
        ? { disposition: "valid" }
        : { disposition: "invalid", reason: "signature mismatch" };
    };
    let reconciliationInput: unknown;
    const reconcileEvidence = h.durability.reconcileEvidencePublication;
    h.durability.reconcileEvidencePublication = async (input) => {
      reconciliationInput = structuredClone(withoutFence(input));
      return reconcileEvidence(input);
    };
    const recovered = await runDurableFulfilmentCore(h.fixture.request, h.deps, {
      ...h.durability,
      workerId: "worker-b",
    });
    expect(recovered.decision).toBe("completed");
    if (recovered.decision !== "completed") throw new Error("completion missing");
    expect(recovered.evidence.signature.value).toBe(firstSignature);
    expect(reconciliationInput).toEqual(firstPublicationInput);
    expect(h.counts.evidence).toBe(1);
    const afterRecovery = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (afterRecovery.status !== "ok") throw new Error("session missing after recovery");
    const outcome = [...afterRecovery.record.checkpoints].reverse().find(
      (checkpoint) => checkpoint.key ===
          sellerFulfilmentCheckpointKey.evidencePublication(2) &&
        checkpoint.stage === "outcome",
    );
    expect(outcome?.data?.input).toBe(retainedInput);
    expect(outcome?.data?.inputHash).toBe(retainedInputHash);
    if (typeof outcome?.data?.output !== "string" ||
        typeof outcome.data.outputHash !== "string") {
      throw new Error("evidence outcome is incomplete");
    }
    expect(outcome.data.outputHash).toBe(
      sha256Hex(Buffer.from(outcome.data.output, "utf8")),
    );
  });

  test.each(["anchor-response", "readback"] as const)(
    "retained attested success controls after %s loss and a later invalid verifier",
    async (loss) => {
      const spec = {
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" },
      } as const;
      const h = durableHarness(spec);
      if (loss === "anchor-response") {
        h.loseAfter.add("evidence");
      } else {
        h.deps.resolveEvidence = async () => ({
          status: "indeterminate",
          reason: "evidence readback is temporarily unavailable",
        });
      }

      const interrupted = await runDurableFulfilmentCore(
        h.fixture.request,
        h.deps,
        h.durability,
      );
      expect(interrupted).toMatchObject({
        decision: "indeterminate",
        safeToRetryDelivery: false,
      });
      const invalidProof = vi.fn(async () => ({
        disposition: "invalid" as const,
        reason: "later mutable verifier contradicts the already-signed success",
      }));
      h.deps.verifyPayloadMethodProof = invalidProof;
      h.deps.resolveEvidence = h.fixture.deps.resolveEvidence;

      const recovered = await runDurableFulfilmentCore(
        h.fixture.request,
        h.deps,
        { ...h.durability, workerId: `worker-evidence-${loss}` },
      );
      expect(recovered, JSON.stringify(recovered)).toMatchObject({
        decision: "completed",
        evidence: { outcome: "success" },
        consumedPaymentAuthorization: h.fixture.authorization,
      });
      expect(invalidProof).not.toHaveBeenCalled();
      expect(h.counts).toEqual({ payload: 1, delivery: 1, evidence: 1, final: 1 });
    },
  );

  test("retained signed DPA failure controls after evidence loss and later verifier recovery", async () => {
    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;
    const h = durableHarness(spec);
    let proofCalls = 0;
    h.deps.verifyPayloadMethodProof = async () => {
      proofCalls += 1;
      return proofCalls === 1
        ? { disposition: "valid" as const }
        : {
            disposition: "invalid" as const,
            reason: "payload proof is conclusively invalid",
          };
    };
    h.loseAfter.add("evidence");
    const interrupted = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    expect(interrupted).toMatchObject({ decision: "indeterminate" });
    const laterValid = vi.fn(async () => ({ disposition: "valid" as const }));
    h.deps.verifyPayloadMethodProof = laterValid;

    const recovered = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      { ...h.durability, workerId: "worker-retained-dpa-evidence" },
    );
    expect(recovered, JSON.stringify(recovered)).toMatchObject({
      decision: "failed",
      errorClass: "permanent",
      evidence: {
        outcome: "failure",
        reason: expect.stringMatching(/^DPA terminal: /),
      },
    });
    expect(laterValid).not.toHaveBeenCalled();
    expect(h.counts.evidence).toBe(1);
    expect(h.counts.final).toBe(1);
  });

  test.each(["evidence-intent", "failure-source"] as const)(
    "recovers a failure after crashing immediately after the %s claim",
    async (crashPoint) => {
      const baseStore = createInMemoryFencedSessionStore();
      let crash = true;
      const crashingStore = proxyFencedStore(baseStore, {
        claimCheckpoint: async (input) => {
          const claimed = await baseStore.claimCheckpoint(input);
          const target = crashPoint === "evidence-intent"
            ? sellerFulfilmentCheckpointKey.evidencePublication(2)
            : sellerFulfilmentCheckpointKey.terminalFailureSource(2);
          if (crash && claimed.ok && input.key === target) {
            crash = false;
            throw new Error(`process crashed after ${crashPoint} claim`);
          }
          return claimed;
        },
      });
      const h = durableHarness(undefined, { store: crashingStore });
      let reconciliationCalls = 0;
      h.deps.reconcileDelivery = async () => {
        reconciliationCalls += 1;
        return reconciliationCalls === 1
          ? { status: "absent", reason: "delivery is absent" }
          : {
              status: "failed",
              reason: "authoritative delivery failure",
              observedAt: NOW,
            };
      };

      const interrupted = await runDurableFulfilmentCore(
        h.fixture.request,
        h.deps,
        h.durability,
      );
      expect(interrupted).toMatchObject({
        decision: "indeterminate",
        consumedPaymentAuthorization: h.fixture.authorization,
      });
      const afterCrash = await baseStore.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
      if (afterCrash.status !== "ok") throw new Error("source-ordering session missing");
      expect(checkpointStateForTest(
        afterCrash.record,
        sellerFulfilmentCheckpointKey.evidencePublication(2),
      )).toBe("intent");
      expect(checkpointStateForTest(
        afterCrash.record,
        sellerFulfilmentCheckpointKey.terminalFailureSource(2),
      )).toBe(crashPoint === "evidence-intent" ? undefined : "intent");

      h.durability.reconcileEvidencePublication = async () => ({
        status: "absent",
        reason: "evidence idempotency key is authoritatively absent",
      });
      const recovered = await runDurableFulfilmentCore(
        h.fixture.request,
        h.deps,
        { ...h.durability, store: baseStore, workerId: `worker-${crashPoint}` },
      );
      expect(recovered, JSON.stringify(recovered)).toMatchObject({
        decision: "failed",
        errorClass: "permanent",
        evidence: {
          outcome: "failure",
          reason: "authoritative delivery failure",
        },
      });
      expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 1, final: 1 });
      const terminal = await baseStore.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
      if (terminal.status !== "ok") throw new Error("source-ordering recovery missing");
      expect(checkpointStateForTest(
        terminal.record,
        sellerFulfilmentCheckpointKey.terminalFailureSource(2),
      )).toBe("outcome");
    },
  );

  test.each(["delivery", "evidence", "final"] as const)(
    "keeps a malformed definitive %s response as an intent and recovers it safely",
    async (target) => {
      const h = durableHarness();
      if (target === "delivery") {
        const invoke = h.deps.submitDelivery;
        h.deps.submitDelivery = async (input) => ({
          ...(await invoke(input)),
          unexpected: "must not become an outcome",
        }) as never;
      } else if (target === "evidence") {
        const invoke = h.deps.anchorEvidence;
        h.deps.anchorEvidence = async (input) => ({
          ...(await invoke(input)),
          unexpected: "must not become an outcome",
        }) as never;
      } else {
        const invoke = h.durability.publishFinalSessionReceipt;
        h.durability.publishFinalSessionReceipt = async (input) => ({
          ...(await invoke(input)),
          unexpected: "must not become an outcome",
        }) as never;
      }

      const first = await runDurableFulfilmentCore(h.fixture.request, h.deps, h.durability);
      expect(first.decision).toBe("indeterminate");
      const key = target === "delivery"
        ? sellerFulfilmentCheckpointKey.delivery(2)
        : target === "evidence"
          ? sellerFulfilmentCheckpointKey.evidencePublication(2)
          : sellerFulfilmentCheckpointKey.finalReceipt(2);
      const afterMalformed = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
      if (afterMalformed.status !== "ok") throw new Error("session missing after malformed output");
      expect(afterMalformed.record.checkpoints.filter(
        (checkpoint) => checkpoint.key === key,
      ).map((checkpoint) => checkpoint.stage)).toEqual(["intent"]);

      const recovered = await runDurableFulfilmentCore(h.fixture.request, h.deps, {
        ...h.durability,
        workerId: "worker-recovery",
      });
      expect(recovered.decision).toBe("completed");
      expect(h.counts[target]).toBe(1);
      const finalRecord = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
      if (finalRecord.status !== "ok") throw new Error("session missing after recovery");
      expect(finalRecord.record.checkpoints.filter(
        (checkpoint) => checkpoint.key === key,
      ).map((checkpoint) => checkpoint.stage)).toEqual(["intent", "outcome"]);
    },
  );

  test("rejects a sparse final receipt before persistence and recovers from its intent", async () => {
    const h = durableHarness();
    const publish = h.durability.publishFinalSessionReceipt;
    let poisonOnce = true;
    h.durability.publishFinalSessionReceipt = async (input) => {
      const output = await publish(input);
      if (!poisonOnce || output.status !== "recorded") return output;
      poisonOnce = false;
      return { status: "recorded", receipt: new Array(1) };
    };

    const rejected = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    expect(rejected.decision).toBe("indeterminate");
    const retained = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (retained.status !== "ok") throw new Error("sparse-receipt session missing");
    expect(retained.record.checkpoints.filter(
      (checkpoint) => checkpoint.key === sellerFulfilmentCheckpointKey.finalReceipt(2),
    ).map((checkpoint) => checkpoint.stage)).toEqual(["intent"]);

    const recovered = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      { ...h.durability, workerId: "worker-sparse-final-receipt" },
    );
    expect(recovered.decision).toBe("completed");
    const reopened = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (reopened.status !== "ok") throw new Error("recovered session missing");
    expect(reopened.record.checkpoints.filter(
      (checkpoint) => checkpoint.key === sellerFulfilmentCheckpointKey.finalReceipt(2),
    ).map((checkpoint) => checkpoint.stage)).toEqual(["intent", "outcome"]);
  });

  test.each(["pending-receipt", "misbound-ref"] as const)(
    "keeps a structurally valid but %s evidence anchor response recoverable",
    async (variant) => {
      const h = durableHarness();
      const anchor = h.deps.anchorEvidence;
      h.deps.anchorEvidence = async (input) => {
        const output = await anchor(input);
        if (output.status !== "anchored") return output;
        const poisoned = structuredClone(output);
        if (variant === "pending-receipt") {
          poisoned.anchorReceipt.state = "submitted";
        } else {
          poisoned.ref.contentHash = "0".repeat(64);
        }
        return poisoned;
      };

      const first = await runDurableFulfilmentCore(
        h.fixture.request,
        h.deps,
        h.durability,
      );
      expect(first).toMatchObject({
        decision: "indeterminate",
        code: "delivery-evidence-publication-pending",
      });
      const pending = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
      if (pending.status !== "ok") throw new Error("pending evidence session missing");
      expect(pending.record.checkpoints.filter(
        (checkpoint) => checkpoint.key ===
          sellerFulfilmentCheckpointKey.evidencePublication(2),
      ).map((checkpoint) => checkpoint.stage)).toEqual(["intent"]);

      const recovered = await runDurableFulfilmentCore(
        h.fixture.request,
        h.deps,
        { ...h.durability, workerId: "worker-anchor-recovery" },
      );
      expect(recovered.decision).toBe("completed");
      expect(h.counts.evidence).toBe(1);
      const complete = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
      if (complete.status !== "ok") throw new Error("recovered evidence session missing");
      expect(complete.record.checkpoints.filter(
        (checkpoint) => checkpoint.key ===
          sellerFulfilmentCheckpointKey.evidencePublication(2),
      ).map((checkpoint) => checkpoint.stage)).toEqual(["intent", "outcome"]);
    },
  );

  test("keeps a non-final payload anchor acknowledgement as an intent until reconciliation", async () => {
    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;
    const h = durableHarness(spec);
    const anchor = h.deps.anchorPayloadAttestation!;
    h.deps.anchorPayloadAttestation = async (input) => {
      const output = await anchor(input);
      if (output.status !== "anchored") return output;
      return {
        ...structuredClone(output),
        anchorReceipt: { ...structuredClone(output.anchorReceipt), state: "accepted" },
      };
    };
    const resolve = h.deps.resolvePayloadAttestation!;
    let firstReadback = true;
    h.deps.resolvePayloadAttestation = async (ref) => {
      if (firstReadback) {
        firstReadback = false;
        return { status: "indeterminate", reason: "payload is not yet included" };
      }
      return resolve(ref);
    };

    const first = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    expect(first).toMatchObject({
      decision: "indeterminate",
      code: "payload-attestation-publication-pending",
    });
    const pending = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (pending.status !== "ok") throw new Error("pending payload session missing");
    expect(pending.record.checkpoints.filter(
      (checkpoint) => checkpoint.key ===
        sellerFulfilmentCheckpointKey.payloadPublication(2),
    ).map((checkpoint) => checkpoint.stage)).toEqual(["intent"]);

    const recovered = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      { ...h.durability, workerId: "worker-payload-recovery" },
    );
    expect(recovered.decision).toBe("completed");
    expect(h.counts.payload).toBe(1);
  });

  test.each(["wrong-signer", "invalid-same-signer"] as const)(
    "does not persist a %s evidence-readback signature",
    async (variant) => {
      const h = durableHarness();
      const resolve = h.deps.resolveEvidence;
      let resolutionCalls = 0;
      h.deps.resolveEvidence = async (ref) => {
        resolutionCalls += 1;
        const output = await resolve(ref);
        if (resolutionCalls !== 1 || output.status !== "verified" ||
            !isRecordForTest(output.value) ||
            !isRecordForTest(output.value.signature)) {
          return output;
        }
        const poisoned = structuredClone(output);
        if (!isRecordForTest(poisoned.value) ||
            !isRecordForTest(poisoned.value.signature)) {
          throw new Error("evidence fixture signature missing");
        }
        if (variant === "wrong-signer") {
          poisoned.value.signature.signer = "did:demos:attacker";
        } else {
          poisoned.value.signature.value = Buffer.from(
            ed25519Sign(
              Uint8Array.from([1, 2, 3]),
              privateKeyFromSeed(ROTATED_SELLER_SEED),
            ),
          ).toString("base64url");
        }
        return poisoned as typeof output;
      };

      const first = await runDurableFulfilmentCore(
        h.fixture.request,
        h.deps,
        h.durability,
      );
      expect(first).toMatchObject({
        decision: "indeterminate",
        code: "delivery-evidence-publication-pending",
      });
      const pending = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
      if (pending.status !== "ok") throw new Error("pending readback session missing");
      expect(pending.record.checkpoints.filter(
        (checkpoint) => checkpoint.key ===
          sellerFulfilmentCheckpointKey.evidenceReadback(2),
      ).map((checkpoint) => checkpoint.stage)).toEqual(["intent"]);

      const recovered = await runDurableFulfilmentCore(
        h.fixture.request,
        h.deps,
        { ...h.durability, workerId: "worker-readback-recovery" },
      );
      expect(recovered.decision).toBe("completed");
      expect(resolutionCalls).toBe(2);
      const complete = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
      if (complete.status !== "ok") throw new Error("recovered readback session missing");
      expect(complete.record.checkpoints.filter(
        (checkpoint) => checkpoint.key ===
          sellerFulfilmentCheckpointKey.evidenceReadback(2),
      ).map((checkpoint) => checkpoint.stage)).toEqual(["intent", "outcome"]);
    },
  );

  test("recovers a lost final-receipt response without consulting unavailable upstreams", async () => {
    const h = durableHarness();
    h.loseAfter.add("final");
    const first = await runDurableFulfilmentCore(h.fixture.request, h.deps, h.durability);
    expect(first).toMatchObject({
      decision: "indeterminate",
      code: "durable-final-session-receipt-pending",
    });

    const unavailable = vi.fn(async () => {
      throw new Error("upstream is unavailable after final receipt commit");
    });
    const unavailableSync = vi.fn(() => {
      throw new Error("upstream is unavailable after final receipt commit");
    });
    Object.assign(h.deps, {
      resolveAgreement: unavailable,
      resolveListing: unavailable,
      resolveSessionRecord: unavailable,
      prepareDelivery: unavailable,
      submitDelivery: unavailable,
      reconcileDelivery: unavailable,
      resolveDelivery: unavailable,
      verifyDeliverySchema: unavailable,
      verifyEncryptedDelivery: unavailable,
      resolvePayloadAttestation: unavailable,
      anchorPayloadAttestation: unavailable,
      resolvePayloadVerificationCapability: unavailable,
      verifyPayloadAttestationSignature: unavailable,
      verifyPayloadMethodProof: unavailable,
      verifyEntitlementSignature: unavailable,
      anchorEvidence: unavailable,
      resolveEvidence: unavailable,
      nowMs: unavailableSync,
      evidenceSigner: {
        algorithm: "ed25519",
        signer: SELLER,
        sign: unavailableSync,
      },
    });
    h.durability.reconcilePayloadAttestation = unavailable;
    h.durability.reconcileDeliverySubmission = unavailable;
    h.durability.reconcileEvidencePublication = unavailable;
    h.durability.publishFinalSessionReceipt = unavailable;
    const reconcileFinal = vi.fn(h.durability.reconcileFinalSessionReceipt);
    h.durability.reconcileFinalSessionReceipt = reconcileFinal;

    const recovered = await runDurableFulfilmentCore(h.fixture.request, h.deps, {
      ...h.durability,
      workerId: "worker-final-recovery",
    });
    expect(recovered.decision).toBe("completed");
    expect(reconcileFinal).toHaveBeenCalledTimes(1);
    expect(unavailable).not.toHaveBeenCalled();
    expect(unavailableSync).not.toHaveBeenCalled();
    expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 1, final: 1 });
  });

  test.each(["publication", "readback"] as const)(
    "fails closed before replaying a committed final receipt when evidence %s history is missing",
    async (missing) => {
      const baseStore = createInMemoryFencedSessionStore();
      let crashAfterFinalOutcome = true;
      const crashingStore = proxyFencedStore(baseStore, {
        transition: async (input) => {
          const transitioned = await baseStore.transition(input);
          if (crashAfterFinalOutcome && transitioned.ok &&
              input.checkpoint?.key === sellerFulfilmentCheckpointKey.finalReceipt(2) &&
              input.checkpoint.stage === "outcome") {
            crashAfterFinalOutcome = false;
            throw new Error("process crashed after final receipt outcome commit");
          }
          return transitioned;
        },
      });
      const h = durableHarness(undefined, { store: crashingStore });
      const interrupted = await runDurableFulfilmentCore(
        h.fixture.request,
        h.deps,
        h.durability,
      );
      expect(interrupted.decision).toBe("indeterminate");
      const afterCrash = await baseStore.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
      if (afterCrash.status !== "ok") throw new Error("final receipt crash session missing");
      expect(checkpointStateForTest(
        afterCrash.record,
        sellerFulfilmentCheckpointKey.finalReceipt(2),
      )).toBe("outcome");
      expect(checkpointStateForTest(
        afterCrash.record,
        sellerFulfilmentCheckpointKey.result(2),
      )).toBeUndefined();

      const missingKey = missing === "publication"
        ? sellerFulfilmentCheckpointKey.evidencePublication(2)
        : sellerFulfilmentCheckpointKey.evidenceReadback(2);
      const damagedStore = proxyRecordView(baseStore, (record) => {
        record.checkpoints = record.checkpoints.filter(
          (checkpoint) => checkpoint.key !== missingKey,
        );
        return record;
      });
      const reconcileFinal = vi.fn(h.durability.reconcileFinalSessionReceipt);
      const recovered = await runDurableFulfilmentCore(
        h.fixture.request,
        h.deps,
        {
          ...h.durability,
          store: damagedStore,
          workerId: "worker-final-spine-check",
          reconcileFinalSessionReceipt: reconcileFinal,
        },
      );
      expect(recovered).toMatchObject({
        decision: "indeterminate",
        code: "durable-final-session-receipt-recovery-failed",
        safeToRetryDelivery: false,
      });
      expect(reconcileFinal).not.toHaveBeenCalled();
      expect(h.counts.final).toBe(1);
      const unchanged = await baseStore.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
      if (unchanged.status !== "ok") throw new Error("damaged final session missing");
      expect(checkpointStateForTest(
        unchanged.record,
        sellerFulfilmentCheckpointKey.result(2),
      )).toBeUndefined();
    },
  );

  test("rejects a rebound crash-surviving terminal-result intent before outcome commit", async () => {
    const baseStore = createInMemoryFencedSessionStore();
    let crashAfterResultIntent = true;
    const unstableStore = proxyFencedStore(baseStore, {
      claimCheckpoint: async (input) => {
        const claimed = await baseStore.claimCheckpoint(input);
        if (input.key !== sellerFulfilmentCheckpointKey.result(2)) return claimed;
        if (crashAfterResultIntent && claimed.ok) {
          crashAfterResultIntent = false;
          throw new Error("process crashed after terminal result intent");
        }
        if (!claimed.ok && claimed.record) {
          const record = structuredClone(claimed.record);
          const intent = record.checkpoints.find(
            (checkpoint) => checkpoint.key === sellerFulfilmentCheckpointKey.result(2) &&
              checkpoint.stage === "intent",
          );
          if (!intent?.data) throw new Error("terminal result intent missing");
          intent.data.authorizationHash = "0".repeat(64);
          return { ...claimed, record };
        }
        return claimed;
      },
    });
    const h = durableHarness(undefined, { store: unstableStore });
    const interrupted = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    expect(interrupted.decision).toBe("indeterminate");
    const afterCrash = await baseStore.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (afterCrash.status !== "ok") throw new Error("result-intent session missing");
    expect(afterCrash.record.checkpoints.filter(
      (checkpoint) => checkpoint.key === sellerFulfilmentCheckpointKey.result(2),
    ).map((checkpoint) => checkpoint.stage)).toEqual(["intent"]);

    const replay = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      { ...h.durability, workerId: "worker-result-intent-recovery" },
    );
    expect(replay).toMatchObject({
      decision: "indeterminate",
      code: "durable-final-session-receipt-recovery-failed",
      safeToRetryDelivery: false,
    });
    const unchanged = await baseStore.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (unchanged.status !== "ok") throw new Error("result-intent session disappeared");
    expect(unchanged.record.checkpoints.filter(
      (checkpoint) => checkpoint.key === sellerFulfilmentCheckpointKey.result(2),
    ).map((checkpoint) => checkpoint.stage)).toEqual(["intent"]);
  });

  test("promotes a crash-surviving DPA terminal intent before consulting an unavailable reconciler", async () => {
    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;
    const baseStore = createInMemoryFencedSessionStore();
    let crashAfterDpaIntent = true;
    const crashingStore = proxyFencedStore(baseStore, {
      claimCheckpoint: async (input) => {
        const claimed = await baseStore.claimCheckpoint(input);
        if (crashAfterDpaIntent && claimed.ok && input.key ===
            sellerFulfilmentCheckpointKey.dpaTerminalFailure(2)) {
          crashAfterDpaIntent = false;
          throw new Error("process crashed after durable DPA terminal intent");
        }
        return claimed;
      },
    });
    const h = durableHarness(spec, { store: crashingStore });
    let proofCalls = 0;
    h.deps.verifyPayloadMethodProof = async () => {
      proofCalls += 1;
      return proofCalls === 1
        ? { disposition: "valid" }
        : { disposition: "invalid", reason: "native proof contradicts payload digest" };
    };

    const interrupted = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    expect(interrupted.decision).toBe("failed");
    const afterCrash = await baseStore.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (afterCrash.status !== "ok") throw new Error("DPA crash session missing");
    expect(afterCrash.record.checkpoints.filter(
      (checkpoint) => checkpoint.key ===
        sellerFulfilmentCheckpointKey.dpaTerminalFailure(2),
    ).map((checkpoint) => checkpoint.stage)).toEqual(["intent", "outcome"]);

    const callsAtCrash = proofCalls;
    h.deps.verifyPayloadMethodProof = async () => {
      proofCalls += 1;
      return { disposition: "indeterminate", reason: "verifier offline" };
    };
    const externalReconcile = vi.fn(async () => {
      throw new Error("delivery reconciler is unavailable");
    });
    h.deps.reconcileDelivery = externalReconcile;
    const recovered = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      { ...h.durability, store: baseStore, workerId: "worker-dpa-recovery" },
    );
    expect(recovered).toMatchObject({
      decision: "failed",
      errorClass: "permanent",
      evidence: { outcome: "failure" },
    });
    expect(proofCalls).toBe(callsAtCrash);
    expect(externalReconcile).not.toHaveBeenCalled();
    const complete = await baseStore.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (complete.status !== "ok") throw new Error("recovered DPA session missing");
    expect(complete.record.checkpoints.filter(
      (checkpoint) => checkpoint.key ===
        sellerFulfilmentCheckpointKey.dpaTerminalFailure(2),
    ).map((checkpoint) => checkpoint.stage)).toEqual(["intent", "outcome"]);
  });

  test.each(["signature", "method-proof", "anchor-receipt"] as const)(
    "terminalizes an immediate invalid payload %s result after exactly one permit consumption",
    async (target) => {
      const spec = {
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" },
      } as const;
      const h = durableHarness(spec);
      const consume = vi.spyOn(h.fixture.store, "consumePermit");
      const invalid = vi.fn(async () => ({
        disposition: "invalid" as const,
        reason: `${target} is invalid immediately`,
      }));
      if (target === "signature") {
        h.deps.verifyPayloadAttestationSignature = invalid;
      } else if (target === "method-proof") {
        h.deps.verifyPayloadMethodProof = invalid;
      } else {
        const healthy = h.deps.verifyAnchorReceipt;
        h.deps.verifyAnchorReceipt = async (input) =>
          input.purpose === "payload-attestation" ? invalid() : healthy(input);
      }

      const failed = await runDurableFulfilmentCore(
        h.fixture.request,
        h.deps,
        h.durability,
      );
      expect(failed, JSON.stringify(failed)).toMatchObject({
        decision: "failed",
        errorClass: "permanent",
        consumedPaymentAuthorization: h.fixture.authorization,
        evidence: { outcome: "failure" },
      });
      expect(consume).toHaveBeenCalledTimes(1);
      expect(h.counts).toEqual({
        payload: target === "anchor-receipt" ? 1 : 0,
        delivery: 0,
        evidence: 1,
        final: 1,
      });
      const terminal = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
      if (terminal.status !== "ok") throw new Error("immediate-invalid session missing");
      expect(checkpointStateForTest(
        terminal.record,
        sellerFulfilmentCheckpointKey.dpaTerminalFailure(2),
      )).toBe(target === "anchor-receipt" ? "outcome" : undefined);
    },
  );

  test.each(["preparer", "delivery-readback", "schema-verifier"] as const)(
    "snapshots a stateful $target result before prefix classification",
    async (target) => {
      const spec = target === "schema-verifier"
        ? {
            kind: "storage-program" as const,
            accessModel: "public" as const,
            schemaUrl: "https://schema.example/result.json",
          }
        : undefined;
      const h = durableHarness(spec);
      let discriminatorReads = 0;
      const flippingResult = (
        field: "status" | "disposition",
        first: string,
        later: string,
      ): unknown => {
        const value: Record<string, unknown> = {
          reason: "DPA terminal: legitimate stateful adapter rejection",
        };
        Object.defineProperty(value, field, {
          enumerable: true,
          get() {
            discriminatorReads += 1;
            return discriminatorReads === 1 ? first : later;
          },
        });
        return value;
      };
      if (target === "preparer") {
        h.fixture.deps.prepareDelivery = async () =>
          flippingResult("status", "rejected", "prepared") as never;
        h.deps.prepareDelivery = h.fixture.deps.prepareDelivery;
      } else if (target === "delivery-readback") {
        h.deps.resolveDelivery = async () =>
          flippingResult("status", "rejected", "verified") as never;
      } else {
        h.deps.verifyDeliverySchema = async () =>
          flippingResult("disposition", "invalid", "valid") as never;
      }

      const result = await runDurableFulfilmentCore(
        h.fixture.request,
        h.deps,
        h.durability,
      );
      expect(result, JSON.stringify(result)).toMatchObject({
        decision: "failed",
        evidence: {
          outcome: "failure",
          reason: "non-DPA terminal: DPA terminal: legitimate stateful adapter rejection",
        },
      });
      expect(discriminatorReads).toBe(1);
      expect(h.counts).toEqual({
        payload: 0,
        delivery: target === "delivery-readback" ? 1 : 0,
        evidence: 1,
        final: 1,
      });
      const terminal = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
      if (terminal.status !== "ok") throw new Error("stateful-adapter session missing");
      expect(checkpointStateForTest(
        terminal.record,
        sellerFulfilmentCheckpointKey.dpaTerminalFailure(2),
      )).toBeUndefined();
    },
  );

  test.each(["method-proof", "anchor-receipt"] as const)(
    "does not persist a malformed invalid DPA %s result as a terminal fact",
    async (target) => {
      const spec = {
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" },
      } as const;
      const h = durableHarness(spec, { initiallyConsumed: true });
      if (target === "method-proof") {
        h.deps.verifyPayloadMethodProof = async () => ({
          disposition: "invalid",
          reason: "malformed verifier response",
          extra: true,
        }) as never;
      } else {
        const verify = h.deps.verifyAnchorReceipt;
        h.deps.verifyAnchorReceipt = async (input) => input.purpose === "payload-attestation"
          ? {
              disposition: "invalid",
              reason: "malformed receipt-verifier response",
              extra: true,
            } as never
          : verify(input);
      }

      const first = await runDurableFulfilmentCore(
        h.fixture.request,
        h.deps,
        h.durability,
      );
      expect(first.decision).toBe("indeterminate");
      const afterMalformed = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
      if (afterMalformed.status !== "ok") throw new Error("malformed DPA session missing");
      expect(checkpointStateForTest(
        afterMalformed.record,
        sellerFulfilmentCheckpointKey.dpaTerminalFailure(2),
      )).toBeUndefined();

      h.deps.verifyPayloadMethodProof = async () => ({ disposition: "valid" });
      h.deps.verifyAnchorReceipt = async () => ({ disposition: "valid" });
      const recovered = await runDurableFulfilmentCore(
        h.fixture.request,
        h.deps,
        { ...h.durability, workerId: "worker-malformed-dpa-recovery" },
      );
      expect(recovered, JSON.stringify(recovered)).toMatchObject({ decision: "completed" });
    },
  );

  test("terminalizes a definitive rejected payload readback for an imported attested delivery", async () => {
    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;
    const h = durableHarness(spec, { initiallyConsumed: true });
    const rejectedReadback = vi.fn(async () => ({
      status: "rejected" as const,
      reason: "imported payload reference is cryptographically rejected",
    }));
    h.deps.resolvePayloadAttestation = rejectedReadback;

    const failed = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    expect(failed, JSON.stringify(failed)).toMatchObject({
      decision: "failed",
      errorClass: "permanent",
      evidence: {
        outcome: "failure",
        reason: expect.stringMatching(/^DPA terminal: payload readback rejected: /),
      },
    });
    expect(rejectedReadback).toHaveBeenCalledTimes(1);
    expect(h.counts).toEqual({ payload: 0, delivery: 0, evidence: 1, final: 1 });
    const terminal = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (terminal.status !== "ok") throw new Error("imported DPA session missing");
    expect(checkpointStateForTest(
      terminal.record,
      sellerFulfilmentCheckpointKey.payloadReadback(2),
    )).toBe("outcome");
    expect(checkpointStateForTest(
      terminal.record,
      sellerFulfilmentCheckpointKey.dpaTerminalFailure(2),
    )).toBe("outcome");
  });

  test("DPA contradiction is terminally fenced before a later verifier outage", async () => {
    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;
    const h = durableHarness(spec);
    let proofCalls = 0;
    h.deps.verifyPayloadMethodProof = async () => {
      proofCalls += 1;
      return proofCalls === 1
        ? { disposition: "valid" }
        : { disposition: "invalid", reason: "native proof contradicts payload digest" };
    };
    h.loseAfter.add("final");
    const first = await runDurableFulfilmentCore(h.fixture.request, h.deps, h.durability);
    expect(first).toMatchObject({
      decision: "indeterminate",
      code: "durable-final-session-receipt-pending",
    });
    const callsAtFailure = proofCalls;
    h.deps.verifyPayloadMethodProof = async () => {
      proofCalls += 1;
      return { disposition: "indeterminate", reason: "verifier offline" };
    };

    const recovered = await runDurableFulfilmentCore(h.fixture.request, h.deps, {
      ...h.durability,
      workerId: "worker-b",
    });
    expect(recovered).toMatchObject({
      decision: "failed",
      errorClass: "permanent",
      evidence: { outcome: "failure" },
    });
    expect(proofCalls).toBe(callsAtFailure);
    expect(h.counts.delivery).toBe(0);
    const loaded = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (loaded.status !== "ok") throw new Error("session missing");
    expect(checkpointStateForTest(
      loaded.record,
      sellerFulfilmentCheckpointKey.dpaTerminalFailure(2),
    )).toBe("outcome");
  });

  test("timestamps a durable DPA contradiction with the normative clock, not the lease clock", async () => {
    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;
    const h = durableHarness(spec);
    let proofCalls = 0;
    h.deps.verifyPayloadMethodProof = async () => {
      proofCalls += 1;
      return proofCalls === 1
        ? { disposition: "valid" }
        : { disposition: "invalid", reason: "native proof contradicts payload digest" };
    };

    const result = await runDurableFulfilmentCore(h.fixture.request, h.deps, {
      ...h.durability,
      leaseNowMs: () => 0,
    });
    expect(result).toMatchObject({
      decision: "failed",
      errorClass: "permanent",
      evidence: { observedAt: NOW },
    });
    const loaded = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (loaded.status !== "ok") throw new Error("DPA session missing");
    const terminal = loaded.record.checkpoints.find(
      (checkpoint) => checkpoint.key ===
          sellerFulfilmentCheckpointKey.dpaTerminalFailure(2) &&
        checkpoint.stage === "outcome",
    );
    expect(terminal?.data?.observedAt).toBe(NOW);
  });

  test.each([
    {
      label: "another fulfilment",
      tamper(data: Record<string, string | number | boolean>) {
        data.fulfilmentId = "0".repeat(64);
      },
    },
    {
      label: "another consumed authorization",
      tamper(data: Record<string, string | number | boolean>) {
        data.authorizationHash = "0".repeat(64);
      },
    },
    {
      label: "an unexpected field",
      tamper(data: Record<string, string | number | boolean>) {
        data.unexpected = true;
      },
    },
  ])("fails closed when a DPA terminal fact is rebound to $label", async ({ tamper }) => {
    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;
    const h = durableHarness(spec);
    let proofCalls = 0;
    h.deps.verifyPayloadMethodProof = async () => {
      proofCalls += 1;
      return proofCalls === 1
        ? { disposition: "valid" }
        : { disposition: "invalid", reason: "native proof contradicts payload digest" };
    };
    h.loseAfter.add("evidence");
    const pending = await runDurableFulfilmentCore(h.fixture.request, h.deps, h.durability);
    expect(pending.decision).toBe("indeterminate");

    const tamperedStore = proxyRecordView(h.store, (record) => {
      const checkpoints = record.checkpoints.filter(
        (checkpoint) => checkpoint.key ===
          sellerFulfilmentCheckpointKey.dpaTerminalFailure(2),
      );
      expect(checkpoints.map((checkpoint) => checkpoint.stage)).toEqual([
        "intent",
        "outcome",
      ]);
      for (const checkpoint of checkpoints) {
        if (!checkpoint.data) throw new Error("DPA terminal data missing");
        tamper(checkpoint.data);
      }
      return record;
    });
    const replay = await runDurableFulfilmentCore(h.fixture.request, h.deps, {
      ...h.durability,
      store: tamperedStore,
      workerId: "worker-dpa-tamper",
    });
    expect(replay).toMatchObject({
      decision: "indeterminate",
      code: "durable-evidence-recovery-failed",
      safeToRetryDelivery: false,
    });
    expect(h.counts).toEqual({ payload: 1, delivery: 0, evidence: 1, final: 0 });
  });

  test("raw DPA readback contradiction is durable before a later resolver outage", async () => {
    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;
    const h = durableHarness(spec);
    const resolve = h.deps.resolvePayloadAttestation!;
    let resolverCalls = 0;
    h.deps.resolvePayloadAttestation = async (ref) => {
      resolverCalls += 1;
      const resolved = await resolve(ref);
      if (resolved.status !== "verified" || !resolved.value ||
          typeof resolved.value.record !== "object" || resolved.value.record === null) {
        throw new Error("DPA fixture resolution missing");
      }
      const value = structuredClone(resolved.value);
      (value.record as Record<string, unknown>).reason = "contradictory durable readback";
      return { status: "verified", value };
    };
    h.loseAfter.add("final");

    const first = await runDurableFulfilmentCore(h.fixture.request, h.deps, h.durability);
    expect(first).toMatchObject({
      decision: "indeterminate",
      code: "durable-final-session-receipt-pending",
    });
    const callsAtFailure = resolverCalls;
    h.deps.resolvePayloadAttestation = async () => {
      resolverCalls += 1;
      return { status: "indeterminate", reason: "resolver offline" };
    };

    const recovered = await runDurableFulfilmentCore(h.fixture.request, h.deps, {
      ...h.durability,
      workerId: "worker-b",
    });
    expect(recovered).toMatchObject({
      decision: "failed",
      errorClass: "permanent",
      evidence: { outcome: "failure" },
    });
    expect(resolverCalls).toBe(callsAtFailure);
    expect(h.counts.delivery).toBe(0);
    const loaded = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (loaded.status !== "ok") throw new Error("session missing");
    expect(checkpointStateForTest(
      loaded.record,
      sellerFulfilmentCheckpointKey.dpaTerminalFailure(2),
    )).toBe("outcome");
  });

  test("filesystem reopen resumes final intent and exact Uint8Array receipt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dacs-pr121-"));
    try {
      const firstStore = await createFsFencedSessionStore({ dir });
      const h = durableHarness(undefined, { store: firstStore });
      h.loseAfter.add("final");
      const first = await runDurableFulfilmentCore(h.fixture.request, h.deps, h.durability);
      expect(first.decision).toBe("indeterminate");

      const reopened = await createFsFencedSessionStore({ dir });
      const second = await runDurableFulfilmentCore(h.fixture.request, h.deps, {
        ...h.durability,
        store: reopened,
        workerId: "worker-reopened",
      });
      expect(second.decision).toBe("completed");
      expect(h.counts.final).toBe(1);
      const reopenedAgain = await createFsFencedSessionStore({ dir });
      const replay = await runDurableFulfilmentCore(h.fixture.request, h.deps, {
        ...h.durability,
        store: reopenedAgain,
        workerId: "worker-replay",
      });
      expect(replay).toEqual(second);
      expect(h.counts.final).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.each(["agreement", "settlement"] as const)(
    "terminal filesystem replay repairs a missing global %s marker",
    async (kind) => {
      const dir = await mkdtemp(join(tmpdir(), "dacs-pr121-marker-repair-"));
      try {
        const store = await createFsFencedSessionStore({ dir });
        const h = durableHarness(undefined, { store });
        const completed = await runDurableFulfilmentCore(
          h.fixture.request,
          h.deps,
          h.durability,
        );
        expect(completed.decision).toBe("completed");
        const markerPath = kind === "agreement"
          ? join(dir, "hashes", `${encodeURIComponent(H.agreement)}.json`)
          : join(
              dir,
              "settlements",
              `${encodeURIComponent(h.fixture.authorization.settlementId)}.json`,
            );
        await unlink(markerPath);

        const replay = await runDurableFulfilmentCore(
          h.fixture.request,
          h.deps,
          {
            ...h.durability,
            store: await createFsFencedSessionStore({ dir }),
            workerId: "worker-marker-repair",
          },
        );
        expect(replay).toEqual(completed);
        const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
        expect(marker.jobId).toBe("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
        if (kind === "agreement") expect(marker.kind).toBe("agreement");
        expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 1, final: 1 });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test.each(["storage", "entitlement"] as const)(
    "filesystem recovery losslessly retains finite fractional %s values",
    async (kind) => {
      const dir = await mkdtemp(join(tmpdir(), "dacs-pr121-fractional-"));
      try {
        const spec: SellerDeliverableSpec = kind === "storage"
          ? { kind: "storage-program", accessModel: "public" }
          : { kind: "entitlement", durationSec: 3_600, renewable: false };
        const h = durableHarness(spec, {
          store: await createFsFencedSessionStore({ dir }),
        });
        if (kind === "storage") {
          h.fixture.artifact.cleartextPayload = { score: 1.5, signedZero: -0 };
          h.fixture.artifact.anchoredValue = structuredClone(
            h.fixture.artifact.cleartextPayload,
          );
        } else {
          if (!isRecordForTest(h.fixture.artifact.cleartextPayload) ||
              !isRecordForTest(h.fixture.artifact.cleartextPayload.scope) ||
              !isRecordForTest(h.fixture.artifact.cleartextPayload.scope.quotas)) {
            throw new Error("entitlement quota fixture missing");
          }
          h.fixture.artifact.cleartextPayload.scope.quotas.calls = 1.5;
          h.fixture.artifact.anchoredValue = structuredClone(
            h.fixture.artifact.cleartextPayload,
          );
        }
        const deliveredHash = kind === "storage"
          ? sha256Hex(canonicalize(h.fixture.artifact.anchoredValue))
          : singularSignatureHash(
              h.fixture.artifact.cleartextPayload as Record<string, unknown>,
            );
        const deliveryLocator = kind === "storage"
          ? "dacs4:deliverable:01J8ME0SXKQ4T9V2RC5HJ6WX7D"
          : "dacs4:entitlement:01J8ME0SXKQ4T9V2RC5HJ6WX7D:0";
        h.deps.resolveDelivery = async () => ({
          status: "verified",
          value: {
            artifact: structuredClone(h.fixture.artifact),
            anchorReceipt: anchorReceipt(deliveryLocator, deliveredHash),
          },
        });
        (h.finalReceipt as unknown as Record<string, unknown>).fractionalMetadata = 0.125;
        h.loseAfter.add("final");

        const interrupted = await runDurableFulfilmentCore(
          h.fixture.request,
          h.deps,
          h.durability,
        );
        expect(interrupted).toMatchObject({
          decision: "indeterminate",
          code: "durable-final-session-receipt-pending",
        });
        const recovered = await runDurableFulfilmentCore(
          h.fixture.request,
          h.deps,
          {
            ...h.durability,
            store: await createFsFencedSessionStore({ dir }),
            workerId: "worker-fractional-recovery",
          },
        );
        expect(recovered, JSON.stringify(recovered)).toMatchObject({ decision: "completed" });
        const replay = await runDurableFulfilmentCore(
          h.fixture.request,
          h.deps,
          {
            ...h.durability,
            store: await createFsFencedSessionStore({ dir }),
            workerId: "worker-fractional-replay",
          },
        );
        expect(replay).toEqual(recovered);
        expect(h.counts.final).toBe(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test.each(["conflicting-agreement", "corrupt-settlement"] as const)(
    "terminal filesystem replay fails closed on a %s marker",
    async (scenario) => {
      const dir = await mkdtemp(join(tmpdir(), "dacs-pr121-marker-conflict-"));
      try {
        const store = await createFsFencedSessionStore({ dir });
        const h = durableHarness(undefined, { store });
        const completed = await runDurableFulfilmentCore(
          h.fixture.request,
          h.deps,
          h.durability,
        );
        expect(completed.decision).toBe("completed");
        if (scenario === "conflicting-agreement") {
          await writeFile(
            join(dir, "hashes", `${encodeURIComponent(H.agreement)}.json`),
            JSON.stringify({ jobId: "attacker-job", kind: "agreement" }),
          );
        } else {
          await writeFile(
            join(
              dir,
              "settlements",
              `${encodeURIComponent(h.fixture.authorization.settlementId)}.json`,
            ),
            "{ corrupt",
          );
        }

        const replay = await runDurableFulfilmentCore(
          h.fixture.request,
          h.deps,
          {
            ...h.durability,
            store: await createFsFencedSessionStore({ dir }),
            workerId: "worker-marker-conflict",
          },
        );
        expect(replay).toMatchObject({
          decision: "indeterminate",
          code: "durable-permit-inspection-failed",
          safeToRetryDelivery: false,
        });
        expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 1, final: 1 });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test("concurrent filesystem workers produce one effect invocation and one exact terminal result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dacs-pr121-concurrent-"));
    try {
      const storeA = await createFsFencedSessionStore({ dir });
      const storeB = await createFsFencedSessionStore({ dir });
      const h = durableHarness(undefined, { store: storeA });
      const [left, right] = await Promise.all([
        runDurableFulfilmentCore(h.fixture.request, h.deps, h.durability),
        runDurableFulfilmentCore(h.fixture.request, h.deps, {
          ...h.durability,
          store: storeB,
          workerId: "worker-b",
        }),
      ]);
      const completed = [left, right].find((result) => result.decision === "completed");
      expect(completed?.decision).toBe("completed");
      const replay = await runDurableFulfilmentCore(h.fixture.request, h.deps, {
        ...h.durability,
        store: await createFsFencedSessionStore({ dir }),
        workerId: "worker-c",
      });
      expect(replay).toEqual(completed);
      expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 1, final: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("terminal replay rejects caller fields that contradict the consumed handoff", async () => {
    const h = durableHarness();
    const first = await runDurableFulfilmentCore(h.fixture.request, h.deps, h.durability);
    expect(first.decision).toBe("completed");
    const redirected = {
      ...h.fixture.request,
      agreementHash: "0".repeat(64),
      agreementRef: "agreement:attacker",
      deliveryPhaseIndex: 99,
    };
    const replay = await runDurableFulfilmentCore(redirected, h.deps, {
      ...h.durability,
      workerId: "worker-b",
    });
    expect(replay).toMatchObject({
      decision: "indeterminate",
      code: "durable-permit-inspection-failed",
      safeToRetryDelivery: false,
    });
    expect(await h.store.load("attacker-job")).toEqual({ status: "missing" });
    expect(h.counts.delivery).toBe(1);
  });

  test("rejects a coherently rehashed failure rewritten as success", async () => {
    const h = durableHarness();
    let reconciliationCalls = 0;
    h.deps.reconcileDelivery = async () => {
      reconciliationCalls += 1;
      return reconciliationCalls === 1
        ? { status: "absent", reason: "authoritative absence" }
        : {
            status: "failed",
            reason: "delivery substrate recorded a terminal failure",
            reconciliationId: "delivery:01J8ME0SXKQ4T9V2RC5HJ6WX7D:1",
            observedAt: NOW,
          };
    };
    const failed = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    if (failed.decision !== "failed") throw new Error("failed terminal fixture missing");
    const { errorClass: _errorClass, ...withoutErrorClass } = structuredClone(failed);
    const rewrittenResult = {
      ...withoutErrorClass,
      decision: "completed" as const,
    };
    const rewrittenResultEncoded = encodeDurableForTest(rewrittenResult);
    const rewrittenResultHash = durableHashForTest(rewrittenResultEncoded);
    const persisted = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (persisted.status !== "ok") throw new Error("failed terminal session missing");
    const persistedResult = persisted.record.checkpoints.find(
      (checkpoint) => checkpoint.key === sellerFulfilmentCheckpointKey.result(2) &&
        checkpoint.stage === "intent",
    );
    expect(persistedResult?.data?.result).toBe(encodeDurableForTest(failed));

    const rewrittenStore = proxyRecordView(h.store, (record) => {
        const binding = record.paymentAuthorizations.find(
          (item) => item.deliveryPhaseIndex === 1,
        );
        if (!binding) throw new Error("terminal authorization binding missing");
        const finalInput = {
          fulfilmentId: binding.fulfilmentId,
          authorizationBinding: structuredClone(binding),
          resultHash: rewrittenResultHash,
          result: structuredClone(rewrittenResult),
        };
        const finalInputEncoded = encodeDurableForTest(finalInput);
        const finalIdentityHash = durableHashForTest(encodeDurableForTest({
          fulfilmentId: binding.fulfilmentId,
          authorizationBinding: binding,
          resultHash: rewrittenResultHash,
        }));
        for (const checkpoint of record.checkpoints) {
          if (!checkpoint.data) continue;
          if (checkpoint.key === sellerFulfilmentCheckpointKey.finalReceipt(2)) {
            checkpoint.data.input = finalInputEncoded;
            checkpoint.data.inputHash = durableHashForTest(finalInputEncoded);
            checkpoint.data.identityHash = finalIdentityHash;
          }
          if (checkpoint.key === sellerFulfilmentCheckpointKey.result(2)) {
            checkpoint.data.result = rewrittenResultEncoded;
            checkpoint.data.resultHash = rewrittenResultHash;
          }
        }
        record.phase = "seller:delivery-completed:2";
        return record;
    });

    const replay = await runDurableFulfilmentCore(h.fixture.request, h.deps, {
      ...h.durability,
      store: rewrittenStore,
      workerId: "worker-semantic-tamper",
    });
    expect(replay).toMatchObject({
      decision: "indeterminate",
      code: "durable-permit-inspection-failed",
      safeToRetryDelivery: false,
    });
    expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 1, final: 1 });
  });

  test.each(terminalTamperCases)(
    "fails closed when terminal state has a tampered $label",
    async ({ tamper }) => {
      const h = durableHarness();
      const completed = await runDurableFulfilmentCore(
        h.fixture.request,
        h.deps,
        h.durability,
      );
      expect(completed.decision).toBe("completed");
      const tamperedStore = proxyRecordView(h.store, (record) => {
        tamper(record);
        return record;
      });

      const replay = await runDurableFulfilmentCore(h.fixture.request, h.deps, {
        ...h.durability,
        store: tamperedStore,
        workerId: "worker-tamper-check",
      });
      expect(replay).toMatchObject({
        decision: "indeterminate",
        code: "durable-permit-inspection-failed",
        safeToRetryDelivery: false,
      });
      expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 1, final: 1 });
    },
  );

  test.each(["publication", "readback"] as const)(
    "attested terminal replay fails closed when payload %s history is deleted",
    async (missing) => {
      const spec = {
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" },
      } as const;
      const h = durableHarness(spec);
      const completed = await runDurableFulfilmentCore(
        h.fixture.request,
        h.deps,
        h.durability,
      );
      expect(completed.decision).toBe("completed");
      const key = missing === "publication"
        ? sellerFulfilmentCheckpointKey.payloadPublication(2)
        : sellerFulfilmentCheckpointKey.payloadReadback(2);
      const damaged = proxyRecordView(h.store, (record) => {
        record.checkpoints = record.checkpoints.filter(
          (checkpoint) => checkpoint.key !== key,
        );
        return record;
      });

      const replay = await runDurableFulfilmentCore(
        h.fixture.request,
        h.deps,
        { ...h.durability, store: damaged, workerId: "worker-payload-spine-tamper" },
      );
      expect(replay).toMatchObject({
        decision: "indeterminate",
        code: "durable-permit-inspection-failed",
        safeToRetryDelivery: false,
      });
      expect(h.counts).toEqual({ payload: 1, delivery: 1, evidence: 1, final: 1 });
    },
  );

  test.each(["dpa", "source", "both"] as const)(
    "post-delivery DPA replay fails closed when %s terminal provenance is deleted",
    async (missing) => {
      const spec = {
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" },
      } as const;
      const h = durableHarness(spec);
      let proofCalls = 0;
      h.deps.verifyPayloadMethodProof = async () => {
        proofCalls += 1;
        return proofCalls < 3
          ? { disposition: "valid" as const }
          : {
              disposition: "invalid" as const,
              reason: "delivered native proof contradicts the retained payload",
            };
      };
      const failed = await runDurableFulfilmentCore(
        h.fixture.request,
        h.deps,
        h.durability,
      );
      expect(failed).toMatchObject({ decision: "failed", errorClass: "permanent" });
      expect(h.counts).toEqual({ payload: 1, delivery: 1, evidence: 1, final: 1 });
      const damaged = proxyRecordView(h.store, (record) => {
        record.checkpoints = record.checkpoints.filter((checkpoint) => {
          const isDpa = checkpoint.key ===
            sellerFulfilmentCheckpointKey.dpaTerminalFailure(2);
          const isSource = checkpoint.key ===
            sellerFulfilmentCheckpointKey.terminalFailureSource(2);
          return missing === "both"
            ? !isDpa && !isSource
            : missing === "dpa"
              ? !isDpa
              : !isSource;
        });
        return record;
      });

      const replay = await runDurableFulfilmentCore(
        h.fixture.request,
        h.deps,
        { ...h.durability, store: damaged, workerId: "worker-dpa-source-tamper" },
      );
      expect(replay).toMatchObject({
        decision: "indeterminate",
        code: "durable-permit-inspection-failed",
        safeToRetryDelivery: false,
      });
      expect(h.counts).toEqual({ payload: 1, delivery: 1, evidence: 1, final: 1 });
    },
  );

  test("signed DPA evidence cannot be coherently reclassified as delivery validation", async () => {
    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;
    const h = durableHarness(spec);
    let proofCalls = 0;
    h.deps.verifyPayloadMethodProof = async () => {
      proofCalls += 1;
      return proofCalls < 3
        ? { disposition: "valid" as const }
        : {
            disposition: "invalid" as const,
            reason: "delivered native proof contradicts the retained payload",
          };
    };
    const failed = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    if (failed.decision !== "failed" || failed.evidence.outcome !== "failure") {
      throw new Error("post-delivery DPA fixture missing");
    }
    const signedReason = failed.evidence.reason;
    const observedAt = failed.evidence.observedAt;
    expect(signedReason).toMatch(/^DPA terminal: /);

    const coherentlyReclassified = proxyRecordView(h.store, (record) => {
      record.checkpoints = record.checkpoints.filter(
        (checkpoint) => checkpoint.key !==
          sellerFulfilmentCheckpointKey.dpaTerminalFailure(2),
      );
      const effectSnapshotHash = terminalEffectSnapshotHashForTest(record);
      const failureSource = {
        kind: "delivery-validation",
        reason: signedReason,
        observedAt,
        deliveryClosure: "reconciliation-complete",
        payloadClosure: "anchored",
      };
      for (const checkpoint of record.checkpoints) {
        if (!checkpoint.data) continue;
        if (checkpoint.key === sellerFulfilmentCheckpointKey.terminalFailureSource(2)) {
          checkpoint.data.sourceKind = failureSource.kind;
          checkpoint.data.reason = signedReason;
          checkpoint.data.observedAt = observedAt;
          checkpoint.data.deliveryClosure = failureSource.deliveryClosure;
          checkpoint.data.payloadClosure = failureSource.payloadClosure;
          checkpoint.data.effectSnapshotHash = effectSnapshotHash;
        }
        if (checkpoint.key === sellerFulfilmentCheckpointKey.evidencePublication(2)) {
          checkpoint.data.identityHash = durableHashForTest(encodeDurableForTest({
            fulfilmentId: failed.fulfilmentId,
            evidenceHash: failed.evidenceHash,
            terminalSource: {
              decision: "failed",
              effectSnapshotHash,
              failureSource,
            },
          }));
        }
      }
      return record;
    });

    const replay = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      {
        ...h.durability,
        store: coherentlyReclassified,
        workerId: "worker-dpa-coherent-reclassification",
      },
    );
    expect(replay).toMatchObject({
      decision: "indeterminate",
      code: "durable-permit-inspection-failed",
      safeToRetryDelivery: false,
    });
    expect(h.counts).toEqual({ payload: 1, delivery: 1, evidence: 1, final: 1 });
  });

  test("escapes a legitimate preparation failure that collides with the DPA namespace", async () => {
    const h = durableHarness();
    h.fixture.deps.prepareDelivery = async () => ({
      status: "rejected",
      reason: "DPA terminal: legitimate preparer message",
    });
    h.deps.prepareDelivery = h.fixture.deps.prepareDelivery;

    const result = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    expect(result).toMatchObject({
      decision: "failed",
      errorClass: "permanent",
      evidence: {
        outcome: "failure",
        reason: "non-DPA terminal: DPA terminal: legitimate preparer message",
      },
    });
    expect(h.counts).toEqual({ payload: 0, delivery: 0, evidence: 1, final: 1 });
    const terminal = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (terminal.status !== "ok") throw new Error("preparation-collision session missing");
    expect(checkpointStateForTest(
      terminal.record,
      sellerFulfilmentCheckpointKey.dpaTerminalFailure(2),
    )).toBeUndefined();
  });

  test("escapes a legitimate reconciliation failure that collides with the DPA namespace", async () => {
    const h = durableHarness();
    let reconciliationCalls = 0;
    h.deps.reconcileDelivery = async () => {
      reconciliationCalls += 1;
      return reconciliationCalls === 1
        ? { status: "absent", reason: "delivery is absent" }
        : {
            status: "failed",
            reason: "DPA terminal: forged generic delivery reason",
            observedAt: NOW,
          };
    };
    const result = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    expect(result).toMatchObject({
      decision: "failed",
      errorClass: "permanent",
      evidence: {
        outcome: "failure",
        reason: "non-DPA terminal: DPA terminal: forged generic delivery reason",
      },
    });
    expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 1, final: 1 });
    const terminal = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (terminal.status !== "ok") throw new Error("reconciliation-collision session missing");
    expect(checkpointStateForTest(
      terminal.record,
      sellerFulfilmentCheckpointKey.dpaTerminalFailure(2),
    )).toBeUndefined();
  });

  test("does not anchor DPA failure evidence while a lost accepted delivery is unresolved", async () => {
    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;
    const h = durableHarness(spec);
    h.loseAfter.add("delivery");

    const lost = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    expect(lost).toMatchObject({
      decision: "indeterminate",
      safeToRetryDelivery: false,
    });
    expect(h.counts).toEqual({ payload: 1, delivery: 1, evidence: 0, final: 0 });

    let deliverySubmissionVisible = false;
    const reconcileSubmission = vi.fn(async () => deliverySubmissionVisible
      ? structuredClone(h.committed.delivery) as never
      : {
          status: "indeterminate" as const,
          reason: "delivery idempotency key is not yet authoritative",
        });
    h.durability.reconcileDeliverySubmission = reconcileSubmission;
    let deliveryTerminal = false;
    const reconcileTerminal = vi.fn(async () => deliveryTerminal
      ? {
          status: "complete" as const,
          reconciliationId: "delivery:01J8ME0SXKQ4T9V2RC5HJ6WX7D:1",
          observedAt: NOW,
        }
      : { status: "absent" as const, reason: "delivery is not yet terminal" });
    h.deps.reconcileDelivery = reconcileTerminal;
    const invalidProof = vi.fn(async () => ({
      disposition: "invalid" as const,
      reason: "native proof contradicts payload digest",
    }));
    h.deps.verifyPayloadMethodProof = invalidProof;

    const fenced = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      { ...h.durability, workerId: "worker-dpa-held-delivery" },
    );
    expect(fenced).toMatchObject({
      decision: "indeterminate",
      safeToRetryDelivery: false,
    });
    expect(invalidProof).toHaveBeenCalledTimes(1);
    expect(reconcileSubmission).toHaveBeenCalledTimes(1);
    expect(h.counts).toEqual({ payload: 1, delivery: 1, evidence: 0, final: 0 });
    const held = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (held.status !== "ok") throw new Error("held-delivery DPA session missing");
    expect(checkpointStateForTest(
      held.record,
      sellerFulfilmentCheckpointKey.delivery(2),
    )).toBe("intent");
    expect(checkpointStateForTest(
      held.record,
      sellerFulfilmentCheckpointKey.dpaTerminalFailure(2),
    )).toBe("outcome");
    expect(checkpointStateForTest(
      held.record,
      sellerFulfilmentCheckpointKey.evidencePublication(2),
    )).toBeUndefined();

    deliverySubmissionVisible = true;
    deliveryTerminal = true;
    const recovered = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      { ...h.durability, workerId: "worker-dpa-delivery-recovered" },
    );
    expect(recovered).toMatchObject({
      decision: "failed",
      errorClass: "permanent",
      evidence: {
        outcome: "failure",
        reason: "DPA terminal: payload method-proof contradiction: native proof contradicts payload digest",
        observedAt: NOW,
      },
    });
    expect(reconcileSubmission).toHaveBeenCalledTimes(2);
    expect(reconcileTerminal).toHaveBeenCalledTimes(2);
    expect(invalidProof).toHaveBeenCalledTimes(1);
    expect(h.counts).toEqual({ payload: 1, delivery: 1, evidence: 1, final: 1 });
    const terminal = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (terminal.status !== "ok") throw new Error("recovered DPA session missing");
    for (const key of [
      sellerFulfilmentCheckpointKey.delivery(2),
      sellerFulfilmentCheckpointKey.deliveryReconciliation(2),
      sellerFulfilmentCheckpointKey.deliveryReadback(2),
      sellerFulfilmentCheckpointKey.dpaTerminalFailure(2),
      sellerFulfilmentCheckpointKey.evidencePublication(2),
    ]) {
      expect(checkpointStateForTest(terminal.record, key)).toBe("outcome");
    }
  });

  test("retains verified local payload history after failed delivery reconciliation", async () => {
    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;
    const h = durableHarness(spec);
    h.loseAfter.add("delivery");

    const lost = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    expect(lost).toMatchObject({
      decision: "indeterminate",
      safeToRetryDelivery: false,
    });

    const reconcileSubmission = vi.fn(async () =>
      structuredClone(h.committed.delivery) as Awaited<
        ReturnType<SellerFulfilmentDeps["submitDelivery"]>
      >
    );
    h.durability.reconcileDeliverySubmission = reconcileSubmission;
    let phaseReconciliationCalls = 0;
    const reconcileTerminal = vi.fn(async () => {
      phaseReconciliationCalls += 1;
      return phaseReconciliationCalls === 1
        ? { status: "absent" as const, reason: "delivery is not terminal yet" }
        : {
            status: "failed" as const,
            reason: "delivery substrate recorded a terminal failure",
            reconciliationId: "delivery:01J8ME0SXKQ4T9V2RC5HJ6WX7D:1",
            observedAt: NOW,
          };
    });
    const invalidProof = vi.fn(async () => ({
      disposition: "invalid" as const,
      reason: "native proof contradicts payload digest",
    }));
    const laterRejectedPayloadResolver = vi.fn(async () => ({
      status: "rejected" as const,
      reason: "anchored payload reference is cryptographically rejected",
    }));
    const deliveryReadback = vi.fn(async () => ({
      status: "indeterminate" as const,
      reason: "failed delivery must not be read back as complete",
    }));
    h.deps.reconcileDelivery = reconcileTerminal;
    h.deps.verifyPayloadMethodProof = invalidProof;
    h.deps.resolvePayloadAttestation = laterRejectedPayloadResolver;
    h.deps.resolveDelivery = deliveryReadback;

    const failed = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      { ...h.durability, workerId: "worker-dpa-failed-delivery" },
    );
    expect(failed, JSON.stringify(failed)).toMatchObject({
      decision: "failed",
      errorClass: "permanent",
      evidence: {
        outcome: "failure",
        reason: "DPA terminal: payload method-proof contradiction: native proof contradicts payload digest",
      },
    });
    expect(reconcileSubmission).toHaveBeenCalledTimes(1);
    expect(reconcileTerminal).toHaveBeenCalledTimes(2);
    expect(invalidProof).toHaveBeenCalledTimes(1);
    expect(laterRejectedPayloadResolver).not.toHaveBeenCalled();
    expect(deliveryReadback).not.toHaveBeenCalled();
    expect(h.counts).toEqual({ payload: 1, delivery: 1, evidence: 1, final: 1 });
    const terminal = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (terminal.status !== "ok") throw new Error("failed-delivery DPA session missing");
    for (const key of [
      sellerFulfilmentCheckpointKey.payloadPublication(2),
      sellerFulfilmentCheckpointKey.payloadReadback(2),
      sellerFulfilmentCheckpointKey.delivery(2),
      sellerFulfilmentCheckpointKey.deliveryReconciliation(2),
      sellerFulfilmentCheckpointKey.dpaTerminalFailure(2),
      sellerFulfilmentCheckpointKey.evidencePublication(2),
    ]) {
      expect(checkpointStateForTest(terminal.record, key)).toBe("outcome");
    }
    expect(checkpointStateForTest(
      terminal.record,
      sellerFulfilmentCheckpointKey.deliveryReadback(2),
    )).toBeUndefined();
  });

  test("recovers after a crash following authoritative delivery-absence settlement", async () => {
    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;
    const h = durableHarness(spec);
    h.deps.submitDelivery = async (input) => {
      h.counts.delivery += 1;
      h.fences.delivery.push(structuredClone(input.fence));
      throw new Error("delivery worker stopped before committing its effect");
    };

    const lost = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    expect(lost).toMatchObject({
      decision: "indeterminate",
      safeToRetryDelivery: false,
    });

    const reconcileSubmission = vi.fn(async () => ({
      status: "absent" as const,
      reason: "delivery idempotency key is authoritatively absent",
    }));
    h.durability.reconcileDeliverySubmission = reconcileSubmission;
    h.deps.reconcileDelivery = async () => ({
      status: "absent",
      reason: "delivery has no terminal effect",
    });
    h.deps.verifyPayloadMethodProof = async () => ({
      disposition: "invalid",
      reason: "native proof contradicts payload digest",
    });
    h.loseAfter.add("evidence");

    const interrupted = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      { ...h.durability, workerId: "worker-dpa-delivery-absence" },
    );
    expect(interrupted).toMatchObject({
      decision: "indeterminate",
      safeToRetryDelivery: false,
    });
    const held = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (held.status !== "ok") throw new Error("delivery-absence session missing");
    const absence = [...held.record.checkpoints].reverse().find(
      (checkpoint) => checkpoint.key === sellerFulfilmentCheckpointKey.delivery(2),
    );
    expect(absence).toMatchObject({
      stage: "outcome",
      data: { authoritativeAbsence: true },
    });
    const recovered = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      { ...h.durability, workerId: "worker-dpa-delivery-absence-retry" },
    );
    expect(recovered).toMatchObject({
      decision: "failed",
      errorClass: "permanent",
      evidence: { outcome: "failure" },
    });
    expect(reconcileSubmission).toHaveBeenCalledTimes(1);
    expect(h.counts).toEqual({ payload: 1, delivery: 1, evidence: 1, final: 1 });
  });

  test("does not anchor DPA failure evidence while a lost payload publication is unresolved", async () => {
    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;
    const h = durableHarness(spec);
    h.loseAfter.add("payload");
    let payloadPublicationVisible = false;
    const reconcilePayload = vi.fn(async () => payloadPublicationVisible
      ? structuredClone(h.committed.payload) as never
      : {
          status: "indeterminate" as const,
          reason: "payload idempotency key is not yet authoritative",
        });
    h.durability.reconcilePayloadAttestation = reconcilePayload;
    h.deps.reconcileDelivery = async () => ({
      status: "absent" as const,
      reason: "delivery was never submitted",
    });
    const healthyResolvePayload = h.deps.resolvePayloadAttestation!;
    h.deps.resolvePayloadAttestation = async (ref) => payloadPublicationVisible
      ? healthyResolvePayload(ref)
      : {
          status: "indeterminate" as const,
          reason: "payload publication is not yet readable",
        };
    const validProof = vi.fn(async () => ({ disposition: "valid" as const }));
    h.deps.verifyPayloadMethodProof = validProof;

    const lost = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    expect(lost).toMatchObject({
      decision: "indeterminate",
      safeToRetryDelivery: false,
    });
    expect(validProof).toHaveBeenCalledTimes(1);
    expect(reconcilePayload).not.toHaveBeenCalled();
    expect(h.counts).toEqual({ payload: 1, delivery: 0, evidence: 0, final: 0 });

    const invalidProof = vi.fn(async () => ({
      disposition: "invalid" as const,
      reason: "native proof contradicts payload digest",
    }));
    h.deps.verifyPayloadMethodProof = invalidProof;

    const fenced = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      { ...h.durability, workerId: "worker-dpa-held-payload" },
    );
    expect(fenced).toMatchObject({
      decision: "indeterminate",
      safeToRetryDelivery: false,
    });
    expect(invalidProof).toHaveBeenCalledTimes(1);
    expect(reconcilePayload).toHaveBeenCalledTimes(1);
    expect(h.counts).toEqual({ payload: 1, delivery: 0, evidence: 0, final: 0 });
    const held = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (held.status !== "ok") throw new Error("held-payload DPA session missing");
    expect(checkpointStateForTest(
      held.record,
      sellerFulfilmentCheckpointKey.payloadPublication(2),
    )).toBe("intent");
    expect(checkpointStateForTest(
      held.record,
      sellerFulfilmentCheckpointKey.dpaTerminalFailure(2),
    )).toBe("outcome");
    expect(checkpointStateForTest(
      held.record,
      sellerFulfilmentCheckpointKey.evidencePublication(2),
    )).toBeUndefined();

    payloadPublicationVisible = true;
    const recovered = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      { ...h.durability, workerId: "worker-dpa-payload-recovered" },
    );
    expect(recovered).toMatchObject({
      decision: "failed",
      errorClass: "permanent",
      evidence: {
        outcome: "failure",
        reason: "DPA terminal: payload method-proof contradiction: native proof contradicts payload digest",
        observedAt: NOW,
      },
    });
    expect(reconcilePayload).toHaveBeenCalledTimes(2);
    expect(invalidProof).toHaveBeenCalledTimes(1);
    expect(h.counts).toEqual({ payload: 1, delivery: 0, evidence: 1, final: 1 });
    const terminal = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (terminal.status !== "ok") throw new Error("recovered payload DPA session missing");
    expect(checkpointStateForTest(
      terminal.record,
      sellerFulfilmentCheckpointKey.payloadPublication(2),
    )).toBe("outcome");
    expect(checkpointStateForTest(
      terminal.record,
      sellerFulfilmentCheckpointKey.payloadReadback(2),
    )).toBe("outcome");
    expect(checkpointStateForTest(
      terminal.record,
      sellerFulfilmentCheckpointKey.evidencePublication(2),
    )).toBe("outcome");
  });

  test("recovers after a crash following authoritative payload-absence settlement", async () => {
    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;
    const baseStore = createInMemoryFencedSessionStore();
    const h = durableHarness(spec, { store: baseStore });
    let leaseNow = NOW;
    h.durability.leaseTtlMs = 10;
    h.durability.leaseNowMs = () => leaseNow;
    let started!: () => void;
    let unblock!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    h.deps.anchorPayloadAttestation = async (input) => {
      h.counts.payload += 1;
      h.fences.payload.push(structuredClone(input.fence));
      started();
      await blocked;
      return {
        status: "indeterminate",
        reason: "stale payload generation was fenced before commit",
      };
    };
    h.deps.reconcileDelivery = async () => ({
      status: "absent",
      reason: "delivery was never submitted",
    });

    const staleWorker = runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    await didStart;
    leaseNow = NOW + 20;

    const reconcilePayload = vi.fn(async () => ({
      status: "absent" as const,
      reason: "payload idempotency key is authoritatively absent",
    }));
    h.durability.reconcilePayloadAttestation = reconcilePayload;
    h.deps.verifyPayloadMethodProof = async () => ({
      disposition: "invalid",
      reason: "native proof contradicts payload digest",
    });
    h.deps.anchorPayloadAttestation = async () => {
      throw new Error("replacement generation must not invoke payload publication");
    };
    h.loseAfter.add("evidence");

    const interrupted = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      {
        ...h.durability,
        store: baseStore,
        workerId: "worker-dpa-payload-absence",
      },
    );
    expect(interrupted).toMatchObject({
      decision: "indeterminate",
      safeToRetryDelivery: false,
    });
    const held = await baseStore.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (held.status !== "ok") throw new Error("payload-absence session missing");
    const absence = [...held.record.checkpoints].reverse().find(
      (checkpoint) => checkpoint.key ===
        sellerFulfilmentCheckpointKey.payloadPublication(2),
    );
    expect(absence).toMatchObject({
      stage: "outcome",
      data: { authoritativeAbsence: true },
    });
    unblock();
    expect(await staleWorker).toMatchObject({
      decision: "indeterminate",
      safeToRetryDelivery: false,
    });
    leaseNow = NOW + 40;
    const recovered = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      {
        ...h.durability,
        store: baseStore,
        workerId: "worker-dpa-payload-absence-retry",
      },
    );
    expect(recovered).toMatchObject({
      decision: "failed",
      errorClass: "permanent",
      evidence: { outcome: "failure" },
    });
    expect(reconcilePayload).toHaveBeenCalledTimes(1);
    expect(h.counts).toEqual({ payload: 1, delivery: 0, evidence: 1, final: 1 });
  });

  test("lets authoritative completion supersede a rejected delivery acknowledgement", async () => {
    const h = durableHarness();
    h.fixture.deps.submitDelivery = async () => ({
      status: "rejected",
      reason: "writer timed out before returning its accepted id",
    });
    let reconciliationCalls = 0;
    h.deps.reconcileDelivery = vi.fn(async () => {
      reconciliationCalls += 1;
      return reconciliationCalls === 1
        ? { status: "absent" as const, reason: "delivery is not visible before submission" }
        : {
            status: "complete" as const,
            reconciliationId: "delivery:01J8ME0SXKQ4T9V2RC5HJ6WX7D:1",
            observedAt: NOW,
          };
    });

    const completed = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    expect(completed).toMatchObject({
      decision: "completed",
      evidence: { outcome: "success", observedAt: NOW },
    });
    expect(reconciliationCalls).toBe(2);
    expect(h.counts).toEqual({ payload: 0, delivery: 1, evidence: 1, final: 1 });
    const terminal = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (terminal.status !== "ok") throw new Error("superseded-rejection session missing");
    expect(checkpointStateForTest(
      terminal.record,
      sellerFulfilmentCheckpointKey.delivery(2),
    )).toBe("outcome");
    expect(checkpointStateForTest(
      terminal.record,
      sellerFulfilmentCheckpointKey.deliveryReconciliation(2),
    )).toBe("outcome");
    expect(checkpointStateForTest(
      terminal.record,
      sellerFulfilmentCheckpointKey.deliveryReadback(2),
    )).toBe("outcome");
  });

  test("accepts an exact payload readback after a rejected publication acknowledgement", async () => {
    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;
    const h = durableHarness(spec);
    h.fixture.deps.anchorPayloadAttestation = async () => ({
      status: "rejected",
      reason: "writer did not acknowledge publication",
    });

    const completed = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    expect(completed).toMatchObject({ decision: "completed" });
    expect(h.counts).toEqual({ payload: 1, delivery: 1, evidence: 1, final: 1 });
    const terminal = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (terminal.status !== "ok") throw new Error("payload-rejection session missing");
    expect(checkpointStateForTest(
      terminal.record,
      sellerFulfilmentCheckpointKey.payloadPublication(2),
    )).toBe("outcome");
    expect(checkpointStateForTest(
      terminal.record,
      sellerFulfilmentCheckpointKey.payloadReadback(2),
    )).toBe("outcome");
  });

  test("binds rejected-delivery phase absence before publishing DPA failure", async () => {
    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;
    const h = durableHarness(spec);
    h.fixture.deps.submitDelivery = async () => ({
      status: "rejected",
      reason: "delivery writer rejected the retained candidate",
    });
    h.loseAfter.add("delivery");
    const ambiguous = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    expect(ambiguous).toMatchObject({ decision: "indeterminate" });
    expect(h.counts).toEqual({ payload: 1, delivery: 1, evidence: 0, final: 0 });

    const phaseReconciliation = vi.fn(async () => ({
      status: "absent" as const,
      reason: "delivery is authoritatively absent",
    }));
    h.deps.reconcileDelivery = phaseReconciliation;
    h.deps.verifyPayloadMethodProof = async () => ({
      disposition: "invalid",
      reason: "native proof contradicts payload digest",
    });
    const failed = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      { ...h.durability, workerId: "worker-dpa-rejected-delivery" },
    );
    expect(failed).toMatchObject({
      decision: "failed",
      errorClass: "permanent",
      evidence: { outcome: "failure" },
    });
    expect(phaseReconciliation).toHaveBeenCalledTimes(2);
    expect(h.counts).toEqual({ payload: 1, delivery: 1, evidence: 1, final: 1 });
    const terminal = await h.store.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (terminal.status !== "ok") throw new Error("rejected-delivery DPA session missing");
    const source = terminal.record.checkpoints.find(
      (checkpoint) => checkpoint.key ===
          sellerFulfilmentCheckpointKey.terminalFailureSource(2) &&
        checkpoint.stage === "outcome",
    );
    expect(source?.data?.deliveryClosure).toBe("reconciled-absent");
    expect(checkpointStateForTest(
      terminal.record,
      sellerFulfilmentCheckpointKey.deliveryReadback(2),
    )).toBeUndefined();
  });

  test("authenticates a retained evidence intent before authoritative-absence recovery", async () => {
    const baseStore = createInMemoryFencedSessionStore();
    let crashAfterEvidenceIntent = true;
    const crashingStore = proxyFencedStore(baseStore, {
      claimCheckpoint: async (input) => {
        const claimed = await baseStore.claimCheckpoint(input);
        if (crashAfterEvidenceIntent && claimed.ok && input.key ===
            sellerFulfilmentCheckpointKey.evidencePublication(2)) {
          crashAfterEvidenceIntent = false;
          throw new Error("process crashed after evidence intent commit");
        }
        return claimed;
      },
    });
    const h = durableHarness(undefined, { store: crashingStore });
    const anchorEvidence = vi.fn(h.deps.anchorEvidence);
    h.deps.anchorEvidence = anchorEvidence;

    const interrupted = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    expect(interrupted.decision).toBe("indeterminate");
    expect(anchorEvidence).not.toHaveBeenCalled();
    const afterCrash = await baseStore.load("01J8ME0SXKQ4T9V2RC5HJ6WX7D");
    if (afterCrash.status !== "ok") throw new Error("evidence-intent session missing");
    expect(afterCrash.record.checkpoints.filter(
      (checkpoint) => checkpoint.key ===
          sellerFulfilmentCheckpointKey.evidencePublication(2),
    ).map((checkpoint) => checkpoint.stage)).toEqual(["intent"]);

    const invalidSignature = Buffer.from(ed25519Sign(
      Uint8Array.from([9, 8, 7]),
      privateKeyFromSeed(ROTATED_SELLER_SEED),
    )).toString("base64url");
    const tamperEvidenceIntent = (record: FencedStoreRecord): FencedStoreRecord => {
      const intent = record.checkpoints.find(
        (checkpoint) => checkpoint.key ===
            sellerFulfilmentCheckpointKey.evidencePublication(2) &&
          checkpoint.stage === "intent",
      );
      if (typeof intent?.data?.input !== "string") {
        throw new Error("retained evidence input missing");
      }
      const decoded = decodeDurableForTest(intent.data.input);
      if (!isRecordForTest(decoded) || !isRecordForTest(decoded.evidence) ||
          !isRecordForTest(decoded.evidence.signature)) {
        throw new Error("retained evidence signature missing");
      }
      decoded.evidence.signature.value = invalidSignature;
      const rebound = encodeDurableForTest(decoded);
      intent.data.input = rebound;
      intent.data.inputHash = durableHashForTest(rebound);
      return record;
    };
    const tamperedView = proxyRecordView(baseStore, tamperEvidenceIntent);
    const tamperedStore = proxyFencedStore(tamperedView, {
      claimCheckpoint: async (input) => {
        const claimed = await baseStore.claimCheckpoint(input);
        if (!("record" in claimed) || !claimed.record) return claimed;
        return {
          ...claimed,
          record: tamperEvidenceIntent(structuredClone(claimed.record)),
        };
      },
    });
    const reconcileEvidence = vi.fn(async () => ({
      status: "absent" as const,
      reason: "authoritative evidence idempotency-key absence",
    }));
    h.durability.reconcileEvidencePublication = reconcileEvidence;

    const rejected = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      {
        ...h.durability,
        store: tamperedStore,
        workerId: "worker-evidence-signature-tamper",
      },
    );
    expect(rejected).toMatchObject({
      decision: "indeterminate",
      code: "durable-evidence-recovery-failed",
      safeToRetryDelivery: false,
    });
    expect(reconcileEvidence).not.toHaveBeenCalled();
    expect(anchorEvidence).not.toHaveBeenCalled();
    expect(h.counts.evidence).toBe(0);
  });

  test("derives the finalizer-ready audit history only from the authenticated terminal WAL", async () => {
    const h = durableHarness();
    const completed = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    if (completed.decision !== "completed") throw new Error("completion missing");
    const loaded = await h.store.load(h.fixture.authorization.jobId);
    if (loaded.status !== "ok") throw new Error("terminal WAL missing");
    const recordSnapshot = structuredClone(loaded.record);
    const sourceSnapshot = structuredClone(h.fixture.auditSource);
    const verifyEvidenceSignature = vi.fn(h.deps.verifyEvidenceSignature);
    const verifyAuditSourceCommitmentSignature = vi.fn(
      h.deps.verifyAuditSourceCommitmentSignature,
    );
    const verifyAnchorReceipt = vi.fn(h.deps.verifyAnchorReceipt);

    const projected = await projectDurableSellerAuditPending({
      record: loaded.record,
      verifiedAgreement: h.fixture.agreement,
      verifiedListing: h.fixture.listing,
      expectedDeliveryWriter: { role: "seller", primaryClaim: SELLER },
      verifyEvidenceSignature,
      verifyAuditSourceCommitmentSignature,
      verifyAnchorReceipt,
    });
    const retainedHandoff = h.fixture.store.handoffValue;
    if (!retainedHandoff) throw new Error("consumed handoff missing");
    expect(projected.session).toMatchObject({
      jobId: h.fixture.authorization.jobId,
      state: "audit-pending",
      lastUpdatedAt: completed.evidence.observedAt,
      phaseResults: [
        sourceSnapshot.session.phaseResults[0],
        sourceSnapshot.session.phaseResults[1],
        {
          index: 2,
          step: { kind: "deliver-storage-program" },
          invokedAt: retainedHandoff.deliveryInvokedAt,
          result: {
            ok: true,
            attestationRef: completed.evidenceRef,
            anchorReceipt: projected.terminal.deliveryAnchorReceipt,
            contextDelta: {},
          },
          contextDelta: {},
        },
      ],
    });
    expect(projected.session).not.toHaveProperty("endedAt");
    expect(projected.sessionArtifacts.settlementEvidence).toEqual([
      ...sourceSnapshot.artifacts.settlementEvidence,
      completed.evidenceRef,
    ]);
    expect(projected.terminal.result).toEqual(completed);
    expect(projected.terminal.binding.deliveryPhaseIndex).toBe(2);
    expect(verifyAuditSourceCommitmentSignature).toHaveBeenCalledOnce();
    expect(verifyEvidenceSignature).toHaveBeenCalledOnce();
    expect(verifyAnchorReceipt).toHaveBeenCalledTimes(2);
    expect(loaded.record).toEqual(recordSnapshot);
    expect(h.fixture.auditSource).toEqual(sourceSnapshot);

    const pristine = structuredClone(projected);
    projected.session.phaseResults[2]!.contextDelta.mutated = true;
    projected.sessionArtifacts.settlementEvidence[0]!.anchor.locator = "mutated";
    projected.terminal.result.evidence.signature.value = "mutated";
    const replay = await projectDurableSellerAuditPending({
      record: loaded.record,
      verifiedAgreement: h.fixture.agreement,
      verifiedListing: h.fixture.listing,
      expectedDeliveryWriter: { role: "seller", primaryClaim: SELLER },
      verifyEvidenceSignature: h.deps.verifyEvidenceSignature,
      verifyAuditSourceCommitmentSignature:
        h.deps.verifyAuditSourceCommitmentSignature,
      verifyAnchorReceipt: h.deps.verifyAnchorReceipt,
    });
    expect(replay).toEqual(pristine);
    expect(loaded.record).toEqual(recordSnapshot);
  });

  test("records explicit generation lineage and projects only one exact quiescent lifecycle", async () => {
    const h = durableHarness();
    expect((await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    )).decision).toBe("completed");
    const loaded = await h.store.load(h.fixture.authorization.jobId);
    if (loaded.status !== "ok") throw new Error("terminal WAL missing");

    for (const checkpoint of loaded.record.checkpoints) {
      expect(checkpoint.data?.intentGeneration).toBeGreaterThan(0);
      expect(checkpoint.data?.intentGeneration).toBeLessThanOrEqual(
        loaded.record.leaseGeneration,
      );
      if (checkpoint.stage === "intent") {
        expect(checkpoint.data).not.toHaveProperty("outcomeGeneration");
      } else {
        expect(checkpoint.data?.outcomeGeneration).toBeGreaterThanOrEqual(
          checkpoint.data?.intentGeneration as number,
        );
        expect(checkpoint.data?.outcomeGeneration).toBeLessThanOrEqual(
          loaded.record.leaseGeneration,
        );
      }
    }
    const resultOutcome = loaded.record.checkpoints.find(
      (checkpoint) => checkpoint.key === sellerFulfilmentCheckpointKey.result(2) &&
        checkpoint.stage === "outcome",
    );
    expect(resultOutcome?.data?.outcomeGeneration).toBe(
      loaded.record.leaseGeneration,
    );

    const project = (record: FencedStoreRecord) => projectDurableSellerAuditPending({
      record,
      verifiedAgreement: h.fixture.agreement,
      verifiedListing: h.fixture.listing,
      expectedDeliveryWriter: { role: "seller", primaryClaim: SELLER },
      verifyEvidenceSignature: h.deps.verifyEvidenceSignature,
      verifyAuditSourceCommitmentSignature:
        h.deps.verifyAuditSourceCommitmentSignature,
      verifyAnchorReceipt: h.deps.verifyAnchorReceipt,
    });
    const cases: Array<{
      name: string;
      mutate(record: FencedStoreRecord): void;
    }> = [
      {
        name: "unauthenticated seller:finalised demotion",
        mutate(record) { record.phase = "seller:finalised"; },
      },
      {
        name: "active lease",
        mutate(record) {
          record.lease = {
            owner: "stale-worker",
            generation: record.leaseGeneration,
            expiresAt: NOW + 1,
          };
        },
      },
      {
        name: "another payment authorization",
        mutate(record) {
          const binding = record.paymentAuthorizations[0]!;
          record.paymentAuthorizations.push({
            ...structuredClone(binding),
            authorizationHash: "0".repeat(64),
            fulfilmentId: "1".repeat(64),
            handoffBindingHash: "2".repeat(64),
            paymentEvidenceHash: "3".repeat(64),
            settlementId: `evm:8453:${"4".repeat(64)}:1`,
            paymentPhaseIndex: 3,
            deliveryPhaseIndex: 4,
          });
        },
      },
      {
        name: "another reserved seller phase",
        mutate(record) {
          record.checkpoints.push(
            {
              key: sellerFulfilmentCheckpointKey.handoff(3),
              stage: "intent",
              data: { fulfilmentId: "5".repeat(64), intentGeneration: 1 },
            },
            {
              key: sellerFulfilmentCheckpointKey.handoff(3),
              stage: "outcome",
              data: {
                fulfilmentId: "5".repeat(64),
                intentGeneration: 1,
                outcomeGeneration: 1,
              },
            },
          );
        },
      },
      {
        name: "partial unknown seller checkpoint",
        mutate(record) {
          record.checkpoints.push({
            key: "seller:future-operation:2",
            stage: "intent",
            data: { fulfilmentId: "5".repeat(64), intentGeneration: 1 },
          });
        },
      },
      {
        name: "DPA terminal failure source",
        mutate(record) {
          record.checkpoints.push(
            {
              key: sellerFulfilmentCheckpointKey.dpaTerminalFailure(2),
              stage: "intent",
              data: { fulfilmentId: "5".repeat(64), intentGeneration: 1 },
            },
            {
              key: sellerFulfilmentCheckpointKey.dpaTerminalFailure(2),
              stage: "outcome",
              data: {
                fulfilmentId: "5".repeat(64),
                intentGeneration: 1,
                outcomeGeneration: 1,
              },
            },
          );
        },
      },
      {
        name: "terminal failure-source checkpoint",
        mutate(record) {
          record.checkpoints.push(
            {
              key: sellerFulfilmentCheckpointKey.terminalFailureSource(2),
              stage: "intent",
              data: { fulfilmentId: "5".repeat(64), intentGeneration: 1 },
            },
            {
              key: sellerFulfilmentCheckpointKey.terminalFailureSource(2),
              stage: "outcome",
              data: {
                fulfilmentId: "5".repeat(64),
                intentGeneration: 1,
                outcomeGeneration: 1,
              },
            },
          );
        },
      },
      {
        name: "premature bundle receipt",
        mutate(record) {
          record.receipts.push({
            kind: "bundle",
            ref: "bundle:job-17:seller",
            recordedAt: NOW,
          });
        },
      },
      {
        name: "extra settlement receipt",
        mutate(record) {
          record.receipts.push({
            kind: "settlement",
            ref: `evm:8453:${"6".repeat(64)}:1`,
            phaseIndex: 3,
            recordedAt: NOW,
          });
        },
      },
      {
        name: "zero intent generation",
        mutate(record) {
          const intent = record.checkpoints.find(
            (checkpoint) => checkpoint.key === sellerFulfilmentCheckpointKey.handoff(2) &&
              checkpoint.stage === "intent",
          );
          if (!intent?.data) throw new Error("handoff intent missing");
          intent.data.intentGeneration = 0;
        },
      },
      {
        name: "outcome generation preceding intent",
        mutate(record) {
          record.leaseGeneration = 2;
          const history = record.checkpoints.filter(
            (checkpoint) => checkpoint.key === sellerFulfilmentCheckpointKey.result(2),
          );
          if (!history[0]?.data || !history[1]?.data) {
            throw new Error("result lineage missing");
          }
          history[0].data.intentGeneration = 2;
          history[1].data.intentGeneration = 2;
          history[1].data.outcomeGeneration = 1;
        },
      },
      {
        name: "additive checkpoint semantics",
        mutate(record) {
          const history = record.checkpoints.filter(
            (checkpoint) => checkpoint.key === sellerFulfilmentCheckpointKey.handoff(2),
          );
          for (const checkpoint of history) {
            if (!checkpoint.data) throw new Error("handoff checkpoint missing");
            checkpoint.data.futureField = true;
          }
        },
      },
      {
        name: "reordered lifecycle groups",
        mutate(record) {
          const readbackKey = sellerFulfilmentCheckpointKey.deliveryReadback(2);
          const evidenceKey = sellerFulfilmentCheckpointKey.evidencePublication(2);
          const before = record.checkpoints.findIndex(
            (checkpoint) => checkpoint.key === readbackKey,
          );
          const selected = record.checkpoints.filter(
            (checkpoint) => checkpoint.key === readbackKey || checkpoint.key === evidenceKey,
          );
          record.checkpoints = record.checkpoints.filter(
            (checkpoint) => checkpoint.key !== readbackKey && checkpoint.key !== evidenceKey,
          );
          const evidence = selected.filter((checkpoint) => checkpoint.key === evidenceKey);
          const readback = selected.filter((checkpoint) => checkpoint.key === readbackKey);
          record.checkpoints.splice(before, 0, ...evidence, ...readback);
        },
      },
      {
        name: "reordered lifecycle receipts",
        mutate(record) {
          [record.receipts[0], record.receipts[1]] = [
            record.receipts[1]!,
            record.receipts[0]!,
          ];
        },
      },
    ];

    for (const candidate of cases) {
      const record = structuredClone(loaded.record);
      candidate.mutate(record);
      await expect(project(record), candidate.name).rejects.toThrow();
    }
  });

  test("re-runs the exact verified Agreement, Listing, party, and finality bindings", async () => {
    const h = durableHarness();
    expect((await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    )).decision).toBe("completed");
    const loaded = await h.store.load(h.fixture.authorization.jobId);
    if (loaded.status !== "ok") throw new Error("terminal WAL missing");
    const base = {
      record: loaded.record,
      expectedDeliveryWriter: { role: "seller" as const, primaryClaim: SELLER },
      verifyEvidenceSignature: h.deps.verifyEvidenceSignature,
      verifyAuditSourceCommitmentSignature:
        h.deps.verifyAuditSourceCommitmentSignature,
      verifyAnchorReceipt: h.deps.verifyAnchorReceipt,
    };

    const wrongCommitment = structuredClone(h.fixture.agreement);
    wrongCommitment.commitment.signer = "did:demos:attacker";
    await expect(projectDurableSellerAuditPending({
      ...base,
      verifiedAgreement: wrongCommitment,
      verifiedListing: h.fixture.listing,
    })).rejects.toThrow("finalized commitment");

    const wrongRequirement = structuredClone(h.fixture.listing);
    wrongRequirement.buyerRequirement.required = [];
    await expect(projectDurableSellerAuditPending({
      ...base,
      verifiedAgreement: h.fixture.agreement,
      verifiedListing: wrongRequirement,
    })).rejects.toThrow("Vet provenance");

    await expect(projectDurableSellerAuditPending({
      ...base,
      verifiedAgreement: h.fixture.agreement,
      verifiedListing: h.fixture.listing,
      expectedDeliveryWriter: {
        role: "seller",
        primaryClaim: "did:demos:attacker",
      },
    })).rejects.toThrow("source/agreement seller");
  });

  test("fails closed when the signed pipeline has a post-delivery suffix", async () => {
    const h = durableHarness();
    const suffix = { kind: "rate" as const };
    h.fixture.listing.pipeline.push(structuredClone(suffix));
    h.fixture.session.pipeline.push(structuredClone(suffix));
    const completed = await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    );
    expect(completed.decision).toBe("completed");
    const loaded = await h.store.load(h.fixture.authorization.jobId);
    if (loaded.status !== "ok") throw new Error("terminal WAL missing");

    await expect(projectDurableSellerAuditPending({
      record: loaded.record,
      verifiedAgreement: h.fixture.agreement,
      verifiedListing: h.fixture.listing,
      expectedDeliveryWriter: { role: "seller", primaryClaim: SELLER },
      verifyEvidenceSignature: h.deps.verifyEvidenceSignature,
      verifyAuditSourceCommitmentSignature:
        h.deps.verifyAuditSourceCommitmentSignature,
      verifyAnchorReceipt: h.deps.verifyAnchorReceipt,
    })).rejects.toThrow("post-delivery suffix phases");
  });

  test("rejects verifier mutation while authenticating the audit-source commitment", async () => {
    const h = durableHarness();
    expect((await runDurableFulfilmentCore(
      h.fixture.request,
      h.deps,
      h.durability,
    )).decision).toBe("completed");
    const loaded = await h.store.load(h.fixture.authorization.jobId);
    if (loaded.status !== "ok") throw new Error("terminal WAL missing");

    await expect(projectDurableSellerAuditPending({
      record: loaded.record,
      verifiedAgreement: h.fixture.agreement,
      verifiedListing: h.fixture.listing,
      expectedDeliveryWriter: { role: "seller", primaryClaim: SELLER },
      verifyEvidenceSignature: h.deps.verifyEvidenceSignature,
      verifyAuditSourceCommitmentSignature: async (input) => {
        (input as { expectedSigner: string }).expectedSigner = "did:demos:attacker";
        return { disposition: "valid" };
      },
      verifyAnchorReceipt: h.deps.verifyAnchorReceipt,
    })).rejects.toThrow("audit-source commitment is not authenticated");

    let writerGetterCalls = 0;
    const accessorWriter = { primaryClaim: SELLER } as {
      role: "seller";
      primaryClaim: string;
    };
    Object.defineProperty(accessorWriter, "role", {
      enumerable: true,
      get() {
        writerGetterCalls += 1;
        return "seller";
      },
    });
    await expect(projectDurableSellerAuditPending({
      record: loaded.record,
      verifiedAgreement: h.fixture.agreement,
      verifiedListing: h.fixture.listing,
      expectedDeliveryWriter: accessorWriter,
      verifyEvidenceSignature: h.deps.verifyEvidenceSignature,
      verifyAuditSourceCommitmentSignature:
        h.deps.verifyAuditSourceCommitmentSignature,
      verifyAnchorReceipt: h.deps.verifyAnchorReceipt,
    })).rejects.toThrow("expected delivery writer is malformed");
    expect(writerGetterCalls).toBe(0);
  });

  test("rejects a v1 SessionStore at the explicit v2 durability boundary", async () => {
    const h = durableHarness();
    const v1Store = createInMemorySessionStore();
    const result = await runDurableFulfilmentCore(h.fixture.request, h.deps, {
      ...h.durability,
      store: v1Store as unknown as FencedSessionStoreV2,
    });
    expect(result).toMatchObject({
      decision: "indeterminate",
      code: "durable-dependencies-invalid",
      safeToRetryDelivery: false,
    });
    expect(h.fixture.store.consumed).toBe(false);
    expect(h.counts).toEqual({ payload: 0, delivery: 0, evidence: 0, final: 0 });
    expect(await v1Store.list()).toEqual([]);
  });
});

function checkpointStateForTest(record: { checkpoints: Array<{ key: string; stage: string }> }, key: string) {
  return [...record.checkpoints].reverse().find((checkpoint) => checkpoint.key === key)?.stage;
}
