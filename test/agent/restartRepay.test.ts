import { describe, expect, test, vi } from "vitest";

import { buildSignedArtifact, type Signer } from "../../src/agent/signedArtifact.js";
import {
  runSessionCore,
  sessionAnchorName,
  type SessionDeps,
} from "../../src/agent/runSessionCore.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import type { IdentityBundle } from "../../src/artifacts/types.js";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "../../src/crypto/index.js";
import { createInMemorySessionStore } from "../../src/agent/sessionStore.js";
import { evmErc20Settle } from "../../src/rails/evmErc20.js";
import { createIdempotencyStore } from "../../src/rails/idempotency.js";
import { payDemSettle } from "../../src/rails/payDem.js";

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

// Test rails are plain objects, so accept them in place of createPayDemRail output.
vi.mock("../../src/rails/payDemExecutionAuthority.js", async () =>
  import("../support/payDemExecutionAuthority.js"));

async function makeDeps(settle: SessionDeps["settle"], kv: Map<string, Record<string, unknown>>, crash: { hit: boolean }, rail: string, expectedSettlementPayee?: string, extra: Partial<SessionDeps> = {}) {
  const listingRef = "stor:listing";
  kv.set(listingRef, (await buildSignedArtifact({ ...listing, supportedPaymentRails: [rail] }, ARTIFACT_SEPARATORS.Listing, sign)) as Record<string, unknown>);
  const evidenceName = sessionAnchorName.evidence("job-1");
  const deps: SessionDeps = {
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
      if (name === evidenceName && !crash.hit) {
        crash.hit = true;
        throw new Error("simulated crash: paid but evidence not yet anchored");
      }
      const addr = `stor:${name}`;
      kv.set(addr, value as Record<string, unknown>);
      return addr;
    },
    settle,
    ...(expectedSettlementPayee === undefined ? {} : { expectedSettlementPayee }),
    newJobId: () => "job-1",
    now: () => "2026-01-01T00:00:00Z",
    nowMs: () => 1780000000000,
    trustListing: true,
    authenticateRecoveredArtifact: () => true,
    ...extra,
  };
  return { deps, listingRef };
}

// These fixtures give each bridge a fresh in-memory store to exercise session recovery.
// Resuming a job whose payment evidence never got anchored must not pay again.
describe("restart with a fresh in-memory rail store, then resume", () => {
  test("evm-erc20: resuming the same job after a crash does not transfer again", async () => {
    let transfers = 0;
    const rail = {
      address: "0xbuyer",
      finalityBlocks: 1,
      async settle() {
        transfers += 1;
        return {
          ok: true as const,
          txHash: `0x${String(transfers).padStart(64, "0")}`,
          chainId: "eip155:84532",
          payer: "0xbuyer",
          payee: "0xpayee",
          finality: { model: "block-depth" as const, finalityBlocks: 1 },
        };
      },
    };
    const cfg = { tokenAddress: "0xtoken", network: "eip155:84532", recipientEvm: "0xpayee" };
    const evmTerms = {
      ...terms,
      price: { amount: "1000000", asset: "USDC", decimals: 6, rail: "pay-evm-erc20" },
    };
    const kv = new Map<string, Record<string, unknown>>();
    const crash = { hit: false };
    // Process 1: the injected store lives only in this bridge instance.
    const first = await makeDeps(evmErc20Settle(rail, cfg, { store: createIdempotencyStore() }), kv, crash, "pay-evm-erc20", "0xpayee");
    await expect(runSessionCore(first.listingRef, evmTerms, first.deps)).rejects.toThrow(/simulated crash/);
    expect(transfers).toBe(1);
    // Process 2: a new bridge instance, so a new empty store.
    const second = await makeDeps(evmErc20Settle(rail, cfg, { store: createIdempotencyStore() }), kv, crash, "pay-evm-erc20", "0xpayee");
    await expect(runSessionCore(second.listingRef, evmTerms, second.deps, "job-1"))
      .rejects.toThrow(/resumeSettlement is required/);
    expect(transfers).toBe(1);
  });

  test("pay-dem: resuming the same job after a crash does not transfer again", async () => {
    let transfers = 0;
    const payer = "ab".repeat(32);
    const payee = sellerDid.split(":").at(-1)!;
    const rail = {
      address: payer,
      settle: async () => {
        transfers += 1;
        return {
          ok: true as const, execution: "executed" as const,
          txHash: transfers.toString(16).padStart(64, "0"), chainId: "demos", payer, payee,
          blockNumber: 42, txRefKind: "demos" as const, finality: { model: "bft-final" as const },
          networkFeeOs: "0",
        };
      },
    };
    const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
    const kv = new Map<string, Record<string, unknown>>();
    const crash = { hit: false };
    const first = await makeDeps(payDemSettle(rail, {}, { store: createIdempotencyStore() }), kv, crash, "pay-dem");
    await expect(runSessionCore(first.listingRef, demTerms, first.deps)).rejects.toThrow(/simulated crash/);
    expect(transfers).toBe(1);
    const second = await makeDeps(payDemSettle(rail, {}, { store: createIdempotencyStore() }), kv, crash, "pay-dem");
    await expect(runSessionCore(second.listingRef, demTerms, second.deps, "job-1"))
      .rejects.toThrow(/resumeSettlement is required/);
    expect(transfers).toBe(1);
  });
});

