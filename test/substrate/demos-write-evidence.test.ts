import { describe, expect, it } from "vitest";

import {
  canonicalize,
  contentHash,
  decodeDemosAnchorReceiptProof,
  demosSignedTransactionProofHash,
  demosWriteEvidenceToAnchorReceipt,
  sha256Hex,
} from "../../src/index.js";
import type { DemosWriteEvidence } from "../../src/substrate/index.js";
import { demosTransactionContentMatches } from "../../src/substrate/demosWriteEvidence.js";

const artifact = { hello: "world" };
const artifactHash = contentHash(artifact);
const signedTransaction = canonicalize({
  hash: "tx-abc",
  content: {
    type: "storageProgram",
    from: "0xabc",
    to: "stor-abc",
    nonce: 7,
    data: ["storageProgram", {
      operation: "CREATE_STORAGE_PROGRAM",
      storageAddress: "stor-abc",
      programName: "dacs%3Atest%3Av1",
      encoding: "json",
      data: artifact,
    }],
  },
});
const finalityProof = canonicalize({ signatures: ["validator-signature"] });
const evidence: DemosWriteEvidence = {
  evidenceVersion: "1",
  chainIdentity: "genesis-hash",
  writer: "0xabc",
  logicalName: "dacs:test:v1",
  nativeAddress: "stor-abc",
  operation: "create",
  nonce: 7,
  transactionRef: "tx-abc",
  signedTransaction,
  signedTransactionHash: demosSignedTransactionProofHash(
    JSON.parse(signedTransaction) as unknown,
  ),
  blockNumber: 42,
  blockHash: "block-hash",
  blockTimestamp: 120,
  finalityProof,
  finalityProofHash: sha256Hex(finalityProof),
  nativeRead: {
    owner: "0xabc",
    programName: "dacs%3Atest%3Av1",
    valueHash: artifactHash,
    observedAt: 123,
  },
};

