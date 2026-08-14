import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  ARTIFACT_SEPARATORS,
  FIXED_PRICE_OFFLINE_COMMERCE_PROFILE,
  FIXED_PRICE_OFFLINE_STANDARD_REVISION,
  VERSION,
  buildTwoSidedBundle,
  bundleConsistency,
  canonicalize,
  commitFixedPriceAgreement,
  contentHash,
  createFixedPriceAgreementSignatureContribution,
  createFixedPriceAgreementSigningPlan,
  deriveFixedPriceAgreement,
  discoverListings,
  ed25519Sign,
  ed25519Verify,
  finalityCommitmentAddress,
  finalizeFixedPriceAgreementContributions,
  identityBundleHash,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  publishListingCore,
  rawPublicKey,
  selfSignedAssertionBytes,
  sha256Hex,
  signComponentArtifact,
  signedBytes,
  validateListingArtifact,
  verifyBundleCopy,
  verifyBundleCore,
  verifyCompositeVerificationRecord,
  verifySettlementEvidence,
  type AgreementArtifact,
  type ProtocolAnchorReceipt as AnchorReceipt,
  type AnchoredFinalityCommitment,
  type AttestationRef,
  type CommitmentSignatureVerifier,
  type ComponentSignature,
  type CompositeBundleRequirement,
  type CompositeVerificationRecord,
  type FinalityCommitmentProvider,
  type IdentityBundle,
  type Listing,
  type ListingDraft,
  type ListingPin,
  type ListingValidationDeps,
  type PaymentRailRef,
  type RecipeDescriptor,
  type SettlementEvidence,
  type StrictCompositeVerification,
  type VerifyResult,
  type VerifyResultRef,
} from "@kynesyslabs/dacs";

import { createDacsNodeOfflineProtocolBinding } from "./offline.js";

const FIXTURE_NOW = 1_790_000_000_000;
const JOB_ID = "01K00000000000000000000059";
const LISTING_ID = "dacs-one-click-offline";
const PAYMENT_PHASE_INDEX = 2;
const DELIVERY_PHASE_INDEX = 3;
const IDENTITY_SEPARATOR = "dacs-bundle-presentation:v1:";
const OFFLINE_RECEIPT_SEPARATOR = "dacs-offline-ap2-provider-receipt:v1:";

const BUYER_SEED = new Uint8Array(32).fill(41);
const SELLER_SEED = new Uint8Array(32).fill(42);
const VERIFIER_SEED = new Uint8Array(32).fill(43);

export interface OfflineLifecycleOptions {
  /** Directory that receives `artifacts/` and `run-report.json`. */
  outputDirectory: string;
}

export interface OfflineRunArtifact {
  type: string;
  contentHash: string;
  localReference: string;
}

export interface OfflineRunPhase {
  stage: "DACS-1" | "DACS-2" | "DACS-3" | "DACS-4" | "DACS-5";
  startedAt: number;
  endedAt: number;
  durationMs: number;
  outcome: "ok";
  artifactTypes: string[];
}

export interface OfflineRunReport {
  reportVersion: "1";
  sdkVersion: string;
  standardRevision: string;
  profile: typeof FIXED_PRICE_OFFLINE_COMMERCE_PROFILE;
  mode: "offline";
  jobId: string;
  protocolBinding: ReturnType<typeof createDacsNodeOfflineProtocolBinding>;
  parties: {
    buyer: string;
    seller: string;
    verifier: string;
  };
  phases: OfflineRunPhase[];
  artifacts: OfflineRunArtifact[];
  payment: {
    amount: string;
    currency: string;
    railId: string;
    availability: "mocked";
    disposition: "offline";
  };
  verification: {
    listing: boolean;
    buyerVet: boolean;
    sellerVet: boolean;
    commitment: boolean;
    paymentEvidence: boolean;
    deliveryEvidence: boolean;
    providerReceipt: boolean;
    buyerBundle: boolean;
    sellerBundle: boolean;
    bundleConsistency: "unified";
  };
  overallSuccess: boolean;
  reportPath: string;
}

interface StoredArtifact {
  type: string;
  hash: string;
  locator: string;
  value: Record<string, unknown>;
}

interface RoleIdentity {
  claim: string;
  keyClaim: string;
  seed: Uint8Array;
  rawPublicKey: Uint8Array;
  bundle: IdentityBundle;
}

interface PublishedListing {
  listing: Listing;
  pin: ListingPin;
  ref: string;
}

interface AgreementResult {
  agreement: AgreementArtifact;
  ref: AttestationRef;
  committed: Awaited<ReturnType<typeof commitFixedPriceAgreement>>;
}

interface VetClosure {
  record: CompositeVerificationRecord;
  result: VerifyResult;
  resultRef: VerifyResultRef;
  assertion: Record<string, unknown>;
  assertionRef: AttestationRef;
  recipe: RecipeDescriptor & { signature: ComponentSignature };
}

const KEY_REQUIREMENT: CompositeBundleRequirement = {
  requirementVersion: "1",
  required: [
    {
      scheme: "key",
      verificationRequired: true,
      recipeVersion: 1,
    },
  ],
};

const RAIL: PaymentRailRef = {
  railId: "ap2:offline-mocked",
  railVersion: 1,
  parameters: {
    providerEndpoint: "https://offline.invalid/ap2",
    availability: "mocked",
    mode: "offline",
  },
};

