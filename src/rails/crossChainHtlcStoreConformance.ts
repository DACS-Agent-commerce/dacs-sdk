import { canonicalize, sha256Hex } from "../canonical/index.js";
import {
  createCrossChainHtlcIntent,
  crossChainHtlcSourceFinalityCheckpointHash,
  generateHtlcBuyerSalt,
  type CrossChainHtlcAuthority,
  type CrossChainHtlcIntent,
  type CrossChainHtlcSecrets,
  type CrossChainHtlcSettlement,
  type CrossChainHtlcStore,
  type HtlcAction,
  type HtlcLease,
  type HtlcPreparedAction,
  type HtlcRevealCheckpoint,
  type HtlcSourceFinalityCheckpoint,
  type HtlcStoreClaim,
  type HtlcStoreWrite,
  type HtlcTxRef,
} from "./crossChainHtlc.js";

/** One contract case of `checkCrossChainHtlcStore`. */
export interface CrossChainHtlcStoreCheck {
  name: string;
  ok: boolean;
  /** Why the case failed; absent when it passed. */
  detail?: string;
}

/** Options of `checkCrossChainHtlcStore`. */
export interface CrossChainHtlcStoreCheckOptions {
  /**
   * Close `store` and return a new store over the same durable state, as a
   * process restart would. The kit never uses `store` again. Without it the
   * restart case fails.
   */
  reopen?: (store: CrossChainHtlcStore) => CrossChainHtlcStore | Promise<CrossChainHtlcStore>;
}

const AUTH_HASH = "c".repeat(64);
const NOW = 1_000_000;
const LEASE_MS = 10_000;
/** Source expiry in Unix seconds, well after `NOW`. */
const SOURCE_EXPIRY = 10_000;
const JOB_IDS = ["01J8ME0SXKQ4T9V2RC5HJ6WX7F", "01J8ME0SXKQ4T9V2RC5HJ6WX7G", "01J8ME0SXKQ4T9V2RC5HJ6WX7H"] as const;

const HASHLOCKS = {
  deriveHashlock({ chainId, preimage }: { chainId: number; preimage: Uint8Array }): string {
    return `${chainId}:${sha256Hex(preimage)}`;
  },
};

function authority(jobId: string): CrossChainHtlcAuthority {
  return {
    jobId,
    phaseIndex: 2,
    railId: "cross-chain-htlc:USDC",
    railDescriptorHash: "b".repeat(64),
    agreementHash: "a".repeat(64),
    assetKind: "stablecoin-cross-chain",
    networkKind: "cross-chain",
    mechanism: "htlc",
    sourceChainId: 84532,
    destinationChainId: 80002,
    sourceAsset: "USDC",
    destinationAsset: "USDC",
    sourceTokenId: "source-usdc-token",
    destinationTokenId: "destination-usdc-token",
    sourceTokenDecimals: 6,
    destinationTokenDecimals: 6,
    amount: "1.25",
    currency: "USDC",
    payerSourceAddress: "payer-source",
    payerDestinationAddress: "payer-destination",
    payeeSourceAddress: "payee-source",
    payeeDestinationAddress: "payee-destination",
    sourceContractAddress: "source-contract",
    destinationContractAddress: "destination-contract",
    sourceFinalitySec: 20,
    destinationFinalitySec: 15,
    safetyWindowSec: 10,
    sourceTimelockSec: 500,
    destinationTimelockSec: 100,
  };
}

interface Session {
  intent: Readonly<CrossChainHtlcIntent>;
  secrets: Readonly<CrossChainHtlcSecrets>;
}

function session(jobId: string = JOB_IDS[0], buyerSalt = generateHtlcBuyerSalt()): Session {
  return createCrossChainHtlcIntent(authority(jobId), buyerSalt, HASHLOCKS);
}

function txRef(intent: Readonly<CrossChainHtlcIntent>, action: HtlcAction, txHash: string): HtlcTxRef {
  const onSource = action === "source-lock" || action === "source-claim" || action === "source-refund";
  const chainId = onSource ? intent.sourceChainId : intent.destinationChainId;
  const contractAddress = onSource ? intent.sourceContractAddress : intent.destinationContractAddress;
  if (action === "source-lock" || action === "destination-lock") {
    return { kind: "htlc-lock", chainId, contractAddress, lockTxHash: txHash };
  }
  if (action === "destination-claim") return { kind: "htlc-reveal", chainId, contractAddress, revealTxHash: txHash };
  if (action === "source-claim") return { kind: "htlc-claim", chainId, contractAddress, claimTxHash: txHash };
  return { kind: "htlc-refund", chainId, contractAddress, refundTxHash: txHash };
}

function prepared(
  intent: Readonly<CrossChainHtlcIntent>,
  action: HtlcAction,
  txHash: string,
  sourceFinalityCheckpointHash?: string,
): Readonly<HtlcPreparedAction> {
  const unsigned = {
    actionVersion: "1" as const,
    action,
    actor: action === "destination-lock" || action === "source-claim" ||
      action === "destination-refund" ? "payee" as const : "payer" as const,
    authorityHash: intent.bindingHash,
    txRef: txRef(intent, action, txHash),
    signedPayloadBase64: Buffer.from(`${action}:${txHash}`, "utf8").toString("base64"),
    preparedAt: NOW,
    ...(sourceFinalityCheckpointHash === undefined ? {} : { sourceFinalityCheckpointHash }),
  };
  return Object.freeze({ ...unsigned, effectHash: sha256Hex(canonicalize(unsigned)) });
}

