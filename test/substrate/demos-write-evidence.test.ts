import { describe, expect, it } from "vitest";

import {
  assertDemosWriteEvidence,
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
      finalityProfile: "demos-bft-final",
      nativeAddress: "stor-abc",
      nonce: "7",
      transactionRef: { value: "tx-abc" },
      blockRef: { id: "block-hash", height: "42", timestamp: 120 },
      evidence: { kind: "demos-bft-write-proof-v1" },
    });
  });

  it("names the DEMOS-MAPPING finality profile and accepts no other", () => {
    // DEMOS-MAPPING §A.2 defines the Demos profile as `demos-bft-final`; the
    // SDK's own proof format is carried by evidence.kind (CORE SR2-6).
    const receipt = demosWriteEvidenceToAnchorReceipt({
      logicalAddress: "dacs:test:v1",
      contentHash: artifactHash,
      writer: "did:demos:agent:abc",
      evidence,
    });
    expect(receipt.finalityProfile).toBe("demos-bft-final");
    expect(decodeDemosAnchorReceiptProof(receipt).chainIdentity).toBe(
      evidence.chainIdentity,
    );
    for (const finalityProfile of [
      "demos-bft-confirmed-native-read",
      "demos-bft-final ",
      "DEMOS-BFT-FINAL",
      "evm-block-depth",
    ]) {
      expect(
        () => decodeDemosAnchorReceiptProof({ ...receipt, finalityProfile }),
        finalityProfile,
      ).toThrow("AnchorReceipt does not contain Demos write evidence");
    }
  });

  // CORE SR2-6/SR2-9 and DEMOS-MAPPING §A.2: only an established, finalized
  // receipt version "1" with the Demos kinds, a nonce and a full blockRef is
  // Demos write evidence. Each row changes one member of a valid receipt.
  it.each<[string, (receipt: Record<string, any>) => void]>([
    ["receiptVersion \"2\"", (receipt) => { receipt.receiptVersion = "2"; }],
    ["another substrate", (receipt) => { receipt.substrate = "test:final"; }],
    ["state included", (receipt) => { receipt.state = "included"; }],
    ["state accepted", (receipt) => { receipt.state = "accepted"; }],
    ["an indeterminate observation", (receipt) => {
      receipt.observationDisposition = "indeterminate";
    }],
    ["another transactionRef kind", (receipt) => { receipt.transactionRef.kind = "demos"; }],
    ["another evidence kind", (receipt) => { receipt.evidence.kind = "demos-bft-proof"; }],
    ["no nonce", (receipt) => { delete receipt.nonce; }],
    ["a non-decimal nonce", (receipt) => { receipt.nonce = "07"; }],
    ["no blockRef", (receipt) => { delete receipt.blockRef; }],
    ["no blockRef height", (receipt) => { delete receipt.blockRef.height; }],
    ["a non-decimal blockRef height", (receipt) => { receipt.blockRef.height = "4.2"; }],
    ["no blockRef timestamp", (receipt) => { delete receipt.blockRef.timestamp; }],
    ["an empty blockRef id", (receipt) => { receipt.blockRef.id = ""; }],
  ])("refuses a Demos receipt with %s", (_label, mutate) => {
    const receipt = demosWriteEvidenceToAnchorReceipt({
      logicalAddress: "dacs:test:v1",
      contentHash: artifactHash,
      writer: "did:demos:agent:abc",
      evidence,
    }) as unknown as Record<string, any>;
    expect(() => decodeDemosAnchorReceiptProof(receipt as never)).not.toThrow();
    mutate(receipt);
    expect(() => decodeDemosAnchorReceiptProof(receipt as never))
      .toThrow("AnchorReceipt does not contain Demos write evidence");
  });

  it("refuses an unsupported Demos evidence version", () => {
    expect(() => assertDemosWriteEvidence(evidence)).not.toThrow();
    expect(() => assertDemosWriteEvidence({ ...evidence, evidenceVersion: "2" as "1" }))
      .toThrow("Demos write evidence has invalid fields");
  });

  it("refuses an unsupported Demos proof version", () => {
    const receipt = demosWriteEvidenceToAnchorReceipt({
      logicalAddress: "dacs:test:v1",
      contentHash: artifactHash,
      writer: "did:demos:agent:abc",
      evidence,
    });
    const proof = JSON.parse(Buffer.from(receipt.evidence.value, "base64url").toString("utf8"));
    expect(proof.proofVersion).toBe("1");
    proof.proofVersion = "2";
    expect(() => decodeDemosAnchorReceiptProof({
      ...receipt,
      evidence: {
        ...receipt.evidence,
        value: Buffer.from(canonicalize(proof), "utf8").toString("base64url"),
      },
    })).toThrow("Demos write evidence does not bind its AnchorReceipt");
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
