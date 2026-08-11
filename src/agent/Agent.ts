import { randomUUID } from "node:crypto";

import type {
  AnyAttestationBundle,
  CompositeVerificationRecord,
  ListingDraft,
  ListingPin,
} from "../artifacts/types.js";
import {
  ed25519Verify,
  publicKeyFromRaw,
  type DomainSeparator,
} from "../crypto/index.js";
import { isAnyAttestationBundle } from "../artifacts/validators.js";
import {
  listingAddress,
  logicalToStorageProgramName,
} from "../canonical/index.js";
import { parseCciRecord, type CciRecord } from "../identity/index.js";
import type { SubstrateAdapter } from "../substrate/SubstrateAdapter.js";
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
import { publishListingCore } from "./publishListingCore.js";
import {
  discoverListings,
  verifyReadableListingArtifact,
  type DiscoveredListing,
} from "./discover.js";
import { computeReputation, type Reputation } from "./reputation.js";
import {
  buildSignedArtifact,
  verifySignedArtifact,
  type Signer,
  type Verifier,
} from "./signedArtifact.js";
import {
  verifyBundleCore,
  type SignatureCheck,
  type BundleVerification,
  type VerifyBundleDeps,
} from "./verifyBundleCore.js";

export type { SignatureCheck, BundleVerification, Reputation, CciRecord };

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

/** Verifier that lifts a raw 32-byte key into a KeyObject for ed25519Verify. */
const ed25519RawVerify: Verifier = (bytes, signature, publicKey) =>
  ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey));

export interface RunSessionOptions {
  /** The agreed fixed-price terms (rail must be offered by the listing). */
  terms: SessionTerms;
  /** Executes payment on the chosen rail (e.g. an x402 rail). */
  settle: (req: SettleRequest) => Promise<SettleResult>;
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
   * Resume an interrupted session: pass the prior run's jobId to re-drive it
   * idempotently (reuse anchored artifacts, never re-pay). Omit for a new session.
   */
  jobId?: string;
  /**
   * Low-level DACS-1 reader dependencies. The SDK always executes the
   * normative `validateListingArtifact` algorithm; callers cannot substitute a
   * fabricated `verified` result. Overrides the agent-wide dependencies.
   */
  listingValidationDeps?: ListingValidationDeps;
}

export interface AgentConfig {
  /** Demos node RPC URL. */
  demosRpc: string;
  /** Wallet secret — mnemonic or private key — used to sign artifacts/txs. */
  wallet: string;
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
}

export interface PublishResult {
  /** Native storage address the listing was anchored at. */
  ref: string;
  /** §6.3.4 colon-bearing LOGICAL address — the discovery key / metadata (#46). */
  logicalAddress: string;
  /** Colon-free NATIVE storage-program name the logical address encodes to (#46). */
  storageName: string;
  /** Exact DACS-1 §6.3.4 LR-1 tuple of the published Listing. */
  listingPin: ListingPin;
  txRef?: string;
}

/**
 * Public shape of the adapter returned by {@link createAgent}. `raw` remains an
 * intentionally untyped escape hatch so importing the pure package surface
 * does not make the optional demosdk peer a declaration-time dependency.
 */
export interface DemosBackedAdapter extends SubstrateAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly raw: any;
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
  /** Seller: sign + anchor a fixed-price listing. */
  publishListing(listing: ListingDraft): Promise<PublishResult>;
  /**
   * Anyone: verify an anchored bundle's signatures, referenced artifacts, and
   * strict DACS-2 vet closure. Bundles with vet records fail closed unless
   * `AgentConfig.verifyCompositeRecord` was configured.
   */
  verifyBundle(ref: string): Promise<BundleVerification>;
  /**
   * Buyer: resolve + structurally validate anchored listings at the given refs.
   * Refs are caller-supplied (shared out-of-band / via a directory) — a
   * marketplace crawl needs an indexer the deterministic substrate doesn't
   * provide. Non-listing / missing refs are skipped. (Seller-identity vetting
   * is the separate Vet stage.)
   */
  discover(listingRefs: string[]): Promise<DiscoveredListing[]>;
  /** Buyer: run a fixed-price session (negotiate → settle → verify). */
  runSession(listingRef: string, opts: RunSessionOptions): Promise<SessionResult>;
  /**
   * Anyone: derive reputation for a primary claim from its bundles. The bundle
   * refs are caller-supplied (enumerating a claim's bundles is an indexer
   * concern, not the substrate's); non-bundle refs and bundles that fail strict
   * verification (including unverified vet closure) are skipped.
   */
  getReputation(primaryClaim: string, bundleRefs: string[]): Promise<Reputation>;
}