function asRecord(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

function signatureValue(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function claimFor(seed: Uint8Array): string {
  return `did:demos:agent:${Buffer.from(
    rawPublicKey(publicKeyFromSeed(seed)),
  ).toString("hex")}`;
}

function roleIdentity(seed: Uint8Array, nonce: string): RoleIdentity {
  const claim = claimFor(seed);
  const keyClaim = `key:${Buffer.from(
    rawPublicKey(publicKeyFromSeed(seed)),
  ).toString("hex")}`;
  const bundle: IdentityBundle = {
    bundleVersion: "1",
    presentedBy: claim,
    presentedAt: FIXTURE_NOW - 10_000,
    sessionNonce: `${JOB_ID}:${nonce}`,
    claims: [{ ref: claim }, { ref: keyClaim }],
    presentation: {
      kind: "per-claim",
      signatures: [
        { ref: claim, signature: "pending" },
        { ref: keyClaim, signature: "pending" },
      ],
    },
  };
  if (bundle.presentation.kind !== "per-claim") {
    throw new Error("offline identity fixture requires per-claim presentation");
  }
  const signature = ed25519Sign(
    signedBytes(IDENTITY_SEPARATOR, identityBundleHash(bundle)),
    privateKeyFromSeed(seed),
  );
  bundle.presentation.signatures = bundle.claims.map(({ ref }) => ({
    ref,
    signature: signatureValue(signature),
  }));
  return {
    claim,
    keyClaim,
    seed: Uint8Array.from(seed),
    rawPublicKey: rawPublicKey(publicKeyFromSeed(seed)),
    bundle,
  };
}

function verifyIdentity(identity: Readonly<RoleIdentity>): boolean {
  if (
    identity.bundle.presentedBy !== identity.claim ||
    identity.bundle.presentation.kind !== "per-claim" ||
    identity.bundle.presentation.signatures.length !==
      identity.bundle.claims.length
  ) {
    return false;
  }
  const bytes = signedBytes(
    IDENTITY_SEPARATOR,
    identityBundleHash(identity.bundle),
  );
  return identity.bundle.presentation.signatures.every((signature, index) => {
    if (signature.ref !== identity.bundle.claims[index]?.ref) return false;
    const decoded = Buffer.from(signature.signature, "base64url");
    return (
      decoded.length === 64 &&
      decoded.toString("base64url") === signature.signature &&
      ed25519Verify(
        bytes,
        Uint8Array.from(decoded),
        publicKeyFromSeed(identity.seed),
      )
    );
  });
}

class OfflineArtifactStore {
  readonly #root: string;
  readonly #records = new Map<string, StoredArtifact>();
  readonly #reportArtifacts: OfflineRunArtifact[] = [];

  constructor(root: string) {
    this.#root = root;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
  }

  async put(
    fileName: string,
    type: string,
    value: Record<string, unknown>,
    options: { hash?: string; signer?: string } = {},
  ): Promise<AttestationRef> {
    const snapshot = structuredClone(value);
    const hash = options.hash ?? contentHash(snapshot);
    const locator = `offline:stor:${fileName}`;
    await writeFile(
      resolve(this.#root, `${fileName}.json`),
      `${canonicalize(snapshot)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    this.#records.set(locator, { type, hash, locator, value: snapshot });
    this.#reportArtifacts.push({
      type,
      contentHash: hash,
      localReference: `artifacts/${fileName}.json`,
    });
    return {
      anchor: { kind: "storage-program", locator },
      contentHash: hash,
      ...(options.signer ? { signer: options.signer } : {}),
    };
  }

  async putAtLocator(
    fileName: string,
    type: string,
    locator: string,
    value: Record<string, unknown>,
    hash: string,
  ): Promise<void> {
    const snapshot = structuredClone(value);
    await writeFile(
      resolve(this.#root, `${fileName}.json`),
      `${canonicalize(snapshot)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    this.#records.set(locator, { type, hash, locator, value: snapshot });
    this.#reportArtifacts.push({
      type,
      contentHash: hash,
      localReference: `artifacts/${fileName}.json`,
    });
  }

  read(locator: string): Record<string, unknown> | null {
    const value = this.#records.get(locator)?.value;
    return value ? structuredClone(value) : null;
  }

  get reportArtifacts(): OfflineRunArtifact[] {
    return structuredClone(this.#reportArtifacts);
  }
}

function railAuthority() {
  return {
    trustPhase: "PA-1" as const,
    trustPolicyAcceptsPA1: true,
    registry: { state: "not-used" as const, entries: [], definitions: [] },
    inCodeDefinitions: [
      {
        railId: RAIL.railId,
        railVersion: RAIL.railVersion!,
        phaseHandler: "pay-ap2",
        governanceAnchoring: "in-code" as const,
        signatureValid: true,
      },
    ],
  };
}

function listingDraft(seller: RoleIdentity): ListingDraft {
  return {
    dacsVersion: "1",
    listingVersion: 1,
    listingId: LISTING_ID,
    seller: {
      identity: structuredClone(seller.bundle),
      displayName: "DACS offline demo seller",
      publicEndpoint: "https://offline.invalid/dacs/engage",
    },
    offering: {
      title: "Deterministic offline DACS result",
      description: "A complete local DACS 1-5 quickstart artifact graph",
      category: "software.demo",
      tags: ["dacs", "offline", "deterministic"],
      deliverable: { kind: "storage-program", accessModel: "public" },
    },
    buyerRequirement: structuredClone(KEY_REQUIREMENT),
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-payee-bound-agreement" },
      { kind: "pay-ap2", parameters: { rail: RAIL.railId } },
      { kind: "deliver-storage-program" },
    ],
    pricing: { kind: "fixed", price: { amount: "1", currency: "USD" } },
    acceptedRails: [structuredClone(RAIL)],
    terms: { deadlineSecAfterCommit: 3_600 },
    validity: {
      notBefore: FIXTURE_NOW - 60_000,
      notAfter: FIXTURE_NOW + 60_000,
    },
  };
}

function listingValidationDeps(seller: RoleIdentity): ListingValidationDeps {
  return {
    nowMs: () => FIXTURE_NOW,
    verifyListingSignature: ({ signedBytes: bytes, signature }) =>
      signature.signer === seller.claim &&
      signature.algorithm === "ed25519" &&
      ed25519Verify(
        bytes,
        Uint8Array.from(Buffer.from(signature.value, "base64url")),
        publicKeyFromSeed(seller.seed),
      ),
    revocation: {
      surfaces: [
        { kind: "well-known", status: "active", integrity: "verified" },
      ],
      readMarker: async () => null,
      verifyMarkerSignature: () => false,
    },
    verifyIdentityPresentation: ({ bundle, signedBytes: bytes }) => {
      if (
        bundle.presentedBy !== seller.claim ||
        bundle.presentation.kind !== "per-claim"
      ) {
        return false;
      }
      if (
        bundle.presentation.signatures.length !== bundle.claims.length
      ) {
        return false;
      }
      return bundle.presentation.signatures.every((signature, index) =>
        signature.ref === bundle.claims[index]?.ref &&
        ed25519Verify(
          bytes,
          Uint8Array.from(Buffer.from(signature.signature, "base64url")),
          publicKeyFromSeed(seller.seed),
        )
      );
    },
    loadRailResolution: () => railAuthority(),
    resolvePayloadVerificationCapability: () => ({ disposition: "supported" }),
    verifySellerControl: ({ bundle, signer }) =>
      signer === seller.claim &&
      bundle.presentedBy === seller.claim &&
      identityBundleHash(bundle) === identityBundleHash(seller.bundle),
  };
}

async function publishAndDiscoverListing(
  store: OfflineArtifactStore,
  seller: RoleIdentity,
): Promise<PublishedListing> {
  let publishedListing: Record<string, unknown> | undefined;
  const published = await publishListingCore(listingDraft(seller), {
    sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(seller.seed)),
    scanOwnAnchorsByNamePrefix: async () => ({ status: "ok", anchors: [] }),
    writeArtifact: async (_logicalAddress, value, options) => {
      const ref = `offline:stor:${options.storageName}`;
      publishedListing = structuredClone(value);
      await store.putAtLocator(
        "dacs-1-listing",
        "Listing",
        ref,
        value,
        contentHash(value),
      );
      return { address: ref, txRef: "offline:listing-publication" };
    },
    loadRailResolution: () => railAuthority(),
    resolvePayloadVerificationCapability: () => ({ disposition: "supported" }),
  });
  if (!publishedListing) throw new Error("offline Listing publication was not retained");

  const discovered = await discoverListings(
    [published.ref],
    async (ref) => store.read(ref),
    {
      verify: (bytes, signature, publicKey) =>
        ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
      resolvePublicKey: (claim) =>
        claim === seller.claim ? Uint8Array.from(seller.rawPublicKey) : null,
      validateListing: (raw) =>
        validateListingArtifact(raw, listingValidationDeps(seller)),
      nowMs: () => FIXTURE_NOW,
    },
  );
  const selected = discovered[0];
  if (!selected || selected.compatibility !== "normative") {
    throw new Error("offline Listing did not pass normative discovery");
  }
  return {
    listing: selected.listing,
    pin: published.listingPin,
    ref: published.ref,
  };
}

async function selfSignedRecipe(
  verifier: RoleIdentity,
): Promise<RecipeDescriptor & { signature: ComponentSignature }> {
  return (await signComponentArtifact(
    {
      recipeVersion: 1,
      scheme: "key",
      defaultMethod: { kind: "self-signed" },
      defaultMaxAgeSec: 3_600,
      parserRules: { format: "raw", matcher: "identity" },
      retryClass: "permanent",
      availability: "bilateral",
      governance: {
        proposedBy: verifier.claim,
        acceptedAt: FIXTURE_NOW - 20_000,
        anchoring: "single-signer",
      },
    },
    "dacs-recipe:v1:",
    {
      algorithm: "ed25519",
      signer: verifier.claim,
      sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(verifier.seed)),
    },
  )) as RecipeDescriptor & { signature: ComponentSignature };
}

async function produceVetClosure(
  store: OfflineArtifactStore,
  role: "buyer" | "seller",
  party: RoleIdentity,
  verifier: RoleIdentity,
  recipe: RecipeDescriptor & { signature: ComponentSignature },
): Promise<VetClosure> {
  const assertion: Record<string, unknown> = {
    assertionVersion: "1",
    subject: party.keyClaim,
    assertion: party.keyClaim,
    signature: Buffer.from(
      ed25519Sign(
        selfSignedAssertionBytes(party.keyClaim),
        privateKeyFromSeed(party.seed),
      ),
    ).toString("hex"),
  };
  const assertionHash = sha256Hex(canonicalize(assertion));
  const assertionRef = await store.put(
    `dacs-2-${role}-self-signed-assertion`,
    `SelfSignedAttestation:${role}`,
    assertion,
    { hash: assertionHash, signer: party.keyClaim },
  );
  const result = (await signComponentArtifact(
    {
      resultVersion: "1",
      scheme: "key",
      identifier: party.keyClaim,
      recipeVersion: 1,
      method: "self-signed",
      decision: "pass",
      reason: "offline key-possession assertion verified",
      attestation: assertionRef,
      data: { keyPossession: true, mode: "offline" },
      fetchedAt: FIXTURE_NOW - 4_000,
      verifiedAt: FIXTURE_NOW - 3_000,
      validUntil: FIXTURE_NOW + 3_596_000,
    },
    "dacs-verifyresult:v1:",
    {
      algorithm: "ed25519",
      signer: verifier.claim,
      sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(verifier.seed)),
    },
  )) as VerifyResult;
  const resultAttestationRef = await store.put(
    `dacs-2-${role}-verify-result`,
    `VerifyResult:${role}`,
    asRecord(result),
    { signer: verifier.claim },
  );
  const resultRef: VerifyResultRef = {
    anchor: structuredClone(resultAttestationRef.anchor),
    contentHash: resultAttestationRef.contentHash,
    recipeVersion: 1,
  };
  const record = (await signComponentArtifact(
    {
      recordVersion: "1",
      jobId: JOB_ID,
      evaluatedParty: party.claim,
      bundleHash: identityBundleHash(party.bundle),
      requirementHash: sha256Hex(canonicalize(KEY_REQUIREMENT)),
      freshness: [],
      supplementary: [],
      dealSpecific: [resultRef],
      overallDecision: "pass",
      generatedAt: FIXTURE_NOW - 2_000,
    },
    ARTIFACT_SEPARATORS.CompositeVerificationRecord,
    {
      algorithm: "ed25519",
      signer: verifier.claim,
      sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(verifier.seed)),
    },
  )) as CompositeVerificationRecord;
  return { record, result, resultRef, assertion, assertionRef, recipe };
}

