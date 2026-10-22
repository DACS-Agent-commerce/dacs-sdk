import { beforeEach, describe, expect, test, vi } from "vitest";

import { demosNode, nodeRecord, sdkPayDemRail } from "../fixtures/demosNodeScript.js";

vi.mock("@kynesyslabs/demosdk/websdk", async () =>
  (await import("../fixtures/demosNodeScript.js")).demosWebsdkMock);
beforeEach(() => demosNode.reset());

// A native DEM session calls only the payDemSettle adapter. Saved native
// verdicts the SDK never read came from an adapter of an SDK before #338,
// which minted them from inclusion alone; a test models such a seam with
// `olderSdkAdapter`. Every other function goes through the real identity check.
const olderSdkAdapters = vi.hoisted(() => new WeakSet<object>());
vi.mock("../../src/rails/payDem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/rails/payDem.js")>();
  return {
    ...actual,
    isPayDemSessionRecoverable: (value: unknown, requireReconciler = true) =>
      (typeof value === "function" && olderSdkAdapters.has(value)) || actual.isPayDemSessionRecoverable(value, requireReconciler),
    isPayDemSettleAdapter: (value: unknown) =>
      (typeof value === "function" && olderSdkAdapters.has(value)) || actual.isPayDemSettleAdapter(value),
  };
});
function olderSdkAdapter<T extends (req: SettleRequest) => Promise<SettleResult>>(seam: T): T {
  olderSdkAdapters.add(seam);
  return seam;
}

import { buildSignedArtifact, type Signer } from "../../src/agent/signedArtifact.js";
import {
  runSessionCore,
  sessionAnchorName,
  type SessionDeps,
  type SettleRequest,
  type SettleResult,
} from "../../src/agent/runSessionCore.js";
import {
  payDemSettle,
  type PayDemRail,
  type PayDemSettlementReconcile,
} from "../../src/rails/payDem.js";
import {
  createIdempotencyStore,
  createInMemorySettlementLog,
  type SettlementBinding,
  type SettlementReconcile,
} from "../../src/rails/idempotency.js";
import { createInMemorySessionStore, type SessionCheckpoint } from "../../src/agent/sessionStore.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import { signComponentArtifact } from "../../src/artifacts/signatures.js";
import { isSettlementEvidence } from "../../src/artifacts/validators.js";
import type {
  IdentityBundle,
  SettlementFinalityParameters,
} from "../../src/artifacts/types.js";
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

/**
 * The SDK's pay-DEM adapter as a restarted buyer wires it for the 1 DEM
 * `job-1` fixture: a new bridge, over the SDK rail and the durable rail log
 * in which the run that paid (wallet `ab…`) recorded transaction `cd…` at
 * block 42 with fee `paid.networkFeeOs` (default: the fee read back). The node
 * serves the confirmed record of `cd…` (nonce 9), and the reconciler claims it
 * executed with the prepared-transfer journal entry. `read` sets the wallet
 * (payer) and the fee the record carries; `onRead` sees each reconciliation
 * and may return another claim in its place (the node still serves its own
 * record); `paid.lost` leaves the log empty, as when the rail record did not
 * survive.
 */
