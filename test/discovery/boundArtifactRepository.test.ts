import { describe, expect, test } from "vitest";

import { contentHash } from "../../src/canonical/index.js";
import {
  createBoundArtifactRepository,
  createInMemoryBindingStore,
  type BindingPublisher,
  type BoundArtifactAdapter,
} from "../../src/discovery/index.js";

const SELLER = "0xseller";
const LOGICAL = "dacs1:0xseller:market-data:v1";
const RECORD = {
  serviceId: "market-data",
  price: "5",
  signature: "sig-real",
};

interface FakeBackend {
  nextAddress: number;
  writes: number;
  byOwnerAndName: Map<string, string>;
  records: Map<string, Record<string, unknown>>;
}

function createBackend(): FakeBackend {
  return {
    nextAddress: 1,
    writes: 0,
    byOwnerAndName: new Map(),
    records: new Map(),
  };
}

function fakeAdapter(owner: string, backend: FakeBackend): BoundArtifactAdapter {
  return {
    getAddress: () => owner,
    async anchorWriteOnce(name, value) {
      const key = `${owner.toLowerCase()}\u0000${name}`;
      const existing = backend.byOwnerAndName.get(key);
      if (existing) {
        const record = backend.records.get(existing)!;
        if (contentHash(record) !== contentHash(value as Record<string, unknown>)) {
          throw new Error("immutable anchor already holds different content");
        }
        return { address: existing, txRef: `tx-${existing}` };
      }

      const address = `stor-${backend.nextAddress++}`;
      backend.writes += 1;
      backend.byOwnerAndName.set(key, address);
      backend.records.set(address, { ...(value as Record<string, unknown>) });
      return { address, txRef: `tx-${address}` };
    },
    async readAnchor(address) {
      const record = backend.records.get(address);
      return record ? { ...record } : null;
    },
  };
}

