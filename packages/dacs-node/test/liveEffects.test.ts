import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_COORDINATOR_STORE_VERSION,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  type FixedPriceX402EffectFence,
  type FixedPriceX402OrderRecord,
  type FixedPriceX402TrackOperationInput,
} from "@kynesyslabs/dacs/commerce";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DACS_NODE_LIVE_PROFILE,
  createDacsLiveEffectTrackV1,
  type DacsLiveEffectAdapterV1,
} from "../src/index.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const BUYER = `did:demos:agent:${"11".repeat(32)}`;
const SELLER = `did:demos:agent:${"22".repeat(32)}`;
const BINDING_HASH = "a".repeat(64);
const LOCAL_BINDING_HASH = "b".repeat(64);
const EFFECT_ID = "dacs-fixed-price-x402:v1:buyer:payment:test-effect";

interface EffectInput {
  jobId: string;
  amount: string;
}

interface EffectResult {
  reference: string;
  authenticationHash: string;
}

function order(): FixedPriceX402OrderRecord {
  return {
    storeVersion: FIXED_PRICE_X402_COORDINATOR_STORE_VERSION,
    revision: 0,
    role: "buyer",
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
        registryIndexHash: "c".repeat(64),
        railDefinitionRef: "dacs4:rail:x402%3Adefault:1",
        railDefinitionHash: "d".repeat(64),
        railId: "x402:default",
        railVersion: 1,
        railType: "x402",
        phaseHandler: "pay-x402",
        network: "eip155:84532",
        availability: "live",
      },
    },
    bindingHash: BINDING_HASH,
    localBindingHash: LOCAL_BINDING_HASH,
    sdkJobs: {
      role: "buyer",
      agreement: `buyer:agreement:${JOB_ID}`,
      payment: `buyer:payment:${JOB_ID}`,
      paymentEvidence: `buyer:payment-evidence:${JOB_ID}`,
      buyerReceived: `buyer:received:${JOB_ID}`,
      audit: `buyer:audit:${JOB_ID}`,
    },
    tracks: {},
    createdAt: 1_780_000_000_000,
    updatedAt: 1_780_000_000_000,
  };
}

function operationInput(): FixedPriceX402TrackOperationInput {
  const fence: FixedPriceX402EffectFence = {
    role: "buyer",
    jobId: JOB_ID,
    bindingHash: BINDING_HASH,
    localBindingHash: LOCAL_BINDING_HASH,
    track: "payment",
    owner: "coordinator-worker",
    generation: 1,
    idempotencyKey: EFFECT_ID,
    assertCurrent: async () => undefined,
  };
  return { order: order(), fence };
}

