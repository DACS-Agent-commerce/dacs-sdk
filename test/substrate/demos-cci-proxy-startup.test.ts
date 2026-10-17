import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http, { createServer, type Server } from "node:http";
import https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEMOS_CCI_PROXY_BYPASS,
  DEMOS_CCI_ROUTE_UNVERIFIED,
  fetchProxyMismatch,
  type NodeRouteState,
} from "../../src/substrate/demosCciTransport.js";

// Each child starts with exactly the environment below, optionally builds an
// Agent of Node's own class whose connector tunnels through a proxy (the shape
// fetch-socks documents) and installs it as the global dispatcher or passes it
// from a wrapper that replaces global fetch, optionally loads a .env file at runtime as the
// generated live agent does, then sends one request with global fetch and one
// with axios (demosdk's transport) to a local target. It reports what the guard
// reads: the global dispatchers before and after fetch loads, each with the
// guard's own Node-default check run on the real object, the guard's check of
// the global fetch the read calls, whether Node gave its global agents a proxy
// configuration, execArgv and the environment. The
// parent's proxy and target record which route each request took.
const CHILD = `
const [rpc, checkModule, connectVia, connectMode, envFile] = process.argv.slice(1);
const { isNodeBuiltinFetch, isNodeDefaultAgent } = await import(checkModule);
const name = (value) => value === undefined ? null : value?.constructor?.name ?? "";
const describe = (value) => value === undefined ? null
  : { name: name(value), nodeDefault: isNodeDefaultAgent(value) };
const symbol = (n) => Symbol.for("undici.globalDispatcher." + n);
const dispatchers = () => ["2", "1"].map(n => describe(globalThis[symbol(n)]));
let before = dispatchers();
if (connectVia) {
  await fetch("data:,").catch(() => undefined);
  const NodeAgent = (globalThis[symbol("2")] ?? globalThis[symbol("1")]).constructor;
  const { connect: netConnect } = await import("node:net");
  const via = new URL(connectVia);
  const CRLF = String.fromCharCode(13, 10);
  const connect = (options, callback) => {
    const socket = netConnect(Number(via.port), via.hostname);
    const fail = (error) => callback(error, null);
    const target = options.hostname + ":" + options.port;
    socket.once("error", fail);
    socket.once("connect", () => socket.write("CONNECT " + target + " HTTP/1.1" + CRLF + "Host: " + target + CRLF + CRLF));
    socket.once("data", (chunk) => {
      socket.off("error", fail);
      if (String(chunk).startsWith("HTTP/1.1 200")) callback(null, socket);
      else callback(new Error("tunnel refused"), null);
    });
  };
  const agent = new NodeAgent({ connect });
  if (connectMode === "fetch") {
    const nodeFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => nodeFetch(input, { ...init, dispatcher: agent });
  } else {
    for (const n of ["2", "1"]) if (globalThis[symbol(n)] !== undefined) globalThis[symbol(n)] = agent;
  }
  // fetch had to load first, so the state before the read is the installed one.
  before = dispatchers();
}
if (envFile) process.loadEnvFile(envFile);
const builtinFetch = isNodeBuiltinFetch(globalThis.fetch);
const headers = (client) => ({ "content-type": "application/json", "x-probe": client });
await fetch(rpc, { method: "POST", headers: headers("fetch"), body: "{}", signal: AbortSignal.timeout(5000) })
  .then(response => response.text()).catch(() => undefined);
const { default: axios } = await import("axios");
await axios.post(rpc, {}, { headers: headers("axios"), timeout: 5000 }).catch(() => undefined);
const { default: http } = await import("node:http");
const { default: https } = await import("node:https");
const agents = [http.globalAgent, https.globalAgent]
  .map(agent => ({ name: name(agent), proxied: agent.options?.proxyEnv != null }));
const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (/^((https?|all|no)_proxy|NODE_USE_ENV_PROXY|NODE_OPTIONS)$/i.test(key)) env[key] = value;
}
console.log(JSON.stringify({ builtinFetch, before, after: dispatchers(), agents, execArgv: process.execArgv, env }));
`;

