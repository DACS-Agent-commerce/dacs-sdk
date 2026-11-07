import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>() }));
import * as fs from "node:fs";

vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>() }));
import * as child from "node:child_process";
import { qualifyJournalRestart } from "../../src/wire/journalRestart.js";

const directories: string[] = [];
const directory = () => { const path = mkdtempSync(join(tmpdir(), "dacs-restart-")); directories.push(path); return path; };
const refused = expect.objectContaining({ code: "seller_replay_guard_invalid", status: 500, detail: "RESTART-NOT-QUALIFIED" });
afterEach(() => { vi.restoreAllMocks(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

it("qualifies only after the publisher exits and a separate process checks the publication once", () => {
  const path = directory(), actual = child.spawnSync, phases: string[] = [];
  vi.spyOn(child, "spawnSync").mockImplementation((...args: Parameters<typeof child.spawnSync>) => {
    const argv = args[1];
    if (!Array.isArray(argv)) throw new Error("missing probe arguments");
    phases.push(String(argv[2]));
    if (phases.length === 2) expect(readdirSync(path).filter((name) => name.startsWith("probe-"))).toHaveLength(1);
    return actual(...args);
  });
  qualifyJournalRestart(path);
  expect(phases).toEqual(["publish", "verify"]);
  expect(readdirSync(path)).toEqual([]);
  qualifyJournalRestart(path);
  expect(phases).toEqual(["publish", "verify", "publish", "verify"]);
});

it.each(["missing", "changed", "oversized"])("refuses %s retained publication before qualification", (fault) => {
  const path = directory(), actual = child.spawnSync;
  vi.spyOn(child, "spawnSync").mockImplementation((...args: Parameters<typeof child.spawnSync>) => {
    const argv = args[1];
    if (Array.isArray(argv) && argv[2] === "verify") {
      const probe = join(path, readdirSync(path).find((name) => name.startsWith("probe-")) ?? "missing");
      if (fault === "missing") unlinkSync(probe);
      else writeFileSync(probe, fault === "changed" ? "x".repeat(32) : "x".repeat(4097));
    }
    return actual(...args);
  });
  expect(() => qualifyJournalRestart(path)).toThrowError(refused);
  expect(readdirSync(path)).toEqual([]);
});

it.each([1, 2])("refuses child failure at phase %s, keeps its cause and cleans probe files", (phase) => {
  const path = directory(), actual = child.spawnSync, cause = Object.assign(new Error("probe deadline"), { code: "ETIMEDOUT" });
  let calls = 0;
  vi.spyOn(child, "spawnSync").mockImplementation((...args: Parameters<typeof child.spawnSync>) => {
    if (++calls === phase) return { pid: 0, output: [], stdout: "", stderr: "", status: null, signal: "SIGTERM", error: cause };
    return actual(...args);
  });
  expect(() => qualifyJournalRestart(path)).toThrowError(expect.objectContaining({ code: "seller_replay_guard_invalid", status: 500, detail: "RESTART-NOT-QUALIFIED", cause }));
  expect(calls).toBe(phase);
  expect(readdirSync(path)).toEqual([]);
});

it("refuses a nonzero verifier exit and bounds both subprocesses", () => {
  const path = directory(), actual = child.spawnSync;
  let calls = 0;
  vi.spyOn(child, "spawnSync").mockImplementation((...args: Parameters<typeof child.spawnSync>) => {
    expect(args[2]).toMatchObject({ timeout: 5000, maxBuffer: 4096 });
    if (++calls === 2) return { pid: 0, output: [], stdout: "", stderr: "", status: 1, signal: null };
    return actual(...args);
  });
  expect(() => qualifyJournalRestart(path)).toThrowError(refused);
  expect(readdirSync(path)).toEqual([]);
});

it("refuses a filesystem that allows replacing a publication", () => {
  const path = directory(), actual = child.spawnSync;
  vi.spyOn(child, "spawnSync").mockImplementation((...args: Parameters<typeof child.spawnSync>) => {
    const argv = args[1];
    if (Array.isArray(argv) && argv[2] === "verify") {
      const modified = [...argv];
      modified[1] = `const faultyFs = require("node:fs"), originalLink = faultyFs.linkSync;
        faultyFs.linkSync = (from, to) => { faultyFs.writeFileSync(${JSON.stringify(join(path, "hook-called"))}, "yes"); if (faultyFs.existsSync(to)) faultyFs.unlinkSync(to); originalLink(from, to); };\n` + modified[1];
      return actual(args[0], modified, args[2]);
    }
    return actual(...args);
  });
  expect(() => qualifyJournalRestart(path)).toThrowError(refused);
  expect(fs.readFileSync(join(path, "hook-called"), "utf8")).toBe("yes");
  expect(readdirSync(path)).toEqual(["hook-called"]);
});


it("refuses replacement of the published pathname during the exclusive retry", () => {
  const path = directory(), actual = child.spawnSync;
  vi.spyOn(child, "spawnSync").mockImplementation((...args: Parameters<typeof child.spawnSync>) => {
    const argv = args[1];
    if (!Array.isArray(argv) || argv[2] !== "verify") return actual(...args);
    const modified = [...argv];
    modified[1] = `const faultyFs = require("node:fs"), originalLink = faultyFs.linkSync;
      faultyFs.linkSync = (from, to) => {
        faultyFs.writeFileSync(from + ".replace", "x".repeat(32));
        faultyFs.renameSync(from + ".replace", to);
        originalLink(from, to);
      };\n` + modified[1];
    return actual(args[0], modified, args[2]);
  });
  expect(() => qualifyJournalRestart(path)).toThrowError(refused);
  expect(readdirSync(path)).toEqual([]);
});

it("retains the actual child filesystem failure diagnostic", () => {
  const path = directory(), actual = child.spawnSync;
  vi.spyOn(child, "spawnSync").mockImplementation((...args: Parameters<typeof child.spawnSync>) => {
    const argv = args[1];
    if (Array.isArray(argv) && argv[2] === "verify") unlinkSync(String(argv[5]));
    return actual(...args);
  });
  expect(() => qualifyJournalRestart(path)).toThrowError(expect.objectContaining({
    ...{ code: "seller_replay_guard_invalid", detail: "RESTART-NOT-QUALIFIED" },
    cause: expect.objectContaining({ message: expect.stringContaining("ENOENT") }),
  }));
});

it.each([true, false])("attempts both cleanups and preserves primary failure when present (%s)", (primary) => {
  const path = directory(), actual = child.spawnSync;
  const cause = Object.assign(new Error("probe deadline"), { code: "ETIMEDOUT" });
  const cleanup = Object.assign(new Error("cleanup denied"), { code: "EACCES" });
  vi.spyOn(child, "spawnSync").mockImplementation((...args: Parameters<typeof child.spawnSync>) => {
    const argv = args[1];
    if (primary && Array.isArray(argv) && argv[2] === "verify") {
      return { pid: 0, output: [], stdout: "", stderr: "", status: null, signal: "SIGTERM", error: cause };
    }
    return actual(...args);
  });
  const remove = vi.spyOn(fs, "unlinkSync").mockImplementation(() => { throw cleanup; });
  expect(() => qualifyJournalRestart(path)).toThrowError(expect.objectContaining(primary
    ? { code: "seller_replay_guard_invalid", cause, cleanupErrors: [cleanup, cleanup] }
    : { code: "seller_replay_guard_invalid", cause: expect.any(AggregateError) }));
  expect(remove).toHaveBeenCalledTimes(2);
});
