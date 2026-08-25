import { types as nodeTypes } from "node:util";
import type {
  AgreementArtifact,
  AnyAttestationBundle,
  AnchorReceipt as ProtocolAnchorReceipt,
  AttestationRef,
  CompositeVerificationRecord,
  ListingDraft,
  ListingPin,
} from "../artifacts/types.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import { verifyComponentSignature } from "../artifacts/signatures.js";
import {
  isAnyAttestationBundle,
  isAgreementArtifact,
  isAttestationRef,
  isLegacyMvpListing,
  isListing,
  readListingArtifact,
} from "../artifacts/validators.js";
import {
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
import { parseCciRecord, type CciRecord } from "../identity/index.js";
import { generateCanonicalJobId } from "../negotiate/jobId.js";
import type {
  DemosWriteEvidence,
  SubstrateAdapter,
} from "../substrate/SubstrateAdapter.js";
import {
  runSessionCore,
  sessionAnchorName,
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
  return Function.prototype.bind.call(candidate, source) as T;
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

/**
 * Resolve a signer DID/claim to its raw ed25519 public key. In the Demos
 * model a CCI *is* the ed25519 public-key hex, so a DID embedding that hex
 * (`did:…:<64-hex>`, `0x<64-hex>`, or a bare `<64-hex>`) resolves directly.
 * Aliases that don't embed the key return null (the artifact stays
 * `unverified` rather than falsely `valid`); alias→CCI lookup is a follow-up.
 */
function publicKeyFromDid(did: string): Uint8Array | null {
  const hex = did.match(/(?:^|:)(?:0x)?([0-9a-fA-F]{64})$/)?.[1];
  return hex ? Uint8Array.from(Buffer.from(hex, "hex")) : null;
}

function normalizedDemosPublicKey(value: string): string | null {
  const match = value.trim().match(/^(?:0x)?([0-9a-fA-F]{64})$/);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Current MVP self-certifying publisher claims. The reduced Listing shape does
 * not yet carry the normative seller.identity authorization chain, so the write
 * path accepts only claims whose key ownership can be established locally.
 */
function publishingKeyFromClaim(claim: string): string | null {
  const match = claim.match(/^did:demos:agent:([0-9a-f]{64})$/);
  return match?.[1] ?? null;
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
  /** Optional identity metadata (e.g. the agent's DID / primary claim). */
  identity?: { agentId?: string };
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
   * Published logical→native binding authority used by listing writes and their
   * consumer-index readback. `publishListing` refuses to anchor unless this is
   * configured: a physical write without its independently readable binding
   * would leave an orphan that consumers cannot resolve safely. Agent-level
   * typed logical reads and owner-scoped enumeration require only `index`.
   */
  bindings?: AgentBindingConfig;
}

export interface AgentSettlementEvidenceContextInput {
  evidence: Readonly<Record<string, unknown>>;
  bundle: Readonly<AnyAttestationBundle>;
  evidenceRef: Readonly<AttestationRef>;
  agreement: Readonly<AgreementArtifact>;
}

export type AgentSettlementEvidenceContext = Omit<
  EvidenceContext,
  "agreement" | "attestationRef"
> & {
  orchestrator: string;
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
 * Public shape of the adapter returned by {@link createAgent}. `raw` remains an
 * intentionally untyped escape hatch so importing the pure package surface
 * does not make the optional demosdk peer a declaration-time dependency.
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
export interface Agent<
  TAdapter extends SubstrateAdapter = DemosBackedAdapter,
> {
  /** Escape hatch to the underlying substrate adapter. */
  readonly adapter: TAdapter;
  /**
   * Anyone: resolve a subject's full cross-context identity (DACS-1) — its
   * primary claim plus the linked Web2 handles and cross-chain wallets bound to
   * it in the GCR, not just the wallet key. Accepts a DID / `0x…` / bare-hex
   * primary key; other claim refs are passed through (reverse resolution is a
   * substrate follow-up).
   */
  resolveIdentity(subject: string): Promise<CciRecord>;
  /**
   * Anyone: reverse-resolve a linked claim to the subject(s) that hold it —
   * `findByClaim("web2:twitter:alice")` or `findByClaim("xm:evm:0x…")` returns
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
  /** Buyer: run a fixed-price session (negotiate → settle → verify). */
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
 * Create a connected agent. A wallet is connected and artifact signing is wired
 * only when `config.wallet` is present; read-only consumers can omit it.
 */
export async function createAgent(
  config: AgentConfig,
): Promise<Agent<DemosBackedAdapter>> {
  // Lazy-load the adapter so importing the package barrel doesn't eagerly pull
  // @kynesyslabs/demosdk, whose ESM packaging breaks plain-Node-ESM imports of
  // the pure/verify surface. demosdk loads only when an agent is actually built.
  const { DemosAdapter } = await import("../substrate/index.js").catch(() => {
    throw new Error(
      "createAgent requires the optional peer @kynesyslabs/demosdk; install it to use the Demos adapter",
    );
  });
  const adapter = new DemosAdapter({
    rpc: config.demosRpc,
    ...(config.wallet === undefined ? {} : { secret: config.wallet }),
    ...(config.demosWriteJournal === undefined
      ? {}
      : { writeJournal: config.demosWriteJournal }),
  });
  await adapter.connect();
  return buildAgent(adapter, config);
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
): Agent<TAdapter> {
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
  const sign: Signer = (bytes) => adapter.sign(bytes);
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
  const verifyBundleAtRef = (ref: string): Promise<BundleVerification> =>
    verifyBundleCore(ref, {
      readArtifact: (artifactRef) => adapter.readAnchor(artifactRef),
      // DACS-2 §7.5.2: normative refs carry their own anchor coordinates.
      // This adapter owns storage-program reads; other registered anchor kinds
      // need a transport-specific resolver supplied to verifyBundleCore.
      resolveAttestationRef: async (artifactRef) =>
        artifactRef.anchor.kind === "storage-program"
          ? adapter.readAnchor(artifactRef.anchor.locator)
          : null,
      resolveListingRef: async (listingRef, parties) => {
        const seller = parties.find((party) => party.role === "seller");
        const key = seller ? publicKeyFromDid(seller.primaryClaim) : null;
        if (!seller || !key) return null;
        const logical = listingAddress(
          seller.primaryClaim,
          listingRef.listingId,
          listingRef.version,
        );
        const resolved = await adapter.resolveAnchorByName(
          logicalToStorageProgramName(logical),
          Buffer.from(key).toString("hex"),
        );
        return resolved.status === "present"
          ? adapter.readAnchor(resolved.address)
          : null;
      },
      // Explicit pre-#308 compatibility for legacy SDK bundles whose refs were
      // keyed only by an SDK artifact kind and the enclosing job id.
      resolveRef: async (kind, jobId, parties, legacyRef) => {
        if (kind === "dacs-2-composite" && legacyRef) {
          return adapter.readAnchor(legacyRef.id);
        }
        const name =
          kind === "dacs-3-agreement"
            ? sessionAnchorName.agreement(jobId)
            : kind === "dacs-4-evidence"
              ? sessionAnchorName.evidence(jobId)
              : kind === "dacs-2-verifyresult"
                ? sessionAnchorName.vet(jobId)
                : null;
        if (!name) return null;
        const buyer = parties.find((party) => party.role === "buyer");
        const key = buyer ? publicKeyFromDid(buyer.primaryClaim) : null;
        if (!key) return null;
        const owner = Buffer.from(key).toString("hex");
        const resolved = await adapter.resolveAnchorByName(name, owner);
        return resolved.status === "present"
          ? adapter.readAnchor(resolved.address)
          : null;
      },
      resolvePublicKey: async (did) => publicKeyFromDid(did),
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
        const verification = await verifySettlementEvidence(
          evidence,
          {
            ...resolvedContext,
            agreement: {
              amount: agreement.terms.price.amount,
              currency: agreement.terms.price.currency,
            },
            attestationRef: context.evidenceRef,
          },
          {
            resolvePublicKey: async (signer) => publicKeyFromDid(signer),
            verify: ed25519RawVerify,
          },
        );
        return {
          ...verification,
          authorizedSigner: resolvedContext.orchestrator,
        };
      },
    });
  const hasWallet =
    typeof config.wallet === "string" && config.wallet.length > 0;
  const bindingsValue: unknown = config.bindings;
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
  const artifactRepository =
    config.bindings?.publisher === undefined
      ? null
      : createBoundArtifactRepository({
          adapter,
          index: config.bindings.index,
          publisher: config.bindings.publisher,
        });
  const bindingIndex = config.bindings?.index ?? null;
  const historyPageFetcherFactory = (
    adapter as SubstrateAdapter & {
      createAnchorHistoryPageFetcher?: (
        expectedOwner: string,
      ) => AnchorHistoryPageFetcher;
    }
  ).createAnchorHistoryPageFetcher;

  return {
    adapter,

    async resolveIdentity(subject: string): Promise<CciRecord> {
      // The GCR routine resolves by Demos address (the ed25519 pubkey hex).
      // Accept a DID / 0x-prefixed / bare-hex primary key; anything else is
      // handed through as-is. The parsed record keeps `subject` as its primary
      // claim (the canonical form the caller passed).
      const key = publicKeyFromDid(subject);
      const address = key ? Buffer.from(key).toString("hex") : subject;
      const resolved = await adapter.resolveIdentity(address);
      return parseCciRecord(subject, resolved.raw);
    },

    async findByClaim(claimRef: string): Promise<string[]> {
      return adapter.findSubjectsByClaim(claimRef);
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
      const sellerKey = publishingKeyFromClaim(
        listing.seller.identity.presentedBy,
      );
      const walletKey = normalizedDemosPublicKey(adapter.getAddress());
      if (
        sellerKey === null ||
        walletKey === null ||
        sellerKey !== walletKey
      ) {
        throw new DacsError(
          "listing seller identity must be a canonical self-certifying Demos claim for the connected wallet",
        );
      }
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
          const scan = await adapter.scanOwnAnchorsByNamePrefix(prefix);
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
                adapter.getAddress(),
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
        readAnchor: (nativeAddress) => adapter.readAnchor(nativeAddress),
        verify: ed25519RawVerify,
        ...(config.listingValidationDeps
          ? { listingValidationDeps: config.listingValidationDeps }
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
          readAnchor: (nativeAddress) => adapter.readAnchor(nativeAddress),
          verify: ed25519RawVerify,
          ...(config.listingValidationDeps
            ? { listingValidationDeps: config.listingValidationDeps }
            : {}),
          ...(typeof historyPageFetcherFactory === "function"
            ? {
                createHistoryPageFetcher: (expectedOwner: string) =>
                  historyPageFetcherFactory.call(adapter, expectedOwner),
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
      return discoverListings(listingRefs, (r) => adapter.readAnchor(r), {
        verify: ed25519RawVerify,
        resolvePublicKey: (claim) => publicKeyFromDid(claim),
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
      if (
        buyerId.normalize("NFC") !== buyerId ||
        buyerId.trim() !== buyerId ||
        /[\u0000-\u001f\u007f]/.test(buyerId)
      ) {
        throw new DacsError(
          "runSession buyer identity must be an exact NFC protocol identifier",
        );
      }
      // Recovery needs the connected wallet's actual signing key, while a fresh
      // run does not. Resolve and cache it lazily so this hardening introduces
      // no additional await (and no new pre-snapshot TOCTOU window) on fresh
      // sessions.
      let buyerSigningPublicKeyPromise: Promise<Uint8Array> | undefined;
      const buyerSigningPublicKey = (): Promise<Uint8Array> => {
        buyerSigningPublicKeyPromise ??= adapter.getPublicKey().then((resolved) => {
          if (!(resolved instanceof Uint8Array) || resolved.length !== 32) {
            throw new DacsError(
              "runSession recovery requires the adapter's exact 32-byte signing public key",
            );
          }
          const key = Uint8Array.from(resolved);
          const addressKey = publicKeyFromDid(adapter.getAddress());
          const claimKey = publicKeyFromDid(buyerId);
          if (
            (addressKey && !Buffer.from(addressKey).equals(Buffer.from(key))) ||
            (claimKey && !Buffer.from(claimKey).equals(Buffer.from(key)))
          ) {
            throw new DacsError(
              "runSession recovery buyer identity does not match the connected signing key",
            );
          }
          return key;
        });
        return buyerSigningPublicKeyPromise;
      };
      const verifyBuyerComponentArtifact = async (
        raw: Record<string, unknown>,
        separator: DomainSeparator,
        buyerClaim: string,
      ): Promise<boolean> => {
        if (buyerClaim !== buyerId) return false;
        const publicKey = await buyerSigningPublicKey();
        const verdict = await verifyComponentSignature(raw, separator, {
          isSignerAuthorized: (_artifact, signature) =>
            signature.algorithm === "ed25519" &&
            signature.signer === buyerClaim,
          resolvePublicKey: (signature) =>
            signature.signer === buyerClaim ? publicKey : null,
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
          readListing: (ref) => adapter.readAnchor(ref),
          // Temporary reduced-MVP agreement writer. DACS-3 AgreementSignature[]
          // migration is owned by #98; it is deliberately not coerced into a
          // ComponentSignature envelope here.
          sign: (artifact, separator) =>
            buildSignedArtifact(artifact, separator as DomainSeparator, sign),
          signBytes: async (bytes) => sign(bytes),
          // Do not move to payment or the next artifact after mere node
          // acceptance. The current phase must be canonical and readable.
          anchor: async (name, value) =>
            (
              await adapter.anchorAndWait(name, value, {
                completion: "read-visible",
              })
            ).address,
          // Resume resolves BY NAME (owner = this agent), failing closed on an
          // indeterminate lookup rather than re-anchoring/re-settling (#70).
          resolveAnchor: async (name) => {
            const r = await adapter.resolveAnchorByName(name, adapter.getAddress());
            if (r.status === "indeterminate") return { status: "indeterminate", reason: r.reason };
            if (r.status === "absent") return { status: "absent" };
            const value = await adapter.readAnchor(r.address);
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
              resolvePublicKey: (claim) => publicKeyFromDid(claim),
            });
            if (!verified) return false;
            const advertisedSeller =
              verified.compatibility === "normative"
                ? verified.listing.seller.identity.presentedBy
                : verified.listing.agentId;
            return advertisedSeller === sellerClaim;
          },
          authenticateRecoveredAgreement: async (raw, buyerClaim) => {
            if (
              buyerClaim !== buyerId ||
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
            if (buyerClaim !== buyerId) return false;
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
                raw.parties[0]?.primaryClaim !== buyerClaim
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
                signature?.party !== buyerClaim ||
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
      const reputation = computeReputation(primaryClaim, bundles);
      return {
        ...reputation,
        exclusions: [...reputation.exclusions, ...invalid].sort((left, right) =>
          `${left.jobId ?? ""}:${left.ref ?? ""}:${left.code}`.localeCompare(
            `${right.jobId ?? ""}:${right.ref ?? ""}:${right.code}`,
          ),
        ),
      };
    },
  };
}
