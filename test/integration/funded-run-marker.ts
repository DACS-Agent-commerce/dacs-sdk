import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { canonicalize, sha256Hex } from "../../src/canonical/index.js";

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_DETAIL_KEYS = 32;
const MAX_DETAIL_STRING_LENGTH = 4_096;
const MAX_INTENT_BYTES = 65_536;
const SENSITIVE_KEY_RE =
  /secret|mnemonic|private.?key|seed|password|credential|auth.?token|access.?token|wallet/i;
const OUTCOME_STATUSES = new Set<FundedRunOutcomeStatus>([
  "included",
  "unresolved",
  "delivery-complete",
  "audit-complete",
  "not-completed",
  "ambiguous",
]);

export type FundedRunPublicDetail = string | number | boolean | null;

export interface FundedRunIntent {
  /** Existing durable directory, owned by this process uid with mode 0700. */
  directory: string;
  operation: string;
  runId: string;
  /** Public reconciliation facts only. Never pass wallet secrets or private keys. */
  details: Readonly<Record<string, FundedRunPublicDetail>>;
}

export interface ArmedFundedRun {
  markerId: string;
  markerPath: string;
  outcomePath: string;
}

export type FundedRunOutcomeStatus =
  | "included"
  | "unresolved"
  | "delivery-complete"
  | "audit-complete"
  | "not-completed"
  | "ambiguous";

export interface FundedRunOutcome {
  /** A diagnostic observation label, not independent settlement or DACS proof. */
  status: FundedRunOutcomeStatus;
  details?: Readonly<Record<string, FundedRunPublicDetail>>;
}

interface CapturedFundedRunIntent {
  directory: string;
  operation: string;
  runId: string;
  details: Record<string, FundedRunPublicDetail>;
}

interface SecureMarkerDirectory {
  directory: string;
  handle: FileHandle;
  stat: Stats;
}

function plainDataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && "value" in descriptor &&
      descriptor.value !== undefined;
  });
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function captureDetails(value: unknown, code: string): Record<string, FundedRunPublicDetail> {
  if (!plainDataRecord(value) || Object.keys(value).length > MAX_DETAIL_KEYS) {
    throw new Error(`funded-e2e:${code}-not-plain`);
  }
  const captured: Record<string, FundedRunPublicDetail> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!SAFE_ID_RE.test(key)) throw new Error(`funded-e2e:${code}-key-invalid`);
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw new Error(`funded-e2e:${code}-key-invalid`);
    }
    if (SENSITIVE_KEY_RE.test(key)) throw new Error(`funded-e2e:${code}-sensitive-key`);
    if (item !== null && typeof item !== "string" && typeof item !== "number" &&
        typeof item !== "boolean") {
      throw new Error(`funded-e2e:${code}-value-invalid`);
    }
    if (typeof item === "number" && !Number.isSafeInteger(item)) {
      throw new Error(`funded-e2e:${code}-number-invalid`);
    }
    if (typeof item === "string" && item.length > MAX_DETAIL_STRING_LENGTH) {
      throw new Error(`funded-e2e:${code}-string-too-long`);
    }
    captured[key] = item;
  }
  return captured;
}

function captureIntent(value: unknown): CapturedFundedRunIntent {
  if (!plainDataRecord(value) ||
      !exactKeys(value, ["directory", "operation", "runId", "details"]) ||
      typeof value.directory !== "string" || !isAbsolute(value.directory) ||
      typeof value.operation !== "string" || !SAFE_ID_RE.test(value.operation) ||
      typeof value.runId !== "string" || !SAFE_ID_RE.test(value.runId)) {
    if (plainDataRecord(value) && typeof value.directory === "string" &&
        !isAbsolute(value.directory)) {
      throw new Error("funded-e2e:marker-directory-must-be-absolute");
    }
    if (plainDataRecord(value) && typeof value.operation === "string" &&
        !SAFE_ID_RE.test(value.operation)) {
      throw new Error("funded-e2e:marker-operation-invalid");
    }
    if (plainDataRecord(value) && typeof value.runId === "string" &&
        !SAFE_ID_RE.test(value.runId)) {
      throw new Error("funded-e2e:run-id-invalid");
    }
    throw new Error("funded-e2e:marker-intent-invalid");
  }
  return {
    directory: value.directory,
    operation: value.operation,
    runId: value.runId,
    details: captureDetails(value.details, "marker-details"),
  };
}

function captureNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("funded-e2e:timestamp-invalid");
  }
  return value;
}

function pathComponents(path: string): string[] {
  const root = parse(path).root;
  const components = [root];
  let current = root;
  for (const component of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, component);
    components.push(current);
  }
  return components;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === "" ||
    (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function requirePosixUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("funded-e2e:marker-platform-unsupported");
  return uid;
}

