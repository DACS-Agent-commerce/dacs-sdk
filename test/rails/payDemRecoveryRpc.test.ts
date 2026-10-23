import { afterEach, expect, it, vi } from "vitest";
import { payDemRecoveryRpc } from "../../src/rails/payDemRecoveryRpc.js";

afterEach(() => vi.unstubAllGlobals());
const rpc = "https://archive.test";

it("uses the Demos read-only wire envelope and refuses redirects", async () => {
  const fetchRpc = vi.fn(async () => new Response('{"result":200,"response":{"chainId":1}}'));
  vi.stubGlobal("fetch", fetchRpc);
  await expect(payDemRecoveryRpc(rpc, 100)("getNetworkInfo", {})).resolves.toEqual({ chainId: 1 });
  const [url, init] = fetchRpc.mock.calls[0] as unknown as Parameters<typeof fetch>;
  expect(url).toBe(rpc);
  expect(init).toMatchObject({ method: "POST", redirect: "error" });
  expect(new Headers(init!.headers).has("Authorization")).toBe(false);
  expect(JSON.parse(init!.body as string)).toEqual({ method: "nodeCall", params: [{ message: "getNetworkInfo", data: {} }] });
});

it.each([
  ["operator:fixture", "operator:fixture"],
  ["op%40example:p%3Aa%25ss%40word", "op@example:p:a%ss@word"],
  ["operator", "operator:"],
  [":fixture", ":fixture"],
  ["op%C3%A9rateur:p%C3%A4ss", "opérateur:päss"],
])("accepts URL userinfo %s using a credential-free Fetch request", async (userinfo, decoded) => {
  const fetchRpc = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    // Native Request applies the same credential-URL rejection as Node fetch.
    const request = new Request(input, init);
    expect(request.url).toBe("https://rpc.test/read%2Fonly?tenant=a%2Fb");
    expect(request.headers.get("Authorization")).toBe(`Basic ${Buffer.from(decoded, "utf8").toString("base64")}`);
    expect(request.redirect).toBe("error");
    expect(await request.json()).toEqual({ method: "nodeCall", params: [{ message: "getNetworkInfo", data: {} }] });
    return new Response('{"result":200,"response":{"chainId":1}}');
  });
  vi.stubGlobal("fetch", fetchRpc);
  await expect(payDemRecoveryRpc(`https://${userinfo}@rpc.test/read%2Fonly?tenant=a%2Fb`, 100)("getNetworkInfo", {}))
    .resolves.toEqual({ chainId: 1 });
  expect(fetchRpc).toHaveBeenCalledOnce();
});

it.each([true, false])("cancels an oversized reply before decoding JSON (declared length=%s)", async (declared) => {
  let pulls = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
    cancel,
  });
  vi.stubGlobal("fetch", async () => new Response(body, {
    headers: declared ? { "content-length": String(1024 * 1024 + 1) } : {},
  }));
  await expect(payDemRecoveryRpc(rpc, 100)("getTxByHash", { hash: "12".repeat(32) }))
    .rejects.toThrow(/byte limit/);
  expect(cancel).toHaveBeenCalledOnce();
  expect(pulls).toBeLessThanOrEqual(2);
});

it.each(["headers", "body"])("cancels a stalled %s read at its deadline", async (stage) => {
  const cancel = vi.fn();
  let signal: AbortSignal;
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    signal = init.signal!;
    return stage === "headers" ? new Promise(() => {}) : new Response(new ReadableStream({ cancel }));
  });
  await expect(payDemRecoveryRpc(rpc, 10)("getNetworkInfo", {})).rejects.toThrow(/getNetworkInfo read timed out/);
  expect(signal!.aborted).toBe(true);
  if (stage === "body") expect(cancel).toHaveBeenCalledOnce();
});

it("cancels a response delivered after the read timed out", async () => {
  let deliver!: (response: Response) => void;
  vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => { deliver = resolve; }));
  await expect(payDemRecoveryRpc(rpc, 10)("getNetworkInfo", {})).rejects.toThrow(/timed out/);
  const cancel = vi.fn();
  deliver(new Response(new ReadableStream({ cancel })));
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
});

it.each([
  [503, '{"result":200,"response":{}}', /HTTP 503/],
  [200, '{"result":404,"response":null}', /RPC refused with result 404/],
  [200, '{"result":200}', /invalid RPC envelope/],
  [200, 'not JSON', /JSON/],
] as const)("refuses HTTP/envelope/JSON errors (%i, %s)", async (status, body, error) => {
  vi.stubGlobal("fetch", async () => new Response(body, { status }));
  await expect(payDemRecoveryRpc(rpc, 100)("getNetworkInfo", {})).rejects.toThrow(error);
});

it("preserves a transport error as the cause observed by the caller", async () => {
  const cause = new Error("connection refused");
  vi.stubGlobal("fetch", async () => { throw cause; });
  await expect(payDemRecoveryRpc(rpc, 100)("getNetworkInfo", {})).rejects.toBe(cause);
});
