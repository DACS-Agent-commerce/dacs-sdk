import {
  getAuthenticatedRailProvenance,
  isAuthenticatedRailDefinition,
  validateListingArtifact,
  type AuthenticatedRailDefinition,
} from "@kynesyslabs/dacs";
import {
  isListing,
  isListingDraft,
  type ComponentSignature,
  type Listing,
  type ListingDraft,
  type RevocationBinding,
} from "@kynesyslabs/dacs/artifacts";
import {
  canonicalize,
  canonicalizeDecimal,
  contentHash,
  listingAddress,
  sha256Hex,
} from "@kynesyslabs/dacs/canonical";
import { ed25519Verify, publicKeyFromRaw, signedBytes } from "@kynesyslabs/dacs/crypto";
import {
  canonicalDemosAgentPublicKey,
  identityBundleHash,
  sameCanonicalClaimIdentity,
} from "@kynesyslabs/dacs/identity";

import type { DacsLiveDoctorProbeResultV1 } from "./doctor.js";

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export interface DacsX402ListingDraftInspectionOptionsV1 {
  draft: unknown;
  sellerAuthority: string;
  sellerPublicKey: Uint8Array;
  sellerPublicEndpoint: string;
  sellerPayee: string;
  network: `eip155:${number}`;
  rail: Readonly<AuthenticatedRailDefinition>;
  maximumServiceAmount: string;
  now: number;
}

export interface DacsX402ExistingListingResolutionOptionsV1 {
  listingRef: string;
  sellerAuthority: string;
  sellerPublicKey: Uint8Array;
  sellerPublicEndpoint: string;
  sellerPayee: string;
  network: `eip155:${number}`;
  rail: Readonly<AuthenticatedRailDefinition>;
  maximumServiceAmount: string;
  now: number;
  readAnchor(locator: string): Promise<Record<string, unknown> | null>;
  authenticateAnchor(input: Readonly<{
    logicalAddress: string;
    nativeAddress: string;
    contentHash: string;
    writer: string;
  }>): Promise<boolean>;
  readJson(url: string): Promise<unknown>;
}

export interface DacsX402ExistingListingAdmissionV1 {
  listingRef: string;
  logicalAddress: string;
  listingContentHash: string;
  listing: Readonly<Listing>;
  rail: Readonly<AuthenticatedRailDefinition>;
  facts: Readonly<Record<string, string | number | boolean | null>>;
}

export type DacsX402ExistingListingResolutionV1 = Readonly<
  | { status: "verified"; admission: Readonly<DacsX402ExistingListingAdmissionV1> }
  | { status: "fail" | "blocked"; reasonCode: string }
>;

export interface DacsX402PurchaseCostInspectionOptionsV1 {
  admission: Readonly<DacsX402ExistingListingAdmissionV1>;
  maximumServiceAmount: string;
  maximumNetworkFeeEth: string;
}

function decimalValue(value: unknown): Readonly<{ units: bigint; scale: number }> | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 ||
      value.trim() !== value || value.startsWith("-")) return undefined;
  let canonical: string;
  try {
    canonical = canonicalizeDecimal(value);
  } catch {
    return undefined;
  }
  if (canonical !== value) return undefined;
  const [whole, fraction = ""] = value.split(".");
  if (whole === undefined) return undefined;
  return Object.freeze({ units: BigInt(`${whole}${fraction}`), scale: fraction.length });
}

function within(value: string, maximum: string): boolean {
  const actual = decimalValue(value);
  const ceiling = decimalValue(maximum);
  if (actual === undefined || ceiling === undefined || actual.units <= 0n) return false;
  const scale = Math.max(actual.scale, ceiling.scale);
  return actual.units * (10n ** BigInt(scale - actual.scale)) <=
    ceiling.units * (10n ** BigInt(scale - ceiling.scale));
}

function exactPublicUrl(value: unknown, expected: string): boolean {
  if (typeof value !== "string" || value !== expected) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" &&
      parsed.search === "" && parsed.hash === "";
  } catch {
    return false;
  }
}

