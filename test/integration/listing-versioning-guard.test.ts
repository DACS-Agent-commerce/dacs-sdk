import { expect, it, vi } from "vitest";

import { publishListingCore } from "../../src/agent/publishListingCore.js";
import { buildVersioningListing } from "./listing-versioning-fixture.js";

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
