import { createRequire } from "node:module";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough, Readable } from "node:stream";
import { gzipSync } from "node:zlib";
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
  it.each(["gzip", "x-gzip", "deflate", "x-deflate", "br", "constructor", "__proto__", "zstd"])("refuses nonempty HTTP encoding %s under the identity contract", async encoding => {
    await expect(readBoundedResponse(response([Buffer.from("{}")], { "content-encoding": encoding }), 1024)).rejects.toThrow("unsupported npm HTTP content encoding");
  });
  it.each(["gzip", "x-gzip", "deflate", "x-deflate", "br"])("forwards an empty %s body without a decompression failure", async encoding => {
    // A redirect or empty reply may keep a compression header; npm accepts it.
    expect(await readBoundedResponse(response([], { "content-encoding": encoding }), 1024)).toHaveLength(0);
  });
  it.each([
    ["a HEAD request", 200, "HEAD"],
    ["a 204 response", 204, "GET"],
    ["a 304 response", 304, "GET"],
  ] as const)("forwards %s without decoding its empty body or rewriting its headers", async (_label, statusCode, method) => {
    const pending = Object.assign(new EventEmitter(), { setHeader: () => {}, path: "/pkg", method, destroy: () => {} });
    const transport = { request: () => pending };
    installBoundedNpmHttp({ transports: [transport], schedule: () => 0, cancel: () => {} });
    const original = Object.assign(response([], { "content-encoding": "gzip", "content-length": "123" }), { statusCode });
    const admitted = new Promise<unknown>((resolve, reject) => {
      pending.once("error", reject); pending.once("response", resolve);
    });
    transport.request().emit("response", original);
    expect(await admitted).toBe(original);
    expect(original.headers).toEqual({ "content-encoding": "gzip", "content-length": "123" });
  });
  it("keeps a 205 response subject to the byte budget because Node frames its body", async () => {
    const pending = Object.assign(new EventEmitter(), { setHeader: () => {}, path: "/pkg", method: "GET", destroy: () => {} });
    const transport = { request: () => pending };
    installBoundedNpmHttp({ transports: [transport], schedule: () => 0, cancel: () => {} });
    const original = Object.assign(response([], { "content-length": String(NPM_METADATA_MAX_BYTES + 1) }), { statusCode: 205 });
    const rejected = new Promise<Error>(resolve => pending.once("error", resolve));
    transport.request().emit("response", original);
    const error = await rejected;
    expect(error.message).toContain("ELIMIT");
    expect(error).toMatchObject({ code: "ELIMIT" });
  });
  it("bounds gzip archive expansion before npm's tar decoder receives it", async () => {
    const archive = gzipSync(Buffer.alloc(8));
    expect(await readBoundedResponse(response([archive]), 1024)).toEqual(archive);
    await expect(readBoundedResponse(response([gzipSync(Buffer.alloc(8192))]), 1024)).rejects.toThrow("ELIMIT");
  });
  it("admits a locked native archive expanding above 64 MiB with its exact compressed bytes", async () => {
    // The source lock's uws archive expands to 117.6 MB.
    const archive = gzipSync(Buffer.alloc(128 * 1024 * 1024));
    const pending = Object.assign(new EventEmitter(), { setHeader: () => {}, path: "/native/-/native.tgz", destroy: () => {} });
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

  it("admits a redirected archive that expands above the metadata budget at a suffixless URL", async () => {
    // A registry may redirect a tarball to a signed download URL without a
    // .tgz suffix. The gzip/tar payload, not the final path, is what npm's
    // archive reader consumes.
    const tar = Buffer.alloc(512 + 65 * 1024 * 1024);
    tar.write("ustar", 257, "latin1");
    const archive = gzipSync(tar);
    const pending = Object.assign(new EventEmitter(), { setHeader: () => {}, path: "/download/signed-token", destroy: () => {} });
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
  it("admits gzip consistently through a redirect chain to its suffixless target", async () => {
    // Every target has the same gzip expansion ceiling, without redirect memory.
    const targetPath = "/download/signed-token-intent";
    const paths = ["/fixture/-/fixture-1.0.0.tgz", "/download/hop", targetPath];
    const body = gzipSync(Buffer.alloc(65 * 1024 * 1024));
    let issued = 0;
    const transport = { request: () => Object.assign(new EventEmitter(), { setHeader: () => {}, path: paths[issued++], destroy: () => {} }) };
    installBoundedNpmHttp({ transports: [transport], schedule: () => 0, cancel: () => {} });
    const redirect = async (location: string) => {
      const pending = transport.request();
      const admitted = new Promise<void>((resolve, reject) => {
        pending.once("error", reject); pending.once("response", () => resolve());
      });
      pending.emit("response", Object.assign(response([], { location }), { statusCode: 302 }));
      await admitted;
    };
    await redirect("/download/hop");
    await redirect(targetPath);
    const target = transport.request();
    const admitted = new Promise<Buffer>((resolve, reject) => {
      target.once("error", reject);
      target.once("response", async (stream: Readable) => {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk);
        resolve(Buffer.concat(chunks));
      });
    });
    target.emit("response", Object.assign(response([body]), { statusCode: 200 }));
    expect(await admitted).toEqual(body);
  });
  it("gives gzip the same expansion ceiling at audit and suffixless routes", async () => {
    const archive = gzipSync(Buffer.alloc(17 * 1024 * 1024));
    for (const path of ["/download/signed-token", "/-/npm/v1/security/audits/quick"]) {
      const pending = Object.assign(new EventEmitter(), { setHeader: () => {}, path, destroy: () => {} });
      const transport = { request: () => pending };
      installBoundedNpmHttp({ transports: [transport], schedule: () => 0, cancel: () => {} });
      const admitted = new Promise<void>((resolve, reject) => { pending.once("error", reject); pending.once("response", () => resolve()); });
      transport.request().emit("response", response([archive])); await admitted;
    }
  });
  it("keeps separate finite wire and unpacked archive bounds", async () => {
    const archive = gzipSync(Buffer.alloc(2048));
    expect(await readBoundedResponse(response([archive]), 1024, false, 4096)).toEqual(archive);
    await expect(readBoundedResponse(response([gzipSync(Buffer.alloc(8192))]), 1024, false, 4096)).rejects.toThrow("ELIMIT");
    await expect(readBoundedResponse(response([Buffer.alloc(1025)]), 1024, false, 4096)).rejects.toThrow("ELIMIT");
  });
  it("admits full npm metadata with more than 1.24 million aggregate entries", async () => {
    // npm 10 requests the full npm packument for a global self-install. Its
    // observed 1,245,605 entries fit the finite decoded-byte budget.
    const metadata = Buffer.from(JSON.stringify({ name: "npm", versions: {
      "11.19.0": { name: "npm", version: "11.19.0", history: Array(1_245_600).fill(0) },
    } }));
    expect(metadata.length).toBeLessThan(NPM_METADATA_MAX_BYTES);
    expect((await readBoundedResponse(response([metadata]), NPM_METADATA_MAX_BYTES)).equals(metadata)).toBe(true);
  });
  it("lets the selected npm read a full self-install packument through the guard", async () => {
    const root = mkdtempSync(join(tmpdir(), "dacs-npm-packument-"));
    const metadata = JSON.stringify({ readme: "x".repeat(33 * 1024 * 1024), name: "npm", "dist-tags": { latest: "11.19.0" }, versions: {
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
  }, 20_000);
  it.each(["declared", "chunked"])("admits full npm metadata above 32 MiB via %s while retaining a finite ceiling", async kind => {
    const metadata = Buffer.from(JSON.stringify({ name: "npm", versions: {
      "11.19.0": { name: "npm", version: "11.19.0", history: Array(1_245_600).fill(0) },
    }, readme: "x".repeat(33 * 1024 * 1024) }));
    const bytes = metadata;
    const headers = kind === "declared" ? { "content-length": String(bytes.length) } : {};
    expect((await readBoundedResponse(response([bytes], headers), NPM_METADATA_MAX_BYTES)).equals(metadata)).toBe(true);
    expect(NPM_METADATA_MAX_BYTES).toBe(64 * 1024 * 1024);
    const overflow = Buffer.alloc(NPM_METADATA_MAX_BYTES + 1, 120);
    const excessive = overflow;
    const overflowHeaders = kind === "declared" ? { "content-length": String(excessive.length) } : {};
    await expect(readBoundedResponse(response([excessive], overflowHeaders), NPM_METADATA_MAX_BYTES)).rejects.toThrow("ELIMIT");
  });
  it("bounds decoded JSON list sizes", async () => {
    await expect(readBoundedResponse(response([Buffer.from(JSON.stringify(Array(NPM_JSON_MAX_ENTRIES + 1).fill(0)))], { "content-type": "application/json" }), NPM_METADATA_MAX_BYTES)).rejects.toThrow("ELIMIT");
  });
  it("terminates a stalled HTTP request at its explicit total deadline", () => {
    const pending = Object.assign(new EventEmitter(), { setHeader: () => {}, path: "/fixture", destroy: (error: Error) => pending.emit("error", error) });
    const transport = { request: () => pending };
    let deadline: (() => void) | undefined;
    installBoundedNpmHttp({ transports: [transport], schedule: (callback: () => void) => { deadline = callback; }, cancel: () => {} });
    const errors: Error[] = [];
    transport.request().on("error", error => errors.push(error)); pending.emit("socket", {}); deadline?.();
    expect(errors.map(error => error.message)).toEqual(["ETIMEDOUT npm HTTP deadline"]);
  });
  // Once its body has arrived a request is destroyed, so only admission is left to stop.
  const closedRequest = () => {
    const pending = Object.assign(new EventEmitter(), { setHeader: () => {}, path: "/a/-/a-1.0.0.tgz", method: "GET", destroyed: true, destroy: () => {} });
    const transport = { request: () => pending };
    let deadline: (() => void) | undefined;
    installBoundedNpmHttp({ transports: [transport], schedule: (callback: () => void) => { deadline = callback; }, cancel: () => {}, now: () => 0 });
    const errors: string[] = [], responses: number[] = [];
    transport.request().on("error", (error: NodeJS.ErrnoException) => errors.push(String(error.code)))
      .on("response", (admitted: { statusCode: number }) => responses.push(admitted.statusCode));
    pending.emit("socket", {});
    const body = Object.assign(new PassThrough(), { headers: {}, statusCode: 200 });
    pending.emit("response", body);
    return { pending, body, errors, responses, expire: () => deadline?.() };
  };
  const settled = () => new Promise(resolve => setTimeout(resolve, 50));
  it("fails admission that outlives a closed request at the deadline, exactly once", async () => {
    const { body, errors, responses, expire } = closedRequest();
    body.end(gzipSync(Buffer.alloc(1024)));
    expire(); expire();
    await settled();
    expect(errors).toEqual(["ETIMEDOUT"]);
    expect(responses).toEqual([]);
    expect(body.destroyed).toBe(true);
  });
  it.each(["error", "abort"])("stops admission when the request emits %s after its response starts", async event => {
    const { pending, body, errors, responses, expire } = closedRequest();
    body.write(gzipSync(Buffer.alloc(1024)).subarray(0, 16));
    if (event === "error") pending.emit("error", Object.assign(new Error("reset"), { code: "ECONNRESET" }));
    else pending.emit("abort");
    expect(body.destroyed).toBe(true);
    expire();
    await settled();
    // The request's own failure is the only error; the wrapper adds none.
    expect(errors).toEqual(event === "error" ? ["ECONNRESET"] : []);
    expect(responses).toEqual([]);
  });
  it.each(["before reading", "while decompressing", "after the body ends"])("rejects admission aborted %s with the abort reason", async stage => {
    const controller = new AbortController();
    const reason = Object.assign(new Error("ETIMEDOUT npm HTTP deadline"), { code: "ETIMEDOUT" });
    const body = Object.assign(new PassThrough(), { headers: {} });
    const archive = gzipSync(Buffer.alloc(4096));
    if (stage === "before reading") controller.abort(reason);
    const admitted = readBoundedResponse(body, NPM_TARBALL_MAX_BYTES, true, NPM_TARBALL_MAX_BYTES, controller.signal);
    if (stage === "while decompressing") body.write(archive.subarray(0, 16));
    if (stage === "after the body ends") body.end(archive);
    controller.abort(reason);
    await expect(admitted).rejects.toBe(reason);
  });
  it.each([true, false])("times out on schedule while the zlib worker is busy, keep-alive %s", keepAlive => {
    // One libuv worker, held by pbkdf2, queues decompression after the request has closed.
    const program = `const http = require("node:http"), { pbkdf2 } = require("node:crypto"), { gzipSync } = require("node:zlib");
      const { installBoundedNpmHttp } = require(${JSON.stringify(require.resolve("../../scripts/bounded-npm-http.cjs"))});
      installBoundedNpmHttp({ transports: [http], schedule: callback => setTimeout(callback, 100) });
      const archive = gzipSync(Buffer.alloc(1024));
      const server = http.createServer((_request, reply) => { reply.writeHead(200, { "content-length": archive.length }); reply.end(archive); });
      server.listen(0, "127.0.0.1", () => {
        const events = [], start = performance.now();
        let released;
        pbkdf2("fixture", "salt", 3_000_000, 64, "sha512", () => { released = performance.now() - start; });
        const agent = new http.Agent({ keepAlive: ${keepAlive} });
        http.get({ host: "127.0.0.1", port: server.address().port, path: "/a/-/a-1.0.0.tgz", agent }, () => events.push(["response"]))
          .on("error", error => events.push([error.code, performance.now() - start]));
        const report = () => released === undefined ? setTimeout(report, 50)
          : setTimeout(() => { console.log(JSON.stringify({ events, released })); agent.destroy(); server.close(); }, 100);
        report();
      });`;
    const result = spawnSync(process.execPath, ["-e", program], { encoding: "utf8", env: { ...process.env, UV_THREADPOOL_SIZE: "1" } });
    expect(result.stderr).toBe("");
    const { events, released } = JSON.parse(result.stdout) as { events: [string, number?][]; released: number };
    expect(events.map(([event]) => event)).toEqual(["ETIMEDOUT"]);
    expect(events[0]?.[1]).toBeLessThan(released);
  }, 30_000);
  it("delivers an oversized declared length to npm as one ELIMIT rejection", async () => {
    const root = mkdtempSync(join(tmpdir(), "dacs-npm-declared-"));
    const server = createServer((_request, reply) => {
      reply.writeHead(200, { "content-type": "application/json", "content-length": String(NPM_METADATA_MAX_BYTES + 1) });
      reply.end("{");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("missing test address");
      const child = spawn("npm", ["view", "fixture", "version", "--fetch-retries=0", "--fetch-timeout=5000", "--registry", `http://127.0.0.1:${address.port}`, "--cache", root], {
        env: { ...process.env, DACS_BOUNDED_NPM_HTTP: "1", NODE_OPTIONS: `--require=${resolve("scripts/bounded-npm-http.cjs")}` }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = ""; child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
      const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
      expect(code, output).not.toBe(0); expect(output).toContain("ELIMIT");
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
  }, 20_000);
  it.each([200, 503])("guards actual npm HTTP status %s before its readers", async status => {
    const root = mkdtempSync(join(tmpdir(), "dacs-npm-transport-"));
    const server = createServer((_request, reply) => {
      reply.writeHead(status, { "content-type": "application/json" });
      reply.end(JSON.stringify({ padding: "x".repeat(NPM_METADATA_MAX_BYTES) }));
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
  }, 20_000);
});

describe("total command deadline and retry budget", () => {
  function harness() {
    const children: EventEmitter[] = [], timers: (() => void)[] = [], kills: unknown[][] = [];
    const start = () => { const child = Object.assign(new EventEmitter(), { pid: children.length + 100 }); children.push(child); return child; };
    return { children, timers, kills, options: { start, schedule: (callback: () => void) => { timers.push(callback); return timers.length; },
      cancel: () => {}, kill: (...args: unknown[]) => { kills.push(args); }, diagnostic: () => {} } };
  }
  function signalHarness() {
    const h = harness();
    const signals = new Map<string, () => void>(), removed: string[] = [];
    return { ...h, signals, removed, options: { ...h.options,
      onSignal: (signal: string, handler: () => void) => { signals.set(signal, handler); },
      offSignal: (signal: string, handler: () => void) => { if (signals.get(signal) === handler) { signals.delete(signal); removed.push(signal); } },
      now: () => 0 } };
  }
  it.each([["SIGHUP", 129], ["SIGINT", 130], ["SIGQUIT", 131], ["SIGTERM", 143]] as const)("terminates the active group and stops retrying on %s", async (signal, code) => {
    const h = signalHarness(); const result = runBoundedCommand("docker", ["pull", "fixture"], { ...h.options, attempts: 3 });
    expect(h.signals.has(signal)).toBe(true); h.signals.get(signal)?.();
    expect(h.children).toHaveLength(1); expect(h.kills).toEqual([[100, "SIGTERM"]]);
    h.timers[1]?.(); expect(await result).toBe(code);
    expect(h.kills).toEqual([[100, "SIGTERM"], [100, "SIGKILL"]]);
    expect(h.removed.sort()).toEqual(["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"]);
  });
  it("removes termination handlers after a normal exit", async () => {
    const h = signalHarness(); const result = runBoundedCommand("npm", ["install"], h.options);
    h.children[0]?.emit("exit", 0); expect(await result).toBe(0);
    expect(h.signals.size).toBe(0); expect(h.removed.sort()).toEqual(["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"]);
  });
  it("releases the deadline and signal handlers when the command cannot start", async () => {
    const h = signalHarness(); const failure = new Error("invalid command");
    const result = runBoundedCommand(123, [], { ...h.options, start: () => { throw failure; } });
    await expect(result).rejects.toBe(failure);
    expect(h.signals.size).toBe(0);
    h.timers[0]?.();
    expect(h.kills).toEqual([]);
  });
  it("does not retry once the absolute deadline has passed", async () => {
    const h = signalHarness(); let clock = 0;
    const result = runBoundedCommand("docker", ["pull", "fixture"], { ...h.options, attempts: 3, seconds: 1, now: () => clock });
    clock = 1100; h.children[0]?.emit("exit", 1);
    expect(h.children).toHaveLength(1);
    h.timers[1]?.(); expect(await result).toBe(124);
    expect(h.kills).toEqual([[100, "SIGKILL"]]);
  });
  it.each([{ attempts: 1, code: 0 }, { attempts: 1, code: 7 }, { attempts: 3, code: 0 }, { attempts: 3, code: 7 }])(
    "reports the timeout when a final exit arrives after the deadline before the timer (attempts $attempts, code $code)",
    async ({ attempts, code }) => {
      const h = signalHarness(); let clock = 0;
      const result = runBoundedCommand("docker", ["pull", "fixture"], { ...h.options, attempts, seconds: 1, now: () => clock });
      clock = 1100; h.children[0]?.emit("exit", code);
      expect(h.children).toHaveLength(1);
      h.timers[1]?.(); expect(await result).toBe(124);
      expect(h.kills).toEqual([[100, "SIGKILL"]]);
    });
  function running(pid: number) {
    try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z"); } catch { return false; }
  }
  it.each([["SIGTERM", 143], ["SIGHUP", 129], ["SIGQUIT", 131]] as const)("stops a running command when the wrapper receives %s", async (signal, expectedCode) => {
    const wrapper = spawn(process.execPath, ["scripts/bounded-command.mjs", "30", "1", process.execPath, "-e", "console.log(process.pid);setInterval(()=>{},1000)"],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let output = "", commandPid = 0;
    wrapper.stderr.resume();
    wrapper.stdout.on("data", bytes => { output += bytes; });
    try {
      commandPid = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("command did not start: " + output)), 5000);
        wrapper.stdout.on("data", () => { const match = /^(\d+)/m.exec(output); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
        wrapper.on("error", reject);
      });
      expect(running(commandPid)).toBe(true);
      const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => wrapper.on("exit", (code, exitSignal) => resolve({ code, signal: exitSignal })));
      wrapper.kill(signal);
      expect(await Promise.race([exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("wrapper did not exit")), 5000))]))
        .toEqual({ code: expectedCode, signal: null });
      const stopped = Date.now() + 2000; while (running(commandPid) && Date.now() < stopped) await new Promise(resolve => setTimeout(resolve, 25));
      expect(running(commandPid)).toBe(false);
    } finally {
      if (commandPid) { try { process.kill(-commandPid, "SIGKILL"); } catch {} }
      try { wrapper.kill("SIGKILL"); } catch {}
    }
  }, 15_000);
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
const { prepareBoundedBuild, replaceFile } = await import(buildModule);
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
  it("inserts admission into a CRLF build stage instead of returning the source unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "dacs-bounded-build-crlf-"));
    try {
      const original = "FROM node:20 AS build\r\nRUN npm ci\r\n";
      writeFileSync(join(root, "Dockerfile"), original); writeFileSync(join(root, ".dockerignore"), "**\n");
      const built = readFileSync(prepareBoundedBuild(root), "utf8");
      expect(built).toContain("COPY acceptance-npm-http.cjs /acceptance-npm-http.cjs");
      expect(built.indexOf("NODE_OPTIONS=")).toBeLessThan(built.indexOf("RUN npm ci"));
      expect(readFileSync(join(root, "Dockerfile"), "utf8")).toBe(original);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("keeps the original file when a replacement write is interrupted", () => {
    const root = mkdtempSync(join(tmpdir(), "dacs-bounded-replace-"));
    try {
      const target = join(root, ".dockerignore");
      writeFileSync(target, "**\n");
      expect(() => replaceFile(target, "!acceptance-npm-http.cjs\n", {
        write: (temporary: string) => { writeFileSync(temporary, "truncated"); throw new Error("interrupted write"); },
        rename: () => { throw new Error("rename ran after a failed write"); },
      })).toThrow("interrupted write");
      expect(readFileSync(target, "utf8")).toBe("**\n");
      expect(existsSync(`${target}.${process.pid}.tmp`)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("flushes a replacement to durable storage before publishing it", () => {
    const root = mkdtempSync(join(tmpdir(), "dacs-bounded-flush-"));
    try {
      const target = join(root, ".dockerignore");
      writeFileSync(target, "**\n");
      let writeOptions: unknown;
      replaceFile(target, "!acceptance-npm-http.cjs\n", {
        write: (temporary: string, contents: string, options: unknown) => { writeFileSync(temporary, contents); writeOptions = options; },
        rename: (temporary: string, path: string) => renameSync(temporary, path),
      });
      expect(writeOptions).toEqual({ flush: true });
      expect(readFileSync(target, "utf8")).toBe("!acceptance-npm-http.cjs\n");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("does not duplicate the ignore exception when preparation repeats", () => {
    const root = mkdtempSync(join(tmpdir(), "dacs-bounded-repeat-"));
    try {
      writeFileSync(join(root, "Dockerfile"), "FROM node:20 AS build\nRUN npm ci\n");
      writeFileSync(join(root, ".dockerignore"), "**\n");
      prepareBoundedBuild(root);
      const once = readFileSync(join(root, ".dockerignore"), "utf8");
      prepareBoundedBuild(root);
      expect(readFileSync(join(root, ".dockerignore"), "utf8")).toBe(once);
      expect(once.match(/^!acceptance-npm-http\.cjs$/gm)).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("refuses an empty ignore file without publishing generated files", () => {
    const root = mkdtempSync(join(tmpdir(), "dacs-bounded-empty-"));
    try {
      writeFileSync(join(root, "Dockerfile"), "FROM node:20 AS build\nRUN npm ci\n");
      writeFileSync(join(root, ".dockerignore"), "");
      expect(() => prepareBoundedBuild(root)).toThrow("empty .dockerignore");
      expect(existsSync(join(root, "acceptance-npm-http.cjs"))).toBe(false);
      expect(existsSync(join(root, "Dockerfile.acceptance"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

it("sources transport budgets without executing the command CLI and preserves failure status", () => {
  const result = spawnSync("bash", ["--norc", "--noprofile", "-euc", "source scripts/bounded-transport.sh; run_bounded node -e 'console.log(process.env.DACS_BOUNDED_NPM_HTTP, process.env.npm_config_fetch_retries); process.exit(17)'"],
    { encoding: "utf8", env: { PATH: process.env.PATH } });
  expect(result.status, result.stderr).toBe(17); expect(result.stdout).toBe("1 2\n");
});
it("scopes npm admission to the bounded wrappers instead of the whole shell", () => {
  // A non-npm Node process the rehearsal runs later must not inherit npm's
  // budgets, decoders and deadlines through a global NODE_OPTIONS.
  const script = "source scripts/bounded-transport.sh; " +
    "printf 'shell:%s:%s\\n' \"${NODE_OPTIONS-}\" \"${DACS_BOUNDED_NPM_HTTP-}\"; " +
    "run_bounded node -e 'console.log(\"child:\" + process.env.DACS_BOUNDED_NPM_HTTP + \":\" + (process.env.NODE_OPTIONS || \"\"))'";
  const result = spawnSync("bash", ["--norc", "--noprofile", "-euc", script], { encoding: "utf8", env: { PATH: process.env.PATH } });
  expect(result.status, result.stderr).toBe(0);
  const lines = result.stdout.trim().split("\n");
  expect(lines[0]).toBe("shell::");
  expect(lines[1]).toMatch(/^child:1:.*--require=.*bounded-npm-http\.cjs/);
});
