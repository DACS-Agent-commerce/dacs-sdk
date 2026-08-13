import type { AnchorReceipt } from "../artifacts/types.js";
import {
  canonicalize,
  logicalToStorageProgramName,
  sha256Hex,
} from "../canonical/index.js";
import { DacsError } from "../errors.js";
import type { DemosWriteEvidence } from "./SubstrateAdapter.js";

export interface DemosPortableAnchorReceiptInput {
  logicalAddress: string;
  contentHash: string;
  /** Protocol identity already authenticated as controlling evidence.writer. */
  writer: string;
  evidence: DemosWriteEvidence;
}

export interface DemosAnchorReceiptProof {
  proofVersion: "1";
  chainIdentity: string;
  writer: string;
  operation: "create" | "update";
  signedTransactionHash: string;
  finalityProofHash: string;
  nativeRead: {
    programName: string;
    /** Hash of the exact JSON stored by the native StorageProgram. */
    valueHash: string;
    metadataHash?: string;
    observedAt: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function protocolWriterControlsDemosAddress(
  protocolWriter: string,
  demosWriter: string,
): boolean {
  const normalizedWriter = demosWriter.toLowerCase();
  const did = `did:demos:agent:${normalizedWriter.replace(/^0x/, "")}`;
  return protocolWriter.toLowerCase() === normalizedWriter ||
    protocolWriter.toLowerCase() === did;
}

function parseCanonicalJson(value: string, label: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
    if (canonicalize(parsed) !== value) throw new Error();
  } catch {
    throw new DacsError(`${label} is not canonical JSON`);
  }
  return parsed;
}

function exactJsonHash(value: Record<string, unknown>): string {
  return sha256Hex(canonicalize(value));
}

function normalizeDemosWireInteger(value: unknown): unknown {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    return value;
  }
  return value;
}

/** Normalize only Demos' documented signed→executed JSON projection fields. */
function normalizedDemosTransactionContent(
  content: Record<string, unknown>,
  expectedTxRef: string,
): Record<string, unknown> {
  const normalized = JSON.parse(canonicalize(content)) as Record<string, unknown>;
  for (const field of ["nonce", "timestamp", "amount"] as const) {
    if (field in normalized) {
      normalized[field] = normalizeDemosWireInteger(normalized[field]);
    }
  }
  if (isRecord(normalized.transaction_fee)) {
    for (const field of ["network_fee", "rpc_fee", "additional_fee"] as const) {
      if (field in normalized.transaction_fee) {
        normalized.transaction_fee[field] = normalizeDemosWireInteger(
          normalized.transaction_fee[field],
        );
      }
    }
  }
  if (Array.isArray(normalized.gcr_edits)) {
    normalized.gcr_edits = normalized.gcr_edits.map((edit) => {
      if (!isRecord(edit)) return edit;
      return {
        ...edit,
        ...("amount" in edit
          ? { amount: normalizeDemosWireInteger(edit.amount) }
          : {}),
        ...(edit.txhash === "" || edit.txhash === expectedTxRef
          ? { txhash: "<demos-execution-txhash>" }
          : {}),
      };
    });
  }
  return normalized;
}

/** Return bounded field paths that differ outside the permitted projection. */
export function demosTransactionContentDifferencePaths(
  signed: Record<string, unknown>,
  canonical: Record<string, unknown>,
  expectedTxRef: string,
): string[] {
  const differences: string[] = [];
  const compare = (left: unknown, right: unknown, path: string): void => {
    if (differences.length >= 8 || Object.is(left, right)) return;
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
        differences.push(path);
        return;
      }
      for (let index = 0; index < left.length; index += 1) {
        compare(left[index], right[index], `${path}[${index}]`);
      }
      return;
    }
    if (isRecord(left) || isRecord(right)) {
      if (!isRecord(left) || !isRecord(right)) {
        differences.push(path);
        return;
      }
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
      for (const key of keys) compare(left[key], right[key], `${path}.${key}`);
      return;
    }
    differences.push(path);
  };
  compare(
    normalizedDemosTransactionContent(signed, expectedTxRef),
    normalizedDemosTransactionContent(canonical, expectedTxRef),
    "content",
  );
  const signedEdits = Array.isArray(signed.gcr_edits) ? signed.gcr_edits : [];
  const canonicalEdits = Array.isArray(canonical.gcr_edits)
    ? canonical.gcr_edits
    : [];
  if (signedEdits.length === canonicalEdits.length) {
    for (let index = 0; index < signedEdits.length; index += 1) {
      const signedEdit = signedEdits[index];
      const canonicalEdit = canonicalEdits[index];
      if (!isRecord(signedEdit) || !isRecord(canonicalEdit)) continue;
      const signedHasTxHash = "txhash" in signedEdit;
      const canonicalHasTxHash = "txhash" in canonicalEdit;
      if (
        signedHasTxHash !== canonicalHasTxHash ||
        (signedHasTxHash &&
          (canonicalEdit.txhash !== expectedTxRef ||
            (signedEdit.txhash !== "" && signedEdit.txhash !== expectedTxRef)))
      ) {
        differences.push(`content.gcr_edits[${index}].txhash`);
        if (differences.length >= 8) break;
      }
    }
  }
  return differences;
}

