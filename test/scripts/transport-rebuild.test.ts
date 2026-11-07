import { createRequire } from "node:module";
import { Agent, createServer, request } from "node:http";
import { EventEmitter, once } from "node:events";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { readBoundedResponse, installBoundedNpmHttp, NPM_JSON_MAX_ENTRIES, NPM_TARBALL_MAX_UNPACKED_BYTES } = require("../../scripts/bounded-npm-http.cjs");
const response = (bytes: Buffer[], headers = {}) => Object.assign(Readable.from(bytes), { headers });
const read = (body: string) => readBoundedResponse(response([Buffer.from(body)]), 64 * 1024 * 1024);
const deep = "[".repeat(130) + "0" + "]".repeat(130);
const many = "[" + "0,".repeat(NPM_JSON_MAX_ENTRIES) + "0]";

describe("raw-token admission", () => {
  it.each(["0", '"prefix"', "true", "false", "null", "{}", "[]"])("counts depth and entries after root %s", async prefix => {
    for (const body of [deep, many]) await expect(read(prefix + "\n" + body)).rejects.toMatchObject({ code: "ELIMIT" });
  });
  it.each(['"objects"', '"obj\\u0065cts"'])("counts every duplicate member including %s", async key => {
    const half = "[" + "0,".repeat(1_000_000) + "0]";
    await expect(read('{"objects":' + half + "," + key + ":" + half + "}")).rejects.toMatchObject({ code: "ELIMIT" });
  });
  it("counts overwritten depth before the replacement member", async () => {
    await expect(read('{"a":' + deep + ',"a":0}')).rejects.toMatchObject({ code: "ELIMIT" });
  });
  it("preserves entry and depth boundaries across roots", async () => {
    expect(await read("[" + "0,".repeat(NPM_JSON_MAX_ENTRIES - 1) + "0]")).toBeInstanceOf(Buffer);
    await expect(read("[" + "0,".repeat(NPM_JSON_MAX_ENTRIES - 1) + "0]\n[0]")).rejects.toMatchObject({ code: "ELIMIT" });
    expect(await read("[".repeat(129) + "]".repeat(129))).toBeInstanceOf(Buffer);
    await expect(read("[".repeat(130) + "]".repeat(130))).rejects.toMatchObject({ code: "ELIMIT" });
  });
  it("carries strings and escaped delimiters over one-byte chunks", async () => {
    const bytes = Buffer.from(JSON.stringify({ 'a"\\': ['[,{', '\\"', "é"] }) + "\n{}");
    expect(await readBoundedResponse(response([...bytes].map(byte => Buffer.from([byte]))), 1024)).toEqual(bytes);
    await expect(readBoundedResponse(response([...Buffer.from(deep)].map(byte => Buffer.from([byte]))), 1024)).rejects.toMatchObject({ code: "ELIMIT" });
  });
  it("fails on an oversized valid prefix before reading its tail", async () => {
    let tailRead = false;
    async function* body() { yield Buffer.from(deep); tailRead = true; throw new Error("tail was read"); }
    await expect(readBoundedResponse(Object.assign(Readable.from(body(), { highWaterMark: 0 }), { headers: {} }), 1024)).rejects.toMatchObject({ code: "ELIMIT" });
    expect(tailRead).toBe(false);
  });
});

