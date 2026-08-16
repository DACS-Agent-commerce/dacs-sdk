import { describe, expect, test } from "vitest";

import { buildSignedArtifact, type Signer } from "../../src/agent/signedArtifact.js";
import {
  runSessionCore,
  sessionAnchorName,
  type SessionDeps,
  type SettleResult,
} from "../../src/agent/runSessionCore.js";
import { createInMemorySessionStore } from "../../src/agent/sessionStore.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import type { SettlementFinalityParameters } from "../../src/artifacts/types.js";
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

const CHECKPOINT_FINALITIES = [
  {
    name: "block depth without optional echo",
    finality: { model: "block-depth" },
  },
  {
    name: "block depth with optional echo",
    finality: { model: "block-depth", finalityBlocks: 12 },
  },
  {
    name: "commitment level",
    finality: {
      model: "commitment-level",
      finalityCommitmentLevel: "finalized",
    },
  },
] satisfies ReadonlyArray<{
  name: string;
  finality: SettlementFinalityParameters;
}>;

interface DepOverrides {
  kv?: Map<string, Record<string, unknown>>;
  settle?: SessionDeps["settle"];
  resumeSettlement?: SessionDeps["resumeSettlement"];
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
    // #70 replaced anchorAddress+readAnchor with a single resolve-by-name seam.
    resolveAnchor: async (name) => {
      const ref = `stor:${name}`;
      const value = kv.get(ref);
      return value ? { status: "present" as const, ref, value } : { status: "absent" as const };
    },
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
    ...(over.resumeSettlement
      ? { resumeSettlement: over.resumeSettlement }
      : {}),
    newJobId: over.newJobId ?? (() => "job-1"),
    now: () => "2026-01-01T00:00:00Z",
    nowMs: () => 1780000000000,
    // These fixtures exercise the durable store, not listing verification (#41).
    trustListing: true,
    // Fixtures use deterministic test signatures; production Agent.runSession
    // wires exact cryptographic recovery for every persisted artifact.
    authenticateRecoveredArtifact: () => true,
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

