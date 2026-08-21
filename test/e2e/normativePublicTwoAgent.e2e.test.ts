import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";
import { verifyMessage, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Deterministic offline precursor to the guarded funded run in issue #114.
 * Every DACS commerce operation enters through the package root; only the
 * transport, storage, chain-reader, and signing adapters below are local.
 */
import {
  ARTIFACT_SEPARATORS,
  EIP3009_AUTHORIZATION_CANCELED_TOPIC,
  EIP3009_AUTHORIZATION_USED_TOPIC,
  ERC20_TRANSFER_TOPIC,
  advanceCompletedBuyerBundleDurable,
  advanceFixedPriceAgreementDurable,
  advanceX402BuyerSettlement,
  attestationBundleHash,
  buildTwoSidedBundle,
  bundleAddress,
  bundleConsistency,
  canonicalize,
  commitFixedPriceAgreement,
  contentHash,
  createFixedPriceAgreementSigningPlan,
  createFsFencedSessionStore,
  createFsSellerReceiptStore,
  createFsX402BuyerSettlementStore,
  createFsX402PaywallSettlementStore,
  createX402BuyerEvmAuthorizationProvider,
  createX402BuyerPaidRequestTransport,
  createX402SellerSpine,
  deriveFixedPriceAgreement,
  discoverListings,
  ed25519Sign,
  ed25519Verify,
  encodeAddressSegment,
  finalityCommitmentAddress,
  finalizeCompletedSellerBundleDurable,
  finalizeCompletedSellerBundleCore,
  getSellerFulfilmentStatus,
  identityBundleHash,
  listingAddress,
  prepareX402BuyerSettlement,
  prepareCompletedSellerBundleCounterSignatureRequest,
  projectDurableSellerAuditPending,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  publishListingCore,
  publishSellerSessionSettlement,
  rawPublicKey,
  respondToFixedPriceAgreementProposalDurable,
  sha256Hex,
  signedBytes,
  validateListingArtifact,
  verifyBundleCopy,
  verifyCompletedSellerBundleCounterSignatureRequest,
  verifyDurableSellerTerminalResult,
  verifyFinalizedSessionSettlement,
  x402Eip3009Nonce,
  x402PaywallCore,
  type AgreementArtifact,
  type AnchorBinding,
  type ProtocolAnchorReceipt as AnchorReceipt,
  type AnchoredFinalityCommitment,
  type AnchoredBuyerBundle,
  type AnchoredSellerBundle,
  type AttestationRef,
  type BundleSignature,
  type BuyerBundleEffectFence,
  type BuyerBundleFinalizationDurability,
  type CommittedAgreementResolution,
  type CommitmentSignatureVerifier,
  type CompositeVerificationRecord,
  type DurableSellerFulfilmentDeps,
  type DurableBuyerBundleFinalizationInput,
  type DurableBuyerBundleFinalizationProvider,
  type DurableFixedPriceAgreementDurability,
  type DurableFixedPriceAgreementInput,
  type DurableSellerFixedPriceAgreementDurability,
  type FinalityCommitmentProvider,
  type FinalityCommitmentRecord,
  type FaultAttestationBundle,
  type FinalizeCompletedSellerBundleInput,
  type FinalizeCompletedSellerBundleDurableInput,
  type FixedPriceAgreementProposal,
  type FixedPriceAgreementSignatureContribution,
  type FixedPriceAgreementTransportIdentity,
  type IdentityBundle,
  type Listing,
  type ListingDraft,
  type ListingValidationDeps,
  type PaymentRailRef,
  type SellerDeliveredArtifact,
  type SellerFinalSessionReceiptResult,
  type SellerFulfilmentAgreement,
  type SellerFulfilmentDurability,
  type SellerFulfilmentListing,
  type SellerFulfilmentResult,
  type SellerFulfilmentSessionRecord,
  type SellerListingAtCommitResolution,
  type DurableSellerBundleFinalizationProvider,
  type SellerBundleEffectFence,
  type SellerBundleFinalizationDurability,
  type SellerPaymentAuthorization,
  type SellerPaymentIntakeDeps,
  type SellerSessionSettlementPublicationDeps,
  type SellerX402RailDefinition,
  type SettlementEvidence,
  type SignedSellerDeliveryEvidence,
  type SellerSessionSettlementNativeProofAuthentication,
  type SessionSettlementContext,
  type SessionSettlementNativeProofRef,
  type SessionSettlementVerificationProvider,
  type X402BuyerChallengeClient,
  type X402BuyerEvmLog,
  type X402BuyerEvmAuthorizationState,
  type X402BuyerEvmBlockAncestry,
  type X402BuyerEvmFinalityHead,
  type X402BuyerEvmReadClient,
  type X402BuyerEvmTransactionReceipt,
  type X402BuyerSettlementIntent,
  type X402PaywallExpectedTerms,
  type X402PaywallHttpAdapter,
  type X402PaywallPaymentPayload,
  type X402PaywallPaymentRequirements,
  type X402PaywallResult,
  type X402PaywallSettlementResult,
  type X402SellerCommittedSessionScope,
  type X402SellerPaymentPermitAuthorization,
  type X402TransferObservation,
} from "../../src/index.js";

const NOW = 1_790_000_000_000;
const JOB_ID = "01JZ0000000000000000000114";
const SELLER_MISMATCH_JOB_ID = "01JZ0000000000000000000115";
const MISSING_COSIGNATURE_JOB_ID = "01JZ0000000000000000000116";
const PAYMENT_PHASE_INDEX = 2;
const DELIVERY_PHASE_INDEX = 3;
const CHAIN_ID = 84_532;
const NETWORK = `eip155:${CHAIN_ID}` as const;
const BUYER_EVM_KEY = `0x${"01".repeat(32)}` as const;
const BUYER_EVM = privateKeyToAccount(BUYER_EVM_KEY);
const PAYER = BUYER_EVM.address;
const PAYEE = `0x${"22".repeat(20)}` as const;
const ASSET = `0x${"33".repeat(20)}` as const;
const AMOUNT_BASE_UNITS = "2500000";
const TX_HASH = `0x${"ab".repeat(32)}` as const;
const BLOCK_HASH = `0x${"bc".repeat(32)}` as const;
const PENDING_HEAD_HASH = `0x${"ce".repeat(32)}` as const;
const HEAD_HASH = `0x${"cd".repeat(32)}` as const;
const ENGAGEMENT_ENDPOINT = "https://local.seller.test/dacs/engage";
const HTTP_RESOURCE = `https://seller.example/deliver/${JOB_ID}`;
const PROCESS_STAGE = process.env.DACS_ISSUE114_PROCESS_STAGE?.trim();

const BUYER_SEED = new Uint8Array(32).fill(91);
const SELLER_SEED = new Uint8Array(32).fill(92);

const claimFor = (seed: Uint8Array): string =>
  `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;

const BUYER = claimFor(BUYER_SEED);
const SELLER = claimFor(SELLER_SEED);

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dacs-${name}-`));
  tempDirs.push(dir);
  return dir;
}

async function filesBelow(dir: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(path.slice(dir.length + 1));
    }
  };
  await visit(dir);
  return files.sort();
}

async function writeExternalRecord(
  dir: string,
  key: string,
  value: unknown,
): Promise<void> {
  await writeFile(
    join(dir, `${sha256Hex(key)}.json`),
    JSON.stringify(value, (_name, candidate: unknown) =>
      candidate instanceof Uint8Array
        ? { "$dacs-test-bytes": Buffer.from(candidate).toString("base64url") }
        : candidate),
    "utf8",
  );
}

