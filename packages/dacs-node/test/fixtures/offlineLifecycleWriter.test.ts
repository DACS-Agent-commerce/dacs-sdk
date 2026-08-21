import { writeFile } from "node:fs/promises";

import { test } from "vitest";

import { runOfflineVerifierSimulation } from "../../src/offlineLifecycle.js";

const outputDirectory = process.env["DACS_OFFLINE_WRITER_OUTPUT"];
const resultPath = process.env["DACS_OFFLINE_WRITER_RESULT"];

test.skipIf(outputDirectory === undefined || resultPath === undefined)(
  "publishes one cross-process simulation attempt",
  async () => {
    let result: Record<string, unknown>;
    try {
      const report = await runOfflineVerifierSimulation({ outputDirectory: outputDirectory! });
      result = { status: "fulfilled", jobId: report.jobId };
    } catch (error) {
      result = {
        status: "rejected",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    await writeFile(resultPath!, JSON.stringify(result), {
      encoding: "utf8",
      flag: "wx",
    });
  },
);