describe("durable live irreversible-effect track", () => {
  const roots: string[] = [];
  const databases: DacsNodeSqliteDatabase[] = [];

  async function database(): Promise<DacsNodeSqliteDatabase> {
    const directory = mkdtempSync(join(tmpdir(), "dacs-live-effect-"));
    roots.push(directory);
    const opened = await openDacsNodeSqliteDatabase({
      databasePath: join(directory, "buyer.sqlite"),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role: "buyer",
      authority: BUYER,
    });
    databases.push(opened);
    return opened;
  }

  function track(
    opened: DacsNodeSqliteDatabase,
    adapter: DacsLiveEffectAdapterV1<EffectInput, EffectResult>,
  ) {
    return createDacsLiveEffectTrackV1({
      database: opened,
      kind: "payment",
      role: "buyer",
      track: "payment",
      workerId: "effect-worker",
      retryDelayMs: 1,
      buildInput: ({ order: retained }) => ({
        jobId: retained.jobId,
        amount: "1",
      }),
      adapter,
      projectResult: (result) => result,
    });
  }

  afterEach(() => {
    for (const opened of databases.splice(0).reverse()) opened.close();
    for (const directory of roots.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("performs once and replays the retained completion without executing again", async () => {
    const opened = await database();
    const execute = vi.fn(async ({ fence }) => {
      await fence.assertCurrent();
      return {
        reference: "evm:payment:1",
        authenticationHash: "e".repeat(64),
      };
    });
    const reconcile = vi.fn();
    const operation = track(opened, { execute, reconcile });

    await expect(operation(operationInput())).resolves.toEqual({
      status: "final",
      outcome: "success",
      reference: "evm:payment:1",
      authenticationHash: "e".repeat(64),
    });
    await expect(operation(operationInput())).resolves.toMatchObject({
      status: "final",
      reference: "evm:payment:1",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
    expect(opened.loadEffect("payment", EFFECT_ID)).toMatchObject({
      state: "completed",
      idempotencyKey: EFFECT_ID,
    });
  });

  it("reconciles an ambiguous execute and never repeats it", async () => {
    const opened = await database();
    const execute = vi.fn(async () => {
      throw new Error("response lost after provider accepted the effect");
    });
    const reconcile = vi.fn(async () => ({
      status: "completed" as const,
      result: {
        reference: "evm:payment:reconciled",
        authenticationHash: "f".repeat(64),
      },
    }));
    const operation = track(opened, { execute, reconcile });

    await expect(operation(operationInput())).resolves.toMatchObject({
      status: "indeterminate",
      reasonCode: "effect-outcome-ambiguous",
    });
    await new Promise((resolve) => setTimeout(resolve, 3));
    await expect(operation(operationInput())).resolves.toMatchObject({
      status: "final",
      reference: "evm:payment:reconciled",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("requires authoritative absence before the same effect may execute again", async () => {
    const opened = await database();
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error("ambiguous"))
      .mockResolvedValueOnce({
        reference: "evm:payment:after-absence",
        authenticationHash: "1".repeat(64),
      });
    const reconcile = vi.fn(async () => ({
      status: "absent" as const,
      absenceProofHash: "2".repeat(64),
    }));
    const operation = track(opened, { execute, reconcile });

    await operation(operationInput());
    await new Promise((resolve) => setTimeout(resolve, 3));
    await expect(operation(operationInput())).resolves.toMatchObject({
      status: "pending-retry",
      reasonCode: "effect-authoritatively-absent",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 3));
    await expect(operation(operationInput())).resolves.toMatchObject({
      status: "final",
      reference: "evm:payment:after-absence",
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("retains indeterminate reconciliation and does not authorize a repeat", async () => {
    const opened = await database();
    const execute = vi.fn(async () => {
      throw new Error("ambiguous");
    });
    const retryAt = opened.readTime() + 30_000;
    const reconcile = vi.fn(async () => ({
      status: "indeterminate" as const,
      reasonCode: "chain-read-indeterminate",
      retryAt,
    }));
    const operation = track(opened, { execute, reconcile });

    await operation(operationInput());
    await new Promise((resolve) => setTimeout(resolve, 3));
    await expect(operation(operationInput())).resolves.toMatchObject({
      status: "indeterminate",
      reasonCode: "chain-read-indeterminate",
      retryAt,
    });
    await expect(operation(operationInput())).resolves.toMatchObject({
      status: "indeterminate",
      reasonCode: "chain-read-indeterminate",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("never repeats an effect whose durable result has an invalid projection", async () => {
    const opened = await database();
    const execute = vi.fn(async () => ({
      reference: "evm:payment:performed",
      authenticationHash: "3".repeat(64),
    }));
    const reconcile = vi.fn();
    const operation = createDacsLiveEffectTrackV1({
      database: opened,
      kind: "payment",
      role: "buyer",
      track: "payment",
      workerId: "effect-worker",
      retryDelayMs: 1,
      buildInput: () => ({ jobId: JOB_ID, amount: "1" }),
      adapter: { execute, reconcile },
      projectResult: () => ({ reference: "" }),
    });

    await expect(operation(operationInput())).resolves.toEqual({
      status: "operator-action",
      reasonCode: "effect-result-invalid",
    });
    await expect(operation(operationInput())).resolves.toEqual({
      status: "operator-action",
      reasonCode: "effect-result-invalid",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
    expect(opened.loadEffect("payment", EFFECT_ID)).toMatchObject({
      state: "completed",
    });
  });
});