async function verifyVet(
  closure: VetClosure,
  store: OfflineArtifactStore,
  party: RoleIdentity,
  verifier: RoleIdentity,
): Promise<StrictCompositeVerification> {
  return verifyCompositeVerificationRecord(
    closure.record,
    {
      jobId: JOB_ID,
      evaluatedParty: party.claim,
      bundleHash: identityBundleHash(party.bundle),
      requirement: KEY_REQUIREMENT,
      verifier: verifier.claim,
      freshness: [],
      dealSpecific: [
        {
          ref: closure.resultRef,
          scheme: "key",
          identifier: party.keyClaim,
          method: "self-signed",
          requirement: KEY_REQUIREMENT.required[0]!,
        },
      ],
    },
    {
      nowMs: () => FIXTURE_NOW,
      resolve: async (ref) => {
        const value = store.read(ref.anchor.locator);
        return value ? { encoding: "canonical-json", value } : null;
      },
      resolveRecipe: async (selector) =>
        selector.scheme === "key" &&
          selector.method === "self-signed" &&
          selector.recipeVersion === 1
          ? structuredClone(closure.recipe)
          : null,
      isRecipeSignerAuthorized: (_recipe, signature) =>
        signature.signer === verifier.claim,
      isVerifyResultSignerAuthorized: (_result, signature) =>
        signature.signer === verifier.claim,
      resolvePublicKey: async (signature) =>
        signature.signer === verifier.claim
          ? Uint8Array.from(verifier.rawPublicKey)
          : null,
      verify: async ({ signedBytes: bytes, signature, publicKey }) =>
        ed25519Verify(
          bytes,
          Uint8Array.from(Buffer.from(signature.value, "base64url")),
          publicKeyFromRaw(publicKey),
        ),
      verifyAuthorityAttestation: ({ result, content }) => {
        if (
          result.method !== "self-signed" ||
          result.identifier !== party.keyClaim ||
          result.attestation.signer !== party.keyClaim ||
          content.encoding !== "canonical-json"
        ) {
          return "invalid";
        }
        const assertion = content.value;
        const encoded = assertion["signature"];
        if (
          assertion["assertionVersion"] !== "1" ||
          assertion["subject"] !== party.keyClaim ||
          assertion["assertion"] !== party.keyClaim ||
          typeof encoded !== "string" ||
          !/^[0-9a-f]{128}$/.test(encoded)
        ) {
          return "invalid";
        }
        return ed25519Verify(
          selfSignedAssertionBytes(party.keyClaim),
          Uint8Array.from(Buffer.from(encoded, "hex")),
          publicKeyFromSeed(party.seed),
        )
          ? "valid"
          : "invalid";
      },
    },
  );
}

