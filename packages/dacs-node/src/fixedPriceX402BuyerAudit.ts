import {
  ARTIFACT_SEPARATORS,
  FINALITY_COMMITMENT_SEPARATOR,
  baseUnits,
  bundleAddress,
  canonicalSellerSettlementId,
  encodeAddressSegment,
  getAuthenticatedRailProvenance,
  sellerFulfilmentId,
  verifyCompletedTwoSidedSession,
  validateFixedPriceAgreementBinding,
  x402Eip3009Nonce,
  type AuthenticatedRailDefinition,
  type AuditPendingSellerSessionRecord,
  type CompletedSellerPhaseEntry,
  type DurableBuyerBundleFinalizationProvider,
  type FinalizedSellerBundle,
  type FinalizedSessionSettlement,
  type SellerBundleFinalizationReadProvider,
  type SellerFulfilmentAgreement,
  type SellerPaymentAuthorization,
  type SessionSettlementContext,
  type SessionSettlementNativeProofRef,
  type SessionSettlementVerificationProvider,
} from "@kynesyslabs/dacs";
import {
  isAgreementArtifact,
  isAttestationRef,
  isCompositeVerificationRecord,
  isFinalityCommitmentRecord,
  isFaultAttestationBundle,
  isListing,
  isSettlementEvidence,
  type AnchorReceipt,
  type BundleBinding,
  type ComponentSignature,
  type FaultAttestationBundle,
  type PayeeBoundAgreementDocument,
  type SettlementEvidence,
} from "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { ed25519Verify, publicKeyFromRaw, signedBytes } from
  "@kynesyslabs/dacs/crypto";
import { canonicalDemosAgentPublicKey, identityBundleHash } from
  "@kynesyslabs/dacs/identity";
import type {
  FixedPricePayDemOrderInput,
  FixedPricePayDemOrderRecord,
  FixedPriceX402OrderInput,
  FixedPriceX402OrderRecord,
} from "@kynesyslabs/dacs/commerce";
import type {
  CompletedSellerBundleCounterSignatureRequest,
  DemosTransferObservation,
  VerifyCompletedSellerBundleCounterSignatureRequestInput,
} from "@kynesyslabs/dacs/seller";

import type {
  DacsBuyerAuditMaterialV1,
  DacsPayDemBuyerAuditRuntimeOptionsV1,
} from "./auditRuntime.js";
import type { DacsBuyerBundleRequestVerificationV1 } from
  "./bundleTransportRuntime.js";
import {
  loadDacsBuyerBundleSignatureForOrderV1,
  loadDacsBuyerBundleSignatureRequestForOrderV1,
} from "./bundleTransportRuntime.js";
import {
  createDacsDemosBundlePublicationV1,
  type DacsDemosBundlePublicationV1,
} from "./demosBundlePublication.js";
import {
  DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1,
  captureDacsFixedPriceX402ApplicationV1,
  loadDacsFixedPriceX402BuyerAgreementPublicationV1,
} from "./fixedPriceX402Profile.js";
import { loadDacsFixedPricePayDemBuyerAgreementPublicationV1 } from
  "./fixedPricePayDemProfile.js";
import type { DacsBuyerLiveCommerceAssemblyOptionsV1 } from
  "./liveCommerceAssembly.js";
import type { DacsLiveOrderInputV1 } from "./orderInput.js";
import { loadDacsLiveOrderInputV1 } from "./orderInput.js";
import {
  createDacsFixedPricePayDemRoleOrderV1,
  createDacsFixedPriceX402RoleOrderV1,
} from "./liveOrder.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";
import {
  loadDacsBuyerSessionAgreementFactsForOrderV1,
  loadDacsPayDemBuyerSessionAgreementFactsForOrderV1,
} from
  "./sessionBootstrapAgreementRuntime.js";
import { createDacsX402SellerEvmObserverV1 } from "./x402SellerEvm.js";

const DEFAULT_LEASE_TTL_MS = 30_000;
const HASH_RE = /^[0-9a-f]{64}$/;

type BuyerAuditOptions = DacsBuyerLiveCommerceAssemblyOptionsV1["audit"];
type PayDemBuyerAuditOptions = Omit<
  DacsPayDemBuyerAuditRuntimeOptionsV1,
  "context" | "workerId" | "bundleTransport"
>;
type BuyerBundleTransportOptions = DacsBuyerLiveCommerceAssemblyOptionsV1["bundleTransport"];
type Dependency = VerifyCompletedSellerBundleCounterSignatureRequestInput[
  "dependencies"
][number];

export interface DacsFixedPriceX402BuyerAuditOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  rail: Readonly<AuthenticatedRailDefinition>;
  evmRpcUrl: string;
  authorizationSearchFromBlock: number;
  recipeRegistryVersion: number;
  finalityTag?: "finalized" | "safe" | "latest";
  logPageSize?: number;
  fetchImpl?: typeof fetch;
  leaseTtlMs?: number;
}

export interface DacsFixedPriceX402BuyerAuditV1 {
  bundleTransport: Readonly<BuyerBundleTransportOptions>;
  audit: Readonly<BuyerAuditOptions>;
}

export interface DacsFixedPricePayDemBuyerAuditOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  rail: Readonly<AuthenticatedRailDefinition>;
  observeDemosTransfer(txHash: string): Promise<DemosTransferObservation>;
  recipeRegistryVersion: number;
  leaseTtlMs?: number;
}

export interface DacsFixedPricePayDemBuyerAuditV1 {
  bundleTransport: Readonly<BuyerBundleTransportOptions>;
  audit: Readonly<PayDemBuyerAuditOptions>;
}

type DacsFixedPriceBuyerAuditOptionsV1 =
  | (DacsFixedPriceX402BuyerAuditOptionsV1 & { paymentProfile: "x402" })
  | (DacsFixedPricePayDemBuyerAuditOptionsV1 & { paymentProfile: "pay-dem" });

type BuyerLiveOrderRecord = FixedPriceX402OrderRecord | FixedPricePayDemOrderRecord;
type BuyerRetainedOrder =
  | DacsLiveOrderInputV1<FixedPriceX402OrderInput>
  | DacsLiveOrderInputV1<FixedPricePayDemOrderInput>;

function isPayDemOrder(
  order: Readonly<BuyerLiveOrderRecord>,
): order is Readonly<FixedPricePayDemOrderRecord> {
  return order.protocol.phase === "pay-dem";
}

export class DacsFixedPriceX402BuyerAuditError extends Error {
  override readonly name = "DacsFixedPriceX402BuyerAuditError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

interface AuthenticatedArtifactV1 {
  artifact: Readonly<Record<string, unknown>>;
  receipt: Readonly<AnchorReceipt>;
  writer: string;
}

interface BuyerReviewMaterialV1 {
  input: Readonly<VerifyCompletedSellerBundleCounterSignatureRequestInput>;
  provider: Readonly<SellerBundleFinalizationReadProvider>;
  publication: Readonly<DacsDemosBundlePublicationV1>;
  settlementContext: Readonly<SessionSettlementContext>;
  settlement: Readonly<FinalizedSessionSettlement>;
  settlementVerification: Readonly<SessionSettlementVerificationProvider>;
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
    throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-authority-invalid");
  }
  return claim.slice(prefix.length);
}

function timing(value: unknown): number {
  const captured = value ?? DEFAULT_LEASE_TTL_MS;
  if (!Number.isSafeInteger(captured) || Number(captured) <= 0 ||
      Number(captured) > 600_000) {
    throw new TypeError("fixed-price buyer audit timing is invalid");
  }
  return Number(captured);
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
  const raw = Buffer.from(signature.value, "base64url");
  if (raw.byteLength !== 64 || raw.toString("base64url") !== signature.value) return false;
  try {
    return ed25519Verify(
      signedBytes(separator, contentHash(artifact)),
      Uint8Array.from(raw),
      publicKeyFromRaw(key),
    );
  } catch {
    return false;
  }
}

function exactEmptyRequirement(value: unknown): boolean {
  return canonicalize(value) === canonicalize(DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1);
}

