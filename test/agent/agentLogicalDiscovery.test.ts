import { describe, expect, test, vi } from "vitest";

import { buildAgent } from "../../src/agent/Agent.js";
import { buildSignedArtifact } from "../../src/agent/signedArtifact.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import type { Listing } from "../../src/artifacts/types.js";
import { contentHash, listingAddress } from "../../src/canonical/index.js";
import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";
import { createInMemoryBindingIndex } from "../../src/discovery/index.js";
import type { DemosAdapter } from "../../src/substrate/DemosAdapter.js";

const seed = Uint8Array.from(Buffer.alloc(32, 5));
const privateKey = privateKeyFromSeed(seed);
const owner = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex");
const sellerId = `did:demos:agent:${owner}`;
const logicalAddress = listingAddress(sellerId, "directory-service", 1);
const listing: Listing = {
  agentId: sellerId,
  serviceId: "directory-service",
  name: "Directory Service",
  description: "Read-only discovery test",
  claimRequirements: [],
  supportedNegotiation: ["negotiate-fixed-price"],
  supportedPaymentRails: ["pay-x402"],
  supportedDelivery: ["deliver-attested-payload"],
};

describe("Agent logical Listing discovery (#54)", () => {
  test("a walletless index-only Agent reads and enumerates without write authority", async () => {
    const record = (await buildSignedArtifact(
      listing,
      ARTIFACT_SEPARATORS.Listing,
      (bytes) => ed25519Sign(bytes, privateKey),
    )) as unknown as Record<string, unknown>;
    const nativeAddress = "stor-directory-listing";
    const index = createInMemoryBindingIndex([
      {
        logicalAddress,
        nativeAddress,
        owner,
        contentHash: contentHash(record),
        version: 1,
      },
    ]);
    const scan = vi.fn();
    const anchor = vi.fn();
    const sign = vi.fn();
    const adapter = {
      readAnchor: async (address: string) =>
        address === nativeAddress ? record : null,
      createAnchorHistoryPageFetcher: (expectedOwner: string) => {
        expect(expectedOwner).toBe(owner);
        return async () => ({
          entries: [
            {
              nativeAddress,
              logicalAddress,
              owner: `0x${owner}`,
            },
          ],
          nextCursor: null,
        });
      },
      scanOwnAnchorsByNamePrefix: scan,
      anchorWriteOnce: anchor,
      sign,
      getAddress: () => owner,
    } as unknown as DemosAdapter;
    const agent = buildAgent(adapter, {
      demosRpc: "mem",
      bindings: { index },
    });

    await expect(agent.readListing(logicalAddress)).resolves.toMatchObject({
      status: "authenticated",
      ref: nativeAddress,
      listing: { serviceId: "directory-service" },
    });
    await expect(agent.enumerateListings(sellerId)).resolves.toMatchObject({
      status: "page",
      listings: [{ ref: nativeAddress }],
      nextCursor: null,
    });

    await expect(agent.publishListing(listing)).rejects.toThrow(
      /bindings\.publisher/,
    );
    expect(scan).not.toHaveBeenCalled();
    expect(anchor).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });

  test("logical reads fail before adapter I/O when no index is configured", async () => {
    const readAnchor = vi.fn();
    const adapter = {
      readAnchor,
      createAnchorHistoryPageFetcher: vi.fn(),
    } as unknown as DemosAdapter;
    const agent = buildAgent(adapter, { demosRpc: "mem" });

    await expect(agent.readListing(logicalAddress)).rejects.toThrow(
      /bindings\.index/,
    );
    await expect(agent.enumerateListings(sellerId)).rejects.toThrow(
      /bindings\.index/,
    );
    expect(readAnchor).not.toHaveBeenCalled();
  });

  test("walletless write and session calls fail before adapter or publisher I/O", async () => {
    const scan = vi.fn();
    const anchor = vi.fn();
    const sign = vi.fn();
    const readAnchor = vi.fn();
    const getAddress = vi.fn(() => owner);
    const publish = vi.fn();
    const index = createInMemoryBindingIndex([]);
    const adapter = {
      scanOwnAnchorsByNamePrefix: scan,
      anchorWriteOnce: anchor,
      sign,
      readAnchor,
      getAddress,
    } as unknown as DemosAdapter;
    const agent = buildAgent(adapter, {
      demosRpc: "mem",
      identity: { agentId: sellerId },
      bindings: { index, publisher: { publish } },
    });

    await expect(agent.publishListing(listing)).rejects.toThrow(
      /AgentConfig\.wallet/,
    );
    await expect(
      agent.runSession("stor-listing", {} as never),
    ).rejects.toThrow(/requires createAgent\(\{ wallet \}\)/);

    expect(scan).not.toHaveBeenCalled();
    expect(anchor).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(readAnchor).not.toHaveBeenCalled();
    expect(getAddress).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  test("rejects a null publisher with the documented configuration error", () => {
    const adapter = {} as DemosAdapter;
    expect(() =>
      buildAgent(adapter, {
        demosRpc: "mem",
        bindings: {
          index: createInMemoryBindingIndex([]),
          publisher: null as never,
        },
      }),
    ).toThrow(/valid publisher/);
    expect(() =>
      buildAgent(adapter, {
        demosRpc: "mem",
        bindings: null as never,
      }),
    ).toThrow(/index resolver/);
  });
});
