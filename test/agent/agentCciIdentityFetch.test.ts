// createAgent() behind an environment proxy: demosdk's Axios connects through a
// real local forward proxy, and the CCI read goes through AgentConfig.identityFetch.
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgent, createUnsafeManualAgent, type AgentConfig } from "../../src/agent/Agent.js";
import { DacsError } from "../../src/errors.js";
import {
  DEMOS_CCI_PROXY_BYPASS,
  DEMOS_CCI_ROUTE_UNVERIFIED,
} from "../../src/substrate/demosCciTransport.js";

const GCR = { result: 200, response: { xm: {}, web2: { github: [{ username: "alice", userId: "1" }] }, ud: [], pqc: {} } };
const SUBJECT = `0x${"ab".repeat(32)}`;
const servers: Server[] = [];
const listen = (server: Server) => new Promise<number>((resolve) => {
  servers.push(server);
  server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

// A Demos node that answers demosdk's connect and the GCR read, and a forward
// proxy in front of it; `seen` records which server each request reached.
async function nodeBehindProxy() {
  const seen: string[] = [];
  const node = createServer((req, res) => {
    seen.push(`node ${req.method}`);
    req.resume().on("end", () => res.writeHead(200, { "content-type": "application/json" })
      .end(req.method === "GET" ? "{}" : JSON.stringify(GCR)));
  });
  const proxy = createServer((req, res) => {
    seen.push(`proxy ${req.method}`);
    const upstream = request(req.url!, { method: req.method, headers: req.headers }, (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(res);
    });
    req.pipe(upstream);
  });
  const rpc = `http://127.0.0.1:${await listen(node)}/`;
  const proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
  for (const name of ["http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
    vi.stubEnv(name, undefined);
    vi.stubEnv(name.toUpperCase(), undefined);
  }
  vi.stubEnv("HTTP_PROXY", proxyUrl);
  return { seen, rpc };
}

describe("AgentConfig.identityFetch", () => {
  it("routes createAgent's CCI reads through the injected fetch behind a proxy", async () => {
    const { rpc, seen } = await nodeBehindProxy();
    // Answers itself, so the route is the one this fetch chose whatever Node's
    // global dispatcher is (a run started with Node's proxy switch included).
    const identityFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(GCR)));
    const agent = await createAgent({ demosRpc: rpc, identityFetch });
    const resolved = await agent.resolveIdentity(SUBJECT);

    expect(resolved).toBeDefined();
    expect(identityFetch).toHaveBeenCalledOnce();
    expect(identityFetch.mock.calls[0]?.[0]).toBe(rpc);
    expect(identityFetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST", redirect: "manual" });
    // demosdk connected (through the proxy); no read reached the node any other way.
    expect(seen).toContain("node GET");
    expect(seen).not.toContain("node POST");
  });

  it("without it, refuses the read before sending where the routes may differ", async () => {
    const { rpc, seen } = await nodeBehindProxy();
    const agent = await createAgent({ demosRpc: rpc });
    const error = await agent.resolveIdentity(SUBJECT).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DacsError);
    // BYPASS, or UNVERIFIED when this run was started with Node's proxy switch.
    expect([DEMOS_CCI_PROXY_BYPASS, DEMOS_CCI_ROUTE_UNVERIFIED]).toContain((error as Error).message);
    expect(seen).not.toContain("node POST");
  });

  it.each([
    ["a non-function", 1],
    ["a Proxy of fetch", new Proxy(fetch, {})],
  // Port 9 refuses connections, so only a check before connecting gives this error.
  ])("rejects %s before connecting", async (_kind, identityFetch) => {
    const error = await createAgent({ demosRpc: "http://127.0.0.1:9/", identityFetch } as unknown as AgentConfig)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DacsError);
    expect(error).toMatchObject({ message: "AgentConfig.identityFetch must be a stable function when supplied" });
  });

  it("rejects an accessor identityFetch before connecting", async () => {
    const get = vi.fn(() => fetch);
    const config = Object.defineProperty({ demosRpc: "http://127.0.0.1:9/" }, "identityFetch", { get, enumerable: true });
    const error = await createAgent(config as AgentConfig).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DacsError);
    expect(error).toMatchObject({ message: "AgentConfig.identityFetch must be stable data" });
    expect(get).not.toHaveBeenCalled();
  });

  it("passes demosWriteJournal and identityFetch to the Demos adapter it connects", async () => {
    const { rpc } = await nodeBehindProxy();
    const demosWriteJournal = { acquire: vi.fn() } as unknown as NonNullable<AgentConfig["demosWriteJournal"]>;
    const identityFetch = vi.fn<typeof fetch>();
    const agent = await createUnsafeManualAgent({ demosRpc: rpc, demosWriteJournal, identityFetch });
    const { config } = agent.adapter as unknown as { config: Record<string, unknown> };
    expect(config).toMatchObject({ rpc, writeJournal: demosWriteJournal, identityFetch });
  });
});
