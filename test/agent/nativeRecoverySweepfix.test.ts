import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { runSessionCore, sessionAnchorName, type SessionDeps } from "../../src/agent/runSessionCore.js";
import { createInMemorySessionStore, type SessionStore } from "../../src/agent/sessionStore.js";
import { buildSignedArtifact } from "../../src/agent/signedArtifact.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "../../src/crypto/index.js";
import { createIdempotencyStore, createInMemorySettlementLog } from "../../src/rails/idempotency.js";
import { payDemSettle } from "../../src/rails/payDem.js";
import { demosNode, demosRpcFetch, sdkPayDemRail } from "../fixtures/demosNodeScript.js";

vi.mock("@kynesyslabs/demosdk/websdk", async () =>
  (await import("../fixtures/demosNodeScript.js")).demosWebsdkMock);
beforeEach(() => { demosNode.reset(); vi.stubGlobal("fetch", demosRpcFetch); });
afterEach(() => vi.unstubAllGlobals());
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
  const adapter = async (archive = false) => payDemSettle(await sdkPayDemRail(undefined,
    archive ? { recoveryRpc: "https://archive.test" } : {}), {}, { store: createIdempotencyStore(log, { now: () => 1, leaseDurationMs: 1 }),
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

test.each([null, "error", { result: 500, response: new Error("ECONNRESET") }])(
"a final payment completes after restart using an archive when primary returns %s", async (primary) => {
  const store = createInMemorySessionStore();
  const f = await fixture(store);
  const healthyAnchor = f.deps.anchor;
  f.deps.anchor = async (name, value) => {
    if (name === sessionAnchorName.evidence("sweep-session")) throw new Error("anchor outage");
    return healthyAnchor(name, value);
  };
  const paid = await runSessionCore("stor:listing", terms, f.deps);
  assert.equal(paid.outcome, "settlement-pending");
  if (paid.outcome !== "settlement-pending") throw new Error("missing paid state");
  assert.equal(paid.payment.ok, true);
  assert.equal(paid.payment.txHash, demosNode.nextHash);
  assert.equal(paid.bundleRef, undefined);
  const loaded = await store.load("sweep-session");
  assert.equal(loaded.status, "ok");
  if (loaded.status !== "ok") throw new Error("missing durable retry");
  assert.equal(loaded.record.phase, "settled");
  assert.ok(loaded.record.checkpoints.some((cp) => cp.key === "settle:0" && cp.stage === "outcome" && cp.data?.ok));
  const record = structuredClone(demosNode.records.get(demosNode.nextHash));
  demosNode.reply = (_hash, rpc) => rpc === "https://archive.test" ? record : primary;
  const restarted = { ...f.deps, anchor: healthyAnchor, settle: await f.adapter(true) };
  assert.equal((await runSessionCore("stor:listing", terms, restarted, "sweep-session")).outcome, "completed");
  assert.equal(demosNode.transfers, 1);
  assert.equal(demosNode.broadcasts, 1);
});

test("closing an expired unsigned intent lets the original session finish failed without paying", async () => {
  const f = await fixture(createInMemorySessionStore());
  demosNode.onTransfer = () => { throw new Error("death before signing"); };
  await assert.rejects(runSessionCore("stor:listing", terms, f.deps), /death before signing/);
  const payee = seller.split(":").at(-1)!;
  await createIdempotencyStore(f.log, { now: () => 3 }).abandonUnattempted!("pay-dem:sweep-session:0", {
    bindingVersion: "1", railId: "pay-dem", jobId: "sweep-session", phaseIndex: 0, phase: "pay-dem",
    amount: "1000000000", agreementAsset: "DEM", settlementAsset: "DEM", payer: demosNode.address,
    payee, network: "demos", finality: { model: "bft-final" },
  }, { originalLogRetained: true, reconcile: async () => null });
  const resumed = { ...f.deps, settle: await f.adapter() };
  assert.equal((await runSessionCore("stor:listing", terms, resumed, "sweep-session")).outcome, "failed");
  assert.equal(demosNode.transfers, 1); // only the pre-signing call that threw
  assert.equal(demosNode.broadcasts, 0);
});

test.each(["default store", "no reconciler", "resume adapter"])(
  "an unattempted retry refuses %s before consuming permission, then accepts repaired configuration", async (fault) => {
    const store = createInMemorySessionStore();
    const f = await fixture(store);
    vi.spyOn(f.log, "claimIntent").mockRejectedValueOnce(new Error("DB outage"));
    f.deps.settle = await f.adapter(); // capture the faulting log method before constructing the adapter
    await assert.rejects(runSessionCore("stor:listing", terms, f.deps), /before invoking/);
    const before = await store.load("sweep-session");
    const unconfigured = fault === "no reconciler"
      ? payDemSettle(await sdkPayDemRail(), {}, { store: createIdempotencyStore(f.log) })
      : payDemSettle(await sdkPayDemRail());
    const resumed = { ...f.deps, ...(fault === "resume adapter"
      ? { resumeSettlement: unconfigured } : { settle: unconfigured }) };
    await assert.rejects(runSessionCore("stor:listing", terms, resumed, "sweep-session"), /caller-supplied settlement store and reconciler/);
    assert.equal(demosNode.transfers, 0);
    assert.equal(demosNode.broadcasts, 0);
    const after = await store.load("sweep-session");
    if (before.status !== "ok" || after.status !== "ok") throw new Error("missing session");
    assert.deepEqual(after.record.checkpoints.filter((cp) => cp.key === "settle:unattempted"),
      before.record.checkpoints.filter((cp) => cp.key === "settle:unattempted"));
    assert.equal((await runSessionCore("stor:listing", terms, f.deps, "sweep-session")).outcome, "completed");
    assert.equal((await runSessionCore("stor:listing", terms, f.deps, "sweep-session")).outcome, "completed");
    assert.equal(demosNode.broadcasts, 1);
  },
);
