import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from
  "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  armFundedRun,
  executeFundedRun,
  recordFundedRunOutcome,
  type FundedRunIntent,
} from "./funded-run-marker.js";

const temporaryDirectories: string[] = [];
const require = createRequire(import.meta.url);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const vitestBin = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const processTest = "test/integration/funded-run-marker.process.test.ts";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  // The production guard rejects recognized OS-temporary roots. Test beneath
  // the checkout so fixtures exercise the same ownership/mode contract.
  const directory = await mkdtemp(join(await realpath(repositoryRoot), `.${prefix}`));
  temporaryDirectories.push(directory);
  return directory;
}

async function fixture(): Promise<FundedRunIntent> {
  return {
    directory: await temporaryDirectory("funded-marker-"),
    operation: "x402-two-agent-e2e",
    runId: "x402-2026-08-15-a",
    details: {
      amountBaseUnits: "1",
      network: "eip155:84532",
      payer: `0x${"ab".repeat(20)}`,
      payee: `0x${"cd".repeat(20)}`,
    },
  };
}

async function runContentionProcess(
  input: FundedRunIntent,
  resultPath: string,
): Promise<void> {
  await new Promise<void>((resolveProcess, rejectProcess) => {
    const child = spawn(process.execPath, [vitestBin, "run", processTest, "--reporter=dot"], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        FUNDED_MARKER_PROCESS_INPUT: JSON.stringify(input),
        FUNDED_MARKER_PROCESS_RESULT: resultPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectProcess);
    child.once("close", (code) => {
      if (code === 0) {
        resolveProcess();
        return;
      }
      rejectProcess(new Error(
        `marker contention child exited ${String(code)}\n${stdout}\n${stderr}`,
      ));
    });
  });
}