function canonicalSignature(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(value)) return undefined;
  try {
    const bytes = Uint8Array.from(Buffer.from(value, "base64url"));
    return bytes.byteLength === 64 && Buffer.from(bytes).toString("base64url") === value
      ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function primaryIdentityValid(
  draft: Readonly<ListingDraft | Listing>,
  authority: string,
  publicKey: Uint8Array,
): boolean {
  const bundle = draft.seller.identity;
  if (!sameCanonicalClaimIdentity(bundle.presentedBy, authority) ||
      bundle.claims.length !== 1 ||
      !sameCanonicalClaimIdentity(bundle.claims[0]?.ref, authority) ||
      bundle.presentation.kind !== "per-claim" ||
      bundle.presentation.signatures.length !== 1 ||
      !sameCanonicalClaimIdentity(bundle.presentation.signatures[0]?.ref, authority)) return false;
  const signature = canonicalSignature(bundle.presentation.signatures[0]?.signature);
  if (signature === undefined) return false;
  try {
    return ed25519Verify(
      signedBytes("dacs-bundle-presentation:v1:", identityBundleHash(bundle)),
      signature,
      publicKeyFromRaw(publicKey),
    );
  } catch {
    return false;
  }
}

function componentSignatureValid(
  input: Readonly<{
    signedBytes: Uint8Array;
    signature: Readonly<ComponentSignature>;
  }>,
  authority: string,
  publicKey: Uint8Array,
): boolean {
  if (input.signature.algorithm !== "ed25519" ||
      !sameCanonicalClaimIdentity(input.signature.signer, authority)) return false;
  const signature = canonicalSignature(input.signature.value);
  if (signature === undefined) return false;
  try {
    return ed25519Verify(input.signedBytes, signature, publicKeyFromRaw(publicKey));
  } catch {
    return false;
  }
}

function listingRailValid(
  draft: Readonly<ListingDraft | Listing>,
  options: Readonly<DacsX402ListingDraftInspectionOptionsV1>,
): boolean {
  const rail = options.rail;
  const accepted = draft.acceptedRails;
  if (!Array.isArray(accepted) || accepted.length !== 1 ||
      accepted[0]?.railId !== rail.railId ||
      accepted[0].railVersion !== rail.railVersion ||
      accepted[0].parameters === undefined) return false;
  const parameters = accepted[0].parameters;
  if (parameters.network !== options.network ||
      typeof parameters.payTo !== "string" ||
      parameters.payTo.toLowerCase() !== options.sellerPayee.toLowerCase() ||
      typeof parameters.asset !== "string" ||
      rail.asset.kind !== "erc20" ||
      parameters.asset.toLowerCase() !== rail.asset.contract.toLowerCase() ||
      parameters.httpResource !== (rail.network.kind === "x402-resource"
        ? rail.network.resourceBaseUrl : undefined)) return false;
  const phases = draft.pipeline;
  return phases.length === 4 &&
    phases[0]?.kind === "negotiate-fixed-price" &&
    phases[1]?.kind === "commit-payee-bound-agreement" &&
    phases[2]?.kind === "pay-x402" && phases[2].parameters?.rail === rail.railId &&
    typeof phases[3]?.kind === "string" && phases[3].kind.startsWith("deliver-");
}

function plainRecord(value: unknown): value is Record<string, unknown> {
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

function safeHttpsUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048 ||
      value.trim() !== value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" &&
      url.hash === "" && url.search === "" ? url : undefined;
  } catch {
    return undefined;
  }
}

function discoveryEntry(
  index: Record<string, unknown>,
  listing: Readonly<Listing>,
  listingRef: string,
  listingContentHash: string,
  sellerAuthority: string,
  now: number,
): Readonly<{ status: "active" | "revoked"; binding?: RevocationBinding }> | undefined {
  if (index.indexVersion !== "1" || index.seller !== sellerAuthority ||
      !Number.isSafeInteger(index.generatedAt) || (index.generatedAt as number) < 0 ||
      (index.generatedAt as number) > now ||
      !Array.isArray(index.listings)) return undefined;
  const matches = index.listings.filter((raw): raw is Record<string, unknown> =>
    plainRecord(raw) && raw.listingId === listing.listingId &&
      raw.version === listing.listingVersion);
  if (matches.length !== 1) return undefined;
  const entry = matches[0]!;
  if (entry.contentHash !== listingContentHash || !plainRecord(entry.anchor) ||
      entry.anchor.kind !== "storage-program" || entry.anchor.locator !== listingRef ||
      (entry.status !== "active" && entry.status !== "revoked")) return undefined;
  if (entry.status === "active") {
    return entry.revocation === undefined ? Object.freeze({ status: "active" as const })
      : undefined;
  }
  if (!plainRecord(entry.revocation)) return undefined;
  return Object.freeze({
    status: "revoked" as const,
    binding: entry.revocation as unknown as RevocationBinding,
  });
}

