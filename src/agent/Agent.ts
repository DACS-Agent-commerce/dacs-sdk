import { randomUUID } from "node:crypto";

import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import type { Listing } from "../artifacts/types.js";
import {
  ed25519Verify,
  publicKeyFromRaw,
  type DomainSeparator,
} from "../crypto/index.js";
import { NotImplementedError } from "../errors.js";
import { DemosAdapter } from "../substrate/index.js";
import {
  runSessionCore,
  type SessionResult,
  type SessionTerms,
  type SettleRequest,
  type SettleResult,
} from "./runSessionCore.js";
import { buildSignedArtifact, type Signer, type Verifier } from "./signedArtifact.js";
import {
  verifyBundleCore,
  type ArtifactVerification,
  type BundleVerification,
} from "./verifyBundleCore.js";

export type { ArtifactVerification, BundleVerification };

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
  /** Storage address the listing was anchored at. */
  ref: string;
  txRef?: string;
}

export interface Reputation {
  primaryClaim: string;
  totalAgreements: number;
  completed: number;
  avgRating: number | null;
}

/**
 * The DACS agent surface (T4). The small set of calls a dApp dev uses; the
 * adapter, artifact model, and signing are wired underneath.
 */
export interface Agent {
  /** Escape hatch to the underlying substrate adapter. */
  readonly adapter: DemosAdapter;
  /** Seller: sign + anchor a fixed-price listing. */
  publishListing(listing: Listing): Promise<PublishResult>;
  /** Anyone: dereference + structurally verify an anchored attestation bundle. */
  verifyBundle(ref: string): Promise<BundleVerification>;
  /** Buyer: find anchored listings. */
  discover(): Promise<Array<{ ref: string; listing: Listing }>>;
  /** Buyer: run a fixed-price session (negotiate → settle → verify). */
  runSession(listingRef: string, opts: RunSessionOptions): Promise<SessionResult>;
  /** Anyone: derive reputation for a primary claim from its bundles. */
  getReputation(primaryClaim: string): Promise<Reputation>;
}

/**
 * Create a connected agent. Connects the substrate adapter with the wallet and
 * wires artifact signing to it.
 */
export async function createAgent(config: AgentConfig): Promise<Agent> {
  const adapter = new DemosAdapter({
    rpc: config.demosRpc,
    secret: config.wallet,
  });
  await adapter.connect();

  const sign: Signer = (bytes) => adapter.sign(bytes);

  return {
    adapter,

    async publishListing(listing: Listing): Promise<PublishResult> {
      const signed = await buildSignedArtifact(
        listing,
        ARTIFACT_SEPARATORS.Listing,
        sign,
      );
      const name = `dacs1:listing:${listing.agentId}:${listing.serviceId}`;
      const { address, txRef } = await adapter.anchor(name, signed);
      return { ref: address, txRef };
    },

    async verifyBundle(ref: string): Promise<BundleVerification> {
      // Structural check (every referenced artifact resolves) plus per-artifact
      // §7.7 signature verification against each signer's resolved public key.
      return verifyBundleCore(ref, {
        readArtifact: (r) => adapter.readAnchor(r),
        resolvePublicKey: async (did) => publicKeyFromDid(did),
        verify: ed25519RawVerify,
      });
    },

    async discover() {
      throw new NotImplementedError(
        "Agent.discover",
        "T6 — marketplace discovery",
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
      return runSessionCore(listingRef, opts.terms, {
        buyerId,
        readListing: (ref) => adapter.readAnchor(ref),
        sign: (artifact, separator) =>
          buildSignedArtifact(artifact, separator as DomainSeparator, sign),
        anchor: async (name, value) => (await adapter.anchor(name, value)).address,
        settle: opts.settle,
        newJobId: () => randomUUID(),
        now: () => new Date().toISOString(),
      });
    },

    async getReputation(_primaryClaim: string) {
      throw new NotImplementedError(
        "Agent.getReputation",
        "T6 — reputation derived from bundles",
      );
    },
  };
}