async function inspectSecureMarkerDirectory(directory: string, uid: number): Promise<Stats> {
  let target: Stats | undefined;
  const components = pathComponents(directory);
  for (const [index, component] of components.entries()) {
    let stat: Stats;
    try {
      stat = await lstat(component);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") {
        throw new Error("funded-e2e:marker-directory-must-exist", { cause });
      }
      throw cause;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("funded-e2e:marker-directory-unsafe");
    }
    if (stat.uid !== 0 && stat.uid !== uid) {
      throw new Error("funded-e2e:marker-directory-owner-unsafe");
    }

    const permissions = stat.mode & 0o777;
    const isTarget = index === components.length - 1;
    if (isTarget) {
      if (stat.uid !== uid || permissions !== 0o700) {
        throw new Error("funded-e2e:marker-directory-must-be-private");
      }
      target = stat;
      continue;
    }

    const trustedStickyDirectory =
      (stat.uid === 0 || stat.uid === uid) && (stat.mode & 0o1000) !== 0;
    if ((permissions & 0o022) !== 0 && !trustedStickyDirectory) {
      throw new Error("funded-e2e:marker-directory-ancestor-writable");
    }
  }

  const canonical = await realpath(directory);
  if (canonical !== directory) {
    throw new Error("funded-e2e:marker-directory-realpath-drift");
  }
  for (const candidate of [tmpdir(), "/tmp", "/var/tmp", "/run", "/dev/shm"]) {
    try {
      const volatileRoot = await realpath(candidate);
      if (pathIsWithin(volatileRoot, directory)) {
        throw new Error("funded-e2e:marker-directory-must-be-persistent");
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code !== "ENOENT") throw cause;
    }
  }
  if (!target) throw new Error("funded-e2e:marker-directory-unsafe");
  return target;
}

