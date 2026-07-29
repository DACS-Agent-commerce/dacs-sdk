import { describe, expect, it } from "vitest";

// Throwaway mnemonic — local key derivation only, no funds needed. We're just
// checking the SDK can reach a live Demos node and do a read round-trip.
const MNEMONIC =
  "polar scale globe beauty stock employ rail exercise goat into sample embark";
const RPC = process.env.DEMOS_RPC;

describe("live node connectivity (SDK <-> Demos node)", () => {
  // Gated on DEMOS_RPC so the default offline `npm test`/CI stays offline.
  // Run with: DEMOS_RPC=https://node2.demos.sh npx vitest run test/integration/connectivity.smoke.test.ts
  if (!RPC) {
    it.skip("set DEMOS_RPC to run the live connectivity smoke", () => {});
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
