import { describe, expect, it } from "vitest";

import {
  assertDemosWriteEvidence,
  canonicalize,
  contentHash,
  DacsError,
  decodeDemosAnchorReceiptProof,
  demosSignedTransactionProofHash,
  demosWriteEvidenceToAnchorReceipt,
  NonFinalDemosEvidenceError,
  sha256Hex,
} from "../../src/index.js";
import * as root from "../../src/index.js";
import type { DemosWriteEvidence } from "../../src/substrate/index.js";
import * as substrate from "../../src/substrate/index.js";
import {
  demosTransactionContentDifferencePaths,
  demosTransactionContentMatches,
} from "../../src/substrate/demosWriteEvidence.js";

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

describe("Demos transaction content comparison", () => {
  it.each([
    ["", ""],
    ["", "tx-abc"],
    ["tx-abc", ""],
    ["tx-abc", "tx-abc"],
  ])("accepts signed txhash %j and canonical txhash %j", (signedHash, canonicalHash) => {
    const signed = { gcr_edits: [{ type: "nonce", amount: 1, txhash: signedHash }] };
    const canonical = { gcr_edits: [{ type: "nonce", amount: 1, txhash: canonicalHash }] };

    expect(demosTransactionContentDifferencePaths(signed, canonical, "tx-abc")).toEqual([]);
    expect(demosTransactionContentMatches(signed, canonical, "tx-abc")).toBe(true);
  });

  it.each([
    ["another canonical hash", { txhash: "" }, { txhash: "other-tx" }],
    ["a missing canonical key", { txhash: "" }, {}],
    ["a missing signed key and an empty canonical hash", {}, { txhash: "" }],
    ["a missing signed key and the canonical transaction hash", {}, { txhash: "tx-abc" }],
    ["a numeric canonical hash", { txhash: "" }, { txhash: 1 }],
    ["a null canonical hash", { txhash: "" }, { txhash: null }],
    ["another signed hash", { txhash: "other-tx" }, { txhash: "" }],
    ["matching unrelated hashes", { txhash: "other-tx" }, { txhash: "other-tx" }],
  ])("rejects %s at the edit's txhash path", (_label, signedEdit, canonicalEdit) => {
    const signed = { gcr_edits: [signedEdit] };
    const canonical = { gcr_edits: [canonicalEdit] };

    expect(demosTransactionContentDifferencePaths(signed, canonical, "tx-abc"))
      .toContain("content.gcr_edits[0].txhash");
    expect(demosTransactionContentMatches(signed, canonical, "tx-abc")).toBe(false);
  });

  it("still compares the other edit fields exactly", () => {
    const signed = { gcr_edits: [{ type: "nonce", amount: 1, txhash: "" }] };
    const canonical = { gcr_edits: [{ type: "balance", amount: 1, txhash: "tx-abc" }] };

    expect(demosTransactionContentDifferencePaths(signed, canonical, "tx-abc"))
      .toEqual(["content.gcr_edits[0].type"]);
    expect(demosTransactionContentMatches(signed, canonical, "tx-abc")).toBe(false);
  });
});

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

  it("exports the signed-content matcher from the root and substrate entry points", () => {
    const content = JSON.parse(signedTransaction).content;
    expect(root.demosTransactionContentMatches).toBe(demosTransactionContentMatches);
    expect(substrate.demosTransactionContentMatches).toBe(demosTransactionContentMatches);
    expect(root.demosTransactionContentMatches(content, content, "tx-abc")).toBe(true);
    expect(root.demosTransactionContentMatches(content, { ...content, nonce: 8 }, "tx-abc")).toBe(false);
  });
});

describe("Demos write evidence JSON diagnostics", () => {
  const thrownBy = (candidate: DemosWriteEvidence): unknown => {
    try {
      assertDemosWriteEvidence(candidate);
    } catch (error) {
      return error;
    }
    throw new Error("Expected Demos write evidence validation to fail");
  };

  it("preserves JSON parser and canonicalizer errors as causes", () => {
    const invalidJson = thrownBy({ ...evidence, signedTransaction: "{" });
    expect(invalidJson).toBeInstanceOf(DacsError);
    expect(invalidJson).toMatchObject({ message: "Demos signed transaction evidence is not canonical JSON" });
    expect((invalidJson as DacsError).cause).toBeInstanceOf(SyntaxError);

    const invalidCanonicalValue = thrownBy({
      ...evidence,
      signedTransaction: "{\"value\":\"\\ud800\"}",
    });
    expect(invalidCanonicalValue).toBeInstanceOf(DacsError);
    expect((invalidCanonicalValue as DacsError).cause).toMatchObject({ code: "canonical.unicode_invalid" });
  });

  it("does not attach a fabricated cause to valid but noncanonical JSON", () => {
    const noncanonical = thrownBy({
      ...evidence,
      signedTransaction: '{ "hash": "tx-abc" }',
    });
    expect(noncanonical).toBeInstanceOf(DacsError);
    expect(noncanonical).toMatchObject({ message: "Demos signed transaction evidence is not canonical JSON" });
    expect((noncanonical as DacsError).cause).toBeUndefined();
  });

  it("preserves finality proof parsing errors as causes", () => {
    const invalidFinality = thrownBy({ ...evidence, finalityProof: "{" });
    expect(invalidFinality).toBeInstanceOf(DacsError);
    expect(invalidFinality).toMatchObject({ message: "Demos finality evidence is not canonical JSON" });
    expect((invalidFinality as DacsError).cause).toBeInstanceOf(SyntaxError);
  });
});