export function demosTransactionContentMatches(
  signed: Record<string, unknown>,
  canonical: Record<string, unknown>,
  expectedTxRef: string,
): boolean {
  return demosTransactionContentDifferencePaths(
    signed,
    canonical,
    expectedTxRef,
  ).length === 0;
}

/** Hash the stable signed fields that a confirmed transaction retains. */
export function demosSignedTransactionProofHash(value: unknown): string {
  if (!isRecord(value) || !nonEmpty(value.hash) || !isRecord(value.content)) {
    throw new DacsError("Demos signed transaction proof has invalid fields");
  }
  const projection: Record<string, unknown> = {
    hash: value.hash,
    content: normalizedDemosTransactionContent(value.content, value.hash),
  };
  // The live node materializes an empty compatibility carrier even when the
  // signed SDK envelope omitted it. Empty is not signature material; any
  // non-empty dual signature remains part of the proof hash.
  if (nonEmpty(value.ed25519_signature)) {
    projection.ed25519_signature = value.ed25519_signature;
  }
  if (Object.hasOwn(value, "signature")) {
    projection.signature = value.signature;
  }
  return sha256Hex(canonicalize(projection));
}

/**
 * Validate the self-contained bindings in adapter-produced Demos evidence.
 * Network finality is re-authenticated separately by DemosAdapter.
 */
export function assertDemosWriteEvidence(
  evidence: Readonly<DemosWriteEvidence>,
): void {
  if (
    !isRecord(evidence) ||
    evidence.evidenceVersion !== "1" ||
    !nonEmpty(evidence.chainIdentity) ||
    !nonEmpty(evidence.writer) ||
    !nonEmpty(evidence.logicalName) ||
    !nonEmpty(evidence.nativeAddress) ||
    (evidence.operation !== "create" && evidence.operation !== "update") ||
    !nonNegativeInteger(evidence.nonce) ||
    !nonEmpty(evidence.transactionRef) ||
    !nonEmpty(evidence.signedTransaction) ||
    !nonEmpty(evidence.signedTransactionHash) ||
    !nonNegativeInteger(evidence.blockNumber) ||
    !nonEmpty(evidence.blockHash) ||
    !nonNegativeInteger(evidence.blockTimestamp) ||
    !nonEmpty(evidence.finalityProof) ||
    !nonEmpty(evidence.finalityProofHash) ||
    !isRecord(evidence.nativeRead) ||
    !nonEmpty(evidence.nativeRead.owner) ||
    !nonEmpty(evidence.nativeRead.programName) ||
    !nonEmpty(evidence.nativeRead.valueHash) ||
    !nonNegativeInteger(evidence.nativeRead.observedAt)
  ) {
    throw new DacsError("Demos write evidence has invalid fields");
  }
  const signed = parseCanonicalJson(
    evidence.signedTransaction,
    "Demos signed transaction evidence",
  );
  parseCanonicalJson(evidence.finalityProof, "Demos finality evidence");
  if (demosSignedTransactionProofHash(signed) !== evidence.signedTransactionHash) {
    throw new DacsError(
      "Demos write evidence has an invalid proof hash (signed transaction)",
    );
  }
  if (sha256Hex(evidence.finalityProof) !== evidence.finalityProofHash) {
    throw new DacsError(
      "Demos write evidence has an invalid proof hash (finality)",
    );
  }
  if (!isRecord(signed) || signed.hash !== evidence.transactionRef) {
    throw new DacsError("Demos signed transaction does not bind its transaction ref");
  }
  const transaction = isRecord(signed.content) ? signed.content : undefined;
  const tuple = Array.isArray(transaction?.data) ? transaction.data : [];
  const payload = isRecord(tuple[1]) ? tuple[1] : undefined;
  const expectedOperation = evidence.operation === "create"
    ? "CREATE_STORAGE_PROGRAM"
    : "WRITE_STORAGE";
  const expectedProgramName = logicalToStorageProgramName(evidence.logicalName);
  if (
    transaction?.type !== "storageProgram" ||
    typeof transaction.from !== "string" ||
    transaction.from.toLowerCase() !== evidence.writer.toLowerCase() ||
    transaction.to !== evidence.nativeAddress ||
    normalizeDemosWireInteger(transaction.nonce) !== String(evidence.nonce) ||
    tuple[0] !== "storageProgram" ||
    payload?.operation !== expectedOperation ||
    payload.storageAddress !== evidence.nativeAddress ||
    payload.encoding !== "json" ||
    !isRecord(payload.data) ||
    exactJsonHash(payload.data) !== evidence.nativeRead.valueHash ||
    (evidence.operation === "create" && payload.programName !== expectedProgramName) ||
    evidence.nativeRead.owner.toLowerCase() !== evidence.writer.toLowerCase() ||
    evidence.nativeRead.programName !== expectedProgramName
  ) {
    throw new DacsError("Demos signed transaction does not bind its native write");
  }
  const metadataHash = payload.metadata === undefined
    ? undefined
    : isRecord(payload.metadata)
      ? exactJsonHash(payload.metadata)
      : null;
  if (metadataHash === null || metadataHash !== evidence.nativeRead.metadataHash) {
    throw new DacsError("Demos signed transaction does not bind its metadata");
  }
}