  test("restart replay preserves rail finality and tx-ref metadata from the checkpoint", async () => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    let settleCalls = 0;
    const settle = async (req: { payee: string }): Promise<SettleResult> => {
      settleCalls += 1;
      return {
        ok: true,
        txHash: "0xdemos-paid",
        chainId: "demos:testnet",
        payer: "demos:buyer",
        payee: req.payee,
        finality: { model: "bft-final" },
        blockNumber: 42,
        txRefKind: "demos",
      };
    };
    const interrupted = await makeDeps(store, {
      kv,
      settle,
      anchor: async (name, value) => {
        if (name === sessionAnchorName.evidence("job-1")) {
          throw new Error("crash after settlement metadata checkpoint");
        }
        kv.set(`stor:${name}`, value as Record<string, unknown>);
        return `stor:${name}`;
      },
    });
    await expect(
      runSessionCore(interrupted.listingRef, terms, interrupted.deps),
    ).rejects.toThrow(/metadata checkpoint/);

    const resumed = await makeDeps(store, { kv, settle });
    await runSessionCore(resumed.listingRef, terms, resumed.deps, "job-1");
    expect(settleCalls).toBe(1);
    const evidence = kv.get(`stor:${sessionAnchorName.evidence("job-1")}`);
    expect(evidence?.paymentTxRefs).toEqual([
      {
        rail: "demos:testnet",
        txHash: "0xdemos-paid",
        kind: "demos",
        blockNumber: 42,
      },
    ]);
    expect(evidence?.settlementFinality).toMatchObject({
      model: "bft-final",
    });
  });

  test.each(CHECKPOINT_FINALITIES)(
    "restart checkpoint round-trip preserves $name parameters",
    async ({ finality }) => {
      const store = createInMemorySessionStore();
      const kv = new Map<string, Record<string, unknown>>();
      let settleCalls = 0;
      const settle: SessionDeps["settle"] = async (req) => {
        settleCalls += 1;
        return {
          ok: true,
          txHash: "0xfinality-checkpoint",
          chainId: "test:checkpoint",
          payer: "buyer",
          payee: req.expectedPayee,
          finality,
        };
      };
      const interrupted = await makeDeps(store, {
        kv,
        settle,
        anchor: async (name, value) => {
          if (name === sessionAnchorName.evidence("job-1")) {
            throw new Error("crash after finality checkpoint");
          }
          kv.set(`stor:${name}`, value as Record<string, unknown>);
          return `stor:${name}`;
        },
      });
      await expect(
        runSessionCore(interrupted.listingRef, terms, interrupted.deps),
      ).rejects.toThrow(/finality checkpoint/);

      const resumed = await makeDeps(store, { kv, settle });
      await runSessionCore(resumed.listingRef, terms, resumed.deps, "job-1");
      expect(settleCalls).toBe(1);
      const evidence = kv.get(`stor:${sessionAnchorName.evidence("job-1")}`);
      expect(evidence?.settlementFinality).toEqual({
        ...finality,
        finalityObservedAt: 1780000000000,
      });
    },
  );

  test("restart fails closed on a wrong-model finality checkpoint", async () => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    let settleCalls = 0;
    const settle: SessionDeps["settle"] = async (req) => {
      settleCalls += 1;
      return {
        ok: true,
        txHash: "0xcheckpoint-shape",
        chainId: "test:checkpoint",
        payer: "buyer",
        payee: req.expectedPayee,
        finality: { model: "block-depth", finalityBlocks: 12 },
      };
    };
    const interrupted = await makeDeps(store, {
      kv,
      settle,
      anchor: async (name, value) => {
        if (name === sessionAnchorName.evidence("job-1")) {
          throw new Error("crash after checkpoint");
        }
        kv.set(`stor:${name}`, value as Record<string, unknown>);
        return `stor:${name}`;
      },
    });
    await expect(
      runSessionCore(interrupted.listingRef, terms, interrupted.deps),
    ).rejects.toThrow(/crash after checkpoint/);

    const malformedStore: NonNullable<SessionDeps["sessionStore"]> = {
      ...store,
      load: async (jobId) => {
        const loaded = await store.load(jobId);
        if (loaded.status !== "ok") return loaded;
        const record = structuredClone(loaded.record);
        const outcome = record.checkpoints.find(
          (checkpoint) => checkpoint.key === "settle:0" &&
            checkpoint.stage === "outcome",
        );
        if (outcome?.data) outcome.data.finalityModel = "commitment-level";
        return { status: "ok" as const, record };
      },
    };
    const resumed = await makeDeps(malformedStore, { kv, settle });
    await expect(
      runSessionCore(resumed.listingRef, terms, resumed.deps, "job-1"),
    ).rejects.toThrow(/invalid|malformed/);
    expect(settleCalls).toBe(1);
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

  test("an unresolved prior intent blocks resubmission until the rail outcome is reconciled (#67)", async () => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();

    // Run 1: the intent is written, then settle is interrupted → intent-only session.
    const boom = await makeDeps(store, {
      kv,
      settle: async () => {
        throw new Error("interrupted before completing settle");
      },
    });
    await expect(runSessionCore(boom.listingRef, terms, boom.deps)).rejects.toThrow(/interrupted/);

    // A later resume must not reacquire the semantic claim. The durable rail
    // outcome must be reconciled first; blindly calling settle again would reopen
    // the post-payment crash window.
    const counter = { n: 0 };
    const settle = async (req: { payee: string }): Promise<SettleResult> => {
      counter.n += 1;
      return { ok: true, txHash: "0xpaid", chainId: "c", payer: "b", payee: req.payee };
    };
    const resumed = await makeDeps(store, { kv, settle });
    await expect(
      runSessionCore(resumed.listingRef, terms, resumed.deps, "job-1"),
    ).rejects.toThrow(/unresolved intent|reconcile/);
    expect(counter.n).toBe(0);
  });

  test("a durable rail outcome reconciles an intent-only crash without resubmitting", async () => {
    const base = createInMemorySessionStore();
    let failFirstOutcomeWrite = true;
    const store: NonNullable<SessionDeps["sessionStore"]> = {
      ...base,
      transition: async (input) => {
        if (
          failFirstOutcomeWrite &&
          input.checkpoint?.key === "settle:0" &&
          input.checkpoint.stage === "outcome"
        ) {
          failFirstOutcomeWrite = false;
          throw new Error(
            "could not record settlement outcome: simulated write loss",
          );
        }
        return base.transition(input);
      },
    };
    const kv = new Map<string, Record<string, unknown>>();
    let submits = 0;
    let recoveries = 0;
    let durableRailOutcome: SettleResult | undefined;
    const settle: SessionDeps["settle"] = async (req) => {
      submits += 1;
      durableRailOutcome = {
        ok: true,
        txHash: "0xdurable-paid",
        chainId: "eip155:84532",
        payer: "0xbuyer",
        payee: req.payee,
      };
      return durableRailOutcome;
    };
    const resumeSettlement: NonNullable<SessionDeps["resumeSettlement"]> = async () => {
      recoveries += 1;
      if (!durableRailOutcome) throw new Error("rail outcome is indeterminate");
      return durableRailOutcome;
    };

    // The rail records success, transaction binding commits, then the process loses
    // the SessionStore outcome write. Only the intent remains in the session file.
    const first = await makeDeps(store, { kv, settle, resumeSettlement });
    await expect(runSessionCore(first.listingRef, terms, first.deps)).rejects.toThrow(
      /could not record settlement outcome/,
    );
    expect(submits).toBe(1);
    expect(
      await store.bindHash({
        hash: "0xdurable-paid",
        jobId: "other",
        kind: "transaction",
      }),
    ).toEqual({ ok: false, boundTo: "job-1" });

    // Resume invokes the explicit #52 recovery seam, adopts the durable result,
    // completes the outcome checkpoint, and never calls the submit seam again.
    const resumed = await makeDeps(store, { kv, settle, resumeSettlement });
    await expect(
      runSessionCore(resumed.listingRef, terms, resumed.deps, "job-1"),
    ).resolves.toMatchObject({ outcome: "completed" });
    expect(submits).toBe(1);
    expect(recoveries).toBe(1);
    const loaded = await store.load("job-1");
    expect(
      loaded.status === "ok" &&
        loaded.record.checkpoints.some(
          (checkpoint) =>
            checkpoint.key === "settle:0" &&
            checkpoint.stage === "outcome" &&
            checkpoint.data?.txHash === "0xdurable-paid",
        ),
    ).toBe(true);
  });

  test("a reconciled definitive failure is checkpointed instead of leaving the intent stuck", async () => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();

    const interrupted = await makeDeps(store, {
      kv,
      settle: async () => {
        throw new Error("interrupted before the rail result was returned");
      },
    });
    await expect(
      runSessionCore(interrupted.listingRef, terms, interrupted.deps),
    ).rejects.toThrow(/interrupted/);

    let freshSubmits = 0;
    let recoveries = 0;
    const resumed = await makeDeps(store, {
      kv,
      settle: async (req) => {
        freshSubmits += 1;
        return {
          ok: true,
          txHash: "0xmust-not-submit",
          chainId: "eip155:84532",
          payer: "0xbuyer",
          payee: req.payee,
        };
      },
      resumeSettlement: async (req) => {
        recoveries += 1;
        return {
          ok: false,
          txHash: "",
          chainId: "eip155:84532",
          payer: "0xbuyer",
          payee: req.payee,
        };
      },
    });
    await expect(
      runSessionCore(resumed.listingRef, terms, resumed.deps, "job-1"),
    ).resolves.toMatchObject({ outcome: "failed" });
    expect(freshSubmits).toBe(0);
    expect(recoveries).toBe(1);
    const loaded = await store.load("job-1");
    expect(
      loaded.status === "ok" &&
        loaded.record.checkpoints.some(
          (checkpoint) =>
            checkpoint.key === "settle:0" &&
            checkpoint.stage === "outcome" &&
            checkpoint.data?.ok === false,
        ),
    ).toBe(true);
  });

  test("a staggered resume cannot settle while the first worker is in flight (#67)", async () => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    let release!: () => void;
    let entered!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inSettle = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const counter = { n: 0 };
    const settle = async (req: { payee: string }): Promise<SettleResult> => {
      counter.n += 1;
      entered();
      await hold;
      return {
        ok: true,
        txHash: "0xpaid",
        chainId: "c",
        payer: "b",
        payee: req.payee,
      };
    };
    const a = await makeDeps(store, { kv, settle });
    const b = await makeDeps(store, { kv, settle });

    const firstRun = runSessionCore(a.listingRef, terms, a.deps, "job-1");
    await inSettle; // A has persisted intent and is paused inside the payment.
    await expect(
      runSessionCore(b.listingRef, terms, b.deps, "job-1"),
    ).rejects.toThrow(/unresolved intent|reconcile/);
    expect(counter.n).toBe(1);

    release();
    await expect(firstRun).resolves.toMatchObject({ outcome: "completed" });
    expect(counter.n).toBe(1);
  });

  test("migrates a pre-binding v1 outcome only through authenticated rail reconciliation", async () => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    let submits = 0;
    const interrupted = await makeDeps(store, {
      kv,
      settle: async () => {
        submits += 1;
        throw new Error("lost rail response after intent");
      },
    });
    await expect(
      runSessionCore(interrupted.listingRef, terms, interrupted.deps),
    ).rejects.toThrow(/lost rail response/);

    const before = await store.load("job-1");
    expect(before.status).toBe("ok");
    if (before.status !== "ok") throw new Error("missing fixture session");
    const legacyWrite = await store.transition({
      jobId: "job-1",
      expectedRevision: before.record.revision,
      checkpoint: {
        key: "settle:0",
        stage: "outcome",
        // Historical SESSION_STORE_VERSION=1 shape: no payer/payee or
        // request/deal binding fields.
        data: {
          txHash: "0xlegacy-paid",
          chainId: "eip155:84532",
          ok: true,
        },
      },
      phase: "settled",
      now: 1_780_000_000_001,
    });
    expect(legacyWrite.ok).toBe(true);

    let recoveries = 0;
    let recoveredPhase: string | undefined;
    const resumed = await makeDeps(store, {
      kv,
      settle: async () => {
        submits += 1;
        throw new Error("must not submit again");
      },
      resumeSettlement: async (req) => {
        recoveries += 1;
        recoveredPhase = req.phase;
        return {
          ok: true,
          txHash: "0xlegacy-paid",
          chainId: "eip155:84532",
          payer: "0xbuyer",
          payee: req.expectedPayee,
        };
      },
    });
    await expect(
      runSessionCore(resumed.listingRef, terms, resumed.deps, "job-1"),
    ).resolves.toMatchObject({ outcome: "completed" });
    expect(submits).toBe(1);
    expect(recoveries).toBe(1);
    expect(recoveredPhase).toBe("pay-x402");
    const migrated = await store.load("job-1");
    expect(
      migrated.status === "ok" &&
        migrated.record.checkpoints.some(
          (checkpoint) =>
            checkpoint.stage === "outcome" &&
            checkpoint.data?.outcomeSource === "rail-result" &&
            checkpoint.data?.phase === "pay-x402" &&
            checkpoint.data?.expectedPayee === sellerDid &&
            checkpoint.data?.payee === sellerDid,
        ),
    ).toBe(true);
  });

  test("rejects a mismatched payee from resumeSettlement and leaves the intent unresolved", async () => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    const interrupted = await makeDeps(store, {
      kv,
      settle: async () => {
        throw new Error("interrupt after durable intent");
      },
    });
    await expect(
      runSessionCore(interrupted.listingRef, terms, interrupted.deps),
    ).rejects.toThrow(/interrupt/);

    const resumed = await makeDeps(store, {
      kv,
      settle: async () => {
        throw new Error("must not freshly submit");
      },
      resumeSettlement: async () => ({
        ok: true,
        txHash: "0xattacker-payment",
        chainId: "eip155:84532",
        payer: "0xbuyer",
        payee: "0xattacker",
      }),
    });
    await expect(
      runSessionCore(resumed.listingRef, terms, resumed.deps, "job-1"),
    ).rejects.toThrow(/request-bound destination/);
    const after = await store.load("job-1");
    expect(
      after.status === "ok" &&
        after.record.checkpoints.filter((checkpoint) => checkpoint.stage === "outcome")
          .length,
    ).toBe(0);
  });

  test("a transaction-bearing ok:false is durably recorded until reconciliation proves a terminal result", async () => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    const first = await makeDeps(store, {
      kv,
      settle: async (req) => ({
        ok: false,
        txHash: "0xambiguous",
        chainId: "eip155:84532",
        payer: "0xbuyer",
        payee: req.expectedPayee,
      }),
    });
    await expect(
      runSessionCore(first.listingRef, terms, first.deps),
    ).rejects.toThrow(/remains indeterminate/);
    let mid = await store.load("job-1");
    expect(
      mid.status === "ok"
        ? mid.record.checkpoints.filter(
            (checkpoint) => checkpoint.stage === "outcome",
          )
        : [],
    ).toMatchObject([
      {
        data: {
          outcomeSource: "rail-result",
          ok: false,
          txHash: "0xambiguous",
        },
      },
    ]);
    await expect(
      store.bindHash({
        hash: "0xambiguous",
        jobId: "other",
        kind: "transaction",
      }),
    ).resolves.toEqual({ ok: false, boundTo: "job-1" });

    const stillUnknown = await makeDeps(store, {
      kv,
      resumeSettlement: async (req) => ({
        ok: false,
        txHash: "0xambiguous",
        chainId: "eip155:84532",
        payer: "0xbuyer",
        payee: req.expectedPayee,
      }),
    });
    await expect(
      runSessionCore(stillUnknown.listingRef, terms, stillUnknown.deps, "job-1"),
    ).rejects.toThrow(/remains indeterminate/);
    mid = await store.load("job-1");
    expect(
      mid.status === "ok" &&
        mid.record.checkpoints.filter(
          (checkpoint) => checkpoint.stage === "outcome",
        ).length,
    ).toBe(1);

    const resolved = await makeDeps(store, {
      kv,
      resumeSettlement: async (req) => ({
        ok: true,
        txHash: "0xambiguous",
        chainId: "eip155:84532",
        payer: "0xbuyer",
        payee: req.expectedPayee,
      }),
    });
    await expect(
      runSessionCore(resolved.listingRef, terms, resolved.deps, "job-1"),
    ).resolves.toMatchObject({ outcome: "completed" });
  });

  test("persists a safely resubmitted transaction when reconciliation returns a new tx", async () => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    const first = await makeDeps(store, {
      kv,
      settle: async (req) => ({
        ok: false,
        txHash: "0xold-attempt",
        chainId: "eip155:84532",
        payer: "0xbuyer",
        payee: req.expectedPayee,
      }),
    });
    await expect(runSessionCore(first.listingRef, terms, first.deps)).rejects.toThrow(
      /remains indeterminate/,
    );

    let secondHistory: unknown;
    const second = await makeDeps(store, {
      kv,
      resumeSettlement: async (req) => {
        secondHistory = req.priorAttempts;
        return {
          ok: false,
          txHash: "0xnew-attempt",
          chainId: "eip155:84532",
          payer: "0xbuyer",
          payee: req.expectedPayee,
        };
      },
    });
    await expect(
      runSessionCore(second.listingRef, terms, second.deps, "job-1"),
    ).rejects.toThrow(/0xnew-attempt.*remains indeterminate/);
    expect(secondHistory).toEqual([
      {
        txHash: "0xold-attempt",
        chainId: "eip155:84532",
        ok: false,
      },
    ]);

    const recorded = await store.load("job-1");
    expect(
      recorded.status === "ok"
        ? recorded.record.checkpoints
            .filter((checkpoint) => checkpoint.stage === "outcome")
            .map((checkpoint) => checkpoint.data?.txHash)
        : [],
    ).toEqual(["0xold-attempt", "0xnew-attempt"]);

    let thirdHistory: unknown;
    const third = await makeDeps(store, {
      kv,
      resumeSettlement: async (req) => {
        thirdHistory = req.priorAttempts;
        return {
          ok: true,
          txHash: "0xsafe-success",
          chainId: "eip155:84532",
          payer: "0xbuyer",
          payee: req.expectedPayee,
        };
      },
    });
    await expect(
      runSessionCore(third.listingRef, terms, third.deps, "job-1"),
    ).resolves.toMatchObject({ outcome: "completed" });
    expect(thirdHistory).toEqual([
      { txHash: "0xold-attempt", chainId: "eip155:84532", ok: false },
      { txHash: "0xnew-attempt", chainId: "eip155:84532", ok: false },
    ]);
  });

  test("rejects a request-mismatched payee in a prior current outcome before reuse", async () => {
    const base = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    let submits = 0;
    const interrupted = await makeDeps(base, {
      kv,
      settle: async (req) => {
        submits += 1;
        return {
          ok: true,
          txHash: "0xprior-paid",
          chainId: "eip155:84532",
          payer: "0xbuyer",
          payee: req.expectedPayee,
        };
      },
      anchor: async (name, value) => {
        if (name === sessionAnchorName.evidence("job-1")) {
          throw new Error("stop after durable outcome");
        }
        kv.set(`stor:${name}`, value as Record<string, unknown>);
        return `stor:${name}`;
      },
    });
    await expect(
      runSessionCore(interrupted.listingRef, terms, interrupted.deps),
    ).rejects.toThrow(/stop after durable outcome/);

    const wrongPayeeStore: NonNullable<SessionDeps["sessionStore"]> = {
      ...base,
      load: async (jobId) => {
        const loaded = await base.load(jobId);
        if (loaded.status !== "ok") return loaded;
        const record = structuredClone(loaded.record);
        const outcome = [...record.checkpoints]
          .reverse()
          .find((checkpoint) => checkpoint.stage === "outcome");
        if (outcome?.data) outcome.data.payee = "0xattacker";
        return { status: "ok" as const, record };
      },
    };
    const resumed = await makeDeps(wrongPayeeStore, { kv });
    await expect(
      runSessionCore(resumed.listingRef, terms, resumed.deps, "job-1"),
    ).rejects.toThrow(/not bound to the requested.*destination/i);
    expect(submits).toBe(1);
    expect(resumed.settleCalls.n).toBe(0);
  });

  test("rejects a request-mismatched phase in a prior current outcome before reuse", async () => {
    const base = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    let submits = 0;
    const interrupted = await makeDeps(base, {
      kv,
      settle: async (req) => {
        submits += 1;
        return {
          ok: true,
          txHash: "0xphase-bound-payment",
          chainId: "eip155:84532",
          payer: "0xbuyer",
          payee: req.expectedPayee,
        };
      },
      anchor: async (name, value) => {
        if (name === sessionAnchorName.evidence("job-1")) {
          throw new Error("stop after phase-bound outcome");
        }
        kv.set(`stor:${name}`, value as Record<string, unknown>);
        return `stor:${name}`;
      },
    });
    await expect(
      runSessionCore(interrupted.listingRef, terms, interrupted.deps),
    ).rejects.toThrow(/stop after phase-bound outcome/);

    const wrongPhaseStore: NonNullable<SessionDeps["sessionStore"]> = {
      ...base,
      load: async (jobId) => {
        const loaded = await base.load(jobId);
        if (loaded.status !== "ok") return loaded;
        const record = structuredClone(loaded.record);
        const outcome = [...record.checkpoints]
          .reverse()
          .find((checkpoint) => checkpoint.stage === "outcome");
        if (outcome?.data) outcome.data.phase = "pay-attacker";
        return { status: "ok" as const, record };
      },
    };
    const resumed = await makeDeps(wrongPhaseStore, { kv });
    await expect(
      runSessionCore(resumed.listingRef, terms, resumed.deps, "job-1"),
    ).rejects.toThrow(/not bound.*phase/i);
    expect(submits).toBe(1);
    expect(resumed.settleCalls.n).toBe(0);
  });

  test("rejects a conflicting settlement hidden below the newest checkpoint", async () => {
    const base = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    let submits = 0;
    const interrupted = await makeDeps(base, {
      kv,
      settle: async (req) => {
        submits += 1;
        return {
          ok: true,
          txHash: "0xlatest-paid",
          chainId: "eip155:84532",
          payer: "0xbuyer",
          payee: req.expectedPayee,
        };
      },
      anchor: async (name, value) => {
        if (name === sessionAnchorName.evidence("job-1")) {
          throw new Error("stop after durable outcome");
        }
        kv.set(`stor:${name}`, value as Record<string, unknown>);
        return `stor:${name}`;
      },
    });
    await expect(
      runSessionCore(interrupted.listingRef, terms, interrupted.deps),
    ).rejects.toThrow(/stop after durable outcome/);

    const conflictingHistoryStore: NonNullable<SessionDeps["sessionStore"]> = {
      ...base,
      load: async (jobId) => {
        const loaded = await base.load(jobId);
        if (loaded.status !== "ok") return loaded;
        const record = structuredClone(loaded.record);
        const latest = record.checkpoints.find(
          (checkpoint) => checkpoint.stage === "outcome",
        );
        if (!latest?.data) throw new Error("missing outcome fixture");
        record.checkpoints.unshift({
          key: "settle:0",
          stage: "outcome",
          data: { ...latest.data, txHash: "0xhidden-conflict" },
        });
        return { status: "ok" as const, record };
      },
    };
    const resumed = await makeDeps(conflictingHistoryStore, { kv });
    await expect(
      runSessionCore(resumed.listingRef, terms, resumed.deps, "job-1"),
    ).rejects.toThrow(/conflicting entries/);
    expect(submits).toBe(1);
    expect(resumed.settleCalls.n).toBe(0);
  });

  test("rejects SessionStore records returned for a different job before settlement", async () => {
    const base = createInMemorySessionStore();
    const wrongCreate: NonNullable<SessionDeps["sessionStore"]> = {
      ...base,
      create: async (input) => ({
        ...(await base.create(input)),
        jobId: "different-job",
      }),
    };
    const { deps, listingRef, settleCalls } = await makeDeps(wrongCreate);
    await expect(runSessionCore(listingRef, terms, deps)).rejects.toThrow(
      /returned jobId different-job/,
    );
    expect(settleCalls.n).toBe(0);
  });

  test("rejects a different-job record inside a SessionStore failure envelope", async () => {
    const base = createInMemorySessionStore();
    const wrongFailure: NonNullable<SessionDeps["sessionStore"]> = {
      ...base,
      claimCheckpoint: async (input) => {
        const claimed = await base.claimCheckpoint(input);
        if (!claimed.ok) return claimed;
        return {
          ok: false as const,
          reason: "held" as const,
          record: { ...claimed.record, jobId: "different-job" },
        };
      },
    };
    const { deps, listingRef, settleCalls } = await makeDeps(wrongFailure);
    await expect(runSessionCore(listingRef, terms, deps)).rejects.toThrow(
      /returned jobId different-job/,
    );
    expect(settleCalls.n).toBe(0);
  });

  test("rejects a successful checkpoint claim that already contains an outcome before paying", async () => {
    const base = createInMemorySessionStore();
    const contradictoryClaim: NonNullable<SessionDeps["sessionStore"]> = {
      ...base,
      claimCheckpoint: async (input) => {
        const claimed = await base.claimCheckpoint(input);
        if (!claimed.ok) return claimed;
        const written = await base.transition({
          jobId: input.jobId,
          expectedRevision: claimed.record.revision,
          phase: "settled",
          checkpoint: {
            key: input.key,
            stage: "outcome",
            data: {
              outcomeSource: "rail-result",
              ...(input.data ?? {}),
              txHash: "0xalready-paid",
              chainId: "eip155:84532",
              payer: "0xbuyer",
              payee: String(input.data?.expectedPayee),
              ok: true,
            },
          },
          now: input.now,
        });
        if (!written.ok) throw new Error("failed to build contradictory fixture");
        return { ok: true as const, record: written.record };
      },
    };
    const { deps, listingRef, settleCalls } = await makeDeps(contradictoryClaim);

    await expect(runSessionCore(listingRef, terms, deps)).rejects.toThrow(
      /exactly the claimed unresolved intent|contradicted existing durable outcome/i,
    );
    expect(settleCalls.n).toBe(0);
  });

  test("migrates authenticated pre-store evidence before receipts and never rebuilds it if deleted", async () => {
    const kv = new Map<string, Record<string, unknown>>();
    const original = await makeDeps(undefined, { kv });
    const completed = await runSessionCore(
      original.listingRef,
      terms,
      original.deps,
      "job-evidence-migration",
    );
    expect(original.settleCalls.n).toBe(1);

    const store = createInMemorySessionStore();
    const migration = await makeDeps(store, { kv });
    await expect(
      runSessionCore(
        migration.listingRef,
        terms,
        migration.deps,
        "job-evidence-migration",
      ),
    ).resolves.toEqual(completed);
    expect(migration.settleCalls.n).toBe(0);

    const loaded = await store.load("job-evidence-migration");
    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok") throw new Error("missing migrated session");
    const evidenceOutcome = loaded.record.checkpoints.find(
      (checkpoint) =>
        checkpoint.stage === "outcome" &&
        checkpoint.data?.outcomeSource === "authenticated-evidence",
    );
    expect(evidenceOutcome?.data).toMatchObject({
      evidenceRef: completed.settlementRef,
      evidenceSigner: "did:demos:agent:buyer",
      txHash: "0xpaid",
      phase: "pay-x402",
      expectedPayee: sellerDid,
      payeeClaim: sellerDid,
    });
    expect(evidenceOutcome?.data?.evidenceContentHash).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      store.bindHash({
        hash: "0xpaid",
        jobId: "different-job",
        kind: "transaction",
      }),
    ).resolves.toEqual({ ok: false, boundTo: "job-evidence-migration" });

    const wrongEvidencePhaseStore: NonNullable<SessionDeps["sessionStore"]> = {
      ...store,
      load: async (jobId) => {
        const current = await store.load(jobId);
        if (current.status !== "ok") return current;
        const record = structuredClone(current.record);
        const outcome = record.checkpoints.find(
          (checkpoint) =>
            checkpoint.stage === "outcome" &&
            checkpoint.data?.outcomeSource === "authenticated-evidence",
        );
        if (outcome?.data) outcome.data.phase = "pay-attacker";
        return { status: "ok" as const, record };
      },
    };
    const wrongEvidencePhase = await makeDeps(wrongEvidencePhaseStore, { kv });
    await expect(
      runSessionCore(
        wrongEvidencePhase.listingRef,
        terms,
        wrongEvidencePhase.deps,
        "job-evidence-migration",
      ),
    ).rejects.toThrow(/conflicts with the durable evidence outcome/);
    expect(wrongEvidencePhase.settleCalls.n).toBe(0);

    kv.delete(completed.settlementRef);
    const afterDeletion = await makeDeps(store, { kv });
    await expect(
      runSessionCore(
        afterDeletion.listingRef,
        terms,
        afterDeletion.deps,
        "job-evidence-migration",
      ),
    ).rejects.toThrow(/evidence is no longer present|refusing to rebuild/i);
    expect(afterDeletion.settleCalls.n).toBe(0);
  });

  test("preserves a migrated authenticated failure outcome across another restart", async () => {
    const kv = new Map<string, Record<string, unknown>>();
    const definitiveFailure: SessionDeps["settle"] = async (req) => ({
      ok: false,
      txHash: "",
      chainId: "eip155:84532",
      payer: "0xbuyer",
      payee: req.expectedPayee,
    });
    const original = await makeDeps(undefined, {
      kv,
      settle: definitiveFailure,
    });
    const failed = await runSessionCore(
      original.listingRef,
      terms,
      original.deps,
      "job-failure-evidence-migration",
    );
    expect(failed.outcome).toBe("failed");

    const store = createInMemorySessionStore();
    const migration = await makeDeps(store, { kv });
    await expect(
      runSessionCore(
        migration.listingRef,
        terms,
        migration.deps,
        "job-failure-evidence-migration",
      ),
    ).resolves.toEqual(failed);
    expect(migration.settleCalls.n).toBe(0);

    const restarted = await makeDeps(store, { kv });
    await expect(
      runSessionCore(
        restarted.listingRef,
        terms,
        restarted.deps,
        "job-failure-evidence-migration",
      ),
    ).resolves.toEqual(failed);
    expect(restarted.settleCalls.n).toBe(0);
  });

  test("an NFD preseed cannot alias an NFC session namespace", async () => {
    const store = createInMemorySessionStore();
    const nfdJobId = "job-e\u0301";
    await store.create({ jobId: nfdJobId, phase: "created", now: 1 });
    const { deps, listingRef, settleCalls } = await makeDeps(store);
    await expect(
      runSessionCore(listingRef, terms, deps, nfdJobId),
    ).rejects.toThrow(/canonical protocol string/);
    expect(settleCalls.n).toBe(0);
    await expect(store.load(nfdJobId)).resolves.toMatchObject({ status: "ok" });
    await expect(store.load("job-é")).resolves.toEqual({ status: "missing" });
  });
});
