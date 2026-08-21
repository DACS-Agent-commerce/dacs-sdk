import { writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { armFundedRun, type FundedRunIntent } from "./funded-run-marker.js";

const inputText = process.env.FUNDED_MARKER_PROCESS_INPUT;
const resultPath = process.env.FUNDED_MARKER_PROCESS_RESULT;

describe("funded-run marker process contender", () => {
  if (!inputText || !resultPath) {
    it.skip("runs only as an isolated child of the contention regression", () => undefined);
    return;
  }

  it("reports whether this process acquired the exclusive intent", async () => {
    const input = JSON.parse(inputText) as FundedRunIntent;
    let outcome: "armed" | "blocked";
    try {
      await armFundedRun(input);
      outcome = "armed";
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/run-already-armed/);
      outcome = "blocked";
    }
    await writeFile(resultPath, outcome, { encoding: "utf8", flag: "wx", mode: 0o600 });
  });
});
