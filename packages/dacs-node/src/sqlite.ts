import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statfsSync,
} from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { types as nodeTypes } from "node:util";

import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  FIXED_PRICE_X402_COORDINATOR_STORE_VERSION,
  fixedPriceOfflineOrderBindingHash,
  fixedPriceOfflineOrderViolation,
  fixedPriceX402OrderBindingHash,
  fixedPriceX402OrderViolation,
  type FixedPriceOfflineCoordinatorStore,
  type FixedPriceOfflineOrderRecord,
  type FixedPriceX402CoordinatorRole,
  type FixedPriceX402CoordinatorStore,
  type FixedPriceX402ErrorClass,
  type FixedPriceX402OrderRecord,
  type FixedPriceX402Track,
  type FixedPriceX402TrackLease,
  type FixedPriceX402TrackOperationResult,
  type FixedPriceX402TrackRecord,
} from "@kynesyslabs/dacs/commerce";
import { isCanonicalJobId } from "@kynesyslabs/dacs/negotiate";
import BetterSqlite3 from "better-sqlite3";

import {
  DACS_NODE_LIVE_PROFILE,
  DACS_NODE_OFFLINE_PROFILE,
} from "./config.js";

export const DACS_NODE_SQLITE_SCHEMA_VERSION = 2 as const;
export const DACS_NODE_SQLITE_APPLICATION_ID = 0x44414353 as const;
export const DACS_NODE_SQLITE_DEFAULT_BUSY_TIMEOUT_MS = 5_000 as const;

const HASH_RE = /^[0-9a-f]{64}$/;
const REASON_CODE_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const EFFECT_KINDS = new Set<DacsNodeSqliteEffectKind>([
  "payment",
  "fulfilment",
  "artifact-publication",
  "setup-write",
]);
const RESERVATION_KINDS = new Set<DacsNodeSqliteReservationKind>([
  "session",
  "message",
  "payment-effect",
  "fulfilment-effect",
  "logical-address",
  "artifact-publication",
  "setup-write-effect",
]);
const SYNC_DIRECTORY_MARKERS = new Set([
  "cloudstorage",
  "dropbox",
  "google drive",
  "googledrive",
  "icloud drive",
  "mobile documents",
  "onedrive",
]);
const NETWORK_FILESYSTEMS = new Set([
  "9p",
  "afpfs",
  "ceph",
  "cifs",
  "davfs",
  "fuse.rclone",
  "fuse.sshfs",
  "gpfs",
  "lustre",
  "nfs",
  "nfs4",
  "smb",
  "smbfs",
  "sshfs",
  "webdav",
]);
const NETWORK_FILESYSTEM_MAGIC = new Set([
  0x00006969, // Linux NFS_SUPER_MAGIC
  0x01021997, // Linux V9FS_MAGIC
  0x00c36400, // Linux CEPH_SUPER_MAGIC
  0x47504653, // Linux GPFS_SUPER_MAGIC
  0xfe534d42, // Linux SMB2_MAGIC_NUMBER
  0xff534d42, // Linux CIFS_MAGIC_NUMBER
]);

export type DacsNodeSqliteActorRole = "buyer" | "seller" | "verifier";
export type DacsNodeSqliteEffectKind =
  | "payment"
  | "fulfilment"
  | "artifact-publication"
  | "setup-write";
export type DacsNodeSqliteReservationKind =
  | "session"
  | "message"
  | "payment-effect"
  | "fulfilment-effect"
  | "logical-address"
  | "artifact-publication"
  | "setup-write-effect";
export type DacsNodeSqliteEffectState =
  | "intent"
  | "active"
  | "reconciliation-required"
  | "operator-action"
  | "completed";

export interface DacsNodeSqliteDatabaseOptions {
  databasePath: string;
  mode: "offline" | "live-demos";
  profile:
    | typeof DACS_NODE_OFFLINE_PROFILE
    | typeof DACS_NODE_LIVE_PROFILE;
  role: DacsNodeSqliteActorRole;
  authority: string;
  sdkVersion: string;
  standardRevision: string;
  busyTimeoutMs?: number;
}

export type DacsNodeSqliteLocationInspection = Readonly<
  | {
      status: "supported";
      databasePath: string;
      filesystemType?: string;
      filesystemMagic: number;
    }
  | {
      status: "blocked";
      databasePath: string;
      reasonCode:
        | "database-path-malformed"
        | "database-path-not-filesystem"
        | "database-path-symlink"
        | "network-filesystem"
        | "consumer-sync-directory"
        | "filesystem-inspection-failed";
      filesystemType?: string;
      filesystemMagic?: number;
    }
>;

export interface DacsNodeSqliteReservation {
  kind: DacsNodeSqliteReservationKind;
  identity: string;
  bindingHash: string;
  payloadHash?: string;
  jobId?: string;
  createdAt: number;
}

export interface DacsNodeSqliteEffectLease {
  owner: string;
  generation: number;
  expiresAt: number;
  mode: "perform" | "reconcile";
}

export interface DacsNodeSqliteEffectRecord {
  kind: DacsNodeSqliteEffectKind;
  effectId: string;
  jobId?: string;
  bindingHash: string;
  inputHash: string;
  idempotencyKey: string;
  state: DacsNodeSqliteEffectState;
  generation: number;
  attempts: number;
  retryAt?: number;
  reasonCode?: string;
  absenceProofHash?: string;
  resultHash?: string;
  result?: unknown;
  lease?: Readonly<DacsNodeSqliteEffectLease>;
  createdAt: number;
  updatedAt: number;
}

export type DacsNodeSqliteEffectClaim = Readonly<
  | {
      status: "acquired";
      mode: "perform" | "reconcile";
      record: Readonly<DacsNodeSqliteEffectRecord>;
      lease: Readonly<DacsNodeSqliteEffectLease>;
    }
  | {
      status: "waiting";
      record: Readonly<DacsNodeSqliteEffectRecord>;
      lease: Readonly<DacsNodeSqliteEffectLease>;
    }
  | {
      status: "completed" | "not-runnable";
      record: Readonly<DacsNodeSqliteEffectRecord>;
    }
  | { status: "missing" | "stale" }
>;

export type DacsNodeSqliteEffectWrite = Readonly<
  | {
      status: "recorded" | "existing";
      record: Readonly<DacsNodeSqliteEffectRecord>;
    }
  | { status: "missing" | "stale" | "conflict" }
>;

export interface DacsNodeSqliteDiagnostics {
  databasePath: string;
  schemaVersion: number;
  applicationId: number;
  mode: DacsNodeSqliteDatabaseOptions["mode"];
  profile: DacsNodeSqliteDatabaseOptions["profile"];
  role: DacsNodeSqliteActorRole;
  authority: string;
  sdkVersion: string;
  standardRevision: string;
  journalMode: "wal";
  synchronous: "full";
  quickCheck: "ok";
  filesystemType?: string;
  filesystemMagic: number;
}

export interface DacsNodeSqliteDatabase {
  readonly databasePath: string;
  readonly metadata: Readonly<{
    mode: DacsNodeSqliteDatabaseOptions["mode"];
    profile: DacsNodeSqliteDatabaseOptions["profile"];
    role: DacsNodeSqliteActorRole;
    authority: string;
    sdkVersion: string;
    standardRevision: string;
  }>;
  readTime(): number;
  diagnostics(): Readonly<DacsNodeSqliteDiagnostics>;
  createLiveCoordinatorStore(
    role: FixedPriceX402CoordinatorRole,
  ): FixedPriceX402CoordinatorStore;
  createOfflineCoordinatorStore(
    role: FixedPriceX402CoordinatorRole,
  ): FixedPriceOfflineCoordinatorStore;
  reserveIdentity(input: Readonly<{
    kind: DacsNodeSqliteReservationKind;
    identity: string;
    bindingHash: string;
    payloadHash?: string;
    jobId?: string;
  }>): Readonly<{
    status: "created" | "existing" | "conflict";
    reservation?: Readonly<DacsNodeSqliteReservation>;
  }>;
  loadReservation(
    kind: DacsNodeSqliteReservationKind,
    identity: string,
  ): Readonly<DacsNodeSqliteReservation> | undefined;
  putEffectIntent(input: Readonly<{
    kind: DacsNodeSqliteEffectKind;
    effectId: string;
    bindingHash: string;
    /** Canonical public effect binding; never secret or reusable authorization data. */
    input: unknown;
    idempotencyKey: string;
    jobId?: string;
  }>): Readonly<{
    status: "created" | "existing" | "conflict";
    record?: Readonly<DacsNodeSqliteEffectRecord>;
  }>;
  loadEffect(
    kind: DacsNodeSqliteEffectKind,
    effectId: string,
  ): Readonly<DacsNodeSqliteEffectRecord> | undefined;
  claimEffect(input: Readonly<{
    kind: DacsNodeSqliteEffectKind;
    effectId: string;
    bindingHash: string;
    owner: string;
    leaseDurationMs: number;
  }>): DacsNodeSqliteEffectClaim;
  isCurrentEffect(input: Readonly<{
    kind: DacsNodeSqliteEffectKind;
    effectId: string;
    bindingHash: string;
    lease: Readonly<DacsNodeSqliteEffectLease>;
  }>): boolean;
  recordEffectCompleted(input: Readonly<{
    kind: DacsNodeSqliteEffectKind;
    effectId: string;
    bindingHash: string;
    lease: Readonly<DacsNodeSqliteEffectLease>;
    /** Sanitized authoritative result required for replay/reconciliation. */
    result: unknown;
  }>): DacsNodeSqliteEffectWrite;
  recordEffectAmbiguous(input: Readonly<{
    kind: DacsNodeSqliteEffectKind;
    effectId: string;
    bindingHash: string;
    lease: Readonly<DacsNodeSqliteEffectLease>;
    reasonCode: string;
    retryAt?: number;
  }>): DacsNodeSqliteEffectWrite;
  recordEffectReconciliation(input: Readonly<{
    kind: DacsNodeSqliteEffectKind;
    effectId: string;
    bindingHash: string;
    lease: Readonly<DacsNodeSqliteEffectLease & { mode: "reconcile" }>;
    result: Readonly<
      | {
          disposition: "performed";
          /** Sanitized authoritative result; never secret or reusable authorization data. */
          result: unknown;
        }
      | { disposition: "absent"; absenceProofHash: string }
      | {
          disposition: "indeterminate";
          reasonCode: string;
          retryAt?: number;
        }
    >;
  }>): DacsNodeSqliteEffectWrite;
  requireEffectOperatorAction(input: Readonly<{
    kind: DacsNodeSqliteEffectKind;
    effectId: string;
    bindingHash: string;
    lease: Readonly<DacsNodeSqliteEffectLease>;
    reasonCode: string;
  }>): DacsNodeSqliteEffectWrite;
  checkpoint(): void;
  close(): void;
}