/**
 * Bind a protocol content hash to the exact native JSON write. Most artifacts
 * use the raw JCS hash directly. Artifacts with a normative signed-scope hash
 * (for example AttestationBundle) carry that hash and the raw envelope hash in
 * the transaction's signed, natively persisted metadata.
 */
export function demosWriteEvidenceBindsReceiptContent(
  evidence: Readonly<DemosWriteEvidence>,
  logicalAddress: string,
  receiptContentHash: string,
): boolean {
  if (!evidence.nativeRead || !nonEmpty(logicalAddress) ||
      !nonEmpty(receiptContentHash)) return false;
  if (evidence.nativeRead.valueHash === receiptContentHash) return true;

  let signed: unknown;
  try {
    signed = parseCanonicalJson(
      evidence.signedTransaction,
      "Demos signed transaction evidence",
    );
  } catch {
    return false;
  }
  const transaction = isRecord(signed) && isRecord(signed.content)
    ? signed.content
    : undefined;
  const tuple = Array.isArray(transaction?.data) ? transaction.data : [];
  const payload = isRecord(tuple[1]) ? tuple[1] : undefined;
  const metadata = isRecord(payload?.metadata) ? payload.metadata : undefined;
  return metadata?.logicalAddress === logicalAddress &&
    metadata.contentHash === receiptContentHash &&
    metadata.envelopeHash === evidence.nativeRead.valueHash;
}

/**
 * Project adapter-authenticated Demos evidence into a self-contained portable
 * CORE §5.1 receipt. The evidence payload uses canonical, unpadded Base64URL.
 */
export function demosWriteEvidenceToAnchorReceipt(
  input: DemosPortableAnchorReceiptInput,
): AnchorReceipt {
  assertDemosWriteEvidence(input.evidence);
  if (
    input.evidence.logicalName !== input.logicalAddress ||
    !demosWriteEvidenceBindsReceiptContent(
      input.evidence,
      input.logicalAddress,
      input.contentHash,
    ) ||
    !protocolWriterControlsDemosAddress(input.writer, input.evidence.writer)
  ) {
    throw new DacsError(
      "Demos write evidence does not match the requested portable receipt",
    );
  }
  const observedAt = input.evidence.nativeRead.observedAt;
  const proof: DemosAnchorReceiptProof = {
    proofVersion: "1",
    chainIdentity: input.evidence.chainIdentity,
    writer: input.evidence.writer,
    operation: input.evidence.operation,
    signedTransactionHash: input.evidence.signedTransactionHash,
    finalityProofHash: input.evidence.finalityProofHash,
    nativeRead: {
      programName: input.evidence.nativeRead.programName,
      valueHash: input.evidence.nativeRead.valueHash,
      ...(input.evidence.nativeRead.metadataHash === undefined
        ? {}
        : { metadataHash: input.evidence.nativeRead.metadataHash }),
      observedAt,
    },
  };
  const encodedEvidence = Buffer.from(
    canonicalize(proof),
    "utf8",
  ).toString("base64url");
  return {
    receiptVersion: "1",
    substrate: "demos",
    finalityProfile: "demos-bft-confirmed-native-read",
    logicalAddress: input.logicalAddress,
    nativeAddress: input.evidence.nativeAddress,
    contentHash: input.contentHash,
    transactionRef: {
      kind: "demos-storage-program",
      value: input.evidence.transactionRef,
    },
    writer: input.writer,
    nonce: String(input.evidence.nonce),
    state: "finalized",
    observationDisposition: "established",
    observedAt,
    blockRef: {
      id: input.evidence.blockHash,
      height: String(input.evidence.blockNumber),
      timestamp: input.evidence.blockTimestamp,
    },
    evidence: {
      kind: "demos-bft-write-proof-v1",
      value: encodedEvidence,
    },
  };
}