async function readExternalRecord<T>(
  dir: string,
  key: string,
): Promise<T | undefined> {
  try {
    return JSON.parse(
      await readFile(join(dir, `${sha256Hex(key)}.json`), "utf8"),
      (_name, candidate: unknown) => {
        if (
          candidate !== null &&
          typeof candidate === "object" &&
          Object.keys(candidate).length === 1 &&
          typeof (candidate as Record<string, unknown>)["$dacs-test-bytes"] ===
            "string"
        ) {
          return Uint8Array.from(Buffer.from(
            (candidate as Record<string, string>)["$dacs-test-bytes"]!,
            "base64url",
          ));
        }
        return candidate;
      },
    ) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function identity(primaryClaim: string, evmClaim?: string): IdentityBundle {
  const claims = [
    { ref: primaryClaim },
    ...(evmClaim ? [{ ref: evmClaim }] : []),
  ];
  const bundle: IdentityBundle = {
    bundleVersion: "1",
    presentedBy: primaryClaim,
    presentedAt: NOW - 10_000,
    sessionNonce: `${JOB_ID}:${primaryClaim}`,
    claims,
    presentation: {
      kind: "per-claim",
      signatures: claims.map(({ ref }) => ({ ref, signature: "pending" })),
    },
  };
  const seed = primaryClaim === BUYER
    ? BUYER_SEED
    : primaryClaim === SELLER
      ? SELLER_SEED
      : null;
  if (seed && bundle.presentation.kind === "per-claim") {
    const signature = Buffer.from(ed25519Sign(
      signedBytes("dacs-bundle-presentation:v1:", identityBundleHash(bundle)),
      privateKeyFromSeed(seed),
    )).toString("base64url");
    bundle.presentation.signatures = claims.map(({ ref }) => ({ ref, signature }));
  }
  return bundle;
}

const BUYER_EVM_CLAIM = `cci-xm:evm:base-sepolia:${PAYER}`;
const BUYER_IDENTITY = identity(BUYER, BUYER_EVM_CLAIM);
if (BUYER_IDENTITY.presentation.kind !== "per-claim") {
  throw new Error("buyer fixture requires a per-claim presentation");
}
const buyerWalletPresentation = BUYER_IDENTITY.presentation.signatures.find(
  ({ ref }) => ref === BUYER_EVM_CLAIM,
);
if (!buyerWalletPresentation) {
  throw new Error("buyer fixture omitted its paying-wallet claim");
}
buyerWalletPresentation.signature = await BUYER_EVM.signMessage({
  message: {
    raw: signedBytes(
      "dacs-bundle-presentation:v1:",
      identityBundleHash(BUYER_IDENTITY),
    ),
  },
});
const SELLER_IDENTITY = identity(SELLER);
const EMPTY_REQUIREMENT = { requirementVersion: "1" as const, required: [] };

async function verifyRoleIdentityPresentation(
  bundle: Readonly<IdentityBundle>,
  expectedPrimaryClaim: string,
  suppliedBytes?: Uint8Array,
): Promise<boolean> {
  try {
    const bytes = suppliedBytes ?? signedBytes(
      "dacs-bundle-presentation:v1:",
      identityBundleHash(bundle),
    );
    if (
      bundle.presentedBy !== expectedPrimaryClaim ||
      bundle.presentation.kind !== "per-claim" ||
      bundle.presentation.signatures.length !== bundle.claims.length
    ) {
      return false;
    }
    for (const [index, signature] of bundle.presentation.signatures.entries()) {
      const claim = bundle.claims[index]?.ref;
      if (signature.ref !== claim) return false;
      if (claim === expectedPrimaryClaim) {
        const seed = expectedPrimaryClaim === BUYER
          ? BUYER_SEED
          : expectedPrimaryClaim === SELLER
            ? SELLER_SEED
            : null;
        if (!seed || !ed25519Verify(
          bytes,
          Uint8Array.from(Buffer.from(signature.signature, "base64url")),
          publicKeyFromSeed(seed),
        )) {
          return false;
        }
        continue;
      }
      if (
        expectedPrimaryClaim !== BUYER ||
        claim !== BUYER_EVM_CLAIM ||
        !await verifyMessage({
          address: PAYER,
          message: { raw: bytes },
          signature: signature.signature as `0x${string}`,
        })
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function signedVetRecord(
  role: "buyer" | "seller",
): CompositeVerificationRecord {
  const party = role === "buyer" ? BUYER : SELLER;
  const bundle = role === "buyer" ? BUYER_IDENTITY : SELLER_IDENTITY;
  const unsigned = {
    recordVersion: "1" as const,
    jobId: JOB_ID,
    evaluatedParty: party,
    bundleHash: identityBundleHash(bundle),
    requirementHash: sha256Hex(canonicalize(EMPTY_REQUIREMENT)),
    freshness: [],
    supplementary: [],
    dealSpecific: [],
    overallDecision: "pass" as const,
    generatedAt: NOW - 5_000,
  };
  return {
    ...unsigned,
    signature: {
      algorithm: "ed25519",
      signer: SELLER,
      value: Buffer.from(ed25519Sign(
        signedBytes(
          ARTIFACT_SEPARATORS.CompositeVerificationRecord,
          contentHash(unsigned),
        ),
        privateKeyFromSeed(SELLER_SEED),
      )).toString("base64url"),
    },
  };
}

const BUYER_VET = signedVetRecord("buyer");
const SELLER_VET = signedVetRecord("seller");

const RAIL = {
  railId: "x402:base-sepolia",
  railVersion: 1,
  parameters: { network: NETWORK, httpResource: HTTP_RESOURCE },
} satisfies PaymentRailRef;

function listingDraft(): ListingDraft {
  return {
    dacsVersion: "1",
    listingVersion: 1,
    listingId: "issue-114-offline-listing",
    seller: {
      identity: structuredClone(SELLER_IDENTITY),
      displayName: "Issue 114 seller",
      publicEndpoint: ENGAGEMENT_ENDPOINT,
    },
    offering: {
      title: "Restart-safe deterministic result",
      description: "A deterministic public-API two-agent commerce run",
      category: "data.test",
      tags: ["issue-114", "offline"],
      deliverable: { kind: "storage-program", accessModel: "public" },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-payee-bound-agreement" },
      { kind: "pay-x402", parameters: { rail: RAIL.railId } },
      { kind: "deliver-storage-program" },
    ],
    pricing: { kind: "fixed", price: { amount: "2.5", currency: "USDC" } },
    acceptedRails: [structuredClone(RAIL)],
    terms: { deadlineSecAfterCommit: 3_600 },
    validity: { notBefore: NOW - 60_000, notAfter: NOW + 60_000 },
  };
}

function listingValidationDeps(): ListingValidationDeps {
  return {
    nowMs: () => NOW,
    verifyListingSignature: ({ signedBytes: bytes, signature }) =>
      signature.signer === SELLER && signature.algorithm === "ed25519" &&
      ed25519Verify(
        bytes,
        Uint8Array.from(Buffer.from(signature.value, "base64url")),
        publicKeyFromSeed(SELLER_SEED),
      ),
    revocation: {
      surfaces: [{ kind: "well-known", status: "active", integrity: "verified" }],
      readMarker: async () => null,
      verifyMarkerSignature: () => false,
    },
    verifyIdentityPresentation: ({ bundle, signedBytes: bytes }) =>
      verifyRoleIdentityPresentation(bundle, bundle.presentedBy, bytes),
    loadRailResolution: () => ({
      trustPhase: "PA-1",
      trustPolicyAcceptsPA1: true,
      registry: { state: "not-used", entries: [], definitions: [] },
      inCodeDefinitions: [{
        railId: RAIL.railId,
        railVersion: RAIL.railVersion,
        phaseHandler: "pay-x402",
        governanceAnchoring: "in-code",
        signatureValid: true,
      }],
    }),
    resolvePayloadVerificationCapability: () => ({ disposition: "supported" }),
    verifySellerControl: ({ bundle, signer }) =>
      signer === SELLER && bundle.presentedBy === SELLER &&
      identityBundleHash(bundle) === identityBundleHash(SELLER_IDENTITY),
  };
}

interface PublishedListing {
  listing: Listing;
  listingRef: string;
  listingPin: { listingId: string; version: number; contentHash: string };
  engagement: {
    observedEndpoints: string[];
    dispatch<T>(endpoint: string, operation: () => Promise<T>): Promise<T>;
  };
}

async function publishAndDiscoverListing(): Promise<PublishedListing> {
  const anchored = new Map<string, Record<string, unknown>>();
  const observedEndpoints: string[] = [];
  const engagement: PublishedListing["engagement"] = {
    observedEndpoints,
    async dispatch(endpoint, operation) {
      if (endpoint !== ENGAGEMENT_ENDPOINT) {
        throw new Error("agreement proposal did not use the pinned Listing endpoint");
      }
      observedEndpoints.push(endpoint);
      return operation();
    },
  };
  const published = await publishListingCore(listingDraft(), {
    sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
    scanOwnAnchorsByNamePrefix: async () => ({ status: "ok", anchors: [] }),
    writeArtifact: async (_logicalAddress, value, options) => {
      const address = `stor:${options.storageName}`;
      anchored.set(address, structuredClone(value));
      return { address, txRef: "listing-publication-tx" };
    },
    loadRailResolution: () => ({
      trustPhase: "PA-1",
      trustPolicyAcceptsPA1: true,
      registry: { state: "not-used", entries: [], definitions: [] },
      inCodeDefinitions: [{
        railId: RAIL.railId,
        railVersion: RAIL.railVersion,
        phaseHandler: "pay-x402",
        governanceAnchoring: "in-code",
        signatureValid: true,
      }],
    }),
    resolvePayloadVerificationCapability: () => ({ disposition: "supported" }),
  });

  const discovered = await discoverListings(
    [published.ref],
    async (ref) => anchored.get(ref) ?? null,
    {
      verify: (bytes, signature, publicKey) =>
        ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
      resolvePublicKey: (claim) => claim === SELLER
        ? rawPublicKey(publicKeyFromSeed(SELLER_SEED))
        : null,
      validateListing: (raw) => validateListingArtifact(raw, listingValidationDeps()),
      nowMs: () => NOW,
    },
  );
  expect(discovered).toHaveLength(1);
  const selected = discovered[0]!;
  expect(selected.compatibility).toBe("normative");
  if (selected.compatibility !== "normative") throw new Error("legacy Listing selected");
  expect(selected.listing.seller.publicEndpoint).toBe(
    ENGAGEMENT_ENDPOINT,
  );
  expect(published.listingPin).toEqual({
    listingId: selected.listing.listingId,
    version: selected.listing.listingVersion,
    contentHash: contentHash(selected.listing as unknown as Record<string, unknown>),
  });
  return {
    listing: selected.listing,
    listingRef: published.ref,
    listingPin: published.listingPin,
    engagement,
  };
}

function vetRef(role: "buyer" | "seller"): AttestationRef {
  const record = role === "buyer" ? BUYER_VET : SELLER_VET;
  const evaluatedParty = role === "buyer" ? BUYER : SELLER;
  return {
    anchor: {
      kind: "storage-program",
      locator: `dacs2:composite:${JOB_ID}:${encodeAddressSegment(evaluatedParty)}`,
    },
    contentHash: contentHash(record as unknown as Record<string, unknown>),
  };
}

function localReceiptSeed(writer: string): Uint8Array | null {
  if (writer === BUYER) return BUYER_SEED;
  if (writer === SELLER) return SELLER_SEED;
  return null;
}

function signedLocalReceipt(
  receipt: Omit<AnchorReceipt, "evidence">,
): AnchorReceipt {
  const seed = localReceiptSeed(receipt.writer);
  if (!seed) throw new Error("local receipt writer has no authenticated key");
  const signature = ed25519Sign(
    Buffer.from(canonicalize(receipt as unknown as Record<string, unknown>), "utf8"),
    privateKeyFromSeed(seed),
  );
  return {
    ...receipt,
    evidence: {
      kind: "test:ed25519-jcs",
      value: Buffer.from(signature).toString("base64url"),
    },
  };
}

function verifyLocalReceipt(receipt: Readonly<AnchorReceipt>): boolean {
  if (receipt.evidence.kind !== "test:ed25519-jcs") return false;
  const seed = localReceiptSeed(receipt.writer);
  if (!seed) return false;
  const { evidence, ...unsigned } = receipt;
  const decoded = Buffer.from(evidence.value, "base64url");
  if (decoded.length !== 64 || decoded.toString("base64url") !== evidence.value) {
    return false;
  }
  return ed25519Verify(
    Buffer.from(canonicalize(unsigned as unknown as Record<string, unknown>), "utf8"),
    Uint8Array.from(decoded),
    publicKeyFromSeed(seed),
  );
}

function agreementReceipt(
  logicalAddress: string,
  nativeAddress: string,
  hash: string,
): AnchorReceipt {
  return signedLocalReceipt({
    receiptVersion: "1",
    substrate: "test:offline",
    finalityProfile: "test-final",
    logicalAddress,
    nativeAddress,
    contentHash: hash,
    transactionRef: { kind: "test", value: `tx:${hash.slice(0, 16)}` },
    writer: BUYER,
    state: "finalized",
    observationDisposition: "established",
    observedAt: NOW + 1,
    blockRef: { id: "block:agreement", height: "10", timestamp: NOW },
  });
}

function contributionVerifier({
  role,
  algorithm,
  value,
  signedBytes: bytes,
}: {
  role: "buyer" | "seller";
  algorithm: string;
  value: string;
  signedBytes: Uint8Array;
}): "valid" | "invalid" {
  if (algorithm !== "ed25519") return "invalid";
  const key = role === "buyer"
    ? publicKeyFromSeed(BUYER_SEED)
    : publicKeyFromSeed(SELLER_SEED);
  return ed25519Verify(
    bytes,
    Uint8Array.from(Buffer.from(value, "base64url")),
    key,
  ) ? "valid" : "invalid";
}

interface AgreementRun {
  agreement: AgreementArtifact;
  agreementHash: string;
  agreementRef: AttestationRef;
  anchorReceipt: AnchorReceipt;
  effects: {
    buyerSign: number;
    sellerSign: number;
    proposal: number;
    contribution: number;
    engagement: number;
    anchor: number;
  };
}

async function negotiateAgreement(
  published: PublishedListing,
  buyerDir: string,
  sellerDir: string,
): Promise<AgreementRun> {
  const context = {
    jobId: JOB_ID,
    verifiedListing: {
      disposition: "verified" as const,
      listing: published.listing,
      pin: published.listingPin,
    },
    buyer: { identityBundle: BUYER_IDENTITY, vetRecordRef: vetRef("buyer") },
    seller: { identityBundle: SELLER_IDENTITY, vetRecordRef: vetRef("seller") },
    selectedRail: RAIL,
    payoutBindings: [{
      railId: RAIL.railId,
      phaseIndex: PAYMENT_PHASE_INDEX,
      payeeAddress: PAYEE,
    }],
    generatedAt: NOW,
  };
  const draft = deriveFixedPriceAgreement(context);
  const plan = createFixedPriceAgreementSigningPlan(draft);
  const effects = {
    buyerSign: 0,
    sellerSign: 0,
    proposal: 0,
    contribution: 0,
    engagement: 0,
    anchor: 0,
  };
  let buyerSignature: Uint8Array | undefined;
  let sellerSignature: Uint8Array | undefined;
  let publishedProposal: FixedPriceAgreementProposal | undefined;
  let sellerContribution: FixedPriceAgreementSignatureContribution | undefined;
  let anchored: {
    artifact: Record<string, unknown>;
    ref: AttestationRef;
    anchorReceipt: AnchorReceipt;
  } | undefined;
  let binding: AnchorBinding | undefined;

  const sellerDurability: DurableSellerFixedPriceAgreementDurability = {
    store: await createFsFencedSessionStore({ dir: sellerDir }),
    workerId: "seller-agreement-agent",
    leaseTtlMs: 1_000,
    leaseNowMs: () => NOW,
    resolveAuthenticatedAgreementContext: () => ({
      disposition: "present",
      value: structuredClone(context),
    }),
    verifyContribution: contributionVerifier,
    reconcileSellerSignature: () => sellerSignature
      ? { disposition: "present", value: Uint8Array.from(sellerSignature) }
      : { disposition: "absent", reason: "seller signature absent" },
    transport: {
      publishSellerContribution: (value, _identity, fence) => {
        effects.contribution += 1;
        sellerContribution = structuredClone(value);
        expect(fence.idempotencyKey.length).toBeGreaterThan(0);
        return { disposition: "submitted" as const };
      },
      reconcileSellerContributionPublication: () => sellerContribution
        ? { disposition: "present", value: structuredClone(sellerContribution) }
        : { disposition: "absent", reason: "seller contribution absent" },
    },
  };

  const input: DurableFixedPriceAgreementInput = {
    draft,
    buyer: {
      party: BUYER,
      algorithm: "ed25519",
      sign: async (bytes, _context, fence) => {
        expect(fence.idempotencyKey.length).toBeGreaterThan(0);
        effects.buyerSign += 1;
        buyerSignature = ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED));
        return Uint8Array.from(buyerSignature);
      },
    },
  };

  const buyerDurability: DurableFixedPriceAgreementDurability = {
    store: await createFsFencedSessionStore({ dir: buyerDir }),
    workerId: "buyer-agreement-agent",
    leaseTtlMs: 1_000,
    leaseNowMs: () => NOW,
    reconcileBuyerSignature: () => buyerSignature
      ? { disposition: "present", value: Uint8Array.from(buyerSignature) }
      : { disposition: "absent", reason: "buyer signature absent" },
    verifyContribution: contributionVerifier,
    transport: {
      publishProposal: async (proposal, identity, fence) => {
        expect(fence.idempotencyKey.length).toBeGreaterThan(0);
        effects.proposal += 1;
        publishedProposal = structuredClone(proposal);
        const endpoint = published.listing.seller.publicEndpoint;
        if (!endpoint) throw new Error("pinned Listing has no engagement endpoint");
        const response = await published.engagement.dispatch(endpoint, async () => {
          effects.engagement += 1;
          return respondToFixedPriceAgreementProposalDurable(
            {
              proposal,
              transportIdentity: identity,
              seller: {
                party: SELLER,
                algorithm: "ed25519",
                sign: async (bytes, _context, sellerFence) => {
                  expect(sellerFence.idempotencyKey.length).toBeGreaterThan(0);
                  effects.sellerSign += 1;
                  sellerSignature = ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED));
                  return Uint8Array.from(sellerSignature);
                },
              },
            },
            sellerDurability,
          );
        });
        if (response.disposition !== "complete") {
          throw new Error(`seller response did not complete: ${response.reason}`);
        }
        sellerContribution = structuredClone(response.result.sellerContribution);
        return { disposition: "submitted" };
      },
      reconcileProposalPublication: () => publishedProposal
        ? { disposition: "present", value: structuredClone(publishedProposal) }
        : { disposition: "absent", reason: "proposal absent" },
      resolveSellerContributions: () => sellerContribution
        ? { disposition: "present", value: [structuredClone(sellerContribution)] }
        : { disposition: "absent", reason: "seller contribution absent" },
    },
    anchor: {
      anchorAgreement: async (value, fence) => {
        expect(fence.idempotencyKey.length).toBeGreaterThan(0);
        effects.anchor += 1;
        const nativeAddress = `stor:agreement:${value.agreementHash.slice(0, 20)}`;
        anchored = {
          artifact: structuredClone(value.artifact),
          ref: {
            anchor: { kind: "storage-program", locator: value.logicalAddress },
            contentHash: value.agreementHash,
            signer: BUYER,
          },
          anchorReceipt: agreementReceipt(
            value.logicalAddress,
            nativeAddress,
            value.agreementHash,
          ),
        };
        return { disposition: "submitted" };
      },
      reconcileAgreementAnchor: () => anchored
        ? { disposition: "present", value: structuredClone(anchored) }
        : { disposition: "absent", reason: "agreement absent" },
      verifyAnchorReceipt: ({ expectedWriter, ref, receipt }) =>
        expectedWriter === BUYER &&
          ref.anchor.locator === receipt.logicalAddress &&
          ref.contentHash === receipt.contentHash &&
          receipt.writer === BUYER &&
          verifyLocalReceipt(receipt)
          ? "valid"
          : "invalid",
      publishBinding: async (value, fence) => {
        expect(fence.idempotencyKey.length).toBeGreaterThan(0);
        binding = structuredClone(value);
        return { disposition: "submitted" };
      },
      reconcileBindingPublication: () => binding
        ? { disposition: "present", value: structuredClone(binding) }
        : { disposition: "absent", reason: "binding absent" },
    },
  };

  const result = await advanceFixedPriceAgreementDurable(input, buyerDurability);
  if (result.disposition !== "anchored") {
    throw new Error(`${result.disposition}:${result.stage}:${result.reason}`);
  }

  buyerDurability.store = await createFsFencedSessionStore({ dir: buyerDir });
  sellerDurability.store = await createFsFencedSessionStore({ dir: sellerDir });
  const recoveredBuyer = await advanceFixedPriceAgreementDurable(input, buyerDurability);
  expect(recoveredBuyer).toEqual({ ...result, recovered: true });
  if (!publishedProposal) throw new Error("proposal was not retained");
  const transportIdentity = {
    jobId: draft.jobId,
    planHash: plan.planHash,
    agreementHash: plan.agreementHash,
    buyer: BUYER,
    seller: SELLER,
    proposalHash: publishedProposal.proposalHash,
  } satisfies FixedPriceAgreementTransportIdentity;
  const recoveredSeller = await respondToFixedPriceAgreementProposalDurable(
    {
      proposal: publishedProposal,
      transportIdentity,
      seller: {
        party: SELLER,
        algorithm: "ed25519",
        sign: () => {
          throw new Error("recovered seller must not sign twice");
        },
      },
    },
    sellerDurability,
  );
  expect(recoveredSeller).toMatchObject({ disposition: "complete", recovered: true });
  expect(effects).toEqual({
    buyerSign: 1,
    sellerSign: 1,
    proposal: 1,
    contribution: 1,
    engagement: 1,
    anchor: 1,
  });
  expect(published.engagement.observedEndpoints).toEqual([ENGAGEMENT_ENDPOINT]);
  return {
    agreement: result.result.agreement,
    agreementHash: result.result.agreementHash,
    agreementRef: result.result.agreementRef,
    anchorReceipt: result.result.anchorReceipt,
    effects,
  };
}

function commitmentReceipt(
  record: FinalityCommitmentRecord,
): AnchoredFinalityCommitment {
  const logicalAddress = finalityCommitmentAddress(record.jobId);
  const hash = contentHash(record as unknown as Record<string, unknown>);
  const nativeAddress = `stor:commitment:${hash.slice(0, 20)}`;
  return {
    record,
    nativeAddress,
    anchorTxRef: {
      kind: "storage-program",
      address: nativeAddress,
      writeTxHash: "d".repeat(64),
    },
    anchorReceipt: signedLocalReceipt({
      ...(() => {
        const { evidence: _evidence, ...receipt } = agreementReceipt(
          logicalAddress,
          nativeAddress,
          hash,
        );
        return receipt;
      })(),
      writer: SELLER,
      observedAt: NOW + 2_000,
      blockRef: { id: "block:commitment", height: "11", timestamp: NOW + 1_000 },
    }),
  };
}

async function commitAgreement(
  published: PublishedListing,
  agreement: AgreementRun,
) {
  let retained: AnchoredFinalityCommitment | undefined;
  let submissions = 0;
  const provider: FinalityCommitmentProvider = {
    resolve: () => retained
      ? { disposition: "present", anchored: structuredClone(retained) }
      : { disposition: "absent" },
    submit: async (_logicalAddress, record) => {
      submissions += 1;
      retained = commitmentReceipt(record);
      return structuredClone(retained);
    },
    verifyAnchorReceipt: (anchored) =>
      verifyLocalReceipt(anchored.anchorReceipt) ? "valid" : "invalid",
  };
  const keys = new Map([
    [BUYER, publicKeyFromSeed(BUYER_SEED)],
    [SELLER, publicKeyFromSeed(SELLER_SEED)],
  ]);
  const verify: CommitmentSignatureVerifier = (request) => {
    const key = keys.get(request.signer);
    if (!key || request.algorithm !== "ed25519") return "indeterminate";
    return ed25519Verify(
      request.signedBytes,
      Uint8Array.from(Buffer.from(request.value, "base64url")),
      key,
    ) ? "valid" : "invalid";
  };
  const input = {
    agreement: structuredClone(agreement.agreement),
    verifiedListing: {
      disposition: "verified" as const,
      listing: structuredClone(published.listing),
      pin: structuredClone(published.listingPin),
    },
    session: {
      jobId: JOB_ID,
      listingRef: published.listingPin,
      phaseKind: "commit-payee-bound-agreement" as const,
      orchestrator: SELLER,
      buyer: {
        primaryClaim: BUYER,
        bundleHash: identityBundleHash(BUYER_IDENTITY),
        vetRecordRef: vetRef("buyer"),
      },
      seller: {
        primaryClaim: SELLER,
        bundleHash: identityBundleHash(SELLER_IDENTITY),
        vetRecordRef: vetRef("seller"),
      },
    },
    createdAt: NOW + 500,
    commitmentSigner: {
      algorithm: "ed25519" as const,
      signer: SELLER,
      sign: (bytes: Uint8Array) =>
        ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
    },
  };
  const committed = await commitFixedPriceAgreement(input, provider, verify);
  const resumed = await commitFixedPriceAgreement(
    {
      ...input,
      commitmentSigner: {
        ...input.commitmentSigner,
        sign: () => {
          throw new Error("finalized commitment must not be signed twice");
        },
      },
    },
    provider,
    verify,
  );
  expect(committed.resumed).toBe(false);
  expect(resumed).toEqual({ ...committed, resumed: true });
  expect(submissions).toBe(1);
  return committed;
}

const EXPECTED_X402: X402PaywallExpectedTerms = {
  network: NETWORK,
  payTo: PAYEE,
  amount: AMOUNT_BASE_UNITS,
  asset: ASSET,
  eip712: { name: "USD Coin", version: "2" },
};

const X402_REQUIREMENTS: X402PaywallPaymentRequirements = {
  scheme: "exact",
  network: NETWORK,
  asset: ASSET,
  amount: AMOUNT_BASE_UNITS,
  payTo: PAYEE,
  maxTimeoutSeconds: 120,
  extra: {
    name: EXPECTED_X402.eip712.name,
    version: EXPECTED_X402.eip712.version,
    assetTransferMethod: "eip3009",
  },
};

function addressTopic(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function uint256Data(value: string): string {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

async function verifyLocalX402Payload(
  payload: Readonly<X402PaywallPaymentPayload>,
): Promise<boolean> {
  const authorization = payload.payload.authorization as
    | {
        from?: string;
        to?: string;
        value?: string;
        validAfter?: string;
        validBefore?: string;
        nonce?: string;
      }
    | undefined;
  const signature = payload.payload.signature;
  const resource = payload.resource?.url;
  if (
    payload.x402Version !== 2 ||
    canonicalize(payload.accepted) !== canonicalize(X402_REQUIREMENTS) ||
    resource !== HTTP_RESOURCE ||
    !authorization ||
    authorization.from?.toLowerCase() !== PAYER.toLowerCase() ||
    authorization.to?.toLowerCase() !== PAYEE.toLowerCase() ||
    authorization.value !== AMOUNT_BASE_UNITS ||
    authorization.validAfter !== "0" ||
    authorization.validBefore !== "4102444800" ||
    authorization.nonce !== x402Eip3009Nonce(JOB_ID, PAYMENT_PHASE_INDEX) ||
    typeof signature !== "string" ||
    !/^0x[0-9a-fA-F]{130}$/.test(signature)
  ) {
    return false;
  }
  return verifyTypedData({
    address: PAYER,
    domain: {
      name: EXPECTED_X402.eip712.name,
      version: EXPECTED_X402.eip712.version,
      chainId: CHAIN_ID,
      verifyingContract: ASSET,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: PAYER,
      to: PAYEE,
      value: BigInt(AMOUNT_BASE_UNITS),
      validAfter: 0n,
      validBefore: 4_102_444_800n,
      nonce: authorization.nonce as `0x${string}`,
    },
    signature: signature as `0x${string}`,
  });
}

function finalizedReceipt(
  logicalAddress: string,
  hash: string,
  writer = SELLER,
): AnchorReceipt {
  return signedLocalReceipt({
    receiptVersion: "1",
    substrate: "test:offline",
    finalityProfile: "test-final",
    logicalAddress,
    nativeAddress: `native:${sha256Hex(logicalAddress).slice(0, 24)}`,
    contentHash: hash,
    transactionRef: { kind: "test", value: `tx:${hash.slice(0, 16)}` },
    writer,
    state: "finalized",
    observationDisposition: "established",
    observedAt: NOW + 4_000,
    blockRef: { id: `block:${hash.slice(0, 8)}`, height: "100", timestamp: NOW + 3_000 },
  });
}

async function verifySellerEvidenceSignature(
  input: Parameters<DurableSellerFulfilmentDeps["verifyEvidenceSignature"]>[0],
) {
  const signature = input.signature;
  const valid = signature.algorithm === "ed25519" &&
    signature.signer === input.expectedSigner &&
    input.expectedSigner === SELLER &&
    ed25519Verify(
      input.signedBytes,
      Uint8Array.from(Buffer.from(signature.value, "base64url")),
      publicKeyFromSeed(SELLER_SEED),
    );
  return valid
    ? { disposition: "valid" as const }
    : {
        disposition: "invalid" as const,
        reason: "delivery evidence signature mismatch",
      };
}

async function verifySellerAuditSourceCommitmentSignature(
  input: Parameters<
    DurableSellerFulfilmentDeps["verifyAuditSourceCommitmentSignature"]
  >[0],
) {
  const signature = input.signature;
  const valid = signature.algorithm === "ed25519" &&
    signature.signer === input.expectedSigner &&
    input.expectedSigner === SELLER &&
    ed25519Verify(
      input.signedBytes,
      Uint8Array.from(Buffer.from(signature.value, "base64url")),
      publicKeyFromSeed(SELLER_SEED),
    );
  return valid
    ? { disposition: "valid" as const }
    : {
        disposition: "invalid" as const,
        reason: "audit-source commitment signature mismatch",
      };
}

async function verifySellerAnchorReceipt(
  input: Parameters<DurableSellerFulfilmentDeps["verifyAnchorReceipt"]>[0],
) {
  const receipt = input.receipt;
  const valid = input.expectedWriter.primaryClaim === SELLER &&
    receipt.writer === SELLER &&
    receipt.logicalAddress === input.ref.anchor.locator &&
    receipt.contentHash === input.ref.contentHash &&
    receipt.state === "finalized" &&
    receipt.observationDisposition === "established" &&
    verifyLocalReceipt(receipt);
  return valid
    ? { disposition: "valid" as const }
    : {
        disposition: "invalid" as const,
        reason: "anchor receipt signature or content binding mismatch",
      };
}

interface CommerceCounts {
  paidRequests: number;
  settlement: number;
  applicationCallback: number;
  delivery: number;
  evidence: number;
  finalReceipt: number;
  render: number;
}

interface CommerceState {
  now: number;
  settled: boolean;
  buyerFinalityVisible: boolean;
  terminalReplayMustBeReadOnly: boolean;
  loseResponseAcknowledgement: boolean;
  responseAcknowledgementLosses: number;
  delivered?: Awaited<ReturnType<DurableSellerFulfilmentDeps["submitDelivery"]>>;
  anchoredEvidence?: SignedSellerDeliveryEvidence;
  evidencePublication?: Awaited<ReturnType<DurableSellerFulfilmentDeps["anchorEvidence"]>>;
  finalReceipt?: SellerFinalSessionReceiptResult;
  counts: CommerceCounts;
}

interface SellerProcessState {
  permit?: X402SellerPaymentPermitAuthorization;
  fulfilment?: Extract<SellerFulfilmentResult, { decision: "completed" }>;
}

function commerceState(loseResponseAcknowledgement = false): CommerceState {
  return {
    now: NOW + 4_000,
    settled: false,
    buyerFinalityVisible: false,
    terminalReplayMustBeReadOnly: false,
    loseResponseAcknowledgement,
    responseAcknowledgementLosses: 0,
    counts: {
      paidRequests: 0,
      settlement: 0,
      applicationCallback: 0,
      delivery: 0,
      evidence: 0,
      finalReceipt: 0,
      render: 0,
    },
  };
}

interface SellerRuntime {
  runPaidRequest(paymentHeader: string): Promise<X402PaywallResult<{ delivered: true }>>;
  receiptStore: Awaited<ReturnType<typeof createFsSellerReceiptStore>>;
  fulfilmentStore: Awaited<ReturnType<typeof createFsFencedSessionStore>>;
  process: SellerProcessState;
}

function paymentResponseObject() {
  return {
    success: true,
    transaction: TX_HASH,
    network: NETWORK,
    payer: PAYER,
    amount: AMOUNT_BASE_UNITS,
  };
}

function settlementResult(): X402PaywallSettlementResult & { success: true } {
  return {
    success: true,
    transaction: TX_HASH,
    network: NETWORK,
    payer: PAYER,
    amount: AMOUNT_BASE_UNITS,
    headers: { "PAYMENT-RESPONSE": encodeJson(paymentResponseObject()) },
    requirements: structuredClone(X402_REQUIREMENTS),
  };
}

function paymentEventRef() {
  return {
    kind: "x402-event" as const,
    httpResource: HTTP_RESOURCE,
    paymentReceiptHash: sha256Hex(canonicalize(paymentResponseObject())),
    settlementTxHash: TX_HASH.slice(2),
    chainId: CHAIN_ID,
    logIndex: 7,
    protocolVersion: "2",
  };
}

async function createSellerRuntime(input: {
  published: PublishedListing;
  agreement: AgreementRun;
  commitment: Awaited<ReturnType<typeof commitAgreement>>;
  settlementDir: string;
  receiptDir: string;
  fulfilmentDir: string;
  workerId: string;
  state: CommerceState;
  rejectSession?: boolean;
  deliveryFailure?: boolean;
  buyerIdentityOverride?: IdentityBundle;
}): Promise<SellerRuntime> {
  const {
    published,
    agreement,
    commitment,
    state,
  } = input;
  const process: SellerProcessState = {};
  const rejectTerminalReplayEffect = (effect: string): void => {
    if (state.terminalReplayMustBeReadOnly) {
      throw new Error(`terminal replay touched process-A-only ${effect}`);
    }
  };
  const settlementStore = await createFsX402PaywallSettlementStore({
    dir: input.settlementDir,
  });
  const receiptStore = await createFsSellerReceiptStore({ dir: input.receiptDir });
  const fulfilmentStore = await createFsFencedSessionStore({ dir: input.fulfilmentDir });
  const buyerHash = identityBundleHash(BUYER_IDENTITY);
  const sellerHash = identityBundleHash(SELLER_IDENTITY);
  const resolvedBuyerIdentity = input.buyerIdentityOverride ?? BUYER_IDENTITY;
  const commitmentHash = contentHash(
    commitment.record as unknown as Record<string, unknown>,
  );
  const commitmentRef: AttestationRef = {
    anchor: {
      kind: "storage-program",
      locator: commitment.logicalAddress,
    },
    contentHash: commitmentHash,
    signer: SELLER,
  };
  const rail: SellerX402RailDefinition = {
    railVersion: RAIL.railVersion,
    railId: RAIL.railId,
    railType: "x402",
    asset: {
      kind: "erc20",
      chainId: CHAIN_ID,
      contract: ASSET,
      symbol: "USDC",
      decimals: 6,
    },
    network: {
      kind: "x402-resource",
      resourceBaseUrl: "https://seller.example/deliver",
    },
    phaseHandler: "pay-x402",
    parameters: { finalityBlocks: 5 },
    availability: "live",
  };
  const committedResolution: Extract<
    CommittedAgreementResolution,
    { disposition: "verified" }
  > = {
    disposition: "verified",
    agreement: agreement.agreement as unknown as Record<string, unknown>,
    agreementHash: agreement.agreementHash,
    commitment: {
      finality: "finalized",
      ref: commitment.logicalAddress,
      contentHash: commitmentHash,
      jobId: JOB_ID,
      agreementHash: agreement.agreementHash,
      listingRef: published.listingPin,
      committedAt: commitment.committedAt,
      signer: SELLER,
    },
    railRegistryVersion: 7,
  };
  const listingResolution: SellerListingAtCommitResolution = {
    rawListing: published.listing as unknown as Record<string, unknown>,
    validation: await validateListingArtifact(
      published.listing as unknown as Record<string, unknown>,
      listingValidationDeps(),
    ),
  };
  const observation: X402TransferObservation = {
    status: "finalized",
    chainId: CHAIN_ID,
    txHash: TX_HASH,
    logIndex: 7,
    payer: PAYER,
    payee: PAYEE,
    amountBaseUnits: AMOUNT_BASE_UNITS,
    asset: { contract: ASSET, symbol: "USDC", decimals: 6 },
    confirmations: 10,
    includedAt: NOW + 2_000,
    finalityObservedAt: NOW + 3_000,
    sessionBinding: {
      kind: "eip3009",
      nonce: x402Eip3009Nonce(JOB_ID, PAYMENT_PHASE_INDEX),
    },
  };
  const resolveAuthenticatedIdentityBundle = async (hash: string) => {
    const role = hash === buyerHash
      ? { bundle: resolvedBuyerIdentity, primaryClaim: BUYER }
      : hash === sellerHash
        ? { bundle: SELLER_IDENTITY, primaryClaim: SELLER }
        : null;
    const walletClaimIsBound = role?.primaryClaim !== BUYER ||
      role.bundle.claims.some(({ ref }) => ref === BUYER_EVM_CLAIM);
    if (!role || identityBundleHash(role.bundle) !== hash ||
        !walletClaimIsBound ||
        !await verifyRoleIdentityPresentation(role.bundle, role.primaryClaim)) {
      return {
        disposition: "rejected" as const,
        reason: "identity presentation or exact bundle hash is not authenticated",
      };
    }
    return {
      disposition: "verified" as const,
      bundle: structuredClone(role.bundle),
    };
  };
  const paymentIntakeDeps: Omit<SellerPaymentIntakeDeps, "receiptStore"> = {
    resolveCommittedAgreement: async () => committedResolution,
    resolveListingAtCommit: async () => listingResolution,
    resolveRail: async ({ railRegistryVersion }) => ({
      disposition: "verified",
      rail,
      railRegistryVersion,
    }),
    resolveIdentityBundle: resolveAuthenticatedIdentityBundle,
    resolvePayerAddress: async ({ payingKey, buyerBundle }) =>
      payingKey === BUYER_EVM_CLAIM &&
        buyerBundle.claims.some(({ ref }) => ref === BUYER_EVM_CLAIM) &&
        await verifyRoleIdentityPresentation(buyerBundle, BUYER)
        ? { disposition: "verified", address: PAYER }
        : {
            disposition: "rejected",
            reason: "buyer wallet claim is not controlled by the presented DID",
          },
    resolvePayeeDestination: async () => ({
      disposition: "bound",
      address: PAYEE,
      tier: 3,
    }),
    observeDemosTransfer: async () => ({ status: "not-found" }),
    observeX402Transfer: async () => observation,
    verifyX402ReceiptExtensions: async ({ protocolVersion, receipt }) =>
      protocolVersion === "2" &&
        canonicalize(receipt) === canonicalize(paymentResponseObject())
        ? { disposition: "pass" }
        : {
            disposition: "fail",
            reason: "unexpected local x402 receipt extension/content",
          },
    classifyX402SettlementChain: async () => ({ disposition: "l2" }),
  };

  const fulfilmentListing: SellerFulfilmentListing = {
    pin: published.listingPin,
    sellerPrimaryClaim: SELLER,
    buyerRequirement: structuredClone(published.listing.buyerRequirement),
    pipeline: published.listing.pipeline,
    deliverable: published.listing.offering.deliverable,
  };
  const fulfilmentAgreement: SellerFulfilmentAgreement = {
    artifactKind: "payee-bound",
    ref: agreement.agreementRef.anchor.locator,
    contentHash: agreement.agreementHash,
    jobId: JOB_ID,
    listingPin: published.listingPin,
    buyer: {
      primaryClaim: BUYER,
      bundleHash: buyerHash,
      vetRecordRef: vetRef("buyer"),
      storageAddress: "demos:buyer-storage",
    },
    seller: {
      primaryClaim: SELLER,
      bundleHash: sellerHash,
      vetRecordRef: vetRef("seller"),
    },
    deliverableRef: {
      deliverableType: "storage-program",
      hash: sha256Hex(canonicalize(published.listing.offering.deliverable)),
    },
    commitment: {
      status: "finalized",
      ref: commitment.logicalAddress,
      agreementHash: agreement.agreementHash,
      recordContentHash: commitmentHash,
      finalizedAt: commitment.committedAt,
      signer: SELLER,
    },
  };
  const deliveredArtifact: SellerDeliveredArtifact = {
    kind: "deliver-storage-program",
    cleartextPayload: { answer: 42, jobId: JOB_ID },
    anchoredValue: { answer: 42, jobId: JOB_ID },
    access: { model: "public" },
  };
  const deliveredHash = sha256Hex(canonicalize(deliveredArtifact.anchoredValue));
  const deliveryLogicalAddress = `dacs4:deliverable:${JOB_ID}`;
  const sessionRecord = (): SellerFulfilmentSessionRecord => ({
    recordVersion: "1",
    jobId: JOB_ID,
    state: "settle-pending",
    listingRef: published.listingPin,
    parties: [
      {
        role: "buyer",
        bundleHash: buyerHash,
        primaryClaim: BUYER,
        vetRecordRef: vetRef("buyer"),
      },
      {
        role: "seller",
        bundleHash: sellerHash,
        primaryClaim: SELLER,
        vetRecordRef: vetRef("seller"),
      },
      { role: "orchestrator", bundleHash: sellerHash, primaryClaim: SELLER },
    ],
    pipeline: published.listing.pipeline,
    phaseResults: [
      {
        index: 0,
        step: published.listing.pipeline[0]!,
        invokedAt: NOW,
        result: {
          ok: true,
          contextDelta: {
            "negotiate-fixed-price": {
              agreementHash: agreement.agreementHash,
              agreementRef: agreement.agreementRef,
            },
          },
        },
        contextDelta: {
          "negotiate-fixed-price": {
            agreementHash: agreement.agreementHash,
            agreementRef: agreement.agreementRef,
          },
        },
      },
      {
        index: 1,
        step: published.listing.pipeline[1]!,
        invokedAt: NOW + 1_000,
        result: {
          ok: true,
          txRefs: [structuredClone(commitment.anchorTxRef)],
          attestationRef: commitmentRef,
          anchorReceipt: structuredClone(commitment.anchorReceipt),
          contextDelta: {
            "commit-payee-bound-agreement": {
              agreementHash: agreement.agreementHash,
              anchorTxRef: structuredClone(commitment.anchorTxRef),
              anchorReceipt: structuredClone(commitment.anchorReceipt),
              committedAt: commitment.committedAt,
            },
          },
        },
        contextDelta: {
          "commit-payee-bound-agreement": {
            agreementHash: agreement.agreementHash,
            anchorTxRef: structuredClone(commitment.anchorTxRef),
            anchorReceipt: structuredClone(commitment.anchorReceipt),
            committedAt: commitment.committedAt,
          },
        },
      },
      {
        index: PAYMENT_PHASE_INDEX,
        step: published.listing.pipeline[PAYMENT_PHASE_INDEX]!,
        invokedAt: NOW + 3_000,
        result: {
          ok: true,
          txRefs: process.permit?.paymentAuthorization.evidenceInput.paymentTxRefs ?? [
            paymentEventRef(),
          ],
          contextDelta: {},
        },
        contextDelta: {},
      },
    ],
    startedAt: NOW - 1_000,
    lastUpdatedAt: NOW + 3_000,
    recipeRegistryVersion: 3,
    railRegistryVersion: 7,
  });
  const fulfilmentDeps: Omit<DurableSellerFulfilmentDeps, "receiptStore"> = {
    auditSourceProfile: "v2",
    resolveAgreement: async () => ({ status: "verified", value: fulfilmentAgreement }),
    resolveListing: async () => ({ status: "verified", value: fulfilmentListing }),
    resolveAuditSource: async () => {
      const retainedAuthorization = process.permit?.paymentAuthorization;
      if (!retainedAuthorization) {
        return {
          status: "indeterminate" as const,
          reason: "payment authorization was not retained before audit-source resolution",
        };
      }
      return {
        status: "verified" as const,
        value: {
        sourceVersion: "1",
        session: sessionRecord(),
        artifacts: {
          agreementCommitment: {
            anchor: { kind: "storage-program", locator: commitment.logicalAddress },
            contentHash: commitmentHash,
            signer: SELLER,
          },
          vetRecords: [vetRef("buyer"), vetRef("seller")],
          vetRequirements: [
            {
              vetRecordRef: vetRef("buyer"),
              evaluatedParty: BUYER,
              requirement: structuredClone(EMPTY_REQUIREMENT),
              verifier: SELLER,
              freshness: [],
              dealSpecific: [],
            },
            {
              vetRecordRef: vetRef("seller"),
              evaluatedParty: SELLER,
              requirement: structuredClone(EMPTY_REQUIREMENT),
              verifier: SELLER,
              freshness: [],
              dealSpecific: [],
            },
          ],
          settlementEvidence: [{
            anchor: {
              kind: "storage-program",
              locator:
                `dacs4:payment:${JOB_ID}:${encodeAddressSegment(RAIL.railId)}:${PAYMENT_PHASE_INDEX}`,
            },
            contentHash: retainedAuthorization.evidenceHash,
            signer: SELLER,
          }],
        },
        provenanceProfile: "dacs-sdk-operational-v1",
        },
      };
    },
    prepareDelivery: async () => {
      rejectTerminalReplayEffect("delivery preparation");
      return input.deliveryFailure
        ? { status: "rejected", reason: "application rejected delivery" }
        : { status: "prepared", delivery: { artifact: deliveredArtifact } };
    },
    submitDelivery: async () => {
      rejectTerminalReplayEffect("delivery submission");
      state.counts.applicationCallback += 1;
      state.counts.delivery += 1;
      state.delivered = {
        status: "accepted",
        reconciliationId: `delivery:${JOB_ID}`,
      };
      return state.delivered;
    },
    reconcileDelivery: async () => {
      rejectTerminalReplayEffect("delivery reconciliation");
      return state.delivered
        ? {
          status: "complete",
          reconciliationId: `delivery:${JOB_ID}`,
          observedAt: state.now,
          }
        : { status: "absent", reason: "delivery absent" };
    },
    resolveDelivery: async () => {
      rejectTerminalReplayEffect("delivery readback");
      return {
        status: "verified",
        value: {
          artifact: deliveredArtifact,
          anchorReceipt: finalizedReceipt(deliveryLogicalAddress, deliveredHash),
        },
      };
    },
    verifyAnchorReceipt: verifySellerAnchorReceipt,
    evidenceSigner: {
      algorithm: "ed25519",
      signer: SELLER,
      sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
    },
    auditSourceCommitmentSigner: {
      algorithm: "ed25519",
      signer: SELLER,
      sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
    },
    verifyEvidenceSignature: verifySellerEvidenceSignature,
    verifyAuditSourceCommitmentSignature:
      verifySellerAuditSourceCommitmentSignature,
    anchorEvidence: async ({ evidence, evidenceHash }) => {
      rejectTerminalReplayEffect("evidence publication");
      state.counts.evidence += 1;
      state.anchoredEvidence = structuredClone(evidence);
      state.evidencePublication = {
        status: "anchored",
        ref: {
          anchor: {
            kind: "storage-program",
            locator: `dacs4:delivery-evidence:${JOB_ID}`,
          },
          contentHash: evidenceHash,
          signer: SELLER,
        },
        anchorReceipt: finalizedReceipt(
          `dacs4:delivery-evidence:${JOB_ID}`,
          evidenceHash,
        ),
      };
      return state.evidencePublication;
    },
    resolveEvidence: async () => {
      rejectTerminalReplayEffect("evidence readback");
      return state.anchoredEvidence
        ? { status: "verified" as const, value: structuredClone(state.anchoredEvidence) }
        : { status: "indeterminate" as const, reason: "delivery evidence absent" };
    },
    nowMs: () => state.now,
  };
  const fulfilmentDurability: SellerFulfilmentDurability = {
    store: fulfilmentStore,
    workerId: input.workerId,
    leaseTtlMs: 1_000,
    leaseNowMs: () => state.now,
    reconcilePayloadAttestation: async () => {
      rejectTerminalReplayEffect("payload-attestation reconciliation");
      return {
        status: "absent",
        reason: "storage delivery has no payload attestation",
      };
    },
    reconcileDeliverySubmission: async () => {
      rejectTerminalReplayEffect("delivery-submission reconciliation");
      return state.delivered ?? {
        status: "absent",
        reason: "delivery absent",
      };
    },
    reconcileEvidencePublication: async () => {
      rejectTerminalReplayEffect("evidence-publication reconciliation");
      return state.evidencePublication ?? {
        status: "absent",
        reason: "evidence absent",
      };
    },
    publishFinalSessionReceipt: async () => {
      rejectTerminalReplayEffect("final receipt publication");
      state.counts.finalReceipt += 1;
      state.finalReceipt = {
        status: "recorded",
        receipt: { id: `final:${JOB_ID}` },
      };
      return state.finalReceipt;
    },
    reconcileFinalSessionReceipt: async () => {
      rejectTerminalReplayEffect("final receipt reconciliation");
      return state.finalReceipt ?? {
        status: "absent",
        reason: "final receipt absent",
      };
    },
  };
  const scope: X402SellerCommittedSessionScope = {
    scopeVersion: "1",
    jobId: JOB_ID,
    paymentPhaseIndex: PAYMENT_PHASE_INDEX,
    deliveryPhaseIndex: DELIVERY_PHASE_INDEX,
    payer: PAYER,
    payerPayingKey: `cci-xm:evm:base-sepolia:${PAYER}`,
    httpResource: HTTP_RESOURCE,
    railId: RAIL.railId,
    railRegistryVersion: 7,
    agreementRef: agreement.agreementRef.anchor.locator,
    agreementHash: agreement.agreementHash,
    listingRef: published.listingPin,
    commitmentRef: commitment.logicalAddress,
    commitmentContentHash: commitmentHash,
    commitmentFinalizedAt: commitment.committedAt,
    expected: EXPECTED_X402,
  };
  const spine = createX402SellerSpine<{ delivered: true }>({
    settlementStore,
    reconcileSettlement: async () => state.settled
      ? { status: "settled", settlement: settlementResult() }
      : { status: "pending", reason: "settlement not observed" },
    receiptStore,
    resolveCommittedSession: async () => {
      if (input.rejectSession) {
        return { disposition: "rejected", reason: "seller policy rejected session" };
      }
      const [buyerAdmission, sellerAdmission] = await Promise.all([
        resolveAuthenticatedIdentityBundle(buyerHash),
        resolveAuthenticatedIdentityBundle(sellerHash),
      ]);
      if (buyerAdmission.disposition !== "verified" ||
          sellerAdmission.disposition !== "verified") {
        return {
          disposition: "rejected",
          reason: "committed session identity presentation is not authenticated",
        };
      }
      return { disposition: "verified", session: scope };
    },
    paymentIntakeDeps,
    fulfilmentDeps,
    fulfilmentDurability,
    renderResponse: async (context) => {
      state.counts.render += 1;
      process.fulfilment = structuredClone(context.fulfilment);
      if (state.loseResponseAcknowledgement) {
        state.loseResponseAcknowledgement = false;
        state.responseAcknowledgementLosses += 1;
        throw new Error("process lost the fulfilled response acknowledgement");
      }
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { delivered: true },
      };
    },
  });

  return {
    receiptStore,
    fulfilmentStore,
    process,
    async runPaidRequest(paymentHeader) {
      state.counts.paidRequests += 1;
      const request: X402PaywallHttpAdapter = Object.freeze({
        getHeader: (name: string) => name.toUpperCase() === "PAYMENT-SIGNATURE"
          ? paymentHeader
          : undefined,
        getMethod: () => "GET",
        getPath: () => new URL(HTTP_RESOURCE).pathname,
        getUrl: () => HTTP_RESOURCE,
        getAcceptHeader: () => "application/json",
        getUserAgent: () => "issue-114-offline-buyer",
      });
      const result = await x402PaywallCore({
        jobId: JOB_ID,
        phaseIndex: PAYMENT_PHASE_INDEX,
        request,
      }, {
        server: {
          initialize: async () => undefined,
          processHTTPRequest: async () => {
            const payload = JSON.parse(
              Buffer.from(paymentHeader, "base64").toString("utf8"),
            ) as X402PaywallPaymentPayload;
            if (!await verifyLocalX402Payload(payload)) {
              return {
                type: "payment-error" as const,
                response: {
                  status: 402,
                  headers: { "content-type": "application/json" },
                  body: { error: "invalid x402 EIP-3009 authorization" },
                },
              };
            }
            return {
              type: "payment-verified" as const,
              cancellationDispatcher: { cancel: async () => undefined },
              paymentPayload: payload,
              paymentRequirements: structuredClone(X402_REQUIREMENTS),
            };
          },
          processSettlement: async () => {
            state.counts.settlement += 1;
            state.settled = true;
            return settlementResult();
          },
        },
        expected: EXPECTED_X402,
        ...spine,
        authorizePayment: async (context) => {
          const result = await spine.authorizePayment(context);
          if (result.disposition === "authorized") {
            process.permit = structuredClone(result.authorization);
          }
          return result;
        },
      });
      return result;
    },
  };
}

function challengeClient(): X402BuyerChallengeClient {
  return {
    getPaymentRequiredResponse: (_getHeader, body) => body,
    async createPaymentPayload(value) {
      const selected = (value as { accepts: X402PaywallPaymentRequirements[] })
        .accepts[0]!;
      const nonce = x402Eip3009Nonce(JOB_ID, PAYMENT_PHASE_INDEX) as `0x${string}`;
      const signature = await BUYER_EVM.signTypedData({
        domain: {
          name: EXPECTED_X402.eip712.name,
          version: EXPECTED_X402.eip712.version,
          chainId: CHAIN_ID,
          verifyingContract: ASSET,
        },
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message: {
          from: PAYER,
          to: PAYEE,
          value: BigInt(AMOUNT_BASE_UNITS),
          validAfter: 0n,
          validBefore: 4_102_444_800n,
          nonce,
        },
      });
      return {
        x402Version: 2,
        resource: { url: HTTP_RESOURCE },
        accepted: selected,
        payload: {
          authorization: {
            from: PAYER,
            to: PAYEE,
            value: AMOUNT_BASE_UNITS,
            validAfter: "0",
            validBefore: "4102444800",
            nonce,
          },
          signature,
        },
      };
    },
    encodePaymentSignatureHeader: (payload) => ({
      "PAYMENT-SIGNATURE": encodeJson(payload),
    }),
  };
}

function authorizationUsedLog(): X402BuyerEvmLog {
  return {
    address: ASSET,
    topics: [
      EIP3009_AUTHORIZATION_USED_TOPIC,
      addressTopic(PAYER),
      x402Eip3009Nonce(JOB_ID, PAYMENT_PHASE_INDEX),
    ],
    data: "0x",
    transactionHash: TX_HASH,
    blockNumber: 100,
    blockHash: BLOCK_HASH,
    logIndex: 5,
    removed: false,
  };
}

function transferLog(): X402BuyerEvmLog {
  return {
    ...authorizationUsedLog(),
    topics: [ERC20_TRANSFER_TOPIC, addressTopic(PAYER), addressTopic(PAYEE)],
    data: uint256Data(AMOUNT_BASE_UNITS),
    logIndex: 7,
  };
}

function evmReceipt(): X402BuyerEvmTransactionReceipt {
  return {
    transactionHash: TX_HASH,
    blockNumber: 100,
    blockHash: BLOCK_HASH,
    status: "success",
    logs: [authorizationUsedLog(), transferLog()],
  };
}

function evmReader(state: CommerceState): X402BuyerEvmReadClient {
  return {
    getFinalityHead: async () => ({
      chainId: CHAIN_ID,
      // The first buyer process can see the exact used nonce and receipt, but
      // only four confirmations. The restarted process observes the fifth and
      // later confirmations without resubmitting the retained paid request.
      blockNumber: state.buyerFinalityVisible ? 110 : 103,
      blockHash: state.buyerFinalityVisible ? HEAD_HASH : PENDING_HEAD_HASH,
      timestamp: Math.floor((NOW + 4_000) / 1_000),
    }),
    getLogs: async (input) => {
      if (!state.settled) return [];
      return input.topics[0] === EIP3009_AUTHORIZATION_USED_TOPIC
        ? [authorizationUsedLog()]
        : input.topics[0] === EIP3009_AUTHORIZATION_CANCELED_TOPIC
          ? []
          : [];
    },
    getTransactionReceipt: async () => state.settled ? evmReceipt() : null,
    readAuthorizationState: async (input) => ({
      used: state.settled,
      blockNumber: input.blockNumber,
      blockHash: input.blockHash,
    }),
    confirmBlockAncestor: async (input) => ({ canonical: true, ...input }),
  };
}

function buyerAuthorizationProvider(state: CommerceState) {
  return createX402BuyerEvmAuthorizationProvider({
    chainId: CHAIN_ID,
    minimumConfirmations: 5,
    authorizationSearchFromBlock: 1,
    client: evmReader(state),
    authorizeIntent: async ({ intent: candidate }) => ({
      disposition: "authorized",
      bindingHash: candidate.bindingHash,
    }),
  });
}

interface SettlementRun {
  intent: Readonly<X402BuyerSettlementIntent>;
  state: CommerceState;
  seller: SellerRuntime;
  permit: X402SellerPaymentPermitAuthorization;
  fulfilment: Extract<SellerFulfilmentResult, { decision: "completed" }>;
  buyerStoreDir: string;
  sellerDirs: { settlement: string; receipt: string; fulfilment: string };
}

async function prepareSettlementIntent(input: {
  agreement: AgreementRun;
}): Promise<Readonly<X402BuyerSettlementIntent>> {
  const challenge = {
    x402Version: 2,
    resource: { url: HTTP_RESOURCE },
    accepts: [structuredClone(X402_REQUIREMENTS)],
  };
  const prepared = await prepareX402BuyerSettlement({
    authority: {
      jobId: JOB_ID,
      phaseIndex: PAYMENT_PHASE_INDEX,
      railId: RAIL.railId,
      railVersion: String(RAIL.railVersion),
      railDescriptorHash: sha256Hex(canonicalize(RAIL)),
      agreementHash: input.agreement.agreementHash,
      termsHash: sha256Hex(canonicalize(input.agreement.agreement.terms)),
      sessionBindingHash: sha256Hex(canonicalize({ jobId: JOB_ID, payer: PAYER })),
      network: NETWORK,
      payer: PAYER,
      payee: PAYEE,
      asset: ASSET,
      amount: AMOUNT_BASE_UNITS,
      httpResource: HTTP_RESOURCE,
      method: "GET",
    },
  }, {
    client: challengeClient(),
    fetchImpl: async () => new Response(JSON.stringify(challenge), { status: 402 }),
  });
  expect(prepared.disposition).toBe("prepared");
  if (prepared.disposition !== "prepared") throw new Error(prepared.reason);
  return prepared.intent;
}

async function settleAndRecover(input: {
  published: PublishedListing;
  agreement: AgreementRun;
  commitment: Awaited<ReturnType<typeof commitAgreement>>;
}): Promise<SettlementRun> {
  const sellerDirs = {
    settlement: await tempDir("issue114-seller-settlement"),
    receipt: await tempDir("issue114-seller-receipt"),
    fulfilment: await tempDir("issue114-seller-fulfilment"),
  };
  const buyerStoreDir = await tempDir("issue114-buyer-settlement");
  const state = commerceState(true);
  let sellerA: SellerRuntime | undefined = await createSellerRuntime({
    ...input,
    settlementDir: sellerDirs.settlement,
    receiptDir: sellerDirs.receipt,
    fulfilmentDir: sellerDirs.fulfilment,
    workerId: "seller-process-a",
    state,
  });
  const intent = await prepareSettlementIntent(input);
  const paidTransport = createX402BuyerPaidRequestTransport({
    fetchImpl: async (_url, init) => {
      const header = new Headers(init?.headers).get("PAYMENT-SIGNATURE");
      if (!header) throw new Error("retained payment header absent");
      const process = sellerA;
      if (!process) throw new Error("seller process A was already discarded");
      const paywall = await process.runPaidRequest(header);
      return new Response(JSON.stringify(paywall.response.body), {
        status: paywall.response.status,
        headers: paywall.response.headers,
      });
    },
  });
  let buyerStore = await createFsX402BuyerSettlementStore({ dir: buyerStoreDir });
  const firstProgress = await advanceX402BuyerSettlement({
    intent,
    owner: "buyer-process-a",
    store: buyerStore,
    authorizationProvider: buyerAuthorizationProvider(state),
    transport: paidTransport,
    now: () => state.now,
    leaseDurationMs: 1_000,
  });
  expect(firstProgress).toEqual({
    status: "indeterminate",
    reason: "eip3009-settlement-not-finalized",
  });
  const buyerPending = await buyerStore.load(intent.settlementKey);
  expect(buyerPending).toMatchObject({
    status: "held",
    pendingDisclosure: {
      protocolVersion: "2",
      headerName: "PAYMENT-RESPONSE",
      encodedSettlementHeader: encodeJson(paymentResponseObject()),
      httpResource: HTTP_RESOURCE,
    },
  });
  expect("outcome" in buyerPending).toBe(false);
  expect(state.counts).toEqual({
    paidRequests: 1,
    settlement: 1,
    applicationCallback: 1,
    delivery: 1,
    evidence: 1,
    finalReceipt: 1,
    render: 1,
  });
  expect(state.responseAcknowledgementLosses).toBe(1);

  // Simulate a real process boundary: no process-A permit, fulfilment result,
  // callback closure, or rendered response remains available to process B.
  sellerA = undefined;
  state.delivered = undefined;
  state.anchoredEvidence = undefined;
  state.evidencePublication = undefined;
  state.finalReceipt = undefined;
  state.terminalReplayMustBeReadOnly = true;
  state.now += 2_000;
  const seller = await createSellerRuntime({
    ...input,
    settlementDir: sellerDirs.settlement,
    receiptDir: sellerDirs.receipt,
    fulfilmentDir: sellerDirs.fulfilment,
    workerId: "seller-process-b",
    state,
  });
  await expect(getSellerFulfilmentStatus(
    seller.fulfilmentStore,
    JOB_ID,
    DELIVERY_PHASE_INDEX,
  )).resolves.toMatchObject({
    status: "ok",
    delivery: "outcome",
    evidence: "outcome",
    receipts: {
      [`delivery:${DELIVERY_PHASE_INDEX}`]: `dacs4:delivery-evidence:${JOB_ID}`,
      [`fulfilment:${DELIVERY_PHASE_INDEX}`]: expect.stringMatching(/^[0-9a-f]{64}$/),
    },
  });

  const replayedSellerResponse = await seller.runPaidRequest(intent.paymentHeader.value);
  expect(replayedSellerResponse).toMatchObject({
    disposition: "settled",
    settled: true,
    response: { status: 200, body: { delivered: true } },
  });
  const permit = seller.process.permit;
  const fulfilment = seller.process.fulfilment;
  if (!permit || !fulfilment) {
    throw new Error("seller process B did not recover its durable terminal handoff");
  }
  const durableRecord = await seller.fulfilmentStore.load(JOB_ID);
  expect(durableRecord.status).toBe("ok");
  if (durableRecord.status !== "ok") {
    throw new Error("seller process B could not load the durable terminal record");
  }
  const authenticatedTerminal = await verifyDurableSellerTerminalResult({
    record: durableRecord.record,
    suppliedResult: fulfilment,
    expectedDeliveryWriter: { role: "seller", primaryClaim: SELLER },
    verifyEvidenceSignature: verifySellerEvidenceSignature,
    verifyAuditSourceCommitmentSignature:
      verifySellerAuditSourceCommitmentSignature,
    verifyAnchorReceipt: verifySellerAnchorReceipt,
  });
  expect(authenticatedTerminal.result).toEqual(fulfilment);
  expect(authenticatedTerminal.binding).toMatchObject({
    agreementHash: input.agreement.agreementHash,
    paymentPhaseIndex: PAYMENT_PHASE_INDEX,
    deliveryPhaseIndex: DELIVERY_PHASE_INDEX,
  });
  await expect(seller.receiptStore.inspectPermit(
    permit.paymentPermitId,
  )).resolves.toMatchObject({
    status: "already-consumed",
    claim: { jobId: JOB_ID, phaseIndex: PAYMENT_PHASE_INDEX },
  });

  state.buyerFinalityVisible = true;
  buyerStore = await createFsX402BuyerSettlementStore({ dir: buyerStoreDir });
  let coldTransportCalls = 0;
  const buyerRecovered = await advanceX402BuyerSettlement({
    intent,
    owner: "buyer-process-b",
    store: buyerStore,
    authorizationProvider: buyerAuthorizationProvider(state),
    transport: {
      submitRetained: async () => {
        coldTransportCalls += 1;
        throw new Error("captured buyer settlement must not submit twice");
      },
    },
    now: () => state.now,
    leaseDurationMs: 1_000,
  });
  expect(buyerRecovered.status).toBe("captured");
  expect(coldTransportCalls).toBe(0);
  expect(state.responseAcknowledgementLosses).toBe(1);
  expect(state.counts).toEqual({
    paidRequests: 2,
    settlement: 1,
    applicationCallback: 1,
    delivery: 1,
    evidence: 1,
    finalReceipt: 1,
    render: 2,
  });
  return { intent, state, seller, permit, fulfilment, buyerStoreDir, sellerDirs };
}

async function publishAndVerifySellerSettlement(input: {
  agreement: AgreementRun;
  settlement: SettlementRun;
}) {
  const permit = input.settlement.permit;
  const authorization = permit.paymentAuthorization;
  const proofArtifact = {
    proofVersion: "offline-1",
    chainId: CHAIN_ID,
    settlementId: authorization.settlementId,
    event: structuredClone(authorization.settlementIdentity),
    receipt: evmReceipt(),
    finalityHead: {
      chainId: CHAIN_ID,
      blockNumber: 110,
      blockHash: HEAD_HASH,
      timestamp: Math.floor((NOW + 4_000) / 1_000),
    },
    authorizationState: {
      used: true,
      blockNumber: 100,
      blockHash: BLOCK_HASH,
    },
  };
  const nativeProofRef: SessionSettlementNativeProofRef = {
    proofVersion: "1",
    kind: "authenticated-x402-event",
    locator: `proof:${JOB_ID}:${PAYMENT_PHASE_INDEX}`,
    contentHash: sha256Hex(canonicalize(proofArtifact)),
    encoding: "jcs",
  };
  let retainedEvidence: SettlementEvidence | undefined;
  let anchored = 0;
  let anchorCommitted = false;
  const authenticateNativeProof = async (
    candidate: Readonly<SellerPaymentAuthorization>,
    expectedRef?: Readonly<SessionSettlementNativeProofRef>,
  ): Promise<SellerSessionSettlementNativeProofAuthentication> => {
    const reader = evmReader(input.settlement.state);
    const [rawReceipt, rawHead, rawAuthorizationState, rawAncestry] = await Promise.all([
      reader.getTransactionReceipt(TX_HASH),
      reader.getFinalityHead(),
      reader.readAuthorizationState({
        asset: ASSET,
        payer: PAYER,
        nonce: x402Eip3009Nonce(
          JOB_ID,
          PAYMENT_PHASE_INDEX,
        ) as `0x${string}`,
        blockNumber: 100,
        blockHash: BLOCK_HASH,
      }),
      reader.confirmBlockAncestor({
        blockNumber: 100,
        blockHash: BLOCK_HASH,
        headBlockNumber: 110,
        headBlockHash: HEAD_HASH,
      }),
    ]);
    const receipt = rawReceipt as X402BuyerEvmTransactionReceipt | null;
    const head = rawHead as X402BuyerEvmFinalityHead;
    const authorizationState = rawAuthorizationState as X402BuyerEvmAuthorizationState;
    const ancestry = rawAncestry as X402BuyerEvmBlockAncestry;
    const observed = {
      proofVersion: "offline-1",
      chainId: head.chainId,
      settlementId: candidate.settlementId,
      event: structuredClone(candidate.settlementIdentity),
      receipt,
      finalityHead: head,
      authorizationState,
    };
    const exactAuthorization = candidate.jobId === JOB_ID &&
      candidate.phaseIndex === PAYMENT_PHASE_INDEX &&
      candidate.agreementHash === input.agreement.agreementHash &&
      candidate.railId === RAIL.railId &&
      candidate.evidenceHash === authorization.evidenceHash &&
      canonicalize(candidate.settlementIdentity) ===
        canonicalize(authorization.settlementIdentity);
    const exactProof = receipt !== null &&
      receipt.status === "success" &&
      receipt.transactionHash === TX_HASH &&
      receipt.blockNumber === 100 &&
      receipt.blockHash === BLOCK_HASH &&
      canonicalize(receipt.logs) === canonicalize([
        authorizationUsedLog(),
        transferLog(),
      ]) &&
      head.chainId === CHAIN_ID &&
      head.blockNumber >= receipt.blockNumber + 5 - 1 &&
      authorizationState.used === true &&
      ancestry.canonical === true &&
      canonicalize(observed) === canonicalize(proofArtifact);
    const exactRef = expectedRef === undefined ||
      canonicalize(expectedRef) === canonicalize(nativeProofRef);
    if (!exactAuthorization || !exactProof || !exactRef) {
      return {
        disposition: "rejected",
        reason: "local EVM proof is not bound to the exact finalized x402 event",
      };
    }
    return {
      disposition: "authenticated",
      binding: {
        bindingVersion: "1",
        jobId: JOB_ID,
        railId: RAIL.railId,
        phaseIndex: PAYMENT_PHASE_INDEX,
        phase: "pay-x402",
        evidenceHash: candidate.evidenceHash,
        settlementId: candidate.settlementId,
        network: NETWORK,
        event: structuredClone(candidate.settlementIdentity),
        settlementFinality: structuredClone(
          candidate.evidenceInput.settlementFinality,
        ),
      },
      proof: {
        encoding: "jcs",
        kind: "authenticated-x402-event",
        locator: nativeProofRef.locator,
        artifact: structuredClone(proofArtifact),
      },
    };
  };
  const evidenceVerifier = {
    resolvePublicKey: async (signer: string) => signer === SELLER
      ? rawPublicKey(publicKeyFromSeed(SELLER_SEED))
      : null,
    verify: (bytes: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) =>
      ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
  };
  const deps: SellerSessionSettlementPublicationDeps = {
    receiptStore: input.settlement.seller.receiptStore,
    evidenceSigner: {
      algorithm: "ed25519",
      signer: SELLER,
      sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
    },
    evidence: evidenceVerifier,
    resolveAuthenticatedNativeProof: async ({
      authorization: candidate,
      expectedNativeProofRef,
    }) => authenticateNativeProof(candidate, expectedNativeProofRef),
    resolveRetainedSignedEvidence: async (request) => retainedEvidence
      ? {
          disposition: "present",
          effectId: request.effectId,
          evidence: structuredClone(retainedEvidence),
        }
      : { disposition: "absent" },
    anchorEvidence: async ({ logicalAddress, evidence, evidenceHash }) => {
      if (!anchorCommitted) {
        anchored += 1;
        anchorCommitted = true;
      }
      retainedEvidence = structuredClone(evidence);
      return {
        disposition: "anchored",
        evidenceRef: {
          anchor: { kind: "storage-program", locator: logicalAddress },
          contentHash: evidenceHash,
          signer: SELLER,
        },
        anchorReceipt: finalizedReceipt(logicalAddress, evidenceHash),
      };
    },
    verifyAnchorReceipt: async ({ expectedWriter, evidenceRef, anchorReceipt }) =>
      expectedWriter === SELLER &&
        evidenceRef.anchor.locator === anchorReceipt.logicalAddress &&
        evidenceRef.contentHash === anchorReceipt.contentHash &&
        anchorReceipt.writer === SELLER &&
        verifyLocalReceipt(anchorReceipt)
        ? { disposition: "pass" }
        : {
            disposition: "fail",
            reason: "settlement evidence anchor signature or binding mismatch",
          },
    resolveEvidence: async () => retainedEvidence
      ? { disposition: "present", evidence: structuredClone(retainedEvidence) }
      : { disposition: "absent" },
  };
  const published = await publishSellerSessionSettlement({
    paymentPermitId: permit.paymentPermitId,
    authorization,
    nativeProofRef,
  }, deps);
  expect(published.disposition).toBe("published");
  if (published.disposition !== "published") throw new Error(published.reason);
  const replay = await publishSellerSessionSettlement({
    paymentPermitId: permit.paymentPermitId,
    authorization,
    nativeProofRef,
  }, deps);
  expect(replay).toEqual(published);
  expect(anchored).toBe(1);

  const context: SessionSettlementContext = {
    contextVersion: "1",
    jobId: JOB_ID,
    agreementRef: input.agreement.agreementRef,
    agreementHash: input.agreement.agreementHash,
    paymentPhaseIndex: PAYMENT_PHASE_INDEX,
    orchestrator: SELLER,
    payer: { primaryClaim: BUYER, payingKey: PAYER },
    payee: { primaryClaim: SELLER, receivingKey: PAYEE },
    paymentAmount: structuredClone(authorization.evidenceInput.paymentAmount),
    rail: {
      railId: RAIL.railId,
      railVersion: RAIL.railVersion,
      railRegistryVersion: authorization.railRegistryVersion,
      descriptorHash: sha256Hex(canonicalize(RAIL)),
      railType: "x402",
      handler: "pay-x402",
      asset: "USDC",
      network: NETWORK,
      finality: {
        model: "block-depth",
        finalityBlocks: 5,
      },
    },
  };
  const provider: SessionSettlementVerificationProvider = {
    authenticateContext: (candidate) =>
      canonicalize(candidate) === canonicalize(context)
        ? { disposition: "pass" }
        : { disposition: "fail", reason: "settlement context binding mismatch" },
    verifyEvidenceAnchor: ({ context: candidate, evidence, evidenceRef, anchorReceipt }) =>
      canonicalize(candidate) === canonicalize(context) &&
        canonicalize(evidence) === canonicalize(published.settlement.evidence) &&
        canonicalize(evidenceRef) === canonicalize(published.settlement.evidenceRef) &&
        contentHash(evidence as unknown as Record<string, unknown>) ===
          evidenceRef.contentHash &&
        anchorReceipt.logicalAddress === evidenceRef.anchor.locator &&
        anchorReceipt.contentHash === evidenceRef.contentHash &&
        anchorReceipt.writer === SELLER &&
        verifyLocalReceipt(anchorReceipt)
        ? { disposition: "pass" }
        : { disposition: "fail", reason: "settlement evidence publication mismatch" },
    resolveNativeProof: (candidate) =>
      canonicalize(candidate) === canonicalize(nativeProofRef)
        ? {
            disposition: "present",
            artifact: structuredClone(proofArtifact),
          }
        : { disposition: "absent" },
    revalidateSettlement: async (request) => {
      const authentication = await authenticateNativeProof(
        authorization,
        request.nativeProofRef,
      );
      if (
        authentication.disposition !== "authenticated" ||
        canonicalize(request.context) !== canonicalize(context) ||
        canonicalize(request.evidence) !==
          canonicalize(published.settlement.evidence) ||
        canonicalize(request.nativeProof) !== canonicalize(proofArtifact)
      ) {
        return {
          disposition: "fail",
          reason: "fresh x402 native observation failed exact binding",
        };
      }
      return {
        disposition: "pass",
        outcome: "success",
        binding: {
          jobId: request.context.jobId,
          railId: request.context.rail.railId,
          phaseIndex: request.context.paymentPhaseIndex,
          settlementId: authorization.settlementId,
        },
        nativeObservation: {
          observationVersion: "1",
          kind: "authenticated-x402-event",
          observedAt: input.settlement.state.now,
          finality: structuredClone(authorization.evidenceInput.settlementFinality),
          sessionBinding: {
            disposition: "established",
            kind: "eip3009",
            bindingHash: input.settlement.intent.bindingHash,
          },
          details: {
            chainId: CHAIN_ID,
            transactionHash: TX_HASH,
            blockHash: BLOCK_HASH,
            logIndex: 7,
            headBlockNumber: 110,
          },
        },
      };
    },
    evidence: evidenceVerifier,
  };
  const verified = await verifyFinalizedSessionSettlement(
    context,
    published.settlement,
    provider,
  );
  expect(verified.disposition).toBe("verified");
  return {
    settlement: published.settlement,
    context,
    provider,
  };
}

async function closeDetachedRoleBundles(input: {
  published: PublishedListing;
  agreement: AgreementRun;
  commitment: Awaited<ReturnType<typeof commitAgreement>>;
  settlement: SettlementRun;
  sellerSettlement: Awaited<ReturnType<typeof publishAndVerifySellerSettlement>>;
}) {
  const fulfilment = input.settlement.fulfilment;
  const deliveryEvidence = fulfilment.evidence;
  if (deliveryEvidence.outcome !== "success") {
    throw new Error("completed seller fulfilment retained failure evidence");
  }
  const commitmentHash = contentHash(
    input.commitment.record as unknown as Record<string, unknown>,
  );
  const commitmentRef: AttestationRef = {
    anchor: { kind: "storage-program", locator: input.commitment.logicalAddress },
    contentHash: commitmentHash,
    signer: SELLER,
  };
  const paymentRef = input.sellerSettlement.settlement.evidenceRef;
  const deliveryRef = fulfilment.evidenceRef;
  const buyerVetRef = vetRef("buyer");
  const sellerVetRef = vetRef("seller");
  const verifiedAgreement: SellerFulfilmentAgreement = {
      artifactKind: "payee-bound",
      ref: input.agreement.agreementRef.anchor.locator,
      contentHash: input.agreement.agreementHash,
      jobId: JOB_ID,
      listingPin: input.published.listingPin,
      buyer: {
        primaryClaim: BUYER,
        bundleHash: identityBundleHash(BUYER_IDENTITY),
        vetRecordRef: buyerVetRef,
        storageAddress: "demos:buyer-storage",
      },
      seller: {
        primaryClaim: SELLER,
        bundleHash: identityBundleHash(SELLER_IDENTITY),
        vetRecordRef: sellerVetRef,
      },
      deliverableRef: {
        deliverableType: "storage-program",
        hash: sha256Hex(canonicalize(input.published.listing.offering.deliverable)),
      },
      commitment: {
        status: "finalized",
        ref: input.commitment.logicalAddress,
        agreementHash: input.agreement.agreementHash,
        recordContentHash: commitmentHash,
        finalizedAt: input.commitment.committedAt,
        signer: SELLER,
      },
  };
  const verifiedListing: SellerFulfilmentListing = {
    pin: structuredClone(input.published.listingPin),
    sellerPrimaryClaim: SELLER,
    buyerRequirement: structuredClone(input.published.listing.buyerRequirement),
    pipeline: structuredClone(input.published.listing.pipeline),
    deliverable: structuredClone(input.published.listing.offering.deliverable),
  };
  const durableRecord = await input.settlement.seller.fulfilmentStore.load(JOB_ID);
  if (durableRecord.status !== "ok") {
    throw new Error("seller terminal WAL was unavailable for audit projection");
  }
  const projection = await projectDurableSellerAuditPending({
    record: durableRecord.record,
    verifiedAgreement: structuredClone(verifiedAgreement),
    verifiedListing: structuredClone(verifiedListing),
    expectedDeliveryWriter: { role: "seller", primaryClaim: SELLER },
    verifyEvidenceSignature: verifySellerEvidenceSignature,
    verifyAuditSourceCommitmentSignature:
      verifySellerAuditSourceCommitmentSignature,
    verifyAnchorReceipt: verifySellerAnchorReceipt,
  });
  const sellerInput: FinalizeCompletedSellerBundleInput = {
    agreement: verifiedAgreement,
    agreementRef: input.agreement.agreementRef,
    fulfilment: projection.terminal.result,
    session: projection.session,
    sessionArtifacts: projection.sessionArtifacts,
    finalisedAt: input.settlement.state.now,
    seller: {
      primaryClaim: SELLER,
      bundleHash: identityBundleHash(SELLER_IDENTITY),
      signer: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED)),
    },
    counterSignatures: [],
    dependencies: [],
  };
  const artifactByHash = new Map<string, Record<string, unknown>>([
    [input.published.listingPin.contentHash, input.published.listing as unknown as Record<string, unknown>],
    [input.agreement.agreementRef.contentHash, input.agreement.agreement as unknown as Record<string, unknown>],
    [commitmentHash, input.commitment.record as unknown as Record<string, unknown>],
    [
      paymentRef.contentHash,
      input.sellerSettlement.settlement.evidence as unknown as Record<string, unknown>,
    ],
    [deliveryRef.contentHash, deliveryEvidence as unknown as Record<string, unknown>],
    [buyerVetRef.contentHash, BUYER_VET as unknown as Record<string, unknown>],
    [sellerVetRef.contentHash, SELLER_VET as unknown as Record<string, unknown>],
    [deliveryEvidence.deliverableContentHash, { answer: 42, jobId: JOB_ID }],
  ]);
  const dependency = (
    source: FinalizeCompletedSellerBundleInput["dependencies"][number]["source"],
    hash: string,
    logicalAddress: string,
    receipt = finalizedReceipt(logicalAddress, hash),
  ): FinalizeCompletedSellerBundleInput["dependencies"][number] => ({
    source,
    anchorReceipt: receipt,
  });
  sellerInput.dependencies = [
    dependency(
      { kind: "listing", listingRef: input.published.listingPin },
      input.published.listingPin.contentHash,
      listingAddress(SELLER, input.published.listingPin.listingId, input.published.listingPin.version),
    ),
    dependency(
      { kind: "attestation-ref", ref: input.agreement.agreementRef },
      input.agreement.agreementRef.contentHash,
      input.agreement.agreementRef.anchor.locator,
      input.agreement.anchorReceipt,
    ),
    dependency(
      { kind: "attestation-ref", ref: commitmentRef },
      commitmentHash,
      commitmentRef.anchor.locator,
      input.commitment.anchorReceipt,
    ),
    dependency(
      { kind: "attestation-ref", ref: paymentRef },
      paymentRef.contentHash,
      paymentRef.anchor.locator,
      input.sellerSettlement.settlement.anchorReceipt,
    ),
    dependency(
      { kind: "attestation-ref", ref: deliveryRef },
      deliveryRef.contentHash,
      deliveryRef.anchor.locator,
      fulfilment.evidenceAnchorReceipt,
    ),
    dependency(
      { kind: "attestation-ref", ref: buyerVetRef },
      buyerVetRef.contentHash,
      buyerVetRef.anchor.locator,
    ),
    dependency(
      { kind: "attestation-ref", ref: sellerVetRef },
      sellerVetRef.contentHash,
      sellerVetRef.anchor.locator,
    ),
    dependency(
      {
        kind: "deliverable",
        anchor: deliveryEvidence.deliverableAnchor,
        contentHash: deliveryEvidence.deliverableContentHash,
        encoding: "jcs",
      },
      deliveryEvidence.deliverableContentHash,
      deliveryEvidence.deliverableAnchor.locator,
    ),
  ];
  const externalDir = await tempDir("issue114-bundle-external");
  const externalKey = {
    sellerRequest: "transport:seller-request",
    counterSignature: "transport:buyer-counter-signature",
    sellerFinalization: "transport:seller-finalization",
    sellerSignature: (idempotencyKey: string) =>
      `signature:seller:${idempotencyKey}`,
    buyerSignature: (idempotencyKey: string) =>
      `signature:buyer:${idempotencyKey}`,
    sellerAnchor: (logicalAddress: string) =>
      `anchor:seller:${logicalAddress}`,
    buyerAnchor: (logicalAddress: string) =>
      `anchor:buyer:${logicalAddress}`,
  } as const;
  const verifier = {
    resolvePublicKey: async (claim: string) => claim === BUYER
      ? rawPublicKey(publicKeyFromSeed(BUYER_SEED))
      : claim === SELLER
        ? rawPublicKey(publicKeyFromSeed(SELLER_SEED))
        : null,
    verify: async (bytes: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) =>
      ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
  };
  const verifyKnownArtifact = async (
    requirement: { contentHash: string },
    artifact: unknown,
  ): Promise<"valid" | "invalid"> => {
    const retained = artifactByHash.get(requirement.contentHash);
    if (!retained || canonicalize(retained) !== canonicalize(artifact)) return "invalid";
    if (requirement.contentHash === input.published.listingPin.contentHash) {
      const validation = await validateListingArtifact(
        retained,
        listingValidationDeps(),
      );
      return validation.disposition === "verified" ? "valid" : "invalid";
    }
    const verifySignature = (
      bytes: Uint8Array,
      signature: { algorithm: string; signer: string; value: string },
    ): boolean => {
      const seed = localReceiptSeed(signature.signer);
      return signature.algorithm === "ed25519" && seed !== null &&
        ed25519Verify(
          bytes,
          Uint8Array.from(Buffer.from(signature.value, "base64url")),
          publicKeyFromSeed(seed),
        );
    };
    if (requirement.contentHash === input.agreement.agreementRef.contentHash) {
      const agreement = retained as unknown as AgreementArtifact;
      const separator = "agreementVersion" in agreement
        ? ARTIFACT_SEPARATORS.AgreementDocument
        : ARTIFACT_SEPARATORS.PayeeBoundAgreementDocument;
      const bytes = signedBytes(separator, requirement.contentHash);
      return agreement.signatures.length === 2 && agreement.signatures.every((signature) =>
        verifySignature(bytes, {
          algorithm: signature.algorithm,
          signer: signature.party,
          value: signature.value,
        }))
        ? "valid"
        : "invalid";
    }
    if (requirement.contentHash === commitmentHash) {
      const record = retained as unknown as FinalityCommitmentRecord;
      const { signature } = record;
      return verifySignature(
        signedBytes(
          "dacs-finality-commitment:v1:",
          requirement.contentHash,
        ),
        signature,
      ) ? "valid" : "invalid";
    }
    if (
      requirement.contentHash === paymentRef.contentHash ||
      requirement.contentHash === deliveryRef.contentHash
    ) {
      const evidence = retained as unknown as SettlementEvidence;
      return verifySignature(
        signedBytes(ARTIFACT_SEPARATORS.SettlementEvidence, requirement.contentHash),
        evidence.signature,
      ) ? "valid" : "invalid";
    }
    if (
      requirement.contentHash === buyerVetRef.contentHash ||
      requirement.contentHash === sellerVetRef.contentHash
    ) {
      const record = retained as unknown as CompositeVerificationRecord;
      return verifySignature(
        signedBytes(
          ARTIFACT_SEPARATORS.CompositeVerificationRecord,
          requirement.contentHash,
        ),
        record.signature,
      ) ? "valid" : "invalid";
    }
    return requirement.contentHash === deliveryEvidence.deliverableContentHash
      ? "valid"
      : "invalid";
  };
  // Standard #331 has not defined a normative complementary-requirement source.
  // This fixture therefore authenticates an explicitly non-normative operational
  // envelope and reports the standards gap; it never labels that envelope DACS.
  const standard331Envelope = {
    profile: "issue-114-local-operational-v1",
    normative: false,
    standardsGap: "DACS-Standard#331",
    jobId: JOB_ID,
    vetRecordHash: sellerVetRef.contentHash,
    evaluatedParty: SELLER,
    requirementHash: sha256Hex(canonicalize(EMPTY_REQUIREMENT)),
    verifier: SELLER,
  } as const;
  const standard331Signature = ed25519Sign(
    Buffer.from(canonicalize(standard331Envelope), "utf8"),
    privateKeyFromSeed(BUYER_SEED),
  );
  const sellerReadProvider = {
    mapping: "pure" as const,
    bundleCopyVerifier: verifier,
    compositeVerificationDeps: {
      resolveRecipe: async () => null,
      isRecipeSignerAuthorized: () => false,
      isVerifyResultSignerAuthorized: (_result: unknown, signature: { signer: string }) =>
        signature.signer === SELLER,
      resolvePublicKey: async (signature: { signer: string; algorithm: string }) =>
        signature.signer === SELLER && signature.algorithm === "ed25519"
          ? rawPublicKey(publicKeyFromSeed(SELLER_SEED))
          : null,
      verify: ({ signedBytes: bytes, signature, publicKey }: {
        signedBytes: Uint8Array;
        signature: { value: string };
        publicKey: Uint8Array;
      }) => ed25519Verify(
        bytes,
        Uint8Array.from(Buffer.from(signature.value, "base64url")),
        publicKeyFromRaw(publicKey),
      ),
      verifyAuthorityAttestation: () => "unresolved" as const,
    },
    resolveDependency: (candidate: FinalizeCompletedSellerBundleInput["dependencies"][number]) => {
      const artifact = artifactByHash.get(candidate.anchorReceipt.contentHash);
      return artifact
        ? { disposition: "present" as const, artifact: structuredClone(artifact) }
        : { disposition: "absent" as const };
    },
    verifyDependencyReceipt: (
      dependency: FinalizeCompletedSellerBundleInput["dependencies"][number],
      requirement: { contentHash: string },
    ) => verifyLocalReceipt(dependency.anchorReceipt) &&
        dependency.anchorReceipt.contentHash === requirement.contentHash
      ? "valid" as const
      : "invalid" as const,
    verifyDependencyBinding: async ({ requirement, artifact }: {
      requirement: { contentHash: string };
      artifact: unknown;
    }) => verifyKnownArtifact(requirement, artifact),
    verifyListingPublisherIdentityLinkage: ({
      listingIdentity,
      listingBundleHash,
      sessionBundleHash,
      primaryClaim,
    }: {
      listingIdentity: Readonly<IdentityBundle>;
      listingBundleHash: string;
      sessionBundleHash: string;
      primaryClaim: string;
    }) => listingIdentity.presentedBy === primaryClaim &&
        primaryClaim === SELLER &&
        listingBundleHash === identityBundleHash(listingIdentity) &&
        sessionBundleHash === identityBundleHash(SELLER_IDENTITY)
      ? "valid" as const
      : "invalid" as const,
    verifyVetRequirementProvenance: ({ invocation, compositeRecord, listingOwned }: {
      invocation: FinalizeCompletedSellerBundleInput["sessionArtifacts"]["vetRequirements"][number];
      compositeRecord: Readonly<CompositeVerificationRecord>;
      listingOwned: boolean;
    }) => {
      if (listingOwned) {
        return invocation.evaluatedParty === BUYER &&
            canonicalize(invocation.requirement) === canonicalize(EMPTY_REQUIREMENT) &&
            compositeRecord.evaluatedParty === BUYER
          ? "valid" as const
          : "invalid" as const;
      }
      const expectedEnvelope = {
        ...standard331Envelope,
        vetRecordHash: contentHash(
          compositeRecord as unknown as Record<string, unknown>,
        ),
        evaluatedParty: invocation.evaluatedParty,
        requirementHash: sha256Hex(canonicalize(invocation.requirement)),
        verifier: invocation.verifier,
      };
      return canonicalize(expectedEnvelope) === canonicalize(standard331Envelope) &&
          ed25519Verify(
            Buffer.from(canonicalize(expectedEnvelope), "utf8"),
            standard331Signature,
            publicKeyFromSeed(BUYER_SEED),
          )
        ? "valid" as const
        : "indeterminate" as const;
    },
    resolvePaymentPhaseIndex: ({ dependency, evidence }: {
      dependency: FinalizeCompletedSellerBundleInput["dependencies"][number];
      evidence: Record<string, unknown>;
    }) => dependency.anchorReceipt.logicalAddress === paymentRef.anchor.locator &&
        dependency.anchorReceipt.contentHash === paymentRef.contentHash &&
        canonicalize(evidence) ===
          canonicalize(input.sellerSettlement.settlement.evidence)
      ? {
          disposition: "valid" as const,
          jobId: JOB_ID,
          railId: RAIL.railId,
          phaseIndex: PAYMENT_PHASE_INDEX,
          resolved: false,
        }
      : {
          disposition: "invalid" as const,
          reason: "payment evidence anchor is not the exact PC-2 phase address",
        },
    resolveSellerBundle: async (logicalAddress: string) => {
      const found = await readExternalRecord<AnchoredSellerBundle>(
        externalDir,
        externalKey.sellerAnchor(logicalAddress),
      );
      return found
        ? { disposition: "present" as const, anchored: found }
        : { disposition: "absent" as const };
    },
    verifyBundleAnchorReceipt: (anchored: Readonly<AnchoredSellerBundle>) =>
      verifyLocalReceipt(anchored.anchorReceipt) &&
        anchored.anchorReceipt.contentHash ===
          attestationBundleHash(anchored.bundle as FaultAttestationBundle) &&
        anchored.anchorReceipt.nativeAddress === anchored.nativeAddress
        ? "valid" as const
        : "invalid" as const,
    resolveBundleBinding: () => ({ disposition: "absent" as const }),
  };
  const {
    seller: sellerSigner,
    counterSignatures: _counterSignatures,
    bindingSigner: _bindingSigner,
    ...verificationFacts
  } = sellerInput;
  const requestVerificationInput = {
    ...verificationFacts,
    seller: {
      primaryClaim: sellerSigner.primaryClaim,
      bundleHash: sellerSigner.bundleHash,
    },
  };
  {
    const processARequest = prepareCompletedSellerBundleCounterSignatureRequest(sellerInput);
    await writeExternalRecord(externalDir, externalKey.sellerRequest, processARequest);
  }
  let missingBuyerSignCalls = 0;
  let missingBuyerWrites = 0;
  await expect(finalizeCompletedSellerBundleCore({
    ...sellerInput,
    seller: {
      ...sellerInput.seller,
      signer: (bytes: Uint8Array) => {
        missingBuyerSignCalls += 1;
        return ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED));
      },
    },
    counterSignatures: [],
  }, {
    ...sellerReadProvider,
    submitSellerBundle: () => {
      missingBuyerWrites += 1;
    },
  })).rejects.toThrow(/buyer.*signature|counter-signature/i);
  expect({ missingBuyerSignCalls, missingBuyerWrites }).toEqual({
    missingBuyerSignCalls: 0,
    missingBuyerWrites: 0,
  });

  const effects = {
    sellerSign: 0,
    sellerAnchor: 0,
    buyerSign: 0,
    counterSignaturePublication: 0,
    sellerFinalizationPublication: 0,
    buyerAnchor: 0,
  };
  let loseCounterPublicationAcknowledgement = true;
  let loseSellerSignatureAcknowledgement = true;

  const createSellerProvider = (): DurableSellerBundleFinalizationProvider => ({
    ...sellerReadProvider,
    submitSellerBundle: async (
      logicalAddress: string,
      bundle: Readonly<FaultAttestationBundle>,
      fence: Readonly<SellerBundleEffectFence>,
    ) => {
      expect(fence.idempotencyKey.length).toBeGreaterThan(20);
      const stored = structuredClone(bundle);
      const hash = attestationBundleHash(stored);
      const nativeAddress = `native:${sha256Hex(logicalAddress).slice(0, 24)}`;
      const key = externalKey.sellerAnchor(logicalAddress);
      const existing = await readExternalRecord<AnchoredSellerBundle>(
        externalDir,
        key,
      );
      if (existing) {
        if (canonicalize(existing.bundle) !== canonicalize(stored)) {
          throw new Error("seller bundle idempotency key rebound to different bytes");
        }
        return;
      }
      effects.sellerAnchor += 1;
      await writeExternalRecord(externalDir, key, {
        bundle: stored,
        nativeAddress,
        anchorTx: `tx:${logicalAddress}`,
        anchorReceipt: finalizedReceipt(logicalAddress, hash),
      });
    },
  });
  const createBuyerProvider = (): DurableBuyerBundleFinalizationProvider => ({
    ...sellerReadProvider,
    resolveBuyerBundle: async (logicalAddress: string) => {
      const found = await readExternalRecord<AnchoredBuyerBundle>(
        externalDir,
        externalKey.buyerAnchor(logicalAddress),
      );
      return found
        ? { disposition: "present" as const, anchored: found }
        : { disposition: "absent" as const };
    },
    submitBuyerBundle: async (
      logicalAddress: string,
      bundle: Readonly<FaultAttestationBundle>,
      fence: Readonly<BuyerBundleEffectFence>,
    ) => {
      expect(fence.idempotencyKey.length).toBeGreaterThan(20);
      const stored = structuredClone(bundle);
      const hash = attestationBundleHash(stored);
      const nativeAddress = `native:${sha256Hex(logicalAddress).slice(0, 24)}`;
      const key = externalKey.buyerAnchor(logicalAddress);
      const existing = await readExternalRecord<AnchoredBuyerBundle>(
        externalDir,
        key,
      );
      if (existing) {
        if (canonicalize(existing.bundle) !== canonicalize(stored)) {
          throw new Error("buyer bundle idempotency key rebound to different bytes");
        }
        return;
      }
      effects.buyerAnchor += 1;
      await writeExternalRecord(externalDir, key, {
        bundle: stored,
        nativeAddress,
        anchorTx: `tx:${logicalAddress}`,
        anchorReceipt: finalizedReceipt(logicalAddress, hash, BUYER),
      });
    },
  });

  const createSellerDurableInput = (
    counterSignatures: BundleSignature[],
    loseSignatureAcknowledgement = false,
  ): FinalizeCompletedSellerBundleDurableInput => ({
    ...sellerInput,
    verifiedListing: {
      pin: input.published.listingPin,
      sellerPrimaryClaim: SELLER,
      buyerRequirement: structuredClone(input.published.listing.buyerRequirement),
      pipeline: structuredClone(input.published.listing.pipeline),
      deliverable: structuredClone(input.published.listing.offering.deliverable),
    },
    counterSignatures: structuredClone(counterSignatures),
    seller: {
      primaryClaim: SELLER,
      bundleHash: identityBundleHash(SELLER_IDENTITY),
      signer: async (bytes, fence) => {
        expect(fence.idempotencyKey.length).toBeGreaterThan(20);
        const key = externalKey.sellerSignature(fence.idempotencyKey);
        const existing = await readExternalRecord<string>(externalDir, key);
        if (existing) {
          const decoded = Uint8Array.from(Buffer.from(existing, "base64url"));
          if (!ed25519Verify(bytes, decoded, publicKeyFromSeed(SELLER_SEED))) {
            throw new Error("durable seller signature is rebound to another message");
          }
          return decoded;
        }
        effects.sellerSign += 1;
        const value = ed25519Sign(bytes, privateKeyFromSeed(SELLER_SEED));
        await writeExternalRecord(
          externalDir,
          key,
          Buffer.from(value).toString("base64url"),
        );
        if (loseSignatureAcknowledgement && loseSellerSignatureAcknowledgement) {
          loseSellerSignatureAcknowledgement = false;
          throw new Error("lost seller signature acknowledgement");
        }
        return value;
      },
    },
  });
  const createSellerDurability = (
    store: Awaited<ReturnType<typeof createFsFencedSessionStore>>,
    workerId: string,
  ): SellerBundleFinalizationDurability => ({
    store,
    workerId,
    leaseTtlMs: 1_000,
    leaseNowMs: () => input.settlement.state.now,
    terminalVerification: {
      verifyEvidenceSignature: verifySellerEvidenceSignature,
      verifyAuditSourceCommitmentSignature:
        verifySellerAuditSourceCommitmentSignature,
      verifyAnchorReceipt: verifySellerAnchorReceipt,
    },
    reconcileSignature: async ({ signedBytes: bytes, fence }) => {
      const value = await readExternalRecord<string>(
        externalDir,
        externalKey.sellerSignature(fence.idempotencyKey),
      );
      if (value && !ed25519Verify(
        bytes,
        Uint8Array.from(Buffer.from(value, "base64url")),
        publicKeyFromSeed(SELLER_SEED),
      )) {
        return {
          disposition: "indeterminate" as const,
          reason: "seller signature is rebound",
        };
      }
      return value
        ? { disposition: "signed" as const, value }
        : {
            disposition: "authoritatively-absent" as const,
            reason: "seller signature is absent",
          };
    },
    reconcileBundleAnchor: async ({ logicalAddress, bundleContentHash }) => {
      const anchored = await readExternalRecord<AnchoredSellerBundle>(
        externalDir,
        externalKey.sellerAnchor(logicalAddress),
      );
      return anchored &&
          anchored.anchorReceipt.logicalAddress === logicalAddress &&
          anchored.anchorReceipt.contentHash === bundleContentHash &&
          anchored.anchorReceipt.nativeAddress === anchored.nativeAddress &&
          attestationBundleHash(
            anchored.bundle as FaultAttestationBundle,
          ) === bundleContentHash &&
          verifyLocalReceipt(anchored.anchorReceipt)
        ? { disposition: "present" as const }
        : {
            disposition: "authoritatively-absent" as const,
            reason: "seller bundle anchor is absent",
          };
    },
    reconcileBindingPublication: () => ({
      disposition: "authoritatively-absent",
      reason: "pure bundle mapping has no binding publication",
    }),
  });

  const buyerStoreDir = await tempDir("issue114-buyer-bundle");
  let buyerStore = await createFsFencedSessionStore({ dir: buyerStoreDir });
  await buyerStore.create({
    jobId: JOB_ID,
    agreementHash: input.agreement.agreementHash,
    phase: "settled",
    now: input.settlement.state.now,
  });
  const createBuyerInput = (): DurableBuyerBundleFinalizationInput => ({
    sellerVerificationInput: requestVerificationInput,
    settlementContext: input.sellerSettlement.context,
    settlement: input.sellerSettlement.settlement,
    buyer: {
      primaryClaim: BUYER,
      bundleHash: identityBundleHash(BUYER_IDENTITY),
      signer: async (bytes, fence) => {
        expect(fence.idempotencyKey.length).toBeGreaterThan(20);
        const key = externalKey.buyerSignature(fence.idempotencyKey);
        const existing = await readExternalRecord<string>(externalDir, key);
        if (existing) {
          const decoded = Uint8Array.from(Buffer.from(existing, "base64url"));
          if (!ed25519Verify(bytes, decoded, publicKeyFromSeed(BUYER_SEED))) {
            throw new Error("durable buyer signature is rebound to another message");
          }
          return decoded;
        }
        effects.buyerSign += 1;
        const value = ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED));
        await writeExternalRecord(
          externalDir,
          key,
          Buffer.from(value).toString("base64url"),
        );
        return value;
      },
    },
  });
  const createBuyerDurability = (
    store: Awaited<ReturnType<typeof createFsFencedSessionStore>>,
    workerId: string,
    losePublicationAcknowledgement = false,
  ): BuyerBundleFinalizationDurability => ({
    store,
    workerId,
    leaseTtlMs: 1_000,
    leaseNowMs: () => input.settlement.state.now,
    settlementVerification: input.sellerSettlement.provider,
    transport: {
      resolveSellerRequest: async () => {
        const retained = await readExternalRecord<unknown>(
          externalDir,
          externalKey.sellerRequest,
        );
        return retained
          ? { disposition: "present" as const, value: retained }
          : {
              disposition: "absent" as const,
              reason: "seller request is absent",
            };
      },
      publishCounterSignature: async ({ signature }, fence) => {
        expect(fence.idempotencyKey.length).toBeGreaterThan(20);
        const existing = await readExternalRecord<BundleSignature>(
          externalDir,
          externalKey.counterSignature,
        );
        if (existing && canonicalize(existing) !== canonicalize(signature)) {
          throw new Error("counter-signature publication is rebound");
        }
        if (!existing) {
          effects.counterSignaturePublication += 1;
          await writeExternalRecord(
            externalDir,
            externalKey.counterSignature,
            signature,
          );
        }
        if (losePublicationAcknowledgement && loseCounterPublicationAcknowledgement) {
          loseCounterPublicationAcknowledgement = false;
          throw new Error("lost counter-signature publication acknowledgement");
        }
        return { disposition: "published" };
      },
      resolveCounterSignatures: async () => {
        const retained = await readExternalRecord<BundleSignature>(
          externalDir,
          externalKey.counterSignature,
        );
        return retained
          ? { disposition: "present" as const, value: [retained] }
          : {
              disposition: "absent" as const,
              reason: "buyer counter-signature is not published",
            };
      },
      resolveSellerFinalization: async () => {
        const retained = await readExternalRecord<unknown>(
          externalDir,
          externalKey.sellerFinalization,
        );
        return retained
          ? { disposition: "present" as const, value: retained }
          : {
              disposition: "absent" as const,
              reason: "seller is waiting for the buyer counter-signature",
            };
      },
    },
    reconcileSignature: async ({ signedBytes: bytes, fence }) => {
      const value = await readExternalRecord<string>(
        externalDir,
        externalKey.buyerSignature(fence.idempotencyKey),
      );
      if (value && !ed25519Verify(
        bytes,
        Uint8Array.from(Buffer.from(value, "base64url")),
        publicKeyFromSeed(BUYER_SEED),
      )) {
        return { disposition: "rejected", reason: "buyer signature is rebound" };
      }
      return value
        ? { disposition: "signed" as const, value }
        : {
            disposition: "authoritatively-absent" as const,
            reason: "buyer signature is absent",
          };
    },
    reconcileCounterSignaturePublication: async ({ signature }) => {
      const retained = await readExternalRecord<BundleSignature>(
        externalDir,
        externalKey.counterSignature,
      );
      if (retained && canonicalize(retained) !== canonicalize(signature)) {
        return {
          disposition: "rejected" as const,
          reason: "counter-signature publication is substituted",
        };
      }
      return retained
        ? { disposition: "present" as const, signature: retained }
        : {
            disposition: "authoritatively-absent" as const,
            reason: "buyer counter-signature publication is absent",
          };
    },
    reconcileBuyerBundleAnchor: async ({ logicalAddress, bundleContentHash }) => {
      const anchored = await readExternalRecord<AnchoredBuyerBundle>(
        externalDir,
        externalKey.buyerAnchor(logicalAddress),
      );
      return anchored &&
          anchored.anchorReceipt.logicalAddress === logicalAddress &&
          anchored.anchorReceipt.contentHash === bundleContentHash &&
          anchored.anchorReceipt.nativeAddress === anchored.nativeAddress &&
          attestationBundleHash(
            anchored.bundle as FaultAttestationBundle,
          ) === bundleContentHash &&
          verifyLocalReceipt(anchored.anchorReceipt)
        ? { disposition: "present" as const }
        : {
            disposition: "authoritatively-absent" as const,
            reason: "buyer bundle anchor is absent",
          };
    },
    reconcileBindingPublication: () => ({
      disposition: "authoritatively-absent",
      reason: "pure bundle mapping has no binding publication",
    }),
  });

  const interruptedBuyer = await advanceCompletedBuyerBundleDurable(
    createBuyerInput(),
    createBuyerProvider(),
    createBuyerDurability(
      buyerStore,
      "buyer-bundle-process-a",
      true,
    ),
  );
  expect(interruptedBuyer).toMatchObject({
    disposition: "indeterminate",
    stage: "counter-signature-publication",
    reason: "lost counter-signature publication acknowledgement",
  });
  expect(loseCounterPublicationAcknowledgement).toBe(false);

  // Process B owns no process-A signature or transport cache. It reopens both
  // its SDK store and the independently persisted publication through fresh adapters.
  buyerStore = await createFsFencedSessionStore({ dir: buyerStoreDir });
  const waitingForSeller = await advanceCompletedBuyerBundleDurable(
    createBuyerInput(),
    createBuyerProvider(),
    createBuyerDurability(buyerStore, "buyer-bundle-process-b"),
  );
  expect(waitingForSeller).toMatchObject({
    disposition: "waiting",
    stage: "seller-finalisation",
  });
  const readAuthenticatedBuyerCounterSignature = async (): Promise<BundleSignature> => {
    const [retainedSellerRequest, retainedCounterSignature] = await Promise.all([
      readExternalRecord<unknown>(externalDir, externalKey.sellerRequest),
      readExternalRecord<BundleSignature>(externalDir, externalKey.counterSignature),
    ]);
    if (!retainedCounterSignature) {
      throw new Error("fresh seller process could not recover the buyer counter-signature");
    }
    const authenticatedSellerRequest =
      await verifyCompletedSellerBundleCounterSignatureRequest(
        structuredClone(requestVerificationInput),
        retainedSellerRequest,
        createSellerProvider(),
      );
    expect(retainedCounterSignature).toMatchObject({
      algorithm: "ed25519",
      party: BUYER,
    });
    expect(ed25519Verify(
      authenticatedSellerRequest.signedBytes,
      Uint8Array.from(Buffer.from(retainedCounterSignature.value, "base64url")),
      publicKeyFromSeed(BUYER_SEED),
    )).toBe(true);
    return structuredClone(retainedCounterSignature);
  };

  let sellerBundleStore = await createFsFencedSessionStore({
    dir: input.settlement.sellerDirs.fulfilment,
  });
  await (async () => {
    const processBCounterSignature = await readAuthenticatedBuyerCounterSignature();
    await expect(finalizeCompletedSellerBundleDurable(
      createSellerDurableInput([processBCounterSignature], true),
      createSellerProvider(),
      createSellerDurability(sellerBundleStore, "seller-bundle-process-b"),
    )).rejects.toThrow("seller bundle signing failed");
  })();
  expect(loseSellerSignatureAcknowledgement).toBe(false);

  // Process C recovers and authenticates the request, counter-signature, and
  // seller signature again before it performs the one seller anchor write.
  sellerBundleStore = await createFsFencedSessionStore({
    dir: input.settlement.sellerDirs.fulfilment,
  });
  await (async () => {
    const processCCounterSignature = await readAuthenticatedBuyerCounterSignature();
    const produced = await finalizeCompletedSellerBundleDurable(
      createSellerDurableInput([processCCounterSignature]),
      createSellerProvider(),
      createSellerDurability(sellerBundleStore, "seller-bundle-process-c"),
    );
    expect(await verifyBundleCopy(
      produced.sellerBundle as unknown as Record<string, unknown>,
      "seller",
      verifier,
    )).toMatchObject({ valid: true, fullySigned: true });
    effects.sellerFinalizationPublication += 1;
    await writeExternalRecord(
      externalDir,
      externalKey.sellerFinalization,
      produced,
    );
  })();
  const sellerFinalization = await readExternalRecord<
    Awaited<ReturnType<typeof finalizeCompletedSellerBundleDurable>>
  >(externalDir, externalKey.sellerFinalization);
  if (!sellerFinalization) {
    throw new Error("seller finalization handoff was not durably published");
  }
  expect(attestationBundleHash(sellerFinalization.sellerBundle)).toBe(
    sellerFinalization.bundleContentHash,
  );
  expect(sellerFinalization.logicalAddress).toBe(bundleAddress(JOB_ID, "seller"));
  expect(sellerFinalization.anchorReceipt).toMatchObject({
    logicalAddress: sellerFinalization.logicalAddress,
    nativeAddress: sellerFinalization.nativeAddress,
    contentHash: sellerFinalization.bundleContentHash,
    writer: SELLER,
    state: "finalized",
  });
  expect(verifyLocalReceipt(sellerFinalization.anchorReceipt)).toBe(true);
  expect(await verifyBundleCopy(
    sellerFinalization.sellerBundle as unknown as Record<string, unknown>,
    "seller",
    verifier,
  )).toMatchObject({ valid: true, fullySigned: true });
  expect(await verifyBundleCopy(
    sellerFinalization.buyerBundle as unknown as Record<string, unknown>,
    "buyer",
    verifier,
  )).toMatchObject({ valid: true, fullySigned: true });
  const sellerFinalizationAnchor = await readExternalRecord<AnchoredSellerBundle>(
    externalDir,
    externalKey.sellerAnchor(sellerFinalization.logicalAddress),
  );
  if (!sellerFinalizationAnchor) {
    throw new Error("seller finalization anchor is not externally readable");
  }
  expect(sellerFinalizationAnchor).toMatchObject({
    nativeAddress: sellerFinalization.nativeAddress,
    anchorReceipt: sellerFinalization.anchorReceipt,
  });
  expect(canonicalize(sellerFinalizationAnchor.bundle)).toBe(
    canonicalize(sellerFinalization.sellerBundle),
  );

  buyerStore = await createFsFencedSessionStore({ dir: buyerStoreDir });
  const completedBuyer = await advanceCompletedBuyerBundleDurable(
    createBuyerInput(),
    createBuyerProvider(),
    createBuyerDurability(buyerStore, "buyer-bundle-process-c"),
  );
  expect(completedBuyer.disposition).toBe("finalised");
  if (completedBuyer.disposition !== "finalised") {
    throw new Error(completedBuyer.reason);
  }
  const buyerFinalization = completedBuyer.result;

  const beforeReplay = structuredClone(effects);
  const sellerReplayStore = await createFsFencedSessionStore({
    dir: input.settlement.sellerDirs.fulfilment,
  });
  const processDCounterSignature = await readAuthenticatedBuyerCounterSignature();
  const sellerReplay = await finalizeCompletedSellerBundleDurable(
    createSellerDurableInput([processDCounterSignature]),
    createSellerProvider(),
    createSellerDurability(sellerReplayStore, "seller-bundle-process-d"),
  );
  buyerStore = await createFsFencedSessionStore({ dir: buyerStoreDir });
  const buyerReplay = await advanceCompletedBuyerBundleDurable(
    createBuyerInput(),
    createBuyerProvider(),
    createBuyerDurability(buyerStore, "buyer-bundle-process-d"),
  );
  expect(sellerReplay.bundleContentHash).toBe(sellerFinalization.bundleContentHash);
  expect(buyerReplay).toMatchObject({ disposition: "finalised", recovered: true });
  expect(effects).toEqual(beforeReplay);
  expect(effects).toEqual({
    sellerSign: 1,
    sellerAnchor: 1,
    buyerSign: 1,
    counterSignaturePublication: 1,
    sellerFinalizationPublication: 1,
    buyerAnchor: 1,
  });
  const retainedSellerAnchor = await readExternalRecord<AnchoredSellerBundle>(
    externalDir,
    externalKey.sellerAnchor(bundleAddress(JOB_ID, "seller")),
  );
  const retainedBuyerAnchor = await readExternalRecord<AnchoredBuyerBundle>(
    externalDir,
    externalKey.buyerAnchor(bundleAddress(JOB_ID, "buyer")),
  );
  if (!retainedSellerAnchor || !retainedBuyerAnchor) {
    throw new Error("fresh external adapter could not recover both role anchors");
  }
  const retainedSellerBytes = canonicalize(retainedSellerAnchor.bundle);
  const retainedBuyerBytes = canonicalize(retainedBuyerAnchor.bundle);
  (sellerReplay.sellerBundle as unknown as {
    phaseSummary: Array<{ outcome: string }>;
  }).phaseSummary[0]!.outcome = "tampered";
  if (buyerReplay.disposition === "finalised") {
    expect(() => {
      (buyerReplay.result.buyerBundle as unknown as {
        phaseSummary: Array<{ outcome: string }>;
      }).phaseSummary[0]!.outcome = "tampered";
    }).toThrow();
  }
  expect(canonicalize((await readExternalRecord<AnchoredSellerBundle>(
    externalDir,
    externalKey.sellerAnchor(bundleAddress(JOB_ID, "seller")),
  ))!.bundle)).toBe(retainedSellerBytes);
  expect(canonicalize((await readExternalRecord<AnchoredBuyerBundle>(
    externalDir,
    externalKey.buyerAnchor(bundleAddress(JOB_ID, "buyer")),
  ))!.bundle)).toBe(retainedBuyerBytes);
  expect(sellerFinalization.sellerBundle.anchoredByRole).toBe("seller");
  expect(buyerFinalization.buyerBundle.anchoredByRole).toBe("buyer");
  expect(await verifyBundleCopy(
    sellerFinalization.sellerBundle as unknown as Record<string, unknown>,
    "seller",
    verifier,
  )).toMatchObject({ valid: true, fullySigned: true });
  expect(await verifyBundleCopy(
    buyerFinalization.buyerBundle as unknown as Record<string, unknown>,
    "buyer",
    verifier,
  )).toMatchObject({ valid: true, fullySigned: true });
  expect(await bundleConsistency({
    buyer: {
      disposition: "present",
      bundle: buyerFinalization.buyerBundle as unknown as Record<string, unknown>,
    },
    seller: {
      disposition: "present",
      bundle: sellerFinalization.sellerBundle as unknown as Record<string, unknown>,
    },
  }, {
    isValid: async (bundle, role) =>
      (await verifyBundleCopy(bundle, role, verifier)).valid,
  })).toBe("unified");
  expect(Object.hasOwn(createSellerProvider(), "submitBuyerBundle")).toBe(false);
  expect(Object.hasOwn(createBuyerProvider(), "submitSellerBundle")).toBe(false);
  return {
    sellerFinalization,
    buyerFinalization,
    effects,
    standardLimitations: ["DACS-Standard#331"] as const,
  };
}

