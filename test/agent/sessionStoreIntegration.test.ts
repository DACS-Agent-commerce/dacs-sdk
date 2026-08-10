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

  test("restart replay preserves x402 receipt and finality metadata from the checkpoint", async () => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    const x402TxHash = `0x${"b".repeat(64)}`;
    const facilitatorReceiptJcs = `{"network":"eip155:84532","transaction":"${x402TxHash}","x402Version":2}`;
    let settleCalls = 0;
    const settle = async (req: { payee: string }): Promise<SettleResult> => {
      settleCalls += 1;
      return {
        ok: true,
        txHash: x402TxHash,
        chainId: "eip155:84532",
        payer: "0xbuyer",
        payee: req.payee,
        finality: { model: "block-depth", finalityBlocks: 12 },
        blockNumber: 42,
        txRefKind: "x402",
        receipt: {
          kind: "x402",
          httpResource: "https://seller.example/deliver",
          paymentReceiptHash: "a".repeat(64),
          protocolVersion: 2,
          facilitatorReceiptJcs,
          settlementTxHash: x402TxHash,
          chainId: "eip155:84532",
          blockNumber: 42,
          blockTimestamp: 1780000000000,
          finalityBlocks: 12,
        },
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
        rail: "eip155:84532",
        txHash: x402TxHash,
        kind: "x402",
        httpResource: "https://seller.example/deliver",
        paymentReceiptHash: "a".repeat(64),
        protocolVersion: 2,
        facilitatorReceiptJcs,
        settlementTxHash: x402TxHash,
        chainId: "eip155:84532",
        blockNumber: 42,
        blockTimestamp: 1780000000000,
        finalityBlocks: 12,
      },
    ]);
    expect(evidence?.settlementFinality).toMatchObject({
      model: "block-depth",
      finalityBlocks: 12,
      finalityObservedAt: 1780000000000,
    });
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
          return { ok: false, reason: "revision-mismatch" };
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
});