/**
 * Create a connected agent. Connects the substrate adapter with the wallet and
 * wires artifact signing to it.
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
    secret: config.wallet,
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
  const sign: Signer = (bytes) => adapter.sign(bytes);
  const listingValidator = (deps: ListingValidationDeps | undefined) =>
    deps
      ? (raw: Record<string, unknown>) => validateListingArtifact(raw, deps)
      : undefined;
  // Capture policy at construction time. Callers cannot swap the verifier on
  // a live Agent between verifyBundle() and getReputation().
  const verifyCompositeRecord = config.verifyCompositeRecord;
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
    });

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

    async publishListing(listing: ListingDraft): Promise<PublishResult> {
      // Versioned, write-once publish (§6.3.4, #29/#46) — pure core over the
      // adapter's owner-bound immutable seam. Do not use anchorAddress() here:
      // on current Demos it predicts the NEXT nonce-derived create address and
      // cannot locate an existing version slot (#70).
      return publishListingCore(listing, {
        sign,
        scanOwnAnchorsByNamePrefix: (prefix) =>
          adapter.scanOwnAnchorsByNamePrefix(prefix),
        anchorWriteOnce: (name, value) => adapter.anchorWriteOnce(name, value),
        loadRailResolution: config.loadListingRailResolution,
        resolvePayloadVerificationCapability:
          config.resolvePayloadVerificationCapability,
      });
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
        validateListing: listingValidator(config.listingValidationDeps),
      });
    },

    async runSession(
      listingRef: string,
      opts: RunSessionOptions,
    ): Promise<SessionResult> {
      const buyerId = config.identity?.agentId;
      if (!buyerId) {
        throw new Error(
          "runSession requires createAgent({ identity: { agentId } })",
        );
      }
      return runSessionCore(
        listingRef,
        opts.terms,
        {
          buyerId,
          readListing: (ref) => adapter.readAnchor(ref),
          // Temporary reduced-MVP agreement writer. DACS-3 AgreementSignature[]
          // migration is owned by #98; it is deliberately not coerced into a
          // ComponentSignature envelope here.
          sign: (artifact, separator) =>
            buildSignedArtifact(artifact, separator as DomainSeparator, sign),
          signBytes: async (bytes) => sign(bytes),
          anchor: async (name, value) => (await adapter.anchor(name, value)).address,
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
            const verified = await verifyReadableListingArtifact(raw, {
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
          validateListing: listingValidator(
            opts.listingValidationDeps ?? config.listingValidationDeps,
          ),
          settle: opts.settle,
          vet: opts.vet,
          verifyVetRecord: opts.verifyVetRecord,
          authenticateVetFinality: opts.authenticateVetFinality,
          newJobId: () => randomUUID(),
          now: () => new Date().toISOString(),
          nowMs: () => Date.now(),
        },
        opts.jobId,
      );
    },

    async getReputation(
      primaryClaim: string,
      bundleRefs: string[],
    ): Promise<Reputation> {
      const bundles: AnyAttestationBundle[] = [];
      for (const ref of bundleRefs) {
        const verdict = await verifyBundleAtRef(ref);
        if (
          verdict.ok &&
          verdict.fullyVerified &&
          verdict.bundle &&
          isAnyAttestationBundle(verdict.bundle)
        ) {
          bundles.push(verdict.bundle);
        }
      }
      return computeReputation(primaryClaim, bundles);
    },
  };
}
