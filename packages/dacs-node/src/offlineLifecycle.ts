import { randomBytes } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
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
  generateCanonicalJobId,
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
  type BundleVerification,
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

const PAYMENT_PHASE_INDEX = 2;
const DELIVERY_PHASE_INDEX = 3;
const IDENTITY_SEPARATOR = "dacs-bundle-presentation:v1:";
const SIMULATION_RECEIPT_SEPARATOR =
  "dacs-x-simulation-ap2-provider-receipt:v1:";
const SIMULATION_ARTIFACT_VERSION = "1" as const;
export const OFFLINE_VERIFIER_SIMULATION_REPORT_KIND =
  "dacs-sdk-offline-verifier-simulation" as const;

const BUYER_SEED = new Uint8Array(32).fill(41);
const SELLER_SEED = new Uint8Array(32).fill(42);
const VERIFIER_SEED = new Uint8Array(32).fill(43);

export interface OfflineVerifierSimulationOptions {
  /** Fresh non-existent directory atomically published after all files validate. */
  outputDirectory: string;
}

/** Internal simulation gate: recursive verification must be complete, not merely non-failing. */
export function simulationBundleGraphVerificationPassed(
  verification: Pick<BundleVerification, "ok" | "fullyVerified">,
): boolean {
  return verification.ok && verification.fullyVerified;
}

export interface OfflineSimulationArtifact {
  simulatedType: string;
  simulatedContentHash: string;
  localReference: string;
}

export interface OfflineSimulationPhase {
  stage: "DACS-1" | "DACS-2" | "DACS-3" | "DACS-4" | "DACS-5";
  startedAt: number;
  endedAt: number;
  durationMs: number;
  outcome: "simulated-pass";
  simulatedArtifactTypes: string[];
}

export interface OfflineVerifierSimulationReport {
  reportKind: typeof OFFLINE_VERIFIER_SIMULATION_REPORT_KIND;
  reportVersion: "2";
  normativeConformance: false;
  commercialSuccess: false;
  simulationPassed: true;
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
  phases: OfflineSimulationPhase[];
  artifacts: OfflineSimulationArtifact[];
  payment: {
    amount: string;
    currency: string;
    railId: string;
    availability: "mocked";
    disposition: "simulation-only";
  };
  assurance: {
    purpose: "internal-verifier-exercise";
    persistedArtifacts: "wrapped-simulation-fixtures";
    substrateAuthority: "mocked-local-not-sr2";
    providerAuthority: "mocked-self-signed-not-sr3";
    railAuthority: "mocked-local-not-rav-r5";
    jobIdDiscipline: "fresh-csprng-ulid-per-run";
    sessionNonceDiscipline: "fresh-per-run-no-normative-challenge-ledger";
    paymentValueMoved: false;
    fixtureKeys: "public-deterministic-test-keys";
  };
  internalChecks: {
    listing: boolean;
    buyerVet: boolean;
    sellerVet: boolean;
    commitment: boolean;
    paymentEvidence: boolean;
    deliveryEvidence: boolean;
    providerFixtureSignature: boolean;
    buyerBundle: boolean;
    sellerBundle: boolean;
    bundleConsistency: "unified";
  };
  reportPath: string;
}

interface OfflineSimulationContext {
  jobId: string;
  listingId: string;
  nowMs: number;
  sessionNonces: {
    buyer: string;
    seller: string;
    verifier: string;
  };
}

interface StoredArtifact {
  type: string;
  hash: string;
  locator: string;
  value: Record<string, unknown>;
}