function sourceFinality(
  sourceLock: Readonly<HtlcPreparedAction>,
  sourceExpiry = SOURCE_EXPIRY,
): HtlcSourceFinalityCheckpoint {
  return {
    sourceLockEffectHash: sourceLock.effectHash,
    sourceLockTxRef: sourceLock.txRef as Extract<HtlcTxRef, { kind: "htlc-lock" }>,
    includedAt: NOW,
    sourceExpiry,
    finalityObservedAt: NOW + 500,
    authenticationHash: AUTH_HASH,
  };
}

function revealCheckpoint(
  reveal: Readonly<HtlcPreparedAction>,
  sourceExpiry = SOURCE_EXPIRY,
): HtlcRevealCheckpoint {
  return {
    revealTxRef: reveal.txRef as Extract<HtlcTxRef, { kind: "htlc-reveal" }>,
    sourceExpiry,
    finalityObservedAt: NOW + 600,
    authenticationHash: AUTH_HASH,
  };
}

function settlement(
  intent: Readonly<CrossChainHtlcIntent>,
  sourceExpiry = SOURCE_EXPIRY,
  hashSuffix = "",
): CrossChainHtlcSettlement {
  return {
    txRefs: [
      txRef(intent, "source-lock", `lock-s${hashSuffix}`),
      txRef(intent, "destination-lock", `lock-d${hashSuffix}`),
      txRef(intent, "destination-claim", `reveal-1${hashSuffix}`),
      txRef(intent, "source-claim", `claim-1${hashSuffix}`),
    ],
    paymentAmount: { amount: intent.amount, currency: intent.currency },
    settlementFinality: {
      model: "htlc-reveal",
      sourceExpiry,
      finalityReachedAt: NOW + 700,
      finalityObservedAt: NOW + 800,
    },
    authenticationHash: AUTH_HASH,
  };
}

class ContractViolation extends Error {}

function expectStatus(
  result: HtlcStoreWrite | HtlcStoreClaim,
  allowed: readonly string[],
  label: string,
): void {
  if (!allowed.includes(result.status)) {
    throw new ContractViolation(`${label}: expected ${allowed.join(" or ")}, got ${result.status}` +
      ("reason" in result ? ` (${result.reason})` : ""));
  }
}

function expectTrue(value: boolean, label: string): void {
  if (!value) throw new ContractViolation(label);
}

const REFUSED = ["conflict", "corrupt"] as const;

interface Leased extends Session {
  store: CrossChainHtlcStore;
  lease: Readonly<HtlcLease>;
}

function writer(s: Leased, lease: Readonly<HtlcLease> = s.lease) {
  return {
    settlementKey: s.intent.settlementKey,
    bindingHash: s.intent.bindingHash,
    owner: lease.owner,
    generation: lease.generation,
  };
}

async function acquire(
  store: CrossChainHtlcStore,
  s: Session = session(),
  owner = "worker-a",
  now = NOW,
): Promise<Leased> {
  const claimed = await store.claim({ intent: s.intent, secrets: s.secrets, owner, now, leaseDurationMs: LEASE_MS });
  expectStatus(claimed, ["acquired"], `claim by ${owner}`);
  if (claimed.status !== "acquired") throw new ContractViolation("unreachable");
  return { ...s, store, lease: claimed.lease };
}

async function takeOver(s: Leased, owner = "worker-b"): Promise<Leased> {
  return acquire(s.store, s, owner, s.lease.expiresAt);
}

/** The rows the store retains, read by another worker while `s` holds the lease. */
async function retainedPrepared(s: Leased): Promise<readonly Readonly<HtlcPreparedAction>[]> {
  const claimed = await s.store.claim({
    intent: s.intent,
    secrets: s.secrets,
    owner: "reader",
    now: s.lease.expiresAt - 1,
    leaseDurationMs: LEASE_MS,
  });
  if (claimed.status !== "waiting") throw new ContractViolation(`read during a live lease returned ${claimed.status}`);
  return claimed.prepared;
}

/** Records the source lock, its finality and the causally bound destination lock. */
async function recordLockRows(s: Leased, sourceExpiry = SOURCE_EXPIRY): Promise<void> {
  const lock = prepared(s.intent, "source-lock", "lock-s");
  const checkpoint = sourceFinality(lock, sourceExpiry);
  expectStatus(await s.store.recordPrepared({ ...writer(s), prepared: lock }), ["recorded"], "source lock");
  expectStatus(await s.store.recordSourceFinality({ ...writer(s), checkpoint }), ["recorded"], "source finality");
  expectStatus(await s.store.recordPrepared({
    ...writer(s),
    prepared: prepared(s.intent, "destination-lock", "lock-d", crossChainHtlcSourceFinalityCheckpointHash(checkpoint)),
  }), ["recorded"], "destination lock");
}

/**
 * Records under `s`'s lease every row and checkpoint `settlement(s.intent,
 * SOURCE_EXPIRY, hashSuffix)` names: the source lock and its finality
 * checkpoint, the bound destination lock, the reveal and its checkpoint, and a
 * source claim replaced once, so the settlement names the earlier attempt.
 */
async function recordSettledRows(s: Leased, hashSuffix = ""): Promise<void> {
  const row = (action: HtlcAction, txHash: string, sourceFinalityCheckpointHash?: string) =>
    prepared(s.intent, action, `${txHash}${hashSuffix}`, sourceFinalityCheckpointHash);
  const lock = row("source-lock", "lock-s");
  const finality = sourceFinality(lock);
  const reveal = row("destination-claim", "reveal-1");
  const claim = row("source-claim", "claim-1");
  expectStatus(await s.store.recordPrepared({ ...writer(s), prepared: lock }), ["recorded"], "source lock");
  expectStatus(await s.store.recordSourceFinality({ ...writer(s), checkpoint: finality }), ["recorded"], "source finality");
  expectStatus(await s.store.recordPrepared({
    ...writer(s),
    prepared: row("destination-lock", "lock-d", crossChainHtlcSourceFinalityCheckpointHash(finality)),
  }), ["recorded"], "destination lock");
  expectStatus(await s.store.recordPrepared({ ...writer(s), prepared: reveal }), ["recorded"], "reveal row");
  expectStatus(await s.store.recordRevealFinal({ ...writer(s), checkpoint: revealCheckpoint(reveal) }), ["recorded"], "reveal");
  expectStatus(await s.store.recordPrepared({ ...writer(s), prepared: claim }), ["recorded"], "source claim");
  expectStatus(await s.store.replacePreparedSourceClaim({
    ...writer(s), now: NOW, priorEffectHash: claim.effectHash,
    priorTxRef: claim.txRef as Extract<HtlcTxRef, { kind: "htlc-claim" }>,
    failedObservation: { state: "failed", txRef: claim.txRef, authenticationHash: AUTH_HASH },
    replacement: row("source-claim", "claim-2"),
  }), ["recorded"], "source-claim replacement");
}

