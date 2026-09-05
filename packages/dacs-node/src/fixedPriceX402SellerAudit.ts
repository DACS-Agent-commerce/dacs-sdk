import {
  ARTIFACT_SEPARATORS,
  FINALITY_COMMITMENT_SEPARATOR,
  bundleAddress,
  encodeAddressSegment,
  projectDurableSellerAuditPending,
  validateFixedPriceAgreementBinding,
  type DurableSellerBundleFinalizationProvider,
  type FinalizeCompletedSellerBundleInput,
  type SellerBundleFinalizationDurability,
} from "@kynesyslabs/dacs";
import {
  isAgreementArtifact,
  isCompositeVerificationRecord,
  isFaultAttestationBundle,
  isListing,
  isSettlementEvidence,
  type AnchorReceipt,
  type BundleBinding,
  type ComponentSignature,
} from "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { ed25519Verify, publicKeyFromRaw, signedBytes } from
  "@kynesyslabs/dacs/crypto";
import { canonicalDemosAgentPublicKey, identityBundleHash } from
  "@kynesyslabs/dacs/identity";

import type { DacsSellerAuditMaterialV1 } from "./auditRuntime.js";
import { loadDacsSellerAgreementVetProductionForOrderV1 } from
  "./agreementTransportRuntime.js";
import {
  createDacsDemosBundlePublicationV1,
} from "./demosBundlePublication.js";
import {
  DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1,
  captureDacsFixedPriceX402ApplicationV1,
  loadDacsFixedPriceX402CommitmentResultV1,
  loadDacsFixedPriceX402SellerAdmissionV1,
} from "./fixedPriceX402Profile.js";
import type { DacsFixedPriceX402SellerFulfilmentV1 } from
  "./fixedPriceX402SellerFulfilment.js";
import type { DacsSellerLiveCommerceAssemblyOptionsV1 } from
  "./liveCommerceAssembly.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";
import { loadDacsSellerX402AuthorizationForOrderV1 } from
  "./sellerX402Runtime.js";
import { loadDacsSellerSessionAgreementFactsForOrderV1 } from
  "./sessionBootstrapAgreementRuntime.js";

const FINALIZATION_VERSION = "1" as const;
const FINALIZATION_DOMAIN = "dacs-fixed-price-x402-seller-audit-time:v1:" as const;
const DEFAULT_LEASE_TTL_MS = 30_000;
const HASH_RE = /^[0-9a-f]{64}$/;

type SellerAuditOptions = DacsSellerLiveCommerceAssemblyOptionsV1["audit"];
type Dependency = FinalizeCompletedSellerBundleInput["dependencies"][number];
export interface DacsFixedPriceX402SellerAuditOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  fulfilment: Readonly<DacsFixedPriceX402SellerFulfilmentV1>;
  leaseTtlMs?: number;
}

export class DacsFixedPriceX402SellerAuditError extends Error {
  override readonly name = "DacsFixedPriceX402SellerAuditError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

interface FinalizationClockV1 {
  finalizationVersion: typeof FINALIZATION_VERSION;
  jobId: string;
  localBindingHash: string;
  finalisedAt: number;
}

interface AuthenticatedArtifactV1 {
  artifact: Readonly<Record<string, unknown>>;
  receipt: Readonly<AnchorReceipt>;
  writer: string;
}

function copy<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

function plainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null) &&
      Reflect.ownKeys(value).every((key) => {
        if (typeof key !== "string") return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
      });
  } catch {
    return false;
  }
}

function owner(claim: string): string {
  const prefix = "did:demos:agent:";
  if (!claim.startsWith(prefix) || claim.length !== prefix.length + 64) {
    throw new DacsFixedPriceX402SellerAuditError("seller-audit-authority-invalid");
  }
  return claim.slice(prefix.length);
}

function positiveTiming(value: unknown): number {
  const captured = value ?? DEFAULT_LEASE_TTL_MS;
  if (!Number.isSafeInteger(captured) || Number(captured) <= 0 ||
      Number(captured) > 600_000) {
    throw new TypeError("fixed-price seller audit timing is invalid");
  }
  return Number(captured);
}