function payerAddress(identity: Readonly<{ claims: readonly Readonly<{ ref: string }>[] }>,
  chainId: number): string {
  const expression = new RegExp(`^cci-xm:evm:${chainId}:(0x[0-9a-fA-F]{40})$`);
  const candidates = identity.claims.flatMap(({ ref }) => {
    const matched = expression.exec(ref);
    return matched === null ? [] : [matched[1]!];
  });
  if (candidates.length !== 1) {
    throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-payer-invalid");
  }
  return candidates[0]!;
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
    throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-anchor-unavailable");
  }
  const artifact = await context.demos.adapter.readAnchor(resolved.address);
  const receipt = await context.demos.adapter.resolveDemosAnchorReceipt({
    logicalAddress,
    nativeAddress: resolved.address,
    contentHash: expectedHash,
    writer,
  });
  if (artifact === null || receipt === null) {
    throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-anchor-unavailable");
  }
  if (contentHash(artifact) !== expectedHash ||
      receipt.writer !== writer || receipt.logicalAddress !== logicalAddress ||
      receipt.nativeAddress !== resolved.address || receipt.contentHash !== expectedHash ||
      receipt.state !== "finalized" || receipt.observationDisposition !== "established" ||
      await context.demos.adapter.verifyDemosAnchorReceipt(receipt) !== true) {
    throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-anchor-invalid");
  }
  return Object.freeze({ artifact: copy(artifact), receipt: copy(receipt), writer });
}

async function resolveNativeAnchor(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  logicalAddress: string,
  nativeAddress: string,
  writer: string,
  expectedHash: string,
): Promise<Readonly<AuthenticatedArtifactV1>> {
  const artifact = await context.demos.adapter.readAnchor(nativeAddress);
  const receipt = await context.demos.adapter.resolveDemosAnchorReceipt({
    logicalAddress,
    nativeAddress,
    contentHash: expectedHash,
    writer,
  });
  if (artifact === null || receipt === null) {
    throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-anchor-unavailable");
  }
  if (contentHash(artifact) !== expectedHash ||
      receipt.writer !== writer || receipt.logicalAddress !== logicalAddress ||
      receipt.nativeAddress !== nativeAddress || receipt.contentHash !== expectedHash ||
      receipt.state !== "finalized" || receipt.observationDisposition !== "established" ||
      await context.demos.adapter.verifyDemosAnchorReceipt(receipt) !== true) {
    throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-native-anchor-invalid");
  }
  return Object.freeze({ artifact: copy(artifact), receipt: copy(receipt), writer });
}

function scope(input: Readonly<CompletedSellerBundleCounterSignatureRequest>) {
  const value = input.signedScope;
  if (!plainObject(value) || value.faultBundleVersion !== "1" ||
      value.outcome !== "completed" || value.faultedParty !== "none" ||
      typeof value.jobId !== "string" || !Array.isArray(value.parties) ||
      !Array.isArray(value.phaseSummary) || !Array.isArray(value.vetRecords) ||
      !Array.isArray(value.settlementEvidence) ||
      !Number.isSafeInteger(value.recipeRegistryVersion) ||
      !Number.isSafeInteger(value.railRegistryVersion) ||
      !Number.isSafeInteger(value.finalisedAt)) {
    throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-scope-invalid");
  }
  return copy(value);
}

function dependency(source: Dependency["source"], anchor: AuthenticatedArtifactV1): Dependency {
  return { source: copy(source), anchorReceipt: copy(anchor.receipt) };
}

function agreementSignaturesValid(
  artifact: Readonly<PayeeBoundAgreementDocument>,
  buyer: string,
  seller: string,
): boolean {
  return artifact.signatures.length === 2 &&
    new Set(artifact.signatures.map(({ party }) => party)).size === 2 &&
    artifact.signatures.some(({ party }) => party === buyer) &&
    artifact.signatures.some(({ party }) => party === seller) &&
    artifact.signatures.every((signature) => {
      if (signature.party !== buyer && signature.party !== seller) return false;
      return verifySignature(
        ARTIFACT_SEPARATORS.PayeeBoundAgreementDocument,
        artifact as unknown as Readonly<Record<string, unknown>>,
        {
          algorithm: signature.algorithm,
          signer: signature.party,
          value: signature.value,
        },
        signature.party,
      );
    });
}

function settlementEvent(evidence: Readonly<SettlementEvidence>) {
  const event = evidence.paymentTxRefs?.[0];
  if (evidence.phase !== "pay-x402" || evidence.outcome !== "success" ||
      event?.kind !== "x402-event" || !Number.isSafeInteger(event.chainId) ||
      !Number.isSafeInteger(event.logIndex) ||
      !/^[0-9a-f]{64}$/.test(event.settlementTxHash)) {
    throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-payment-event-invalid");
  }
  return event;
}

function demosSettlementEvent(evidence: Readonly<SettlementEvidence>) {
  const event = evidence.paymentTxRefs?.[0];
  if (evidence.phase !== "pay-dem" || evidence.outcome !== "success" ||
      event?.kind !== "demos" || typeof event.blockNumber !== "number" ||
      !Number.isSafeInteger(event.blockNumber) ||
      event.blockNumber < 0 || !/^[0-9a-f]{64}$/.test(event.txHash)) {
    throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-payment-event-invalid");
  }
  return event;
}

function exactScopeParties(
  value: Readonly<Record<string, unknown>>,
  buyer: string,
  buyerBundleHash: string,
  seller: string,
  sellerBundleHash: string,
): boolean {
  return canonicalize(value.parties) === canonicalize([
    { role: "buyer", bundleHash: buyerBundleHash, primaryClaim: buyer },
    { role: "seller", bundleHash: sellerBundleHash, primaryClaim: seller },
  ]);
}