interface FundedPreflightInput {
  expectedNetwork: string;
  connectedNetwork: string;
  nativeBalance: bigint;
  minimumNativeBalance: bigint;
  assetBalance: bigint;
  spendAmount: bigint;
}

function fundedPreflight(input: FundedPreflightInput):
  | { disposition: "ready" }
  | { disposition: "rejected"; reason: string } {
  if (input.connectedNetwork !== input.expectedNetwork) {
    return { disposition: "rejected", reason: "wrong-network" };
  }
  if (input.nativeBalance < input.minimumNativeBalance) {
    return { disposition: "rejected", reason: "insufficient-native-balance" };
  }
  if (input.assetBalance < input.spendAmount) {
    return { disposition: "rejected", reason: "insufficient-payment-balance" };
  }
  return { disposition: "ready" };
}

async function commerceFixture() {
  const [buyerPresentation, sellerPresentation] = await Promise.all([
    verifyRoleIdentityPresentation(BUYER_IDENTITY, BUYER),
    verifyRoleIdentityPresentation(SELLER_IDENTITY, SELLER),
  ]);
  expect({ buyerPresentation, sellerPresentation }).toEqual({
    buyerPresentation: true,
    sellerPresentation: true,
  });
  const published = await publishAndDiscoverListing();
  const agreement = await negotiateAgreement(
    published,
    await tempDir("issue114-buyer-agreement"),
    await tempDir("issue114-seller-agreement"),
  );
  const commitment = await commitAgreement(published, agreement);
  return { published, agreement, commitment };
}

