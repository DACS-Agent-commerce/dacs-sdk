import {
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
} from "@kynesyslabs/dacs";
import {
  isCanonicalBase64Url,
  type IdentityBundle,
  type ListingRef,
} from "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash } from "@kynesyslabs/dacs/canonical";
import type {
  FixedPricePayDemOrderInput,
  FixedPricePayDemOrderRecord,
} from "@kynesyslabs/dacs/commerce";
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import {
  canonicalDemosAgentPublicKey,
  identityBundleHash,
} from "@kynesyslabs/dacs/identity";

import {
  captureDacsFixedPriceX402ApplicationV1,
  type DacsFixedPriceX402ApplicationV1,
} from "./fixedPriceX402Profile.js";
import {
  loadDacsFixedPricePayDemCommitmentResultV1,
  loadDacsFixedPricePayDemSellerAdmissionV1,
} from "./fixedPricePayDemProfile.js";
import { createDacsFixedPricePayDemRoleOrderV1 } from "./liveOrder.js";
import { loadDacsLiveOrderInputV1, type DacsLiveOrderInputV1 } from
  "./orderInput.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";
import { loadDacsPayDemSellerSessionAgreementFactsForOrderV1 } from
  "./sessionBootstrapAgreementRuntime.js";
import { authenticateDacsLiveSessionIdentityV1 } from
  "./sessionBootstrapTransportRuntime.js";

type NativeSellerIntakeAuthorityV1 = Pick<
  SellerPaymentIntakeDeps,
  | "resolveCommittedAgreement"
  | "resolveListingAtCommit"
  | "resolveRail"
  | "resolveIdentityBundle"
>;

export interface DacsFixedPricePayDemSellerAuthorityOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  rail: Readonly<AuthenticatedRailDefinition>;
}

export interface DacsFixedPricePayDemSellerAuthorityV1
  extends NativeSellerIntakeAuthorityV1 {
  resolveFulfilmentAgreement(
    ref: string,
  ): Promise<SellerFulfilmentResolution<SellerFulfilmentAgreement>>;
  resolveFulfilmentListing(
    ref: Readonly<ListingRef>,
  ): Promise<SellerFulfilmentResolution<SellerFulfilmentListing>>;
}

