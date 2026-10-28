import { afterEach, describe, expect, test, vi } from "vitest";
import { ratingAddress, logicalToStorageProgramName } from "../../src/canonical/index.js";
import { isCanonicalClaimReference } from "../../src/identity/index.js";
import { createInMemoryDemosWriteJournal, DemosAdapter } from "../../src/substrate/index.js";

const OWNER = `0x${"b".repeat(64)}`;
const RATER = "stor-cred:demo:\u0301x";
const LOGICAL = ratingAddress("01J8ME0SXKQ4T9V2RC5HJ6WX7D", RATER);

afterEach(() => vi.restoreAllMocks());

describe("Demos retained wire journal", () => {
  test("retains the CF-4 logical key in a synthetic signed envelope without broadcasting", async () => {
    expect(isCanonicalClaimReference(RATER)).toBe(true);
    expect(LOGICAL.normalize("NFC")).not.toBe(LOGICAL);
    const journal = createInMemoryDemosWriteJournal();
    const acquire = journal.acquire.bind(journal);
    vi.spyOn(journal, "acquire").mockImplementation(async (key) => {
      const lease = await acquire(key);
      const put = lease.put.bind(lease);
      lease.put = async (record) => {
        await put(record);
        if (record.stage === "signed") throw new Error("stop after retaining synthetic envelope");
      };
      return lease;
    });
    const adapter = new DemosAdapter({
      rpc: "https://wire-journal-fixture.test", chainIdentity: "test-chain", writeJournal: journal,
    });
    Object.assign(adapter, { connected: true });
    vi.spyOn(adapter.raw, "getAddress").mockReturnValue(OWNER);
    vi.spyOn(adapter, "resolveAnchorByName").mockResolvedValue({ status: "absent" });
    vi.spyOn(adapter as unknown as { nextAnchorNonce(): Promise<number> }, "nextAnchorNonce")
      .mockResolvedValue(1);
    vi.spyOn(adapter.raw.storagePrograms, "sign").mockImplementation(async (payload) => ({
      hash: "public-synthetic-transaction",
      content: {
        type: "storageProgram", from: OWNER, to: payload.storageAddress, nonce: 1,
        data: ["storageProgram", payload],
      },
    }) as never);
    vi.spyOn(adapter.raw.tx, "confirm").mockImplementation(async (signed) => signed as never);
    const broadcast = vi.spyOn(adapter.raw.tx, "broadcast");
    await expect(adapter.anchorWriteOnce(logicalToStorageProgramName(LOGICAL), { public: true }, {
      metadata: { logicalAddress: LOGICAL },
    })).rejects.toThrow("stop after retaining synthetic envelope");
    expect(broadcast).not.toHaveBeenCalled();
    const lease = await acquire({ chainIdentity: "test-chain", wallet: OWNER });
    try {
      expect(lease.snapshot.records).toHaveLength(1);
      const retained = lease.snapshot.records[0]!;
      expect(retained.logicalName).toBe(LOGICAL);
      expect(retained.stage).toBe("signed");
      const signed = JSON.parse(retained.signedTransaction!) as {
        content: { data: [string, { programName: string; metadata: { logicalAddress: string } }] };
      };
      expect(signed.content.data[1].metadata.logicalAddress).toBe(LOGICAL);
      expect(signed.content.data[1].programName).toBe(logicalToStorageProgramName(LOGICAL));
    } finally {
      await lease.release();
    }
  });
});
