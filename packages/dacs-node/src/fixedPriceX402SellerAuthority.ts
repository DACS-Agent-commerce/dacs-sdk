import {
  baseUnits,
  commitFixedPriceAgreement,
  finalityCommitmentAddress,
  fixedPriceAgreementLogicalAddress,
  getAuthenticatedRailProvenance,
  isAuthenticatedRailDefinition,
  type AnchoredFinalityCommitment,
  type AuthenticatedRailDefinition,
  type CommitmentSignatureVerifier,
  type FinalityCommitmentProvider,
  type SellerFulfilmentAgreement,
  type SellerFulfilmentListing,
  type SellerFulfilmentResolution,
  type SellerListingAtCommitResolution,
  type SellerPaymentIntakeDeps,
  type SellerSupportedRailDefinition,
  type X402PaywallPreSettlementContext,
  type X402SellerCommittedSessionScope,
  type X402SellerSpineOptions,
} from "@kynesyslabs/dacs";
import {
  isCanonicalBase64Url,
  type IdentityBundle,
  type ListingRef,
} from "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash } from "@kynesyslabs/dacs/canonical";
import type {
  FixedPriceX402OrderRecord,
  FixedPriceX402TrackOperationInput,
} from "@kynesyslabs/dacs/commerce";
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import { canonicalDemosAgentPublicKey, identityBundleHash } from
  "@kynesyslabs/dacs/identity";

import {
  captureDacsFixedPriceX402ApplicationV1,
  dacsFixedPriceX402DeliveryResourceV1,
  loadDacsFixedPriceX402CommitmentResultV1,
  loadDacsFixedPriceX402SellerAdmissionV1,
} from "./fixedPriceX402Profile.js";
import { createDacsFixedPriceX402RoleOrderV1 } from "./liveOrder.js";
import {
  loadDacsLiveOrderInputV1,
  type DacsLiveOrderInputV1,
} from "./orderInput.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";
import { loadDacsSellerSessionAgreementFactsForOrderV1 } from
  "./sessionBootstrapAgreementRuntime.js";
import { authenticateDacsX402SessionIdentityV1 } from
  "./sessionBootstrapTransportRuntime.js";
import type { DacsSellerX402RuntimeOptionsV1 } from "./sellerX402Runtime.js";

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const EVM_TX_RE = /^0x[0-9a-fA-F]{64}$/;

type SellerIntakeAuthorityV1 = Pick<
  SellerPaymentIntakeDeps,
  | "resolveCommittedAgreement"
  | "resolveListingAtCommit"
  | "resolveRail"
  | "resolveIdentityBundle"
  | "resolvePayerAddress"
  | "resolvePayeeDestination"
>;

export interface DacsFixedPriceX402SellerAuthorityOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  rail: Readonly<AuthenticatedRailDefinition>;
  tokenDomain: Readonly<{ name: string; version: string }>;
}

export interface DacsFixedPriceX402SellerAuthorityV1
  extends SellerIntakeAuthorityV1 {
  resolveCommittedSession: X402SellerSpineOptions["resolveCommittedSession"];
  resolveHttpScope(jobId: string): Promise<Readonly<{
    paymentPhaseIndex: number;
    httpResource: string;
  }>>;
  resolveFulfilmentAgreement(
    ref: string,
  ): Promise<SellerFulfilmentResolution<SellerFulfilmentAgreement>>;
  resolveFulfilmentListing(
    ref: Readonly<ListingRef>,
  ): Promise<SellerFulfilmentResolution<SellerFulfilmentListing>>;
  resolveOrderScope: DacsSellerX402RuntimeOptionsV1["resolveOrderScope"];
  authorizePaymentComplete:
    DacsSellerX402RuntimeOptionsV1["authorizePaymentComplete"];
}

