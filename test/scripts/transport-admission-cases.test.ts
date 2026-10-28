import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { installBoundedNpmHttp, readBoundedResponse, responseBudget, NPM_METADATA_MAX_BYTES, NPM_TARBALL_MAX_BYTES } = require("../../scripts/bounded-npm-http.cjs");
const commandModule = "../../scripts/bounded-command.mjs";
const { runBoundedCommand } = await import(commandModule);
const buildModule = "../../scripts/bounded-build.mjs";
const { prepareBoundedBuild } = await import(buildModule);
const response = (bytes: Buffer, headers = {}, statusCode = 200) => Object.assign(Readable.from([bytes]), { headers, statusCode });
function admitted(path: string, bytes: Buffer, headers = {}, statusCode = 200) {
  const pending = Object.assign(new EventEmitter(), { path, destroy: () => {} });
  const transport = { request: () => pending };
  installBoundedNpmHttp({ transports: [transport], schedule: () => 0, cancel: () => {} });
  const result = new Promise<void>((resolve, reject) => {
    pending.once("error", reject); pending.once("response", () => resolve());
  });
  transport.request().emit("response", response(bytes, headers, statusCode));
  return result;
}

describe("metadata and archive admission boundaries", () => {
  it.each(["/fixture.tgz", "/fixture.tar.gz", "/@scope%2ffixture.tgz", "/@scope/fixture.tgz?view=full"])(
    "applies metadata budgets and JSON depth admission to %s", async path => {
      let value: unknown = {}; for (let i = 0; i < 130; i++) value = { child: value };
      await expect(admitted(path, Buffer.from(JSON.stringify(value)))).rejects.toThrow("ELIMIT");
      expect(responseBudget(path)).toBe(NPM_METADATA_MAX_BYTES);
    });
  it.each(["/fixture/-/fixture-1.tgz", "/@scope/fixture/-/fixture-1.tar.gz?download=1"])(
    "retains the archive budget at canonical tarball path %s", path => {
      expect(responseBudget(path)).toBe(NPM_TARBALL_MAX_BYTES);
    });
  it.each([200, 302, 503])("applies JSON admission to JSON replies at archive paths, status %s", async status => {
    let value: unknown = {}; for (let i = 0; i < 130; i++) value = { child: value };
    await expect(admitted("/fixture/-/fixture.tgz", Buffer.from(JSON.stringify(value)), {}, status)).rejects.toThrow("ELIMIT");
  });
  it.each([undefined, "gzip", "deflate", "br"])("refuses unsupported zstd archive compression after HTTP decoding %s", async encoding => {
    // An empty zstd frame; npm's tar reader recognizes these four magic bytes.
    const zstd = Buffer.from("28b52ffd2000010000", "hex");
    const bytes = encoding === "gzip" ? gzipSync(zstd) : encoding === "deflate" ? deflateSync(zstd) : encoding === "br" ? brotliCompressSync(zstd) : zstd;
    const headers = encoding ? { "content-encoding": encoding } : {};
    await expect(readBoundedResponse(response(bytes, headers), 1024, false, 4096)).rejects.toThrow("unsupported npm archive compression");
    await expect(admitted("/fixture/-/fixture.tgz", bytes, headers)).rejects.toThrow("unsupported npm archive compression");
  });
});

describe("command attempt process-group cleanup", () => {
  function harness() {
    const children: EventEmitter[] = [], timers: (() => void)[] = [], events: string[] = [];
    return { children, timers, events, options: {
      start: () => { events.push("start"); const child = Object.assign(new EventEmitter(), { pid: 100 + children.length }); children.push(child); return child; },
      schedule: (callback: () => void) => { timers.push(callback); return timers.length; }, cancel: () => {},
      kill: (pid: number, signal: string) => { events.push(`${pid}:${signal}`); }, diagnostic: () => {},
    } };
  }
  it.each([0, 7, null])("cleans remaining descendants before returning leader status %s", async code => {
    const h = harness(); const result = runBoundedCommand("fixture", [], h.options);
    h.children[0]?.emit("exit", code);
    expect(await result).toBe(code ?? 1);
    expect(h.events).toEqual(["start", "100:SIGKILL"]);
  });
  it("cleans the previous attempt before retrying and timing out its successor", async () => {
    const h = harness(); const result = runBoundedCommand("fixture", [], { ...h.options, attempts: 2 });
    h.children[0]?.emit("exit", 1);
    expect(h.events).toEqual(["start", "100:SIGKILL", "start"]);
    h.timers[0]?.(); h.children[1]?.emit("exit", null); h.timers[1]?.();
    expect(await result).toBe(124);
    expect(h.events).toEqual(["start", "100:SIGKILL", "start", "101:SIGTERM", "101:SIGKILL"]);
  });
  it("cleans a failed spawned attempt before reporting an error", async () => {
    const h = harness(); const result = runBoundedCommand("fixture", [], h.options);
    h.children[0]?.emit("error", Error("fixture failure"));
    expect(await result).toBe(1);
    expect(h.events).toEqual(["start", "100:SIGKILL"]);
  });
});

describe("generated build directory components", () => {
  it.each(["root", "slash", "dot", "ancestor", "hidden-parent"])("refuses a linked %s before reading or writing the project", kind => {
    const root = mkdtempSync(join(tmpdir(), "dacs-build-directories-"));
    try {
      const project = join(root, "actual", "project"); mkdirSync(project, { recursive: true });
      writeFileSync(join(project, "Dockerfile"), "FROM node:20 AS build\nRUN npm ci\n");
      writeFileSync(join(project, ".dockerignore"), "**\n");
      const alias = join(root, "alias"); symlinkSync((kind === "ancestor" || kind === "hidden-parent") ? join(root, "actual") : project, alias);
      const path = kind === "slash" ? alias + "/" : kind === "dot" ? alias + "/." :
        kind === "ancestor" ? alias + "/project" : kind === "hidden-parent" ? alias + "/../actual/project" : alias;
      expect(() => prepareBoundedBuild(path)).toThrow("not a directory (or a link to one)");
      expect(existsSync(join(project, "Dockerfile.acceptance"))).toBe(false);
      expect(existsSync(join(project, "acceptance-npm-http.cjs"))).toBe(false);
      expect(readFileSync(join(project, ".dockerignore"), "utf8")).toBe("**\n");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

it("keeps timeout status and cleanup grace when a child emits an error after the deadline", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 100 });
  const timers: (() => void)[] = [], kills: string[] = [];
  const result = runBoundedCommand("fixture", [], { start: () => child,
    schedule: (callback: () => void) => { timers.push(callback); return timers.length; }, cancel: () => {},
    kill: (_pid: number, signal: string) => { kills.push(signal); }, diagnostic: () => {} });
  timers[0]?.(); child.emit("error", Error("late child error")); timers[1]?.();
  expect(await result).toBe(124);
  expect(kills).toEqual(["SIGTERM", "SIGKILL"]);
});
