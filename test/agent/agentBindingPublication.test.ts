import { describe, expect, test } from "vitest";

import { buildAgent } from "../../src/agent/Agent.js";
import { verifySignedArtifact } from "../../src/agent/signedArtifact.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import type { Listing } from "../../src/artifacts/types.js";
import { isListing } from "../../src/artifacts/validators.js";
import {
  contentHash,
  listingAddress,
  stripSignature,
} from "../../src/canonical/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";
import {
  createInMemoryBindingStore,
  resolveAndRead,
  type BindingPublisher,
} from "../../src/discovery/index.js";
import type { DemosAdapter } from "../../src/substrate/DemosAdapter.js";

const SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 7));
const SELLER_PRIVATE_KEY = privateKeyFromSeed(SELLER_SEED);
const SELLER_PUBLIC_KEY = rawPublicKey(publicKeyFromSeed(SELLER_SEED));
const OWNER = Buffer.from(SELLER_PUBLIC_KEY).toString("hex");
const SELLER = `did:demos:agent:${OWNER}`;
const LOGICAL = listingAddress(SELLER, "market-data", 1);
const verifyRaw = (
  bytes: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
) => ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey));

const LISTING = {
  agentId: SELLER,
  serviceId: "market-data",
  name: "Market Data",
  description: "End-of-day prices",
  claimRequirements: [],
  supportedNegotiation: ["negotiate-fixed-price"],
  supportedPaymentRails: ["pay-x402"],
  supportedDelivery: ["deliver-attested-payload"],
};

interface FakeAdapterState {
  creates: number;
  scans: number;
  metadata: Array<Record<string, unknown> | undefined>;
  byName: Map<string, string>;
  records: Map<string, Record<string, unknown>>;
}

function fakeAdapter(
  seed: Uint8Array = SELLER_SEED,
): { adapter: DemosAdapter; state: FakeAdapterState } {
  const privateKey = privateKeyFromSeed(seed);
  const owner = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString(
    "hex",
  );
  const state: FakeAdapterState = {
    creates: 0,
    scans: 0,
    metadata: [],
    byName: new Map(),
    records: new Map(),
  };

  const adapter = {
    getAddress: () => owner,
    sign: async (bytes: Uint8Array) => ed25519Sign(bytes, privateKey),
    async scanOwnAnchorsByNamePrefix(prefix: string) {
      state.scans += 1;
      return {
        status: "ok" as const,
        anchors: [...state.byName.entries()]
          .filter(([name]) => name.startsWith(prefix))
          .map(([programName, address]) => ({
            address,
            programName,
            value: state.records.get(address)!,
          })),
      };
    },
    async anchorWriteOnce(
      name: string,
      value: object,
      options?: { metadata?: Record<string, unknown> },
    ) {
      state.metadata.push(
        options?.metadata === undefined ? undefined : { ...options.metadata },
      );
      const existing = state.byName.get(name);
      if (existing !== undefined) {
        const stored = state.records.get(existing)!;
        if (
          contentHash(stored) !==
          contentHash(value as Record<string, unknown>)
        ) {
          throw new Error("immutable anchor already contains different content");
        }
        return { address: existing, txRef: `tx-${existing}` };
      }

      const address = `stor-${++state.creates}`;
      state.byName.set(name, address);
      state.records.set(address, value as Record<string, unknown>);
      return { address, txRef: `tx-${address}` };
    },
    async readAnchor(address: string) {
      return state.records.get(address) ?? null;
    },
  } as unknown as DemosAdapter;

  return { adapter, state };
}