describe("createBoundArtifactRepository (#58 publish/consume binding lifecycle)", () => {
  test("writer publishes logical→native binding and an independent reader verifies it", async () => {
    const backend = createBackend();
    const bindings = createInMemoryBindingStore();
    const writer = createBoundArtifactRepository({
      adapter: fakeAdapter(SELLER, backend),
      index: bindings,
      publisher: bindings,
    });

    const written = await writer.write(LOGICAL, RECORD, { version: 1 });
    expect(written).toMatchObject({
      status: "published",
      anchor: { address: "stor-1", txRef: "tx-stor-1" },
      binding: {
        logicalAddress: LOGICAL,
        nativeAddress: "stor-1",
        owner: SELLER,
        contentHash: contentHash(RECORD),
        version: 1,
      },
    });
    expect(written.storageName).not.toContain(":");

    // A separate repository instance has no nonce or storage-name input. It only
    // receives the logical address, expected signer, and published index.
    const reader = createBoundArtifactRepository({
      adapter: fakeAdapter("0xreader", backend),
      index: bindings,
      publisher: bindings,
    });
    const read = await reader.read(
      LOGICAL,
      SELLER,
      (record) => record.signature === "sig-real",
    );
    expect(read).toMatchObject({
      status: "verified",
      nativeAddress: "stor-1",
      record: RECORD,
    });
  });

  test("retry after reconnect reuses the physical anchor and publication", async () => {
    const backend = createBackend();
    const bindings = createInMemoryBindingStore();
    const first = createBoundArtifactRepository({
      adapter: fakeAdapter(SELLER, backend),
      index: bindings,
      publisher: bindings,
    });
    expect((await first.write(LOGICAL, RECORD)).status).toBe("published");

    const reconnected = createBoundArtifactRepository({
      adapter: fakeAdapter(SELLER, backend),
      index: bindings,
      publisher: bindings,
    });
    const retry = await reconnected.write(LOGICAL, RECORD);
    expect(retry).toMatchObject({
      status: "already-published",
      anchor: { address: "stor-1" },
    });
    expect(backend.writes).toBe(1);
    expect(bindings.snapshot()).toHaveLength(1);
  });

  test("publication failure is indeterminate and a retry does not duplicate the anchor", async () => {
    const backend = createBackend();
    const bindings = createInMemoryBindingStore();
    let fail = true;
    const publisher: BindingPublisher = {
      async publish(binding) {
        if (fail) {
          fail = false;
          throw new Error("catalog timeout");
        }
        return bindings.publish(binding);
      },
    };
    const repository = createBoundArtifactRepository({
      adapter: fakeAdapter(SELLER, backend),
      index: bindings,
      publisher,
    });

    const uncertain = await repository.write(LOGICAL, RECORD);
    expect(uncertain).toMatchObject({
      status: "indeterminate",
      anchor: { address: "stor-1" },
      reason: expect.stringContaining("catalog timeout"),
    });
    expect(await repository.read(LOGICAL, SELLER)).toEqual({ status: "absent" });

    const retry = await repository.write(LOGICAL, RECORD);
    expect(retry).toMatchObject({
      status: "published",
      anchor: { address: "stor-1" },
    });
    expect(backend.writes).toBe(1);
  });

  test("a pre-existing different binding conflicts and is never overwritten", async () => {
    const backend = createBackend();
    const bindings = createInMemoryBindingStore([
      {
        logicalAddress: LOGICAL,
        nativeAddress: "stor-stale",
        owner: SELLER,
        contentHash: "different",
      },
    ]);
    const repository = createBoundArtifactRepository({
      adapter: fakeAdapter(SELLER, backend),
      index: bindings,
      publisher: bindings,
    });

    const result = await repository.write(LOGICAL, RECORD);
    expect(result).toMatchObject({
      status: "conflict",
      anchor: { address: "stor-1" },
      existing: { nativeAddress: "stor-stale" },
    });
    expect(bindings.snapshot()).toHaveLength(1);
  });

  test("a publisher cannot report success for a different anchored binding", async () => {
    const backend = createBackend();
    const bindings = createInMemoryBindingStore();
    const repository = createBoundArtifactRepository({
      adapter: fakeAdapter(SELLER, backend),
      index: bindings,
      publisher: {
        async publish(binding) {
          return {
            status: "published",
            binding: { ...binding, nativeAddress: "stor-not-the-anchor" },
          };
        },
      },
    });

    expect(await repository.write(LOGICAL, RECORD)).toMatchObject({
      status: "conflict",
      anchor: { address: "stor-1" },
      existing: { nativeAddress: "stor-not-the-anchor" },
    });
  });

  test("wrong owner and missing binding are absent", async () => {
    const backend = createBackend();
    const bindings = createInMemoryBindingStore();
    const repository = createBoundArtifactRepository({
      adapter: fakeAdapter(SELLER, backend),
      index: bindings,
      publisher: bindings,
    });
    await repository.write(LOGICAL, RECORD);

    expect(await repository.read(LOGICAL, "0xother")).toEqual({ status: "absent" });
    expect(await repository.read("dacs1:missing", SELLER)).toEqual({ status: "absent" });
  });

  test("stale binding, invalid signature, and transient index failure fail closed", async () => {
    const backend = createBackend();
    backend.records.set("stor-stale", RECORD);
    const stale = createInMemoryBindingStore([
      {
        logicalAddress: LOGICAL,
        nativeAddress: "stor-stale",
        owner: SELLER,
        contentHash: "wrong-hash",
      },
    ]);
    const staleRepository = createBoundArtifactRepository({
      adapter: fakeAdapter("0xreader", backend),
      index: stale,
      publisher: stale,
    });
    expect(
      (await staleRepository.read(LOGICAL, SELLER, () => true)).status,
    ).toBe("hash-mismatch");

    const valid = createInMemoryBindingStore([
      {
        logicalAddress: LOGICAL,
        nativeAddress: "stor-stale",
        owner: SELLER,
        contentHash: contentHash(RECORD),
      },
    ]);
    const invalidSignature = createBoundArtifactRepository({
      adapter: fakeAdapter("0xreader", backend),
      index: valid,
      publisher: valid,
    });
    expect(
      (await invalidSignature.read(LOGICAL, SELLER, () => false)).status,
    ).toBe("signature-invalid");

    const transient = createBoundArtifactRepository({
      adapter: fakeAdapter("0xreader", backend),
      index: {
        resolve: async () => {
          throw new Error("index offline");
        },
      },
      publisher: valid,
    });
    expect((await transient.read(LOGICAL, SELLER)).status).toBe("indeterminate");
  });

  test("consecutive logical artifacts receive distinct physical anchors", async () => {
    const backend = createBackend();
    const bindings = createInMemoryBindingStore();
    const repository = createBoundArtifactRepository({
      adapter: fakeAdapter(SELLER, backend),
      index: bindings,
      publisher: bindings,
    });

    const first = await repository.write(LOGICAL, RECORD);
    const second = await repository.write(
      "dacs1:0xseller:market-data:v2",
      { ...RECORD, price: "6" },
    );
    expect(first.anchor.address).toBe("stor-1");
    expect(second.anchor.address).toBe("stor-2");
    expect(backend.writes).toBe(2);
  });
});
