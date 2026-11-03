import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { DACS_NODE_RELEASE_METADATA_V1 } from "../src/release.js";
import {
  DACS_NODE_SQLITE_APPLICATION_ID,
  DACS_NODE_SQLITE_SCHEMA_VERSION,
} from "../src/sqlite.js";

const PACKAGE_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));
const HOOK_URL = pathToFileURL(
  join(PACKAGE_DIRECTORY, "test/helpers/recordingResolveHook.mjs"),
).href;
const PROBE_PATH = join(PACKAGE_DIRECTORY, "test/helpers/defaultOpenerProbe.mjs");
const SQLITE_MODULE_SUFFIX = "/dist/sqlite.js";
const CHILD_TIMEOUT_MS = 60_000;

interface ChildRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly log: readonly string[];
}

interface ProbeOutput {
  readonly logBefore: string;
  readonly outcomes: ReadonlyArray<{
    readonly opened: boolean;
    readonly name?: string;
    readonly reasonCode?: string;
    readonly causeCode?: string;
    readonly causeMessage?: string;
  }>;
  readonly secretsDestroyed: readonly boolean[];
}

describe("root import without the optional SQLite driver", () => {
  const logDirectories: string[] = [];

  beforeAll(() => {
    // The children import the built package through its own export map.
    expect(
      existsSync(join(PACKAGE_DIRECTORY, "dist/index.js")),
      "build packages/dacs-node (and the core package) before running this file",
    ).toBe(true);
  });

  afterEach(() => {
    for (const directory of logDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function runWithHook(nodeArguments: readonly string[]): ChildRun {
    const logDirectory = mkdtempSync(join(tmpdir(), "dacs-resolve-log-"));
    logDirectories.push(logDirectory);
    const logPath = join(logDirectory, "resolve.log");
    const child = spawnSync(
      process.execPath,
      ["--import", HOOK_URL, ...nodeArguments],
      {
        cwd: PACKAGE_DIRECTORY,
        env: { ...process.env, DACS_RESOLVE_LOG: logPath },
        encoding: "utf8",
        timeout: CHILD_TIMEOUT_MS,
      },
    );
    return {
      status: child.status,
      stdout: child.stdout,
      stderr: child.stderr,
      log: existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n") : [],
    };
  }

  function importEntries(specifiers: readonly string[]): ChildRun {
    return runWithHook([
      "--input-type=module",
      "-e",
      `await Promise.all(${JSON.stringify(specifiers)}.map((specifier) => import(specifier)));`,
    ]);
  }

  function runProbe(mode: "single" | "concurrent"): { run: ChildRun; probe: ProbeOutput } {
    const run = runWithHook([PROBE_PATH, mode]);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    return { run, probe: JSON.parse(run.stdout) as ProbeOutput };
  }

  function loadedSqliteModules(log: readonly string[]): string[] {
    return log.filter((line) => line.startsWith("load ") && line.endsWith(SQLITE_MODULE_SUFFIX));
  }

  it("the root entry imports without requesting better-sqlite3", () => {
    const run = importEntries(["@kynesyslabs/dacs-node"]);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.log).not.toContain("resolve better-sqlite3");
  });

  it("./transport and ./demos-loader import without requesting better-sqlite3", () => {
    const run = importEntries([
      "@kynesyslabs/dacs-node/transport",
      "@kynesyslabs/dacs-node/demos-loader",
    ]);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.log).not.toContain("resolve better-sqlite3");
  });

  it("./sqlite still requests better-sqlite3 (control)", () => {
    const run = importEntries(["@kynesyslabs/dacs-node/sqlite"]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("ERR_MODULE_NOT_FOUND");
    expect(run.log).toContain("resolve better-sqlite3");
  });

  it("the schema version in DACS_NODE_RELEASE_METADATA_V1 and the ./sqlite export are the same constant", async () => {
    const sqliteConstants = await import("../src/sqliteConstants.js");
    expect(DACS_NODE_RELEASE_METADATA_V1.sqliteSchemaVersion).toBe(
      DACS_NODE_SQLITE_SCHEMA_VERSION,
    );
    expect(sqliteConstants.DACS_NODE_SQLITE_SCHEMA_VERSION).toBe(
      DACS_NODE_SQLITE_SCHEMA_VERSION,
    );
    expect(sqliteConstants.DACS_NODE_SQLITE_APPLICATION_ID).toBe(
      DACS_NODE_SQLITE_APPLICATION_ID,
    );
  });

  it("the default database opener loads the SQLite module only when called", () => {
    const { run, probe } = runProbe("single");
    expect(loadedSqliteModules(probe.logBefore.split("\n"))).toEqual([]);
    expect(loadedSqliteModules(run.log)).toHaveLength(1);
  });

  it("a missing driver reports role-database-open-failed with the original error as cause and destroys the loaded identity", () => {
    const { probe } = runProbe("single");
    expect(probe.outcomes).toEqual([
      {
        opened: false,
        name: "DacsLiveRoleRuntimeError",
        reasonCode: "role-database-open-failed",
        causeCode: "ERR_MODULE_NOT_FOUND",
        causeMessage: expect.stringContaining("better-sqlite3"),
      },
    ]);
    expect(probe.secretsDestroyed).toEqual([true]);
  });

  it("concurrent and repeated default opens share one module instance", () => {
    const { run, probe } = runProbe("concurrent");
    expect(probe.outcomes.map((outcome) => outcome.reasonCode)).toEqual([
      "role-database-open-failed",
      "role-database-open-failed",
      "role-database-open-failed",
    ]);
    expect(loadedSqliteModules(run.log)).toHaveLength(1);
  });
});
