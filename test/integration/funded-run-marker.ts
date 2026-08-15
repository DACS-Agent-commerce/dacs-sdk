import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { types as nodeTypes } from "node:util";

import { canonicalize, sha256Hex } from "../../src/canonical/index.js";

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_DETAIL_KEYS = 32;
const MAX_DETAIL_STRING_LENGTH = 4_096;
const MAX_MARKER_BYTES = 65_536;
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
  /** Operator-retained POSIX directory, owned by this process uid with mode 0700. */
  directory: string;
  /** Public identifier only; it is persisted in the intent marker. */
  operation: string;
  /** Public identifier only; it is persisted in the intent marker. */
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

interface CapturedArmedFundedRun {
  markerId: string;
  markerPath: string;
  outcomePath: string;
}

interface CapturedFundedRunOutcome {
  status: FundedRunOutcomeStatus;
  details: Record<string, FundedRunPublicDetail>;
}

interface SecureMarkerDirectory {
  directory: string;
  handle: FileHandle;
  stat: Stats;
}

/**
 * Take one shallow snapshot without invoking caller getters or retaining the
 * caller's record. Proxies are rejected explicitly: their descriptor traps can
 * otherwise return different values between validation and use.
 */
function snapshotPlainDataRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      nodeTypes.isProxy(value)) return undefined;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) return undefined;

    const snapshot: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !("value" in descriptor) ||
          descriptor.value === undefined) return undefined;
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return snapshot;
  } catch {
    return undefined;
  }
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
  const snapshot = snapshotPlainDataRecord(value);
  if (!snapshot || Object.keys(snapshot).length > MAX_DETAIL_KEYS) {
    throw new Error(`funded-e2e:${code}-not-plain`);
  }
  const captured: Record<string, FundedRunPublicDetail> = {};
  for (const [key, item] of Object.entries(snapshot)) {
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
  const snapshot = snapshotPlainDataRecord(value);
  if (!snapshot || !exactKeys(snapshot, ["directory", "operation", "runId", "details"])) {
    throw new Error("funded-e2e:marker-intent-invalid");
  }
  const { directory, operation, runId, details } = snapshot;
  if (typeof directory !== "string" || !isAbsolute(directory) ||
      typeof operation !== "string" || !SAFE_ID_RE.test(operation) ||
      typeof runId !== "string" || !SAFE_ID_RE.test(runId)) {
    if (typeof directory === "string" && !isAbsolute(directory)) {
      throw new Error("funded-e2e:marker-directory-must-be-absolute");
    }
    if (typeof operation === "string" && !SAFE_ID_RE.test(operation)) {
      throw new Error("funded-e2e:marker-operation-invalid");
    }
    if (typeof runId === "string" && !SAFE_ID_RE.test(runId)) {
      throw new Error("funded-e2e:run-id-invalid");
    }
    throw new Error("funded-e2e:marker-intent-invalid");
  }
  return {
    directory,
    operation,
    runId,
    details: captureDetails(details, "marker-details"),
  };
}

function captureMarker(value: unknown): CapturedArmedFundedRun {
  const snapshot = snapshotPlainDataRecord(value);
  if (!snapshot || !exactKeys(snapshot, ["markerId", "markerPath", "outcomePath"]) ||
      typeof snapshot.markerId !== "string" || !HASH_RE.test(snapshot.markerId) ||
      typeof snapshot.markerPath !== "string" || typeof snapshot.outcomePath !== "string") {
    throw new Error("funded-e2e:marker-invalid");
  }
  return {
    markerId: snapshot.markerId,
    markerPath: snapshot.markerPath,
    outcomePath: snapshot.outcomePath,
  };
}

