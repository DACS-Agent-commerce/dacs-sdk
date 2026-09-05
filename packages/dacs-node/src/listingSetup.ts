import {
  getAuthenticatedRailProvenance,
  isAuthenticatedRailDefinition,
  publishListingCore,
  type AuthenticatedRailDefinition,
} from "@kynesyslabs/dacs";
import {
  ARTIFACT_SEPARATORS,
  isListing,
  signComponentArtifact,
  type Listing,
  type ListingDraft,
} from "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";

import type { DacsDemosActorRuntimeV1 } from "./demosRuntime.js";
import {
  createDacsGuardedSetupPlanV1,
  type DacsGuardedExecutorV1,
  type DacsGuardedSetupPlanV1,
} from "./guardedCommands.js";
import {
  inspectDacsPayDemListingDraftV1,
  inspectDacsX402ListingDraftV1,
} from "./listingDoctor.js";

export interface DacsPreparedListingSetupV1 {
  draft: Readonly<ListingDraft>;
  listing: Readonly<Listing>;
  plan: Readonly<DacsGuardedSetupPlanV1>;
}

export interface DacsListingDiscoveryPublicationInputV1 {
  listing: Readonly<Listing>;
  listingRef: string;
  logicalAddress: string;
  listingContentHash: string;
}

export type DacsListingDiscoveryPublicationV1 = Readonly<
  | { status: "published" | "existing"; indexHash: string }
  | { status: "conflict"; reasonCode: string }
  | { status: "indeterminate"; reasonCode: string }
>;

export interface DacsListingDiscoveryPublisherV1 {
  publishActive(
    input: Readonly<DacsListingDiscoveryPublicationInputV1>,
  ): Promise<Readonly<DacsListingDiscoveryPublicationV1>>;
}

export interface DacsPrepareListingSetupOptionsV1 {
  draft: unknown;
  buyerAuthority: string;
  seller: Readonly<DacsDemosActorRuntimeV1>;
  sellerPublicEndpoint: string;
  sellerPayee: string;
  network: `eip155:${number}`;
  demosNetwork: string;
  rail: Readonly<AuthenticatedRailDefinition>;
  maximumServiceAmount: string;
  actionMaximumSpendDem: string;
  safetyMarginDem: string;
  maximumSpendDem: string;
  now: number;
}

export interface DacsPreparePayDemListingSetupOptionsV1 {
  draft: unknown;
  buyerAuthority: string;
  seller: Readonly<DacsDemosActorRuntimeV1>;
  sellerPublicEndpoint: string;
  sellerPayee: string;
  demosNetwork: string;
  rail: Readonly<AuthenticatedRailDefinition>;
  maximumServiceAmount: string;
  actionMaximumSpendDem: string;
  safetyMarginDem: string;
  maximumSpendDem: string;
  now: number;
}

export interface DacsListingSetupExecutorOptionsV1 {
  prepared: Readonly<DacsPreparedListingSetupV1>;
  seller: Readonly<DacsDemosActorRuntimeV1>;
  rail: Readonly<AuthenticatedRailDefinition>;
  discovery: Readonly<DacsListingDiscoveryPublisherV1>;
}

