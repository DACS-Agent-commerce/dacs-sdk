import { createRequire } from "node:module";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { readBoundedResponse, NPM_METADATA_MAX_BYTES, NPM_AUDIT_MAX_BYTES, NPM_JSON_MAX_ENTRIES } = require("../../scripts/bounded-npm-http.cjs");
const response = (value: unknown, contentType?: string) => Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]),
  { headers: contentType ? { "content-type": contentType } : {} });
const finished = (child: ReturnType<typeof spawn>) => new Promise<{ code: number | null; output: string; error: string }>((resolve, reject) => {
  let output = "", error = ""; child.stdout?.on("data", bytes => { output += bytes; }); child.stderr?.on("data", bytes => { error += bytes; });
  child.on("error", reject); child.on("close", code => resolve({ code, output, error }));
});
describe("request-driven npm JSON limits", () => {
  it.each([undefined, "text/plain", "application/json"])("bounds lists and depth regardless of Content-Type %s", async header => {
    let deep: unknown = {}; for (let i = 0; i < 130; i++) deep = { child: deep };
    for (const maximum of [NPM_METADATA_MAX_BYTES, NPM_AUDIT_MAX_BYTES]) {
      for (const body of [Array(NPM_JSON_MAX_ENTRIES + 1).fill(0), deep]) await expect(readBoundedResponse(response(body, header), maximum)).rejects.toThrow("ELIMIT");
    }
  });
  it.each([undefined, "text/plain"])("delivers a successful large generator packument with Content-Type %s", async header => {
    const root = mkdtempSync(join(tmpdir(), "dacs-npm-success-"));
    const server = createServer((_request, reply) => {
      reply.writeHead(200, header ? { "content-type": header } : {});
      reply.end(JSON.stringify({ name: "fixture", "dist-tags": { latest: "1.2.3" }, versions: { "1.2.3": { name: "fixture", version: "1.2.3" } }, history: Array(600_000).fill(0), readme: "x".repeat(16 * 1024 * 1024) }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("missing test address");
      const result = await finished(spawn("npm", ["view", "fixture", "version", "--fetch-retries=0", "--registry", `http://127.0.0.1:${address.port}`, "--cache", root],
        { env: { ...process.env, DACS_BOUNDED_NPM_HTTP: "1", NODE_OPTIONS: `--require=${resolve("scripts/bounded-npm-http.cjs")}` }, stdio: ["ignore", "pipe", "pipe"] }));
      expect(result.code, result.error).toBe(0); expect(result.output.trim()).toBe("1.2.3");
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
  }, 20_000);
});
describe("bounded registry curl prerequisites", () => {
  it.each(["8.4.0", "8.3.0", "7.99.0", "malformed"])("propagates curl prerequisite result for %s even in a conditional source", version => {
    const result = spawnSync("bash", ["--norc", "--noprofile", "-euc", `curl() { printf '%s\\n' 'curl ${version} (fixture)'; }; if source scripts/bounded-http.sh; then printf '%s\\n' "\${http_json_curl[@]}"; else exit 17; fi`], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(version === "8.4.0" ? 0 : 17);
    if (version === "8.4.0") expect(result.stdout.trim().split("\n")).toEqual(["--disable", "--silent", "--show-error", "--fail", "--connect-timeout", "5", "--max-time", "15", "--max-filesize", "65536"]);
  });
  it("refuses a chunked response above 64 KiB through the actual curl options", async () => {
    const server = createServer((_request, reply) => { reply.writeHead(200); reply.write(Buffer.alloc(65536, 120)); reply.end("x"); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("missing test address");
      const result = await finished(spawn("bash", ["--norc", "--noprofile", "-euc", 'source scripts/bounded-http.sh; curl "${http_json_curl[@]}" "$1"', "fixture", `http://127.0.0.1:${address.port}`], { stdio: ["ignore", "pipe", "pipe"] }));
      expect(result.code, result.error).toBe(63); expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(65536);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