async function validPaymentHeader(): Promise<string> {
  const payload = await challengeClient().createPaymentPayload({
    x402Version: 2,
    resource: { url: HTTP_RESOURCE },
    accepts: [structuredClone(X402_REQUIREMENTS)],
  });
  return encodeJson(payload);
}

function processRecoveryPaths(root: string) {
  return {
    settlement: join(root, "seller-settlement"),
    receipt: join(root, "seller-receipt"),
    fulfilment: join(root, "seller-fulfilment"),
    buyer: join(root, "buyer-settlement"),
  };
}

async function runWholeProcessStageA(root: string, runId: string): Promise<never> {
  const fixture = await commerceFixture();
  const paths = processRecoveryPaths(root);
  const state = commerceState(true);
  const seller = await createSellerRuntime({
    ...fixture,
    settlementDir: paths.settlement,
    receiptDir: paths.receipt,
    fulfilmentDir: paths.fulfilment,
    workerId: `${runId}:seller-process-a`,
    state,
  });
  const intent = await prepareSettlementIntent(fixture);
  const store = await createFsX402BuyerSettlementStore({ dir: paths.buyer });
  const transport = createX402BuyerPaidRequestTransport({
    fetchImpl: async (_url, init) => {
      const header = new Headers(init?.headers).get("PAYMENT-SIGNATURE");
      if (!header) throw new Error("process A lost its retained payment header");
      const paywall = await seller.runPaidRequest(header);
      return new Response(JSON.stringify(paywall.response.body), {
        status: paywall.response.status,
        headers: paywall.response.headers,
      });
    },
  });
  const first = await advanceX402BuyerSettlement({
    intent,
    owner: `${runId}:buyer-process-a`,
    store,
    authorizationProvider: buyerAuthorizationProvider(state),
    transport,
    now: () => state.now,
    leaseDurationMs: 1_000,
  });
  expect(first).toEqual({
    status: "indeterminate",
    reason: "eip3009-settlement-not-finalized",
  });
  expect(state.responseAcknowledgementLosses).toBe(1);
  expect(state.counts).toEqual({
    paidRequests: 1,
    settlement: 1,
    applicationCallback: 1,
    delivery: 1,
    evidence: 1,
    finalReceipt: 1,
    render: 1,
  });
  await writeExternalRecord(root, "whole-process-manifest", {
    runId,
    jobId: JOB_ID,
    settlementKey: intent.settlementKey,
    intent,
    stageAEffects: state.counts,
  });

  // Model the failure that matters for #114: the process disappears after all
  // irreversible seller effects commit but before the fulfilled response is
  // acknowledged. A new process must own no closure or in-memory result.
  process.kill(process.pid, "SIGKILL");
  return await new Promise<never>(() => undefined);
}

