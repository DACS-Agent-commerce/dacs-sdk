import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";

import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import type { DacsLiveEffectFenceV1 } from "../src/liveEffects.js";
import {
  createDacsPayDemPaymentNoticeV1,
  type DacsPayDemBuyerPaymentInputV1,
} from "../src/payDemPayment.js";
import {
  createDacsPayDemBuyerPaymentNoticePublisherV1,
  createDacsPayDemSellerPaymentNoticeRuntimeV1,
} from "../src/payDemPaymentNoticeRuntime.js";
import type { DacsLiveRoleInboundOperationContextV1 } from "../src/roleRuntime.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";
import type { DacsHttpAuthenticatedEnvelopeV1 } from "../src/transport/envelope.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = `did:demos:agent:${"1".repeat(64)}`;
const SELLER = `did:demos:agent:${"2".repeat(64)}`;
const TX_HASH = "3".repeat(64);

const PAYMENT: DacsPayDemBuyerPaymentInputV1 = {
  authorityVersion: "1",
  jobId: JOB_ID,
  phaseIndex: 2,
  railId: "demos-native:DEM",
  railVersion: 1,
  railDescriptorHash: "4".repeat(64),
  network: "demos",
  payer: "5".repeat(64),
  payee: "6".repeat(64),
  amountOs: "1000000000",
  maxTotalDebitOs: "2000000000",
  agreementHash: "7".repeat(64),
  termsHash: "8".repeat(64),
  payoutBindingHash: "9".repeat(64),
  paymentInputVersion: "1",
  orderBindingHash: "a".repeat(64),
  orderLocalBindingHash: "b".repeat(64),
  settlementKey: `demos-native:DEM:${JOB_ID}:2`,
};

function notice(txHash = TX_HASH) {
  return createDacsPayDemPaymentNoticeV1(PAYMENT, {
    ok: true,
    txHash,
    chainId: "demos",
    payer: PAYMENT.payer,
    payee: PAYMENT.payee,
    finality: { model: "bft-final" },
    blockNumber: 42,
    txRefKind: "demos",
    networkFeeOs: "1000000000",
  });
}

function authenticated(
  value = notice(),
  envelopeId = "c".repeat(64),
): Readonly<DacsHttpAuthenticatedEnvelopeV1> {
  const payloadHash = sha256Hex(canonicalize(value));
  return {
    status: "authenticated",
    envelope: {
      version: "1",
      type: "pay-dem-payment-notice",
      envelopeId,
      jobId: JOB_ID,
      sender: BUYER,
      audience: SELLER,
      keyId: BUYER,
      algorithm: "ed25519",
      issuedAt: 1_800_000_000_000,
      expiresAt: 1_800_000_300_000,
      nonce: Buffer.alloc(32, 1).toString("base64url"),
      payloadHash,
      payload: value,
      signature: Buffer.alloc(64, 2).toString("base64url"),
    },
    authenticationHash: "d".repeat(64),
    identityEvidenceHash: "e".repeat(64),
    identityRole: "buyer",
    receivedAt: 1_800_000_000_010,
  };
}

describe("native DEM payment notice runtime", () => {
  const roots: string[] = [];
  const databases: DacsNodeSqliteDatabase[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    for (const directory of roots.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  async function sellerDatabase(): Promise<DacsNodeSqliteDatabase> {
    const root = mkdtempSync(join(tmpdir(), "dacs-pay-dem-notice-"));
    roots.push(root);
    const database = await openDacsNodeSqliteDatabase({
      databasePath: join(root, "seller.sqlite"),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "seller",
      authority: SELLER,
    });
    databases.push(database);
    return database;
  }

  it("queues one stable signed buyer notice under the payment fence", async () => {
    const queueMessage = vi.fn(async (input) => ({
      type: input.type,
    }));
    const assertCurrent = vi.fn(async () => undefined);
    const publish = createDacsPayDemBuyerPaymentNoticePublisherV1({
      role: "buyer",
      authority: BUYER,
      peerAuthority: SELLER,
      queueMessage,
    } as never);
    const fence = {
      role: "buyer",
      track: "payment",
      jobId: JOB_ID,
      effectId: "buyer-payment",
      idempotencyKey: "buyer-payment",
      bindingHash: "f".repeat(64),
      generation: 1,
      assertCurrent,
      checkpoint: vi.fn(),
    } satisfies DacsLiveEffectFenceV1;

    await publish({ notice: notice(), fence });

    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(queueMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "pay-dem-payment-notice",
      jobId: JOB_ID,
      payload: expect.objectContaining({ paymentNoticeVersion: "1" }),
      idempotencyKey: expect.stringContaining(`pay-dem-payment-notice:${JOB_ID}:`),
    }));
  });

  it("retains the first authenticated notice and accepts exact transport renewal", async () => {
    const database = await sellerDatabase();
    const runtime = createDacsPayDemSellerPaymentNoticeRuntimeV1({
      role: "seller",
      authority: SELLER,
      peerAuthority: BUYER,
      database,
    } as never);
    const inboundContext = {
      role: "seller",
      authority: SELLER,
      peerAuthority: BUYER,
    } as DacsLiveRoleInboundOperationContextV1;

    await expect(runtime.handleMessage(
      authenticated(),
      inboundContext,
    )).resolves.toEqual({ disposition: "accepted" });
    await expect(runtime.handleMessage(
      authenticated(notice(), "f".repeat(64)),
      inboundContext,
    )).resolves.toEqual({ disposition: "accepted" });

    expect(runtime.load(JOB_ID)).toMatchObject({
      noticeHash: sha256Hex(canonicalize(notice())),
      notice: { settlement: { txHash: TX_HASH } },
      transportAuthentication: { envelopeId: "c".repeat(64), sender: BUYER },
    });
  });

  it("rejects a second settlement identity for the same payment job", async () => {
    const database = await sellerDatabase();
    const runtime = createDacsPayDemSellerPaymentNoticeRuntimeV1({
      role: "seller",
      authority: SELLER,
      peerAuthority: BUYER,
      database,
    } as never);
    const context = {
      role: "seller",
      authority: SELLER,
      peerAuthority: BUYER,
    } as DacsLiveRoleInboundOperationContextV1;
    await runtime.handleMessage(authenticated(), context);

    await expect(runtime.handleMessage(
      authenticated(notice("0".repeat(64)), "f".repeat(64)),
      context,
    )).resolves.toEqual({
      disposition: "rejected",
      reasonCode: "pay-dem-payment-notice-conflict",
    });
  });
});
