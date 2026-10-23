import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { runSessionCore, type SessionDeps } from "../../src/agent/runSessionCore.js";
import { createInMemorySessionStore, type SessionStore } from "../../src/agent/sessionStore.js";
import { buildSignedArtifact } from "../../src/agent/signedArtifact.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "../../src/crypto/index.js";
import { createIdempotencyStore, createInMemorySettlementLog } from "../../src/rails/idempotency.js";
import { payDemSettle } from "../../src/rails/payDem.js";
import { demosNode, sdkPayDemRail } from "../fixtures/demosNodeScript.js";

vi.mock("@kynesyslabs/demosdk/websdk", async () =>
  (await import("../fixtures/demosNodeScript.js")).demosWebsdkMock);
beforeEach(() => demosNode.reset());
const seed = new Uint8Array(32).fill(5);
const sign = (bytes: Uint8Array) => ed25519Sign(bytes, privateKeyFromSeed(seed));
const seller = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const terms = { price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" },
  deliveryPhase: "deliver-attested-payload", deliveryFormat: "application/json" };

async function fixture(store?: SessionStore) {
  const kv = new Map<string, Record<string, unknown>>();
  kv.set("stor:listing", await buildSignedArtifact({ agentId: seller, serviceId: "svc", name: "n",
    description: "d", claimRequirements: [], supportedNegotiation: ["negotiate-fixed-price"],
    supportedPaymentRails: ["pay-dem"], supportedDelivery: ["deliver-attested-payload"] },
  ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
  const log = createInMemorySettlementLog();
  const adapter = async () => payDemSettle(await sdkPayDemRail(), {}, { store: createIdempotencyStore(log, { now: () => 1, leaseDurationMs: 1 }),
    reconcile: async () => ({ ok: true, execution: "executed", txHash: demosNode.nextHash,
      payer: demosNode.address, payee: seller.split(":").at(-1)!, chainId: "demos", amountOs: "1000000000",
      blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" } }) });
  const deps: SessionDeps = {
    buyerId: "did:demos:buyer",
    buyerIdentityBundle: { bundleVersion: "1", presentedBy: "did:demos:buyer", presentedAt: 1780000000000,
      claims: [{ ref: "did:demos:buyer" }], presentation: { kind: "per-claim",
        signatures: [{ ref: "did:demos:buyer", signature: "test" }] } },
    authenticateBuyerIdentityBundle: () => true,
    readListing: async (ref) => kv.get(ref) ?? null, trustListing: true,
    sign: (artifact, sep) => buildSignedArtifact(artifact, sep as never, sign), signBytes: async (b) => sign(b),
    settle: await adapter(), sessionStore: store,
    resolveAnchor: async (name) => {
      const ref = `stor:${name}`, value = kv.get(ref);
      return value ? { status: "present", ref, value } : { status: "absent" };
    },
    anchor: async (name, value) => { const ref = `stor:${name}`; kv.set(ref, value as Record<string, unknown>); return ref; },
    authenticateRecoveredArtifact: () => true,
    newJobId: () => "sweep-session", now: () => "2026-01-01T00:00:00Z", nowMs: () => 1780000000000,
  };
  return { deps, adapter, kv, log };
}

test("fresh native sessions require a SessionStore before signing, and accept a configured store", async () => {
  const f = await fixture();
  await assert.rejects(runSessionCore("stor:listing", terms, f.deps), /requires a SessionStore/);
  assert.equal(demosNode.transfers, 0);
  f.deps.sessionStore = createInMemorySessionStore();
  assert.equal((await runSessionCore("stor:listing", terms, f.deps, "sweep-session")).outcome, "completed");
  assert.equal(demosNode.broadcasts, 1);
});
