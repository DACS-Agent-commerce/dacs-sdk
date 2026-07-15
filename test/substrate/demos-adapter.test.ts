import { describe, expect, it, vi } from "vitest";

// DemosAdapter lives on the substrate subpath, not the top-level barrel (the
// barrel stays demosdk-free for plain-Node-ESM consumers — #1/F1).
vi.mock("@kynesyslabs/demosdk/websdk", () => ({
  Demos: class MockDemos {},
}));
vi.mock("@kynesyslabs/demosdk/storage", () => ({
  StorageProgram: {},
}));
vi.mock("@kynesyslabs/demosdk/abstraction", () => ({
  Identities: class MockIdentities {},
}));

const RPC = "https://node2.demos.sh";

describe("DemosAdapter", () => {
  async function loadAdapter() {
    const { DemosAdapter } = await import("../../src/substrate/index.js");
    return DemosAdapter;
  }

  it("requires an rpc url", async () => {
    const DemosAdapter = await loadAdapter();
    // @ts-expect-error — exercising the runtime guard
    expect(() => new DemosAdapter({})).toThrow(/rpc/);
  });

  it("constructs and exposes the raw demosdk instance", async () => {
    const DemosAdapter = await loadAdapter();
    const adapter = new DemosAdapter({ rpc: RPC });
    expect(adapter.raw).toBeDefined();
  });

  it("getAddress throws before connect", async () => {
    const DemosAdapter = await loadAdapter();
    const adapter = new DemosAdapter({ rpc: RPC });
    expect(() => adapter.getAddress()).toThrow(/not connected/);
  });

  it("substrate ops require a connection", async () => {
    const DemosAdapter = await loadAdapter();
    const adapter = new DemosAdapter({ rpc: RPC });
    await expect(adapter.anchor("dacs:test", { a: 1 })).rejects.toThrow(
      /not connected/,
    );
    await expect(adapter.sign(new Uint8Array())).rejects.toThrow(
      /not connected/,
    );
    await expect(
      adapter.proxyFetch({ url: "https://example.com" }),
    ).rejects.toThrow(/not connected/);
    await expect(adapter.resolveIdentity("ref")).rejects.toThrow(
      /not connected/,
    );
    await expect(
      adapter.findSubjectsByClaim("web2:twitter:alice"),
    ).rejects.toThrow(/not connected/);
  });
});
