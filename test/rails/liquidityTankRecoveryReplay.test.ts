import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import {
  advanceLiquidityTankSettlement, createLiquidityTankIntent, liquidityTankPhaseOutcome,
  type LiquidityTankAuthority, type LiquidityTankObservation, type LiquidityTankStore,
} from "../../src/rails/liquidityTank.js";
import { createFsLiquidityTankStore } from "../../src/rails/liquidityTankFs.js";
import { createLiquidityTankEvmFinalityVerifier } from "../../src/rails/liquidityTankEvmFinality.js";

const T0 = 1_785_000_000_000;
const D = T0 + 86_400_000;
const LOCK = `0x${"1".repeat(64)}`;
const RELEASE = `0x${"3".repeat(64)}`;
const BLOCK = `0x${"2".repeat(64)}`;
const roots: string[] = [];
type Unsigned<T> = T extends unknown ? Omit<T, "authenticationHash"> : never;
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function phase() {
  vi.stubEnv("NODE_ENV", "production");
  const dir = await mkdtemp(join(tmpdir(), "dacs-tank-replay-"));
  roots.push(dir);
  const authority: LiquidityTankAuthority = {
    jobId: "01JZ0000000000000000000001", phaseIndex: 0,
    railId: "cross-chain-liquidity-tank:USDC", railDescriptorHash: "b".repeat(64),
    agreementHash: "c".repeat(64), sr5BindingHash: "d".repeat(64),
    assetKind: "stablecoin-cross-chain", networkKind: "cross-chain", mechanism: "liquidity-tank",
    sourceChainId: 11155111, destinationChainId: 80002, sourceChainType: "EVM", destinationChainType: "EVM",
    sourceAsset: "USDC", destinationAsset: "USDC", sourceTokenDecimals: 6, destinationTokenDecimals: 6,
    amount: "1.25", currency: "USDC", originAddress: "origin", destinationAddress: "destination",
    sourceLiquidityTankId: "source", destinationLiquidityTankId: "destination",
    supportedScope: "dacs-v0.1-eth-sepolia-polygon-amoy-usdc",
  };
  const intent = createLiquidityTankIntent(authority);
  const rail = {
    railId: authority.railId, railType: "cross-chain-liquidity-tank" as const,
    phaseHandler: "pay-cross-chain-liquidity-tank" as const,
    asset: { kind: "stablecoin-cross-chain" as const, canonicalSymbol: "USDC", routes: [{
      sourceChainId: 11155111, destChainId: 80002, liquidityTankIds: ["source", "destination"],
    }] }, network: { kind: "cross-chain" as const, mechanism: "liquidity-tank" as const },
  };
  const base = { bridgeId: "replay-payment", operationHash: intent.operationHash };
  type Observation = Exclude<LiquidityTankObservation, { status: "indeterminate" }>;
  const sign = (value: Unsigned<Observation>) =>
    ({ ...value, authenticationHash: sha256Hex(canonicalize(value)) }) as Observation;
  const empty = (at: number) => sign({ ...base, status: "empty", history: ["empty"], observedAt: at });
  const pending = (at: number, locked = true) => sign({ ...base, status: "pending",
    history: ["empty", "pending"], observedAt: at,
    ...(locked ? { lockTxHash: LOCK, recoveryDeadline: D } : {}),
  });
  const completed = (at: number, finality = at, extra = {}) => sign({ ...base, status: "completed",
    history: ["empty", "pending", "completed"], observedAt: at, finalityObservedAt: finality,
    lockTxHash: LOCK, releaseTxHash: RELEASE, recoveryDeadline: D, ...extra,
  });
  const failed = (at: number) => sign({ ...base, status: "failed", history: ["empty", "pending", "failed"],
    observedAt: at, lockTxHash: LOCK, recoveryDeadline: D, reason: "shard failed",
  });
  let now = T0;
  let observed: LiquidityTankObservation = empty(T0);
  let afterBroadcast: LiquidityTankObservation = pending(T0 + 1);
  let readThrows = false;
  let signedUnavailable = false;
  let authenticationUnavailable = false;
  let authenticationRefused = false;
  let owner = 0;
  const prepare = vi.fn(async () => ({ submissionVersion: "1" as const,
    authorityHash: intent.bindingHash, operationHash: intent.operationHash, bridgeId: base.bridgeId,
    substrateTxHash: "signed-tx", signedSubmissionBase64: Buffer.from("retained-bytes").toString("base64"), preparedAt: T0,
  }));
  const broadcast = vi.fn(async () => { observed = afterBroadcast; });
  const observe = vi.fn(async () => {
    if (readThrows) throw new Error("bridge offline");
    return observed;
  });
  const verifier = createLiquidityTankEvmFinalityVerifier({
    sourceRpcUrl: "https://trusted-sepolia.example/",
    verifier: {
      verifySignedSubmission: () => signedUnavailable ? "unavailable" : true,
      authenticateObservation: ({ observation }) => {
        if (authenticationRefused) return false;
        if (authenticationUnavailable) return "unavailable";
        const { authenticationHash, ...value } = observation;
        return sha256Hex(canonicalize(value)) === authenticationHash;
      },
    },
    fetch: async (_url, init) => {
      const { id, method } = JSON.parse(init?.body as string);
      const result = method === "eth_chainId" ? "0xaa36a7" : method === "eth_getTransactionReceipt"
        ? { transactionHash: LOCK, blockHash: BLOCK, blockNumber: "0x10", status: "0x1" }
        : { hash: BLOCK, number: "0x10", transactions: [LOCK] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
    },
  });
  const run = async (wrap?: (store: LiquidityTankStore) => LiquidityTankStore) => {
    const store = await createFsLiquidityTankStore({ dir });
    return advanceLiquidityTankSettlement({ authority, owner: `worker-${++owner}`,
      store: wrap ? wrap(store) : store, adapter: { prepareSubmission: prepare, broadcastRetained: broadcast, observe },
      verifier, resolveAuthority: async () => ({ authority, rail }), now: () => now, leaseDurationMs: 10,
    });
  };
  return { run, prepare, broadcast, observe, empty, pending, completed, failed, intent,
    store: () => createFsLiquidityTankStore({ dir }),
    see(value: LiquidityTankObservation) { observed = value; },
    after(value: LiquidityTankObservation) { afterBroadcast = value; },
    at(value: number) { now = value; },
    outage(kind: string) {
      readThrows = kind === "bridge";
      signedUnavailable = kind === "signed";
      authenticationUnavailable = kind === "authentication";
      authenticationRefused = kind === "refused";
      if (kind === "adapter") observed = { status: "indeterminate", reason: "offline" };
    },
    inspect: async () => (await createFsLiquidityTankStore({ dir })).claim({
      intent, owner: "inspect", now, leaseDurationMs: 10,
    }),
  };
}

test("production replay accepts refreshed authenticated snapshots of the same settled payment", async () => {
  const p = await phase();
  p.after(p.completed(T0 + 1));
  const settled = await p.run();
  expect(settled.status).toBe("settled");
  expect(await p.run()).toEqual(settled);
  p.at(T0 + 20);
  p.see(p.completed(T0 + 20, T0 + 1));
  expect(await p.run()).toEqual(settled);
  expect(p.prepare).toHaveBeenCalledTimes(1);
  expect(p.broadcast).toHaveBeenCalledTimes(1);
});

test.each([
  ["release", { releaseTxHash: "changed-release" }, T0 + 1],
  ["lock", { lockTxHash: `0x${"4".repeat(64)}` }, T0 + 1],
  ["deadline", { recoveryDeadline: D + 1 }, T0 + 1],
  ["finality", {}, T0 + 2],
])("production replay refuses changed %s facts", async (_label, extra, finality) => {
  const p = await phase();
  p.after(p.completed(T0 + 1));
  expect((await p.run()).status).toBe("settled");
  p.at(T0 + 20);
  p.see(p.completed(T0 + 20, finality, extra));
  expect((await p.run()).status).toBe("indeterminate");
  expect(p.prepare).toHaveBeenCalledTimes(1);
  expect(p.broadcast).toHaveBeenCalledTimes(1);
});

test("production replay still refuses an unauthenticated refreshed snapshot", async () => {
  const p = await phase();
  p.after(p.completed(T0 + 1));
  await p.run();
  p.see(p.completed(T0 + 20, T0 + 1));
  p.outage("refused");
  expect(await p.run()).toMatchObject({ status: "indeterminate", reason: "liquidity-tank-observation-unauthenticated" });
});

test.each(["pending", "failed", "contradicted", "standalone-failed"])(
  "%s expiry retains a late release across subsequent filesystem restarts", async (kind) => {
    const p = await phase();
    p.after(kind === "standalone-failed" ? p.failed(T0 + 1) : p.pending(T0 + 1));
    expect((await p.run()).status).toBe("settle-asymmetric");
    p.at(D + 1);
    p.see(kind === "pending" ? p.pending(D + 1) : kind === "contradicted" ? p.empty(D + 1) : p.failed(D + 1));
    expect(await p.run()).toMatchObject({ status: "failed", errorClass: "failed-substrate" });
    p.at(D + 2);
    p.see(p.completed(D + 2));
    const paid = await p.run();
    expect(paid).toMatchObject({ status: "failed", errorClass: "failed-substrate", reputationNeutral: true,
      reason: "tank-released-after-recovery-deadline", txRef: { releaseTxHash: RELEASE }, finalityObservedAt: D + 2,
    });
    expect(liquidityTankPhaseOutcome(paid)).toMatchObject({ release: { txRef: { releaseTxHash: RELEASE } } });
    expect(await p.inspect()).toMatchObject({ status: "recovery-expired", observation: { status: "completed", releaseTxHash: RELEASE } });
    p.outage("bridge");
    expect(await p.run()).toEqual(paid);
    expect(p.prepare).toHaveBeenCalledTimes(1);
    expect(p.broadcast).toHaveBeenCalledTimes(1);
  }, 30_000,
);

test.each([D - 1, D])("expiry reconciles a delayed proof of a timely release at %s", async (finality) => {
  const p = await phase();
  await p.run();
  p.at(D + 1);
  p.see(p.pending(D + 1));
  expect((await p.run()).status).toBe("failed");
  p.at(D + 2);
  p.see(p.completed(D + 2, finality));
  expect((await p.run()).status).toBe("settled");
  expect((await p.run()).status).toBe("settled");
  expect(p.prepare).toHaveBeenCalledTimes(1);
  expect(p.broadcast).toHaveBeenCalledTimes(1);
});

test("late-release reconciliation keeps its expiry CAS and rejects conflicting payment facts", async () => {
  const p = await phase();
  await p.run();
  p.at(D + 1);
  p.see(p.pending(D + 1));
  await p.run();
  const expired = await p.inspect();
  if (expired.status !== "recovery-expired") throw new Error("expected expiry");
  const store = await p.store();
  const completion = p.completed(D + 2) as Extract<LiquidityTankObservation, { status: "completed" }>;
  const input = { settlementKey: p.intent.settlementKey, bindingHash: p.intent.bindingHash,
    expectedEvidence: expired.observation, completion };
  const reconcile = store.reconcileRecoveryExpired!.bind(store);
  for (const extra of [{ lockTxHash: "wrong-lock" }, { recoveryDeadline: D + 1 }]) {
    await expect(reconcile({ ...input, completion: { ...completion, ...extra } })).resolves.toMatchObject({ status: "conflict" });
  }
  await expect(reconcile({ ...input, expectedEvidence: p.pending(D + 2) as never })).resolves.toMatchObject({ status: "conflict" });
  await expect(reconcile(input)).resolves.toEqual({ status: "recorded" });
  await expect(reconcile(input)).resolves.toEqual({ status: "existing" });
  await expect(reconcile({ ...input, completion: { ...completion, authenticationHash: "f".repeat(64) } }))
    .resolves.toEqual({ status: "existing" });
  for (const extra of [{ releaseTxHash: "wrong-release" }, { finalityObservedAt: D }]) {
    await expect(reconcile({ ...input, completion: { ...completion, ...extra } })).resolves.toMatchObject({ status: "conflict" });
  }
  expect(await p.inspect()).toMatchObject({ status: "recovery-expired", observation: completion });
}, 30_000);

test.each(["refused", "unavailable", "missing", "throws"])(
  "a %s reconciliation write never reports an unpaid expiry after seeing a late release", async (kind) => {
    const p = await phase();
    await p.run();
    p.at(D + 1);
    p.see(p.pending(D + 1));
    await p.run();
    p.at(D + 2);
    p.see(p.completed(D + 2));
    // Custom store wrappers are deliberately restricted to development/test.
    vi.stubEnv("NODE_ENV", "test");
    const result = await p.run((store) => ({ ...store, reconcileRecoveryExpired: kind === "missing" ? undefined : async () => {
      if (kind === "throws") throw new Error("disk offline");
      return kind === "refused" ? { status: "conflict", reason: "lost CAS" } : undefined as never;
    } }));
    expect(result).toEqual({ status: "indeterminate", reason: "liquidity-tank-expiry-correction-persistence-uncertain" });
    expect(await p.inspect()).toMatchObject({ status: "recovery-expired", observation: { status: "pending" } });
    expect(p.prepare).toHaveBeenCalledTimes(1);
    expect(p.broadcast).toHaveBeenCalledTimes(1);
  },
);

test.each(["bridge", "adapter", "signed", "authentication"])(
  "unlocked pending retains its deadline during a %s outage after restart", async (kind) => {
    const p = await phase();
    p.after(p.pending(T0 + 1, false));
    const pending = await p.run();
    expect(pending).toMatchObject({ status: "waiting", pendingDeadline: T0 + 600_000, pastDeadline: false });
    p.at(T0 + 600_001);
    p.outage(kind);
    expect(await p.run()).toMatchObject({ status: "indeterminate", pendingDeadline: T0 + 600_000, pastDeadline: true });
    expect(p.prepare).toHaveBeenCalledTimes(1);
    expect(p.broadcast).toHaveBeenCalledTimes(1);
  },
);