export class DacsFixedPriceX402SellerAuthorityError extends Error {
  override readonly name = "DacsFixedPriceX402SellerAuthorityError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
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

function copy<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Project the authenticated registry document onto the exact rail shape owned
 * by seller payment intake. Registry governance and its ComponentSignature
 * authenticate the source document, but they are not members of the
 * `SellerSupportedRailDefinition` callback contract. Passing the full
 * registry document would make the intake boundary reject an otherwise valid
 * rail as an over-wide callback result.
 */
function sellerIntakeRail(
  rail: Readonly<AuthenticatedRailDefinition>,
): Readonly<SellerSupportedRailDefinition> {
  if (rail.railType !== "x402" || rail.asset.kind !== "erc20" ||
      rail.network.kind !== "x402-resource" || rail.phaseHandler !== "pay-x402" ||
      (rail.availability !== "live" && rail.availability !== "operator_gated" &&
        rail.availability !== "closed_data" && rail.availability !== "bilateral")) {
    throw new TypeError("fixed-price seller authority requires an x402 rail");
  }
  return deepFreeze({
    railVersion: rail.railVersion,
    railId: rail.railId,
    railType: rail.railType,
    asset: copy(rail.asset),
    network: copy(rail.network),
    phaseHandler: rail.phaseHandler,
    parameters: copy(rail.parameters),
    availability: rail.availability,
  });
}

function tokenDomain(value: unknown): Readonly<{ name: string; version: string }> {
  if (!plainObject(value) || Object.keys(value).length !== 2 ||
      typeof value.name !== "string" || value.name.length === 0 ||
      value.name.trim() !== value.name || typeof value.version !== "string" ||
      value.version.length === 0 || value.version.trim() !== value.version) {
    throw new TypeError("fixed-price seller token domain is invalid");
  }
  return Object.freeze({ name: value.name, version: value.version });
}

function verifyComponent(
  expected: string,
  algorithm: string,
  value: string,
  bytes: Uint8Array,
): "valid" | "invalid" | "error" {
  const key = canonicalDemosAgentPublicKey(expected);
  if (key === null || algorithm !== "ed25519" || !isCanonicalBase64Url(value)) {
    return "invalid";
  }
  const signature = Buffer.from(value, "base64url");
  if (signature.byteLength !== 64 || signature.toString("base64url") !== value) {
    return "invalid";
  }
  try {
    return ed25519Verify(bytes, Uint8Array.from(signature), publicKeyFromRaw(key))
      ? "valid" : "invalid";
  } catch {
    return "error";
  }
}

function verifier(buyer: string, seller: string): CommitmentSignatureVerifier {
  return ({ signer, algorithm, value, signedBytes }) =>
    signer === buyer || signer === seller
      ? verifyComponent(signer, algorithm, value, signedBytes)
      : "invalid";
}

interface SellerStateV1 {
  order: Readonly<FixedPriceX402OrderRecord>;
  retained: Readonly<DacsLiveOrderInputV1>;
  session: ReturnType<typeof loadDacsSellerSessionAgreementFactsForOrderV1>;
  scope: Readonly<X402SellerCommittedSessionScope>;
  agreement: Readonly<Record<string, unknown>>;
  listingResolution: Readonly<SellerListingAtCommitResolution>;
  fulfilmentAgreement: Readonly<SellerFulfilmentAgreement>;
  fulfilmentListing: Readonly<SellerFulfilmentListing>;
}

async function loadOrder(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  jobId: string,
): Promise<Readonly<FixedPriceX402OrderRecord>> {
  const loaded = await context.database.createLiveCoordinatorStore("seller")
    .load("seller", jobId);
  if (loaded.status !== "ok" || loaded.record.seller !== context.authority ||
      loaded.record.buyer !== context.peerAuthority) {
    throw new DacsFixedPriceX402SellerAuthorityError("seller-authority-order-invalid");
  }
  return loaded.record;
}

function loadRetained(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<FixedPriceX402OrderRecord>,
): Readonly<DacsLiveOrderInputV1> {
  const input = createDacsFixedPriceX402RoleOrderV1({
    role: "seller",
    jobId: order.jobId,
    buyer: order.buyer,
    seller: order.seller,
    protocol: order.protocol,
  });
  const retained = loadDacsLiveOrderInputV1({ database: context.database, order: input });
  if (retained === undefined || retained.localBindingHash !== order.localBindingHash) {
    throw new DacsFixedPriceX402SellerAuthorityError("seller-authority-input-invalid");
  }
  return retained;
}

function exactPhases(application: ReturnType<
  typeof captureDacsFixedPriceX402ApplicationV1
>, order: Readonly<FixedPriceX402OrderRecord>) {
  const payment = application.listing.pipeline
    .map((phase, index) => ({ phase, index }))
    .filter(({ phase }) => phase.kind === "pay-x402");
  const deliverable = application.listing.offering.deliverable;
  const expectedDeliveryPhase = deliverable.kind === "storage-program"
    ? "deliver-storage-program"
    : deliverable.kind === "entitlement"
      ? "deliver-entitlement"
      : deliverable.kind === "attested-payload"
        ? "deliver-attested-payload"
        : undefined;
  if (payment.length !== 1 || payment[0]!.index < 0 ||
      expectedDeliveryPhase === undefined ||
      application.listing.pipeline[payment[0]!.index + 1]?.kind !==
        expectedDeliveryPhase) {
    throw new DacsFixedPriceX402SellerAuthorityError("seller-authority-phases-invalid");
  }
  const paymentPhaseIndex = payment[0]!.index;
  const deliveryPhaseIndex = paymentPhaseIndex + 1;
  if (order.protocol.phase !== "pay-x402") {
    throw new DacsFixedPriceX402SellerAuthorityError("seller-authority-phases-invalid");
  }
  return Object.freeze({ paymentPhaseIndex, deliveryPhaseIndex });
}

function payerClaim(
  identity: Readonly<IdentityBundle>,
  chainId: number,
): Readonly<{ claim: string; address: string }> {
  const expression = new RegExp(`^cci-xm:evm:${chainId}:(0x[0-9a-fA-F]{40})$`);
  const matches = identity.claims.flatMap(({ ref }) => {
    const match = expression.exec(ref);
    return match === null ? [] : [{ claim: ref, address: match[1]! }];
  });
  if (matches.length !== 1) {
    throw new DacsFixedPriceX402SellerAuthorityError("seller-authority-payer-invalid");
  }
  return Object.freeze(matches[0]!);
}

function sameExpected(
  left: Readonly<X402SellerCommittedSessionScope["expected"]>,
  right: Readonly<X402SellerCommittedSessionScope["expected"]>,
): boolean {
  return left.network === right.network && left.amount === right.amount &&
    left.payTo.toLowerCase() === right.payTo.toLowerCase() &&
    left.asset.toLowerCase() === right.asset.toLowerCase() &&
    left.eip712.name === right.eip712.name &&
    left.eip712.version === right.eip712.version;
}

async function authenticateState(
  options: Readonly<DacsFixedPriceX402SellerAuthorityOptionsV1>,
  order: Readonly<FixedPriceX402OrderRecord>,
): Promise<Readonly<SellerStateV1>> {
  const { context, rail } = options;
  const evm = context.evm;
  if (evm?.role !== "seller") {
    throw new DacsFixedPriceX402SellerAuthorityError("seller-authority-binding-invalid");
  }
  const provenance = getAuthenticatedRailProvenance(rail);
  const retained = loadRetained(context, order);
  const application = captureDacsFixedPriceX402ApplicationV1(retained.application);
  const admission = loadDacsFixedPriceX402SellerAdmissionV1(context, order);
  const result = loadDacsFixedPriceX402CommitmentResultV1(context, order);
  const session = loadDacsSellerSessionAgreementFactsForOrderV1(context, order);
  const phases = exactPhases(application, order);
  const agreement = result.agreement;
  const buyer = agreement.parties.find((party) => party.role === "buyer");
  const seller = agreement.parties.find((party) => party.role === "seller");
  const selected = application.listing.acceptedRails?.filter((candidate) =>
    candidate.railId === order.protocol.rail.railId);
  const payout = "payoutBindings" in agreement.terms
    ? agreement.terms.payoutBindings.filter((candidate) =>
    candidate.railId === order.protocol.rail.railId &&
      candidate.phaseIndex === phases.paymentPhaseIndex)
    : [];
  if (!isAuthenticatedRailDefinition(rail) || provenance === null ||
      rail.railType !== "x402" || rail.phaseHandler !== "pay-x402" ||
      rail.availability !== "live" || rail.asset.kind !== "erc20" ||
      provenance.indexContentHash !== order.protocol.rail.registryIndexHash ||
      provenance.definitionContentHash !== order.protocol.rail.railDefinitionHash ||
      provenance.registryVersion <= 0 || rail.railId !== order.protocol.rail.railId ||
      rail.railVersion !== order.protocol.rail.railVersion ||
      `eip155:${rail.asset.chainId}` !== order.protocol.rail.network ||
      canonicalize(admission.application) !== canonicalize(application) ||
      result.commitment.recordKind !== "finality" ||
      result.commitment.record.signature.signer !== context.authority ||
      result.commitment.anchorReceipt.writer !== context.authority ||
      buyer?.primaryClaim !== context.peerAuthority ||
      seller?.primaryClaim !== context.authority ||
      buyer.bundleHash !== identityBundleHash(session.buyerIdentity) ||
      seller.bundleHash !== identityBundleHash(session.sellerIdentity) ||
      selected?.length !== 1 || payout.length !== 1 ||
      !plainObject(selected[0]!.parameters)) {
    throw new DacsFixedPriceX402SellerAuthorityError("seller-authority-binding-invalid");
  }
  if (!await authenticateDacsX402SessionIdentityV1(
    session.buyerIdentity,
    order.buyer,
    session.buyerIdentity.sessionNonce!,
    "buyer",
    order.protocol.rail.network,
  ) || !await authenticateDacsX402SessionIdentityV1(
    session.sellerIdentity,
    order.seller,
    session.sellerIdentity.sessionNonce!,
    "seller",
    order.protocol.rail.network,
  )) {
    throw new DacsFixedPriceX402SellerAuthorityError("seller-authority-identity-invalid");
  }
  const anchored: AnchoredFinalityCommitment = {
    record: copy(result.commitment.record),
    nativeAddress: result.commitment.nativeAddress,
    anchorTxRef: copy(result.commitment.anchorTxRef),
    anchorReceipt: copy(result.commitment.anchorReceipt),
  };
  const provider: FinalityCommitmentProvider = {
    resolve: async (logicalAddress) => logicalAddress === result.commitment.logicalAddress
      ? { disposition: "present", anchored: copy(anchored) }
      : { disposition: "absent" },
    submit: async () => {
      throw new DacsFixedPriceX402SellerAuthorityError("seller-authority-write-forbidden");
    },
    async verifyAnchorReceipt(candidate) {
      if (candidate.anchorReceipt.writer !== context.authority ||
          candidate.anchorReceipt.logicalAddress !==
            finalityCommitmentAddress(order.jobId) ||
          candidate.anchorReceipt.nativeAddress !== candidate.nativeAddress ||
          candidate.anchorReceipt.contentHash !== contentHash(
            candidate.record as unknown as Record<string, unknown>,
          )) return "invalid";
      try {
        if (await context.demos.adapter.verifyDemosAnchorReceipt(
          candidate.anchorReceipt,
        ) !== true) return "invalid";
        const readback = await context.demos.adapter.readAnchor(candidate.nativeAddress);
        return readback !== null && canonicalize(readback) === canonicalize(candidate.record)
          ? "valid" : "indeterminate";
      } catch {
        return "error";
      }
    },
  };
  const authenticated = await commitFixedPriceAgreement({
    agreement: copy(agreement),
    verifiedListing: {
      disposition: "verified",
      listing: copy(application.listing),
      pin: copy(agreement.listingRef),
    },
    session: {
      jobId: order.jobId,
      listingRef: copy(agreement.listingRef),
      phaseKind: "commit-payee-bound-agreement",
      orchestrator: order.seller,
      buyer: {
        primaryClaim: order.buyer,
        bundleHash: buyer.bundleHash,
        vetRecordRef: copy(buyer.vetRecordRef),
      },
      seller: {
        primaryClaim: order.seller,
        bundleHash: seller.bundleHash,
        vetRecordRef: copy(seller.vetRecordRef),
      },
    },
    createdAt: agreement.generatedAt,
    commitmentSigner: {
      algorithm: "ed25519",
      signer: order.seller,
      sign: () => {
        throw new DacsFixedPriceX402SellerAuthorityError("seller-authority-write-forbidden");
      },
    },
  }, provider, verifier(order.buyer, order.seller));
  if (authenticated.recordKind !== "finality" ||
      canonicalize(authenticated.record) !== canonicalize(result.commitment.record)) {
    throw new DacsFixedPriceX402SellerAuthorityError("seller-authority-commitment-invalid");
  }
  const parameters = selected[0]!.parameters;
  const payTo = parameters.payTo;
  const asset = parameters.asset;
  const resourceBaseUrl = parameters.httpResource;
  if (typeof payTo !== "string" || !EVM_ADDRESS_RE.test(payTo) ||
      typeof asset !== "string" || !EVM_ADDRESS_RE.test(asset) ||
      typeof resourceBaseUrl !== "string" ||
      payTo.toLowerCase() !== payout[0]!.payeeAddress.toLowerCase() ||
      payTo.toLowerCase() !== evm.address.toLowerCase() ||
      asset.toLowerCase() !== rail.asset.contract.toLowerCase() ||
      rail.network.kind !== "x402-resource" ||
      resourceBaseUrl !== rail.network.resourceBaseUrl ||
      agreement.terms.price.currency !== rail.asset.symbol) {
    throw new DacsFixedPriceX402SellerAuthorityError("seller-authority-terms-invalid");
  }
  const amount = baseUnits(agreement.terms.price.amount, rail.asset.decimals);
  if (amount === "0") {
    throw new DacsFixedPriceX402SellerAuthorityError("seller-authority-amount-invalid");
  }
  const paying = payerClaim(session.buyerIdentity, rail.asset.chainId);
  const listingRef: ListingRef = {
    listingId: application.listing.listingId,
    version: application.listing.listingVersion,
    contentHash: application.listingContentHash,
  };
  if (canonicalize(listingRef) !== canonicalize(agreement.listingRef)) {
    throw new DacsFixedPriceX402SellerAuthorityError("seller-authority-listing-invalid");
  }
  const deliverable = application.listing.offering.deliverable;
  // The first generated live profile owns one fully implemented delivery
  // contract: public Demos Storage Program publication. Fail every other mode
  // before settlement. In particular, never manufacture an attested-payload
  // producer/reader capability from the Listing's self-assertion.
  if (deliverable.kind !== "storage-program" ||
      (deliverable.accessModel !== undefined && deliverable.accessModel !== "public") ||
      deliverable.schemaUrl !== undefined) {
    throw new DacsFixedPriceX402SellerAuthorityError(
      "seller-authority-deliverable-unconfigured",
    );
  }
  const listingResolution: SellerListingAtCommitResolution = {
    rawListing: copy(application.listing as unknown as Record<string, unknown>),
    validation: {
      disposition: "verified",
      step: 9,
      reason: "seller-session-admission-verified",
      listing: copy(application.listing),
      listingContentHash: application.listingContentHash,
    },
  };
  const scope: X402SellerCommittedSessionScope = {
    scopeVersion: "1",
    jobId: order.jobId,
    paymentPhaseIndex: phases.paymentPhaseIndex,
    deliveryPhaseIndex: phases.deliveryPhaseIndex,
    payer: paying.address,
    payerPayingKey: paying.claim,
    httpResource: dacsFixedPriceX402DeliveryResourceV1(resourceBaseUrl, order.jobId),
    railId: rail.railId,
    railRegistryVersion: provenance.registryVersion,
    agreementRef: fixedPriceAgreementLogicalAddress(order.jobId),
    agreementHash: contentHash(agreement as unknown as Record<string, unknown>),
    listingRef,
    commitmentRef: result.commitment.logicalAddress,
    commitmentContentHash: contentHash(
      result.commitment.record as unknown as Record<string, unknown>,
    ),
    commitmentFinalizedAt: result.commitment.committedAt,
    expected: {
      network: `eip155:${rail.asset.chainId}`,
      payTo,
      amount,
      asset,
      eip712: copy(options.tokenDomain),
    },
  };
  const fulfilmentAgreement: SellerFulfilmentAgreement = {
    artifactKind: "payee-bound",
    ref: scope.agreementRef,
    contentHash: scope.agreementHash,
    jobId: order.jobId,
    listingPin: copy(listingRef),
    buyer: {
      primaryClaim: order.buyer,
      bundleHash: buyer.bundleHash,
      vetRecordRef: copy(buyer.vetRecordRef),
    },
    seller: {
      primaryClaim: order.seller,
      bundleHash: seller.bundleHash,
      vetRecordRef: copy(seller.vetRecordRef),
    },
    deliverableRef: {
      deliverableType: deliverable.kind,
      hash: agreement.terms.deliverable.hash,
      ...(agreement.terms.deliverable.schemaUrl === undefined
        ? {} : { schemaUrl: agreement.terms.deliverable.schemaUrl }),
    },
    commitment: {
      status: "finalized",
      ref: scope.commitmentRef,
      agreementHash: scope.agreementHash,
      recordContentHash: scope.commitmentContentHash,
      finalizedAt: scope.commitmentFinalizedAt,
      signer: order.seller,
    },
  };
  const fulfilmentListing: SellerFulfilmentListing = {
    pin: copy(listingRef),
    sellerPrimaryClaim: order.seller,
    buyerRequirement: copy(application.listing.buyerRequirement),
    pipeline: copy(application.listing.pipeline),
    deliverable: copy(application.listing.offering.deliverable),
  };
  return deepFreeze({
    order,
    retained,
    session,
    scope,
    agreement: copy(agreement as unknown as Record<string, unknown>),
    listingResolution,
    fulfilmentAgreement,
    fulfilmentListing,
  });
}

function paymentCompleteMatches(
  state: Readonly<SellerStateV1>,
  authorization: Parameters<
    DacsSellerX402RuntimeOptionsV1["authorizePaymentComplete"]
  >[0]["authorization"],
  settlementTransaction: string,
): boolean {
  const payment = authorization.paymentAuthorization;
  return canonicalize(authorization.sessionAuthorization) === canonicalize(state.scope) &&
    payment.jobId === state.order.jobId &&
    payment.phaseIndex === state.scope.paymentPhaseIndex &&
    payment.agreementHash === state.scope.agreementHash &&
    payment.railId === state.scope.railId &&
    payment.commitment.ref === state.scope.commitmentRef &&
    payment.commitment.contentHash === state.scope.commitmentContentHash &&
    payment.settlementIdentity.kind === "evm" && EVM_TX_RE.test(settlementTransaction) &&
    payment.settlementIdentity.txHash.toLowerCase() === settlementTransaction.toLowerCase();
}

/**
 * Reconstruct every pre-settlement seller authority from actor-local admitted
 * state and the authenticated Demos commitment. No HTTP/facilitator field can
 * grant a session, payer, destination or phase binding.
 */
export function createDacsFixedPriceX402SellerAuthorityV1(
  rawOptions: Readonly<DacsFixedPriceX402SellerAuthorityOptionsV1>,
): Readonly<DacsFixedPriceX402SellerAuthorityV1> {
  if (!plainObject(rawOptions) || !plainObject(rawOptions.context) ||
      rawOptions.context.role !== "seller" || rawOptions.context.evm?.role !== "seller" ||
      !isAuthenticatedRailDefinition(rawOptions.rail)) {
    throw new TypeError("fixed-price seller authority options are invalid");
  }
  const options = Object.freeze({
    ...rawOptions,
    tokenDomain: tokenDomain(rawOptions.tokenDomain),
  });
  const { context, rail } = options;
  const evm = context.evm;
  if (evm?.role !== "seller") {
    throw new TypeError("fixed-price seller authority options are invalid");
  }
  const intakeRail = sellerIntakeRail(rail);

  const stateCache = new Map<string, Readonly<SellerStateV1>>();
  const listingAuthorities = new Map<string, Readonly<SellerListingAtCommitResolution>>();
  const fulfilmentListings = new Map<string, Readonly<SellerFulfilmentListing>>();
  const identityAuthorities = new Map<string, Readonly<{
    role: "buyer" | "seller";
    bundle: Readonly<IdentityBundle>;
  }>>();
  const railAuthorities = new Set<string>();

  const remember = (state: Readonly<SellerStateV1>): Readonly<SellerStateV1> => {
    const priorState = stateCache.get(state.order.jobId);
    const listingKey = canonicalize(state.scope.listingRef);
    const priorListing = listingAuthorities.get(listingKey);
    const priorFulfilmentListing = fulfilmentListings.get(listingKey);
    const buyerHash = identityBundleHash(state.session.buyerIdentity);
    const sellerHash = identityBundleHash(state.session.sellerIdentity);
    const priorBuyer = identityAuthorities.get(buyerHash);
    const priorSeller = identityAuthorities.get(sellerHash);
    if ((priorState !== undefined && canonicalize(priorState) !== canonicalize(state)) ||
        (priorListing !== undefined &&
          canonicalize(priorListing) !== canonicalize(state.listingResolution)) ||
        (priorFulfilmentListing !== undefined &&
          canonicalize(priorFulfilmentListing) !==
            canonicalize(state.fulfilmentListing)) ||
        (priorBuyer !== undefined && (priorBuyer.role !== "buyer" ||
          canonicalize(priorBuyer.bundle) !== canonicalize(state.session.buyerIdentity))) ||
        (priorSeller !== undefined && (priorSeller.role !== "seller" ||
          canonicalize(priorSeller.bundle) !== canonicalize(state.session.sellerIdentity)))) {
      throw new DacsFixedPriceX402SellerAuthorityError("seller-authority-cache-conflict");
    }
    stateCache.set(state.order.jobId, state);
    listingAuthorities.set(listingKey, state.listingResolution);
    fulfilmentListings.set(listingKey, state.fulfilmentListing);
    identityAuthorities.set(buyerHash, Object.freeze({
      role: "buyer",
      bundle: state.session.buyerIdentity,
    }));
    identityAuthorities.set(sellerHash, Object.freeze({
      role: "seller",
      bundle: state.session.sellerIdentity,
    }));
    const terms = state.agreement.terms;
    if (plainObject(terms) && plainObject(terms.rail)) {
      railAuthorities.add(canonicalize(terms.rail));
    }
    return state;
  };

  const stateForJob = async (jobId: string) => {
    const existing = stateCache.get(jobId);
    if (existing !== undefined) return existing;
    return remember(await authenticateState(options, await loadOrder(context, jobId)));
  };

  const authority: DacsFixedPriceX402SellerAuthorityV1 = {
    async resolveHttpScope(jobId) {
      const state = await stateForJob(jobId);
      return Object.freeze({
        paymentPhaseIndex: state.scope.paymentPhaseIndex,
        httpResource: state.scope.httpResource,
      });
    },
    async resolveFulfilmentAgreement(ref) {
      try {
        const prefix = "dacs3:agreement:";
        if (typeof ref !== "string" || !ref.startsWith(prefix)) {
          return { status: "rejected" as const, reason: "agreement-ref-invalid" };
        }
        const jobId = ref.slice(prefix.length);
        const state = await stateForJob(jobId);
        return state.fulfilmentAgreement.ref === ref
          ? { status: "verified" as const, value: copy(state.fulfilmentAgreement) }
          : { status: "rejected" as const, reason: "agreement-ref-mismatch" };
      } catch {
        return { status: "indeterminate" as const,
          reason: "agreement-authority-unavailable" };
      }
    },
    async resolveFulfilmentListing(ref) {
      try {
        const found = fulfilmentListings.get(canonicalize(ref));
        return found === undefined
          ? { status: "indeterminate" as const,
              reason: "listing-authority-unavailable" }
          : { status: "verified" as const, value: copy(found) };
      } catch {
        return { status: "rejected" as const, reason: "listing-ref-invalid" };
      }
    },
    async resolveCommittedSession(input: Readonly<X402PaywallPreSettlementContext>) {
      try {
        const state = await stateForJob(input.jobId);
        if (input.phaseIndex !== state.scope.paymentPhaseIndex ||
            input.payer.toLowerCase() !== state.scope.payer.toLowerCase() ||
            input.request.getMethod() !== "GET" ||
            input.request.getUrl() !== state.scope.httpResource ||
            !sameExpected(input.expected, state.scope.expected)) {
          return { disposition: "rejected" as const,
            reason: "committed-session-request-mismatch" };
        }
        return { disposition: "verified" as const, session: copy(state.scope) };
      } catch {
        return { disposition: "indeterminate" as const,
          reason: "committed-session-authority-unavailable" };
      }
    },
    async resolveOrderScope({ operation, retained }) {
      const state = await stateForJob(operation.order.jobId);
      if (canonicalize(retained) !== canonicalize(state.retained)) {
        throw new DacsFixedPriceX402SellerAuthorityError("seller-authority-input-invalid");
      }
      return Object.freeze({
        paymentPhaseIndex: state.scope.paymentPhaseIndex,
        deliveryPhaseIndex: state.scope.deliveryPhaseIndex,
      });
    },
    async authorizePaymentComplete(input) {
      const state = await stateForJob(input.operation.order.jobId);
      return canonicalize(input.retained) === canonicalize(state.retained) &&
        paymentCompleteMatches(state, input.authorization, input.settlementTransaction);
    },
    async resolveCommittedAgreement(jobId) {
      try {
        const state = await stateForJob(jobId);
        return {
          disposition: "verified" as const,
          agreement: copy(state.agreement),
          agreementHash: state.scope.agreementHash,
          commitment: {
            finality: "finalized" as const,
            ref: state.scope.commitmentRef,
            contentHash: state.scope.commitmentContentHash,
            jobId: state.order.jobId,
            agreementHash: state.scope.agreementHash,
            listingRef: copy(state.scope.listingRef),
            committedAt: state.scope.commitmentFinalizedAt,
            signer: state.order.seller,
          },
          railRegistryVersion: state.scope.railRegistryVersion,
        };
      } catch {
        return { disposition: "indeterminate" as const,
          reason: "committed-agreement-authority-unavailable" };
      }
    },
    async resolveListingAtCommit(listingRef) {
      const found = listingAuthorities.get(canonicalize(listingRef));
      if (found === undefined) {
        throw new DacsFixedPriceX402SellerAuthorityError(
          "listing-at-commit-authority-unavailable",
        );
      }
      return copy(found);
    },
    async resolveRail({ ref, railRegistryVersion }) {
      const provenance = getAuthenticatedRailProvenance(rail);
      return provenance !== null && provenance.registryVersion === railRegistryVersion &&
          railAuthorities.has(canonicalize(ref)) && ref.railId === rail.railId &&
          ref.railVersion === rail.railVersion
        ? { disposition: "verified" as const,
            rail: intakeRail,
            railRegistryVersion }
        : { disposition: "rejected" as const, reason: "rail-authority-mismatch" };
    },
    async resolveIdentityBundle(hash) {
      const found = identityAuthorities.get(hash);
      return found === undefined
        ? { disposition: "rejected" as const, reason: "identity-bundle-mismatch" }
        : { disposition: "verified" as const, bundle: copy(found.bundle) };
    },
    async resolvePayerAddress({ payingKey, buyerBundle, rail: candidate }) {
      try {
        const paying = payerClaim(buyerBundle, candidate.asset.chainId);
        const retainedIdentity = identityAuthorities.get(identityBundleHash(buyerBundle));
        return paying.claim === payingKey &&
            retainedIdentity?.role === "buyer" &&
            canonicalize(candidate) === canonicalize(intakeRail)
          ? { disposition: "verified" as const, address: paying.address }
          : { disposition: "rejected" as const, reason: "payer-binding-mismatch" };
      } catch {
        return { disposition: "rejected" as const, reason: "payer-binding-mismatch" };
      }
    },
    async resolvePayeeDestination({
      payeePrimaryClaim,
      payeeBundle,
      payoutAddress,
      rail: candidate,
    }) {
      const retainedIdentity = identityAuthorities.get(identityBundleHash(payeeBundle));
      return payeePrimaryClaim === context.authority &&
          retainedIdentity?.role === "seller" &&
          canonicalize(candidate) === canonicalize(intakeRail) &&
          payoutAddress.toLowerCase() === evm.address.toLowerCase()
        ? { disposition: "bound" as const, address: evm.address, tier: 3 as const }
        : { disposition: "mismatch" as const,
            reason: "payee-binding-mismatch", tier: 3 as const };
    },
  };
  return Object.freeze(authority);
}