function evmFixture() {
  const counter = { transfers: 0 };
  const rail = {
    address: "0xbuyer",
    finalityBlocks: 1,
    async settle() {
      counter.transfers += 1;
      return {
        ok: true as const,
        txHash: `0x${String(counter.transfers).padStart(64, "0")}`,
        chainId: "eip155:84532",
        payer: "0xbuyer",
        payee: "0xpayee",
        finality: { model: "block-depth" as const, finalityBlocks: 1 },
      };
    },
  };
  const cfg = { tokenAddress: "0xtoken", network: "eip155:84532", recipientEvm: "0xpayee" };
  const evmTerms = {
    ...terms,
    price: { amount: "1000000", asset: "USDC", decimals: 6, rail: "pay-evm-erc20" },
  };
  return { counter, rail, cfg, evmTerms };
}

describe("resume with a session store that never saw the earlier run", () => {
  test("a fresh in-memory session store after a restart does not transfer again", async () => {
    const { counter, rail, cfg, evmTerms } = evmFixture();
    const kv = new Map<string, Record<string, unknown>>();
    const crash = { hit: false };
    const first = await makeDeps(evmErc20Settle(rail, cfg, { store: createIdempotencyStore() }), kv, crash, "pay-evm-erc20", "0xpayee",
      { sessionStore: createInMemorySessionStore() });
    await expect(runSessionCore(first.listingRef, evmTerms, first.deps)).rejects.toThrow(/simulated crash/);
    expect(counter.transfers).toBe(1);
    // Process 2: the session store is new and empty, so it has no record of job-1.
    const second = await makeDeps(evmErc20Settle(rail, cfg, { store: createIdempotencyStore() }), kv, crash, "pay-evm-erc20", "0xpayee",
      { sessionStore: createInMemorySessionStore() });
    await expect(runSessionCore(second.listingRef, evmTerms, second.deps, "job-1"))
      .rejects.toThrow(/resumeSettlement is required/);
    expect(counter.transfers).toBe(1);
  });

  test("a retry after a failed resume on the same fresh store does not transfer again", async () => {
    const { counter, rail, cfg, evmTerms } = evmFixture();
    const kv = new Map<string, Record<string, unknown>>();
    const crash = { hit: false };
    const first = await makeDeps(evmErc20Settle(rail, cfg, { store: createIdempotencyStore() }), kv, crash, "pay-evm-erc20", "0xpayee");
    await expect(runSessionCore(first.listingRef, evmTerms, first.deps)).rejects.toThrow(/simulated crash/);
    expect(counter.transfers).toBe(1);
    // Process 2: one fresh store. The first resume fails on the evidence lookup
    // after the store has created its record of the job; the retry reuses it.
    const sessionStore = createInMemorySessionStore();
    const second = await makeDeps(evmErc20Settle(rail, cfg, { store: createIdempotencyStore() }), kv, crash, "pay-evm-erc20", "0xpayee", { sessionStore });
    const resolve = second.deps.resolveAnchor;
    let failNext = true;
    second.deps.resolveAnchor = async (name) => {
      if (name === sessionAnchorName.evidence("job-1") && failNext) {
        failNext = false;
        throw new Error("simulated network error");
      }
      return resolve(name);
    };
    await expect(runSessionCore(second.listingRef, evmTerms, second.deps, "job-1")).rejects.toThrow();
    await expect(runSessionCore(second.listingRef, evmTerms, second.deps, "job-1"))
      .rejects.toThrow(/resumeSettlement is required/);
    expect(counter.transfers).toBe(1);
  });

  test("two resumes at once on one fresh store do not transfer again", async () => {
    const { counter, rail, cfg, evmTerms } = evmFixture();
    const kv = new Map<string, Record<string, unknown>>();
    const crash = { hit: false };
    const first = await makeDeps(evmErc20Settle(rail, cfg, { store: createIdempotencyStore() }), kv, crash, "pay-evm-erc20", "0xpayee");
    await expect(runSessionCore(first.listingRef, evmTerms, first.deps)).rejects.toThrow(/simulated crash/);
    const sessionStore = createInMemorySessionStore();
    const a = await makeDeps(evmErc20Settle(rail, cfg, { store: createIdempotencyStore() }), kv, crash, "pay-evm-erc20", "0xpayee", { sessionStore });
    const b = await makeDeps(evmErc20Settle(rail, cfg, { store: createIdempotencyStore() }), kv, crash, "pay-evm-erc20", "0xpayee", { sessionStore });
    const results = await Promise.allSettled([
      runSessionCore(a.listingRef, evmTerms, a.deps, "job-1"),
      runSessionCore(b.listingRef, evmTerms, b.deps, "job-1"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(counter.transfers).toBe(1);
  });

  test("a crash before paying resumes through a durable resumeSettlement and pays once", async () => {
    const { counter, rail, cfg, evmTerms } = evmFixture();
    const kv = new Map<string, Record<string, unknown>>();
    const crash = { hit: true }; // evidence anchoring does not crash in this case
    const durableRailStore = createIdempotencyStore(); // shared by both processes
    const first = await makeDeps(async () => {
      throw new Error("simulated crash before paying");
    }, kv, crash, "pay-evm-erc20", "0xpayee");
    await expect(runSessionCore(first.listingRef, evmTerms, first.deps)).rejects.toThrow(/before paying/);
    expect(counter.transfers).toBe(0);
    const bridge = evmErc20Settle(rail, cfg, { store: durableRailStore });
    const second = await makeDeps(bridge, kv, crash, "pay-evm-erc20", "0xpayee", { resumeSettlement: bridge });
    await expect(runSessionCore(second.listingRef, evmTerms, second.deps, "job-1")).resolves.toBeDefined();
    expect(counter.transfers).toBe(1);
  });

  test("a durable session store with the job but no claim resumes through resumeSettlement and pays once", async () => {
    const { counter, rail, cfg, evmTerms } = evmFixture();
    const kv = new Map<string, Record<string, unknown>>();
    const crash = { hit: true }; // evidence anchoring does not crash in this case
    const sessionStore = createInMemorySessionStore(); // stands in for a durable store shared by both processes
    const durableRailStore = createIdempotencyStore();
    const bridge = evmErc20Settle(rail, cfg, { store: durableRailStore });
    // Process 1 stops after the Agreement and the store record, before the settlement claim.
    const first = await makeDeps(bridge, kv, crash, "pay-evm-erc20", "0xpayee", { sessionStore });
    const resolve = first.deps.resolveAnchor;
    first.deps.resolveAnchor = async (name) => {
      if (name === sessionAnchorName.evidence("job-1")) throw new Error("simulated stop before the claim");
      return resolve(name);
    };
    await expect(runSessionCore(first.listingRef, evmTerms, first.deps)).rejects.toThrow(/lookup for/);
    expect(counter.transfers).toBe(0);
    expect((await sessionStore.load("job-1")).status).toBe("ok");
    // Without resumeSettlement the resume is refused; with it, the job completes once.
    const refused = await makeDeps(bridge, kv, crash, "pay-evm-erc20", "0xpayee", { sessionStore });
    await expect(runSessionCore(refused.listingRef, evmTerms, refused.deps, "job-1"))
      .rejects.toThrow(/resumeSettlement is required/);
    const second = await makeDeps(bridge, kv, crash, "pay-evm-erc20", "0xpayee",
      { sessionStore, resumeSettlement: bridge });
    await expect(runSessionCore(second.listingRef, evmTerms, second.deps, "job-1")).resolves.toBeDefined();
    expect(counter.transfers).toBe(1);
  });
});