/** A claim's intent, rows (in action order), claim histories and checkpoints, canonicalized. */
function retainedState(claimed: HtlcStoreClaim): string {
  if (claimed.status !== "waiting" && claimed.status !== "acquired" && claimed.status !== "settled") {
    throw new ContractViolation(`read of the retained state returned ${claimed.status}`);
  }
  return canonicalize({
    intent: claimed.intent,
    prepared: [...claimed.prepared].sort((x, y) => x.action.localeCompare(y.action)),
    sourceClaimAttemptHistory: claimed.sourceClaimAttemptHistory,
    destinationClaimAttemptHistory: claimed.destinationClaimAttemptHistory,
    sourceFinalityCheckpoint: claimed.sourceFinalityCheckpoint ?? null,
    revealCheckpoint: claimed.revealCheckpoint ?? null,
  });
}

type Case = (makeStore: () => CrossChainHtlcStore | Promise<CrossChainHtlcStore>) => Promise<void>;

const CASES: ReadonlyArray<readonly [string, Case]> = [
  ["lease: a live lease makes another owner wait, and an expired one is taken over at a higher generation", async (make) => {
    const a = await acquire(await make());
    const waiting = await a.store.claim({
      intent: a.intent, secrets: a.secrets, owner: "worker-b", now: a.lease.expiresAt - 1, leaseDurationMs: LEASE_MS,
    });
    expectStatus(waiting, ["waiting"], "claim during a live lease");
    if (waiting.status === "waiting") expectTrue(waiting.lease.owner === "worker-a", "waiting names the lease holder");
    const b = await takeOver(a);
    expectTrue(b.lease.owner === "worker-b" && b.lease.generation > a.lease.generation,
      "takeover gives the new owner a higher generation");
  }],
  ["lease: isCurrent holds only for the current owner, generation and binding before the lease expires", async (make) => {
    const a = await acquire(await make());
    const at = (over: Partial<ReturnType<typeof writer>> & { now?: number }) =>
      a.store.isCurrent({ ...writer(a), now: NOW, ...over });
    expectTrue(await at({}), "current owner is current");
    expectTrue(!(await at({ owner: "worker-x" })), "another owner is not current");
    expectTrue(!(await at({ generation: a.lease.generation + 1 })), "another generation is not current");
    expectTrue(!(await at({ bindingHash: "f".repeat(64) })), "another binding is not current");
    expectTrue(!(await at({ now: a.lease.expiresAt })), "a lease is not current at its expiry");
    const b = await takeOver(a);
    expectTrue(!(await at({ now: b.lease.expiresAt - 1 })), "the superseded generation is not current");
  }],
  ["lease: concurrent first claims acquire exactly one lease", async (make) => {
    const store = await make();
    const s = session();
    const results = await Promise.all(["worker-a", "worker-b"].map((owner) =>
      store.claim({ intent: s.intent, secrets: s.secrets, owner, now: NOW, leaseDurationMs: LEASE_MS })));
    expectTrue(results.filter((r) => r.status === "acquired").length === 1 &&
      results.filter((r) => r.status === "waiting").length === 1,
      `one acquired and one waiting, got ${results.map((r) => r.status).join(", ")}`);
  }],
  ["stale: every write from a superseded owner or generation is stale", async (make) => {
    const a = await acquire(await make());
    const lock = prepared(a.intent, "source-lock", "lock-s");
    const claim = prepared(a.intent, "source-claim", "claim-1");
    const reveal = prepared(a.intent, "destination-claim", "reveal-1");
    const b = await takeOver(a);
    const old = writer(a);
    const failed = (p: Readonly<HtlcPreparedAction>) => ({
      state: "failed" as const,
      txRef: p.txRef,
      authenticationHash: AUTH_HASH,
    });
    expectStatus(await a.store.recordPrepared({ ...old, prepared: lock }), ["stale"], "recordPrepared");
    expectStatus(await a.store.recordPrepared({ ...writer(b, { ...b.lease, generation: a.lease.generation }), prepared: lock }),
      ["stale"], "recordPrepared by the new owner at the old generation");
    expectStatus(await a.store.recordSourceFinality({ ...old, checkpoint: sourceFinality(lock) }), ["stale"], "recordSourceFinality");
    expectStatus(await a.store.recordRevealFinal({ ...old, checkpoint: revealCheckpoint(reveal) }), ["stale"], "recordRevealFinal");
    expectStatus(await a.store.recordSettlement({ ...old, settlement: settlement(a.intent) }), ["stale"], "recordSettlement");
    expectStatus(await a.store.replacePreparedSourceClaim({
      ...old, now: NOW, priorEffectHash: claim.effectHash,
      priorTxRef: claim.txRef as Extract<HtlcTxRef, { kind: "htlc-claim" }>,
      failedObservation: failed(claim), replacement: prepared(a.intent, "source-claim", "claim-2"),
    }), ["stale"], "replacePreparedSourceClaim");
    expectStatus(await a.store.replacePreparedDestinationClaim({
      ...old, now: NOW, priorEffectHash: reveal.effectHash,
      priorTxRef: reveal.txRef as Extract<HtlcTxRef, { kind: "htlc-reveal" }>,
      failedObservation: failed(reveal), replacement: prepared(a.intent, "destination-claim", "reveal-2"),
    }), ["stale"], "replacePreparedDestinationClaim");
    expectStatus(await b.store.replacePreparedSourceClaim({
      ...writer(b), now: b.lease.expiresAt, priorEffectHash: claim.effectHash,
      priorTxRef: claim.txRef as Extract<HtlcTxRef, { kind: "htlc-claim" }>,
      failedObservation: failed(claim), replacement: prepared(a.intent, "source-claim", "claim-2"),
    }), ["stale"], "replacePreparedSourceClaim by the current owner once its lease expired");
    expectStatus(await b.store.replacePreparedDestinationClaim({
      ...writer(b), now: b.lease.expiresAt, priorEffectHash: reveal.effectHash,
      priorTxRef: reveal.txRef as Extract<HtlcTxRef, { kind: "htlc-reveal" }>,
      failedObservation: failed(reveal), replacement: prepared(a.intent, "destination-claim", "reveal-2"),
    }), ["stale"], "replacePreparedDestinationClaim by the current owner once its lease expired");
    expectTrue((await retainedPrepared(b)).length === 0, "no stale write was retained");
  }],
  ["binding: another binding, salt or preimage for the session is a conflict", async (make) => {
    const a = await acquire(await make());
    const later = a.lease.expiresAt;
    for (const [label, s] of [
      ["binding", { intent: { ...a.intent, bindingHash: "f".repeat(64) }, secrets: a.secrets }],
      ["salt", { intent: a.intent, secrets: { ...a.secrets, buyerSaltHash: "f".repeat(64) } }],
      ["preimage", { intent: a.intent, secrets: { ...a.secrets, preimageHash: "f".repeat(64) } }],
    ] as const) {
      expectStatus(await a.store.claim({ intent: s.intent, secrets: s.secrets, owner: "worker-b", now: later, leaseDurationMs: LEASE_MS }),
        ["conflict"], `claim with another ${label}`);
    }
    await takeOver(a);
  }],
  ["salt: a buyer salt is never reused by another session", async (make) => {
    const store = await make();
    const salt = generateHtlcBuyerSalt();
    await acquire(store, session(JOB_IDS[0], salt));
    const other = session(JOB_IDS[1], salt);
    expectStatus(await store.claim({ intent: other.intent, secrets: other.secrets, owner: "worker-b", now: NOW, leaseDurationMs: LEASE_MS }),
      ["conflict"], "second session with the same salt");
  }],
  ["prepared: the same row is existing, another row for the action is a conflict, and the first is kept", async (make) => {
    const a = await acquire(await make());
    const first = prepared(a.intent, "source-lock", "lock-s");
    expectStatus(await a.store.recordPrepared({ ...writer(a), prepared: first }), ["recorded"], "first row");
    expectStatus(await a.store.recordPrepared({ ...writer(a), prepared: { ...first } }), ["existing"], "same row again");
    expectStatus(await a.store.recordPrepared({ ...writer(a), prepared: prepared(a.intent, "source-lock", "lock-other") }),
      REFUSED, "another row for the action");
    const kept = await retainedPrepared(a);
    expectTrue(kept.length === 1 && kept[0]!.effectHash === first.effectHash &&
      canonicalize(kept[0]) === canonicalize(first), "the first row is retained unchanged");
  }],
  ["prepared: a retained row does not change when the caller mutates its input or a returned row", async (make) => {
    const a = await acquire(await make());
    const original = prepared(a.intent, "source-lock", "lock-s");
    const input = { ...original, txRef: { ...original.txRef } } as HtlcPreparedAction;
    expectStatus(await a.store.recordPrepared({ ...writer(a), prepared: input }), ["recorded"], "first row");
    (input as { signedPayloadBase64: string }).signedPayloadBase64 = "bXV0YXRlZA==";
    (input.txRef as { lockTxHash?: string }).lockTxHash = "mutated";
    const returned = await retainedPrepared(a);
    try {
      (returned[0] as { signedPayloadBase64: string }).signedPayloadBase64 = "bXV0YXRlZA==";
    } catch {
      // A frozen row is the expected way to refuse this.
    }
    const kept = await retainedPrepared(a);
    expectTrue(kept.length === 1 && canonicalize(kept[0]) === canonicalize(original),
      "the retained row equals the recorded bytes");
  }],
  ["prepared: an effect or transaction recorded by another session is a conflict", async (make) => {
    const store = await make();
    const one = await acquire(store, session(JOB_IDS[0]));
    const two = await acquire(store, session(JOB_IDS[1]));
    const lock = prepared(one.intent, "source-lock", "lock-s");
    expectStatus(await store.recordPrepared({ ...writer(one), prepared: lock }), ["recorded"], "first session");
    expectStatus(await store.recordPrepared({ ...writer(two), prepared: lock }), REFUSED, "the same row");
    expectStatus(await store.recordPrepared({
      ...writer(two),
      prepared: { ...prepared(two.intent, "source-lock", "lock-two"), effectHash: lock.effectHash },
    }), REFUSED, "another row under the same effect hash");
    expectStatus(await store.recordPrepared({ ...writer(two), prepared: prepared(two.intent, "source-lock", "lock-s") }),
      REFUSED, "the same transaction");
  }],
  ["source finality: a destination lock needs the retained checkpoint, and no other action carries one", async (make) => {
    const a = await acquire(await make());
    const lock = prepared(a.intent, "source-lock", "lock-s");
    const checkpoint = sourceFinality(lock);
    const hash = crossChainHtlcSourceFinalityCheckpointHash(checkpoint);
    expectStatus(await a.store.recordPrepared({ ...writer(a), prepared: prepared(a.intent, "destination-lock", "lock-d", hash) }),
      REFUSED, "destination lock before the checkpoint");
    expectStatus(await a.store.recordPrepared({ ...writer(a), prepared: lock }), ["recorded"], "source lock");
    expectStatus(await a.store.recordSourceFinality({ ...writer(a), checkpoint: { ...checkpoint, sourceLockEffectHash: "f".repeat(64) } }),
      REFUSED, "checkpoint of another source lock");
    expectStatus(await a.store.recordSourceFinality({ ...writer(a), checkpoint }), ["recorded"], "checkpoint");
    expectStatus(await a.store.recordSourceFinality({ ...writer(a), checkpoint: { ...checkpoint } }), ["existing"], "same checkpoint");
    expectStatus(await a.store.recordSourceFinality({ ...writer(a), checkpoint: { ...checkpoint, finalityObservedAt: NOW + 900 } }),
      REFUSED, "another checkpoint");
    expectStatus(await a.store.recordPrepared({ ...writer(a), prepared: prepared(a.intent, "destination-lock", "lock-d", "f".repeat(64)) }),
      REFUSED, "destination lock bound to another checkpoint");
    expectStatus(await a.store.recordPrepared({ ...writer(a), prepared: prepared(a.intent, "source-claim", "claim-1", hash) }),
      REFUSED, "source claim carrying a checkpoint binding");
    expectStatus(await a.store.recordPrepared({ ...writer(a), prepared: prepared(a.intent, "destination-lock", "lock-d", hash) }),
      ["recorded"], "destination lock bound to the checkpoint");
  }],
  ["reveal: the reveal checkpoint is write-once, and a source refund is refused after it", async (make) => {
    const a = await acquire(await make());
    await recordLockRows(a);
    const reveal = prepared(a.intent, "destination-claim", "reveal-1");
    expectStatus(await a.store.recordPrepared({ ...writer(a), prepared: reveal }), ["recorded"], "reveal row");
    const checkpoint = revealCheckpoint(reveal);
    expectStatus(await a.store.recordRevealFinal({ ...writer(a), checkpoint }), ["recorded"], "reveal checkpoint");
    expectStatus(await a.store.recordRevealFinal({ ...writer(a), checkpoint: { ...checkpoint } }), ["existing"], "same checkpoint");
    expectStatus(await a.store.recordRevealFinal({ ...writer(a), checkpoint: { ...checkpoint, finalityObservedAt: NOW + 900 } }),
      REFUSED, "another checkpoint");
    expectStatus(await a.store.recordPrepared({ ...writer(a), prepared: prepared(a.intent, "source-refund", "refund-s") }),
      REFUSED, "source refund after the reveal");
  }],
  ["settlement: it needs the reveal checkpoint and its expiry, is write-once, ends the session, and is claimed with its rows", async (make) => {
    const a = await acquire(await make());
    const done = settlement(a.intent);
    expectStatus(await a.store.recordSettlement({ ...writer(a), settlement: done }), REFUSED, "settlement before the reveal");
    await recordSettledRows(a);
    const retained = retainedState(await a.store.claim({
      intent: a.intent, secrets: a.secrets, owner: "reader", now: NOW, leaseDurationMs: LEASE_MS,
    }));
    expectStatus(await a.store.recordSettlement({ ...writer(a), settlement: settlement(a.intent, SOURCE_EXPIRY + 1) }),
      REFUSED, "settlement with another source expiry");
    expectStatus(await a.store.recordSettlement({ ...writer(a), settlement: { ...done, txRefs: done.txRefs.slice(1) } }),
      REFUSED, "settlement without the source lock");
    expectStatus(await a.store.recordSettlement({ ...writer(a), settlement: done }), ["recorded"], "settlement");
    expectStatus(await a.store.recordSettlement({ ...writer(a), settlement: { ...done } }), ["existing"], "same settlement");
    expectStatus(await a.store.recordSettlement({ ...writer(a), settlement: { ...done, authenticationHash: "d".repeat(64) } }),
      REFUSED, "another settlement");
    const claimed = await a.store.claim({
      intent: a.intent, secrets: a.secrets, owner: "worker-b", now: a.lease.expiresAt, leaseDurationMs: LEASE_MS,
    });
    expectStatus(claimed, ["settled"], "claim after settlement");
    if (claimed.status === "settled") {
      expectTrue(canonicalize(claimed.settlement) === canonicalize(done), "claim returns the recorded settlement");
      // The core replays a settlement only against the rows it names.
      expectTrue(retainedState(claimed) === retained, "claim returns the retained rows and checkpoints with the settlement");
    }
    expectTrue(!(await a.store.isCurrent({ ...writer(a), now: NOW })), "a settled session has no current lease");
  }],
  ["source-claim CAS: only the named prior is replaced, by a fresh row, within the window and the limit", async (make) => {
    const a = await acquire(await make());
    await recordLockRows(a);
    const attempt = (n: number) => prepared(a.intent, "source-claim", `claim-${n}`);
    const cas = (prior: Readonly<HtlcPreparedAction>, replacement: Readonly<HtlcPreparedAction>, now = NOW) =>
      a.store.replacePreparedSourceClaim({
        ...writer(a), now, priorEffectHash: prior.effectHash,
        priorTxRef: prior.txRef as Extract<HtlcTxRef, { kind: "htlc-claim" }>,
        failedObservation: { state: "failed", txRef: prior.txRef, authenticationHash: AUTH_HASH },
        replacement,
      });
    const reveal = prepared(a.intent, "destination-claim", "reveal-1");
    expectStatus(await a.store.recordPrepared({ ...writer(a), prepared: reveal }), ["recorded"], "reveal row");
    expectStatus(await a.store.recordPrepared({ ...writer(a), prepared: attempt(1) }), ["recorded"], "first claim");
    expectStatus(await cas(attempt(1), attempt(2)), REFUSED, "replacement before the reveal checkpoint");
    expectStatus(await a.store.recordRevealFinal({ ...writer(a), checkpoint: revealCheckpoint(reveal) }), ["recorded"], "reveal");
    expectStatus(await cas(attempt(9), attempt(2)), REFUSED, "replacement naming another prior");
    const naming = (effect: Readonly<HtlcPreparedAction>, ref: Readonly<HtlcPreparedAction>) =>
      a.store.replacePreparedSourceClaim({
        ...writer(a), now: NOW, priorEffectHash: effect.effectHash,
        priorTxRef: ref.txRef as Extract<HtlcTxRef, { kind: "htlc-claim" }>,
        failedObservation: { state: "failed", txRef: attempt(1).txRef, authenticationHash: AUTH_HASH },
        replacement: attempt(2),
      });
    expectStatus(await naming(attempt(9), attempt(1)), REFUSED, "replacement naming the prior's reference under another effect");
    expectStatus(await naming(attempt(1), attempt(9)), REFUSED, "replacement naming the prior's effect with another reference");
    expectStatus(await cas(attempt(1), attempt(1)), REFUSED, "replacement equal to the prior");
    expectStatus(await cas(attempt(1), attempt(2)), ["recorded"], "replacement 1");
    expectStatus(await cas(attempt(1), attempt(3)), REFUSED, "replaying the CAS on the replaced prior");
    expectStatus(await cas(attempt(2), attempt(1)), REFUSED, "replacement reusing an earlier attempt");
    const kept = await retainedPrepared(a);
    expectTrue(kept.some((p) => p.action === "source-claim" && p.effectHash === attempt(2).effectHash),
      "the replacement is the active claim");
    const b = await acquire(a.store, a, `worker-${a.lease.generation + 9}`, NOW + 3 * LEASE_MS);
    const casB = (prior: Readonly<HtlcPreparedAction>, replacement: Readonly<HtlcPreparedAction>, now: number) =>
      b.store.replacePreparedSourceClaim({
        ...writer(b), now, priorEffectHash: prior.effectHash,
        priorTxRef: prior.txRef as Extract<HtlcTxRef, { kind: "htlc-claim" }>,
        failedObservation: { state: "failed", txRef: prior.txRef, authenticationHash: AUTH_HASH },
        replacement,
      });
    const at = NOW + 3 * LEASE_MS;
    expectStatus(await casB(attempt(2), attempt(3), at), ["recorded"], "replacement 2");
    expectStatus(await casB(attempt(3), attempt(4), at), ["recorded"], "replacement 3");
    expectStatus(await casB(attempt(4), attempt(5), at), REFUSED, "a replacement past the limit");
  }],
  ["source-claim CAS: no replacement at or after the source expiry", async (make) => {
    const a = await acquire(await make());
    const expiry = Math.floor((NOW + LEASE_MS / 2) / 1_000);
    await recordLockRows(a, expiry);
    const reveal = prepared(a.intent, "destination-claim", "reveal-1");
    expectStatus(await a.store.recordPrepared({ ...writer(a), prepared: reveal }), ["recorded"], "reveal row");
    expectStatus(await a.store.recordRevealFinal({ ...writer(a), checkpoint: revealCheckpoint(reveal, expiry) }),
      ["recorded"], "reveal");
    const first = prepared(a.intent, "source-claim", "claim-1");
    expectStatus(await a.store.recordPrepared({ ...writer(a), prepared: first }), ["recorded"], "first claim");
    expectStatus(await a.store.replacePreparedSourceClaim({
      ...writer(a), now: expiry * 1_000, priorEffectHash: first.effectHash,
      priorTxRef: first.txRef as Extract<HtlcTxRef, { kind: "htlc-claim" }>,
      failedObservation: { state: "failed", txRef: first.txRef, authenticationHash: AUTH_HASH },
      replacement: prepared(a.intent, "source-claim", "claim-2"),
    }), REFUSED, "replacement at the source expiry");
  }],
  ["destination-claim CAS: refused without source finality, after a refund or after the reveal checkpoint", async (make) => {
    const store = await make();
    const setup = async (jobId: string, withFinality: boolean) => {
      const s = await acquire(store, session(jobId), `worker-${jobId}`);
      const lock = prepared(s.intent, "source-lock", `lock-s-${jobId}`);
      expectStatus(await store.recordPrepared({ ...writer(s), prepared: lock }), ["recorded"], "source lock");
      if (withFinality) {
        expectStatus(await store.recordSourceFinality({ ...writer(s), checkpoint: sourceFinality(lock) }), ["recorded"], "finality");
      }
      const reveal = (n: number) => prepared(s.intent, "destination-claim", `reveal-${n}-${jobId}`);
      expectStatus(await store.recordPrepared({ ...writer(s), prepared: reveal(1) }), ["recorded"], "reveal");
      const cas = (prior: number, next: number, named = { effect: prior, ref: prior }) =>
        store.replacePreparedDestinationClaim({
          ...writer(s), now: NOW, priorEffectHash: reveal(named.effect).effectHash,
          priorTxRef: reveal(named.ref).txRef as Extract<HtlcTxRef, { kind: "htlc-reveal" }>,
          failedObservation: { state: "failed", txRef: reveal(prior).txRef, authenticationHash: AUTH_HASH },
          replacement: reveal(next),
        });
      return { s, reveal, cas };
    };
    const noFinality = await setup(JOB_IDS[0], false);
    expectStatus(await noFinality.cas(1, 2), REFUSED, "replacement without source finality");
    const refunded = await setup(JOB_IDS[1], true);
    expectStatus(await store.recordPrepared({ ...writer(refunded.s), prepared: prepared(refunded.s.intent, "destination-refund", "refund-d") }),
      ["recorded"], "destination refund");
    expectStatus(await refunded.cas(1, 2), REFUSED, "replacement after a refund");
    const revealed = await setup(JOB_IDS[2], true);
    expectStatus(await revealed.cas(1, 1), REFUSED, "replacement equal to the prior");
    expectStatus(await revealed.cas(1, 2, { effect: 3, ref: 1 }), REFUSED,
      "replacement naming the prior's reference under another effect");
    expectStatus(await revealed.cas(1, 2, { effect: 1, ref: 3 }), REFUSED,
      "replacement naming the prior's effect with another reference");
    expectStatus(await revealed.cas(1, 2), ["recorded"], "replacement");
    expectStatus(await revealed.cas(1, 3), REFUSED, "replaying the CAS on the replaced prior");
    expectStatus(await store.recordRevealFinal({ ...writer(revealed.s), checkpoint: revealCheckpoint(revealed.reveal(2)) }),
      ["recorded"], "reveal checkpoint");
    expectStatus(await revealed.cas(2, 3), REFUSED, "replacement after the reveal checkpoint");
  }],
  ["concurrency: concurrent writes of two rows for one action record exactly one", async (make) => {
    const a = await acquire(await make());
    const results = await Promise.all(["lock-x", "lock-y"].map((hash) =>
      a.store.recordPrepared({ ...writer(a), prepared: prepared(a.intent, "source-lock", hash) })));
    expectTrue(results.filter((r) => r.status === "recorded").length === 1 &&
      results.filter((r) => r.status === "conflict" || r.status === "corrupt").length === 1,
      `one recorded and one refused, got ${results.map((r) => r.status).join(", ")}`);
  }],
];

