import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  type FixedPriceX402OrderInput,
} from "@kynesyslabs/dacs/commerce";
import { afterEach, describe, expect, it } from "vitest";

import {
  DACS_NODE_LIVE_PROFILE,
  loadDacsLiveOrderInputV1,
  putDacsLiveOrderInputV1,
} from "../src/index.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = `did:demos:agent:${"11".repeat(32)}`;
const SELLER = `did:demos:agent:${"22".repeat(32)}`;

function order(role: "buyer" | "seller" = "buyer"): FixedPriceX402OrderInput {
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
        railDefinitionRef: "dacs4:rail:x402%3Adefault:2",
        railDefinitionHash: "2".repeat(64),
        railId: "x402:default",
        railVersion: 2,
        railType: "x402",
        phaseHandler: "pay-x402",
        network: "eip155:84532",
        availability: "live",
      },
    },
    sdkJobs: role === "buyer"
      ? {
          role,
          agreement: `buyer:agreement:${JOB_ID}`,
          payment: `buyer:payment:${JOB_ID}`,
          paymentEvidence: `buyer:payment-evidence:${JOB_ID}`,
          buyerReceived: `buyer:received:${JOB_ID}`,
          audit: `buyer:audit:${JOB_ID}`,
        }
      : {
          role,
          agreement: `seller:agreement:${JOB_ID}`,
          payment: `seller:payment:${JOB_ID}`,
          paymentEvidence: `seller:payment-evidence:${JOB_ID}`,
          fulfilment: `seller:fulfilment:${JOB_ID}`,
          deliveryEvidence: `seller:delivery-evidence:${JOB_ID}`,
          audit: `seller:audit:${JOB_ID}`,
        },
  };
}

describe("durable live order input", () => {
  const roots: string[] = [];
  const databases: DacsNodeSqliteDatabase[] = [];

  async function database(role: "buyer" | "seller" = "buyer") {
    const directory = mkdtempSync(join(tmpdir(), "dacs-order-input-"));
    roots.push(directory);
    const opened = await openDacsNodeSqliteDatabase({
      databasePath: join(directory, `${role}.sqlite`),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role,
      authority: role === "buyer" ? BUYER : SELLER,
    });
    databases.push(opened);
    return opened;
  }

  afterEach(() => {
    for (const database of databases.splice(0).reverse()) database.close();
    for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("retains one immutable canonical application input for restart recovery", async () => {
    const opened = await database();
    const first = putDacsLiveOrderInputV1({
      database: opened,
      order: order(),
      application: {
        listingRef: "dacs1:listing:service:1",
        requestHash: "a".repeat(64),
      },
    });
    expect(first).toMatchObject({
      status: "created",
      record: {
        role: "buyer",
        jobId: JOB_ID,
        applicationHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(putDacsLiveOrderInputV1({
      database: opened,
      order: structuredClone(order()),
      application: {
        requestHash: "a".repeat(64),
        listingRef: "dacs1:listing:service:1",
      },
    })).toMatchObject({ status: "existing", effectId: first.effectId });
    expect(loadDacsLiveOrderInputV1({ database: opened, order: order() }))
      .toEqual(first.status === "conflict" ? undefined : first.record);
  });

  it("rejects changed application facts and cross-role databases", async () => {
    const opened = await database();
    putDacsLiveOrderInputV1({
      database: opened,
      order: order(),
      application: { requestHash: "a".repeat(64) },
    });
    expect(putDacsLiveOrderInputV1({
      database: opened,
      order: order(),
      application: { requestHash: "b".repeat(64) },
    })).toMatchObject({ status: "conflict" });

    expect(() => putDacsLiveOrderInputV1({
      database: opened,
      order: order("seller"),
      application: { requestHash: "b".repeat(64) },
    })).toThrow(/database-binding-mismatch/);
  });
});
