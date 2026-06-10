import { describe, expect, it } from "vitest";

import { DemosAdapter, NotImplementedError } from "../../src/index.js";

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

  it("seam methods outside the MVP scaffold throw NotImplementedError", async () => {
    const adapter = new DemosAdapter({ rpc: RPC });
    await expect(adapter.sign(new Uint8Array())).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(adapter.anchor("addr", "val")).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(adapter.readAnchor("addr")).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(
      adapter.proxyFetch({ url: "https://example.com" }),
    ).rejects.toBeInstanceOf(NotImplementedError);
    await expect(adapter.resolveIdentity("ref")).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });
});