async function authenticatedDiscoverySurface(
  options: Readonly<DacsX402ExistingListingResolutionOptionsV1>,
  listing: Readonly<Listing>,
  listingContentHash: string,
): Promise<Readonly<{
  status: "active" | "revoked";
  binding?: RevocationBinding;
}> | undefined> {
  const endpoint = safeHttpsUrl(options.sellerPublicEndpoint);
  if (endpoint === undefined) return undefined;
  const cardUrl = new URL("/.well-known/agent.json", endpoint);
  let cardRaw: unknown;
  try {
    cardRaw = await options.readJson(cardUrl.toString());
  } catch {
    return undefined;
  }
  if (!plainRecord(cardRaw) || !plainRecord(cardRaw.dacs) ||
      cardRaw.dacs.dacsVersion !== "1" || !plainRecord(cardRaw.dacs.listings)) {
    return undefined;
  }
  const indexUrl = safeHttpsUrl(cardRaw.dacs.listings.indexUrl);
  const indexHash = cardRaw.dacs.listings.indexHash;
  if (indexUrl === undefined || indexUrl.origin !== endpoint.origin ||
      typeof indexHash !== "string" || !/^sha256-[0-9a-f]{64}$/.test(indexHash)) {
    return undefined;
  }
  let indexRaw: unknown;
  try {
    indexRaw = await options.readJson(indexUrl.toString());
  } catch {
    return undefined;
  }
  if (!plainRecord(indexRaw)) return undefined;
  let observedHash: string;
  try {
    observedHash = `sha256-${sha256Hex(canonicalize(indexRaw))}`;
  } catch {
    return undefined;
  }
  if (observedHash !== indexHash) return undefined;
  return discoveryEntry(
    indexRaw,
    listing,
    options.listingRef,
    listingContentHash,
    options.sellerAuthority,
    options.now,
  );
}

function validExistingOptions(
  options: Readonly<DacsX402ExistingListingResolutionOptionsV1>,
): boolean {
  const authorityKey = canonicalDemosAgentPublicKey(options.sellerAuthority);
  return typeof options.listingRef === "string" &&
    /^stor-[0-9a-f]{40}$/.test(options.listingRef) &&
    authorityKey !== null && options.sellerPublicKey instanceof Uint8Array &&
    options.sellerPublicKey.byteLength === 32 &&
    Buffer.from(authorityKey).equals(options.sellerPublicKey) &&
    safeHttpsUrl(options.sellerPublicEndpoint) !== undefined &&
    EVM_ADDRESS_RE.test(options.sellerPayee) && /^eip155:[1-9][0-9]*$/.test(options.network) &&
    typeof options.maximumServiceAmount === "string" &&
    Number.isSafeInteger(options.now) && options.now >= 0 &&
    isAuthenticatedRailDefinition(options.rail) &&
    getAuthenticatedRailProvenance(options.rail) !== null &&
    typeof options.readAnchor === "function" &&
    typeof options.authenticateAnchor === "function" && typeof options.readJson === "function";
}

/**
 * Resolve one exact Demos Listing reference into a session-admissible x402
 * Listing. Discovery remains a pointer: the function independently verifies the
 * Demos receipt, Listing signature, identity presentation, revocation surface,
 * authenticated rail and generated-profile price/payee bindings.
 */
