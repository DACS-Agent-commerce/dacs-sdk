import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIXED_PRICE_X402_STANDARD_REVISION } from "@kynesyslabs/dacs/commerce";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DACS_LIVE_DOCTOR_CHECK_IDS,
  DACS_NODE_LIVE_PROFILE,
  DACS_FUNDED_DOCTOR_CONSENT_DOMAIN,
  DacsGuardedCommandError,
  createDacsGuardedPayDemPurchasePlanV1,
  createDacsGuardedPurchasePlanV1,
  createDacsGuardedSetupPlanV1,
  createDacsFundedDoctorPlanV1,
  runDacsGuardedCommandV1,
  runDacsLiveDoctorV1,
  type DacsGuardedExecutorV1,
  type DacsLiveDoctorReportV1,
} from "../src/index.js";
import {
  openDacsNodeSqliteDatabase,
  type DacsNodeSqliteDatabase,
} from "../src/sqlite.js";

const BUYER = `did:demos:agent:${"a".repeat(64)}`;
const SELLER = `did:demos:agent:${"b".repeat(64)}`;
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const NOW = 10_000;

async function doctor(
  phase: "pre-start" | "post-start",
  scope: "start" | "setup" | "buy",
): Promise<Readonly<DacsLiveDoctorReportV1>> {
  return runDacsLiveDoctorV1({
    phase,
    scope,
    sdkVersion: "0.1.0-alpha.0",
    standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
    profile: DACS_NODE_LIVE_PROFILE,
    now: () => NOW,
    probes: Object.fromEntries(DACS_LIVE_DOCTOR_CHECK_IDS.map((id) => [
      id,
      () => ({ status: "pass" as const }),
    ])),
  });
}

function setupPlan(effectId = "setup-listing-v1") {
  return createDacsGuardedSetupPlanV1({
    effectId,
    buyerAuthority: BUYER,
    sellerAuthority: SELLER,
    demosNetwork: "demos-testnet",
    listingContentHash: "c".repeat(64),
    actions: [
      { actionId: "listing", effectId: "listing-anchor-v1", maximumSpendDem: "4" },
      { actionId: "binding", effectId: "listing-binding-v1", maximumSpendDem: "3" },
    ],
    safetyMarginDem: "1",
    maximumSpendDem: "8",
  });
}

function purchasePlan(effectId = "x402-purchase-v1") {
  return createDacsGuardedPurchasePlanV1({
    effectId,
    jobId: JOB_ID,
    listingRef: "stor-test-listing-ref",
    requestHash: "d".repeat(64),
    buyerAuthority: BUYER,
    sellerAuthority: SELLER,
    payer: `0x${"1".repeat(40)}`,
    payee: `0x${"2".repeat(40)}`,
    railId: "x402:base-sepolia",
    network: "eip155:84532",
    asset: "USDC",
    serviceAmount: "0.5",
    maximumServiceAmount: "1",
    estimatedNetworkFeeEth: "0.0001",
    maximumNetworkFeeEth: "0.001",
    maximumDemosStorageWriteFeeDem: { buyer: "2", seller: "3" },
  });
}

function payDemPurchasePlan(effectId = "pay-dem-purchase-v1") {
  return createDacsGuardedPayDemPurchasePlanV1({
    effectId,
    jobId: JOB_ID,
    listingRef: "stor-test-native-listing-ref",
    requestHash: "e".repeat(64),
    buyerAuthority: BUYER,
    sellerAuthority: SELLER,
    payer: "a".repeat(64),
    payee: "b".repeat(64),
    railId: "demos-native:DEM",
    serviceAmount: "0.5",
    maximumServiceAmount: "1",
    maximumTotalDebitDem: "1.1",
    maximumDemosStorageWriteFeeDem: { buyer: "2", seller: "3" },
  });
}

function fundedDoctorPlan(effectId = "funded-doctor-v1") {
  return createDacsFundedDoctorPlanV1({
    effectId,
    runId: JOB_ID,
    disposableWallet: "disposable-test-wallet",
    walletAuthority: `0x${"3".repeat(40)}`,
    network: "eip155:84532",
    debits: [
      { actionId: "demos-anchor", asset: "DEM", maximumDebit: "2" },
      { actionId: "x402-payment", asset: "USDC", maximumDebit: "0.1" },
      { actionId: "base-gas", asset: "ETH", maximumDebit: "0.001" },
    ],
    ceilings: [
      { asset: "USDC", maximumTotalDebit: "0.1" },
      { asset: "DEM", maximumTotalDebit: "2" },
      { asset: "ETH", maximumTotalDebit: "0.001" },
    ],
  });
}