type Route = "proxy" | "direct";
type Dispatcher = { name: string; nodeDefault: boolean } | null;
interface ChildState {
  builtinFetch: boolean;
  before: Dispatcher[];
  after: Dispatcher[];
  agents: Array<{ name: string; proxied: boolean }>;
  execArgv: string[];
  env: Record<string, string>;
}

// An object whose constructor has the reported name, as the guard sees it.
const named = (kind: string | null) => kind === null ? undefined : new ({ [kind]: class {} })[kind]!();
// Where the child's real check found Node's default Agent, a stand-in of that
// shape; otherwise a stand-in with the reported name, which the check refuses.
class DispatcherBase {}
const nodeDefaultAgent = () => Object.assign(new ({ Agent: class extends DispatcherBase {} }).Agent(), {
  [Symbol("factory")]: new Function("return function defaultFactory (origin, opts) {\n" +
    "  return opts && opts.connections === 1 ? new Client(origin, opts) : new Pool(origin, opts)\n}")() as unknown,
  [Symbol("options")]: { connect: undefined },
});
// Where the child's real check found Node's own fetch, a stand-in with its source.
const nodeFetch = new Function("return function fetch(input, init = undefined) {\n" +
  "  if (!fetchImpl) {\n    const undiciModule = require('internal/deps/undici/undici');\n" +
  "    fetchImpl = undiciModule.fetch;\n  }\n  return fetchImpl(input, init);\n}")() as unknown;
const rebuilt = (dispatcher: Dispatcher) =>
  dispatcher?.nodeDefault === true ? nodeDefaultAgent() : named(dispatcher?.name ?? null);
const SWITCH_FLAG = process.allowedNodeEnvironmentFlags.has("--use-env-proxy");

