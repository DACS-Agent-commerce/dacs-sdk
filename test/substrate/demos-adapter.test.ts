import { describe, expect, it } from "vitest";

import { DemosAdapter } from "../../src/index.js";

const RPC = "https://node2.demos.sh";

describe("DemosAdapter", () => {
  it("requires an rpc url", () => {
    // @ts-expect-error — exercising the runtime guard
    expect(() => new DemosAdapter({})).toThrow(/rpc/);
  });

  it("constructs and exposes the raw demosdk instance", () => {
    const adapter = new DemosAdapter({ rpc: RPC });
    expect(adapter.raw).toBeDefined();
  });

  it("getAddress throws before connect", () => {
    const adapter = new DemosAdapter({ rpc: RPC });
    expect(() => adapter.getAddress()).toThrow(/not connected/);
  });

  it("substrate ops require a connection", async () => {
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
  });
});
