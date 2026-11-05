import { describe, expect, test, vi } from "vitest";

import { buildSignedArtifact, type Signer } from "../../src/agent/signedArtifact.js";
import {
  runSessionCore,
  sessionAnchorName,
  type SessionDeps,
  type SettleResult,
} from "../../src/agent/runSessionCore.js";
import { payDemSettle } from "../../src/rails/payDem.js";
import { createIdempotencyStore } from "../../src/rails/idempotency.js";
import { createInMemorySessionStore } from "../../src/agent/sessionStore.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import { signComponentArtifact } from "../../src/artifacts/signatures.js";
import { isListing, isSettlementEvidence } from "../../src/artifacts/validators.js";
import type {
  IdentityBundle,
  ListingDraft,
  SettlementFinalityParameters,
} from "../../src/artifacts/types.js";
import { canonicalize, contentHash } from "../../src/canonical/index.js";
import { deriveX402ReceiptCommitment } from "../../src/seller/x402Receipt.js";
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

const FAILED_CHECKPOINT_FINALITY_FIELDS = [
  { name: "model", fields: { finalityModel: "bft-final" } },
  { name: "block-depth parameter", fields: { finalityBlocks: 12 } },
  {
    name: "commitment-level parameter",
    fields: { finalityCommitmentLevel: "finalized" },
  },
] as const;

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
    buyerId: buyerDid,
    buyerIdentityBundle: buyerIdentity,
    authenticateBuyerIdentityBundle: () => true,
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