const RESTART_CASE = "restart: a reopened store keeps the lease, rows, checkpoints, claim histories, secret bindings and settlement";

function restartCase(reopen: CrossChainHtlcStoreCheckOptions["reopen"]): readonly [string, Case] {
  return [RESTART_CASE, async (make) => {
    // A store whose state does not survive a restart can lose a reveal or
    // lock row and lead the core to a second lock or an unsafe refund.
    if (reopen === undefined) throw new ContractViolation("not checked: no reopen hook");
    const store = await make();
    const a = await acquire(store, session(JOB_IDS[0]));
    const lock = prepared(a.intent, "source-lock", "lock-s");
    const finality = sourceFinality(lock);
    const reveal = (n: number) => prepared(a.intent, "destination-claim", `reveal-${n}`);
    const claim = (n: number) => prepared(a.intent, "source-claim", `claim-${n}`);
    const failed = (p: Readonly<HtlcPreparedAction>) => ({
      state: "failed" as const,
      txRef: p.txRef,
      authenticationHash: AUTH_HASH,
    });
    expectStatus(await store.recordPrepared({ ...writer(a), prepared: lock }), ["recorded"], "source lock");
    expectStatus(await store.recordSourceFinality({ ...writer(a), checkpoint: finality }), ["recorded"], "source finality");
    expectStatus(await store.recordPrepared({
      ...writer(a),
      prepared: prepared(a.intent, "destination-lock", "lock-d", crossChainHtlcSourceFinalityCheckpointHash(finality)),
    }), ["recorded"], "destination lock");
    expectStatus(await store.recordPrepared({ ...writer(a), prepared: reveal(1) }), ["recorded"], "reveal");
    expectStatus(await store.replacePreparedDestinationClaim({
      ...writer(a), now: NOW, priorEffectHash: reveal(1).effectHash,
      priorTxRef: reveal(1).txRef as Extract<HtlcTxRef, { kind: "htlc-reveal" }>,
      failedObservation: failed(reveal(1)), replacement: reveal(2),
    }), ["recorded"], "reveal replacement");
    expectStatus(await store.recordRevealFinal({ ...writer(a), checkpoint: revealCheckpoint(reveal(2)) }),
      ["recorded"], "reveal checkpoint");
    expectStatus(await store.recordPrepared({ ...writer(a), prepared: claim(1) }), ["recorded"], "source claim");
    expectStatus(await store.replacePreparedSourceClaim({
      ...writer(a), now: NOW, priorEffectHash: claim(1).effectHash,
      priorTxRef: claim(1).txRef as Extract<HtlcTxRef, { kind: "htlc-claim" }>,
      failedObservation: failed(claim(1)), replacement: claim(2),
    }), ["recorded"], "source-claim replacement");
    const settled = await acquire(store, session(JOB_IDS[1]), "worker-c");
    const done = settlement(settled.intent, SOURCE_EXPIRY, "-two");
    await recordSettledRows(settled, "-two");
    expectStatus(await store.recordSettlement({ ...writer(settled), settlement: done }), ["recorded"], "settlement");
    const settledBefore = retainedState(await store.claim({
      intent: settled.intent, secrets: settled.secrets, owner: "reader", now: NOW, leaseDurationMs: LEASE_MS,
    }));
    const read = (from: CrossChainHtlcStore) => from.claim({
      intent: a.intent, secrets: a.secrets, owner: "reader", now: a.lease.expiresAt - 1, leaseDurationMs: LEASE_MS,
    });
    const before = retainedState(await read(store));

    const reopened = await reopen(store);
    const waiting = await read(reopened);
    expectStatus(waiting, ["waiting"], "claim during the live lease after reopening");
    if (waiting.status === "waiting") {
      expectTrue(canonicalize(waiting.lease) === canonicalize(a.lease), "the live lease survives unchanged");
    }
    expectTrue(retainedState(waiting) === before, "the intent, rows, checkpoints and claim histories survive unchanged");
    expectTrue(await reopened.isCurrent({ ...writer(a), now: NOW }), "the lease holder is still current");
    for (const [label, secrets] of [
      ["salt", { ...a.secrets, buyerSaltHash: "f".repeat(64) }],
      ["preimage", { ...a.secrets, preimageHash: "f".repeat(64) }],
    ] as const) {
      expectStatus(await reopened.claim({
        intent: a.intent, secrets, owner: "worker-x", now: a.lease.expiresAt, leaseDurationMs: LEASE_MS,
      }), ["conflict"], `claim with another ${label} after reopening`);
    }
    const reused = session(JOB_IDS[2], a.secrets.buyerSalt);
    expectStatus(await reopened.claim({
      intent: reused.intent, secrets: reused.secrets, owner: "worker-x", now: NOW, leaseDurationMs: LEASE_MS,
    }), ["conflict"], "another session with the same salt after reopening");

    const takeover = await reopened.claim({
      intent: a.intent, secrets: a.secrets, owner: "worker-b", now: a.lease.expiresAt, leaseDurationMs: LEASE_MS,
    });
    expectStatus(takeover, ["acquired"], "takeover after reopening");
    if (takeover.status !== "acquired") throw new ContractViolation("unreachable");
    expectTrue(takeover.lease.generation > a.lease.generation, "a takeover after reopening gets a higher generation");
    expectTrue(retainedState(takeover) === before, "a takeover after reopening returns the same retained state");
    const b: Leased = { ...a, store: reopened, lease: takeover.lease };
    expectStatus(await reopened.recordPrepared({ ...writer(a), prepared: prepared(a.intent, "destination-refund", "refund-d") }),
      ["stale"], "a write from the generation before the restart");
    expectStatus(await reopened.recordPrepared({ ...writer(b), prepared: lock }), ["existing"], "the retained source lock again");
    expectStatus(await reopened.recordPrepared({ ...writer(b), prepared: prepared(a.intent, "source-lock", "lock-other") }),
      REFUSED, "another source lock");
    expectStatus(await reopened.recordSourceFinality({ ...writer(b), checkpoint: { ...finality, finalityObservedAt: NOW + 900 } }),
      REFUSED, "another source-finality checkpoint");
    expectStatus(await reopened.recordRevealFinal({
      ...writer(b), checkpoint: { ...revealCheckpoint(reveal(2)), finalityObservedAt: NOW + 900 },
    }), REFUSED, "another reveal checkpoint");
    expectStatus(await reopened.recordPrepared({ ...writer(b), prepared: prepared(a.intent, "source-refund", "refund-s") }),
      REFUSED, "a source refund after the retained reveal checkpoint");

    const other = await acquire(reopened, session(JOB_IDS[2]), "worker-d");
    expectStatus(await reopened.recordPrepared({ ...writer(other), prepared: prepared(other.intent, "source-lock", "lock-s") }),
      REFUSED, "another session's row with a retained transaction");
    expectStatus(await reopened.recordPrepared({
      ...writer(other),
      prepared: { ...prepared(other.intent, "source-lock", "lock-three"), effectHash: lock.effectHash },
    }), REFUSED, "another session's row under a retained effect hash");
    const settledClaim = await reopened.claim({
      intent: settled.intent, secrets: settled.secrets, owner: "worker-e", now: settled.lease.expiresAt, leaseDurationMs: LEASE_MS,
    });
    expectStatus(settledClaim, ["settled"], "claim of the settled session after reopening");
    if (settledClaim.status === "settled") {
      expectTrue(canonicalize(settledClaim.settlement) === canonicalize(done), "the settlement survives unchanged");
      expectTrue(retainedState(settledClaim) === settledBefore, "the settled session's rows and checkpoints survive unchanged");
    }
  }];
}