export class DacsNodeSqliteError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = "DacsNodeSqliteError";
  }
}

interface MetadataRow {
  schema_version: number;
  mode: string;
  profile: string;
  role: string;
  authority: string;
  sdk_version: string;
  standard_revision: string;
  created_at: number;
}

interface ReservationRow {
  kind: string;
  identity: string;
  binding_hash: string;
  payload_hash: string | null;
  job_id: string | null;
  created_at: number;
}

interface EffectRow {
  effect_kind: string;
  effect_id: string;
  job_id: string | null;
  binding_hash: string;
  input_hash: string;
  input_json: string;
  idempotency_key: string;
  state: string;
  active_mode: string | null;
  generation: number;
  attempts: number;
  owner: string | null;
  lease_expires_at: number | null;
  retry_at: number | null;
  reason_code: string | null;
  absence_proof_hash: string | null;
  result_hash: string | null;
  result_json: string | null;
  created_at: number;
  updated_at: number;
}

interface CoordinatorRow {
  profile: string;
  role: string;
  job_id: string;
  binding_hash: string;
  record_hash: string;
  record_json: string;
  revision: number;
  created_at: number;
  updated_at: number;
}

type CoordinatorProfile = "live-x402" | "offline";
type CoordinatorRecord = FixedPriceX402OrderRecord | FixedPriceOfflineOrderRecord;

const COORDINATOR_TRACKS_BY_ROLE = Object.freeze({
  buyer: Object.freeze([
    "agreement",
    "payment",
    "payment-evidence",
    "buyer-received",
    "audit",
  ] as const satisfies readonly FixedPriceX402Track[]),
  seller: Object.freeze([
    "agreement",
    "payment",
    "payment-evidence",
    "delivery",
    "delivery-evidence",
    "audit",
  ] as const satisfies readonly FixedPriceX402Track[]),
});

const COORDINATOR_ERROR_CLASSES = new Set<FixedPriceX402ErrorClass>([
  "permanent",
  "transient",
  "counterparty",
  "substrate",
  "settlement-atomicity",
]);

const MIGRATION_1 = `
CREATE TABLE dacs_store_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  mode TEXT NOT NULL,
  profile TEXT NOT NULL,
  role TEXT NOT NULL,
  authority TEXT NOT NULL,
  sdk_version TEXT NOT NULL,
  standard_revision TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE dacs_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
) STRICT;

CREATE TABLE dacs_reservations (
  kind TEXT NOT NULL,
  identity TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  payload_hash TEXT,
  job_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, identity)
) STRICT, WITHOUT ROWID;

CREATE TABLE dacs_effects (
  effect_kind TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  job_id TEXT,
  binding_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL,
  active_mode TEXT,
  generation INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  owner TEXT,
  lease_expires_at INTEGER,
  retry_at INTEGER,
  reason_code TEXT,
  absence_proof_hash TEXT,
  result_hash TEXT,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (effect_kind, effect_id),
  UNIQUE (effect_kind, idempotency_key),
  CHECK (generation >= 0),
  CHECK (attempts >= 0),
  CHECK (updated_at >= created_at)
) STRICT, WITHOUT ROWID;

CREATE TABLE dacs_effect_history (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  effect_kind TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  event TEXT NOT NULL,
  generation INTEGER NOT NULL,
  occurred_at INTEGER NOT NULL,
  detail_hash TEXT NOT NULL,
  FOREIGN KEY (effect_kind, effect_id)
    REFERENCES dacs_effects (effect_kind, effect_id)
) STRICT;

CREATE INDEX dacs_effects_runnable_idx
  ON dacs_effects (state, retry_at, effect_kind, effect_id);
CREATE INDEX dacs_effect_history_effect_idx
  ON dacs_effect_history (effect_kind, effect_id, sequence);
`;

const MIGRATION_2 = `
CREATE TABLE dacs_coordinator_orders (
  profile TEXT NOT NULL,
  role TEXT NOT NULL,
  job_id TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  record_hash TEXT NOT NULL,
  record_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile, role, job_id),
  CHECK (revision > 0),
  CHECK (updated_at >= created_at)
) STRICT, WITHOUT ROWID;

CREATE INDEX dacs_coordinator_orders_runnable_idx
  ON dacs_coordinator_orders (profile, role, job_id);
`;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.trim() === value && !value.includes("\0");
}

function hash(value: unknown): value is string {
  return typeof value === "string" && HASH_RE.test(value);
}

function reasonCode(value: unknown): value is string {
  return typeof value === "string" && REASON_CODE_RE.test(value);
}

function safeUint(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function coordinatorTracks(
  role: FixedPriceX402CoordinatorRole,
): readonly FixedPriceX402Track[] {
  return COORDINATOR_TRACKS_BY_ROLE[role];
}

function emptyCoordinatorTracks(
  role: FixedPriceX402CoordinatorRole,
  now: number,
): Partial<Record<FixedPriceX402Track, FixedPriceX402TrackRecord>> {
  return Object.fromEntries(coordinatorTracks(role).map((track) => [
    track,
    { state: "not-started", generation: 0, attempts: 0, updatedAt: now },
  ])) as Partial<Record<FixedPriceX402Track, FixedPriceX402TrackRecord>>;
}

function coordinatorViolation(
  profile: CoordinatorProfile,
  value: unknown,
): string | null {
  return profile === "live-x402"
    ? fixedPriceX402OrderViolation(value)
    : fixedPriceOfflineOrderViolation(value);
}

function coordinatorBindingHash(
  profile: CoordinatorProfile,
  value: Readonly<{
    jobId: string;
    buyer: string;
    seller: string;
    protocol: CoordinatorRecord["protocol"];
  }>,
): string {
  return profile === "live-x402"
    ? fixedPriceX402OrderBindingHash(
        value as Parameters<typeof fixedPriceX402OrderBindingHash>[0],
      )
    : fixedPriceOfflineOrderBindingHash(
        value as Parameters<typeof fixedPriceOfflineOrderBindingHash>[0],
      );
}

type CoordinatorDecode = Readonly<
  | { status: "ok"; record: Readonly<CoordinatorRecord> }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string }
>;

function coordinatorFromRow(
  row: Readonly<CoordinatorRow>,
  profile: CoordinatorProfile,
): CoordinatorDecode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.record_json) as unknown;
  } catch {
    return { status: "corrupt", reason: "coordinator record JSON is malformed" };
  }
  if (parsed !== null && typeof parsed === "object" &&
      Number.isSafeInteger((parsed as { storeVersion?: unknown }).storeVersion) &&
      (parsed as { storeVersion: number }).storeVersion !==
        FIXED_PRICE_X402_COORDINATOR_STORE_VERSION) {
    return {
      status: "unsupported",
      version: (parsed as { storeVersion: number }).storeVersion,
    };
  }
  let recordJson: string;
  try {
    recordJson = canonicalize(parsed);
  } catch {
    return { status: "corrupt", reason: "coordinator record is not canonical data" };
  }
  const violation = coordinatorViolation(profile, parsed);
  const record = parsed as CoordinatorRecord;
  if (violation || recordJson !== row.record_json || sha256Hex(recordJson) !== row.record_hash ||
      row.profile !== profile || row.role !== record.role || row.job_id !== record.jobId ||
      row.binding_hash !== record.bindingHash || row.revision !== record.revision ||
      row.created_at !== record.createdAt || row.updated_at !== record.updatedAt) {
    return {
      status: "corrupt",
      reason: violation ?? "coordinator record integrity binding differs",
    };
  }
  return { status: "ok", record: clone(record) };
}

function coordinatorTrack(
  record: Readonly<CoordinatorRecord>,
  track: FixedPriceX402Track,
): Readonly<FixedPriceX402TrackRecord> | undefined {
  return record.tracks[track];
}

function coordinatorTrackFinal(
  record: Readonly<CoordinatorRecord>,
  track: FixedPriceX402Track,
): boolean {
  return coordinatorTrack(record, track)?.state === "final";
}

function coordinatorTrackSuccessful(
  record: Readonly<CoordinatorRecord>,
  track: FixedPriceX402Track,
): boolean {
  const retained = coordinatorTrack(record, track);
  return retained?.state === "final" && retained.outcome === "success";
}

function coordinatorTerminalResult(
  record: Readonly<CoordinatorRecord>,
): Readonly<
  | { outcome: "failure"; errorClass: FixedPriceX402ErrorClass }
  | { outcome: "aborted" }
> | null {
  const tracks: readonly FixedPriceX402Track[] = record.role === "buyer"
    ? ["agreement", "payment", "buyer-received"]
    : ["agreement", "payment", "delivery"];
  for (const track of tracks) {
    const retained = coordinatorTrack(record, track);
    if (retained?.state === "final" && retained.outcome !== "success") {
      return retained.outcome === "failure"
        ? { outcome: "failure", errorClass: retained.errorClass! }
        : { outcome: "aborted" };
    }
  }
  return null;
}