function signAgreementContribution(
  seed: Uint8Array,
): (bytes: Uint8Array) => Uint8Array {
  return (bytes) => ed25519Sign(bytes, privateKeyFromSeed(seed));
}

function localReceipt(
  writer: RoleIdentity,
  input: Omit<AnchorReceipt, "evidence">,
): AnchorReceipt {
  const signature = ed25519Sign(
    Buffer.from(canonicalize(input as unknown as Record<string, unknown>), "utf8"),
    privateKeyFromSeed(writer.seed),
  );
  return {
    ...input,
    evidence: {
      kind: "test:ed25519-jcs",
      value: signatureValue(signature),
    },
  };
}

function verifyLocalReceipt(
  receipt: Readonly<AnchorReceipt>,
  identities: readonly RoleIdentity[],
): boolean {
  if (receipt.evidence.kind !== "test:ed25519-jcs") return false;
  const writer = identities.find((identity) => identity.claim === receipt.writer);
  if (!writer) return false;
  const decoded = Buffer.from(receipt.evidence.value, "base64url");
  if (
    decoded.length !== 64 ||
    decoded.toString("base64url") !== receipt.evidence.value
  ) {
    return false;
  }
  const { evidence: _evidence, ...unsigned } = receipt;
  return ed25519Verify(
    Buffer.from(canonicalize(unsigned as unknown as Record<string, unknown>), "utf8"),
    Uint8Array.from(decoded),
    publicKeyFromSeed(writer.seed),
  );
}

