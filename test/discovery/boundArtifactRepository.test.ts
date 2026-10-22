import { attestationBundleHash } from "../../src/agent/twoSidedBundle.js";
import { identityBundleHash } from "../../src/identity/bundle.js";
import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";

import {
  isAgreementArtifact,
  isAttestationBundle,
  isEvidenceBoundFaultAttestationBundle,
  isFaultAttestationBundle,
  isIdentityBundle,
  isListing,
} from "../../src/artifacts/validators.js";

import {
  canonicalize,
  contentHash,
  sha256Hex,
} from "../../src/canonical/index.js";
import {
  createBoundArtifactRepository,
  createInMemoryBindingIndex,
  createInMemoryBindingStore,
  type BindingPublisher,
  type BoundArtifactAdapter,
} from "../../src/discovery/index.js";

const identityHash = (record: Record<string, unknown>) => identityBundleHash(record as unknown as Parameters<typeof identityBundleHash>[0]);
const terminalHash = (record: Record<string, unknown>) => attestationBundleHash(record as unknown as Parameters<typeof attestationBundleHash>[0]);
const agreementHash = (record: Record<string, unknown>) => contentHash(record, "signatures");

const SELLER = "0xseller";
const LOGICAL = "dacs1:0xseller:market-data:v1";
const RECORD = {
  serviceId: "market-data",
  price: "5",
  signature: "sig-real",
};

function upstreamScenario(kind = "agreement") {
  const corpus = JSON.parse(readFileSync(new URL(
    "../../vendor/DACS-Standard/conformance/vectors/security/identity-bundle-hash-binding-v0.1.json",
    import.meta.url,
  ), "utf8"));
  return corpus.scenarios[kind];
}

function upstreamAgreement(): Record<string, unknown> {
  return upstreamScenario().agreement;
}

const AGREEMENT_CASES = [
  { kind: "agreement", hash: "b52c3c0a9fc7f9265d5d0e42e81e8d8da024bfd691e0e13a62b9af713bdce479" },
  { kind: "payeeBoundAgreement", hash: "edf599f4c56bd488c1a8cc2d08aa744215bb7d8a6ec431d57beee0ec9a242bcf" },
  { kind: "identityBoundAgreement", hash: "cb2eca6610a1e99530a21606c8a043e83741e2ffc4cf038ece09d283e7d6a4f9" },
  { kind: "identityBoundPayeeAgreement", hash: "4b49696a61f32face0c9c24d29069633e69fb9db06289fcd7f92f32e69955acc" },
];

function independentHash(record: Record<string, unknown>, omitted: string[]): string {
  return sha256Hex(canonicalize(Object.fromEntries(
    Object.entries(record).filter(([key]) => !omitted.includes(key)),
  )));
}

interface FakeBackend {
  nextAddress: number;
  writes: number;
  anchorMetadata: Array<Record<string, unknown> | undefined>;
  byOwnerAndName: Map<string, string>;
  records: Map<string, Record<string, unknown>>;
}

function createBackend(): FakeBackend {
  return {
    nextAddress: 1,
    writes: 0,
    anchorMetadata: [],
    byOwnerAndName: new Map(),
    records: new Map(),
  };
}