function finalizationId(jobId: string): string {
  return sha256Hex(`${FINALIZATION_DOMAIN}${jobId}`);
}

function captureClock(value: unknown): Readonly<FinalizationClockV1> {
  if (!plainObject(value) || Object.keys(value).length !== 4 ||
      value.finalizationVersion !== FINALIZATION_VERSION ||
      typeof value.jobId !== "string" || value.jobId.length === 0 ||
      typeof value.localBindingHash !== "string" || !HASH_RE.test(value.localBindingHash) ||
      !Number.isSafeInteger(value.finalisedAt) || Number(value.finalisedAt) < 0) {
    throw new DacsFixedPriceX402SellerAuditError("seller-audit-clock-corrupt");
  }
  return Object.freeze(copy(value) as unknown as FinalizationClockV1);
}

function retainFinalisedAt(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  jobId: string,
  localBindingHash: string,
  causalFloor: number,
): number {
  const id = finalizationId(jobId);
  const existing = context.database.loadEffectInput("session", id);
  if (existing !== undefined) {
    const captured = captureClock(existing);
    if (captured.jobId !== jobId || captured.localBindingHash !== localBindingHash ||
        captured.finalisedAt < causalFloor) {
      throw new DacsFixedPriceX402SellerAuditError("seller-audit-clock-conflict");
    }
    return captured.finalisedAt;
  }
  const finalisedAt = Math.max(context.database.readTime(), causalFloor);
  if (!Number.isSafeInteger(finalisedAt)) {
    throw new DacsFixedPriceX402SellerAuditError("seller-audit-clock-invalid");
  }
  const record: FinalizationClockV1 = {
    finalizationVersion: FINALIZATION_VERSION,
    jobId,
    localBindingHash,
    finalisedAt,
  };
  const put = context.database.putEffectIntent({
    kind: "session",
    effectId: id,
    bindingHash: localBindingHash,
    input: record,
    idempotencyKey: id,
    jobId,
  });
  if (put.status === "conflict") {
    throw new DacsFixedPriceX402SellerAuditError("seller-audit-clock-conflict");
  }
  return captureClock(context.database.loadEffectInput("session", id)).finalisedAt;
}

function publicKey(claim: string): Uint8Array | null {
  const raw = canonicalDemosAgentPublicKey(claim);
  return raw === null ? null : Uint8Array.from(raw);
}

function verifySignature(
  separator: Parameters<typeof signedBytes>[0],
  artifact: Readonly<Record<string, unknown>>,
  signature: Readonly<ComponentSignature>,
  expectedSigner: string,
): boolean {
  const key = publicKey(expectedSigner);
  if (key === null || signature.algorithm !== "ed25519" ||
      signature.signer !== expectedSigner) return false;
  const encoded = signature.value;
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.byteLength !== 64 || bytes.toString("base64url") !== encoded) return false;
  try {
    return ed25519Verify(
      signedBytes(separator, contentHash(artifact)),
      Uint8Array.from(bytes),
      publicKeyFromRaw(key),
    );
  } catch {
    return false;
  }
}

async function authenticatedReceipt(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  input: Readonly<{
    logicalAddress: string;
    nativeAddress: string;
    contentHash: string;
    writer: string;
  }>,
): Promise<Readonly<AnchorReceipt>> {
  const receipt = await context.demos.adapter.resolveDemosAnchorReceipt(input);
  if (receipt === null) {
    throw new DacsFixedPriceX402SellerAuditError("seller-audit-anchor-unavailable");
  }
  if (receipt.writer !== input.writer ||
      receipt.logicalAddress !== input.logicalAddress ||
      receipt.nativeAddress !== input.nativeAddress ||
      receipt.contentHash !== input.contentHash ||
      receipt.observationDisposition !== "established" ||
      (receipt.state !== "included" && receipt.state !== "finalized") ||
      await context.demos.adapter.verifyDemosAnchorReceipt(receipt) !== true) {
    throw new DacsFixedPriceX402SellerAuditError("seller-audit-receipt-invalid");
  }
  return Object.freeze(copy(receipt));
}