/** Decode and validate the compact Demos proof descriptor in a receipt. */
export function decodeDemosAnchorReceiptProof(
  receipt: Readonly<AnchorReceipt>,
): DemosAnchorReceiptProof {
  if (
    receipt.receiptVersion !== "1" ||
    receipt.substrate !== "demos" ||
    receipt.finalityProfile !== "demos-bft-confirmed-native-read" ||
    receipt.state !== "finalized" ||
    receipt.observationDisposition !== "established" ||
    !nonEmpty(receipt.logicalAddress) ||
    !nonEmpty(receipt.nativeAddress) ||
    !nonEmpty(receipt.contentHash) ||
    receipt.transactionRef.kind !== "demos-storage-program" ||
    !nonEmpty(receipt.transactionRef.value) ||
    !nonEmpty(receipt.writer) ||
    receipt.nonce === undefined ||
    !/^(0|[1-9][0-9]*)$/.test(receipt.nonce) ||
    !Number.isSafeInteger(Number(receipt.nonce)) ||
    !nonNegativeInteger(receipt.observedAt) ||
    !isRecord(receipt.blockRef) ||
    !nonEmpty(receipt.blockRef.id) ||
    receipt.blockRef.height === undefined ||
    !/^(0|[1-9][0-9]*)$/.test(receipt.blockRef.height) ||
    !Number.isSafeInteger(Number(receipt.blockRef.height)) ||
    !nonNegativeInteger(receipt.blockRef.timestamp) ||
    receipt.evidence.kind !== "demos-bft-write-proof-v1"
  ) {
    throw new DacsError("AnchorReceipt does not contain Demos write evidence");
  }
  const bytes = Buffer.from(receipt.evidence.value, "base64url");
  if (bytes.toString("base64url") !== receipt.evidence.value) {
    throw new DacsError("Demos write evidence is not canonical Base64URL");
  }
  let proof: unknown;
  try {
    const json = bytes.toString("utf8");
    proof = JSON.parse(json) as unknown;
    if (canonicalize(proof) !== json) throw new Error();
  } catch {
    throw new DacsError("Demos write evidence is not canonical JSON");
  }
  if (!isRecord(proof) || !isRecord(proof.nativeRead)) {
    throw new DacsError("Demos AnchorReceipt proof has invalid fields");
  }
  const nativeRead = proof.nativeRead;
  if (
    proof.proofVersion !== "1" ||
    !nonEmpty(proof.chainIdentity) ||
    !nonEmpty(proof.writer) ||
    (proof.operation !== "create" && proof.operation !== "update") ||
    !nonEmpty(proof.signedTransactionHash) ||
    !nonEmpty(proof.finalityProofHash) ||
    !protocolWriterControlsDemosAddress(receipt.writer, proof.writer) ||
    !nonEmpty(nativeRead.programName) ||
    !nonEmpty(nativeRead.valueHash) ||
    (nativeRead.metadataHash !== undefined && !nonEmpty(nativeRead.metadataHash)) ||
    nativeRead.observedAt !== receipt.observedAt ||
    nativeRead.programName !== logicalToStorageProgramName(receipt.logicalAddress)
  ) {
    throw new DacsError("Demos write evidence does not bind its AnchorReceipt");
  }
  return structuredClone(proof) as unknown as DemosAnchorReceiptProof;
}