function fakeAdapter(owner: string, backend: FakeBackend): BoundArtifactAdapter {
  return {
    getAddress: () => owner,
    async anchorWriteOnce(name, value, options) {
      backend.anchorMetadata.push(
        options?.metadata === undefined ? undefined : { ...options.metadata },
      );
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
  test.each(AGREEMENT_CASES)("publishes the upstream $kind hash in binding and anchor metadata", async ({ kind, hash }) => {
    const agreement = upstreamScenario(kind).agreement;
    const expectedHash = independentHash(agreement, ["signatures"]);
    expect(expectedHash).toBe(hash);
    const backend = createBackend();
    const bindings = createInMemoryBindingStore();
    const repository = createBoundArtifactRepository({
      contentHashOf: agreementHash,
      adapter: fakeAdapter(SELLER, backend), index: bindings, publisher: bindings,
    });
    const written = await repository.write(`dacs3:${agreement.jobId}:agreement`, agreement);
    expect(written).toMatchObject({ status: "published", binding: { contentHash: expectedHash } });
    expect(backend.anchorMetadata[0]).toEqual({
      logicalAddress: `dacs3:${agreement.jobId}:agreement`,
      contentHash: expectedHash,
      envelopeHash: sha256Hex(canonicalize(agreement)),
    });
    expect(backend.records.get(written.anchor.address)).toEqual(agreement);
  });

  test.each(AGREEMENT_CASES)("reads a pre-existing correctly hashed $kind binding and invokes its verifier", async ({ kind, hash }) => {
    const agreement = upstreamScenario(kind).agreement;
    const logicalAddress = `dacs3:${agreement.jobId}:agreement`;
    const backend = createBackend();
    backend.records.set("stor-existing", agreement);
    const bindings = createInMemoryBindingStore([{
      logicalAddress, nativeAddress: "stor-existing", owner: SELLER,
      contentHash: hash,
    }]);
    const repository = createBoundArtifactRepository({
      contentHashOf: agreementHash,
      adapter: fakeAdapter("0xreader", backend), index: bindings, publisher: bindings,
    });
    const verify = vi.fn(() => true);
    expect(await repository.read(logicalAddress, SELLER, verify)).toMatchObject({
      status: "verified", record: agreement,
    });
    expect(verify).toHaveBeenCalledOnce();
    expect(backend.writes).toBe(0);
  });

  test("fails before anchoring or verifying when the selected hash contract fails", async () => {
    const backend = createBackend();
    backend.records.set("stor-existing", RECORD);
    const bindings = createInMemoryBindingStore([{
      logicalAddress: LOGICAL, nativeAddress: "stor-existing", owner: SELLER, contentHash: "00".repeat(32),
    }]);
    const repository = createBoundArtifactRepository({
      contentHashOf: () => { throw new Error("invalid artifact for selected contract"); },
      adapter: fakeAdapter(SELLER, backend), index: bindings, publisher: bindings,
    });
    await expect(repository.write(LOGICAL, RECORD)).rejects.toThrow("invalid artifact for selected contract");
    expect(backend.writes).toBe(0);
    const verify = vi.fn(() => true);
    expect(await repository.read(LOGICAL, SELLER, verify)).toMatchObject({ status: "unverifiable" });
    expect(verify).not.toHaveBeenCalled();
  });

  test.each([
    { name: "Agreement", record: () => ({ ...upstreamAgreement(), signature: { note: "signed extension" } }), omitted: ["signatures"] },
    { name: "PayeeBoundAgreement", record: () => {
      const agreement = upstreamScenario("payeeBoundAgreement").agreement;
      expect(isAgreementArtifact(agreement)).toBe(true);
      return { ...agreement, signature: { note: "signed extension" } };
    }, omitted: ["signatures"] },
    ...["identityBoundAgreement", "identityBoundPayeeAgreement"].map((kind) => ({
      name: kind,
      record: () => ({ ...upstreamScenario(kind).agreement, signature: { note: "signed extension" } }),
      omitted: ["signatures"],
    })),
    { name: "ChannelTranscript", record: () => ({
      transcriptVersion: "1", channelId: "channel-1", members: ["buyer", "seller"],
      messages: [], generatedAt: 1, signatures: [{ party: "buyer", algorithm: "ed25519", value: "AA" }],
      signature: { note: "signed extension" },
    }), omitted: ["signatures"] },
    { name: "AttestationBundle", record: () => {
      const { evidenceBoundFaultBundleVersion: _version, faultedParty: _fault, ...scope } = upstreamScenario().terminalInput.bundle;
      const bundle = { ...scope, bundleVersion: "1" };
      expect(isAttestationBundle(bundle)).toBe(true);
      return { ...bundle, signature: { note: "signed extension" } };
    }, omitted: ["signatures", "anchoredByRole"] },
    { name: "FaultAttestationBundle", record: () => {
      const { evidenceBoundFaultBundleVersion: _version, ...scope } = upstreamScenario().terminalInput.bundle;
      const bundle = { ...scope, faultBundleVersion: "1" };
      expect(isFaultAttestationBundle(bundle)).toBe(true);
      return { ...bundle, signature: { note: "signed extension" } };
    }, omitted: ["signatures", "anchoredByRole"] },
    { name: "EvidenceBoundFaultAttestationBundle", record: () => {
      const bundle = upstreamScenario().terminalInput.bundle;
      expect(isEvidenceBoundFaultAttestationBundle(bundle)).toBe(true);
      return { ...bundle, signature: { note: "signed extension" } };
    }, omitted: ["signatures", "anchoredByRole"] },
    { name: "IdentityBundle", record: () => {
      const bundle = upstreamScenario().listing.seller.identity;
      expect(isIdentityBundle(bundle)).toBe(true);
      return { ...bundle, signature: { note: "signed extension" }, signatures: ["signed extension"] };
    }, omitted: ["presentation"] },
    { name: "singular-signature record", record: () => ({ ...RECORD, signatures: ["signed extension"] }), omitted: ["signature"] },
  ])("uses the $name contract on write and read and binds opposite-named extensions", async ({ record, omitted }) => {
    const artifact = record() as Record<string, unknown>;
    const backend = createBackend();
    const bindings = createInMemoryBindingStore();
    const repository = createBoundArtifactRepository({
      contentHashOf: omitted.includes("presentation") ? identityHash
        : omitted.includes("anchoredByRole") ? terminalHash
        : omitted.includes("signatures") ? agreementHash : contentHash,
      adapter: fakeAdapter(SELLER, backend), index: bindings, publisher: bindings,
    });
    const expectedHash = independentHash(artifact, omitted);
    const written = await repository.write(LOGICAL, artifact);
    expect(written.binding.contentHash).toBe(expectedHash);
    expect(backend.anchorMetadata[0]?.contentHash).toBe(expectedHash);
    const verify = vi.fn(() => true);
    expect((await repository.read(LOGICAL, SELLER, verify)).status).toBe("verified");
    expect(verify).toHaveBeenCalledOnce();
    const extension = omitted.includes("signature") ? "signatures" : "signature";
    for (const value of [undefined, { note: "tampered extension" }]) {
      const tampered = structuredClone(artifact);
      if (value === undefined) delete tampered[extension];
      else tampered[extension] = value;
      backend.records.set(written.anchor.address, tampered);
      expect((await repository.read(LOGICAL, SELLER, verify)).status).toBe("hash-mismatch");
    }
    expect(verify).toHaveBeenCalledOnce();
  });

  test.each([
    ...[
      "agreementVersion",
      "payeeBoundAgreementVersion",
      "identityBoundAgreementVersion",
      "identityBoundPayeeAgreementVersion",
    ].map((discriminator) => ({
      name: `Listing carrying ${discriminator}`,
      record: () => {
        const listing = { ...upstreamScenario().listing, [discriminator]: "1", signatures: ["signed extension"] };
        expect(isListing(listing)).toBe(true);
        return listing;
      },
      extension: discriminator,
      omitted: ["signature"],
    })),
    { name: "Listing carrying competing Agreement versions", record: () => {
      const listing = { ...upstreamScenario().listing, agreementVersion: "2", identityBoundAgreementVersion: "1" };
      expect(isListing(listing)).toBe(true);
      return listing;
    }, extension: "agreementVersion", omitted: ["signature"] },
    { name: "AttestationBundle carrying agreementVersion", record: () => {
      const { evidenceBoundFaultBundleVersion: _version, faultedParty: _fault, ...scope } = upstreamScenario().terminalInput.bundle;
      const bundle = { ...scope, bundleVersion: "1", agreementVersion: "1" };
      expect(isAttestationBundle(bundle)).toBe(true);
      return bundle;
    }, extension: "agreementVersion", omitted: ["signatures", "anchoredByRole"] },
    { name: "IdentityBundle carrying agreementVersion", record: () => {
      const bundle = { ...upstreamScenario().listing.seller.identity, agreementVersion: "1" };
      expect(isIdentityBundle(bundle)).toBe(true);
      return bundle;
    }, extension: "agreementVersion", omitted: ["presentation"] },
    { name: "singular-signature record carrying agreementVersion", record: () => ({
      ...RECORD, agreementVersion: "1", signatures: ["signed extension"],
    }), extension: "agreementVersion", omitted: ["signature"] },
  ])("keeps a $name on its own contract (CORE SIG-5)", async ({ record, extension, omitted }) => {
    const artifact = record() as Record<string, unknown>;
    const expectedHash = independentHash(artifact, omitted);
    expect(expectedHash).not.toBe(independentHash(artifact, ["signatures"]));
    const backend = createBackend();
    const bindings = createInMemoryBindingStore();
    const repository = createBoundArtifactRepository({
      contentHashOf: omitted.includes("presentation") ? identityHash
        : omitted.includes("anchoredByRole") ? terminalHash : contentHash,
      adapter: fakeAdapter(SELLER, backend), index: bindings, publisher: bindings,
    });
    const written = await repository.write(LOGICAL, artifact);
    expect(written.binding.contentHash).toBe(expectedHash);
    expect(backend.anchorMetadata[0]?.contentHash).toBe(expectedHash);
    const verify = vi.fn(() => true);
    expect((await repository.read(LOGICAL, SELLER, verify)).status).toBe("verified");
    expect(verify).toHaveBeenCalledOnce();
    for (const value of [undefined, "3"]) {
      const tampered = structuredClone(artifact);
      if (value === undefined) delete tampered[extension];
      else tampered[extension] = value;
      backend.records.set(written.anchor.address, tampered);
      expect((await repository.read(LOGICAL, SELLER, verify)).status).toBe("hash-mismatch");
    }
    expect(verify).toHaveBeenCalledOnce();
  });

  test("writer publishes logical→native binding and an independent reader verifies it", async () => {
    const backend = createBackend();
    const bindings = createInMemoryBindingStore();
    const writer = createBoundArtifactRepository({
      contentHashOf: contentHash,
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
    expect(backend.anchorMetadata).toEqual([{
      logicalAddress: LOGICAL,
      contentHash: contentHash(RECORD),
      envelopeHash: sha256Hex(canonicalize(RECORD)),
    }]);

    // A separate repository instance has no nonce or storage-name input. It only
    // receives the logical address, expected signer, and published index.
    const reader = createBoundArtifactRepository({
      contentHashOf: contentHash,
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
      contentHashOf: contentHash,
      adapter: fakeAdapter(SELLER, backend),
      index: bindings,
      publisher: bindings,
    });
    expect((await first.write(LOGICAL, RECORD)).status).toBe("published");

    const reconnected = createBoundArtifactRepository({
      contentHashOf: contentHash,
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

  test("hashes and anchors one deep snapshot across an asynchronous adapter write", async () => {
    const bindings = createInMemoryBindingStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let anchored: Record<string, unknown> | undefined;
    const adapter: BoundArtifactAdapter = {
      getAddress: () => SELLER,
      async anchorWriteOnce(_name, value) {
        await gate;
        anchored = value as Record<string, unknown>;
        return { address: "stor-pinned", txRef: "tx-pinned" };
      },
      async readAnchor() {
        return anchored ?? null;
      },
    };
    const repository = createBoundArtifactRepository({
      contentHashOf: contentHash,
      adapter,
      index: bindings,
      publisher: bindings,
    });
    const input = {
      ...RECORD,
      nested: { labels: ["original"] },
    };
    const expected = structuredClone(input);

    const pending = repository.write(LOGICAL, input, { version: 1 });
    input.serviceId = "mutated-after-call";
    input.nested.labels.push("mutated-after-call");
    release();

    const result = await pending;
    expect(result.status).toBe("published");
    expect(anchored).toEqual(expected);
    expect(result.binding.contentHash).toBe(contentHash(expected));
  });

  test("preserves caller metadata but reserves the logical-address keys", async () => {
    const backend = createBackend();
    const bindings = createInMemoryBindingStore();
    const repository = createBoundArtifactRepository({
      contentHashOf: contentHash,
      adapter: fakeAdapter(SELLER, backend),
      index: bindings,
      publisher: bindings,
    });

    await expect(
      repository.write(LOGICAL, RECORD, {
        anchor: { metadata: { source: "catalog", logical_address: LOGICAL } },
      }),
    ).resolves.toMatchObject({ status: "published" });
    expect(backend.anchorMetadata[0]).toEqual({
      source: "catalog",
      logical_address: LOGICAL,
      logicalAddress: LOGICAL,
      contentHash: contentHash(RECORD),
      envelopeHash: sha256Hex(canonicalize(RECORD)),
    });

    const conflicting = createBackend();
    const conflictRepository = createBoundArtifactRepository({
      contentHashOf: contentHash,
      adapter: fakeAdapter(SELLER, conflicting),
      index: createInMemoryBindingStore(),
      publisher: createInMemoryBindingStore(),
    });
    await expect(
      conflictRepository.write(LOGICAL, RECORD, {
        anchor: { metadata: { logicalAddress: "dacs1:other" } },
      }),
    ).rejects.toThrow(/conflicts with the repository logical address/);
    expect(conflicting.writes).toBe(0);
  });

  test("rejects non-canonical logical addresses before anchoring", async () => {
    const backend = createBackend();
    const bindings = createInMemoryBindingStore();
    const repository = createBoundArtifactRepository({
      contentHashOf: contentHash,
      adapter: fakeAdapter(SELLER, backend),
      index: bindings,
      publisher: bindings,
    });

    await expect(repository.write(` ${LOGICAL}`, RECORD)).rejects.toThrow(
      /trimmed and NFC-normalized/,
    );
    const decomposed = "dacs1:seller:caf\u0065\u0301:v1";
    expect(decomposed).not.toBe(decomposed.normalize("NFC"));
    await expect(repository.write(decomposed, RECORD)).rejects.toThrow(
      /trimmed and NFC-normalized/,
    );
    expect(backend.writes).toBe(0);
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
      contentHashOf: contentHash,
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

  test("publisher acknowledgement is indeterminate until the configured index can read it", async () => {
    const backend = createBackend();
    const visible = createInMemoryBindingStore();
    let acknowledged = false;
    const publisher: BindingPublisher = {
      async publish(binding) {
        const status = acknowledged ? "already-published" : "published";
        acknowledged = true;
        return { status, binding: { ...binding } };
      },
    };
    const repository = createBoundArtifactRepository({
      contentHashOf: contentHash,
      adapter: fakeAdapter(SELLER, backend),
      index: visible,
      publisher,
    });

    const pending = await repository.write(LOGICAL, RECORD);
    expect(pending).toMatchObject({
      status: "indeterminate",
      anchor: { address: "stor-1" },
      reason: expect.stringContaining("not yet visible"),
    });
    expect(backend.writes).toBe(1);

    await visible.publish(pending.binding);
    const retry = await repository.write(LOGICAL, RECORD);
    expect(retry).toMatchObject({
      status: "already-published",
      anchor: { address: "stor-1" },
    });
    expect(backend.writes).toBe(1);
  });

  test("accepts equivalent Demos owner spellings from publisher and index readback", async () => {
    const backend = createBackend();
    const key = "ab".repeat(32);
    const visible = createInMemoryBindingStore();
    const repository = createBoundArtifactRepository({
      contentHashOf: contentHash,
      adapter: fakeAdapter(`0x${key}`, backend),
      index: visible,
      publisher: {
        async publish(binding) {
          const normalized = { ...binding, owner: key };
          await visible.publish(normalized);
          return { status: "published", binding: normalized };
        },
      },
    });

    await expect(repository.write(LOGICAL, RECORD)).resolves.toMatchObject({
      status: "published",
      binding: { owner: `0x${key}` },
    });
  });

  test("publisher acknowledgement conflicts when index readback has a different tuple", async () => {
    const backend = createBackend();
    const stale = {
      logicalAddress: LOGICAL,
      nativeAddress: "stor-stale",
      owner: SELLER,
      contentHash: "stale",
    };
    const repository = createBoundArtifactRepository({
      contentHashOf: contentHash,
      adapter: fakeAdapter(SELLER, backend),
      index: createInMemoryBindingIndex([stale]),
      publisher: {
        async publish(binding) {
          return { status: "published", binding: { ...binding } };
        },
      },
    });

    expect(await repository.write(LOGICAL, RECORD)).toMatchObject({
      status: "conflict",
      anchor: { address: "stor-1" },
      existing: stale,
      reason: expect.stringContaining("does not match"),
    });
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
      contentHashOf: contentHash,
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
      contentHashOf: contentHash,
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
      contentHashOf: contentHash,
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
      contentHashOf: contentHash,
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
      contentHashOf: contentHash,
      adapter: fakeAdapter("0xreader", backend),
      index: valid,
      publisher: valid,
    });
    expect(
      (await invalidSignature.read(LOGICAL, SELLER, () => false)).status,
    ).toBe("signature-invalid");

    const transient = createBoundArtifactRepository({
      contentHashOf: contentHash,
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
      contentHashOf: contentHash,
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