export async function resolveDacsX402ExistingListingV1(
  options: Readonly<DacsX402ExistingListingResolutionOptionsV1>,
): Promise<Readonly<DacsX402ExistingListingResolutionV1>> {
  if (!validExistingOptions(options)) {
    throw new TypeError("existing x402 Listing resolution options are invalid");
  }
  let raw: Record<string, unknown> | null;
  try {
    raw = await options.readAnchor(options.listingRef);
  } catch {
    return Object.freeze({ status: "blocked", reasonCode: "listing-anchor-read-unavailable" });
  }
  if (raw === null) {
    return Object.freeze({ status: "blocked", reasonCode: "listing-anchor-unavailable" });
  }
  let listing: Listing;
  try {
    const captured = JSON.parse(canonicalize(raw)) as unknown;
    if (!isListing(captured)) {
      return Object.freeze({ status: "fail", reasonCode: "listing-existing-schema-invalid" });
    }
    listing = captured;
  } catch {
    return Object.freeze({ status: "fail", reasonCode: "listing-existing-not-canonical" });
  }
  if (!sameCanonicalClaimIdentity(listing.seller.identity.presentedBy,
    options.sellerAuthority) || listing.signature.signer !== options.sellerAuthority ||
      !exactPublicUrl(listing.seller.publicEndpoint, options.sellerPublicEndpoint)) {
    return Object.freeze({ status: "fail", reasonCode: "listing-existing-seller-invalid" });
  }
  const listingContentHash = contentHash(listing as unknown as Record<string, unknown>);
  const logicalAddress = listingAddress(
    listing.seller.identity.presentedBy,
    listing.listingId,
    listing.listingVersion,
  );
  try {
    if (await options.authenticateAnchor({
      logicalAddress,
      nativeAddress: options.listingRef,
      contentHash: listingContentHash,
      writer: options.sellerAuthority,
    }) !== true) {
      return Object.freeze({ status: "fail", reasonCode: "listing-anchor-authentication-invalid" });
    }
  } catch {
    return Object.freeze({ status: "blocked", reasonCode: "listing-anchor-authentication-unavailable" });
  }
  const surface = await authenticatedDiscoverySurface(options, listing, listingContentHash);
  if (surface === undefined) {
    return Object.freeze({ status: "blocked", reasonCode: "listing-registry-resolution-unavailable" });
  }
  const validation = await validateListingArtifact(
    listing as unknown as Record<string, unknown>,
    {
      nowMs: () => options.now,
      verifyListingSignature: (input) => componentSignatureValid(
        input,
        options.sellerAuthority,
        options.sellerPublicKey,
      ),
      revocation: {
        surfaces: [{
          kind: "well-known",
          status: surface.status,
          integrity: "verified",
          ...(surface.binding === undefined ? {} : { binding: surface.binding }),
        }],
        async readMarker(anchor) {
          if (anchor.kind !== "storage-program" ||
              typeof anchor.locator !== "string" || !/^stor-[0-9a-f]{40}$/.test(anchor.locator) ||
              surface.binding === undefined) throw new Error("revocation marker anchor invalid");
          const marker = await options.readAnchor(anchor.locator);
          if (marker === null || await options.authenticateAnchor({
            logicalAddress: surface.binding.logicalAddress,
            nativeAddress: anchor.locator,
            contentHash: surface.binding.markerContentHash,
            writer: options.sellerAuthority,
          }) !== true) throw new Error("revocation marker authentication unavailable");
          return marker;
        },
        verifyMarkerSignature: (input) => componentSignatureValid(
          input,
          options.sellerAuthority,
          options.sellerPublicKey,
        ),
      },
      verifyIdentityPresentation: ({ bundle }) => primaryIdentityValid(
        { ...listing, seller: { ...listing.seller, identity: bundle } },
        options.sellerAuthority,
        options.sellerPublicKey,
      ),
      loadRailResolution: () => ({
        trustPhase: "PA-2",
        registry: {
          state: "verified-finalized",
          entries: [{
            railId: options.rail.railId,
            latestVersion: options.rail.railVersion,
            versions: [options.rail.railVersion],
          }],
          definitions: [{
            railId: options.rail.railId,
            railVersion: options.rail.railVersion,
            phaseHandler: options.rail.phaseHandler,
            state: "verified-finalized",
          }],
        },
      }),
      verifySellerControl: ({ bundle, signer }) =>
        signer === options.sellerAuthority && primaryIdentityValid(
          { ...listing, seller: { ...listing.seller, identity: bundle } },
          options.sellerAuthority,
          options.sellerPublicKey,
        ),
    },
  );
  if (validation.disposition !== "verified" || validation.step !== 9 ||
      validation.listingContentHash !== listingContentHash) {
    return Object.freeze({
      status: validation.disposition === "rejected" || validation.disposition === "revoked"
        ? "fail" as const : "blocked" as const,
      reasonCode: validation.disposition === "revoked"
        ? "listing-existing-revoked"
        : validation.disposition === "rejected"
          ? "listing-existing-validation-invalid"
          : "listing-existing-validation-indeterminate",
    });
  }
  const profileOptions: DacsX402ListingDraftInspectionOptionsV1 = {
    draft: listing,
    sellerAuthority: options.sellerAuthority,
    sellerPublicKey: options.sellerPublicKey,
    sellerPublicEndpoint: options.sellerPublicEndpoint,
    sellerPayee: options.sellerPayee,
    network: options.network,
    rail: options.rail,
    maximumServiceAmount: options.maximumServiceAmount,
    now: options.now,
  };
  if (!listingRailValid(listing, profileOptions)) {
    return Object.freeze({ status: "fail", reasonCode: "listing-existing-rail-invalid" });
  }
  if (listing.pricing.kind !== "fixed" || options.rail.asset.kind !== "erc20" ||
      listing.pricing.price.currency !== options.rail.asset.symbol ||
      !within(listing.pricing.price.amount, options.maximumServiceAmount)) {
    return Object.freeze({ status: "fail", reasonCode: "listing-existing-price-invalid" });
  }
  const facts = Object.freeze({
    listingRef: options.listingRef,
    logicalAddress,
    listingContentHash,
    listingId: listing.listingId,
    listingVersion: listing.listingVersion,
    seller: options.sellerAuthority,
    railId: options.rail.railId,
    railVersion: options.rail.railVersion,
    network: options.network,
    asset: options.rail.asset.symbol,
    amount: listing.pricing.price.amount,
    payee: options.sellerPayee.toLowerCase(),
  });
  return Object.freeze({
    status: "verified",
    admission: Object.freeze({
      listingRef: options.listingRef,
      logicalAddress,
      listingContentHash,
      listing: validation.listing!,
      rail: options.rail,
      facts,
    }),
  });
}