async function negotiateAndCommit(
  store: OfflineArtifactStore,
  published: PublishedListing,
  buyer: RoleIdentity,
  seller: RoleIdentity,
  buyerVetRef: AttestationRef,
  sellerVetRef: AttestationRef,
): Promise<AgreementResult> {
  const draft = deriveFixedPriceAgreement({
    jobId: JOB_ID,
    verifiedListing: {
      disposition: "verified",
      listing: published.listing,
      pin: published.pin,
    },
    buyer: {
      identityBundle: buyer.bundle,
      vetRecordRef: buyerVetRef,
    },
    seller: {
      identityBundle: seller.bundle,
      vetRecordRef: sellerVetRef,
    },
    selectedRail: RAIL,
    payoutBindings: [
      {
        railId: RAIL.railId,
        phaseIndex: PAYMENT_PHASE_INDEX,
        payeeAddress: "offline:mocked-ap2-provider",
      },
    ],
    generatedAt: FIXTURE_NOW,
  });
  const plan = createFixedPriceAgreementSigningPlan(draft);
  const buyerContribution = await createFixedPriceAgreementSignatureContribution(
    plan,
    "buyer",
    {
      party: buyer.claim,
      algorithm: "ed25519",
      sign: signAgreementContribution(buyer.seed),
    },
  );
  const sellerContribution = await createFixedPriceAgreementSignatureContribution(
    plan,
    "seller",
    {
      party: seller.claim,
      algorithm: "ed25519",
      sign: signAgreementContribution(seller.seed),
    },
  );
  const byClaim = new Map([
    [buyer.claim, buyer],
    [seller.claim, seller],
  ]);
  const agreement = await finalizeFixedPriceAgreementContributions(
    plan,
    [buyerContribution, sellerContribution],
    ({ party, algorithm, value, signedBytes: bytes }) => {
      const identity = byClaim.get(party);
      if (!identity || algorithm !== "ed25519") return "indeterminate";
      return ed25519Verify(
          bytes,
          Uint8Array.from(Buffer.from(value, "base64url")),
          publicKeyFromSeed(identity.seed),
        )
        ? "valid"
        : "invalid";
    },
  );
  const agreementRef = await store.put(
    "dacs-3-agreement",
    "PayeeBoundAgreementDocument",
    asRecord(agreement),
    { signer: buyer.claim },
  );

  let retained: AnchoredFinalityCommitment | undefined;
  const provider: FinalityCommitmentProvider = {
    resolve: () =>
      retained
        ? { disposition: "present", anchored: structuredClone(retained) }
        : { disposition: "absent" },
    submit: async (logicalAddress, record) => {
      const recordHash = contentHash(asRecord(record));
      const nativeAddress = `offline-stor-commitment-${recordHash.slice(0, 20)}`;
      const receipt = localReceipt(seller, {
        receiptVersion: "1",
        substrate: "test:offline",
        finalityProfile: "test-final",
        logicalAddress,
        nativeAddress,
        contentHash: recordHash,
        transactionRef: {
          kind: "test:offline",
          value: `offline:tx:${recordHash.slice(0, 24)}`,
        },
        writer: seller.claim,
        state: "finalized",
        observationDisposition: "established",
        observedAt: FIXTURE_NOW + 2_000,
        blockRef: {
          id: "offline:block:commitment",
          height: "1",
          timestamp: FIXTURE_NOW + 1_000,
        },
      });
      retained = {
        record: structuredClone(record),
        nativeAddress,
        anchorTxRef: {
          kind: "storage-program",
          address: nativeAddress,
          writeTxHash: sha256Hex(`offline:${recordHash}`),
        },
        anchorReceipt: receipt,
      };
      return structuredClone(retained);
    },
    verifyAnchorReceipt: (anchored) =>
      anchored.anchorReceipt.logicalAddress ===
          finalityCommitmentAddress(JOB_ID) &&
        anchored.anchorReceipt.nativeAddress === anchored.nativeAddress &&
        anchored.anchorReceipt.writer === seller.claim &&
        verifyLocalReceipt(anchored.anchorReceipt, [buyer, seller])
        ? "valid"
        : "invalid",
  };
  const verifyCommitmentSignature: CommitmentSignatureVerifier = (request) => {
    const identity = byClaim.get(request.signer);
    if (!identity || request.algorithm !== "ed25519") return "indeterminate";
    return ed25519Verify(
        request.signedBytes,
        Uint8Array.from(Buffer.from(request.value, "base64url")),
        publicKeyFromSeed(identity.seed),
      )
      ? "valid"
      : "invalid";
  };
  const committed = await commitFixedPriceAgreement(
    {
      agreement: structuredClone(agreement),
      verifiedListing: {
        disposition: "verified",
        listing: structuredClone(published.listing),
        pin: structuredClone(published.pin),
      },
      session: {
        jobId: JOB_ID,
        listingRef: structuredClone(published.pin),
        phaseKind: "commit-payee-bound-agreement",
        orchestrator: seller.claim,
        buyer: {
          primaryClaim: buyer.claim,
          bundleHash: identityBundleHash(buyer.bundle),
          vetRecordRef: structuredClone(buyerVetRef),
        },
        seller: {
          primaryClaim: seller.claim,
          bundleHash: identityBundleHash(seller.bundle),
          vetRecordRef: structuredClone(sellerVetRef),
        },
      },
      createdAt: FIXTURE_NOW + 500,
      commitmentSigner: {
        algorithm: "ed25519",
        signer: seller.claim,
        sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(seller.seed)),
      },
    },
    provider,
    verifyCommitmentSignature,
  );
  await store.put(
    "dacs-3-finality-commitment",
    "FinalityCommitmentRecord",
    asRecord(committed.record),
    { signer: seller.claim },
  );
  await store.put(
    "dacs-3-finality-receipt",
    "OfflineAnchorReceipt",
    asRecord(committed.anchorReceipt),
    { hash: sha256Hex(canonicalize(committed.anchorReceipt)) },
  );
  return { agreement, ref: agreementRef, committed };
}

function signSettlementEvidence(
  unsigned: Omit<SettlementEvidence, "signature">,
  seller: RoleIdentity,
): SettlementEvidence {
  return {
    ...unsigned,
    signature: {
      algorithm: "ed25519",
      signer: seller.claim,
      value: signatureValue(
        ed25519Sign(
          signedBytes(
            ARTIFACT_SEPARATORS.SettlementEvidence,
            contentHash(unsigned as unknown as Record<string, unknown>),
          ),
          privateKeyFromSeed(seller.seed),
        ),
      ),
    },
  } as SettlementEvidence;
}

function signOfflineProviderReceipt(
  verifier: RoleIdentity,
  agreement: AgreementArtifact,
): Record<string, unknown> {
  const unsigned = {
    receiptVersion: "offline-ap2-v1",
    mode: "offline",
    availability: "mocked",
    provider: "deterministic-local-ap2",
    jobId: JOB_ID,
    agreementHash: contentHash(asRecord(agreement)),
    mandateId: `offline-mandate:${JOB_ID}`,
    status: "captured",
    amount: "1",
    currency: "USD",
    observedAt: FIXTURE_NOW + 3_000,
  };
  return {
    ...unsigned,
    signature: {
      algorithm: "ed25519",
      signer: verifier.claim,
      value: signatureValue(
        ed25519Sign(
          signedBytes(OFFLINE_RECEIPT_SEPARATOR, contentHash(unsigned)),
          privateKeyFromSeed(verifier.seed),
        ),
      ),
    },
  };
}

function verifyOfflineProviderReceipt(
  value: Record<string, unknown>,
  verifier: RoleIdentity,
): boolean {
  const signature = value["signature"];
  if (
    value["receiptVersion"] !== "offline-ap2-v1" ||
    value["mode"] !== "offline" ||
    value["availability"] !== "mocked" ||
    value["status"] !== "captured" ||
    signature === null ||
    typeof signature !== "object" ||
    Array.isArray(signature)
  ) {
    return false;
  }
  const component = signature as Record<string, unknown>;
  if (
    component["algorithm"] !== "ed25519" ||
    component["signer"] !== verifier.claim ||
    typeof component["value"] !== "string"
  ) {
    return false;
  }
  const encoded = component["value"];
  const decoded = Buffer.from(encoded, "base64url");
  return (
    decoded.length === 64 &&
    decoded.toString("base64url") === encoded &&
    ed25519Verify(
      signedBytes(OFFLINE_RECEIPT_SEPARATOR, contentHash(value)),
      Uint8Array.from(decoded),
      publicKeyFromSeed(verifier.seed),
    )
  );
}