describe("Demos write evidence that is not final", () => {
  const portableInput = (candidate: DemosWriteEvidence) => ({
    logicalAddress: "dacs:test:v1",
    contentHash: artifactHash,
    writer: "did:demos:agent:abc",
    evidence: candidate,
  });
  const fixtureLabelled: DemosWriteEvidence = {
    ...evidence,
    state: "included",
    finalityProfile: "simulated-fixture-inclusion-only",
  };

  it("refuses evidence labelled as simulated fixture inclusion", () => {
    expect(() => demosWriteEvidenceToAnchorReceipt(portableInput(fixtureLabelled)))
      .toThrow(NonFinalDemosEvidenceError);
    expect(() => demosWriteEvidenceToAnchorReceipt(portableInput(fixtureLabelled)))
      .toThrow(/not final/);
  });

  it.each([
    ["a state other than finalized", { state: "included" }],
    ["a finality profile other than Demos BFT", { finalityProfile: "simulated-fixture-inclusion-only" }],
  ] as const)("refuses evidence carrying %s", (_name, labels) => {
    expect(() => demosWriteEvidenceToAnchorReceipt(portableInput({ ...evidence, ...labels })))
      .toThrow(NonFinalDemosEvidenceError);
  });

  it("refuses non-final evidence in the evidence assertion too", () => {
    expect(() => assertDemosWriteEvidence(fixtureLabelled))
      .toThrow(NonFinalDemosEvidenceError);
    expect(substrate.NonFinalDemosEvidenceError).toBe(NonFinalDemosEvidenceError);
  });

  it("types the refusal as a permanent SDK error", () => {
    expect.assertions(2);
    try {
      demosWriteEvidenceToAnchorReceipt(portableInput(fixtureLabelled));
    } catch (error) {
      expect(error).toBeInstanceOf(DacsError);
      expect((error as DacsError).category).toBe("permanent");
    }
  });

  it("still converts evidence explicitly labelled final", () => {
    expect(demosWriteEvidenceToAnchorReceipt(portableInput({
      ...evidence,
      state: "finalized",
      finalityProfile: "demos-bft-confirmed-native-read",
    }))).toMatchObject({ state: "finalized" });
  });

  it("keeps refusing a decoded receipt that carries the fixture labels", () => {
    const receipt = demosWriteEvidenceToAnchorReceipt(portableInput(evidence));
    expect(() => decodeDemosAnchorReceiptProof({
      ...receipt,
      substrate: "demos-sr2-simulated-fixture",
      finalityProfile: "simulated-fixture-inclusion-only",
      state: "included",
      evidence: { ...receipt.evidence, kind: "demos-sr2-simulated-fixture-proof-v1" },
    })).toThrow(/does not contain Demos write evidence/);
  });
});


describe("Demos write evidence program-name support", () => {
  it("explains the SDK naming restriction for an otherwise bound alternate name", () => {
    const alternate = structuredClone(evidence);
    const signed = JSON.parse(alternate.signedTransaction);
    signed.content.data[1].programName = "other-implementation-deliverable";
    alternate.nativeRead!.programName = signed.content.data[1].programName;
    alternate.signedTransaction = canonicalize(signed);
    alternate.signedTransactionHash = demosSignedTransactionProofHash(signed);
    expect(() => assertDemosWriteEvidence(alternate))
      .toThrow(/only SDK-derived program names are supported/);
  });
  it.each(["no storage payload", "missing program name", "non-string program name"])(
    "does not attribute %s to unsupported naming",
    (cause) => {
      const invalid = structuredClone(evidence);
      const signed = JSON.parse(invalid.signedTransaction);
      if (cause === "no storage payload") {
        signed.content.data = [];
      } else if (cause === "missing program name") {
        delete signed.content.data[1].programName;
      } else {
        signed.content.data[1].programName = 42;
      }
      invalid.signedTransaction = canonicalize(signed);
      invalid.signedTransactionHash = demosSignedTransactionProofHash(signed);
      expect(() => assertDemosWriteEvidence(invalid))
        .toThrow(/^Demos signed transaction does not bind its native write$/);
    },
  );
  it("explains an alternate payload name when the native read name is SDK-derived", () => {
    const invalid = structuredClone(evidence);
    const signed = JSON.parse(invalid.signedTransaction);
    signed.content.data[1].programName = "other-implementation-deliverable";
    invalid.signedTransaction = canonicalize(signed);
    invalid.signedTransactionHash = demosSignedTransactionProofHash(signed);
    expect(() => assertDemosWriteEvidence(invalid))
      .toThrow(/only SDK-derived program names are supported/);
  });
  it.each(["create", "update"] as const)(
    "explains an alternate native read name for %s evidence",
    (operation) => {
      const invalid = structuredClone(evidence);
      invalid.operation = operation;
      const signed = JSON.parse(invalid.signedTransaction);
      if (operation === "update") {
        signed.content.data[1].operation = "WRITE_STORAGE";
        delete signed.content.data[1].programName;
      }
      invalid.signedTransaction = canonicalize(signed);
      invalid.signedTransactionHash = demosSignedTransactionProofHash(signed);
      expect(() => assertDemosWriteEvidence(invalid)).not.toThrow();
      invalid.nativeRead!.programName = "other-implementation-deliverable";
      expect(() => assertDemosWriteEvidence(invalid))
        .toThrow(/only SDK-derived program names are supported/);
    },
  );
  it("continues accepting the SDK-derived program name", () => {
    expect(() => assertDemosWriteEvidence(evidence)).not.toThrow();
  });
});
