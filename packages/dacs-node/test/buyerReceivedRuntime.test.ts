import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  fixedPriceX402OrderBindingHash,
  fixedPriceX402OrderLocalBindingHash,
  type FixedPriceX402OrderInput,
} from "@kynesyslabs/dacs/commerce";
import { x402BuyerSettlementKey } from "@kynesyslabs/dacs/rails";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDacsBuyerReceivedTrackV1 } from "../src/buyerReceivedRuntime.js";
import { DACS_NODE_LIVE_PROFILE } from "../src/config.js";
import { putDacsLiveOrderInputV1 } from "../src/orderInput.js";
import type { DacsLiveRoleOperationContextV1 } from "../src/roleRuntime.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = `did:demos:agent:${"11".repeat(32)}`;
const SELLER = `did:demos:agent:${"22".repeat(32)}`;
const RESOURCE = `https://seller.example/deliver/${JOB_ID}`;
const RESPONSE_HEADER = Buffer.from("settlement").toString("base64url");

function order(): FixedPriceX402OrderInput {
  return {
    jobId: JOB_ID,
    buyer: BUYER,
    seller: SELLER,
    protocol: {
      commerceProfile: FIXED_PRICE_X402_COMMERCE_PROFILE,
      standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
      phase: "pay-x402",
      orchestratorTopology: "seller-as-phase-orchestrator-v1",
      orchestrator: SELLER,
      rail: {
        registryIndexRef: FIXED_PRICE_X402_REGISTRY_INDEX_REF,
        registryIndexHash: "1".repeat(64),
        railDefinitionRef: "dacs4:rail:x402%3Aruntime:2",
        railDefinitionHash: "2".repeat(64),
        railId: "x402:runtime",
        railVersion: 2,
        railType: "x402",
        phaseHandler: "pay-x402",
        network: "eip155:8453",
        availability: "live",
      },
    },
    sdkJobs: {
      role: "buyer",
      agreement: `buyer:agreement:${JOB_ID}`,
      payment: `buyer:payment:${JOB_ID}`,
      paymentEvidence: `buyer:payment-evidence:${JOB_ID}`,
      buyerReceived: `buyer:received:${JOB_ID}`,
      audit: `buyer:audit:${JOB_ID}`,
    },
  };
}

