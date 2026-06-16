import { randomUUID } from "node:crypto";

import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import type { AttestationBundle, Listing } from "../artifacts/types.js";
import { isAttestationBundle } from "../artifacts/validators.js";
import type { DomainSeparator } from "../crypto/index.js";
import { NotImplementedError } from "../errors.js";
import { DemosAdapter } from "../substrate/index.js";
import {
  runSessionCore,
  type SessionResult,
  type SessionTerms,
  type SettleRequest,
  type SettleResult,
} from "./runSessionCore.js";
import { buildSignedArtifact, type Signer } from "./signedArtifact.js";

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

export interface BundleVerification {
  ok: boolean;
  reason?: string;
  bundle?: AttestationBundle;
  artifacts?: Array<{ ref: string; resolved: boolean }>;
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
      const bundle = await adapter.readAnchor(ref);
      if (!bundle || !isAttestationBundle(bundle)) {
        return { ok: false, reason: "not an attestation bundle" };
      }
      // Structural check: every referenced artifact resolves on-chain.
      // Per-artifact signature verification is gated on CCI public-key
      // resolution (resolveIdentity, a later task).
      const artifacts: Array<{ ref: string; resolved: boolean }> = [];
      for (const r of bundle.artifactRefs) {
        artifacts.push({ ref: r, resolved: (await adapter.readAnchor(r)) != null });
      }
      return { ok: artifacts.every((a) => a.resolved), bundle, artifacts };
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
