import { admittedFixture } from "../helpers/admitted.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  attestationAddress,
  canonicalize,
  contentHash,
  logicalToStorageProgramName,
  ratingAddress,
  sha256Hex,
} from "../../src/canonical/index.js";
import { canonicalizeWireJson } from "../../src/canonical/jcs.js";
import {
  createBoundArtifactRepository,
  createInMemoryBindingStore,
  createScanningArtifactRepository,
} from "../../src/discovery/index.js";
import {
  createDemosHistoryPageFetcher,
  createInMemoryDemosWriteJournal,
  DemosAdapter,
} from "../../src/substrate/index.js";
import {
  assertDemosWriteEvidence,
  decodeDemosAnchorReceiptProof,
  demosSignedTransactionProofHash,
  demosTransactionContentMatches,
  demosWriteEvidenceToAnchorReceipt,
} from "../../src/substrate/demosWriteEvidence.js";

const OWNER = `0x${"a".repeat(64)}`;
const NATIVE = `stor-${"1".repeat(40)}`;
const JOB = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const RATER = "stor-cred:demo:\u0301x";
const KEYS = [
  ratingAddress(JOB, RATER),
  attestationAddress(JOB, "stor-cred", "demo:\u0301x", 1),
];

function fixture() {
  const journal = createInMemoryDemosWriteJournal();
  const adapter = new DemosAdapter({
    rpc: "https://metadata-fixture.test", chainIdentity: "test-chain", writeJournal: journal,
  });
  Object.assign(adapter, { connected: true });
  vi.spyOn(adapter.raw, "getAddress").mockReturnValue(OWNER);
  const sign = vi.spyOn(adapter.raw.storagePrograms, "sign")
    .mockRejectedValue(new Error("stop before signing"));
  const confirm = vi.spyOn(adapter.raw.tx, "confirm");
  const broadcast = vi.spyOn(adapter.raw.tx, "broadcast");
  return { adapter, journal, sign, confirm, broadcast };
}

afterEach(() => vi.restoreAllMocks());

