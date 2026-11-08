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
import { evmErc20Settle } from "../../src/rails/evmErc20.js";
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

async function makeDeps(settle: SessionDeps["settle"], kv: Map<string, Record<string, unknown>>, crash: { hit: boolean }, rail: string, expectedSettlementPayee?: string) {
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
  };
  return { deps, listingRef };
}

// A rail's default idempotency store lives in memory, so a restart forgets it.
// Resuming a job whose payment evidence never got anchored must not pay again.
describe("restart with the default in-memory rail store, then resume", () => {
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
    // Process 1: the default store lives only in this bridge instance.
    const first = await makeDeps(evmErc20Settle(rail, cfg), kv, crash, "pay-evm-erc20", "0xpayee");
    await expect(runSessionCore(first.listingRef, evmTerms, first.deps)).rejects.toThrow(/simulated crash/);
    expect(transfers).toBe(1);
    // Process 2: a new bridge instance, so a new empty default store.
    const second = await makeDeps(evmErc20Settle(rail, cfg), kv, crash, "pay-evm-erc20", "0xpayee");
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
    const first = await makeDeps(payDemSettle(rail), kv, crash, "pay-dem");
    await expect(runSessionCore(first.listingRef, demTerms, first.deps)).rejects.toThrow(/simulated crash/);
    expect(transfers).toBe(1);
    const second = await makeDeps(payDemSettle(rail), kv, crash, "pay-dem");
    await expect(runSessionCore(second.listingRef, demTerms, second.deps, "job-1"))
      .rejects.toThrow(/resumeSettlement is required/);
    expect(transfers).toBe(1);
  });
});
