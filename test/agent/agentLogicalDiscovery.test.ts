import { describe, expect, test, vi } from "vitest";

import { buildAgent } from "../../src/agent/Agent.js";
import type { ListingValidationDeps } from "../../src/agent/listingValidation.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import { signComponentArtifact } from "../../src/artifacts/signatures.js";
import type { ListingDraft } from "../../src/artifacts/types.js";
import { contentHash, listingAddress } from "../../src/canonical/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
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
const listing: ListingDraft = {
  dacsVersion: "1",
  listingVersion: 1,
  listingId: "directory-service",
  seller: {
    identity: {
      bundleVersion: "1",
      presentedBy: sellerId,
      presentedAt: 1_780_000_000_000,
      claims: [{ ref: sellerId }],
      presentation: {
        kind: "per-claim",
        signatures: [{ ref: sellerId, signature: "identity-presentation" }],
      },
    },
    displayName: "Directory Service",
    publicEndpoint: "https://seller.example/dacs",
  },
  offering: {
    title: "Directory Service",
    description: "Read-only discovery test",
    category: "data.directory",
    tags: ["directory"],
    deliverable: {
      kind: "attested-payload",
      payloadFormat: "application/json",
      verificationMethod: { kind: "self-signed" },
    },
  },
  buyerRequirement: { requirementVersion: "1", required: [] },
  pipeline: [
    { kind: "negotiate-fixed-price" },
    { kind: "commit-agreement" },
    { kind: "pay-x402", parameters: { rail: "x402:default" } },
    { kind: "deliver-attested-payload" },
  ],
  pricing: { kind: "fixed", price: { amount: "1", currency: "USDC" } },
  acceptedRails: [{ railId: "x402:default" }],
  terms: { deadlineSecAfterCommit: 3_600 },
  validity: { notBefore: 1_780_000_000_000 },
};

const publicationCapabilities = {
  resolvePayloadVerificationCapability: () => ({
    disposition: "supported" as const,
  }),
  loadListingRailResolution: (draft: Readonly<ListingDraft>) => ({
    trustPhase: "PA-1" as const,
    trustPolicyAcceptsPA1: true,
    payPhases: draft.pipeline
      .filter((phase) => phase.kind.startsWith("pay-"))
      .map((phase) => ({ kind: phase.kind, rail: phase.parameters?.rail })),
    acceptedRails: draft.acceptedRails ?? [],
    registry: { state: "not-used" as const, entries: [], definitions: [] },
    inCodeDefinitions: [
      {
        railId: "x402:default",
        railVersion: 1,
        phaseHandler: "pay-x402",
        governanceAnchoring: "in-code" as const,
        signatureValid: true,
      },
    ],
  }),
};

const listingValidationDeps: ListingValidationDeps = {
  nowMs: () => 1_780_000_000_000,
  verifyListingSignature: ({ signedBytes, signature }) =>
    signature.signer === sellerId &&
    ed25519Verify(
      signedBytes,
      Uint8Array.from(Buffer.from(signature.value, "base64url")),
      publicKeyFromRaw(rawPublicKey(publicKeyFromSeed(seed))),
    ),
  revocation: {
    surfaces: [{
      kind: "well-known",
      status: "active",
      integrity: "verified",
    }],
    readMarker: async () => null,
    verifyMarkerSignature: () => false,
  },
  verifyIdentityPresentation: () => true,
  loadRailResolution: () => ({
    trustPhase: "PA-1",
    trustPolicyAcceptsPA1: true,
    registry: { state: "not-used", entries: [], definitions: [] },
    inCodeDefinitions: [{
      railId: "x402:default",
      railVersion: 1,
      phaseHandler: "pay-x402",
      governanceAnchoring: "in-code",
      signatureValid: true,
    }],
  }),
  resolvePayloadVerificationCapability: () => ({
    disposition: "supported",
  }),
  verifySellerControl: ({ signer }) => signer === sellerId,
};

describe("Agent logical Listing discovery (#54)", () => {
  test("a walletless index-only Agent reads and enumerates without write authority", async () => {
    const record = (await signComponentArtifact(
      listing,
      ARTIFACT_SEPARATORS.Listing,
      {
        algorithm: "ed25519",
        signer: sellerId,
        sign: (bytes) => ed25519Sign(bytes, privateKey),
      },
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
      ...publicationCapabilities,
      listingValidationDeps,
      bindings: { index },
    });

    await expect(agent.readListing(logicalAddress)).resolves.toMatchObject({
      status: "verified",
      compatibility: "normative",
      ref: nativeAddress,
      listingPin: {
        listingId: "directory-service",
        version: 1,
        contentHash: contentHash(record),
      },
      listing: {
        listingId: "directory-service",
        seller: { identity: { presentedBy: sellerId } },
      },
    });
    await expect(agent.enumerateListings(sellerId)).resolves.toMatchObject({
      status: "page",
      listings: [{ compatibility: "normative", ref: nativeAddress }],
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
      ...publicationCapabilities,
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
