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
  signedBytes,
  type DomainSeparator,
} from "../crypto/index.js";
import { contentHash } from "../canonical/index.js";
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
  discoverValidatedListings,
  type ValidatedDiscoveredListing,
} from "./discover.js";
import {
  resolveListingRails,
  validateListingArtifact,
  type ArtifactSignatureCheck,
  type ArtifactSignatureCheckInput,
  type ListingRailResolutionDeps,
  type ListingValidationDeps,
} from "./listingValidation.js";
import { computeReputation, type Reputation } from "./reputation.js";
import { buildSignedArtifact, type Signer, type Verifier } from "./signedArtifact.js";
import {
  verifyBundleCore,
  type SignatureCheck,
  type BundleVerification,
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

export interface AgentConfig {
  /** Demos node RPC URL. */
  demosRpc: string;
  /** Wallet secret — mnemonic or private key — used to sign artifacts/txs. */
  wallet: string;
  /** Optional identity metadata (e.g. the agent's DID / primary claim). */
  identity?: { agentId?: string };
  /**
   * DACS-1 authority policy used for normative Listing publication, discovery,
   * revocation, identity-control, and rail resolution. The Agent refuses the
   * relevant operation when this policy is absent; it never upgrades a partial
   * check into `verified`.
   */
  listingValidation?: AgentListingValidationPolicy;
  /** LP-6-only policy for sellers that publish but do not read Listings. */
  listingRailResolution?: ListingRailResolutionDeps;
}

export type AgentListingValidationPolicy = Omit<
  ListingValidationDeps,
  "nowMs" | "verifyArtifactSignature"
> &
  Partial<
    Pick<ListingValidationDeps, "nowMs" | "verifyArtifactSignature">
  >;

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
   * Buyer: resolve + run the complete DACS-1 reader pipeline at the given refs.
   * Refs are caller-supplied (shared out-of-band / via a directory) — a
   * marketplace crawl needs an indexer the deterministic substrate doesn't
   * provide. Only normative Listings with disposition `verified` are returned;
   * missing, legacy, rejected, revoked, and indeterminate entries are skipped.
   * Use the pure `inspectListings` API when diagnostics for every disposition
   * are required. (Counterparty vetting remains the separate Vet stage.)
   */
  discover(listingRefs: string[]): Promise<ValidatedDiscoveredListing[]>;
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
  const sign: Signer = (bytes) => adapter.sign(bytes);
  const verifyBundleAtRef = (ref: string): Promise<BundleVerification> =>
    verifyBundleCore(ref, {
      readArtifact: (artifactRef) => adapter.readAnchor(artifactRef),
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

  const defaultArtifactSignatureCheck = async (
    input: ArtifactSignatureCheckInput,
  ): Promise<ArtifactSignatureCheck> => {
    if (input.signature.algorithm !== "ed25519") {
      return {
        status: "indeterminate",
        reason: `no ${input.signature.algorithm} verifier is configured`,
      };
    }
    const key = publicKeyFromDid(input.signature.signer);
    if (!key) {
      return {
        status: "indeterminate",
        reason: `signer key cannot be resolved for ${input.signature.signer}`,
      };
    }
    let signature: Uint8Array;
    try {
      signature = Uint8Array.from(
        Buffer.from(input.signature.value, "base64url"),
      );
    } catch {
      return { status: "invalid", reason: "signature value is not Base64URL" };
    }
    if (
      signature.length !== 64 ||
      Buffer.from(signature).toString("base64url") !== input.signature.value
    ) {
      return {
        status: "invalid",
        reason: "Ed25519 signature is not canonical unpadded Base64URL for 64 bytes",
      };
    }
    const bytes = signedBytes(
      input.separator,
      contentHash(input.artifact as Record<string, unknown>),
    );
    return ed25519RawVerify(bytes, signature, key)
      ? { status: "valid" }
      : { status: "invalid", reason: "cryptographic verification failed" };
  };

  const listingValidationDeps = (): ListingValidationDeps => {
    const policy = config.listingValidation;
    if (!policy) {
      throw new Error(
        "this Listing operation requires AgentConfig.listingValidation with identity, revocation, and PA-1/2/3 rail authority dependencies",
      );
    }
    return {
      ...policy,
      nowMs: policy.nowMs ?? (() => Date.now()),
      verifyArtifactSignature:
        policy.verifyArtifactSignature ?? defaultArtifactSignatureCheck,
    };
  };

  const listingRailResolutionDeps = (): ListingRailResolutionDeps => {
    const policy = config.listingRailResolution ?? config.listingValidation;
    if (!policy) {
      throw new Error(
        "pay-bearing Listing publication requires AgentConfig.listingRailResolution (or the superset listingValidation)",
      );
    }
    return {
      ...policy,
      verifyArtifactSignature:
        policy.verifyArtifactSignature ?? defaultArtifactSignatureCheck,
    };
  };

  const validateListing = (
    raw: Readonly<Record<string, unknown>>,
  ) => validateListingArtifact(raw, listingValidationDeps());

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
        validateRailsForPublication: (draft) =>
          resolveListingRails(draft, listingRailResolutionDeps()),
        scanOwnAnchorsByNamePrefix: (prefix) =>
          adapter.scanOwnAnchorsByNamePrefix(prefix),
        anchorWriteOnce: (name, value) => adapter.anchorWriteOnce(name, value),
      });
    },

    async verifyBundle(ref: string): Promise<BundleVerification> {
      // Bundle signature verification (§7.7) PLUS dereferencing each referenced
      // artifact and hash-checking it. Session artifacts are resolved BY NAME
      // (kind, jobId → name → address): the physical address folds in the writer's
      // create-time nonce, so it can't be recomputed (#70).
      return verifyBundleAtRef(ref);
    },

    async discover(
      listingRefs: string[],
    ): Promise<ValidatedDiscoveredListing[]> {
      return discoverValidatedListings(
        listingRefs,
        (r) => adapter.readAnchor(r),
        validateListing,
      );
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
          // LR-3: exact `verified` only. Rejected, revoked, indeterminate, and
          // historical compatibility reads all stop before vetting/payment.
          validateListing,
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
        const verdict = await verifyBundleAtRef(ref);
        if (verdict.ok && verdict.fullyVerified && verdict.bundle) {
          bundles.push(verdict.bundle);
        }
      }
      return computeReputation(primaryClaim, bundles);
    },
  };
}
