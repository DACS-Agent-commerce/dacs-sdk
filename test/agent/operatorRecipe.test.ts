import { linkSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { createFsSessionStore } from "../../src/agent/sessionStoreFs.js";
import {
  runSessionCore,
  type SessionDeps,
} from "../../src/agent/runSessionCore.js";
import type { SettleRequest, SettleResult } from "../../src/rails/settlementTypes.js";
import { buildSignedArtifact, type Signer } from "../../src/agent/signedArtifact.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import type { IdentityBundle } from "../../src/artifacts/types.js";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "../../src/crypto/index.js";
import {
  createIdempotencyStore,
  createInMemorySettlementLog,
  isSettlementBridge,
  settlementKey,
  type SettlementLog,
} from "../../src/rails/idempotency.js";
import {
  payDemSettle,
  withRecoveredAttempts,
  type PayDemRail,
  type PayDemRailResult,
  type PayDemReconciledSettlement,
  type PayDemSettlementReconcile,
} from "../../src/rails/payDem.js";

// These tests drive the real bridge, store and session with a fake chain.
vi.mock("../../src/rails/payDemExecutionAuthority.js", async () =>
  import("../support/payDemExecutionAuthority.js"));

const seed = Uint8Array.from(Buffer.alloc(32, 7));
const priv = privateKeyFromSeed(seed);
const sign: Signer = (bytes) => ed25519Sign(bytes, priv);
const sellerHex = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex");
const sellerDid = `did:demos:agent:${sellerHex}`;
const buyerDid = "did:demos:buyer";
const buyerIdentity: IdentityBundle = {
  bundleVersion: "1",
  presentedBy: buyerDid,
  presentedAt: 1_780_000_000_000,
  claims: [{ ref: buyerDid }],
  presentation: { kind: "per-claim", signatures: [{ ref: buyerDid, signature: "test-presentation" }] },
};
const listing = {
  agentId: sellerDid,
  serviceId: "svc",
  name: "n",
  description: "d",
  claimRequirements: [],
  supportedNegotiation: ["negotiate-fixed-price"],
  supportedPaymentRails: ["pay-dem"],
  supportedDelivery: ["deliver-attested-payload"],
};
const terms = {
  price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" },
  deliveryPhase: "deliver-attested-payload",
  deliveryFormat: "application/json",
};

const LISTING_REF = "stor:listing";
const FIRST_JOB = "job-1";
const REBUY_JOB = "job-2";
const PAYER_ADDRESS = "ab".repeat(32);
const NETWORK = "demos";
const BLOCK_NUMBER = 42;
const RESTART_DELAY_MS = 60 * 60 * 1000;
const CRASH = /simulated crash/;
const NOT_YET_INCLUDED = /not yet included/;
const NONCE_TAKEN = /nonce was used by another transaction/;
/** An intent with no outcome and no retained hash refuses to resubmit; the store words it by what it last saw. */
const NO_OUTCOME_TO_RECOVER = /refusing to resubmit|operator action required/;
const SLOW_TEST_MS = 30_000;

interface PreparedRecord {
  txHash: string;
  nonce: number;
  key: string;
  payee: string;
  amountOs: string;
}

/** What the chain, the prepared-transfer journal and the stores keep across a process death. */
interface World {
  journal: PreparedRecord[];
  executed: Map<string, number>;
  pending: Map<string, number>;
  nextNonce: number;
  confirmedNonce: number;
  hashes: number;
  railCalls: number;
  nodeReadsFail: boolean;
  clockMs: number;
  kv: Map<string, Record<string, unknown>>;
  log: SettlementLog;
  sessionDir: string;
}

type RailFault = "after-journal" | "pending-then-lost" | "lost-after-broadcast";
type LogFault = "put-outcome-before" | "put-outcome-after";
type StoreFault = "bind-transaction-before" | "bind-transaction-after" | "transition-after-payment";
type JournalHook = "records" | "records-nothing";

interface ProcessOptions {
  jobId?: string;
  hook?: JournalHook;
  railFault?: RailFault;
  logFault?: LogFault;
  storeFault?: StoreFault;
}

async function createWorld(): Promise<World> {
  const kv = new Map<string, Record<string, unknown>>();
  kv.set(LISTING_REF, (await buildSignedArtifact(listing, ARTIFACT_SEPARATORS.Listing, sign)) as Record<string, unknown>);
  return {
    journal: [], executed: new Map(), pending: new Map(), nextNonce: 0, confirmedNonce: 0, hashes: 0,
    railCalls: 0, nodeReadsFail: false, clockMs: 1_780_000_000_000, kv,
    log: createInMemorySettlementLog(),
    sessionDir: mkdtempSync(join(tmpdir(), "dacs-recipe-")),
  };
}

const crash = (point: string) => new Error(`simulated crash: ${point}`);

/** A transaction the chain has executed: it advances the account's confirmed nonce. */
function execute(world: World, txHash: string, nonce: number): void {
  world.pending.delete(txHash);
  world.executed.set(txHash, nonce);
  world.confirmedNonce = Math.max(world.confirmedNonce, nonce + 1);
}

/** Another transaction from the same account uses `nonce`; the pending transfer can never land. */
function consumeNonceByOther(world: World, nonce: number): void {
  world.confirmedNonce = Math.max(world.confirmedNonce, nonce + 1);
  for (const [txHash, pendingNonce] of world.pending) if (pendingNonce === nonce) world.pending.delete(txHash);
}

function fakeRail(world: World, options: ProcessOptions): PayDemRail {
  return {
    address: PAYER_ADDRESS,
    async settle(params): Promise<PayDemRailResult> {
      world.railCalls += 1;
      world.hashes += 1;
      const txHash = String(world.hashes).padStart(64, "a");
      const nonce = world.nextNonce;
      world.nextNonce += 1;
      if (options.hook !== "records-nothing" && params.recovery !== undefined) {
        world.journal.push({ txHash, nonce, key: params.recovery.settlementKey, payee: params.recipient, amountOs: params.amount });
      }
      if (options.railFault === "after-journal") throw crash("after the journal record, before broadcast");
      if (options.railFault === "pending-then-lost") {
        world.pending.set(txHash, nonce);
        throw crash("broadcast accepted, answer lost");
      }
      execute(world, txHash, nonce);
      if (options.railFault === "lost-after-broadcast") throw crash("after broadcast, before the outcome is saved");
      return {
        ok: true, execution: "executed", txHash, chainId: NETWORK, payer: PAYER_ADDRESS, payee: params.recipient,
        finality: { model: "bft-final" }, blockNumber: BLOCK_NUMBER, txRefKind: "demos",
      };
    },
  };
}

/** The operator's chain reader: only an executed transaction completes; everything else is thrown, never `null`. */
function chainReconcile(world: World): PayDemSettlementReconcile {
  return async (context): Promise<PayDemReconciledSettlement | null> => {
    if (context.txHash === undefined) return null;
    if (world.nodeReadsFail) throw new Error("node timeout while reading the transaction");
    const record = world.journal.find((entry) => entry.txHash === context.txHash);
    if (record === undefined) throw new Error("retained transaction is absent from the prepared-transfer journal");
    if (record.key !== context.settlementKey || record.payee !== context.payee || record.amountOs !== context.amountOs) {
      throw new Error("prepared-transfer journal conflicts with the settlement being recovered");
    }
    if (!world.executed.has(record.txHash)) {
      if (world.confirmedNonce > record.nonce) throw new Error("the prepared nonce was used by another transaction");
      throw new Error("the prepared transfer is not yet included");
    }
    return {
      ok: true, execution: "executed", amountOs: record.amountOs, txHash: record.txHash, chainId: NETWORK,
      payer: context.payer, payee: context.payee, finality: { model: "bft-final" }, blockNumber: BLOCK_NUMBER, txRefKind: "demos",
    };
  };
}

/** The transaction hashes the operator reads from the prepared-transfer journal for one settlement. */
function journalAttempts(world: World) {
  return async (req: Readonly<SettleRequest>) =>
    world.journal
      .filter((entry) => entry.key === settlementKey(req.rail, req.jobId, req.phaseIndex ?? 0))
      .map((entry) => ({ txHash: entry.txHash, chainId: NETWORK, ok: false }));
}

function faultyLog(log: SettlementLog, fault: LogFault | undefined): SettlementLog {
  if (fault === undefined) return log;
  return {
    ...log,
    putOutcome: async (input) => {
      if (fault === "put-outcome-before") throw crash("before the outcome is recorded");
      await log.putOutcome(input);
      throw crash("after the outcome is recorded");
    },
  };
}

async function sessionStoreFor(world: World, fault: StoreFault | undefined) {
  const store = await createFsSessionStore({ dir: world.sessionDir });
  if (fault === undefined) return store;
  return {
    ...store,
    bindHash: async (input: Parameters<typeof store.bindHash>[0]) => {
      if (input.kind !== "transaction") return store.bindHash(input);
      if (fault === "bind-transaction-before") throw crash("before the transaction hash is bound");
      if (fault === "bind-transaction-after") {
        await store.bindHash(input);
        throw crash("after the transaction hash is bound");
      }
      return store.bindHash(input);
    },
    transition: async (input: Parameters<typeof store.transition>[0]) => {
      if (fault === "transition-after-payment" && world.executed.size > 0) {
        throw crash("before the session is moved past settlement");
      }
      return store.transition(input);
    },
  };
}

/** One process: a fresh bridge, rail handle and store handle over the world's durable state. */
async function startProcess(
  world: World,
  options: ProcessOptions = {},
  reconcile: PayDemSettlementReconcile = chainReconcile(world),
) {
  world.clockMs += RESTART_DELAY_MS;
  const rail = fakeRail(world, options);
  const store = createIdempotencyStore(faultyLog(world.log, options.logFault), { now: () => world.clockMs });
  const bridge = payDemSettle(rail, {}, { store, reconcile });
  const deps = (resumeSettlement?: SessionDeps["resumeSettlement"]): SessionDeps => ({
    buyerId: buyerDid,
    buyerIdentityBundle: buyerIdentity,
    authenticateBuyerIdentityBundle: () => true,
    readListing: async (ref) => world.kv.get(ref) ?? null,
    sign: (artifact, separator) => buildSignedArtifact(artifact, separator as never, sign),
    signBytes: async (bytes) => sign(bytes),
    resolveAnchor: async (name) => {
      const ref = `stor:${name}`;
      const value = world.kv.get(ref);
      return value ? { status: "present" as const, ref, value } : { status: "absent" as const };
    },
    anchor: async (name, value) => {
      world.kv.set(`stor:${name}`, value as Record<string, unknown>);
      return `stor:${name}`;
    },
    settle: bridge,
    ...(resumeSettlement === undefined ? {} : { resumeSettlement }),
    newJobId: () => options.jobId ?? FIRST_JOB,
    now: () => "2026-01-01T00:00:00Z",
    nowMs: () => world.clockMs,
    trustListing: true,
    authenticateRecoveredArtifact: () => true,
  });
  const sessionStore = await sessionStoreFor(world, options.storeFault);
  const run = (resumeSettlement?: SessionDeps["resumeSettlement"], resumeJobId?: string) =>
    runSessionCore(LISTING_REF, terms, { ...deps(resumeSettlement), sessionStore }, resumeJobId);
  return {
    rail,
    bridge,
    firstRun: () => run(bridge),
    plainResume: () => run(bridge, FIRST_JOB),
    recipe: (jobId = FIRST_JOB) => run(withRecoveredAttempts(bridge, journalAttempts(world)), jobId),
  };
}

const PAID_CUTS: ReadonlyArray<[string, ProcessOptions]> = [
  ["outcome not recorded", { logFault: "put-outcome-before" }],
  ["outcome recorded, answer lost", { logFault: "put-outcome-after" }],
  ["hash not bound", { storeFault: "bind-transaction-before" }],
  ["hash bound, then death", { storeFault: "bind-transaction-after" }],
  ["session not moved past settlement", { storeFault: "transition-after-payment" }],
  ["broadcast answer lost", { railFault: "lost-after-broadcast" }],
];

describe("withRecoveredAttempts", () => {
  const hash = "12".repeat(32);
  const request: SettleRequest = {
    rail: "pay-dem", phase: "pay-dem", phaseIndex: 0, jobId: FIRST_JOB,
    amount: "1", asset: "DEM", payee: sellerDid, expectedPayee: sellerDid,
  };
  const stubBridge = () => {
    const seen: SettleRequest[] = [];
    const bridge = payDemSettle({ address: PAYER_ADDRESS, settle: vi.fn() }, {}, {
      store: createIdempotencyStore(createInMemorySettlementLog()),
      reconcile: async () => null,
    });
    const forwarding = vi.fn(async (req: SettleRequest): Promise<SettleResult> => {
      seen.push(req);
      throw new Error("stop");
    });
    return { bridge, forwarding, seen };
  };

  test("withRecoveredAttempts adds journal history to a recovery request and keeps the registration", async () => {
    const { bridge, forwarding, seen } = stubBridge();
    const wrapped = withRecoveredAttempts(bridge, async () => [{ txHash: hash, chainId: NETWORK, ok: false }]);
    expect(isSettlementBridge(wrapped)).toBe(true);
    expect(wrapped).not.toBe(bridge);
    await expect(wrapped({ ...request, recoveryOnly: true })).rejects.toThrow(/proof of absence/);

    const forwarded = withRecoveredAttempts(forwarding, async () => [{ txHash: hash, chainId: NETWORK, ok: false }]);
    await expect(forwarded({ ...request, recoveryOnly: true })).rejects.toThrow("stop");
    expect(seen[0]?.priorAttempts).toEqual([{ txHash: hash, chainId: NETWORK, ok: false }]);
    expect(isSettlementBridge(forwarded)).toBe(false);
  });

  test("withRecoveredAttempts leaves a request that is not a recovery, or already has history, untouched", async () => {
    const { forwarding, seen } = stubBridge();
    const attempts = vi.fn(async () => [{ txHash: hash, chainId: NETWORK, ok: false }]);
    const wrapped = withRecoveredAttempts(forwarding, attempts);
    const supplied = [{ txHash: "34".repeat(32), chainId: NETWORK, ok: true }];
    await expect(wrapped(request)).rejects.toThrow("stop");
    await expect(wrapped({ ...request, recoveryOnly: true, priorAttempts: supplied })).rejects.toThrow("stop");
    expect(attempts).not.toHaveBeenCalled();
    expect(seen.map((req) => req.priorAttempts)).toEqual([undefined, supplied]);
  });
});

describe("the operator recipe", () => {
  test("operator recipe completes each paid cut with one transfer", async () => {
    for (const [cut, options] of PAID_CUTS) {
      const world = await createWorld();
      const first = await startProcess(world, options);
      await expect(first.firstRun(), cut).rejects.toThrow(CRASH);
      expect(world.executed.size, cut).toBe(1);

      // A plain resume may finish a cut that already recorded its outcome, but never pays.
      await (await startProcess(world)).plainResume().catch(() => undefined);
      expect(world.executed.size, cut).toBe(1);

      const result = await (await startProcess(world)).recipe();
      expect(result.outcome, cut).toBe("completed");
      expect(world.executed.size, cut).toBe(1);
      expect(world.railCalls, cut).toBe(1);
    }
  }, SLOW_TEST_MS);

  test("a prepared transfer that lands after the first recipe attempt completes on the second, and is never re-bought", async () => {
    const world = await createWorld();
    await expect((await startProcess(world, { railFault: "pending-then-lost" })).firstRun()).rejects.toThrow(CRASH);
    const [prepared] = world.journal;
    expect(prepared).toBeDefined();

    await expect((await startProcess(world)).recipe()).rejects.toThrow(NOT_YET_INCLUDED);
    expect(world.executed.size).toBe(0);

    execute(world, prepared!.txHash, prepared!.nonce);
    const result = await (await startProcess(world)).recipe();
    expect(result.outcome).toBe("completed");
    expect(world.executed.size).toBe(1);
    expect(world.railCalls).toBe(1);
    expect(world.journal).toHaveLength(1);
  });

  test("a prepared transfer whose nonce another transaction took is refused again, and the re-buy under a new job id pays once", async () => {
    const world = await createWorld();
    await expect((await startProcess(world, { railFault: "pending-then-lost" })).firstRun()).rejects.toThrow(CRASH);
    consumeNonceByOther(world, world.journal[0]!.nonce);

    await expect((await startProcess(world)).recipe()).rejects.toThrow(NONCE_TAKEN);
    await expect((await startProcess(world)).recipe()).rejects.toThrow(NONCE_TAKEN);
    expect(world.executed.size).toBe(0);
    expect(world.railCalls).toBe(1);

    const rebuy = await (await startProcess(world, { jobId: REBUY_JOB })).firstRun();
    expect(rebuy.outcome).toBe("completed");
    expect(world.executed.size).toBe(1);
    expect(world.railCalls).toBe(2);
  });

  test("recipe after journal-before-broadcast crash keeps the original purchase unresolved without signing or sending", async () => {
    const world = await createWorld();
    await expect((await startProcess(world, { railFault: "after-journal" })).firstRun()).rejects.toThrow(CRASH);
    expect(world.journal).toHaveLength(1);

    for (let restart = 0; restart < 2; restart += 1) {
      const process = await startProcess(world);
      await expect(process.recipe()).rejects.toThrow(NOT_YET_INCLUDED);
    }
    expect(world.railCalls).toBe(1);
    expect(world.journal).toHaveLength(1);
    expect(world.executed.size).toBe(0);
    expect(world.pending.size).toBe(0);
  });

  test("recipe never recommends re-buy after an inconclusive nonce read", async () => {
    const world = await createWorld();
    await expect((await startProcess(world, { railFault: "pending-then-lost" })).firstRun()).rejects.toThrow(CRASH);
    const prepared = world.journal[0]!;
    const guidance = /new job id|abandon|re-?buy/i;

    world.nodeReadsFail = true;
    const unreadable = await (await startProcess(world)).recipe().then(() => "", (error: Error) => error.message);
    expect(unreadable).toMatch(/node timeout/);
    expect(unreadable).not.toMatch(guidance);

    world.nodeReadsFail = false;
    const pending = await (await startProcess(world)).recipe().then(() => "", (error: Error) => error.message);
    expect(pending).toMatch(NOT_YET_INCLUDED);
    expect(pending).not.toMatch(guidance);
    expect(world.railCalls).toBe(1);

    execute(world, prepared.txHash, prepared.nonce);
    expect((await (await startProcess(world)).recipe()).outcome).toBe("completed");
    expect(world.executed.size).toBe(1);
  });

  test("recipe preserves supplied history and refuses conflicting journal or concurrent outcome after restart", async () => {
    const conflicted = await createWorld();
    await expect((await startProcess(conflicted, { logFault: "put-outcome-before" })).firstRun()).rejects.toThrow(CRASH);
    conflicted.journal[0]!.amountOs = "2";
    await expect((await startProcess(conflicted)).recipe()).rejects.toThrow(/journal conflicts/);
    expect(conflicted.executed.size).toBe(1);
    expect(conflicted.railCalls).toBe(1);

    // Another worker finishes the recipe while this one is still reading the chain.
    const world = await createWorld();
    await expect((await startProcess(world, { logFault: "put-outcome-before" })).firstRun()).rejects.toThrow(CRASH);
    const original = world.journal[0]!.txHash;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reading!: () => void;
    const readStarted = new Promise<void>((resolve) => { reading = resolve; });
    const chainRead = chainReconcile(world);
    const slowChainRead: PayDemSettlementReconcile = async (context) => {
      reading();
      await gate;
      return chainRead(context);
    };
    const slowRun = (await startProcess(world, {}, slowChainRead)).recipe();
    await readStarted;
    expect((await (await startProcess(world)).recipe()).outcome).toBe("completed");
    release();
    await slowRun.catch(() => undefined);

    expect(world.executed.size).toBe(1);
    expect(world.railCalls).toBe(1);
    expect(world.journal.map((entry) => entry.txHash)).toEqual([original]);
    const evidence = [...world.kv.entries()].find(([name]) => name.startsWith("stor:dacs4:evidence:"));
    expect(JSON.stringify(evidence?.[1])).toContain(original);
  });

  test("paid recipe crash between hash-link publication and staging unlink refuses twice without another transfer", async () => {
    const world = await createWorld();
    await expect((await startProcess(world, { storeFault: "bind-transaction-after" })).firstRun()).rejects.toThrow(CRASH);
    const hashesDir = join(world.sessionDir, "hashes");
    const transactionBinding = readdirSync(hashesDir).find((name) => readFileSync(join(hashesDir, name), "utf8").includes("transaction"));
    expect(transactionBinding).toBeDefined();
    linkSync(join(hashesDir, transactionBinding!), join(hashesDir, `${transactionBinding}.staging`));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect((await startProcess(world)).recipe()).rejects.toThrow(/corrupt|link/i);
    }
    expect(world.executed.size).toBe(1);
    expect(world.railCalls).toBe(1);
  });
});