async function resolveActorAnchor(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  logicalAddress: string,
  writer: string,
  expectedHash: string,
): Promise<Readonly<AuthenticatedArtifactV1>> {
  const resolved = await context.demos.adapter.resolveAnchorByName(
    logicalAddress,
    owner(writer),
  );
  if (resolved.status !== "present") {
    throw new DacsFixedPriceX402SellerAuditError("seller-audit-anchor-unavailable");
  }
  const artifact = await context.demos.adapter.readAnchor(resolved.address);
  if (artifact === null) {
    throw new DacsFixedPriceX402SellerAuditError("seller-audit-anchor-unavailable");
  }
  if (contentHash(artifact) !== expectedHash) {
    throw new DacsFixedPriceX402SellerAuditError("seller-audit-anchor-invalid");
  }
  const receipt = await authenticatedReceipt(context, {
    logicalAddress,
    nativeAddress: resolved.address,
    contentHash: expectedHash,
    writer,
  });
  return Object.freeze({ artifact: copy(artifact), receipt, writer });
}

async function authenticateRetainedAnchor(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  artifact: Readonly<Record<string, unknown>>,
  receipt: Readonly<AnchorReceipt>,
  writer: string,
): Promise<Readonly<AuthenticatedArtifactV1>> {
  const hash = contentHash(artifact);
  if (receipt.writer !== writer || receipt.contentHash !== hash) {
    throw new DacsFixedPriceX402SellerAuditError("seller-audit-retained-anchor-invalid");
  }
  const authenticated = await authenticatedReceipt(context, {
    logicalAddress: receipt.logicalAddress,
    nativeAddress: receipt.nativeAddress,
    contentHash: hash,
    writer,
  });
  const readback = await context.demos.adapter.readAnchor(receipt.nativeAddress);
  if (readback === null) {
    throw new DacsFixedPriceX402SellerAuditError("seller-audit-anchor-unavailable");
  }
  if (canonicalize(readback) !== canonicalize(artifact)) {
    throw new DacsFixedPriceX402SellerAuditError("seller-audit-retained-readback-invalid");
  }
  return Object.freeze({ artifact: copy(artifact), receipt: authenticated, writer });
}

function dependency(
  source: Dependency["source"],
  anchored: Readonly<AuthenticatedArtifactV1>,
): Dependency {
  return { source: copy(source), anchorReceipt: copy(anchored.receipt) };
}

function exactEmptyRequirement(value: unknown): boolean {
  return canonicalize(value) === canonicalize(DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1);
}

/**
 * Close seller DACS-5 material for the generated schema-free public-storage
 * profile. Every dependency is re-read with an authenticated Demos receipt;
 * the terminal session is projected only from the exact fulfilment WAL.
 */
