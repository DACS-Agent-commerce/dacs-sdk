import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEMOS_CCI_PROXY_ADDED,
  DEMOS_CCI_PROXY_BYPASS,
  fetchProxyMismatch,
} from "../../src/substrate/demosCciTransport.js";

// Each child starts with exactly the environment below, optionally loads a
// .env file at runtime as the generated live agent does, then reports the
// global dispatcher Node installed and sends one request with global fetch and
// one with axios (demosdk's transport) to a local target. The parent's proxy
// and target record which route each request took.
const CHILD = `
const [rpc, envFile] = process.argv.slice(1);
if (envFile) process.loadEnvFile(envFile);
const dispatcher = globalThis[Symbol.for("undici.globalDispatcher.1")]?.constructor?.name ?? null;
const env = {};
for (const [name, value] of Object.entries(process.env)) {
  if (/^(https?|all|no)_proxy$/i.test(name)) env[name] = value;
}
const headers = (client) => ({ "content-type": "application/json", "x-probe": client });
await fetch(rpc, { method: "POST", headers: headers("fetch"), body: "{}", signal: AbortSignal.timeout(5000) })
  .then(response => response.text()).catch(() => undefined);
const { default: axios } = await import("axios");
await axios.post(rpc, {}, { headers: headers("axios"), timeout: 5000 }).catch(() => undefined);
console.log(JSON.stringify({ dispatcher, env }));
`;

type Route = "proxy" | "direct";

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
  // undici tunnels even http:// requests with CONNECT; answer inside the tunnel.
  const tunnel = reply("proxy");
  proxy.on("connect", (_request, socket: Socket, head: Buffer) => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) socket.unshift(head);
    tunnel.emit("connection", socket);
  });
  let rpc = "";
  let proxyUrl = "";
  let dir = "";

  const listen = (server: Server) => new Promise<number>(resolve => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });

  beforeAll(async () => {
    rpc = `http://127.0.0.1:${await listen(target)}/rpc`;
    proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
    dir = mkdtempSync(join(tmpdir(), "dacs-cci-proxy-"));
  });

  afterAll(async () => {
    for (const server of [target, proxy, tunnel]) server.closeAllConnections();
    await Promise.all([target, proxy].map(server => new Promise(resolve => server.close(resolve))));
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(startup: Record<string, string>, dotEnv?: Record<string, string>) {
    routes.clear();
    const args = ["--input-type=module", "-e", CHILD, rpc];
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
    const { dispatcher, env: childEnv } = JSON.parse(stdout.trim().split("\n").pop()!) as {
      dispatcher: string | null; env: Record<string, string>;
    };
    // The guard, given the child's final environment and the dispatcher its
    // Node installed (an object whose constructor has that name).
    const installed = dispatcher === null ? undefined : new ({ [dispatcher]: class {} })[dispatcher]!();
    const mismatch = fetchProxyMismatch(rpc, childEnv, { dispatcher: installed });
    const fetchRoute = routes.get("fetch");
    const axiosRoute = routes.get("axios");
    expect(fetchRoute).toHaveLength(1);
    expect(axiosRoute).toHaveLength(1);
    // Never allow a route other than Axios's; a bypass refusal means a real one.
    if (mismatch === undefined) expect(fetchRoute).toEqual(axiosRoute);
    if (mismatch === DEMOS_CCI_PROXY_BYPASS) expect(fetchRoute).not.toEqual(axiosRoute);
    return { dispatcher, mismatch, fetchRoute: fetchRoute![0], axiosRoute: axiosRoute![0] };
  }

  it("refuses without the switch: Axios proxies and fetch connects directly", async () => {
    const result = await run({ HTTP_PROXY: proxyUrl });
    expect(result).toMatchObject({ mismatch: DEMOS_CCI_PROXY_BYPASS, fetchRoute: "direct", axiosRoute: "proxy" });
  });

  it("allows the switch only where Node installed its proxy agent (Node 22.21+)", async () => {
    const result = await run({ HTTP_PROXY: proxyUrl, NODE_USE_ENV_PROXY: "1" });
    expect(result.mismatch === undefined).toBe(result.dispatcher === "EnvHttpProxyAgent");
    expect(result.axiosRoute).toBe("proxy");
  });

  it.each([
    { kind: "ALL_PROXY, which Node's agent never reads", startup: () => ({ ALL_PROXY: proxyUrl, NODE_USE_ENV_PROXY: "1" }) },
    { kind: "the switch loaded from .env after startup", startup: () => ({ HTTP_PROXY: proxyUrl }),
      dotEnv: { NODE_USE_ENV_PROXY: "1" } },
    { kind: "HTTP_PROXY loaded from .env after startup", startup: () => ({ NODE_USE_ENV_PROXY: "1" }),
      dotEnv: () => ({ HTTP_PROXY: proxyUrl }) },
  ])("refuses with $kind: fetch would connect directly", async ({ startup, dotEnv }) => {
    const result = await run(startup(), typeof dotEnv === "function" ? dotEnv() : dotEnv);
    expect(result).toMatchObject({ mismatch: DEMOS_CCI_PROXY_BYPASS, fetchRoute: "direct", axiosRoute: "proxy" });
  });

  it("allows a direct read that Axios's loopback NO_PROXY rule also makes", async () => {
    const result = await run({ HTTP_PROXY: proxyUrl, NO_PROXY: "localhost" });
    expect(result).toMatchObject({ mismatch: undefined, fetchRoute: "direct", axiosRoute: "direct" });
  });

  // Node 22.21+ with the switch also proxies Axios's own direct connections
  // (http.globalAgent), without Axios's loopback rule. The guard does not model
  // that and refuses: it fails closed rather than allow an unproven route.
  it("fails closed where Node's agents proxy a loopback name that Axios alone would bypass", async () => {
    const result = await run({ HTTP_PROXY: proxyUrl, NO_PROXY: "localhost", NODE_USE_ENV_PROXY: "1" });
    const installed = result.dispatcher === "EnvHttpProxyAgent";
    expect(result).toMatchObject(installed
      ? { mismatch: DEMOS_CCI_PROXY_ADDED, fetchRoute: "proxy", axiosRoute: "proxy" }
      : { mismatch: undefined, fetchRoute: "direct", axiosRoute: "direct" });
  });
});
