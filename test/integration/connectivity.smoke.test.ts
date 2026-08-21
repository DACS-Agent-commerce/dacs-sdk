import { describe, expect, it } from "vitest";

const RPC = process.env.DEMOS_RPC;
const MNEMONIC = process.env.DEMOS_CONNECTIVITY_MNEMONIC?.trim();

describe("live node connectivity (SDK <-> Demos node)", () => {
  // Both values are required so the default offline test run stays offline and
  // no account material needs to be committed to source control.
  if (!RPC || !MNEMONIC) {
    it.skip(
      "set DEMOS_RPC and DEMOS_CONNECTIVITY_MNEMONIC to run the live connectivity smoke",
      () => {},
    );
    return;
  }

  it(
    "connects, derives an address, and does a read round-trip",
    async () => {
      const { DemosAdapter } = await import("../../src/substrate/index.js");
      const adapter = new DemosAdapter({ rpc: RPC, secret: MNEMONIC });
      await adapter.connect();

      const addr = adapter.getAddress();
      console.log("[connectivity] connected to", RPC, "as", addr);
      expect(addr).toBeTruthy();

      // Read a derived (almost certainly empty) anchor address — exercises a
      // real node read; should resolve to null rather than throw.
      const probeName = `dacs:connectivity:probe:${Date.now()}`;
      const probe = await adapter.anchorAddress(probeName);
      const value = await adapter.readAnchor(probe);
      console.log("[connectivity] read", probe, "=>", value);
      expect(value === null || typeof value === "object").toBe(true);

      // Exercise the fail-closed raw name-search path used by immutable listing
      // publication. The unique probe was never written, so both exact lookup
      // and owner-prefix scan must report genuine absence rather than an RPC
      // error disguised as an empty result.
      await expect(
        adapter.resolveAnchorByName(probeName, addr),
      ).resolves.toEqual({ status: "absent" });
      await expect(
        adapter.scanOwnAnchorsByNamePrefix(probeName),
      ).resolves.toEqual({ status: "ok", anchors: [] });
    },
    60_000,
  );
});
