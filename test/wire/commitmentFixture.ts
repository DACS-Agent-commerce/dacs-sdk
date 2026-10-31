// A committed purchase for the wire tests, made by the SDK's own commitment
// gate: a Listing, an Agreement both parties signed, and a finality commitment
// whose finalized receipt time the test chooses. As in TP-1 (G3), the seller
// is the orchestrator and signs the commitment. The anchor reader and the
// signature verifier are test-only; production installs authenticated ones.
// tp1Listing, signedAgreement and wireCommitment make the same evidence for a
// test's own parties and job: the seller's signed Listing (whose pin every
// continuation names), the Agreement and the commitment.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { TP1_APPROVED_IDENTITY_RECORD } from "../../src/wire/profile.js";
import type { CommitmentReceiptReader, ListingPin } from "../../src/wire/index.js";
import {
  commitFixedPriceAgreement, contentHash, deriveFixedPriceAgreement, ed25519Sign, ed25519Verify, privateKeyFromSeed,
  publicKeyFromSeed, rawPublicKey, signFixedPriceAgreement,
  type AgreementArtifact, type CommitmentSignatureVerifier, type FinalityCommitmentProvider, type FinalizedAgreementCommitment,
  type IdentityBundle, type Listing,
} from "../../src/index.js";

/** The test's SR-2 receipt reader: every receipt it is shown is authentic. Production reads the chain. */
export const validReceipt: CommitmentReceiptReader = Object.assign(() => "valid", { chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity });

/**
 * A commitment or Agreement as the exact bytes it is received as (CORE CF-5):
 * the wire admits each from bytes. `undefined` and `null` stay as they are.
 */
export const received = (value: unknown): unknown => (value === undefined || value === null ? value : Buffer.from(JSON.stringify(value), "utf8"));

/** The Listing commit phase TP-1 continues: the one tp1Listing's pipeline selects. */
export const COMMIT_PHASE = "commit-payee-bound-agreement";

/**
 * An Ed25519 key pair: random, or fixed by `seed` (the byte repeated as its
 * 32-byte seed). A test file's seller is fixed, so the pin of its signed
 * Listing is a module constant.
 */
export function ed25519KeyPair(seed?: number): { privateKey: KeyObject; publicKey: KeyObject } {
  if (seed === undefined) return generateKeyPairSync("ed25519");
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, seed)]), format: "der", type: "pkcs8" });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

/** A party with a fixed key, shaped like the tests' random parties. */
export function fixedParty(byte: number) {
  const { privateKey, publicKey } = ed25519KeyPair(byte);
  const key = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  return { claim: `did:demos:agent:${key}`, key, sign: (bytes: Uint8Array) => sign(null, Buffer.from(bytes), privateKey) };
}

/** A party whose one key signs its Agreement, its commitment record or its wire messages; `calls` counts wire signatures. */
export function seededParty(byte: number) {
  const seed = Uint8Array.from(Buffer.alloc(32, byte));
  const key = publicKeyFromSeed(seed);
  const raw = Buffer.from(rawPublicKey(key)).toString("hex");
  const signBytes = (bytes: Uint8Array) => ed25519Sign(bytes, privateKeyFromSeed(seed));
  return { raw, claim: `did:demos:agent:${raw}`, key, signBytes, calls: 0, sign(bytes: Uint8Array) { this.calls++; return signBytes(bytes); } };
}
export type SeededParty = ReturnType<typeof seededParty>;

const DEM = { railId: "demos-native:DEM", railVersion: 1 };
const identity = (claim: string, at: number): IdentityBundle => ({
  bundleVersion: "1", presentedBy: claim, presentedAt: at, claims: [{ ref: claim }],
  presentation: { kind: "per-claim", signatures: [{ ref: claim, signature: "identity-proof" }] },
});
const vet = (locator: string, digit: string) => ({ anchor: { kind: "storage-program" as const, locator }, contentHash: digit.repeat(64) });

/**
 * TP-1's deliverable: delivered by `deliver-storage-program` at
 * `dacs4:deliverable:{jobId}`, which validates `deliverableType ==
 * "storage-program"` (DACS-4 §9.6.1 step 1).
 */
const TP1_DELIVERABLE = Object.freeze({ kind: "storage-program" as const });

/** A Listing validity wide enough for every test clock in 2026. */
export const WIDE_VALIDITY = Object.freeze({ notBefore: Date.UTC(2026, 0, 1), notAfter: Date.UTC(2027, 0, 1) });