describe("Agent.publishListing binding publication (#54)", () => {
  test("rejects malformed binding configuration before constructing the Agent", () => {
    const { adapter, state } = fakeAdapter();
    expect(() =>
      buildAgent(adapter, {
        demosRpc: "mem",
        wallet: "secret",
        bindings: { index: {}, publisher: {} },
      } as never),
    ).toThrow(/index resolver and an authorized publisher/);
    expect(state.creates).toBe(0);
  });

  test("fails before scanning, signing, or anchoring when publication authority is absent", async () => {
    const { adapter, state } = fakeAdapter();
    const agent = buildAgent(adapter, { demosRpc: "mem", wallet: "secret" });

    await expect(agent.publishListing(LISTING)).rejects.toThrow(
      /requires AgentConfig\.bindings/,
    );
    expect(state.scans).toBe(0);
    expect(state.creates).toBe(0);
  });

  test("rejects a seller claim that is not the connected wallet before anchoring", async () => {
    const { adapter, state } = fakeAdapter(
      Uint8Array.from(Buffer.alloc(32, 9)),
    );
    const bindings = createInMemoryBindingStore();
    const agent = buildAgent(adapter, {
      demosRpc: "mem",
      wallet: "secret",
      bindings: { index: bindings, publisher: bindings },
    });

    await expect(agent.publishListing(LISTING)).rejects.toThrow(
      /self-certifying Demos claim for the connected wallet/,
    );
    expect(state.scans).toBe(0);
    expect(state.creates).toBe(0);
    expect(bindings.snapshot()).toEqual([]);
  });

  test("rejects non-canonical or unrelated DID schemes even when they end in the wallet key", async () => {
    for (const agentId of [
      `did:web:seller.example:${OWNER}`,
      `did:demos:agent:${OWNER.toUpperCase()}`,
      OWNER,
      `0x${OWNER}`,
      `demos:0x${OWNER}`,
    ]) {
      const { adapter, state } = fakeAdapter();
      const bindings = createInMemoryBindingStore();
      const agent = buildAgent(adapter, {
        demosRpc: "mem",
        wallet: "secret",
        bindings: { index: bindings, publisher: bindings },
      });
      await expect(
        agent.publishListing({ ...LISTING, agentId }),
      ).rejects.toThrow(/self-certifying Demos claim/);
      expect(state.scans).toBe(0);
      expect(state.creates).toBe(0);
    }
  });

  test("anchors once and automatically publishes the exact logical-to-native binding", async () => {
    const { adapter, state } = fakeAdapter();
    const bindings = createInMemoryBindingStore();
    const agent = buildAgent(adapter, {
      demosRpc: "mem",
      wallet: "secret",
      bindings: { index: bindings, publisher: bindings },
    });

    const result = await agent.publishListing(LISTING);

    expect(result).toMatchObject({
      status: "published",
      ref: "stor-1",
      logicalAddress: LOGICAL,
      txRef: "tx-stor-1",
      publication: {
        status: "published",
        anchor: { address: "stor-1", txRef: "tx-stor-1" },
        binding: {
          logicalAddress: LOGICAL,
          nativeAddress: "stor-1",
          owner: OWNER,
          version: 1,
        },
      },
    });
    expect(result.publication.binding.contentHash).toBe(
      contentHash(state.records.get("stor-1")!),
    );
    expect(state.metadata).toEqual([{ logicalAddress: LOGICAL }]);
    expect(bindings.snapshot()).toEqual([result.publication.binding]);
    await expect(bindings.resolve(LOGICAL, OWNER)).resolves.toMatchObject({
      status: "present",
      binding: result.publication.binding,
    });

    // Independent reader: only the logical address, expected owner, published
    // index, and native read seam cross the boundary. It receives neither the
    // writer's opaque StorageProgram name nor its transaction nonce.
    const read = await resolveAndRead(bindings, LOGICAL, OWNER, {
      read: async (nativeAddress) => state.records.get(nativeAddress) ?? null,
      contentHashOf: contentHash,
      verifySignature: async (record, binding) => {
        const unsigned = stripSignature(record);
        if (!isListing(unsigned)) return false;
        const listing = unsigned as unknown as Listing;
        if (
          listingAddress(
            listing.agentId,
            listing.serviceId,
            listing.listingVersion ?? 1,
          ) !== binding.logicalAddress ||
          binding.owner !== OWNER ||
          binding.version !== (listing.listingVersion ?? 1)
        ) {
          return false;
        }
        return verifySignedArtifact(
          record,
          ARTIFACT_SEPARATORS.Listing,
          SELLER_PUBLIC_KEY,
          verifyRaw,
        );
      },
    });
    expect(read).toMatchObject({
      status: "verified",
      nativeAddress: "stor-1",
    });
  });

  test("returns an indeterminate receipt and republishes the same anchor on retry", async () => {
    const { adapter, state } = fakeAdapter();
    const bindings = createInMemoryBindingStore();
    let publicationAttempts = 0;
    const publisher: BindingPublisher = {
      async publish(binding) {
        publicationAttempts += 1;
        if (publicationAttempts === 1) throw new Error("catalog timeout");
        return bindings.publish(binding);
      },
    };
    const agent = buildAgent(adapter, {
      demosRpc: "mem",
      wallet: "secret",
      bindings: { index: bindings, publisher },
    });

    const first = await agent.publishListing(LISTING);
    expect(first).toMatchObject({
      status: "indeterminate",
      publication: {
        status: "indeterminate",
        anchor: { address: "stor-1" },
        reason: expect.stringContaining("catalog timeout"),
      },
    });
    expect("ref" in first).toBe(false);
    expect(bindings.snapshot()).toEqual([]);

    const retry = await agent.publishListing(LISTING);
    expect(retry).toMatchObject({
      status: "published",
      ref: "stor-1",
      publication: {
        status: "published",
        anchor: { address: "stor-1" },
      },
    });
    expect(state.creates).toBe(1);
    expect(publicationAttempts).toBe(2);
  });

  test("does not expose a ref when the publisher acknowledges before index visibility", async () => {
    const { adapter, state } = fakeAdapter();
    const bindings = createInMemoryBindingStore();
    const agent = buildAgent(adapter, {
      demosRpc: "mem",
      wallet: "secret",
      bindings: {
        index: bindings,
        publisher: {
          async publish(binding) {
            return { status: "published", binding };
          },
        },
      },
    });

    const result = await agent.publishListing(LISTING);
    expect(result).toMatchObject({
      status: "indeterminate",
      publication: {
        anchor: { address: "stor-1" },
        reason: expect.stringContaining("not yet visible"),
      },
    });
    expect("ref" in result).toBe(false);
    expect(state.creates).toBe(1);
  });

  test("surfaces a conflicting published binding without replacing or duplicating it", async () => {
    const { adapter, state } = fakeAdapter();
    const bindings = createInMemoryBindingStore([
      {
        logicalAddress: LOGICAL,
        nativeAddress: "stor-stale",
        owner: OWNER,
        contentHash: "stale",
        version: 1,
      },
    ]);
    const agent = buildAgent(adapter, {
      demosRpc: "mem",
      wallet: "secret",
      bindings: { index: bindings, publisher: bindings },
    });

    const result = await agent.publishListing(LISTING);
    expect(result).toMatchObject({
      status: "conflict",
      publication: {
        status: "conflict",
        anchor: { address: "stor-1" },
        existing: { nativeAddress: "stor-stale" },
      },
    });
    expect("ref" in result).toBe(false);
    expect(state.creates).toBe(1);
    expect(bindings.snapshot()).toHaveLength(1);
    expect(bindings.snapshot()[0]!.nativeAddress).toBe("stor-stale");
  });

  test("blocks v2 while the physical v1 binding is unresolved, then proceeds after repair", async () => {
    const { adapter, state } = fakeAdapter();
    const bindings = createInMemoryBindingStore();
    let failFirst = true;
    const publisher: BindingPublisher = {
      async publish(binding) {
        if (failFirst) {
          failFirst = false;
          throw new Error("catalog timeout");
        }
        return bindings.publish(binding);
      },
    };
    const agent = buildAgent(adapter, {
      demosRpc: "mem",
      wallet: "secret",
      bindings: { index: bindings, publisher },
    });

    const v1 = await agent.publishListing(LISTING);
    expect(v1.status).toBe("indeterminate");
    const scan = adapter.scanOwnAnchorsByNamePrefix.bind(adapter);
    let releaseScan!: () => void;
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    adapter.scanOwnAnchorsByNamePrefix = async (prefix) => {
      const result = await scan(prefix);
      await scanGate;
      return result;
    };
    const v2Input = {
      ...LISTING,
      listingVersion: 2,
      description: "v2",
    };
    const blocked = agent.publishListing(v2Input);
    v2Input.serviceId = "mutated-while-scan-waits";
    releaseScan();
    await expect(blocked).rejects.toThrow(
      /prior listing v1 binding is absent/,
    );
    expect(state.creates).toBe(1);

    adapter.scanOwnAnchorsByNamePrefix = scan;
    await bindings.publish(v1.publication.binding);
    const v2 = await agent.publishListing({
      ...LISTING,
      listingVersion: 2,
      description: "v2",
    });
    expect(v2).toMatchObject({ status: "published", ref: "stor-2" });
    expect(state.creates).toBe(2);
  });
});
