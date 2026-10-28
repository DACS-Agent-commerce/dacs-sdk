import { createRequire } from "node:module";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { installBoundedNpmHttp, readBoundedResponse, responseBudget, NPM_METADATA_MAX_BYTES, NPM_TARBALL_MAX_BYTES, NPM_AUDIT_MAX_BYTES, NPM_JSON_MAX_ENTRIES } = require("../../scripts/bounded-npm-http.cjs");
const modulePath = "../../scripts/bounded-command.mjs";
const { runBoundedCommand } = await import(modulePath);
const response = (chunks: Buffer[], headers = {}) => Object.assign(Readable.from(chunks), { headers });

describe("inert bounded npm HTTP admission", () => {
  it("uses separate metadata, archive and audit budgets", () => {
    expect(responseBudget("/pkg")).toBe(NPM_METADATA_MAX_BYTES);
    expect(responseBudget("/pkg/-/pkg.tgz")).toBe(NPM_TARBALL_MAX_BYTES);
    expect(responseBudget("/-/npm/v1/security/audits/quick")).toBe(NPM_AUDIT_MAX_BYTES);
  });
  it("admits exact-limit responses and rejects streaming overflow without a length header", async () => {
    expect(await readBoundedResponse(response([Buffer.alloc(8)]), 8)).toHaveLength(8);
    await expect(readBoundedResponse(response([Buffer.alloc(8), Buffer.alloc(1)]), 8)).rejects.toThrow("ELIMIT");
  });
  it("refuses oversized declared responses before consuming bytes", async () => {
    const stream = response([], { "content-length": "9" });
    await expect(readBoundedResponse(stream, 8)).rejects.toThrow("ELIMIT");
  });
  it.each([gzipSync, deflateSync, brotliCompressSync])("bounds decompression before downstream JSON readers: %s", async compress => {
    const encoding = compress === gzipSync ? "gzip" : compress === deflateSync ? "deflate" : "br";
    await expect(readBoundedResponse(response([compress(Buffer.alloc(8192))], { "content-encoding": encoding }), 1024)).rejects.toThrow("ELIMIT");
  });
  it("bounds gzip archive expansion before npm's tar decoder receives it", async () => {
    const archive = gzipSync(Buffer.alloc(8));
    expect(await readBoundedResponse(response([archive]), 1024)).toEqual(archive);
    await expect(readBoundedResponse(response([gzipSync(Buffer.alloc(8192))]), 1024)).rejects.toThrow("ELIMIT");
  });
  it("admits a locked native archive expanding above 64 MiB with its exact compressed bytes", async () => {
    // The source lock's uws archive expands to 117.6 MB.
    const archive = gzipSync(Buffer.alloc(128 * 1024 * 1024));
    const pending = Object.assign(new EventEmitter(), { path: "/native/-/native.tgz", destroy: () => {} });
    const transport = { request: () => pending };
    installBoundedNpmHttp({ transports: [transport], schedule: () => 0, cancel: () => {} });
    const admitted = new Promise<Buffer>((resolve, reject) => {
      pending.once("error", reject);
      pending.once("response", async (stream: Readable) => {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk);
        resolve(Buffer.concat(chunks));
      });
    });
    transport.request().emit("response", response([archive]));
    expect(await admitted).toEqual(archive);
  });

  it("keeps separate finite wire and unpacked archive bounds", async () => {
    const archive = gzipSync(Buffer.alloc(2048));
    expect(await readBoundedResponse(response([archive]), 1024, false, 4096)).toEqual(archive);
    await expect(readBoundedResponse(response([gzipSync(Buffer.alloc(8192))]), 1024, false, 4096)).rejects.toThrow("ELIMIT");
    await expect(readBoundedResponse(response([Buffer.alloc(1025)]), 1024, false, 4096)).rejects.toThrow("ELIMIT");
  });
  it("admits full npm metadata with more than 1.24 million aggregate entries", async () => {
    // npm 10 requests the full npm packument for a global self-install. Its
    // observed 1,245,605 entries fit the 32 MiB decoded-byte budget.
    const metadata = Buffer.from(JSON.stringify({ name: "npm", versions: {
      "11.19.0": { name: "npm", version: "11.19.0", history: Array(1_245_600).fill(0) },
    } }));
    expect(metadata.length).toBeLessThan(NPM_METADATA_MAX_BYTES);
    expect((await readBoundedResponse(response([metadata]), NPM_METADATA_MAX_BYTES)).equals(metadata)).toBe(true);
  });
  it("lets the selected npm read a full self-install packument through the guard", async () => {
    const root = mkdtempSync(join(tmpdir(), "dacs-npm-packument-"));
    const metadata = JSON.stringify({ name: "npm", "dist-tags": { latest: "11.19.0" }, versions: {
      "11.19.0": { name: "npm", version: "11.19.0", history: Array(1_245_600).fill(0) },
    } });
    const server = createServer((_request, reply) => { reply.writeHead(200, { "content-type": "application/json" }); reply.end(metadata); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("missing test address");
      const child = spawn("npm", ["view", "npm@11.19.0", "version", "--json", "--fetch-retries=0", "--registry", `http://127.0.0.1:${address.port}`, "--cache", root], {
        env: { ...process.env, DACS_BOUNDED_NPM_HTTP: "1", NODE_OPTIONS: `--require=${resolve("scripts/bounded-npm-http.cjs")}` }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "", diagnostic = "";
      child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { diagnostic += bytes; });
      const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
      expect(code, diagnostic).toBe(0); expect(JSON.parse(output)).toBe("11.19.0");
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
  });
  it("bounds decoded JSON list sizes", async () => {
    await expect(readBoundedResponse(response([Buffer.from(JSON.stringify(Array(NPM_JSON_MAX_ENTRIES + 1).fill(0)))], { "content-type": "application/json" }), NPM_METADATA_MAX_BYTES)).rejects.toThrow("ELIMIT");
  });
  it("terminates a stalled HTTP request at its explicit total deadline", () => {
    const pending = Object.assign(new EventEmitter(), { path: "/fixture", destroy: (error: Error) => pending.emit("error", error) });
    const transport = { request: () => pending };
    let deadline: (() => void) | undefined;
    installBoundedNpmHttp({ transports: [transport], schedule: (callback: () => void) => { deadline = callback; }, cancel: () => {} });
    const errors: Error[] = [];
    transport.request().on("error", error => errors.push(error)); deadline?.();
    expect(errors.map(error => error.message)).toEqual(["ETIMEDOUT npm HTTP deadline"]);
  });
  it.each([200, 503])("guards actual npm HTTP status %s before its readers", async status => {
    const root = mkdtempSync(join(tmpdir(), "dacs-npm-transport-"));
    const server = createServer((_request, reply) => {
      reply.writeHead(status, { "content-type": "application/json", "content-encoding": "gzip" });
      reply.end(gzipSync(Buffer.from(JSON.stringify({ padding: "x".repeat(NPM_METADATA_MAX_BYTES) }))));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("missing test address");
      const child = spawn("npm", ["view", "fixture", "version", "--fetch-retries=0", "--fetch-timeout=15000", "--registry", `http://127.0.0.1:${address.port}`, "--cache", root], {
        env: { ...process.env, DACS_BOUNDED_NPM_HTTP: "1", NODE_OPTIONS: `--require=${resolve("scripts/bounded-npm-http.cjs")}` }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = ""; child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
      const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
      expect(code, output).not.toBe(0); expect(output).toContain("ELIMIT");
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
  });
});

describe("total command deadline and retry budget", () => {
  function harness() {
    const children: EventEmitter[] = [], timers: (() => void)[] = [], kills: unknown[][] = [];
    const start = () => { const child = Object.assign(new EventEmitter(), { pid: children.length + 100 }); children.push(child); return child; };
    return { children, timers, kills, options: { start, schedule: (callback: () => void) => { timers.push(callback); return timers.length; },
      cancel: () => {}, kill: (...args: unknown[]) => { kills.push(args); }, diagnostic: () => {} } };
  }
  it("kills a stalled Docker pull and its process group within the total deadline", async () => {
    const h = harness(); const result = runBoundedCommand("docker", ["pull", "fixture"], { ...h.options, seconds: 180, attempts: 3 });
    h.timers[0]?.(); h.children[0]?.emit("exit", null); h.timers[1]?.();
    expect(await result).toBe(124); expect(h.children).toHaveLength(1); expect(h.kills).toEqual([[100, "SIGTERM"], [100, "SIGKILL"]]);
  });
  it("shares one deadline across all retries", async () => {
    const h = harness(); const result = runBoundedCommand("docker", ["pull", "fixture"], { ...h.options, attempts: 3 });
    h.children[0]?.emit("exit", 1); h.children[1]?.emit("exit", 1); h.children[2]?.emit("exit", 7);
    expect(await result).toBe(7); expect(h.children).toHaveLength(3); expect(h.timers).toHaveLength(1);
  });
  it("stops retrying after success", async () => {
    const h = harness(); const result = runBoundedCommand("npm", ["install"], { ...h.options, attempts: 3 });
    h.children[0]?.emit("exit", 0); expect(await result).toBe(0); expect(h.children).toHaveLength(1);
  });
  it.each([0, 4, -1])("rejects retry budget %s", attempts => {
    expect(() => runBoundedCommand("docker", [], { attempts })).toThrow("retry budget");
  });
});

const buildModule = "../../scripts/bounded-build.mjs";
const { prepareBoundedBuild } = await import(buildModule);
describe("bounded generated build", () => {
  it("inserts admission into the build stage and keeps the generated source available for review", () => {
    const root = mkdtempSync(join(tmpdir(), "dacs-bounded-build-"));
    try {
      const original = "FROM node:20 AS build\nRUN npm ci\nFROM node:20\nCOPY --from=build /app /app\n";
      writeFileSync(join(root, "Dockerfile"), original); writeFileSync(join(root, ".dockerignore"), "**\n");
      const built = readFileSync(prepareBoundedBuild(root), "utf8");
      expect(built).toContain("COPY acceptance-npm-http.cjs /acceptance-npm-http.cjs");
      expect(built.indexOf("NODE_OPTIONS=")).toBeLessThan(built.indexOf("RUN npm ci"));
      expect(readFileSync(join(root, "Dockerfile"), "utf8")).toBe(original);
      expect(readFileSync(join(root, ".dockerignore"), "utf8")).toContain("!acceptance-npm-http.cjs");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

it("sources transport budgets without executing the command CLI and preserves failure status", () => {
  const result = spawnSync("bash", ["--norc", "--noprofile", "-euc", "source scripts/bounded-transport.sh; run_bounded node -e 'console.log(process.env.DACS_BOUNDED_NPM_HTTP, process.env.npm_config_fetch_retries); process.exit(17)'"],
    { encoding: "utf8", env: { PATH: process.env.PATH } });
  expect(result.status, result.stderr).toBe(17); expect(result.stdout).toBe("1 2\n");
});
