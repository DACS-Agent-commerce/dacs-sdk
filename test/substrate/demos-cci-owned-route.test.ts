import http from "node:http";
import https from "node:https";
import { Agent } from "undici";
import { afterEach, expect, it, vi } from "vitest";
import { defaultCciTransport, fetchProxyMismatch, readDemosCciResponse } from "../../src/substrate/demosCciTransport.js";

// Mock only the package's send boundary. Lazy private Agent construction and
// route selection still run; neither copied global closure may receive a read.
const send = vi.hoisted(() => vi.fn());
vi.mock("undici", async importOriginal => ({
  ...await importOriginal<typeof import("undici")>(), fetch: send,
}));

const nativeFetchSource = Function.prototype.toString.call(globalThis.fetch);
const globals = globalThis as Record<symbol, unknown>;
const symbols = [Symbol.for("undici.globalDispatcher.2"), Symbol.for("undici.globalDispatcher.1")];
const restores: Array<() => void> = [];
const GCR = { result: 200, response: { xm: {}, web2: {}, ud: [], pqc: {} } };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  send.mockReset();
  for (const restore of restores.splice(0).reverse()) restore();
});

it.each([false, true])("keeps copied-source Fetch and Agent closures off the route (swap during headers: %s)", async swap => {
  for (const key of ["http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
    vi.stubEnv(key, undefined);
    vi.stubEnv(key.toUpperCase(), undefined);
  }
  vi.stubEnv("NODE_USE_ENV_PROXY", undefined);
  vi.stubEnv("NODE_OPTIONS", undefined);
  const previous = [http.globalAgent, https.globalAgent, process.execArgv] as const;
  http.globalAgent = new http.Agent();
  https.globalAgent = new https.Agent();
  process.execArgv = [];
  restores.push(() => {
    [http.globalAgent, https.globalAgent, process.execArgv] = previous;
  });
  const construct = vi.fn();
  const factory = new Function("Client", "Pool", `return function defaultFactory (origin, opts) {
    return opts && opts.connections === 1 ? new Client(origin, opts) : new Pool(origin, opts)
  }`)(construct, construct);
  const customAgent = new Agent({ factory });
  symbols.forEach((symbol, index) => {
    const had = Object.hasOwn(globals, symbol);
    const original = globals[symbol];
    globals[symbol] = index === 0 ? undefined : customAgent;
    restores.push(() => { if (had) globals[symbol] = original; else delete globals[symbol]; });
  });
  const copiedSend = vi.fn();
  vi.stubGlobal("fetch", new Function("fetchImpl", `return ${nativeFetchSource}`)(copiedSend));
  const rpc = "https://node.example/rpc";
  expect(fetchProxyMismatch(rpc)).toBeUndefined();
  const transport = defaultCciTransport(rpc);
  const lateSend = vi.fn();
  const headers = vi.fn(async () => {
    if (swap) {
      vi.stubGlobal("fetch", lateSend);
      symbols.forEach(symbol => { globals[symbol] = customAgent; });
    }
    return { identity: "ed25519:", signature: "", timestamp: "" };
  });
  send.mockResolvedValueOnce(new Response(JSON.stringify(GCR)));
  try {
    await expect(readDemosCciResponse(rpc, "subject", headers, transport, 1024, 5000, 12000))
      .resolves.toEqual(GCR);
    expect(headers).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toBe(rpc);
    const init = send.mock.calls[0]?.[1];
    expect(init).toMatchObject({ method: "POST", redirect: "manual",
      headers: { identity: "ed25519:", signature: "", timestamp: "" } });
    expect(init.dispatcher).toBeInstanceOf(Agent);
    expect(init.dispatcher).not.toBe(customAgent);
    expect(construct).not.toHaveBeenCalled();
    expect(copiedSend).not.toHaveBeenCalled();
    expect(lateSend).not.toHaveBeenCalled();
  } finally {
    await customAgent.destroy();
  }
});
