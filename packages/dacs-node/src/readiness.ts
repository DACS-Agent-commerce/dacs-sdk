import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { VERSION } from "@kynesyslabs/dacs";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import {
  canonicalDemosAgentPublicKey,
  demosAgentClaimRef,
} from "@kynesyslabs/dacs/identity";
import { FIXED_PRICE_X402_STANDARD_REVISION } from "@kynesyslabs/dacs/commerce";

import {
  DACS_NODE_LIVE_PROFILE,
  validateDacsAgentConfig,
  type DacsLiveAgentConfig,
} from "./config.js";
import type { DacsNodeReadinessStatus } from "./events.js";

const READINESS_LATCH_VERSION = "1" as const;
const READINESS_LATCH_DOMAIN = "dacs-live-readiness-latch:v1:";
const DEFAULT_READINESS_LATCH_TTL_MS = 300_000;
const MAX_READINESS_LATCH_TTL_MS = 300_000;
const READINESS_LATCH_FUTURE_SKEW_MS = 1_000;
const MAX_READINESS_LATCH_BYTES = 16_384;
const HASH_RE = /^[0-9a-f]{64}$/;

export interface DacsRoleReadinessLatchPayloadV1 {
  latchVersion: typeof READINESS_LATCH_VERSION;
  operation: "start";
  role: "buyer" | "seller";
  authority: string;
  sdkVersion: typeof VERSION;
  standardRevision: typeof FIXED_PRICE_X402_STANDARD_REVISION;
  profile: typeof DACS_NODE_LIVE_PROFILE;
  configHash: string;
  prerequisiteReportHash: string;
  issuedAt: number;
  expiresAt: number;
}

export interface DacsRoleReadinessLatchRecordV1 {
  payload: Readonly<DacsRoleReadinessLatchPayloadV1>;
  signature: string;
}

export type DacsRoleReadinessLatchSignerV1 = (
  bytes: Uint8Array,
) => Promise<Uint8Array> | Uint8Array;

export interface DacsRoleReadinessLatchV1 {
  readonly filePath: string;
  readonly role: "buyer" | "seller";
  readonly authority: string;
  readonly configHash: string;
  readiness(): Promise<Readonly<DacsNodeReadinessStatus>>;
  commit(
    prerequisiteReportHash: string,
    sign: DacsRoleReadinessLatchSignerV1,
  ): Promise<Readonly<DacsNodeReadinessStatus>>;
  revoke(): Promise<void>;
}

export class DacsRoleReadinessLatchError extends Error {
  override readonly name = "DacsRoleReadinessLatchError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null) &&
      Reflect.ownKeys(value).every((key) => {
        if (typeof key !== "string") return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
      });
  } catch {
    return false;
  }
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) =>
    Object.hasOwn(value, key)
  );
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function exactAuthority(value: unknown): value is string {
  const publicKey = canonicalDemosAgentPublicKey(value);
  return typeof value === "string" && publicKey !== null &&
    value === demosAgentClaimRef(publicKey);
}

function canonicalBase64Url(value: unknown, length: number): value is string {
  if (typeof value !== "string" || value.includes("=") || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return false;
  }
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.byteLength === length && bytes.toString("base64url") === value;
  } catch {
    return false;
  }
}

function signedBytes(payload: Readonly<DacsRoleReadinessLatchPayloadV1>): Uint8Array {
  return new TextEncoder().encode(`${READINESS_LATCH_DOMAIN}${canonicalize(payload)}`);
}

function notReady(checkedAt: number, reasonCode: string): Readonly<DacsNodeReadinessStatus> {
  return Object.freeze({
    ready: false,
    checkedAt,
    reasonCodes: Object.freeze([reasonCode]),
  });
}

function ready(checkedAt: number): Readonly<DacsNodeReadinessStatus> {
  return Object.freeze({
    ready: true,
    checkedAt,
    reasonCodes: Object.freeze([]),
  });
}

