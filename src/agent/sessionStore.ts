/**
 * The version 1 session record format, as far as the generation-fenced
 * filesystem store needs it. That store scans existing files and recognises a
 * version 1 file, so the file still counts as holding its agreement; loading it
 * reports `unsupported` and never upgrades it. No version 1 store is
 * implemented or exported from the package.
 */

/** The `storeVersion` of a version 1 session record. */
export const SESSION_STORE_VERSION = 1 as const;

/** An immutable reference receipt for a recorded session side effect. */
interface SessionReceipt {
  kind: "agreement" | "settlement" | "delivery" | "fulfilment" | "bundle";
  /** Content hash / tx hash / anchor address — the audit pointer. */
  ref: string;
  recordedAt?: number;
}

const RECEIPT_KINDS = new Set<SessionReceipt["kind"]>([
  "agreement",
  "settlement",
  "delivery",
  "fulfilment",
  "bundle",
]);

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function unexpectedKey(
  value: Record<string, unknown>,
  allowed: readonly string[],
): string | undefined {
  const allowedSet = new Set(allowed);
  return Object.keys(value).find((key) => !allowedSet.has(key));
}

function checkpointShapeViolation(value: unknown): string | null {
  if (!isPlainRecord(value)) return "checkpoint must be an object";
  const extra = unexpectedKey(value, ["key", "stage", "data"]);
  if (extra) return `checkpoint.${extra} is not a v1 field`;
  if (typeof value.key !== "string" || value.key.length === 0) {
    return "checkpoint.key must be a non-empty string";
  }
  if (value.stage !== "intent" && value.stage !== "outcome") {
    return "checkpoint.stage must be intent or outcome";
  }
  if (value.data !== undefined) {
    if (!isPlainRecord(value.data)) return "checkpoint.data must be an object";
    for (const [key, item] of Object.entries(value.data)) {
      const type = typeof item;
      if (
        type !== "string" &&
        type !== "boolean" &&
        !isFiniteNumber(item)
      ) {
        return `checkpoint.data.${key} must be a string, boolean, or finite number`;
      }
    }
  }
  return null;
}

function receiptShapeViolation(value: unknown): string | null {
  if (!isPlainRecord(value)) return "receipt must be an object";
  const extra = unexpectedKey(value, ["kind", "ref", "recordedAt"]);
  if (extra) return `receipt.${extra} is not a v1 field`;
  if (!RECEIPT_KINDS.has(value.kind as SessionReceipt["kind"])) {
    return "receipt.kind is invalid";
  }
  if (typeof value.ref !== "string" || value.ref.length === 0) {
    return "receipt.ref must be a non-empty string";
  }
  if (value.recordedAt !== undefined && !isFiniteNumber(value.recordedAt)) {
    return "receipt.recordedAt must be a finite number";
  }
  return null;
}

/**
 * Validate a complete version 1 session record read from disk. The fenced
 * filesystem store calls it when it scans existing files, so a valid version 1
 * file still counts as holding its agreement.
 * Returns the first problem found, or `null` when the record is valid.
 */
export function sessionRecordShapeViolation(value: unknown): string | null {
  if (!isPlainRecord(value)) return "session record must be an object";
  const extra = unexpectedKey(value, [
    "storeVersion",
    "jobId",
    "agreementHash",
    "phase",
    "revision",
    "lease",
    "checkpoints",
    "receipts",
    "createdAt",
    "updatedAt",
  ]);
  if (extra) return `${extra} is not a v1 session-record field`;
  if (value.storeVersion !== SESSION_STORE_VERSION) {
    return "storeVersion does not match this reader";
  }
  if (typeof value.jobId !== "string" || value.jobId.length === 0) {
    return "jobId missing or not a non-empty string";
  }
  if (
    value.agreementHash !== undefined &&
    (typeof value.agreementHash !== "string" || value.agreementHash.length === 0)
  ) {
    return "agreementHash must be a non-empty string when present";
  }
  if (typeof value.phase !== "string" || value.phase.length === 0) {
    return "phase missing or not a non-empty string";
  }
  if (
    !Number.isInteger(value.revision) ||
    (value.revision as number) < 0
  ) {
    return "revision must be a non-negative integer";
  }
  if (!isFiniteNumber(value.createdAt)) return "createdAt must be a finite number";
  if (!isFiniteNumber(value.updatedAt)) return "updatedAt must be a finite number";
  if (value.lease !== undefined) {
    if (!isPlainRecord(value.lease)) return "lease must be an object";
    const leaseExtra = unexpectedKey(value.lease, ["owner", "expiresAt"]);
    if (leaseExtra) return `lease.${leaseExtra} is not a v1 field`;
    if (
      typeof value.lease.owner !== "string" ||
      value.lease.owner.length === 0
    ) {
      return "lease.owner must be a non-empty string";
    }
    if (!isFiniteNumber(value.lease.expiresAt)) {
      return "lease.expiresAt must be a finite number";
    }
  }
  if (!Array.isArray(value.checkpoints)) return "checkpoints missing or not an array";
  for (let index = 0; index < value.checkpoints.length; index++) {
    const violation = checkpointShapeViolation(value.checkpoints[index]);
    if (violation) return `checkpoints[${index}]: ${violation}`;
  }
  if (!Array.isArray(value.receipts)) return "receipts missing or not an array";
  for (let index = 0; index < value.receipts.length; index++) {
    const violation = receiptShapeViolation(value.receipts[index]);
    if (violation) return `receipts[${index}]: ${violation}`;
  }
  return null;
}
