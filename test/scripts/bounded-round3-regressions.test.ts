import { createRequire } from "node:module";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { describe, expect, it, onTestFinished } from "vitest";
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
  it("refuses a JSON-shaped body whose appended root would skip the list limits", async () => {
    // npm's streaming reader accepts several concatenated JSON roots, so a
    // failed single-value parse must not silently skip admission.
    let deep: unknown = {}; for (let i = 0; i < 130; i++) deep = { child: deep };
    const bytes = Buffer.from(JSON.stringify({ name: "fixture" }) + "\n" + JSON.stringify(deep));
    await expect(readBoundedResponse(Object.assign(Readable.from([bytes]), { headers: { "content-type": "application/json" } }), NPM_METADATA_MAX_BYTES)).rejects.toThrow("ELIMIT");
  });
  it("still forwards a malformed non-JSON reply for npm's own diagnostics", async () => {
    const bytes = Buffer.from("<html>bad gateway</html>");
    expect(await readBoundedResponse(Object.assign(Readable.from([bytes]), { headers: { "content-type": "text/html" } }), 1024)).toEqual(bytes);
  });
  it.each([undefined, "text/plain"])("delivers a successful large generator packument with Content-Type %s", async header => {
    // When this case fails or is slow, print when each step happened, so a
    // timeout shows whether the wait was in npm, the server or this worker.
    // The hook also runs after a timeout, while the test body is still waiting.
    // It writes to stderr directly because the default reporter hides console
    // output from passing tests.
    const began = performance.now(), stamps = new Map<string, number>(); let exitStatus = "-";
    const stamp = (step: string) => { if (!stamps.has(step)) stamps.set(step, performance.now()); };
    onTestFinished(({ task }) => {
      const now = performance.now(); if (task.result?.state !== "fail" && now - began <= 5_000) return;
      const since = (time: number | undefined) => time === undefined ? "-" : String(Math.round(time - (stamps.get("spawned") ?? began)));
      const steps = ["request received", "body built", "body sent", "npm exited", "assertions done"].map(step => `${step} ${since(stamps.get(step))}`);
      process.stderr.write(`large packument case (Content-Type ${header}), ms since npm spawn: began ${since(began)}, ${steps.join(", ")}, exit ${exitStatus}, hook ${since(now)}\n`);
    });
    const root = mkdtempSync(join(tmpdir(), "dacs-npm-success-"));
    const server = createServer((_request, reply) => {
      stamp("request received");
      reply.writeHead(200, header ? { "content-type": header } : {});
      const body = JSON.stringify({ name: "fixture", "dist-tags": { latest: "1.2.3" }, versions: { "1.2.3": { name: "fixture", version: "1.2.3" } }, history: Array(600_000).fill(0), readme: "x".repeat(16 * 1024 * 1024) });
      stamp("body built"); reply.end(body, () => stamp("body sent"));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("missing test address");
      const child = spawn("npm", ["view", "fixture", "version", "--fetch-retries=0", "--registry", `http://127.0.0.1:${address.port}`, "--cache", root],
        { env: { ...process.env, DACS_BOUNDED_NPM_HTTP: "1", NODE_OPTIONS: `--require=${resolve("scripts/bounded-npm-http.cjs")}` }, stdio: ["ignore", "pipe", "pipe"] });
      stamp("spawned"); child.on("exit", (code, signal) => { exitStatus = String(code ?? signal); stamp("npm exited"); });
      const result = await finished(child);
      expect(result.code, result.error).toBe(0); expect(result.output.trim()).toBe("1.2.3"); stamp("assertions done");
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
