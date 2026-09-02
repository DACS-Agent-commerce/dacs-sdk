import {
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type {
  AnchorReceipt,
  AttestationRef,
  SettlementEvidence,
} from "@kynesyslabs/dacs/artifacts";
import { canonicalize, contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  createBuyerPaymentEvidenceHandshake,
  createPaymentEvidenceAnchorCompletion,
  createPaymentEvidenceAnchorRequest,
  createSellerPaymentEvidenceHandshake,
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  fixedPriceX402ProtocolBindingHash,
  paymentEvidenceHandshakeScopeHash,
  type FixedPriceX402ProtocolBinding,
  type BuyerPaymentEvidenceHandshakeOptions,
  type PaymentEvidenceAnchorCompletion,
  type PaymentEvidenceAnchorRequest,
  type PaymentEvidenceAuthenticatedPeer,
  type PaymentEvidenceHandshakeStore,
} from "@kynesyslabs/dacs/commerce";

import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import {
  DACS_NODE_SQLITE_MAX_PAGE_SIZE,
  DACS_NODE_SQLITE_SCHEMA_VERSION,
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";
import { downgradeCoordinatorSchemaToV6 } from "./helpers/sqliteSchema.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const SELLER = "did:example:seller";
const BUYER = "did:example:buyer";
const OTHER_SELLER = "did:example:other-seller";
const AUTH_HASH = "a".repeat(64);
const COMPLETION_AUTH_HASH = "b".repeat(64);
const ABSENCE_HASH = "e".repeat(64);

const PROTOCOL: FixedPriceX402ProtocolBinding = {
  commerceProfile: FIXED_PRICE_X402_COMMERCE_PROFILE,
  standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
  phase: "pay-x402",
  orchestratorTopology: "seller-as-phase-orchestrator-v1",
  orchestrator: SELLER,
  rail: {
    registryIndexRef: FIXED_PRICE_X402_REGISTRY_INDEX_REF,
    registryIndexHash: "1".repeat(64),
    railDefinitionRef: "dacs4:rail:x402%3Asqlite:2",
    railDefinitionHash: "2".repeat(64),
    railId: "x402:sqlite",
    railVersion: 2,
    railType: "x402",
    phaseHandler: "pay-x402",
    network: "eip155:8453",
    availability: "live",
  },
};

const SCOPE_HASH = paymentEvidenceHandshakeScopeHash({
  seller: SELLER,
  buyer: BUYER,
  protocolHash: fixedPriceX402ProtocolBindingHash(PROTOCOL),
});

function evidence(index = 0): SettlementEvidence {
  return {
    evidenceVersion: "1",
    jobId: JOB_ID,
    phase: "pay-x402",
    outcome: "success",
    observedAt: 7_000 + index,
    paymentTxRefs: [{
      kind: "x402-event",
      httpResource: `https://seller.example/orders/${index}`,
      paymentReceiptHash: (index + 101).toString(16).padStart(64, "0"),
      settlementTxHash: (index + 1).toString(16).padStart(64, "0"),
      chainId: 8453,
      logIndex: index,
      protocolVersion: "2",
    }],
    paymentAmount: { amount: "1", currency: "USDC" },
    settlementFinality: {
      model: "provider-receipt",
      finalityObservedAt: 7_000 + index,
    },
    signature: { algorithm: "ed25519", signer: SELLER, value: "c2ln" },
  };
}

function request(index = 0, overrides: Readonly<{
  effectId?: string;
  logicalAddress?: string;
}> = {}): PaymentEvidenceAnchorRequest {
  const artifact = evidence(index);
  return createPaymentEvidenceAnchorRequest({
    seller: SELLER,
    buyer: BUYER,
    protocol: PROTOCOL,
    effectId: overrides.effectId ?? `payment-evidence:${JOB_ID}:${index}`,
    logicalAddress: overrides.logicalAddress ??
      `dacs4:payment:${JOB_ID}:x402%3Asqlite:${index}`,
    evidenceHash: contentHash(artifact as unknown as Record<string, unknown>),
    evidence: artifact,
    expectedWriter: { role: "buyer", primaryClaim: BUYER },
  });
}

function requestPeer(candidate: PaymentEvidenceAnchorRequest): PaymentEvidenceAuthenticatedPeer {
  return {
    principal: SELLER,
    audience: BUYER,
    messageId: candidate.messageId,
    messageHash: candidate.requestHash,
    authenticationHash: AUTH_HASH,
  };
}

function finalAnchor(candidate: PaymentEvidenceAnchorRequest): {
  evidenceRef: AttestationRef;
  anchorReceipt: AnchorReceipt;
} {
  return {
    evidenceRef: {
      anchor: { kind: "storage-program", locator: candidate.logicalAddress },
      contentHash: candidate.evidenceHash,
      signer: SELLER,
    },
    anchorReceipt: {
      receiptVersion: "1",
      substrate: "demos",
      finalityProfile: "demos-bft",
      logicalAddress: candidate.logicalAddress,
      nativeAddress: `native:${candidate.logicalAddress}`,
      contentHash: candidate.evidenceHash,
      transactionRef: { kind: "demos", value: `tx:${candidate.evidenceHash}` },
      writer: BUYER,
      state: "finalized",
      observationDisposition: "established",
      observedAt: 7_000,
      blockRef: { id: "block-10", height: "10", timestamp: 7_000 },
      evidence: { kind: "demos-bft-proof", value: "proof" },
    },
  };
}

function completion(candidate: PaymentEvidenceAnchorRequest): PaymentEvidenceAnchorCompletion {
  return createPaymentEvidenceAnchorCompletion({
    request: candidate,
    ...finalAnchor(candidate),
  });
}

function completionPeer(
  candidate: PaymentEvidenceAnchorCompletion,
): PaymentEvidenceAuthenticatedPeer {
  return {
    principal: BUYER,
    audience: SELLER,
    messageId: candidate.messageId,
    messageHash: candidate.completionHash,
    authenticationHash: COMPLETION_AUTH_HASH,
  };
}

describe("SQLite payment-evidence handshake store", () => {
  const roots: string[] = [];
  const databases: DacsNodeSqliteDatabase[] = [];

  function temporaryRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "dacs-node-handshake-"));
    roots.push(root);
    return root;
  }

  async function open(
    databasePath: string,
    role: "buyer" | "seller" = "buyer",
    authority = role === "buyer" ? BUYER : SELLER,
  ): Promise<DacsNodeSqliteDatabase> {
    const database = await openDacsNodeSqliteDatabase({
      databasePath,
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role,
      authority,
    });
    databases.push(database);
    return database;
  }

  function close(database: DacsNodeSqliteDatabase): void {
    database.close();
    databases.splice(databases.indexOf(database), 1);
  }

  function retainOriginAt(
    databasePath: string,
    role: "buyer" | "seller",
    messageId: string,
    retainedAt: number,
  ): void {
    const raw = new BetterSqlite3(databasePath);
    const row = raw.prepare(`
      SELECT record_json FROM dacs_payment_evidence_handshakes
      WHERE role = ? AND message_id = ?
    `).get(role, messageId) as { record_json: string };
    const record = JSON.parse(row.record_json) as Record<string, unknown>;
    record.createdAt = retainedAt;
    record.updatedAt = retainedAt;
    const substate = role === "buyer" ? "buyerWork" : "requestOutbox";
    (record[substate] as Record<string, unknown>).updatedAt = retainedAt;
    const recordJson = canonicalize(record);
    const recordHash = sha256Hex(recordJson);
    const entryHash = sha256Hex(canonicalize({
      historyVersion: "1",
      role,
      messageId,
      revision: 1,
      occurredAt: retainedAt,
      recordHash,
      previousEntryHash: null,
    }));
    raw.transaction(() => {
      raw.prepare(`
        UPDATE dacs_payment_evidence_handshakes SET
          record_json = ?, record_hash = ?, created_at = ?, updated_at = ?
        WHERE role = ? AND message_id = ?
      `).run(recordJson, recordHash, retainedAt, retainedAt, role, messageId);
      raw.prepare(`
        UPDATE dacs_payment_evidence_reservations SET created_at = ?
        WHERE role = ? AND message_id = ?
      `).run(retainedAt, role, messageId);
      raw.prepare(`
        UPDATE dacs_payment_evidence_history SET
          occurred_at = ?, record_hash = ?, record_json = ?, entry_hash = ?
        WHERE role = ? AND message_id = ? AND revision = 1
      `).run(retainedAt, recordHash, recordJson, entryHash, role, messageId);
    })();
    raw.close();
  }

  async function putBuyer(
    store: PaymentEvidenceHandshakeStore,
    candidate: PaymentEvidenceAnchorRequest,
  ) {
    return store.putRequest({
      role: "buyer",
      scopeHash: SCOPE_HASH,
      request: candidate,
      requestAuthentication: requestPeer(candidate),
    });
  }

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("persists buyer intent, recovery, completion, and durable outbox acknowledgement", async () => {
    const databasePath = join(temporaryRoot(), "buyer.sqlite");
    let database = await open(databasePath);
    let store = database.createPaymentEvidenceHandshakeStore();
    const candidate = request();
    expect(await putBuyer(store, candidate)).toMatchObject({ status: "created" });
    expect(await putBuyer(store, candidate)).toMatchObject({ status: "existing" });

    const claimed = await store.claimBuyer({
      scopeHash: SCOPE_HASH,
      messageId: candidate.messageId,
      requestHash: candidate.requestHash,
      owner: "buyer-worker-1",
      leaseDurationMs: 60_000,
    });
    expect(claimed).toMatchObject({ status: "acquired", mode: "anchor" });
    if (claimed.status !== "acquired") throw new Error("expected buyer claim");
    close(database);

    database = await open(databasePath);
    store = database.createPaymentEvidenceHandshakeStore();
    expect(await store.isCurrentBuyer({
      scopeHash: SCOPE_HASH,
      messageId: candidate.messageId,
      requestHash: candidate.requestHash,
      lease: claimed.lease,
    })).toBe(true);
    const completed = completion(candidate);
    expect(await store.recordBuyerCompletion({
      scopeHash: SCOPE_HASH,
      messageId: candidate.messageId,
      requestHash: candidate.requestHash,
      lease: claimed.lease,
      completion: completed,
    })).toMatchObject({ status: "recorded" });

    const outbox = await store.claimBuyerCompletions({
      scopeHash: SCOPE_HASH,
      owner: "buyer-outbox-1",
      limit: 10,
      leaseDurationMs: 60_000,
    });
    expect(outbox.items).toHaveLength(1);
    expect(await store.acknowledgeBuyerCompletion({
      scopeHash: SCOPE_HASH,
      messageId: candidate.messageId,
      completionHash: completed.completionHash,
      lease: outbox.items[0]!.lease,
    })).toMatchObject({ status: "recorded" });
    close(database);

    database = await open(databasePath);
    store = database.createPaymentEvidenceHandshakeStore();
    expect(await store.load("buyer", candidate.messageId, SCOPE_HASH)).toMatchObject({
      status: "ok",
      record: {
        revision: 5,
        buyerWork: { state: "complete", generation: 1, attempts: 1 },
        completionOutbox: { state: "acknowledged", generation: 1, attempts: 1 },
      },
    });
    expect((await store.claimBuyerCompletions({
      scopeHash: SCOPE_HASH,
      owner: "buyer-outbox-2",
      limit: 10,
      leaseDurationMs: 1_000,
    })).items).toEqual([]);
  });

  it("persists seller request delivery and authenticates role-owned completion", async () => {
    const databasePath = join(temporaryRoot(), "seller.sqlite");
    let database = await open(databasePath, "seller");
    let store = database.createPaymentEvidenceHandshakeStore();
    const candidate = request();
    expect(await store.putRequest({
      role: "seller",
      scopeHash: SCOPE_HASH,
      request: candidate,
    })).toMatchObject({ status: "created" });
    const claimed = await store.claimSellerRequests({
      scopeHash: SCOPE_HASH,
      owner: "seller-outbox",
      limit: 1,
      leaseDurationMs: 60_000,
    });
    expect(claimed.items).toHaveLength(1);
    expect(await store.acknowledgeSellerRequest({
      scopeHash: SCOPE_HASH,
      messageId: candidate.messageId,
      requestHash: candidate.requestHash,
      lease: claimed.items[0]!.lease,
    })).toMatchObject({ status: "recorded" });
    close(database);

    database = await open(databasePath, "seller");
    store = database.createPaymentEvidenceHandshakeStore();
    const completed = completion(candidate);
    expect(await store.recordSellerCompletion({
      scopeHash: SCOPE_HASH,
      messageId: candidate.messageId,
      requestHash: candidate.requestHash,
      completion: completed,
      completionAuthentication: completionPeer(completed),
    })).toMatchObject({ status: "recorded" });
    expect(await store.load("seller", candidate.messageId, SCOPE_HASH)).toMatchObject({
      status: "ok",
      record: {
        requestOutbox: { state: "acknowledged" },
        completion: { completionHash: completed.completionHash },
      },
    });
  });

  it("drives the public two-actor handshake across independent SQLite authorities", async () => {
    const root = temporaryRoot();
    const buyerDatabase = await open(join(root, "buyer.sqlite"));
    const sellerDatabase = await open(join(root, "seller.sqlite"), "seller");
    const buyerStore = buyerDatabase.createPaymentEvidenceHandshakeStore();
    const sellerStore = sellerDatabase.createPaymentEvidenceHandshakeStore();
    const sellerHandshake = createSellerPaymentEvidenceHandshake({
      store: sellerStore,
      seller: SELLER,
      buyer: BUYER,
      workerId: "seller-worker",
      protocol: PROTOCOL,
      authenticateCompletion: (candidate) => ({
        disposition: "authenticated",
        peer: completionPeer(candidate),
      }),
      verifyAnchorReceipt: () => ({ disposition: "valid" }),
    });
    const buyerHandshake = createBuyerPaymentEvidenceHandshake({
      store: buyerStore,
      seller: SELLER,
      buyer: BUYER,
      workerId: "buyer-worker",
      protocol: PROTOCOL,
      authenticateRequest: (candidate) => ({
        disposition: "authenticated",
        peer: requestPeer(candidate),
      }),
      verifyEvidence: () => ({ disposition: "valid" }),
      anchorEvidence: ((input: { logicalAddress: string; evidenceHash: string }) => ({
        disposition: "anchored",
        ...finalAnchor({
          logicalAddress: input.logicalAddress,
          evidenceHash: input.evidenceHash,
        } as PaymentEvidenceAnchorRequest),
      })) as BuyerPaymentEvidenceHandshakeOptions["anchorEvidence"],
      reconcileAnchor: () => ({
        disposition: "indeterminate",
        reason: "not-used",
      }),
      verifyAnchorReceipt: () => ({ disposition: "valid" }),
    });
    const candidate = request();
    expect(await sellerHandshake.anchorEvidence({
      effectId: candidate.effectId,
      logicalAddress: candidate.logicalAddress,
      evidenceHash: candidate.evidenceHash,
      evidence: candidate.evidence,
      expectedWriter: candidate.expectedWriter,
    })).toMatchObject({ disposition: "indeterminate" });
    const outboundRequest = (await sellerHandshake.claimOutboundRequests()).items[0]!;
    expect(await buyerHandshake.receiveRequest(outboundRequest.request, {})).toBe("accepted");
    await sellerHandshake.acknowledgeOutboundRequest(outboundRequest);
    expect(await buyerHandshake.runPending()).toMatchObject({
      items: [{ status: "completed" }],
    });
    const outboundCompletion = (await buyerHandshake.claimOutboundCompletions()).items[0]!;
    expect(await sellerHandshake.receiveCompletion(outboundCompletion.completion, {}))
      .toBe("accepted");
    await buyerHandshake.acknowledgeOutboundCompletion(outboundCompletion);
    expect(await sellerHandshake.anchorEvidence({
      effectId: candidate.effectId,
      logicalAddress: candidate.logicalAddress,
      evidenceHash: candidate.evidenceHash,
      evidence: candidate.evidence,
      expectedWriter: candidate.expectedWriter,
    })).toMatchObject({ disposition: "anchored" });
  });

  it("atomically reserves message, effect, and logical address without partial conflicts", async () => {
    const database = await open(join(temporaryRoot(), "buyer.sqlite"));
    const store = database.createPaymentEvidenceHandshakeStore();
    const first = request(0);
    expect(await putBuyer(store, first)).toMatchObject({ status: "created" });

    const collidingEffect = request(1, { effectId: first.effectId });
    expect(await putBuyer(store, collidingEffect)).toEqual({ status: "conflict" });
    const reusingUncommittedAddress = request(2, {
      logicalAddress: collidingEffect.logicalAddress,
    });
    expect(await putBuyer(store, reusingUncommittedAddress))
      .toMatchObject({ status: "created" });

    const collidingAddress = request(3, { logicalAddress: first.logicalAddress });
    expect(await putBuyer(store, collidingAddress)).toEqual({ status: "conflict" });
    const raw = new BetterSqlite3(database.databasePath, { readonly: true });
    expect(raw.prepare(`
      SELECT COUNT(*) AS count FROM dacs_payment_evidence_reservations
    `).get()).toEqual({ count: 6 });
    raw.close();
  });

  it("uses bounded stable cursor pages", async () => {
    const database = await open(join(temporaryRoot(), "buyer.sqlite"));
    const store = database.createPaymentEvidenceHandshakeStore();
    const candidates = [request(0), request(1), request(2)]
      .sort((left, right) => left.messageId.localeCompare(right.messageId));
    for (const candidate of candidates) {
      expect(await putBuyer(store, candidate)).toMatchObject({ status: "created" });
    }
    const first = await store.listBuyerRunnable({ scopeHash: SCOPE_HASH, limit: 2 });
    expect(first.items.map((record) => record.messageId)).toEqual(
      candidates.slice(0, 2).map((candidate) => candidate.messageId),
    );
    expect(first.nextCursor).toBe(candidates[1]!.messageId);
    const second = await store.listBuyerRunnable({
      scopeHash: SCOPE_HASH,
      cursor: first.nextCursor,
      limit: 2,
    });
    expect(second.items.map((record) => record.messageId)).toEqual([
      candidates[2]!.messageId,
    ]);
    await expect(store.listBuyerRunnable({
      scopeHash: SCOPE_HASH,
      limit: DACS_NODE_SQLITE_MAX_PAGE_SIZE + 1,
    })).rejects.toMatchObject({ reasonCode: "payment-evidence-query-malformed" });
  });

  it("fences an expired stale worker after a recovery claim", async () => {
    const database = await open(join(temporaryRoot(), "buyer.sqlite"));
    const store = database.createPaymentEvidenceHandshakeStore();
    const candidate = request();
    await putBuyer(store, candidate);
    const first = await store.claimBuyer({
      scopeHash: SCOPE_HASH,
      messageId: candidate.messageId,
      requestHash: candidate.requestHash,
      owner: "slow-worker",
      leaseDurationMs: 1,
    });
    if (first.status !== "acquired") throw new Error("expected first claim");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const recovered = await store.claimBuyer({
      scopeHash: SCOPE_HASH,
      messageId: candidate.messageId,
      requestHash: candidate.requestHash,
      owner: "recovery-worker",
      leaseDurationMs: 60_000,
    });
    expect(recovered).toMatchObject({
      status: "acquired",
      mode: "reconcile",
      lease: { generation: 2 },
    });
    expect(await store.recordBuyerAttempt({
      scopeHash: SCOPE_HASH,
      messageId: candidate.messageId,
      requestHash: candidate.requestHash,
      lease: first.lease,
      state: "operator-action",
      reasonCode: "stale-worker",
    })).toEqual({ status: "stale" });
    expect(await store.isCurrentBuyer({
      scopeHash: SCOPE_HASH,
      messageId: candidate.messageId,
      requestHash: candidate.requestHash,
      lease: first.lease,
    })).toBe(false);
    if (recovered.status !== "acquired") throw new Error("expected recovery claim");
    expect(await store.recordBuyerAbsence({
      scopeHash: SCOPE_HASH,
      messageId: candidate.messageId,
      requestHash: candidate.requestHash,
      lease: recovered.lease,
      absenceProofHash: ABSENCE_HASH,
    })).toMatchObject({ status: "recorded" });
  });

  it("bases new leases on retained monotonic time after a backward clock correction", async () => {
    const root = temporaryRoot();
    const retainedAt = Date.now() + 60_000;
    const candidate = request();

    const buyerPath = join(root, "buyer.sqlite");
    let database = await open(buyerPath);
    await putBuyer(database.createPaymentEvidenceHandshakeStore(), candidate);
    close(database);
    retainOriginAt(buyerPath, "buyer", candidate.messageId, retainedAt);
    database = await open(buyerPath);
    const buyerClaim = await database.createPaymentEvidenceHandshakeStore().claimBuyer({
      scopeHash: SCOPE_HASH,
      messageId: candidate.messageId,
      requestHash: candidate.requestHash,
      owner: "buyer-after-clock-correction",
      leaseDurationMs: 1,
    });
    expect(buyerClaim).toMatchObject({
      status: "acquired",
      lease: { expiresAt: retainedAt + 1 },
    });
    close(database);
    database = await open(buyerPath);
    expect(await database.createPaymentEvidenceHandshakeStore().load(
      "buyer",
      candidate.messageId,
      SCOPE_HASH,
    )).toMatchObject({ status: "ok" });
    close(database);

    const sellerPath = join(root, "seller.sqlite");
    database = await open(sellerPath, "seller");
    await database.createPaymentEvidenceHandshakeStore().putRequest({
      role: "seller",
      scopeHash: SCOPE_HASH,
      request: candidate,
    });
    close(database);
    retainOriginAt(sellerPath, "seller", candidate.messageId, retainedAt);
    database = await open(sellerPath, "seller");
    const sellerClaim = await database.createPaymentEvidenceHandshakeStore()
      .claimSellerRequests({
        scopeHash: SCOPE_HASH,
        owner: "seller-after-clock-correction",
        limit: 1,
        leaseDurationMs: 1,
      });
    expect(sellerClaim.items[0]).toMatchObject({
      lease: { expiresAt: retainedAt + 1 },
    });
    close(database);
    database = await open(sellerPath, "seller");
    expect(await database.createPaymentEvidenceHandshakeStore().load(
      "seller",
      candidate.messageId,
      SCOPE_HASH,
    )).toMatchObject({ status: "ok" });
  });

  it("durably requeues operator work and fences released outbox generations", async () => {
    const root = temporaryRoot();
    const buyerDatabase = await open(join(root, "buyer.sqlite"));
    const buyerStore = buyerDatabase.createPaymentEvidenceHandshakeStore();
    const candidate = request();
    await putBuyer(buyerStore, candidate);
    const buyerClaim = await buyerStore.claimBuyer({
      scopeHash: SCOPE_HASH,
      messageId: candidate.messageId,
      requestHash: candidate.requestHash,
      owner: "buyer-operator-worker",
      leaseDurationMs: 60_000,
    });
    if (buyerClaim.status !== "acquired") throw new Error("expected buyer claim");
    expect(await buyerStore.recordBuyerAttempt({
      scopeHash: SCOPE_HASH,
      messageId: candidate.messageId,
      requestHash: candidate.requestHash,
      lease: buyerClaim.lease,
      state: "operator-action",
      reasonCode: "manual-review",
    })).toMatchObject({ status: "recorded" });
    expect((await buyerStore.listBuyerRunnable({
      scopeHash: SCOPE_HASH,
      limit: 1,
    })).items).toEqual([]);
    expect(await buyerStore.requeueBuyer({
      scopeHash: SCOPE_HASH,
      messageId: candidate.messageId,
      requestHash: candidate.requestHash,
      operatorReasonCode: "operator-approved-reconciliation",
    })).toMatchObject({ status: "recorded" });
    expect(await buyerStore.claimBuyer({
      scopeHash: SCOPE_HASH,
      messageId: candidate.messageId,
      requestHash: candidate.requestHash,
      owner: "buyer-recovery-worker",
      leaseDurationMs: 60_000,
    })).toMatchObject({ status: "acquired", mode: "reconcile" });

    const sellerDatabase = await open(join(root, "seller.sqlite"), "seller");
    const sellerStore = sellerDatabase.createPaymentEvidenceHandshakeStore();
    await sellerStore.putRequest({ role: "seller", scopeHash: SCOPE_HASH, request: candidate });
    const first = (await sellerStore.claimSellerRequests({
      scopeHash: SCOPE_HASH,
      owner: "seller-outbox-1",
      limit: 1,
      leaseDurationMs: 60_000,
    })).items[0]!;
    expect(await sellerStore.releaseSellerRequest({
      scopeHash: SCOPE_HASH,
      messageId: candidate.messageId,
      requestHash: candidate.requestHash,
      lease: first.lease,
      reasonCode: "transport-unavailable",
    })).toMatchObject({ status: "recorded" });
    const second = (await sellerStore.claimSellerRequests({
      scopeHash: SCOPE_HASH,
      owner: "seller-outbox-2",
      limit: 1,
      leaseDurationMs: 60_000,
    })).items[0]!;
    expect(second.lease.generation).toBe(first.lease.generation + 1);
    expect(await sellerStore.acknowledgeSellerRequest({
      scopeHash: SCOPE_HASH,
      messageId: candidate.messageId,
      requestHash: candidate.requestHash,
      lease: first.lease,
    })).toEqual({ status: "stale" });
    expect(await sellerStore.acknowledgeSellerRequest({
      scopeHash: SCOPE_HASH,
      messageId: candidate.messageId,
      requestHash: candidate.requestHash,
      lease: second.lease,
    })).toMatchObject({ status: "recorded" });
  });

  it("accepts late outbox outcomes until a newer claimant changes generation", async () => {
    const database = await open(join(temporaryRoot(), "seller.sqlite"), "seller");
    const store = database.createPaymentEvidenceHandshakeStore();
    const candidates = [request(0), request(1)];
    for (const candidate of candidates) {
      await store.putRequest({
        role: "seller",
        scopeHash: SCOPE_HASH,
        request: candidate,
      });
    }
    const claims = await store.claimSellerRequests({
      scopeHash: SCOPE_HASH,
      owner: "short-lived-outbox-worker",
      limit: 2,
      leaseDurationMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const byMessage = new Map(claims.items.map((claim) => [claim.request.messageId, claim]));
    const acknowledged = byMessage.get(candidates[0]!.messageId)!;
    const released = byMessage.get(candidates[1]!.messageId)!;
    expect(await store.acknowledgeSellerRequest({
      scopeHash: SCOPE_HASH,
      messageId: acknowledged.request.messageId,
      requestHash: acknowledged.request.requestHash,
      lease: acknowledged.lease,
    })).toMatchObject({ status: "recorded" });
    expect(await store.releaseSellerRequest({
      scopeHash: SCOPE_HASH,
      messageId: released.request.messageId,
      requestHash: released.request.requestHash,
      lease: released.lease,
      reasonCode: "late-transport-result",
    })).toMatchObject({ status: "recorded" });

    const replacement = (await store.claimSellerRequests({
      scopeHash: SCOPE_HASH,
      owner: "replacement-outbox-worker",
      limit: 2,
      leaseDurationMs: 60_000,
    })).items[0]!;
    expect(replacement.request.messageId).toBe(released.request.messageId);
    expect(replacement.lease.generation).toBe(released.lease.generation + 1);
    expect(await store.acknowledgeSellerRequest({
      scopeHash: SCOPE_HASH,
      messageId: released.request.messageId,
      requestHash: released.request.requestHash,
      lease: released.lease,
    })).toEqual({ status: "stale" });
    expect(await store.acknowledgeSellerRequest({
      scopeHash: SCOPE_HASH,
      messageId: replacement.request.messageId,
      requestHash: replacement.request.requestHash,
      lease: replacement.lease,
    })).toMatchObject({ status: "recorded" });
  });

  it("rejects offline, verifier, cross-role, and foreign-authority use", async () => {
    const root = temporaryRoot();
    const offline = await openDacsNodeSqliteDatabase({
      databasePath: join(root, "offline.sqlite"),
      mode: "offline",
      profile: "dacs-sdk:fixed-price-offline:v1",
      role: "buyer",
      authority: BUYER,
    });
    databases.push(offline);
    expect(() => offline.createPaymentEvidenceHandshakeStore()).toThrowError(
      expect.objectContaining({ reasonCode: "payment-evidence-profile-mismatch" }),
    );

    const verifier = await openDacsNodeSqliteDatabase({
      databasePath: join(root, "verifier.sqlite"),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "verifier",
      authority: "did:example:verifier",
    });
    databases.push(verifier);
    expect(() => verifier.createPaymentEvidenceHandshakeStore()).toThrowError(
      expect.objectContaining({ reasonCode: "payment-evidence-profile-mismatch" }),
    );

    const foreign = await open(join(root, "foreign.sqlite"), "seller", OTHER_SELLER);
    const foreignStore = foreign.createPaymentEvidenceHandshakeStore();
    expect(await foreignStore.putRequest({
      role: "seller",
      scopeHash: SCOPE_HASH,
      request: request(),
    })).toMatchObject({ status: "corrupt" });
    await expect(foreignStore.listBuyerRunnable({
      scopeHash: SCOPE_HASH,
      limit: 1,
    })).rejects.toMatchObject({ reasonCode: "payment-evidence-role-mismatch" });
  });

  it("fails closed on authenticated-record or reservation corruption during reopen", async () => {
    const root = temporaryRoot();
    for (const [index, target] of ["record", "reservation", "history"].entries()) {
      const databasePath = join(root, `${target}.sqlite`);
      const database = await open(databasePath);
      const store = database.createPaymentEvidenceHandshakeStore();
      const candidate = request(index);
      await putBuyer(store, candidate);
      database.checkpoint();
      close(database);
      const raw = new BetterSqlite3(databasePath);
      if (target === "record") {
        raw.prepare(`
          UPDATE dacs_payment_evidence_handshakes SET record_hash = ?
          WHERE role = 'buyer' AND message_id = ?
        `).run("f".repeat(64), candidate.messageId);
      } else if (target === "reservation") {
        raw.prepare(`
          UPDATE dacs_payment_evidence_reservations SET request_hash = ?
          WHERE role = 'buyer' AND message_id = ? AND reservation_kind = 'effect'
        `).run("f".repeat(64), candidate.messageId);
      } else {
        raw.prepare(`
          DELETE FROM dacs_payment_evidence_history
          WHERE role = 'buyer' AND message_id = ? AND revision = 1
        `).run(candidate.messageId);
      }
      raw.close();
      await expect(open(databasePath)).rejects.toMatchObject({
        reasonCode: "database-logical-corruption",
      });
    }
  });

  it("refuses unsupported handshake state on admission", async () => {
    const databasePath = join(temporaryRoot(), "unsupported.sqlite");
    const database = await open(databasePath);
    const store = database.createPaymentEvidenceHandshakeStore();
    const candidate = request();
    await putBuyer(store, candidate);
    database.checkpoint();
    close(database);
    const raw = new BetterSqlite3(databasePath);
    const row = raw.prepare(`
      SELECT record_json FROM dacs_payment_evidence_handshakes
      WHERE role = 'buyer' AND message_id = ?
    `).get(candidate.messageId) as { record_json: string };
    const parsed = JSON.parse(row.record_json) as Record<string, unknown>;
    parsed.storeVersion = 999;
    const recordJson = canonicalize(parsed);
    raw.prepare(`
      UPDATE dacs_payment_evidence_handshakes
      SET store_version = 999, record_json = ?, record_hash = ?
      WHERE role = 'buyer' AND message_id = ?
    `).run(recordJson, sha256Hex(recordJson), candidate.messageId);
    raw.close();
    await expect(open(databasePath)).rejects.toMatchObject({
      reasonCode: "payment-evidence-version-unsupported",
    });
  });

  it("rejects a hash-consistent history whose origin skips the required intent claim", async () => {
    const databasePath = join(temporaryRoot(), "illegal-origin.sqlite");
    const database = await open(databasePath);
    const store = database.createPaymentEvidenceHandshakeStore();
    const candidate = request();
    await putBuyer(store, candidate);
    database.checkpoint();
    close(database);
    const raw = new BetterSqlite3(databasePath);
    const row = raw.prepare(`
      SELECT record_json FROM dacs_payment_evidence_handshakes
      WHERE role = 'buyer' AND message_id = ?
    `).get(candidate.messageId) as { record_json: string };
    const record = JSON.parse(row.record_json) as Record<string, unknown>;
    const updatedAt = record.updatedAt as number;
    record.buyerWork = {
      state: "reconciliation-required",
      generation: 1,
      attempts: 1,
      updatedAt,
      reasonCode: "anchor-attempt-in-flight",
      lease: {
        owner: "fabricated-worker",
        generation: 1,
        expiresAt: updatedAt + 60_000,
      },
    };
    const recordJson = canonicalize(record);
    const recordHash = sha256Hex(recordJson);
    raw.prepare(`
      UPDATE dacs_payment_evidence_handshakes SET
        buyer_state = 'reconciliation-required', buyer_generation = 1,
        buyer_attempts = 1, buyer_lease_expires_at = ?,
        record_json = ?, record_hash = ?
      WHERE role = 'buyer' AND message_id = ?
    `).run(updatedAt + 60_000, recordJson, recordHash, candidate.messageId);
    const entryHash = sha256Hex(canonicalize({
      historyVersion: "1",
      role: "buyer",
      messageId: candidate.messageId,
      revision: 1,
      occurredAt: updatedAt,
      recordHash,
      previousEntryHash: null,
    }));
    raw.prepare(`
      UPDATE dacs_payment_evidence_history SET
        record_hash = ?, record_json = ?, entry_hash = ?
      WHERE role = 'buyer' AND message_id = ? AND revision = 1
    `).run(recordHash, recordJson, entryHash, candidate.messageId);
    raw.close();

    await expect(open(databasePath)).rejects.toMatchObject({
      reasonCode: "database-logical-corruption",
    });
  });

  it("rejects a foreign-scope reservation attached to an otherwise valid record", async () => {
    const databasePath = join(temporaryRoot(), "foreign-scope-reservation.sqlite");
    const database = await open(databasePath);
    const store = database.createPaymentEvidenceHandshakeStore();
    const candidate = request();
    await putBuyer(store, candidate);
    database.checkpoint();
    close(database);
    const raw = new BetterSqlite3(databasePath);
    raw.prepare(`
      INSERT INTO dacs_payment_evidence_reservations (
        role, scope_hash, reservation_kind, identity, message_id,
        request_hash, created_at
      ) VALUES ('buyer', ?, 'effect', 'poisoned-scope-effect', ?, ?, 1)
    `).run("9".repeat(64), candidate.messageId, candidate.requestHash);
    raw.close();

    await expect(open(databasePath)).rejects.toMatchObject({
      reasonCode: "database-logical-corruption",
    });
  });

  it("backs up and migrates the immutable v4 database before adding handshake state", async () => {
    const root = temporaryRoot();
    const databasePath = join(root, "legacy-v4.sqlite");
    const database = await open(databasePath);
    database.checkpoint();
    close(database);
    const raw = new BetterSqlite3(databasePath);
    downgradeCoordinatorSchemaToV6(raw);
    raw.exec(`
      DROP TABLE dacs_http_inbox_history;
      DROP TABLE dacs_http_outbox_history;
      DROP TABLE dacs_http_inbox;
      DROP TABLE dacs_http_outbox;
      DROP TABLE dacs_http_clock;
      DROP TABLE dacs_payment_evidence_history;
      DROP TABLE dacs_payment_evidence_reservations;
      DROP TABLE dacs_payment_evidence_handshakes;
      DELETE FROM dacs_migrations WHERE version = 7;
      DELETE FROM dacs_migrations WHERE version = 6;
      DELETE FROM dacs_migrations WHERE version = 5;
      UPDATE dacs_store_metadata SET schema_version = 4 WHERE singleton = 1;
      PRAGMA user_version = 4;
    `);
    raw.close();

    const migrated = await open(databasePath);
    expect(migrated.diagnostics().schemaVersion).toBe(DACS_NODE_SQLITE_SCHEMA_VERSION);
    expect(readdirSync(root).filter((name) => name.includes(".backup-v4-")))
      .toHaveLength(1);
    expect(migrated.createPaymentEvidenceHandshakeStore()).toBeDefined();
  });
});