interface SimulationArtifactEnvelope {
  simulationArtifactVersion: typeof SIMULATION_ARTIFACT_VERSION;
  normativeConformance: false;
  commercialAuthority: "none";
  anchorAuthority: "none";
  portableAttestationRef: false;
  simulatedType: string;
  simulatedContentHash: string;
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
  railId: "x-simulation-ap2",
  railVersion: 1,
  parameters: {
    providerEndpoint: "https://simulation.invalid/not-ap2",
    availability: "mocked",
    mode: "simulation",
    authority: "none",
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

function freshSessionNonce(): string {
  return Buffer.from(randomBytes(16)).toString("hex");
}

function createSimulationContext(): OfflineSimulationContext {
  const jobId = generateCanonicalJobId();
  return {
    jobId,
    listingId: `offline-simulation-${jobId.toLowerCase()}`,
    nowMs: Date.now(),
    sessionNonces: {
      buyer: freshSessionNonce(),
      seller: freshSessionNonce(),
      verifier: freshSessionNonce(),
    },
  };
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error &&
      typeof error.code === "string"
    ? error.code
    : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function withExclusiveSimulationOutput<T>(
  requestedDirectory: string,
  run: (directories: Readonly<{
    stagingDirectory: string;
    finalDirectory: string;
  }>) => Promise<T>,
): Promise<T> {
  const requested = resolve(requestedDirectory);
  const leaf = basename(requested);
  if (leaf.length === 0 || requested === dirname(requested)) {
    throw new TypeError(
      "offline verifier simulation outputDirectory must name a new child directory",
    );
  }
  const requestedParent = dirname(requested);
  await mkdir(requestedParent, { recursive: true });
  const canonicalParent = await realpath(requestedParent);
  const finalDirectory = resolve(canonicalParent, leaf);
  if (await pathExists(finalDirectory)) {
    throw new Error(
      "offline verifier simulation outputDirectory already exists; choose a fresh directory",
    );
  }

  const stagingDirectory = resolve(
    canonicalParent,
    `.${leaf}.dacs-simulation-${randomBytes(16).toString("hex")}.tmp`,
  );
  await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
  try {
    const result = await run({ stagingDirectory, finalDirectory });
    try {
      await rename(stagingDirectory, finalDirectory);
    } catch (error) {
      if (["EEXIST", "ENOTEMPTY"].includes(errorCode(error) ?? "")) {
        throw new Error(
          "offline verifier simulation outputDirectory was published concurrently",
        );
      }
      throw error;
    }
    return result;
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

function roleIdentity(
  seed: Uint8Array,
  sessionNonce: string,
  nowMs: number,
): RoleIdentity {
  const claim = claimFor(seed);
  const keyClaim = `key:${Buffer.from(
    rawPublicKey(publicKeyFromSeed(seed)),
  ).toString("hex")}`;
  const bundle: IdentityBundle = {
    bundleVersion: "1",
    presentedBy: claim,
    presentedAt: nowMs - 10_000,
    sessionNonce,
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

class SimulationArtifactStore {
  readonly #root: string;
  readonly #runId: string;
  readonly #records = new Map<string, StoredArtifact>();
  readonly #reportArtifacts: OfflineSimulationArtifact[] = [];

  constructor(root: string, runId: string) {
    this.#root = root;
    this.#runId = runId;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: false, mode: 0o700 });
  }

  async put(
    fileName: string,
    type: string,
    value: Record<string, unknown>,
    options: { hash?: string; signer?: string } = {},
  ): Promise<AttestationRef> {
    const snapshot = structuredClone(value);
    const hash = options.hash ?? contentHash(snapshot);
    const locator = `x-simulation-internal:${this.#runId}:${fileName}`;
    await this.#writeFixture(fileName, type, snapshot, hash);
    this.#records.set(locator, { type, hash, locator, value: snapshot });
    this.#reportArtifacts.push({
      simulatedType: type,
      simulatedContentHash: hash,
      localReference: `simulation-artifacts/${fileName}.simulation.json`,
    });
    // The current recursive verifier consumes the Standard's closed
    // AttestationRef union. This reference exists only inside this process and
    // is resolved only by the map above. The bare value is never persisted:
    // #writeFixture wraps it in a fail-closed simulation envelope so no file is
    // a portable SR-2 target.
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
    if (!locator.startsWith(`x-simulation-internal:${this.#runId}:`)) {
      throw new Error("simulation store refuses a non-simulation locator");
    }
    await this.#writeFixture(fileName, type, snapshot, hash);
    this.#records.set(locator, { type, hash, locator, value: snapshot });
    this.#reportArtifacts.push({
      simulatedType: type,
      simulatedContentHash: hash,
      localReference: `simulation-artifacts/${fileName}.simulation.json`,
    });
  }

  async #writeFixture(
    fileName: string,
    type: string,
    value: Record<string, unknown>,
    hash: string,
  ): Promise<void> {
    const envelope: SimulationArtifactEnvelope = {
      simulationArtifactVersion: SIMULATION_ARTIFACT_VERSION,
      normativeConformance: false,
      commercialAuthority: "none",
      anchorAuthority: "none",
      portableAttestationRef: false,
      simulatedType: type,
      simulatedContentHash: hash,
      value,
    };
    await writeFile(
      resolve(this.#root, `${fileName}.simulation.json`),
      `${canonicalize(envelope)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  }

  read(locator: string): Record<string, unknown> | null {
    const value = this.#records.get(locator)?.value;
    return value ? structuredClone(value) : null;
  }

  get reportArtifacts(): OfflineSimulationArtifact[] {
    return structuredClone(this.#reportArtifacts);
  }
}

function railAuthority() {
  // DACS-4 §9.4.4 RAV-R5 requires a signed, anchored, independently resolved
  // rail definition. This local dependency is only an input to the simulation's
  // internal verifier exercise and is disclosed as non-authoritative in the
  // report; it must never be reused for production rail selection.
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

function listingDraft(
  seller: RoleIdentity,
  context: Readonly<OfflineSimulationContext>,
): ListingDraft {
  return {
    dacsVersion: "1",
    listingVersion: 1,
    listingId: context.listingId,
    seller: {
      identity: structuredClone(seller.bundle),
      displayName: "DACS verifier simulation seller fixture",
      publicEndpoint: "https://simulation.invalid/not-a-live-endpoint",
    },
    offering: {
      title: "Offline SDK verifier simulation fixture",
      description:
        "A local simulation fixture for exercising DACS SDK verifiers",
      category: "software.demo",
      tags: ["dacs", "simulation", "non-production"],
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
      notBefore: context.nowMs - 60_000,
      notAfter: context.nowMs + 60_000,
    },
  };
}

function listingValidationDeps(
  seller: RoleIdentity,
  context: Readonly<OfflineSimulationContext>,
): ListingValidationDeps {
  return {
    nowMs: () => context.nowMs,
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
  store: SimulationArtifactStore,
  seller: RoleIdentity,
  context: Readonly<OfflineSimulationContext>,
): Promise<PublishedListing> {
  let publishedListing: Record<string, unknown> | undefined;
  const published = await publishListingCore(listingDraft(seller, context), {
    sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(seller.seed)),
    scanOwnAnchorsByNamePrefix: async () => ({ status: "ok", anchors: [] }),
    writeArtifact: async (_logicalAddress, value, options) => {
      const ref = `x-simulation-internal:${context.jobId}:${options.storageName}`;
      publishedListing = structuredClone(value);
      await store.putAtLocator(
        "dacs-1-listing",
        "Listing",
        ref,
        value,
        contentHash(value),
      );
      return { address: ref, txRef: "x-simulation:listing-publication" };
    },
    loadRailResolution: () => railAuthority(),
    resolvePayloadVerificationCapability: () => ({ disposition: "supported" }),
  });
  if (!publishedListing) {
    throw new Error("simulation Listing fixture was not retained");
  }

  const discovered = await discoverListings(
    [published.ref],
    async (ref) => store.read(ref),
    {
      verify: (bytes, signature, publicKey) =>
        ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey)),
      resolvePublicKey: (claim) =>
        claim === seller.claim ? Uint8Array.from(seller.rawPublicKey) : null,
      validateListing: (raw) =>
        validateListingArtifact(raw, listingValidationDeps(seller, context)),
      nowMs: () => context.nowMs,
    },
  );
  const selected = discovered[0];
  if (!selected || selected.compatibility !== "normative") {
    throw new Error(
      "simulation Listing did not pass the SDK normative-shape discovery exercise",
    );
  }
  return {
    listing: selected.listing,
    pin: published.listingPin,
    ref: published.ref,
  };
}

async function selfSignedRecipe(
  verifier: RoleIdentity,
  context: Readonly<OfflineSimulationContext>,
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
        acceptedAt: context.nowMs - 20_000,
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
  store: SimulationArtifactStore,
  role: "buyer" | "seller",
  party: RoleIdentity,
  verifier: RoleIdentity,
  recipe: RecipeDescriptor & { signature: ComponentSignature },
  context: Readonly<OfflineSimulationContext>,
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
      reason: "simulation key-possession fixture signature verified",
      attestation: assertionRef,
      data: { keyPossession: true, mode: "simulation" },
      fetchedAt: context.nowMs - 4_000,
      verifiedAt: context.nowMs - 3_000,
      validUntil: context.nowMs + 3_596_000,
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
      jobId: context.jobId,
      evaluatedParty: party.claim,
      bundleHash: identityBundleHash(party.bundle),
      requirementHash: sha256Hex(canonicalize(KEY_REQUIREMENT)),
      freshness: [],
      supplementary: [],
      dealSpecific: [resultRef],
      overallDecision: "pass",
      generatedAt: context.nowMs - 2_000,
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
  store: SimulationArtifactStore,
  party: RoleIdentity,
  verifier: RoleIdentity,
  context: Readonly<OfflineSimulationContext>,
): Promise<StrictCompositeVerification> {
  return verifyCompositeVerificationRecord(
    closure.record,
    {
      jobId: context.jobId,
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
      nowMs: () => context.nowMs,
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
  store: SimulationArtifactStore,
  published: PublishedListing,
  buyer: RoleIdentity,
  seller: RoleIdentity,
  buyerVetRef: AttestationRef,
  sellerVetRef: AttestationRef,
  context: Readonly<OfflineSimulationContext>,
): Promise<AgreementResult> {
  const draft = deriveFixedPriceAgreement({
    jobId: context.jobId,
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
        payeeAddress: "x-simulation:mocked-provider",
      },
    ],
    generatedAt: context.nowMs,
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
      const nativeAddress =
        `x-simulation-not-sr2-${recordHash.slice(0, 20)}`;
      const receipt = localReceipt(seller, {
        receiptVersion: "1",
        substrate: "x-simulation-not-a-substrate",
        finalityProfile: "x-simulation-fixture-finality",
        logicalAddress,
        nativeAddress,
        contentHash: recordHash,
        transactionRef: {
          kind: "x-simulation",
          value: `x-simulation:tx:${recordHash.slice(0, 24)}`,
        },
        writer: seller.claim,
        state: "finalized",
        observationDisposition: "established",
        observedAt: context.nowMs + 2_000,
        blockRef: {
          id: `x-simulation:block:${context.jobId}:commitment`,
          height: "1",
          timestamp: context.nowMs + 1_000,
        },
      });
      retained = {
        record: structuredClone(record),
        nativeAddress,
        anchorTxRef: {
          kind: "storage-program",
          address: nativeAddress,
          writeTxHash: sha256Hex(`x-simulation:${recordHash}`),
        },
        anchorReceipt: receipt,
      };
      return structuredClone(retained);
    },
    verifyAnchorReceipt: (anchored) =>
      anchored.anchorReceipt.logicalAddress ===
          finalityCommitmentAddress(context.jobId) &&
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
        jobId: context.jobId,
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
      createdAt: context.nowMs + 500,
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

function signSimulationProviderFixture(
  verifier: RoleIdentity,
  agreement: AgreementArtifact,
  context: Readonly<OfflineSimulationContext>,
): Record<string, unknown> {
  const unsigned = {
    receiptVersion: "x-simulation-ap2-v1",
    mode: "simulation",
    availability: "mocked",
    provider: "self-signed-fixture-not-sr3",
    jobId: context.jobId,
    agreementHash: contentHash(asRecord(agreement)),
    mandateId: `simulation-mandate:${context.jobId}`,
    status: "simulated-captured",
    amount: "1",
    currency: "USD",
    observedAt: context.nowMs + 3_000,
  };
  return {
    ...unsigned,
    signature: {
      algorithm: "ed25519",
      signer: verifier.claim,
      value: signatureValue(
        ed25519Sign(
          signedBytes(SIMULATION_RECEIPT_SEPARATOR, contentHash(unsigned)),
          privateKeyFromSeed(verifier.seed),
        ),
      ),
    },
  };
}

function verifySimulationProviderFixture(
  value: Record<string, unknown>,
  verifier: RoleIdentity,
): boolean {
  const signature = value["signature"];
  if (
    value["receiptVersion"] !== "x-simulation-ap2-v1" ||
    value["mode"] !== "simulation" ||
    value["availability"] !== "mocked" ||
    value["status"] !== "simulated-captured" ||
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
      signedBytes(SIMULATION_RECEIPT_SEPARATOR, contentHash(value)),
      Uint8Array.from(decoded),
      publicKeyFromSeed(verifier.seed),
    )
  );
}

async function settleAndDeliver(
  store: SimulationArtifactStore,
  agreement: AgreementArtifact,
  seller: RoleIdentity,
  verifier: RoleIdentity,
  context: Readonly<OfflineSimulationContext>,
): Promise<{
  paymentEvidence: SettlementEvidence;
  paymentRef: AttestationRef;
  deliveryEvidence: SettlementEvidence;
  deliveryRef: AttestationRef;
  providerFixtureSignatureValid: boolean;
}> {
  const providerFixture = signSimulationProviderFixture(
    verifier,
    agreement,
    context,
  );
  const providerFixtureRef = await store.put(
    "dacs-4-simulation-provider-fixture",
    "SimulationProviderReceipt:not-AP2-2",
    providerFixture,
    { signer: verifier.claim },
  );
  const providerFixtureSignatureValid = verifySimulationProviderFixture(
    providerFixture,
    verifier,
  );
  if (!providerFixtureSignatureValid) {
    throw new Error(
      "simulation provider fixture failed its internal signature check",
    );
  }

  const paymentEvidence = signSettlementEvidence(
    {
      evidenceVersion: "1",
      jobId: context.jobId,
      phase: "pay-ap2",
      outcome: "success",
      observedAt: context.nowMs + 4_000,
      paymentTxRefs: [
        {
          kind: "ap2",
          mandateId: `simulation-mandate:${context.jobId}`,
          providerRef: providerFixtureRef.anchor.locator,
          protocolVersion: "x-simulation-not-ap2-v1",
          receiptAttestation: providerFixtureRef,
        },
      ],
      paymentAmount: { amount: "1", currency: "USD" },
      settlementFinality: {
        model: "provider-receipt",
        finalityObservedAt: context.nowMs + 3_000,
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
    deliverableVersion: "x-simulation-v1",
    mode: "simulation",
    jobId: context.jobId,
    result: "Hello from a non-conformant SDK verifier simulation.",
    generatedAt: context.nowMs + 5_000,
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
      jobId: context.jobId,
      phase: "deliver-storage-program",
      outcome: "success",
      observedAt: context.nowMs + 6_000,
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
    providerFixtureSignatureValid,
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
  attestationRef: Readonly<AttestationRef>,
) {
  return verifySettlementEvidence(
    evidence,
    evidence["phase"] === "pay-ap2"
      ? {
          orchestrator: seller.claim,
          agreement: { amount: "1", currency: "USD" },
          attestationRef,
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
          agreement: { amount: "1", currency: "USD" },
          attestationRef,
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
  store: SimulationArtifactStore,
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
  context: Readonly<OfflineSimulationContext>,
): Promise<{
  buyerValid: boolean;
  sellerValid: boolean;
  consistency: "unified";
}> {
  const bundles = await buildTwoSidedBundle({
    jobId: context.jobId,
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
    finalisedAt: context.nowMs + 7_000,
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
    throw new Error(
      "completed simulation fixture did not produce both role copies",
    );
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
        context,
      );
    }
    if (record.evaluatedParty === seller.claim) {
      return verifyVet(
        { ...sellerVet, record: structuredClone(record) },
        store,
        seller,
        verifier,
        context,
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
      verifyEvidence: async (evidence) => ({
        ...(await verifyEvidence(
          evidence,
          seller,
          resolveKey,
          deliveryEvidence.deliverableAnchor!.locator,
          evidence["phase"] === "pay-ap2" ? paymentRef : deliveryRef,
        )),
        authorizedSigner: seller.claim,
      }),
      verifyCompositeRecord: verifierForParty,
    });
  const [buyerVerification, sellerVerification] = await Promise.all([
    verifyBundle(buyerBundleRef.anchor.locator),
    verifyBundle(sellerBundleRef.anchor.locator),
  ]);
  if (!simulationBundleGraphVerificationPassed(buyerVerification) ||
      !simulationBundleGraphVerificationPassed(sellerVerification)) {
    throw new Error(
      `simulation bundle graph exercise failed: buyer=${buyerVerification.reason ?? "invalid"}, ` +
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
    throw new Error("simulation role-owned bundle copy verification failed");
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
    throw new Error(
      `simulation bundle copies are ${consistency}, expected unified`,
    );
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
    throw new Error(
      "simulation referenced artifact identity changed after closure",
    );
  }
  return { buyerValid: true, sellerValid: true, consistency };
}

async function timedPhase<T>(
  stage: OfflineSimulationPhase["stage"],
  artifactTypes: string[],
  operation: () => Promise<T>,
): Promise<{ result: T; phase: OfflineSimulationPhase }> {
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
      outcome: "simulated-pass",
      simulatedArtifactTypes: artifactTypes,
    },
  };
}

/**
 * Run a credential-free, zero-network, zero-spend internal verifier exercise.
 *
 * This function deliberately does not claim DACS conformance or commercial
 * success. It wraps every persisted fixture in a simulation-only envelope and
 * uses neither SR-2 anchor authority nor the SR-3/AP2-2 provider authority
 * required for normative success. The generated graph exists only to exercise
 * SDK construction, signing, dereferencing, and recursive verification code.
 */
export async function runOfflineVerifierSimulation(
  options: OfflineVerifierSimulationOptions,
): Promise<Readonly<OfflineVerifierSimulationReport>> {
  if (
    !options ||
    typeof options.outputDirectory !== "string" ||
    options.outputDirectory.trim() === ""
  ) {
    throw new TypeError(
      "offline verifier simulation outputDirectory must be a non-empty path",
    );
  }
  return withExclusiveSimulationOutput(
    options.outputDirectory,
    executeOfflineVerifierSimulation,
  );
}

async function executeOfflineVerifierSimulation({
  stagingDirectory: outputDirectory,
  finalDirectory,
}: Readonly<{
  stagingDirectory: string;
  finalDirectory: string;
}>): Promise<Readonly<OfflineVerifierSimulationReport>> {
  const context = createSimulationContext();
  const artifactDirectory = resolve(outputDirectory, "simulation-artifacts");
  const store = new SimulationArtifactStore(artifactDirectory, context.jobId);
  await store.initialize();

  const buyer = roleIdentity(
    BUYER_SEED,
    context.sessionNonces.buyer,
    context.nowMs,
  );
  const seller = roleIdentity(
    SELLER_SEED,
    context.sessionNonces.seller,
    context.nowMs,
  );
  const verifier = roleIdentity(
    VERIFIER_SEED,
    context.sessionNonces.verifier,
    context.nowMs,
  );
  if (![buyer, seller, verifier].every(verifyIdentity)) {
    throw new Error("simulation identity presentation exercise failed");
  }
  const phases: OfflineSimulationPhase[] = [];

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
      return publishAndDiscoverListing(store, seller, context);
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
      const recipe = await selfSignedRecipe(verifier, context);
      await store.put(
        "dacs-2-self-signed-recipe",
        "RecipeDescriptor:self-signed",
        asRecord(recipe),
        { signer: verifier.claim },
      );
      const [buyerVet, sellerVet] = await Promise.all([
        produceVetClosure(store, "buyer", buyer, verifier, recipe, context),
        produceVetClosure(store, "seller", seller, verifier, recipe, context),
      ]);
      const [buyerVerification, sellerVerification] = await Promise.all([
        verifyVet(buyerVet, store, buyer, verifier, context),
        verifyVet(sellerVet, store, seller, verifier, context),
      ]);
      if (buyerVerification.status !== "valid" || sellerVerification.status !== "valid") {
        throw new Error("simulation Vet closure exercise failed");
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
        context,
      ),
  );
  phases.push(dacs3.phase);

  const dacs4 = await timedPhase(
    "DACS-4",
    [
      "SimulationProviderReceipt:not-AP2-2",
      "SettlementEvidence:pay-ap2",
      "OfflineDeliverable",
      "SettlementEvidence:deliver-storage-program",
    ],
    () =>
      settleAndDeliver(
        store,
        dacs3.result.agreement,
        seller,
        verifier,
        context,
      ),
  );
  phases.push(dacs4.phase);

  const resolveKey = keyResolver([buyer, seller, verifier]);
  const [paymentVerification, deliveryVerification] = await Promise.all([
    verifyEvidence(
      asRecord(dacs4.result.paymentEvidence),
      seller,
      resolveKey,
      dacs4.result.deliveryEvidence.deliverableAnchor!.locator,
      dacs4.result.paymentRef,
    ),
    verifyEvidence(
      asRecord(dacs4.result.deliveryEvidence),
      seller,
      resolveKey,
      dacs4.result.deliveryEvidence.deliverableAnchor!.locator,
      dacs4.result.deliveryRef,
    ),
  ]);
  if (
    paymentVerification.decision !== "pass" ||
    deliveryVerification.decision !== "pass"
  ) {
    throw new Error(
      `simulation DACS-4 verifier exercise failed: payment=${paymentVerification.decision}, ` +
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
        context,
      ),
  );
  phases.push(dacs5.phase);

  const reportPath = resolve(finalDirectory, "simulation-report.json");
  const protocolBinding = createDacsNodeOfflineProtocolBinding(seller.claim);
  const report: OfflineVerifierSimulationReport = {
    reportKind: OFFLINE_VERIFIER_SIMULATION_REPORT_KIND,
    reportVersion: "2",
    normativeConformance: false,
    commercialSuccess: false,
    simulationPassed: true,
    sdkVersion: VERSION,
    standardRevision: FIXED_PRICE_OFFLINE_STANDARD_REVISION,
    profile: FIXED_PRICE_OFFLINE_COMMERCE_PROFILE,
    mode: "offline",
    jobId: context.jobId,
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
      disposition: "simulation-only",
    },
    assurance: {
      purpose: "internal-verifier-exercise",
      persistedArtifacts: "wrapped-simulation-fixtures",
      substrateAuthority: "mocked-local-not-sr2",
      providerAuthority: "mocked-self-signed-not-sr3",
      railAuthority: "mocked-local-not-rav-r5",
      jobIdDiscipline: "fresh-csprng-ulid-per-run",
      sessionNonceDiscipline:
        "fresh-per-run-no-normative-challenge-ledger",
      paymentValueMoved: false,
      fixtureKeys: "public-deterministic-test-keys",
    },
    internalChecks: {
      listing: true,
      buyerVet: true,
      sellerVet: true,
      commitment: dacs3.result.committed.recordKind === "finality",
      paymentEvidence: true,
      deliveryEvidence: true,
      providerFixtureSignature:
        dacs4.result.providerFixtureSignatureValid,
      buyerBundle: dacs5.result.buyerValid,
      sellerBundle: dacs5.result.sellerValid,
      bundleConsistency: dacs5.result.consistency,
    },
    reportPath,
  };
  await writeFile(
    resolve(outputDirectory, "simulation-report.json"),
    `${canonicalize(report)}\n`,
    {
      encoding: "utf8",
      flag: "wx",
    },
  );
  return Object.freeze(structuredClone(report));
}