async function settleAndDeliver(
  store: OfflineArtifactStore,
  agreement: AgreementArtifact,
  seller: RoleIdentity,
  verifier: RoleIdentity,
): Promise<{
  paymentEvidence: SettlementEvidence;
  paymentRef: AttestationRef;
  deliveryEvidence: SettlementEvidence;
  deliveryRef: AttestationRef;
  providerReceiptValid: boolean;
}> {
  const providerReceipt = signOfflineProviderReceipt(verifier, agreement);
  const providerReceiptRef = await store.put(
    "dacs-4-offline-ap2-provider-receipt",
    "OfflineAp2ProviderReceipt",
    providerReceipt,
    { signer: verifier.claim },
  );
  const providerReceiptValid = verifyOfflineProviderReceipt(
    providerReceipt,
    verifier,
  );
  if (!providerReceiptValid) {
    throw new Error("offline AP2 provider receipt failed cryptographic verification");
  }

  const paymentEvidence = signSettlementEvidence(
    {
      evidenceVersion: "1",
      jobId: JOB_ID,
      phase: "pay-ap2",
      outcome: "success",
      observedAt: FIXTURE_NOW + 4_000,
      paymentTxRefs: [
        {
          kind: "ap2",
          mandateId: `offline-mandate:${JOB_ID}`,
          providerRef: providerReceiptRef.anchor.locator,
          protocolVersion: "offline-mocked-v1",
          receiptAttestation: providerReceiptRef,
        },
      ],
      paymentAmount: { amount: "1", currency: "USD" },
      settlementFinality: {
        model: "provider-receipt",
        finalityObservedAt: FIXTURE_NOW + 3_000,
      },
    },
    seller,
  );
  const paymentRef = await store.put(
    "dacs-4-payment-evidence",
    "SettlementEvidence:pay-ap2",
    asRecord(paymentEvidence),
    { signer: seller.claim },
  );

  const deliverable = {
    deliverableVersion: "offline-v1",
    mode: "offline",
    jobId: JOB_ID,
    result: "Hello from a complete deterministic DACS lifecycle.",
    generatedAt: FIXTURE_NOW + 5_000,
  };
  const deliverableRef = await store.put(
    "dacs-4-deliverable",
    "OfflineDeliverable",
    deliverable,
    { hash: sha256Hex(canonicalize(deliverable)) },
  );
  const deliveryEvidence = signSettlementEvidence(
    {
      evidenceVersion: "1",
      jobId: JOB_ID,
      phase: "deliver-storage-program",
      outcome: "success",
      observedAt: FIXTURE_NOW + 6_000,
      deliverableContentHash: deliverableRef.contentHash,
      deliverableAnchor: {
        kind: "storage-program",
        locator: deliverableRef.anchor.locator,
      },
    },
    seller,
  );
  const deliveryRef = await store.put(
    "dacs-4-delivery-evidence",
    "SettlementEvidence:deliver-storage-program",
    asRecord(deliveryEvidence),
    { signer: seller.claim },
  );
  return {
    paymentEvidence,
    paymentRef,
    deliveryEvidence,
    deliveryRef,
    providerReceiptValid,
  };
}

function keyResolver(identities: readonly RoleIdentity[]) {
  return async (claim: string): Promise<Uint8Array | null> => {
    const identity = identities.find((candidate) => candidate.claim === claim);
    return identity ? Uint8Array.from(identity.rawPublicKey) : null;
  };
}

async function verifyEvidence(
  evidence: Record<string, unknown>,
  seller: RoleIdentity,
  resolveKey: (claim: string) => Promise<Uint8Array | null>,
  expectedDeliveryLocator: string,
) {
  return verifySettlementEvidence(
    evidence,
    evidence["phase"] === "pay-ap2"
      ? {
          orchestrator: seller.claim,
          agreement: { amount: "1", currency: "USD" },
          rail: {
            railId: RAIL.railId,
            railType: "ap2",
            asset: "USD",
            handler: "pay-ap2",
          },
          result: { ok: true },
        }
      : {
          orchestrator: seller.claim,
          expectedAnchorLocator: expectedDeliveryLocator,
          result: { ok: true },
        },
    {
      resolvePublicKey: resolveKey,
      verify: async (bytes, signature, publicKey) =>
        ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
    },
  );
}

