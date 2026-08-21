import {
  getAuthenticatedRailProvenance,
  isAuthenticatedRailDefinition,
  type AuthenticatedRailDefinition,
} from "@kynesyslabs/dacs";
import { isListingDraft, type ListingDraft } from "@kynesyslabs/dacs/artifacts";
import { canonicalize, canonicalizeDecimal, contentHash } from "@kynesyslabs/dacs/canonical";
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
  draft: Readonly<ListingDraft>,
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

function listingRailValid(
  draft: Readonly<ListingDraft>,
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