async function openSecureMarkerDirectory(input: string): Promise<SecureMarkerDirectory> {
  const directory = resolve(input);
  const uid = requirePosixUid();
  const initial = await inspectSecureMarkerDirectory(directory, uid);
  let handle: FileHandle;
  try {
    handle = await open(
      directory,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
  } catch (cause) {
    if (["ELOOP", "ENOTDIR"].includes((cause as NodeJS.ErrnoException)?.code ?? "")) {
      throw new Error("funded-e2e:marker-directory-unsafe", { cause });
    }
    throw cause;
  }
  try {
    const opened = await handle.stat();
    const checked = await inspectSecureMarkerDirectory(directory, uid);
    if (!sameFile(initial, opened) || !sameFile(opened, checked)) {
      throw new Error("funded-e2e:marker-directory-realpath-drift");
    }
    return { directory, handle, stat: opened };
  } catch (cause) {
    await handle.close();
    throw cause;
  }
}

async function syncAndConfirmMarkerDirectory(state: SecureMarkerDirectory): Promise<void> {
  const uid = requirePosixUid();
  const before = await inspectSecureMarkerDirectory(state.directory, uid);
  const opened = await state.handle.stat();
  if (!sameFile(state.stat, opened) || !sameFile(opened, before)) {
    throw new Error("funded-e2e:marker-directory-realpath-drift");
  }
  await state.handle.sync();
  const after = await inspectSecureMarkerDirectory(state.directory, uid);
  if (!sameFile(opened, after)) {
    throw new Error("funded-e2e:marker-directory-realpath-drift");
  }
}

async function writeExclusive(
  path: string,
  value: Readonly<Record<string, unknown>>,
): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${canonicalize(value)}\n`, "utf8");
    await handle.sync();
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== requirePosixUid() || (stat.mode & 0o777) !== 0o600) {
      throw new Error("funded-e2e:marker-file-unsafe");
    }
  } finally {
    await handle.close();
  }
}

async function verifyIntentMarker(
  markerPath: string,
  markerId: string,
): Promise<void> {
  const uid = requirePosixUid();
  const before = await lstat(markerPath);
  if (before.isSymbolicLink() || !before.isFile() || before.uid !== uid ||
      (before.mode & 0o777) !== 0o600 || before.size > MAX_INTENT_BYTES) {
    throw new Error("funded-e2e:intent-marker-unsafe");
  }
  let handle: FileHandle;
  try {
    handle = await open(markerPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (cause) {
    throw new Error("funded-e2e:intent-marker-unsafe", { cause });
  }
  try {
    const opened = await handle.stat();
    if (!sameFile(before, opened)) throw new Error("funded-e2e:intent-marker-drift");
    const encoded = await handle.readFile("utf8");
    const after = await lstat(markerPath);
    if (!sameFile(opened, after)) throw new Error("funded-e2e:intent-marker-drift");
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded);
    } catch (cause) {
      throw new Error("funded-e2e:intent-marker-corrupt", { cause });
    }
    if (!plainDataRecord(parsed) ||
        !exactKeys(parsed, [
          "markerVersion",
          "operation",
          "runId",
          "markerId",
          "details",
          "state",
          "armedAt",
        ]) ||
        parsed.markerVersion !== "1" || parsed.markerId !== markerId ||
        parsed.state !== "armed" || typeof parsed.operation !== "string" ||
        !SAFE_ID_RE.test(parsed.operation) || typeof parsed.runId !== "string" ||
        !SAFE_ID_RE.test(parsed.runId) || !Number.isSafeInteger(parsed.armedAt) ||
        (parsed.armedAt as number) < 0) {
      throw new Error("funded-e2e:intent-marker-corrupt");
    }
    captureDetails(parsed.details, "stored-marker-details");
    const expectedId = sha256Hex(canonicalize({
      markerVersion: "1",
      operation: parsed.operation,
      runId: parsed.runId,
    }));
    if (expectedId !== markerId || encoded !== `${canonicalize(parsed)}\n`) {
      throw new Error("funded-e2e:intent-marker-corrupt");
    }
  } finally {
    await handle.close();
  }
}

/**
 * Permanently arm one funded attempt before its first irreversible call.
 *
 * The marker identity deliberately excludes wallets, amount and other mutable
 * details. Reusing an operation/run-id pair in the same directory therefore
 * fails before another write even if configuration changes after an ambiguous
 * result. The durable directory is the guard domain: it must remain on the
 * execution host, already exist, be owned by this process uid with mode 0700,
 * and contain no symlink components. A separately approved attempt needs a
 * fresh run id and, for a payment test, fresh dedicated wallets.
 */
export async function armFundedRun(
  input: Readonly<FundedRunIntent>,
  now = Date.now,
): Promise<Readonly<ArmedFundedRun>> {
  const captured = captureIntent(input);
  const armedAt = captureNow(now);
  const secureDirectory = await openSecureMarkerDirectory(resolve(captured.directory));
  try {
    const identity = {
      markerVersion: "1",
      operation: captured.operation,
      runId: captured.runId,
    } as const;
    const markerId = sha256Hex(canonicalize(identity));
    const markerPath = join(secureDirectory.directory, `${markerId}.intent.json`);
    const outcomePath = join(secureDirectory.directory, `${markerId}.outcome.json`);
    try {
      await writeExclusive(markerPath, {
        ...identity,
        markerId,
        details: captured.details,
        state: "armed",
        armedAt,
      });
      await syncAndConfirmMarkerDirectory(secureDirectory);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code === "EEXIST") {
        throw new Error(`funded-e2e:run-already-armed:${markerId}`, { cause });
      }
      throw cause;
    }
    return Object.freeze({ markerId, markerPath, outcomePath });
  } finally {
    await secureDirectory.handle.close();
  }
}

/** Arm durably, then and only then invoke the caller's irreversible operation. */
export async function executeFundedRun<T>(
  input: Readonly<FundedRunIntent>,
  operation: (marker: Readonly<ArmedFundedRun>) => Promise<T>,
  now = Date.now,
): Promise<Readonly<{ marker: Readonly<ArmedFundedRun>; result: T }>> {
  const marker = await armFundedRun(input, now);
  try {
    const result = await operation(marker);
    return Object.freeze({ marker, result });
  } catch (cause) {
    throw new Error(`funded-e2e:effect-ambiguous-do-not-rerun:${marker.markerId}`, { cause });
  }
}

/** Record the first observed outcome without replacing either marker file. */
export async function recordFundedRunOutcome(
  marker: Readonly<ArmedFundedRun>,
  outcome: Readonly<FundedRunOutcome>,
  now = Date.now,
): Promise<void> {
  if (!plainDataRecord(marker) ||
      !exactKeys(marker, ["markerId", "markerPath", "outcomePath"]) ||
      typeof marker.markerId !== "string" || !HASH_RE.test(marker.markerId) ||
      typeof marker.markerPath !== "string" || typeof marker.outcomePath !== "string") {
    throw new Error("funded-e2e:marker-invalid");
  }
  if (!plainDataRecord(outcome) ||
      !exactKeys(outcome, ["status"], ["details"]) ||
      typeof outcome.status !== "string" ||
      !OUTCOME_STATUSES.has(outcome.status as FundedRunOutcomeStatus)) {
    throw new Error("funded-e2e:outcome-invalid");
  }
  const details = captureDetails(outcome.details ?? {}, "outcome-details");
  const recordedAt = captureNow(now);
  const directory = dirname(marker.markerPath);
  const expectedMarkerPath = join(directory, `${marker.markerId}.intent.json`);
  const expectedOutcomePath = join(directory, `${marker.markerId}.outcome.json`);
  if (!isAbsolute(directory) || directory !== resolve(directory) ||
      marker.markerPath !== expectedMarkerPath ||
      marker.outcomePath !== expectedOutcomePath) {
    throw new Error("funded-e2e:marker-path-invalid");
  }

  const secureDirectory = await openSecureMarkerDirectory(directory);
  try {
    await verifyIntentMarker(marker.markerPath, marker.markerId);
    try {
      await writeExclusive(marker.outcomePath, {
        markerVersion: "1",
        markerId: marker.markerId,
        state: outcome.status,
        details,
        recordedAt,
      });
      await syncAndConfirmMarkerDirectory(secureDirectory);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code === "EEXIST") {
        throw new Error(`funded-e2e:outcome-already-recorded:${marker.markerId}`, { cause });
      }
      throw cause;
    }
  } finally {
    await secureDirectory.handle.close();
  }
}