async function buildAndVerifyBundles(
  store: OfflineArtifactStore,
  published: PublishedListing,
  agreement: AgreementResult,
  buyer: RoleIdentity,
  seller: RoleIdentity,
  verifier: RoleIdentity,
  buyerVet: VetClosure,
  sellerVet: VetClosure,
  buyerVetRef: AttestationRef,
  sellerVetRef: AttestationRef,
  paymentEvidence: SettlementEvidence,
  paymentRef: AttestationRef,
  deliveryEvidence: SettlementEvidence,
  deliveryRef: AttestationRef,
): Promise<{
  buyerValid: boolean;
  sellerValid: boolean;
  consistency: "unified";
}> {
  const bundles = await buildTwoSidedBundle({
    jobId: JOB_ID,
    outcome: "completed",
    listingRef: published.pin,
    agreementRef: agreement.ref,
    phaseSummary: published.listing.pipeline.map((phase, index) => ({
      index,
      kind: phase.kind,
      outcome: "ok" as const,
    })),
    vetRecords: [buyerVetRef, sellerVetRef],
    settlementEvidence: [paymentRef, deliveryRef],
    recipeRegistryVersion: 1,
    railRegistryVersion: 1,
    finalisedAt: FIXTURE_NOW + 7_000,
    buyer: {
      primaryClaim: buyer.claim,
      bundleHash: identityBundleHash(buyer.bundle),
      signer: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(buyer.seed)),
    },
    seller: {
      primaryClaim: seller.claim,
      bundleHash: identityBundleHash(seller.bundle),
      signer: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(seller.seed)),
    },
  });
  if (!bundles.buyerCopy || !bundles.sellerCopy) {
    throw new Error("completed offline session did not produce both role copies");
  }
  const buyerBundleRef = await store.put(
    "dacs-5-buyer-bundle",
    "FaultAttestationBundle:buyer",
    asRecord(bundles.buyerCopy),
  );
  const sellerBundleRef = await store.put(
    "dacs-5-seller-bundle",
    "FaultAttestationBundle:seller",
    asRecord(bundles.sellerCopy),
  );

  const identities = [buyer, seller, verifier] as const;
  const resolveKey = keyResolver(identities);
  const verifierForParty = async (
    record: Readonly<CompositeVerificationRecord>,
  ): Promise<StrictCompositeVerification> => {
    if (record.evaluatedParty === buyer.claim) {
      return verifyVet(
        { ...buyerVet, record: structuredClone(record) },
        store,
        buyer,
        verifier,
      );
    }
    if (record.evaluatedParty === seller.claim) {
      return verifyVet(
        { ...sellerVet, record: structuredClone(record) },
        store,
        seller,
        verifier,
      );
    }
    return { status: "invalid", code: "evaluated-party-mismatch" };
  };
  const resolveAttestation = async (
    ref: Readonly<AttestationRef>,
  ): Promise<Record<string, unknown> | null> => store.read(ref.anchor.locator);
  const verifyBundle = (bundleLocator: string) =>
    verifyBundleCore(bundleLocator, {
      readArtifact: async (ref) => store.read(ref),
      resolveAttestationRef: resolveAttestation,
      resolveListingRef: async (pin) =>
        pin.listingId === published.pin.listingId &&
        pin.version === published.pin.version &&
        pin.contentHash === published.pin.contentHash
          ? asRecord(published.listing)
          : null,
      resolvePublicKey: resolveKey,
      verify: async (bytes, signature, publicKey) =>
        ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
      verifyEvidence: (evidence) =>
        verifyEvidence(
          evidence,
          seller,
          resolveKey,
          deliveryEvidence.deliverableAnchor!.locator,
        ),
      verifyCompositeRecord: verifierForParty,
    });
  const [buyerVerification, sellerVerification] = await Promise.all([
    verifyBundle(buyerBundleRef.anchor.locator),
    verifyBundle(sellerBundleRef.anchor.locator),
  ]);
  if (!buyerVerification.ok || !sellerVerification.ok) {
    throw new Error(
      `offline bundle graph verification failed: buyer=${buyerVerification.reason ?? "invalid"}, ` +
        `seller=${sellerVerification.reason ?? "invalid"}`,
    );
  }

  const copyDeps = {
    resolvePublicKey: resolveKey,
    verify: async (bytes: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) =>
      ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
  };
  const [buyerCopy, sellerCopy] = await Promise.all([
    verifyBundleCopy(asRecord(bundles.buyerCopy), "buyer", copyDeps),
    verifyBundleCopy(asRecord(bundles.sellerCopy), "seller", copyDeps),
  ]);
  if (!buyerCopy.valid || !sellerCopy.valid) {
    throw new Error("offline role-owned bundle copy verification failed");
  }
  const consistency = await bundleConsistency(
    {
      buyer: { disposition: "present", bundle: asRecord(bundles.buyerCopy) },
      seller: { disposition: "present", bundle: asRecord(bundles.sellerCopy) },
    },
    {
      isValid: async (bundle, role) =>
        (await verifyBundleCopy(bundle, role, copyDeps)).valid,
    },
  );
  if (consistency !== "unified") {
    throw new Error(`offline bundle copies are ${consistency}, expected unified`);
  }

  // The bundle verifier dereferenced these exact values. Keep these explicit
  // identity assertions as a guard against accidental map substitution.
  if (
    store.read(buyerVetRef.anchor.locator)?.["evaluatedParty"] !==
      buyerVet.record.evaluatedParty ||
    store.read(sellerVetRef.anchor.locator)?.["evaluatedParty"] !==
      sellerVet.record.evaluatedParty ||
    store.read(paymentRef.anchor.locator)?.["phase"] !== paymentEvidence.phase ||
    store.read(deliveryRef.anchor.locator)?.["phase"] !== deliveryEvidence.phase
  ) {
    throw new Error("offline referenced artifact identity changed after closure");
  }
  return { buyerValid: true, sellerValid: true, consistency };
}

async function timedPhase<T>(
  stage: OfflineRunPhase["stage"],
  artifactTypes: string[],
  operation: () => Promise<T>,
): Promise<{ result: T; phase: OfflineRunPhase }> {
  const startedAt = Date.now();
  const started = performance.now();
  const result = await operation();
  const endedAt = Date.now();
  return {
    result,
    phase: {
      stage,
      startedAt,
      endedAt,
      durationMs: Number((performance.now() - started).toFixed(3)),
      outcome: "ok",
      artifactTypes,
    },
  };
}

/**
 * Run the credential-free, zero-network, zero-spend quickstart lifecycle.
 *
 * The payment phase is the Standard's `pay-ap2` handler under an explicitly
 * mocked rail definition. Its local provider receipt is cryptographically
 * authenticated, but it is not represented as a live AP2 or substrate result.
 */
