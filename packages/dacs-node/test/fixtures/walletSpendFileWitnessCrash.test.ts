import { writeFile } from "node:fs/promises";

import { describe, it, vi } from "vitest";

import { openTestWitness, transitionTo } from "../helpers/walletSpendFileWitness.js";

const directory = process.env.DACS_FILE_WITNESS_CRASH_DIRECTORY;
const readyPath = process.env.DACS_FILE_WITNESS_CRASH_READY;
const point = process.env.DACS_FILE_WITNESS_CRASH_POINT;
const revision = Number(process.env.DACS_FILE_WITNESS_CRASH_REVISION);
const configured = directory !== undefined && readyPath !== undefined &&
  (point === "before-link" || point === "after-link") && Number.isSafeInteger(revision);

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const stallAfterSignalling = async (): Promise<never> => {
    await actual.writeFile(process.env.DACS_FILE_WITNESS_CRASH_READY ?? "", "ready");
    return new Promise<never>(() => undefined);
  };
  return {
    ...actual,
    link: async (existingPath: string, newPath: string) => {
      const crashPoint = process.env.DACS_FILE_WITNESS_CRASH_POINT;
      if (crashPoint === "before-link") await stallAfterSignalling();
      await actual.link(existingPath, newPath);
      if (crashPoint === "after-link") await stallAfterSignalling();
    },
  };
});

describe("file witness crash fixture", () => {
  it.skipIf(!configured)("advances one revision and stops at the chosen point", async () => {
    const opened = await openTestWitness(directory!);
    await opened.witness.compareAndSet(transitionTo(revision));
    await writeFile(readyPath!, "finished");
  }, 600_000);
});
