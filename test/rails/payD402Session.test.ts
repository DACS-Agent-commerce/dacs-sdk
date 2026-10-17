import { describe, expect, test, vi } from "vitest";

import { buildSignedArtifact, type Signer } from "../../src/agent/signedArtifact.js";
import { runSessionCore, type SessionDeps, type SettleResult } from "../../src/agent/runSessionCore.js";
import { createInMemorySessionStore } from "../../src/agent/sessionStore.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import type { IdentityBundle } from "../../src/artifacts/types.js";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "../../src/crypto/index.js";
import { createIdempotencyStore } from "../../src/rails/idempotency.js";
import { payD402ResumeSettlement, payD402Settle, type PayD402Rail } from "../../src/rails/payD402.js";

// The documented wiring: `settle = payD402Settle`, `resumeSettlement = payD402ResumeSettlement`.

const seed = Uint8Array.from(Buffer.alloc(32, 7));
const priv = privateKeyFromSeed(seed);
const sign: Signer = (b) => ed25519Sign(b, priv);
const sellerDid = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const buyerDid = "did:demos:buyer";
const buyerIdentity: IdentityBundle = {
  bundleVersion: "1",
  presentedBy: buyerDid,
  presentedAt: 1_780_000_000_000,
  claims: [{ ref: buyerDid }],
  presentation: { kind: "per-claim", signatures: [{ ref: buyerDid, signature: "test-presentation" }] },
};

const RECIPIENT = "demos1recipientaddress0000000000000000000000";
const PAYER = "demos1payeraddress00000000000000000000000000";
const paywall = { url: "https://seller.example/premium", recipient: RECIPIENT, network: "demos:testnet" };
const listing = {
  agentId: sellerDid,
  serviceId: "svc",
  name: "n",
  description: "d",
  claimRequirements: [],
  supportedNegotiation: ["negotiate-fixed-price"],
  supportedPaymentRails: ["pay-d402"],
  supportedDelivery: ["deliver-attested-payload"],
};
const terms = {
  price: { amount: "1.5", asset: "DEM", decimals: 9, rail: "pay-d402" },
  deliveryPhase: "deliver-attested-payload",
  deliveryFormat: "application/json",
};

/** A D402 rail whose settle reports `pending` and whose read-backs follow `reads`. */
function d402Rail(reads: Array<Partial<SettleResult>> = []) {
  const paid: Array<Record<string, unknown>> = [];
  const waited: string[] = [];
  const rail: PayD402Rail = {
    address: PAYER,
    settle: async (p) => {
      paid.push({ ...p });
      return { ok: false, txHash: "0xpend", chainId: p.network, payer: PAYER, payee: p.recipient };
    },
    waitForSettlement: async (p) => {
      waited.push(p.txHash);
      return { ok: false, txHash: p.txHash, chainId: p.network, payer: PAYER, payee: p.recipient, ...reads.shift() };
    },
  };
  return { rail, paid, waited };
}

async function sessionDeps(
  kv: Map<string, Record<string, unknown>>,
  sessionStore: SessionDeps["sessionStore"],
  rail: PayD402Rail,
): Promise<SessionDeps> {
  if (!kv.has("stor:listing")) {
    kv.set("stor:listing", (await buildSignedArtifact(listing, ARTIFACT_SEPARATORS.Listing, sign)) as Record<string, unknown>);
  }
  return {
    buyerId: buyerDid,
    buyerIdentityBundle: buyerIdentity,
    authenticateBuyerIdentityBundle: () => true,
    readListing: async (ref) => kv.get(ref) ?? null,
    sign: (artifact, sep) => buildSignedArtifact(artifact, sep as never, sign),
    signBytes: async (b) => sign(b),
    resolveAnchor: async (name) => {
      const ref = `stor:${name}`;
      const value = kv.get(ref);
      return value ? { status: "present" as const, ref, value } : { status: "absent" as const };
    },
    anchor: async (name, value) => {
      kv.set(`stor:${name}`, value as Record<string, unknown>);
      return `stor:${name}`;
    },
    // A fresh bridge store per process: the session store carries the claim across restarts.
    settle: payD402Settle(rail, paywall, { store: createIdempotencyStore() }),
    resumeSettlement: payD402ResumeSettlement(rail, paywall),
    expectedSettlementPayee: RECIPIENT,
    newJobId: () => "job-d402",
    now: () => "2026-01-01T00:00:00Z",
    nowMs: () => 1780000000000,
    trustListing: true,
    authenticateRecoveredArtifact: () => true,
    sessionStore,
  };
}

describe("pay-d402 through runSessionCore", () => {
  test.each([undefined, "job-d402"])("unregistered rail cannot pay or complete, including recovery %s", async (resumeJobId) => {
    const kv = new Map<string, Record<string, unknown>>();
    const store = createInMemorySessionStore();
    const { rail, paid, waited } = d402Rail();
    const deps = await sessionDeps(kv, store, rail);
    // Even a custom executor claiming success cannot admit an unregistered phase.
    const settle = vi.fn(async () => ({
      ok: true, txHash: "0xincluded", chainId: "demos:testnet", payer: PAYER, payee: RECIPIENT,
      blockNumber: 77, txRefKind: "demos" as const, finality: { model: "bft-final" as const },
    }));
    const resumeSettlement = vi.fn(settle);
    const anchor = vi.fn(deps.anchor);
    const sign = vi.fn(deps.sign);
    await expect(runSessionCore("stor:listing", terms, {
      ...deps, settle, resumeSettlement, anchor, sign,
    }, resumeJobId)).rejects.toThrow(/pay-d402 is unregistered and unavailable/);
    expect(settle).not.toHaveBeenCalled();
    expect(resumeSettlement).not.toHaveBeenCalled();
    expect(anchor).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(paid).toEqual([]);
    expect(waited).toEqual([]);
    expect([...kv.keys()]).toEqual(["stor:listing"]);
  });
});