function captureOutcome(value: unknown): CapturedFundedRunOutcome {
  const snapshot = snapshotPlainDataRecord(value);
  if (!snapshot || !exactKeys(snapshot, ["status"], ["details"]) ||
      typeof snapshot.status !== "string" ||
      !OUTCOME_STATUSES.has(snapshot.status as FundedRunOutcomeStatus)) {
    throw new Error("funded-e2e:outcome-invalid");
  }
  return {
    status: snapshot.status as FundedRunOutcomeStatus,
    details: captureDetails(
      Object.hasOwn(snapshot, "details") ? snapshot.details : {},
      "outcome-details",
    ),
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

function encodeMarker(
  value: Readonly<Record<string, unknown>>,
  kind: "intent" | "outcome",
): string {
  const encoded = `${canonicalize(value)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > MAX_MARKER_BYTES) {
    throw new Error(`funded-e2e:${kind}-marker-too-large`);
  }
  return encoded;
}

async function writeExclusive(path: string, encoded: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(encoded, "utf8");
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
      (before.mode & 0o777) !== 0o600 || before.size > MAX_MARKER_BYTES) {
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
    const stored = snapshotPlainDataRecord(parsed);
    if (!stored ||
        !exactKeys(stored, [
          "markerVersion",
          "operation",
          "runId",
          "markerId",
          "details",
          "state",
          "armedAt",
        ]) ||
        stored.markerVersion !== "1" || stored.markerId !== markerId ||
        stored.state !== "armed" || typeof stored.operation !== "string" ||
        !SAFE_ID_RE.test(stored.operation) || typeof stored.runId !== "string" ||
        !SAFE_ID_RE.test(stored.runId) || !Number.isSafeInteger(stored.armedAt) ||
        (stored.armedAt as number) < 0) {
      throw new Error("funded-e2e:intent-marker-corrupt");
    }
    captureDetails(stored.details, "stored-marker-details");
    const expectedId = sha256Hex(canonicalize({
      markerVersion: "1",
      operation: stored.operation,
      runId: stored.runId,
    }));
    if (expectedId !== markerId || encoded !== `${canonicalize(stored)}\n`) {
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
 * result. The intact, operator-retained directory is the cooperative local
 * guard domain: it must remain on the execution host, already exist, be owned
 * by this process uid with mode 0700, and contain no symlink components. The
 * helper cannot defend against the directory owner or root replacing its
 * ledger. A separately approved attempt needs a fresh run id and, for a payment
 * test, fresh dedicated wallets.
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
      const encoded = encodeMarker({
        ...identity,
        markerId,
        details: captured.details,
        state: "armed",
        armedAt,
      }, "intent");
      await writeExclusive(markerPath, encoded);
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

/** Record the first observed diagnostic through this helper without replacing either file. */
export async function recordFundedRunOutcome(
  marker: Readonly<ArmedFundedRun>,
  outcome: Readonly<FundedRunOutcome>,
  now = Date.now,
): Promise<void> {
  const capturedMarker = captureMarker(marker);
  const capturedOutcome = captureOutcome(outcome);
  const recordedAt = captureNow(now);
  const directory = dirname(capturedMarker.markerPath);
  const expectedMarkerPath = join(directory, `${capturedMarker.markerId}.intent.json`);
  const expectedOutcomePath = join(directory, `${capturedMarker.markerId}.outcome.json`);
  if (!isAbsolute(directory) || directory !== resolve(directory) ||
      capturedMarker.markerPath !== expectedMarkerPath ||
      capturedMarker.outcomePath !== expectedOutcomePath) {
    throw new Error("funded-e2e:marker-path-invalid");
  }

  const encoded = encodeMarker({
    markerVersion: "1",
    markerId: capturedMarker.markerId,
    state: capturedOutcome.status,
    details: capturedOutcome.details,
    recordedAt,
  }, "outcome");

  const secureDirectory = await openSecureMarkerDirectory(directory);
  try {
    await verifyIntentMarker(capturedMarker.markerPath, capturedMarker.markerId);
    try {
      await writeExclusive(capturedMarker.outcomePath, encoded);
      await syncAndConfirmMarkerDirectory(secureDirectory);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code === "EEXIST") {
        throw new Error(
          `funded-e2e:outcome-already-recorded:${capturedMarker.markerId}`,
          { cause },
        );
      }
      throw cause;
    }
  } finally {
    await secureDirectory.handle.close();
  }
}
