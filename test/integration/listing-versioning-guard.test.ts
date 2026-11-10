import { afterEach, expect, it, vi } from "vitest";

import { publishListingCore } from "../../src/agent/publishListingCore.js";
import { canonicalize, logicalToStorageProgramName, sha256Hex } from "../../src/canonical/index.js";
import { createInMemoryDemosWriteJournal, DemosAdapter } from "../../src/substrate/index.js";
import { buildVersioningListing, VERSIONING_OVERWRITE_REFUSAL } from "./listing-versioning-fixture.js";

afterEach(() => vi.restoreAllMocks());

it("admits the live versioning listing through publication checks before substrate I/O", async () => {
  const reachedScan = new Error("offline guard reached owned-anchor scan");
  const scanOwnAnchorsByNamePrefix = vi.fn(async () => { throw reachedScan; });
  const sign = vi.fn(async () => { throw new Error("unexpected signing"); });
  const writeArtifact = vi.fn(async () => { throw new Error("unexpected write"); });

  await expect(publishListingCore({
    ...buildVersioningListing("versioning-guard", "did:demos:seller", 1_000),
    listingVersion: 1,
  }, { sign, scanOwnAnchorsByNamePrefix, writeArtifact })).rejects.toBe(reachedScan);

  expect(scanOwnAnchorsByNamePrefix).toHaveBeenCalledTimes(1);
  expect(sign).not.toHaveBeenCalled();
  expect(writeArtifact).not.toHaveBeenCalled();
});

it.each(["content", "metadata"] as const)("guards the live listing %s overwrite refusal after confirmed create", async (conflict) => {
  const wallet = `0x${"ab".repeat(32)}`;
  const logicalName = "versioning-guard-v1";
  const listing = { ...buildVersioningListing("versioning-guard", "did:demos:seller", 1_000), listingVersion: 1 };
  const metadata = { kind: "Listing" };
  const writeJournal = createInMemoryDemosWriteJournal();
  const lease = await writeJournal.acquire({ chainIdentity: "test-chain", wallet });
  // Model v1 retained after confirmed execution and authenticated native readback.
  await lease.put({
    writeId: "versioning-guard-create",
    generation: lease.generation,
    kind: "immutable",
    operation: "create",
    stage: "native-visible",
    logicalName,
    programName: logicalToStorageProgramName(logicalName),
    owner: wallet,
    nativeAddress: "stor-versioning-guard",
    valueHash: sha256Hex(canonicalize(listing)),
    metadataHash: sha256Hex(canonicalize(metadata)),
    nonce: 1,
    txRef: "12".repeat(32),
    blockNumber: 14,
    updatedAt: 1_000,
  });
  await lease.release();
  const adapter = new DemosAdapter({ rpc: "https://node.test", chainIdentity: "test-chain", writeJournal });
  vi.spyOn(adapter.raw, "connect").mockResolvedValue(true);
  vi.spyOn(adapter.raw, "getAddress").mockReturnValue(wallet);
  const sign = vi.spyOn(adapter.raw.storagePrograms, "sign").mockRejectedValue(new Error("unexpected signing"));
  const broadcast = vi.spyOn(adapter.raw.tx, "broadcast").mockRejectedValue(new Error("unexpected broadcast"));
  await adapter.connect();

  await expect(adapter.anchorWriteOnce(logicalName, conflict === "content"
    ? { ...listing, offering: { ...listing.offering, description: "forbidden overwrite" } }
    : listing, { metadata: conflict === "metadata" ? { kind: "changed" } : metadata },
  )).rejects.toThrow(VERSIONING_OVERWRITE_REFUSAL);
  expect(sign).not.toHaveBeenCalled();
  expect(broadcast).not.toHaveBeenCalled();
});