it("gives a real Agent's queued request its full socket deadline", async () => {
  const agent = new Agent({ maxSockets: 1 });
  const transport = { request, get: request };
  let clock = 0;
  const timers = new Map<number, { at: number; callback: () => void }>(); let next = 0;
  installBoundedNpmHttp({ transports: [transport], now: () => clock,
    schedule: (callback: () => void, ms: number) => { const id = ++next; timers.set(id, { at: clock + ms, callback }); return id; },
    cancel: (id: number) => timers.delete(id) });
  const server = createServer((_req, reply) => reply.end("{}"));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw Error("missing address");
  const options = { hostname: "127.0.0.1", port: address.port, agent };
  // Reserve the only socket without sending headers; no wall-clock sleep needed.
  const blocker = request(options); blocker.on("response", reply => reply.resume()); await once(blocker, "socket");
  const queued = transport.request(options);
  const completed = new Promise<Buffer>((resolve, reject) => { queued.on("error", reject); queued.on("response", async reply => {
    const chunks: Buffer[] = []; for await (const chunk of reply) chunks.push(chunk); resolve(Buffer.concat(chunks));
  }); });
  queued.end();
  try {
    clock = 16_000; for (const timer of [...timers.values()]) if (timer.at <= clock) timer.callback();
    blocker.end(); expect(await completed).toEqual(Buffer.from("{}")); expect(timers.size).toBe(0);
  } finally { blocker.destroy(); queued.destroy(); agent.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it.each(["headers", "body", "late-admission"])("bounds total time after socket assignment through %s", async phase => {
  const transport = { request, get: request }; let clock = 0; let expire: (() => void) | undefined;
  installBoundedNpmHttp({ transports: [transport], now: () => clock,
    schedule: (callback: () => void) => { expire = callback; return 1; }, cancel: () => {} });
  const server = createServer((_req, reply) => {
    if (phase === "headers") { clock = 16_000; expire?.(); }
    else if (phase === "body") { reply.write("{"); clock = 16_000; expire?.(); }
    else { clock = 16_000; reply.end("{}"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw Error("missing address");
  const pending = transport.request({ hostname: "127.0.0.1", port: address.port });
  const errors: Error[] = []; pending.on("error", error => errors.push(error));
  const rejected = once(pending, "error"); pending.end();
  try { expect((await rejected)[0]).toMatchObject({ code: "ETIMEDOUT" }); expect(errors).toHaveLength(1); }
  finally { pending.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("preserves real npm cache revalidation and requests identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "dacs-revalidation-"));
  const log = join(root, "requests.json");
  // A separate server process lets spawnSync run a real npm client.
  const serverCode = `const http=require('http'),fs=require('fs'); const seen=[];
    const s=http.createServer((req,res)=>{seen.push([req.headers['accept-encoding'],req.headers['if-none-match']]); fs.writeFileSync(process.argv[1],JSON.stringify(seen));
      if(req.headers['if-none-match']) {res.writeHead(304,{'content-encoding':'gzip',etag:'"fixture"'});res.end();}
      else {res.writeHead(200,{etag:'"fixture"','cache-control':'max-age=0','content-type':'application/json'});res.end(JSON.stringify({name:'fixture','dist-tags':{latest:'1.0.0'},versions:{'1.0.0':{name:'fixture',version:'1.0.0'}}}));}});
    s.listen(0,'127.0.0.1',()=>console.log(s.address().port));`;
  const { spawn } = await import("node:child_process");
  const server = spawn(process.execPath, ["-e", serverCode, log], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const [port] = await once(server.stdout, "data");
    for (let i = 0; i < 2; i++) {
      const result = spawnSync("npm", ["view", "fixture", "version", "--prefer-online", "--fetch-retries=0", "--registry", `http://127.0.0.1:${String(port).trim()}`, "--cache", root],
        { encoding: "utf8", env: { ...process.env, DACS_BOUNDED_NPM_HTTP: "1", NODE_OPTIONS: `--require=${resolve("scripts/bounded-npm-http.cjs")}` }, timeout: 15_000 });
      expect(result.status, result.stderr).toBe(0); expect(result.stdout.trim()).toBe("1.0.0");
    }
    const requests: [string, string | null][] = JSON.parse(readFileSync(log, "utf8"));
    expect(requests.every(([encoding]) => encoding === "identity")).toBe(true); expect(requests.some(([, etag]) => etag === '"fixture"')).toBe(true);
  } finally { server.kill(); await once(server, "exit"); rmSync(root, { recursive: true, force: true }); }
}, 40_000);

it("counts concatenated gzip members and preserves integrity at the expansion boundary", async () => {
  const tar = Buffer.alloc(1024); tar.write("ustar", 257);
  const archive = Buffer.concat([gzipSync(tar), gzipSync(Buffer.alloc(NPM_TARBALL_MAX_UNPACKED_BYTES - tar.length))]);
  const hash = (bytes: Buffer) => createHash("sha512").update(bytes).digest("hex");
  const chunks = [archive.subarray(0, 1), archive.subarray(1, 3), archive.subarray(3)];
  expect(hash(await readBoundedResponse(response(chunks), archive.length, false, NPM_TARBALL_MAX_UNPACKED_BYTES))).toBe(hash(archive));
  await expect(readBoundedResponse(response([...chunks, gzipSync(Buffer.alloc(1))]), archive.length + 100, false, NPM_TARBALL_MAX_UNPACKED_BYTES)).rejects.toMatchObject({ code: "ELIMIT" });
  await expect(readBoundedResponse(response([Buffer.from([0x1f, 0x8b, 0, 0])]), 1024)).rejects.toThrow();
}, 20_000);

it.each(["bounded-command.mjs", "bounded-build.mjs"])("executes %s through a symlinked directory and stays inert on import", name => {
  const root = mkdtempSync(join(tmpdir(), "dacs-cli-alias-"));
  try {
    const alias = join(root, "scripts"); symlinkSync(resolve("scripts"), alias);
    const path = join(alias, name), marker = join(root, "marker");
    const imported = spawnSync(process.execPath, ["--input-type=module", "-e", "const path = process.argv[1]; process.argv[1] = process.execPath; await import(path)", path, "5", "1", "touch", marker], { encoding: "utf8" });
    expect(imported.status, imported.stderr).toBe(0); expect(existsSync(marker)).toBe(false);
    if (name === "bounded-command.mjs") {
      expect(spawnSync(process.execPath, [path, "5", "1", "false"]).status).toBe(1);
      expect(spawnSync(process.execPath, [path, "5", "1", "touch", marker]).status).toBe(0); expect(existsSync(marker)).toBe(true);
    } else {
      writeFileSync(join(root, "Dockerfile"), "FROM node:20 AS build\nRUN npm ci\n"); writeFileSync(join(root, ".dockerignore"), "**\n");
      expect(spawnSync(process.execPath, [path, root]).status).toBe(0); expect(existsSync(join(root, "Dockerfile.acceptance"))).toBe(true);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each(["admitted", "bodyless", "error", "abort", "close", "limit"])("clears the socket timer on %s with one terminal result", async kind => {
  const pending = Object.assign(new EventEmitter(), { path: "/fixture", setHeader: () => {}, destroy: () => {} });
  const transport = { request: () => pending }; const cancelled: number[] = [];
  let scheduled = 0;
  installBoundedNpmHttp({ transports: [transport], schedule: () => ++scheduled, cancel: (id: number) => cancelled.push(id) });
  const errors: Error[] = []; pending.on("error", error => errors.push(error));
  transport.request(); expect(scheduled).toBe(0); pending.emit("socket", {});
  if (["error", "abort", "close"].includes(kind)) pending.emit(kind, new Error("connection failed"));
  else {
    const completed = new Promise<void>(resolve => { pending.once("response", () => resolve()); pending.once("error", () => resolve()); });
    pending.emit("response", Object.assign(response([Buffer.from(kind === "limit" ? deep : "{}")]), { statusCode: kind === "bodyless" ? 304 : 200 }));
    await completed;
  }
  expect(cancelled).toEqual([1]); expect(errors).toHaveLength(kind === "error" || kind === "limit" ? 1 : 0);
});

it("prepares the same build concurrently and after a completed preparation", async () => {
  const root = mkdtempSync(join(tmpdir(), "dacs-build-concurrent-"));
  const { spawn } = await import("node:child_process");
  try {
    writeFileSync(join(root, "Dockerfile"), "FROM node:20 AS build\nRUN npm ci\n"); writeFileSync(join(root, ".dockerignore"), "**\n");
    const prepare = () => { const child = spawn(process.execPath, ["scripts/bounded-build.mjs", root], { stdio: "ignore" }); return once(child, "exit"); };
    expect(await Promise.all([prepare(), prepare()])).toEqual([[0, null], [0, null]]);
    const first = readFileSync(join(root, "Dockerfile.acceptance")); expect(await prepare()).toEqual([0, null]);
    expect(readFileSync(join(root, "Dockerfile.acceptance"))).toEqual(first);
    expect(readFileSync(join(root, ".dockerignore"), "utf8").match(/^!acceptance-npm-http.cjs$/gm)).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each(["/fixture.tgz", "/@scope/fixture", "/fixture/-/fixture.tgz", "/download/suffixless"])("checks raw tokens at %s across origins, errors and redirects", async path => {
  for (const origin of ["first.invalid", "second.invalid"]) for (const statusCode of [200, 302, 503]) {
    const pending = Object.assign(new EventEmitter(), { path, host: origin, setHeader: () => {}, destroy: () => {} });
    const transport = { request: () => pending }; installBoundedNpmHttp({ transports: [transport], schedule: () => 0, cancel: () => {} });
    const rejected = once(pending, "error"); transport.request().emit("response", Object.assign(response([Buffer.from('0\n' + deep)]), { statusCode }));
    expect((await rejected)[0]).toMatchObject({ code: "ELIMIT" });
  }
});
it("keeps HTML error status and original headers with admitted bytes", async () => {
  const pending = Object.assign(new EventEmitter(), { path: "/missing", setHeader: () => {}, destroy: () => {} });
  const transport = { request: () => pending }; installBoundedNpmHttp({ transports: [transport], schedule: () => 0, cancel: () => {} });
  const original = Object.assign(response([Buffer.from("<html>not found</html>")], { "content-type": "text/html" }), { statusCode: 404, rawHeaders: ["Content-Type", "text/html"] });
  const accepted = once(pending, "response"); transport.request().emit("response", original);
  const [reply] = await accepted; expect(reply.statusCode).toBe(404); expect(reply.headers).toBe(original.headers); expect(reply.rawHeaders).toBe(original.rawHeaders);
});
