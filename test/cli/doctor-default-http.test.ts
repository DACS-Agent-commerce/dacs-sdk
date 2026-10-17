import { beforeEach, describe, expect, test, vi } from "vitest";
import { runDoctor } from "../../src/cli/doctor.js";

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
    data: { response: body.params[0].message === "getLastBlockNumber" ? 42 : {} },
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
    expect(http.post).toHaveBeenCalled();
  });
});
