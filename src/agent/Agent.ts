import { randomUUID } from "node:crypto";
import { types as nodeTypes } from "node:util";

import type {
  AnyAttestationBundle,
  CompositeVerificationRecord,
  ListingDraft,
  ListingPin,
} from "../artifacts/types.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import { verifyComponentSignature } from "../artifacts/signatures.js";
import {
  ed25519Verify,
  publicKeyFromRaw,
  signedBytes,
  type DomainSeparator,
} from "../crypto/index.js";
import { isAnyAttestationBundle } from "../artifacts/validators.js";
import { isLegacyMvpAttestationBundle } from "../artifacts/legacyMvp.js";
import { DacsError } from "../errors.js";
import {
  listingAddress,
  logicalToStorageProgramName,
} from "../canonical/index.js";
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
import { publishListingCore } from "./publishListingCore.js";
import {
  authenticateReadableListingArtifact,
  discoverListings,
  type DiscoveredListing,
} from "./discover.js";
import { snapshotCanonicalJson } from "../canonical/snapshot.js";
import { computeReputation, type Reputation } from "./reputation.js";
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
  verifyBundleCore,
  type SignatureCheck,
  type BundleVerification,
} from "./verifyBundleCore.js";

export type { SignatureCheck, BundleVerification, Reputation, CciRecord };

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
   * vetCore). Returns a CompositeVerificationRecord; the session aborts before
   * settlement unless the decision is `pass`. Omit to skip vetting.
   */
  vet?: (subject: string) => Promise<CompositeVerificationRecord>;
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
}

export interface AgentConfig {
  /** Demos node RPC URL. */
  demosRpc: string;
  /** Wallet secret — mnemonic or private key — used to sign artifacts/txs. */
  wallet: string;
  /** Optional identity metadata (e.g. the agent's DID / primary claim). */
  identity?: { agentId?: string };
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
  /** Seller: sign + anchor a fixed-price listing. */
  publishListing(listing: ListingDraft): Promise<PublishResult>;
  /** Anyone: dereference + structurally verify an anchored attestation bundle. */
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
   * concern, not the substrate's); non-bundle refs are skipped.
   */
  getReputation(primaryClaim: string, bundleRefs: string[]): Promise<Reputation>;
}

/**
 * Create a connected agent. Connects the substrate adapter with the wallet and
 * wires artifact signing to it.
 */
export async function createAgent(config: AgentConfig): Promise<Agent> {
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
export function buildAgent(adapter: DemosAdapter, config: AgentConfig): Agent {
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
      });
    },

    async runSession(
      listingRef: string,
      opts: RunSessionOptions,
    ): Promise<SessionResult> {
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
      const resumeSettlement = stableAgentMethod<
        RunSessionOptions["resumeSettlement"]
      >(
        opts,
        "resumeSettlement",
        "Agent.runSession resumeSettlement",
        true,
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
          newJobId: () => randomUUID(),
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