test.each(["fresh", "recovered"].flatMap((mode) =>
  [false, true].map((anchorCommitted) => ({ mode, anchorCommitted })),
))("preserves a $mode factory-shaped permanent failure across an anchor crash committed=$anchorCommitted", async ({ mode, anchorCommitted }) => {
  const store = createInMemorySessionStore();
  const kv = new Map<string, Record<string, unknown>>();
  kv.set("stor:listing", await buildSignedArtifact({ ...listing,
    supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
  const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
  const payer = "ab".repeat(32);
  const payee = sellerDid.slice("did:demos:agent:".length);
  const txHash = "cd".repeat(32);
  const failure: SettleResult = {
    ok: false, txHash, chainId: "demos", payer, payee: sellerDid,
    blockNumber: 42, txRefKind: "demos", errorClass: "permanent",
    failureProof: { kind: "demos-failed-record", txHash, payer, payee,
      nonce: 9, blockNumber: 42, amountOs: "1000000000" },
  };
  let submissions = 0;
  const first = await makeDeps(store, { kv,
    settle: async () => {
      submissions += 1;
      if (mode === "recovered") throw new Error("response lost");
      return failure;
    },
    resumeSettlement: async () => failure,
    anchor: async (name, value) => {
      const ref = `stor:${name}`;
      if (name === sessionAnchorName.evidence("job-1")) {
        if (anchorCommitted) kv.set(ref, value as Record<string, unknown>);
        throw new Error("evidence storage unavailable");
      }
      kv.set(ref, value as Record<string, unknown>);
      return ref;
    },
  });
  await expect(runSessionCore(first.listingRef, demTerms, first.deps))
    .rejects.toThrow(mode === "fresh" ? /evidence storage unavailable/ : /response lost/);
  if (mode === "recovered") {
    await expect(runSessionCore(first.listingRef, demTerms, first.deps, "job-1"))
      .rejects.toThrow(/evidence storage unavailable/);
  }
  const loaded = await store.load("job-1");
  if (loaded.status !== "ok") throw new Error("missing session");
  const checkpoint = loaded.record.checkpoints.find((cp) => cp.key === "settle:0" && cp.stage === "outcome");
  expect(checkpoint?.data).toMatchObject({ ok: false, errorClass: "permanent",
    failureProofJson: JSON.stringify(failure.failureProof, Object.keys(failure.failureProof ?? {}).sort()) });
  const resumed = await makeDeps(store, { kv,
    settle: async () => { throw new Error("must not resubmit"); },
    resumeSettlement: async () => { throw new Error("must not reconcile a terminal failure"); },
  });
  await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
    .resolves.toMatchObject({ outcome: "failed" });
  await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
    .resolves.toMatchObject({ outcome: "failed" });
  expect(submissions).toBe(1);
});

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

  test("restart preserves exact x402 event, raw receipt commitment, and finality time", async () => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    const txHash = `0x${"a".repeat(64)}`;
    const receiptHeader = Buffer.from(JSON.stringify({
      success: true,
      transaction: txHash,
      network: "eip155:84532",
      payer: "0xbuyer",
      amount: "1000000",
      extension: { retained: true },
    })).toString("base64");
    const receipt = deriveX402ReceiptCommitment({
      protocolVersion: "2",
      responseHeader: { name: "PAYMENT-RESPONSE", value: receiptHeader },
    });
    if (receipt.disposition !== "pass" || !receipt.computedPaymentReceiptHash) {
      throw new Error("invalid test receipt");
    }
    const receiptHash = receipt.computedPaymentReceiptHash;
    let payments = 0;
    const settle: SessionDeps["settle"] = async (req) => {
      payments += 1;
      return {
        ok: true,
        txHash,
        chainId: "eip155:84532",
        payer: "0xbuyer",
        payee: req.expectedPayee,
        finality: { model: "block-depth", finalityBlocks: 2 },
        finalityObservedAt: 1_700_000_011_000,
        blockNumber: 100,
        txRef: {
          kind: "x402-event",
          httpResource: "https://seller.example/deliver",
          paymentReceiptHash: receiptHash,
          settlementTxHash: "a".repeat(64),
          chainId: 84532,
          logIndex: 7,
          protocolVersion: "2",
        },
        x402Receipt: {
          protocolVersion: "2",
          headerName: "PAYMENT-RESPONSE",
          headerValue: receiptHeader,
          paymentReceiptHash: receiptHash,
        },
      };
    };
    const interrupted = await makeDeps(store, {
      kv,
      settle,
      anchor: async (name, value) => {
        if (name.includes("evidence")) throw new Error("crash after settlement WAL");
        const ref = `stor:${name}`;
        kv.set(ref, value as Record<string, unknown>);
        return ref;
      },
    });
    await expect(runSessionCore(
      interrupted.listingRef,
      terms,
      interrupted.deps,
    )).rejects.toThrow(/crash after settlement WAL/);
    expect(payments).toBe(1);

    const resumed = await makeDeps(store, { kv, settle });
    const result = await runSessionCore(
      resumed.listingRef,
      terms,
      resumed.deps,
      "job-1",
    );
    expect(payments).toBe(1);
    const anchoredEvidence = kv.get(result.settlementRef);
    expect(isSettlementEvidence(anchoredEvidence)).toBe(true);
    expect(anchoredEvidence).not.toHaveProperty("phaseIndex");
    expect(anchoredEvidence).toMatchObject({
      settlementFinality: {
        model: "block-depth",
        finalityBlocks: 2,
        finalityObservedAt: 1_700_000_011_000,
      },
      paymentTxRefs: [{
        kind: "x402-event",
        paymentReceiptHash: receiptHash,
        settlementTxHash: "a".repeat(64),
        chainId: 84532,
        logIndex: 7,
      }],
    });
  });

  test("a contradictory raw x402 receipt fails closed without reopening payment", async () => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    const txHash = `0x${"a".repeat(64)}`;
    const receiptHeader = Buffer.from(JSON.stringify({
      success: true,
      transaction: txHash,
      network: "eip155:84532",
      payer: "0x3333333333333333333333333333333333333333",
      amount: "1000000",
    })).toString("base64");
    const commitment = deriveX402ReceiptCommitment({
      protocolVersion: "2",
      responseHeader: { name: "PAYMENT-RESPONSE", value: receiptHeader },
    });
    if (commitment.disposition !== "pass" ||
        !commitment.computedPaymentReceiptHash) {
      throw new Error("invalid test receipt");
    }
    const receiptHash = commitment.computedPaymentReceiptHash;
    let payments = 0;
    const settle: SessionDeps["settle"] = async (req) => {
      payments += 1;
      return {
        ok: true,
        txHash,
        chainId: "eip155:84532",
        payer: "0x2222222222222222222222222222222222222222",
        payee: req.expectedPayee,
        finality: { model: "block-depth", finalityBlocks: 2 },
        finalityObservedAt: 1_700_000_011_000,
        txRef: {
          kind: "x402-event",
          httpResource: "https://seller.example/deliver",
          paymentReceiptHash: receiptHash,
          settlementTxHash: "a".repeat(64),
          chainId: 84532,
          logIndex: 7,
          protocolVersion: "2",
        },
        x402Receipt: {
          protocolVersion: "2",
          headerName: "PAYMENT-RESPONSE",
          headerValue: receiptHeader,
          paymentReceiptHash: receiptHash,
        },
      };
    };
    const first = await makeDeps(store, { kv, settle });
    await expect(runSessionCore(
      first.listingRef,
      terms,
      first.deps,
    )).rejects.toThrow(/unauthenticated x402 receipt/);
    expect(payments).toBe(1);

    const resumed = await makeDeps(store, { kv, settle });
    await expect(runSessionCore(
      resumed.listingRef,
      terms,
      resumed.deps,
      "job-1",
    )).rejects.toThrow(/resumeSettlement/);
    expect(payments).toBe(1);
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

  test.each(FAILED_CHECKPOINT_FINALITY_FIELDS)(
    "restart rejects a failed current rail checkpoint carrying a finality $name",
    async ({ fields }) => {
      const store = createInMemorySessionStore();
      const kv = new Map<string, Record<string, unknown>>();
      let settleCalls = 0;
      const settle: SessionDeps["settle"] = async (req) => {
        settleCalls += 1;
        return {
          ok: false,
          txHash: "",
          chainId: "test:checkpoint",
          payer: "buyer",
          payee: req.expectedPayee,
        };
      };
      const interrupted = await makeDeps(store, {
        kv,
        settle,
        anchor: async (name, value) => {
          if (name === sessionAnchorName.evidence("job-1")) {
            throw new Error("crash after failed settlement checkpoint");
          }
          kv.set(`stor:${name}`, value as Record<string, unknown>);
          return `stor:${name}`;
        },
      });
      await expect(
        runSessionCore(interrupted.listingRef, terms, interrupted.deps),
      ).rejects.toThrow(/failed settlement checkpoint/);

      const malformedStore: NonNullable<SessionDeps["sessionStore"]> = {
        ...store,
        load: async (jobId) => {
          const loaded = await store.load(jobId);
          if (loaded.status !== "ok") return loaded;
          const record = structuredClone(loaded.record);
          const outcome = record.checkpoints.find(
            (checkpoint) =>
              checkpoint.key === "settle:0" &&
              checkpoint.stage === "outcome" &&
              checkpoint.data?.outcomeSource === "rail-result",
          );
          if (outcome?.data) Object.assign(outcome.data, fields);
          return { status: "ok" as const, record };
        },
      };
      const resumed = await makeDeps(malformedStore, { kv, settle });
      await expect(
        runSessionCore(resumed.listingRef, terms, resumed.deps, "job-1"),
      ).rejects.toThrow(/invalid|finality/);
      expect(settleCalls).toBe(1);
    },
  );

  test.each(FAILED_CHECKPOINT_FINALITY_FIELDS)(
    "restart rejects a failed legacy checkpoint carrying a finality $name",
    async ({ fields }) => {
      const store = createInMemorySessionStore();
      const kv = new Map<string, Record<string, unknown>>();
      const interrupted = await makeDeps(store, {
        kv,
        settle: async () => {
          throw new Error("interrupted after durable intent");
        },
      });
      await expect(
        runSessionCore(interrupted.listingRef, terms, interrupted.deps),
      ).rejects.toThrow(/durable intent/);

      const before = await store.load("job-1");
      if (before.status !== "ok") throw new Error("missing fixture session");
      const legacyWrite = await store.transition({
        jobId: "job-1",
        expectedRevision: before.record.revision,
        checkpoint: {
          key: "settle:0",
          stage: "outcome",
          data: {
            txHash: "",
            chainId: "test:legacy",
            ok: false,
            ...fields,
          },
        },
        phase: "failed",
        now: 1_780_000_000_001,
      });
      expect(legacyWrite.ok).toBe(true);

      let recoveries = 0;
      const resumed = await makeDeps(store, {
        kv,
        resumeSettlement: async (req) => {
          recoveries += 1;
          return {
            ok: false,
            txHash: "",
            chainId: "test:legacy",
            payer: "buyer",
            payee: req.expectedPayee,
          };
        },
      });
      await expect(
        runSessionCore(resumed.listingRef, terms, resumed.deps, "job-1"),
      ).rejects.toThrow(/invalid|finality/);
      expect(recoveries).toBe(0);
    },
  );

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

  test.each(["fresh", "recovered"].flatMap((mode) =>
    ["demos", "demos:testnet"].flatMap((network) =>
      [false, true].map((anchorCommitted) => ({ mode, network, anchorCommitted }))),
  ))("resumes $mode permanent DEM failure on $network after anchor committed=$anchorCommitted", async ({ mode, network, anchorCommitted }) => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    kv.set("stor:listing", await buildSignedArtifact({ ...listing,
      supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
    const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
    const payer = "ab".repeat(32);
    const payee = sellerDid.split(":").at(-1)!;
    const txHash = "cd".repeat(32);
    const failure: SettleResult = { ok: false, txHash, chainId: network, payer,
      payee: mode === "fresh" ? sellerDid : payee,
      blockNumber: 42, txRefKind: "demos", errorClass: "permanent",
      failureProof: { kind: "demos-failed-record", txHash, payer, payee,
        nonce: 9, blockNumber: 42, amountOs: "1000000000" } };
    let submissions = 0;
    let recoveries = 0;
    const first = await makeDeps(store, { kv,
      settle: async () => {
        submissions += 1;
        if (mode === "recovered") throw new Error("response lost");
        return failure;
      },
      resumeSettlement: async () => { recoveries += 1; return failure; },
      anchor: async (name, value) => {
        const ref = `stor:${name}`;
        if (name === sessionAnchorName.evidence("job-1")) {
          if (anchorCommitted) kv.set(ref, value as Record<string, unknown>);
          throw new Error("evidence storage unavailable");
        }
        kv.set(ref, value as Record<string, unknown>); return ref;
      },
    });
    if (mode === "recovered") first.deps.expectedSettlementPayee = payee;
    await expect(runSessionCore(first.listingRef, demTerms, first.deps))
      .rejects.toThrow(mode === "fresh" ? /evidence storage unavailable/ : /response lost/);
    if (mode === "recovered") {
      await expect(runSessionCore(first.listingRef, demTerms, first.deps, "job-1"))
        .rejects.toThrow(/evidence storage unavailable/);
    }
    const loaded = await store.load("job-1");
    if (loaded.status !== "ok") throw new Error("missing session");
    const outcome = loaded.record.checkpoints.find((cp) => cp.key === "settle:0" && cp.stage === "outcome");
    expect(outcome?.data).toMatchObject({ ok: false, errorClass: "permanent", txHash,
      failureProofJson: expect.any(String) });
    expect(JSON.parse(outcome!.data!.failureProofJson as string)).toEqual(failure.failureProof);
    const corruptedStore: NonNullable<SessionDeps["sessionStore"]> = {
      ...store,
      load: async (jobId) => {
        const value = await store.load(jobId);
        if (value.status !== "ok") return value;
        const record = structuredClone(value.record);
        const checkpoint = record.checkpoints.find((cp) => cp.key === "settle:0" && cp.stage === "outcome");
        checkpoint!.data!.failureProofJson = JSON.stringify({ ...failure.failureProof, amountOs: "1" });
        return { status: "ok" as const, record };
      },
    };
    const corrupted = await makeDeps(corruptedStore, { kv,
      settle: async () => { throw new Error("must not pay with corrupted proof"); },
      resumeSettlement: async () => { throw new Error("must not reconcile corrupted proof"); },
    });
    if (mode === "recovered") corrupted.deps.expectedSettlementPayee = payee;
    await expect(runSessionCore(corrupted.listingRef, demTerms, corrupted.deps, "job-1"))
      .rejects.toThrow(/invalid.*terminal-failure proof|payment remains indeterminate/);
    if (anchorCommitted) {
      const evidenceRef = `stor:${sessionAnchorName.evidence("job-1")}`;
      const { signature: _signature, ...unsigned } = kv.get(evidenceRef)!;
      const wrongKindKv = new Map(kv);
      wrongKindKv.set(evidenceRef, await signComponentArtifact(JSON.parse(JSON.stringify({
        ...unsigned,
        phaseIndex: 0,
        paymentTxRefs: [{ rail: network, kind: "payment", txHash, blockNumber: 42 }],
      })), ARTIFACT_SEPARATORS.SettlementEvidence, {
        algorithm: "ed25519", signer: buyerDid, sign,
      }) as Record<string, unknown>);
      const wrongKind = await makeDeps(store, { kv: wrongKindKv,
        settle: async () => { throw new Error("must not pay for wrong-kind evidence"); },
        resumeSettlement: async () => { throw new Error("must not reconcile wrong-kind evidence"); },
      });
      if (mode === "recovered") wrongKind.deps.expectedSettlementPayee = payee;
      await expect(runSessionCore(wrongKind.listingRef, demTerms, wrongKind.deps, "job-1"))
        .rejects.toThrow(/payment remains indeterminate/);
    }
    const resumed = await makeDeps(store, { kv,
      settle: async () => { throw new Error("must not resubmit"); },
      resumeSettlement: async () => { throw new Error("must not reconcile terminal failure"); },
    });
    if (mode === "recovered") resumed.deps.expectedSettlementPayee = payee;
    await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
      .resolves.toMatchObject({ outcome: "failed" });
    // Reuse the already anchored failure on every later resume, preserving proof.
    await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
      .resolves.toMatchObject({ outcome: "failed" });
    const after = await store.load("job-1");
    expect(after.status === "ok" && after.record.checkpoints
      .filter((cp) => cp.key === "settle:0" && cp.stage === "outcome").map((cp) => cp.data))
      .toEqual([outcome!.data]);
    expect(submissions).toBe(1);
    expect(recoveries).toBe(mode === "recovered" ? 1 : 0);
    const evidence = kv.get(`stor:${sessionAnchorName.evidence("job-1")}`);
    expect(evidence).toMatchObject({ outcome: "failure" });
    expect(evidence).not.toHaveProperty("settlementFinality");
    // Only a matching permanent proof can authenticate the anchored failure.
    for (const retained of ["different block", "unproven failure"]) {
      const mismatch = await makeDeps({ ...store, load: async (jobId) => {
        const value = await store.load(jobId);
        if (value.status === "ok") {
          const cp = value.record.checkpoints.find((cp) => cp.key === "settle:0" && cp.stage === "outcome");
          if (retained === "different block") {
            cp!.data!.blockNumber = 43;
            cp!.data!.failureProofJson = JSON.stringify({ ...failure.failureProof, blockNumber: 43 });
          } else {
            delete cp!.data!.errorClass;
            delete cp!.data!.failureProofJson;
          }
        }
        return value;
      } }, { kv,
        settle: async () => { throw new Error("must not resubmit conflicting proof"); },
        resumeSettlement: async () => { throw new Error("must not reconcile conflicting proof"); },
      });
      if (mode === "recovered") mismatch.deps.expectedSettlementPayee = payee;
      await expect(runSessionCore(mismatch.listingRef, demTerms, mismatch.deps, "job-1"))
        .rejects.toThrow(/payment remains indeterminate/);
    }
    await expect(store.bindHash({ hash: txHash, jobId: "another-job", kind: "transaction" }))
      .resolves.toEqual({ ok: false, boundTo: "job-1" });
  });

  test.each(["checkpoint", "legacy checkpoint", "anchored rail", "anchored evidence", "anchor only"]
    .flatMap((saved) => [true, false].map((journalAvailable) => ({ saved, journalAvailable }))))(
    "audits included-only native success from $saved with journalAvailable=$journalAvailable before reuse",
    async ({ saved, journalAvailable }) => {
      const store = createInMemorySessionStore();
      const kv = new Map<string, Record<string, unknown>>();
      kv.set("stor:listing", await buildSignedArtifact({ ...listing,
        supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
      const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
      const txHash = "cd".repeat(32);
      const payer = "ab".repeat(32);
      const payee = sellerDid.split(":").at(-1)!;
      // Exact pre-execution-gate rail result: inclusion alone minted bft-final.
      const oldSuccess: SettleResult = { ok: true, txHash, chainId: "demos", payer,
        payee: sellerDid, blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" }, networkFeeOs: "0" };
      const first = await makeDeps(saved === "anchor only" ? undefined : store, { kv,
        settle: async () => oldSuccess,
        anchor: async (name, value) => {
          const ref = `stor:${name}`;
          if (name === sessionAnchorName.evidence("job-1")) {
            if (saved.startsWith("anchor")) kv.set(ref, value as Record<string, unknown>);
            throw new Error("checkpoint crash");
          }
          kv.set(ref, value as Record<string, unknown>); return ref;
        },
      });
      await expect(runSessionCore(first.listingRef, demTerms, first.deps)).rejects.toThrow("checkpoint crash");
      // This fixture represents receipts written before execution authentication existed.
      const resumeStore = saved === "anchor only" ? undefined : saved === "anchored evidence"
        ? createInMemorySessionStore() : legacyNativeStore(store);
      const legacyStore = saved === "legacy checkpoint" ? { ...store, load: async (jobId: string) => {
        const loaded = await store.load(jobId);
        if (loaded.status === "ok") {
          const cp = loaded.record.checkpoints.find((cp) => cp.stage === "outcome");
          if (cp) cp.data = { txHash, chainId: "demos", ok: true };
        }
        return loaded;
      } } : resumeStore;
      let reconciliations = 0;
      const failure: SettleResult = { ok: false, txHash, chainId: "demos", payer, payee: sellerDid,
        blockNumber: 42, txRefKind: "demos", errorClass: "permanent",
        failureProof: { kind: "demos-failed-record", txHash, payer, payee,
          nonce: 9, blockNumber: 42, amountOs: "1000000000" } };
      const before = await store.load("job-1");
      const beforeEvidence = structuredClone([...kv]);
      const missingJournal = new Error("prepared-transfer journal missing");
      const railStore = createIdempotencyStore();
      const once = vi.spyOn(railStore, "once");
      let broadcasts = 0;
      const audit = payDemSettle({ address: payer, settle: async () => {
        broadcasts += 1; throw new Error("recovery must never broadcast");
      } }, {}, {
        store: railStore,
        reconcile: async (context) => {
          reconciliations += 1;
          expect(context.txHash).toBe(txHash);
          if (!journalAvailable) throw missingJournal;
          return { ...failure, ok: false, errorClass: "permanent",
            amountOs: "1000000000", failureProof: failure.failureProof! };
        },
      });
      const resumed = await makeDeps(legacyStore, { kv,
        resumeSettlement: async (req) => {
          expect(req.priorAttempts?.at(-1)).toMatchObject({ txHash, chainId: "demos", ok: true });
          return audit(req);
        },
      });
      if (!journalAvailable) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
            .rejects.toBe(missingJournal);
        }
        if (before.status === "ok") {
          expect(await settlementCheckpoints(store)).toEqual(before.record.checkpoints.filter((cp) => cp.key === "settle:0"));
        } else {
          expect(await store.load("job-1")).toEqual(before);
        }
        expect([...kv]).toEqual(beforeEvidence);
      } else if (saved.startsWith("anchor")) {
        await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
          .rejects.toThrow(/success evidence.*execution|execution.*success evidence/);
      } else {
        await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
          .resolves.toMatchObject({ outcome: "failed" });
        const evidence = kv.get(`stor:${sessionAnchorName.evidence("job-1")}`);
        expect(evidence).toMatchObject({ outcome: "failure" });
        expect(evidence).not.toHaveProperty("settlementFinality");
        await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
          .resolves.toMatchObject({ outcome: "failed" });
      }
      if (journalAvailable && saved === "checkpoint") {
        const poisonedStore: NonNullable<SessionDeps["sessionStore"]> = { ...store, load: async (jobId) => {
          const loaded = await store.load(jobId);
          if (loaded.status === "ok") {
            const original = loaded.record.checkpoints.find((cp) => cp.stage === "outcome")!;
            loaded.record.checkpoints.push(structuredClone(original));
          }
          return loaded;
        } };
        const stale = await makeDeps(poisonedStore, { kv });
        await expect(runSessionCore(stale.listingRef, demTerms, stale.deps, "job-1"))
          .rejects.toThrow(/conflicting|invalid|indeterminate/);
        expect(stale.settleCalls.n).toBe(0);
      }
      expect(reconciliations).toBe(journalAvailable ? 1 : 2);
      expect(once).not.toHaveBeenCalled();
      expect(broadcasts).toBe(0);
      expect(resumed.settleCalls.n).toBe(0);
    },
  );

  test("conflicting session history cannot turn an executed rail payment into terminal failure", async () => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    kv.set("stor:listing", await buildSignedArtifact({ ...listing,
      supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
    const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
    const hashA = "12".repeat(32);
    const hashB = "34".repeat(32);
    const payer = "ab".repeat(32);
    const payee = sellerDid.split(":").at(-1)!;
    const oldSuccess: SettleResult = { ok: true, txHash: hashB, chainId: "demos", payer,
      payee: sellerDid, blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" } };
    const first = await makeDeps(store, { kv, settle: async () => oldSuccess,
      anchor: async (name, value) => {
        if (name === sessionAnchorName.evidence("job-1")) throw new Error("checkpoint crash");
        const ref = `stor:${name}`; kv.set(ref, value as Record<string, unknown>); return ref;
      },
    });
    await expect(runSessionCore(first.listingRef, demTerms, first.deps)).rejects.toThrow("checkpoint crash");
    const railStore = createIdempotencyStore();
    await railStore.once("pay-dem:job-1:0", {
      bindingVersion: "1", railId: "pay-dem", jobId: "job-1", phaseIndex: 0, phase: "pay-dem",
      amount: "1000000000", agreementAsset: "DEM", settlementAsset: "DEM", payer, payee,
      network: "demos", finality: { model: "bft-final" },
    }, async () => ({ ...oldSuccess, txHash: hashA, payee }));
    const once = vi.spyOn(railStore, "once");
    const submit = vi.fn(async () => { throw new Error("must not broadcast"); });
    const reconcile = vi.fn(async () => ({ ok: false as const, txHash: hashB, chainId: "demos", payer, payee,
      blockNumber: 42, txRefKind: "demos", errorClass: "permanent" as const, amountOs: "1000000000",
      failureProof: { kind: "demos-failed-record" as const, txHash: hashB, payer, payee,
        nonce: 9, blockNumber: 42, amountOs: "1000000000" } }));
    const audit = payDemSettle({ address: payer, settle: submit }, {}, { store: railStore, reconcile });
    const before = await store.load("job-1");
    const beforeEvidence = structuredClone([...kv]);
    const resumed = await makeDeps(store, { kv, resumeSettlement: audit });
    for (let repeat = 0; repeat < 2; repeat += 1) {
      await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
        .rejects.toThrow(/conflicts with the rail outcome|different.*transaction/);
      expect(await settlementCheckpoints(store)).toEqual(before.status === "ok" && before.record.checkpoints.filter((cp) => cp.key === "settle:0"));
      expect([...kv]).toEqual(beforeEvidence);
    }
    expect(once).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(resumed.settleCalls.n).toBe(0);
  });

  test.each(["checkpoint", "anchored evidence"].flatMap((saved) =>
    ["absent", "indeterminate", "timeout", "hash", "network", "payer", "payee", "block", "fee", "proof amount", "missing reconciler"]
      .map((reply) => ({ saved, reply }))),
  )("withholds saved native success from $saved on $reply without a second debit", async ({ saved, reply }) => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    kv.set("stor:listing", await buildSignedArtifact({ ...listing,
      supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
    const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
    const success: SettleResult = { ok: true, txHash: "cd".repeat(32), chainId: "demos", payer: "ab".repeat(32),
      payee: sellerDid, blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" }, networkFeeOs: "0" };
    const first = await makeDeps(store, { kv, settle: async () => success,
      anchor: async (name, value) => {
        const ref = `stor:${name}`;
        if (name === sessionAnchorName.evidence("job-1")) {
          if (saved === "anchored evidence") kv.set(ref, value as Record<string, unknown>);
          throw new Error("audit crash");
        }
        kv.set(ref, value as Record<string, unknown>); return ref;
      },
    });
    await expect(runSessionCore(first.listingRef, demTerms, first.deps)).rejects.toThrow("audit crash");
    const before = await store.load("job-1");
    let reconciliations = 0;
    const resumed = await makeDeps(store, { kv, ...(reply === "missing reconciler" ? {} : {
      resumeSettlement: async (): Promise<SettleResult> => {
        reconciliations += 1;
        if (reply === "timeout") throw new Error("chain observation timed out");
        if (reply === "proof amount") return { ok: false, txHash: success.txHash, chainId: success.chainId,
          payer: success.payer, payee: success.payee, blockNumber: 42, txRefKind: "demos",
          errorClass: "permanent", failureProof: { kind: "demos-failed-record", txHash: success.txHash,
            payer: success.payer, payee: sellerDid.split(":").at(-1)!, nonce: 9, blockNumber: 42, amountOs: "1" } };
        if (reply === "absent" || reply === "indeterminate") return { ok: false,
          txHash: reply === "absent" ? "" : success.txHash, chainId: success.chainId,
          payer: success.payer, payee: success.payee, blockNumber: 42, txRefKind: "demos" };
        return { ...success,
          ...(reply === "hash" ? { txHash: "ef".repeat(32) } : {}),
          ...(reply === "network" ? { chainId: "demos:other" } : {}),
          ...(reply === "payer" ? { payer: "ef".repeat(32) } : {}),
          ...(reply === "payee" ? { payee: "ef".repeat(32) } : {}),
          ...(reply === "block" ? { blockNumber: 43 } : {}),
          ...(reply === "fee" ? { networkFeeOs: "1" } : {}),
        };
      },
    }) });
    await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1")).rejects.toThrow();
    expect(reconciliations).toBe(reply === "missing reconciler" ? 0 : 1);
    expect(resumed.settleCalls.n).toBe(0);
    const after = await store.load("job-1");
    expect(after.status === "ok" && after.record.checkpoints).toEqual(before.status === "ok" && before.record.checkpoints);
    if (saved === "checkpoint") expect(kv.has(`stor:${sessionAnchorName.evidence("job-1")}`)).toBe(false);
  });

  test.each(["0", "1000000000"])("retains a payDemSettle fee of %s OS across session restart", async (networkFeeOs) => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    kv.set("stor:listing", await buildSignedArtifact({ ...listing,
      supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
    const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
    const payer = "ab".repeat(32);
    const payee = sellerDid.split(":").at(-1)!;
    let transfers = 0;
    const settle = payDemSettle({ address: payer, settle: async () => {
      transfers += 1;
      return { ok: true, execution: "executed", txHash: "cd".repeat(32), chainId: "demos", payer, payee,
        blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" }, networkFeeOs };
    } });
    const first = await makeDeps(store, { kv, settle,
      anchor: async (name, value) => {
        if (name === sessionAnchorName.evidence("job-1")) throw new Error("anchor unavailable");
        const ref = `stor:${name}`; kv.set(ref, value as Record<string, unknown>); return ref;
      },
    });
    await expect(runSessionCore(first.listingRef, demTerms, first.deps))
      .rejects.toThrow("anchor unavailable");
    const loaded = await store.load("job-1");
    if (loaded.status !== "ok") throw new Error("missing session");
    const checkpoint = loaded.record.checkpoints.find((cp) => cp.key === "settle:0" && cp.stage === "outcome");
    expect(checkpoint?.data).toMatchObject({ ok: true, networkFeeOs });
    let reconciliations = 0;
    const resumed = await makeDeps(store, { kv, resumeSettlement: async (req) => {
      reconciliations += 1;
      expect(req.priorAttempts?.at(-1)).toMatchObject({ txHash: "cd".repeat(32), ok: true });
      return { ok: true, txHash: "cd".repeat(32), chainId: "demos", payer,
        payee: req.expectedPayee, blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" } };
    } });
    await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
      .resolves.toMatchObject({ outcome: "completed" });
    await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
      .resolves.toMatchObject({ outcome: "completed" });
    expect(transfers).toBe(1);
    expect(reconciliations).toBe(2);
    const retained = await store.load("job-1");
    expect(retained.status === "ok" && retained.record.checkpoints.find((cp) => cp.stage === "outcome")?.data?.networkFeeOs)
      .toBe(networkFeeOs);
    expect(resumed.settleCalls.n).toBe(0);
    expect(kv.get(`stor:${sessionAnchorName.evidence("job-1")}`))
      .toMatchObject({ outcome: "success", settlementFinality: { model: "bft-final" } });

    for (const invalidFee of ["01", 1]) {
      const corrupted = await makeDeps({ ...store, load: async (jobId) => {
        const value = await store.load(jobId);
        if (value.status === "ok") {
          const cp = value.record.checkpoints.find((cp) => cp.key === "settle:0" && cp.stage === "outcome");
          cp!.data!.networkFeeOs = invalidFee;
        }
        return value;
      } }, { kv });
      await expect(runSessionCore(corrupted.listingRef, demTerms, corrupted.deps, "job-1"))
        .rejects.toThrow(/malformed/);
      expect(corrupted.settleCalls.n).toBe(0);
    }
  });

  test.each(["01", "-1", "1.5", " 1", 1, null])("rejects noncanonical session network fee %s before evidence publication", async (networkFeeOs) => {
    const store = createInMemorySessionStore();
    const f = await makeDeps(store, { settle: async (req) => ({
      ok: true, txHash: "0xpaid", chainId: "demos", payer: "buyer", payee: req.expectedPayee,
      networkFeeOs,
    } as SettleResult) });
    await expect(runSessionCore(f.listingRef, terms, f.deps)).rejects.toThrow(/malformed/);
    expect(f.kv.has(`stor:${sessionAnchorName.evidence("job-1")}`)).toBe(false);
    const loaded = await store.load("job-1");
    expect(loaded.status === "ok" && loaded.record.checkpoints.some((cp) => cp.stage === "outcome"))
      .toBe(false);
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

  test.each([
    { field: "txHash", value: "0xhidden-conflict" },
    { field: "networkFeeOs", value: "2" },
  ])("rejects conflicting $field hidden below the newest checkpoint", async ({ field, value }) => {
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
          networkFeeOs: "1",
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
          data: { ...latest.data, [field]: value },
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
      evidenceSigner: buyerDid,
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

  test.each(FAILED_CHECKPOINT_FINALITY_FIELDS)(
    "restart rejects failed authenticated-evidence state carrying a finality $name",
    async ({ fields }) => {
      const jobId = "job-failed-evidence-finality";
      const kv = new Map<string, Record<string, unknown>>();
      const original = await makeDeps(undefined, {
        kv,
        settle: async (req) => ({
          ok: false,
          txHash: "",
          chainId: "test:evidence",
          payer: "buyer",
          payee: req.expectedPayee,
        }),
      });
      await expect(
        runSessionCore(original.listingRef, terms, original.deps, jobId),
      ).resolves.toMatchObject({ outcome: "failed" });

      const store = createInMemorySessionStore();
      const migration = await makeDeps(store, { kv });
      await expect(
        runSessionCore(migration.listingRef, terms, migration.deps, jobId),
      ).resolves.toMatchObject({ outcome: "failed" });
      expect(migration.settleCalls.n).toBe(0);

      const loaded = await store.load(jobId);
      if (loaded.status !== "ok") throw new Error("missing migrated session");
      expect(
        loaded.record.checkpoints.some(
          (checkpoint) =>
            checkpoint.data?.outcomeSource === "authenticated-evidence" &&
            checkpoint.data.ok === false,
        ),
      ).toBe(true);

      const malformedStore: NonNullable<SessionDeps["sessionStore"]> = {
        ...store,
        load: async (loadedJobId) => {
          const current = await store.load(loadedJobId);
          if (current.status !== "ok") return current;
          const record = structuredClone(current.record);
          const outcome = record.checkpoints.find(
            (checkpoint) =>
              checkpoint.data?.outcomeSource === "authenticated-evidence",
          );
          if (outcome?.data) Object.assign(outcome.data, fields);
          return { status: "ok" as const, record };
        },
      };
      const resumed = await makeDeps(malformedStore, { kv });
      await expect(
        runSessionCore(resumed.listingRef, terms, resumed.deps, jobId),
      ).rejects.toThrow(/invalid|finality/);
      expect(resumed.settleCalls.n).toBe(0);
    },
  );

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

// These session tests exercise recovery with injected settlement capabilities.
vi.mock("../../src/rails/payDemExecutionAuthority.js", async () =>
  import("../support/payDemExecutionAuthority.js"));

async function nativeAuditFixture(anchorCommitted = false, normative = false, omitTxRefKind = false) {
  const store = createInMemorySessionStore();
  const kv = new Map<string, Record<string, unknown>>();
  const rail = normative ? "demos-native:DEM" : "pay-dem";
  if (normative) {
    const draft: ListingDraft = {
      dacsVersion: "1", listingVersion: 1, listingId: "native-fence",
      seller: {
        identity: {
          bundleVersion: "1", presentedBy: sellerDid, presentedAt: 1780000000000,
          claims: [{ ref: sellerDid }],
          presentation: { kind: "per-claim", signatures: [{ ref: sellerDid, signature: "presentation" }] },
        },
        displayName: "Native seller",
      },
      offering: {
        title: "Native fence", description: "Native session publication", category: "data.test", tags: [],
        deliverable: { kind: "storage-program", accessModel: "public" },
      },
      buyerRequirement: { requirementVersion: "1", required: [] },
      pipeline: [
        { kind: "negotiate-fixed-price" }, { kind: "commit-agreement" },
        { kind: "pay-dem", parameters: { rail } }, { kind: "deliver-storage-program" },
      ],
      pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } },
      acceptedRails: [{ railId: rail }],
      terms: { deadlineSecAfterCommit: 3600 }, validity: { notBefore: 1770000000000 },
    };
    kv.set("stor:listing", await signComponentArtifact(draft, ARTIFACT_SEPARATORS.Listing, {
      algorithm: "ed25519", signer: sellerDid, sign,
    }));
  } else {
    kv.set("stor:listing", await buildSignedArtifact({ ...listing, supportedPaymentRails: [rail] },
      ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
  }
  const validateListing: NonNullable<SessionDeps["validateListing"]> = (raw) => {
    if (!isListing(raw)) throw new Error("expected native normative listing");
    return { disposition: "verified", step: 9, reason: "fixture admission",
      listing: raw, listingContentHash: contentHash(raw) };
  };
  const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail },
    deliveryPhase: normative ? "deliver-storage-program" : terms.deliveryPhase };
  const payer = "ab".repeat(32);
  const payee = sellerDid.slice("did:demos:agent:".length);
  const txHash = "cd".repeat(32);
  const success: SettleResult = { ok: true, txHash, chainId: "demos", payer,
    payee: sellerDid, blockNumber: 42, ...(omitTxRefKind ? {} : { txRefKind: "demos" }),
    finality: { model: "bft-final" } };
  const failure: SettleResult = { ok: false, txHash, chainId: "demos", payer,
    payee: sellerDid, blockNumber: 42, txRefKind: "demos", errorClass: "permanent",
    failureProof: { kind: "demos-failed-record", txHash, payer, payee,
      nonce: 9, blockNumber: 42, amountOs: "1000000000" } };
  const first = await makeDeps(store, { kv, settle: async () => success,
    anchor: async (name, value) => {
      const ref = `stor:${name}`;
      if (name === sessionAnchorName.evidence("job-1")) {
        if (anchorCommitted) kv.set(ref, value as Record<string, unknown>);
        throw new Error("audit fixture crash");
      }
      kv.set(ref, value as Record<string, unknown>);
      return ref;
    },
  });
  first.deps.validateListing = validateListing;
  await expect(runSessionCore(first.listingRef, demTerms, first.deps)).rejects.toThrow("audit fixture crash");
  return { store, kv, demTerms, success, failure, validateListing };
}

function legacyNativeStore(store: NonNullable<SessionDeps["sessionStore"]>, unbound = false) {
  return { ...store, load: async (jobId: string) => {
    const loaded = await store.load(jobId);
    if (loaded.status === "ok") {
      for (const cp of loaded.record.checkpoints) {
        if (cp.key !== "settle:0" || cp.stage !== "outcome" || !cp.data) continue;
        delete cp.data.executionAuthenticated;
        if (unbound) {
          const { txHash, chainId } = cp.data;
          if (typeof txHash !== "string" || typeof chainId !== "string") throw new Error("missing legacy identity");
          cp.data = { ok: true, txHash, chainId };
        }
      }
    }
    return loaded;
  } };
}

async function settlementCheckpoints(store: NonNullable<SessionDeps["sessionStore"]>) {
  const loaded = await store.load("job-1");
  if (loaded.status !== "ok") throw new Error("missing audit session");
  return loaded.record.checkpoints.filter((cp) => cp.key === "settle:0");
}

test.each([false, true])("refuses demotion of authenticated native execution after a prior audit=%s", async (auditFirst) => {
  const f = await nativeAuditFixture();
  if (auditFirst) {
    const audit = await makeDeps(f.store, { kv: f.kv, resumeSettlement: async () => f.success,
      anchor: async () => { throw new Error("second anchor crash"); } });
    await expect(runSessionCore(audit.listingRef, f.demTerms, audit.deps, "job-1"))
      .rejects.toThrow("second anchor crash");
  }
  const before = await settlementCheckpoints(f.store);
  const resumed = await makeDeps(f.store, { kv: f.kv, resumeSettlement: async () => f.failure });
  await expect(runSessionCore(resumed.listingRef, f.demTerms, resumed.deps, "job-1"))
    .rejects.toThrow(/conflicts|contradict/);
  expect(await settlementCheckpoints(f.store)).toEqual(before);
});

test("audits anchored legacy success without persisting a contradictory failure", async () => {
  const f = await nativeAuditFixture(true);
  const before = await settlementCheckpoints(f.store);
  const resumed = await makeDeps(legacyNativeStore(f.store), { kv: f.kv,
    resumeSettlement: async () => f.failure });
  await expect(runSessionCore(resumed.listingRef, f.demTerms, resumed.deps, "job-1"))
    .rejects.toThrow(/success evidence.*execution|execution.*success evidence/);
  expect(await settlementCheckpoints(f.store)).toEqual(before);
});

test.each(["block", "kind"])("refuses an anchor-only audit with a conflicting %s", async (change) => {
  const f = await nativeAuditFixture(true);
  const resumed = await makeDeps(undefined, { kv: f.kv, resumeSettlement: async () => ({
    ...f.success, ...(change === "block" ? { blockNumber: 43 } : { txRefKind: "payment" }),
  }) });
  await expect(runSessionCore(resumed.listingRef, f.demTerms, resumed.deps, "job-1"))
    .rejects.toThrow(/success evidence.*execution|execution.*success evidence/);
});

test("accepts an anchor-only audit whose rail omits the optional txRefKind", async () => {
  const f = await nativeAuditFixture(true, false, true);
  const resumed = await makeDeps(undefined, { kv: f.kv, resumeSettlement: async () => f.success });
  await expect(runSessionCore(resumed.listingRef, f.demTerms, resumed.deps, "job-1"))
    .resolves.toMatchObject({ outcome: "completed" });
});

test("rejects an indeterminate audit of an unbound legacy success before checkpoint writes", async () => {
  const f = await nativeAuditFixture();
  const before = await settlementCheckpoints(f.store);
  const { finality: _finality, ...ambiguous } = f.success;
  const resumed = await makeDeps(legacyNativeStore(f.store, true), { kv: f.kv,
    resumeSettlement: async () => ({ ...ambiguous, ok: false }) });
  await expect(runSessionCore(resumed.listingRef, f.demTerms, resumed.deps, "job-1"))
    .rejects.toThrow(/indeterminate|conflicts/);
  expect(await settlementCheckpoints(f.store)).toEqual(before);
});

test.each([false, true])("holds the native session fence while success evidence is being anchored normative=%s", async (normative) => {
  const f = await nativeAuditFixture(false, normative);
  let competingWrite: Awaited<ReturnType<typeof f.store.transition>> | undefined;
  const resumed = await makeDeps(f.store, { kv: f.kv, resumeSettlement: async () => f.success,
    anchor: async (name, value) => {
      if (name === sessionAnchorName.evidence("job-1")) {
        const loaded = await f.store.load("job-1");
        if (loaded.status !== "ok") throw new Error("missing session");
        const cp = loaded.record.checkpoints.find((cp) => cp.key === "settle:0" && cp.stage === "outcome");
        if (!cp?.data) throw new Error("missing settlement");
        const data: Record<string, string | number | boolean> = { ...cp.data, ok: false, errorClass: "permanent",
          failureProofJson: canonicalize(f.failure.failureProof) };
        delete data.finalityModel;
        delete data.executionAuthenticated;
        competingWrite = await f.store.transition({ jobId: "job-1",
          expectedRevision: loaded.record.revision, phase: "failed",
          checkpoint: { key: "settle:0", stage: "outcome", data }, now: resumed.deps.nowMs() });
      }
      const ref = `stor:${name}`;
      f.kv.set(ref, value as Record<string, unknown>);
      return ref;
    },
  });
  resumed.deps.validateListing = f.validateListing;
  await expect(runSessionCore(resumed.listingRef, f.demTerms, resumed.deps, "job-1"))
    .resolves.toMatchObject({ outcome: "completed" });
  expect(competingWrite).toMatchObject({ ok: false, reason: "lease-held" });
  expect((await settlementCheckpoints(f.store)).filter((cp) => cp.stage === "outcome").at(-1)?.data?.ok).toBe(true);
});

test("durably authenticates a legacy success on its first successful execution audit", async () => {
  const f = await nativeAuditFixture();
  const old = await f.store.load("job-1");
  if (old.status !== "ok") throw new Error("missing original session");
  const legacy = createInMemorySessionStore();
  let record = await legacy.create({ jobId: "job-1", agreementHash: old.record.agreementHash,
    phase: "settled", now: 1780000000000 });
  for (const cp of old.record.checkpoints) {
    if (cp.data) delete cp.data.executionAuthenticated;
    const written = await legacy.transition({ jobId: "job-1", expectedRevision: record.revision,
      checkpoint: cp, now: 1780000000000 });
    if (!written.ok) throw new Error("cannot seed legacy session");
    record = written.record;
  }
  const audit = await makeDeps(legacy, { kv: f.kv, resumeSettlement: async () => f.success,
    anchor: async () => { throw new Error("audit anchor crash"); } });
  await expect(runSessionCore(audit.listingRef, f.demTerms, audit.deps, "job-1"))
    .rejects.toThrow("audit anchor crash");
  const before = await settlementCheckpoints(legacy);
  expect(before.at(-1)?.data?.executionAuthenticated).toBe(true);
  const contradicting = await makeDeps(legacy, { kv: f.kv, resumeSettlement: async () => f.failure });
  await expect(runSessionCore(contradicting.listingRef, f.demTerms, contradicting.deps, "job-1"))
    .rejects.toThrow(/conflicts|contradict/);
  expect(await settlementCheckpoints(legacy)).toEqual(before);
});

test("refuses permanent-failure to success checkpoint progression", async () => {
  const f = await nativeAuditFixture();
  const loaded = await f.store.load("job-1");
  if (loaded.status !== "ok") throw new Error("missing session");
  const original = loaded.record.checkpoints.find((cp) => cp.key === "settle:0" && cp.stage === "outcome");
  if (!original?.data) throw new Error("missing outcome");
  const store = createInMemorySessionStore();
  let record = await store.create({ jobId: "job-1", agreementHash: loaded.record.agreementHash, now: 1780000000000 });
  const data = { ...original.data };
  delete data.executionAuthenticated;
  delete data.finalityModel;
  for (const outcome of [
    { ...data, ok: false, errorClass: "permanent", failureProofJson: canonicalize(f.failure.failureProof) },
    { ...data, ok: true, finalityModel: "bft-final" },
  ]) {
    const write = await store.transition({ jobId: "job-1", expectedRevision: record.revision,
      checkpoint: { key: "settle:0", stage: "outcome", data: outcome }, now: 1780000000000 });
    if (!write.ok) throw new Error("cannot seed contradictory history");
    record = write.record;
  }
  const resumed = await makeDeps(store, { kv: f.kv, resumeSettlement: async () => f.success });
  await expect(runSessionCore(resumed.listingRef, f.demTerms, resumed.deps, "job-1"))
    .rejects.toThrow(/conflicting|invalid/);
});

test("refuses a well-formed Demos failure proof on an x402 settlement", async () => {
  const f = await nativeAuditFixture();
  const other = await makeDeps(undefined, { settle: async () => f.failure });
  other.deps.expectedSettlementPayee = sellerDid;
  const x402Terms = { ...terms, price: { ...terms.price, amount: "1" } };
  await expect(runSessionCore(other.listingRef, x402Terms, other.deps))
    .rejects.toThrow(/does not bind the payment amount and rail/);
});

test("renews the native session fence while evidence publication waits", async () => {
  const f = await nativeAuditFixture();
  vi.useFakeTimers();
  vi.setSystemTime(1780000000000);
  let release: () => void = () => { throw new Error("publication gate not initialized"); };
  let started: () => void = () => { throw new Error("publication signal not initialized"); };
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const anchoring = new Promise<void>((resolve) => { started = resolve; });
  const resumed = await makeDeps(f.store, { kv: f.kv, resumeSettlement: async () => f.success,
    anchor: async (name, value) => {
      if (name === sessionAnchorName.evidence("job-1")) { started(); await gate; }
      const ref = `stor:${name}`;
      f.kv.set(ref, value as Record<string, unknown>);
      return ref;
    },
  });
  resumed.deps.nowMs = () => Date.now();
  const pending = runSessionCore(resumed.listingRef, f.demTerms, resumed.deps, "job-1");
  try {
    await anchoring;
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(f.store.acquireLease({ jobId: "job-1", owner: "competing-worker",
      ttlMs: 30_000, now: Date.now() })).resolves.toMatchObject({ ok: false });
    release();
    await expect(pending).resolves.toMatchObject({ outcome: "completed" });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    release();
    await pending.catch(() => undefined);
    vi.useRealTimers();
  }
});

test("aborts native publication completion on a conflicting revision", async () => {
  const f = await nativeAuditFixture();
  const resumed = await makeDeps(f.store, { kv: f.kv, resumeSettlement: async () => f.success,
    anchor: async (name) => {
      if (name === sessionAnchorName.evidence("job-1")) {
        const loaded = await f.store.load("job-1");
        if (loaded.status !== "ok" || !loaded.record.lease) throw new Error("missing fence");
        // Simulate an out-of-band mutation even by the current owner.
        await f.store.transition({ jobId: "job-1", expectedRevision: loaded.record.revision,
          owner: loaded.record.lease.owner, phase: "unexpected", now: resumed.deps.nowMs() });
      }
      return `stor:${name}`;
    },
  });
  await expect(runSessionCore(resumed.listingRef, f.demTerms, resumed.deps, "job-1"))
    .rejects.toThrow(/fence lost|revision changed/);
  expect(f.kv.has(`stor:${sessionAnchorName.bundle("job-1")}`)).toBe(false);
});