function coordinatorTrackEligible(
  record: Readonly<CoordinatorRecord>,
  track: FixedPriceX402Track,
): boolean {
  if (!coordinatorTracks(record.role).includes(track)) return false;
  switch (track) {
    case "agreement": return true;
    case "payment": return coordinatorTrackSuccessful(record, "agreement");
    case "payment-evidence": return coordinatorTrackFinal(record, "payment");
    case "delivery":
      return record.role === "seller" && coordinatorTrackSuccessful(record, "payment");
    case "buyer-received":
      return record.role === "buyer" && coordinatorTrackSuccessful(record, "payment");
    case "delivery-evidence":
      return record.role === "seller" && coordinatorTrackFinal(record, "delivery");
    case "audit": {
      const agreement = coordinatorTrack(record, "agreement");
      if (agreement?.state === "final" && agreement.outcome !== "success") return true;
      const payment = coordinatorTrack(record, "payment");
      if (payment?.state === "final" && payment.outcome !== "success") {
        return coordinatorTrackSuccessful(record, "payment-evidence");
      }
      return record.role === "buyer"
        ? coordinatorTrackSuccessful(record, "payment-evidence") &&
            coordinatorTrackFinal(record, "buyer-received")
        : coordinatorTrackSuccessful(record, "payment-evidence") &&
            coordinatorTrackSuccessful(record, "delivery-evidence");
    }
  }
}

function coordinatorResultAllowed(
  record: Readonly<CoordinatorRecord>,
  track: FixedPriceX402Track,
  result: Readonly<{
    outcome: "success" | "failure" | "aborted";
    errorClass?: FixedPriceX402ErrorClass;
  }>,
): boolean {
  if (track === "payment-evidence" || track === "delivery-evidence") {
    return result.outcome === "success";
  }
  if (track === "audit") {
    const expected = coordinatorTerminalResult(record) ?? { outcome: "success" as const };
    return result.outcome === expected.outcome &&
      (expected.outcome !== "failure" || result.errorClass === expected.errorClass);
  }
  return true;
}

function coordinatorTrackRunnable(
  record: Readonly<CoordinatorRecord>,
  track: FixedPriceX402Track,
  now: number,
): boolean {
  const retained = coordinatorTrack(record, track);
  if (!retained || !coordinatorTrackEligible(record, track) ||
      retained.state === "final" || retained.state === "operator-action") return false;
  if (retained.nextAttemptAt !== undefined && retained.nextAttemptAt > now) return false;
  return retained.lease === undefined || retained.lease.expiresAt <= now;
}

function exactDataKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      nodeTypes.isProxy(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key as string)) &&
    keys.every((key) => {
      const descriptor = descriptors[key as string];
      return descriptor?.enumerable === true && "value" in descriptor &&
        descriptor.value !== undefined;
    });
}

function captureCoordinatorResult(value: unknown): FixedPriceX402TrackOperationResult | null {
  if (exactDataKeys(value, ["status", "outcome", "reference"], ["authenticationHash"]) &&
      value.status === "final" && (value.outcome === "success" || value.outcome === "aborted") &&
      nonEmpty(value.reference) &&
      (value.authenticationHash === undefined || hash(value.authenticationHash))) {
    return clone(value) as unknown as FixedPriceX402TrackOperationResult;
  }
  if (exactDataKeys(
    value,
    ["status", "outcome", "errorClass", "reference"],
    ["authenticationHash"],
  ) && value.status === "final" && value.outcome === "failure" &&
      COORDINATOR_ERROR_CLASSES.has(value.errorClass as FixedPriceX402ErrorClass) &&
      nonEmpty(value.reference) &&
      (value.authenticationHash === undefined || hash(value.authenticationHash))) {
    return clone(value) as unknown as FixedPriceX402TrackOperationResult;
  }
  if (exactDataKeys(value, ["status", "reasonCode", "retryAt"]) &&
      (value.status === "pending-retry" || value.status === "indeterminate") &&
      reasonCode(value.reasonCode) && safeUint(value.retryAt)) {
    return clone(value) as unknown as FixedPriceX402TrackOperationResult;
  }
  if (exactDataKeys(value, ["status", "reasonCode"]) &&
      value.status === "operator-action" && reasonCode(value.reasonCode)) {
    return clone(value) as unknown as FixedPriceX402TrackOperationResult;
  }
  return null;
}

function decodeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)));
}

function withinPath(candidate: string, parent: string): boolean {
  const normalizedParent = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return candidate === parent || candidate.startsWith(normalizedParent);
}

function linuxMountType(candidate: string): string | undefined {
  if (process.platform !== "linux" || !existsSync("/proc/self/mountinfo")) {
    return undefined;
  }
  const entries = readFileSync("/proc/self/mountinfo", "utf8")
    .split("\n")
    .flatMap((line) => {
      const separator = line.indexOf(" - ");
      if (separator < 0) return [];
      const before = line.slice(0, separator).split(" ");
      const after = line.slice(separator + 3).split(" ");
      if (before.length < 5 || after.length < 1) return [];
      return [{ mountPoint: decodeMountPath(before[4]!), type: after[0]! }];
    })
    .filter((entry) => withinPath(candidate, entry.mountPoint))
    .sort((left, right) => right.mountPoint.length - left.mountPoint.length);
  return entries[0]?.type.toLowerCase();
}

function darwinMountType(candidate: string): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const output = execFileSync("/sbin/mount", [], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const entries = output.split("\n").flatMap((line) => {
      const match = /^.+ on (.+) \(([^,)]+)/.exec(line);
      if (!match) return [];
      return [{
        mountPoint: decodeMountPath(match[1]!),
        type: match[2]!.toLowerCase(),
      }];
    }).filter((entry) => withinPath(candidate, entry.mountPoint))
      .sort((left, right) => right.mountPoint.length - left.mountPoint.length);
    return entries[0]?.type;
  } catch {
    return undefined;
  }
}

function nearestExistingPath(value: string): string {
  let candidate = value;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return candidate;
}

function containsSyncDirectory(value: string): boolean {
  return value.toLowerCase().split(/[\\/]+/u)
    .some((component) => SYNC_DIRECTORY_MARKERS.has(component) ||
      /^(?:dropbox|google ?drive|icloud drive|onedrive)(?:[ (\-]|$)/u.test(component));
}

export function inspectDacsNodeSqliteLocation(
  databasePath: string,
): DacsNodeSqliteLocationInspection {
  if (!nonEmpty(databasePath)) {
    return {
      status: "blocked",
      databasePath: typeof databasePath === "string" ? databasePath : "",
      reasonCode: "database-path-malformed",
    };
  }
  if (databasePath === ":memory:" || databasePath.startsWith("file:") ||
      (process.platform === "win32" && databasePath.startsWith("\\\\"))) {
    return {
      status: "blocked",
      databasePath,
      reasonCode: "database-path-not-filesystem",
    };
  }
  const absolutePath = isAbsolute(databasePath) ? databasePath : resolve(databasePath);
  if (containsSyncDirectory(absolutePath)) {
    return {
      status: "blocked",
      databasePath: absolutePath,
      reasonCode: "consumer-sync-directory",
    };
  }
  try {
    if (existsSync(absolutePath) && lstatSync(absolutePath).isSymbolicLink()) {
      return {
        status: "blocked",
        databasePath: absolutePath,
        reasonCode: "database-path-symlink",
      };
    }
    const existing = nearestExistingPath(dirname(absolutePath));
    const physicalDirectory = realpathSync(existing);
    if (containsSyncDirectory(physicalDirectory)) {
      return {
        status: "blocked",
        databasePath: absolutePath,
        reasonCode: "consumer-sync-directory",
      };
    }
    const filesystemMagic = Number(statfsSync(physicalDirectory).type) >>> 0;
    const filesystemType = linuxMountType(physicalDirectory) ??
      darwinMountType(physicalDirectory);
    if ((filesystemType !== undefined && NETWORK_FILESYSTEMS.has(filesystemType)) ||
        NETWORK_FILESYSTEM_MAGIC.has(filesystemMagic)) {
      return {
        status: "blocked",
        databasePath: absolutePath,
        reasonCode: "network-filesystem",
        ...(filesystemType === undefined ? {} : { filesystemType }),
        filesystemMagic,
      };
    }
    return {
      status: "supported",
      databasePath: absolutePath,
      ...(filesystemType === undefined ? {} : { filesystemType }),
      filesystemMagic,
    };
  } catch {
    return {
      status: "blocked",
      databasePath: absolutePath,
      reasonCode: "filesystem-inspection-failed",
    };
  }
}

function validateOptions(
  options: Readonly<DacsNodeSqliteDatabaseOptions>,
): Required<Omit<DacsNodeSqliteDatabaseOptions, "busyTimeoutMs">> & {
  busyTimeoutMs: number;
} {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new DacsNodeSqliteError("configuration-malformed", "SQLite options are malformed");
  }
  const expectedProfile = options.mode === "offline"
    ? DACS_NODE_OFFLINE_PROFILE
    : options.mode === "live-demos"
      ? DACS_NODE_LIVE_PROFILE
      : undefined;
  const busyTimeoutMs = options.busyTimeoutMs ??
    DACS_NODE_SQLITE_DEFAULT_BUSY_TIMEOUT_MS;
  if (expectedProfile === undefined || options.profile !== expectedProfile ||
      !["buyer", "seller", "verifier"].includes(options.role) ||
      !nonEmpty(options.authority) || !nonEmpty(options.sdkVersion) ||
      !nonEmpty(options.standardRevision) || !nonEmpty(options.databasePath) ||
      !safeUint(busyTimeoutMs) || busyTimeoutMs === 0 || busyTimeoutMs > 60_000) {
    throw new DacsNodeSqliteError(
      "configuration-malformed",
      "SQLite options are malformed or profile-incompatible",
    );
  }
  return {
    ...options,
    busyTimeoutMs,
  } as Required<Omit<DacsNodeSqliteDatabaseOptions, "busyTimeoutMs">> & {
    busyTimeoutMs: number;
  };
}