/**
 * The TP-1 fixed-price Listing `seller` signs (DACS-1 §6.3.4): negotiate
 * fixed price, commit a payee-bound Agreement, pay in DEM, deliver a storage-program
 * deliverable through Demos storage. Its pin is what every
 * request, Agreement and commitment for it names, and continuations are given
 * it as `signedListing`. `patch` changes members before it is signed.
 */
export function tp1Listing(options: {
  seller: SyncSigner; listingId?: string; validity?: { notBefore: number; notAfter?: number }; publicEndpoint?: string; patch?: Record<string, unknown>;
}): { listing: Listing; pin: ListingPin } {
  const validity = options.validity ?? WIDE_VALIDITY;
  const unsigned = {
    dacsVersion: "1", listingVersion: 1, listingId: options.listingId ?? "report",
    seller: { identity: identity(options.seller.claim, validity.notBefore), displayName: "Report", publicEndpoint: options.publicEndpoint ?? "https://seller.agreement.invalid" },
    offering: { title: "Report", description: "A fixed-text report", category: "data.test", tags: ["report"],
      deliverable: { ...TP1_DELIVERABLE } },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-payee-bound-agreement" }, { kind: "pay-dem", parameters: { rail: DEM.railId } }, { kind: "deliver-storage-program" }],
    pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } },
    acceptedRails: [DEM], terms: { deadlineSecAfterCommit: 600 }, validity: { ...validity },
    ...options.patch,
  } as Record<string, unknown>;
  const hash = contentHash(unsigned);
  const signature = { algorithm: "ed25519", signer: options.seller.claim, value: signNow(options.seller, Buffer.from(`dacs-listing:v1:${hash}`, "utf8")) };
  const listing = { ...unsigned, signature } as unknown as Listing;
  return { listing, pin: { listingId: listing.listingId, version: listing.listingVersion, contentHash: hash } };
}

export interface AcceptedPurchase {
  buyer: SeededParty;
  seller: SeededParty;
  /** TP-1's orchestrator: the seller itself (G3). */
  orchestrator: SeededParty;
  listing: Listing;
  pin: { listingId: string; version: number; contentHash: string };
  agreement: AgreementArtifact;
  /** The Agreement's hash, as the commitment gate computes it. */
  agreementHash: string;
}

/**
 * An Agreement for `jobId` that both parties signed at `generatedAt`. The
 * Listing's own validity is wide, so a commitment can finalize at any time a
 * test names; the wire's Listing reader gives the window it compares.
 */
export async function acceptedPurchase(options: { jobId: string; generatedAt: number; validity: { notBefore: number; notAfter: number }; publicEndpoint: string; listingId?: string }): Promise<AcceptedPurchase> {
  const buyer = seededParty(41), seller = seededParty(42), orchestrator = seller;
  const at = options.validity.notBefore;
  const unsigned = {
    dacsVersion: "1", listingVersion: 1, listingId: options.listingId ?? "report",
    seller: { identity: identity(seller.claim, at), displayName: "Report", publicEndpoint: options.publicEndpoint },
    offering: { title: "Report", description: "A fixed-text report", category: "data.test", tags: ["report"],
      deliverable: { ...TP1_DELIVERABLE } },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-payee-bound-agreement" }, { kind: "pay-dem", parameters: { rail: DEM.railId } }, { kind: "deliver-storage-program" }],
    pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } },
    acceptedRails: [DEM],
    terms: { deadlineSecAfterCommit: 600 },
    validity: options.validity,
  };
  // The seller signs the Listing (DACS-1 §6.3.4): the wire verifies that signature at every continuation.
  const listingHash = contentHash(unsigned as unknown as Record<string, unknown>);
  const listing = { ...unsigned, signature: { algorithm: "ed25519", signer: seller.claim,
    value: Buffer.from(seller.signBytes(Buffer.from(`dacs-listing:v1:${listingHash}`, "utf8"))).toString("base64url") } } as unknown as Listing;
  const pin = { listingId: listing.listingId, version: listing.listingVersion, contentHash: listingHash };
  const draft = deriveFixedPriceAgreement({
    jobId: options.jobId, verifiedListing: { disposition: "verified", listing, pin },
    buyer: { identityBundle: identity(buyer.claim, at), vetRecordRef: vet("buyer-vet", "a") },
    seller: { identityBundle: identity(seller.claim, at), vetRecordRef: vet("seller-vet", "b") },
    selectedRail: DEM,
    ...(listing.pipeline.some((phase) => phase.kind === "commit-payee-bound-agreement")
      ? { payoutBindings: listing.pipeline.flatMap((phase, phaseIndex) => phase.kind.startsWith("pay-")
          ? [{ railId: DEM.railId, phaseIndex, payeeAddress: listing.seller.identity.presentedBy.slice("did:demos:agent:".length) }] : []) } : {}),
    generatedAt: options.generatedAt,
  });
  const agreement = await signFixedPriceAgreement(draft,
    { party: buyer.claim, algorithm: "ed25519", sign: buyer.signBytes },
    { party: seller.claim, algorithm: "ed25519", sign: seller.signBytes });
  return { buyer, seller, orchestrator, listing, pin, agreement, agreementHash: contentHash(agreement as unknown as Record<string, unknown>) };
}