export class DacsListingSetupError extends Error {
  override readonly name = "DacsListingSetupError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function canonicalCopy<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

async function signListing(
  draft: ListingDraft,
  seller: Readonly<DacsDemosActorRuntimeV1>,
): Promise<Listing> {
  const listing = await signComponentArtifact(
    draft,
    ARTIFACT_SEPARATORS.Listing,
    {
      algorithm: "ed25519",
      signer: seller.authority,
      sign: seller.signComponent,
    },
  );
  if (!isListing(listing)) throw new DacsListingSetupError("listing-signature-invalid");
  return listing;
}

async function signListingBytes(
  bytes: Uint8Array,
  seller: Readonly<DacsDemosActorRuntimeV1>,
): Promise<Uint8Array> {
  const signed = await seller.signComponent(bytes, {
    algorithm: "ed25519",
    signer: seller.authority,
  });
  if (signed instanceof Uint8Array) return Uint8Array.from(signed);
  const decoded = Uint8Array.from(Buffer.from(signed, "base64url"));
  if (decoded.byteLength !== 64 || Buffer.from(decoded).toString("base64url") !== signed) {
    throw new DacsListingSetupError("listing-signature-invalid");
  }
  return decoded;
}

function railAuthority(rail: Readonly<AuthenticatedRailDefinition>) {
  return {
    trustPhase: "PA-2" as const,
    registry: {
      state: "verified-finalized" as const,
      entries: [{
        railId: rail.railId,
        latestVersion: rail.railVersion,
        versions: [rail.railVersion],
      }],
      definitions: [{
        railId: rail.railId,
        railVersion: rail.railVersion,
        phaseHandler: rail.phaseHandler,
        state: "verified-finalized" as const,
      }],
    },
  };
}

async function preflightListingPublication(
  draft: ListingDraft,
  listing: Readonly<Listing>,
  seller: Readonly<DacsDemosActorRuntimeV1>,
  rail: Readonly<AuthenticatedRailDefinition>,
): Promise<void> {
  let predicted: Record<string, unknown> | undefined;
  const publication = await publishListingCore(draft, {
    sign: (bytes) => signListingBytes(bytes, seller),
    scanOwnAnchorsByNamePrefix: (prefix) =>
      seller.adapter.scanOwnAnchorsByNamePrefix(prefix),
    loadRailResolution: () => railAuthority(rail),
    async writeArtifact(_logicalAddress, value) {
      predicted = canonicalCopy(value);
      return { address: "listing-setup-read-only-preflight" };
    },
  });
  if (predicted === undefined ||
      canonicalize(predicted) !== canonicalize(listing) ||
      publication.listingPin.contentHash !== contentHash(
        listing as unknown as Record<string, unknown>,
      )) {
    throw new DacsListingSetupError("listing-setup-preflight-mismatch");
  }
}

/** Sign and bind the exact read-only setup plan before any Demos write. */
export async function prepareDacsListingSetupV1(
  options: Readonly<
    DacsPrepareListingSetupOptionsV1 | DacsPreparePayDemListingSetupOptionsV1
  >,
): Promise<Readonly<DacsPreparedListingSetupV1>> {
  if (options === null || typeof options !== "object" ||
      options.seller.role !== "seller") {
    throw new TypeError("Listing setup preparation options are invalid");
  }
  const inspected = options.rail.phaseHandler === "pay-dem"
    ? inspectDacsPayDemListingDraftV1({
        draft: options.draft,
        sellerAuthority: options.seller.authority,
        sellerPublicKey: options.seller.publicKey,
        sellerPublicEndpoint: options.sellerPublicEndpoint,
        sellerPayee: options.sellerPayee,
        rail: options.rail,
        maximumServiceAmount: options.maximumServiceAmount,
        now: options.now,
      })
    : inspectDacsX402ListingDraftV1({
        draft: options.draft,
        sellerAuthority: options.seller.authority,
        sellerPublicKey: options.seller.publicKey,
        sellerPublicEndpoint: options.sellerPublicEndpoint,
        sellerPayee: options.sellerPayee,
        network: (options as DacsPrepareListingSetupOptionsV1).network,
        rail: options.rail,
        maximumServiceAmount: options.maximumServiceAmount,
        now: options.now,
      });
  if (inspected.status !== "pass") {
    throw new DacsListingSetupError(inspected.reasonCode ?? "listing-candidate-invalid");
  }
  const draft = canonicalCopy(options.draft) as ListingDraft;
  const listing = await signListing(draft, options.seller);
  // Exercise the complete read-only publication path before a guarded intent is
  // created. In particular, this authenticates the owner-bound version history
  // and rejects gaps (for example v2 on a fresh chain) without manufacturing an
  // ambiguous effect that never crossed a write boundary.
  await preflightListingPublication(draft, listing, options.seller, options.rail);
  const listingContentHash = contentHash(listing as unknown as Record<string, unknown>);
  const plan = createDacsGuardedSetupPlanV1({
    effectId: `listing-setup:${listingContentHash}`,
    buyerAuthority: options.buyerAuthority,
    sellerAuthority: options.seller.authority,
    demosNetwork: options.demosNetwork,
    listingContentHash,
    actions: [{
      actionId: "publish-listing",
      effectId: `listing-anchor:${listingContentHash}`,
      maximumSpendDem: options.actionMaximumSpendDem,
    }],
    safetyMarginDem: options.safetyMarginDem,
    maximumSpendDem: options.maximumSpendDem,
  });
  return deepFreeze({
    draft,
    listing,
    plan,
  });
}

/**
 * Create a guarded executor whose reconciliation path repeats the same
 * deterministic Listing publication and local discovery update. The Demos
 * adapter's write journal and publishListingCore's immutable slot checks make
 * that replay safe after response loss.
 */
export function createDacsListingSetupExecutorV1(
  options: Readonly<DacsListingSetupExecutorOptionsV1>,
): DacsGuardedExecutorV1 {
  if (options === null || typeof options !== "object" ||
      options.seller.role !== "seller" ||
      typeof options.discovery?.publishActive !== "function" ||
      !isAuthenticatedRailDefinition(options.rail) ||
      getAuthenticatedRailProvenance(options.rail) === null) {
    throw new TypeError("Listing setup executor options are invalid");
  }
  const prepared = canonicalCopy(options.prepared) as DacsPreparedListingSetupV1;
  const expectedPlan = canonicalize(prepared.plan);
  const expectedListingHash = contentHash(
    prepared.listing as unknown as Record<string, unknown>,
  );
  if (!isListing(prepared.listing) ||
      expectedListingHash !== prepared.plan.listingContentHash) {
    throw new TypeError("prepared Listing setup is inconsistent");
  }

  return async ({ plan, fence }) => {
    if (plan.kind !== "setup" || canonicalize(plan) !== expectedPlan) {
      return Object.freeze({ status: "operator-action" as const,
        reasonCode: "listing-setup-plan-mismatch" });
    }
    let writeMayHaveOccurred = false;
    try {
      // Re-sign the captured draft and compare it with the plan-bound Listing
      // before crossing the first effect boundary. This is deliberately
      // redundant: it makes mutation or mismatched preparation fail closed
      // without publishing an unplanned artifact.
      const predictedListing = await signListing(prepared.draft, options.seller);
      if (contentHash(predictedListing as unknown as Record<string, unknown>) !==
            expectedListingHash ||
          canonicalize(predictedListing) !== canonicalize(prepared.listing)) {
        return Object.freeze({ status: "operator-action" as const,
          reasonCode: "listing-setup-publication-mismatch" });
      }
      await fence.assertCurrent();
      const published = await publishListingCore(prepared.draft, {
        async sign(bytes) {
          return signListingBytes(bytes, options.seller);
        },
        scanOwnAnchorsByNamePrefix: (prefix) =>
          options.seller.adapter.scanOwnAnchorsByNamePrefix(prefix),
        loadRailResolution: () => railAuthority(options.rail),
        async writeArtifact(logicalAddress, value, writeOptions) {
          await fence.assertCurrent();
          // From this point a thrown response may follow an accepted Demos
          // write. Only this boundary requires durable reconciliation.
          writeMayHaveOccurred = true;
          const result = await options.seller.adapter.anchorWriteOnce(
            writeOptions.storageName,
            value,
            {
              metadata: {
                logicalAddress,
                contentHash: contentHash(value),
                envelopeHash: sha256Hex(canonicalize(value)),
              },
            },
          );
          return Object.freeze({
            address: result.address,
            ...(result.txRef === undefined ? {} : { txRef: result.txRef }),
          });
        },
      });
      if (published.listingPin.contentHash !== expectedListingHash) {
        return Object.freeze({ status: "operator-action" as const,
          reasonCode: "listing-setup-publication-mismatch" });
      }
      const receipt = await options.seller.adapter.resolveDemosAnchorReceipt({
        logicalAddress: published.logicalAddress,
        nativeAddress: published.ref,
        contentHash: expectedListingHash,
        writer: options.seller.authority,
      });
      if (receipt === null ||
          await options.seller.adapter.verifyDemosAnchorReceipt(receipt) !== true) {
        throw new DacsListingSetupError("listing-setup-receipt-unavailable");
      }
      const readback = await options.seller.adapter.readAnchor(published.ref);
      if (readback === null || !isListing(readback) ||
          contentHash(readback) !== expectedListingHash ||
          canonicalize(readback) !== canonicalize(prepared.listing)) {
        throw new DacsListingSetupError("listing-setup-readback-unavailable");
      }
      await fence.assertCurrent();
      const discovery = await options.discovery.publishActive({
        listing: readback,
        listingRef: published.ref,
        logicalAddress: published.logicalAddress,
        listingContentHash: expectedListingHash,
      });
      if (discovery.status === "conflict") {
        return Object.freeze({ status: "operator-action" as const,
          reasonCode: discovery.reasonCode });
      }
      if (discovery.status === "indeterminate") {
        throw new DacsListingSetupError(discovery.reasonCode);
      }
      await fence.assertCurrent();
      const result = Object.freeze({
        listingRef: published.ref,
        logicalAddress: published.logicalAddress,
        listingContentHash: expectedListingHash,
        indexHash: discovery.indexHash,
        publicationStatus: discovery.status,
      });
      return fence.mode === "perform"
        ? Object.freeze({ status: "completed" as const, result })
        : Object.freeze({ status: "reconciled-performed" as const, result });
    } catch {
      if (!writeMayHaveOccurred) {
        return Object.freeze({ status: "operator-action" as const,
          reasonCode: "listing-setup-prewrite-failed" });
      }
      return fence.mode === "perform"
        ? Object.freeze({ status: "ambiguous" as const,
            reasonCode: "listing-setup-reconciliation-required" })
        : Object.freeze({ status: "reconciled-indeterminate" as const,
            reasonCode: "listing-setup-reconciliation-required" });
    }
  };
}
