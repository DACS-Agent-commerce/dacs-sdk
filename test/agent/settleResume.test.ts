import { describe, expect, test } from "vitest";

import { buildSignedArtifact, type Signer } from "../../src/agent/signedArtifact.js";
import {
  runSessionCore,
  sessionAnchorName,
  type SessionDeps,
  type SettleResult,
} from "../../src/agent/runSessionCore.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import type { IdentityBundle } from "../../src/artifacts/types.js";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "../../src/crypto/index.js";
import { createIdempotencyStore, createInMemorySettlementLog, settlementKey } from "../../src/rails/idempotency.js";

const seed = Uint8Array.from(Buffer.alloc(32, 5));
const priv = privateKeyFromSeed(seed);
const sign: Signer = (b) => ed25519Sign(b, priv);
const sellerDid = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const buyerDid = "did:demos:buyer";
const buyerIdentity: IdentityBundle = {
  bundleVersion: "1",
  presentedBy: buyerDid,
  presentedAt: 1_780_000_000_000,
  claims: [{ ref: buyerDid }],
  presentation: {
    kind: "per-claim",
    signatures: [{ ref: buyerDid, signature: "test-presentation" }],
  },
};

const listing = {
  agentId: sellerDid,
  serviceId: "svc",
  name: "n",
  description: "d",
  claimRequirements: [],
  supportedNegotiation: ["negotiate-fixed-price"],
  supportedPaymentRails: ["pay-x402"],
  supportedDelivery: ["deliver-attested-payload"],
};
const terms = {
  price: { amount: "1000000", asset: "USDC", decimals: 6, rail: "pay-x402" },
  deliveryPhase: "deliver-attested-payload",
  deliveryFormat: "application/json",
};

/**
 * Build deps over an in-memory store. `store` (durable idempotency) survives the
 * simulated crash; `failEvidenceAnchorOnce` throws the FIRST time the evidence is
 * anchored, reproducing a crash after payment but before the evidence write.
 */
async function makeDeps(opts: { store: ReturnType<typeof createIdempotencyStore>; failEvidenceAnchorOnce?: { hit: boolean }; counter: { n: number } }) {
  const kv = new Map<string, Record<string, unknown>>();
  const listingRef = "stor:listing";
  kv.set(listingRef, (await buildSignedArtifact(listing, ARTIFACT_SEPARATORS.Listing, sign)) as Record<string, unknown>);

  const evidenceName = sessionAnchorName.evidence("job-1");
  const deps: SessionDeps = {
    buyerId: buyerDid,
    buyerIdentityBundle: buyerIdentity,
    authenticateBuyerIdentityBundle: () => true,
    readListing: async (ref) => kv.get(ref) ?? null,
    sign: (artifact, sep) => buildSignedArtifact(artifact, sep as never, sign),
    signBytes: async (b) => sign(b),
    // #70 replaced anchorAddress+readAnchor with a single resolve-by-name seam.
    resolveAnchor: async (name) => {
      const ref = `stor:${name}`;
      const value = kv.get(ref);
      return value ? { status: "present" as const, ref, value } : { status: "absent" as const };
    },
    anchor: async (name, value) => {
      if (name === evidenceName && opts.failEvidenceAnchorOnce && !opts.failEvidenceAnchorOnce.hit) {
        opts.failEvidenceAnchorOnce.hit = true;
        throw new Error("simulated crash: paid but evidence not yet anchored");
      }
      const addr = `stor:${name}`;
      kv.set(addr, value as Record<string, unknown>);
      return addr;
    },
    settle: (req) =>
      opts.store.once(settlementKey(req.rail, req.jobId, req.phaseIndex ?? 0), async (): Promise<SettleResult> => {
        opts.counter.n += 1;
        return { ok: true, txHash: `0xsettle${opts.counter.n}`, chainId: "eip155:84532", payer: "0xbuyer", payee: req.payee };
      }),
    newJobId: () => "job-1",
    now: () => "2026-01-01T00:00:00Z",
    nowMs: () => 1780000000000,
    // These fixtures exercise settle→anchor RESUME, not listing verification —
    // opt out of the #41 gate explicitly (same as runSession.test.ts).
    trustListing: true,
    authenticateRecoveredArtifact: () => true,
    // kv shared across resume via the same closure
  };
  return { deps, kv, listingRef };
}

describe("runSession resume is at-most-once across a settle→anchor crash (#43)", () => {
  test("a crash after payment but before evidence anchoring does NOT re-pay on resume", async () => {
    const store = createIdempotencyStore(createInMemorySettlementLog()); // durable: survives the crash
    const counter = { n: 0 };
    const crash = { hit: false };
    const { deps, listingRef } = await makeDeps({ store, failEvidenceAnchorOnce: crash, counter });

    // Run 1: settles (payment happens), then the evidence anchor throws.
    await expect(runSessionCore(listingRef, terms, deps)).rejects.toThrow(/simulated crash/);
    expect(counter.n).toBe(1); // paid once

    // Run 2: resume the SAME jobId with the SAME idempotency store.
    const res = await runSessionCore(listingRef, terms, deps, "job-1");
    expect(res.outcome).toBe("completed");
    expect(counter.n).toBe(1); // NOT re-paid — the store reconciled the prior settlement
  });
});
