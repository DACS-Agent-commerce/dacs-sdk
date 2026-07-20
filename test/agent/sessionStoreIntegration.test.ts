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

interface DepOverrides {
  kv?: Map<string, Record<string, unknown>>;
  settle?: SessionDeps["settle"];
  anchor?: SessionDeps["anchor"];
  newJobId?: () => string;
}

async function makeDeps(store: SessionDeps["sessionStore"], over: DepOverrides = {}) {
  const kv = over.kv ?? new Map<string, Record<string, unknown>>();
  const settleCalls = { n: 0 };
  const listingRef = "stor:listing";
  if (!kv.has(listingRef)) {
    kv.set(listingRef, (await buildSignedArtifact(listing, ARTIFACT_SEPARATORS.Listing, sign)) as Record<string, unknown>);
  }
  const deps: SessionDeps = {
    buyerId: "did:demos:agent:buyer",
    readListing: async (ref) => kv.get(ref) ?? null,
    sign: (artifact, sep) => buildSignedArtifact(artifact, sep as never, sign),
    signBytes: async (b) => sign(b),
    anchorAddress: async (name) => `stor:${name}`,
    readAnchor: async (addr) => kv.get(addr) ?? null,
    anchor:
      over.anchor ??
      (async (name, value) => {
        const addr = `stor:${name}`;
        kv.set(addr, value as Record<string, unknown>);
        return addr;
      }),
    settle:
      over.settle ??
      (async (req): Promise<SettleResult> => {
        settleCalls.n++;
        return { ok: true, txHash: "0xpaid", chainId: "eip155:84532", payer: "0xbuyer", payee: req.payee };
      }),
    newJobId: over.newJobId ?? (() => "job-1"),
    now: () => "2026-01-01T00:00:00Z",
    nowMs: () => 1780000000000,
    sessionStore: store,
  };
  return { deps, listingRef, kv, settleCalls };
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

  test("write-ahead: a crash AFTER paying but BEFORE anchoring evidence does NOT re-pay on resume (#52)", async () => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    // Run 1: pay succeeds, then the anchor of the evidence "crashes".
    const boom = await makeDeps(store, {
      kv,
      anchor: async (name, value) => {
        if (name.includes("evidence")) throw new Error("crash: evidence anchor lost");
        kv.set(`stor:${name}`, value as Record<string, unknown>);
        return `stor:${name}`;
      },
    });
    await expect(runSessionCore(boom.listingRef, terms, boom.deps)).rejects.toThrow(/crash/);
    expect(boom.settleCalls.n).toBe(1); // paid exactly once
    // The write-ahead outcome checkpoint recorded the payment before the crash.
    const mid = await store.load("job-1");
    expect(mid.status === "ok" && mid.record.checkpoints.some((c) => c.stage === "outcome")).toBe(true);

    // Run 2: resume the SAME jobId with a healthy anchor. Evidence still isn't
    // anchored, so the anchoring guard alone would re-pay — the store must reconcile.
    const resumed = await makeDeps(store, { kv });
    const res = await runSessionCore(resumed.listingRef, terms, resumed.deps, "job-1");
    expect(res.outcome).toBe("completed");
    expect(resumed.settleCalls.n).toBe(0); // did NOT pay again — reconciled from the checkpoint
  });

  test("fail-closed: untrustworthy (corrupt) durable state refuses to settle (#67)", async () => {
    // A store whose load reports `corrupt` for this session — payment must be
    // refused BEFORE the effect, never run against state we can't trust.
    const base = createInMemorySessionStore();
    const corruptStore: SessionDeps["sessionStore"] = {
      ...base,
      load: async () => ({ status: "corrupt", reason: "planted" }),
    };
    const { deps, listingRef, settleCalls } = await makeDeps(corruptStore);
    await expect(runSessionCore(listingRef, terms, deps)).rejects.toThrow(/fail-closed|corrupt/);
    expect(settleCalls.n).toBe(0); // never paid
  });
});