describe("Demos portable write evidence", () => {
  it("uses one proof hash for signed and canonical Demos wire projections", () => {
    const signed = {
      hash: "tx-abc",
      signature: "signature",
      content: {
        type: "storageProgram",
        nonce: 7,
        timestamp: 123,
        amount: 0,
        transaction_fee: {
          network_fee: 1,
          rpc_fee: 2,
          additional_fee: 0,
        },
        gcr_edits: [{ amount: 3, txhash: "" }],
      },
    };
    const canonicalProjection = {
      ...signed,
      attrs: { executionOnly: true },
      ed25519_signature: "",
      content: {
        ...signed.content,
        nonce: "7",
        timestamp: "123",
        amount: "0",
        transaction_fee: {
          network_fee: "1",
          rpc_fee: "2",
          additional_fee: "0",
        },
        gcr_edits: [{ amount: "3", txhash: "tx-abc" }],
      },
    };

    expect(demosSignedTransactionProofHash(canonicalProjection)).toBe(
      demosSignedTransactionProofHash(signed),
    );
    expect(demosTransactionContentMatches(
      signed.content,
      canonicalProjection.content,
      signed.hash,
    )).toBe(true);
    expect(demosTransactionContentMatches(
      canonicalProjection.content,
      canonicalProjection.content,
      signed.hash,
    )).toBe(true);
    expect(demosSignedTransactionProofHash({
      ...canonicalProjection,
      content: {
        ...canonicalProjection.content,
        amount: "1",
      },
    })).not.toBe(demosSignedTransactionProofHash(signed));
    expect(demosSignedTransactionProofHash({
      ...canonicalProjection,
      content: {
        ...canonicalProjection.content,
        gcr_edits: [{ amount: "3", txhash: "different-tx" }],
      },
    })).not.toBe(demosSignedTransactionProofHash(signed));
  });

  it("projects only adapter-authenticated transaction and block facts", () => {
    expect(demosWriteEvidenceToAnchorReceipt({
      logicalAddress: "dacs:test:v1",
      contentHash: artifactHash,
      writer: "did:demos:agent:abc",
      evidence,
    })).toMatchObject({
      finalityProfile: "demos-bft-confirmed-native-read",
      nativeAddress: "stor-abc",
      nonce: "7",
      transactionRef: { value: "tx-abc" },
      blockRef: { id: "block-hash", height: "42", timestamp: 120 },
      evidence: { kind: "demos-bft-write-proof-v1" },
    });
  });

  it("round-trips canonical self-contained evidence", () => {
    const receipt = demosWriteEvidenceToAnchorReceipt({
      logicalAddress: "dacs:test:v1",
      contentHash: artifactHash,
      writer: "did:demos:agent:abc",
      evidence,
    });
    expect(receipt.evidence.value).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(receipt.evidence.value.length).toBeLessThan(1_000);
    expect(decodeDemosAnchorReceiptProof(receipt)).toMatchObject({
      proofVersion: "1",
      chainIdentity: evidence.chainIdentity,
      writer: evidence.writer,
      signedTransactionHash: evidence.signedTransactionHash,
      finalityProofHash: evidence.finalityProofHash,
    });
    expect(() => decodeDemosAnchorReceiptProof({
      ...receipt,
      writer: "did:demos:agent:attacker",
    })).toThrow(/does not bind/);
  });

  it("rejects content or owner provenance mismatches", () => {
    expect(() => demosWriteEvidenceToAnchorReceipt({
      logicalAddress: "dacs:test:v1",
      contentHash: "wrong",
      writer: "did:demos:agent:abc",
      evidence,
    })).toThrow(/does not match/);
    expect(() => demosWriteEvidenceToAnchorReceipt({
      logicalAddress: "dacs:test:v1",
      contentHash: artifactHash,
      writer: "did:demos:agent:abc",
      evidence: {
        ...evidence,
        nativeRead: { ...evidence.nativeRead, owner: "0xattacker" },
      },
    })).toThrow(/does not bind/);
  });

  it("binds a normative signed-scope hash through persisted envelope metadata", () => {
    const normativeHash = "12".repeat(32);
    const metadata = {
      logicalAddress: evidence.logicalName,
      contentHash: normativeHash,
      envelopeHash: artifactHash,
    };
    const signed = JSON.parse(signedTransaction) as {
      content: { data: [string, Record<string, unknown>] };
    };
    signed.content.data[1].metadata = metadata;
    const signedWithMetadata = canonicalize(signed);
    const evidenceWithMetadata: DemosWriteEvidence = {
      ...evidence,
      signedTransaction: signedWithMetadata,
      signedTransactionHash: demosSignedTransactionProofHash(signed),
      nativeRead: {
        ...evidence.nativeRead,
        metadataHash: contentHash(metadata),
      },
    };

    const receipt = demosWriteEvidenceToAnchorReceipt({
      logicalAddress: evidence.logicalName,
      contentHash: normativeHash,
      writer: "did:demos:agent:abc",
      evidence: evidenceWithMetadata,
    });
    expect(receipt.contentHash).toBe(normativeHash);
    expect(decodeDemosAnchorReceiptProof(receipt).nativeRead.valueHash).toBe(
      artifactHash,
    );
    expect(() => demosWriteEvidenceToAnchorReceipt({
      logicalAddress: evidence.logicalName,
      contentHash: "34".repeat(32),
      writer: "did:demos:agent:abc",
      evidence: evidenceWithMetadata,
    })).toThrow(/does not match/);
  });

  it("rejects tampered signed or finality proof material", () => {
    expect(() => demosWriteEvidenceToAnchorReceipt({
      logicalAddress: "dacs:test:v1",
      contentHash: artifactHash,
      writer: "did:demos:agent:abc",
      evidence: {
        ...evidence,
        signedTransaction: signedTransaction.replace("tx-abc", "tx-abd"),
      },
    })).toThrow(/invalid proof hash/);
    expect(() => demosWriteEvidenceToAnchorReceipt({
      logicalAddress: "dacs:test:v1",
      contentHash: artifactHash,
      writer: "did:demos:agent:abc",
      evidence: { ...evidence, finalityProofHash: "tampered" },
    })).toThrow(/invalid proof hash/);
  });
});
