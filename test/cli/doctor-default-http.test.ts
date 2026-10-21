import { beforeEach, describe, expect, test, vi } from "vitest";
import { VERIFIED_DEMOS_NODE_REVISION, runDoctor } from "../../src/cli/doctor.js";

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), connectWallet: vi.fn() }));
vi.mock("../../src/cli/demosHttp.js", () => ({ demosHttpClient: () => http }));
vi.mock("../../src/substrate/index.js", () => ({
  DemosAdapter: class {
    raw = { connectWallet: http.connectWallet, getAddress: () => "unused" };
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  http.post.mockImplementation(async (_url, body) => ({
    data: { result: 200, response: body.params[0].message === "getLastBlockNumber" ? 42 : {} },
  }));
});

describe("doctor default adapter matches demosdk's HTTP 200 connection contract", () => {
  test.each([201, 204])("rejects GET %s before wallet derivation or node calls", async (status) => {
    http.get.mockResolvedValue({ status });
    const report = await runDoctor({ rpc: "https://rpc.example", walletSecret: "unused" });
    expect(report.checks.find((c) => c.id === "rpc.reachable")).toMatchObject({
      status: "fail", detail: "Demos RPC connection requires HTTP 200",
    });
    expect(report.exitCode).toBe(3);
    expect(http.connectWallet).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
  });

  test("accepts GET 200 and probes the node", async () => {
    http.get.mockResolvedValue({ status: 200 });
    const report = await runDoctor({ rpc: "https://rpc.example" });
    expect(report.checks.find((c) => c.id === "rpc.reachable")?.status).toBe("pass");
    expect(http.post).toHaveBeenCalledTimes(2);
    for (const [index, message] of ["getLastBlockNumber", "getNetworkInfo"].entries()) {
      expect(http.post).toHaveBeenNthCalledWith(index + 1, "https://rpc.example", {
        method: "nodeCall",
        params: [{ type: "nodeCall", message, sender: null, receiver: null, timestamp: null, data: {}, extra: "" }],
      }, { headers: { "Content-Type": "application/json" }, signal: expect.any(AbortSignal) });
    }
  });
});

test.each([
  [503, 42],
  [400, "STATE_NOT_READY"],
])("reports a generic RPC failure for result=%s, response=%s", async (result, response) => {
  http.get.mockResolvedValue({ status: 200 });
  http.post.mockResolvedValue({ data: { result, response } });
  const report = await runDoctor({ rpc: "https://rpc.example" });
  expect(report.checks.find((c) => c.id === "rpc.reachable")).toMatchObject({
    status: "fail", summary: "RPC endpoint did not answer the Demos block-height call",
    detail: "Demos RPC returned an unsuccessful result",
    remediation: "Check that the RPC URL points at a reachable Demos node.",
  });
  expect(report.exitCode).toBe(3);
});

test("recognizes the exact loading envelope", async () => {
  http.get.mockResolvedValue({ status: 200 });
  http.post.mockResolvedValue({ data: { result: 503, response: "STATE_NOT_READY" } });
  const report = await runDoctor({ rpc: "https://rpc.example" });
  expect(report.checks.find((c) => c.id === "rpc.reachable")).toMatchObject({
    status: "fail", summary: "Demos node is not ready",
    detail: "getLastBlockNumber answered STATE_NOT_READY",
    remediation: "Wait for the Demos node to finish loading its state, then retry.",
  });
  expect(report.exitCode).toBe(3);
});


test.each([400, 503, "200", undefined])("rejects failed/malformed height result %s despite a plausible payload", async (result) => {
  http.get.mockResolvedValue({ status: 200 });
  http.post.mockResolvedValue({ data: { result, response: 42 } });
  const report = await runDoctor({ rpc: "https://rpc.example" });
  expect(report.checks.find((c) => c.id === "rpc.reachable")?.status).toBe("fail");
  expect(report.exitCode).toBe(3);
});

test("does not pass a failed revision envelope carrying the pinned build", async () => {
  http.get.mockResolvedValue({ status: 200 });
  http.post.mockImplementation(async (_url, body) => ({ data:
    body.params[0].message === "getLastBlockNumber" ? { result: 200, response: 42 } :
      { result: 400, response: { nodeVersion: { name: "demos-node-software", version: "0.9.8",
        commit: VERIFIED_DEMOS_NODE_REVISION, dirty: false } } },
  }));
  const report = await runDoctor({ rpc: "https://rpc.example" });
  expect(report.checks.find((c) => c.id === "rpc.node-revision")).toMatchObject({
    status: "warn", data: { reported: null },
  });
});