/** Commit the purchase with commitFixedPriceAgreement; its finalized receipt carries `committedAt`. */
export async function commitPurchase(p: AcceptedPurchase, committedAt: number): Promise<FinalizedAgreementCommitment> {
  const keys = new Map([p.buyer, p.seller, p.orchestrator].map((party) => [party.claim, party.key]));
  const verifySignature: CommitmentSignatureVerifier = (input) => {
    const key = keys.get(input.signer);
    if (!key || input.algorithm !== "ed25519") return "indeterminate";
    return ed25519Verify(input.signedBytes, Uint8Array.from(Buffer.from(input.value, "base64url")), key) ? "valid" : "invalid";
  };
  const provider: FinalityCommitmentProvider = {
    resolve: () => ({ disposition: "absent" }),
    submit: async (logicalAddress, record) => ({
      record, nativeAddress: "stor-commitment",
      anchorTxRef: { kind: "storage-program", address: "stor-commitment", writeTxHash: "c".repeat(64) },
      anchorReceipt: {
        receiptVersion: "1", substrate: "demos", finalityProfile: "demos-bft-final", logicalAddress,
        nativeAddress: "stor-commitment", contentHash: contentHash(record as unknown as Record<string, unknown>),
        transactionRef: { kind: "demos", value: "commitment-write-tx" }, writer: "demos-writer", nonce: "1",
        state: "finalized", observationDisposition: "established", observedAt: committedAt + 1000,
        blockRef: { id: "block-1", height: "1", timestamp: committedAt }, evidence: { kind: "demos-finality-proof", value: "proof-1" },
      },
    }),
    verifyAnchorReceipt: () => "valid",
  };
  const party = (role: "buyer" | "seller") => {
    const found = p.agreement.parties.find((x) => x.role === role)!;
    return { primaryClaim: found.primaryClaim, bundleHash: found.bundleHash, vetRecordRef: structuredClone(found.vetRecordRef) };
  };
  return commitFixedPriceAgreement({
    agreement: p.agreement, verifiedListing: { disposition: "verified", listing: p.listing, pin: p.pin },
    session: { jobId: p.agreement.jobId, listingRef: { ...p.pin }, phaseKind: "commit-payee-bound-agreement", orchestrator: p.orchestrator.claim, buyer: party("buyer"), seller: party("seller") },
    createdAt: p.agreement.generatedAt,
    commitmentSigner: { algorithm: "ed25519", signer: p.orchestrator.claim, sign: p.orchestrator.signBytes },
  }, provider, verifySignature);
}

type SyncSigner = { claim: string; signBytes?: (bytes: Uint8Array) => Uint8Array | Buffer; sign(bytes: Uint8Array): Uint8Array | Buffer | string | Promise<Uint8Array | string> };
const signNow = (party: SyncSigner, bytes: Uint8Array): string => {
  const value = (party.signBytes ?? party.sign.bind(party))(bytes);
  if (value instanceof Promise) throw new Error("signedAgreement needs a synchronous signer");
  return typeof value === "string" ? value : Buffer.from(value).toString("base64url");
};

/**
 * An exact fixed-price Agreement for any job, Listing pin and parties, signed
 * by `signers` (default: the buyer and the seller). It is derived from the
 * seller's tp1Listing as the SDK derives one, then names `listingPin` (that
 * Listing's pin, or another a test names) and is signed under
 * the artifact type's domain over its content hash.
 * `patch` changes the draft before it is signed.
 */
