import { types as nodeTypes } from "node:util";
import type {
  AgreementArtifact,
  AnyAttestationBundle,
  AnchorReceipt as ProtocolAnchorReceipt,
  AttestationRef,
  ChainTxRef,
  CompositeVerificationRecord,
  IdentityBundle,
  ListingDraft,
  ListingPin,
} from "../artifacts/types.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import { verifyComponentSignature } from "../artifacts/signatures.js";
import {
  isAnyAttestationBundle,
  isAgreementArtifact,
  isAttestationRef,
  isChainTxRef,
  isIdentityBundle,
  isLegacyMvpListing,
  isListing,
  readListingArtifact,
} from "../artifacts/validators.js";
import {
  canonicalize,
  contentHash,
  listingAddress,
  logicalToStorageProgramName,
} from "../canonical/index.js";
import {
  ed25519Verify,
  publicKeyFromRaw,
  signedBytes,
  type DomainSeparator,
} from "../crypto/index.js";
import { isLegacyMvpAttestationBundle } from "../artifacts/legacyMvp.js";
import {
  createBoundArtifactRepository,
  type AnchorHistoryPageFetcher,
  type BindingIndex,
  type BindingPublisher,
  type BoundArtifactWriteResult,
} from "../discovery/index.js";
import { DacsError } from "../errors.js";
import {
  authenticateDemosCciRecord,
  canonicalDemosAgentPublicKey,
  classifyCciTlsnProof,
  demosAgentClaimRef,
  isCanonicalClaimReference,
  parseCanonicalClaimReference,
  parseCciRecord,
  parseDemosAgentClaimReference,
  requireCanonicalClaimReference,
  sameCanonicalClaimIdentity,
  type AuthenticateDemosCciDeps,
  type AuthenticateDemosCciResult,
  type CciRecord,
  type CciTlsnDisposition,
  type CciTlsnSessionContext,
  type ClassifyCciTlsnDeps,
} from "../identity/index.js";
import { generateCanonicalJobId } from "../negotiate/jobId.js";
import type {
  DemosWriteEvidence,
  SubstrateAdapter,
} from "../substrate/SubstrateAdapter.js";
import {
  runSessionCore,
  legacyMvpSessionAnchorName,
  type SessionDeps,
  type SessionResult,
  type SessionTerms,
  type SessionVetRequest,
  type SettleRequest,
  type SettleResult,
} from "./runSessionCore.js";
import {
  validateListingArtifact,
  type ListingValidationDeps,
  type ListingRailAuthorityInput,
  type PayloadVerificationCapabilityResolver,
} from "./listingValidation.js";
import type { StrictCompositeVerification } from "./compositeVerification.js";
import type { VetProduction } from "./vetCore.js";
import {
  publishListingCore,
  type PublishListingResult,
} from "./publishListingCore.js";
import {
  authenticateReadableListingArtifact,
  discoverListings,
  type DiscoveredListing,
} from "./discover.js";
import {
  listingDraftClaimReferencesArePublishable,
} from "./listingClaimReferences.js";
import { snapshotCanonicalJson } from "../canonical/snapshot.js";
import {
  computeReputation,
  type Reputation,
  type ReputationExclusion,
} from "./reputation.js";
import {
  buildSignedArtifact,
  verifySignedArtifact,
  type Signer,
  type Verifier,
} from "./signedArtifact.js";
import {
  attestationBundleHash,
} from "./twoSidedBundle.js";
import {
  verifySettlementEvidence,
  type EvidenceContext,
} from "./verifySettlementEvidence.js";
import {
  verifyBundleCore,
  type SignatureCheck,
  type BundleVerification,
  type VerifyBundleDeps,
} from "./verifyBundleCore.js";
import {
  enumerateListingsForSeller,
  readListingByLogicalAddress,
  type AuthenticatedListing,
  type EnumerateListingsOptions,
  type ListingEnumerationResult,
  type ListingReadResult,
} from "./listingDiscovery.js";
import type { DemosWriteJournal } from "../substrate/demosWriteJournal.js";

export type {
  SignatureCheck,
  BundleVerification,
  Reputation,
  ReputationExclusion,
  CciRecord,
};
export type {
  AuthenticatedListing,
  EnumerateListingsOptions,
  ListingEnumerationDiagnostic,
  ListingEnumerationResult,
  ListingReadFailure,
  ListingReadRejectionCheck,
  ListingReadRejectionCode,
  ListingReadResult,
} from "./listingDiscovery.js";

function stableAgentData(
  source: object,
  key: PropertyKey,
  label: string,
): unknown {
  if (nodeTypes.isProxy(source)) throw new DacsError(`${label} must be stable data`);
  let owner: object | null = source;
  try {
    while (owner !== null) {
      if (nodeTypes.isProxy(owner)) throw new TypeError("proxy prototype");
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor) {
        if (!("value" in descriptor)) throw new TypeError("accessor property");
        return descriptor.value;
      }
      owner = Object.getPrototypeOf(owner);
    }
  } catch (cause) {
    throw new DacsError(`${label} must be stable data`, { cause });
  }
  return undefined;
}

const INERT_AGENT_CALLBACK_RECEIVER = Object.freeze(Object.create(null)) as object;

function isolateAgentCallback<T>(candidate: (...args: never[]) => unknown): T {
  // A dependency record can also contain stores, secrets, or broad runtime
  // capabilities. Never make that record the implicit `this` value received by
  // one of its callbacks; retain only the exact function captured above.
  return ((...args: unknown[]) =>
    Reflect.apply(candidate, INERT_AGENT_CALLBACK_RECEIVER, args)) as T;
}

function stableAgentMethod<T>(
  source: object,
  key: PropertyKey,
  label: string,
  optional = false,
): T {
  const candidate = stableAgentData(source, key, label);
  if (candidate === undefined && optional) return undefined as T;
  if (typeof candidate !== "function" || nodeTypes.isProxy(candidate)) {
    throw new DacsError(`${label} must be a stable function`);
  }
  return isolateAgentCallback<T>(candidate as (...args: never[]) => unknown);
}

interface CapturedAgentDemosCciConfig {
  authenticateResolution: AuthenticateDemosCciDeps["authenticateResolution"];
  authenticateProviderClaim?: AuthenticateDemosCciDeps["authenticateProviderClaim"];
  verifyIdentityPresentation?: ClassifyCciTlsnDeps["verifyIdentityPresentation"];
  verifyNativeTlsn?: ClassifyCciTlsnDeps["verifyNativeTlsn"];
  nowMs?: () => number;
}

function captureAgentDemosCciConfig(
  value: unknown,
): Readonly<CapturedAgentDemosCciConfig> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      nodeTypes.isProxy(value)) {
    throw new DacsError("AgentConfig.demosCci must be stable data");
  }
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  const allowed = new Set<PropertyKey>([
    "authenticateResolution",
    "authenticateProviderClaim",
    "verifyIdentityPresentation",
    "verifyNativeTlsn",
    "nowMs",
  ]);
  if ((prototype !== Object.prototype && prototype !== null) ||
      !keys.includes("authenticateResolution") ||
      keys.some((key) => !allowed.has(key))) {
    throw new DacsError("AgentConfig.demosCci has an invalid capability shape");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const capture = <T>(key: string, optional = false): T | undefined => {
    const descriptor = descriptors[key];
    if (descriptor === undefined && optional) return undefined;
    if (!descriptor?.enumerable || !("value" in descriptor) ||
        typeof descriptor.value !== "function" || nodeTypes.isProxy(descriptor.value)) {
      throw new DacsError(`AgentConfig.demosCci.${key} must be a stable function`);
    }
    return isolateAgentCallback<T>(
      descriptor.value as (...args: never[]) => unknown,
    );
  };
  const authenticateResolution = capture<
    AuthenticateDemosCciDeps["authenticateResolution"]
  >("authenticateResolution")!;
  const authenticateProviderClaim = capture<
    NonNullable<AuthenticateDemosCciDeps["authenticateProviderClaim"]>
  >("authenticateProviderClaim", true);
  const verifyIdentityPresentation = capture<
    ClassifyCciTlsnDeps["verifyIdentityPresentation"]
  >("verifyIdentityPresentation", true);
  const verifyNativeTlsn = capture<ClassifyCciTlsnDeps["verifyNativeTlsn"]>(
    "verifyNativeTlsn",
    true,
  );
  const nowMs = capture<() => number>("nowMs", true);
  const nativeCapabilityCount = [
    verifyIdentityPresentation,
    verifyNativeTlsn,
    nowMs,
  ].filter((entry) => entry !== undefined).length;
  if (nativeCapabilityCount !== 0 && nativeCapabilityCount !== 3) {
    throw new DacsError(
      "AgentConfig.demosCci native TLSN verifiers and clock must be configured together",
    );
  }
  return Object.freeze({
    authenticateResolution,
    ...(authenticateProviderClaim === undefined ? {} : { authenticateProviderClaim }),
    ...(verifyIdentityPresentation === undefined
      ? {}
      : {
          verifyIdentityPresentation,
          verifyNativeTlsn: verifyNativeTlsn!,
          nowMs: nowMs!,
        }),
  });
}

/** Own the low-level reader policy once; the SDK retains the algorithm. */
function captureAgentListingValidationDeps(
  value: unknown,
  label: string,
): ListingValidationDeps | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) {
    throw new DacsError(`${label} must be stable data`);
  }
  const deps = value as ListingValidationDeps;
  const revocationValue = stableAgentData(
    deps,
    "revocation",
    `${label}.revocation`,
  );
  if (
    revocationValue === null ||
    typeof revocationValue !== "object" ||
    nodeTypes.isProxy(revocationValue)
  ) {
    throw new DacsError(`${label}.revocation must be stable data`);
  }
  const revocation = revocationValue as ListingValidationDeps["revocation"];
  return Object.freeze({
    nowMs: stableAgentMethod<ListingValidationDeps["nowMs"]>(
      deps,
      "nowMs",
      `${label}.nowMs`,
    ),
    verifyListingSignature: stableAgentMethod<
      ListingValidationDeps["verifyListingSignature"]
    >(deps, "verifyListingSignature", `${label}.verifyListingSignature`),
    revocation: Object.freeze({
      surfaces: snapshotCanonicalJson(
        stableAgentData(revocation, "surfaces", `${label}.revocation.surfaces`),
        `${label}.revocation.surfaces`,
      ) as ListingValidationDeps["revocation"]["surfaces"],
      readMarker: stableAgentMethod<
        ListingValidationDeps["revocation"]["readMarker"]
      >(revocation, "readMarker", `${label}.revocation.readMarker`),
      verifyMarkerSignature: stableAgentMethod<
        ListingValidationDeps["revocation"]["verifyMarkerSignature"]
      >(
        revocation,
        "verifyMarkerSignature",
        `${label}.revocation.verifyMarkerSignature`,
      ),
    }),
    verifyIdentityPresentation: stableAgentMethod<
      ListingValidationDeps["verifyIdentityPresentation"]
    >(
      deps,
      "verifyIdentityPresentation",
      `${label}.verifyIdentityPresentation`,
    ),
    loadRailResolution: stableAgentMethod<
      ListingValidationDeps["loadRailResolution"]
    >(deps, "loadRailResolution", `${label}.loadRailResolution`, true),
    resolvePayloadVerificationCapability: stableAgentMethod<
      ListingValidationDeps["resolvePayloadVerificationCapability"]
    >(
      deps,
      "resolvePayloadVerificationCapability",
      `${label}.resolvePayloadVerificationCapability`,
      true,
    ),
    verifySellerControl: stableAgentMethod<
      ListingValidationDeps["verifySellerControl"]
    >(deps, "verifySellerControl", `${label}.verifySellerControl`),
  });
}