describe("guarded setup and purchase commands", () => {
  const roots: string[] = [];
  const databases: DacsNodeSqliteDatabase[] = [];

  async function database(role: "buyer" | "seller"): Promise<DacsNodeSqliteDatabase> {
    const directory = mkdtempSync(join(tmpdir(), "dacs-guarded-command-"));
    roots.push(directory);
    const value = await openDacsNodeSqliteDatabase({
      databasePath: join(directory, `${role}.sqlite`),
      mode: "live-demos",
      profile: DACS_NODE_LIVE_PROFILE,
      role,
      authority: role === "buyer" ? BUYER : SELLER,
    });
    databases.push(value);
    return value;
  }

  afterEach(() => {
    for (const value of databases.splice(0)) value.close();
    for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
  });

  it("keeps setup plan-only by default and exposes no executor effect", async () => {
    const execute = vi.fn(async () => ({ status: "completed" as const, result: {} }));
    const result = await runDacsGuardedCommandV1({
      plan: setupPlan(),
      database: await database("seller"),
      workerId: "setup-worker",
      doctorReports: [],
      executor: execute,
    });
    expect(result.status).toBe("plan-only");
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires a fresh buy doctor even for a purchase plan-only projection", async () => {
    const db = await database("buyer");
    const executor = vi.fn(async () => ({ status: "completed" as const, result: {} }));
    await expect(runDacsGuardedCommandV1({
      plan: purchasePlan(),
      database: db,
      workerId: "buyer-worker",
      doctorReports: [],
      executor,
      now: () => NOW,
    })).rejects.toEqual(new DacsGuardedCommandError("doctor-prerequisite-invalid-or-stale"));
    await expect(runDacsGuardedCommandV1({
      plan: purchasePlan(),
      database: db,
      workerId: "buyer-worker",
      doctorReports: [await doctor("post-start", "buy")],
      executor,
      now: () => NOW,
    })).resolves.toMatchObject({ status: "plan-only" });
    expect(executor).not.toHaveBeenCalled();
  });

  it("binds and displays the complete generated Demos cost envelope", async () => {
    const x402 = purchasePlan();
    expect(x402.demosCost).toEqual({
      rail: "x402",
      maximumStorageWriteFeeDem: { buyer: "2", seller: "3" },
      expectedStorageWrites: { buyer: 5, seller: 6 },
      safetyMarginWrites: { buyer: 1, seller: 1 },
      maximumStorageFeesDem: { buyer: "10", seller: "18" },
      safetyMarginDem: { buyer: "2", seller: "3" },
      minimumDem: { buyer: "12", seller: "21" },
      maximumTotalDemosDebitDem: "33",
    });
    const higherCap = createDacsGuardedPurchasePlanV1({
      ...x402,
      effectId: x402.effectId,
      maximumDemosStorageWriteFeeDem: { buyer: "2.1", seller: "3" },
    });
    expect(higherCap.planHash).not.toBe(x402.planHash);

    const confirm = vi.fn(() => false);
    await expect(runDacsGuardedCommandV1({
      plan: x402,
      execute: true,
      database: await database("buyer"),
      workerId: "buyer-consent-summary",
      doctorReports: [await doctor("post-start", "buy")],
      confirmation: "1",
      confirm,
      executor: async () => ({ status: "completed", result: {} }),
      now: () => NOW,
    })).rejects.toEqual(new DacsGuardedCommandError("interactive-confirmation-declined"));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      actionCount: 12,
      maximumAssetSpend: "1 USDC",
      maximumNetworkFee: "0.001 ETH EVM; 33 DEM whole-order Demos ceiling",
    }));
  });

  it("guards native DEM purchases with a total-debit ceiling and the buy doctor", async () => {
    const db = await database("buyer");
    const executor = vi.fn(async () => ({ status: "completed" as const, result: {} }));
    await expect(runDacsGuardedCommandV1({
      plan: payDemPurchasePlan(),
      database: db,
      workerId: "pay-dem-buyer-worker",
      doctorReports: [await doctor("post-start", "buy")],
      executor,
      now: () => NOW,
    })).resolves.toMatchObject({
      status: "plan-only",
      plan: {
        kind: "purchase-pay-dem",
        network: "demos",
        maximumTotalDebitDem: "1.1",
        demosCost: {
          expectedStorageWrites: { buyer: 5, seller: 6 },
          maximumTotalDemosDebitDem: "34.1",
        },
      },
    });
    expect(executor).not.toHaveBeenCalled();
    expect(() => createDacsGuardedPayDemPurchasePlanV1({
      ...payDemPurchasePlan(),
      effectId: "pay-dem-over-ceiling",
      maximumTotalDebitDem: "0.1",
      maximumDemosStorageWriteFeeDem: { buyer: "2", seller: "3" },
    })).toThrow(/exceeds a ceiling/);
  });

  it("rejects a forged or mutated plan before plan-only projection", async () => {
    const plan = setupPlan();
    const forged = { ...plan, maximumSpendDem: "8000" };
    await expect(runDacsGuardedCommandV1({
      plan: forged,
      database: await database("seller"),
      workerId: "setup-worker",
      doctorReports: [],
      executor: async () => ({ status: "completed", result: {} }),
    })).rejects.toThrow(/options are invalid/);
    const purchase = purchasePlan();
    await expect(runDacsGuardedCommandV1({
      plan: {
        ...purchase,
        demosCost: { ...purchase.demosCost, maximumTotalDemosDebitDem: "0" },
      },
      database: await database("buyer"),
      workerId: "buyer-worker",
      doctorReports: [await doctor("post-start", "buy")],
      executor: async () => ({ status: "completed", result: {} }),
      now: () => NOW,
    })).rejects.toThrow(/options are invalid/);
  });

  it("returns deeply immutable plans and rejects option accessors", async () => {
    const plan = setupPlan();
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.actions)).toBe(true);
    expect(Object.isFrozen(plan.actions[0])).toBe(true);
    expect(Reflect.set(plan.actions[0]!, "maximumSpendDem", "8000")).toBe(false);
    const execute = vi.fn(async () => ({ status: "completed" as const, result: {} }));
    const rawOptions = {
      plan,
      database: await database("seller"),
      workerId: "setup-worker",
      doctorReports: [],
      get executor() {
        return execute;
      },
    };
    await expect(runDacsGuardedCommandV1(rawOptions)).rejects.toThrow(
      /closed data object/,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires both fresh setup doctors and domain-specific confirmation", async () => {
    const db = await database("seller");
    const base = {
      plan: setupPlan(),
      execute: true,
      database: db,
      workerId: "setup-worker",
      doctorReports: [await doctor("post-start", "start"), await doctor("pre-start", "setup")],
      executor: async () => ({ status: "completed" as const, result: {} }),
      now: () => NOW,
    };
    await expect(runDacsGuardedCommandV1(base)).rejects.toEqual(
      new DacsGuardedCommandError("setup-confirmation-missing"),
    );
    await expect(runDacsGuardedCommandV1({
      ...base,
      confirmation: "1",
      confirm: () => false,
    })).rejects.toEqual(new DacsGuardedCommandError("interactive-confirmation-declined"));
    await expect(runDacsGuardedCommandV1({
      ...base,
      confirmation: "1",
      nonInteractive: true,
      doctorReports: [await doctor("pre-start", "setup")],
    })).rejects.toEqual(new DacsGuardedCommandError("doctor-prerequisite-invalid-or-stale"));
  });

  it("completes a setup effect once and replays the retained result", async () => {
    const db = await database("seller");
    const execute = vi.fn(async ({ fence }) => {
      await fence.assertCurrent();
      expect(fence.mode).toBe("perform");
      return { status: "completed" as const, result: { listingRef: "stor-listing" } };
    });
    const options = {
      plan: setupPlan(),
      execute: true,
      database: db,
      workerId: "setup-worker",
      doctorReports: [await doctor("post-start", "start"), await doctor("pre-start", "setup")],
      confirmation: "1",
      nonInteractive: true,
      executor: execute,
      now: () => NOW,
    };
    await expect(runDacsGuardedCommandV1(options)).resolves.toMatchObject({
      status: "completed",
      result: { listingRef: "stor-listing" },
    });
    await expect(runDacsGuardedCommandV1(options)).resolves.toMatchObject({
      status: "existing-completion",
      result: { listingRef: "stor-listing" },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("forces ambiguous purchase effects through reconciliation before completion", async () => {
    const db = await database("buyer");
    const calls: string[] = [];
    const executor: DacsGuardedExecutorV1 = async ({ fence }) => {
      await fence.assertCurrent();
      calls.push(fence.mode);
      return fence.mode === "perform"
        ? { status: "ambiguous" as const, reasonCode: "settlement-unknown" }
        : {
            status: "reconciled-performed" as const,
            result: { transactionHash: `0x${"e".repeat(64)}` },
          };
    };
    const options = {
      plan: purchasePlan(),
      execute: true,
      database: db,
      workerId: "buyer-worker",
      doctorReports: [await doctor("post-start", "buy")],
      confirmation: "1",
      nonInteractive: true,
      now: () => NOW,
      executor,
    };
    await expect(runDacsGuardedCommandV1(options)).resolves.toMatchObject({
      status: "reconciliation-required",
      reasonCode: "settlement-unknown",
    });
    await expect(runDacsGuardedCommandV1(options)).resolves.toMatchObject({
      status: "completed",
      result: { transactionHash: `0x${"e".repeat(64)}` },
    });
    expect(calls).toEqual(["perform", "reconcile"]);
  });

  it("records executor throws as ambiguous without leaking the error", async () => {
    const db = await database("buyer");
    const result = await runDacsGuardedCommandV1({
      plan: purchasePlan(),
      execute: true,
      database: db,
      workerId: "buyer-worker",
      doctorReports: [await doctor("post-start", "buy")],
      confirmation: "1",
      nonInteractive: true,
      now: () => NOW,
      executor: async () => { throw new Error("private RPC URL and wallet detail"); },
    });
    expect(result).toMatchObject({
      status: "reconciliation-required",
      reasonCode: "guarded-executor-threw",
    });
    expect(JSON.stringify(result)).not.toContain("private RPC");
  });

  it("refuses to trust an executor result that bypassed the generation fence", async () => {
    const db = await database("buyer");
    const options = {
      plan: purchasePlan("x402-unfenced-purchase-v1"),
      execute: true,
      database: db,
      workerId: "buyer-worker",
      doctorReports: [await doctor("post-start", "buy")],
      confirmation: "1",
      nonInteractive: true,
      now: () => NOW,
      executor: async () => ({ status: "completed" as const, result: { unsafe: true } }),
    };
    await expect(runDacsGuardedCommandV1(options)).resolves.toMatchObject({
      status: "reconciliation-required",
      reasonCode: "effect-fence-not-asserted",
    });
    await expect(runDacsGuardedCommandV1({
      ...options,
      executor: async ({ fence }: Parameters<DacsGuardedExecutorV1>[0]) => {
        expect(fence.mode).toBe("reconcile");
        await fence.assertCurrent();
        return { status: "reconciled-absent" as const, absenceProofHash: "f".repeat(64) };
      },
    })).resolves.toMatchObject({ status: "reconciliation-cleared" });
  });

  it("uses a separate funded-doctor consent domain and total-debit plan", async () => {
    const db = await database("buyer");
    const execute = vi.fn(async ({ plan, consent, fence }:
      Parameters<DacsGuardedExecutorV1>[0]) => {
      await fence.assertCurrent();
      expect(plan.kind).toBe("funded-doctor");
      expect(consent.domain).toBe(DACS_FUNDED_DOCTOR_CONSENT_DOMAIN);
      return { status: "completed" as const, result: { smoke: "passed" } };
    });
    await expect(runDacsGuardedCommandV1({
      plan: fundedDoctorPlan(),
      execute: true,
      database: db,
      workerId: "funded-doctor-worker",
      doctorReports: [await doctor("post-start", "start")],
      confirmation: "1",
      nonInteractive: true,
      executor: execute,
      now: () => NOW,
    })).resolves.toMatchObject({ status: "completed", result: { smoke: "passed" } });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("enforces whole-plan setup and purchase ceilings before consent", () => {
    expect(() => createDacsGuardedSetupPlanV1({
      ...setupPlan(),
      actions: [
        { actionId: "listing", effectId: "listing-v2", maximumSpendDem: "8" },
      ],
      safetyMarginDem: "1",
      maximumSpendDem: "8",
    })).toThrowError(new DacsGuardedCommandError("setup-spend-ceiling-insufficient"));
    expect(() => createDacsGuardedPurchasePlanV1({
      ...purchasePlan(),
      serviceAmount: "2",
      maximumServiceAmount: "1",
      maximumDemosStorageWriteFeeDem: { buyer: "2", seller: "3" },
    })).toThrow(/exceeds a ceiling/);
    expect(() => createDacsGuardedPurchasePlanV1({
      ...purchasePlan(),
      network: "eip155:8453",
      maximumDemosStorageWriteFeeDem: { buyer: "2", seller: "3" },
    })).toThrow(/invalid/);
    expect(() => createDacsFundedDoctorPlanV1({
      ...fundedDoctorPlan(),
      debits: [
        { actionId: "demos-anchor", asset: "DEM", maximumDebit: "3" },
      ],
      ceilings: [{ asset: "DEM", maximumTotalDebit: "2" }],
    })).toThrowError(
      new DacsGuardedCommandError("funded-doctor-debit-ceiling-insufficient"),
    );
  });
});
