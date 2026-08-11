import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";

import type { AnchorReceipt } from "../../src/artifacts/index.js";
import { canonicalize, contentHash, sha256Hex } from "../../src/canonical/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
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
  type SellerFulfilmentSessionRecord,
  type SellerPayloadAttestationRecord,
  type SignedSellerDeliveryEvidence,
} from "../../src/agent/runFulfilmentCore.js";
import { verifySettlementEvidence } from "../../src/agent/verifySettlementEvidence.js";
import type {
  SellerFulfilmentHandoff,
  SellerFulfilmentReceiptStore,
  SellerPaymentAuthorization,
  SellerPaymentEvidenceInput,
  SellerReceiptClaim,
} from "../../src/seller/paymentIntake.js";

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

function paymentAuthorization(): SellerPaymentAuthorization {
  const evidenceInput: SellerPaymentEvidenceInput = {
    evidenceVersion: "1",
    jobId: "job-17",
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
    jobId: "job-17",
    phaseIndex: 0,
    agreementHash: H.agreement,
    listingRef: { listingId: "listing-17", version: 4, contentHash: H.listing },
    railId: "x402-test",
    railRegistryVersion: 7,
    commitment: {
      ref: "commitment:job-17",
      contentHash: H.commitment,
      finalizedAt: NOW - 3_000,
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
    jobId: "job-17",
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
      jobId: "job-17",
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
          locator: `dacs4:payload-attestation:job-17:${methodHash}:0`,
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
  const listing: SellerFulfilmentListing = {
    pin: { ...authorization.listingRef },
    sellerPrimaryClaim: SELLER,
    pipeline: [
      { kind: "pay-x402", parameters: { rail: authorization.railId } },
      { kind: phase },
    ],
    deliverable: spec,
  };
  const agreement: SellerFulfilmentAgreement = {
    artifactKind: "payee-bound",
    ref: "agreement:job-17",
    contentHash: H.agreement,
    jobId: authorization.jobId,
    listingPin: { ...authorization.listingRef },
    buyer: {
      primaryClaim: BUYER,
      bundleHash: H.buyerBundle,
      storageAddress: "demos-address-buyer",
      encryptionKey: "demos-encryption-key-buyer",
    },
    seller: { primaryClaim: SELLER, bundleHash: H.sellerBundle },
    deliverableRef: {
      deliverableType: spec.kind,
      hash: sha256Hex(canonicalize(spec)),
      ...(spec.kind === "storage-program" && spec.schemaUrl ? { schemaUrl: spec.schemaUrl } : {}),
    },
    commitment: {
      status: "finalized",
      ref: "commitment:job-17",
      agreementHash: H.agreement,
      recordContentHash: H.commitment,
      finalizedAt: NOW - 3_000,
    },
  };
  const paymentRef = {
    anchor: {
      kind: "storage-program" as const,
      locator: `dacs4:payment:${authorization.jobId}:${authorization.railId}:0`,
    },
    contentHash: authorization.evidenceHash,
  };
  const session: SellerFulfilmentSessionRecord = {
    recordVersion: "1",
    jobId: authorization.jobId,
    state: "settle-pending",
    listingRef: { ...authorization.listingRef },
    parties: [
      { role: "buyer", bundleHash: H.buyerBundle, primaryClaim: BUYER },
      { role: "seller", bundleHash: H.sellerBundle, primaryClaim: SELLER },
      { role: "orchestrator", bundleHash: H.sellerBundle, primaryClaim: SELLER },
    ],
    pipeline: structuredClone(listing.pipeline),
    phaseResults: [{
      index: 0,
      step: structuredClone(listing.pipeline[0]!),
      invokedAt: NOW - 2_100,
      result: {
        ok: true,
        txRefs: structuredClone(authorization.evidenceInput.paymentTxRefs),
        contextDelta: {},
        attestationRef: paymentRef,
      },
      contextDelta: {},
    }],
    startedAt: NOW - 10_000,
    lastUpdatedAt: NOW - 2_000,
    recipeRegistryVersion: 3,
    railRegistryVersion: authorization.railRegistryVersion,
  };
  const artifact = defaultArtifact(spec);
  const preparedPayloadRecord = spec.kind === "attested-payload" && artifact.cleartextBytes
    ? payloadAttestationRecord(spec, artifact.cleartextBytes)
    : undefined;
  const logicalAddress = phase === "deliver-entitlement"
    ? "dacs4:entitlement:job-17:0"
    : "dacs4:deliverable:job-17";
  if (initiallyConsumed) {
    store.consumed = true;
    store.handoffValue = {
      handoffVersion: "1",
      fulfilmentId: sellerFulfilmentId({
        jobId: authorization.jobId,
        paymentPhaseIndex: authorization.phaseIndex,
        deliveryPhaseIndex: 1,
        settlementId: authorization.settlementId,
        agreementHash: authorization.agreementHash,
        paymentEvidenceHash: authorization.evidenceHash,
      }),
      jobId: authorization.jobId,
      agreementRef: agreement.ref,
      agreementHash: authorization.agreementHash,
      commitmentRef: agreement.commitment.ref,
      authorizationHash: sha256Hex(canonicalize(authorization)),
      settlementId: authorization.settlementId,
      paymentEvidenceHash: authorization.evidenceHash,
      paymentPhaseIndex: authorization.phaseIndex,
      deliveryPhaseIndex: 1,
      phase,
      logicalAddress,
      deliverableSpecHash: sha256Hex(canonicalize(spec)),
      agreementViewHash: sha256Hex(canonicalize(agreement)),
      validationFloorAt: Math.max(
        agreement.commitment.finalizedAt,
        authorization.evidenceInput.observedAt,
        session.lastUpdatedAt,
      ),
      evidenceAuthority: { primaryClaim: SELLER, algorithm: "ed25519" },
      candidate: {
        status: "prepared",
        validatedAt: NOW,
        artifactHash: handoffArtifactHash(artifact),
        delivery: {
          artifact: structuredClone(artifact),
          ...(preparedPayloadRecord
            ? { payloadAttestationRecord: structuredClone(preparedPayloadRecord) }
            : {}),
        },
      },
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
    deliveryPhaseIndex: 1,
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
    resolveAgreement: async () => ({ status: "verified", value: agreement }),
    resolveListing: async () => ({ status: "verified", value: listing }),
    resolveSessionRecord: async () => ({ status: "verified", value: session }),
    prepareDelivery: async () => ({
      status: "prepared",
      delivery: {
        artifact,
        ...(preparedPayloadRecord
          ? { payloadAttestationRecord: preparedPayloadRecord }
          : {}),
      },
    }),
    submitDelivery: async () => ({ status: "accepted", reconciliationId: "delivery:job-17:1" }),
    reconcileDelivery: vi.fn(async () => {
      reconciliationCount += 1;
      return reconciliationCount === 1 && !initiallyConsumed
        ? { status: "absent" as const, reason: "authoritative absence" }
        : {
            status: "complete" as const,
            reconciliationId: "delivery:job-17:1",
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
    anchorEvidence: async ({ evidence, evidenceHash }) => {
      anchoredEvidence = structuredClone(evidence);
      const locator = "dacs4:test-delivery-evidence:job-17";
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
  return { authorization, claim, store, agreement, listing, session, artifact, request, deps };
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
      locator: `dacs4:payload-attestation:job-17:${methodHash}:${record.attempt}`,
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

describe("runFulfilmentCore", () => {
  test("derives non-aliasing fulfilment identities from colon-bearing fields", () => {
    const common = {
      agreementHash: H.agreement,
      paymentEvidenceHash: H.paymentTx,
    };
    const left = sellerFulfilmentId({
      ...common,
      jobId: "job:1",
      paymentPhaseIndex: 2,
      deliveryPhaseIndex: 3,
      settlementId: "event",
    });
    const right = sellerFulfilmentId({
      ...common,
      jobId: "job",
      paymentPhaseIndex: 1,
      deliveryPhaseIndex: 2,
      settlementId: "3:event",
    });
    expect(left).toMatch(/^[0-9a-f]{64}$/);
    expect(right).toMatch(/^[0-9a-f]{64}$/);
    expect(left).not.toBe(right);
  });

  test.each(["buyer.storageAddress", "buyer.encryptionKey", "deliverableRef.schemaUrl"] as const)(
    "rejects an explicitly undefined optional agreement field despite its $field JCS collision",
    async (field) => {
      const f = fixture();
      const omitted = structuredClone(f.agreement) as unknown as Record<string, unknown>;
      const ambiguous = structuredClone(f.agreement) as unknown as Record<string, unknown>;
      const [parent, child] = field.split(".") as ["buyer" | "deliverableRef", string];
      delete (omitted[parent] as Record<string, unknown>)[child];
      delete (ambiguous[parent] as Record<string, unknown>)[child];
      (ambiguous[parent] as Record<string, unknown>)[child] = undefined;
      expect(canonicalize(ambiguous)).toBe(canonicalize(omitted));
      f.deps.resolveAgreement = async () => ({
        status: "verified",
        value: ambiguous as unknown as SellerFulfilmentAgreement,
      });
      const consume = vi.spyOn(f.store, "consumePermit");

      expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
        decision: "rejected",
        code: "agreement-fields-malformed",
      });
      expect(consume).not.toHaveBeenCalled();
    },
  );

  test("rejects negative-zero agreement time despite its zero JCS collision", async () => {
    const f = fixture();
    expect(canonicalize({ finalizedAt: -0 })).toBe(canonicalize({ finalizedAt: 0 }));
    f.authorization.commitment.finalizedAt = 0;
    f.agreement.commitment.finalizedAt = -0;
    const consume = vi.spyOn(f.store, "consumePermit");

    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "rejected",
      code: "agreement-fields-malformed",
    });
    expect(consume).not.toHaveBeenCalled();
  });

  test("rejects an undefined DeliverableSpec optional on a consumed retry despite its JCS collision", async () => {
    const f = fixture(undefined, true);
    const omitted = structuredClone(f.listing.deliverable);
    const ambiguous = structuredClone(omitted) as unknown as Record<string, unknown>;
    ambiguous.expectedSizeBytes = undefined;
    expect(canonicalize(ambiguous)).toBe(canonicalize(omitted));
    f.listing.deliverable = ambiguous as unknown as SellerDeliverableSpec;
    f.deps.submitDelivery = vi.fn(f.deps.submitDelivery);

    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "indeterminate",
      code: "consumed-fulfilment-rejected",
      safeToRetryDelivery: false,
      consumedPaymentAuthorization: f.authorization,
    });
    expect(f.deps.submitDelivery).not.toHaveBeenCalled();
  });

  test.each(["resolver-rejected", "signer-mismatch"] as const)(
    "never exposes a plain rejection for an already-consumed $case retry",
    async (scenario) => {
      const f = fixture(undefined, true);
      if (scenario === "resolver-rejected") {
        f.deps.resolveAgreement = async () => ({
          status: "rejected",
          reason: "agreement is no longer resolvable",
        });
      } else {
        f.deps.evidenceSigner = {
          ...f.deps.evidenceSigner,
          signer: "did:demos:unexpected-signer",
        };
      }

      expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
        decision: "indeterminate",
        code: "consumed-fulfilment-rejected",
        safeToRetryDelivery: false,
        consumedPaymentAuthorization: f.authorization,
      });
    },
  );

  test("consumes the opaque payment permit, reconciles, and emits verified normative evidence", async () => {
    const f = fixture();
    f.deps.prepareDelivery = vi.fn(f.deps.prepareDelivery);
    f.deps.submitDelivery = vi.fn(f.deps.submitDelivery);
    const result = await runFulfilmentCore(f.request, f.deps);

    expect(result).toMatchObject({
      decision: "completed",
      consumedPaymentAuthorization: {
        settlementId: f.authorization.settlementId,
        phaseIndex: f.authorization.phaseIndex,
      },
      evidence: {
        evidenceVersion: "1",
        jobId: "job-17",
        phase: "deliver-storage-program",
        outcome: "success",
        deliverableAnchor: {
          kind: "storage-program",
          locator: "dacs4:deliverable:job-17",
        },
        signature: { signer: SELLER },
      },
      bundleContribution: {
        phaseSummary: { index: 1, kind: "deliver-storage-program", outcome: "ok" },
      },
    });
    expect(f.store.consumed).toBe(true);
    expect(f.deps.prepareDelivery).toHaveBeenCalledWith(expect.objectContaining({
      logicalAddress: "dacs4:deliverable:job-17",
    }));
    expect(f.deps.submitDelivery).toHaveBeenCalledOnce();
    expect(f.deps.submitDelivery).toHaveBeenCalledWith(expect.objectContaining({
      logicalAddress: "dacs4:deliverable:job-17",
      artifactHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    expect(result).not.toHaveProperty("evidence.phaseIndex");
    if (result.decision === "completed") {
      expect(result.consumedPaymentAuthorization).toEqual(f.claim.authorization);
      expect(result.consumedPaymentAuthorization).not.toBe(f.claim.authorization);
      expect(result.evidenceRef).not.toBe(result.bundleContribution.phaseSummary.attestationRef);
      expect(result.evidenceRef).not.toBe(result.bundleContribution.settlementEvidence);
      expect(result.bundleContribution.phaseSummary.attestationRef)
        .not.toBe(result.bundleContribution.settlementEvidence);
      const anchoredLocator = result.bundleContribution.settlementEvidence.anchor.locator;
      result.evidenceRef.anchor.locator = "mutated:caller-copy";
      expect(result.bundleContribution.phaseSummary.attestationRef.anchor.locator)
        .toBe(anchoredLocator);
      expect(result.bundleContribution.settlementEvidence.anchor.locator).toBe(anchoredLocator);
      expect(await verifySettlementEvidence(
        result.evidence,
        { orchestrator: SELLER },
        {
          resolvePublicKey: async () => rawPublicKey(publicKeyFromSeed(SELLER_SEED)),
          verify: (bytes, signature, publicKey) =>
            ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
        },
      )).toEqual({ decision: "pass", reasons: [] });
    }
  });

  test("rejects an invalid permit without invoking or reconciling application work", async () => {
    const f = fixture();
    f.request.paymentPermitId = "caller-forged";
    f.deps.submitDelivery = vi.fn(f.deps.submitDelivery);
    f.deps.reconcileDelivery = vi.fn(f.deps.reconcileDelivery);
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "rejected",
      code: "payment-permit-invalid",
    });
    expect(f.deps.submitDelivery).not.toHaveBeenCalled();
    expect(f.deps.reconcileDelivery).not.toHaveBeenCalled();
  });

  test("reconciles a consumed permit or resumes only its exact retained candidate", async () => {
    const complete = fixture(undefined, true);
    complete.deps.submitDelivery = vi.fn(complete.deps.submitDelivery);
    expect((await runFulfilmentCore(complete.request, complete.deps)).decision).toBe("completed");
    expect(complete.deps.submitDelivery).not.toHaveBeenCalled();

    const absent = fixture(undefined, true);
    absent.deps.prepareDelivery = vi.fn(absent.deps.prepareDelivery);
    let submitted = false;
    absent.deps.submitDelivery = vi.fn(async () => {
      submitted = true;
      return { status: "accepted" as const, reconciliationId: "delivery:job-17:1" };
    });
    absent.deps.reconcileDelivery = async () => submitted
      ? { status: "complete", reconciliationId: "delivery:job-17:1", observedAt: NOW }
      : { status: "absent", reason: "no reconcilable effect in authoritative state" };
    expect(await runFulfilmentCore(absent.request, absent.deps)).toMatchObject({
      decision: "completed",
      consumedPaymentAuthorization: {
        settlementId: absent.authorization.settlementId,
        phaseIndex: absent.authorization.phaseIndex,
      },
    });
    expect(absent.deps.prepareDelivery).not.toHaveBeenCalled();
    expect(absent.deps.submitDelivery).toHaveBeenCalledOnce();
    expect(absent.deps.submitDelivery).toHaveBeenCalledWith(expect.objectContaining({
      fulfilmentId: absent.store.handoffValue!.fulfilmentId,
      artifactHash: absent.store.handoffValue!.candidate.status === "prepared"
        ? absent.store.handoffValue!.candidate.artifactHash
        : "unexpected",
      artifact: absent.store.handoffValue!.candidate.status === "prepared"
        ? absent.store.handoffValue!.candidate.delivery.artifact
        : undefined,
    }));
  });

  test.each(["entitlement", "attested-payload"] as const)(
    "revalidates a retained $kind candidate against its immutable validation floor",
    async (kind) => {
      const spec: SellerDeliverableSpec = kind === "entitlement"
        ? {
            kind: "entitlement",
            durationSec: 3_600,
            renewable: false,
          }
        : {
            kind: "attested-payload",
            payloadFormat: "application/json",
            verificationMethod: { kind: "self-signed" },
          };
      const f = fixture(spec, true);
      // A later authenticated SessionRecord observation must not rewrite the
      // causal floor atomically retained with the already-consumed candidate.
      f.session.lastUpdatedAt = NOW - 100;
      f.deps.prepareDelivery = vi.fn(f.deps.prepareDelivery);
      f.deps.submitDelivery = vi.fn(f.deps.submitDelivery);

      const result = await runFulfilmentCore(f.request, f.deps);
      expect(result, JSON.stringify(result)).toMatchObject({
        decision: "completed",
        consumedPaymentAuthorization: f.authorization,
      });
      expect(f.deps.prepareDelivery).not.toHaveBeenCalled();
      expect(f.deps.submitDelivery).not.toHaveBeenCalled();
    },
  );

  test("retains consumed authority when inspection returns a malformed recovery handoff", async () => {
    const f = fixture(undefined, true);
    const retained = structuredClone(f.store.handoffValue!);
    delete (retained as unknown as Record<string, unknown>).candidate;
    f.store.inspectPermit = async () => ({
      status: "already-consumed",
      claim: structuredClone(f.claim),
      handoff: retained,
    }) as never;

    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "indeterminate",
      code: "payment-permit-store-invalid",
      reasons: ["receipt store returned a malformed consumed handoff"],
      safeToRetryDelivery: false,
      consumedPaymentAuthorization: f.authorization,
    });
  });

  test("fails closed when delivery state contradicts a retained preparation failure", async () => {
    for (const terminal of [
      { status: "complete" as const, reconciliationId: "unexpected", observedAt: NOW },
      { status: "failed" as const, reason: "different failure", observedAt: NOW },
    ]) {
      const f = fixture(undefined, true);
      f.store.handoffValue!.candidate = {
        status: "preparation-failed",
        validatedAt: NOW - 1,
        reason: "exact retained rejection",
      };
      f.deps.reconcileDelivery = async () => terminal;
      f.deps.resolveDelivery = vi.fn(f.deps.resolveDelivery);
      expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
        decision: "indeterminate",
        code: "delivery-reconciliation-contradiction",
        safeToRetryDelivery: false,
      });
      expect(f.deps.resolveDelivery).not.toHaveBeenCalled();
    }
  });

  test("uses the retained preparation-failure time for an exact durable failure echo", async () => {
    const f = fixture(undefined, true);
    f.store.handoffValue!.candidate = {
      status: "preparation-failed",
      validatedAt: NOW - 1,
      reason: "exact retained rejection",
    };
    f.deps.reconcileDelivery = async () => ({
      status: "failed",
      reason: "exact retained rejection",
      observedAt: NOW,
      reconciliationId: "failure:job-17:1",
    });
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "failed",
      evidence: {
        outcome: "failure",
        reason: "exact retained rejection",
        observedAt: NOW - 1,
      },
    });
  });

  test.each([
    ["agreement", (f: Fixture) => { f.request.agreementHash = "0".repeat(64); }, "payment-authorization-scope-mismatch"],
    ["commitment", (f: Fixture) => { f.request.commitmentRef = "wrong"; }, "agreement-commitment-mismatch"],
    ["Listing", (f: Fixture) => { f.listing.pin.contentHash = "0".repeat(64); }, "listing-resolution-mismatch"],
    ["rail", (f: Fixture) => { f.session.pipeline[0]!.parameters!.rail = "other"; }, "session-record-mismatch"],
    ["payment evidence", (f: Fixture) => { f.session.phaseResults[0]!.result.attestationRef!.contentHash = "0".repeat(64); }, "session-record-mismatch"],
    ["seller", (f: Fixture) => { f.session.parties[1]!.primaryClaim = "did:demos:mallory"; }, "session-record-mismatch"],
  ] as Array<[string, (f: Fixture) => void, string]>) (
    "rejects a wrong %s scope before permit consumption",
    async (_label, mutate, code) => {
      const f = fixture();
      f.deps.submitDelivery = vi.fn(f.deps.submitDelivery);
      mutate(f);
      expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({ decision: "rejected", code });
      expect(f.store.consumed).toBe(false);
      expect(f.deps.submitDelivery).not.toHaveBeenCalled();
    },
  );

  test("rejects skipped, duplicate, and non-exact prior SessionRecord phases", async () => {
    for (const mutate of [
      (f: Fixture) => { f.session.phaseResults = []; },
      (f: Fixture) => { f.session.phaseResults[0]!.index = 1; },
      (f: Fixture) => { f.session.phaseResults[0]!.result.ok = false; },
      (f: Fixture) => { f.session.phaseResults[0]!.contextDelta = { forged: true }; },
    ]) {
      const f = fixture();
      mutate(f);
      expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
        decision: "rejected",
        code: "session-record-mismatch",
      });
      expect(f.store.consumed).toBe(false);
    }
  });

  test("allows PC-7 payment-evidence anchor catch-up without relabelling rail-final payment", async () => {
    const f = fixture();
    delete f.session.phaseResults[0]!.result.attestationRef;
    delete f.session.phaseResults[0]!.result.anchorReceipt;
    expect((await runFulfilmentCore(f.request, f.deps)).decision).toBe("completed");
  });

  test("fails closed for repeated delivery phases in the current profile", async () => {
    const f = fixture();
    f.listing.pipeline.push({ kind: "deliver-storage-program" });
    f.session.pipeline = structuredClone(f.listing.pipeline);
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "rejected",
      code: "unsupported-delivery-profile",
    });
    expect(f.store.consumed).toBe(false);
  });

  test("fails closed for more than one prior payment in the focused profile", async () => {
    const f = fixture();
    f.listing.pipeline = [
      structuredClone(f.listing.pipeline[0]!),
      structuredClone(f.listing.pipeline[0]!),
      structuredClone(f.listing.pipeline[1]!),
    ];
    f.session.pipeline = structuredClone(f.listing.pipeline);
    f.request.deliveryPhaseIndex = 2;
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "rejected",
      code: "unsupported-payment-profile",
    });
    expect(f.store.consumed).toBe(false);
  });

  test.each(["complete", "failed"] as const)(
    "rejects a %s delivery effect while its permit is still available",
    async (status) => {
      const f = fixture();
      f.deps.reconcileDelivery = async () => status === "complete"
        ? { status, reconciliationId: "delivery:job-17:1", observedAt: NOW }
        : { status, reason: "terminal effect exists", observedAt: NOW };
      expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
        decision: "rejected",
        code: "delivery-effect-before-permit-consumption",
      });
      expect(f.store.consumed).toBe(false);
    },
  );

  test("recovers a response-lost permit commit from the exact atomic handoff", async () => {
    const f = fixture();
    const consume = f.store.consumePermit;
    let loseFirstResponse = true;
    f.store.consumePermit = async function (permitId, handoff) {
      const result = await consume.call(this, permitId, handoff);
      if (loseFirstResponse && result.status === "consumed") {
        loseFirstResponse = false;
        throw new Error("response lost after atomic commit");
      }
      return result;
    };
    let submitted = false;
    f.deps.prepareDelivery = vi.fn(f.deps.prepareDelivery);
    f.deps.submitDelivery = vi.fn(async () => {
      submitted = true;
      return { status: "accepted" as const, reconciliationId: "delivery:job-17:1" };
    });
    f.deps.reconcileDelivery = async () => submitted
      ? { status: "complete", reconciliationId: "delivery:job-17:1", observedAt: NOW }
      : { status: "absent", reason: "authoritative absence" };
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "indeterminate",
      code: "payment-permit-store-unavailable",
      safeToRetryDelivery: false,
      recovery: { action: "reconcile-delivery" },
    });
    expect(f.store.consumed).toBe(true);
    expect(f.store.handoffValue?.candidate.status).toBe("prepared");
    expect(f.deps.submitDelivery).not.toHaveBeenCalled();

    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "completed",
      consumedPaymentAuthorization: {
        settlementId: f.authorization.settlementId,
      },
    });
    expect(f.deps.prepareDelivery).toHaveBeenCalledOnce();
    expect(f.deps.submitDelivery).toHaveBeenCalledOnce();
  });

  test("rejects a different handoff returned by permit consumption without submitting", async () => {
    const f = fixture();
    const consume = f.store.consumePermit;
    f.store.consumePermit = async function (permitId, handoff) {
      const result = await consume.call(this, permitId, handoff);
      if (result.status === "invalid") return result;
      const altered = structuredClone(result.handoff);
      altered.logicalAddress = `${altered.logicalAddress}:replacement`;
      return { ...result, handoff: altered };
    };
    f.deps.submitDelivery = vi.fn(f.deps.submitDelivery);

    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "indeterminate",
      code: "payment-permit-store-invalid",
      reasons: ["receipt store returned a different retained fulfilment handoff"],
      safeToRetryDelivery: false,
      consumedPaymentAuthorization: f.authorization,
    });
    expect(f.store.consumed).toBe(true);
    expect(f.store.handoffValue?.logicalAddress).toBe("dacs4:deliverable:job-17");
    expect(f.deps.submitDelivery).not.toHaveBeenCalled();
  });

  test("fails closed without submitting when a retained handoff candidate is altered", async () => {
    const f = fixture(undefined, true);
    if (f.store.handoffValue?.candidate.status !== "prepared") throw new Error("fixture");
    const artifact = f.store.handoffValue.candidate.delivery.artifact as {
      cleartextPayload: { answer: number };
    };
    artifact.cleartextPayload.answer = 999;
    f.deps.prepareDelivery = vi.fn(f.deps.prepareDelivery);
    f.deps.submitDelivery = vi.fn(f.deps.submitDelivery);

    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "indeterminate",
      code: "payment-permit-store-invalid",
      safeToRetryDelivery: false,
    });
    expect(f.deps.prepareDelivery).not.toHaveBeenCalled();
    expect(f.deps.submitDelivery).not.toHaveBeenCalled();
  });

  test("requires delivery clocks to follow the commitment, payment, and SessionRecord", async () => {
    const f = fixture();
    f.deps.prepareDelivery = vi.fn(f.deps.prepareDelivery);
    f.deps.nowMs = () => f.session.lastUpdatedAt - 1;
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "indeterminate",
      code: "clock-invalid",
      safeToRetryDelivery: true,
    });
    expect(f.store.consumed).toBe(false);
    expect(f.deps.prepareDelivery).not.toHaveBeenCalled();
  });

  test.each([
    ["before finalized session state", NOW - 2_001],
    ["after the current clock", NOW + 1],
  ] as const)("rejects a stable terminal observation %s", async (_label, observedAt) => {
    const f = fixture(undefined, true);
    f.deps.reconcileDelivery = async () => ({
      status: "complete",
      reconciliationId: "delivery:job-17:1",
      observedAt,
    });
    f.deps.resolveDelivery = vi.fn(f.deps.resolveDelivery);
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "indeterminate",
      code: "clock-invalid",
      safeToRetryDelivery: false,
    });
    expect(f.deps.resolveDelivery).not.toHaveBeenCalled();
  });

  test("observes entitlement timestamps after side-effect-free preparation returns", async () => {
    const f = fixture({ kind: "entitlement", durationSec: 3_600, renewable: true });
    const record = f.artifact.cleartextPayload as Record<string, unknown>;
    record.startsAt = NOW + 1;
    record.endsAt = NOW + 1 + 3_600_000;
    f.artifact.anchoredValue = structuredClone(record);
    f.deps.resolveDelivery = async () => ({
      status: "verified",
      value: {
        artifact: f.artifact,
        anchorReceipt: anchorReceipt(
          "dacs4:entitlement:job-17:0",
          contentHash(record),
        ),
      },
    });
    let reads = 0;
    let reconciliations = 0;
    f.deps.nowMs = () => reads++ === 0 ? NOW : NOW + 1;
    f.deps.reconcileDelivery = async () => {
      reconciliations += 1;
      return reconciliations === 1
        ? { status: "absent" as const, reason: "authoritative absence" }
        : {
            status: "complete" as const,
            reconciliationId: "delivery:job-17:1",
            observedAt: NOW + 1,
          };
    };
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({ decision: "completed" });
  });

  test("retains a rejected preparation at its post-callback observation time", async () => {
    const f = fixture();
    f.deps.prepareDelivery = async () => ({ status: "rejected", reason: "application refused" });
    let reads = 0;
    f.deps.nowMs = () => reads++ === 0 ? NOW : NOW + 7;
    const result = await runFulfilmentCore(f.request, f.deps);
    expect(result).toMatchObject({
      decision: "failed",
      evidence: { outcome: "failure", reason: "application refused", observedAt: NOW + 7 },
    });
    expect(f.store.handoffValue?.candidate).toEqual({
      status: "preparation-failed",
      reason: "application refused",
      validatedAt: NOW + 7,
    });
  });

  test("rejects a pre-payment entitlement rather than delivering a mostly-expired grant", async () => {
    const f = fixture({ kind: "entitlement", durationSec: 3_600, renewable: true });
    const entitlement = f.artifact.cleartextPayload as Record<string, unknown>;
    entitlement.startsAt = f.authorization.evidenceInput.observedAt - 1;
    entitlement.endsAt = (entitlement.startsAt as number) + 3_600_000;
    f.artifact.anchoredValue = structuredClone(entitlement);
    f.deps.submitDelivery = vi.fn(f.deps.submitDelivery);
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "failed",
      errorClass: "permanent",
      evidence: { outcome: "failure" },
    });
    expect(f.deps.submitDelivery).not.toHaveBeenCalled();
  });

  test("requires configured exact-method DPA producer capability before permit consumption", async () => {
    const f = fixture({
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    });
    f.deps.resolvePayloadVerificationCapability = async () => ({
      disposition: "unsupported",
      reason: "method not installed",
    });
    f.deps.prepareDelivery = vi.fn(f.deps.prepareDelivery);
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "rejected",
      code: "payload-method-capability-unsupported",
    });
    expect(f.store.consumed).toBe(false);
    expect(f.deps.prepareDelivery).not.toHaveBeenCalled();
  });

  test("requires the exact store-retained DPA producer admission in the request", async () => {
    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;

    const missingRequest = fixture(spec);
    delete missingRequest.request.payloadVerificationProducerAdmission;
    missingRequest.deps.resolvePayloadVerificationCapability = vi.fn(
      missingRequest.deps.resolvePayloadVerificationCapability!,
    );
    missingRequest.deps.prepareDelivery = vi.fn(missingRequest.deps.prepareDelivery);
    expect(await runFulfilmentCore(missingRequest.request, missingRequest.deps)).toMatchObject({
      decision: "rejected",
      code: "payload-producer-admission-missing",
    });
    expect(missingRequest.store.consumed).toBe(false);
    expect(missingRequest.deps.resolvePayloadVerificationCapability).not.toHaveBeenCalled();
    expect(missingRequest.deps.prepareDelivery).not.toHaveBeenCalled();

    const missingStore = fixture(spec);
    delete missingStore.authorization.payloadVerificationProducerAdmission;
    expect(await runFulfilmentCore(missingStore.request, missingStore.deps)).toMatchObject({
      decision: "rejected",
      code: "payload-producer-admission-missing",
    });
    expect(missingStore.store.consumed).toBe(false);

    const callerMismatch = fixture(spec);
    callerMismatch.request.payloadVerificationProducerAdmission!.verificationMethodHash =
      "0".repeat(64);
    expect(await runFulfilmentCore(callerMismatch.request, callerMismatch.deps)).toMatchObject({
      decision: "rejected",
      code: "payload-producer-admission-mismatch",
    });
    expect(callerMismatch.store.consumed).toBe(false);
  });

  test("forbids DPA producer admission on a non-DPA delivery", async () => {
    const ordinary = fixture();
    const dpa = fixture({
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    });
    ordinary.request.payloadVerificationProducerAdmission = structuredClone(
      dpa.request.payloadVerificationProducerAdmission!,
    );
    ordinary.deps.prepareDelivery = vi.fn(ordinary.deps.prepareDelivery);
    expect(await runFulfilmentCore(ordinary.request, ordinary.deps)).toMatchObject({
      decision: "rejected",
      code: "payload-producer-admission-unexpected",
    });
    expect(ordinary.store.consumed).toBe(false);
    expect(ordinary.deps.prepareDelivery).not.toHaveBeenCalled();

    const retainedExtra = fixture();
    retainedExtra.authorization.payloadVerificationProducerAdmission = structuredClone(
      dpa.authorization.payloadVerificationProducerAdmission!,
    );
    expect(await runFulfilmentCore(retainedExtra.request, retainedExtra.deps)).toMatchObject({
      decision: "rejected",
      code: "payload-producer-admission-unexpected",
    });
    expect(retainedExtra.store.consumed).toBe(false);
  });

  test.each([
    ["Listing ref", (admission: NonNullable<SellerPaymentAuthorization["payloadVerificationProducerAdmission"]>) => {
      admission.listingRef.contentHash = "0".repeat(64);
    }],
    ["method kind", (admission: NonNullable<SellerPaymentAuthorization["payloadVerificationProducerAdmission"]>) => {
      admission.verificationMethodKind = "tlsnotary";
    }],
    ["method hash", (admission: NonNullable<SellerPaymentAuthorization["payloadVerificationProducerAdmission"]>) => {
      admission.verificationMethodHash = "0".repeat(64);
    }],
    ["spec hash", (admission: NonNullable<SellerPaymentAuthorization["payloadVerificationProducerAdmission"]>) => {
      admission.deliverableSpecHash = "0".repeat(64);
    }],
    ["post-commit admission time", (
      admission: NonNullable<SellerPaymentAuthorization["payloadVerificationProducerAdmission"]>,
      f: Fixture,
    ) => {
      admission.admittedAt = f.authorization.commitment.finalizedAt + 1;
    }],
  ] as Array<[
    string,
    (
      admission: NonNullable<SellerPaymentAuthorization["payloadVerificationProducerAdmission"]>,
      f: Fixture,
    ) => void,
  ]>)("fails closed when the retained DPA admission mutates its %s", async (_label, mutate) => {
    const f = fixture({
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    });
    const retained = f.authorization.payloadVerificationProducerAdmission!;
    mutate(retained, f);
    f.request.payloadVerificationProducerAdmission = structuredClone(retained);
    f.deps.prepareDelivery = vi.fn(f.deps.prepareDelivery);
    const result = await runFulfilmentCore(f.request, f.deps);
    expect(["rejected", "indeterminate"]).toContain(result.decision);
    expect(f.store.consumed).toBe(false);
    expect(f.deps.prepareDelivery).not.toHaveBeenCalled();
  });

  test("refreshes local produce admission immediately before preparation and consumes before effects", async () => {
    const f = fixture({
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    });
    const order: string[] = [];
    const capability = f.deps.resolvePayloadVerificationCapability!;
    f.deps.resolvePayloadVerificationCapability = async (input) => {
      order.push(`capability:${input.operation}`);
      return capability(input);
    };
    const prepare = f.deps.prepareDelivery;
    f.deps.prepareDelivery = async (input) => {
      order.push("prepare");
      return prepare(input);
    };
    const consume = f.store.consumePermit;
    f.store.consumePermit = async function (permitId, handoff) {
      order.push("consume");
      return consume.call(this, permitId, handoff);
    };
    const anchor = f.deps.anchorPayloadAttestation!;
    f.deps.anchorPayloadAttestation = async (input) => {
      order.push("payload-anchor");
      return anchor(input);
    };
    const submit = f.deps.submitDelivery;
    f.deps.submitDelivery = async (input) => {
      order.push("submit");
      return submit(input);
    };

    expect((await runFulfilmentCore(f.request, f.deps)).decision).toBe("completed");
    expect(order).toEqual([
      "capability:produce",
      "prepare",
      "consume",
      "payload-anchor",
      "submit",
    ]);
  });

  test("rejects a DPA retry attempt without authenticated contiguous history", async () => {
    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;
    const f = fixture(spec);
    const record = payloadAttestationRecord(spec, f.artifact.cleartextBytes!);
    record.attempt = 1;
    installPayloadRecord(f, spec, record);
    f.deps.submitDelivery = vi.fn(f.deps.submitDelivery);
    const result = await runFulfilmentCore(f.request, f.deps);
    expect(result).toMatchObject({
      decision: "failed",
      errorClass: "permanent",
    });
    expect(f.deps.submitDelivery).not.toHaveBeenCalled();
  });

  test("replays the Standard payload-attestation binding vectors owned by the core", async () => {
    type BindingVector = {
      name: string;
      expected: "pass" | "fail" | "indeterminate";
      listing: { offering: { deliverable: Record<string, unknown> } };
      agreement: {
        jobId: string;
        agreementHash: string;
        deliverable: { hash: string };
      };
      payloadUtf8: string;
      methodEvidence?: unknown;
      payloadAttestationRecord: Record<string, unknown>;
    };
    const set = JSON.parse(readFileSync(new URL(
      "../../vendor/DACS-Standard/conformance/vectors/security/payload-attestation-binding-v0.1.json",
      import.meta.url,
    ), "utf8")) as { vectors: BindingVector[] };
    const owned = new Set([
      "dahr-payload-bound-success",
      "listing-method-missing-rejected-before-payment",
      "verifyresult-discriminator-cannot-coerce",
      "unsupported-payload-attestation-version",
      "record-job-mismatch",
      "record-agreement-mismatch",
      "record-deliverable-spec-mismatch",
      "record-payload-digest-mismatch",
      "record-method-mismatch",
      "method-evidence-unresolvable",
      "nonpass-payload-record-cannot-support-success",
    ]);
    const vectors = set.vectors.filter((vector) => owned.has(vector.name));
    expect(vectors).toHaveLength(11);

    for (const vector of vectors) {
      const rawSpec = vector.listing.offering.deliverable;
      if (rawSpec.verificationMethod === undefined) {
        const invalidListing = fixture({
          kind: "attested-payload",
          payloadFormat: "application/json",
          verificationMethod: { kind: "self-signed" },
        });
        invalidListing.listing.deliverable = rawSpec as unknown as SellerDeliverableSpec;
        const result = await runFulfilmentCore(invalidListing.request, invalidListing.deps);
        expect(result.decision, vector.name).toBe("rejected");
        continue;
      }
      const spec = rawSpec as unknown as SellerDeliverableSpec;
      const f = fixture(spec);
      if (spec.kind !== "attested-payload" || !(f.artifact.cleartextBytes instanceof Uint8Array)) {
        const result = await runFulfilmentCore(f.request, f.deps);
        expect(result.decision, vector.name).toBe("rejected");
        continue;
      }
      const record = payloadAttestationRecord(spec, f.artifact.cleartextBytes);
      const oracle = vector.payloadAttestationRecord;
      if (oracle.payloadAttestationVersion !== "1") {
        (record as unknown as Record<string, unknown>).payloadAttestationVersion =
          oracle.payloadAttestationVersion;
      }
      if (oracle.jobId !== vector.agreement.jobId) record.jobId = String(oracle.jobId);
      if (oracle.agreementHash !== vector.agreement.agreementHash) {
        record.agreementHash = String(oracle.agreementHash);
      }
      if (oracle.deliverableSpecHash !== vector.agreement.deliverable.hash) {
        record.deliverableSpecHash = String(oracle.deliverableSpecHash);
      }
      if (oracle.payloadContentHash !== sha256Hex(vector.payloadUtf8)) {
        record.payloadContentHash = String(oracle.payloadContentHash);
      }
      const oracleMethodHash = rawSpec.verificationMethod === undefined
        ? null
        : sha256Hex(canonicalize(rawSpec.verificationMethod));
      if (oracle.verificationMethodHash !== oracleMethodHash) {
        record.verificationMethodHash = String(oracle.verificationMethodHash);
      }
      record.decision = oracle.decision as SellerPayloadAttestationRecord["decision"];
      installPayloadRecord(f, spec, record);
      if (vector.name === "method-evidence-unresolvable") {
        f.deps.verifyPayloadMethodProof = async () => ({
          disposition: "indeterminate",
          reason: "method evidence unavailable",
        });
      }
      const result = await runFulfilmentCore(f.request, f.deps);
      const actual = result.decision === "completed"
        ? "pass"
        : result.decision === "indeterminate"
          ? "indeterminate"
          : "fail";
      expect(actual, vector.name).toBe(vector.expected);
    }
  });

  test("fails when a DPA reference names a signer other than the record producer", async () => {
    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;
    const f = fixture(spec);
    const record = payloadAttestationRecord(spec, f.artifact.cleartextBytes!);
    installPayloadRecord(f, spec, record);
    f.artifact.attestationRef!.signer = "did:demos:mallory";
    f.deps.submitDelivery = vi.fn(f.deps.submitDelivery);
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "failed",
      errorClass: "permanent",
    });
    expect(f.deps.submitDelivery).not.toHaveBeenCalled();
  });

  test("preserves and hash-binds inert SIG-5 extensions in DPA records and nested refs", async () => {
    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;
    const f = fixture(spec);
    const record = payloadAttestationRecord(spec, f.artifact.cleartextBytes!);
    const raw = record as unknown as Record<string, unknown>;
    raw.futureAudit = { retained: true };
    (record.methodEvidenceRef as unknown as Record<string, unknown>).futureRouting = "v2";
    (record.methodEvidenceRef!.anchor as unknown as Record<string, unknown>).futureShard = 7;
    installPayloadRecord(f, spec, record);
    let seen: Record<string, unknown> | undefined;
    f.deps.verifyPayloadAttestationSignature = async ({ record: candidate }) => {
      seen = structuredClone(candidate as unknown as Record<string, unknown>);
      return { disposition: "valid" };
    };
    expect((await runFulfilmentCore(f.request, f.deps)).decision).toBe("completed");
    expect(seen).toMatchObject({
      futureAudit: { retained: true },
      methodEvidenceRef: {
        futureRouting: "v2",
        anchor: { futureShard: 7 },
      },
    });
    expect(f.artifact.attestationRef!.contentHash).toBe(singularSignatureHash(raw));
  });

  test("requires included-or-finalized receipts for DPA, delivery, and evidence", async () => {
    const delivery = fixture();
    delivery.deps.resolveDelivery = async () => ({
      status: "verified",
      value: {
        artifact: delivery.artifact,
        anchorReceipt: anchorReceipt(
          "dacs4:deliverable:job-17",
          sha256Hex(canonicalize(delivery.artifact.anchoredValue)),
          "accepted",
        ),
      },
    });
    expect(await runFulfilmentCore(delivery.request, delivery.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-verification-indeterminate",
    });

    const evidence = fixture();
    evidence.deps.anchorEvidence = async ({ evidenceHash }) => {
      const locator = "dacs4:test-delivery-evidence:job-17";
      return {
        status: "anchored",
        ref: { anchor: { kind: "storage-program", locator }, contentHash: evidenceHash },
        anchorReceipt: anchorReceipt(locator, evidenceHash, "accepted"),
      };
    };
    expect(await runFulfilmentCore(evidence.request, evidence.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-evidence-publication-pending",
    });

    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;
    const dpa = fixture(spec);
    const record = payloadAttestationRecord(spec, dpa.artifact.cleartextBytes!);
    installPayloadRecord(dpa, spec, record);
    dpa.deps.anchorPayloadAttestation = async ({ ref, recordHash }) => ({
      status: "anchored",
      ref: structuredClone(ref),
      anchorReceipt: anchorReceipt(ref.anchor.locator, recordHash, "accepted"),
    });
    dpa.deps.resolvePayloadAttestation = async () => ({
      status: "verified",
      value: {
        record,
        anchorReceipt: anchorReceipt(
          dpa.artifact.attestationRef!.anchor.locator,
          dpa.artifact.attestationRef!.contentHash,
          "accepted",
        ),
      },
    });
    dpa.deps.submitDelivery = vi.fn(dpa.deps.submitDelivery);
    expect(await runFulfilmentCore(dpa.request, dpa.deps)).toMatchObject({
      decision: "indeterminate",
      code: "payload-attestation-publication-pending",
    });
    expect(dpa.deps.submitDelivery).not.toHaveBeenCalled();
  });

  test("treats a post-submit read-back mismatch as a signed permanent failure", async () => {
    const f = fixture();
    f.deps.resolveDelivery = async () => ({
      status: "verified",
      value: {
        artifact: {
          ...structuredClone(f.artifact),
          cleartextPayload: { answer: 99 },
          anchoredValue: { answer: 99 },
        },
        anchorReceipt: anchorReceipt(
          "dacs4:deliverable:job-17",
          sha256Hex(canonicalize({ answer: 99 })),
        ),
      },
    });
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "failed",
      errorClass: "permanent",
      evidence: { outcome: "failure" },
    });
  });

  test("records an authoritative delivery-resolver rejection as terminal failure evidence", async () => {
    const f = fixture();
    f.deps.resolveDelivery = async () => ({
      status: "rejected",
      reason: "authenticated read-back contradicts the submitted artifact",
    });
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "failed",
      errorClass: "permanent",
      evidence: {
        outcome: "failure",
        reason: "authenticated read-back contradicts the submitted artifact",
      },
    });
  });

  test("rejects malformed access unions without misclassifying them as a confidentiality downgrade", async () => {
    const f = fixture({ kind: "storage-program", accessModel: "buyer-only" });
    f.artifact.access = { model: "public", allowed: ["demos-address-buyer"] } as never;
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "failed",
      errorClass: "permanent",
    });

    const downgrade = fixture({ kind: "storage-program", accessModel: "buyer-only" });
    downgrade.artifact.access = { model: "public" };
    expect(await runFulfilmentCore(downgrade.request, downgrade.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-confidentiality-downgrade",
      safeToRetryDelivery: true,
    });
    expect(downgrade.store.consumed).toBe(false);
  });

  test("uses the authenticated SessionRecord orchestrator as evidence signer authority", async () => {
    const f = fixture();
    const orchestrator = f.session.parties.find((party) => party.role === "orchestrator")!;
    orchestrator.bundleHash = "7".repeat(64);
    orchestrator.primaryClaim = ORCHESTRATOR;
    f.deps.evidenceSigner = {
      algorithm: "ed25519",
      signer: ORCHESTRATOR,
      sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
    };
    const expectedWriters: Array<{ role: string; primaryClaim: string }> = [];
    f.deps.verifyAnchorReceipt = async ({ expectedWriter }) => {
      expectedWriters.push(structuredClone(expectedWriter));
      return { disposition: "valid" };
    };
    expect((await runFulfilmentCore(f.request, f.deps)).decision).toBe("completed");
    expect(expectedWriters).toContainEqual({ role: "seller", primaryClaim: SELLER });
    expect(expectedWriters).toContainEqual({
      role: "phase-orchestrator",
      primaryClaim: ORCHESTRATOR,
    });
  });

  test("rejects an evidence signer that is not the authenticated phase orchestrator", async () => {
    const f = fixture();
    const orchestrator = f.session.parties.find((party) => party.role === "orchestrator")!;
    orchestrator.bundleHash = "7".repeat(64);
    orchestrator.primaryClaim = ORCHESTRATOR;
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "rejected",
      code: "evidence-signer-mismatch",
    });
    expect(f.store.consumed).toBe(false);
  });

  test("requires an explicit authenticated phase-orchestrator row", async () => {
    const f = fixture();
    f.session.parties = f.session.parties.filter((party) => party.role !== "orchestrator");
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "rejected",
      code: "phase-orchestrator-missing",
    });
    expect(f.store.consumed).toBe(false);
  });

  test("rejects signer callbacks that mutate the captured signature algorithm", async () => {
    const f = fixture();
    f.deps.evidenceSigner.sign = async (_bytes, context) => {
      context.algorithm = "ecdsa-secp256k1";
      return new Uint8Array(64).fill(1);
    };
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-evidence-publication-pending",
      recovery: { action: "retry-evidence-publication" },
    });
  });

  test("cryptographically rejects arbitrary canonical Base64URL evidence before anchoring", async () => {
    const f = fixture();
    f.deps.evidenceSigner.sign = () => new Uint8Array(64).fill(7);
    f.deps.anchorEvidence = vi.fn(f.deps.anchorEvidence);

    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-evidence-publication-pending",
      recovery: { action: "retry-evidence-publication" },
    });
    expect(f.deps.anchorEvidence).not.toHaveBeenCalled();
  });

  test("does not anchor when evidence signature verification is indeterminate", async () => {
    const f = fixture();
    f.deps.verifyEvidenceSignature = async () => ({
      disposition: "indeterminate",
      reason: "signer key service unavailable",
    });
    f.deps.anchorEvidence = vi.fn(f.deps.anchorEvidence);

    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-evidence-publication-pending",
      reasons: ["signer key service unavailable"],
    });
    expect(f.deps.anchorEvidence).not.toHaveBeenCalled();
  });

  test("detects evidence-verifier input mutation and withholds anchoring", async () => {
    const f = fixture();
    f.deps.verifyEvidenceSignature = async (input) => {
      (input.evidence as { observedAt: number }).observedAt += 1;
      input.signedBytes[0] = input.signedBytes[0]! ^ 0xff;
      (input.signature as { value: string }).value = "c2ln";
      return { disposition: "valid" };
    };
    f.deps.anchorEvidence = vi.fn(f.deps.anchorEvidence);

    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-evidence-publication-pending",
      reasons: ["SettlementEvidence signature verifier mutated its exact inputs"],
    });
    expect(f.deps.anchorEvidence).not.toHaveBeenCalled();
  });

  test("re-verifies the exact independently read-back evidence", async () => {
    const f = fixture();
    const verify = f.deps.verifyEvidenceSignature;
    let calls = 0;
    f.deps.verifyEvidenceSignature = async (input) => {
      calls += 1;
      if (calls === 2) {
        return { disposition: "invalid", reason: "read-back signature rejected" };
      }
      return verify(input);
    };

    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-evidence-publication-pending",
      reasons: ["evidence read-back signature is invalid: read-back signature rejected"],
    });
    expect(calls).toBe(2);
  });

  test("recovers a response-lost evidence publication under one stable id and signed scope", async () => {
    const f = fixture();
    let signingCalls = 0;
    const candidateSignatures: string[] = [];
    f.deps.evidenceSigner.sign = (bytes) => {
      const seed = signingCalls++ === 0 ? SELLER_SEED : ROTATED_SELLER_SEED;
      const signature = ed25519Sign(bytes, privateKeyFromSeed(seed));
      candidateSignatures.push(Buffer.from(signature).toString("base64url"));
      return signature;
    };
    f.deps.verifyEvidenceSignature = async ({ signedBytes, signature, expectedSigner }) => {
      if (signature.algorithm !== "ed25519" || signature.signer !== expectedSigner) {
        return { disposition: "invalid", reason: "unexpected signer or algorithm" };
      }
      const signatureBytes = Uint8Array.from(Buffer.from(signature.value, "base64url"));
      const valid = [SELLER_SEED, ROTATED_SELLER_SEED].some((seed) =>
        ed25519Verify(signedBytes, signatureBytes, publicKeyFromSeed(seed)));
      return valid
        ? { disposition: "valid" }
        : { disposition: "invalid", reason: "signature mismatch" };
    };

    let persistedEvidence: SignedSellerDeliveryEvidence | undefined;
    let persistedHash: string | undefined;
    let persistedFulfilmentId: string | undefined;
    let anchorCalls = 0;
    const locator = "dacs4:test-delivery-evidence:job-17";
    f.deps.anchorEvidence = async (input) => {
      anchorCalls += 1;
      if (!persistedEvidence) {
        persistedEvidence = structuredClone(input.evidence);
        persistedHash = input.evidenceHash;
        persistedFulfilmentId = input.fulfilmentId;
        throw new Error("response lost after atomic evidence publication");
      }
      expect(input.fulfilmentId).toBe(persistedFulfilmentId);
      expect(input.evidenceHash).toBe(persistedHash);
      expect(input.evidence.signature.value).not.toBe(persistedEvidence.signature.value);
      return {
        status: "anchored",
        ref: {
          anchor: { kind: "storage-program", locator },
          contentHash: persistedHash!,
        },
        anchorReceipt: anchorReceipt(locator, persistedHash!, "included"),
      };
    };
    f.deps.resolveEvidence = async () => persistedEvidence
      ? { status: "verified", value: structuredClone(persistedEvidence) }
      : { status: "indeterminate", reason: "publication is not readable" };

    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-evidence-publication-pending",
      evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const recovered = await runFulfilmentCore(f.request, f.deps);
    expect(recovered).toMatchObject({
      decision: "completed",
      fulfilmentId: persistedFulfilmentId,
      evidenceHash: persistedHash,
      evidence: { observedAt: NOW, signature: persistedEvidence!.signature },
    });
    expect(candidateSignatures).toHaveLength(2);
    expect(candidateSignatures[0]).not.toBe(candidateSignatures[1]);
    expect(anchorCalls).toBe(2);
  });

  test("fails closed if a reconciler drifts the terminal event time after evidence response loss", async () => {
    const f = fixture();
    let reconciliationCalls = 0;
    let clock = NOW;
    f.deps.nowMs = () => clock;
    f.deps.reconcileDelivery = async () => {
      reconciliationCalls += 1;
      if (reconciliationCalls === 1) {
        return { status: "absent", reason: "authoritative absence" };
      }
      return {
        status: "complete",
        reconciliationId: "delivery:job-17:1",
        observedAt: reconciliationCalls === 2 ? NOW : NOW + 1,
      };
    };
    let persistedHash: string | undefined;
    let persistedId: string | undefined;
    const attemptedHashes: string[] = [];
    f.deps.anchorEvidence = async ({ fulfilmentId, evidenceHash }) => {
      attemptedHashes.push(evidenceHash);
      if (!persistedHash) {
        persistedHash = evidenceHash;
        persistedId = fulfilmentId;
        throw new Error("response lost after first evidence publication");
      }
      expect(fulfilmentId).toBe(persistedId);
      if (evidenceHash !== persistedHash) {
        return { status: "rejected", reason: "same fulfilment id has a different evidence hash" };
      }
      throw new Error("fixture expected a drifting hash");
    };
    f.deps.resolveEvidence = vi.fn(f.deps.resolveEvidence);

    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-evidence-publication-pending",
    });
    clock = NOW + 1;
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-evidence-publication-pending",
      reasons: ["same fulfilment id has a different evidence hash"],
    });
    expect(attemptedHashes).toHaveLength(2);
    expect(attemptedHashes[0]).not.toBe(attemptedHashes[1]);
    expect(persistedHash).toBe(attemptedHashes[0]);
    expect(f.deps.resolveEvidence).not.toHaveBeenCalled();
  });

  test("snapshots permit and agreement resolver values before later callbacks can mutate aliases", async () => {
    const f = fixture();
    const inspected = structuredClone(f.claim);
    f.store.inspectPermit = async () => {
      setTimeout(() => { inspected.authorization.agreementHash = "0".repeat(64); }, 0);
      return { status: "available", claim: inspected };
    };
    const resolvedAgreement = structuredClone(f.agreement);
    f.deps.resolveAgreement = async () => {
      setTimeout(() => { resolvedAgreement.jobId = "mutated-after-return"; }, 0);
      return { status: "verified", value: resolvedAgreement };
    };
    const originalResolveListing = f.deps.resolveListing;
    f.deps.resolveListing = async (pin) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return originalResolveListing(pin);
    };
    expect((await runFulfilmentCore(f.request, f.deps)).decision).toBe("completed");
  });

  test("snapshots the public request before any awaited dependency can mutate the caller alias", async () => {
    const f = fixture({
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    });
    const callerRequest = f.request;
    const original = f.deps.resolveAgreement;
    f.deps.resolveAgreement = async (ref) => {
      callerRequest.paymentPermitId = "mutated-permit";
      callerRequest.deliveryPhaseIndex = 99;
      callerRequest.agreementRef = "mutated-agreement";
      callerRequest.payloadVerificationProducerAdmission!.verificationMethodHash =
        "0".repeat(64);
      return original(ref);
    };
    expect((await runFulfilmentCore(callerRequest, f.deps)).decision).toBe("completed");
    expect(f.store.consumed).toBe(true);
  });

  test("captures every callback and store method before an awaited dependency can swap them", async () => {
    const f = fixture();
    const originalResolveAgreement = f.deps.resolveAgreement;
    const originalInspect = f.store.inspectPermit;
    const capturedResolveAgreement = vi.fn(originalResolveAgreement);
    f.store.inspectPermit = async function (permitId) {
      f.store.consumePermit = async () => ({ status: "invalid" });
      f.deps.resolveAgreement = async () => ({ status: "rejected", reason: "swapped" });
      f.deps.prepareDelivery = async () => ({ status: "rejected", reason: "swapped" });
      f.deps.submitDelivery = async () => ({ status: "rejected", reason: "swapped" });
      f.deps.nowMs = () => -1;
      return originalInspect.call(this, permitId);
    };
    f.deps.resolveAgreement = capturedResolveAgreement;

    expect((await runFulfilmentCore(f.request, f.deps)).decision).toBe("completed");
    expect(f.store.consumed).toBe(true);
    expect(capturedResolveAgreement).toHaveBeenCalledOnce();
  });

  test("reads dependency getters once and retains the first bound authority", async () => {
    const f = fixture();
    const callerRequest = f.request;
    const first = f.deps.prepareDelivery;
    const malicious = vi.fn(async () => ({ status: "rejected" as const, reason: "late getter" }));
    let reads = 0;
    Object.defineProperty(f.deps, "prepareDelivery", {
      configurable: true,
      get: () => {
        callerRequest.paymentPermitId = "mutated-by-dependency-getter";
        return ++reads === 1 ? first : malicious;
      },
    });

    expect((await runFulfilmentCore(callerRequest, f.deps)).decision).toBe("completed");
    expect(reads).toBe(1);
    expect(malicious).not.toHaveBeenCalled();
  });

  test("dereferences root, receipt-store, and signer proxies only during synchronous capture", async () => {
    const f = fixture();
    const rootReads = new Map<PropertyKey, number>();
    const storeReads = new Map<PropertyKey, number>();
    const signerReads = new Map<PropertyKey, number>();
    const count = (reads: Map<PropertyKey, number>, key: PropertyKey): void => {
      reads.set(key, (reads.get(key) ?? 0) + 1);
    };
    const storeProxy = new Proxy(f.store, {
      get(target, key, receiver) {
        count(storeReads, key);
        return Reflect.get(target, key, receiver);
      },
    });
    const signerProxy = new Proxy(f.deps.evidenceSigner, {
      get(target, key, receiver) {
        count(signerReads, key);
        return Reflect.get(target, key, receiver);
      },
    });
    let callbackBindReads = 0;
    const prepareProxy = new Proxy(f.deps.prepareDelivery, {
      get(target, key, receiver) {
        if (key === "bind") {
          callbackBindReads += 1;
          throw new Error("callback bind getter must not be trusted");
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const depsProxy = new Proxy({
      ...f.deps,
      receiptStore: storeProxy,
      evidenceSigner: signerProxy,
      prepareDelivery: prepareProxy,
    }, {
      get(target, key, receiver) {
        count(rootReads, key);
        return Reflect.get(target, key, receiver);
      },
    });

    expect((await runFulfilmentCore(f.request, depsProxy)).decision).toBe("completed");
    expect([...rootReads.values()].every((reads) => reads === 1)).toBe(true);
    expect(callbackBindReads).toBe(0);
    expect([...storeReads.entries()]).toEqual(expect.arrayContaining([
      ["claim", 1],
      ["inspectPermit", 1],
      ["consumePermit", 1],
    ]));
    expect([...signerReads.entries()]).toEqual(expect.arrayContaining([
      ["algorithm", 1],
      ["signer", 1],
      ["sign", 1],
    ]));
  });

  test("rejects a throwing dependency getter before inspecting or consuming a permit", async () => {
    const f = fixture();
    f.store.inspectPermit = vi.fn(f.store.inspectPermit);
    f.store.consumePermit = vi.fn(f.store.consumePermit);
    Object.defineProperty(f.deps, "resolveListing", {
      configurable: true,
      get: () => { throw new Error("getter trap"); },
    });
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "rejected",
      code: "fulfilment-dependencies-invalid",
    });
    expect(f.store.inspectPermit).not.toHaveBeenCalled();
    expect(f.store.consumePermit).not.toHaveBeenCalled();
  });

  test("rejects a malformed request before dereferencing dependency authority", async () => {
    const f = fixture();
    let dependencyReads = 0;
    Object.defineProperty(f.deps, "resolveListing", {
      configurable: true,
      get: () => {
        dependencyReads += 1;
        throw new Error("must not be read for an invalid request");
      },
    });
    (f.request as unknown as Record<string, unknown>).callerAssertion = true;
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "rejected",
      code: "invalid-request",
    });
    expect(dependencyReads).toBe(0);
  });

  test("treats non-cloneable callback envelopes after delivery submission as ambiguous", async () => {
    const f = fixture();
    f.deps.submitDelivery = async () => ({
      status: "accepted",
      reconciliationId: "delivery:job-17:1",
      nonCloneable: () => undefined,
    } as never);
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-submission-ambiguous",
      safeToRetryDelivery: false,
      recovery: { action: "reconcile-delivery" },
    });
  });

  test("detects added operational fields on the exact attested-payload submit input", async () => {
    const f = fixture({
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    });
    f.deps.submitDelivery = async (input) => {
      (input.artifact as unknown as Record<string, unknown>).callerAssertion = true;
      return { status: "accepted", reconciliationId: "delivery:job-17:1" };
    };
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-submission-ambiguous",
      safeToRetryDelivery: false,
      recovery: { action: "reconcile-delivery" },
    });
  });

  test("clones security-bearing resolver and capability envelopes before reading them", async () => {
    const agreement = fixture();
    agreement.deps.resolveAgreement = async () => new Proxy({
      status: "verified" as const,
      value: agreement.agreement,
    }, {});
    expect(await runFulfilmentCore(agreement.request, agreement.deps)).toMatchObject({
      decision: "indeterminate",
      code: "agreement-indeterminate",
      safeToRetryDelivery: true,
    });
    expect(agreement.store.consumed).toBe(false);

    const capability = fixture({
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    });
    capability.deps.resolvePayloadVerificationCapability = async () => new Proxy({
      disposition: "supported" as const,
    }, {});
    expect(await runFulfilmentCore(capability.request, capability.deps)).toMatchObject({
      decision: "indeterminate",
      code: "payload-method-capability-indeterminate",
      safeToRetryDelivery: true,
    });
    expect(capability.store.consumed).toBe(false);
  });

  test("detects verifier mutation of exact schema, entitlement, DPA, and receipt inputs", async () => {
    const schema = fixture({
      kind: "storage-program",
      accessModel: "public",
      schemaUrl: "https://schema.example/result.json",
    });
    schema.deps.verifyDeliverySchema = async (input) => {
      (input.cleartextPayload as Record<string, unknown>).answer = 99;
      return { disposition: "valid" };
    };
    expect(await runFulfilmentCore(schema.request, schema.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-preparation-indeterminate",
      safeToRetryDelivery: true,
    });
    expect(schema.store.consumed).toBe(false);

    const entitlement = fixture({ kind: "entitlement", durationSec: 3_600, renewable: true });
    entitlement.deps.verifyEntitlementSignature = async (input) => {
      (input.record as Record<string, unknown>).jobId = "coerced";
      return { disposition: "valid" };
    };
    expect(await runFulfilmentCore(entitlement.request, entitlement.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-preparation-indeterminate",
    });
    expect(entitlement.store.consumed).toBe(false);

    const dpa = fixture({
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    });
    dpa.deps.verifyPayloadAttestationSignature = async (input) => {
      (input.record as SellerPayloadAttestationRecord).reason = "coerced";
      return { disposition: "valid" };
    };
    expect(await runFulfilmentCore(dpa.request, dpa.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-preparation-indeterminate",
    });
    expect(dpa.store.consumed).toBe(false);

    const receipt = fixture();
    receipt.deps.verifyAnchorReceipt = async (input) => {
      (input.receipt as AnchorReceipt).contentHash = "0".repeat(64);
      return { disposition: "valid" };
    };
    expect(await runFulfilmentCore(receipt.request, receipt.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-verification-indeterminate",
      safeToRetryDelivery: false,
    });
  });

  test("requires exact independent evidence read-back and coherent optional signer metadata", async () => {
    const unavailable = fixture();
    unavailable.deps.resolveEvidence = async () => ({
      status: "indeterminate",
      reason: "read replica unavailable",
    });
    expect(await runFulfilmentCore(unavailable.request, unavailable.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-evidence-publication-pending",
      safeToRetryDelivery: false,
    });

    const mismatch = fixture();
    let signed: Record<string, unknown> | undefined;
    const originalAnchor = mismatch.deps.anchorEvidence;
    mismatch.deps.anchorEvidence = async (input) => {
      signed = structuredClone(input.evidence) as unknown as Record<string, unknown>;
      return originalAnchor(input);
    };
    mismatch.deps.resolveEvidence = async () => ({
      status: "verified",
      value: { ...signed!, observedAt: NOW + 1 },
    });
    expect(await runFulfilmentCore(mismatch.request, mismatch.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-evidence-publication-pending",
    });

    const wrongSigner = fixture();
    const signerAnchor = wrongSigner.deps.anchorEvidence;
    wrongSigner.deps.anchorEvidence = async (input) => {
      const result = await signerAnchor(input);
      if (result.status === "anchored") result.ref.signer = "did:demos:mallory";
      return result;
    };
    expect(await runFulfilmentCore(wrongSigner.request, wrongSigner.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-evidence-publication-pending",
    });

    const nonSr2 = fixture();
    const sr2Anchor = nonSr2.deps.anchorEvidence;
    nonSr2.deps.anchorEvidence = async (input) => {
      const result = await sr2Anchor(input);
      if (result.status === "anchored") {
        result.ref.anchor = {
          kind: "https",
          locator: "https://seller.example/not-an-sr2-anchor",
        };
      }
      return result;
    };
    expect(await runFulfilmentCore(nonSr2.request, nonSr2.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-evidence-publication-pending",
    });
  });

  test.each(["dropped", "expired", "reorged", "replaced"] as const)(
    "keeps a recoverable %s delivery receipt pending",
    async (state) => {
      const f = fixture();
      f.deps.resolveDelivery = async () => ({
        status: "verified",
        value: {
          artifact: f.artifact,
          anchorReceipt: {
            ...anchorReceipt(
              "dacs4:deliverable:job-17",
              sha256Hex(canonicalize(f.artifact.anchoredValue)),
              state,
            ),
            ...(state === "replaced"
              ? { replacementTransactionRef: { kind: "test", value: "tx:replacement" } }
              : {}),
          },
        },
      });
      expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
        decision: "indeterminate",
        code: "delivery-verification-indeterminate",
        safeToRetryDelivery: false,
      });
    },
  );

  test("reconciles an ambiguous DPA writer result before deciding whether to submit payload", async () => {
    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;
    const f = fixture(spec);
    const record = payloadAttestationRecord(spec, f.artifact.cleartextBytes!);
    installPayloadRecord(f, spec, record);
    f.deps.anchorPayloadAttestation = async () => ({
      status: "anchored",
      ref: f.artifact.attestationRef!,
      anchorReceipt: anchorReceipt(
        f.artifact.attestationRef!.anchor.locator,
        f.artifact.attestationRef!.contentHash,
      ),
      nonCloneable: () => undefined,
    } as never);
    f.deps.submitDelivery = vi.fn(f.deps.submitDelivery);
    expect((await runFulfilmentCore(f.request, f.deps)).decision).toBe("completed");
    expect(f.deps.submitDelivery).toHaveBeenCalledOnce();
  });

  test("submission success cannot authorize fulfilment without independent reconciliation", async () => {
    const f = fixture();
    f.deps.reconcileDelivery = vi.fn()
      .mockResolvedValueOnce({ status: "absent", reason: "authoritative absence" })
      .mockResolvedValueOnce({ status: "pending", reason: "worker acknowledgement is not proof" });
    f.deps.resolveDelivery = vi.fn(f.deps.resolveDelivery);
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-reconciliation-pending",
      safeToRetryDelivery: false,
    });
    expect(f.deps.resolveDelivery).not.toHaveBeenCalled();
  });

  test("does not mint failure evidence from a non-durable submit rejection", async () => {
    const f = fixture();
    f.deps.submitDelivery = async () => ({ status: "rejected", reason: "application refused" });
    f.deps.reconcileDelivery = async () => ({
      status: "absent",
      reason: "no durable terminal result",
    });
    f.deps.anchorEvidence = vi.fn(f.deps.anchorEvidence);
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-rejection-unreconciled",
      safeToRetryDelivery: false,
    });
    expect(f.deps.anchorEvidence).not.toHaveBeenCalled();
  });

  test("malformed submit and reconciliation dispositions fail closed", async () => {
    const reconcile = fixture();
    reconcile.deps.reconcileDelivery = async () => ({
      status: "complete",
      reconciliationId: "",
      observedAt: NOW,
    });
    expect(await runFulfilmentCore(reconcile.request, reconcile.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-reconciliation-pending",
      safeToRetryDelivery: false,
    });

    const submit = fixture();
    submit.deps.submitDelivery = async () => ({
      status: "accepted",
      reconciliationId: "",
    });
    expect(await runFulfilmentCore(submit.request, submit.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-submission-ambiguous",
      safeToRetryDelivery: false,
    });
  });

  test("rejects caller-asserted delivery and evidence anchors without authenticated receipts", async () => {
    const delivery = fixture();
    delivery.deps.verifyAnchorReceipt = async ({ purpose }) =>
      purpose === "delivery"
        ? { disposition: "invalid", reason: "forged inclusion proof" }
        : { disposition: "valid" };
    expect(await runFulfilmentCore(delivery.request, delivery.deps)).toMatchObject({
      decision: "failed",
      errorClass: "permanent",
      evidence: { outcome: "failure" },
    });

    const evidence = fixture();
    evidence.deps.verifyAnchorReceipt = async ({ purpose }) =>
      purpose === "settlement-evidence"
        ? { disposition: "invalid", reason: "forged evidence anchor" }
        : { disposition: "valid" };
    expect(await runFulfilmentCore(evidence.request, evidence.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-evidence-publication-pending",
      safeToRetryDelivery: false,
    });
  });

  test("uses normative signature-omitting contentHash for entitlement records", async () => {
    const f = fixture({ kind: "entitlement", durationSec: 3_600, renewable: true });
    const result = await runFulfilmentCore(f.request, f.deps);
    expect(result.decision).toBe("completed");
    if (result.decision === "completed" && result.evidence.outcome === "success") {
      expect(result.evidence).toMatchObject({
        deliverableContentHash: contentHash(
          f.artifact.cleartextPayload as Record<string, unknown>,
        ),
      });
      expect(result.evidence.deliverableContentHash).not.toBe(
        sha256Hex(canonicalize(f.artifact.cleartextPayload)),
      );
    }
  });

  test("rejects credentialRef until DV-5 evidence addressing is normative", async () => {
    const f = fixture({ kind: "entitlement", durationSec: 3_600, renewable: true });
    (f.artifact.cleartextPayload as Record<string, unknown>).credentialRef = {
      ref: {
        anchor: { kind: "storage-program", locator: "dacs4:credential:job-17" },
        contentHash: H.attestation,
      },
      accessModel: "buyer-only",
    };
    f.artifact.anchoredValue = structuredClone(f.artifact.cleartextPayload);
    const hash = contentHash(f.artifact.cleartextPayload as Record<string, unknown>);
    f.deps.resolveDelivery = async () => ({
      status: "verified",
      value: {
        artifact: f.artifact,
        anchorReceipt: anchorReceipt("dacs4:entitlement:job-17:0", hash),
      },
    });
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "failed",
      errorClass: "permanent",
      evidence: { outcome: "failure" },
    });
  });

  test.each([
    ["record signature", (f: Fixture) => {
      f.deps.verifyPayloadAttestationSignature = async () => ({
        disposition: "invalid", reason: "cryptographic mismatch",
      });
    }],
    ["method-native proof", (f: Fixture) => {
      f.deps.verifyPayloadMethodProof = async () => ({
        disposition: "invalid", reason: "proof does not bind payload bytes",
      });
    }],
  ] as Array<[string, (f: Fixture) => void]>) (
    "independently verifies the DPA %s instead of trusting adapter booleans",
    async (_label, mutate) => {
      const f = fixture({
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" },
      });
      mutate(f);
      expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
        decision: "failed",
        errorClass: "permanent",
        evidence: { outcome: "failure" },
      });
    },
  );

  test("requires the DPA verifier to preserve the exact signed inputs", async () => {
    const f = fixture({
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    });
    f.deps.verifyPayloadMethodProof = async (input) => {
      (input.record as SellerPayloadAttestationRecord).reason = "mutated";
      return { disposition: "valid" };
    };
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-preparation-indeterminate",
      safeToRetryDelivery: true,
    });
  });

  test("withholds delivery and failure evidence until a DPA contradiction is durably terminal", async () => {
    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;
    const f = fixture(spec);
    const record = payloadAttestationRecord(spec, f.artifact.cleartextBytes!);
    installPayloadRecord(f, spec, record);
    f.deps.resolvePayloadAttestation = async () => ({
      status: "rejected",
      reason: "authenticated record contradicts the retained candidate",
    });
    f.deps.submitDelivery = vi.fn(f.deps.submitDelivery);
    f.deps.anchorEvidence = vi.fn(f.deps.anchorEvidence);
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "indeterminate",
      code: "payload-attestation-publication-invalid",
      safeToRetryDelivery: false,
      recovery: { action: "reconcile-payload-attestation" },
    });
    expect(f.store.consumed).toBe(true);
    expect(f.deps.submitDelivery).not.toHaveBeenCalled();
    expect(f.deps.anchorEvidence).not.toHaveBeenCalled();
  });

  test("anchors a typed failure only after authoritative failure reconciliation", async () => {
    const f = fixture(undefined, true);
    f.deps.reconcileDelivery = async () => ({
      status: "failed",
      reason: "application rejected exact work id",
      observedAt: NOW,
    });
    const result = await runFulfilmentCore(f.request, f.deps);
    expect(result).toMatchObject({
      decision: "failed",
      errorClass: "permanent",
      evidence: { phase: "deliver-storage-program", outcome: "failure" },
      bundleContribution: { phaseSummary: { outcome: "fail", errorClass: "permanent" } },
    });
  });

  test("does not demote a durable terminal failure behind later DPA verifier outages", async () => {
    const spec = {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    } as const;
    const f = fixture(spec, true);
    f.deps.reconcileDelivery = async () => ({
      status: "failed",
      reason: "durably recorded DPA publication contradiction",
      observedAt: NOW,
      reconciliationId: "failure:job-17:1",
    });
    f.deps.verifyPayloadAttestationSignature = vi.fn(async () => ({
      disposition: "indeterminate" as const,
      reason: "key service unavailable after terminal failure",
    }));
    f.deps.verifyPayloadMethodProof = vi.fn(async () => ({
      disposition: "indeterminate" as const,
      reason: "proof service unavailable after terminal failure",
    }));
    f.deps.resolvePayloadAttestation = vi.fn(async () => ({
      status: "indeterminate" as const,
      reason: "read replica unavailable after terminal failure",
    }));
    expect(await runFulfilmentCore(f.request, f.deps)).toMatchObject({
      decision: "failed",
      evidence: {
        outcome: "failure",
        reason: "durably recorded DPA publication contradiction",
        observedAt: NOW,
      },
    });
    expect(f.deps.verifyPayloadAttestationSignature).not.toHaveBeenCalled();
    expect(f.deps.verifyPayloadMethodProof).not.toHaveBeenCalled();
    expect(f.deps.resolvePayloadAttestation).not.toHaveBeenCalled();
  });

  test("never recommends redelivery after an ambiguous submit or evidence outage", async () => {
    const submit = fixture();
    submit.deps.submitDelivery = async () => ({
      status: "indeterminate",
      reason: "response lost",
      reconciliationId: "delivery:job-17:1",
    });
    expect(await runFulfilmentCore(submit.request, submit.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-submission-ambiguous",
      safeToRetryDelivery: false,
    });

    const anchor = fixture();
    anchor.deps.anchorEvidence = async () => ({ status: "indeterminate", reason: "SR-2 unavailable" });
    expect(await runFulfilmentCore(anchor.request, anchor.deps)).toMatchObject({
      decision: "indeterminate",
      code: "delivery-evidence-publication-pending",
      safeToRetryDelivery: false,
      evidence: { outcome: "success" },
    });
  });
});