function normalizedDemosPublicKey(value: string): string | null {
  const match = value.trim().match(/^(?:0x)?([0-9a-fA-F]{64})$/);
  return match?.[1]?.toLowerCase() ?? null;
}

/** Resolve only explicit identity-lookup conveniences, never signed claims. */
function demosIdentityLookup(subject: string): Readonly<{
  address: string;
  primaryClaim: string;
}> {
  const claim = parseDemosAgentClaimReference(subject);
  if (claim) {
    return {
      address: Buffer.from(claim.publicKey).toString("hex"),
      primaryClaim: claim.canonicalIdentity,
    };
  }
  const native = /^(?:0x)?([0-9a-fA-F]{64})$/.exec(subject)?.[1];
  if (native) {
    const address = native.toLowerCase();
    return { address, primaryClaim: demosAgentClaimRef(address) };
  }
  const parsed = requireCanonicalClaimReference(
    subject,
    "Identity lookup subject",
  );
  return {
    address: parsed.reference,
    primaryClaim: `${parsed.identity.scheme}:${parsed.identity.identifier}`,
  };
}

/** Verifier that lifts a raw 32-byte key into a KeyObject for ed25519Verify. */
const ed25519RawVerify: Verifier = (bytes, signature, publicKey) =>
  ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey));

export interface RunSessionOptions {
  /** The agreed fixed-price terms (rail must be offered by the listing). */
  terms: SessionTerms;
  /** Executes payment on the chosen rail (e.g. an x402 rail). */
  settle: (req: SettleRequest) => Promise<SettleResult>;
  /**
   * Runtime destination the buyer instructs the selected rail to pay and records
   * in its buyer-signed legacy Agreement extension. Required when that address
   * is in a different namespace from the seller claim (for example an EVM
   * recipient associated with a seller DID). Defaults to the seller claim only
   * for same-namespace rails. This option is not seller-authenticated payout
   * negotiation; use a PayeeBoundAgreementDocument for PB-1 binding.
   */
  expectedSettlementPayee?: string;
  /**
   * Optional Vet step: verify the seller before paying (e.g. resolveRecipe +
   * vetCore). Returns a finalized VetProduction; the session aborts before
   * settlement unless the decision is `pass`. Omit to skip vetting.
   */
  vet?: (request: SessionVetRequest) => Promise<VetProduction>;
  /** Required with `vet`; normally calls verifyCompositeVerificationRecord. */
  verifyVetRecord?: (
    record: Readonly<CompositeVerificationRecord>,
    request: Readonly<SessionVetRequest>,
  ) => Promise<StrictCompositeVerification>;
  /**
   * Required with `vet`. Independently resolves and cryptographically
   * authenticates the exact finalized VPC-3 record/ref/receipt binding on both
   * first production and resume; a shape-valid receipt is not sufficient.
   */
  authenticateVetFinality?: NonNullable<
    SessionDeps["authenticateVetFinality"]
  >;
  /**
   * Resume an interrupted session by passing the prior run's jobId. Anchored
   * artifacts are reused. Crash-safe no-repayment across processes additionally
   * requires both `sessionStore` and a durable/idempotent `resumeSettlement`
   * implementation; a job id alone cannot prove what happened after a lost rail
   * response. Omit for a new session.
   */
  jobId?: string;
  /** Optional durable buyer-session lifecycle store used for restart recovery. */
  sessionStore?: import("./sessionStore.js").SessionStore;
  /**
   * Reconcile a previously claimed payment whose durable session record still
   * has only an intent or ambiguous outcome. Must use the same rail idempotency
   * key and reconcile every ordered `req.priorAttempts` entry before returning.
   */
  resumeSettlement?: (req: SettleRequest) => Promise<SettleResult>;
  /**
   * Low-level DACS-1 reader dependencies. The SDK always executes the
   * normative `validateListingArtifact` algorithm; callers cannot substitute a
   * fabricated `verified` result. Overrides the agent-wide dependencies.
   */
  listingValidationDeps?: ListingValidationDeps;
}

/**
 * Prefer an authenticated logical-read result so the session pins the exact
 * signed content selected by the buyer across its pre-payment re-read. A native
 * string ref remains supported for callers that obtained it through another
 * trusted, already-pinned flow.
 */
export type SessionListingInput = string | AuthenticatedListing;

export interface AgentConfig {
  /** Demos node RPC URL. */
  demosRpc: string;
  /**
   * Wallet secret — mnemonic or private key — used to sign artifacts/txs.
   * Optional for a read-only Directory/consumer; write and session methods fail
   * before side effects when it is absent.
   */
  wallet?: string;
  /** Durable wallet/write authority required by Demos write methods. */
  demosWriteJournal?: DemosWriteJournal;
  /**
   * Local identity authority. Session-capable agents must provide the exact
   * DACS-1 bundle whose presentation is authenticated by `verifyPresentation`
   * (or an explicitly configured listing-validation fallback); the SDK
   * computes every session party hash from these bytes rather than `agentId`.
   */
  identity?: {
    agentId?: string;
    bundle?: IdentityBundle;
    /**
     * Authenticate this agent's exact DACS-1 bundle presentation before any
     * session effect. Keep this authority independent from seller Listing
     * validation when the two identities use different keys or claim methods.
     */
    verifyPresentation?: ListingValidationDeps["verifyIdentityPresentation"];
  };
  /**
   * DACS-1 §6.3.1 / CORE §B.1: explicit Ed25519 resolver for canonical
   * current ClaimReference methods that are not the self-certifying
   * `did:demos:agent` profile. It is used for signature verification and must
   * resolve the configured writer identity to the connected adapter's actual
   * signing key before a new artifact is signed.
   */
  resolveIdentitySigningPublicKey?: (
    claim: string,
  ) => Promise<Uint8Array | null> | Uint8Array | null;
  /** DACS-1 §6.3.4 LP-6 authority read for pay-bearing Listing publication. */
  loadListingRailResolution?: (
    listing: Readonly<ListingDraft>,
  ) => Promise<ListingRailAuthorityInput> | ListingRailAuthorityInput;
  /** DACS-4 DPA-1 local producer support for attested-payload Listings. */
  resolvePayloadVerificationCapability?: PayloadVerificationCapabilityResolver;
  /**
   * Low-level DACS-1 reader dependencies shared by normative discovery and,
   * unless overridden per call, new-session admission. The SDK owns the
   * ordered validation algorithm and accepts only its exact result.
   */
  listingValidationDeps?: ListingValidationDeps;
  /**
   * Strict DACS-2 closure verifier used by {@link Agent.verifyBundle} and
   * {@link Agent.getReputation}. It is required for any bundle whose
   * `vetRecords` is non-empty; omitting it deliberately makes those bundles
   * fail closed. Build expectations from independently trusted listing,
   * identity-bundle, and recipe-registry inputs rather than from the record.
   */
  verifyCompositeRecord?: NonNullable<
    VerifyBundleDeps["verifyCompositeRecord"]
  >;
  /**
   * Resolve independently authenticated DACS-4 context for one referenced
   * SettlementEvidence record. The SDK owns evidence shape, hash, signature,
   * agreement-price, rail-coherence, and attestation-ref verification; the
   * host supplies only facts that cannot be derived from the bundle itself:
   * the exact phase orchestrator and authenticated pinned-rail definition.
   *
   * Required whenever a public bundle verification contains settlement
   * evidence. Omission fails closed instead of accepting hash-only evidence.
   */
  resolveSettlementEvidenceContext?: AgentSettlementEvidenceContextResolver;

  /**
   * Optional Demos CCI trust capabilities. Authenticated identity resolution
   * requires `authenticateResolution`; provider scores additionally require
   * `authenticateProviderClaim`. Native TLSN qualification is exposed only
   * when both TLSN verification capabilities and a trusted clock are configured.
   */
  demosCci?: AgentDemosCciConfig;

  /**
   * Published logical→native binding authority used by listing writes and their
   * consumer-index readback. `publishListing` refuses to anchor unless this is
   * configured: a physical write without its independently readable binding
   * would leave an orphan that consumers cannot resolve safely. Agent-level
   * typed logical reads and owner-scoped enumeration require only `index`.
   */
  bindings?: AgentBindingConfig;
}

export interface AgentDemosCciConfig extends AuthenticateDemosCciDeps {
  verifyIdentityPresentation?: ClassifyCciTlsnDeps["verifyIdentityPresentation"];
  verifyNativeTlsn?: ClassifyCciTlsnDeps["verifyNativeTlsn"];
  /** Trusted wall clock used for current-session freshness evaluation. */
  nowMs?: () => number;
}

export interface AgentNativeCciTlsnInput {
  subject: string;
  bundle: IdentityBundle;
  proofHash: string;
  context: Omit<CciTlsnSessionContext, "evaluatedAt">;
}

export interface AgentSettlementEvidenceContextInput {
  evidence: Readonly<Record<string, unknown>>;
  bundle: Readonly<AnyAttestationBundle>;
  evidenceRef: Readonly<AttestationRef>;
  agreement: Readonly<AgreementArtifact>;
}

type AgentSettlementEvidenceResultContext = Omit<
  NonNullable<EvidenceContext["result"]>,
  "txRefs"
>;

export type AgentSettlementEvidenceContext = Omit<
  EvidenceContext,
  "agreement" | "attestationRef" | "paymentAddress" | "result"
> & {
  orchestrator: string;
  /** `txRefs` are derived from the authenticated bundle phase, never supplied. */
  result?: AgentSettlementEvidenceResultContext;
};

export type AgentSettlementEvidenceContextResolver = (
  input: Readonly<AgentSettlementEvidenceContextInput>,
) =>
  | Promise<AgentSettlementEvidenceContext | null>
  | AgentSettlementEvidenceContext
  | null;