describe("Demos transport metadata preserves encoded logical keys", () => {
  test.each(KEYS)("anchors and discovers exact metadata for %s", async (logicalAddress) => {
    expect(logicalAddress.normalize("NFC")).not.toBe(logicalAddress);
    const { adapter, journal, sign, confirm, broadcast } = fixture();
    vi.spyOn(adapter, "resolveAnchorByName").mockResolvedValue({ status: "absent" });
    vi.spyOn(adapter as unknown as { nextAnchorNonce(): Promise<number> }, "nextAnchorNonce")
      .mockResolvedValue(1);
    const bindings = createInMemoryBindingStore();
    const repository = createBoundArtifactRepository({ adapter, index: bindings, publisher: bindings });
    const artifact = { public: "synthetic artifact" };

    await expect(repository.write(logicalAddress, artifact)).rejects.toThrow("stop before signing");
    const payload = sign.mock.calls[0]![0] as unknown as {
      storageAddress: string; metadata: Record<string, unknown>;
    };
    expect(payload.metadata.logicalAddress).toBe(logicalAddress);
    expect(confirm).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    const lease = await journal.acquire({ chainIdentity: "test-chain", wallet: OWNER });
    expect(lease.snapshot.records).toHaveLength(1);
    expect(lease.snapshot.records[0]).toMatchObject({
      logicalName: logicalAddress,
      metadataHash: sha256Hex(canonicalizeWireJson(payload.metadata)),
    });
    await lease.release();

    // Consume the actual adapter's CREATE metadata through the history parser
    // and the independently keyed binding store. No wallet operation is run.
    await bindings.publish({
      logicalAddress, nativeAddress: payload.storageAddress, owner: OWNER,
      contentHash: contentHash(artifact),
    });
    const history = [{
      hash: "public-create-row", status: "confirmed", blockNumber: 42,
      content: {
        type: "storageProgram", from: OWNER, to: payload.storageAddress, timestamp: "123",
        data: ["storageProgram", payload],
      },
    }];
    const scanner = createScanningArtifactRepository({
      adapter: {
        getAddress: () => OWNER,
        anchorWriteOnce: adapter.anchorWriteOnce.bind(adapter),
        readAnchor: async () => admittedFixture(artifact),
      },
      index: bindings, publisher: bindings, expectedOwner: OWNER,
      fetchPage: createDemosHistoryPageFetcher({
        getTransactionHistory: async (_owner, _type, { start, limit }) => history.slice(start, start + limit),
      }, OWNER),
      verifyArtifact: () => true,
    });
    const page = await scanner.scanPage();
    expect(page.status).toBe("page");
    expect(page.results).toHaveLength(1);
    expect(page.results[0]).toMatchObject({
      anchor: { logicalAddress }, outcome: { status: "verified", record: artifact },
    });
  });

  test("an immutable retry rejects an NFC alias of the requested metadata", async () => {
    const { adapter, sign } = fixture();
    const logicalAddress = KEYS[0]!;
    vi.spyOn(adapter, "resolveAnchorByName").mockResolvedValue({ status: "present", address: NATIVE });
    const read = vi.spyOn(adapter.raw.storagePrograms, "read").mockResolvedValue({
      success: true, data: { public: true }, metadata: { logicalAddress: logicalAddress.normalize("NFC") },
    } as never);
    await expect(adapter.anchorWriteOnce(logicalToStorageProgramName(logicalAddress), { public: true }, {
      metadata: { logicalAddress },
    })).rejects.toThrow(/different descriptive metadata/);
    read.mockResolvedValue({ success: true, data: { public: true }, metadata: { logicalAddress } } as never);
    await expect(adapter.anchorWriteOnce(logicalToStorageProgramName(logicalAddress), { public: true }, {
      metadata: { logicalAddress },
    })).resolves.toEqual({ address: NATIVE });
    expect(sign).not.toHaveBeenCalled();
  });

  test("retained transaction and receipt identities distinguish NFC aliases", () => {
    const logicalAddress = KEYS[0]!;
    const programName = logicalToStorageProgramName(logicalAddress);
    const data = { public: true, note: "cafe\u0301" };
    const metadata = { logicalAddress, contentHash: contentHash(data), envelopeHash: contentHash(data) };
    const signed = {
      hash: "public-tx", content: {
        type: "storageProgram", from: OWNER, to: NATIVE, nonce: 1,
        data: ["storageProgram", {
          operation: "CREATE_STORAGE_PROGRAM", storageAddress: NATIVE, programName,
          encoding: "json", data, metadata,
        }],
      },
    };
    const alias = JSON.parse(canonicalize(signed)) as typeof signed;
    expect(demosSignedTransactionProofHash(alias)).not.toBe(demosSignedTransactionProofHash(signed));
    expect(demosTransactionContentMatches(signed.content, alias.content, signed.hash)).toBe(false);
    const finalityProof = canonicalizeWireJson({ signatures: ["public-validator-fixture"] });
    const evidence = {
      evidenceVersion: "1" as const, chainIdentity: "test-chain", writer: OWNER, logicalName: logicalAddress,
      nativeAddress: NATIVE, operation: "create" as const, nonce: 1, transactionRef: signed.hash,
      signedTransaction: canonicalizeWireJson(signed), signedTransactionHash: demosSignedTransactionProofHash(signed),
      blockNumber: 42, blockHash: "public-block", blockTimestamp: 120,
      finalityProof, finalityProofHash: sha256Hex(finalityProof),
      nativeRead: {
        owner: OWNER, programName, valueHash: contentHash(data),
        metadataHash: sha256Hex(canonicalizeWireJson(metadata)), observedAt: 123,
      },
    };
    expect(() => assertDemosWriteEvidence(evidence)).not.toThrow();
    const receipt = demosWriteEvidenceToAnchorReceipt({ logicalAddress, contentHash: contentHash(data), writer: OWNER, evidence });
    expect(receipt.logicalAddress).toBe(logicalAddress);
    expect(decodeDemosAnchorReceiptProof(receipt).nativeRead.programName).toBe(programName);
    expect(() => assertDemosWriteEvidence({
      ...evidence, nativeRead: { ...evidence.nativeRead, metadataHash: sha256Hex(canonicalize(metadata)) },
    })).toThrow();
  });
});