async function demAudit(
  read: { payer?: string; networkFeeOs?: string; blockNumber?: number } = {},
  onRead: (retained: { txHash: string; claim: Record<string, unknown> }) => unknown = () => undefined,
  paid: { networkFeeOs?: string; lost?: boolean } = { networkFeeOs: read.networkFeeOs },
) {
  const payer = read.payer ?? "ab".repeat(32);
  const payee = sellerDid.split(":").at(-1)!;
  const blockNumber = read.blockNumber ?? 42;
  const log = createInMemorySettlementLog();
  if (!paid.lost) await createIdempotencyStore(log).once("pay-dem:job-1:0", {
    bindingVersion: "1", railId: "pay-dem", jobId: "job-1", phaseIndex: 0, phase: "pay-dem",
    amount: "1000000000", agreementAsset: "DEM", settlementAsset: "DEM", payer: "ab".repeat(32), payee,
    network: "demos", finality: { model: "bft-final" },
  }, async (fence) => {
    // The rail records the signed hash under its generation before it returns.
    await fence?.recordAttempt?.("cd".repeat(32));
    return { ok: true, txHash: "cd".repeat(32), chainId: "demos", payer: "ab".repeat(32), payee,
      blockNumber, txRefKind: "demos", finality: { model: "bft-final" },
      ...(paid.networkFeeOs === undefined ? {} : { networkFeeOs: paid.networkFeeOs }) };
  });
  demosNode.address = payer;
  demosNode.records.set("cd".repeat(32), nodeRecord({
    txHash: "cd".repeat(32), payer, payee, amountOs: "1000000000", feeOs: read.networkFeeOs, blockNumber,
  }));
  return payDemSettle(await sdkPayDemRail(), {}, { store: createIdempotencyStore(log), reconcile: async (context) => {
    const txHash = "txHash" in context ? context.txHash : "";
    const claim: Record<string, unknown> = { ok: true, execution: "executed", txHash, chainId: "demos", payer,
      payee, blockNumber, txRefKind: "demos", finality: { model: "bft-final" }, amountOs: "1000000000",
      ...(read.networkFeeOs === undefined ? {} : { networkFeeOs: read.networkFeeOs }),
      preparedTransfer: { txHash, nonce: 9, payer, payee, amountOs: "1000000000", denomination: "os",
        network: "demos", recovery: { railId: "pay-dem", jobId: "job-1", phaseIndex: 0,
          settlementKey: "pay-dem:job-1:0", network: "demos", payer, payee, amountOs: "1000000000" } } };
    return (await onRead({ txHash, claim }) ?? claim) as never;
  } });
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
    await expect(runSessionCore(boom.listingRef, terms, boom.deps)).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });
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
    )).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });
    expect(payments).toBe(1);

    const resumed = await makeDeps(store, { kv, settle });
    const result = await runSessionCore(
      resumed.listingRef,
      terms,
      resumed.deps,
      "job-1",
    );
    expect(payments).toBe(1);
    const anchoredEvidence = kv.get(result.settlementRef!);
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
    ).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });

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
      ).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });

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
    ).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });

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

  test.each(["cached", "reconciled"])("refuses another job's native transaction from a %s no-history outcome before evidence or session completion", async (mode) => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    kv.set("stor:listing", await buildSignedArtifact({ ...listing,
      supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
    const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
    const rail = await sdkPayDemRail();
    const first = await makeDeps(store, { kv, newJobId: () => "job-a",
      settle: payDemSettle(rail, {}, { store: createIdempotencyStore(), reconcile: async () => null }),
    });
    await expect(runSessionCore(first.listingRef, demTerms, first.deps))
      .resolves.toMatchObject({ outcome: "completed" });
    const cached: SettleResult = {
      ok: true, txHash: demosNode.nextHash, chainId: "demos", payer: demosNode.address,
      payee: sellerDid.split(":").at(-1)!, blockNumber: 42, txRefKind: "demos",
      finality: { model: "bft-final" },
    };
    const outcomeStore = {
      once: async (key: string, _binding: SettlementBinding, _submit: unknown, reconcile?: SettlementReconcile) =>
        mode === "cached" ? cached : await reconcile!(key) as SettleResult,
      readOutcome: async () => null,
    };
    const adapter = payDemSettle(rail, {}, {
      store: outcomeStore,
      reconcile: async () => ({ ...cached, amountOs: "1000000000", execution: "executed" }),
    });
    const second = await makeDeps(store, { kv, newJobId: () => "job-b", settle: adapter });
    const anchor = vi.spyOn(second.deps, "anchor");
    // This injected store has no SDK attempt records, so preflight refuses
    // it before a settlement claim or the session's transaction binding.
    await expect(runSessionCore(second.listingRef, demTerms, second.deps))
      .rejects.toThrow(/caller-supplied settlement store and reconciler/);
    expect(anchor.mock.calls.some(([name]) =>
      name === sessionAnchorName.evidence("job-b") || name === sessionAnchorName.bundle("job-b"),
    )).toBe(false);
    const saved = await store.load("job-b");
    expect(saved.status).toBe("ok");
    if (saved.status === "ok") {
      expect(saved.record.phase).not.toBe("completed");
      expect(saved.record.checkpoints.some((cp) => cp.key === "settle:0" && cp.stage === "outcome"))
        .toBe(false);
    }
    expect(demosNode.transfers).toBe(1);
    expect(demosNode.broadcasts).toBe(1);
  });

  // A rail without SDK attempt records leaves the refusal to the session's own
  // transaction binding.
  test("refuses another job's transaction from a rail without attempt records before evidence or session completion", async () => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    const first = await makeDeps(store, { kv, newJobId: () => "job-a" });
    await expect(runSessionCore(first.listingRef, terms, first.deps))
      .resolves.toMatchObject({ outcome: "completed" });
    // The default rail reports the same transaction for every job.
    const second = await makeDeps(store, { kv, newJobId: () => "job-b" });
    const anchor = vi.spyOn(second.deps, "anchor");
    await expect(runSessionCore(second.listingRef, terms, second.deps))
      .rejects.toThrow(/already bound to session job-a.*transaction replay/);
    expect(anchor.mock.calls.some(([name]) =>
      name === sessionAnchorName.evidence("job-b") || name === sessionAnchorName.bundle("job-b"),
    )).toBe(false);
    const saved = await store.load("job-b");
    expect(saved.status).toBe("ok");
    if (saved.status === "ok") {
      expect(saved.record.phase).not.toBe("completed");
      expect(saved.record.checkpoints.some((cp) => cp.key === "settle:0" && cp.stage === "outcome"))
        .toBe(false);
    }
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
    // Only the SDK rail's own read of the failed record is a permanent failure.
    // "fresh" reads it at once; "recovered" first reads a pending record (held
    // with its hash), then the failed record when the session audits the hash.
    demosNode.recordStatus = mode === "fresh" ? "failed" : "pending";
    let recoveries = 0;
    const reconcile = vi.fn(async (context: Parameters<PayDemSettlementReconcile>[0]) => {
      recoveries += 1;
      expect("txHash" in context ? context.txHash : undefined).toBe(txHash);
      return { ...failure, payee, amountOs: "1000000000" } as never;
    });
    // One bridge for the whole test: a held hash is bound only by the bridge that saw it.
    const adapter = payDemSettle(await sdkPayDemRail(network), { network }, {
      store: createIdempotencyStore(createInMemorySettlementLog()), reconcile,
    });
    const first = await makeDeps(store, { kv,
      settle: adapter,
      resumeSettlement: adapter,
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
      .rejects.toThrow(mode === "fresh" ? /evidence storage unavailable/ : /remains indeterminate/);
    if (mode === "recovered") {
      const pending = demosNode.records.get(txHash) as Record<string, unknown>;
      demosNode.records.set(txHash, { ...pending, status: "failed" });
      await expect(runSessionCore(first.listingRef, demTerms, first.deps, "job-1"))
        .rejects.toThrow(/evidence storage unavailable/);
    }
    const loaded = await store.load("job-1");
    if (loaded.status !== "ok") throw new Error("missing session");
    // "recovered" first saved the held hash, then the failure the SDK read.
    const lastOutcome = (checkpoints: typeof loaded.record.checkpoints) =>
      checkpoints.filter((cp) => cp.key === "settle:0" && cp.stage === "outcome").at(-1);
    const outcome = lastOutcome(loaded.record.checkpoints);
    expect(outcome?.data).toMatchObject({ ok: false, errorClass: "permanent", txHash,
      failureProofJson: expect.any(String) });
    expect(JSON.parse(outcome!.data!.failureProofJson as string)).toEqual(failure.failureProof);
    const corruptedStore: NonNullable<SessionDeps["sessionStore"]> = {
      ...store,
      load: async (jobId) => {
        const value = await store.load(jobId);
        if (value.status !== "ok") return value;
        const record = structuredClone(value.record);
        const checkpoint = lastOutcome(record.checkpoints);
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
    // A saved proof is reported again only when the rail re-reads it exactly:
    // the signed nonce and inclusion block are bound, not just self-consistent.
    const beforeAudit = await store.load("job-1");
    const beforeAuditKv = structuredClone([...kv]);
    const failedRecord = demosNode.records.get(txHash) as Record<string, unknown>;
    for (const tamper of ["nonce", "consistent block", "rail reads success", "missing reconciler"]) {
      const audited = recoveries;
      // The node serves the confirmed record while the reconciler claims failure.
      if (tamper === "rail reads success") demosNode.records.set(txHash, { ...failedRecord, status: "confirmed" });
      const tampered = await makeDeps({ ...store, load: async (jobId) => {
        const value = await store.load(jobId);
        if (value.status !== "ok") return value;
        const record = structuredClone(value.record);
        const cp = lastOutcome(record.checkpoints)!;
        if (tamper === "nonce") {
          cp.data!.failureProofJson = JSON.stringify({ ...failure.failureProof, nonce: 10 });
        } else if (tamper === "consistent block") {
          cp.data!.blockNumber = 43;
          cp.data!.failureProofJson = JSON.stringify({ ...failure.failureProof, blockNumber: 43 });
        }
        return { status: "ok" as const, record };
      } }, { kv,
        settle: async () => { throw new Error("must not resubmit a tampered failure"); },
        ...(tamper === "missing reconciler" ? {} : { resumeSettlement: adapter }),
      });
      if (mode === "recovered") tampered.deps.expectedSettlementPayee = payee;
      await expect(runSessionCore(tampered.listingRef, demTerms, tampered.deps, "job-1")).rejects.toThrow(
        tamper === "missing reconciler" ? /requires authenticated rail reconciliation/
          : tamper === "consistent block" && anchorCommitted ? /payment remains indeterminate/
            : tamper === "rail reads success" ? /contradicts the node record the SDK read/
              : /failure proof conflicts with the rail re-read/,
      );
      demosNode.records.set(txHash, failedRecord);
      expect(recoveries - audited).toBe(tamper === "missing reconciler" ||
        (tamper === "consistent block" && anchorCommitted) ? 0 : 1);
      expect(tampered.settleCalls.n).toBe(0);
      expect(await store.load("job-1")).toEqual(beforeAudit);
      expect([...kv]).toEqual(beforeAuditKv);
    }
    const audited = recoveries;
    const resumed = await makeDeps(store, { kv,
      settle: async () => { throw new Error("must not resubmit"); },
      resumeSettlement: adapter,
    });
    if (mode === "recovered") resumed.deps.expectedSettlementPayee = payee;
    await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
      .resolves.toMatchObject({ outcome: "failed" });
    // Reuse the already anchored failure on every later resume, preserving proof.
    await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
      .resolves.toMatchObject({ outcome: "failed" });
    const after = await store.load("job-1");
    expect(after.status === "ok" && lastOutcome(after.record.checkpoints)?.data).toEqual(outcome!.data);
    expect(demosNode.broadcasts).toBe(1);
    expect(recoveries - audited).toBe(2);
    const evidence = kv.get(`stor:${sessionAnchorName.evidence("job-1")}`);
    expect(evidence).toMatchObject({ outcome: "failure" });
    expect(evidence).not.toHaveProperty("settlementFinality");
    // Only a matching permanent proof can authenticate the anchored failure.
    for (const retained of ["different block", "unproven failure"]) {
      const mismatch = await makeDeps({ ...store, load: async (jobId) => {
        const value = await store.load(jobId);
        if (value.status === "ok") {
          const cp = lastOutcome(value.record.checkpoints);
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
    .flatMap((saved) => (["journal missing", "rail audit", "injected failure"] as const)
      .map((reconciler) => ({ saved, reconciler }))))(
    "audits included-only native success from $saved with $reconciler before reuse",
    async ({ saved, reconciler }) => {
      const journalAvailable = reconciler !== "journal missing";
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
      const first = await makeDeps(store, { kv,
        settle: olderSdkAdapter(async () => oldSuccess),
        anchor: async (name, value) => {
          const ref = `stor:${name}`;
          if (name === sessionAnchorName.evidence("job-1")) {
            if (saved.startsWith("anchor")) kv.set(ref, value as Record<string, unknown>);
            throw new Error("checkpoint crash");
          }
          kv.set(ref, value as Record<string, unknown>); return ref;
        },
      });
      await expect(runSessionCore(first.listingRef, demTerms, first.deps)).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });
      const resumeStore = saved === "anchor only" ? undefined : saved === "anchored evidence"
        ? createInMemorySessionStore() : store;
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
      // The node's record of the saved success's hash says it failed.
      demosNode.records.set(txHash, nodeRecord({ txHash, payer, payee, amountOs: "1000000000", status: "failed" }));
      const audit = payDemSettle(await sdkPayDemRail(), {}, {
        store: railStore,
        reconcile: async (context) => {
          reconciliations += 1;
          // Only the audit member of the context union carries the retained hash.
          expect("txHash" in context ? context.txHash : undefined).toBe(txHash);
          if (!journalAvailable) throw missingJournal;
          return { ...failure, ok: false, errorClass: "permanent",
            amountOs: "1000000000", failureProof: failure.failureProof!,
            // A journal entry can refuse but never binds the hash: the SDK's
            // rail log and its own node read decide.
            preparedTransfer: { txHash, nonce: 9, payer, payee, amountOs: "1000000000",
              denomination: "os", network: "demos", recovery: { railId: "pay-dem", jobId: "job-1",
                phaseIndex: 0, settlementKey: "pay-dem:job-1:0", network: "demos", payer, payee,
                amountOs: "1000000000" } } };
        },
      });
      // A custom native rail that would report the bound failed record itself.
      const injected = vi.fn(async (): Promise<SettleResult> => failure);
      const resumed = await makeDeps(legacyStore, { kv,
        resumeSettlement: reconciler === "injected failure" ? injected : audit,
      });
      // A saved success is never reported unpaid (DACS-4 §9.5.1 PC-7): the rail
      // refuses the failed record it reads, and the session never asks another
      // implementation. Either way nothing completes and nothing is rewritten.
      const refusal = {
        "journal missing": missingJournal,
        "rail audit": /pay-dem reconciliation contradicted an authenticated successful outcome; refusing to report a final payment unpaid/,
        "injected failure": /resumeSettlement is not the payDemSettle adapter, so it is not called/,
      }[reconciler];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const run = expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1")).rejects;
        await (refusal instanceof Error ? run.toBe(refusal) : run.toThrow(refusal));
        expect(await store.load("job-1")).toEqual(before);
        expect([...kv]).toEqual(beforeEvidence);
      }
      if (journalAvailable && saved === "checkpoint") {
        // The same failure written under the success (as a demoting writer
        // would) is conflicting history, refused before any rail call.
        const poisonedStore: NonNullable<SessionDeps["sessionStore"]> = { ...store, load: async (jobId) => {
          const loaded = await store.load(jobId);
          if (loaded.status === "ok") {
            const original = loaded.record.checkpoints.find((cp) => cp.stage === "outcome")!;
            const { finalityModel: _model, ...binding } = original.data!;
            loaded.record.checkpoints.push({ ...structuredClone(original), data: { ...binding, ok: false,
              errorClass: "permanent", failureProofJson: JSON.stringify(failure.failureProof) } });
          }
          return loaded;
        } };
        const stale = await makeDeps(poisonedStore, { kv, resumeSettlement: async () => {
          throw new Error("conflicting history must not reach the rail");
        } });
        await expect(runSessionCore(stale.listingRef, demTerms, stale.deps, "job-1"))
          .rejects.toThrow("settlement outcome history contains conflicting entries");
        expect(stale.settleCalls.n).toBe(0);
      }
      // Every resume re-reads the saved success; none is answered from a cache.
      expect(reconciliations).toBe(reconciler === "injected failure" ? 0 : 2);
      expect(injected).not.toHaveBeenCalled();
      expect(once).not.toHaveBeenCalled();
      expect(demosNode.transfers).toBe(0);
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
    const first = await makeDeps(store, { kv, settle: olderSdkAdapter(async () => oldSuccess),
      anchor: async (name, value) => {
        if (name === sessionAnchorName.evidence("job-1")) throw new Error("checkpoint crash");
        const ref = `stor:${name}`; kv.set(ref, value as Record<string, unknown>); return ref;
      },
    });
    await expect(runSessionCore(first.listingRef, demTerms, first.deps)).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });
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
      expect(await store.load("job-1")).toEqual(before);
      expect([...kv]).toEqual(beforeEvidence);
    }
    expect(once).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(resumed.settleCalls.n).toBe(0);
  });

  test.each(["checkpoint", "anchored evidence"].flatMap((saved) =>
    ["absent", "indeterminate", "timeout", "hash", "network", "payer", "payee", "block", "block omitted", "fee",
      "fee omitted", "finality omitted", "saved block deleted", "saved kind deleted", "proof amount", "stale success",
      "node failed", "custom callback", "missing reconciler"]
      .map((reply) => ({ saved, reply }))),
  )("withholds saved native success from $saved on $reply without a second debit", async ({ saved, reply }) => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    kv.set("stor:listing", await buildSignedArtifact({ ...listing,
      supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
    const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
    const success: SettleResult = { ok: true, txHash: "cd".repeat(32), chainId: "demos", payer: "ab".repeat(32),
      payee: sellerDid, blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" }, networkFeeOs: "0" };
    const first = await makeDeps(store, { kv, settle: olderSdkAdapter(async () => success),
      anchor: async (name, value) => {
        const ref = `stor:${name}`;
        if (name === sessionAnchorName.evidence("job-1")) {
          if (saved === "anchored evidence") kv.set(ref, value as Record<string, unknown>);
          throw new Error("audit crash");
        }
        kv.set(ref, value as Record<string, unknown>); return ref;
      },
    });
    await expect(runSessionCore(first.listingRef, demTerms, first.deps)).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });
    const before = await store.load("job-1");
    let reconciliations = 0;
    // A saved record that lost a chain fact cannot be completed from it.
    const resumeStore: NonNullable<SessionDeps["sessionStore"]> = !reply.startsWith("saved ") ? store
      : { ...store, load: async (jobId) => {
        const value = await store.load(jobId);
        if (value.status !== "ok") return value;
        const record = structuredClone(value.record);
        delete record.checkpoints.find((cp) => cp.stage === "outcome")!
          .data![reply === "saved block deleted" ? "blockNumber" : "txRefKind"];
        return { status: "ok" as const, record };
      } };
    // Another writer demotes the saved success while the SDK adapter re-reads it.
    const demoteDuringRead = async () => {
      reconciliations += 1;
      const loaded = await store.load("job-1");
      if (loaded.status !== "ok") throw new Error("missing session");
      const original = loaded.record.checkpoints.find((cp) => cp.stage === "outcome")!.data!;
      const { finalityModel: _model, ...binding } = original;
      await store.transition({ jobId: "job-1", expectedRevision: loaded.record.revision,
        phase: "failed", now: 1780000000001, checkpoint: { key: "settle:0", stage: "outcome", data: {
          ...binding, ok: false, errorClass: "permanent", failureProofJson: JSON.stringify({
            kind: "demos-failed-record", txHash: success.txHash, payer: success.payer,
            payee: sellerDid.split(":").at(-1)!, nonce: 9, blockNumber: 42, amountOs: "1000000000",
          }),
        } } });
    };
    // Every reply comes through the SDK adapter over the SDK rail: the node
    // serves its record and the reconciler claims an outcome (#338). The
    // claim is the executed record unless the reply replaces it.
    const claimFor = (claim: Record<string, unknown>): Record<string, unknown> | undefined => {
      const { blockNumber: _block, finality: _finality, ...rest } = claim;
      if (reply === "hash") return { ...claim, txHash: "ef".repeat(32) };
      if (reply === "network") return { ...claim, chainId: "demos:other" };
      if (reply === "payee") return { ...claim, payee: "ef".repeat(32) };
      if (reply === "block omitted") return { ...rest, finality: claim.finality };
      if (reply === "finality omitted") return { ...rest, blockNumber: 42 };
      if (reply === "proof amount") {
        const { execution: _execution, ...failed } = rest;
        return { ...failed, ok: false, blockNumber: 42, errorClass: "permanent",
          failureProof: { kind: "demos-failed-record", txHash: claim.txHash, payer: claim.payer,
            payee: claim.payee, nonce: 9, blockNumber: 42, amountOs: "1" } };
      }
      return undefined;
    };
    const custom = vi.fn(async (): Promise<SettleResult> => success);
    const adapter = reply === "custom callback" || reply === "missing reconciler" ? undefined
      : await demAudit(
        { networkFeeOs: reply === "fee" ? "1" : reply === "fee omitted" ? undefined : "0",
          ...(reply === "payer" ? { payer: "ef".repeat(32) } : {}) },
        reply === "stale success" ? demoteDuringRead : ({ claim }) => {
          reconciliations += 1;
          return claimFor(claim);
        },
        { networkFeeOs: "0" },
      );
    const record = demosNode.records.get("cd".repeat(32)) as Record<string, unknown>;
    if (reply === "absent") demosNode.records.delete("cd".repeat(32));
    if (reply === "indeterminate") demosNode.records.set("cd".repeat(32), { ...record, status: "pending" });
    // The reconciler claims execution; the node's record says the transfer failed.
    if (reply === "node failed") demosNode.records.set("cd".repeat(32), { ...record, status: "failed" });
    if (reply === "block") demosNode.records.set("cd".repeat(32), { ...record, blockNumber: 43 });
    if (reply === "timeout") demosNode.reply = () => new Promise(() => undefined);
    const resumed = await makeDeps(resumeStore, { kv, ...(reply === "missing reconciler" ? {} : {
      resumeSettlement: adapter ?? custom,
    }) });
    const conflict = /native settlement execution remains indeterminate or conflicts with the saved success/;
    const unread = (reason: string) => new RegExp(
      `could not establish the node record for (?:cd){32}: ${reason}; the payment stays unresolved`,
    );
    const expected: Record<string, RegExp> = {
      absent: unread("transaction record was not found or lookup failed"),
      indeterminate: unread("transaction record has no terminal execution status"),
      timeout: unread("transaction record read timed out"),
      hash: /does not match the retained transaction/,
      network: /does not bind the exact pay-dem network, payer, and payee/,
      // Another wallet's bridge cannot read this key's rail log at all.
      payer: /outcome binding conflicts with requested terms/,
      payee: /does not bind the exact pay-dem network, payer, and payee/,
      block: /contradicts the node record the SDK read/,
      "node failed": /contradicts the node record the SDK read/,
      "block omitted": /success lacks canonical tx identity, block evidence/,
      fee: /fee conflicts with the authenticated network fee/,
      "fee omitted": /contradicts the node record the SDK read/,
      "finality omitted": /success lacks canonical tx identity, block evidence, or bft-final finality/,
      "saved block deleted": conflict,
      "saved kind deleted": conflict,
      "proof amount": /invalid terminal-failure proof/,
      // A failure written under the saved success is conflicting history.
      "stale success": saved === "checkpoint"
        ? /could not record settlement outcome for job-1: settlement outcome history contains conflicting entries/
        : /cannot migrate authenticated evidence for job-1: settlement outcome history contains conflicting entries/,
      // Only the SDK adapter can re-read a saved success, so another one is not called.
      "custom callback": /resumeSettlement is not the payDemSettle adapter, so it is not called/,
      "missing reconciler": /requires authenticated rail reconciliation/,
    };
    await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
      .rejects.toThrow(expected[reply]);
    expect(custom).not.toHaveBeenCalled();
    expect(demosNode.transfers).toBe(0);
    expect(reconciliations)
      .toBe(["missing reconciler", "custom callback", "payer"].includes(reply) ? 0 : 1);
    expect(resumed.settleCalls.n).toBe(0);
    const after = await store.load("job-1");
    if (reply === "stale success") {
      expect(after.status === "ok" && after.record.checkpoints.at(-1)?.data)
        .toMatchObject({ ok: false, errorClass: "permanent" });
    } else {
      expect(after.status === "ok" && after.record.checkpoints).toEqual(before.status === "ok" && before.record.checkpoints);
    }
    if (saved === "checkpoint") expect(kv.has(`stor:${sessionAnchorName.evidence("job-1")}`)).toBe(false);
  });

  test.each(["rail reads success", "rail reads failure", "missing reconciler"])(
    "holds anchored native failure evidence without a SessionStore as indeterminate when the %s",
    async (reply) => {
      const kv = new Map<string, Record<string, unknown>>();
      kv.set("stor:listing", await buildSignedArtifact({ ...listing,
        supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
      const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
      const txHash = "cd".repeat(32);
      const payer = "ab".repeat(32);
      const failure: SettleResult = { ok: false, txHash, chainId: "demos", payer, payee: sellerDid,
        blockNumber: 42, txRefKind: "demos", errorClass: "permanent",
        failureProof: { kind: "demos-failed-record", txHash, payer, payee: sellerDid.split(":").at(-1)!,
          nonce: 9, blockNumber: 42, amountOs: "1000000000" } };
      // The SDK rail reads the failed record itself, so the first run ends failed.
      demosNode.recordStatus = "failed";
      const first = await makeDeps(createInMemorySessionStore(), { kv, settle: payDemSettle(await sdkPayDemRail(), {}, { store: createIdempotencyStore(), reconcile: async () => null }) });
      await expect(runSessionCore(first.listingRef, demTerms, first.deps))
        .resolves.toMatchObject({ outcome: "failed" });
      expect(demosNode.broadcasts).toBe(1);
      const minted = structuredClone([...kv]);
      let reads = 0;
      // No durable proof survived the first run: nothing can be re-read byte
      // for byte, so the anchored failure is never reported again on trust.
      const rerun = await makeDeps(undefined, { kv,
        settle: async () => { throw new Error("must not pay again"); },
        ...(reply === "missing reconciler" ? {} : { resumeSettlement: async (): Promise<SettleResult> => {
          reads += 1;
          return reply === "rail reads failure" ? failure : { ok: true, txHash, chainId: "demos", payer,
            payee: sellerDid, blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" } };
        } }),
      });
      await expect(runSessionCore(rerun.listingRef, demTerms, rerun.deps, "job-1")).rejects.toThrow(
        /carries transaction demos:(?:cd){32}; the payment remains indeterminate without a SessionStore holding its failure proof/,
      );
      expect(reads).toBe(0);
      expect(rerun.settleCalls.n).toBe(0);
      expect([...kv]).toEqual(minted);
    },
  );

  test.each(["anchor only", "fresh store", "migrated evidence"].flatMap((saved) =>
    ["finality omitted", "other finality"].map((reply) => ({ saved, reply }))),
  )("re-asserts the signed finality of native success evidence from $saved on $reply", async ({ saved, reply }) => {
    const kv = new Map<string, Record<string, unknown>>();
    kv.set("stor:listing", await buildSignedArtifact({ ...listing,
      supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
    const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
    const success: SettleResult = { ok: true, txHash: "cd".repeat(32), chainId: "demos", payer: "ab".repeat(32),
      payee: sellerDid, blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" } };
    const first = await makeDeps(createInMemorySessionStore(), { kv,
      settle: olderSdkAdapter(async () => success),
      anchor: async (name, value) => {
        const ref = `stor:${name}`;
        kv.set(ref, value as Record<string, unknown>);
        if (name === sessionAnchorName.evidence("job-1")) throw new Error("evidence ack lost");
        return ref;
      },
    });
    await expect(runSessionCore(first.listingRef, demTerms, first.deps)).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });
    // No rail checkpoint reaches the resume: only the signed evidence is saved.
    const store = saved === "anchor only" ? undefined : createInMemorySessionStore();
    let reads = 0;
    // Only the SDK adapter's re-read of the signed facts can complete.
    const audit = await demAudit({}, () => { reads += 1; });
    if (saved === "migrated evidence") {
      const migrate = await makeDeps(store, { kv, resumeSettlement: audit });
      await expect(runSessionCore(migrate.listingRef, demTerms, migrate.deps, "job-1"))
        .resolves.toMatchObject({ outcome: "completed" });
      const migrated = await store!.load("job-1");
      expect(migrated.status === "ok" && migrated.record.checkpoints.at(-1)?.data)
        .toMatchObject({ outcomeSource: "authenticated-evidence", ok: true });
      reads = 0;
    }
    const checkpoints = async () => {
      const loaded = await store!.load("job-1");
      return loaded.status === "ok" ? loaded.record.checkpoints : [];
    };
    const before = store ? await checkpoints() : undefined;
    const evidence = structuredClone([...kv]);
    // A reconciler claiming the same record under another finality: the
    // adapter itself requires exact bft-final before the session compares it.
    const resumed = await makeDeps(store, { kv, resumeSettlement: await demAudit({}, ({ claim }) => {
      reads += 1;
      const { finality: _finality, ...unfinal } = claim;
      return reply === "finality omitted" ? unfinal
        : { ...claim, finality: { model: "block-depth", finalityBlocks: 12 } };
    }) });
    await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
      .rejects.toThrow(/bft-final finality/);
    expect(reads).toBe(1);
    expect(resumed.settleCalls.n).toBe(0);
    expect([...kv]).toEqual(evidence);
    if (store) expect(await checkpoints()).toEqual(before);
    // The refusal is the finality alone: the signed finality re-read completes.
    const matching = await makeDeps(store, { kv, resumeSettlement: audit });
    await expect(runSessionCore(matching.listingRef, demTerms, matching.deps, "job-1"))
      .resolves.toMatchObject({ outcome: "completed" });
    expect(reads).toBe(2);
  });

  test.each(["anchor only", "fresh store", "migrated evidence"].flatMap((saved) =>
    (["payer", "fee"] as const).flatMap((change) =>
      (["payDemSettle", "constant callback"] as const).map((via) => ({ saved, change, via })))),
  )("refuses native success evidence from $saved re-read with another $change via $via", async ({ saved, change, via }) => {
    const kv = new Map<string, Record<string, unknown>>();
    kv.set("stor:listing", await buildSignedArtifact({ ...listing,
      supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
    const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
    const success: SettleResult = { ok: true, txHash: "cd".repeat(32), chainId: "demos", payer: "ab".repeat(32),
      payee: sellerDid, blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" }, networkFeeOs: "5" };
    const first = await makeDeps(createInMemorySessionStore(), { kv,
      settle: olderSdkAdapter(async () => success),
      anchor: async (name, value) => {
        const ref = `stor:${name}`;
        kv.set(ref, value as Record<string, unknown>);
        if (name === sessionAnchorName.evidence("job-1")) throw new Error("evidence ack lost");
        return ref;
      },
    });
    await expect(runSessionCore(first.listingRef, demTerms, first.deps)).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });
    // No rail checkpoint reaches the resume: only the signed evidence binds the payer and fee.
    const store = saved === "anchor only" ? undefined : createInMemorySessionStore();
    let reads = 0;
    const counted = () => { reads += 1; };
    if (saved === "migrated evidence") {
      const migrate = await makeDeps(store, { kv, resumeSettlement: await demAudit({ networkFeeOs: "5" }, counted) });
      await expect(runSessionCore(migrate.listingRef, demTerms, migrate.deps, "job-1"))
        .resolves.toMatchObject({ outcome: "completed" });
      const migrated = await store!.load("job-1");
      expect(migrated.status === "ok" && migrated.record.checkpoints.at(-1)?.data)
        .toMatchObject({ outcomeSource: "authenticated-evidence", payer: success.payer, networkFeeOs: "5" });
      reads = 0;
    }
    const checkpoints = async () => {
      const loaded = await store!.load("job-1");
      return loaded.status === "ok" ? loaded.record.checkpoints : [];
    };
    const before = store ? await checkpoints() : undefined;
    const evidence = structuredClone([...kv]);
    // The same hash, block and finality, re-read for another wallet or fee.
    const reread = change === "payer" ? { payer: "ef".repeat(32), networkFeeOs: "5" } : { networkFeeOs: "6" };
    const resumed = await makeDeps(store, { kv, resumeSettlement: via === "payDemSettle"
      ? await demAudit(reread, counted, { networkFeeOs: "5" })
      : async (): Promise<SettleResult> => { counted(); return { ...success, ...reread }; } });
    // The rail log binds the paying wallet, so the adapter refuses another one
    // before its node read; the node's fee is re-asserted against the signed
    // one; another callback is never called for a saved success.
    const viaRailLog = via === "payDemSettle" && change === "payer";
    const unread = via === "constant callback" || viaRailLog;
    await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
      .rejects.toThrow(viaRailLog ? "settlement pay-dem:job-1:0 outcome binding conflicts with requested terms"
        : via === "constant callback" ? "resumeSettlement is not the payDemSettle adapter, so it is not called"
          : "fee conflicts with the authenticated network fee");
    expect(reads).toBe(unread ? 0 : 1);
    expect(resumed.settleCalls.n).toBe(0);
    expect([...kv]).toEqual(evidence);
    if (store) expect(await checkpoints()).toEqual(before);
    // The refusal is the payer or fee alone: the signed ones re-read complete.
    const matching = await makeDeps(store, { kv, resumeSettlement: await demAudit({ networkFeeOs: "5" }, counted) });
    await expect(runSessionCore(matching.listingRef, demTerms, matching.deps, "job-1"))
      .resolves.toMatchObject({ outcome: "completed" });
    expect(reads).toBe(unread ? 1 : 2);
  });

  test.each(["evidence, anchor only", "evidence, fresh store", "checkpoint without payer", "checkpoint without fee"])(
    "holds native success as indeterminate without a rail read when its %s binds no payer or fee",
    async (saved) => {
      const kv = new Map<string, Record<string, unknown>>();
      kv.set("stor:listing", await buildSignedArtifact({ ...listing,
        supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
      const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
      const evidenceRef = `stor:${sessionAnchorName.evidence("job-1")}`;
      const first = await makeDeps(createInMemorySessionStore(), { kv,
        settle: olderSdkAdapter(async () => ({ ok: true, txHash: "cd".repeat(32), chainId: "demos",
          payer: "ab".repeat(32), payee: sellerDid, blockNumber: 42, txRefKind: "demos",
          finality: { model: "bft-final" }, networkFeeOs: "5" })),
        anchor: async (name, value) => {
          const ref = `stor:${name}`;
          kv.set(ref, value as Record<string, unknown>);
          if (name === sessionAnchorName.evidence("job-1")) throw new Error("evidence ack lost");
          return ref;
        },
      });
      await expect(runSessionCore(first.listingRef, demTerms, first.deps)).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });
      if (saved.startsWith("evidence")) {
        // Evidence as signed before the payer and fee were bound into it.
        const { signature: _signature, dacsSdkSettlementPayer: _payer, dacsSdkNetworkFeeOs: _fee, ...unsigned } =
          kv.get(evidenceRef)!;
        kv.set(evidenceRef, await signComponentArtifact(JSON.parse(JSON.stringify(unsigned)),
          ARTIFACT_SEPARATORS.SettlementEvidence, { algorithm: "ed25519", signer: buyerDid, sign },
        ) as Record<string, unknown>);
      }
      const base = saved === "evidence, anchor only" ? undefined : createInMemorySessionStore();
      if (saved.startsWith("checkpoint")) {
        const migrate = await makeDeps(base, { kv, resumeSettlement: await demAudit({ networkFeeOs: "5" }) });
        await expect(runSessionCore(migrate.listingRef, demTerms, migrate.deps, "job-1"))
          .resolves.toMatchObject({ outcome: "completed" });
      }
      // An evidence checkpoint as an earlier writer left it.
      const store: SessionDeps["sessionStore"] = base && saved.startsWith("checkpoint")
        ? { ...base, load: async (jobId) => {
          const value = await base.load(jobId);
          if (value.status !== "ok") return value;
          const record = structuredClone(value.record);
          const cp = record.checkpoints.find((cp) => cp.data?.outcomeSource === "authenticated-evidence")!;
          delete cp.data![saved === "checkpoint without payer" ? "payer" : "networkFeeOs"];
          return { status: "ok" as const, record };
        } }
        : base;
      let reads = 0;
      const resumed = await makeDeps(store, { kv, resumeSettlement: await demAudit({ networkFeeOs: "5" }, () => {
        reads += 1;
      }) });
      if (saved.startsWith("evidence")) {
        // The SDK adapter's rail log binds the paying wallet: the old evidence completes.
        await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
          .resolves.toMatchObject({ outcome: "completed" });
        expect(reads).toBe(1);
        expect(resumed.settleCalls.n).toBe(0);
        return;
      }
      await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1")).rejects.toThrow(
        "saved native success evidence checkpoint does not bind the evidence's payer and fee; the payment remains indeterminate",
      );
      expect(reads).toBe(0);
      expect(resumed.settleCalls.n).toBe(0);
    },
  );

  test.each(["anchor only", "fresh store"].flatMap((saved) =>
    ["payDemSettle", "constant callback", "lost rail log"].map((via) => ({ saved, via }))),
  )("binds the payer of old native success evidence from $saved only through the rail log ($via)", async ({ saved, via }) => {
    const kv = new Map<string, Record<string, unknown>>();
    kv.set("stor:listing", await buildSignedArtifact({ ...listing,
      supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
    const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
    const evidenceRef = `stor:${sessionAnchorName.evidence("job-1")}`;
    const success: SettleResult = { ok: true, txHash: "cd".repeat(32), chainId: "demos", payer: "ab".repeat(32),
      payee: sellerDid, blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" }, networkFeeOs: "5" };
    const first = await makeDeps(createInMemorySessionStore(), { kv,
      settle: olderSdkAdapter(async () => success),
      anchor: async (name, value) => {
        const ref = `stor:${name}`;
        kv.set(ref, value as Record<string, unknown>);
        if (name === sessionAnchorName.evidence("job-1")) throw new Error("evidence ack lost");
        return ref;
      },
    });
    await expect(runSessionCore(first.listingRef, demTerms, first.deps)).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });
    // Evidence as signed before the payer and fee were bound into it.
    const { signature: _signature, dacsSdkSettlementPayer: _payer, dacsSdkNetworkFeeOs: _fee, ...unsigned } =
      kv.get(evidenceRef)!;
    kv.set(evidenceRef, await signComponentArtifact(JSON.parse(JSON.stringify(unsigned)),
      ARTIFACT_SEPARATORS.SettlementEvidence, { algorithm: "ed25519", signer: buyerDid, sign },
    ) as Record<string, unknown>);
    const store = saved === "anchor only" ? undefined : createInMemorySessionStore();
    const evidence = structuredClone([...kv]);
    let reads = 0;
    const counted = () => { reads += 1; };
    const resumed = await makeDeps(store, { kv, resumeSettlement: via === "payDemSettle"
      ? await demAudit({ networkFeeOs: "5" }, counted)
      : via === "lost rail log" ? await demAudit({ networkFeeOs: "5" }, counted, { lost: true })
      : async (): Promise<SettleResult> => { counted(); return success; } });
    const run = runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1");
    expect(resumed.settleCalls.n).toBe(0);
    if (via !== "payDemSettle") {
      await expect(run).rejects.toThrow(via === "lost rail log"
        ? "no SDK record binds the retained transaction"
        : "resumeSettlement is not the payDemSettle adapter, so it is not called");
      expect(reads).toBe(via === "lost rail log" ? 1 : 0);
      expect([...kv]).toEqual(evidence);
      if (store) {
        const held = await store.load("job-1");
        expect(held.status === "ok" && held.record.checkpoints.some((cp) => cp.stage === "outcome")).toBe(false);
      }
      return;
    }
    await expect(run).resolves.toMatchObject({ outcome: "completed" });
    expect(kv.get(evidenceRef)).toEqual(Object.fromEntries(evidence)[evidenceRef]);
    if (store) {
      // The first re-read's payer and fee are recorded beside the unchanged evidence...
      const migrated = await store.load("job-1");
      expect(migrated.status === "ok" && migrated.record.checkpoints.at(-1)?.data)
        .toMatchObject({ outcomeSource: "authenticated-evidence", payer: success.payer, networkFeeOs: "5" });
      // ...and every later re-read must repeat them.
      const refee = await makeDeps(store, { kv, resumeSettlement: await demAudit({ networkFeeOs: "6" }, counted,
        { networkFeeOs: "5" }) });
      await expect(runSessionCore(refee.listingRef, demTerms, refee.deps, "job-1"))
        .rejects.toThrow("fee conflicts with the authenticated network fee");
      expect(await store.load("job-1")).toEqual(migrated);
    }
    const again = await makeDeps(store, { kv, resumeSettlement: await demAudit({ networkFeeOs: "5" }, counted) });
    await expect(runSessionCore(again.listingRef, demTerms, again.deps, "job-1"))
      .resolves.toMatchObject({ outcome: "completed" });
    expect(reads).toBe(store ? 3 : 2);
  });

  test.each(["checkpoint", "anchored evidence", "anchor only"].flatMap((saved) =>
    (["constant callback", "payDemSettle"] as const).map((via) => ({ saved, via }))),
  )("completes a saved native success from $saved only through the SDK adapter ($via)", async ({ saved, via }) => {
    const kv = new Map<string, Record<string, unknown>>();
    kv.set("stor:listing", await buildSignedArtifact({ ...listing,
      supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
    const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
    const success: SettleResult = { ok: true, txHash: "cd".repeat(32), chainId: "demos", payer: "ab".repeat(32),
      payee: sellerDid, blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" }, networkFeeOs: "5" };
    const store = saved === "anchor only" ? undefined : createInMemorySessionStore();
    const first = await makeDeps(store ?? createInMemorySessionStore(), { kv, settle: olderSdkAdapter(async () => success),
      anchor: async (name, value) => {
        const ref = `stor:${name}`;
        if (name === sessionAnchorName.evidence("job-1")) {
          if (saved !== "checkpoint") kv.set(ref, value as Record<string, unknown>);
          throw new Error("evidence ack lost");
        }
        kv.set(ref, value as Record<string, unknown>); return ref;
      },
    });
    await expect(runSessionCore(first.listingRef, demTerms, first.deps)).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });
    const before = store ? await store.load("job-1") : undefined;
    const minted = structuredClone([...kv]);
    let reads = 0;
    // The constant callback echoes the saved success exactly, with no node read behind it.
    const resumed = await makeDeps(store, { kv, resumeSettlement: via === "payDemSettle"
      ? await demAudit({ networkFeeOs: "5" }, () => { reads += 1; })
      : async (): Promise<SettleResult> => { reads += 1; return success; } });
    for (let run = 0; run < 2; run += 1) {
      const result = runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1");
      if (via === "payDemSettle") {
        await expect(result).resolves.toMatchObject({ outcome: "completed" });
        continue;
      }
      // Another callback could never complete it, so it is not called at all.
      await expect(result).rejects.toThrow(
        "resumeSettlement is not the payDemSettle adapter, so it is not called and the payment remains indeterminate",
      );
      if (store) expect(await store.load("job-1")).toEqual(before);
      expect([...kv]).toEqual(minted);
    }
    expect(reads).toBe(via === "payDemSettle" ? 2 : 0);
    expect(resumed.settleCalls.n).toBe(0);
  });

  // A native success is final only from the SDK's own read, fresh or saved: a
  // custom `settle` is never called, so no run completes on a payment that a
  // re-run could not read again. The adapter's session repeats to the same
  // result without a second debit.
  test("never calls a custom native settle, and repeats an adapter-completed session without paying again", async () => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    kv.set("stor:listing", await buildSignedArtifact({ ...listing,
      supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
    const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
    const payer = "ab".repeat(32);
    const payee = sellerDid.split(":").at(-1)!;
    let paid = 0;
    const success: SettleResult = { ok: true, txHash: "cd".repeat(32), chainId: "demos", payer,
      payee: sellerDid, blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" } };
    const wallet = await sdkPayDemRail();
    // A custom callback, and one that delegates to the SDK rail through a wrapper.
    const delegating = payDemSettle(wallet, {}, {});
    for (const [settle, sessions] of [
      [async () => { paid += 1; return success; }, store],
      [async (req: SettleRequest) => { paid += 1; return delegating(req); }, createInMemorySessionStore()],
    ] as const) {
      const custom = await makeDeps(sessions, { kv, settle });
      await expect(runSessionCore(custom.listingRef, demTerms, custom.deps)).rejects.toThrow(
        /requires the SDK's own record read \(fresh native settlement\); settle is not the payDemSettle adapter, so it is not called and no payment is made/,
      );
      // Cold P3-N1: the refusal comes before the claim, so no intent is held
      // for a payment that was never attempted.
      const refused = await sessions.load("job-1");
      expect(refused.status === "ok"
        ? refused.record.checkpoints.filter((cp) => cp.key.startsWith("settle")) : []).toEqual([]);
      // Its re-run calls no custom settle or recovery either.
      const resume = await makeDeps(sessions, { kv, settle, resumeSettlement: settle });
      await expect(runSessionCore(resume.listingRef, demTerms, resume.deps, "job-1")).rejects.toThrow(
        /settle is not the payDemSettle adapter, so it is not called and no payment is made/,
      );
    }
    expect(paid).toBe(0);
    expect(demosNode.transfers).toBe(0);
    expect(kv.has(`stor:${sessionAnchorName.evidence("job-1")}`)).toBe(false);
    // The job then continues through the adapter as `settle` alone, as the
    // README wires it, and pays once.
    const log = createInMemorySettlementLog();
    const reconcile = vi.fn(async (context: Parameters<PayDemSettlementReconcile>[0]) => {
      const retained = "txHash" in context ? context.txHash : "cd".repeat(32);
      return { ok: true as const, execution: "executed" as const, txHash: retained, chainId: "demos", payer, payee,
        blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" as const }, amountOs: "1000000000" };
    });
    const adapter = () => payDemSettle(wallet, {}, { store: createIdempotencyStore(log), reconcile });
    const first = await makeDeps(store ?? createInMemorySessionStore(), { kv, settle: adapter() });
    await expect(runSessionCore(first.listingRef, demTerms, first.deps, "job-1"))
      .resolves.toMatchObject({ outcome: "completed" });
    const completed = await store.load("job-1");
    const evidence = structuredClone([...kv]);
    for (let repeat = 0; repeat < 2; repeat += 1) {
      const again = await makeDeps(store, { kv, settle: adapter(), resumeSettlement: adapter() });
      await expect(runSessionCore(again.listingRef, demTerms, again.deps, "job-1"))
        .resolves.toMatchObject({ outcome: "completed" });
    }
    expect(await store.load("job-1")).toEqual(completed);
    expect([...kv]).toEqual(evidence);
    expect(demosNode.transfers).toBe(1);
    expect(demosNode.broadcasts).toBe(1);
  });

  test.each(["durable rail log", "lost rail log"])(
    "restarts a payDemSettle session whose evidence ack was lost over a %s without a second debit",
    async (railLog) => {
      const store = createInMemorySessionStore();
      const kv = new Map<string, Record<string, unknown>>();
      kv.set("stor:listing", await buildSignedArtifact({ ...listing,
        supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
      const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
      const txHash = "cd".repeat(32);
      const payer = "ab".repeat(32);
      const payee = sellerDid.split(":").at(-1)!;
      const log = createInMemorySettlementLog();
      // The SDK rail over the scripted node: it signs `cd…` and reads it executed.
      const wallet = await sdkPayDemRail();
      const first = await makeDeps(store ?? createInMemorySessionStore(), { kv, settle: payDemSettle(wallet, {}, { store: createIdempotencyStore(log), reconcile: async () => null }),
        anchor: async (name, value) => {
          const ref = `stor:${name}`;
          kv.set(ref, value as Record<string, unknown>);
          if (name === sessionAnchorName.evidence("job-1")) throw new Error("evidence ack lost");
          return ref;
        } });
      await expect(runSessionCore(first.listingRef, demTerms, first.deps)).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });
      const before = await store.load("job-1");
      const evidence = structuredClone([...kv]);
      // A new process: a new bridge over the same log, or over an empty one.
      const reconcile = vi.fn(async (context: Parameters<PayDemSettlementReconcile>[0]) => {
        const retained = "txHash" in context ? context.txHash : "";
        return { ok: true as const, execution: "executed" as const, txHash: retained, chainId: "demos", payer, payee,
          blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" as const }, amountOs: "1000000000",
          // A journal entry the caller supplies can refuse, but never binds the hash on its own.
          preparedTransfer: { txHash: retained, nonce: 9, payer, payee, amountOs: "1000000000", denomination: "os" as const,
            network: "demos", recovery: { railId: "pay-dem", jobId: "job-1", phaseIndex: 0,
              settlementKey: "pay-dem:job-1:0", network: "demos", payer, payee, amountOs: "1000000000" } } };
      });
      const resumed = await makeDeps(store, { kv, resumeSettlement: payDemSettle(wallet, {}, {
        store: createIdempotencyStore(railLog === "durable rail log" ? log : createInMemorySettlementLog()),
        reconcile,
      }) });
      const run = runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1");
      if (railLog === "durable rail log") {
        await expect(run).resolves.toMatchObject({ outcome: "completed" });
      } else {
        // Without the SDK's own record the hash is unbound: held, never re-sent.
        // The buyer's anchored evidence names it, but pay-dem declares no
        // settlement-side job binding (DACS-4 §9.5.9) and SB-2 gives an anchor
        // no collision authority, so it cannot bind the hash to this job.
        await expect(run).rejects.toThrow(
          "no SDK record binds the retained transaction",
        );
        expect(await store.load("job-1")).toEqual(before);
        expect([...kv]).toEqual(evidence);
      }
      expect(reconcile).toHaveBeenCalledOnce();
      expect(demosNode.transfers).toBe(1);
      expect(demosNode.broadcasts).toBe(1);
      expect(resumed.settleCalls.n).toBe(0);
    },
  );

  test.each<[string, Record<string, unknown>]>([
    ["an empty payer", { dacsSdkSettlementPayer: "" }],
    ["a payer that is not a string", { dacsSdkSettlementPayer: 7 }],
    ["a fee that is not canonical decimal", { dacsSdkNetworkFeeOs: "05" }],
    ["a fee without a payer", { dacsSdkSettlementPayer: undefined }],
  ])("refuses saved native success evidence signed with %s, without calling the rail", async (_label, tamper) => {
    const kv = new Map<string, Record<string, unknown>>();
    kv.set("stor:listing", await buildSignedArtifact({ ...listing,
      supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
    const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
    const evidenceRef = `stor:${sessionAnchorName.evidence("job-1")}`;
    const success: SettleResult = { ok: true, txHash: "cd".repeat(32), chainId: "demos", payer: "ab".repeat(32),
      payee: sellerDid, blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" }, networkFeeOs: "5" };
    const first = await makeDeps(createInMemorySessionStore(), { kv, settle: olderSdkAdapter(async () => success),
      anchor: async (name, value) => {
        const ref = `stor:${name}`;
        kv.set(ref, value as Record<string, unknown>);
        if (name === sessionAnchorName.evidence("job-1")) throw new Error("evidence ack lost");
        return ref;
      },
    });
    await expect(runSessionCore(first.listingRef, demTerms, first.deps)).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });
    const { signature: _signature, ...unsigned } = kv.get(evidenceRef)!;
    // JSON drops an `undefined` member, which removes the payer.
    const forged = JSON.parse(JSON.stringify({ ...unsigned, ...tamper }));
    kv.set(evidenceRef, await signComponentArtifact(forged, ARTIFACT_SEPARATORS.SettlementEvidence,
      { algorithm: "ed25519", signer: buyerDid, sign }) as Record<string, unknown>);
    const evidence = structuredClone([...kv]);
    const audit = vi.fn(async (): Promise<SettleResult> => success);
    const resumed = await makeDeps(createInMemorySessionStore(), { kv, resumeSettlement: olderSdkAdapter(audit) });
    await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
      .rejects.toThrow("saved native success evidence has a malformed payer or fee");
    expect(audit).not.toHaveBeenCalled();
    expect(resumed.settleCalls.n).toBe(0);
    expect([...kv]).toEqual(evidence);
  });

  test.each(["payDemSettle", "constant callback", "lost rail log"])(
    "audits old native success evidence under a checkpoint written before payers were bound (%s)",
    async (via) => {
      const kv = new Map<string, Record<string, unknown>>();
      kv.set("stor:listing", await buildSignedArtifact({ ...listing,
        supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
      const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
      const evidenceRef = `stor:${sessionAnchorName.evidence("job-1")}`;
      const success: SettleResult = { ok: true, txHash: "cd".repeat(32), chainId: "demos", payer: "ab".repeat(32),
        payee: sellerDid, blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" }, networkFeeOs: "5" };
      const first = await makeDeps(createInMemorySessionStore(), { kv, settle: olderSdkAdapter(async () => success),
        anchor: async (name, value) => {
          const ref = `stor:${name}`;
          kv.set(ref, value as Record<string, unknown>);
          if (name === sessionAnchorName.evidence("job-1")) throw new Error("evidence ack lost");
          return ref;
        },
      });
      await expect(runSessionCore(first.listingRef, demTerms, first.deps)).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });
      const { signature: _signature, dacsSdkSettlementPayer: _payer, dacsSdkNetworkFeeOs: _fee, ...unsigned } =
        kv.get(evidenceRef)!;
      kv.set(evidenceRef, await signComponentArtifact(JSON.parse(JSON.stringify(unsigned)),
        ARTIFACT_SEPARATORS.SettlementEvidence, { algorithm: "ed25519", signer: buyerDid, sign },
      ) as Record<string, unknown>);
      const base = createInMemorySessionStore();
      const migrate = await makeDeps(base, { kv, resumeSettlement: await demAudit({ networkFeeOs: "5" }) });
      await expect(runSessionCore(migrate.listingRef, demTerms, migrate.deps, "job-1"))
        .resolves.toMatchObject({ outcome: "completed" });
      // The evidence checkpoint as a store that migrated this evidence before payers were bound left it.
      const store: SessionDeps["sessionStore"] = { ...base, load: async (jobId) => {
        const value = await base.load(jobId);
        if (value.status !== "ok") return value;
        const record = structuredClone(value.record);
        const cp = record.checkpoints.find((cp) => cp.data?.outcomeSource === "authenticated-evidence")!;
        delete cp.data!.payer;
        delete cp.data!.networkFeeOs;
        return { status: "ok" as const, record };
      } };
      const before = await base.load("job-1");
      const evidence = structuredClone([...kv]);
      let reads = 0;
      const counted = () => { reads += 1; };
      const resumed = await makeDeps(store, { kv, resumeSettlement: via === "constant callback"
        ? async (): Promise<SettleResult> => { counted(); return success; }
        : await demAudit({ networkFeeOs: "5" }, counted, { networkFeeOs: "5", lost: via === "lost rail log" }) });
      for (let run = 0; run < 2; run += 1) {
        const result = runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1");
        if (via === "payDemSettle") await expect(result).resolves.toMatchObject({ outcome: "completed" });
        else {
          await expect(result).rejects.toThrow(via === "lost rail log"
            ? "no SDK record binds the retained transaction"
            : "resumeSettlement is not the payDemSettle adapter, so it is not called");
        }
      }
      // Each resume re-reads through the rail log; the old checkpoint and evidence stay as they were.
      expect(reads).toBe(via === "constant callback" ? 0 : 2);
      expect(resumed.settleCalls.n).toBe(0);
      expect(await base.load("job-1")).toEqual(before);
      expect([...kv]).toEqual(evidence);
    },
  );

  test.each([
    { saved: "permanent failure", then: "rail success", conflicting: true },
    { saved: "permanent failure", then: "evidence success", conflicting: true },
    { saved: "indeterminate failure", then: "evidence success", conflicting: false },
  ])("reads native history [$saved, $then] for one hash as conflicting: $conflicting", async ({ saved, then, conflicting }) => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    kv.set("stor:listing", await buildSignedArtifact({ ...listing,
      supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
    const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
    const txHash = "cd".repeat(32);
    const payer = "ab".repeat(32);
    const failure: SettleResult = saved === "permanent failure"
      ? { ok: false, txHash, chainId: "demos", payer, payee: sellerDid, blockNumber: 42, txRefKind: "demos",
        errorClass: "permanent", failureProof: { kind: "demos-failed-record", txHash, payer,
          payee: sellerDid.split(":").at(-1)!, nonce: 9, blockNumber: 42, amountOs: "1000000000" } }
      : { ok: false, txHash, chainId: "demos", payer, payee: sellerDid };
    // Only the SDK rail's own read of the failed record is a permanent failure.
    demosNode.recordStatus = "failed";
    const first = await makeDeps(store, { kv, settle: saved === "permanent failure"
      ? payDemSettle(await sdkPayDemRail(), {}, { store: createIdempotencyStore(), reconcile: async () => null }) : olderSdkAdapter(async () => failure),
      anchor: async (name, value) => {
        if (name === sessionAnchorName.evidence("job-1")) throw new Error("anchor unavailable");
        kv.set(`stor:${name}`, value as Record<string, unknown>); return `stor:${name}`;
      },
    });
    await expect(runSessionCore(first.listingRef, demTerms, first.deps))
      .rejects.toThrow(saved === "permanent failure" ? "anchor unavailable" : /remains indeterminate/);
    const loaded = await store.load("job-1");
    if (loaded.status !== "ok") throw new Error("missing session");
    const { errorClass: _class, failureProofJson: _proof, ...rail } =
      loaded.record.checkpoints.filter((cp) => cp.stage === "outcome").at(-1)!.data!;
    const binding = Object.fromEntries(["settlementBindingVersion", "rail", "phase", "agreementHash", "amount",
      "asset", "payeeClaim", "expectedPayee", "phaseIndex"].map((key) => [key, rail[key]]));
    // A store writer appends a success for the same hash after the failure.
    await expect(store.transition({ jobId: "job-1", expectedRevision: loaded.record.revision,
      phase: "settled", now: 1780000000001, checkpoint: { key: "settle:0", stage: "outcome", data: then === "rail success"
        ? { ...rail, ok: true, blockNumber: 42, txRefKind: "demos", finalityModel: "bft-final" }
        : { ...binding, outcomeSource: "authenticated-evidence", evidenceRef: `stor:${sessionAnchorName.evidence("job-1")}`,
          evidenceContentHash: "ef".repeat(32), evidenceSigner: buyerDid, txHash, chainId: "demos",
          txRefKind: "demos", blockNumber: 42, ok: true, payer },
      } })).resolves.toMatchObject({ ok: true });
    const before = await store.load("job-1");
    let audits = 0;
    const resumed = await makeDeps(store, { kv, resumeSettlement: async () => { audits += 1; return failure; } });
    // A recorded permanent failure is terminal: nothing may follow it. A
    // tx-bearing indeterminate one may still resolve to authenticated evidence.
    await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1")).rejects.toThrow(conflicting
      ? "invalid durable state: settlement outcome history contains conflicting entries"
      : "is complete only through authenticated anchored evidence, but that evidence is no longer present");
    expect(audits).toBe(0);
    expect(resumed.settleCalls.n).toBe(0);
    expect(await store.load("job-1")).toEqual(before);
  });

  test("never records a recovered success over a permanent failure another writer bound meanwhile", async () => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    kv.set("stor:listing", await buildSignedArtifact({ ...listing,
      supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
    const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
    const txHash = "cd".repeat(32);
    const payer = "ab".repeat(32);
    const first = await makeDeps(store, { kv, settle: olderSdkAdapter(async () => ({ ok: false, txHash,
      chainId: "demos", payer, payee: sellerDid, blockNumber: 42, txRefKind: "demos" })) });
    await expect(runSessionCore(first.listingRef, demTerms, first.deps)).rejects.toThrow(/remains indeterminate/);
    // Another writer binds the definitive failure while the SDK adapter re-reads the hash.
    const bindFailure = async () => {
      const loaded = await store.load("job-1");
      if (loaded.status !== "ok") throw new Error("missing session");
      const data = loaded.record.checkpoints.filter((cp) => cp.stage === "outcome").at(-1)!.data!;
      await store.transition({ jobId: "job-1", expectedRevision: loaded.record.revision,
        phase: "failed", now: 1780000000001, checkpoint: { key: "settle:0", stage: "outcome", data: {
          ...data, errorClass: "permanent", failureProofJson: JSON.stringify({
            kind: "demos-failed-record", txHash, payer, payee: sellerDid.split(":").at(-1)!,
            nonce: 9, blockNumber: 42, amountOs: "1000000000",
          }),
        } } });
    };
    const resumed = await makeDeps(store, { kv, resumeSettlement: await demAudit({}, bindFailure) });
    await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
      .rejects.toThrow(`could not record settlement outcome for job-1: existing outcome conflicts with ${txHash}`);
    const after = await store.load("job-1");
    expect(after.status === "ok" && after.record.checkpoints.at(-1)?.data)
      .toMatchObject({ ok: false, errorClass: "permanent" });
    expect(resumed.settleCalls.n).toBe(0);
    expect(kv.has(`stor:${sessionAnchorName.evidence("job-1")}`)).toBe(false);
  });

  test.each([
    { rail: "pay-x402", asset: "DEM" },
    { rail: "pay-dem", asset: "USDC" },
  ])("sweep native checks require both pay-dem and DEM: $rail/$asset", async ({ rail, asset }) => {
    const kv = new Map<string, Record<string, unknown>>([["stor:listing",
      await buildSignedArtifact({ ...listing, supportedPaymentRails: [rail] },
        ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>]]);
    const selectedTerms = { ...terms, price: { amount: "1", asset, decimals: 9, rail } };
    const store = createInMemorySessionStore();
    const settle = vi.fn(async (req: SettleRequest): Promise<SettleResult> => ({
      ok: true, txHash: "0xnon-native", chainId: "test:non-native", payer: buyerDid, payee: req.expectedPayee,
    }));
    const first = await makeDeps(store, { kv, settle, anchor: async (name, value) => {
      if (name === sessionAnchorName.evidence("job-1")) throw new Error("sweep non-native boundary");
      kv.set(`stor:${name}`, value as Record<string, unknown>);
      return `stor:${name}`;
    } });
    await expect(runSessionCore(first.listingRef, selectedTerms, first.deps)).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });
    expect(settle).toHaveBeenCalledOnce();
    const changed: typeof store = { ...store, load: async (jobId) => {
      const loaded = await store.load(jobId);
      if (loaded.status !== "ok") return loaded;
      const record = structuredClone(loaded.record);
      record.checkpoints.find((cp) => cp.stage === "outcome")!.data!.networkFeeOs = "12";
      return { status: "ok", record };
    } };
    const resume = vi.fn(async (): Promise<SettleResult> => { throw new Error("must not reconcile malformed state"); });
    const refused = await makeDeps(changed, { kv, settle, resumeSettlement: resume });
    await expect(runSessionCore(refused.listingRef, selectedTerms, refused.deps, "job-1"))
      .rejects.toThrow(/malformed/);
    expect(resume).not.toHaveBeenCalled();
    expect(kv.has(`stor:${sessionAnchorName.evidence("job-1")}`)).toBe(false);
    const allowed = await makeDeps(store, { kv, settle });
    await expect(runSessionCore(allowed.listingRef, selectedTerms, allowed.deps, "job-1"))
      .resolves.toMatchObject({ outcome: "completed" });
    expect(settle).toHaveBeenCalledOnce();
  });

  test("sweep orphan proof on a non-native success refuses before reconciliation", async () => {
    const store = createInMemorySessionStore();
    const first = await makeDeps(store, { anchor: async () => { throw new Error("sweep stop"); } });
    // Let agreement anchoring complete, then stop at the evidence boundary.
    first.deps.anchor = async (name, value) => {
      if (name === sessionAnchorName.evidence("job-1")) throw new Error("sweep stop");
      first.kv.set(`stor:${name}`, value as Record<string, unknown>);
      return `stor:${name}`;
    };
    await expect(runSessionCore(first.listingRef, terms, first.deps)).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });
    const changed: typeof store = { ...store, load: async (jobId) => {
      const loaded = await store.load(jobId);
      if (loaded.status !== "ok") return loaded;
      const record = structuredClone(loaded.record);
      record.checkpoints.find((cp) => cp.stage === "outcome")!.data!.failureProofJson = "{}";
      return { status: "ok", record };
    } };
    const resume = vi.fn(async (): Promise<SettleResult> => { throw new Error("must not reconcile"); });
    const resumed = await makeDeps(changed, { kv: first.kv, resumeSettlement: resume });
    await expect(runSessionCore(resumed.listingRef, terms, resumed.deps, "job-1"))
      .rejects.toThrow(/invalid durable terminal-failure proof/);
    expect(resume).not.toHaveBeenCalled();
    expect(resumed.settleCalls.n).toBe(0);
  });

  test.each([
    { rail: "pay-x402", asset: "DEM" },
    { rail: "pay-dem", asset: "USDC" },
  ])("rejects a non-native durable terminal proof before recovery: $rail/$asset", async ({ rail, asset }) => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>([["stor:listing",
      await buildSignedArtifact({ ...listing, supportedPaymentRails: [rail] },
        ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>]]);
    const selectedTerms = { ...terms, price: { amount: "1", asset, decimals: 9, rail } };
    const payer = "ab".repeat(32);
    const txHash = "cd".repeat(32);
    const settle = vi.fn(async (): Promise<SettleResult> => ({
      ok: false, txHash: "", chainId: "demos", payer, payee: sellerDid,
    }));
    const first = await makeDeps(store, { kv, settle, anchor: async (name, value) => {
      if (name === sessionAnchorName.evidence("job-1")) throw new Error("terminal proof fixture boundary");
      kv.set(`stor:${name}`, value as Record<string, unknown>);
      return `stor:${name}`;
    } });
    await expect(runSessionCore(first.listingRef, selectedTerms, first.deps))
      .rejects.toThrow("terminal proof fixture boundary");
    const loaded = await store.load("job-1");
    if (loaded.status !== "ok") throw new Error("missing fixture session");
    const storedBefore = structuredClone(loaded);
    const data = loaded.record.checkpoints.find((cp) => cp.stage === "outcome")!.data!;
    // Keep the request binding and amount consistent with the Agreement. Only
    // the native-only proof is invalid here; its own failure facts all agree.
    const proof = { kind: "demos-failed-record", txHash, payer,
      payee: sellerDid.split(":").at(-1)!, nonce: 9, blockNumber: 42, amountOs: "1000000000" };
    Object.assign(data, { txHash, blockNumber: 42, txRefKind: "demos",
      errorClass: "permanent", failureProofJson: JSON.stringify(proof) });
    const changed: typeof store = { ...store, load: async (jobId) =>
      jobId === "job-1" ? structuredClone(loaded) : store.load(jobId) };
    const before = await changed.load("job-1");
    const anchors = structuredClone([...kv]);
    const bindHash = vi.spyOn(changed, "bindHash");
    const resume = vi.fn(async (): Promise<SettleResult> => { throw new Error("must not recover a non-native proof"); });
    settle.mockClear();
    const resumed = await makeDeps(changed, { kv, settle, resumeSettlement: resume });
    const error = await runSessionCore(resumed.listingRef, selectedTerms, resumed.deps, "job-1")
      .catch((cause: unknown) => cause);
    expect(resume).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(error).toMatchObject({ message: expect.stringContaining("invalid durable terminal-failure proof") });
    expect(bindHash.mock.calls.filter(([input]) => input.kind === "transaction")).toEqual([]);
    expect(await changed.load("job-1")).toEqual(before);
    expect(await store.load("job-1")).toEqual(storedBefore);
    expect([...kv]).toEqual(anchors);
  });

  test("sweep non-native signed payer extension stays inert through evidence migration and repeat", async () => {
    const first = await makeDeps(undefined);
    first.deps.anchor = async (name, value) => {
      const ref = `stor:${name}`;
      first.kv.set(ref, value as Record<string, unknown>);
      if (name === sessionAnchorName.evidence("job-1")) throw new Error("sweep evidence ack lost");
      return ref;
    };
    await expect(runSessionCore(first.listingRef, terms, first.deps)).rejects.toThrow("sweep evidence ack lost");
    const evidenceRef = `stor:${sessionAnchorName.evidence("job-1")}`;
    const { signature: _signature, ...unsigned } = first.kv.get(evidenceRef)!;
    first.kv.set(evidenceRef, await signComponentArtifact(JSON.parse(JSON.stringify({
      ...unsigned, dacsSdkSettlementPayer: "inert-extension",
    })),
      ARTIFACT_SEPARATORS.SettlementEvidence, { algorithm: "ed25519", signer: buyerDid, sign }) as Record<string, unknown>);
    const store = createInMemorySessionStore();
    for (let repeat = 0; repeat < 2; repeat += 1) {
      const resumed = await makeDeps(store, { kv: first.kv });
      await expect(runSessionCore(resumed.listingRef, terms, resumed.deps, "job-1"))
        .resolves.toMatchObject({ outcome: "completed" });
      const loaded = await store.load("job-1");
      if (loaded.status !== "ok") throw new Error("missing fixture session");
      const checkpoint = loaded.record.checkpoints.find((cp) => cp.stage === "outcome")!.data!;
      expect(checkpoint.outcomeSource).toBe("authenticated-evidence");
      expect(checkpoint).not.toHaveProperty("payer");
      expect(checkpoint).not.toHaveProperty("networkFeeOs");
      expect(resumed.settleCalls.n).toBe(0);
    }
    const conflicting: typeof store = { ...store, load: async (jobId) => {
      const loaded = await store.load(jobId);
      if (loaded.status !== "ok") return loaded;
      const record = structuredClone(loaded.record);
      const evidence = record.checkpoints.find((cp) => cp.stage === "outcome")!;
      record.checkpoints.unshift({ ...evidence, data: { ...evidence.data, ok: false } });
      return { status: "ok", record };
    } };
    const refused = await makeDeps(conflicting, { kv: first.kv });
    await expect(runSessionCore(refused.listingRef, terms, refused.deps, "job-1"))
      .rejects.toThrow(/conflicting entries/);
    expect(refused.settleCalls.n).toBe(0);
  });

  test.each([
    { withStore: true, anchored: true },
    { withStore: true, anchored: false },
    { withStore: false, anchored: true },
  ])(
    "sweep repeats empty-hash definitive failures: store=$withStore, anchored=$anchored", async ({ withStore, anchored }) => {
      const store = withStore ? createInMemorySessionStore() : undefined;
      const settle = vi.fn(async (req: SettleRequest): Promise<SettleResult> => ({
        ok: false, txHash: "", chainId: "test:failure", payer: buyerDid, payee: req.expectedPayee,
      }));
      const first = await makeDeps(store, { settle });
      first.deps.anchor = async (name, value) => {
        const ref = `stor:${name}`;
        if (name === sessionAnchorName.evidence("job-1")) {
          if (anchored) first.kv.set(ref, value as Record<string, unknown>);
          throw new Error("sweep failed evidence boundary");
        }
        first.kv.set(ref, value as Record<string, unknown>);
        return ref;
      };
      await expect(runSessionCore(first.listingRef, terms, first.deps)).rejects.toThrow("sweep failed evidence boundary");
      for (let repeat = 0; repeat < 2; repeat += 1) {
        const resumed = await makeDeps(store, { kv: first.kv, settle });
        await expect(runSessionCore(resumed.listingRef, terms, resumed.deps, "job-1"))
          .resolves.toMatchObject({ outcome: "failed" });
      }
      expect(settle).toHaveBeenCalledOnce();
    },
  );

  describe("a native verdict is final only from the SDK's own node record read", () => {
    const txHash = "cd".repeat(32);
    const payer = "ab".repeat(32);
    const payee = sellerDid.split(":").at(-1)!;
    const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
    const demKv = async () => new Map<string, Record<string, unknown>>([["stor:listing",
      await buildSignedArtifact({ ...listing, supportedPaymentRails: ["pay-dem"] },
        ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>]]);
    const lastOutcome = async (store: ReturnType<typeof createInMemorySessionStore>) => {
      const loaded = await store.load("job-1");
      return loaded.status === "ok"
        ? loaded.record.checkpoints.filter((cp) => cp.stage === "outcome").at(-1)?.data
        : undefined;
    };
    const executedClaim = (retained: string) => ({ ok: true as const, execution: "executed" as const,
      txHash: retained, chainId: "demos", payer, payee, blockNumber: 42, txRefKind: "demos",
      finality: { model: "bft-final" as const }, amountOs: "1000000000" });
    const failedClaim = (hash: string) => ({ ok: false as const, txHash: hash, chainId: "demos", payer, payee,
      blockNumber: 42, txRefKind: "demos", errorClass: "permanent" as const, amountOs: "1000000000",
      failureProof: { kind: "demos-failed-record" as const, txHash: hash, payer, payee, nonce: 9,
        blockNumber: 42, amountOs: "1000000000" } });

    // Every checkpoint and anchor in these sweep fixtures is first written by
    // the current SDK over its own rail; only the retained test input changes.
    async function sweepNative(ok = true, anchored = false, withStore = true, withFee = true) {
      const store = withStore ? createInMemorySessionStore() : undefined;
      const log = createInMemorySettlementLog();
      const kv = await demKv();
      demosNode.recordStatus = ok ? "confirmed" : "failed";
      demosNode.feeOs = withFee ? "12" : undefined;
      const reconcile = vi.fn<PayDemSettlementReconcile>(async () =>
        ok ? { ...executedClaim(txHash), blockNumber: demosNode.blockNumber } : failedClaim(txHash));
      const adapter = () => payDemSettle(sdkRail, {}, { store: createIdempotencyStore(log), reconcile });
      const sdkRail = await sdkPayDemRail();
      const first = await makeDeps(store ?? createInMemorySessionStore(), { kv, settle: adapter(), anchor: async (name, value) => {
        const ref = `stor:${name}`;
        if (name === sessionAnchorName.evidence("job-1")) {
          if (anchored) kv.set(ref, value as Record<string, unknown>);
          throw new Error("sweep evidence boundary");
        }
        kv.set(ref, value as Record<string, unknown>);
        return ref;
      } });
      if (ok) await expect(runSessionCore(first.listingRef, demTerms, first.deps)).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });
      else await expect(runSessionCore(first.listingRef, demTerms, first.deps)).rejects.toThrow("sweep evidence boundary");
      reconcile.mockClear();
      demosNode.reads = [];
      return { store, kv, reconcile, adapter };
    }

    function sweepCheckpoints(
      base: ReturnType<typeof createInMemorySessionStore>, change: (checkpoints: SessionCheckpoint[]) => void,
    ): typeof base {
      return { ...base, load: async (jobId) => {
        const loaded = await base.load(jobId);
        if (loaded.status !== "ok") return loaded;
        const record = structuredClone(loaded.record);
        change(record.checkpoints);
        return { status: "ok", record };
      } };
    }

    test.each(["txHash", "chainId", "amount"] as const)(
      "refuses a single conflicting evidence checkpoint before audit or transaction binding: %s", async (field) => {
        const f = await sweepNative(true, true, false);
        const store = createInMemorySessionStore();
        const migrate = await makeDeps(store, { kv: f.kv, settle: f.adapter() });
        await expect(runSessionCore(migrate.listingRef, demTerms, migrate.deps, "job-1"))
          .resolves.toMatchObject({ outcome: "completed" });
        const changed = sweepCheckpoints(store, (checkpoints) => {
          const outcomes = checkpoints.filter((cp) => cp.key === "settle:0" && cp.stage === "outcome");
          expect(outcomes).toHaveLength(1);
          expect(outcomes[0]!.data).toMatchObject({ outcomeSource: "authenticated-evidence", payer, networkFeeOs: "12" });
          outcomes[0]!.data![field] = field === "txHash" ? "ef".repeat(32) : field === "chainId" ? "demos:other" : "2";
        });
        const before = await changed.load("job-1");
        const storedBefore = await store.load("job-1");
        const anchors = structuredClone([...f.kv]);
        const bindHash = vi.spyOn(changed, "bindHash");
        f.reconcile.mockClear();
        demosNode.reads = [];
        const resumed = await makeDeps(changed, { kv: f.kv, settle: f.adapter() });
        const error = await runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1")
          .catch((cause: unknown) => cause);
        expect(f.reconcile).not.toHaveBeenCalled();
        expect(demosNode.reads).toEqual([]);
        expect(bindHash.mock.calls.filter(([input]) => input.kind === "transaction")).toEqual([]);
        expect(error).toMatchObject({ message: "saved native success evidence conflicts with the durable outcome" });
        expect(await changed.load("job-1")).toEqual(before);
        expect(await store.load("job-1")).toEqual(storedBefore);
        expect([...f.kv]).toEqual(anchors);
        expect(demosNode.transfers).toBe(1);
        expect(demosNode.broadcasts).toBe(1);
      },
    );

    test("rechecks native authority after a store reports a held intent as a fresh claim", async () => {
      const store = createInMemorySessionStore();
      const kv = await demKv();
      const adapter = payDemSettle(await sdkPayDemRail(), {}, {
        store: createIdempotencyStore(), reconcile: async () => null,
      });
      // Interrupt a real configured adapter before it signs or broadcasts.
      demosNode.onTransfer = () => { throw new Error("interrupted native payment"); };
      const first = await makeDeps(store, { kv, settle: adapter });
      await expect(runSessionCore(first.listingRef, demTerms, first.deps))
        .rejects.toThrow("interrupted native payment");
      const before = await store.load("job-1");
      if (before.status !== "ok") throw new Error("missing fixture session");
      expect(before.record.checkpoints.filter((cp) => cp.key === "settle:0"))
        .toEqual([expect.objectContaining({ stage: "intent" })]);
      demosNode.onTransfer = undefined;
      demosNode.transfers = 0;
      demosNode.reads = [];
      const anchors = structuredClone([...kv]);
      const claimCheckpoint = vi.fn<typeof store.claimCheckpoint>(async (input) => {
        const held = await store.claimCheckpoint(input);
        expect(held).toMatchObject({ ok: false, reason: "held" });
        if (!held.record) throw new Error("missing held intent");
        // Structurally valid, matching intent, but the custom store reports it
        // freshly claimed. That response must not authorize a different seam.
        return { ok: true, record: held.record };
      });
      const changed = { ...store, claimCheckpoint };
      const settle = vi.fn(async (): Promise<SettleResult> => executedClaim(txHash));
      const resumed = await makeDeps(changed, { kv, settle });
      const error = await runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1")
        .catch((cause: unknown) => cause);
      expect(claimCheckpoint).toHaveBeenCalledOnce();
      expect(settle).not.toHaveBeenCalled();
      expect(error).toMatchObject({ message: expect.stringContaining("requires the SDK's own record read (fresh native settlement); settle is not the payDemSettle adapter") });
      expect(demosNode.transfers).toBe(0);
      expect(demosNode.broadcasts).toBe(0);
      expect(demosNode.reads).toEqual([]);
      expect(await store.load("job-1")).toEqual(before);
      expect([...kv]).toEqual(anchors);
    });

    test("sweep current native checkpoint without a fee survives later record fee metadata unchanged", async () => {
      const f = await sweepNative(true, false, true, false);
      const original = await lastOutcome(f.store!);
      expect(original).not.toHaveProperty("networkFeeOs");
      demosNode.records.set(txHash, nodeRecord({ txHash, payer, payee,
        amountOs: "1000000000", feeOs: "12" }));
      const resumed = await makeDeps(f.store, { kv: f.kv, settle: f.adapter() });
      resumed.deps.nowMs = () => 1780000999999;
      await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
        .resolves.toMatchObject({ outcome: "completed" });
      expect(await lastOutcome(f.store!)).toEqual(original);
      expect(f.reconcile).toHaveBeenCalledOnce();
      expect(demosNode.reads).toEqual([txHash]);
      expect(demosNode.transfers).toBe(1);
      expect(demosNode.broadcasts).toBe(1);
    });

    test("sweep current evidence signing a payer without a fee migrates and repeats without adopting an unsigned fee", async () => {
      const f = await sweepNative(true, true, false, false);
      const evidenceRef = `stor:${sessionAnchorName.evidence("job-1")}`;
      const evidence = structuredClone(f.kv.get(evidenceRef)!);
      expect(evidence.dacsSdkSettlementPayer).toBe(payer);
      expect(evidence).not.toHaveProperty("dacsSdkNetworkFeeOs");
      demosNode.records.set(txHash, nodeRecord({ txHash, payer, payee,
        amountOs: "1000000000", feeOs: "12" }));
      const store = createInMemorySessionStore();
      for (let repeat = 0; repeat < 2; repeat += 1) {
        const resumed = await makeDeps(store, { kv: f.kv, settle: f.adapter() });
        await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
          .resolves.toMatchObject({ outcome: "completed" });
        expect(await lastOutcome(store)).toMatchObject({ outcomeSource: "authenticated-evidence", payer });
        expect(await lastOutcome(store)).not.toHaveProperty("networkFeeOs");
        expect(f.kv.get(evidenceRef)).toEqual(evidence);
      }
      expect(demosNode.transfers).toBe(1);
      expect(demosNode.broadcasts).toBe(1);
    });

    test.each([0, 42])("sweep accepts matching current rail-to-evidence history at block %s", async (blockNumber) => {
      demosNode.blockNumber = blockNumber;
      const f = await sweepNative(true, true);
      const railState = await f.store!.load("job-1");
      if (railState.status !== "ok") throw new Error("missing rail fixture");
      const rail = railState.record.checkpoints.find((cp) => cp.stage === "outcome")!;
      const store = createInMemorySessionStore();
      const migrate = await makeDeps(store, { kv: f.kv, settle: f.adapter() });
      await expect(runSessionCore(migrate.listingRef, demTerms, migrate.deps, "job-1"))
        .resolves.toMatchObject({ outcome: "completed" });
      expect(await lastOutcome(store)).toMatchObject({ outcomeSource: "authenticated-evidence", blockNumber });
      const history = sweepCheckpoints(store, (checkpoints) => checkpoints.unshift(structuredClone(rail)));
      const resumed = await makeDeps(history, { kv: f.kv, settle: f.adapter() });
      await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
        .resolves.toMatchObject({ outcome: "completed" });
      expect(demosNode.transfers).toBe(1);
      expect(demosNode.broadcasts).toBe(1);
    });

    test.each([
      { field: "payer", value: "ef".repeat(32) },
      { field: "finalityModel", value: "provider-receipt" },
    ])("sweep saved success $field must equal the valid SDK audit", async ({ field, value }) => {
      const f = await sweepNative();
      const before = await f.store!.load("job-1");
      const anchors = structuredClone([...f.kv]);
      const changed = sweepCheckpoints(f.store!, (checkpoints) => {
        checkpoints.find((cp) => cp.stage === "outcome")!.data![field] = value;
      });
      const resumed = await makeDeps(changed, { kv: f.kv, settle: f.adapter() });
      await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
        .rejects.toThrow(/conflicts with the saved success/);
      expect(f.reconcile).toHaveBeenCalledOnce();
      expect(demosNode.reads).toEqual([txHash]);
      expect([...f.kv]).toEqual(anchors);
      expect(await f.store!.load("job-1")).toEqual(before);
      const allowed = await makeDeps(f.store, { kv: f.kv, settle: f.adapter() });
      await expect(runSessionCore(allowed.listingRef, demTerms, allowed.deps, "job-1"))
        .resolves.toMatchObject({ outcome: "completed" });
      expect(demosNode.transfers).toBe(1);
    });

    test.each([
      { failureProofJson: "{}" },
      { errorClass: "permanent" },
      { errorClass: "permanent", failureProofJson: "{" },
      { errorClass: "permanent", failureProofJson: JSON.stringify(failedClaim(txHash).failureProof) },
    ])("sweep rejects orphan or invalid terminal proof fields on a current success: %j", async (fields) => {
      const f = await sweepNative();
      const changed = sweepCheckpoints(f.store!, (checkpoints) => {
        Object.assign(checkpoints.find((cp) => cp.stage === "outcome")!.data!, fields);
      });
      const before = await f.store!.load("job-1");
      const anchors = structuredClone([...f.kv]);
      const resumed = await makeDeps(changed, { kv: f.kv, settle: f.adapter() });
      await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
        .rejects.toThrow(/invalid durable terminal-failure proof/);
      expect(f.reconcile).not.toHaveBeenCalled();
      expect(demosNode.reads).toEqual([]);
      expect(await f.store!.load("job-1")).toEqual(before);
      expect([...f.kv]).toEqual(anchors);
      expect(demosNode.transfers).toBe(1);
    });

    test("sweep contradictory valid failed-record proofs are rejected before reconciliation", async () => {
      const f = await sweepNative(false);
      const changed = sweepCheckpoints(f.store!, (checkpoints) => {
        const outcome = checkpoints.find((cp) => cp.stage === "outcome")!;
        const proof = JSON.parse(outcome.data!.failureProofJson as string);
        checkpoints.unshift({ ...outcome, data: { ...outcome.data,
          failureProofJson: JSON.stringify({ ...proof, nonce: proof.nonce + 1 }) } });
      });
      const resumed = await makeDeps(changed, { kv: f.kv, settle: f.adapter() });
      await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
        .rejects.toThrow(/conflicting entries/);
      expect(f.reconcile).not.toHaveBeenCalled();
      expect(demosNode.reads).toEqual([]);
      expect(demosNode.transfers).toBe(1);
    });

    test.each(["payer", "kind", "finality", "matching"] as const)(
      "sweep authenticated saved success facts are compared to a valid audit: %s", async (field) => {
        const f = await sweepNative(true, true, false);
        const evidenceRef = `stor:${sessionAnchorName.evidence("job-1")}`;
        const { signature: _signature, ...unsigned } = f.kv.get(evidenceRef)!;
        const changed = structuredClone(unsigned);
        if (field === "payer") changed.dacsSdkSettlementPayer = "ef".repeat(32);
        if (field === "kind") (changed.paymentTxRefs as Record<string, unknown>[])[0]!.kind = "payment";
        if (field === "finality") changed.settlementFinality = {
          ...(changed.settlementFinality as Record<string, unknown>), model: "provider-receipt",
        };
        f.kv.set(evidenceRef, await signComponentArtifact(changed, ARTIFACT_SEPARATORS.SettlementEvidence,
          { algorithm: "ed25519", signer: buyerDid, sign }) as Record<string, unknown>);
        const anchors = structuredClone([...f.kv]);
        const resumed = await makeDeps(undefined, { kv: f.kv, settle: f.adapter() });
        const run = runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1");
        if (field === "matching") await expect(run).resolves.toMatchObject({ outcome: "completed" });
        else {
          await expect(run).rejects.toThrow("saved native success evidence contradicts chain execution");
          expect([...f.kv]).toEqual(anchors);
        }
        expect(f.reconcile).toHaveBeenCalledOnce();
        expect(demosNode.reads).toEqual([txHash]);
        expect(demosNode.transfers).toBe(1);
      },
    );

    test("sweep failure evidence with another tx-ref kind refuses before the real adapter audits", async () => {
      const f = await sweepNative(false, true);
      const evidenceRef = `stor:${sessionAnchorName.evidence("job-1")}`;
      const { signature: _signature, ...unsigned } = structuredClone(f.kv.get(evidenceRef)!);
      (unsigned.paymentTxRefs as Record<string, unknown>[])[0]!.kind = "payment";
      f.kv.set(evidenceRef, await signComponentArtifact(unsigned, ARTIFACT_SEPARATORS.SettlementEvidence,
        { algorithm: "ed25519", signer: buyerDid, sign }) as Record<string, unknown>);
      const before = await f.store!.load("job-1");
      const anchors = structuredClone([...f.kv]);
      const resumed = await makeDeps(f.store, { kv: f.kv, settle: f.adapter() });
      await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
        .rejects.toThrow(/cannot become a terminal checkpoint/);
      expect(f.reconcile).not.toHaveBeenCalled();
      expect(demosNode.reads).toEqual([]);
      expect(await f.store!.load("job-1")).toEqual(before);
      expect([...f.kv]).toEqual(anchors);
      expect(demosNode.transfers).toBe(1);
    });

    test.each(["payer", "networkFeeOs", "ok"] as const)(
      "sweep contradictory evidence checkpoint $field refuses before reconciliation", async (field) => {
        const f = await sweepNative(true, true, false);
        const store = createInMemorySessionStore();
        const migrate = await makeDeps(store, { kv: f.kv, settle: f.adapter() });
        await expect(runSessionCore(migrate.listingRef, demTerms, migrate.deps, "job-1"))
          .resolves.toMatchObject({ outcome: "completed" });
        const data = await lastOutcome(store);
        expect(data).toMatchObject({ outcomeSource: "authenticated-evidence", payer, networkFeeOs: "12" });
        const changed = sweepCheckpoints(store, (checkpoints) => {
          const outcome = checkpoints.find((cp) => cp.stage === "outcome")!;
          checkpoints.unshift({ ...outcome, data: { ...outcome.data,
            [field]: field === "payer" ? "ef".repeat(32) : field === "networkFeeOs" ? "13" : false } });
        });
        f.reconcile.mockClear();
        demosNode.reads = [];
        const resumed = await makeDeps(changed, { kv: f.kv, settle: f.adapter() });
        await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
          .rejects.toThrow(/conflicting entries|malformed/);
        expect(f.reconcile).not.toHaveBeenCalled();
        expect(demosNode.reads).toEqual([]);
        expect(demosNode.transfers).toBe(1);
      },
    );

    test.each(["payer", "networkFeeOs"] as const)(
      "sweep current evidence checkpoint rejects numeric %s before reconciliation", async (field) => {
        const f = await sweepNative(true, true, false);
        const store = createInMemorySessionStore();
        const migrate = await makeDeps(store, { kv: f.kv, settle: f.adapter() });
        await expect(runSessionCore(migrate.listingRef, demTerms, migrate.deps, "job-1"))
          .resolves.toMatchObject({ outcome: "completed" });
        const changed = sweepCheckpoints(store, (checkpoints) => {
          checkpoints.find((cp) => cp.stage === "outcome")!.data![field] = 12;
        });
        f.reconcile.mockClear();
        demosNode.reads = [];
        const before = await store.load("job-1");
        const anchors = structuredClone([...f.kv]);
        const resumed = await makeDeps(changed, { kv: f.kv, settle: f.adapter() });
        await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
          .rejects.toThrow(/authenticated-evidence outcome has malformed or extra fields/);
        expect(f.reconcile).not.toHaveBeenCalled();
        expect(demosNode.reads).toEqual([]);
        expect(await store.load("job-1")).toEqual(before);
        expect([...f.kv]).toEqual(anchors);
        expect(demosNode.transfers).toBe(1);
      },
    );

    test("sweep an unrelated checkpoint cannot claim a refused native settlement", async () => {
      const store = createInMemorySessionStore();
      const kv = await demKv();
      const first = await makeDeps(store, { kv, settle: payDemSettle(await sdkPayDemRail()) });
      await expect(runSessionCore(first.listingRef, demTerms, first.deps))
        .rejects.toThrow(/caller-supplied settlement store and reconciler/);
      const loaded = await store.load("job-1");
      if (loaded.status !== "ok") throw new Error("missing fixture session");
      await store.transition({ jobId: "job-1", expectedRevision: loaded.record.revision,
        phase: loaded.record.phase, now: 1780000000001, checkpoint: { key: "unrelated", stage: "intent" } });
      await expect(runSessionCore(first.listingRef, demTerms, first.deps, "job-1"))
        .rejects.toThrow(/caller-supplied settlement store and reconciler/);
      const refused = await store.load("job-1");
      expect(refused.status === "ok" && refused.record.checkpoints.some((cp) => cp.key === "settle:0")).toBe(false);
      expect(demosNode.transfers).toBe(0);
      const allowed = await makeDeps(store, { kv, settle: payDemSettle(await sdkPayDemRail(), {}, {
        store: createIdempotencyStore(), reconcile: async () => executedClaim(txHash),
      }) });
      await expect(runSessionCore(allowed.listingRef, demTerms, allowed.deps, "job-1"))
        .resolves.toMatchObject({ outcome: "completed" });
      expect(demosNode.transfers).toBe(1);
    });

    test.each([false, true].flatMap((explicitResume) => [false, true].map((keepLog) =>
      ({ explicitResume, keepLog }))))(
      "cold intent-only restart never submits: explicitResume=$explicitResume, retainedLog=$keepLog",
      async ({ explicitResume, keepLog }) => {
        const store = createInMemorySessionStore();
        const log = createInMemorySettlementLog();
        const kv = await demKv();
        const dying: typeof store = { ...store, bindHash: async (input) => {
          if (input.kind === "transaction") throw new Error("crash before session outcome");
          return store.bindHash(input);
        } };
        const first = await makeDeps(dying, { kv,
          settle: payDemSettle(await sdkPayDemRail(), {}, {
            store: createIdempotencyStore(log), reconcile: async () => null,
          }) });
        await expect(runSessionCore(first.listingRef, demTerms, first.deps))
          .rejects.toThrow("crash before session outcome");
        expect(await lastOutcome(store)).toBeUndefined();
        expect(demosNode.broadcasts).toBe(1);
        // Recreate both the rail and bridge, as a fresh process would. A lost
        // log must never turn the session's existing intent into a new payment.
        const reconcile = vi.fn<PayDemSettlementReconcile>(async () => executedClaim(txHash));
        const restarted = payDemSettle(await sdkPayDemRail(), {}, keepLog
          ? { store: createIdempotencyStore(log), reconcile } : {});
        const resumed = await makeDeps(store, { kv, settle: restarted,
          ...(explicitResume ? { resumeSettlement: restarted } : {}) });
        const before = await store.load("job-1");
        const result = await runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1")
          .then((value) => ({ value, error: undefined }), (error) => ({ value: undefined, error }));
        expect(demosNode.transfers).toBe(1);
        expect(demosNode.broadcasts).toBe(1);
        if (keepLog) {
          expect(result.error).toBeUndefined();
          expect(result.value).toMatchObject({ outcome: "completed" });
          expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ txHash }));
        } else {
          expect(result.error?.message).toMatch(/recovery has no recorded attempt/);
          expect(await store.load("job-1")).toEqual(before);
        }
      },
    );

    test.each([true, false].flatMap((sessionStore) => ["neither", "store", "reconciler", "undefined store"].map((configured) =>
      ({ sessionStore, configured }))))(
      "refuses unrecoverable fresh configuration before claiming: sessionStore=$sessionStore, configured=$configured",
      async ({ sessionStore, configured }) => {
        const store = sessionStore ? createInMemorySessionStore() : undefined;
        const kv = await demKv();
        const adapter = payDemSettle(await sdkPayDemRail(), {}, {
          ...(configured === "store" ? { store: createIdempotencyStore() } : {}),
          ...(configured === "undefined store" ? { store: undefined } : {}),
          ...(configured === "reconciler" || configured === "undefined store" ? { reconcile: async () => null } : {}),
        });
        const first = await makeDeps(store, { kv, settle: adapter });
        await expect(runSessionCore(first.listingRef, demTerms, first.deps))
          .rejects.toThrow(/caller-supplied settlement store and reconciler/);
        if (store) {
          const loaded = await store.load("job-1");
          expect(loaded.status === "ok" && loaded.record.checkpoints.some((cp) => cp.key === "settle:0"))
            .toBe(false);
        }
        expect(demosNode.transfers).toBe(0);
        expect(demosNode.broadcasts).toBe(0);
      },
    );

    test.each([true, false])("restarts a configured native session with SessionStore=%s", async (hasSessionStore) => {
      const store = hasSessionStore ? createInMemorySessionStore() : undefined;
      const log = createInMemorySettlementLog();
      const kv = await demKv();
      const adapter = async () => payDemSettle(await sdkPayDemRail(), {}, {
        store: createIdempotencyStore(log), reconcile: async () => executedClaim(txHash),
      });
      const first = await makeDeps(store ?? createInMemorySessionStore(), { kv, settle: await adapter() });
      await expect(runSessionCore(first.listingRef, demTerms, first.deps))
        .resolves.toMatchObject({ outcome: "completed" });
      const resumed = await makeDeps(store, { kv, settle: await adapter() });
      await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
        .resolves.toMatchObject({ outcome: "completed" });
      expect(demosNode.transfers).toBe(1);
      expect(demosNode.broadcasts).toBe(1);
    });

    test.each(["callback", "wrapper", "bound", "unconfigured adapter", "adapter", "separate adapter"])(
      "checks supplied resume configuration before claiming or paying (%s)", async (kind) => {
        const store = createInMemorySessionStore();
        const kv = await demKv();
        const railStore = createIdempotencyStore();
        const adapter = payDemSettle(await sdkPayDemRail(), {}, { store: railStore,
          reconcile: async () => executedClaim(txHash) });
        const callback = vi.fn(async (req: SettleRequest) => adapter(req));
        const resumeSettlement = kind === "adapter" ? adapter : kind === "bound"
          ? adapter.bind(undefined) : kind === "wrapper" ? callback : kind === "unconfigured adapter"
            ? payDemSettle(await sdkPayDemRail()) : kind === "separate adapter"
              ? payDemSettle(await sdkPayDemRail(), {}, { store: railStore, reconcile: async () => executedClaim(txHash) })
              : async () => executedClaim(txHash);
        const settle = kind === "separate adapter"
          ? payDemSettle(await sdkPayDemRail(), {}, { store: railStore }) : adapter;
        const first = await makeDeps(store, { kv, settle, resumeSettlement });
        const result = runSessionCore(first.listingRef, demTerms, first.deps);
        if (kind === "adapter" || kind === "separate adapter") {
          await expect(result).resolves.toMatchObject({ outcome: "completed" });
          expect(demosNode.broadcasts).toBe(1);
        } else {
          await expect(result).rejects.toThrow(kind === "unconfigured adapter"
            ? /caller-supplied settlement store and reconciler/ : /resumeSettlement is not the payDemSettle adapter/);
          const loaded = await store.load("job-1");
          expect(loaded.status === "ok" && loaded.record.checkpoints.some((cp) => cp.key === "settle:0"))
            .toBe(false);
          expect(demosNode.broadcasts).toBe(0);
          expect(demosNode.transfers).toBe(0);
        }
        expect(callback).not.toHaveBeenCalled();
      },
    );

    test.each([true, false].flatMap((ok) => [true, false].flatMap((anchorCommitted) =>
      [true, false].map((explicitResume) => ({ ok, anchorCommitted, explicitResume })))))(
      "retries native evidence anchoring after re-reading ok=$ok, anchored=$anchorCommitted, explicitResume=$explicitResume",
      async ({ ok, anchorCommitted, explicitResume }) => {
        const store = createInMemorySessionStore();
        const kv = await demKv();
        demosNode.recordStatus = ok ? "confirmed" : "failed";
        const adapter = payDemSettle(await sdkPayDemRail(), {}, { store: createIdempotencyStore(),
          reconcile: async () => ok ? executedClaim(txHash) : failedClaim(txHash) });
        const first = await makeDeps(store, { kv, settle: adapter, anchor: async (name, value) => {
          const ref = `stor:${name}`;
          if (name === sessionAnchorName.evidence("job-1")) {
            if (anchorCommitted) kv.set(ref, value as Record<string, unknown>);
            throw new Error("evidence acknowledgment lost");
          }
          kv.set(ref, value as Record<string, unknown>);
          return ref;
        } });
        if (ok) await expect(runSessionCore(first.listingRef, demTerms, first.deps)).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });
        else await expect(runSessionCore(first.listingRef, demTerms, first.deps))
          .rejects.toThrow("evidence acknowledgment lost");
        const original = structuredClone(demosNode.records.get(txHash)) as Record<string, unknown>;
        demosNode.records.set(txHash, { ...original, status: ok ? "failed" : "confirmed" });
        const resumed = await makeDeps(store, { kv, settle: adapter,
          ...(explicitResume ? { resumeSettlement: adapter } : {}) });
        const before = await store.load("job-1");
        const anchors = structuredClone([...kv]);
        demosNode.reads = [];
        await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
          .rejects.toThrow(/contradicts the node record the SDK read/);
        expect(demosNode.reads).toEqual([txHash]);
        expect(await store.load("job-1")).toEqual(before);
        expect([...kv]).toEqual(anchors);
        demosNode.records.set(txHash, original);
        for (let retry = 0; retry < 2; retry += 1) {
          demosNode.reads = [];
          await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
            .resolves.toMatchObject({ outcome: ok ? "completed" : "failed" });
          expect(demosNode.reads).toEqual([txHash]);
        }
        expect(demosNode.transfers).toBe(1);
        expect(demosNode.broadcasts).toBe(1);
      },
    );

    test("recovers after restarting with the original rail log and a settle adapter alone", async () => {
      const store = createInMemorySessionStore();
      const log = createInMemorySettlementLog();
      const kv = await demKv();
      const first = await makeDeps(store, { kv,
        settle: payDemSettle(await sdkPayDemRail(), {}, { store: createIdempotencyStore(log), reconcile: async () => null }),
        anchor: async (name, value) => {
          if (name === sessionAnchorName.evidence("job-1")) throw new Error("evidence unavailable");
          kv.set(`stor:${name}`, value as Record<string, unknown>);
          return `stor:${name}`;
        } });
      await expect(runSessionCore(first.listingRef, demTerms, first.deps)).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });
      const reconcile = vi.fn<PayDemSettlementReconcile>(async () => executedClaim(txHash));
      const restarted = await makeDeps(store, { kv,
        settle: payDemSettle(await sdkPayDemRail(), {}, { store: createIdempotencyStore(log), reconcile }) });
      demosNode.reads = [];
      await expect(runSessionCore(restarted.listingRef, demTerms, restarted.deps, "job-1"))
        .resolves.toMatchObject({ outcome: "completed" });
      expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ txHash }));
      expect(demosNode.reads).toEqual([txHash]);
      expect(demosNode.transfers).toBe(1);
      expect(demosNode.broadcasts).toBe(1);
    });

    // A recovery the SDK did not read (the adapter over a custom rail) holds
    // the hash it reports: only its transaction identity.
    const heldRecovery = () => olderSdkAdapter(vi.fn(async (req: SettleRequest): Promise<SettleResult> =>
      ({ ok: false, txHash, chainId: "demos", payer, payee: req.expectedPayee })));
    const lostResponse = () => olderSdkAdapter(async (): Promise<SettleResult> => {
      throw new Error("transfer response lost");
    });

    // Outside review F1: refusing a reported hash before binding it let a
    // later adapter, over a rail log without the intent, broadcast again.
    test("binds and saves a hash a recovery holds, so a later adapter audits it instead of paying again", async () => {
      const store = createInMemorySessionStore();
      const kv = await demKv();
      const first = await makeDeps(store, { kv, settle: lostResponse() });
      await expect(runSessionCore(first.listingRef, demTerms, first.deps)).rejects.toThrow("transfer response lost");
      // A recovery that names the transfer without the SDK's own read of it.
      const custom = heldRecovery();
      const second = await makeDeps(store, { kv, resumeSettlement: custom });
      await expect(runSessionCore(second.listingRef, demTerms, second.deps, "job-1"))
        .rejects.toThrow(`settlement demos:${txHash} remains indeterminate`);
      expect(custom).toHaveBeenCalledOnce();
      await expect(store.bindHash({ hash: txHash, jobId: "other", kind: "transaction" }))
        .resolves.toEqual({ ok: false, boundTo: "job-1" });
      expect(await lastOutcome(store)).toMatchObject({ ok: false, txHash });
      // The SDK adapter over a rail log that never saw the intent: the session
      // sends the saved hash, so the adapter audits it and never broadcasts.
      demosNode.records.set(txHash, nodeRecord({ txHash, payer, payee, amountOs: "1000000000" }));
      const reconcile = vi.fn(async (context: Parameters<PayDemSettlementReconcile>[0]) =>
        executedClaim("txHash" in context ? context.txHash : ""));
      const third = await makeDeps(store, { kv, resumeSettlement: payDemSettle(await sdkPayDemRail(), {}, {
        store: createIdempotencyStore(createInMemorySettlementLog()), reconcile,
      }) });
      await expect(runSessionCore(third.listingRef, demTerms, third.deps, "job-1"))
        .rejects.toThrow("no SDK record binds the retained transaction");
      expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ txHash }));
      expect(demosNode.transfers).toBe(0);
      expect(demosNode.broadcasts).toBe(0);
      expect(third.settleCalls.n).toBe(0);
    });

    // A process killed after binding a held recovery's hash and before
    // saving it as the held outcome loses nothing. The restart
    // finds the hash bound to this job and the intent still held, saves the
    // held outcome, and never pays.
    test("retries a crash between binding a recovered hash and saving it held, read-only", async () => {
      const store = createInMemorySessionStore();
      const kv = await demKv();
      const first = await makeDeps(store, { kv, settle: lostResponse() });
      await expect(runSessionCore(first.listingRef, demTerms, first.deps)).rejects.toThrow("transfer response lost");
      const custom = heldRecovery();
      let killed = false;
      const dying: typeof store = { ...store, transition: async (input) => {
        if (!killed && input.checkpoint?.stage === "outcome") {
          killed = true;
          throw new Error("process killed");
        }
        return store.transition(input);
      } };
      const second = await makeDeps(dying, { kv, resumeSettlement: custom });
      await expect(runSessionCore(second.listingRef, demTerms, second.deps, "job-1")).rejects.toThrow("process killed");
      expect(killed).toBe(true);
      await expect(store.bindHash({ hash: txHash, jobId: "other", kind: "transaction" }))
        .resolves.toEqual({ ok: false, boundTo: "job-1" });
      expect(await lastOutcome(store)).toBeUndefined();
      const third = await makeDeps(store, { kv, resumeSettlement: custom });
      await expect(runSessionCore(third.listingRef, demTerms, third.deps, "job-1"))
        .rejects.toThrow(`settlement demos:${txHash} remains indeterminate`);
      expect(custom).toHaveBeenCalledTimes(2);
      expect(await lastOutcome(store)).toMatchObject({ ok: false, txHash });
      expect(second.settleCalls.n + third.settleCalls.n).toBe(0);
      expect(demosNode.transfers).toBe(0);
    });

    // Cold P1-1: a rail's fee is its debit accounting (the confirmation's gas
    // fee), which the signed record need not carry. The session saved and
    // signed that fee, then every restart re-read the record's and refused its
    // own saved success. Only the record's fee is saved, signed and re-read now.
    test.each([
      ["createPayDemRail's confirmation", undefined],
      ["createPayDemRail's confirmation, on a record without a fee", "none"],
    ] as const)("completes, resumes and repeats a session whose debit fee from %s is not its record's, paying once", async (_source, recordFee) => {
      const kv = await demKv();
      const log = createInMemorySettlementLog();
      const hash = txHash;
      const recordFeeOs = recordFee === "none" ? undefined : "0";
      // The confirmation reports a 2 DEM fee; the signed record carries 0 OS
      // (or none).
      demosNode.feeOs = recordFeeOs;
      demosNode.confirmFeeOs = "2000000000";
      // Each run is a new process: a new rail and bridge over the durable rail log.
      const adapter = async () => payDemSettle(await sdkPayDemRail(), {}, { store: createIdempotencyStore(log),
        reconcile: async (context) => executedClaim("txHash" in context ? context.txHash : hash) });
      const evidence = `stor:${sessionAnchorName.evidence("job-1")}`;
      const crashAtEvidence: SessionDeps["anchor"] = async (name, value) => {
        if (`stor:${name}` === evidence) throw new Error("process killed at the evidence anchor");
        kv.set(`stor:${name}`, value as Record<string, unknown>);
        return `stor:${name}`;
      };
      const feeOf = (value: unknown) => recordFeeOs === undefined
        ? expect(value).not.toHaveProperty("networkFeeOs")
        : expect(value).toMatchObject({ networkFeeOs: recordFeeOs });

      const store = createInMemorySessionStore();
      const first = await makeDeps(store, { kv, settle: await adapter(), anchor: crashAtEvidence });
      await expect(runSessionCore(first.listingRef, demTerms, first.deps))
        .resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });
      const saved = await lastOutcome(store);
      expect(saved).toMatchObject({ ok: true, txHash: hash });
      feeOf(saved);
      const resumed = await makeDeps(store, { kv, settle: await adapter(), resumeSettlement: await adapter() });
      await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
        .resolves.toMatchObject({ outcome: "completed" });
      const signed = kv.get(evidence);
      expect(signed).toMatchObject({ outcome: "success", dacsSdkSettlementPayer: payer });
      if (recordFeeOs === undefined) expect(signed).not.toHaveProperty("dacsSdkNetworkFeeOs");
      else expect(signed).toMatchObject({ dacsSdkNetworkFeeOs: recordFeeOs });

      // Re-run the completed session: same result, no new write.
      const completed = await store.load("job-1");
      const anchored = structuredClone([...kv]);
      const again = await makeDeps(store, { kv, settle: await adapter(), resumeSettlement: await adapter() });
      await expect(runSessionCore(again.listingRef, demTerms, again.deps, "job-1"))
        .resolves.toMatchObject({ outcome: "completed" });
      expect(await store.load("job-1")).toEqual(completed);
      expect([...kv]).toEqual(anchored);
      expect(demosNode.broadcasts).toBe(1);
      expect(first.settleCalls.n + resumed.settleCalls.n + again.settleCalls.n).toBe(0);
    });

    test("pays without a crash, then repeats, when the confirmation's fee is not the record's", async () => {
      const kv = await demKv();
      const log = createInMemorySettlementLog();
      demosNode.feeOs = "0";
      demosNode.confirmFeeOs = "2000000000";
      const adapter = async () => payDemSettle(await sdkPayDemRail(), {}, { store: createIdempotencyStore(log),
        reconcile: async (context) => executedClaim("txHash" in context ? context.txHash : txHash) });
      const store = createInMemorySessionStore();
      const first = await makeDeps(store, { kv, settle: await adapter() });
      await expect(runSessionCore(first.listingRef, demTerms, first.deps))
        .resolves.toMatchObject({ outcome: "completed" });
      expect(kv.get(`stor:${sessionAnchorName.evidence("job-1")}`))
        .toMatchObject({ outcome: "success", dacsSdkNetworkFeeOs: "0" });
      const again = await makeDeps(store, { kv, settle: await adapter(), resumeSettlement: await adapter() });
      await expect(runSessionCore(again.listingRef, demTerms, again.deps, "job-1"))
        .resolves.toMatchObject({ outcome: "completed" });
      expect(demosNode.broadcasts).toBe(1);
    });

    // The rail's own result keeps the confirmation's debit, which a host
    // books as the wallet's spend (dacs-node); only payDemSettle reports the
    // record's fee.
    test("keeps the confirmation's debit on the rail result and reports the record's fee from payDemSettle", async () => {
      demosNode.feeOs = "0";
      demosNode.confirmFeeOs = "2000000000";
      await expect((await sdkPayDemRail()).settle({ recipient: payee, amount: "1000000000" }))
        .resolves.toMatchObject({ ok: true, execution: "executed", networkFeeOs: "2000000000" });
      demosNode.nextHash = "ce".repeat(32);
      demosNode.nonce = 10;
      await expect(payDemSettle(await sdkPayDemRail(), {}, { store: createIdempotencyStore() })({
        amount: "1", asset: "DEM", expectedPayee: sellerDid, jobId: "job-fee", payee: sellerDid,
        phase: "pay-dem", phaseIndex: 0, rail: "pay-dem",
      })).resolves.toMatchObject({ ok: true, networkFeeOs: "0" });
    });

    // A process killed after the SDK rail recorded the failed
    // record it read, and before the session bound and saved it, leaves only
    // the intent. The resume's re-check returns that failure for a hash the
    // session never held, so it is held once; the next resume ends it failed.
    test("holds a recovered failure for a hash the session never held, then ends it failed once held", async () => {
      const store = createInMemorySessionStore();
      const kv = await demKv();
      const log = createInMemorySettlementLog();
      demosNode.recordStatus = "failed";
      const wallet = await sdkPayDemRail();
      let killed = false;
      const dying: typeof store = { ...store, bindHash: async (input) => {
        if (input.kind !== "transaction") return store.bindHash(input);
        killed = true;
        throw new Error(`process killed before binding ${input.hash}`);
      } };
      const first = await makeDeps(dying, { kv,
        settle: payDemSettle(wallet, {}, { store: createIdempotencyStore(log), reconcile: async () => null }) });
      await expect(runSessionCore(first.listingRef, demTerms, first.deps)).rejects.toThrow("process killed");
      expect(killed).toBe(true);
      expect(await lastOutcome(store)).toBeUndefined();
      const reconcile = vi.fn(async (context: Parameters<PayDemSettlementReconcile>[0]) =>
        failedClaim("txHash" in context ? context.txHash : txHash));
      const resume = async () => makeDeps(store, { kv,
        resumeSettlement: payDemSettle(wallet, {}, { store: createIdempotencyStore(log), reconcile }) });
      const held = await resume();
      await expect(runSessionCore(held.listingRef, demTerms, held.deps, "job-1"))
        .rejects.toThrow(`settlement demos:${txHash} remains indeterminate`);
      const saved = await lastOutcome(store);
      expect(saved).toMatchObject({ ok: false, txHash });
      expect(saved).not.toHaveProperty("errorClass");
      expect(kv.has(`stor:${sessionAnchorName.evidence("job-1")}`)).toBe(false);
      const final = await resume();
      await expect(runSessionCore(final.listingRef, demTerms, final.deps, "job-1"))
        .resolves.toMatchObject({ outcome: "failed" });
      expect(await lastOutcome(store)).toMatchObject({ ok: false, txHash, errorClass: "permanent" });
      expect(kv.get(`stor:${sessionAnchorName.evidence("job-1")}`)).toMatchObject({ outcome: "failure" });
      expect(demosNode.transfers).toBe(1);
      expect(demosNode.broadcasts).toBe(1);
      expect(held.settleCalls.n + final.settleCalls.n).toBe(0);
    });

    // Outside review F2: a failed record found by (payer, payee, amount) may
    // be another job's; it never ends this session failed.
    test("never ends a session failed on a failed record a lookup by key finds for a hash it never held", async () => {
      const store = createInMemorySessionStore();
      const kv = await demKv();
      const log = createInMemorySettlementLog();
      // The SDK rail's transfer is lost before it signs: only the intent is in the log.
      const lost = vi.fn(async () => { throw new Error("transfer response lost"); });
      demosNode.onTransfer = lost;
      const first = await makeDeps(store, { kv, settle: payDemSettle(await sdkPayDemRail(), {}, {
        store: createIdempotencyStore(log, { owner: "before", now: () => 1, leaseDurationMs: 1 }),
        reconcile: async () => null,
      }) });
      await expect(runSessionCore(first.listingRef, demTerms, first.deps)).rejects.toThrow("transfer response lost");
      const otherJob = "ef".repeat(32);
      demosNode.records.set(otherJob, nodeRecord({ txHash: otherJob, payer, payee, amountOs: "1000000000",
        status: "failed" }));
      const reconcile = vi.fn(async () => failedClaim(otherJob));
      const resumed = await makeDeps(store, { kv, resumeSettlement: payDemSettle(await sdkPayDemRail(), {}, {
        store: createIdempotencyStore(log, { owner: "after", now: () => 3, leaseDurationMs: 1 }), reconcile,
      }) });
      await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
        .rejects.toThrow(/recovery has no recorded attempt/);
      expect(reconcile).not.toHaveBeenCalled();
      expect(await lastOutcome(store)).toBeUndefined();
      expect(kv.has(`stor:${sessionAnchorName.evidence("job-1")}`)).toBe(false);
      // Only the first run's lost transfer was ever started, and nothing was broadcast.
      expect(lost).toHaveBeenCalledOnce();
      expect(demosNode.transfers).toBe(1);
      expect(demosNode.broadcasts).toBe(0);
    });
  });

  test("completes a saved tx-bearing indeterminate native failure that the SDK adapter re-reads as executed", async () => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    kv.set("stor:listing", await buildSignedArtifact({ ...listing,
      supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
    const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
    // A custom native rail's non-final reply with the block and kind a success re-read repeats.
    const first = await makeDeps(store, { kv, settle: olderSdkAdapter(async () => ({ ok: false,
      txHash: "cd".repeat(32), chainId: "demos", payer: "ab".repeat(32), payee: sellerDid, blockNumber: 42,
      txRefKind: "demos" })) });
    await expect(runSessionCore(first.listingRef, demTerms, first.deps)).rejects.toThrow(/remains indeterminate/);
    const resumed = await makeDeps(store, { kv, resumeSettlement: await demAudit() });
    // The executed re-read is never folded into the saved failure (PC-7).
    await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
      .resolves.toMatchObject({ outcome: "completed" });
    const after = await store.load("job-1");
    expect(after.status === "ok" && after.record.checkpoints.filter((cp) => cp.stage === "outcome").at(-1)?.data)
      .toMatchObject({ ok: true, txHash: "cd".repeat(32) });
    expect(kv.get(`stor:${sessionAnchorName.evidence("job-1")}`)).toMatchObject({ outcome: "success" });
    expect(resumed.settleCalls.n).toBe(0);
  });

  test.each(["anchor only", "fresh store"].flatMap((saved) =>
    ["block", "block omitted", "kind"].map((reply) => ({ saved, reply }))),
  )("re-asserts the signed block and kind of native success evidence from $saved on $reply", async ({ saved, reply }) => {
    const kv = new Map<string, Record<string, unknown>>();
    kv.set("stor:listing", await buildSignedArtifact({ ...listing,
      supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
    const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
    const success: SettleResult = { ok: true, txHash: "cd".repeat(32), chainId: "demos", payer: "ab".repeat(32),
      payee: sellerDid, blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" } };
    const first = await makeDeps(createInMemorySessionStore(), { kv,
      settle: olderSdkAdapter(async () => success),
      anchor: async (name, value) => {
        const ref = `stor:${name}`;
        kv.set(ref, value as Record<string, unknown>);
        if (name === sessionAnchorName.evidence("job-1")) throw new Error("evidence ack lost");
        return ref;
      },
    });
    await expect(runSessionCore(first.listingRef, demTerms, first.deps)).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });
    // Only the signed evidence reaches the resume; no rail checkpoint can refuse first.
    const store = saved === "anchor only" ? undefined : createInMemorySessionStore();
    const evidence = structuredClone([...kv]);
    let reads = 0;
    // Through the SDK adapter: a rail log, node record and claim all at block
    // 43, or a claim without the block or with another kind.
    const resumed = await makeDeps(store, { kv, resumeSettlement: await demAudit(
      reply === "block" ? { blockNumber: 43 } : {},
      ({ claim }) => {
        reads += 1;
        const { blockNumber: _block, ...unblocked } = claim;
        return reply === "block omitted" ? unblocked
          : reply === "kind" ? { ...claim, txRefKind: "payment" } : undefined;
      },
    ) });
    await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1")).rejects.toThrow(
      reply === "block" ? "saved native success evidence contradicts chain execution"
        : reply === "block omitted" ? /success lacks canonical tx identity, block evidence/
          : /non-Demos transaction reference/,
    );
    expect(reads).toBe(1);
    expect(resumed.settleCalls.n).toBe(0);
    expect([...kv]).toEqual(evidence);
    if (store) {
      const loaded = await store.load("job-1");
      expect(loaded.status === "ok" ? loaded.record.checkpoints : []).toEqual([]);
    }
  });

  test.each([true, false])(
    "re-reads a saved payDemSettle fee from the node record whether or not the reconciler reports it (echoes=%s)",
    async (echoesFee) => {
      const store = createInMemorySessionStore();
      const kv = new Map<string, Record<string, unknown>>();
      kv.set("stor:listing", await buildSignedArtifact({ ...listing,
        supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
      const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
      const txHash = "cd".repeat(32);
      const payer = "ab".repeat(32);
      const payee = sellerDid.split(":").at(-1)!;
      const railStore = createIdempotencyStore();
      // The SDK rail signs a transfer whose record carries a 5 OS fee.
      demosNode.feeOs = "5";
      const fresh = payDemSettle(await sdkPayDemRail(), {}, { store: railStore, reconcile: async () => null });
      const first = await makeDeps(store, { kv, settle: fresh, anchor: async (name, value) => {
        if (name === sessionAnchorName.evidence("job-1")) throw new Error("evidence crash");
        const ref = `stor:${name}`; kv.set(ref, value as Record<string, unknown>); return ref;
      } });
      await expect(runSessionCore(first.listingRef, demTerms, first.deps)).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });
      const saved = await store.load("job-1");
      expect(saved.status === "ok" && saved.record.checkpoints.at(-1)?.data)
        .toMatchObject({ ok: true, networkFeeOs: "5" });
      // A restarted process: a new bridge over the same durable rail log.
      const audit = async () => payDemSettle(await sdkPayDemRail(), {}, {
        store: railStore, reconcile: async (context) => ({
          ok: true, execution: "executed", txHash, chainId: "demos", payer, payee,
          blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" }, amountOs: "1000000000",
          ...(echoesFee ? { networkFeeOs: "5" } : {}),
          preparedTransfer: { txHash: "txHash" in context ? context.txHash : "", nonce: 9, payer, payee,
            amountOs: "1000000000", denomination: "os", network: "demos", recovery: { railId: "pay-dem",
              jobId: "job-1", phaseIndex: 0, settlementKey: "pay-dem:job-1:0", network: "demos", payer, payee,
              amountOs: "1000000000" } },
        }) });
      // The node now serves the record with another fee: the saved one is not
      // re-asserted, so the success stays saved and nothing is minted.
      const record = demosNode.records.get(txHash) as { content: Record<string, unknown> };
      demosNode.records.set(txHash, { ...record, content: { ...record.content,
        transaction_fee: { network_fee: "6", rpc_fee: "0", additional_fee: "0" } } });
      const refeed = await makeDeps(store, { kv, resumeSettlement: await audit() });
      await expect(runSessionCore(refeed.listingRef, demTerms, refeed.deps, "job-1"))
        .rejects.toThrow(/contradicts the node record the SDK read/);
      expect(await store.load("job-1")).toEqual(saved);
      expect(kv.has(`stor:${sessionAnchorName.evidence("job-1")}`)).toBe(false);
      // The fee is the SDK's own read of the record, whether or not the
      // reconciler reports it.
      demosNode.records.set(txHash, record);
      const resumed = await makeDeps(store, { kv, resumeSettlement: await audit() });
      await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
        .resolves.toMatchObject({ outcome: "completed" });
      expect(resumed.settleCalls.n).toBe(0);
      expect(demosNode.broadcasts).toBe(1);
    },
  );

  // demosdk signs in DEM numbers before the denomination fork, and the node
  // keeps the transaction as signed after it activates.
  test("completes a payment saved before the denomination fork after the fork activates, paying once", async () => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    kv.set("stor:listing", await buildSignedArtifact({ ...listing,
      supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
    const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
    const txHash = "cd".repeat(32);
    const payer = "ab".repeat(32);
    const payee = sellerDid.split(":").at(-1)!;
    const railStore = createIdempotencyStore();
    // Before the fork the SDK rail signs 1 DEM with a 1 DEM fee.
    Object.assign(demosNode, { postFork: false, feeOs: "1000000000" });
    const first = await makeDeps(store, { kv, settle: payDemSettle(await sdkPayDemRail(), {}, { store: railStore, reconcile: async () => null }),
      anchor: async (name, value) => {
        if (name === sessionAnchorName.evidence("job-1")) throw new Error("evidence crash");
        const ref = `stor:${name}`; kv.set(ref, value as Record<string, unknown>); return ref;
      } });
    await expect(runSessionCore(first.listingRef, demTerms, first.deps)).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });
    expect((demosNode.records.get(txHash) as { content: Record<string, unknown> }).content)
      .toMatchObject({ amount: 1, data: ["native", { nativeOperation: "send", args: [payee, 1] }] });
    const saved = await store.load("job-1");
    expect(saved.status === "ok" && saved.record.checkpoints.at(-1)?.data)
      .toMatchObject({ ok: true, txHash, networkFeeOs: "1000000000" });
    // The fork activates, and a restarted process re-reads the saved success.
    demosNode.postFork = true;
    const resumed = await makeDeps(store, { kv, resumeSettlement: payDemSettle(await sdkPayDemRail(), {}, {
      store: railStore, reconcile: async (context) => ({
        ok: true, execution: "executed", txHash, chainId: "demos", payer, payee,
        blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" }, amountOs: "1000000000",
        preparedTransfer: { txHash: "txHash" in context ? context.txHash : "", nonce: 9, payer, payee,
          amountOs: "1000000000", denomination: "dem", network: "demos", recovery: { railId: "pay-dem",
            jobId: "job-1", phaseIndex: 0, settlementKey: "pay-dem:job-1:0", network: "demos", payer, payee,
            amountOs: "1000000000" } },
      }) }) });
    await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
      .resolves.toMatchObject({ outcome: "completed" });
    expect(resumed.settleCalls.n).toBe(0);
    expect(demosNode.transfers).toBe(1);
    expect(demosNode.broadcasts).toBe(1);
    expect(kv.get(`stor:${sessionAnchorName.evidence("job-1")}`))
      .toMatchObject({ outcome: "success", dacsSdkSettlementPayer: payer, dacsSdkNetworkFeeOs: "1000000000" });
  });

  test.each(["0", "1000000000"])("retains a payDemSettle fee of %s OS across session restart", async (networkFeeOs) => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    kv.set("stor:listing", await buildSignedArtifact({ ...listing,
      supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
    const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
    const payer = "ab".repeat(32);
    // The SDK rail signs a transfer whose record carries this fee.
    demosNode.feeOs = networkFeeOs;
    const settle = payDemSettle(await sdkPayDemRail(), {}, { store: createIdempotencyStore(), reconcile: async () => null });
    const first = await makeDeps(store, { kv, settle,
      anchor: async (name, value) => {
        if (name === sessionAnchorName.evidence("job-1")) throw new Error("anchor unavailable");
        const ref = `stor:${name}`; kv.set(ref, value as Record<string, unknown>); return ref;
      },
    });
    await expect(runSessionCore(first.listingRef, demTerms, first.deps))
      .resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });
    const loaded = await store.load("job-1");
    if (loaded.status !== "ok") throw new Error("missing session");
    const checkpoint = loaded.record.checkpoints.find((cp) => cp.key === "settle:0" && cp.stage === "outcome");
    expect(checkpoint?.data).toMatchObject({ ok: true, networkFeeOs });
    let reconciliations = 0;
    const reconcileWith = (echoFee: boolean) => async (req: SettleRequest): Promise<SettleResult> => {
      reconciliations += 1;
      expect(req.priorAttempts?.at(-1)).toMatchObject({ txHash: "cd".repeat(32), ok: true });
      return { ok: true, txHash: "cd".repeat(32), chainId: "demos", payer,
        payee: req.expectedPayee, blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" },
        ...(echoFee ? { networkFeeOs } : {}) };
    };
    // A saved fee is a chain fact only the SDK adapter's own read re-asserts;
    // a callback echoing or omitting it is never called.
    const before = await store.load("job-1");
    for (const echoFee of [false, true]) {
      const unread = await makeDeps(store, { kv, resumeSettlement: reconcileWith(echoFee) });
      await expect(runSessionCore(unread.listingRef, demTerms, unread.deps, "job-1"))
        .rejects.toThrow(/resumeSettlement is not the payDemSettle adapter, so it is not called/);
    }
    expect(reconciliations).toBe(0);
    expect(await store.load("job-1")).toEqual(before);
    expect(kv.has(`stor:${sessionAnchorName.evidence("job-1")}`)).toBe(false);
    const resumed = await makeDeps(store, { kv, resumeSettlement: await demAudit({ networkFeeOs }, (context) => {
      reconciliations += 1;
      expect(context.txHash).toBe("cd".repeat(32));
    }) });
    await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
      .resolves.toMatchObject({ outcome: "completed" });
    await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
      .resolves.toMatchObject({ outcome: "completed" });
    expect(demosNode.transfers).toBe(1);
    expect(reconciliations).toBe(2);
    const retained = await store.load("job-1");
    expect(retained.status === "ok" && retained.record.checkpoints.find((cp) => cp.stage === "outcome")?.data?.networkFeeOs)
      .toBe(networkFeeOs);
    expect(resumed.settleCalls.n).toBe(0);
    expect(kv.get(`stor:${sessionAnchorName.evidence("job-1")}`))
      .toMatchObject({ outcome: "success", settlementFinality: { model: "bft-final" },
        dacsSdkSettlementPayer: payer, dacsSdkNetworkFeeOs: networkFeeOs });

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

  test("accepts a network fee only from a native DEM settlement, fresh or saved", async () => {
    const store = createInMemorySessionStore();
    const f = await makeDeps(store, { settle: async (req) => ({
      ok: true, txHash: "0xpaid", chainId: "eip155:84532", payer: "0xbuyer", payee: req.expectedPayee,
      networkFeeOs: "1",
    }) });
    await expect(runSessionCore(f.listingRef, terms, f.deps))
      .rejects.toThrow("settlement rail returned a native DEM network fee for a non-native settlement");
    expect(f.kv.has(`stor:${sessionAnchorName.evidence("job-1")}`)).toBe(false);
    const loaded = await store.load("job-1");
    expect(loaded.status === "ok" && loaded.record.checkpoints.some((cp) => cp.stage === "outcome"))
      .toBe(false);

    const saved = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    const first = await makeDeps(saved, { kv, anchor: async (name, value) => {
      if (name === sessionAnchorName.evidence("job-1")) throw new Error("anchor unavailable");
      kv.set(`stor:${name}`, value as Record<string, unknown>); return `stor:${name}`;
    } });
    await expect(runSessionCore(first.listingRef, terms, first.deps)).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });
    const withFee = await makeDeps({ ...saved, load: async (jobId) => {
      const value = await saved.load(jobId);
      if (value.status === "ok") {
        value.record.checkpoints.find((cp) => cp.key === "settle:0" && cp.stage === "outcome")!
          .data!.networkFeeOs = "1";
      }
      return value;
    } }, { kv });
    await expect(runSessionCore(withFee.listingRef, terms, withFee.deps, "job-1")).rejects.toThrow(/malformed/);
    expect(withFee.settleCalls.n).toBe(0);
    expect(kv.has(`stor:${sessionAnchorName.evidence("job-1")}`)).toBe(false);
  });

  test.each(["permanent failure", "success", "absence"])(
    "refuses a native %s for another transaction while the retained transfer is unresolved",
    async (reply) => {
      const store = createInMemorySessionStore();
      const kv = new Map<string, Record<string, unknown>>();
      kv.set("stor:listing", await buildSignedArtifact({ ...listing,
        supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
      const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
      const payer = "ab".repeat(32);
      const payee = sellerDid.split(":").at(-1)!;
      const hashA = "12".repeat(32);
      const hashB = "34".repeat(32);
      const first = await makeDeps(store, { kv, settle: olderSdkAdapter(async () => ({ ok: false, txHash: hashA,
        chainId: "demos", payer, payee: sellerDid, blockNumber: 41, txRefKind: "demos" })) });
      await expect(runSessionCore(first.listingRef, demTerms, first.deps)).rejects.toThrow(/indeterminate/);
      const before = await store.load("job-1");
      const beforeKv = structuredClone([...kv]);
      let recoveries = 0;
      // The session refuses another hash whatever adapter reports it.
      const resumed = await makeDeps(store, { kv, resumeSettlement: olderSdkAdapter(async (req): Promise<SettleResult> => {
        recoveries += 1;
        expect(req.priorAttempts).toEqual([{ txHash: hashA, chainId: "demos", ok: false }]);
        if (reply === "absence") return { ok: false, txHash: "", chainId: "demos", payer, payee: sellerDid };
        return reply === "success"
          ? { ok: true, txHash: hashB, chainId: "demos", payer, payee: sellerDid, blockNumber: 42,
            txRefKind: "demos", finality: { model: "bft-final" } }
          : { ok: false, txHash: hashB, chainId: "demos", payer, payee: sellerDid, blockNumber: 42,
            txRefKind: "demos", errorClass: "permanent", failureProof: { kind: "demos-failed-record",
              txHash: hashB, payer, payee, nonce: 10, blockNumber: 42, amountOs: "1000000000" } };
      }) });
      await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
        .rejects.toThrow(/not the retained transfer; a native transfer is never replaced/);
      expect(recoveries).toBe(1);
      expect(await store.load("job-1")).toEqual(before);
      expect([...kv]).toEqual(beforeKv);
    },
  );

  test("a permanent failure saved over a native success is refused as conflicting history", async () => {
    const store = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    kv.set("stor:listing", await buildSignedArtifact({ ...listing,
      supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
    const demTerms = { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } };
    const txHash = "cd".repeat(32);
    const payer = "ab".repeat(32);
    const success: SettleResult = { ok: true, txHash, chainId: "demos", payer, payee: sellerDid,
      blockNumber: 42, txRefKind: "demos", finality: { model: "bft-final" } };
    const first = await makeDeps(store, { kv, settle: olderSdkAdapter(async () => success),
      anchor: async (name, value) => {
        if (name === sessionAnchorName.evidence("job-1")) throw new Error("anchor unavailable");
        kv.set(`stor:${name}`, value as Record<string, unknown>); return `stor:${name}`;
      },
    });
    await expect(runSessionCore(first.listingRef, demTerms, first.deps)).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });
    // A self-consistent failure record appended by a store writer is the newest entry.
    const loaded = await store.load("job-1");
    if (loaded.status !== "ok") throw new Error("missing session");
    const { finalityModel: _model, ...binding } =
      loaded.record.checkpoints.find((cp) => cp.stage === "outcome")!.data!;
    await expect(store.transition({ jobId: "job-1", expectedRevision: loaded.record.revision,
      phase: "failed", now: 1780000000001, checkpoint: { key: "settle:0", stage: "outcome", data: {
        ...binding, ok: false, errorClass: "permanent", failureProofJson: JSON.stringify({
          kind: "demos-failed-record", txHash, payer, payee: sellerDid.split(":").at(-1)!,
          nonce: 9, blockNumber: 42, amountOs: "1000000000",
        }),
      } } })).resolves.toMatchObject({ ok: true });
    const before = await store.load("job-1");
    let audits = 0;
    const resumed = await makeDeps(store, { kv, resumeSettlement: async () => { audits += 1; return success; } });
    for (let repeat = 0; repeat < 2; repeat += 1) {
      // A success is never demoted, so the pair is invalid history (PC-7).
      await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
        .rejects.toThrow("invalid durable state: settlement outcome history contains conflicting entries");
    }
    expect(audits).toBe(0);
    expect(await store.load("job-1")).toEqual(before);
    expect(kv.has(`stor:${sessionAnchorName.evidence("job-1")}`)).toBe(false);
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

  describe("a pay-dem permanent failed-record result (#338)", () => {
    const FAILED_HASH = "85".repeat(32);
    const PAYER_HEX = "ab".repeat(32);
    const payeeHex = sellerDid.slice("did:demos:agent:".length);
    const failedRecord = (
      payee: string,
      proof: Record<string, unknown> = {},
    ): SettleResult => ({
      ok: false,
      txHash: FAILED_HASH,
      chainId: "demos",
      payer: PAYER_HEX,
      payee,
      errorClass: "permanent",
      blockNumber: 480877,
      txRefKind: "demos",
      failureProof: {
        kind: "demos-failed-record",
        txHash: FAILED_HASH,
        nonce: 9,
        blockNumber: 480877,
        payer: PAYER_HEX,
        payee: payeeHex,
        amountOs: "9500000000",
        ...proof,
      } as SettleResult["failureProof"],
    });
    const outcomes = async (store: ReturnType<typeof createInMemorySessionStore>) => {
      const loaded = await store.load("job-1");
      return loaded.status === "ok"
        ? loaded.record.checkpoints.filter((checkpoint) => checkpoint.stage === "outcome")
        : [];
    };
    // 9.5 DEM is 9500000000 OS, the proof amount above.
    const demTerms = {
      ...terms,
      price: { amount: "9.5", asset: "DEM", decimals: 9, rail: "pay-dem" },
    };
    const demKv = async () => new Map<string, Record<string, unknown>>([[
      "stor:listing",
      (await buildSignedArtifact(
        { ...listing, supportedPaymentRails: ["pay-dem"] },
        ARTIFACT_SEPARATORS.Listing,
        sign,
      )) as Record<string, unknown>,
    ]]);

    test("never calls a callback for a native failed-record proof, fresh or on recovery", async () => {
      // The proof is terminal only from the SDK adapter's own record read, and
      // a native session calls no other implementation at all (a custom rail's
      // proof through the adapter is held: see the custom pay-dem rail below).
      const demTerms = { ...terms, price: { amount: "9.5", asset: "DEM", decimals: 9, rail: "pay-dem" } };
      const store = createInMemorySessionStore();
      const kv = await demKv();
      const callback = vi.fn(async (req: SettleRequest) => failedRecord(req.expectedPayee));
      const first = await makeDeps(store, { kv, settle: callback });
      await expect(runSessionCore(first.listingRef, demTerms, first.deps))
        .rejects.toThrow(/settle is not the payDemSettle adapter, so it is not called and no payment is made/);
      // The refusal claimed nothing (cold P3-N1), so a re-run's settle is
      // refused the same way and its recovery is never reached.
      const resumed = await makeDeps(store, { kv, settle: callback, resumeSettlement: callback });
      await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
        .rejects.toThrow(/settle is not the payDemSettle adapter, so it is not called and no payment is made/);
      expect(callback).not.toHaveBeenCalled();
      expect(await outcomes(store)).toHaveLength(0);
      // Nothing bound the hash to this job.
      await expect(store.bindHash({ hash: FAILED_HASH, jobId: "other", kind: "transaction" }))
        .resolves.toEqual({ ok: true, boundTo: "other" });

      // The same proof cannot settle another rail's payment.
      const x402Store = createInMemorySessionStore();
      const x402 = await makeDeps(x402Store, { settle: async (req) => failedRecord(req.expectedPayee) });
      await expect(runSessionCore(x402.listingRef, terms, x402.deps))
        .rejects.toThrow(/does not bind the requested pay-dem amount/);
      expect(await outcomes(x402Store)).toHaveLength(0);
    });

    test.each<[string, (payee: string) => SettleResult]>([
      ["another amount", (payee) => failedRecord(payee, { amountOs: "" })],
      ["another transaction", (payee) => failedRecord(payee, { txHash: "34".repeat(32) })],
      ["another payee", (payee) => failedRecord(payee, { payee: "ef".repeat(32) })],
      ["a permanent class without a proof", (payee) => {
        const { failureProof: _proof, ...result } = failedRecord(payee);
        return result;
      }],
      ["a proof without a permanent class", (payee) => {
        const { errorClass: _class, ...result } = failedRecord(payee);
        return result;
      }],
    ])("refuses a failed-record proof with %s as malformed", async (_case, result) => {
      const store = createInMemorySessionStore();
      const first = await makeDeps(store, {
        kv: await demKv(),
        settle: olderSdkAdapter(async (req) => result(req.expectedPayee)),
      });
      await expect(runSessionCore(first.listingRef, demTerms, first.deps))
        .rejects.toThrow(/malformed terminal-failure proof/);
      expect(await outcomes(store)).toHaveLength(0);
    });

    test("refuses a valid proof for another DEM amount on fresh settlement", async () => {
      const store = createInMemorySessionStore();
      const first = await makeDeps(store, {
        kv: await demKv(),
        settle: olderSdkAdapter(async (req) => failedRecord(req.expectedPayee, { amountOs: "20000000000" })),
      });
      await expect(runSessionCore(first.listingRef, demTerms, first.deps))
        .rejects.toThrow(/does not bind the requested pay-dem amount/);
      expect(await outcomes(store)).toHaveLength(0);
    });

    test("refuses a valid proof for another DEM amount on recovery", async () => {
      const store = createInMemorySessionStore();
      const kv = await demKv();
      // A held attempt: only the hash of the transfer.
      const first = await makeDeps(store, {
        kv,
        settle: olderSdkAdapter(async (req) => ({ ok: false, txHash: FAILED_HASH, chainId: "demos",
          payer: PAYER_HEX, payee: req.expectedPayee })),
      });
      await expect(runSessionCore(first.listingRef, demTerms, first.deps))
        .rejects.toThrow(/remains indeterminate/);
      const resumed = await makeDeps(store, {
        kv,
        resumeSettlement: olderSdkAdapter(async (req) =>
          failedRecord(req.expectedPayee, { amountOs: "20000000000" })),
      });
      await expect(runSessionCore(resumed.listingRef, demTerms, resumed.deps, "job-1"))
        .rejects.toThrow(/does not bind the requested pay-dem amount/);
      expect(await outcomes(store)).toHaveLength(1);
    });

    // The proof binds shape, not origin: a custom rail that could invent one
    // no node served is refused before the session can call it, so it can
    // neither pay nor leave a durable verdict (#338).
    test("refuses a custom pay-dem rail that could invent a proof before calling it", async () => {
      const log = createInMemorySettlementLog();
      const putOutcome = vi.spyOn(log, "putOutcome");
      const rail: PayDemRail = {
        address: PAYER_HEX,
        settle: vi.fn(async () => failedRecord(payeeHex) as Awaited<ReturnType<PayDemRail["settle"]>>),
      };
      const settle = payDemSettle(rail, { network: "demos" }, {
        store: createIdempotencyStore(log),
      });
      await expect(settle({
        rail: "pay-dem",
        phase: "pay-dem",
        amount: "9.5",
        asset: "DEM",
        payee: sellerDid,
        expectedPayee: payeeHex,
        jobId: "job-1",
        phaseIndex: 0,
      })).rejects.toThrow(/createPayDemRail returned.*refusing/);
      expect(rail.settle).not.toHaveBeenCalled();
      expect(putOutcome).not.toHaveBeenCalled();
    });

    test("refuses a failed-record proof on a session that is not a DEM payment", async () => {
      const store = createInMemorySessionStore();
      const first = await makeDeps(store, {
        settle: async (req) => failedRecord(req.expectedPayee),
      });
      await expect(runSessionCore(first.listingRef, terms, first.deps))
        .rejects.toThrow(/does not bind the requested pay-dem amount/);
      expect(await outcomes(store)).toHaveLength(0);
    });
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
    ).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });

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
    ).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });

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
    { field: "txHash", value: "0xhidden-conflict", native: false },
    { field: "networkFeeOs", value: "2", native: true },
  ])("rejects conflicting $field hidden below the newest checkpoint", async ({ field, value, native }) => {
    const base = createInMemorySessionStore();
    const kv = new Map<string, Record<string, unknown>>();
    if (native) {
      kv.set("stor:listing", await buildSignedArtifact({ ...listing,
        supportedPaymentRails: ["pay-dem"] }, ARTIFACT_SEPARATORS.Listing, sign) as Record<string, unknown>);
    }
    const sessionTerms = native
      ? { ...terms, price: { amount: "1", asset: "DEM", decimals: 9, rail: "pay-dem" } }
      : terms;
    let submits = 0;
    const interrupted = await makeDeps(base, {
      kv,
      settle: olderSdkAdapter(async (req) => {
        submits += 1;
        return native
          ? { ok: true, txHash: "cd".repeat(32), chainId: "demos", payer: "ab".repeat(32),
            payee: req.expectedPayee, blockNumber: 42, txRefKind: "demos",
            finality: { model: "bft-final" }, networkFeeOs: "1" }
          : { ok: true, txHash: "0xlatest-paid", chainId: "eip155:84532", payer: "0xbuyer",
            payee: req.expectedPayee };
      }),
      anchor: async (name, value) => {
        if (name === sessionAnchorName.evidence("job-1")) {
          throw new Error("stop after durable outcome");
        }
        kv.set(`stor:${name}`, value as Record<string, unknown>);
        return `stor:${name}`;
      },
    });
    await expect(
      runSessionCore(interrupted.listingRef, sessionTerms, interrupted.deps),
    ).resolves.toMatchObject({ outcome: "settlement-pending", payment: { ok: true } });

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
      runSessionCore(resumed.listingRef, sessionTerms, resumed.deps, "job-1"),
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
      evidenceRef: completed.settlementRef!,
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

    kv.delete(completed.settlementRef!);
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
