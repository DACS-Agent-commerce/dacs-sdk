import { randomUUID } from "node:crypto";

import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import type {
  AnyAttestationBundle,
  CompositeVerificationRecord,
  Listing,
} from "../artifacts/types.js";
import {
  isAnyAttestationBundle,
  isListing,
} from "../artifacts/validators.js";
import {
  contentHash,
  listingAddress,
  stripSignature,
} from "../canonical/index.js";
import {
  ed25519Verify,
  publicKeyFromRaw,
  type DomainSeparator,
} from "../crypto/index.js";
import {
  createBoundArtifactRepository,
  type BindingIndex,
  type BindingPublisher,
  type BoundArtifactWriteResult,
} from "../discovery/index.js";
import { DacsError } from "../errors.js";
import { parseCciRecord, type CciRecord } from "../identity/index.js";
import type { DemosAdapter } from "../substrate/index.js";
import {
  runSessionCore,
  sessionAnchorName,
  type SessionResult,
  type SessionTerms,
  type SettleRequest,
  type SettleResult,
} from "./runSessionCore.js";
import {
  publishListingCore,
  type PublishListingResult,
} from "./publishListingCore.js";
import { discoverListings } from "./discover.js";
import { computeReputation, type Reputation } from "./reputation.js";
import { buildSignedArtifact, verifySignedArtifact, type Signer, type Verifier } from "./signedArtifact.js";
import {
  verifyBundleCore,
  type SignatureCheck,
  type BundleVerification,
} from "./verifyBundleCore.js";
import {
  enumerateListingsForSeller,
  readListingByLogicalAddress,
  type AuthenticatedListing,
  type EnumerateListingsOptions,
  type ListingEnumerationResult,
  type ListingReadResult,
} from "./listingDiscovery.js";

export type { SignatureCheck, BundleVerification, Reputation, CciRecord };
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
   * Optional Vet step: verify the seller before paying (e.g. resolveRecipe +
   * vetCore). Returns a CompositeVerificationRecord; the session aborts before
   * settlement unless the decision is `pass`. Omit to skip vetting.
   */
  vet?: (subject: string) => Promise<CompositeVerificationRecord>;
  /**
   * Resume an interrupted session: pass the prior run's jobId to re-drive it
   * idempotently (reuse anchored artifacts, never re-pay). Omit for a new session.
   */
  jobId?: string;
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
  /** Optional identity metadata (e.g. the agent's DID / primary claim). */
  identity?: { agentId?: string };
  /**
   * Published logical→native binding authority used by listing writes and their
   * consumer-index readback. `publishListing` refuses to anchor unless this is
   * configured: a physical write without its independently readable binding
   * would leave an orphan that consumers cannot resolve safely. Agent-level
   * typed logical reads and owner-scoped enumeration require only `index`.
   */
  bindings?: AgentBindingConfig;
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
 * The DACS agent surface (T4). The small set of calls a dApp dev uses; the
 * adapter, artifact model, and signing are wired underneath.
 */
export interface Agent {
  /** Escape hatch to the underlying substrate adapter. */
  readonly adapter: DemosAdapter;
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
  /** Seller: sign, immutably anchor, and publish a fixed-price listing binding. */
  publishListing(listing: Listing): Promise<PublishResult>;
  /**
   * Buyer/Directory: resolve and authenticate one historical reduced-MVP
   * Listing by canonical logical address. `authenticated` proves binding, hash,
   * context, and Listing-domain authorship only; it is not an active/revocation
   * disposition.
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
  /** Anyone: dereference + structurally verify an anchored attestation bundle. */
  verifyBundle(ref: string): Promise<BundleVerification>;
  /**
   * Buyer: resolve + structurally validate anchored listings at the given refs.
   * Refs are caller-supplied (shared out-of-band / via a directory) — a
   * global marketplace crawl still needs a catalog; use `enumerateListings` for
   * one known seller's history. Non-listing / missing refs are skipped.
   * (Seller-identity vetting is the separate Vet stage.)
   */
  discover(listingRefs: string[]): Promise<Array<{ ref: string; listing: Listing }>>;
  /** Buyer: run a fixed-price session (negotiate → settle → verify). */
  runSession(
    listing: SessionListingInput,
    opts: RunSessionOptions,
  ): Promise<SessionResult>;
  /**
   * Anyone: derive reputation for a primary claim from its bundles. The bundle
   * refs are caller-supplied (enumerating a claim's bundles is an indexer
   * concern, not the substrate's); non-bundle refs are skipped.
   */
  getReputation(primaryClaim: string, bundleRefs: string[]): Promise<Reputation>;
}

/**
 * Create a connected agent. A wallet is connected and artifact signing is wired
 * only when `config.wallet` is present; read-only consumers can omit it.
 */
