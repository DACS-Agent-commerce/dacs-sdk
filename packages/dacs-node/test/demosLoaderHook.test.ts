import { describe, expect, it, vi } from "vitest";

import { resolve } from "../src/demosLoaderHook.js";

const context = Object.freeze({
  conditions: Object.freeze(["node", "import"]),
  importAttributes: Object.freeze({}),
});

describe("Demos ESM compatibility loader", () => {
  it("resolves only the exact published operations directory", async () => {
    const error = Object.assign(new Error("directory import"), {
      code: "ERR_UNSUPPORTED_DIR_IMPORT",
      url: "file:///app/node_modules/@kynesyslabs/demosdk/build/demoswork/operations/",
    });
    const nextResolve = vi.fn(async () => { throw error; });

    await expect(resolve("./", context, nextResolve)).resolves.toEqual({
      url: "file:///app/node_modules/@kynesyslabs/demosdk/build/demoswork/operations/index.js",
      shortCircuit: true,
    });
    expect(nextResolve).toHaveBeenCalledOnce();
  });

  it("preserves all unrelated resolution failures", async () => {
    const error = Object.assign(new Error("directory import"), {
      code: "ERR_UNSUPPORTED_DIR_IMPORT",
      url: "file:///app/node_modules/unrelated/operations/",
    });
    await expect(resolve("./", context, async () => { throw error; }))
      .rejects.toBe(error);
  });
});
