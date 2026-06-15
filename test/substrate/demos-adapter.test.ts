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

  it("anchor (SR-2) requires a connection", async () => {
    const adapter = new DemosAdapter({ rpc: RPC });
    await expect(adapter.anchor("dacs:test", { a: 1 })).rejects.toThrow(
      /not connected/,
    );
  });

  it("seam methods not yet implemented throw NotImplementedError", async () => {
    const adapter = new DemosAdapter({ rpc: RPC });
    await expect(adapter.sign(new Uint8Array())).rejects.toBeInstanceOf(
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