export class DacsFixedPricePayDemSellerAuthorityError extends Error {
  override readonly name = "DacsFixedPricePayDemSellerAuthorityError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

interface NativeSellerStateV1 {
  order: Readonly<FixedPricePayDemOrderRecord>;
  retained: Readonly<DacsLiveOrderInputV1<FixedPricePayDemOrderInput>>;
  application: Readonly<DacsFixedPriceX402ApplicationV1>;
  agreement: Readonly<Record<string, unknown>>;
  agreementHash: string;
  commitmentRef: string;
  commitmentContentHash: string;
  commitmentFinalizedAt: number;
  railRegistryVersion: number;
  listingResolution: Readonly<SellerListingAtCommitResolution>;
  fulfilmentAgreement: Readonly<SellerFulfilmentAgreement>;
  fulfilmentListing: Readonly<SellerFulfilmentListing>;
  buyerIdentity: Readonly<IdentityBundle>;
  sellerIdentity: Readonly<IdentityBundle>;
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

function nativeIntakeRail(
  rail: Readonly<AuthenticatedRailDefinition>,
): Readonly<SellerSupportedRailDefinition> {
  if (rail.railType !== "demos-native" || rail.asset.kind !== "native-dem" ||
      rail.network.kind !== "demos" || rail.phaseHandler !== "pay-dem" ||
      rail.availability !== "live") {
    throw new TypeError("fixed-price pay-dem authority requires a live native DEM rail");
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

async function loadOrder(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  jobId: string,
): Promise<Readonly<FixedPricePayDemOrderRecord>> {
  const loaded = await context.database.createPayDemCoordinatorStore("seller")
    .load("seller", jobId);
  if (loaded.status !== "ok" || loaded.record.seller !== context.authority ||
      loaded.record.buyer !== context.peerAuthority ||
      loaded.record.protocol.phase !== "pay-dem") {
    throw new DacsFixedPricePayDemSellerAuthorityError("pay-dem-authority-order-invalid");
  }
  return loaded.record;
}

function loadRetained(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  order: Readonly<FixedPricePayDemOrderRecord>,
): Readonly<DacsLiveOrderInputV1<FixedPricePayDemOrderInput>> {
  const retained = loadDacsLiveOrderInputV1({
    database: context.database,
    order: createDacsFixedPricePayDemRoleOrderV1({
      role: "seller",
      jobId: order.jobId,
      buyer: order.buyer,
      seller: order.seller,
      protocol: order.protocol,
    }),
  });
  if (retained === undefined || retained.localBindingHash !== order.localBindingHash) {
    throw new DacsFixedPricePayDemSellerAuthorityError("pay-dem-authority-input-invalid");
  }
  return retained;
}

async function authenticateState(
  options: Readonly<DacsFixedPricePayDemSellerAuthorityOptionsV1>,
  order: Readonly<FixedPricePayDemOrderRecord>,
): Promise<Readonly<NativeSellerStateV1>> {
  const { context, rail } = options;
  const provenance = getAuthenticatedRailProvenance(rail);
  const retained = loadRetained(context, order);
  const application = captureDacsFixedPriceX402ApplicationV1(retained.application);
  const admission = loadDacsFixedPricePayDemSellerAdmissionV1(context, order);
  const result = loadDacsFixedPricePayDemCommitmentResultV1(context, order);
  const session = loadDacsPayDemSellerSessionAgreementFactsForOrderV1(context, order);
  const agreement = result.agreement;
  const buyer = agreement.parties.find((party) => party.role === "buyer");
  const seller = agreement.parties.find((party) => party.role === "seller");
  const selected = application.listing.acceptedRails?.filter((candidate) =>
    candidate.railId === order.protocol.rail.railId);
  const payout = "payoutBindings" in agreement.terms
    ? agreement.terms.payoutBindings.filter((candidate) =>
      candidate.railId === order.protocol.rail.railId && candidate.phaseIndex === 2)
    : [];
  const sellerPayee = canonicalDemosAgentPublicKey(context.authority);
  const parameters = selected?.[0]?.parameters;
  if (!isAuthenticatedRailDefinition(rail) || provenance === null ||
      rail.railType !== "demos-native" || rail.phaseHandler !== "pay-dem" ||
      rail.availability !== "live" || rail.asset.kind !== "native-dem" ||
      rail.network.kind !== "demos" || rail.asset.symbol !== "DEM" ||
      rail.asset.decimals !== 9 || sellerPayee === null ||
      provenance.indexContentHash !== order.protocol.rail.registryIndexHash ||
      provenance.definitionContentHash !== order.protocol.rail.railDefinitionHash ||
      provenance.registryVersion <= 0 || rail.railId !== order.protocol.rail.railId ||
      rail.railVersion !== order.protocol.rail.railVersion ||
      canonicalize(admission.application) !== canonicalize(application) ||
      canonicalize(admission.protocol) !== canonicalize(order.protocol) ||
      result.commitment.recordKind !== "finality" ||
      result.commitment.record.signature.signer !== context.authority ||
      result.commitment.anchorReceipt.writer !== context.authority ||
      buyer?.primaryClaim !== context.peerAuthority || seller?.primaryClaim !== context.authority ||
      buyer.bundleHash !== identityBundleHash(session.buyerIdentity) ||
      seller.bundleHash !== identityBundleHash(session.sellerIdentity) ||
      selected?.length !== 1 || payout.length !== 1 || !plainObject(parameters) ||
      parameters.network !== "demos" || parameters.payTo !== Buffer.from(sellerPayee).toString("hex") ||
      payout[0]!.payeeAddress !== parameters.payTo ||
      agreement.terms.price.currency !== "DEM" ||
      application.listing.pipeline.length !== 4 ||
      application.listing.pipeline[2]?.kind !== "pay-dem") {
    throw new DacsFixedPricePayDemSellerAuthorityError("pay-dem-authority-binding-invalid");
  }
  if (!await authenticateDacsLiveSessionIdentityV1(
    session.buyerIdentity,
    order.buyer,
    session.buyerIdentity.sessionNonce!,
    "buyer",
    "pay-dem",
    "demos",
  ) || !await authenticateDacsLiveSessionIdentityV1(
    session.sellerIdentity,
    order.seller,
    session.sellerIdentity.sessionNonce!,
    "seller",
    "pay-dem",
    "demos",
  )) {
    throw new DacsFixedPricePayDemSellerAuthorityError("pay-dem-authority-identity-invalid");
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
      throw new DacsFixedPricePayDemSellerAuthorityError("pay-dem-authority-write-forbidden");
    },
    async verifyAnchorReceipt(candidate) {
      if (candidate.anchorReceipt.writer !== context.authority ||
          candidate.anchorReceipt.logicalAddress !== finalityCommitmentAddress(order.jobId) ||
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
        throw new DacsFixedPricePayDemSellerAuthorityError("pay-dem-authority-write-forbidden");
      },
    },
  }, provider, verifier(order.buyer, order.seller));
  if (authenticated.recordKind !== "finality" ||
      canonicalize(authenticated.record) !== canonicalize(result.commitment.record)) {
    throw new DacsFixedPricePayDemSellerAuthorityError("pay-dem-authority-commitment-invalid");
  }
  const listingRef: ListingRef = {
    listingId: application.listing.listingId,
    version: application.listing.listingVersion,
    contentHash: application.listingContentHash,
  };
  if (canonicalize(listingRef) !== canonicalize(agreement.listingRef)) {
    throw new DacsFixedPricePayDemSellerAuthorityError("pay-dem-authority-listing-invalid");
  }
  const deliverable = application.listing.offering.deliverable;
  if (deliverable.kind !== "storage-program" ||
      (deliverable.accessModel !== undefined && deliverable.accessModel !== "public") ||
      deliverable.schemaUrl !== undefined) {
    throw new DacsFixedPricePayDemSellerAuthorityError(
      "pay-dem-authority-deliverable-unconfigured",
    );
  }
  const agreementHash = contentHash(agreement as unknown as Record<string, unknown>);
  const commitmentContentHash = contentHash(
    result.commitment.record as unknown as Record<string, unknown>,
  );
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
  const fulfilmentAgreement: SellerFulfilmentAgreement = {
    artifactKind: "payee-bound",
    ref: fixedPriceAgreementLogicalAddress(order.jobId),
    contentHash: agreementHash,
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
      ref: result.commitment.logicalAddress,
      agreementHash,
      recordContentHash: commitmentContentHash,
      finalizedAt: result.commitment.committedAt,
      signer: order.seller,
    },
  };
  const fulfilmentListing: SellerFulfilmentListing = {
    pin: copy(listingRef),
    sellerPrimaryClaim: order.seller,
    buyerRequirement: copy(application.listing.buyerRequirement),
    pipeline: copy(application.listing.pipeline),
    deliverable: copy(deliverable),
  };
  return deepFreeze({
    order,
    retained,
    application,
    agreement: copy(agreement as unknown as Record<string, unknown>),
    agreementHash,
    commitmentRef: result.commitment.logicalAddress,
    commitmentContentHash,
    commitmentFinalizedAt: result.commitment.committedAt,
    railRegistryVersion: provenance.registryVersion,
    listingResolution,
    fulfilmentAgreement,
    fulfilmentListing,
    buyerIdentity: copy(session.buyerIdentity),
    sellerIdentity: copy(session.sellerIdentity),
  });
}

/**
 * Reconstruct every native seller authority from admitted actor-local state,
 * authenticated identities, the exact Listing pin, and the finalized Demos
 * Agreement commitment. No payment notice can grant these capabilities.
 */
export function createDacsFixedPricePayDemSellerAuthorityV1(
  options: Readonly<DacsFixedPricePayDemSellerAuthorityOptionsV1>,
): Readonly<DacsFixedPricePayDemSellerAuthorityV1> {
  if (!plainObject(options) || !plainObject(options.context) ||
      options.context.role !== "seller" || !isAuthenticatedRailDefinition(options.rail)) {
    throw new TypeError("fixed-price pay-dem seller authority options are invalid");
  }
  const intakeRail = nativeIntakeRail(options.rail);
  const states = new Map<string, Readonly<NativeSellerStateV1>>();
  const listings = new Map<string, Readonly<SellerListingAtCommitResolution>>();
  const fulfilmentListings = new Map<string, Readonly<SellerFulfilmentListing>>();
  const identities = new Map<string, Readonly<IdentityBundle>>();

  const remember = (state: Readonly<NativeSellerStateV1>) => {
    const listingKey = canonicalize(state.fulfilmentAgreement.listingPin);
    const prior = states.get(state.order.jobId);
    if (prior !== undefined && canonicalize(prior) !== canonicalize(state)) {
      throw new DacsFixedPricePayDemSellerAuthorityError("pay-dem-authority-cache-conflict");
    }
    states.set(state.order.jobId, state);
    listings.set(listingKey, state.listingResolution);
    fulfilmentListings.set(listingKey, state.fulfilmentListing);
    identities.set(identityBundleHash(state.buyerIdentity), state.buyerIdentity);
    identities.set(identityBundleHash(state.sellerIdentity), state.sellerIdentity);
    return state;
  };
  const stateForJob = async (jobId: string) => states.get(jobId) ??
    remember(await authenticateState(options, await loadOrder(options.context, jobId)));

  const authority: DacsFixedPricePayDemSellerAuthorityV1 = {
    async resolveCommittedAgreement(jobId: string) {
      try {
        const state = await stateForJob(jobId);
        return {
          disposition: "verified" as const,
          agreement: copy(state.agreement),
          agreementHash: state.agreementHash,
          commitment: {
            finality: "finalized" as const,
            ref: state.commitmentRef,
            contentHash: state.commitmentContentHash,
            jobId: state.order.jobId,
            agreementHash: state.agreementHash,
            listingRef: copy(state.fulfilmentAgreement.listingPin),
            committedAt: state.commitmentFinalizedAt,
            signer: state.order.seller,
          },
          railRegistryVersion: state.railRegistryVersion,
        };
      } catch {
        return { disposition: "indeterminate" as const,
          reason: "pay-dem-committed-agreement-unavailable" };
      }
    },
    async resolveListingAtCommit(listingRef: ListingRef) {
      const found = listings.get(canonicalize(listingRef));
      if (found === undefined) {
        throw new DacsFixedPricePayDemSellerAuthorityError(
          "pay-dem-listing-at-commit-unavailable",
        );
      }
      return copy(found);
    },
    async resolveRail({ ref, railRegistryVersion }: Parameters<
      SellerPaymentIntakeDeps["resolveRail"]
    >[0]) {
      const provenance = getAuthenticatedRailProvenance(options.rail);
      return provenance !== null && provenance.registryVersion === railRegistryVersion &&
          ref.railId === options.rail.railId && ref.railVersion === options.rail.railVersion
        ? { disposition: "verified" as const,
            rail: intakeRail,
            railRegistryVersion }
        : { disposition: "rejected" as const, reason: "pay-dem-rail-authority-mismatch" };
    },
    async resolveIdentityBundle(hash: string) {
      const found = identities.get(hash);
      return found === undefined
        ? { disposition: "rejected" as const, reason: "pay-dem-identity-bundle-mismatch" }
        : { disposition: "verified" as const, bundle: copy(found) };
    },
    async resolveFulfilmentAgreement(ref: string) {
      try {
        const prefix = "dacs3:agreement:";
        if (!ref.startsWith(prefix)) {
          return { status: "rejected" as const, reason: "agreement-ref-invalid" };
        }
        const state = await stateForJob(ref.slice(prefix.length));
        return state.fulfilmentAgreement.ref === ref
          ? { status: "verified" as const, value: copy(state.fulfilmentAgreement) }
          : { status: "rejected" as const, reason: "agreement-ref-mismatch" };
      } catch {
        return { status: "indeterminate" as const, reason: "agreement-authority-unavailable" };
      }
    },
    async resolveFulfilmentListing(ref: Readonly<ListingRef>) {
      try {
        const found = fulfilmentListings.get(canonicalize(ref));
        return found === undefined
          ? { status: "indeterminate" as const, reason: "listing-authority-unavailable" }
          : { status: "verified" as const, value: copy(found) };
      } catch {
        return { status: "rejected" as const, reason: "listing-ref-invalid" };
      }
    },
  };
  return Object.freeze(authority);
}
