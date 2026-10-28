import { StorageProgram } from "@kynesyslabs/demosdk/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

import { logicalToStorageProgramName } from "../../src/canonical/index.js";
import { DemosAdapter, createInMemoryDemosWriteJournal } from "../../src/substrate/index.js";

const WALLET = `0x${"ab".repeat(32)}`;

function fixture(response: unknown) {
  const adapter = new DemosAdapter({
    rpc: "https://nonce-admission.test", chainIdentity: "nonce-admission",
    writeJournal: createInMemoryDemosWriteJournal(),
  });
  Object.assign(adapter, { connected: true });
  vi.spyOn(adapter.raw, "getAddress").mockReturnValue(WALLET);
  const convenience = vi.spyOn(adapter.raw, "getAddressNonce").mockResolvedValue(0);
  const nodeCall = vi.spyOn(adapter.raw, "nodeCall").mockResolvedValue(response);
  vi.spyOn(adapter, "resolveAnchorByName").mockResolvedValue({ status: "absent" });
  const create = vi.spyOn(StorageProgram, "createStorageProgram");
  const sign = vi.spyOn(adapter.raw.storagePrograms, "sign").mockRejectedValue(
    new Error("unexpected signing"),
  );
  const confirm = vi.spyOn(adapter.raw.tx, "confirm");
  const broadcast = vi.spyOn(adapter.raw.tx, "broadcast");
  return { adapter, convenience, nodeCall, create, sign, confirm, broadcast };
}

afterEach(() => vi.restoreAllMocks());

describe("anchor nonce admission", () => {
  for (const method of ["anchorAndWait", "anchorWriteOnce"] as const) {
    it.each([
      undefined, null, false, {}, { result: 500, response: "unavailable" },
      "12garbage", " 12", "01", "1.5", "-1", -1, 1.5, NaN,
      Number.MAX_SAFE_INTEGER, "9007199254740991", "9007199254740992",
    ])(`${method} rejects malformed or exhausted raw nonce %j before preparing a write`, async (response) => {
      const h = fixture(response);
      await expect(h.adapter[method]("strict-nonce", { value: 1 }, {
        timeoutMs: 1_000, pollMs: 1,
      })).rejects.toThrow(/nonce/);
      expect(h.nodeCall).toHaveBeenCalledWith("getAddressNonce", { address: WALLET });
      expect(h.convenience).not.toHaveBeenCalled();
      expect(h.create).not.toHaveBeenCalled();
      expect(h.sign).not.toHaveBeenCalled();
      expect(h.confirm).not.toHaveBeenCalled();
      expect(h.broadcast).not.toHaveBeenCalled();
    });

    it(`${method} rejects an unavailable nonce read before preparing a write`, async () => {
      const h = fixture(0);
      h.nodeCall.mockRejectedValue(new Error("nonce RPC unavailable"));
      await expect(h.adapter[method]("strict-nonce", { value: 1 }, {
        timeoutMs: 1_000, pollMs: 1,
      })).rejects.toThrow(/nonce/);
      expect(h.convenience).not.toHaveBeenCalled();
      expect(h.create).not.toHaveBeenCalled();
      expect(h.sign).not.toHaveBeenCalled();
      expect(h.confirm).not.toHaveBeenCalled();
      expect(h.broadcast).not.toHaveBeenCalled();
    });
  }

  it.each([0, "0", 17, "17", Number.MAX_SAFE_INTEGER - 1])(
    "derives a storage address from canonical raw nonce %j", async (response) => {
      const h = fixture(response);
      await expect(h.adapter.anchorAddress("strict-nonce")).resolves.toBe(
        StorageProgram.deriveStorageAddress(
          WALLET, logicalToStorageProgramName("strict-nonce"), Number(response) + 1, "",
        ),
      );
      expect(h.nodeCall).toHaveBeenCalledWith("getAddressNonce", { address: WALLET });
      expect(h.convenience).not.toHaveBeenCalled();
    },
  );
});