async function runWholeProcessStageB(root: string, runId: string): Promise<void> {
  const manifest = await readExternalRecord<{
    runId: string;
    jobId: string;
    settlementKey: string;
    intent: X402BuyerSettlementIntent;
    stageAEffects: CommerceCounts;
  }>(root, "whole-process-manifest");
  if (!manifest) throw new Error("process B could not read process A's manifest");
  expect(manifest).toMatchObject({ runId, jobId: JOB_ID });
  expect(manifest.intent.jobId).toBe(JOB_ID);
  expect(manifest.intent.settlementKey).toBe(manifest.settlementKey);

  const fixture = await commerceFixture();
  const paths = processRecoveryPaths(root);
  const state = commerceState();
  state.settled = true;
  state.buyerFinalityVisible = true;
  state.terminalReplayMustBeReadOnly = true;
  state.now += 2_000;
  const seller = await createSellerRuntime({
    ...fixture,
    settlementDir: paths.settlement,
    receiptDir: paths.receipt,
    fulfilmentDir: paths.fulfilment,
    workerId: `${runId}:seller-process-b`,
    state,
  });
  await expect(getSellerFulfilmentStatus(
    seller.fulfilmentStore,
    JOB_ID,
    DELIVERY_PHASE_INDEX,
  )).resolves.toMatchObject({
    status: "ok",
    delivery: "outcome",
    evidence: "outcome",
  });

  const replayed = await seller.runPaidRequest(manifest.intent.paymentHeader.value);
  expect(replayed).toMatchObject({
    disposition: "settled",
    settled: true,
    response: { status: 200, body: { delivered: true } },
  });
  if (!seller.process.permit || !seller.process.fulfilment) {
    throw new Error("process B did not reconstruct the terminal seller handoff");
  }
  await expect(seller.receiptStore.inspectPermit(
    seller.process.permit.paymentPermitId,
  )).resolves.toMatchObject({ status: "already-consumed" });
  expect(state.counts).toEqual({
    paidRequests: 1,
    settlement: 0,
    applicationCallback: 0,
    delivery: 0,
    evidence: 0,
    finalReceipt: 0,
    render: 1,
  });

  const buyerStore = await createFsX402BuyerSettlementStore({ dir: paths.buyer });
  let resubmissions = 0;
  const buyer = await advanceX402BuyerSettlement({
    intent: manifest.intent,
    owner: `${runId}:buyer-process-b`,
    store: buyerStore,
    authorizationProvider: buyerAuthorizationProvider(state),
    transport: {
      submitRetained: async () => {
        resubmissions += 1;
        throw new Error("process B must not resubmit the paid request");
      },
    },
    now: () => state.now,
    leaseDurationMs: 1_000,
  });
  expect(buyer.status).toBe("captured");
  expect(resubmissions).toBe(0);

  await writeExternalRecord(root, "whole-process-result", {
    runId,
    jobId: JOB_ID,
    settlementKey: manifest.settlementKey,
    stageAEffects: manifest.stageAEffects,
    stageBEffects: state.counts,
    totals: {
      settlement: manifest.stageAEffects.settlement + state.counts.settlement,
      applicationCallback:
        manifest.stageAEffects.applicationCallback + state.counts.applicationCallback,
      delivery: manifest.stageAEffects.delivery + state.counts.delivery,
      evidence: manifest.stageAEffects.evidence + state.counts.evidence,
      finalReceipt: manifest.stageAEffects.finalReceipt + state.counts.finalReceipt,
      paidRequestResubmissions: resubmissions,
    },
  });
}