export function createDacsFixedPriceX402SellerAuditV1(
  options: Readonly<DacsFixedPriceX402SellerAuditOptionsV1>,
): Readonly<SellerAuditOptions> {
  if (!plainObject(options) || !plainObject(options.context) ||
      options.context.role !== "seller" || !plainObject(options.fulfilment)) {
    throw new TypeError("fixed-price seller audit options are invalid");
  }
  const context = options.context;
  const leaseTtlMs = positiveTiming(options.leaseTtlMs);
  const terminalVerification = Object.freeze({
    verifyEvidenceSignature: options.fulfilment.fulfilmentDeps.verifyEvidenceSignature,
    verifyAuditSourceCommitmentSignature:
      options.fulfilment.fulfilmentDeps.verifyAuditSourceCommitmentSignature,
    verifyAnchorReceipt: options.fulfilment.fulfilmentDeps.verifyAnchorReceipt,
  });

  return Object.freeze({
    async resolveMaterial({ operation, retained }) {
      const order = operation.order;
      const application = captureDacsFixedPriceX402ApplicationV1(retained.application);
      if (retained.localBindingHash !== order.localBindingHash ||
          !exactEmptyRequirement(application.listing.buyerRequirement)) {
        throw new DacsFixedPriceX402SellerAuditError("seller-audit-profile-invalid");
      }
      const authorization = loadDacsSellerX402AuthorizationForOrderV1(context, order, 2);
      const agreementResolution = await options.fulfilment.fulfilmentDeps.resolveAgreement(
        authorization.sessionAuthorization.agreementRef,
      );
      const listingResolution = await options.fulfilment.fulfilmentDeps.resolveListing(
        authorization.sessionAuthorization.listingRef,
      );
      if (agreementResolution.status === "rejected" ||
          listingResolution.status === "rejected") {
        throw new DacsFixedPriceX402SellerAuditError("seller-audit-authority-invalid");
      }
      if (agreementResolution.status !== "verified" ||
          listingResolution.status !== "verified") {
        throw new DacsFixedPriceX402SellerAuditError("seller-audit-authority-unavailable");
      }
      const verifiedAgreement = agreementResolution.value;
      const verifiedListing = listingResolution.value;
      const stored = await context.sessionStore.load(order.jobId);
      if (stored.status !== "ok") {
        throw new DacsFixedPriceX402SellerAuditError("seller-audit-terminal-wal-unavailable");
      }
      const projection = await projectDurableSellerAuditPending({
        record: stored.record,
        verifiedAgreement: copy(verifiedAgreement),
        verifiedListing: copy(verifiedListing),
        expectedDeliveryWriter: { role: "seller", primaryClaim: order.seller },
        ...terminalVerification,
      });
      const deliveryEvidence = projection.terminal.result.evidence;
      if (deliveryEvidence.outcome !== "success") {
        throw new DacsFixedPriceX402SellerAuditError(
          "seller-audit-delivery-not-successful",
        );
      }
      const session = loadDacsSellerSessionAgreementFactsForOrderV1(context, order);
      const sellerVet = loadDacsSellerAgreementVetProductionForOrderV1(context, order);
      const admission = loadDacsFixedPriceX402SellerAdmissionV1(context, order);
      const commitment = loadDacsFixedPriceX402CommitmentResultV1(context, order);
      if (!exactEmptyRequirement(verifiedListing.buyerRequirement) ||
          canonicalize(admission.application) !== canonicalize(application)) {
        throw new DacsFixedPriceX402SellerAuditError("seller-audit-retained-state-invalid");
      }
      validateFixedPriceAgreementBinding(copy({
        agreement: commitment.agreement,
        verifiedListing: {
          disposition: "verified",
          listing: application.listing,
          pin: authorization.sessionAuthorization.listingRef,
        },
        committedAt: commitment.commitment.committedAt,
      }));

      const agreementHash = contentHash(
        commitment.agreement as unknown as Record<string, unknown>,
      );
      const commitmentHash = contentHash(
        commitment.commitment.record as unknown as Record<string, unknown>,
      );
      const paymentRef = projection.sessionArtifacts.settlementEvidence.find((ref) =>
        ref.contentHash === authorization.paymentAuthorization.evidenceHash
      );
      if (paymentRef === undefined || paymentRef.anchor.kind !== "storage-program") {
        throw new DacsFixedPriceX402SellerAuditError("seller-audit-payment-ref-invalid");
      }

      const [listingAnchor, agreementAnchor, paymentAnchor] = await Promise.all([
        (async () => {
          const artifact = application.listing as unknown as Readonly<Record<string, unknown>>;
          const receipt = await authenticatedReceipt(context, {
            logicalAddress: application.listingLogicalAddress,
            nativeAddress: application.listingRef,
            contentHash: application.listingContentHash,
            writer: order.seller,
          });
          const readback = await context.demos.adapter.readAnchor(application.listingRef);
          if (readback === null) {
            throw new DacsFixedPriceX402SellerAuditError("seller-audit-anchor-unavailable");
          }
          if (canonicalize(readback) !== canonicalize(artifact)) {
            throw new DacsFixedPriceX402SellerAuditError("seller-audit-listing-readback-invalid");
          }
          return Object.freeze({ artifact: copy(artifact), receipt, writer: order.seller });
        })(),
        resolveActorAnchor(context, authorization.sessionAuthorization.agreementRef,
          order.buyer, agreementHash),
        resolveActorAnchor(context, paymentRef.anchor.locator, order.buyer,
          paymentRef.contentHash),
      ]);
      const commitmentAnchor = await authenticateRetainedAnchor(
        context,
        commitment.commitment.record as unknown as Readonly<Record<string, unknown>>,
        commitment.commitment.anchorReceipt,
        order.seller,
      );
      const buyerVetAnchor = await authenticateRetainedAnchor(
        context,
        session.buyerVetRecord as unknown as Readonly<Record<string, unknown>>,
        session.buyerVetReceipt,
        order.seller,
      );
      const sellerVetAnchor = await authenticateRetainedAnchor(
        context,
        sellerVet.record as unknown as Readonly<Record<string, unknown>>,
        sellerVet.anchorReceipt,
        order.buyer,
      );
      const deliveryEvidenceAnchor = await authenticateRetainedAnchor(
        context,
        projection.terminal.result.evidence as unknown as Readonly<Record<string, unknown>>,
        projection.terminal.result.evidenceAnchorReceipt,
        order.seller,
      );
      const deliverableRaw = await context.demos.adapter.readAnchor(
        projection.terminal.deliveryAnchorReceipt.nativeAddress,
      );
      if (deliverableRaw === null) {
        throw new DacsFixedPriceX402SellerAuditError("seller-audit-deliverable-unavailable");
      }
      const deliverableAnchor = await authenticateRetainedAnchor(
        context,
        deliverableRaw,
        projection.terminal.deliveryAnchorReceipt,
        order.seller,
      );

      const authenticated = [
        listingAnchor,
        agreementAnchor,
        commitmentAnchor,
        paymentAnchor,
        deliveryEvidenceAnchor,
        buyerVetAnchor,
        sellerVetAnchor,
        deliverableAnchor,
      ] as const;
      const byNative = new Map(authenticated.map((entry) =>
        [entry.receipt.nativeAddress, entry] as const));
      const listingArtifact = listingAnchor.artifact;
      const agreementArtifact = agreementAnchor.artifact;
      const paymentArtifact = paymentAnchor.artifact;
      const deliveryArtifact = deliveryEvidenceAnchor.artifact;
      const buyerVetArtifact = buyerVetAnchor.artifact;
      const sellerVetArtifact = sellerVetAnchor.artifact;
      if (byNative.size !== authenticated.length ||
          !isListing(listingArtifact) ||
          !isAgreementArtifact(agreementArtifact) ||
          !isSettlementEvidence(paymentArtifact) ||
          !isSettlementEvidence(deliveryArtifact) ||
          !isCompositeVerificationRecord(buyerVetArtifact) ||
          !isCompositeVerificationRecord(sellerVetArtifact) ||
          commitment.commitment.recordKind !== "finality") {
        throw new DacsFixedPriceX402SellerAuditError("seller-audit-dependency-invalid");
      }
      const finalityRecord = commitment.commitment.record;
      if (canonicalize(agreementArtifact) !== canonicalize(commitment.agreement) ||
          canonicalize(listingArtifact) !== canonicalize(application.listing) ||
          canonicalize(deliveryArtifact) !== canonicalize(deliveryEvidence) ||
          canonicalize(buyerVetArtifact) !== canonicalize(session.buyerVetRecord) ||
          canonicalize(sellerVetArtifact) !== canonicalize(sellerVet.record)) {
        throw new DacsFixedPriceX402SellerAuditError(
          "seller-audit-dependency-authority-conflict",
        );
      }

      const verifyKnown = (entry: Readonly<AuthenticatedArtifactV1>): boolean => {
        const artifact = entry.artifact;
        if (entry === listingAnchor) {
          return verifySignature(ARTIFACT_SEPARATORS.Listing, artifact,
            listingArtifact.signature, order.seller);
        }
        if (entry === agreementAnchor) {
          const separator = "agreementVersion" in agreementArtifact
            ? ARTIFACT_SEPARATORS.AgreementDocument
            : ARTIFACT_SEPARATORS.PayeeBoundAgreementDocument;
          return agreementArtifact.signatures.length === 2 &&
            agreementArtifact.signatures.every((signature) => {
              const component = {
                algorithm: signature.algorithm,
                signer: signature.party,
                value: signature.value,
              } as const;
              return (signature.party === order.buyer || signature.party === order.seller) &&
                verifySignature(separator, artifact, component, signature.party);
            });
        }
        if (entry === commitmentAnchor) {
          return verifySignature(FINALITY_COMMITMENT_SEPARATOR, artifact,
            finalityRecord.signature, order.seller);
        }
        if (entry === paymentAnchor || entry === deliveryEvidenceAnchor) {
          const evidence = entry === paymentAnchor
            ? paymentArtifact : deliveryArtifact;
          return verifySignature(ARTIFACT_SEPARATORS.SettlementEvidence,
            evidence as unknown as Readonly<Record<string, unknown>>,
            evidence.signature, order.seller);
        }
        if (entry === buyerVetAnchor || entry === sellerVetAnchor) {
          const vet = entry === buyerVetAnchor
            ? buyerVetArtifact : sellerVetArtifact;
          return verifySignature(ARTIFACT_SEPARATORS.CompositeVerificationRecord,
            vet as unknown as Readonly<Record<string, unknown>>,
            vet.signature, entry === buyerVetAnchor ? order.seller : order.buyer);
        }
        return entry === deliverableAnchor &&
          contentHash(artifact) === deliveryEvidence.deliverableContentHash;
      };
      if (authenticated.some((entry) => !verifyKnown(entry))) {
        throw new DacsFixedPriceX402SellerAuditError("seller-audit-signature-invalid");
      }

      const dependencies: Dependency[] = [
        dependency({ kind: "listing", listingRef: authorization.sessionAuthorization.listingRef },
          listingAnchor),
        dependency({ kind: "attestation-ref", ref: {
          anchor: { kind: "storage-program", locator:
            authorization.sessionAuthorization.agreementRef },
          contentHash: agreementHash,
          signer: order.buyer,
        } }, agreementAnchor),
        dependency({ kind: "attestation-ref", ref: {
          anchor: { kind: "storage-program", locator: commitment.commitment.logicalAddress },
          contentHash: commitmentHash,
          signer: order.seller,
        } }, commitmentAnchor),
        dependency({ kind: "attestation-ref", ref: paymentRef }, paymentAnchor),
        dependency({ kind: "attestation-ref", ref:
          projection.terminal.result.evidenceRef }, deliveryEvidenceAnchor),
        dependency({ kind: "attestation-ref", ref: session.buyerVetRef }, buyerVetAnchor),
        dependency({ kind: "attestation-ref", ref: sellerVet.recordRef }, sellerVetAnchor),
        dependency({
          kind: "deliverable",
          anchor: deliveryEvidence.deliverableAnchor,
          contentHash: deliveryEvidence.deliverableContentHash,
          encoding: "jcs",
        }, deliverableAnchor),
      ];

      const publication = createDacsDemosBundlePublicationV1({
        context,
        jobId: order.jobId,
        buyer: order.buyer,
        seller: order.seller,
      });
      const compositeVerificationDeps = Object.freeze({
        resolveRecipe: async () => null,
        isRecipeSignerAuthorized: () => false,
        isVerifyResultSignerAuthorized: () => false,
        resolvePublicKey: async (signature: Readonly<ComponentSignature>) =>
          signature.algorithm === "ed25519" ? publicKey(signature.signer) : null,
        verify: (input: Readonly<{
          signedBytes: Uint8Array;
          signature: Readonly<ComponentSignature>;
          publicKey: Uint8Array;
        }>) => {
          try {
            return ed25519Verify(
              input.signedBytes,
              Uint8Array.from(Buffer.from(input.signature.value, "base64url")),
              publicKeyFromRaw(input.publicKey),
            );
          } catch {
            return false;
          }
        },
        verifyAuthorityAttestation: () => "unresolved" as const,
      });

      const provider: DurableSellerBundleFinalizationProvider = {
        mapping: publication.mapping,
        bundleCopyVerifier: publication.bundleCopyVerifier,
        compositeVerificationDeps,
        async resolveDependency(candidate) {
          const known = byNative.get(candidate.anchorReceipt.nativeAddress);
          if (known === undefined) return { disposition: "absent" as const };
          try {
            const readback = await context.demos.adapter.readAnchor(
              candidate.anchorReceipt.nativeAddress,
            );
            return readback === null
              ? { disposition: "absent" as const }
              : { disposition: "present" as const, artifact: copy(readback) };
          } catch {
            return { disposition: "indeterminate" as const,
              reason: "seller-audit-dependency-read-unavailable" };
          }
        },
        async verifyDependencyReceipt(candidate) {
          const known = byNative.get(candidate.anchorReceipt.nativeAddress);
          if (known === undefined ||
              canonicalize(known.receipt) !== canonicalize(candidate.anchorReceipt)) {
            return "invalid" as const;
          }
          try {
            return await context.demos.adapter.verifyDemosAnchorReceipt(
              candidate.anchorReceipt,
            ) === true ? "valid" as const : "invalid" as const;
          } catch {
            return "error" as const;
          }
        },
        verifyDependencyBinding({ dependency: candidate, requirement, artifact }) {
          const known = byNative.get(candidate.anchorReceipt.nativeAddress);
          if (known === undefined || !plainObject(artifact) ||
              requirement.contentHash !== contentHash(artifact) ||
              canonicalize(artifact) !== canonicalize(known.artifact)) return "invalid";
          return verifyKnown(known) ? "valid" : "invalid";
        },
        verifyListingPublisherIdentityLinkage(input) {
          return input.primaryClaim === order.seller &&
              input.listingIdentity.presentedBy === order.seller &&
              input.listingIdentity.claims.some(({ ref }) => ref === order.seller) &&
              input.listingBundleHash === identityBundleHash(application.listing.seller.identity) &&
              input.sessionBundleHash === identityBundleHash(session.sellerIdentity)
            ? "valid" : "invalid";
        },
        verifyVetRequirementProvenance({ invocation, compositeRecord, listingOwned }) {
          const expectedRecord = listingOwned ? session.buyerVetRecord : sellerVet.record;
          const expectedParty = listingOwned ? order.buyer : order.seller;
          const expectedVerifier = listingOwned ? order.seller : order.buyer;
          return invocation.evaluatedParty === expectedParty &&
              invocation.verifier === expectedVerifier &&
              exactEmptyRequirement(invocation.requirement) &&
              canonicalize(compositeRecord) === canonicalize(expectedRecord)
            ? "valid" : "invalid";
        },
        resolvePaymentPhaseIndex({ dependency: candidate, evidence }) {
          const payment = authorization.paymentAuthorization;
          const exact = candidate.anchorReceipt.nativeAddress ===
              paymentAnchor.receipt.nativeAddress &&
            canonicalize(evidence) === canonicalize(paymentAnchor.artifact) &&
            payment.evidenceHash === contentHash(evidence) &&
            payment.jobId === order.jobId && payment.phaseIndex === 2 &&
            payment.railId === order.protocol.rail.railId &&
            candidate.anchorReceipt.logicalAddress ===
              `dacs4:payment:${order.jobId}:${encodeAddressSegment(payment.railId)}:2`;
          return exact ? {
            disposition: "valid" as const,
            jobId: order.jobId,
            railId: payment.railId,
            phaseIndex: 2,
            resolved: false,
          } : { disposition: "invalid" as const,
            reason: "seller-audit-payment-binding-invalid" };
        },
        async resolveSellerBundle(logicalAddress) {
          if (logicalAddress !== bundleAddress(order.jobId, "seller")) {
            return { disposition: "absent" as const };
          }
          try {
            const anchored = await publication.resolveRoleBundle("seller");
            return anchored === null
              ? { disposition: "absent" as const }
              : { disposition: "present" as const, anchored };
          } catch {
            return { disposition: "indeterminate" as const,
              reason: "seller-audit-bundle-read-unavailable" };
          }
        },
        submitSellerBundle: (logicalAddress, bundle) => {
          if (logicalAddress !== bundleAddress(order.jobId, "seller")) {
            throw new DacsFixedPriceX402SellerAuditError(
              "seller-audit-bundle-address-rebound",
            );
          }
          return publication.submitRoleBundle("seller", logicalAddress, bundle);
        },
        async verifyBundleAnchorReceipt(anchored) {
          if (!isFaultAttestationBundle(anchored.bundle)) return "invalid";
          return publication.verifyBundleAnchorReceipt({
            ...anchored,
            bundle: anchored.bundle,
          });
        },
        resolveBundleBinding: publication.resolveBundleBinding,
        publishBundleBinding: (binding) =>
          publication.publishRoleBundleBinding("seller", binding),
        verifyBundleBinding: publication.verifyBundleBinding,
      };

      const durability: Omit<
        SellerBundleFinalizationDurability,
        "store" | "workerId"
      > = {
        leaseTtlMs,
        leaseNowMs: () => context.database.readTime(),
        terminalVerification,
        reconcileSignature: () => ({ disposition: "authoritatively-absent" as const,
          reason: "seller-audit-deterministic-signature-absent" }),
        async reconcileBundleAnchor({ logicalAddress, bundleContentHash }) {
          try {
            if (logicalAddress !== bundleAddress(order.jobId, "seller")) {
              return { disposition: "rejected" as const,
                reason: "seller-audit-bundle-address-rebound" };
            }
            const anchored = await publication.resolveRoleBundle("seller");
            return anchored === null
              ? { disposition: "authoritatively-absent" as const,
                  reason: "seller-audit-bundle-absent" }
              : anchored.anchorReceipt.contentHash === bundleContentHash
                ? { disposition: "present" as const }
                : { disposition: "rejected" as const,
                    reason: "seller-audit-bundle-conflict" };
          } catch {
            return { disposition: "indeterminate" as const,
              reason: "seller-audit-bundle-reconciliation-unavailable" };
          }
        },
        async reconcileBindingPublication(binding: Readonly<BundleBinding>) {
          try {
            const resolved = await publication.resolveBundleBinding(
              binding.logicalAddress,
              binding.signer,
            );
            if (resolved.disposition === "absent") {
              return { disposition: "authoritatively-absent" as const,
                reason: "seller-audit-binding-absent" };
            }
            if (resolved.disposition === "indeterminate") return resolved;
            return canonicalize(resolved.binding) === canonicalize(binding) &&
                await publication.verifyBundleBinding(binding) === "valid"
              ? { disposition: "published" as const }
              : { disposition: "rejected" as const,
                  reason: "seller-audit-binding-conflict" };
          } catch {
            return { disposition: "indeterminate" as const,
              reason: "seller-audit-binding-reconciliation-unavailable" };
          }
        },
      };

      const finalisedAt = retainFinalisedAt(
        context,
        order.jobId,
        order.localBindingHash,
        projection.session.lastUpdatedAt,
      );
      const material: DacsSellerAuditMaterialV1 = {
        input: {
          agreement: copy(verifiedAgreement),
          verifiedListing: copy(verifiedListing),
          agreementRef: {
            anchor: { kind: "storage-program", locator:
              authorization.sessionAuthorization.agreementRef },
            contentHash: agreementHash,
            signer: order.buyer,
          },
          fulfilment: copy(projection.terminal.result),
          session: copy(projection.session),
          sessionArtifacts: copy(projection.sessionArtifacts),
          finalisedAt,
          seller: {
            primaryClaim: order.seller,
            bundleHash: identityBundleHash(session.sellerIdentity),
          },
          dependencies,
        },
        provider,
        durability,
      };
      return Object.freeze(material);
    },
    async authorizeFinalized({ operation, result }) {
      if (result.logicalAddress !== bundleAddress(operation.order.jobId, "seller") ||
          result.sellerBundle.jobId !== operation.order.jobId) return false;
      const publication = createDacsDemosBundlePublicationV1({
        context,
        jobId: operation.order.jobId,
        buyer: operation.order.buyer,
        seller: operation.order.seller,
      });
      const anchored = await publication.resolveRoleBundle("seller");
      return anchored !== null && anchored.nativeAddress === result.nativeAddress &&
        anchored.anchorReceipt.contentHash === result.bundleContentHash &&
        canonicalize(anchored.bundle) === canonicalize(result.sellerBundle) &&
        await publication.verifyBundleAnchorReceipt(anchored) === "valid";
    },
  });
}