export async function runDeterministicOfflineLifecycle(
  options: OfflineLifecycleOptions,
): Promise<Readonly<OfflineRunReport>> {
  if (
    !options ||
    typeof options.outputDirectory !== "string" ||
    options.outputDirectory.trim() === ""
  ) {
    throw new TypeError("offline lifecycle outputDirectory must be a non-empty path");
  }
  const outputDirectory = resolve(options.outputDirectory);
  const artifactDirectory = resolve(outputDirectory, "artifacts");
  await mkdir(outputDirectory, { recursive: true });
  const store = new OfflineArtifactStore(artifactDirectory);
  await store.initialize();

  const buyer = roleIdentity(BUYER_SEED, "buyer");
  const seller = roleIdentity(SELLER_SEED, "seller");
  const verifier = roleIdentity(VERIFIER_SEED, "verifier");
  if (![buyer, seller, verifier].every(verifyIdentity)) {
    throw new Error("offline identity presentation verification failed");
  }
  const phases: OfflineRunPhase[] = [];

  const dacs1 = await timedPhase(
    "DACS-1",
    ["IdentityBundle", "Listing"],
    async () => {
      await Promise.all([
        store.put(
          "dacs-1-buyer-identity",
          "IdentityBundle:buyer",
          asRecord(buyer.bundle),
          { hash: identityBundleHash(buyer.bundle), signer: buyer.claim },
        ),
        store.put(
          "dacs-1-seller-identity",
          "IdentityBundle:seller",
          asRecord(seller.bundle),
          { hash: identityBundleHash(seller.bundle), signer: seller.claim },
        ),
        store.put(
          "dacs-1-verifier-identity",
          "IdentityBundle:verifier",
          asRecord(verifier.bundle),
          { hash: identityBundleHash(verifier.bundle), signer: verifier.claim },
        ),
      ]);
      return publishAndDiscoverListing(store, seller);
    },
  );
  phases.push(dacs1.phase);

  const dacs2 = await timedPhase(
    "DACS-2",
    [
      "SelfSignedRecipe",
      "SelfSignedAttestation:buyer",
      "SelfSignedAttestation:seller",
      "VerifyResult:buyer",
      "VerifyResult:seller",
      "CompositeVerificationRecord:buyer",
      "CompositeVerificationRecord:seller",
    ],
    async () => {
      const recipe = await selfSignedRecipe(verifier);
      await store.put(
        "dacs-2-self-signed-recipe",
        "RecipeDescriptor:self-signed",
        asRecord(recipe),
        { signer: verifier.claim },
      );
      const [buyerVet, sellerVet] = await Promise.all([
        produceVetClosure(store, "buyer", buyer, verifier, recipe),
        produceVetClosure(store, "seller", seller, verifier, recipe),
      ]);
      const [buyerVerification, sellerVerification] = await Promise.all([
        verifyVet(buyerVet, store, buyer, verifier),
        verifyVet(sellerVet, store, seller, verifier),
      ]);
      if (buyerVerification.status !== "valid" || sellerVerification.status !== "valid") {
        throw new Error("offline Vet closure verification failed");
      }
      const [buyerRef, sellerRef] = await Promise.all([
        store.put(
          "dacs-2-buyer-vet",
          "CompositeVerificationRecord:buyer",
          asRecord(buyerVet.record),
          { signer: verifier.claim },
        ),
        store.put(
          "dacs-2-seller-vet",
          "CompositeVerificationRecord:seller",
          asRecord(sellerVet.record),
          { signer: verifier.claim },
        ),
      ]);
      return { buyerVet, sellerVet, buyerRef, sellerRef };
    },
  );
  phases.push(dacs2.phase);

  const dacs3 = await timedPhase(
    "DACS-3",
    ["PayeeBoundAgreementDocument", "FinalityCommitmentRecord"],
    () =>
      negotiateAndCommit(
        store,
        dacs1.result,
        buyer,
        seller,
        dacs2.result.buyerRef,
        dacs2.result.sellerRef,
      ),
  );
  phases.push(dacs3.phase);

  const dacs4 = await timedPhase(
    "DACS-4",
    [
      "OfflineAp2ProviderReceipt",
      "SettlementEvidence:pay-ap2",
      "OfflineDeliverable",
      "SettlementEvidence:deliver-storage-program",
    ],
    () => settleAndDeliver(store, dacs3.result.agreement, seller, verifier),
  );
  phases.push(dacs4.phase);

  const resolveKey = keyResolver([buyer, seller, verifier]);
  const [paymentVerification, deliveryVerification] = await Promise.all([
    verifyEvidence(
      asRecord(dacs4.result.paymentEvidence),
      seller,
      resolveKey,
      dacs4.result.deliveryEvidence.deliverableAnchor!.locator,
    ),
    verifyEvidence(
      asRecord(dacs4.result.deliveryEvidence),
      seller,
      resolveKey,
      dacs4.result.deliveryEvidence.deliverableAnchor!.locator,
    ),
  ]);
  if (
    paymentVerification.decision !== "pass" ||
    deliveryVerification.decision !== "pass"
  ) {
    throw new Error(
      `offline DACS-4 verification failed: payment=${paymentVerification.decision}, ` +
        `delivery=${deliveryVerification.decision}`,
    );
  }

  const dacs5 = await timedPhase(
    "DACS-5",
    ["FaultAttestationBundle:buyer", "FaultAttestationBundle:seller"],
    () =>
      buildAndVerifyBundles(
        store,
        dacs1.result,
        dacs3.result,
        buyer,
        seller,
        verifier,
        dacs2.result.buyerVet,
        dacs2.result.sellerVet,
        dacs2.result.buyerRef,
        dacs2.result.sellerRef,
        dacs4.result.paymentEvidence,
        dacs4.result.paymentRef,
        dacs4.result.deliveryEvidence,
        dacs4.result.deliveryRef,
      ),
  );
  phases.push(dacs5.phase);

  const reportPath = resolve(outputDirectory, "run-report.json");
  const protocolBinding = createDacsNodeOfflineProtocolBinding(seller.claim);
  const report: OfflineRunReport = {
    reportVersion: "1",
    sdkVersion: VERSION,
    standardRevision: FIXED_PRICE_OFFLINE_STANDARD_REVISION,
    profile: FIXED_PRICE_OFFLINE_COMMERCE_PROFILE,
    mode: "offline",
    jobId: JOB_ID,
    protocolBinding,
    parties: {
      buyer: buyer.claim,
      seller: seller.claim,
      verifier: verifier.claim,
    },
    phases,
    artifacts: store.reportArtifacts,
    payment: {
      amount: "1",
      currency: "USD",
      railId: RAIL.railId,
      availability: "mocked",
      disposition: "offline",
    },
    verification: {
      listing: true,
      buyerVet: true,
      sellerVet: true,
      commitment: dacs3.result.committed.recordKind === "finality",
      paymentEvidence: true,
      deliveryEvidence: true,
      providerReceipt: dacs4.result.providerReceiptValid,
      buyerBundle: dacs5.result.buyerValid,
      sellerBundle: dacs5.result.sellerValid,
      bundleConsistency: dacs5.result.consistency,
    },
    overallSuccess: true,
    reportPath,
  };
  await writeFile(reportPath, `${canonicalize(report)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return Object.freeze(structuredClone(report));
}