async function spawnWholeProcessStage(
  stage: "a" | "b",
  root: string,
  runId: string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  const child = spawn(process.execPath, [
    join(process.cwd(), "node_modules", "vitest", "vitest.mjs"),
    "run",
    fileURLToPath(import.meta.url),
    "-t",
    "whole-process worker stage",
    "--pool=forks",
    "--maxWorkers=1",
    "--reporter=dot",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DACS_ISSUE114_PROCESS_STAGE: stage,
      DACS_ISSUE114_PROCESS_ROOT: root,
      DACS_ISSUE114_RUN_ID: runId,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`whole-process stage ${stage} timed out\n${output}`));
    }, 25_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, output });
    });
  });
}

describe.skipIf(PROCESS_STAGE !== undefined)(
  "issue #114 deterministic public two-agent precursor",
  () => {
  test("runs cold durable buyer/seller closure and rejects a missing buyer counter-signature", async () => {
    const { published, agreement, commitment } = await commerceFixture();
    expect(commitment.record.agreementHash).toBe(agreement.agreementHash);
    expect(commitment.committedAt).toBeGreaterThan(NOW);
    const settlement = await settleAndRecover({ published, agreement, commitment });
    expect(settlement.permit.paymentAuthorization.settlementIdentity).toEqual({
      kind: "evm",
      chainId: CHAIN_ID,
      txHash: TX_HASH,
      logIndex: 7,
      includedAt: NOW + 2_000,
    });
    const sellerSettlement = await publishAndVerifySellerSettlement({
      agreement,
      settlement,
    });
    const bundles = await closeDetachedRoleBundles({
      published,
      agreement,
      commitment,
      settlement,
      sellerSettlement,
    });
    expect(bundles.buyerFinalization.buyerBundle.anchoredByRole).toBe("buyer");
    expect(bundles.sellerFinalization.sellerBundle.anchoredByRole).toBe("seller");
    expect(bundles.standardLimitations).toEqual(["DACS-Standard#331"]);
  }, 20_000);

  test("recovers the same run after a real process crash without replaying effects", async () => {
    const root = await tempDir("issue114-whole-process");
    const runId = `issue114-${process.pid}-${Date.now()}`;
    const first = await spawnWholeProcessStage("a", root, runId);
    expect(first.code === 0 && first.signal === null).toBe(false);
    const manifest = await readExternalRecord<{
      runId: string;
      jobId: string;
      settlementKey: string;
      stageAEffects: CommerceCounts;
    }>(root, "whole-process-manifest");
    expect(manifest).toMatchObject({
      runId,
      jobId: JOB_ID,
      stageAEffects: {
        settlement: 1,
        applicationCallback: 1,
        delivery: 1,
        evidence: 1,
        finalReceipt: 1,
      },
    });

    const second = await spawnWholeProcessStage("b", root, runId);
    expect(second.code, second.output).toBe(0);
    expect(second.signal, second.output).toBeNull();
    const result = await readExternalRecord<{
      runId: string;
      jobId: string;
      settlementKey: string;
      stageAEffects: CommerceCounts;
      stageBEffects: CommerceCounts;
      totals: Record<string, number>;
    }>(root, "whole-process-result");
    expect(result).toEqual({
      runId,
      jobId: JOB_ID,
      settlementKey: manifest?.settlementKey,
      stageAEffects: manifest?.stageAEffects,
      stageBEffects: {
        paidRequests: 1,
        settlement: 0,
        applicationCallback: 0,
        delivery: 0,
        evidence: 0,
        finalReceipt: 0,
        render: 1,
      },
      totals: {
        settlement: 1,
        applicationCallback: 1,
        delivery: 1,
        evidence: 1,
        finalReceipt: 1,
        paidRequestResubmissions: 0,
      },
    });
  }, 40_000);

  test("rejects a wrong-network x402 challenge before the buyer signer", async () => {
    let signerCalls = 0;
    const client = challengeClient();
    const originalSigner = client.createPaymentPayload.bind(client);
    client.createPaymentPayload = async (challenge) => {
      signerCalls += 1;
      return originalSigner(challenge);
    };
    const result = await prepareX402BuyerSettlement({
      authority: {
        jobId: JOB_ID,
        phaseIndex: PAYMENT_PHASE_INDEX,
        railId: RAIL.railId,
        railVersion: String(RAIL.railVersion),
        railDescriptorHash: "1".repeat(64),
        agreementHash: "2".repeat(64),
        termsHash: "3".repeat(64),
        sessionBindingHash: "4".repeat(64),
        network: NETWORK,
        payer: PAYER,
        payee: PAYEE,
        asset: ASSET,
        amount: AMOUNT_BASE_UNITS,
        httpResource: HTTP_RESOURCE,
        method: "GET",
      },
    }, {
      client,
      fetchImpl: async () => new Response(JSON.stringify({
        x402Version: 2,
        resource: { url: HTTP_RESOURCE },
        accepts: [{ ...structuredClone(X402_REQUIREMENTS), network: "eip155:1" }],
      }), { status: 402 }),
    });
    expect(result).toEqual({
      disposition: "rejected",
      reason: "x402-payment-requirements-mismatch",
    });
    expect(signerCalls).toBe(0);
  });

  test("seller intake rejects unproven buyer wallet/DID linkage before any write", async () => {
    const fixture = await commerceFixture();
    const badSignature = structuredClone(BUYER_IDENTITY);
    if (badSignature.presentation.kind !== "per-claim") {
      throw new Error("buyer fixture requires per-claim signatures");
    }
    const walletSignature = badSignature.presentation.signatures.find(
      ({ ref }) => ref === BUYER_EVM_CLAIM,
    );
    if (!walletSignature) throw new Error("buyer wallet signature is absent");
    walletSignature.signature = `${walletSignature.signature.slice(0, -1)}${
      walletSignature.signature.endsWith("0") ? "1" : "0"
    }`;

    const badAddress = structuredClone(BUYER_IDENTITY);
    if (badAddress.presentation.kind !== "per-claim") {
      throw new Error("buyer fixture requires per-claim signatures");
    }
    const replacementClaim =
      `cci-xm:evm:base-sepolia:0x${"44".repeat(20)}`;
    const walletClaim = badAddress.claims.find(({ ref }) => ref === BUYER_EVM_CLAIM);
    const walletPresentation = badAddress.presentation.signatures.find(
      ({ ref }) => ref === BUYER_EVM_CLAIM,
    );
    if (!walletClaim || !walletPresentation) {
      throw new Error("buyer wallet claim is absent");
    }
    walletClaim.ref = replacementClaim;
    walletPresentation.ref = replacementClaim;

    for (const [name, buyerIdentityOverride] of [
      ["bad-signature", badSignature],
      ["bad-address", badAddress],
    ] as const) {
      const state = commerceState();
      const settlementDir = await tempDir(`issue114-${name}-settlement`);
      const receiptDir = await tempDir(`issue114-${name}-receipt`);
      const fulfilmentDir = await tempDir(`issue114-${name}-fulfilment`);
      const seller = await createSellerRuntime({
        ...fixture,
        settlementDir,
        receiptDir,
        fulfilmentDir,
        workerId: `seller-${name}`,
        state,
        buyerIdentityOverride,
      });
      await expect(seller.runPaidRequest(await validPaymentHeader())).resolves.toMatchObject({
        disposition: "rejected",
        settled: false,
      });
      expect(state.counts).toEqual({
        paidRequests: 1,
        settlement: 0,
        applicationCallback: 0,
        delivery: 0,
        evidence: 0,
        finalReceipt: 0,
        render: 0,
      });
      expect(await filesBelow(settlementDir)).toEqual([]);
      expect(await filesBelow(receiptDir)).toEqual([]);
      expect(await filesBelow(fulfilmentDir)).toEqual([]);
    }
  });

  test("rejects a seller identity that does not control the pinned Listing", async () => {
    const published = await publishAndDiscoverListing();
    expect(() => deriveFixedPriceAgreement({
      jobId: SELLER_MISMATCH_JOB_ID,
      verifiedListing: {
        disposition: "verified",
        listing: published.listing,
        pin: published.listingPin,
      },
      buyer: { identityBundle: BUYER_IDENTITY, vetRecordRef: vetRef("buyer") },
      seller: {
        identityBundle: identity("did:demos:unrelated-seller"),
        vetRecordRef: vetRef("seller"),
      },
      selectedRail: RAIL,
      payoutBindings: [{
        railId: RAIL.railId,
        phaseIndex: PAYMENT_PHASE_INDEX,
        payeeAddress: PAYEE,
      }],
      generatedAt: NOW,
    })).toThrow(/seller bundle primary claim does not match the pinned Listing/);
  });

  test("stops before settlement when the seller rejects the committed session", async () => {
    const fixture = await commerceFixture();
    const state = commerceState();
    const seller = await createSellerRuntime({
      ...fixture,
      settlementDir: await tempDir("issue114-rejected-settlement"),
      receiptDir: await tempDir("issue114-rejected-receipt"),
      fulfilmentDir: await tempDir("issue114-rejected-fulfilment"),
      workerId: "seller-rejecting-agent",
      state,
      rejectSession: true,
    });
    await expect(seller.runPaidRequest(await validPaymentHeader())).resolves.toMatchObject({
      disposition: "rejected",
      settled: false,
      reason: "seller policy rejected session",
    });
    expect(state.counts.settlement).toBe(0);
    expect(state.counts.delivery).toBe(0);
  });

  test("records a seller delivery failure without invoking the delivery callback", async () => {
    const fixture = await commerceFixture();
    const state = commerceState();
    const seller = await createSellerRuntime({
      ...fixture,
      settlementDir: await tempDir("issue114-failed-settlement"),
      receiptDir: await tempDir("issue114-failed-receipt"),
      fulfilmentDir: await tempDir("issue114-failed-fulfilment"),
      workerId: "seller-failing-delivery-agent",
      state,
      deliveryFailure: true,
    });
    await expect(seller.runPaidRequest(await validPaymentHeader())).resolves.toMatchObject({
      disposition: "fulfilment-failed",
      settled: true,
    });
    expect(state.counts.settlement).toBe(1);
    expect(state.counts.applicationCallback).toBe(0);
    expect(state.counts.delivery).toBe(0);
  }, 20_000);

  test("rejects completed bundle closure when the seller co-signature is missing", async () => {
    await expect(buildTwoSidedBundle({
      jobId: MISSING_COSIGNATURE_JOB_ID,
      outcome: "completed",
      listingRef: {
        listingId: "missing-cosignature",
        version: 1,
        contentHash: "1".repeat(64),
      },
      agreementRef: {
        anchor: { kind: "storage-program", locator: "agreement:missing-cosignature" },
        contentHash: "2".repeat(64),
      },
      phaseSummary: [{ index: 0, kind: "commit-agreement", outcome: "ok" }],
      vetRecords: [],
      settlementEvidence: [],
      recipeRegistryVersion: 1,
      railRegistryVersion: 1,
      finalisedAt: NOW,
      buyer: {
        primaryClaim: BUYER,
        bundleHash: identityBundleHash(BUYER_IDENTITY),
        signer: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(BUYER_SEED)),
      },
      seller: {
        primaryClaim: SELLER,
        bundleHash: identityBundleHash(SELLER_IDENTITY),
      },
    })).rejects.toThrow(/requires the seller's signature/);
  });

  test("rejects tampered local x402 and SR-2 cryptographic proofs", async () => {
    const payload = await challengeClient().createPaymentPayload({
      x402Version: 2,
      resource: { url: HTTP_RESOURCE },
      accepts: [structuredClone(X402_REQUIREMENTS)],
    }) as X402PaywallPaymentPayload;
    expect(await verifyLocalX402Payload(payload)).toBe(true);
    const tamperedPayload = structuredClone(payload);
    (tamperedPayload.payload.authorization as { value: string }).value = "1";
    expect(await verifyLocalX402Payload(tamperedPayload)).toBe(false);

    const receipt = finalizedReceipt("dacs:test:tamper", "a".repeat(64));
    expect(verifyLocalReceipt(receipt)).toBe(true);
    const tamperedReceipt = structuredClone(receipt);
    tamperedReceipt.contentHash = "b".repeat(64);
    expect(verifyLocalReceipt(tamperedReceipt)).toBe(false);
  });

  test("funded preflight rejects insufficient balances before any write", () => {
    expect(fundedPreflight({
      expectedNetwork: NETWORK,
      connectedNetwork: NETWORK,
      nativeBalance: 9n,
      minimumNativeBalance: 10n,
      assetBalance: 100n,
      spendAmount: 20n,
    })).toEqual({
      disposition: "rejected",
      reason: "insufficient-native-balance",
    });
    expect(fundedPreflight({
      expectedNetwork: NETWORK,
      connectedNetwork: NETWORK,
      nativeBalance: 10n,
      minimumNativeBalance: 10n,
      assetBalance: 19n,
      spendAmount: 20n,
    })).toEqual({
      disposition: "rejected",
      reason: "insufficient-payment-balance",
    });
  });
});

describe.skipIf(PROCESS_STAGE === undefined)("issue #114 whole-process worker", () => {
  test("whole-process worker stage", async () => {
    const root = process.env.DACS_ISSUE114_PROCESS_ROOT?.trim();
    const runId = process.env.DACS_ISSUE114_RUN_ID?.trim();
    if (!root || !runId) throw new Error("whole-process worker environment is incomplete");
    if (PROCESS_STAGE === "a") await runWholeProcessStageA(root, runId);
    else if (PROCESS_STAGE === "b") await runWholeProcessStageB(root, runId);
    else throw new Error(`unknown whole-process worker stage: ${PROCESS_STAGE}`);
  }, 20_000);
});