function captureSettlementEvidenceContext(
  value: unknown,
  phase: string,
  agreement: Readonly<AgreementArtifact>,
): AgentSettlementEvidenceContext | null {
  let captured: unknown;
  try {
    captured = snapshotCanonicalJson(
      value,
      "Agent settlement evidence context",
    );
  } catch {
    return null;
  }
  if (
    captured === null ||
    typeof captured !== "object" ||
    Array.isArray(captured)
  ) {
    return null;
  }
  const context = captured as Record<string, unknown>;
  if (
    Object.prototype.hasOwnProperty.call(context, "agreement") ||
    Object.prototype.hasOwnProperty.call(context, "attestationRef") ||
    Object.prototype.hasOwnProperty.call(context, "paymentAddress") ||
    (context.result !== undefined &&
      context.result !== null &&
      typeof context.result === "object" &&
      Object.prototype.hasOwnProperty.call(context.result, "txRefs")) ||
    typeof context.orchestrator !== "string" ||
    context.orchestrator.length === 0
  ) {
    return null;
  }

  if (phase.startsWith("pay-")) {
    const rail = context.rail;
    const pinnedRail = agreement.terms.rail;
    if (
      rail === null ||
      typeof rail !== "object" ||
      Array.isArray(rail) ||
      !pinnedRail ||
      (rail as Record<string, unknown>).railId !== pinnedRail.railId ||
      (rail as Record<string, unknown>).handler !== phase ||
      typeof (rail as Record<string, unknown>).railType !== "string" ||
      typeof (rail as Record<string, unknown>).asset !== "string"
    ) {
      return null;
    }
  } else if (phase.startsWith("deliver-") && context.rail !== undefined) {
    // Rail context belongs only to payment evidence. Supplying it for delivery
    // can create a false phase/rail comparison in the generic verifier.
    return null;
  }

  return context as unknown as AgentSettlementEvidenceContext;
}

export interface AgentBindingConfig {
  /**
   * Consumer-facing well-known/catalog index updated by `publisher`; an
   * acknowledgement is not successful until this view resolves the exact tuple.
   */
  index: BindingIndex;
  /**
   * Writer-authorized target that updates the deployment's required discovery
   * surfaces. A production DACS listing publisher is normally composite across
   * well-known and catalog publication and must report partial success as
   * indeterminate, not published. Optional for read-only consumers; required by
   * `publishListing`.
   */
  publisher?: BindingPublisher;
}

type PublishedWrite = Extract<
  BoundArtifactWriteResult,
  { status: "published" }
>;
type AlreadyPublishedWrite = Extract<
  BoundArtifactWriteResult,
  { status: "already-published" }
>;
type ConflictingWrite = Extract<
  BoundArtifactWriteResult,
  { status: "conflict" }
>;
type IndeterminateWrite = Extract<
  BoundArtifactWriteResult,
  { status: "indeterminate" }
>;

/**
 * Seller listing result. A native `ref` is exposed only after the configured
 * consumer-facing index can resolve the exact published binding. Failure
 * variants retain the physical receipt under `publication.anchor` for a safe
 * same-listing retry, but do not expose it as a successfully published ref.
 * Here `published` means only publisher acknowledgement plus exact configured-
 * index readback; it is not a portable AnchorReceipt, finality proof, or a claim
 * that the Listing satisfies the complete DACS activation pipeline.
 */
export type PublishResult =
  | (PublishListingResult & {
      status: "published";
      publication: PublishedWrite;
    })
  | (PublishListingResult & {
      status: "already-published";
      publication: AlreadyPublishedWrite;
    })
  | (Pick<PublishListingResult, "logicalAddress" | "storageName"> & {
      status: "conflict";
      publication: ConflictingWrite;
    })
  | (Pick<PublishListingResult, "logicalAddress" | "storageName"> & {
      status: "indeterminate";
      publication: IndeterminateWrite;
    });

/**
 * Concrete adapter shape retained only by the explicitly unsafe/manual Agent
 * factory. The default {@link createAgent} result never exposes this object.
 * `raw` remains untyped so the pure package surface has no declaration-time
 * dependency on the optional demosdk peer.
 */
export interface DemosBackedAdapter extends SubstrateAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly raw: any;
  /** Re-authenticate a portable Demos proof through this adapter's RPC. */
  verifyDemosWriteEvidence(
    evidence: Readonly<DemosWriteEvidence>,
  ): Promise<boolean>;
  /** Re-authenticate a compact portable Demos AnchorReceipt without its index. */
  verifyDemosAnchorReceipt(
    receipt: Readonly<ProtocolAnchorReceipt>,
  ): Promise<boolean>;
}

/**
 * The DACS agent surface (T4). The small set of calls a dApp dev uses; the
 * adapter, artifact model, and signing are wired underneath.
 */
export interface Agent {
  /**
   * Anyone: resolve a subject's full cross-context identity (DACS-1) — its
   * primary claim plus all eight production Demos CCI contexts bound to it in
   * the GCR, not just the wallet key. Accepts a DID / `0x…` / bare-hex
   * primary key; other canonical claim refs are passed through (reverse
   * resolution is a substrate follow-up). Lookup conveniences are never
   * retained: the returned `primaryClaim` is a canonical parameter-free CF-3
   * identity.
   */
  resolveIdentity(subject: string): Promise<CciRecord>;
  /**
   * Resolve and authenticate the exact Demos GCR response through the
   * construction-time `AgentConfig.demosCci` trust capabilities.
   */
  resolveAuthenticatedIdentity(subject: string): Promise<AuthenticateDemosCciResult>;
  /**
   * Resolve authenticated CCI state and qualify one native TLSN commitment for
   * an exact current Vet job/session. This never routes a registered native
   * commitment through the external `tlsnotary` recipe.
   */
  qualifyNativeCciTlsn(
    input: Readonly<AgentNativeCciTlsnInput>,
  ): Promise<CciTlsnDisposition>;
  /**
   * Anyone: reverse-resolve a linked claim to the subject(s) that hold it —
   * `findByClaim("cci-web2:twitter:alice")` or
   * `findByClaim("cci-xm:evm:mainnet:0x…")` returns
   * the matching primary claims (Demos pubkeys), usually one, or [] if none.
   */
  findByClaim(claimRef: string): Promise<string[]>;
  /** Seller: sign, immutably anchor, and publish a normative Listing binding. */
  publishListing(listing: ListingDraft): Promise<PublishResult>;
  /**
   * Buyer/Directory: resolve and authenticate one historical Listing by its
   * canonical logical address. This authenticates binding, content, context,
   * and authorship; ordered active/revocation admission remains separate.
   */
  readListing(logicalAddress: string): Promise<ListingReadResult>;
  /**
   * Buyer/Directory: page through one known seller's Demos Listing history.
   * This is owner-scoped discovery, not global marketplace search.
   */
  enumerateListings(
    sellerId: string,
    options?: EnumerateListingsOptions,
  ): Promise<ListingEnumerationResult>;
  /**
   * Anyone: verify an anchored bundle's signatures, referenced artifacts, and
   * strict DACS-2 vet closure. Bundles with vet records fail closed unless
   * `AgentConfig.verifyCompositeRecord` was configured; bundles with settlement
   * evidence likewise require `AgentConfig.resolveSettlementEvidenceContext`.
   */
  verifyBundle(ref: string): Promise<BundleVerification>;
  /**
   * Buyer: resolve + structurally validate anchored listings at the given refs.
   * Refs are caller-supplied (shared out-of-band / via a directory) — a
   * global marketplace crawl still needs a catalog; use `enumerateListings` for
   * one known seller's history. Non-listing / missing refs are skipped.
   * (Seller-identity vetting is the separate Vet stage.)
   */
  discover(listingRefs: string[]): Promise<DiscoveredListing[]>;
  /**
   * @deprecated Buyer-only legacy settlement runner. Its result is explicitly
   * marked `legacy-mvp-settlement-only` and `commerceComplete: false`; it does
   * not run seller fulfilment, delivery evidence, or two-sided DACS-5
   * finalisation. New production integrations use the role-separated
   * fixed-price commerce coordinators.
   */
  runSession(
    listing: SessionListingInput,
    opts: RunSessionOptions,
  ): Promise<SessionResult>;
  /**
   * Anyone: derive reputation for a primary claim from its bundles. The bundle
   * refs are caller-supplied (enumerating a claim's bundles is an indexer
   * concern, not the substrate's); invalid refs, bundles that fail strict
   * verification (including unverified vet closure), and divergent copies are
   * excluded from the score and reported in the result.
   */
  getReputation(primaryClaim: string, bundleRefs: string[]): Promise<Reputation>;
}

/**
 * Explicit operator-only escape hatch for diagnostics, funded conformance
 * runs, and manual substrate operations. Never pass this object to application
 * callbacks, HTTP handlers, plugins, or generated production role services.
 * Those consumers must receive the default {@link Agent} surface instead.
 */
export interface UnsafeManualAgent<
  TAdapter extends SubstrateAdapter = DemosBackedAdapter,
> extends Agent {
  readonly adapter: TAdapter;
}

interface ConnectedAgentInput {
  adapter: DemosBackedAdapter;
  runtimeConfig: AgentConfig;
}

function capturedCreateConfigValue(
  config: AgentConfig,
  key: keyof AgentConfig,
): unknown {
  return stableAgentData(config, key, `AgentConfig.${key}`);
}

function captureAgentIdentityConfig(
  value: unknown,
): AgentConfig["identity"] {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) {
    throw new DacsError("AgentConfig.identity must be stable data");
  }
  const agentId = stableAgentData(
    value,
    "agentId",
    "AgentConfig.identity.agentId",
  );
  const bundle = stableAgentData(
    value,
    "bundle",
    "AgentConfig.identity.bundle",
  );
  const verifyPresentation = stableAgentMethod<
    NonNullable<AgentConfig["identity"]>["verifyPresentation"]
  >(
    value,
    "verifyPresentation",
    "AgentConfig.identity.verifyPresentation",
    true,
  );
  if (agentId !== undefined && typeof agentId !== "string") {
    throw new DacsError("AgentConfig.identity.agentId must be a string");
  }
  const retainedBundle = bundle === undefined
    ? undefined
    : snapshotCanonicalJson(
        bundle,
        "AgentConfig.identity.bundle",
      );
  if (retainedBundle !== undefined && !isIdentityBundle(retainedBundle)) {
    throw new DacsError(
      "AgentConfig.identity.bundle must be a normative DACS-1 IdentityBundle",
    );
  }
  return Object.freeze({
    ...(agentId === undefined ? {} : { agentId }),
    ...(retainedBundle === undefined ? {} : { bundle: retainedBundle }),
    ...(verifyPresentation === undefined ? {} : { verifyPresentation }),
  });
}

/**
 * Snapshot every retained construction capability before the first await. The
 * wallet bytes are deliberately absent: buildAgent needs only the fact that a
 * signer was connected, never the secret which connected it.
 */