/**
 * Run the `CrossChainHtlcStore` contract against a host store. `makeStore`
 * must return a new, empty store on every call. Each case reports `ok`, or
 * the first broken expectation in `detail`. The cases cover lease ownership
 * and generations, stale writes, binding and salt conflicts, write-once rows
 * and checkpoints (`existing` only for the identical row), cross-session
 * effect and transaction reuse, the source-finality binding of a destination
 * lock, the reveal/refund exclusion, both replacement CASes and concurrent
 * workers. A store that fails any case can make the core send twice.
 *
 * The restart case needs `options.reopen`. It drives one session to a
 * replaced reveal and a replaced source claim with both checkpoints, and
 * settles another over every row and checkpoint its settlement names, then
 * reopens the store. The reopened store must return the
 * same live lease, intent, rows, checkpoints and claim histories, a higher
 * generation on takeover, and the same settlement. It must still refuse the
 * old generation, another salt or preimage, a reused salt, effect or
 * transaction, and a second row or checkpoint. Without `reopen` that case
 * fails (`not checked: no reopen hook`): nothing else shows that state
 * survives a restart, so a store passes the kit only with every case `ok`,
 * restart included. No case proves encryption or atomicity across processes;
 * those remain the host's to test.
 */
export async function checkCrossChainHtlcStore(
  makeStore: () => CrossChainHtlcStore | Promise<CrossChainHtlcStore>,
  options: Readonly<CrossChainHtlcStoreCheckOptions> = {},
): Promise<readonly CrossChainHtlcStoreCheck[]> {
  const results: CrossChainHtlcStoreCheck[] = [];
  for (const [name, run] of [...CASES, restartCase(options?.reopen)]) {
    try {
      await run(makeStore);
      results.push(Object.freeze({ name, ok: true }));
    } catch (error) {
      results.push(Object.freeze({
        name,
        ok: false,
        detail: error instanceof ContractViolation ? error.message : `threw: ${String(error)}`,
      }));
    }
  }
  return Object.freeze(results);
}