export function signedAgreement(options: {
  buyer: SyncSigner; seller: SyncSigner; jobId: string; listingPin: ListingPin; generatedAt?: number;
  signers?: { buyer: SyncSigner; seller: SyncSigner }; patch?: Record<string, unknown>;
  /** The Listing to derive from (default: the seller's tp1Listing for the pin's id). */
  listing?: { listing: Listing; pin: ListingPin };
}): { agreement: AgreementArtifact; agreementHash: string } {
  // A minute before the tests' clock: the commitments they make finalize after it (generatedAt <= committedAt).
  const at = options.generatedAt ?? Date.UTC(2026, 9, 18) - 60_000;
  // The seller's tp1Listing for the pin's id: with the pin it gives, the Agreement names exactly that Listing.
  const { listing, pin } = options.listing ?? tp1Listing({ seller: options.seller, listingId: options.listingPin.listingId });
  const draft = deriveFixedPriceAgreement({
    jobId: options.jobId, verifiedListing: { disposition: "verified", listing, pin },
    buyer: { identityBundle: identity(options.buyer.claim, at), vetRecordRef: vet("buyer-vet", "a") },
    seller: { identityBundle: identity(options.seller.claim, at), vetRecordRef: vet("seller-vet", "b") },
    selectedRail: DEM,
    ...(listing.pipeline.some((phase) => phase.kind === "commit-payee-bound-agreement")
      ? { payoutBindings: listing.pipeline.flatMap((phase, phaseIndex) => phase.kind.startsWith("pay-")
          ? [{ railId: DEM.railId, phaseIndex, payeeAddress: listing.seller.identity.presentedBy.slice("did:demos:agent:".length) }] : []) } : {}),
    generatedAt: at,
  });
  const unsigned = { ...draft, listingRef: { ...options.listingPin }, ...options.patch } as Record<string, unknown>;
  const agreementHash = contentHash(unsigned);
  const domain = "agreementVersion" in unsigned ? "dacs-agreement:v1:" : "dacs-payee-bound-agreement:v1:";
  const bytes = Buffer.from(`${domain}${agreementHash}`, "utf8");
  const signers = options.signers ?? { buyer: options.buyer, seller: options.seller };
  const agreement = { ...unsigned, signatures: [
    { party: options.buyer.claim, algorithm: "ed25519", value: signNow(signers.buyer, bytes) },
    { party: options.seller.claim, algorithm: "ed25519", value: signNow(signers.seller, bytes) },
  ] } as unknown as AgreementArtifact;
  return { agreement, agreementHash };
}

/**
 * A finality commitment for any job, Agreement hash and Listing pin, as data
 * in the shape commitFixedPriceAgreement returns: its record signed by
 * `seller` (TP-1's orchestrator) and a finalized receipt at `committedAt`.
 * For seller-side tests whose Agreement is a literal hash. `patch` changes the
 * record before it is signed, `receipt` the receipt after.
 */
export function wireCommitment(options: {
  seller: { claim: string; sign(bytes: Uint8Array): Uint8Array | string | Promise<Uint8Array | string> };
  buyer: string; jobId: string; agreementHash: string; listingPin: ListingPin; committedAt: number;
  signer?: string; patch?: Record<string, unknown>; receipt?: Record<string, unknown>;
}) {
  const unsigned = {
    finalityCommitmentVersion: "1", jobId: options.jobId, agreementHash: options.agreementHash, listingRef: { ...options.listingPin },
    parties: [options.buyer, options.seller.claim], pattern: "fixed-price", createdAt: options.committedAt - 1000, ...options.patch,
  };
  const hash = contentHash(unsigned as Record<string, unknown>);
  const signature = options.seller.sign(Buffer.from(`dacs-finality-commitment:v1:${hash}`, "utf8"));
  if (signature instanceof Promise) throw new Error("wireCommitment needs a synchronous signer");
  const value = typeof signature === "string" ? signature : Buffer.from(signature).toString("base64url");
  const record = { ...unsigned, signature: { algorithm: "ed25519", signer: options.signer ?? options.seller.claim, value } };
  const logicalAddress = `dacs3:commit:${options.jobId}`;
  const anchorReceipt = {
    receiptVersion: "1", substrate: "demos", finalityProfile: "demos-bft-final", logicalAddress,
    nativeAddress: "stor-commitment", contentHash: contentHash(record as Record<string, unknown>),
    transactionRef: { kind: "demos", value: "commitment-write-tx" }, writer: "demos-writer", nonce: "1",
    state: "finalized", observationDisposition: "established", observedAt: options.committedAt + 1000,
    blockRef: { id: "block-1", height: "1", timestamp: options.committedAt }, evidence: { kind: "demos-finality-proof", value: "proof-1" },
    ...options.receipt,
  };
  return {
    logicalAddress, nativeAddress: "stor-commitment", agreementHash: options.agreementHash,
    anchorTxRef: { kind: "storage-program", address: "stor-commitment", writeTxHash: "c".repeat(64) },
    anchorReceipt, committedAt: options.committedAt, resumed: false, recordKind: "finality", record,
  };
}