function databaseTime(database: BetterSqlite3.Database): number {
  const row = database.prepare(`
    SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now
  `).get() as { now?: unknown } | undefined;
  if (!row || !safeUint(row.now)) {
    throw new DacsNodeSqliteError("database-clock-invalid", "SQLite clock is invalid");
  }
  return row.now;
}

function beginImmediate<T>(database: BetterSqlite3.Database, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function reservationFromRow(row: ReservationRow): DacsNodeSqliteReservation {
  if (!RESERVATION_KINDS.has(row.kind as DacsNodeSqliteReservationKind) ||
      !nonEmpty(row.identity) || !hash(row.binding_hash) ||
      (row.payload_hash !== null && !hash(row.payload_hash)) ||
      (row.job_id !== null && !nonEmpty(row.job_id)) || !safeUint(row.created_at)) {
    throw new DacsNodeSqliteError(
      "reservation-corrupt",
      "SQLite reservation is malformed",
    );
  }
  return {
    kind: row.kind as DacsNodeSqliteReservationKind,
    identity: row.identity,
    bindingHash: row.binding_hash,
    ...(row.payload_hash === null ? {} : { payloadHash: row.payload_hash }),
    ...(row.job_id === null ? {} : { jobId: row.job_id }),
    createdAt: row.created_at,
  };
}

function effectFromRow(row: EffectRow): DacsNodeSqliteEffectRecord {
  if (!EFFECT_KINDS.has(row.effect_kind as DacsNodeSqliteEffectKind) ||
      !nonEmpty(row.effect_id) || (row.job_id !== null && !nonEmpty(row.job_id)) ||
      !hash(row.binding_hash) || !hash(row.input_hash) ||
      !nonEmpty(row.idempotency_key) ||
      !["intent", "active", "reconciliation-required", "operator-action", "completed"]
        .includes(row.state) || !safeUint(row.generation) || !safeUint(row.attempts) ||
      row.attempts !== row.generation || !safeUint(row.created_at) ||
      !safeUint(row.updated_at) || row.updated_at < row.created_at ||
      (row.retry_at !== null && !safeUint(row.retry_at)) ||
      (row.reason_code !== null && !reasonCode(row.reason_code)) ||
      (row.absence_proof_hash !== null && !hash(row.absence_proof_hash)) ||
      (row.result_hash !== null && !hash(row.result_hash))) {
    throw new DacsNodeSqliteError("effect-corrupt", "SQLite effect is malformed");
  }
  const active = row.state === "active";
  if (active !== (row.active_mode !== null) || active !== (row.owner !== null) ||
      active !== (row.lease_expires_at !== null) ||
      (row.active_mode !== null && row.active_mode !== "perform" &&
        row.active_mode !== "reconcile") ||
      (row.owner !== null && !nonEmpty(row.owner)) ||
      (row.lease_expires_at !== null && !safeUint(row.lease_expires_at)) ||
      (row.state === "completed") !== (row.result_hash !== null) ||
      (row.state === "completed") !== (row.result_json !== null) ||
      (["intent", "active", "completed", "operator-action"].includes(row.state) &&
        row.retry_at !== null) ||
      (["reconciliation-required", "operator-action"].includes(row.state) !==
        (row.reason_code !== null))) {
    throw new DacsNodeSqliteError("effect-corrupt", "SQLite effect state is inconsistent");
  }
  try {
    const parsedInput = JSON.parse(row.input_json) as unknown;
    const canonicalInput = canonicalize(parsedInput);
    if (canonicalInput !== row.input_json || sha256Hex(canonicalInput) !== row.input_hash) {
      throw new Error();
    }
  } catch {
    throw new DacsNodeSqliteError("effect-corrupt", "SQLite effect input is corrupt");
  }
  let result: unknown;
  if (row.result_json !== null) {
    try {
      result = JSON.parse(row.result_json) as unknown;
      const canonicalResult = canonicalize(result);
      if (canonicalResult !== row.result_json || sha256Hex(canonicalResult) !== row.result_hash) {
        throw new Error();
      }
    } catch {
      throw new DacsNodeSqliteError("effect-corrupt", "SQLite effect result is corrupt");
    }
  }
  return {
    kind: row.effect_kind as DacsNodeSqliteEffectKind,
    effectId: row.effect_id,
    ...(row.job_id === null ? {} : { jobId: row.job_id }),
    bindingHash: row.binding_hash,
    inputHash: row.input_hash,
    idempotencyKey: row.idempotency_key,
    state: row.state as DacsNodeSqliteEffectState,
    generation: row.generation,
    attempts: row.attempts,
    ...(row.retry_at === null ? {} : { retryAt: row.retry_at }),
    ...(row.reason_code === null ? {} : { reasonCode: row.reason_code }),
    ...(row.absence_proof_hash === null
      ? {}
      : { absenceProofHash: row.absence_proof_hash }),
    ...(row.result_hash === null ? {} : { resultHash: row.result_hash, result }),
    ...(active
      ? {
          lease: {
            owner: row.owner!,
            generation: row.generation,
            expiresAt: row.lease_expires_at!,
            mode: row.active_mode as "perform" | "reconcile",
          },
        }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function reservationKindForEffect(
  kind: DacsNodeSqliteEffectKind,
): DacsNodeSqliteReservationKind {
  switch (kind) {
    case "payment": return "payment-effect";
    case "fulfilment": return "fulfilment-effect";
    case "artifact-publication": return "artifact-publication";
    case "setup-write": return "setup-write-effect";
  }
}

function exactLease(
  record: Readonly<DacsNodeSqliteEffectRecord>,
  supplied: Readonly<DacsNodeSqliteEffectLease>,
  now: number,
): boolean {
  return record.state === "active" && record.lease !== undefined &&
    record.lease.owner === supplied.owner &&
    record.lease.generation === supplied.generation &&
    record.lease.expiresAt === supplied.expiresAt &&
    record.lease.mode === supplied.mode && supplied.expiresAt > now;
}

function validateEffectIdentity(input: Readonly<{
  kind: DacsNodeSqliteEffectKind;
  effectId: string;
  bindingHash: string;
}>): void {
  if (!EFFECT_KINDS.has(input.kind) || !nonEmpty(input.effectId) ||
      !hash(input.bindingHash)) {
    throw new DacsNodeSqliteError("effect-input-malformed", "SQLite effect input is malformed");
  }
}

class DacsNodeSqliteDatabaseImpl implements DacsNodeSqliteDatabase {
  readonly databasePath: string;
  readonly metadata: DacsNodeSqliteDatabase["metadata"];
  private closed = false;

  constructor(
    private readonly database: BetterSqlite3.Database,
    options: ReturnType<typeof validateOptions>,
    private readonly location: Extract<
      DacsNodeSqliteLocationInspection,
      { status: "supported" }
    >,
  ) {
    this.databasePath = location.databasePath;
    this.metadata = Object.freeze({
      mode: options.mode,
      profile: options.profile,
      role: options.role,
      authority: options.authority,
      sdkVersion: options.sdkVersion,
      standardRevision: options.standardRevision,
    });
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new DacsNodeSqliteError("database-closed", "SQLite database is closed");
    }
  }

  readTime(): number {
    this.assertOpen();
    return databaseTime(this.database);
  }

  diagnostics(): Readonly<DacsNodeSqliteDiagnostics> {
    this.assertOpen();
    const quick = this.database.pragma("quick_check(1)", { simple: true });
    const journal = this.database.pragma("journal_mode", { simple: true });
    const synchronous = this.database.pragma("synchronous", { simple: true });
    if (quick !== "ok" || journal !== "wal" || synchronous !== 2) {
      throw new DacsNodeSqliteError(
        "database-diagnostics-failed",
        "SQLite durability diagnostics failed",
      );
    }
    return {
      databasePath: this.databasePath,
      schemaVersion: Number(this.database.pragma("user_version", { simple: true })),
      applicationId: Number(this.database.pragma("application_id", { simple: true })),
      ...this.metadata,
      journalMode: "wal",
      synchronous: "full",
      quickCheck: "ok",
      ...(this.location.filesystemType === undefined
        ? {}
        : { filesystemType: this.location.filesystemType }),
      filesystemMagic: this.location.filesystemMagic,
    };
  }

  createLiveCoordinatorStore(
    role: FixedPriceX402CoordinatorRole,
  ): FixedPriceX402CoordinatorStore {
    if (this.metadata.mode !== "live-demos") {
      throw new DacsNodeSqliteError(
        "coordinator-profile-mismatch",
        "A live coordinator store requires a live Demos actor database",
      );
    }
    return this.createCoordinatorStore("live-x402", role);
  }

  createOfflineCoordinatorStore(
    role: FixedPriceX402CoordinatorRole,
  ): FixedPriceOfflineCoordinatorStore {
    if (this.metadata.mode !== "offline") {
      throw new DacsNodeSqliteError(
        "coordinator-profile-mismatch",
        "An offline coordinator store requires an offline actor database",
      );
    }
    return this.createCoordinatorStore("offline", role) as unknown as
      FixedPriceOfflineCoordinatorStore;
  }

  private createCoordinatorStore(
    profile: CoordinatorProfile,
    role: FixedPriceX402CoordinatorRole,
  ): FixedPriceX402CoordinatorStore {
    this.assertOpen();
    if ((role !== "buyer" && role !== "seller") || role !== this.metadata.role) {
      throw new DacsNodeSqliteError(
        "coordinator-role-mismatch",
        "Coordinator role must equal the SQLite actor authority role",
      );
    }
    const database = this.database;
    const readRow = (jobId: string): CoordinatorRow | undefined =>
      database.prepare(`
        SELECT * FROM dacs_coordinator_orders
        WHERE profile = ? AND role = ? AND job_id = ?
      `).get(profile, role, jobId) as CoordinatorRow | undefined;
    const loadRecord = (jobId: string): Readonly<
      | { status: "missing" }
      | CoordinatorDecode
    > => {
      const row = readRow(jobId);
      return row ? coordinatorFromRow(row, profile) : { status: "missing" };
    };
    const saveRecord = (
      current: Readonly<CoordinatorRecord>,
      nextValue: Readonly<CoordinatorRecord>,
    ): Readonly<CoordinatorRecord> | null => {
      const next = {
        ...clone(nextValue),
        revision: current.revision + 1,
      } as CoordinatorRecord;
      const violation = coordinatorViolation(profile, next);
      if (violation) {
        throw new DacsNodeSqliteError("coordinator-record-invalid", violation);
      }
      const recordJson = canonicalize(next);
      const result = database.prepare(`
        UPDATE dacs_coordinator_orders SET
          binding_hash = ?, record_hash = ?, record_json = ?, revision = ?,
          created_at = ?, updated_at = ?
        WHERE profile = ? AND role = ? AND job_id = ? AND revision = ?
      `).run(
        next.bindingHash,
        sha256Hex(recordJson),
        recordJson,
        next.revision,
        next.createdAt,
        next.updatedAt,
        profile,
        role,
        next.jobId,
        current.revision,
      );
      return result.changes === 1 ? clone(next) : null;
    };
    const toLive = (record: Readonly<CoordinatorRecord>): FixedPriceX402OrderRecord =>
      clone(record) as FixedPriceX402OrderRecord;

    const store: FixedPriceX402CoordinatorStore = {
      async readTime() {
        return databaseTime(database);
      },

      async create(input) {
        if (input.role !== role) {
          return { status: "corrupt", reason: "coordinator role differs from bound store" };
        }
        let expectedBindingHash: string;
        try {
          expectedBindingHash = coordinatorBindingHash(profile, input.order);
        } catch (error) {
          return {
            status: "corrupt",
            reason: error instanceof Error ? error.message : "coordinator order is malformed",
          };
        }
        if (input.bindingHash !== expectedBindingHash) return { status: "conflict" };
        return beginImmediate(database, () => {
          const now = databaseTime(database);
          let record: CoordinatorRecord;
          try {
            record = {
              storeVersion: FIXED_PRICE_X402_COORDINATOR_STORE_VERSION,
              revision: 1,
              role,
              jobId: input.order.jobId,
              buyer: input.order.buyer,
              seller: input.order.seller,
              protocol: clone(input.order.protocol),
              bindingHash: expectedBindingHash,
              sdkJobs: clone(input.order.sdkJobs),
              tracks: emptyCoordinatorTracks(role, now),
              createdAt: now,
              updatedAt: now,
            } as CoordinatorRecord;
          } catch {
            return { status: "corrupt" as const, reason: "coordinator order is malformed" };
          }
          const violation = coordinatorViolation(profile, record);
          if (violation) return { status: "corrupt" as const, reason: violation };
          const existing = loadRecord(input.order.jobId);
          if (existing.status !== "missing") {
            if (existing.status !== "ok") return existing;
            return existing.record.bindingHash === expectedBindingHash &&
                canonicalize(existing.record.sdkJobs) === canonicalize(record.sdkJobs)
              ? { status: "existing" as const, record: toLive(existing.record) }
              : { status: "conflict" as const };
          }
          const recordJson = canonicalize(record);
          database.prepare(`
            INSERT INTO dacs_coordinator_orders (
              profile, role, job_id, binding_hash, record_hash, record_json,
              revision, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            profile,
            role,
            record.jobId,
            record.bindingHash,
            sha256Hex(recordJson),
            recordJson,
            record.revision,
            record.createdAt,
            record.updatedAt,
          );
          return { status: "created" as const, record: toLive(record) };
        });
      },

      async load(inputRole, jobId) {
        if (inputRole !== role) {
          return { status: "corrupt", reason: "coordinator role differs from bound store" };
        }
        const loaded = loadRecord(jobId);
        return loaded.status === "ok"
          ? { status: "ok", record: toLive(loaded.record) }
          : loaded;
      },

      async listRunnable(input) {
        if (input.role !== role || !Array.isArray(input.tracks) ||
            input.tracks.some((track) => !coordinatorTracks(role).includes(track)) ||
            (input.cursor !== undefined && !nonEmpty(input.cursor)) ||
            !safeUint(input.limit) || input.limit === 0) {
          throw new DacsNodeSqliteError(
            "coordinator-query-malformed",
            "Coordinator runnable query is malformed",
          );
        }
        const now = databaseTime(database);
        const rows = database.prepare(`
          SELECT * FROM dacs_coordinator_orders
          WHERE profile = ? AND role = ? AND job_id > ?
          ORDER BY job_id
        `).all(profile, role, input.cursor ?? "") as CoordinatorRow[];
        const eligible = rows.flatMap((row) => {
          const decoded = coordinatorFromRow(row, profile);
          if (decoded.status !== "ok") {
            throw new DacsNodeSqliteError(
              decoded.status === "unsupported"
                ? "coordinator-version-unsupported"
                : "coordinator-record-corrupt",
              decoded.status === "unsupported"
                ? `Coordinator store version ${decoded.version} is unsupported`
                : decoded.reason,
            );
          }
          return input.tracks.some((track) =>
            coordinatorTrackRunnable(decoded.record, track, now)
          ) ? [decoded.record] : [];
        });
        const selected = eligible.slice(0, input.limit);
        return {
          items: selected.map(toLive),
          ...(eligible.length > selected.length && selected.length > 0
            ? { nextCursor: selected.at(-1)!.jobId }
            : {}),
        };
      },

      async claim(input) {
        if (input.role !== role) return { status: "stale" };
        return beginImmediate(database, () => {
          const loaded = loadRecord(input.jobId);
          if (loaded.status !== "ok") return loaded;
          const current = loaded.record;
          if (current.bindingHash !== input.bindingHash) return { status: "stale" as const };
          if (!coordinatorTracks(role).includes(input.track) || !nonEmpty(input.owner) ||
              !safeUint(input.leaseDurationMs) || input.leaseDurationMs === 0) {
            return { status: "corrupt" as const, reason: "coordinator claim is malformed" };
          }
          const now = databaseTime(database);
          const retained = current.tracks[input.track]!;
          if (!coordinatorTrackEligible(current, input.track) || retained.state === "final" ||
              retained.state === "operator-action" ||
              (retained.nextAttemptAt !== undefined && retained.nextAttemptAt > now)) {
            return { status: "not-runnable" as const, record: toLive(current) };
          }
          if (retained.lease && retained.lease.expiresAt > now) {
            return {
              status: "waiting" as const,
              record: toLive(current),
              lease: clone(retained.lease),
            };
          }
          const expiresAt = now + input.leaseDurationMs;
          const generation = retained.generation + 1;
          if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(generation)) {
            return { status: "corrupt" as const, reason: "coordinator lease overflows" };
          }
          const lease: FixedPriceX402TrackLease = {
            owner: input.owner,
            generation,
            expiresAt,
          };
          const updatedAt = Math.max(current.updatedAt, now);
          const tracks = clone(current.tracks) as Partial<
            Record<FixedPriceX402Track, FixedPriceX402TrackRecord>
          >;
          tracks[input.track] = {
            state: "running",
            generation,
            attempts: retained.attempts + 1,
            updatedAt,
            lease,
          };
          const next = saveRecord(current, {
            ...clone(current),
            tracks,
            updatedAt,
          });
          return next
            ? { status: "acquired" as const, record: toLive(next), lease: clone(lease) }
            : { status: "stale" as const };
        });
      },

      async isCurrent(input) {
        if (input.role !== role) return false;
        const loaded = loadRecord(input.jobId);
        if (loaded.status !== "ok" || loaded.record.bindingHash !== input.bindingHash) {
          return false;
        }
        const retained = loaded.record.tracks[input.track];
        const now = databaseTime(database);
        return retained?.state === "running" && retained.lease !== undefined &&
          retained.lease.owner === input.lease.owner &&
          retained.lease.generation === input.lease.generation &&
          retained.lease.expiresAt === input.lease.expiresAt &&
          retained.lease.expiresAt > now;
      },

      async record(input) {
        if (input.role !== role) return { status: "stale" };
        return beginImmediate(database, () => {
          const loaded = loadRecord(input.jobId);
          if (loaded.status !== "ok") return loaded;
          const current = loaded.record;
          if (current.bindingHash !== input.bindingHash ||
              !coordinatorTracks(role).includes(input.track)) return { status: "stale" as const };
          const retained = current.tracks[input.track]!;
          const now = databaseTime(database);
          if (retained.state !== "running" || !retained.lease ||
              retained.lease.owner !== input.lease.owner ||
              retained.lease.generation !== input.lease.generation ||
              retained.lease.expiresAt !== input.lease.expiresAt ||
              retained.lease.expiresAt <= now) return { status: "stale" as const };
          const result = captureCoordinatorResult(input.result);
          if (!result || (result.status === "final" &&
              !coordinatorResultAllowed(current, input.track, result))) {
            return { status: "conflict" as const };
          }
          const updatedAt = Math.max(current.updatedAt, now);
          const nextTrack: FixedPriceX402TrackRecord = result.status === "final"
            ? {
                state: "final",
                generation: retained.generation,
                attempts: retained.attempts,
                updatedAt,
                reference: result.reference,
                outcome: result.outcome,
                ...(result.authenticationHash
                  ? { authenticationHash: result.authenticationHash }
                  : {}),
                ...(result.outcome === "failure" ? { errorClass: result.errorClass } : {}),
              }
            : {
                state: result.status,
                generation: retained.generation,
                attempts: retained.attempts,
                updatedAt,
                reasonCode: result.reasonCode,
                ...(result.retryAt === undefined ? {} : { nextAttemptAt: result.retryAt }),
              };
          const tracks = clone(current.tracks) as Partial<
            Record<FixedPriceX402Track, FixedPriceX402TrackRecord>
          >;
          tracks[input.track] = nextTrack;
          const next = saveRecord(current, {
            ...clone(current),
            tracks,
            updatedAt,
          });
          return next
            ? { status: "recorded" as const, record: toLive(next) }
            : { status: "stale" as const };
        });
      },

      async requeue(input) {
        if (input.role !== role) return { status: "stale" };
        return beginImmediate(database, () => {
          const loaded = loadRecord(input.jobId);
          if (loaded.status !== "ok") return loaded;
          const current = loaded.record;
          if (current.bindingHash !== input.bindingHash ||
              !coordinatorTracks(role).includes(input.track) ||
              !reasonCode(input.operatorReasonCode) ||
              (input.retryAt !== undefined && !safeUint(input.retryAt))) {
            return { status: "conflict" as const };
          }
          const retained = current.tracks[input.track]!;
          const now = databaseTime(database);
          if (retained.state === "final" ||
              (retained.lease !== undefined && retained.lease.expiresAt > now)) {
            return { status: "stale" as const };
          }
          const updatedAt = Math.max(current.updatedAt, now);
          const tracks = clone(current.tracks) as Partial<
            Record<FixedPriceX402Track, FixedPriceX402TrackRecord>
          >;
          tracks[input.track] = {
            state: "pending-retry",
            generation: retained.generation,
            attempts: retained.attempts,
            updatedAt,
            reasonCode: input.operatorReasonCode,
            ...(input.retryAt === undefined ? {} : { nextAttemptAt: input.retryAt }),
          };
          const next = saveRecord(current, {
            ...clone(current),
            tracks,
            updatedAt,
          });
          return next
            ? { status: "recorded" as const, record: toLive(next) }
            : { status: "stale" as const };
        });
      },
    };
    return store;
  }

  reserveIdentity(input: Readonly<{
    kind: DacsNodeSqliteReservationKind;
    identity: string;
    bindingHash: string;
    payloadHash?: string;
    jobId?: string;
  }>): Readonly<{
    status: "created" | "existing" | "conflict";
    reservation?: Readonly<DacsNodeSqliteReservation>;
  }> {
    this.assertOpen();
    if (!RESERVATION_KINDS.has(input.kind) || !nonEmpty(input.identity) ||
        !hash(input.bindingHash) ||
        (input.payloadHash !== undefined && !hash(input.payloadHash)) ||
        (input.jobId !== undefined && !isCanonicalJobId(input.jobId))) {
      throw new DacsNodeSqliteError(
        "reservation-input-malformed",
        "SQLite reservation input is malformed",
      );
    }
    return beginImmediate(this.database, () => {
      const found = this.database.prepare(`
        SELECT * FROM dacs_reservations WHERE kind = ? AND identity = ?
      `).get(input.kind, input.identity) as ReservationRow | undefined;
      if (found) {
        const reservation = reservationFromRow(found);
        const same = reservation.bindingHash === input.bindingHash &&
          reservation.payloadHash === input.payloadHash &&
          reservation.jobId === input.jobId;
        return same
          ? { status: "existing" as const, reservation: clone(reservation) }
          : { status: "conflict" as const };
      }
      const createdAt = databaseTime(this.database);
      this.database.prepare(`
        INSERT INTO dacs_reservations
          (kind, identity, binding_hash, payload_hash, job_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        input.kind,
        input.identity,
        input.bindingHash,
        input.payloadHash ?? null,
        input.jobId ?? null,
        createdAt,
      );
      return {
        status: "created" as const,
        reservation: {
          ...clone(input),
          createdAt,
        },
      };
    });
  }

  loadReservation(
    kind: DacsNodeSqliteReservationKind,
    identity: string,
  ): Readonly<DacsNodeSqliteReservation> | undefined {
    this.assertOpen();
    if (!RESERVATION_KINDS.has(kind) || !nonEmpty(identity)) {
      throw new DacsNodeSqliteError(
        "reservation-input-malformed",
        "SQLite reservation lookup is malformed",
      );
    }
    const row = this.database.prepare(`
      SELECT * FROM dacs_reservations WHERE kind = ? AND identity = ?
    `).get(kind, identity) as ReservationRow | undefined;
    return row ? clone(reservationFromRow(row)) : undefined;
  }

  putEffectIntent(input: Readonly<{
    kind: DacsNodeSqliteEffectKind;
    effectId: string;
    bindingHash: string;
    input: unknown;
    idempotencyKey: string;
    jobId?: string;
  }>): Readonly<{
    status: "created" | "existing" | "conflict";
    record?: Readonly<DacsNodeSqliteEffectRecord>;
  }> {
    this.assertOpen();
    validateEffectIdentity(input);
    if (!nonEmpty(input.idempotencyKey) ||
        (input.jobId !== undefined && !isCanonicalJobId(input.jobId))) {
      throw new DacsNodeSqliteError("effect-input-malformed", "SQLite effect input is malformed");
    }
    let inputJson: string;
    try {
      inputJson = canonicalize(input.input);
    } catch {
      throw new DacsNodeSqliteError(
        "effect-input-malformed",
        "SQLite effect input must be canonical JSON data",
      );
    }
    const inputHash = sha256Hex(inputJson);
    return beginImmediate(this.database, () => {
      const existing = this.effectRow(input.kind, input.effectId);
      if (existing) {
        const record = effectFromRow(existing);
        const same = record.bindingHash === input.bindingHash &&
          record.inputHash === inputHash &&
          record.idempotencyKey === input.idempotencyKey &&
          record.jobId === input.jobId;
        return same
          ? { status: "existing" as const, record: clone(record) }
          : { status: "conflict" as const };
      }
      const duplicateKey = this.database.prepare(`
        SELECT effect_id FROM dacs_effects
        WHERE effect_kind = ? AND idempotency_key = ?
      `).get(input.kind, input.idempotencyKey) as { effect_id: string } | undefined;
      if (duplicateKey) return { status: "conflict" as const };

      const reservationKind = reservationKindForEffect(input.kind);
      const reservation = this.database.prepare(`
        SELECT * FROM dacs_reservations WHERE kind = ? AND identity = ?
      `).get(reservationKind, input.effectId) as ReservationRow | undefined;
      if (reservation) {
        const retained = reservationFromRow(reservation);
        if (retained.bindingHash !== input.bindingHash ||
            retained.payloadHash !== inputHash || retained.jobId !== input.jobId) {
          return { status: "conflict" as const };
        }
      }
      const now = databaseTime(this.database);
      if (!reservation) {
        this.database.prepare(`
          INSERT INTO dacs_reservations
            (kind, identity, binding_hash, payload_hash, job_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          reservationKind,
          input.effectId,
          input.bindingHash,
          inputHash,
          input.jobId ?? null,
          now,
        );
      }
      this.database.prepare(`
        INSERT INTO dacs_effects (
          effect_kind, effect_id, job_id, binding_hash, input_hash, input_json,
          idempotency_key, state, active_mode, generation, attempts, owner,
          lease_expires_at, retry_at, reason_code, absence_proof_hash,
          result_hash, result_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'intent', NULL, 0, 0, NULL, NULL, NULL,
          NULL, NULL, NULL, NULL, ?, ?)
      `).run(
        input.kind,
        input.effectId,
        input.jobId ?? null,
        input.bindingHash,
        inputHash,
        inputJson,
        input.idempotencyKey,
        now,
        now,
      );
      this.appendEffectHistory(input.kind, input.effectId, "intent-created", 0, now, {
        bindingHash: input.bindingHash,
        inputHash,
      });
      return {
        status: "created" as const,
        record: clone(effectFromRow(this.effectRow(input.kind, input.effectId)!)),
      };
    });
  }

  loadEffect(
    kind: DacsNodeSqliteEffectKind,
    effectId: string,
  ): Readonly<DacsNodeSqliteEffectRecord> | undefined {
    this.assertOpen();
    if (!EFFECT_KINDS.has(kind) || !nonEmpty(effectId)) {
      throw new DacsNodeSqliteError("effect-input-malformed", "SQLite effect lookup is malformed");
    }
    const row = this.effectRow(kind, effectId);
    return row ? clone(effectFromRow(row)) : undefined;
  }

  claimEffect(input: Readonly<{
    kind: DacsNodeSqliteEffectKind;
    effectId: string;
    bindingHash: string;
    owner: string;
    leaseDurationMs: number;
  }>): DacsNodeSqliteEffectClaim {
    this.assertOpen();
    validateEffectIdentity(input);
    if (!nonEmpty(input.owner) || !safeUint(input.leaseDurationMs) ||
        input.leaseDurationMs === 0) {
      throw new DacsNodeSqliteError("effect-claim-malformed", "SQLite effect claim is malformed");
    }
    return beginImmediate(this.database, () => {
      const row = this.effectRow(input.kind, input.effectId);
      if (!row) return { status: "missing" as const };
      const current = effectFromRow(row);
      if (current.bindingHash !== input.bindingHash) return { status: "stale" as const };
      if (current.state === "completed") {
        return { status: "completed" as const, record: clone(current) };
      }
      if (current.state === "operator-action") {
        return { status: "not-runnable" as const, record: clone(current) };
      }
      const now = databaseTime(this.database);
      if (current.retryAt !== undefined && current.retryAt > now) {
        return { status: "not-runnable" as const, record: clone(current) };
      }
      if (current.state === "active" && current.lease!.expiresAt > now) {
        return {
          status: "waiting" as const,
          record: clone(current),
          lease: clone(current.lease!),
        };
      }
      const mode: "perform" | "reconcile" = current.state === "intent"
        ? "perform"
        : "reconcile";
      const expiresAt = now + input.leaseDurationMs;
      if (!Number.isSafeInteger(expiresAt)) {
        throw new DacsNodeSqliteError("effect-claim-malformed", "SQLite lease expiry overflows");
      }
      const generation = current.generation + 1;
      if (!Number.isSafeInteger(generation)) {
        throw new DacsNodeSqliteError(
          "effect-generation-overflow",
          "SQLite effect generation overflows",
        );
      }
      this.database.prepare(`
        UPDATE dacs_effects SET
          state = 'active', active_mode = ?, generation = ?, attempts = ?,
          owner = ?, lease_expires_at = ?, retry_at = NULL, reason_code = NULL,
          updated_at = ?
        WHERE effect_kind = ? AND effect_id = ? AND generation = ?
      `).run(
        mode,
        generation,
        current.attempts + 1,
        input.owner,
        expiresAt,
        Math.max(current.updatedAt, now),
        input.kind,
        input.effectId,
        current.generation,
      );
      this.appendEffectHistory(input.kind, input.effectId, `${mode}-claimed`, generation, now, {
        owner: input.owner,
        expiresAt,
      });
      const record = effectFromRow(this.effectRow(input.kind, input.effectId)!);
      return {
        status: "acquired" as const,
        mode,
        record: clone(record),
        lease: clone(record.lease!),
      };
    });
  }

  isCurrentEffect(input: Readonly<{
    kind: DacsNodeSqliteEffectKind;
    effectId: string;
    bindingHash: string;
    lease: Readonly<DacsNodeSqliteEffectLease>;
  }>): boolean {
    this.assertOpen();
    validateEffectIdentity(input);
    const row = this.effectRow(input.kind, input.effectId);
    if (!row) return false;
    const record = effectFromRow(row);
    return record.bindingHash === input.bindingHash &&
      exactLease(record, input.lease, databaseTime(this.database));
  }

  recordEffectCompleted(input: Readonly<{
    kind: DacsNodeSqliteEffectKind;
    effectId: string;
    bindingHash: string;
    lease: Readonly<DacsNodeSqliteEffectLease>;
    result: unknown;
  }>): DacsNodeSqliteEffectWrite {
    this.assertOpen();
    validateEffectIdentity(input);
    let resultJson: string;
    try {
      resultJson = canonicalize(input.result);
    } catch {
      throw new DacsNodeSqliteError(
        "effect-result-malformed",
        "SQLite effect result must be canonical JSON data",
      );
    }
    return this.completeEffect(
      input,
      resultJson,
      sha256Hex(resultJson),
      "effect-completed",
    );
  }

  recordEffectAmbiguous(input: Readonly<{
    kind: DacsNodeSqliteEffectKind;
    effectId: string;
    bindingHash: string;
    lease: Readonly<DacsNodeSqliteEffectLease>;
    reasonCode: string;
    retryAt?: number;
  }>): DacsNodeSqliteEffectWrite {
    this.assertOpen();
    validateEffectIdentity(input);
    if (!reasonCode(input.reasonCode) ||
        (input.retryAt !== undefined && !safeUint(input.retryAt))) {
      throw new DacsNodeSqliteError(
        "effect-result-malformed",
        "SQLite ambiguous effect result is malformed",
      );
    }
    return this.transitionCurrentEffect(input, ({ current, now }) => {
      this.database.prepare(`
        UPDATE dacs_effects SET
          state = 'reconciliation-required', active_mode = NULL, owner = NULL,
          lease_expires_at = NULL, retry_at = ?, reason_code = ?, updated_at = ?
        WHERE effect_kind = ? AND effect_id = ? AND generation = ?
      `).run(
        input.retryAt ?? null,
        input.reasonCode,
        Math.max(current.updatedAt, now),
        input.kind,
        input.effectId,
        current.generation,
      );
      this.appendEffectHistory(
        input.kind,
        input.effectId,
        "reconciliation-required",
        current.generation,
        now,
        { reasonCode: input.reasonCode, retryAt: input.retryAt ?? null },
      );
    });
  }

  recordEffectReconciliation(input: Readonly<{
    kind: DacsNodeSqliteEffectKind;
    effectId: string;
    bindingHash: string;
    lease: Readonly<DacsNodeSqliteEffectLease & { mode: "reconcile" }>;
    result: Readonly<
      | { disposition: "performed"; result: unknown }
      | { disposition: "absent"; absenceProofHash: string }
      | {
          disposition: "indeterminate";
          reasonCode: string;
          retryAt?: number;
        }
    >;
  }>): DacsNodeSqliteEffectWrite {
    this.assertOpen();
    validateEffectIdentity(input);
    if (input.result === null || typeof input.result !== "object" ||
        Array.isArray(input.result)) {
      throw new DacsNodeSqliteError(
        "effect-result-malformed",
        "SQLite reconciliation result is malformed",
      );
    }
    if (input.lease.mode !== "reconcile") return { status: "conflict" };
    if (input.result.disposition === "performed") {
      let resultJson: string;
      try {
        resultJson = canonicalize(input.result.result);
      } catch {
        throw new DacsNodeSqliteError(
          "effect-result-malformed",
          "SQLite reconciliation result must be canonical JSON data",
        );
      }
      return this.completeEffect(
        input,
        resultJson,
        sha256Hex(resultJson),
        "reconciliation-performed",
      );
    }
    if (input.result.disposition === "absent") {
      const absenceProofHash = input.result.absenceProofHash;
      if (!hash(absenceProofHash)) {
        throw new DacsNodeSqliteError(
          "effect-result-malformed",
          "SQLite absence proof is malformed",
        );
      }
      return this.transitionCurrentEffect(input, ({ current, now }) => {
        this.database.prepare(`
          UPDATE dacs_effects SET
            state = 'intent', active_mode = NULL, owner = NULL,
            lease_expires_at = NULL, retry_at = NULL, reason_code = NULL,
            absence_proof_hash = ?, updated_at = ?
          WHERE effect_kind = ? AND effect_id = ? AND generation = ?
        `).run(
          absenceProofHash,
          Math.max(current.updatedAt, now),
          input.kind,
          input.effectId,
          current.generation,
        );
        this.appendEffectHistory(
          input.kind,
          input.effectId,
          "reconciliation-absent",
          current.generation,
          now,
          { absenceProofHash },
        );
      });
    }
    if (input.result.disposition !== "indeterminate") {
      throw new DacsNodeSqliteError(
        "effect-result-malformed",
        "SQLite reconciliation result is malformed",
      );
    }
    const indeterminate = input.result;
    if (!reasonCode(indeterminate.reasonCode) ||
        (indeterminate.retryAt !== undefined && !safeUint(indeterminate.retryAt))) {
      throw new DacsNodeSqliteError(
        "effect-result-malformed",
        "SQLite reconciliation result is malformed",
      );
    }
    return this.transitionCurrentEffect(input, ({ current, now }) => {
      this.database.prepare(`
        UPDATE dacs_effects SET
          state = 'reconciliation-required', active_mode = NULL, owner = NULL,
          lease_expires_at = NULL, retry_at = ?, reason_code = ?, updated_at = ?
        WHERE effect_kind = ? AND effect_id = ? AND generation = ?
      `).run(
        indeterminate.retryAt ?? null,
        indeterminate.reasonCode,
        Math.max(current.updatedAt, now),
        input.kind,
        input.effectId,
        current.generation,
      );
      this.appendEffectHistory(
        input.kind,
        input.effectId,
        "reconciliation-indeterminate",
        current.generation,
        now,
        { reasonCode: indeterminate.reasonCode, retryAt: indeterminate.retryAt ?? null },
      );
    });
  }

  requireEffectOperatorAction(input: Readonly<{
    kind: DacsNodeSqliteEffectKind;
    effectId: string;
    bindingHash: string;
    lease: Readonly<DacsNodeSqliteEffectLease>;
    reasonCode: string;
  }>): DacsNodeSqliteEffectWrite {
    this.assertOpen();
    validateEffectIdentity(input);
    if (!reasonCode(input.reasonCode)) {
      throw new DacsNodeSqliteError(
        "effect-result-malformed",
        "SQLite operator-action result is malformed",
      );
    }
    return this.transitionCurrentEffect(input, ({ current, now }) => {
      this.database.prepare(`
        UPDATE dacs_effects SET
          state = 'operator-action', active_mode = NULL, owner = NULL,
          lease_expires_at = NULL, retry_at = NULL, reason_code = ?, updated_at = ?
        WHERE effect_kind = ? AND effect_id = ? AND generation = ?
      `).run(
        input.reasonCode,
        Math.max(current.updatedAt, now),
        input.kind,
        input.effectId,
        current.generation,
      );
      this.appendEffectHistory(
        input.kind,
        input.effectId,
        "operator-action-required",
        current.generation,
        now,
        { reasonCode: input.reasonCode },
      );
    });
  }

  checkpoint(): void {
    this.assertOpen();
    this.database.pragma("wal_checkpoint(FULL)");
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  private effectRow(
    kind: DacsNodeSqliteEffectKind,
    effectId: string,
  ): EffectRow | undefined {
    return this.database.prepare(`
      SELECT * FROM dacs_effects WHERE effect_kind = ? AND effect_id = ?
    `).get(kind, effectId) as EffectRow | undefined;
  }

  private transitionCurrentEffect(
    input: Readonly<{
      kind: DacsNodeSqliteEffectKind;
      effectId: string;
      bindingHash: string;
      lease: Readonly<DacsNodeSqliteEffectLease>;
    }>,
    transition: (context: Readonly<{
      current: Readonly<DacsNodeSqliteEffectRecord>;
      now: number;
    }>) => void,
  ): DacsNodeSqliteEffectWrite {
    return beginImmediate(this.database, () => {
      const row = this.effectRow(input.kind, input.effectId);
      if (!row) return { status: "missing" as const };
      const current = effectFromRow(row);
      if (current.bindingHash !== input.bindingHash) return { status: "stale" as const };
      const now = databaseTime(this.database);
      if (!exactLease(current, input.lease, now)) return { status: "stale" as const };
      transition({ current, now });
      return {
        status: "recorded" as const,
        record: clone(effectFromRow(this.effectRow(input.kind, input.effectId)!)),
      };
    });
  }

  private completeEffect(
    input: Readonly<{
      kind: DacsNodeSqliteEffectKind;
      effectId: string;
      bindingHash: string;
      lease: Readonly<DacsNodeSqliteEffectLease>;
    }>,
    resultJson: string,
    resultHash: string,
    event: string,
  ): DacsNodeSqliteEffectWrite {
    return beginImmediate(this.database, () => {
      const row = this.effectRow(input.kind, input.effectId);
      if (!row) return { status: "missing" as const };
      const current = effectFromRow(row);
      if (current.bindingHash !== input.bindingHash) return { status: "stale" as const };
      if (current.state === "completed") {
        return current.resultHash === resultHash
          ? { status: "existing" as const, record: clone(current) }
          : { status: "conflict" as const };
      }
      const now = databaseTime(this.database);
      if (!exactLease(current, input.lease, now)) return { status: "stale" as const };
      this.database.prepare(`
        UPDATE dacs_effects SET
          state = 'completed', active_mode = NULL, owner = NULL,
          lease_expires_at = NULL, retry_at = NULL, reason_code = NULL,
          result_hash = ?, result_json = ?, updated_at = ?
        WHERE effect_kind = ? AND effect_id = ? AND generation = ?
      `).run(
        resultHash,
        resultJson,
        Math.max(current.updatedAt, now),
        input.kind,
        input.effectId,
        current.generation,
      );
      this.appendEffectHistory(
        input.kind,
        input.effectId,
        event,
        current.generation,
        now,
        { resultHash },
      );
      return {
        status: "recorded" as const,
        record: clone(effectFromRow(this.effectRow(input.kind, input.effectId)!)),
      };
    });
  }

  private appendEffectHistory(
    kind: DacsNodeSqliteEffectKind,
    effectId: string,
    event: string,
    generation: number,
    occurredAt: number,
    details: unknown,
  ): void {
    const detailHash = sha256Hex(canonicalize(details));
    this.database.prepare(`
      INSERT INTO dacs_effect_history
        (effect_kind, effect_id, event, generation, occurred_at, detail_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(kind, effectId, event, generation, occurredAt, detailHash);
  }
}

async function initializeDatabase(
  database: BetterSqlite3.Database,
  options: ReturnType<typeof validateOptions>,
  existedBeforeOpen: boolean,
): Promise<void> {
  const applicationId = Number(database.pragma("application_id", { simple: true }));
  const version = Number(database.pragma("user_version", { simple: true }));
  if (applicationId !== 0 && applicationId !== DACS_NODE_SQLITE_APPLICATION_ID) {
    throw new DacsNodeSqliteError(
      "database-application-mismatch",
      "SQLite file belongs to another application",
    );
  }
  if (!safeUint(version) || version > DACS_NODE_SQLITE_SCHEMA_VERSION) {
    throw new DacsNodeSqliteError(
      "database-schema-newer",
      "SQLite schema is newer than this runtime supports",
    );
  }
  if (version === 0) {
    const tables = database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      LIMIT 1
    `).all();
    if (existedBeforeOpen && tables.length > 0) {
      throw new DacsNodeSqliteError(
        "database-unrecognized",
        "Existing SQLite file is not an empty DACS database",
      );
    }
    beginImmediate(database, () => {
      const lockedVersion = Number(database.pragma("user_version", { simple: true }));
      if (lockedVersion !== 0) return;
      const now = databaseTime(database);
      database.exec(MIGRATION_1);
      database.exec(MIGRATION_2);
      database.prepare(`
        INSERT INTO dacs_store_metadata (
          singleton, schema_version, mode, profile, role, authority,
          sdk_version, standard_revision, created_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        DACS_NODE_SQLITE_SCHEMA_VERSION,
        options.mode,
        options.profile,
        options.role,
        options.authority,
        options.sdkVersion,
        options.standardRevision,
        now,
      );
      database.prepare(`
        INSERT INTO dacs_migrations (version, applied_at) VALUES (1, ?), (2, ?)
      `).run(now, now);
      database.pragma(`application_id = ${DACS_NODE_SQLITE_APPLICATION_ID}`);
      database.pragma(`user_version = ${DACS_NODE_SQLITE_SCHEMA_VERSION}`);
    });
    return;
  }
  if (version === 1) {
    const backupPath = `${options.databasePath}.backup-v1-${randomUUID()}.sqlite`;
    await database.backup(backupPath);
    chmodSync(backupPath, 0o600);
    beginImmediate(database, () => {
      const lockedVersion = Number(database.pragma("user_version", { simple: true }));
      if (lockedVersion !== 1) return;
      const now = databaseTime(database);
      database.exec(MIGRATION_2);
      database.prepare(`
        UPDATE dacs_store_metadata SET schema_version = ? WHERE singleton = 1
      `).run(DACS_NODE_SQLITE_SCHEMA_VERSION);
      database.prepare(`
        INSERT INTO dacs_migrations (version, applied_at) VALUES (2, ?)
      `).run(now);
      database.pragma(`user_version = ${DACS_NODE_SQLITE_SCHEMA_VERSION}`);
    });
  }
}

function preflightDatabaseIdentity(
  database: BetterSqlite3.Database,
  existedBeforeOpen: boolean,
): void {
  const applicationId = Number(database.pragma("application_id", { simple: true }));
  const version = Number(database.pragma("user_version", { simple: true }));
  if (applicationId !== 0 && applicationId !== DACS_NODE_SQLITE_APPLICATION_ID) {
    throw new DacsNodeSqliteError(
      "database-application-mismatch",
      "SQLite file belongs to another application",
    );
  }
  if (!safeUint(version) || version > DACS_NODE_SQLITE_SCHEMA_VERSION) {
    throw new DacsNodeSqliteError(
      "database-schema-newer",
      "SQLite schema is newer than this runtime supports",
    );
  }
  if (version === 0 && existedBeforeOpen) {
    const tables = database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      LIMIT 1
    `).all();
    if (tables.length > 0) {
      throw new DacsNodeSqliteError(
        "database-unrecognized",
        "Existing SQLite file is not an empty DACS database",
      );
    }
  }
}

function verifyMetadata(
  database: BetterSqlite3.Database,
  options: ReturnType<typeof validateOptions>,
): void {
  const row = database.prepare(`
    SELECT schema_version, mode, profile, role, authority, sdk_version,
      standard_revision, created_at
    FROM dacs_store_metadata WHERE singleton = 1
  `).get() as MetadataRow | undefined;
  if (!row || row.schema_version !== DACS_NODE_SQLITE_SCHEMA_VERSION ||
      !safeUint(row.created_at)) {
    throw new DacsNodeSqliteError(
      "database-metadata-corrupt",
      "SQLite DACS metadata is missing or corrupt",
    );
  }
  if (row.mode !== options.mode || row.profile !== options.profile ||
      row.role !== options.role || row.authority !== options.authority ||
      row.sdk_version !== options.sdkVersion ||
      row.standard_revision !== options.standardRevision) {
    throw new DacsNodeSqliteError(
      "database-binding-mismatch",
      "SQLite database is bound to a different profile, actor, or runtime revision",
    );
  }
}

export async function openDacsNodeSqliteDatabase(
  rawOptions: Readonly<DacsNodeSqliteDatabaseOptions>,
): Promise<DacsNodeSqliteDatabase> {
  const options = validateOptions(rawOptions);
  const location = inspectDacsNodeSqliteLocation(options.databasePath);
  if (location.status === "blocked") {
    throw new DacsNodeSqliteError(
      location.reasonCode,
      `SQLite database location is blocked: ${location.reasonCode}`,
    );
  }
  mkdirSync(dirname(location.databasePath), { recursive: true, mode: 0o700 });
  if (existsSync(location.databasePath) && lstatSync(location.databasePath).isSymbolicLink()) {
    throw new DacsNodeSqliteError(
      "database-path-symlink",
      "SQLite database path must not be a symbolic link",
    );
  }
  const existedBeforeOpen = existsSync(location.databasePath);
  const database = new BetterSqlite3(location.databasePath, {
    timeout: options.busyTimeoutMs,
  });
  try {
    chmodSync(location.databasePath, 0o600);
    database.pragma(`busy_timeout = ${options.busyTimeoutMs}`);
    database.pragma("foreign_keys = ON");
    database.pragma("trusted_schema = OFF");
    database.pragma("temp_store = MEMORY");
    preflightDatabaseIdentity(database, existedBeforeOpen);
    const journalMode = database.pragma("journal_mode = WAL", { simple: true });
    database.pragma("synchronous = FULL");
    if (journalMode !== "wal") {
      throw new DacsNodeSqliteError(
        "database-wal-unavailable",
        "SQLite WAL journal mode is unavailable",
      );
    }
    await initializeDatabase(database, options, existedBeforeOpen);
    verifyMetadata(database, options);
    const quick = database.pragma("quick_check(1)", { simple: true });
    if (quick !== "ok") {
      throw new DacsNodeSqliteError(
        "database-integrity-failed",
        "SQLite integrity check failed",
      );
    }
    return new DacsNodeSqliteDatabaseImpl(database, options, location);
  } catch (error) {
    database.close();
    throw error;
  }
}
