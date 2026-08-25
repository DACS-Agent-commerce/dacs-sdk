import { describe, expect, it } from "vitest";

import {
  dacsFixedPricePurchaseAnchorOptionsV1,
  retainDacsFixedPricePurchaseDemosBudgetGrantV1,
} from "../src/purchaseDemosBudget.js";

const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";

function context(
  role: "buyer" | "seller",
  configuredRole = role,
  retainGrant = true,
) {
  const effects = new Map<string, unknown>();
  const authority = `did:demos:agent:${role === "buyer" ? "1" : "2"}`;
  const database = {
    metadata: { mode: "live-demos", role, authority },
    loadEffectInput: (_kind: string, id: string) => effects.get(id),
    putEffectIntent: (input: Readonly<{ effectId: string; input: unknown }>) => {
      if (effects.has(input.effectId)) return { status: "existing" as const };
      effects.set(input.effectId, structuredClone(input.input));
      return { status: "created" as const };
    },
  } as never;
  if (retainGrant) {
    retainDacsFixedPricePurchaseDemosBudgetGrantV1({
      database,
      jobId: JOB_ID,
      role,
      authority,
      maximumPerWriteFeeDem: "2",
    });
  }
  return {
    role,
    authority,
    database,
    config: {
      role: configuredRole,
      limits: { maxDemosNetworkFeeDem: "2" },
    },
  };
}

describe("fixed-price Demos aggregate fee budget", () => {
  it("derives role-local retained ceilings from the audited write graph", () => {
    expect(dacsFixedPricePurchaseAnchorOptionsV1(
      context("buyer") as never,
      JOB_ID,
      { logicalAddress: "dacs:test:buyer" },
    )).toEqual({
      metadata: { logicalAddress: "dacs:test:buyer" },
      feeBudget: {
        budgetId: `dacs-fixed-price-purchase:v1:${JOB_ID}:buyer`,
        maximumTotalFeeOs: 12_000_000_000n,
      },
    });
    expect(dacsFixedPricePurchaseAnchorOptionsV1(
      context("seller") as never,
      JOB_ID,
      { logicalAddress: "dacs:test:seller" },
    ).feeBudget?.maximumTotalFeeOs).toBe(14_000_000_000n);
  });

  it("rejects role/config substitution and malformed job identities", () => {
    expect(() => dacsFixedPricePurchaseAnchorOptionsV1(
      context("buyer", "seller") as never,
      JOB_ID,
      {},
    )).toThrow(/input is invalid/);
    expect(() => dacsFixedPricePurchaseAnchorOptionsV1(
      context("buyer") as never,
      "not-a-job",
      {},
    )).toThrow(/input is invalid/);
  });

  it("does not enlarge a retained order grant after configuration changes", () => {
    const value = context("buyer");
    value.config.limits.maxDemosNetworkFeeDem = "99";
    expect(dacsFixedPricePurchaseAnchorOptionsV1(
      value as never,
      JOB_ID,
      {},
    ).feeBudget?.maximumTotalFeeOs).toBe(12_000_000_000n);
    expect(() => retainDacsFixedPricePurchaseDemosBudgetGrantV1({
      database: value.database,
      jobId: JOB_ID,
      role: "buyer",
      authority: value.authority,
      maximumPerWriteFeeDem: "3",
    })).toThrow(/conflicts/);
  });

  it("fails closed without an order grant and enforces seller admission policy", () => {
    const missing = context("buyer", "buyer", false);
    expect(() => dacsFixedPricePurchaseAnchorOptionsV1(
      missing as never,
      JOB_ID,
      {},
    )).toThrow(/grant is missing/);

    const seller = context("seller", "seller", false);
    expect(() => retainDacsFixedPricePurchaseDemosBudgetGrantV1({
      database: seller.database,
      jobId: JOB_ID,
      role: "seller",
      authority: seller.authority,
      maximumPerWriteFeeDem: "3",
      maximumAllowedPerWriteFeeDem: "2",
    })).toThrow(/exceeds local policy/);
  });
});
