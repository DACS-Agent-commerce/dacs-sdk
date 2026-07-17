import { describe, expect, test } from "vitest";

import { buildSignedArtifact, type Signer } from "../../src/agent/signedArtifact.js";
import {
  runSessionCore,
  type SessionDeps,
  type SettleResult,
} from "../../src/agent/runSessionCore.js";
import { createInMemorySessionStore } from "../../src/agent/sessionStore.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";

const seed = Uint8Array.from(Buffer.alloc(32, 5));
const priv = privateKeyFromSeed(seed);
const sign: Signer = (b) => ed25519Sign(b, priv);
const sellerDid = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;

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

async function makeDeps(store: SessionDeps["sessionStore"]) {
  const kv = new Map<string, Record<string, unknown>>();
  const listingRef = "stor:listing";
  kv.set(listingRef, (await buildSignedArtifact(listing, ARTIFACT_SEPARATORS.Listing, sign)) as Record<string, unknown>);
  const deps: SessionDeps = {
    buyerId: "did:demos:agent:buyer",
    readListing: async (ref) => kv.get(ref) ?? null,
    sign: (artifact, sep) => buildSignedArtifact(artifact, sep as never, sign),
    signBytes: async (b) => sign(b),
    anchorAddress: async (name) => `stor:${name}`,
    readAnchor: async (addr) => kv.get(addr) ?? null,
    anchor: async (name, value) => {
      const addr = `stor:${name}`;
      kv.set(addr, value as Record<string, unknown>);
      return addr;
    },
    settle: async (req): Promise<SettleResult> => ({
      ok: true,
      txHash: "0xpaid",
      chainId: "eip155:84532",
      payer: "0xbuyer",
      payee: req.payee,
    }),
    newJobId: () => "job-1",
    now: () => "2026-01-01T00:00:00Z",
    nowMs: () => 1780000000000,
    sessionStore: store,
  };
  return { deps, listingRef };
}

describe("runSessionCore records to the durable SessionStore (#55 integration)", () => {
  test("a completed session is recorded with receipts, status, and an anti-replay binding", async () => {
    const store = createInMemorySessionStore();
    const { deps, listingRef } = await makeDeps(store);
    const res = await runSessionCore(listingRef, terms, deps);
    expect(res.outcome).toBe("completed");

    // The store now has the session with the final status + all three receipts.
    const loaded = await store.load("job-1");
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") {
      expect(loaded.record.phase).toBe("completed");
      expect(loaded.record.receipts.map((r) => r.kind).sort()).toEqual([
        "agreement",
        "bundle",
        "settlement",
      ]);
      expect(loaded.record.agreementHash).toMatch(/^[0-9a-f]{64}$/);
      // The agreement hash is bound for anti-replay: another session can't reuse it.
      const reuse = await store.bindHash({ hash: loaded.record.agreementHash!, jobId: "other", kind: "agreement" });
      expect(reuse).toEqual({ ok: false, boundTo: "job-1" });
    }
  });

  test("no store wired → the session still completes (store is additive)", async () => {
    const { deps, listingRef } = await makeDeps(undefined);
    const res = await runSessionCore(listingRef, terms, deps);
    expect(res.outcome).toBe("completed");
  });
});