describe("durable funded-run guard", () => {
  it("allows exactly one concurrent arm for an operation/run id", async () => {
    const input = await fixture();
    const results = await Promise.allSettled([
      armFundedRun(input, () => 1_800_000_000_000),
      armFundedRun(input, () => 1_800_000_000_001),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: expect.stringContaining("run-already-armed") }),
    });

    const armed = results.find((result) => result.status === "fulfilled");
    if (!armed || armed.status !== "fulfilled") throw new Error("marker was not armed");
    const record = JSON.parse(await readFile(armed.value.markerPath, "utf8"));
    expect(record).toMatchObject({
      markerVersion: "1",
      operation: input.operation,
      runId: input.runId,
      state: "armed",
      markerId: armed.value.markerId,
      details: input.details,
    });
    expect(JSON.stringify(record)).not.toMatch(/secret|mnemonic|private.?key/i);
  });

  it("allows exactly one arm across independent operating-system processes", async () => {
    const input = await fixture();
    const firstResult = join(input.directory, ".first-process-result");
    const secondResult = join(input.directory, ".second-process-result");
    await Promise.all([
      runContentionProcess(input, firstResult),
      runContentionProcess(input, secondResult),
    ]);
    const outcomes = await Promise.all([
      readFile(firstResult, "utf8"),
      readFile(secondResult, "utf8"),
    ]);
    expect(outcomes.sort()).toEqual(["armed", "blocked"]);
  }, 30_000);

  it("cannot bypass a marker by changing wallets, amounts, or other details", async () => {
    const input = await fixture();
    const armed = await armFundedRun(input);
    await expect(armFundedRun({
      ...input,
      details: {
        ...input.details,
        amountBaseUnits: "2",
        payer: `0x${"ef".repeat(20)}`,
      },
    })).rejects.toThrow(`run-already-armed:${armed.markerId}`);
  });

  it("snapshots caller-owned details before the first asynchronous boundary", async () => {
    const details: Record<string, string> = { amountBaseUnits: "1", network: "demos" };
    const input = { ...(await fixture()), details };
    const pending = armFundedRun(input, () => 1);
    details.amountBaseUnits = "999";
    details.network = "changed";
    const armed = await pending;
    const record = JSON.parse(await readFile(armed.markerPath, "utf8"));
    expect(record.details).toEqual({ amountBaseUnits: "1", network: "demos" });
  });

  it("rejects proxy intent records without invoking their property traps", async () => {
    const target = await fixture();
    let propertyReads = 0;
    const input = new Proxy(target, {
      get(object, key, receiver) {
        propertyReads += 1;
        if (key === "operation") return "private-key-material-is-here";
        return Reflect.get(object, key, receiver);
      },
    });

    await expect(armFundedRun(input)).rejects.toThrow(/marker-intent-invalid/);
    expect(propertyReads).toBe(0);
    expect(await readdir(target.directory)).toEqual([]);
  });

  it("never invokes the irreversible callback when a prior intent exists", async () => {
    const input = await fixture();
    await armFundedRun(input);
    let irreversibleCalls = 0;
    await expect(executeFundedRun(input, async () => {
      irreversibleCalls += 1;
      return "submitted";
    })).rejects.toThrow(/run-already-armed/);
    expect(irreversibleCalls).toBe(0);
  });

  it("retains the intent after an ambiguous callback failure", async () => {
    const input = await fixture();
    let irreversibleCalls = 0;
    await expect(executeFundedRun(input, async () => {
      irreversibleCalls += 1;
      throw new Error("response-lost-after-submission");
    })).rejects.toThrow(/effect-ambiguous-do-not-rerun/);
    await expect(executeFundedRun(input, async () => {
      irreversibleCalls += 1;
      return "submitted-again";
    })).rejects.toThrow(/run-already-armed/);
    expect(irreversibleCalls).toBe(1);
  });

  it("records one write-once-through-helper outcome without removing the intent", async () => {
    const input = await fixture();
    const armed = await armFundedRun(input, () => 1);
    const outcome = {
      status: "audit-complete" as const,
      details: { transactionHash: "12".repeat(32), blockNumber: 45_486_024 },
    };
    await recordFundedRunOutcome(armed, outcome, () => 2);
    expect(JSON.parse(await readFile(armed.outcomePath, "utf8"))).toMatchObject({
      markerId: armed.markerId,
      state: "audit-complete",
      details: outcome.details,
      recordedAt: 2,
    });
    await expect(recordFundedRunOutcome(armed, outcome)).rejects.toThrow(
      /outcome-already-recorded/,
    );
    await expect(readFile(armed.markerPath, "utf8")).resolves.toContain('"state":"armed"');
  });

  it("snapshots outcome state before the first asynchronous boundary", async () => {
    const input = await fixture();
    const armed = await armFundedRun(input, () => 1);
    const outcome: { status: string; details: Record<string, string> } = {
      status: "included",
      details: { transactionHash: "12".repeat(32) },
    };
    const pending = recordFundedRunOutcome(
      armed,
      outcome as unknown as Parameters<typeof recordFundedRunOutcome>[1],
      () => 2,
    );
    outcome.status = "forged-unsupported-status";
    outcome.details.transactionHash = "34".repeat(32);
    await pending;

    expect(JSON.parse(await readFile(armed.outcomePath, "utf8"))).toMatchObject({
      state: "included",
      details: { transactionHash: "12".repeat(32) },
    });
  });

  it("snapshots marker paths before asynchronous directory checks", async () => {
    const parent = await temporaryDirectory("funded-marker-redirect-");
    const markerDirectory = join(parent, "markers");
    await mkdir(markerDirectory, { mode: 0o700 });
    const base = await fixture();
    const armed = await armFundedRun({ ...base, directory: markerDirectory }, () => 1);
    const mutableMarker = { ...armed };
    const redirectedPath = join(parent, "redirected.outcome.json");
    const pending = recordFundedRunOutcome(
      mutableMarker,
      { status: "included", details: { transactionHash: "12".repeat(32) } },
      () => 2,
    );
    mutableMarker.outcomePath = redirectedPath;
    await pending;

    await expect(readFile(armed.outcomePath, "utf8")).resolves.toContain(
      '"state":"included"',
    );
    await expect(readFile(redirectedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects proxy and accessor marker/outcome records", async () => {
    const input = await fixture();
    const armed = await armFundedRun(input, () => 1);
    await expect(recordFundedRunOutcome(
      new Proxy({ ...armed }, {}),
      { status: "included" },
    )).rejects.toThrow(/marker-invalid/);
    await expect(recordFundedRunOutcome(
      armed,
      new Proxy({ status: "included" as const }, {}),
    )).rejects.toThrow(/outcome-invalid/);

    let accessorReads = 0;
    const accessorOutcome: Record<string, unknown> = {};
    Object.defineProperty(accessorOutcome, "status", {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return "included";
      },
    });
    await expect(recordFundedRunOutcome(
      armed,
      accessorOutcome as unknown as Parameters<typeof recordFundedRunOutcome>[1],
    )).rejects.toThrow(/outcome-invalid/);
    expect(accessorReads).toBe(0);
    await expect(recordFundedRunOutcome(
      armed,
      { status: "included", details: null } as unknown as
        Parameters<typeof recordFundedRunOutcome>[1],
    )).rejects.toThrow(/outcome-details-not-plain/);
  });

  it("refuses to attach an outcome to a forged or corrupted intent", async () => {
    const input = await fixture();
    const armed = await armFundedRun(input, () => 1);
    await writeFile(armed.markerPath, '{"state":"armed"}\n', { mode: 0o600 });
    await expect(recordFundedRunOutcome(armed, {
      status: "unresolved",
      details: { reason: "inclusion-not-observed" },
    })).rejects.toThrow(/intent-marker-corrupt/);

    const fakeId = "34".repeat(32);
    await expect(recordFundedRunOutcome({
      markerId: fakeId,
      markerPath: join(input.directory, `${fakeId}.intent.json`),
      outcomePath: join(input.directory, `${fakeId}.outcome.json`),
    }, { status: "ambiguous" })).rejects.toThrow();
  });

  it("requires public primitive details and refuses secret-shaped keys", async () => {
    const input = await fixture();
    await expect(armFundedRun({
      ...input,
      details: { privateKey: "must-never-be-written" },
    })).rejects.toThrow(/sensitive-key/);
    await expect(armFundedRun({
      ...input,
      details: { amount: 0.1 },
    })).rejects.toThrow(/number-invalid/);
    await expect(armFundedRun({
      ...input,
      details: Object.create({ inherited: "unsafe" }) as Record<string, string>,
    })).rejects.toThrow(/not-plain/);
    await expect(armFundedRun({
      ...input,
      details: JSON.parse('{"__proto__":"unsafe"}') as Record<string, string>,
    })).rejects.toThrow(/key-invalid/);
  });

  it("rejects an oversized encoded intent before creating a marker file", async () => {
    const input = await fixture();
    const details = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`field${index}`, "a".repeat(4_096)]),
    );
    await expect(armFundedRun({ ...input, details })).rejects.toThrow(
      /intent-marker-too-large/,
    );
    expect(await readdir(input.directory)).toEqual([]);
  });

  it("rejects an oversized encoded outcome before creating an outcome file", async () => {
    const input = await fixture();
    const armed = await armFundedRun(input, () => 1);
    const details = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`field${index}`, "a".repeat(4_096)]),
    );
    await expect(recordFundedRunOutcome(
      armed,
      { status: "included", details },
      () => 2,
    )).rejects.toThrow(/outcome-marker-too-large/);
    await expect(readFile(armed.outcomePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires a pre-existing absolute private directory outside known temp roots", async () => {
    const input = await fixture();
    await expect(armFundedRun({ ...input, directory: "relative" })).rejects.toThrow(
      /must-be-absolute/,
    );
    await expect(armFundedRun({
      ...input,
      directory: join(input.directory, "not-created"),
    })).rejects.toThrow(/must-exist/);
    const volatileDirectory = await mkdtemp(join(await realpath(tmpdir()), "funded-volatile-"));
    temporaryDirectories.push(volatileDirectory);
    await expect(armFundedRun({
      ...input,
      directory: volatileDirectory,
    })).rejects.toThrow(/must-be-persistent/);

    await chmod(input.directory, 0o750);
    try {
      await expect(armFundedRun(input)).rejects.toThrow(/must-be-private/);
    } finally {
      await chmod(input.directory, 0o700);
    }
  });

  it("rejects final and intermediate symlink components", async () => {
    const input = await fixture();
    const parent = await temporaryDirectory("funded-marker-link-");
    const linked = join(parent, "linked");
    await symlink(input.directory, linked);
    await expect(armFundedRun({ ...input, directory: linked })).rejects.toThrow(
      /directory-unsafe/,
    );

    const actualParent = join(parent, "actual");
    const actualMarkers = join(actualParent, "markers");
    await mkdir(actualMarkers, { recursive: true, mode: 0o700 });
    const linkedParent = join(parent, "linked-parent");
    await symlink(actualParent, linkedParent);
    await expect(armFundedRun({
      ...input,
      directory: join(linkedParent, "markers"),
    })).rejects.toThrow(/directory-unsafe|realpath-drift/);
  });

  it("rejects a marker path whose ancestor permits replacement", async () => {
    const input = await fixture();
    const unsafeAncestor = await temporaryDirectory("funded-marker-writable-");
    const markerDirectory = join(unsafeAncestor, "markers");
    await mkdir(markerDirectory, { mode: 0o700 });
    await chmod(unsafeAncestor, 0o777);
    try {
      await expect(armFundedRun({
        ...input,
        directory: markerDirectory,
      })).rejects.toThrow(/ancestor-writable/);
    } finally {
      await chmod(unsafeAncestor, 0o700);
    }
  });

  it("requires stable identifiers and non-negative safe timestamps", async () => {
    const input = await fixture();
    await expect(armFundedRun({ ...input, operation: "unsafe operation" }))
      .rejects.toThrow(/operation-invalid/);
    await expect(armFundedRun({ ...input, runId: "unsafe run id" }))
      .rejects.toThrow(/run-id-invalid/);
    await expect(armFundedRun(input, () => -1)).rejects.toThrow(/timestamp-invalid/);
  });
});
