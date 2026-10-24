import { contentHash } from "../../src/canonical/hash.js";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "../../src/crypto/index.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import { isPayeeBoundAgreementDocument } from "../../src/artifacts/validators.js";
import type { IdentityBundle, Listing, PayeeBoundAgreementDocument } from "../../src/artifacts/types.js";
import { deriveFixedPriceAgreement, signFixedPriceAgreement } from "../../src/negotiate/fixedPrice.js";
import { FINALITY_COMMITMENT_SEPARATOR } from "../../src/negotiate/commitment.js";
import * as wire from "../../src/wire/index.js";
import { fixtureBinder } from "./authorityFixture.js";

export const NOW = 1_780_000_000_000;
export const COMMITTED_AT = NOW + 2_000;
export const JOB = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
export const BUYER_SEED = Uint8Array.from(Buffer.alloc(32, 41));
export const SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 42));
const claim = (seed: Uint8Array) => `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
export const BUYER = claim(BUYER_SEED);
export const SELLER = claim(SELLER_SEED);
export const hash = (value: object) => contentHash({ ...value });
export const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
export function signature(value: object, domain: string, seed = SELLER_SEED, signer = SELLER) {
  return { algorithm: "ed25519" as const, signer,
    value: Buffer.from(ed25519Sign(Buffer.from(`${domain}${hash(value)}`), privateKeyFromSeed(seed))).toString("base64url") };
}
const identity = (primaryClaim: string): IdentityBundle => ({
  bundleVersion: "1", presentedBy: primaryClaim, presentedAt: NOW - 10_000,
  claims: [{ ref: primaryClaim }], presentation: { kind: "per-claim", signatures: [{ ref: primaryClaim, signature: "test-identity-proof" }] },
});

export async function committedPurchase(changeListing: (listing: Listing) => void = () => {}) {
  const rail = { railId: "dem:testnet", railVersion: 1 };
  const listing: Listing = {
    dacsVersion: "1", listingVersion: 1, listingId: "wire-committed-purchase",
    seller: { identity: identity(SELLER), displayName: "Test seller", publicEndpoint: "https://seller.invalid/dacs" },
    offering: { title: "Test purchase", description: "Deterministic committed evidence", category: "data.test", tags: [], deliverable: { kind: "storage-program" } },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-payee-bound-agreement" },
      { kind: "pay-dem", parameters: { rail: rail.railId } }, { kind: "deliver-storage-program" }],
    pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } }, acceptedRails: [rail],
    terms: { deadlineSecAfterCommit: 600 }, validity: { notBefore: NOW - 60_000, notAfter: NOW + 60_000 },
    signature: { algorithm: "ed25519", signer: SELLER, value: Buffer.alloc(64).toString("base64url") },
  };
  changeListing(listing);
  listing.signature = signature(listing, ARTIFACT_SEPARATORS.Listing, SELLER_SEED, listing.signature.signer);
  const pin = { listingId: listing.listingId, version: listing.listingVersion, contentHash: hash(listing) };
  const party = (primaryClaim: string) => ({ identityBundle: identity(primaryClaim),
    vetRecordRef: { anchor: { kind: "storage-program" as const, locator: "test-vet" }, contentHash: "a".repeat(64) } });
  const draft = deriveFixedPriceAgreement({ jobId: JOB, verifiedListing: { disposition: "verified", listing, pin },
    buyer: party(BUYER), seller: party(SELLER), selectedRail: rail, generatedAt: NOW,
    payoutBindings: [{ railId: rail.railId, phaseIndex: 2, payeeAddress: SELLER }] });
  const signed = await signFixedPriceAgreement(draft,
    { party: BUYER, algorithm: "ed25519", sign: (input) => ed25519Sign(input, privateKeyFromSeed(BUYER_SEED)) },
    { party: SELLER, algorithm: "ed25519", sign: (input) => ed25519Sign(input, privateKeyFromSeed(SELLER_SEED)) });
  if (!isPayeeBoundAgreementDocument(signed)) throw new Error("fixture must be payee-bound");
  const agreement: PayeeBoundAgreementDocument = signed;
  const record = { finalityCommitmentVersion: "1", jobId: JOB, agreementHash: hash(agreement), listingRef: pin,
    parties: [BUYER, SELLER], pattern: "fixed-price", createdAt: NOW + 1_000,
    signature: { algorithm: "ed25519", signer: SELLER, value: "" } };
  record.signature = signature(record, FINALITY_COMMITMENT_SEPARATOR);
  const anchored = { record, nativeAddress: "test-commitment-address",
    anchorTxRef: { kind: "storage-program", address: "test-commitment-address", writeTxHash: "b".repeat(64) },
    anchorReceipt: { receiptVersion: "1", substrate: "demos", finalityProfile: "demos-bft-confirmed-native-read",
      logicalAddress: `dacs3:commit:${JOB}`, nativeAddress: "test-commitment-address", contentHash: hash(record),
      transactionRef: { kind: "demos-storage-program", value: "test-write-transaction" }, writer: SELLER, nonce: "17",
      state: "finalized", observationDisposition: "established", observedAt: COMMITTED_AT + 1_000,
      blockRef: { id: "test-block", height: "100", timestamp: COMMITTED_AT }, evidence: { kind: "test-chain-proof", value: "test-proof" } } };
  const binding = await fixtureBinder(wire)({ record: wire.TP1_APPROVED_IDENTITY_RECORD,
    local: { endpoint: "https://rpc.identity.invalid/", transportAuthority: "test-transport", connectionId: "test-connection" } });
  const scope = { seller: SELLER, listingPin: pin, now: COMMITTED_AT, binding,
    request: { jobId: JOB, agreementHash: hash(agreement), buyer: BUYER } };
  return { listing, agreement, anchored, scope };
}
export type Purchase = Awaited<ReturnType<typeof committedPurchase>>;

export function resignAgreement(purchase: Purchase) {
  const { agreement, anchored, scope } = purchase;
  agreement.signatures = [[BUYER, BUYER_SEED], [SELLER, SELLER_SEED]].map(([party, seed]) => {
    if (typeof party !== "string" || !(seed instanceof Uint8Array)) throw new Error("fixture signer invalid");
    const signed = signature(agreement, ARTIFACT_SEPARATORS.PayeeBoundAgreementDocument, seed, party);
    return { party, algorithm: signed.algorithm, value: signed.value };
  });
  anchored.record.agreementHash = hash(agreement);
  scope.request.agreementHash = hash(agreement);
  resignRecord(purchase);
}
export function resignRecord({ anchored }: Purchase) {
  anchored.record.signature = signature(anchored.record, FINALITY_COMMITMENT_SEPARATOR);
  anchored.anchorReceipt.contentHash = hash(anchored.record);
}
