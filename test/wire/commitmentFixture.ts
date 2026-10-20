// A committed purchase for the wire tests, made by the SDK's own commitment
// gate: a Listing, an Agreement both parties signed, and a finality commitment
// whose finalized receipt time the test chooses. As in TP-1 (G3), the seller
// is the orchestrator and signs the commitment. The anchor reader and the
// signature verifier are test-only; production installs authenticated ones.
import type { CommitmentReceiptReader, ListingPin } from "../../src/wire/index.js";
import {
  commitFixedPriceAgreement, contentHash, deriveFixedPriceAgreement, ed25519Sign, ed25519Verify, privateKeyFromSeed,
  publicKeyFromSeed, rawPublicKey, signFixedPriceAgreement,
  type AgreementArtifact, type CommitmentSignatureVerifier, type FinalityCommitmentProvider, type FinalizedAgreementCommitment,
  type IdentityBundle, type Listing,
} from "../../src/index.js";

/** The test's SR-2 receipt reader: every receipt it is shown is authentic. Production reads the chain. */
export const validReceipt: CommitmentReceiptReader = () => "valid";

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
  const listing: Listing = {
    dacsVersion: "1", listingVersion: 1, listingId: options.listingId ?? "report",
    seller: { identity: identity(seller.claim, at), displayName: "Report", publicEndpoint: options.publicEndpoint },
    offering: { title: "Report", description: "A fixed-text report", category: "data.test", tags: ["report"],
      deliverable: { kind: "attested-payload", payloadFormat: "text/plain", verificationMethod: { kind: "self-signed" } } },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "pay-dem", parameters: { rail: DEM.railId } }, { kind: "deliver-storage-program" }],
    pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } },
    acceptedRails: [DEM],
    terms: { deadlineSecAfterCommit: 600 },
    validity: options.validity,
    signature: { algorithm: "ed25519", signer: seller.claim, value: Buffer.alloc(64, 7).toString("base64url") },
  };
  const pin = { listingId: listing.listingId, version: listing.listingVersion, contentHash: contentHash(listing as unknown as Record<string, unknown>) };
  const draft = deriveFixedPriceAgreement({
    jobId: options.jobId, verifiedListing: { disposition: "verified", listing, pin },
    buyer: { identityBundle: identity(buyer.claim, at), vetRecordRef: vet("buyer-vet", "a") },
    seller: { identityBundle: identity(seller.claim, at), vetRecordRef: vet("seller-vet", "b") },
    selectedRail: DEM, generatedAt: options.generatedAt,
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
        receiptVersion: "1", substrate: "demos:testnet", finalityProfile: "demos-bft-final", logicalAddress,
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
    session: { jobId: p.agreement.jobId, listingRef: { ...p.pin }, phaseKind: "commit-agreement", orchestrator: p.orchestrator.claim, buyer: party("buyer"), seller: party("seller") },
    createdAt: p.agreement.generatedAt,
    commitmentSigner: { algorithm: "ed25519", signer: p.orchestrator.claim, sign: p.orchestrator.signBytes },
  }, provider, verifySignature);
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
    receiptVersion: "1", substrate: "demos:testnet", finalityProfile: "demos-bft-final", logicalAddress,
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
