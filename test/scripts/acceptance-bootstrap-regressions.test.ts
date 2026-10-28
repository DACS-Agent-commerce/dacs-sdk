import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { packTarball } from "./npm-archive-fixtures.js";
const modulePath = "../../scripts/acceptance-bootstrap.mjs";
const { bootstrapNpm, downloadArchive, NPM_BOOTSTRAP_ARTIFACT } = await import(modulePath);
const publisher = "../../scripts/publish-exact-local-registry.mjs";
const { PINNED_ACCEPTANCE_NPM_VERSION } = await import(publisher);
const execute = promisify(execFile);
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const root = () => { const directory = mkdtempSync(join(tmpdir(), "dacs-bootstrap-test-")); directories.push(directory); return directory; };
const digest = (bytes: Buffer) => createHash("sha512").update(bytes).digest("base64");
const archive = (version = "11.19.0") => packTarball({
  "package.json": JSON.stringify({ name: "npm", version: "11.19.0", bin: { npm: "bin/npm-cli.js" } }),
  "bin/npm-cli.js": `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)});\n`,
});
async function registry(body: Buffer, headers = {}, interrupted = false) {
  const requests: string[] = [];
  const server = createServer((request, reply) => {
    requests.push(request.url ?? "");
    if (request.url !== "/npm/-/npm-11.19.0.tgz") { reply.writeHead(403); reply.end("metadata forbidden"); return; }
    reply.writeHead(200, headers);
    if (interrupted) { reply.write(body.subarray(0, 10)); reply.socket?.destroy(); } else reply.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing registry address");
  return { requests, url: `http://127.0.0.1:${address.port}/npm/-/npm-11.19.0.tgz`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
describe("closed acceptance npm bootstrap", () => {
  it("pins a literal reviewed archive descriptor consistent with the publisher", () => {
    expect(NPM_BOOTSTRAP_ARTIFACT).toEqual({ version: PINNED_ACCEPTANCE_NPM_VERSION,
      url: "https://registry.npmjs.org/npm/-/npm-11.19.0.tgz",
      sha512: "SDd/hHg3KqHE5Ht2NHWxNYNtqCQ2pXAPLl6OtQhPyED5PHsRfrOtO199MZTIG2cQoQ1ZRI9t28shrD+2cr3AAw==" });
  });
  it("uses real runner npm offline without metadata or installation requests, then publishes the verified bin", async () => {
    const directory = root(), bytes = archive(), server = await registry(bytes), path = join(directory, "github-path");
    const commands: string[][] = [];
    try {
      const prefix = await bootstrapNpm({ directory, githubPath: path,
        descriptor: { ...NPM_BOOTSTRAP_ARTIFACT, url: server.url, sha512: digest(bytes) },
        execute: async (command: string, args: string[], options: object) => {
          commands.push([command, ...args]); expect(existsSync(path)).toBe(false);
          return execute(command, args, { ...options, env: { ...process.env,
            npm_config_cache: join(directory, "runner-cache"), npm_config_registry: server.url.split("/npm/")[0] } });
        } });
      expect(server.requests).toEqual(["/npm/-/npm-11.19.0.tgz"]);
      expect(commands[0]?.slice(1, -1)).toEqual(["install", "--offline", "--global", "--prefix", prefix,
        "--ignore-scripts", "--no-audit", "--no-fund", "--update-notifier=false"]);
      expect(commands[0]?.at(-1)).toMatch(/npm-11\.19\.0\.tgz$/);
      expect(commands[1]).toEqual([process.execPath, join(prefix, "lib/node_modules/npm/bin/npm-cli.js"), "--version"]);
      expect(readFileSync(path, "utf8")).toBe(join(prefix, "bin") + "\n");
      expect(existsSync(join(prefix, "lib/node_modules/npm/package.json"))).toBe(true);
    } finally { await server.close(); }
  });
  it.each(["digest", "install", "version", "interrupted", "descriptor"])("cleans partial state and keeps diagnostics without PATH after %s failure", async kind => {
    const directory = root(), bytes = archive(), server = await registry(bytes, {}, kind === "interrupted"), path = join(directory, "github-path");
    let installed = false;
    try {
      await expect(bootstrapNpm({ directory, githubPath: path,
        descriptor: { ...NPM_BOOTSTRAP_ARTIFACT, version: kind === "descriptor" ? "0.0.0" : "11.19.0",
          url: server.url, sha512: kind === "digest" ? "wrong" : digest(bytes) },
        execute: async (_command: string, args: string[]) => {
          if (args[0] === "install") { installed = true; if (kind === "install") throw Error("installation failed"); return { stdout: "installed", stderr: "" }; }
          return { stdout: kind === "version" ? "0.0.0\n" : "11.19.0\n", stderr: "" };
        } })).rejects.toThrow();
      expect(installed).toBe(kind === "install" || kind === "version");
      expect(existsSync(path)).toBe(false);
      for (const run of readdirSync(directory)) {
        expect(readdirSync(join(directory, run))).toEqual(["bootstrap.log"]);
        expect(readFileSync(join(directory, run, "bootstrap.log"), "utf8")).not.toBe("");
      }
    } finally { await server.close(); }
  });
  it.each(["install", "version"])("cleans a real offline npm %s failure without publishing PATH", async kind => {
    const directory = root(), bytes = kind === "install" ? Buffer.from("invalid archive") : archive("0.0.0");
    const server = await registry(bytes), path = join(directory, "github-path");
    try {
      await expect(bootstrapNpm({ directory, githubPath: path,
        descriptor: { ...NPM_BOOTSTRAP_ARTIFACT, url: server.url, sha512: digest(bytes) } })).rejects.toThrow();
      expect(existsSync(path)).toBe(false);
      expect(server.requests).toEqual(["/npm/-/npm-11.19.0.tgz"]);
      for (const run of readdirSync(directory)) expect(readdirSync(join(directory, run))).toEqual(["bootstrap.log"]);
    } finally { await server.close(); }
  });
  it.each(["declared", "chunked", "http-gzip", "archive-gzip"])("rejects oversized %s download before installation", async kind => {
    const directory = root();
    const size = kind === "archive-gzip" ? 256 * 1024 * 1024 + 1 : 64 * 1024 * 1024 + 1;
    const bytes = kind === "declared" ? Buffer.from("x") : kind.endsWith("gzip") ? gzipSync(Buffer.alloc(size)) : Buffer.alloc(size);
    const headers = kind === "declared" ? { "content-length": String(size) } : kind === "http-gzip" ? { "content-encoding": "gzip" } : {};
    const server = await registry(bytes, headers); let installed = false;
    try {
      await expect(bootstrapNpm({ directory, githubPath: join(directory, "path"), descriptor: { ...NPM_BOOTSTRAP_ARTIFACT, url: server.url },
        execute: async () => { installed = true; } })).rejects.toThrow("ELIMIT");
      expect(installed).toBe(false); expect(existsSync(join(directory, "path"))).toBe(false);
    } finally { await server.close(); }
  });
  it("ends stalled download at the inherited HTTP deadline", async () => {
    let deadline: (() => void) | undefined, milliseconds = 0;
    const pending = Object.assign(new EventEmitter(), { end: () => {}, destroy: (error: Error) => pending.emit("error", error) });
    const result = downloadArchive(NPM_BOOTSTRAP_ARTIFACT.url, { request: () => pending,
      schedule: (callback: () => void, ms: number) => { deadline = callback; milliseconds = ms; return 1; }, cancel: () => {} });
    deadline?.();
    await expect(result).rejects.toThrow("ETIMEDOUT"); expect(milliseconds).toBe(15_000);
  });
  it("wires bounded bootstrap/source install and independent reporting entrypoints", () => {
    const workflow = readFileSync(".github/workflows/registry-container-acceptance.yml", "utf8");
    expect(workflow).toContain("run_bounded node scripts/acceptance-bootstrap.mjs");
    expect(workflow).toContain("source scripts/bounded-transport.sh");
    expect(workflow).toContain("run_bounded npm ci --no-audit");
    expect(workflow).not.toContain("npm install --global");
    expect(workflow).not.toContain("before prerelease publication");
    expect(readFileSync("scripts/bounded-command.mjs", "utf8")).toContain("COMMAND_TIMEOUT_SECONDS = 900");
  });
});