function captureAgentRuntimeConfig(
  config: AgentConfig,
  hasWallet: boolean,
  demosCci: AgentDemosCciConfig | undefined,
): AgentConfig {
  const runtimeConfig: AgentConfig = {
    demosRpc: String(capturedCreateConfigValue(config, "demosRpc") ?? ""),
    ...(hasWallet ? { wallet: "connected-signer" } : {}),
  };
  const identity = captureAgentIdentityConfig(
    capturedCreateConfigValue(config, "identity"),
  );
  if (identity !== undefined) {
    Object.defineProperty(runtimeConfig, "identity", {
      value: identity,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  for (const key of [
    "resolveIdentitySigningPublicKey",
    "loadListingRailResolution",
    "resolvePayloadVerificationCapability",
    "listingValidationDeps",
    "verifyCompositeRecord",
    "resolveSettlementEvidenceContext",
    "bindings",
  ] as const) {
    const value = capturedCreateConfigValue(config, key);
    if (value !== undefined) {
      Object.defineProperty(runtimeConfig, key, {
        value,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
  }
  if (demosCci !== undefined) {
    Object.defineProperty(runtimeConfig, "demosCci", {
      value: demosCci,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(runtimeConfig);
}

async function connectAgentAdapter(config: AgentConfig): Promise<ConnectedAgentInput> {
  if (config === null || typeof config !== "object" || nodeTypes.isProxy(config)) {
    throw new DacsError("AgentConfig must be stable data");
  }
  const rpc = capturedCreateConfigValue(config, "demosRpc");
  if (typeof rpc !== "string" || rpc.length === 0) {
    throw new DacsError("AgentConfig.demosRpc must be a non-empty string");
  }
  const wallet = capturedCreateConfigValue(config, "wallet");
  if (wallet !== undefined && (typeof wallet !== "string" || wallet.length === 0)) {
    throw new DacsError("AgentConfig.wallet must be a non-empty string when supplied");
  }
  const writeJournal = capturedCreateConfigValue(config, "demosWriteJournal");
  const retainedDemosCci = captureAgentDemosCciConfig(
    capturedCreateConfigValue(config, "demosCci"),
  );
  const runtimeConfig = captureAgentRuntimeConfig(
    config,
    wallet !== undefined,
    retainedDemosCci,
  );
  // Lazy-load the adapter so importing the package barrel doesn't eagerly pull
  // @kynesyslabs/demosdk, whose ESM packaging breaks plain-Node-ESM imports of
  // the pure/verify surface. demosdk loads only when an agent is actually built.
  const { DemosAdapter } = await import("../substrate/index.js").catch(() => {
    throw new Error(
      "createAgent requires the optional peer @kynesyslabs/demosdk; install it to use the Demos adapter",
    );
  });
  const adapter = new DemosAdapter({
    rpc,
    ...(wallet === undefined ? {} : { secret: wallet }),
    ...(writeJournal === undefined ? {} : {
      writeJournal: writeJournal as DemosWriteJournal,
    }),
  });
  await adapter.connect();
  return { adapter, runtimeConfig };
}

/**
 * Create a connected agent. A wallet is connected and artifact signing is wired
 * only when `config.wallet` is present; read-only consumers can omit it.
 */
export async function createAgent(
  config: AgentConfig,
): Promise<Agent> {
  const connected = await connectAgentAdapter(config);
  return buildAgent(connected.adapter, connected.runtimeConfig);
}

/**
 * Build a connected Agent with direct adapter authority for explicit operator
 * diagnostics and manual tests. Application code should use createAgent().
 */
export async function createUnsafeManualAgent(
  config: AgentConfig,
): Promise<UnsafeManualAgent<DemosBackedAdapter>> {
  const connected = await connectAgentAdapter(config);
  return buildUnsafeManualAgent(connected.adapter, connected.runtimeConfig);
}

function captureBoundAdapterMethod<T>(
  adapter: object,
  key: PropertyKey,
): T | undefined {
  const candidate = stableAgentData(
    adapter,
    key,
    `SubstrateAdapter.${String(key)}`,
  );
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "function" || nodeTypes.isProxy(candidate)) {
    throw new DacsError(
      `SubstrateAdapter.${String(key)} must be a stable function`,
    );
  }
  return Function.prototype.bind.call(candidate, adapter) as T;
}

function missingAdapterCapability(name: string): never {
  throw new DacsError(`SubstrateAdapter.${name} is unavailable`);
}

/**
 * Build the Agent surface over an ALREADY-CONNECTED adapter. Split out from
 * {@link createAgent} so the full lifecycle (incl. the `runSession` dep wiring
 * that #41 verification depends on) is exercisable in a NON-LIVE test against an
 * in-memory adapter — the public-Agent path was previously only reachable via a
 * live, environment-skipped test, which let the missing `verifyListing` wiring
 * ship. Not exported from the package barrel; internal test seam.
 */
export function buildAgent<TAdapter extends SubstrateAdapter>(
  adapter: TAdapter,
  config: AgentConfig,
): Agent {
  if (adapter === null || typeof adapter !== "object" || nodeTypes.isProxy(adapter)) {
    throw new DacsError("SubstrateAdapter must be stable data");
  }
  // Capture exact, bound methods once and group them by authority. Downstream
  // subsystems receive only the group they need; none receives the adapter,
  // its raw client, or an ambient transfer/broadcast capability.
  const getAddressMethod = captureBoundAdapterMethod<
    SubstrateAdapter["getAddress"]
  >(adapter, "getAddress");
  const getPublicKeyMethod = captureBoundAdapterMethod<
    SubstrateAdapter["getPublicKey"]
  >(adapter, "getPublicKey");
  const signMethod = captureBoundAdapterMethod<SubstrateAdapter["sign"]>(
    adapter,
    "sign",
  );
  const readAnchorMethod = captureBoundAdapterMethod<
    SubstrateAdapter["readAnchor"]
  >(adapter, "readAnchor");
  const resolveAnchorByNameMethod = captureBoundAdapterMethod<
    SubstrateAdapter["resolveAnchorByName"]
  >(adapter, "resolveAnchorByName");
  const scanOwnAnchorsByNamePrefixMethod = captureBoundAdapterMethod<
    SubstrateAdapter["scanOwnAnchorsByNamePrefix"]
  >(adapter, "scanOwnAnchorsByNamePrefix");
  const anchorWriteOnceMethod = captureBoundAdapterMethod<
    SubstrateAdapter["anchorWriteOnce"]
  >(adapter, "anchorWriteOnce");
  const anchorAndWaitMethod = captureBoundAdapterMethod<
    SubstrateAdapter["anchorAndWait"]
  >(adapter, "anchorAndWait");
  const resolveIdentityMethod = captureBoundAdapterMethod<
    SubstrateAdapter["resolveIdentity"]
  >(adapter, "resolveIdentity");
  const findSubjectsByClaimMethod = captureBoundAdapterMethod<
    SubstrateAdapter["findSubjectsByClaim"]
  >(adapter, "findSubjectsByClaim");
  const historyPageFetcherMethod = captureBoundAdapterMethod<
    (expectedOwner: string) => AnchorHistoryPageFetcher
  >(adapter, "createAnchorHistoryPageFetcher");

  const publicReads = Object.freeze({
    getAddress: (): string =>
      getAddressMethod?.() ?? missingAdapterCapability("getAddress"),
    readAnchor: (address: string) =>
      readAnchorMethod?.(address) ?? missingAdapterCapability("readAnchor"),
    resolveAnchorByName: (name: string, owner: string) =>
      resolveAnchorByNameMethod?.(name, owner) ??
        missingAdapterCapability("resolveAnchorByName"),
    scanOwnAnchorsByNamePrefix: (prefix: string) =>
      scanOwnAnchorsByNamePrefixMethod?.(prefix) ??
        missingAdapterCapability("scanOwnAnchorsByNamePrefix"),
    createAnchorHistoryPageFetcher: historyPageFetcherMethod,
  });
  const identityReads = Object.freeze({
    resolveIdentity: (ref: string) =>
      resolveIdentityMethod?.(ref) ??
        missingAdapterCapability("resolveIdentity"),
    findSubjectsByClaim: (claim: string) =>
      findSubjectsByClaimMethod?.(claim) ??
        missingAdapterCapability("findSubjectsByClaim"),
  });
  const signing = Object.freeze({
    getAddress: publicReads.getAddress,
    getPublicKey: () =>
      getPublicKeyMethod?.() ?? missingAdapterCapability("getPublicKey"),
    sign: (bytes: Uint8Array) =>
      signMethod?.(bytes) ?? missingAdapterCapability("sign"),
  });
  const anchoring = Object.freeze({
    getAddress: publicReads.getAddress,
    readAnchor: publicReads.readAnchor,
    anchorWriteOnce: (
      name: string,
      value: object,
      options?: Parameters<SubstrateAdapter["anchorWriteOnce"]>[2],
    ) => anchorWriteOnceMethod?.(name, value, options) ??
      missingAdapterCapability("anchorWriteOnce"),
    anchorAndWait: (
      name: string,
      value: object,
      options?: Parameters<SubstrateAdapter["anchorAndWait"]>[2],
    ) => anchorAndWaitMethod?.(name, value, options) ??
      missingAdapterCapability("anchorAndWait"),
  });
  const loadListingRailResolution = stableAgentMethod<
    AgentConfig["loadListingRailResolution"]
  >(
    config,
    "loadListingRailResolution",
    "AgentConfig.loadListingRailResolution",
    true,
  );
  const configuredListingValidationDeps = captureAgentListingValidationDeps(
    stableAgentData(
      config,
      "listingValidationDeps",
      "AgentConfig.listingValidationDeps",
    ),
    "AgentConfig.listingValidationDeps",
  );
  const resolvePayloadVerificationCapability = stableAgentMethod<
    AgentConfig["resolvePayloadVerificationCapability"]
  >(
    config,
    "resolvePayloadVerificationCapability",
    "AgentConfig.resolvePayloadVerificationCapability",
    true,
  );
  const resolveIdentitySigningPublicKey = stableAgentMethod<
    AgentConfig["resolveIdentitySigningPublicKey"]
  >(
    config,
    "resolveIdentitySigningPublicKey",
    "AgentConfig.resolveIdentitySigningPublicKey",
    true,
  );
  const identity = stableAgentData(config, "identity", "AgentConfig.identity");
  if (
    identity !== undefined &&
    (identity === null || typeof identity !== "object" || nodeTypes.isProxy(identity))
  ) {
    throw new DacsError("AgentConfig.identity must be stable data");
  }
  const configuredBuyerId =
    identity === undefined
      ? undefined
      : stableAgentData(identity, "agentId", "AgentConfig.identity.agentId");
  if (
    configuredBuyerId !== undefined &&
    typeof configuredBuyerId !== "string"
  ) {
    throw new DacsError("AgentConfig.identity.agentId must be a string");
  }
  const identityBundleInput =
    identity === undefined
      ? undefined
      : stableAgentData(identity, "bundle", "AgentConfig.identity.bundle");
  const configuredBuyerIdentityBundle =
    identityBundleInput === undefined
      ? undefined
      : snapshotCanonicalJson(
          identityBundleInput,
          "AgentConfig.identity.bundle",
        );
  if (
    configuredBuyerIdentityBundle !== undefined &&
    !isIdentityBundle(configuredBuyerIdentityBundle)
  ) {
    throw new DacsError(
      "AgentConfig.identity.bundle must be a normative DACS-1 IdentityBundle",
    );
  }
  if (
    configuredBuyerIdentityBundle !== undefined &&
    configuredBuyerId !== undefined &&
    configuredBuyerIdentityBundle.presentedBy !== configuredBuyerId
  ) {
    throw new DacsError(
      "AgentConfig.identity.bundle.presentedBy must equal AgentConfig.identity.agentId",
    );
  }
  const configuredBuyerIdentityPresentationVerifier =
    identity === undefined
      ? undefined
      : stableAgentMethod<
          NonNullable<AgentConfig["identity"]>["verifyPresentation"]
        >(
          identity,
          "verifyPresentation",
          "AgentConfig.identity.verifyPresentation",
          true,
        );
  const resolveCanonicalSigningKey = async (
    claim: string,
  ): Promise<Uint8Array | null> => {
    const parsed = parseCanonicalClaimReference(claim);
    if (parsed === null) return null;
    const intrinsic = canonicalDemosAgentPublicKey(claim);
    if (intrinsic) return Uint8Array.from(intrinsic);
    if (!resolveIdentitySigningPublicKey) return null;
    // CORE CF-3 excludes advisory parameters from identity. Do not let two
    // parameter spellings of one party select different signing authorities.
    const identityClaim = `${parsed.identity.scheme}:${parsed.identity.identifier}`;
    const resolved = await resolveIdentitySigningPublicKey(identityClaim);
    if (resolved === null) return null;
    if (!(resolved instanceof Uint8Array) || resolved.length !== 32) {
      throw new DacsError(
        "identity signing-key resolver must return null or an exact 32-byte Ed25519 key",
      );
    }
    return Uint8Array.from(resolved);
  };
  const resolveCanonicalSigningKeyForRead = async (
    claim: string,
  ): Promise<Uint8Array | null> => {
    try {
      return await resolveCanonicalSigningKey(claim);
    } catch {
      return null;
    }
  };
  const requireConnectedSigner = async (
    claim: string,
    label: string,
  ): Promise<Uint8Array> => {
    const parsed = requireCanonicalClaimReference(claim, label);
    // DACS-1 §6.3.1 calls this substrate notation out explicitly: although
    // its unknown `demos` scheme is forwardable on read, a current producer
    // must never emit it as a ClaimReference or treat it as the agent DID.
    if (
      parsed.identity.scheme === "demos" &&
      /^0x[0-9a-fA-F]{64}$/i.test(parsed.identity.identifier)
    ) {
      throw new DacsError(
        `${label} cannot use native demos:0x address notation as a ClaimReference`,
      );
    }
    const expected = await resolveCanonicalSigningKey(claim);
    if (!expected) {
      throw new DacsError(
        `${label} uses an unsupported identity method; configure ` +
          "AgentConfig.resolveIdentitySigningPublicKey",
      );
    }
    const resolved = await signing.getPublicKey();
    if (!(resolved instanceof Uint8Array) || resolved.length !== 32) {
      throw new DacsError(
        `${label} requires the adapter's exact 32-byte Ed25519 signing public key`,
      );
    }
    const actual = Uint8Array.from(resolved);
    const addressHex = normalizedDemosPublicKey(signing.getAddress());
    const addressMatches = addressHex === null ||
      Buffer.from(addressHex, "hex").equals(Buffer.from(actual));
    if (!addressMatches || !Buffer.from(expected).equals(Buffer.from(actual))) {
      throw new DacsError(
        `${label} does not match the connected adapter signing key`,
      );
    }
    return actual;
  };
  const sign: Signer = (bytes) => signing.sign(bytes);
  const listingValidator = (deps: ListingValidationDeps | undefined) =>
    deps
      ? (raw: Record<string, unknown>) => validateListingArtifact(raw, deps)
      : undefined;
  // Capture policy at construction time. Callers cannot swap the verifier on
  // a live Agent between verifyBundle() and getReputation().
  const verifyCompositeRecord = stableAgentMethod<
    AgentConfig["verifyCompositeRecord"]
  >(
    config,
    "verifyCompositeRecord",
    "AgentConfig.verifyCompositeRecord",
    true,
  );
  const resolveSettlementEvidenceContext = stableAgentMethod<
    AgentConfig["resolveSettlementEvidenceContext"]
  >(
    config,
    "resolveSettlementEvidenceContext",
    "AgentConfig.resolveSettlementEvidenceContext",
    true,
  );
  const demosCci = captureAgentDemosCciConfig(
    stableAgentData(config, "demosCci", "AgentConfig.demosCci"),
  );
  const resolveDemosCciRaw = async (
    subject: string,
  ): Promise<Readonly<{ primaryClaim: string; raw: unknown }>> => {
    const lookup = demosIdentityLookup(subject);
    const resolved = await identityReads.resolveIdentity(lookup.address);
    return Object.freeze({
      primaryClaim: lookup.primaryClaim,
      raw: resolved.raw,
    });
  };
  const resolveAuthenticatedDemosCci = async (
    subject: string,
  ): Promise<AuthenticateDemosCciResult> => {
    if (!demosCci) {
      throw new DacsError(
        "resolveAuthenticatedIdentity requires AgentConfig.demosCci",
      );
    }
    if (!isCanonicalClaimReference(subject)) {
      return Object.freeze({
        status: "error" as const,
        reason: "CCI subject is malformed",
      });
    }
    const resolved = await resolveDemosCciRaw(subject);
    return authenticateDemosCciRecord(resolved.primaryClaim, resolved.raw, {
      authenticateResolution: demosCci.authenticateResolution,
      ...(demosCci.authenticateProviderClaim === undefined
        ? {}
        : { authenticateProviderClaim: demosCci.authenticateProviderClaim }),
    });
  };
  const verifyBundleAtRef = (ref: string): Promise<BundleVerification> =>
    verifyBundleCore(ref, {
      readArtifact: (artifactRef) => publicReads.readAnchor(artifactRef),
      // DACS-2 §7.5.2: normative refs carry their own anchor coordinates.
      // This adapter owns storage-program reads; other registered anchor kinds
      // need a transport-specific resolver supplied to verifyBundleCore.
      resolveAttestationRef: async (artifactRef) =>
        artifactRef.anchor.kind === "storage-program"
          ? publicReads.readAnchor(artifactRef.anchor.locator)
          : null,
      resolveListingRef: async (listingRef, parties) => {
        const seller = parties.find((party) => party.role === "seller");
        const key = seller
          ? await resolveCanonicalSigningKeyForRead(seller.primaryClaim)
          : null;
        if (!seller || !key) return null;
        const logical = listingAddress(
          seller.primaryClaim,
          listingRef.listingId,
          listingRef.version,
        );
        const resolved = await publicReads.resolveAnchorByName(
          logicalToStorageProgramName(logical),
          Buffer.from(key).toString("hex"),
        );
        return resolved.status === "present"
          ? publicReads.readAnchor(resolved.address)
          : null;
      },
      // Explicit pre-#308 compatibility for legacy SDK bundles whose refs were
      // keyed only by an SDK artifact kind and the enclosing job id.
      resolveRef: async (kind, jobId, parties, legacyRef) => {
        if (kind === "dacs-2-composite" && legacyRef) {
          return publicReads.readAnchor(legacyRef.id);
        }
        const name =
          kind === "dacs-3-agreement"
            ? legacyMvpSessionAnchorName.agreement(jobId)
            : kind === "dacs-4-evidence"
              ? legacyMvpSessionAnchorName.evidence(jobId)
              : kind === "dacs-2-verifyresult"
                ? legacyMvpSessionAnchorName.vet(jobId)
                : null;
        if (!name) return null;
        const buyer = parties.find((party) => party.role === "buyer");
        const key = buyer
          ? await resolveCanonicalSigningKeyForRead(buyer.primaryClaim)
          : null;
        if (!key) return null;
        const owner = Buffer.from(key).toString("hex");
        const resolved = await publicReads.resolveAnchorByName(name, owner);
        return resolved.status === "present"
          ? publicReads.readAnchor(resolved.address)
          : null;
      },
      resolvePublicKey: resolveCanonicalSigningKeyForRead,
      verify: ed25519RawVerify,
      ...(verifyCompositeRecord ? { verifyCompositeRecord } : {}),
      verifyEvidence: async (evidence, context) => {
        if (
          !context.agreement ||
          !isAgreementArtifact(context.agreement) ||
          !isAttestationRef(context.evidenceRef)
        ) {
          return { decision: "fail" as const, authorizedSigner: null };
        }
        const agreement = context.agreement;
        const phase = typeof evidence.phase === "string" ? evidence.phase : "";
        if (!resolveSettlementEvidenceContext) {
          return { decision: "indeterminate" as const, authorizedSigner: null };
        }
        let resolvedContext: AgentSettlementEvidenceContext | null;
        try {
          resolvedContext = captureSettlementEvidenceContext(
            await resolveSettlementEvidenceContext({
              evidence: structuredClone(evidence),
              bundle: structuredClone(context.bundle as AnyAttestationBundle),
              evidenceRef: structuredClone(context.evidenceRef),
              agreement: structuredClone(agreement),
            }),
            phase,
            agreement,
          );
        } catch {
          return { decision: "indeterminate" as const, authorizedSigner: null };
        }
        if (!resolvedContext) {
          return { decision: "error" as const, authorizedSigner: null };
        }
        let exactPhase:
          | Readonly<(typeof context.bundle.phaseSummary)[number]>
          | undefined;
        try {
          const evidenceRefBytes = canonicalize(context.evidenceRef);
          const matchingPhases = context.bundle.phaseSummary.filter(
            (candidate) =>
              candidate.kind === phase &&
              candidate.attestationRef !== undefined &&
              isAttestationRef(candidate.attestationRef) &&
              canonicalize(candidate.attestationRef) === evidenceRefBytes,
          );
          if (matchingPhases.length !== 1) {
            return { decision: "fail" as const, authorizedSigner: null };
          }
          exactPhase = matchingPhases[0];
        } catch {
          return { decision: "error" as const, authorizedSigner: null };
        }
        if (!exactPhase) {
          return { decision: "fail" as const, authorizedSigner: null };
        }
        const exactPaymentTxRefs = phase.startsWith("pay-")
          ? exactPhase.txRefs
          : undefined;
        if (
          phase.startsWith("pay-") && evidence.outcome === "success" &&
          exactPaymentTxRefs === undefined
        ) {
          return {
            decision: "indeterminate" as const,
            authorizedSigner: resolvedContext.orchestrator,
          };
        }
        if (
          exactPaymentTxRefs !== undefined &&
          !exactPaymentTxRefs.every((ref) => isChainTxRef(ref))
        ) {
          return { decision: "fail" as const, authorizedSigner: null };
        }
        const paymentAddress = phase.startsWith("pay-")
          ? agreement.terms.rail
            ? {
                railId: agreement.terms.rail.railId,
                phaseIndex: exactPhase.index,
                resolved: evidence.supersedesEvidenceRef !== undefined,
              }
            : null
          : undefined;
        if (paymentAddress === null) {
          return { decision: "fail" as const, authorizedSigner: null };
        }
        const verification = await verifySettlementEvidence(
          evidence,
          {
            ...resolvedContext,
            ...(paymentAddress === undefined ? {} : { paymentAddress }),
            result: {
              ...resolvedContext.result,
              // The exact signed phaseSummary entry, not the host resolver,
              // decides whether this handler result succeeded.
              ok: exactPhase.outcome === "ok",
              ...(exactPaymentTxRefs !== undefined
                ? { txRefs: exactPaymentTxRefs as readonly ChainTxRef[] }
                : {}),
            },
            agreement: {
              amount: agreement.terms.price.amount,
              currency: agreement.terms.price.currency,
            },
            attestationRef: context.evidenceRef,
          },
          {
            resolvePublicKey: resolveCanonicalSigningKeyForRead,
            verify: ed25519RawVerify,
          },
        );
        return {
          ...verification,
          authorizedSigner: resolvedContext.orchestrator,
        };
      },
    });
  const walletMarker = stableAgentData(
    config,
    "wallet",
    "AgentConfig.wallet",
  );
  const hasWallet =
    typeof walletMarker === "string" && walletMarker.length > 0;
  const bindingsValue = stableAgentData(
    config,
    "bindings",
    "AgentConfig.bindings",
  );
  const runtimeBindings =
    typeof bindingsValue === "object" && bindingsValue !== null
      ? (bindingsValue as { index?: unknown; publisher?: unknown })
      : null;
  const publisherValue = runtimeBindings?.publisher;
  if (
    bindingsValue !== undefined &&
    (runtimeBindings === null ||
      typeof (runtimeBindings.index as { resolve?: unknown } | undefined)
        ?.resolve !== "function" ||
      (publisherValue !== undefined &&
        (typeof publisherValue !== "object" ||
          publisherValue === null ||
          typeof (publisherValue as { publish?: unknown }).publish !==
            "function")))
  ) {
    throw new DacsError(
      "AgentConfig.bindings requires an index resolver and, when supplied, a valid publisher",
    );
  }
  const bindingIndex =
    (runtimeBindings?.index as BindingIndex | undefined) ?? null;
  const bindingPublisher = runtimeBindings?.publisher as
    | BindingPublisher
    | undefined;
  const artifactRepository = bindingPublisher === undefined || bindingIndex === null
    ? null
    : createBoundArtifactRepository({
          adapter: anchoring,
        index: bindingIndex,
        publisher: bindingPublisher,
      });
  const historyPageFetcherFactory = publicReads.createAnchorHistoryPageFetcher;

  return Object.freeze({
    async resolveIdentity(subject: string): Promise<CciRecord> {
      // The GCR routine resolves by Demos address (the ed25519 pubkey hex).
      // Accept a Demos DID / 0x-prefixed / bare-hex key as explicit lookup
      // conveniences, but never retain those caller aliases in protocol data.
      const resolved = await resolveDemosCciRaw(subject);
      return parseCciRecord(resolved.primaryClaim, resolved.raw);
    },

    async resolveAuthenticatedIdentity(
      subject: string,
    ): Promise<AuthenticateDemosCciResult> {
      return resolveAuthenticatedDemosCci(subject);
    },

    async qualifyNativeCciTlsn(
      input: Readonly<AgentNativeCciTlsnInput>,
    ): Promise<CciTlsnDisposition> {
      if (!demosCci?.verifyIdentityPresentation || !demosCci.verifyNativeTlsn ||
          !demosCci.nowMs) {
        throw new DacsError(
          "qualifyNativeCciTlsn requires AgentConfig.demosCci native TLSN verifiers and clock",
        );
      }
      let captured: AgentNativeCciTlsnInput;
      try {
        captured = snapshotCanonicalJson(
          input,
          "Agent native CCI TLSN request",
        ) as unknown as AgentNativeCciTlsnInput;
      } catch {
        return Object.freeze({
          status: "invalid",
          reason: "CCI TLSN request is malformed",
        });
      }
      if (Reflect.ownKeys(captured).length !== 4 ||
          !["subject", "bundle", "proofHash", "context"].every((key) =>
            Object.prototype.hasOwnProperty.call(captured, key)) ||
          captured.context === null || typeof captured.context !== "object" ||
          Object.prototype.hasOwnProperty.call(captured.context, "evaluatedAt")) {
        return Object.freeze({
          status: "invalid",
          reason: "CCI TLSN request is malformed",
        });
      }
      const resolution = await resolveAuthenticatedDemosCci(captured.subject);
      if (resolution.status !== "authenticated") {
        return Object.freeze({
          status: resolution.status,
          reason: resolution.reason,
        });
      }
      let evaluatedAt: number;
      try {
        evaluatedAt = demosCci.nowMs();
      } catch {
        return Object.freeze({
          status: "indeterminate",
          reason: "CCI TLSN evaluation clock was unavailable",
        });
      }
      if (!Number.isSafeInteger(evaluatedAt) || evaluatedAt < 0) {
        return Object.freeze({
          status: "error",
          reason: "CCI TLSN evaluation clock was malformed",
        });
      }
      return classifyCciTlsnProof(
        resolution.record,
        captured.bundle,
        captured.proofHash,
        { ...captured.context, evaluatedAt },
        {
          verifyIdentityPresentation: demosCci.verifyIdentityPresentation,
          verifyNativeTlsn: demosCci.verifyNativeTlsn,
        },
      );
    },

    async findByClaim(claimRef: string): Promise<string[]> {
      return identityReads.findSubjectsByClaim(claimRef);
    },

    async publishListing(listingInput: ListingDraft): Promise<PublishResult> {
      if (artifactRepository === null) {
        throw new DacsError(
          "publishListing requires AgentConfig.bindings.publisher so the logical-to-native binding is published",
        );
      }
      if (!hasWallet) {
        throw new DacsError(
          "publishListing requires AgentConfig.wallet for signing and anchoring",
        );
      }
      // The Agent callback below performs additional async index checks around
      // the pure core. Pin once here so both layers see the same listing even if
      // caller-owned fields are mutated while history lookup is in flight.
      const listing = structuredClone(listingInput);
      if (!listingDraftClaimReferencesArePublishable(listing)) {
        throw new DacsError(
          "publishListing ClaimReferences must use exact, current-producer-valid CORE B.1 CF-2 bytes",
        );
      }
      // This high-level Agent publishes through the native Demos
      // logical-to-storage binding. A resolver-backed foreign DID can be a
      // valid portable Listing signer, but it cannot identify the owner of
      // this Demos publication slot. Refuse it before any scan or write so a
      // fresh publication is always readable through this Agent's own Demos
      // discovery profile (DACS-1 §6.3.1 / §6.3.4 SR-1).
      const sellerKey = canonicalDemosAgentPublicKey(
        listing.seller.identity.presentedBy,
      );
      const walletKey = normalizedDemosPublicKey(signing.getAddress());
      if (sellerKey === null) {
        throw new DacsError(
          "publishListing seller uses an unsupported identity method for native Demos publication; expected canonical did:demos:agent identity",
        );
      }
      if (walletKey === null) {
        throw new DacsError(
          "publishListing requires a canonical native Demos adapter address",
        );
      }
      if (!Buffer.from(sellerKey).equals(Buffer.from(walletKey, "hex"))) {
        throw new DacsError(
          "listing seller identity does not match the connected adapter signing key",
        );
      }
      await requireConnectedSigner(
        listing.seller.identity.presentedBy,
        "listing seller identity",
      );
      if (bindingIndex === null) {
        throw new DacsError("publishListing has no configured binding index");
      }
      const targetVersion = listing.listingVersion;
      // Versioned, write-once publish (§6.3.4, #29/#46) — pure core over the
      // binding-aware repository. Do not use anchorAddress() here: on current
      // Demos it predicts the NEXT nonce-derived create address and cannot
      // locate an existing version slot (#70).
      let publication: BoundArtifactWriteResult | undefined;
      const result = await publishListingCore(listing, {
        sign,
        scanOwnAnchorsByNamePrefix: async (prefix) => {
          const scan = await publicReads.scanOwnAnchorsByNamePrefix(prefix);
          if (scan.status === "indeterminate") return scan;

          // A later version must not leapfrog an orphaned earlier physical
          // anchor. Every prior slot must already be independently resolvable
          // through the configured index with the exact immutable tuple.
          for (const anchor of scan.anchors) {
            const stored = readListingArtifact(anchor.value);
            if (stored === null) continue;
            const storedPublisher = stored.compatibility === "normative"
              ? stored.listing.seller.identity.presentedBy
              : stored.listing.agentId;
            const storedId = stored.compatibility === "normative"
              ? stored.listing.listingId
              : stored.listing.serviceId;
            const priorVersion = stored.listing.listingVersion ?? 1;
            if (
              !Number.isSafeInteger(priorVersion) ||
              (priorVersion as number) >= targetVersion ||
              storedPublisher !== listing.seller.identity.presentedBy ||
              storedId !== listing.listingId
            ) {
              continue;
            }

            const logicalAddress = listingAddress(
              listing.seller.identity.presentedBy,
              listing.listingId,
              priorVersion as number,
            );
            try {
              const resolution = await bindingIndex.resolve(
                logicalAddress,
                publicReads.getAddress(),
              );
              if (resolution.status !== "present") {
                return {
                  status: "indeterminate",
                  reason:
                    `prior listing v${String(priorVersion)} binding is ` +
                    `${resolution.status}; repair it before publishing v${targetVersion}`,
                };
              }
              const binding = resolution.binding;
              if (
                binding.logicalAddress !== logicalAddress ||
                binding.nativeAddress !== anchor.address ||
                normalizedDemosPublicKey(binding.owner) !== walletKey ||
                binding.contentHash !== contentHash(anchor.value) ||
                binding.version !== priorVersion ||
                binding.revoked === true
              ) {
                return {
                  status: "indeterminate",
                  reason:
                    `prior listing v${String(priorVersion)} binding does not ` +
                    `match its immutable anchor; repair it before publishing v${targetVersion}`,
                };
              }
            } catch (error) {
              return {
                status: "indeterminate",
                reason:
                  `prior listing v${String(priorVersion)} binding check failed: ` +
                  (error instanceof Error ? error.message : String(error)),
              };
            }
          }
          return scan;
        },
        writeArtifact: async (logicalAddress, value, options) => {
          publication = await artifactRepository.write(
            logicalAddress,
            value,
            options,
          );
          // publishListingCore deliberately owns a narrow, exact dependency
          // envelope. Keep richer substrate evidence on `publication.anchor`
          // for callers, but project only the fields the pure core consumes.
          return {
            address: publication.anchor.address,
            ...(publication.anchor.txRef === undefined
              ? {}
              : { txRef: publication.anchor.txRef }),
          };
        },
        loadRailResolution: loadListingRailResolution,
        resolvePayloadVerificationCapability:
          resolvePayloadVerificationCapability,
      });
      if (publication === undefined) {
        throw new DacsError(
          "publishListing completed without a binding publication receipt",
        );
      }
      if (
        publication.anchor.address !== result.ref ||
        publication.binding.logicalAddress !== result.logicalAddress ||
        publication.storageName !== result.storageName
      ) {
        throw new DacsError(
          "publishListing binding receipt does not match the anchored listing",
        );
      }
      switch (publication.status) {
        case "published":
          return { ...result, status: "published", publication };
        case "already-published":
          return { ...result, status: "already-published", publication };
        case "conflict":
          return {
            status: "conflict",
            logicalAddress: result.logicalAddress,
            storageName: result.storageName,
            publication,
          };
        case "indeterminate":
          return {
            status: "indeterminate",
            logicalAddress: result.logicalAddress,
            storageName: result.storageName,
            publication,
          };
      }
    },

    async readListing(logicalAddress: string): Promise<ListingReadResult> {
      if (bindingIndex === null) {
        throw new DacsError(
          "readListing requires AgentConfig.bindings.index for logical resolution",
        );
      }
      return readListingByLogicalAddress(logicalAddress, {
        index: bindingIndex,
        readAnchor: (nativeAddress, anchorKind) => {
          if (anchorKind !== undefined && anchorKind !== "storage-program") {
            throw new DacsError(
              `configured Demos adapter cannot dereference ${anchorKind} catalog anchors`,
            );
          }
          return publicReads.readAnchor(nativeAddress);
        },
        verify: ed25519RawVerify,
        ...(configuredListingValidationDeps
          ? { listingValidationDeps: configuredListingValidationDeps }
          : {}),
      });
    },

    async enumerateListings(
      sellerId: string,
      options?: EnumerateListingsOptions,
    ): Promise<ListingEnumerationResult> {
      if (bindingIndex === null) {
        throw new DacsError(
          "enumerateListings requires AgentConfig.bindings.index for logical resolution",
        );
      }
      return enumerateListingsForSeller(
        sellerId,
        {
          index: bindingIndex,
          readAnchor: (nativeAddress, anchorKind) => {
            if (anchorKind !== undefined && anchorKind !== "storage-program") {
              throw new DacsError(
                `configured Demos adapter cannot dereference ${anchorKind} catalog anchors`,
              );
            }
            return publicReads.readAnchor(nativeAddress);
          },
          verify: ed25519RawVerify,
          ...(configuredListingValidationDeps
            ? { listingValidationDeps: configuredListingValidationDeps }
            : {}),
          ...(typeof historyPageFetcherFactory === "function"
            ? {
                createHistoryPageFetcher: (expectedOwner: string) =>
                  historyPageFetcherFactory(expectedOwner),
              }
            : {}),
        },
        options,
      );
    },

    async verifyBundle(ref: string): Promise<BundleVerification> {
      // Bundle signature verification (§7.7) PLUS dereferencing each referenced
      // artifact and hash-checking it. Normative DACS-2 §7.5.2 refs resolve the
      // signed storage-program locator directly. Pre-#308 MVP refs alone use
      // owner-bound name resolution (kind, jobId → name → address), because
      // their physical address folds in the writer's create-time nonce (#70).
      return verifyBundleAtRef(ref);
    },

    async discover(
      listingRefs: string[],
    ): Promise<DiscoveredListing[]> {
      // DACS-1 §6.3.4: verify the structured signer through seller.identity;
      // historical string signatures remain in the explicit legacy read arm.
      return discoverListings(listingRefs, (r) => publicReads.readAnchor(r), {
        verify: ed25519RawVerify,
        resolvePublicKey: resolveCanonicalSigningKeyForRead,
        validateListing: listingValidator(configuredListingValidationDeps),
      });
    },

    async runSession(
      listingInput: SessionListingInput,
      opts: RunSessionOptions,
    ): Promise<SessionResult> {
      if (!hasWallet) {
        throw new Error("runSession requires createAgent({ wallet })");
      }
      if (opts === null || typeof opts !== "object" || nodeTypes.isProxy(opts)) {
        throw new DacsError("Agent.runSession options must be stable data");
      }
      const inputTerms = stableAgentData(opts, "terms", "Agent.runSession terms");
      const inputJobId = stableAgentData(opts, "jobId", "Agent.runSession jobId");
      const inputExpectedSettlementPayee = stableAgentData(
        opts,
        "expectedSettlementPayee",
        "Agent.runSession expectedSettlementPayee",
      );
      const settle = stableAgentMethod<RunSessionOptions["settle"]>(
        opts,
        "settle",
        "Agent.runSession settle",
      );
      const vet = stableAgentMethod<RunSessionOptions["vet"]>(
        opts,
        "vet",
        "Agent.runSession vet",
        true,
      );
      const verifyVetRecord = stableAgentMethod<RunSessionOptions["verifyVetRecord"]>(
        opts,
        "verifyVetRecord",
        "Agent.runSession verifyVetRecord",
        true,
      );
      const authenticateVetFinality = stableAgentMethod<
        RunSessionOptions["authenticateVetFinality"]
      >(
        opts,
        "authenticateVetFinality",
        "Agent.runSession authenticateVetFinality",
        true,
      );
      const resumeSettlement = stableAgentMethod<
        RunSessionOptions["resumeSettlement"]
      >(
        opts,
        "resumeSettlement",
        "Agent.runSession resumeSettlement",
        true,
      );
      const sessionListingValidationDeps = captureAgentListingValidationDeps(
        stableAgentData(
          opts,
          "listingValidationDeps",
          "Agent.runSession listingValidationDeps",
        ),
        "Agent.runSession listingValidationDeps",
      );
      const sessionStore = stableAgentData(
        opts,
        "sessionStore",
        "Agent.runSession sessionStore",
      ) as RunSessionOptions["sessionStore"];
      const options = snapshotCanonicalJson(
        {
          terms: inputTerms,
          ...(inputJobId !== undefined ? { jobId: inputJobId } : {}),
          ...(inputExpectedSettlementPayee !== undefined
            ? { expectedSettlementPayee: inputExpectedSettlementPayee }
            : {}),
        },
        "Agent.runSession options",
      ) as {
        terms: SessionTerms;
        jobId?: string;
        expectedSettlementPayee?: string;
      };
      const buyerId = configuredBuyerId;
      if (!buyerId) {
        throw new Error(
          "runSession requires createAgent({ identity: { agentId } })",
        );
      }
      const buyerIdentityBundle = configuredBuyerIdentityBundle;
      if (!buyerIdentityBundle) {
        throw new DacsError(
          "runSession requires createAgent({ identity: { agentId, bundle } })",
        );
      }
      const buyerIdentityPresentationVerifier =
        configuredBuyerIdentityPresentationVerifier ??
        sessionListingValidationDeps?.verifyIdentityPresentation ??
        configuredListingValidationDeps?.verifyIdentityPresentation;
      if (!buyerIdentityPresentationVerifier) {
        throw new DacsError(
          "runSession requires a configured DACS-1 identity presentation verifier",
        );
      }
      if (
        buyerId.normalize("NFC") !== buyerId ||
        buyerId.trim() !== buyerId ||
        /[\u0000-\u001f\u007f]/.test(buyerId) ||
        parseCanonicalClaimReference(buyerId) === null
      ) {
        throw new DacsError(
          "runSession buyer identity must use exact CORE B.1 CF-2 ClaimReference bytes",
        );
      }
      if (
        canonicalDemosAgentPublicKey(buyerId) === null &&
        !resolveIdentitySigningPublicKey
      ) {
        throw new DacsError(
          "runSession buyer identity uses an unsupported identity method; " +
            "configure AgentConfig.resolveIdentitySigningPublicKey",
        );
      }
      // Both fresh writes and recovery authenticate as this identity. Resolve
      // and bind it lazily at the first signature/authentication operation, then
      // retain one owned key snapshot for the rest of this run.
      let buyerSigningPublicKeyPromise: Promise<Uint8Array> | undefined;
      const buyerSigningPublicKey = (): Promise<Uint8Array> => {
        buyerSigningPublicKeyPromise ??= requireConnectedSigner(
          buyerId,
          "runSession buyer identity",
        );
        return buyerSigningPublicKeyPromise;
      };
      const signAsBuyer = async (bytes: Uint8Array): Promise<Uint8Array> => {
        await buyerSigningPublicKey();
        return sign(bytes);
      };
      const verifyBuyerComponentArtifact = async (
        raw: Record<string, unknown>,
        separator: DomainSeparator,
        buyerClaim: string,
      ): Promise<boolean> => {
        if (!sameCanonicalClaimIdentity(buyerClaim, buyerId)) return false;
        const publicKey = await buyerSigningPublicKey();
        const verdict = await verifyComponentSignature(raw, separator, {
          isSignerAuthorized: (_artifact, signature) =>
            signature.algorithm === "ed25519" &&
            sameCanonicalClaimIdentity(signature.signer, buyerClaim),
          resolvePublicKey: (signature) =>
            sameCanonicalClaimIdentity(signature.signer, buyerClaim)
              ? publicKey
              : null,
          verify: ({ signedBytes: bytes, signature, publicKey }) => {
            const signatureBytes = Uint8Array.from(
              Buffer.from(signature.value, "base64url"),
            );
            return signatureBytes.length === 64
              ? ed25519RawVerify(bytes, signatureBytes, publicKey)
              : false;
          },
        });
        return verdict.status === "valid";
      };
      let listingRef: string;
      let expectedContentHash: string | null = null;
      let expectedListingPin: ListingPin | undefined;
      if (typeof listingInput === "string") {
        listingRef = listingInput;
      } else {
        let selectedValue: unknown;
        try {
          selectedValue = structuredClone(listingInput);
        } catch (error) {
          throw new DacsError(
            "runSession Listing selection could not be snapshotted",
            { cause: error },
          );
        }
        if (
          typeof selectedValue !== "object" ||
          selectedValue === null ||
          Array.isArray(selectedValue) ||
          !("listing" in selectedValue)
        ) {
          throw new DacsError(
            "runSession requires an internally consistent authenticated Listing selection",
          );
        }
        const selected = selectedValue as AuthenticatedListing;
        let selectedSeller: string;
        let selectedListingId: string;
        let selectedVersion: number;
        if (
          selected.compatibility === "normative" &&
          selected.status === "verified" &&
          isListing(selected.listing)
        ) {
          selectedSeller = selected.listing.seller.identity.presentedBy;
          selectedListingId = selected.listing.listingId;
          selectedVersion = selected.listing.listingVersion;
        } else if (
          selected.compatibility === "legacy-mvp" &&
          selected.status === "authenticated" &&
          isLegacyMvpListing(selected.listing) &&
          !Object.prototype.hasOwnProperty.call(selected.listing, "signature") &&
          !Object.prototype.hasOwnProperty.call(selected.listing, "signatures")
        ) {
          selectedSeller = selected.listing.agentId;
          selectedListingId = selected.listing.serviceId;
          selectedVersion = selected.listing.listingVersion ?? 1;
        } else {
          throw new DacsError(
            "runSession requires an internally consistent authenticated Listing selection",
          );
        }
        let selectedHash: string;
        try {
          selectedHash = contentHash(
            selected.listing as unknown as Record<string, unknown>,
          );
        } catch (error) {
          throw new DacsError("runSession Listing selection is not canonical", {
            cause: error,
          });
        }
        if (
          typeof selected.ref !== "string" ||
          selected.ref.trim().length === 0 ||
          typeof selected.contentHash !== "string" ||
          !/^[0-9a-f]{64}$/.test(selected.contentHash) ||
          selectedHash !== selected.contentHash ||
          typeof selected.listingPin !== "object" ||
          selected.listingPin === null ||
          selected.listingPin.listingId !== selectedListingId ||
          selected.listingPin.version !== selectedVersion ||
          selected.listingPin.contentHash !== selected.contentHash ||
          !Number.isSafeInteger(selected.version) ||
          selected.version !== selectedVersion ||
          listingAddress(
            selectedSeller,
            selectedListingId,
            selectedVersion,
          ) !== selected.logicalAddress
        ) {
          throw new DacsError(
            "runSession requires an internally consistent authenticated Listing selection",
          );
        }
        listingRef = selected.ref;
        expectedContentHash = selected.contentHash;
        expectedListingPin = structuredClone(selected.listingPin);
      }
      return runSessionCore(
        listingRef,
        options.terms,
        {
          buyerId,
          buyerIdentityBundle,
          authenticateBuyerIdentityBundle: ({ bundle, signedBytes: bytes }) =>
            buyerIdentityPresentationVerifier({ bundle, signedBytes: bytes }),
          readListing: (ref) => publicReads.readAnchor(ref),
          // Temporary reduced-MVP agreement writer. DACS-3 AgreementSignature[]
          // migration is owned by #98; it is deliberately not coerced into a
          // ComponentSignature envelope here.
          sign: (artifact, separator) =>
            buildSignedArtifact(
              artifact,
              separator as DomainSeparator,
              signAsBuyer,
            ),
          signBytes: signAsBuyer,
          // Do not move to payment or the next artifact after mere node
          // acceptance. The current phase must be canonical and readable.
          anchor: async (name, value) =>
            (
              await anchoring.anchorAndWait(name, value, {
                completion: "read-visible",
              })
            ).address,
          // Resume resolves BY NAME (owner = this agent), failing closed on an
          // indeterminate lookup rather than re-anchoring/re-settling (#70).
          resolveAnchor: async (name) => {
            const r = await publicReads.resolveAnchorByName(
              name,
              publicReads.getAddress(),
            );
            if (r.status === "indeterminate") return { status: "indeterminate", reason: r.reason };
            if (r.status === "absent") return { status: "absent" };
            const value = await publicReads.readAnchor(r.address);
            return value
              ? { status: "present", ref: r.address, value }
              : { status: "indeterminate", reason: "resolved address was not readable" };
          },
          // #41 — verify the listing against the key in its own agentId before
          // vetting or settlement. Without this the money path would run on an
          // unverified listing (and the gate below would throw).
          verifyListing: async (raw, sellerClaim) => {
            if (expectedContentHash !== null) {
              try {
                if (contentHash(raw) !== expectedContentHash) return false;
              } catch {
                return false;
              }
            }
            // Authenticate the exact Listing independently of its current
            // wall-clock validity. runSessionCore applies that admission policy:
            // fresh sessions must be in-window, while an expired recovery must
            // first prove an exact signed Agreement and authenticated successful
            // SettlementEvidence before this callback is reached.
            const verified = await authenticateReadableListingArtifact(raw, {
              verify: ed25519RawVerify,
              resolvePublicKey: resolveCanonicalSigningKeyForRead,
            });
            if (!verified) return false;
            const advertisedSeller =
              verified.compatibility === "normative"
                ? verified.listing.seller.identity.presentedBy
                : verified.listing.agentId;
            return sameCanonicalClaimIdentity(advertisedSeller, sellerClaim);
          },
          authenticateRecoveredAgreement: async (raw, buyerClaim) => {
            if (
              !sameCanonicalClaimIdentity(buyerClaim, buyerId) ||
              Object.prototype.hasOwnProperty.call(raw, "signatures") ||
              typeof raw.signature !== "string" ||
              !/^[0-9a-f]{128}$/.test(raw.signature)
            ) {
              return false;
            }
            const publicKey = await buyerSigningPublicKey();
            return verifySignedArtifact(
              raw,
              ARTIFACT_SEPARATORS.AgreementDocument,
              publicKey,
              ed25519RawVerify,
            );
          },
          authenticateRecoveredSettlementEvidence: async (
            raw,
            buyerClaim,
          ) =>
            verifyBuyerComponentArtifact(
              raw,
              ARTIFACT_SEPARATORS.SettlementEvidence,
              buyerClaim,
            ),
          authenticateRecoveredArtifact: async (
            raw,
            separator,
            buyerClaim,
          ) => {
            if (!sameCanonicalClaimIdentity(buyerClaim, buyerId)) return false;
            if (separator === ARTIFACT_SEPARATORS.AgreementDocument) {
              if (
                Object.prototype.hasOwnProperty.call(raw, "signatures") ||
                typeof raw.signature !== "string" ||
                !/^[0-9a-f]{128}$/.test(raw.signature)
              ) {
                return false;
              }
              return verifySignedArtifact(
                raw,
                ARTIFACT_SEPARATORS.AgreementDocument,
                await buyerSigningPublicKey(),
                ed25519RawVerify,
              );
            }
            if (
              separator === ARTIFACT_SEPARATORS.SettlementEvidence ||
              separator === ARTIFACT_SEPARATORS.CompositeVerificationRecord
            ) {
              return verifyBuyerComponentArtifact(
                raw,
                separator as DomainSeparator,
                buyerClaim,
              );
            }
            if (separator === ARTIFACT_SEPARATORS.AttestationBundle) {
              if (
                !isLegacyMvpAttestationBundle(raw) ||
                raw.anchoredByRole !== "buyer" ||
                Object.prototype.hasOwnProperty.call(raw, "signature") ||
                raw.parties.length !== 1 ||
                raw.parties[0]?.role !== "buyer" ||
                !sameCanonicalClaimIdentity(
                  raw.parties[0]?.primaryClaim,
                  buyerClaim,
                )
              ) {
                return false;
              }
              const requiredRootKeys = new Set([
                "bundleVersion",
                "jobId",
                "outcome",
                "anchoredByRole",
                "listingRef",
                "agreementRef",
                "parties",
                "phaseSummary",
                "vetRecords",
                "settlementEvidence",
                "recipeRegistryVersion",
                "railRegistryVersion",
                "finalisedAt",
                "signatures",
              ]);
              if (
                Object.keys(raw).length !== requiredRootKeys.size ||
                Object.keys(raw).some((key) => !requiredRootKeys.has(key))
              ) {
                return false;
              }
              const signatures = Array.isArray(raw.signatures)
                ? raw.signatures
                : [];
              if (signatures.length !== 1) return false;
              const signature = signatures[0];
              if (
                signature === undefined ||
                !sameCanonicalClaimIdentity(signature.party, buyerClaim) ||
                signature.algorithm !== "ed25519" ||
                typeof signature.value !== "string" ||
                Object.keys(signature).length !== 3 ||
                !Object.prototype.hasOwnProperty.call(signature, "party") ||
                !Object.prototype.hasOwnProperty.call(signature, "algorithm") ||
                !Object.prototype.hasOwnProperty.call(signature, "value") ||
                !/^[A-Za-z0-9_-]{86}$/.test(signature.value)
              ) {
                return false;
              }
              const bytes = Uint8Array.from(
                Buffer.from(signature.value, "base64url"),
              );
              if (
                bytes.length !== 64 ||
                Buffer.from(bytes).toString("base64url") !== signature.value
              ) {
                return false;
              }
              return ed25519RawVerify(
                signedBytes(
                  ARTIFACT_SEPARATORS.AttestationBundle,
                  attestationBundleHash(
                    raw as unknown as AnyAttestationBundle,
                  ),
                ),
                bytes,
                await buyerSigningPublicKey(),
              );
            }
            return false;
          },
          settle,
          expectedSettlementPayee: options.expectedSettlementPayee,
          resumeSettlement,
          vet,
          newJobId: () => generateCanonicalJobId(),
          validateListing: listingValidator(
            sessionListingValidationDeps ?? configuredListingValidationDeps,
          ),
          verifyVetRecord,
          authenticateVetFinality,
          ...(expectedListingPin ? { expectedListingPin } : {}),
          now: () => new Date().toISOString(),
          nowMs: () => Date.now(),
          sessionStore,
        },
        options.jobId,
      );
    },

    async getReputation(
      primaryClaim: string,
      bundleRefs: string[],
    ): Promise<Reputation> {
      const identity = requireCanonicalClaimReference(
        primaryClaim,
        "Reputation primaryClaim",
      ).identity;
      const reputationKey = `${identity.scheme}:${identity.identifier}`;
      const bundles: AnyAttestationBundle[] = [];
      const invalid: ReputationExclusion[] = [];
      for (const ref of bundleRefs) {
        const verdict = await verifyBundleAtRef(ref);
        if (
          verdict.ok &&
          verdict.fullyVerified &&
          verdict.bundle &&
          isAnyAttestationBundle(verdict.bundle)
        ) {
          bundles.push(verdict.bundle);
        } else {
          invalid.push({
            code: "invalid-bundle",
            ...(verdict.bundle ? { jobId: verdict.bundle.jobId } : {}),
            ref,
            reason: verdict.reason ?? "bundle did not fully verify",
          });
        }
      }
      const reputation = computeReputation(reputationKey, bundles);
      return {
        ...reputation,
        exclusions: [...reputation.exclusions, ...invalid].sort((left, right) =>
          `${left.jobId ?? ""}:${left.ref ?? ""}:${left.code}`.localeCompare(
            `${right.jobId ?? ""}:${right.ref ?? ""}:${right.code}`,
          ),
        ),
      };
    },
  });
}

/**
 * Internal/manual construction seam matching {@link createUnsafeManualAgent}.
 * The direct adapter property exists only on this explicitly named result.
 */
export function buildUnsafeManualAgent<TAdapter extends SubstrateAdapter>(
  adapter: TAdapter,
  config: AgentConfig,
): UnsafeManualAgent<TAdapter> {
  const agent = buildAgent(adapter, config);
  return Object.freeze({ ...agent, adapter });
}