export async function inspectDacsX402ExistingListingV1(
  options: Readonly<DacsX402ExistingListingResolutionOptionsV1>,
): Promise<Readonly<DacsLiveDoctorProbeResultV1>> {
  const result = await resolveDacsX402ExistingListingV1(options);
  return result.status === "verified"
    ? Object.freeze({ status: "pass" as const, facts: result.admission.facts })
    : result;
}

/**
 * Report the exact buyer-side cost boundary for the admitted v1 x402 profile.
 * The buyer signs a gasless authorization and the facilitator broadcasts the
 * Base transaction, so the buyer's direct EVM gas debit is exactly zero. Demos
 * publication fees remain a separate doctor budget and are never folded into
 * the service asset or described as ETH gas.
 */
export function inspectDacsX402PurchaseCostV1(
  options: Readonly<DacsX402PurchaseCostInspectionOptionsV1>,
): Readonly<DacsLiveDoctorProbeResultV1> {
  if (options === null || typeof options !== "object" ||
      options.admission === null || typeof options.admission !== "object" ||
      !isAuthenticatedRailDefinition(options.admission.rail) ||
      getAuthenticatedRailProvenance(options.admission.rail) === null ||
      typeof options.maximumServiceAmount !== "string" ||
      typeof options.maximumNetworkFeeEth !== "string") {
    throw new TypeError("x402 purchase cost inspection options are invalid");
  }
  const serviceCeiling = decimalValue(options.maximumServiceAmount);
  const networkCeiling = decimalValue(options.maximumNetworkFeeEth);
  const listing = options.admission.listing;
  if (serviceCeiling === undefined || networkCeiling === undefined ||
      listing.pricing.kind !== "fixed" ||
      contentHash(listing as unknown as Record<string, unknown>) !==
        options.admission.listingContentHash ||
      options.admission.rail.railType !== "x402" ||
      options.admission.rail.phaseHandler !== "pay-x402" ||
      options.admission.rail.availability !== "live") {
    return Object.freeze({ status: "fail", reasonCode: "x402-cost-context-invalid" });
  }
  if (!within(listing.pricing.price.amount, options.maximumServiceAmount)) {
    return Object.freeze({ status: "fail", reasonCode: "x402-service-cost-ceiling-exceeded" });
  }
  return Object.freeze({
    status: "pass",
    facts: Object.freeze({
      serviceAsset: listing.pricing.price.currency,
      estimatedServiceAmount: listing.pricing.price.amount,
      maximumServiceAmount: options.maximumServiceAmount,
      estimatedBuyerNetworkFeeEth: "0",
      networkFeeSafetyMarginEth: "0",
      maximumNetworkFeeEth: options.maximumNetworkFeeEth,
      facilitatorBroadcast: true,
      demosFeesReportedSeparately: true,
    }),
  });
}