async function safeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const observed = await lstat(path);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!observed.isDirectory() || observed.isSymbolicLink() ||
      (process.platform !== "win32" && (observed.mode & 0o077) !== 0) ||
      (currentUid !== undefined && observed.uid !== currentUid)) {
    throw new DacsRoleReadinessLatchError("readiness-directory-unsafe");
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertSafeExistingFile(path: string): Promise<void> {
  try {
    const observed = await lstat(path);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!observed.isFile() || observed.isSymbolicLink() ||
        (process.platform !== "win32" && (observed.mode & 0o777) !== 0o600) ||
        (currentUid !== undefined && observed.uid !== currentUid)) {
      throw new DacsRoleReadinessLatchError("readiness-latch-unsafe");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function atomicWrite(path: string, value: string): Promise<void> {
  const directory = dirname(path);
  await safeDirectory(directory);
  await assertSafeExistingFile(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(value, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await syncDirectory(directory);
    await assertSafeExistingFile(path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readSafeFile(path: string): Promise<string> {
  const initial = await lstat(path);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!initial.isFile() || initial.isSymbolicLink() ||
      initial.size <= 0 || initial.size > MAX_READINESS_LATCH_BYTES ||
      (process.platform !== "win32" && (initial.mode & 0o777) !== 0o600) ||
      (currentUid !== undefined && initial.uid !== currentUid)) {
    throw new DacsRoleReadinessLatchError("readiness-latch-unsafe");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const admitted = await handle.stat();
    if (!admitted.isFile() || admitted.dev !== initial.dev || admitted.ino !== initial.ino ||
        admitted.size !== initial.size ||
        (process.platform !== "win32" && (admitted.mode & 0o777) !== 0o600) ||
        (currentUid !== undefined && admitted.uid !== currentUid)) {
      throw new DacsRoleReadinessLatchError("readiness-latch-unsafe");
    }
    const content = await handle.readFile();
    try {
      if (content.byteLength !== initial.size ||
          content.byteLength > MAX_READINESS_LATCH_BYTES) {
        throw new DacsRoleReadinessLatchError("readiness-latch-unsafe");
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch (error) {
      if (error instanceof DacsRoleReadinessLatchError) throw error;
      throw new DacsRoleReadinessLatchError("readiness-latch-invalid");
    } finally {
      content.fill(0);
    }
  } finally {
    await handle.close();
  }
}

function validatePayload(
  value: unknown,
  expected: Readonly<{
    role: "buyer" | "seller";
    authority: string;
    configHash: string;
    ttlMs: number;
  }>,
): Readonly<DacsRoleReadinessLatchPayloadV1> | undefined {
  if (!plainObject(value) || !exactKeys(value, [
    "latchVersion",
    "operation",
    "role",
    "authority",
    "sdkVersion",
    "standardRevision",
    "profile",
    "configHash",
    "prerequisiteReportHash",
    "issuedAt",
    "expiresAt",
  ]) || value.latchVersion !== READINESS_LATCH_VERSION ||
      value.operation !== "start" || value.role !== expected.role ||
      value.authority !== expected.authority || value.sdkVersion !== VERSION ||
      value.standardRevision !== FIXED_PRICE_X402_STANDARD_REVISION ||
      value.profile !== DACS_NODE_LIVE_PROFILE || value.configHash !== expected.configHash ||
      typeof value.prerequisiteReportHash !== "string" ||
      !HASH_RE.test(value.prerequisiteReportHash) ||
      !safeTimestamp(value.issuedAt) || !safeTimestamp(value.expiresAt) ||
      value.expiresAt - value.issuedAt !== expected.ttlMs) {
    return undefined;
  }
  return Object.freeze({ ...value }) as Readonly<DacsRoleReadinessLatchPayloadV1>;
}

/**
 * Create the role-local readiness latch required by the live install profile.
 * The latch is not a health assertion: it is a short-lived, authenticated
 * record that the post-start supervisor has completed the exact prerequisite
 * report for this role and configuration.
 */
export function createDacsRoleReadinessLatchV1(rawOptions: Readonly<{
  config: unknown;
  authority: string;
  ttlMs?: number;
  now?: () => number;
}>): Readonly<DacsRoleReadinessLatchV1> {
  if (!plainObject(rawOptions) || !exactKeys(rawOptions, [
    "config",
    "authority",
    ...(Object.hasOwn(rawOptions, "ttlMs") ? ["ttlMs"] : []),
    ...(Object.hasOwn(rawOptions, "now") ? ["now"] : []),
  ]) || !exactAuthority(rawOptions.authority) ||
      (rawOptions.ttlMs !== undefined &&
        (!Number.isSafeInteger(rawOptions.ttlMs) || rawOptions.ttlMs <= 0 ||
          rawOptions.ttlMs > MAX_READINESS_LATCH_TTL_MS)) ||
      (rawOptions.now !== undefined && typeof rawOptions.now !== "function")) {
    throw new TypeError("readiness latch options are invalid");
  }
  const config = validateDacsAgentConfig(rawOptions.config);
  if (config.mode !== "live-demos" || config.profile !== DACS_NODE_LIVE_PROFILE ||
      (config.role !== "buyer" && config.role !== "seller")) {
    throw new TypeError("readiness latch requires a live buyer or seller configuration");
  }
  const liveConfig = config as Readonly<DacsLiveAgentConfig>;
  const role = liveConfig.role as "buyer" | "seller";
  const authority = rawOptions.authority;
  const ttlMs = rawOptions.ttlMs ?? DEFAULT_READINESS_LATCH_TTL_MS;
  const now = rawOptions.now === undefined
    ? Date.now
    : Function.prototype.bind.call(rawOptions.now, rawOptions) as () => number;
  const configHash = sha256Hex(canonicalize(liveConfig));
  const filePath = resolve(liveConfig.dataDirectory, "readiness-latch.v1.json");
  const publicKey = canonicalDemosAgentPublicKey(authority)!;
  const expected = Object.freeze({ role, authority, configHash, ttlMs });

  const readiness = async (): Promise<Readonly<DacsNodeReadinessStatus>> => {
    const checkedAt = now();
    if (!safeTimestamp(checkedAt)) {
      return notReady(0, "readiness-clock-invalid");
    }
    let text: string;
    try {
      text = await readSafeFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return notReady(checkedAt, "readiness-latch-missing");
      }
      if (error instanceof DacsRoleReadinessLatchError) {
        return notReady(checkedAt, error.reasonCode);
      }
      return notReady(checkedAt, "readiness-latch-unavailable");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return notReady(checkedAt, "readiness-latch-invalid");
    }
    let canonical = "";
    try {
      canonical = canonicalize(parsed);
    } catch {
      return notReady(checkedAt, "readiness-latch-invalid");
    }
    if (!plainObject(parsed) || !exactKeys(parsed, ["payload", "signature"]) ||
        canonical !== text || !canonicalBase64Url(parsed.signature, 64)) {
      return notReady(checkedAt, "readiness-latch-invalid");
    }
    const payload = validatePayload(parsed.payload, expected);
    if (payload === undefined) {
      return notReady(checkedAt, "readiness-latch-binding-mismatch");
    }
    if (payload.issuedAt > checkedAt + READINESS_LATCH_FUTURE_SKEW_MS) {
      return notReady(checkedAt, "readiness-latch-not-yet-valid");
    }
    if (payload.expiresAt <= checkedAt) {
      return notReady(checkedAt, "readiness-latch-expired");
    }
    let authentic = false;
    try {
      authentic = ed25519Verify(
        signedBytes(payload),
        Buffer.from(parsed.signature, "base64url"),
        publicKeyFromRaw(publicKey),
      );
    } catch {
      authentic = false;
    }
    return authentic
      ? ready(checkedAt)
      : notReady(checkedAt, "readiness-latch-signature-invalid");
  };

  return Object.freeze({
    filePath,
    role,
    authority,
    configHash,
    readiness,
    async commit(
      prerequisiteReportHash: string,
      sign: DacsRoleReadinessLatchSignerV1,
    ) {
      if (!HASH_RE.test(prerequisiteReportHash) || typeof sign !== "function") {
        throw new TypeError("readiness latch commit input is invalid");
      }
      const issuedAt = now();
      const expiresAt = issuedAt + ttlMs;
      if (!safeTimestamp(issuedAt) || !safeTimestamp(expiresAt) || expiresAt <= issuedAt) {
        throw new DacsRoleReadinessLatchError("readiness-clock-invalid");
      }
      const payload = Object.freeze({
        latchVersion: READINESS_LATCH_VERSION,
        operation: "start" as const,
        role,
        authority,
        sdkVersion: VERSION,
        standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
        profile: DACS_NODE_LIVE_PROFILE,
        configHash,
        prerequisiteReportHash,
        issuedAt,
        expiresAt,
      });
      let signature: Uint8Array;
      try {
        signature = Uint8Array.from(await sign(signedBytes(payload)));
      } catch {
        throw new DacsRoleReadinessLatchError("readiness-latch-signing-failed");
      }
      if (signature.byteLength !== 64) {
        signature.fill(0);
        throw new DacsRoleReadinessLatchError("readiness-latch-signature-invalid");
      }
      const record = Object.freeze({
        payload,
        signature: Buffer.from(signature).toString("base64url"),
      });
      signature.fill(0);
      try {
        await atomicWrite(filePath, canonicalize(record));
      } catch (error) {
        if (error instanceof DacsRoleReadinessLatchError) throw error;
        throw new DacsRoleReadinessLatchError("readiness-latch-write-failed");
      }
      const result = await readiness();
      if (!result.ready) {
        throw new DacsRoleReadinessLatchError(result.reasonCodes[0]!);
      }
      return result;
    },
    async revoke() {
      try {
        await rm(filePath, { force: true });
        await syncDirectory(dirname(filePath));
      } catch {
        throw new DacsRoleReadinessLatchError("readiness-latch-revoke-failed");
      }
    },
  });
}