export async function createAgent(config: AgentConfig): Promise<Agent> {
  // Lazy-load the adapter so importing the package barrel doesn't eagerly pull
  // @kynesyslabs/demosdk, whose ESM packaging breaks plain-Node-ESM imports of
  // the pure/verify surface. demosdk loads only when an agent is actually built.
  const { DemosAdapter } = await import("../substrate/index.js");
  const adapter = new DemosAdapter({
    rpc: config.demosRpc,
    ...(config.wallet === undefined ? {} : { secret: config.wallet }),
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
export function buildAgent(adapter: DemosAdapter, config: AgentConfig): Agent {
  const sign: Signer = (bytes) => adapter.sign(bytes);
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

    async publishListing(listingInput: Listing): Promise<PublishResult> {
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
      const sellerKey = publishingKeyFromClaim(listing.agentId);
      const walletKey = normalizedDemosPublicKey(adapter.getAddress());
      if (
        sellerKey === null ||
        walletKey === null ||
        sellerKey !== walletKey
      ) {
        throw new DacsError(
          "listing agentId must be a canonical self-certifying Demos claim for the connected wallet",
        );
      }
      if (bindingIndex === null) {
        throw new DacsError("publishListing has no configured binding index");
      }
      const targetVersion = listing.listingVersion ?? 1;
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
            const priorVersion = anchor.value["listingVersion"] ?? 1;
            if (
              !Number.isSafeInteger(priorVersion) ||
              (priorVersion as number) >= targetVersion ||
              anchor.value["agentId"] !== listing.agentId ||
              anchor.value["serviceId"] !== listing.serviceId
            ) {
              continue;
            }

            const logicalAddress = listingAddress(
              listing.agentId,
              listing.serviceId,
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
          return publication.anchor;
        },
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
          createHistoryPageFetcher: (expectedOwner) =>
            adapter.createAnchorHistoryPageFetcher(expectedOwner),
        },
        options,
      );
    },

    async verifyBundle(ref: string): Promise<BundleVerification> {
      // Bundle signature verification (§7.7) PLUS dereferencing each referenced
      // artifact and hash-checking it. Session artifacts are resolved BY NAME
      // (kind, jobId → name → address): the physical address folds in the writer's
      // create-time nonce, so it can't be recomputed (#70).
      return verifyBundleCore(ref, {
        readArtifact: (r) => adapter.readAnchor(r),
        resolveRef: async (kind, jobId, parties) => {
          const name =
            kind === "dacs-3-agreement"
              ? sessionAnchorName.agreement(jobId)
              : kind === "dacs-4-evidence"
                ? sessionAnchorName.evidence(jobId)
                : kind === "dacs-2-verifyresult"
                  ? sessionAnchorName.vet(jobId)
                  : null;
          if (!name) return null;
          // Session artifacts are anchored by the session's BUYER (the orchestrator
          // in this SDK), so owner-bind resolution to the buyer party from the
          // bundle — NOT to this verifier's own address, which only works when the
          // verifier IS the buyer and breaks independent verification (#70). No
          // resolvable buyer party → fail closed (ref reports unresolved).
          const buyer = parties.find((p) => p.role === "buyer");
          const key = buyer ? publicKeyFromDid(buyer.primaryClaim) : null;
          if (!key) return null;
          const owner = Buffer.from(key).toString("hex");
          const r = await adapter.resolveAnchorByName(name, owner);
          return r.status === "present" ? adapter.readAnchor(r.address) : null;
        },
        resolvePublicKey: async (did) => publicKeyFromDid(did),
        verify: ed25519RawVerify,
      });
    },

    async discover(
      listingRefs: string[],
    ): Promise<Array<{ ref: string; listing: Listing }>> {
      // Verify every discovered listing against the key in its own agentId (#41)
      // — an unverified listing must never reach negotiation or settlement.
      return discoverListings(listingRefs, (r) => adapter.readAnchor(r), {
        verify: ed25519RawVerify,
        resolvePublicKey: (claim) => publicKeyFromDid(claim),
      });
    },

    async runSession(
      listingInput: SessionListingInput,
      opts: RunSessionOptions,
    ): Promise<SessionResult> {
      if (!hasWallet) {
        throw new Error("runSession requires createAgent({ wallet })");
      }
      const buyerId = config.identity?.agentId;
      if (!buyerId) {
        throw new Error(
          "runSession requires createAgent({ identity: { agentId } })",
        );
      }
      let listingRef: string;
      let expectedContentHash: string | null = null;
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
          !("listing" in selectedValue) ||
          !isListing(selectedValue.listing)
        ) {
          throw new DacsError(
            "runSession requires an internally consistent authenticated Listing selection",
          );
        }
        const selected = selectedValue as AuthenticatedListing;
        const selectedVersion = selected.listing.listingVersion ?? 1;
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
          selected.status !== "authenticated" ||
          selected.compatibility !== "legacy-mvp" ||
          typeof selected.ref !== "string" ||
          selected.ref.trim().length === 0 ||
          typeof selected.contentHash !== "string" ||
          !/^[0-9a-f]{64}$/.test(selected.contentHash) ||
          selectedHash !== selected.contentHash ||
          Object.prototype.hasOwnProperty.call(selected.listing, "signature") ||
          Object.prototype.hasOwnProperty.call(selected.listing, "signatures") ||
          !Number.isSafeInteger(selected.version) ||
          selected.version !== selectedVersion ||
          listingAddress(
            selected.listing.agentId,
            selected.listing.serviceId,
            selectedVersion,
          ) !== selected.logicalAddress
        ) {
          throw new DacsError(
            "runSession requires an internally consistent authenticated Listing selection",
          );
        }
        listingRef = selected.ref;
        expectedContentHash = selected.contentHash;
      }
      return runSessionCore(
        listingRef,
        opts.terms,
        {
          buyerId,
          readListing: (ref) => adapter.readAnchor(ref),
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
            const key = publicKeyFromDid(sellerClaim);
            if (!key) return false;
            if (
              expectedContentHash !== null &&
              contentHash(raw) !== expectedContentHash
            ) {
              return false;
            }
            return verifySignedArtifact(
              raw,
              ARTIFACT_SEPARATORS.Listing,
              key,
              ed25519RawVerify,
            );
          },
          settle: opts.settle,
          vet: opts.vet,
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
        const raw = await adapter.readAnchor(ref);
        if (raw && isAnyAttestationBundle(stripSignature(raw))) {
          bundles.push(stripSignature(raw) as unknown as AnyAttestationBundle);
        }
      }
      return computeReputation(primaryClaim, bundles);
    },
  };
}