describe("the operator recipe on a rail whose journal hook records nothing", () => {
  test("a paid crash on a rail without a prepared-transfer journal is refused and leaves no record to recover from", async () => {
    // Only the cuts that die before the outcome is recorded leave nothing for a plain resume to return.
    const cutsWithoutOutcome = PAID_CUTS.filter(([, options]) =>
      options.logFault === "put-outcome-before" || options.railFault === "lost-after-broadcast");
    for (const [cut, cutOptions] of cutsWithoutOutcome) {
      const world = await createWorld();
      await expect((await startProcess(world, { ...cutOptions, hook: "records-nothing" })).firstRun(), cut).rejects.toThrow(CRASH);

      await expect((await startProcess(world, { hook: "records-nothing" })).recipe(), cut).rejects.toThrow(NO_OUTCOME_TO_RECOVER);
      expect(world.journal, cut).toHaveLength(0);
      // The transfer is on the chain: the operator finishes outside the SDK with one transfer.
      expect(world.executed.size, cut).toBe(1);
      expect(world.railCalls, cut).toBe(1);
    }
  });

  test("adding a journal only after the paid crash never authorizes re-buy", async () => {
    const world = await createWorld();
    await expect((await startProcess(world, { logFault: "put-outcome-before", hook: "records-nothing" })).firstRun()).rejects.toThrow(CRASH);

    const rebuilt = await startProcess(world, { hook: "records" });
    await expect(rebuilt.recipe()).rejects.toThrow(NO_OUTCOME_TO_RECOVER);
    await expect(rebuilt.plainResume()).rejects.toThrow(NO_OUTCOME_TO_RECOVER);
    expect(world.journal).toHaveLength(0);
    expect(world.executed.size).toBe(1);
    expect(world.railCalls).toBe(1);
  });
});