/** Rail-neutral buyer-owned DACS-5 reconstruction and role publication. */
export function createDacsFixedPriceBuyerAuditV1(
  options: Readonly<DacsFixedPriceBuyerAuditOptionsV1>,
): Readonly<DacsFixedPriceX402BuyerAuditV1> {
  if (!plainObject(options) || !plainObject(options.context) ||
      options.context.role !== "buyer" ||
      getAuthenticatedRailProvenance(options.rail) === null ||
      !Number.isSafeInteger(options.recipeRegistryVersion) ||
      options.recipeRegistryVersion <= 0 ||
      (options.paymentProfile !== "x402" && options.paymentProfile !== "pay-dem") ||
      (options.paymentProfile === "x402" &&
        (options.context.evm?.role !== "buyer" ||
          typeof options.evmRpcUrl !== "string" || options.evmRpcUrl.length === 0 ||
          !Number.isSafeInteger(options.authorizationSearchFromBlock) ||
          options.authorizationSearchFromBlock < 0)) ||
      (options.paymentProfile === "pay-dem" &&
        typeof options.observeDemosTransfer !== "function")) {
    throw new TypeError("fixed-price buyer audit options are invalid");
  }
  const context = options.context;
  const leaseTtlMs = timing(options.leaseTtlMs);
  const rail = options.rail;
  const provenance = getAuthenticatedRailProvenance(rail)!;
  const payDem = options.paymentProfile === "pay-dem";
  if ((payDem && (rail.railType !== "demos-native" ||
      rail.phaseHandler !== "pay-dem" || rail.asset.kind !== "native-dem" ||
      rail.asset.symbol !== "DEM" || rail.asset.decimals !== 9)) ||
      (!payDem && (rail.railType !== "x402" ||
        rail.phaseHandler !== "pay-x402" || rail.asset.kind !== "erc20"))) {
    throw new TypeError(payDem
      ? "fixed-price buyer audit requires native DEM"
      : "fixed-price buyer audit requires x402 ERC-20");
  }
  const observer = options.paymentProfile === "x402"
    ? createDacsX402SellerEvmObserverV1({
        rail,
        rpcUrl: options.evmRpcUrl,
        authorizationSearchFromBlock: options.authorizationSearchFromBlock,
        ...(options.finalityTag === undefined ? {} : { finalityTag: options.finalityTag }),
        ...(options.logPageSize === undefined ? {} : { logPageSize: options.logPageSize }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      })
    : undefined;

  const build = async (
    request: Readonly<CompletedSellerBundleCounterSignatureRequest>,
    order: Readonly<BuyerLiveOrderRecord>,
    retained: Readonly<BuyerRetainedOrder>,
  ): Promise<Readonly<BuyerReviewMaterialV1>> => {
    if (payDem !== isPayDemOrder(order)) {
      throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-profile-invalid");
    }
    const signedScope = scope(request);
    const application = captureDacsFixedPriceX402ApplicationV1(retained.application);
    const session = isPayDemOrder(order)
      ? loadDacsPayDemBuyerSessionAgreementFactsForOrderV1(context, order)
      : loadDacsBuyerSessionAgreementFactsForOrderV1(context, order);
    const agreementPublication = isPayDemOrder(order)
      ? await loadDacsFixedPricePayDemBuyerAgreementPublicationV1(context, order)
      : await loadDacsFixedPriceX402BuyerAgreementPublicationV1(context, order);
    const agreementRaw = agreementPublication.artifact;
    if (!isAgreementArtifact(agreementRaw) ||
        !("payeeBoundAgreementVersion" in agreementRaw) ||
        !exactEmptyRequirement(application.listing.buyerRequirement) ||
        signedScope.jobId !== order.jobId ||
        canonicalize(signedScope.listingRef) !== canonicalize(agreementRaw.listingRef) ||
        signedScope.recipeRegistryVersion !== options.recipeRegistryVersion ||
        signedScope.railRegistryVersion !== provenance.registryVersion ||
        order.protocol.rail.registryIndexHash !== provenance.indexContentHash ||
        order.protocol.rail.railDefinitionHash !== provenance.definitionContentHash ||
        order.protocol.rail.railId !== rail.railId ||
        order.protocol.rail.railVersion !== rail.railVersion ||
        order.protocol.rail.railType !== rail.railType ||
        order.protocol.rail.phaseHandler !== rail.phaseHandler ||
        order.protocol.rail.network !== (rail.asset.kind === "erc20"
          ? `eip155:${rail.asset.chainId}` : "demos") ||
        !exactScopeParties(
          signedScope,
          order.buyer,
          identityBundleHash(session.buyerIdentity),
          order.seller,
          identityBundleHash(session.sellerIdentity),
        )) {
      throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-local-scope-conflict");
    }
    const agreement = agreementRaw as PayeeBoundAgreementDocument;
    const phaseSummary = signedScope.phaseSummary as readonly Readonly<Record<string, unknown>>[];
    if (phaseSummary.length !== application.listing.pipeline.length ||
        phaseSummary.length !== 4 || phaseSummary.some((entry, index) =>
          !plainObject(entry) || entry.index !== index || entry.outcome !== "ok" ||
          entry.kind !== application.listing.pipeline[index]?.kind)) {
      throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-phase-scope-invalid");
    }
    const commitmentRefRaw = phaseSummary[1]?.attestationRef;
    if (!isAttestationRef(commitmentRefRaw) ||
        !plainObject(commitmentRefRaw.anchor) ||
        commitmentRefRaw.anchor.kind !== "storage-program" ||
        typeof commitmentRefRaw.anchor.locator !== "string" ||
        typeof commitmentRefRaw.contentHash !== "string" ||
        commitmentRefRaw.signer !== order.seller) {
      throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-commitment-ref-invalid");
    }
    const commitmentRef = commitmentRefRaw;
    const listingAnchor = await resolveNativeAnchor(
      context,
      application.listingLogicalAddress,
      application.listingRef,
      order.seller,
      application.listingContentHash,
    );
    const agreementAnchor = await resolveActorAnchor(
      context,
      agreementPublication.logicalAddress,
      order.buyer,
      agreementPublication.agreementHash,
    );
    const commitmentAnchor = await resolveActorAnchor(
      context,
      commitmentRef.anchor.locator,
      order.seller,
      commitmentRef.contentHash,
    );
    if (!isListing(listingAnchor.artifact) ||
        canonicalize(listingAnchor.artifact) !== canonicalize(application.listing) ||
        !isAgreementArtifact(agreementAnchor.artifact) ||
        canonicalize(agreementAnchor.artifact) !== canonicalize(agreement) ||
        !isFinalityCommitmentRecord(commitmentAnchor.artifact) ||
        commitmentAnchor.artifact.jobId !== order.jobId ||
        commitmentAnchor.artifact.agreementHash !== agreementPublication.agreementHash ||
        !verifySignature(ARTIFACT_SEPARATORS.Listing, listingAnchor.artifact,
          listingAnchor.artifact.signature, order.seller) ||
        !listingAnchor.artifact.seller.identity.claims.some(({ ref }) =>
          ref === order.seller) ||
        !agreementSignaturesValid(agreement, order.buyer, order.seller) ||
        !verifySignature(FINALITY_COMMITMENT_SEPARATOR, commitmentAnchor.artifact,
          commitmentAnchor.artifact.signature, order.seller)) {
      throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-core-artifact-invalid");
    }
    const listingArtifact = listingAnchor.artifact;
    const commitmentArtifact = commitmentAnchor.artifact;
    const committedAt = commitmentAnchor.receipt.blockRef?.timestamp ??
      commitmentAnchor.receipt.observedAt;
    validateFixedPriceAgreementBinding(copy({
      agreement,
      verifiedListing: {
        disposition: "verified",
        listing: copy(application.listing),
        pin: copy(agreement.listingRef),
      },
      committedAt,
    }));

    const settlementRefs = signedScope.settlementEvidence;
    if (!Array.isArray(settlementRefs) || settlementRefs.length !== 2) {
      throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-evidence-inventory-invalid");
    }
    const paymentLogicalAddress =
      `dacs4:payment:${order.jobId}:${encodeAddressSegment(rail.railId)}:2`;
    const deliveryLogicalAddress = `dacs4:delivery-evidence:${order.jobId}`;
    const evidenceAnchors = await Promise.all(settlementRefs.map(async (candidate) => {
      if (!plainObject(candidate) || !plainObject(candidate.anchor) ||
          candidate.anchor.kind !== "storage-program" ||
          typeof candidate.anchor.locator !== "string" ||
          typeof candidate.contentHash !== "string" || candidate.signer !== order.seller) {
        throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-evidence-ref-invalid");
      }
      const writer = candidate.anchor.locator === paymentLogicalAddress
        ? order.buyer : candidate.anchor.locator === deliveryLogicalAddress
          ? order.seller : undefined;
      if (writer === undefined) {
        throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-evidence-address-invalid");
      }
      return resolveActorAnchor(
        context,
        candidate.anchor.locator,
        writer,
        candidate.contentHash,
      );
    }));
    const paymentAnchor = evidenceAnchors.find(({ artifact }) =>
      isSettlementEvidence(artifact) && artifact.phase === rail.phaseHandler);
    const deliveryAnchor = evidenceAnchors.find(({ artifact }) =>
      isSettlementEvidence(artifact) && artifact.phase === "deliver-storage-program");
    if (paymentAnchor === undefined || deliveryAnchor === undefined ||
        !isSettlementEvidence(paymentAnchor.artifact) ||
        !isSettlementEvidence(deliveryAnchor.artifact) ||
        paymentAnchor.artifact.outcome !== "success" ||
        deliveryAnchor.artifact.phase !== "deliver-storage-program" ||
        deliveryAnchor.artifact.outcome !== "success" ||
        (payDem
          ? paymentAnchor.artifact.settlementFinality?.model !== "bft-final"
          : paymentAnchor.artifact.settlementFinality?.model !== "block-depth" ||
            !Number.isSafeInteger(
              paymentAnchor.artifact.settlementFinality.finalityBlocks,
            ) ||
            Number(paymentAnchor.artifact.settlementFinality.finalityBlocks) <= 0) ||
        !verifySignature(ARTIFACT_SEPARATORS.SettlementEvidence,
          paymentAnchor.artifact, paymentAnchor.artifact.signature, order.seller) ||
        !verifySignature(ARTIFACT_SEPARATORS.SettlementEvidence,
          deliveryAnchor.artifact, deliveryAnchor.artifact.signature, order.seller)) {
      throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-evidence-invalid");
    }
    const paymentEvidence = paymentAnchor.artifact;
    const deliveryEvidence = deliveryAnchor.artifact as
      Readonly<Record<string, unknown>> & SettlementEvidence & {
      phase: "deliver-storage-program";
      outcome: "success";
      deliverableContentHash: string;
      deliverableAnchor: { kind: string; locator: string };
    };
    const capturedPaymentFinality = paymentEvidence.settlementFinality;
    if (capturedPaymentFinality === undefined) {
      throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-finality-invalid");
    }

    const buyerVetAnchor = await resolveNativeAnchor(
      context,
      session.buyerVetReceipt.logicalAddress,
      session.buyerVetReceipt.nativeAddress,
      order.seller,
      session.buyerVetRef.contentHash,
    );
    const sellerVetAnchor = await resolveNativeAnchor(
      context,
      session.sellerVetReceipt.logicalAddress,
      session.sellerVetReceipt.nativeAddress,
      order.buyer,
      session.sellerVetRef.contentHash,
    );
    if (!isCompositeVerificationRecord(buyerVetAnchor.artifact) ||
        !isCompositeVerificationRecord(sellerVetAnchor.artifact) ||
        canonicalize(buyerVetAnchor.artifact) !== canonicalize(session.buyerVetRecord) ||
        canonicalize(sellerVetAnchor.artifact) !== canonicalize(session.sellerVetRecord) ||
        !verifySignature(ARTIFACT_SEPARATORS.CompositeVerificationRecord,
          buyerVetAnchor.artifact, buyerVetAnchor.artifact.signature, order.seller) ||
        !verifySignature(ARTIFACT_SEPARATORS.CompositeVerificationRecord,
          sellerVetAnchor.artifact, sellerVetAnchor.artifact.signature, order.buyer)) {
      throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-vet-invalid");
    }
    const deliverableAnchor = await resolveActorAnchor(
      context,
      deliveryEvidence.deliverableAnchor.locator,
      order.seller,
      deliveryEvidence.deliverableContentHash,
    );

    const agreementRef = {
      anchor: { kind: "storage-program" as const,
        locator: agreementPublication.logicalAddress },
      contentHash: agreementPublication.agreementHash,
      signer: order.buyer,
    };
    const commitmentAttestationRef = {
      anchor: { kind: "storage-program" as const,
        locator: commitmentRef.anchor.locator },
      contentHash: commitmentRef.contentHash,
      signer: order.seller,
    };
    const paymentRef = settlementRefs.find((ref) => isAttestationRef(ref) &&
      plainObject(ref.anchor) && ref.anchor.locator === paymentAnchor.receipt.logicalAddress)!;
    const deliveryRef = settlementRefs.find((ref) => isAttestationRef(ref) &&
      plainObject(ref.anchor) && ref.anchor.locator === deliveryAnchor.receipt.logicalAddress)!;
    if (!isAttestationRef(paymentRef) || !isAttestationRef(deliveryRef) ||
        application.listing.offering.deliverable.kind !== "storage-program" ||
        application.listing.offering.deliverable.accessModel !== "public" ||
        deliveryEvidence.deliverableAnchor.kind !== "storage-program" ||
        deliveryEvidence.deliverableAnchor.locator !==
          `dacs4:deliverable:${order.jobId}`) {
      throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-delivery-binding-invalid");
    }
    const buyerParty = agreement.parties.find(({ role }) => role === "buyer")!;
    const sellerParty = agreement.parties.find(({ role }) => role === "seller")!;
    const fulfilmentAgreement: SellerFulfilmentAgreement = {
      artifactKind: "payee-bound" as const,
      ref: agreementPublication.logicalAddress,
      contentHash: agreementPublication.agreementHash,
      jobId: order.jobId,
      listingPin: copy(agreement.listingRef),
      buyer: {
        primaryClaim: order.buyer,
        bundleHash: buyerParty.bundleHash,
        vetRecordRef: copy(buyerParty.vetRecordRef),
      },
      seller: {
        primaryClaim: order.seller,
        bundleHash: sellerParty.bundleHash,
        vetRecordRef: copy(sellerParty.vetRecordRef),
      },
      deliverableRef: {
        deliverableType: application.listing.offering.deliverable.kind,
        hash: agreement.terms.deliverable.hash,
        ...(agreement.terms.deliverable.schemaUrl === undefined
          ? {} : { schemaUrl: agreement.terms.deliverable.schemaUrl }),
      },
      commitment: {
        status: "finalized" as const,
        ref: commitmentRef.anchor.locator,
        agreementHash: agreementPublication.agreementHash,
        recordContentHash: commitmentRef.contentHash,
        finalizedAt: committedAt,
        signer: order.seller,
      },
    };
    const payout = agreement.terms.payoutBindings.find((binding) =>
      binding.railId === rail.railId && binding.phaseIndex === 2);
    if (payout === undefined || paymentEvidence.paymentAmount === undefined ||
        paymentEvidence.paymentAmount.amount !== agreement.terms.price.amount ||
        paymentEvidence.paymentAmount.currency !== agreement.terms.price.currency) {
      throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-payment-terms-invalid");
    }
    const evidenceHash = contentHash(paymentEvidence);
    const commonAuthorization = {
      jobId: order.jobId,
      phaseIndex: 2,
      agreementHash: agreementPublication.agreementHash,
      listingRef: copy(agreement.listingRef),
      railId: rail.railId,
      railRegistryVersion: provenance.registryVersion,
      commitment: {
        ref: commitmentRef.anchor.locator,
        contentHash: commitmentRef.contentHash,
        finalizedAt: committedAt,
        signer: order.seller,
      },
      evidenceHash,
      payoutBindingTier: 1 as const,
      sessionBinding: "established" as const,
    };
    const paymentAudit = await (async () => {
      if (options.paymentProfile === "pay-dem") {
        if (capturedPaymentFinality.model !== "bft-final") {
          throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-finality-invalid");
        }
        const event = demosSettlementEvent(paymentEvidence);
        const observation = await options.observeDemosTransfer(event.txHash);
        const buyerKey = canonicalDemosAgentPublicKey(order.buyer);
        const sellerKey = canonicalDemosAgentPublicKey(order.seller);
        const buyerPayingKey = buyerKey === null
          ? undefined : Buffer.from(buyerKey).toString("hex");
        const sellerReceivingKey = sellerKey === null
          ? undefined : Buffer.from(sellerKey).toString("hex");
        const expectedAmountOs = baseUnits(agreement.terms.price.amount, 9);
        if (observation.status !== "included" || buyerPayingKey === undefined ||
            sellerReceivingKey === undefined || observation.txHash !== event.txHash ||
            observation.blockNumber !== event.blockNumber ||
            observation.includedAt !== paymentEvidence.observedAt ||
            observation.includedAt !== capturedPaymentFinality.finalityObservedAt ||
            observation.includedAt < committedAt ||
            observation.includedAt > agreement.terms.deadline ||
            observation.payer !== buyerPayingKey ||
            observation.payee !== sellerReceivingKey ||
            observation.amountOs !== expectedAmountOs) {
          throw new DacsFixedPriceX402BuyerAuditError(
            "buyer-audit-native-finality-invalid",
          );
        }
        if (payout.payeeAddress !== sellerReceivingKey) {
          throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-payment-terms-invalid");
        }
        const settlementId = canonicalSellerSettlementId({
          kind: "demos",
          txHash: event.txHash,
        });
        if (settlementId === null) {
          throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-settlement-id-invalid");
        }
        const paymentFinality = {
          model: "bft-final" as const,
          finalityObservedAt: capturedPaymentFinality.finalityObservedAt,
        };
        const authorization: SellerPaymentAuthorization = {
          ...commonAuthorization,
          settlementIdentity: {
            kind: "demos",
            txHash: event.txHash,
            blockNumber: event.blockNumber,
            includedAt: observation.includedAt,
          },
          settlementId,
          evidenceInput: {
            evidenceVersion: "1",
            jobId: order.jobId,
            phase: "pay-dem",
            outcome: "success",
            paymentTxRefs: [copy(event)],
            paymentAmount: copy(paymentEvidence.paymentAmount),
            settlementFinality: paymentFinality,
            observedAt: paymentEvidence.observedAt,
          },
        };
        const proofArtifact = {
          proofVersion: "dacs-pay-dem-buyer-transfer-v1",
          event: copy(event),
          payer: observation.payer,
          payee: observation.payee,
          amountOs: observation.amountOs,
        };
        const proofRef: SessionSettlementNativeProofRef = {
          proofVersion: "1",
          kind: "authenticated-demos-transfer",
          locator: event.txHash,
          contentHash: sha256Hex(canonicalize(proofArtifact)),
          encoding: "jcs",
        };
        const settlementContext: SessionSettlementContext = {
          contextVersion: "1",
          jobId: order.jobId,
          agreementRef,
          agreementHash: agreementPublication.agreementHash,
          paymentPhaseIndex: 2,
          orchestrator: order.seller,
          payer: { primaryClaim: order.buyer, payingKey: buyerPayingKey },
          payee: { primaryClaim: order.seller, receivingKey: sellerReceivingKey },
          paymentAmount: copy(paymentEvidence.paymentAmount),
          rail: {
            railId: rail.railId,
            railVersion: rail.railVersion,
            railRegistryVersion: provenance.registryVersion,
            descriptorHash: provenance.definitionContentHash,
            railType: rail.railType,
            handler: "pay-dem",
            asset: "DEM",
            network: "demos",
            finality: { model: "bft-final" },
          },
        };
        const revalidateSettlement: SessionSettlementVerificationProvider[
          "revalidateSettlement"
        ] = async () => {
          const fresh = await options.observeDemosTransfer(event.txHash);
          if (fresh.status !== "included") {
            return fresh.status === "failed" || fresh.status === "invalid"
              ? { disposition: "fail" as const,
                  reason: "buyer-audit-native-settlement-failed" }
              : { disposition: "indeterminate" as const,
                  reason: "buyer-audit-native-revalidation-unavailable" };
          }
          if (fresh.txHash !== event.txHash || fresh.blockNumber !== event.blockNumber ||
              fresh.includedAt !== paymentEvidence.observedAt ||
              fresh.includedAt < committedAt ||
              fresh.includedAt > agreement.terms.deadline ||
              fresh.payer !== buyerPayingKey || fresh.payee !== sellerReceivingKey ||
              fresh.amountOs !== expectedAmountOs) {
            return { disposition: "fail" as const,
              reason: "buyer-audit-native-settlement-conflict" };
          }
          return {
            disposition: "pass" as const,
            outcome: "success" as const,
            binding: { jobId: order.jobId, railId: rail.railId,
              phaseIndex: 2, settlementId },
            nativeObservation: {
              observationVersion: "1" as const,
              kind: "authenticated-demos-transfer",
              observedAt: fresh.includedAt,
              finality: copy(paymentFinality),
              sessionBinding: {
                disposition: "established" as const,
                kind: "pay-dem-transfer",
                bindingHash: sha256Hex(canonicalize({
                  jobId: order.jobId,
                  phaseIndex: 2,
                  txHash: fresh.txHash,
                })),
              },
              details: { transactionHash: fresh.txHash,
                blockNumber: fresh.blockNumber, payer: fresh.payer,
                payee: fresh.payee, amountOs: fresh.amountOs },
            },
          };
        };
        return { authorization, settlementId, proofArtifact, proofRef,
          settlementContext, revalidateSettlement };
      }

      const asset = rail.asset;
      const evm = context.evm;
      if (asset.kind !== "erc20" || evm?.role !== "buyer" || observer === undefined ||
          capturedPaymentFinality.model !== "block-depth" ||
          !Number.isSafeInteger(capturedPaymentFinality.finalityBlocks) ||
          Number(capturedPaymentFinality.finalityBlocks) <= 0) {
        throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-finality-invalid");
      }
      const paymentFinality = {
        model: "block-depth" as const,
        finalityBlocks: Number(capturedPaymentFinality.finalityBlocks),
        finalityObservedAt: capturedPaymentFinality.finalityObservedAt,
      };
      const event = settlementEvent(paymentEvidence);
      const expectedAmountBaseUnits = baseUnits(
        agreement.terms.price.amount,
        asset.decimals,
      );
      const observation = await observer.observeX402Transfer({
        chainId: event.chainId,
        txHash: `0x${event.settlementTxHash}`,
      });
      if (observation.status !== "finalized" || observation.chainId !== event.chainId ||
          observation.txHash.toLowerCase() !== `0x${event.settlementTxHash}` ||
          observation.logIndex !== event.logIndex ||
          observation.includedAt > paymentEvidence.observedAt ||
          observation.includedAt < committedAt ||
          observation.includedAt > agreement.terms.deadline ||
          observation.payer.toLowerCase() !== evm.address.toLowerCase() ||
          observation.asset.contract.toLowerCase() !== asset.contract.toLowerCase() ||
          observation.amountBaseUnits !== expectedAmountBaseUnits ||
          observation.sessionBinding.kind !== "eip3009" ||
          observation.sessionBinding.nonce !== x402Eip3009Nonce(order.jobId, 2) ||
          observation.confirmations < paymentFinality.finalityBlocks ||
          observation.finalityObservedAt < paymentFinality.finalityObservedAt) {
        throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-native-finality-invalid");
      }
      if (payout.payeeAddress.toLowerCase() !== observation.payee.toLowerCase()) {
        throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-payment-terms-invalid");
      }
      const settlementId = canonicalSellerSettlementId({
        kind: "evm",
        chainId: event.chainId,
        txHash: event.settlementTxHash,
        logIndex: event.logIndex,
      });
      if (settlementId === null) {
        throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-settlement-id-invalid");
      }
      const authorization: SellerPaymentAuthorization = {
        ...commonAuthorization,
        settlementIdentity: {
          kind: "evm",
          chainId: event.chainId,
          txHash: event.settlementTxHash,
          logIndex: event.logIndex,
          includedAt: observation.includedAt,
        },
        settlementId,
        evidenceInput: {
          evidenceVersion: "1",
          jobId: order.jobId,
          phase: "pay-x402",
          outcome: "success",
          paymentTxRefs: [copy(event)],
          paymentAmount: copy(paymentEvidence.paymentAmount),
          settlementFinality: copy(paymentFinality),
          observedAt: paymentEvidence.observedAt,
        },
      };
      const proofArtifact = {
        proofVersion: "dacs-x402-buyer-event-v1",
        event: copy(event),
      };
      const proofRef: SessionSettlementNativeProofRef = {
        proofVersion: "1",
        kind: "authenticated-x402-event",
        locator: `eip155:${event.chainId}:${event.settlementTxHash.toLowerCase()}:` +
          `${event.logIndex}`,
        contentHash: sha256Hex(canonicalize(proofArtifact)),
        encoding: "jcs",
      };
      const settlementContext: SessionSettlementContext = {
        contextVersion: "1",
        jobId: order.jobId,
        agreementRef,
        agreementHash: agreementPublication.agreementHash,
        paymentPhaseIndex: 2,
        orchestrator: order.seller,
        payer: { primaryClaim: order.buyer,
          payingKey: payerAddress(session.buyerIdentity, asset.chainId) },
        payee: { primaryClaim: order.seller, receivingKey: payout.payeeAddress },
        paymentAmount: copy(paymentEvidence.paymentAmount),
        rail: {
          railId: rail.railId,
          railVersion: rail.railVersion,
          railRegistryVersion: provenance.registryVersion,
          descriptorHash: provenance.definitionContentHash,
          railType: rail.railType,
          handler: "pay-x402",
          asset: asset.symbol,
          network: `eip155:${asset.chainId}`,
          finality: { model: "block-depth",
            finalityBlocks: paymentFinality.finalityBlocks },
        },
      };
      const revalidateSettlement: SessionSettlementVerificationProvider[
        "revalidateSettlement"
      ] = async () => {
        const fresh = await observer.observeX402Transfer({
          chainId: event.chainId,
          txHash: `0x${event.settlementTxHash}`,
        });
        if (fresh.status !== "finalized") {
          return fresh.status === "failed"
            ? { disposition: "fail" as const,
                reason: "buyer-audit-native-settlement-failed" }
            : { disposition: "indeterminate" as const,
                reason: "buyer-audit-native-revalidation-unavailable" };
        }
        if (fresh.chainId !== event.chainId ||
            fresh.txHash.toLowerCase() !== `0x${event.settlementTxHash}` ||
            fresh.logIndex !== event.logIndex ||
            fresh.includedAt > paymentEvidence.observedAt ||
            fresh.includedAt < committedAt ||
            fresh.includedAt > agreement.terms.deadline ||
            fresh.payer.toLowerCase() !== settlementContext.payer.payingKey.toLowerCase() ||
            fresh.payee.toLowerCase() !== settlementContext.payee.receivingKey.toLowerCase() ||
            fresh.amountBaseUnits !== expectedAmountBaseUnits ||
            fresh.asset.contract.toLowerCase() !== asset.contract.toLowerCase() ||
            fresh.confirmations < paymentFinality.finalityBlocks ||
            fresh.finalityObservedAt < paymentFinality.finalityObservedAt ||
            fresh.sessionBinding.kind !== "eip3009" ||
            fresh.sessionBinding.nonce !== x402Eip3009Nonce(order.jobId, 2)) {
          return { disposition: "fail" as const,
            reason: "buyer-audit-native-settlement-conflict" };
        }
        return {
          disposition: "pass" as const,
          outcome: "success" as const,
          binding: { jobId: order.jobId, railId: rail.railId,
            phaseIndex: 2, settlementId },
          nativeObservation: {
            observationVersion: "1" as const,
            kind: "authenticated-x402-event",
            observedAt: fresh.finalityObservedAt,
            finality: copy(paymentFinality),
            sessionBinding: {
              disposition: "established" as const,
              kind: "eip3009",
              bindingHash: sha256Hex(canonicalize({
                jobId: order.jobId,
                phaseIndex: 2,
                nonce: fresh.sessionBinding.nonce,
              })),
            },
            details: { chainId: fresh.chainId,
              transactionHash: fresh.txHash, logIndex: fresh.logIndex },
          },
        };
      };
      return { authorization, settlementId, proofArtifact, proofRef,
        settlementContext, revalidateSettlement };
    })();
    const { authorization, settlementId } = paymentAudit;
    if (sha256Hex(canonicalize(authorization.evidenceInput)) !==
        authorization.evidenceHash) {
      throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-authorization-invalid");
    }
    const fulfilmentId = sellerFulfilmentId({
      jobId: order.jobId,
      paymentPhaseIndex: 2,
      deliveryPhaseIndex: 3,
      settlementId,
      agreementHash: agreementPublication.agreementHash,
      paymentEvidenceHash: authorization.evidenceHash,
    });
    const phaseResults: CompletedSellerPhaseEntry[] =
      application.listing.pipeline.map((step, index) => {
      const summary = phaseSummary[index]!;
      const contextDelta = index === 0 ? {
        "negotiate-fixed-price": {
          agreementHash: agreementPublication.agreementHash,
          agreementRef,
        },
      } : {};
      const invokedAt = index === 0 ? agreement.generatedAt
        : index === 1 ? committedAt
          : index === 2 ? paymentEvidence.observedAt : deliveryEvidence.observedAt;
      return {
        index,
        step: copy(step),
        invokedAt,
        result: {
          ok: true as const,
          ...(Array.isArray(summary.txRefs) ? { txRefs: copy(summary.txRefs) } : {}),
          ...(isAttestationRef(summary.attestationRef)
            ? { attestationRef: copy(summary.attestationRef) } : {}),
          ...(index === 1 ? { anchorReceipt: copy(commitmentAnchor.receipt) }
            : index === 3 ? { anchorReceipt: copy(deliveryAnchor.receipt) } : {}),
          contextDelta: copy(contextDelta),
        },
        contextDelta: copy(contextDelta),
      };
    });
    const auditSession: AuditPendingSellerSessionRecord = {
      recordVersion: "1" as const,
      jobId: order.jobId,
      state: "audit-pending" as const,
      listingRef: copy(agreement.listingRef),
      parties: [
        { role: "buyer" as const, bundleHash: buyerParty.bundleHash,
          primaryClaim: order.buyer, vetRecordRef: copy(session.buyerVetRef) },
        { role: "seller" as const, bundleHash: sellerParty.bundleHash,
          primaryClaim: order.seller, vetRecordRef: copy(session.sellerVetRef) },
        { role: "orchestrator" as const, bundleHash: sellerParty.bundleHash,
          primaryClaim: order.seller },
      ],
      pipeline: copy(application.listing.pipeline),
      phaseResults,
      startedAt: agreement.generatedAt,
      lastUpdatedAt: deliveryEvidence.observedAt,
      recipeRegistryVersion: options.recipeRegistryVersion,
      railRegistryVersion: provenance.registryVersion,
    };
    const sessionArtifacts = {
      agreementCommitment: commitmentAttestationRef,
      vetRecords: [copy(session.buyerVetRef), copy(session.sellerVetRef)],
      vetRequirements: [
        { vetRecordRef: copy(session.buyerVetRef), evaluatedParty: order.buyer,
          requirement: copy(DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1),
          verifier: order.seller, freshness: [], dealSpecific: [] },
        { vetRecordRef: copy(session.sellerVetRef), evaluatedParty: order.seller,
          requirement: copy(DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1),
          verifier: order.buyer, freshness: [], dealSpecific: [] },
      ],
      settlementEvidence: [copy(paymentRef), copy(deliveryRef)],
    };
    const fulfilment = {
      decision: "completed" as const,
      fulfilmentId,
      evidence: copy(deliveryEvidence),
      evidenceHash: contentHash(deliveryEvidence),
      evidenceRef: copy(deliveryRef),
      evidenceAnchorReceipt: copy(deliveryAnchor.receipt),
      bundleContribution: {
        phaseSummary: {
          index: 3,
          kind: "deliver-storage-program" as const,
          outcome: "ok" as const,
          attestationRef: copy(deliveryRef),
        },
        settlementEvidence: copy(deliveryRef),
      },
      consumedPaymentAuthorization: authorization,
    };

    const authenticated = [listingAnchor, agreementAnchor, commitmentAnchor,
      paymentAnchor, deliveryAnchor, buyerVetAnchor, sellerVetAnchor,
      deliverableAnchor] as const;
    const byNative = new Map(authenticated.map((entry) =>
      [entry.receipt.nativeAddress, entry] as const));
    if (byNative.size !== authenticated.length) {
      throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-dependency-alias");
    }
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
      verify: (input: Readonly<{ signedBytes: Uint8Array;
        signature: Readonly<ComponentSignature>; publicKey: Uint8Array }>) => {
        try {
          return ed25519Verify(input.signedBytes,
            Uint8Array.from(Buffer.from(input.signature.value, "base64url")),
            publicKeyFromRaw(input.publicKey));
        } catch {
          return false;
        }
      },
      verifyAuthorityAttestation: () => "unresolved" as const,
    });
    const verifyKnown = (known: Readonly<AuthenticatedArtifactV1>): boolean => {
      if (known === listingAnchor) return verifySignature(
        ARTIFACT_SEPARATORS.Listing, listingArtifact,
        listingArtifact.signature, order.seller);
      if (known === agreementAnchor) return agreementSignaturesValid(
        agreement, order.buyer, order.seller);
      if (known === commitmentAnchor) return verifySignature(
        FINALITY_COMMITMENT_SEPARATOR, commitmentArtifact,
        commitmentArtifact.signature, order.seller);
      if (known === paymentAnchor || known === deliveryAnchor) {
        const evidence = known === paymentAnchor ? paymentEvidence : deliveryEvidence;
        return verifySignature(ARTIFACT_SEPARATORS.SettlementEvidence,
          evidence, evidence.signature, order.seller);
      }
      if (known === buyerVetAnchor || known === sellerVetAnchor) {
        const vet = known === buyerVetAnchor
          ? session.buyerVetRecord : session.sellerVetRecord;
        return verifySignature(ARTIFACT_SEPARATORS.CompositeVerificationRecord,
          vet, vet.signature, known === buyerVetAnchor ? order.seller : order.buyer);
      }
      return known === deliverableAnchor &&
        contentHash(known.artifact) === deliveryEvidence.deliverableContentHash;
    };
    const dependencies: Dependency[] = [
      dependency({ kind: "listing", listingRef: copy(agreement.listingRef) }, listingAnchor),
      dependency({ kind: "attestation-ref", ref: agreementRef }, agreementAnchor),
      dependency({ kind: "attestation-ref", ref: commitmentAttestationRef },
        commitmentAnchor),
      dependency({ kind: "attestation-ref", ref: copy(paymentRef) }, paymentAnchor),
      dependency({ kind: "attestation-ref", ref: copy(deliveryRef) }, deliveryAnchor),
      dependency({ kind: "attestation-ref", ref: copy(session.buyerVetRef) }, buyerVetAnchor),
      dependency({ kind: "attestation-ref", ref: copy(session.sellerVetRef) }, sellerVetAnchor),
      dependency({ kind: "deliverable", anchor: copy(deliveryEvidence.deliverableAnchor),
        contentHash: deliveryEvidence.deliverableContentHash, encoding: "jcs" },
      deliverableAnchor),
    ];
    const commonProvider = {
      mapping: publication.mapping,
      bundleCopyVerifier: publication.bundleCopyVerifier,
      compositeVerificationDeps,
      async resolveDependency(candidate: Dependency) {
        const known = byNative.get(candidate.anchorReceipt.nativeAddress);
        if (known === undefined) return { disposition: "absent" as const };
        const artifact = await context.demos.adapter.readAnchor(
          candidate.anchorReceipt.nativeAddress,
        );
        return artifact === null ? { disposition: "absent" as const }
          : { disposition: "present" as const, artifact: copy(artifact) };
      },
      async verifyDependencyReceipt(candidate: Dependency) {
        const known = byNative.get(candidate.anchorReceipt.nativeAddress);
        if (known === undefined || canonicalize(known.receipt) !==
            canonicalize(candidate.anchorReceipt)) return "invalid" as const;
        try {
          return await context.demos.adapter.verifyDemosAnchorReceipt(
            candidate.anchorReceipt,
          ) === true ? "valid" as const : "invalid" as const;
        } catch {
          return "error" as const;
        }
      },
      verifyDependencyBinding({ dependency: candidate, requirement, artifact }:
        { dependency: Dependency; requirement: { contentHash: string }; artifact: unknown }) {
        const known = byNative.get(candidate.anchorReceipt.nativeAddress);
        return known !== undefined && plainObject(artifact) &&
            requirement.contentHash === contentHash(artifact) &&
            canonicalize(artifact) === canonicalize(known.artifact) && verifyKnown(known)
          ? "valid" as const : "invalid" as const;
      },
      verifyListingPublisherIdentityLinkage(input: Readonly<{
        listingIdentity: typeof application.listing.seller.identity;
        listingBundleHash: string; sessionBundleHash: string; primaryClaim: string;
      }>) {
        return input.primaryClaim === order.seller &&
            input.listingIdentity.presentedBy === order.seller &&
            input.listingBundleHash === identityBundleHash(application.listing.seller.identity) &&
            input.sessionBundleHash === identityBundleHash(session.sellerIdentity)
          ? "valid" as const : "invalid" as const;
      },
      verifyVetRequirementProvenance(input: Readonly<{
        invocation: { evaluatedParty: string; verifier: string; requirement: unknown };
        compositeRecord: unknown; listingOwned: boolean;
      }>) {
        const expected = input.listingOwned ? session.buyerVetRecord : session.sellerVetRecord;
        return input.invocation.evaluatedParty ===
              (input.listingOwned ? order.buyer : order.seller) &&
            input.invocation.verifier === (input.listingOwned ? order.seller : order.buyer) &&
            exactEmptyRequirement(input.invocation.requirement) &&
            canonicalize(input.compositeRecord) === canonicalize(expected)
          ? "valid" as const : "invalid" as const;
      },
      resolvePaymentPhaseIndex({ dependency: candidate, evidence }:
        { dependency: Dependency; evidence: Readonly<Record<string, unknown>> }) {
        return candidate.anchorReceipt.nativeAddress === paymentAnchor.receipt.nativeAddress &&
            canonicalize(evidence) === canonicalize(paymentEvidence)
          ? { disposition: "valid" as const, jobId: order.jobId,
              railId: rail.railId, phaseIndex: 2, resolved: false }
          : { disposition: "invalid" as const,
              reason: "buyer-audit-payment-binding-invalid" };
      },
      async resolveSellerBundle(logicalAddress: string) {
        if (logicalAddress !== bundleAddress(order.jobId, "seller")) {
          return { disposition: "absent" as const };
        }
        const anchored = await publication.resolveRoleBundle("seller");
        return anchored === null ? { disposition: "absent" as const }
          : { disposition: "present" as const, anchored };
      },
      verifyBundleAnchorReceipt: async (anchored) => {
        if (!isFaultAttestationBundle(anchored.bundle)) return "invalid" as const;
        return publication.verifyBundleAnchorReceipt({
          ...anchored,
          bundle: anchored.bundle,
        });
      },
      resolveBundleBinding: publication.resolveBundleBinding,
      verifyBundleBinding: publication.verifyBundleBinding,
    } satisfies SellerBundleFinalizationReadProvider;

    if (Number(signedScope.finalisedAt) < deliveryEvidence.observedAt) {
      throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-finalization-time-invalid");
    }
    const input: VerifyCompletedSellerBundleCounterSignatureRequestInput = {
      agreement: fulfilmentAgreement,
      agreementRef,
      fulfilment,
      session: auditSession,
      sessionArtifacts,
      finalisedAt: Number(signedScope.finalisedAt),
      seller: { primaryClaim: order.seller, bundleHash: sellerParty.bundleHash },
      dependencies,
    };

    const { proofArtifact, proofRef, settlementContext,
      revalidateSettlement } = paymentAudit;
    const settlement: FinalizedSessionSettlement = {
      settlementVersion: "1",
      outcome: "success",
      evidence: copy(paymentEvidence),
      evidenceRef: copy(paymentRef),
      anchorReceipt: copy(paymentAnchor.receipt),
      nativeProofRef: proofRef,
    };
    const evidenceVerifier = Object.freeze({
      async resolvePublicKey(signer: string) {
        return signer === order.seller ? publicKey(signer) : null;
      },
      verify(bytes: Uint8Array, signature: Uint8Array, key: Uint8Array) {
        try {
          return ed25519Verify(bytes, signature, publicKeyFromRaw(key));
        } catch {
          return false;
        }
      },
    });
    const settlementVerification: SessionSettlementVerificationProvider = {
      authenticateContext: (candidate) =>
        canonicalize(candidate) === canonicalize(settlementContext) &&
          canonicalize(agreementAnchor.artifact) === canonicalize(agreement) &&
          agreementSignaturesValid(agreement, order.buyer, order.seller)
          ? { disposition: "pass" as const }
          : { disposition: "fail" as const, reason: "buyer-audit-context-invalid" },
      verifyEvidenceAnchor: ({ evidence, evidenceRef, anchorReceipt }) =>
        canonicalize(evidence) === canonicalize(paymentEvidence) &&
          canonicalize(evidenceRef) === canonicalize(paymentRef) &&
          canonicalize(anchorReceipt) === canonicalize(paymentAnchor.receipt)
          ? { disposition: "pass" as const }
          : { disposition: "fail" as const,
              reason: "buyer-audit-evidence-anchor-invalid" },
      resolveNativeProof: (candidate) => canonicalize(candidate) === canonicalize(proofRef)
        ? { disposition: "present" as const, artifact: copy(proofArtifact) }
        : { disposition: "absent" as const },
      revalidateSettlement,
      evidence: evidenceVerifier,
    };
    return Object.freeze({ input, provider: commonProvider, publication,
      settlementContext, settlement, settlementVerification });
  };

  const resolveForOrder = async (
    request: Readonly<CompletedSellerBundleCounterSignatureRequest>,
    jobId: string,
  ) => {
    const loaded = payDem
      ? await context.database.createPayDemCoordinatorStore("buyer").load("buyer", jobId)
      : await context.database.createLiveCoordinatorStore("buyer").load("buyer", jobId);
    if (loaded.status !== "ok") {
      throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-order-unavailable");
    }
    const record = loaded.record as BuyerLiveOrderRecord;
    if (payDem !== isPayDemOrder(record)) {
      throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-profile-invalid");
    }
    const retained = isPayDemOrder(record)
      ? loadDacsLiveOrderInputV1({
          database: context.database,
          order: createDacsFixedPricePayDemRoleOrderV1({
            role: "buyer",
            jobId: record.jobId,
            buyer: record.buyer,
            seller: record.seller,
            protocol: record.protocol,
          }),
        })
      : loadDacsLiveOrderInputV1({
          database: context.database,
          order: createDacsFixedPriceX402RoleOrderV1({
            role: "buyer",
            jobId: record.jobId,
            buyer: record.buyer,
            seller: record.seller,
            protocol: record.protocol,
          }),
        });
    if (retained === undefined || retained.localBindingHash !==
        record.localBindingHash) {
      throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-input-unavailable");
    }
    return build(request, record, retained);
  };

  const bundleTransport: BuyerBundleTransportOptions = {
    async resolveVerification({ authenticated, request }) {
      if (authenticated.envelope.sender !== context.peerAuthority ||
          authenticated.envelope.audience !== context.authority) {
        throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-envelope-invalid");
      }
      const material = await resolveForOrder(request, authenticated.envelope.jobId);
      const verification: DacsBuyerBundleRequestVerificationV1 = {
        input: material.input,
        provider: material.provider,
      };
      return verification;
    },
    async resolveSellerFinalization(input) {
      try {
        const loaded = payDem
          ? await context.database.createPayDemCoordinatorStore("buyer")
              .load("buyer", input.identity.jobId)
          : await context.database.createLiveCoordinatorStore("buyer")
              .load("buyer", input.identity.jobId);
        if (loaded.status !== "ok" || input.identity.buyer !== loaded.record.buyer ||
            input.identity.seller !== loaded.record.seller) {
          return { disposition: "rejected" as const,
            reason: "seller-finalization-identity-invalid" };
        }
        const publication = createDacsDemosBundlePublicationV1({
          context,
          jobId: loaded.record.jobId,
          buyer: loaded.record.buyer,
          seller: loaded.record.seller,
        });
        const anchored = await publication.resolveRoleBundle("seller");
        if (anchored === null) return { disposition: "absent" as const,
          reason: "seller-finalization-pending" };
        const binding = await publication.resolveBundleBinding(
          bundleAddress(loaded.record.jobId, "seller"),
          loaded.record.seller,
        );
        if (binding.disposition !== "present") {
          return binding.disposition === "absent"
            ? { disposition: "absent" as const, reason: "seller-binding-pending" }
            : { disposition: "indeterminate" as const, reason: binding.reason };
        }
        const sellerBundle = copy(anchored.bundle);
        const buyerBundle = copy({ ...sellerBundle, anchoredByRole: "buyer" as const });
        const result: FinalizedSellerBundle = {
          state: "finalised",
          logicalAddress: bundleAddress(loaded.record.jobId, "seller"),
          nativeAddress: anchored.nativeAddress,
          bundleContentHash: anchored.anchorReceipt.contentHash,
          sellerBundle,
          buyerBundle,
          anchorReceipt: copy(anchored.anchorReceipt),
          ...(anchored.anchorTx === undefined ? {} : { anchorTx: anchored.anchorTx }),
          binding: copy(binding.binding),
          resumedBundle: true,
          resumedBinding: true,
        };
        return { disposition: "present" as const, value: result };
      } catch {
        return { disposition: "indeterminate" as const,
          reason: "seller-finalization-unavailable" };
      }
    },
  };

  const audit: BuyerAuditOptions = {
    async resolveMaterial({ operation, retained }) {
      const request = await loadDacsBuyerBundleSignatureRequestForOrderV1(
        context,
        operation.order,
      );
      if (request === undefined) {
        throw new DacsFixedPriceX402BuyerAuditError("buyer-audit-request-pending");
      }
      const material = await build(request, operation.order, retained);
      const provider: DurableBuyerBundleFinalizationProvider = {
        ...material.provider,
        async resolveBuyerBundle(logicalAddress) {
          if (logicalAddress !== bundleAddress(operation.order.jobId, "buyer")) {
            return { disposition: "absent" as const };
          }
          const anchored = await material.publication.resolveRoleBundle("buyer");
          return anchored === null ? { disposition: "absent" as const }
            : { disposition: "present" as const, anchored };
        },
        submitBuyerBundle: (logicalAddress, bundle) => {
          if (logicalAddress !== bundleAddress(operation.order.jobId, "buyer")) {
            throw new DacsFixedPriceX402BuyerAuditError("buyer-bundle-address-rebound");
          }
          return material.publication.submitRoleBundle("buyer", logicalAddress, bundle);
        },
        publishBundleBinding: (binding) =>
          material.publication.publishRoleBundleBinding("buyer", binding),
      };
      const durability: DacsBuyerAuditMaterialV1["durability"] = {
        leaseTtlMs,
        leaseNowMs: () => context.database.readTime(),
        settlementVerification: material.settlementVerification,
        reconcileSignature: () => ({ disposition: "authoritatively-absent" as const,
          reason: "buyer-audit-deterministic-signature-absent" }),
        async reconcileCounterSignaturePublication(input) {
          const retainedSignature = await loadDacsBuyerBundleSignatureForOrderV1(
            context,
            operation.order,
          );
          if (retainedSignature === undefined) return {
            disposition: "authoritatively-absent" as const,
            reason: "buyer-audit-counter-signature-absent",
          };
          return retainedSignature.requestHash === input.requestHash &&
              canonicalize(retainedSignature.signature) === canonicalize(input.signature)
            ? { disposition: "present" as const,
                signature: copy(retainedSignature.signature) }
            : { disposition: "rejected" as const,
                reason: "buyer-audit-counter-signature-conflict" };
        },
        async reconcileBuyerBundleAnchor({ logicalAddress, bundleContentHash }) {
          if (logicalAddress !== bundleAddress(operation.order.jobId, "buyer")) {
            return { disposition: "rejected" as const,
              reason: "buyer-bundle-address-rebound" };
          }
          const anchored = await material.publication.resolveRoleBundle("buyer");
          return anchored === null
            ? { disposition: "authoritatively-absent" as const,
                reason: "buyer-bundle-absent" }
            : anchored.anchorReceipt.contentHash === bundleContentHash
              ? { disposition: "present" as const }
              : { disposition: "rejected" as const, reason: "buyer-bundle-conflict" };
        },
        async reconcileBindingPublication(binding: Readonly<BundleBinding>) {
          const resolved = await material.publication.resolveBundleBinding(
            binding.logicalAddress,
            binding.signer,
          );
          if (resolved.disposition === "absent") return {
            disposition: "authoritatively-absent" as const,
            reason: "buyer-bundle-binding-absent",
          };
          if (resolved.disposition === "indeterminate") return resolved;
          return canonicalize(resolved.binding) === canonicalize(binding) &&
              await material.publication.verifyBundleBinding(binding) === "valid"
            ? { disposition: "published" as const }
            : { disposition: "rejected" as const, reason: "buyer-binding-conflict" };
        },
      };
      const auditOrder = operation.order as unknown as BuyerLiveOrderRecord;
      const buyerSession = isPayDemOrder(auditOrder)
        ? loadDacsPayDemBuyerSessionAgreementFactsForOrderV1(context, auditOrder)
        : loadDacsBuyerSessionAgreementFactsForOrderV1(context, auditOrder);
      const result: DacsBuyerAuditMaterialV1 = {
        input: {
          sellerVerificationInput: material.input,
          settlementContext: material.settlementContext,
          settlement: material.settlement,
          buyer: {
            primaryClaim: operation.order.buyer,
            bundleHash: identityBundleHash(buyerSession.buyerIdentity),
          },
        },
        provider,
        durability,
      };
      return result;
    },
    async authorizeFinalized({ operation, material, completion, result }) {
      if (result.logicalAddress !== bundleAddress(operation.order.jobId, "buyer") ||
          result.buyerBundle.jobId !== operation.order.jobId) return false;
      const publication = createDacsDemosBundlePublicationV1({
        context,
        jobId: operation.order.jobId,
        buyer: operation.order.buyer,
        seller: operation.order.seller,
      });
      const buyerPublication = result.publications.buyer;
      const sellerPublication = result.publications.seller;
      if (buyerPublication.nativeAddress !== result.nativeAddress ||
          buyerPublication.bundleContentHash !== result.bundleContentHash ||
          completion.sellerClosure.result.nativeAddress !==
            sellerPublication.nativeAddress) return false;
      try {
        await verifyCompletedTwoSidedSession({
          jobId: operation.order.jobId,
          buyer: operation.order.buyer,
          seller: operation.order.seller,
          sellerClosure: completion.sellerClosure,
          copies: {
            buyer: {
              role: "buyer",
              nativeAddress: buyerPublication.nativeAddress,
              bundle: result.buyerBundle,
              anchorReceipt: buyerPublication.anchorReceipt,
              ...(buyerPublication.binding === undefined
                ? {} : { binding: buyerPublication.binding }),
            },
            seller: {
              role: "seller",
              nativeAddress: sellerPublication.nativeAddress,
              bundle: completion.sellerClosure.result.sellerBundle,
              anchorReceipt: sellerPublication.anchorReceipt,
              ...(sellerPublication.binding === undefined
                ? {} : { binding: sellerPublication.binding }),
            },
          },
        }, {
          sellerFinalizationProvider: material.provider,
          async readBundleCopy(nativeAddress, role) {
            const anchored = await publication.resolveRoleBundle(role);
            return anchored !== null && anchored.nativeAddress === nativeAddress
              ? copy(anchored.bundle) as unknown as Record<string, unknown>
              : null;
          },
          async verifyBundleAnchor(candidate) {
            const disposition = await publication.verifyBundleAnchorReceipt({
              bundle: candidate.bundle,
              nativeAddress: candidate.nativeAddress,
              anchorReceipt: candidate.anchorReceipt,
            });
            return disposition === "valid"
              ? { disposition: "valid" as const, mapping: "write-input" as const }
              : { disposition, reason: `demos-${candidate.role}-bundle-anchor-${disposition}` };
          },
          resolveBundleBinding: (logicalAddress, signer) =>
            publication.resolveBundleBinding(logicalAddress, signer),
          async verifyBundleBinding(binding) {
            const disposition = await publication.verifyBundleBinding(binding);
            return disposition === "valid"
              ? { disposition: "valid" as const }
              : { disposition, reason: `demos-bundle-binding-${disposition}` };
          },
        });
        return true;
      } catch {
        return false;
      }
    },
  };

  return Object.freeze({
    bundleTransport: Object.freeze(bundleTransport),
    audit: Object.freeze(audit),
  });
}

/** Preserve the public x402-only composition surface. */
export function createDacsFixedPriceX402BuyerAuditV1(
  options: Readonly<DacsFixedPriceX402BuyerAuditOptionsV1>,
): Readonly<DacsFixedPriceX402BuyerAuditV1> {
  return createDacsFixedPriceBuyerAuditV1({ ...options, paymentProfile: "x402" });
}

/** Native DEM projection of the shared authenticated buyer audit spine. */
export function createDacsFixedPricePayDemBuyerAuditV1(
  options: Readonly<DacsFixedPricePayDemBuyerAuditOptionsV1>,
): Readonly<DacsFixedPricePayDemBuyerAuditV1> {
  return createDacsFixedPriceBuyerAuditV1({
    ...options,
    paymentProfile: "pay-dem",
  }) as unknown as Readonly<DacsFixedPricePayDemBuyerAuditV1>;
}