/**
 * Validate the exact public Listing draft admitted by generated live setup.
 * The authenticated rail brand cannot be recreated from config or JSON, so a
 * draft never acquires payment authority merely by repeating a rail ID.
 */
export function inspectDacsX402ListingDraftV1(
  options: Readonly<DacsX402ListingDraftInspectionOptionsV1>,
): Readonly<DacsLiveDoctorProbeResultV1> {
  if (options === null || typeof options !== "object" ||
      typeof options.sellerAuthority !== "string" ||
      !(options.sellerPublicKey instanceof Uint8Array) ||
      options.sellerPublicKey.byteLength !== 32 ||
      typeof options.sellerPublicEndpoint !== "string" ||
      !EVM_ADDRESS_RE.test(options.sellerPayee) ||
      !/^eip155:[1-9][0-9]*$/.test(options.network) ||
      typeof options.maximumServiceAmount !== "string" ||
      !Number.isSafeInteger(options.now) || options.now < 0) {
    throw new TypeError("x402 Listing draft inspection options are invalid");
  }
  const authorityKey = canonicalDemosAgentPublicKey(options.sellerAuthority);
  if (authorityKey === null || !Buffer.from(authorityKey).equals(options.sellerPublicKey) ||
      !isAuthenticatedRailDefinition(options.rail) ||
      getAuthenticatedRailProvenance(options.rail) === null) {
    throw new TypeError("x402 Listing draft inspection authority is invalid");
  }
  let draft: unknown;
  try {
    draft = JSON.parse(canonicalize(options.draft));
  } catch {
    return Object.freeze({ status: "fail", reasonCode: "listing-candidate-not-canonical" });
  }
  if (!isListingDraft(draft)) {
    return Object.freeze({ status: "fail", reasonCode: "listing-candidate-schema-invalid" });
  }
  if (!primaryIdentityValid(draft, options.sellerAuthority, options.sellerPublicKey)) {
    return Object.freeze({ status: "fail", reasonCode: "listing-candidate-identity-invalid" });
  }
  if (!exactPublicUrl(draft.seller.publicEndpoint, options.sellerPublicEndpoint)) {
    return Object.freeze({ status: "fail", reasonCode: "listing-candidate-endpoint-invalid" });
  }
  if (options.rail.railType !== "x402" || options.rail.phaseHandler !== "pay-x402" ||
      options.rail.availability !== "live" || !listingRailValid(draft, options)) {
    return Object.freeze({ status: "fail", reasonCode: "listing-candidate-rail-invalid" });
  }
  if (draft.pricing.kind !== "fixed" || options.rail.asset.kind !== "erc20" ||
      draft.pricing.price.currency !== options.rail.asset.symbol ||
      !within(draft.pricing.price.amount, options.maximumServiceAmount)) {
    return Object.freeze({ status: "fail", reasonCode: "listing-candidate-price-invalid" });
  }
  if (options.now < draft.validity.notBefore ||
      (draft.validity.notAfter !== undefined && options.now > draft.validity.notAfter)) {
    return Object.freeze({ status: "blocked", reasonCode: "listing-candidate-not-live" });
  }
  return Object.freeze({
    status: "pass",
    facts: Object.freeze({
      candidateHash: contentHash(draft as unknown as Record<string, unknown>),
      listingId: draft.listingId,
      listingVersion: draft.listingVersion,
      railId: options.rail.railId,
      railVersion: options.rail.railVersion,
      asset: options.rail.asset.symbol,
      amount: draft.pricing.price.amount,
      payee: options.sellerPayee.toLowerCase(),
    }),
  });
}