describe("buyer received response runtime", () => {
  const roots: string[] = [];
  const databases: DacsNodeSqliteDatabase[] = [];

  afterEach(() => {
    for (const database of databases.splice(0).reverse()) database.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function open(): Promise<DacsNodeSqliteDatabase> {
    const root = mkdtempSync(join(tmpdir(), "dacs-buyer-received-"));
    roots.push(root);
    const database = await openDacsNodeSqliteDatabase({
      databasePath: join(root, "buyer.sqlite"),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      authority: BUYER,
    });
    databases.push(database);
    return database;
  }

  it("durably captures exact paid bytes and replays without another request", async () => {
    const database = await open();
    const buyerOrder = order();
    await database.createLiveCoordinatorStore("buyer").create({
      role: "buyer",
      order: buyerOrder,
      bindingHash: fixedPriceX402OrderBindingHash(buyerOrder),
      localBindingHash: fixedPriceX402OrderLocalBindingHash(buyerOrder),
    });
    putDacsLiveOrderInputV1({
      database,
      order: buyerOrder,
      application: { request: "runtime" },
    });
    const loaded = await database.createLiveCoordinatorStore("buyer").load("buyer", JOB_ID);
    if (loaded.status !== "ok") throw new Error();
    const settlementKey = x402BuyerSettlementKey({
      railId: "x402:runtime",
      jobId: JOB_ID,
      phaseIndex: 2,
    });
    const settlementStore = {
      load: vi.fn(async () => ({
        status: "captured" as const,
        intent: {
          settlementKey,
          jobId: JOB_ID,
          phaseIndex: 2,
          httpResource: RESOURCE,
          paymentHeader: { name: "PAYMENT-SIGNATURE", value: "retained-bearer" },
        },
        outcome: {
          status: "captured" as const,
          settlement: {
            httpResource: RESOURCE,
            encodedSettlementHeader: RESPONSE_HEADER,
            authenticationHash: "a".repeat(64),
          },
        },
      })),
    };
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("PAYMENT-SIGNATURE")).toBe("retained-bearer");
      return new Response(JSON.stringify({ delivered: true }), {
        status: 200,
        headers: {
          "PAYMENT-RESPONSE": RESPONSE_HEADER,
          "content-type": "application/json",
        },
      });
    });
    const authorizeReceived = vi.fn(({ body }: { body: Uint8Array }) =>
      JSON.parse(Buffer.from(body).toString("utf8")).delivered === true
    );
    const context = {
      role: "buyer",
      authority: BUYER,
      peerAuthority: SELLER,
      database,
      commerceStores: { role: "buyer", x402Settlement: settlementStore },
    } as unknown as DacsLiveRoleOperationContextV1;
    const track = createDacsBuyerReceivedTrackV1({
      context,
      resolvePaymentScope: () => ({ paymentPhaseIndex: 2 }),
      authorizeReceived: authorizeReceived as never,
      fetchImpl: fetchImpl as never,
    });
    const operation = {
      order: loaded.record,
      fence: {
        role: "buyer",
        jobId: JOB_ID,
        bindingHash: loaded.record.bindingHash,
        localBindingHash: loaded.record.localBindingHash,
        track: "buyer-received",
        owner: "buyer-worker",
        generation: 1,
        idempotencyKey: `buyer:received:${JOB_ID}`,
        assertCurrent: vi.fn(async () => undefined),
      },
    } as const;

    await expect(track(operation)).resolves.toMatchObject({
      status: "final",
      outcome: "success",
      reference: RESOURCE,
      authenticationHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    fetchImpl.mockRejectedValueOnce(new Error("must not fetch retained response"));
    await expect(track(operation)).resolves.toMatchObject({
      status: "final",
      outcome: "success",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(authorizeReceived).toHaveBeenCalledTimes(2);
  });

  it("rejects a paid response that does not bind the finalized settlement header", async () => {
    const database = await open();
    const buyerOrder = order();
    await database.createLiveCoordinatorStore("buyer").create({
      role: "buyer",
      order: buyerOrder,
      bindingHash: fixedPriceX402OrderBindingHash(buyerOrder),
      localBindingHash: fixedPriceX402OrderLocalBindingHash(buyerOrder),
    });
    putDacsLiveOrderInputV1({ database, order: buyerOrder, application: {} });
    const loaded = await database.createLiveCoordinatorStore("buyer").load("buyer", JOB_ID);
    if (loaded.status !== "ok") throw new Error();
    const settlementKey = x402BuyerSettlementKey({
      railId: "x402:runtime", jobId: JOB_ID, phaseIndex: 2,
    });
    const context = {
      role: "buyer",
      database,
      commerceStores: {
        role: "buyer",
        x402Settlement: {
          load: async () => ({
            status: "captured",
            intent: {
              settlementKey,
              jobId: JOB_ID,
              phaseIndex: 2,
              httpResource: RESOURCE,
              paymentHeader: { name: "PAYMENT-SIGNATURE", value: "bearer" },
            },
            outcome: {
              status: "captured",
              settlement: {
                httpResource: RESOURCE,
                encodedSettlementHeader: RESPONSE_HEADER,
                authenticationHash: "a".repeat(64),
              },
            },
          }),
        },
      },
    } as unknown as DacsLiveRoleOperationContextV1;
    const track = createDacsBuyerReceivedTrackV1({
      context,
      resolvePaymentScope: () => ({ paymentPhaseIndex: 2 }),
      authorizeReceived: () => true,
      fetchImpl: async () => new Response("substituted", {
        status: 200,
        headers: { "PAYMENT-RESPONSE": "different" },
      }),
    });
    await expect(track({
      order: loaded.record,
      fence: {
        role: "buyer",
        jobId: JOB_ID,
        bindingHash: loaded.record.bindingHash,
        localBindingHash: loaded.record.localBindingHash,
        track: "buyer-received",
        owner: "buyer-worker",
        generation: 1,
        idempotencyKey: "buyer-received",
        assertCurrent: async () => undefined,
      },
    })).resolves.toEqual({
      status: "operator-action",
      reasonCode: "buyer-received-paid-response-invalid",
    });
  });
});
