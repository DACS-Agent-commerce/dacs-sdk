import { randomBytes } from "node:crypto";

import { DacsError } from "../errors.js";

const CANONICAL_JOB_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_ULID_TIME = 0xffff_ffff_ffff;

/** CORE §B.1 canonical 26-character uppercase Crockford-Base32 ULID. */
export function isCanonicalJobId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_JOB_ID.test(value);
}

/** Reject alternate spellings instead of silently changing an idempotency key. */
export function requireCanonicalJobId(value: unknown, label = "jobId"): string {
  if (!isCanonicalJobId(value)) {
    throw new DacsError(`${label} must be a canonical uppercase ULID`);
  }
  return value;
}

export interface GenerateCanonicalJobIdOptions {
  /** Unix milliseconds. Defaults to the local clock. */
  timestamp?: number;
  /** Exactly ten random bytes. Supplying this is intended for deterministic tests. */
  entropy?: Uint8Array;
}

/** Generate a normative ULID for a new DACS session. */
export function generateCanonicalJobId(
  options: GenerateCanonicalJobIdOptions = {},
): string {
  const timestamp = options.timestamp ?? Date.now();
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    timestamp > MAX_ULID_TIME
  ) {
    throw new DacsError("ULID timestamp must be a 48-bit unix-ms integer");
  }
  const entropy = options.entropy ?? randomBytes(10);
  if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 10) {
    throw new DacsError("ULID entropy must contain exactly 10 bytes");
  }

  let randomness = 0n;
  for (const byte of Uint8Array.from(entropy)) {
    randomness = (randomness << 8n) | BigInt(byte);
  }
  let encoded = (BigInt(timestamp) << 80n) | randomness;

  let output = "";
  for (let index = 0; index < 26; index += 1) {
    output = CROCKFORD_BASE32[Number(encoded & 31n)]! + output;
    encoded >>= 5n;
  }
  return output;
}