describe("Demos CCI proxy route decided from Node's actual startup state", () => {
  const routes = new Map<string, Route[]>();
  const record = (probe: unknown, route: Route) => {
    const client = String(probe);
    routes.set(client, [...(routes.get(client) ?? []), route]);
  };
  const reply = (route: Route) => createServer((request, response) => {
    record(request.headers["x-probe"], route);
    request.resume().on("end", () => response.writeHead(200).end("{}"));
  });
  const target = reply("direct");
  const proxy = reply("proxy");
  // undici tunnels http:// requests with CONNECT before Node 26; answer inside the tunnel.
  const tunnel = reply("proxy");
  proxy.on("connect", (_request, socket: Socket, head: Buffer) => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) socket.unshift(head);
    tunnel.emit("connection", socket);
  });
  let rpc = "";
  let proxyUrl = "";
  let dir = "";
  let checkModule = "";

  const listen = (server: Server) => new Promise<number>(resolve => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });

  beforeAll(async () => {
    rpc = `http://127.0.0.1:${await listen(target)}/rpc`;
    proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
    dir = mkdtempSync(join(tmpdir(), "dacs-cci-proxy-"));
    // The guard's Node-default check, transpiled alone for the child to run.
    const source = readFileSync(new URL("../../src/substrate/nodeDefaultDispatcher.ts", import.meta.url), "utf8");
    checkModule = join(dir, "nodeDefaultDispatcher.mjs");
    writeFileSync(checkModule, ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText);
  });

  afterAll(async () => {
    for (const server of [target, proxy, tunnel]) server.closeAllConnections();
    await Promise.all([target, proxy].map(server => new Promise(resolve => server.close(resolve))));
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(startup: Record<string, string>, dotEnv?: Record<string, string>, flags: string[] = [],
    connectVia = "", connectMode: "dispatcher" | "fetch" = "dispatcher") {
    routes.clear();
    const args = [...flags, "--input-type=module", "-e", CHILD, rpc, checkModule, connectVia, connectMode];
    if (dotEnv !== undefined) {
      const file = join(dir, `${Object.keys(startup).join("-")}.env`);
      writeFileSync(file, Object.entries(dotEnv).map(([name, value]) => `${name}=${value}\n`).join(""));
      args.push(file);
    }
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", ...startup };
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk: Buffer) => { out += chunk; });
      child.stderr.on("data", (chunk: Buffer) => { err += chunk; });
      child.on("error", reject);
      child.on("close", code => (code === 0 ? resolve(out) : reject(new Error(`child exited ${code}: ${err}`))));
    });
    const child = JSON.parse(stdout.trim().split("\n").pop()!) as ChildState;
    const state = (dispatchers: Dispatcher[]): NodeRouteState => ({
      fetch: child.builtinFetch ? nodeFetch : () => undefined,
      dispatchers: [rebuilt(dispatchers[0]!), rebuilt(dispatchers[1]!)],
      agents: child.agents.map(({ name, proxied }, index) => {
        if (name !== "Agent") return named(name);
        const agent = new (index === 0 ? http.Agent : https.Agent)();
        if (proxied) Object.assign((agent as unknown as { options: object }).options, { proxyEnv: {} });
        return agent;
      }),
      execArgv: child.execArgv,
    });
    // The guard, given the child's final environment and the state its Node
    // left before and after fetch first loaded: both must decide alike.
    const mismatch = fetchProxyMismatch(rpc, child.env, state(child.after));
    expect(fetchProxyMismatch(rpc, child.env, state(child.before))).toBe(mismatch);
    const { NODE_USE_ENV_PROXY: _switch, NODE_OPTIONS: _options, ...withoutSwitch } = child.env;
    const fetchRoute = routes.get("fetch");
    const axiosRoute = routes.get("axios");
    // Allowed only where both clients really connected directly.
    if (mismatch === undefined) {
      expect(fetchRoute).toEqual(["direct"]);
      expect(axiosRoute).toEqual(["direct"]);
    }
    return {
      mismatch,
      // The decision from Node's state alone, without the switch's variables.
      fromState: fetchProxyMismatch(rpc, withoutSwitch, state(child.after)),
      httpsMismatch: fetchProxyMismatch("https://node.example.test/", child.env, state(child.after)),
      switchApplied: child.agents.some(agent => agent.proxied),
      // The real check on each dispatcher left under .2 and .1 (null if none).
      nodeDefault: child.after.map(dispatcher => dispatcher?.nodeDefault ?? null),
      builtinFetch: child.builtinFetch,
      fetchRoute: fetchRoute?.[0],
      axiosRoute: axiosRoute?.[0],
    };
  }

  it("allows a read with no proxy, where both clients connect directly", async () => {
    const result = await run({});
    expect(result).toMatchObject({ mismatch: undefined, fetchRoute: "direct", axiosRoute: "direct" });
    expect(result.httpsMismatch).toBeUndefined();
    // Node's real default Agent and Node's own fetch pass the checks: the Agent
    // under .1 on Node 20-22, under both symbols on 24, and under .2 (beside its
    // wrapper under .1) on 26.
    expect(result.nodeDefault).toContain(true);
    expect(result.builtinFetch).toBe(true);
  });

  it("refuses a replaced global fetch that tunnels through a proxy while Node's default dispatcher stays", async () => {
    const result = await run({}, undefined, [], proxyUrl, "fetch");
    expect(result).toMatchObject({ mismatch: DEMOS_CCI_ROUTE_UNVERIFIED, fetchRoute: "proxy", axiosRoute: "direct" });
    expect(result.nodeDefault).toContain(true);
    expect(result.builtinFetch).toBe(false);
  });

  it("refuses a global Agent whose connector tunnels through a proxy, as fetch-socks installs", async () => {
    const result = await run({}, undefined, [], proxyUrl);
    expect(result).toMatchObject({ mismatch: DEMOS_CCI_ROUTE_UNVERIFIED, fetchRoute: "proxy", axiosRoute: "direct" });
    expect(result.nodeDefault).not.toContain(true);
  });

  it.each([
    { kind: "HTTP_PROXY", startup: () => ({ HTTP_PROXY: proxyUrl }) },
    { kind: "ALL_PROXY", startup: () => ({ ALL_PROXY: proxyUrl }) },
  ])("refuses $kind without the switch: Axios proxies and fetch connects directly", async ({ startup }) => {
    const result = await run(startup());
    expect(result).toMatchObject({ mismatch: DEMOS_CCI_PROXY_BYPASS, fetchRoute: "direct", axiosRoute: "proxy" });
  });

  it("allows a direct read that Axios's loopback NO_PROXY rule also makes", async () => {
    const result = await run({ HTTP_PROXY: proxyUrl, NO_PROXY: "localhost" });
    expect(result).toMatchObject({ mismatch: undefined, fetchRoute: "direct", axiosRoute: "direct" });
  });

  // With the switch Node may proxy either client by rules that differ across
  // releases (and, for Axios, from a startup snapshot), so every read is
  // refused on every Node line. Where Node applied the switch (22.21+), its
  // state alone refuses, even with the switch's variables gone.
  it.each([
    { kind: "HTTP_PROXY", startup: () => ({ HTTP_PROXY: proxyUrl }) },
    { kind: "only HTTPS_PROXY", startup: () => ({ HTTPS_PROXY: proxyUrl }) },
    { kind: "ALL_PROXY", startup: () => ({ ALL_PROXY: proxyUrl }) },
    { kind: "no proxy at all", startup: () => ({}) },
    { kind: "a loopback NO_PROXY", startup: () => ({ HTTP_PROXY: proxyUrl, NO_PROXY: "localhost" }) },
    { kind: "a space-separated NO_PROXY", startup: () => ({ HTTP_PROXY: proxyUrl, NO_PROXY: "other.test 127.0.0.1" }) },
    { kind: "NO_PROXY loaded from .env", startup: () => ({ HTTP_PROXY: proxyUrl }), dotEnv: () => ({ NO_PROXY: "127.0.0.1" }) },
    { kind: "HTTP_PROXY loaded from .env", startup: () => ({}), dotEnv: () => ({ HTTP_PROXY: proxyUrl }) },
  ])("refuses with the switch and $kind", async ({ startup, dotEnv }) => {
    const result = await run({ ...startup(), NODE_USE_ENV_PROXY: "1" }, dotEnv?.());
    expect(result.mismatch).toBe(DEMOS_CCI_ROUTE_UNVERIFIED);
    expect(result.httpsMismatch).toBe(DEMOS_CCI_ROUTE_UNVERIFIED);
    if (result.switchApplied) expect(result.fromState).toBe(DEMOS_CCI_ROUTE_UNVERIFIED);
  });

  it("refuses with the switch loaded from .env after startup", async () => {
    const result = await run({ HTTP_PROXY: proxyUrl }, { NODE_USE_ENV_PROXY: "1" });
    expect(result).toMatchObject({ mismatch: DEMOS_CCI_ROUTE_UNVERIFIED, switchApplied: false });
    expect(result).toMatchObject({ fetchRoute: "direct", axiosRoute: "proxy" });
  });

  it.runIf(SWITCH_FLAG)("refuses with --use-env-proxy on the command line", async () => {
    const result = await run({ HTTPS_PROXY: proxyUrl, NO_PROXY: "127.0.0.1" }, undefined, ["--use-env-proxy"]);
    expect(result).toMatchObject({ mismatch: DEMOS_CCI_ROUTE_UNVERIFIED, switchApplied: true });
    expect(result.fromState).toBe(DEMOS_CCI_ROUTE_UNVERIFIED);
  });
});
