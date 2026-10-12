import { describe, expect, test } from "vitest";

import {
  createInMemoryLiquidityTankStore,
  type LiquidityTankStore,
} from "../../src/rails/liquidityTank.js";
import { runLiquidityTankStoreConformance } from "../../src/rails/liquidityTankStoreConformance.js";
import * as rails from "../../src/rails/index.js";
import * as root from "../../src/index.js";

describe("runLiquidityTankStoreConformance", () => {
  test("the reference store passes every case within one process", async () => {
    const results = await runLiquidityTankStoreConformance({
      createStore: () => createInMemoryLiquidityTankStore(),
      // The reference store cannot survive a restart; within one process the
      // same instance stands in for the reopened handle.
      reopenStore: (store) => store,
    });
    expect(results.filter((result) => !result.passed)).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(20);
    expect(new Set(results.map((result) => result.name)).size).toBe(results.length);
  });

  test("the reference store fails the restart cases when a restart really drops its memory", async () => {
    const results = await runLiquidityTankStoreConformance({
      createStore: () => createInMemoryLiquidityTankStore(),
      reopenStore: () => createInMemoryLiquidityTankStore(),
    });
    const failed = results.filter((result) => !result.passed);
    expect(failed.map((result) => result.name)).toEqual([
      "retained state survives a restart",
      "through the core, crashes and restarts never double-send, over-lock or settle an expired phase",
      "through the core, an expired phase stays expired across restarts and a late release",
    ]);
    // After the restart the core signs and broadcasts a second bridge operation.
    expect(failed[1]?.failure).toMatch(/2 different signed submissions were broadcast/);
  });

  test("a store that accepts a submission replacement fails its case", async () => {
    const results = await runLiquidityTankStoreConformance({
      createStore: () => {
        const inner = createInMemoryLiquidityTankStore();
        const store: LiquidityTankStore = {
          ...inner,
          recordSubmission: async (input) => {
            const result = await inner.recordSubmission(input);
            return result.status === "conflict" ? { status: "existing" } : result;
          },
        };
        return store;
      },
      reopenStore: (store) => store,
    });
    expect(results.filter((result) => !result.passed).map((result) => result.name)).toEqual([
      "the first submission is kept and a replacement is refused",
      "a bridge operation serves one settlement only",
    ]);
  });

  test("a store that throws reports a failed case instead of rejecting the run", async () => {
    const results = await runLiquidityTankStoreConformance({
      createStore: () => {
        throw new Error("database unavailable");
      },
      reopenStore: (store) => store,
    });
    expect(results.every((result) => !result.passed && result.failure === "database unavailable"))
      .toBe(true);
  });

  test("is exported from the rails and root barrels", () => {
    expect(rails.runLiquidityTankStoreConformance).toBe(runLiquidityTankStoreConformance);
    expect(root.runLiquidityTankStoreConformance).toBe(runLiquidityTankStoreConformance);
  });
});
