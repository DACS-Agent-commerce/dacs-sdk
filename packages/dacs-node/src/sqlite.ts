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
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { types as nodeTypes } from "node:util";

import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { sameCanonicalClaimIdentity, VERSION } from "@kynesyslabs/dacs";
import {
  FIXED_PRICE_X402_COORDINATOR_STORE_VERSION,
  FIXED_PRICE_OFFLINE_STANDARD_REVISION,
  FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
  FIXED_PRICE_X402_STANDARD_REVISION,
  fixedPriceOfflineOrderBindingHash,
  fixedPriceOfflineOrderLocalBindingHash,
  fixedPriceOfflineOrderViolation,
  fixedPricePayDemOrderBindingHash,
  fixedPricePayDemOrderLocalBindingHash,
  fixedPricePayDemOrderViolation,
  fixedPriceX402OrderBindingHash,
  fixedPriceX402OrderLocalBindingHash,
  fixedPriceX402OrderViolation,
  isPaymentEvidenceAnchorCompletion,
  isPaymentEvidenceAnchorRequest,
  PAYMENT_EVIDENCE_HANDSHAKE_STORE_VERSION,
  paymentEvidenceHandshakeScopeHash,
  paymentEvidenceHandshakeViolation,
  type FixedPriceOfflineCoordinatorStore,
  type FixedPriceOfflineOrderRecord,
  type FixedPriceOfflineSimulationErrorClass,
  type FixedPriceOfflineSimulationOutcome,
  type FixedPriceOfflineTrackOperationResult,
  type FixedPriceOfflineTrackRecord,
  type FixedPricePayDemCoordinatorStore,
  type FixedPricePayDemOrderRecord,
  type FixedPriceX402CoordinatorRole,
  type FixedPriceX402CoordinatorStore,
  type FixedPriceX402ErrorClass,
  type FixedPriceX402FaultedParty,
  type FixedPriceX402NormativeOutcome,
  type FixedPriceX402OrderRecord,
  type FixedPriceX402Track,
  type FixedPriceX402TrackLease,
  type FixedPriceX402TrackOperationResult,
  type FixedPriceX402TrackRecord,
  type PaymentEvidenceAnchorCompletion,
  type PaymentEvidenceAnchorRequest,
  type PaymentEvidenceBuyerWork,
  type PaymentEvidenceHandshakeLease,
  type PaymentEvidenceHandshakeLoad,
  type PaymentEvidenceHandshakeRecord,
  type PaymentEvidenceHandshakeRole,
  type PaymentEvidenceHandshakeStore,
  type PaymentEvidenceHandshakeWrite,
  type PaymentEvidenceOutboundCompletionClaim,
  type PaymentEvidenceOutboundRequestClaim,
  type PaymentEvidenceOutbox,
  type PaymentEvidencePage,
} from "@kynesyslabs/dacs/commerce";
import { isCanonicalJobId } from "@kynesyslabs/dacs/negotiate";
import BetterSqlite3 from "better-sqlite3";

import {
  DACS_NODE_LIVE_PROFILE,
  DACS_NODE_OFFLINE_PROFILE,
} from "./config.js";
import type {
  DacsHttpInboxStoreV1,
  DacsHttpOutboxStoreV1,
  DacsHttpTransportStoreOptionsV1,
} from "./transport/contracts.js";
import {
  createDacsHttpInboxSqliteStore,
  createDacsHttpOutboxSqliteStore,
  verifyDacsHttpSqliteRows,
  type DacsHttpSqliteContext,
} from "./sqliteTransport.js";

export { createSqliteRatingPublicationEffectStore } from "./sqliteRatingPublication.js";

export const DACS_NODE_SQLITE_SCHEMA_VERSION = 7 as const;
export const DACS_NODE_SQLITE_APPLICATION_ID = 0x44414353 as const;
export const DACS_NODE_SQLITE_DEFAULT_BUSY_TIMEOUT_MS = 5_000 as const;
export const DACS_NODE_SQLITE_MAX_PAGE_SIZE = 1_000 as const;

const HASH_RE = /^[0-9a-f]{64}$/;
const REASON_CODE_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const EFFECT_KINDS = new Set<DacsNodeSqliteEffectKind>([
  "session",
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
  | "session"
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
  /** Omit to use the exact SDK build version. Any supplied value must match it. */
  sdkVersion?: typeof VERSION;
  /** Omit to use the exact Standard revision supported by the selected profile. */
  standardRevision?:
    | typeof FIXED_PRICE_OFFLINE_STANDARD_REVISION
    | typeof FIXED_PRICE_PAY_DEM_STANDARD_REVISION
    | typeof FIXED_PRICE_X402_STANDARD_REVISION;
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
        | "database-path-owner-mismatch"
        | "database-path-permissions-unsafe"
        | "database-directory-owner-mismatch"
        | "database-directory-permissions-unsafe"
        | "network-filesystem"
        | "consumer-sync-directory"
        | "filesystem-inspection-failed";
      filesystemType?: string;
      filesystemMagic?: number;
    }
>;

type DacsNodeSqliteLocationBlockReason = Extract<
  DacsNodeSqliteLocationInspection,
  { status: "blocked" }
>["reasonCode"];

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

export type DacsNodeSqliteEffectCheckpointWrite = Readonly<
  | {
      status: "recorded" | "existing";
      checkpoint: Readonly<DacsNodeSqliteEffectCheckpoint>;
    }
  | { status: "missing" | "stale" | "conflict" }
>;

export interface DacsNodeSqliteEffectCheckpoint {
  name: string;
  generation: number;
  valueHash: string;
  value: unknown;
  recordedAt: number;
}

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

export interface DacsNodeSqliteUpgradeSafetyV1 {
  safe: boolean;
  intentEffects: number;
  activeEffects: number;
  reconciliationEffects: number;
  operatorActionEffects: number;
  incompleteOrders: number;
}

export type DacsNodeSqliteReadOnlyInspection = Readonly<
  | {
      status: "pass";
      diagnostics: Readonly<DacsNodeSqliteDiagnostics>;
    }
  | {
      status: "blocked" | "fail";
      reasonCode: string;
      databasePath: string;
    }
>;

export type DacsNodeSqliteUpgradeInspectionV1 = Readonly<
  | {
      status: "pass";
      diagnostics: Readonly<DacsNodeSqliteDiagnostics>;
      safety: Readonly<DacsNodeSqliteUpgradeSafetyV1>;
    }
  | {
      status: "blocked" | "fail";
      reasonCode: string;
      databasePath: string;
    }
>;

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
  /** Read-only release gate; upgrades never proceed across unfinished effects or orders. */
  upgradeSafety(): Readonly<DacsNodeSqliteUpgradeSafetyV1>;
  createLiveCoordinatorStore(
    role: FixedPriceX402CoordinatorRole,
  ): FixedPriceX402CoordinatorStore;
  createPayDemCoordinatorStore(
    role: FixedPriceX402CoordinatorRole,
  ): FixedPricePayDemCoordinatorStore;
  createOfflineCoordinatorStore(
    role: FixedPriceX402CoordinatorRole,
  ): FixedPriceOfflineCoordinatorStore;
  /**
   * Creates the live x402 payment-evidence store bound to this database's
   * single buyer or seller authority. Verifier and offline databases reject it.
   */
  createPaymentEvidenceHandshakeStore(): PaymentEvidenceHandshakeStore;
  /**
   * Creates actor-local durable HTTP replay and delivery stores. Operational
   * envelopes remain outside DACS signed artifacts.
   */
  createHttpInboxStore(
    options?: Readonly<DacsHttpTransportStoreOptionsV1>,
  ): DacsHttpInboxStoreV1;
  createHttpOutboxStore(
    options?: Readonly<DacsHttpTransportStoreOptionsV1>,
  ): DacsHttpOutboxStoreV1;
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
  /**
   * Load the exact authenticated intent payload for local effect recovery.
   * This may contain a retained one-use authorization and must never be logged
   * or exposed through diagnostics/status APIs.
   */
  loadEffectInput(
    kind: DacsNodeSqliteEffectKind,
    effectId: string,
  ): unknown | undefined;
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
  /** Commit public recovery coordinates before an irreversible adapter call. */
  recordEffectCheckpoint(input: Readonly<{
    kind: DacsNodeSqliteEffectKind;
    effectId: string;
    bindingHash: string;
    lease: Readonly<DacsNodeSqliteEffectLease>;
    name: string;
    value: unknown;
  }>): DacsNodeSqliteEffectCheckpointWrite;
  /** Load the newest integrity-checked checkpoint with this name. */
  loadEffectCheckpoint(
    kind: DacsNodeSqliteEffectKind,
    effectId: string,
    name: string,
  ): Readonly<DacsNodeSqliteEffectCheckpoint> | undefined;
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
  identity_hash: string;
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
  local_binding_hash: string;
  record_hash: string;
  record_json: string;
  revision: number;
  created_at: number;
  updated_at: number;
}

type LegacyCoordinatorRow = Omit<CoordinatorRow, "local_binding_hash">;

interface CoordinatorTrackRow {
  profile: string;
  role: string;
  job_id: string;
  local_binding_hash: string;
  track: string;
  eligible: number;
  state: string;
  outcome: string | null;
  error_class: string | null;
  faulted_party: string | null;
  withdrawn_by: string | null;
  generation: number;
  attempts: number;
  lease_expires_at: number | null;
  next_attempt_at: number | null;
  updated_at: number;
}

interface PaymentEvidenceHandshakeRow {
  role: string;
  message_id: string;
  scope_hash: string;
  request_hash: string;
  effect_id: string;
  logical_address: string;
  store_version: number;
  revision: number;
  record_hash: string;
  record_json: string;
  buyer_state: string | null;
  buyer_generation: number | null;
  buyer_attempts: number | null;
  buyer_lease_expires_at: number | null;
  buyer_retry_at: number | null;
  request_outbox_state: string | null;
  request_outbox_generation: number | null;
  request_outbox_attempts: number | null;
  request_outbox_lease_expires_at: number | null;
  request_outbox_retry_at: number | null;
  completion_hash: string | null;
  completion_outbox_state: string | null;
  completion_outbox_generation: number | null;
  completion_outbox_attempts: number | null;
  completion_outbox_lease_expires_at: number | null;
  completion_outbox_retry_at: number | null;
  created_at: number;
  updated_at: number;
}

interface PaymentEvidenceReservationRow {
  role: string;
  scope_hash: string;
  reservation_kind: string;
  identity: string;
  message_id: string;
  request_hash: string;
  created_at: number;
}

interface PaymentEvidenceHistoryRow {
  sequence: number;
  role: string;
  message_id: string;
  revision: number;
  occurred_at: number;
  record_hash: string;
  record_json: string;
  previous_entry_hash: string | null;
  entry_hash: string;
}

type CoordinatorProfile = "live-x402" | "live-pay-dem" | "offline";
type CoordinatorRecord =
  | FixedPriceX402OrderRecord
  | FixedPricePayDemOrderRecord
  | FixedPriceOfflineOrderRecord;
type CoordinatorTrackRecord = FixedPriceX402TrackRecord | FixedPriceOfflineTrackRecord;
type CoordinatorOutcome = FixedPriceX402NormativeOutcome | FixedPriceOfflineSimulationOutcome;
type CoordinatorErrorClass = FixedPriceX402ErrorClass | FixedPriceOfflineSimulationErrorClass;
type CoordinatorOperationResult =
  | FixedPriceX402TrackOperationResult
  | FixedPriceOfflineTrackOperationResult;

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

const OFFLINE_COORDINATOR_ERROR_CLASSES =
  new Set<FixedPriceOfflineSimulationErrorClass>([
    "simulated-permanent",
    "simulated-transient",
    "simulated-counterparty",
    "simulated-substrate",
    "simulated-settlement-atomicity",
  ]);

const FAULTED_PARTIES = new Set<FixedPriceX402FaultedParty>([
  "buyer",
  "seller",
  "orchestrator",
  "none",
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

const MIGRATION_3 = `
DROP INDEX dacs_coordinator_orders_runnable_idx;

CREATE TABLE dacs_coordinator_tracks (
  profile TEXT NOT NULL,
  role TEXT NOT NULL,
  job_id TEXT NOT NULL,
  track TEXT NOT NULL,
  eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
  state TEXT NOT NULL,
  outcome TEXT,
  error_class TEXT,
  generation INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  lease_expires_at INTEGER,
  next_attempt_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile, role, job_id, track),
  FOREIGN KEY (profile, role, job_id)
    REFERENCES dacs_coordinator_orders (profile, role, job_id)
    ON DELETE CASCADE,
  CHECK (profile IN ('live-x402', 'offline')),
  CHECK (role IN ('buyer', 'seller')),
  CHECK (track IN (
    'agreement', 'payment', 'payment-evidence', 'delivery',
    'buyer-received', 'delivery-evidence', 'audit'
  )),
  CHECK (generation >= 0),
  CHECK (attempts >= 0),
  CHECK (attempts = generation),
  CHECK (lease_expires_at IS NULL OR lease_expires_at >= 0),
  CHECK (next_attempt_at IS NULL OR next_attempt_at >= 0),
  CHECK (updated_at >= 0),
  CHECK (state IN (
    'not-started', 'running', 'pending-retry', 'indeterminate',
    'operator-action', 'final'
  )),
  CHECK ((state = 'running') = (lease_expires_at IS NOT NULL)),
  CHECK ((state IN ('pending-retry', 'indeterminate')) OR next_attempt_at IS NULL),
  CHECK ((state = 'final') = (outcome IS NOT NULL)),
  CHECK (outcome IS NULL OR outcome IN ('success', 'failure', 'aborted')),
  CHECK (error_class IS NULL OR error_class IN (
    'permanent', 'transient', 'counterparty', 'substrate',
    'settlement-atomicity'
  )),
  CHECK (error_class IS NULL OR outcome = 'failure'),
  CHECK (outcome IS NULL OR outcome != 'failure' OR error_class IS NOT NULL)
) STRICT, WITHOUT ROWID;

CREATE INDEX dacs_coordinator_tracks_runnable_idx
  ON dacs_coordinator_tracks (
    profile, role, track, eligible, state, next_attempt_at,
    lease_expires_at, job_id
  );

DROP INDEX dacs_effect_history_effect_idx;
DROP INDEX dacs_effects_runnable_idx;
DROP TABLE dacs_effect_history;
DROP TABLE dacs_effects;

CREATE TABLE dacs_effects (
  effect_kind TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  job_id TEXT,
  binding_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  identity_hash TEXT NOT NULL,
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
  detail_json TEXT NOT NULL,
  previous_entry_hash TEXT,
  entry_hash TEXT NOT NULL,
  FOREIGN KEY (effect_kind, effect_id)
    REFERENCES dacs_effects (effect_kind, effect_id)
) STRICT;

CREATE INDEX dacs_effects_runnable_idx
  ON dacs_effects (state, retry_at, effect_kind, effect_id);
CREATE INDEX dacs_effect_history_effect_idx
  ON dacs_effect_history (effect_kind, effect_id, sequence);
`;

const MIGRATION_4_PREPARE = `
DROP INDEX dacs_coordinator_tracks_runnable_idx;

ALTER TABLE dacs_coordinator_tracks RENAME TO dacs_coordinator_tracks_v3;
ALTER TABLE dacs_coordinator_orders RENAME TO dacs_coordinator_orders_v3;

CREATE TABLE dacs_coordinator_orders (
  profile TEXT NOT NULL,
  role TEXT NOT NULL,
  job_id TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  local_binding_hash TEXT NOT NULL,
  record_hash TEXT NOT NULL,
  record_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile, role, job_id),
  CHECK (profile IN ('live-x402', 'offline')),
  CHECK (role IN ('buyer', 'seller')),
  CHECK (length(binding_hash) = 64 AND binding_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(local_binding_hash) = 64 AND local_binding_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(record_hash) = 64 AND record_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (revision > 0),
  CHECK (created_at >= 0),
  CHECK (updated_at >= created_at)
) STRICT, WITHOUT ROWID;

CREATE TABLE dacs_coordinator_tracks (
  profile TEXT NOT NULL,
  role TEXT NOT NULL,
  job_id TEXT NOT NULL,
  local_binding_hash TEXT NOT NULL,
  track TEXT NOT NULL,
  eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
  state TEXT NOT NULL,
  outcome TEXT,
  error_class TEXT,
  faulted_party TEXT,
  withdrawn_by TEXT,
  generation INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  lease_expires_at INTEGER,
  next_attempt_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile, role, job_id, track),
  FOREIGN KEY (profile, role, job_id)
    REFERENCES dacs_coordinator_orders (profile, role, job_id)
    ON DELETE CASCADE,
  CHECK (profile IN ('live-x402', 'offline')),
  CHECK (role IN ('buyer', 'seller')),
  CHECK (length(local_binding_hash) = 64 AND
    local_binding_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (track IN (
    'agreement', 'payment', 'payment-evidence', 'delivery',
    'buyer-received', 'delivery-evidence', 'audit'
  )),
  CHECK (generation >= 0),
  CHECK (attempts >= 0),
  CHECK (attempts = generation),
  CHECK (lease_expires_at IS NULL OR lease_expires_at >= 0),
  CHECK (next_attempt_at IS NULL OR next_attempt_at >= 0),
  CHECK (updated_at >= 0),
  CHECK (state IN (
    'not-started', 'running', 'pending-retry', 'indeterminate',
    'operator-action', 'final'
  )),
  CHECK ((state = 'running') = (lease_expires_at IS NOT NULL)),
  CHECK ((state IN ('pending-retry', 'indeterminate')) OR next_attempt_at IS NULL),
  CHECK ((state = 'final') = (outcome IS NOT NULL)),
  CHECK (
    (profile = 'live-x402' AND
      (outcome IS NULL OR outcome IN ('success', 'failure', 'aborted')) AND
      (error_class IS NULL OR error_class IN (
        'permanent', 'transient', 'counterparty', 'substrate',
        'settlement-atomicity'
      )) AND
      (faulted_party IS NULL OR faulted_party IN ('buyer', 'seller', 'none')) AND
      (withdrawn_by IS NULL OR withdrawn_by IN ('buyer', 'seller')) AND
      (
        (outcome = 'failure' AND error_class IS NOT NULL AND
          faulted_party IS NOT NULL AND withdrawn_by IS NULL AND
          ((error_class = 'substrate') = (faulted_party = 'none'))) OR
        (outcome = 'aborted' AND error_class IS NULL AND
          faulted_party IS NULL AND withdrawn_by IS NOT NULL) OR
        ((outcome IS NULL OR outcome = 'success') AND error_class IS NULL AND
          faulted_party IS NULL AND withdrawn_by IS NULL)
      )) OR
    (profile = 'offline' AND
      (outcome IS NULL OR outcome IN (
        'simulated-success', 'simulated-failure', 'simulated-aborted'
      )) AND
      (error_class IS NULL OR error_class IN (
        'simulated-permanent', 'simulated-transient',
        'simulated-counterparty', 'simulated-substrate',
        'simulated-settlement-atomicity'
      )) AND
      faulted_party IS NULL AND withdrawn_by IS NULL AND
      (
        (outcome = 'simulated-failure' AND error_class IS NOT NULL) OR
        ((outcome IS NULL OR outcome IN (
          'simulated-success', 'simulated-aborted'
        )) AND error_class IS NULL)
      ))
  )
) STRICT, WITHOUT ROWID;

CREATE INDEX dacs_coordinator_tracks_runnable_idx
  ON dacs_coordinator_tracks (
    profile, role, track, eligible, state, next_attempt_at,
    lease_expires_at, job_id
  );
`;

const MIGRATION_4_FINALIZE = `
DROP TABLE dacs_coordinator_tracks_v3;
DROP TABLE dacs_coordinator_orders_v3;
`;

/**
 * DACS One-Click Install Specification §§11–12: actor-local durable
 * payment-evidence handshakes, runnable projections, and replay reservations.
 * Keep this historical migration immutable after release.
 */
const MIGRATION_5 = `
CREATE TABLE dacs_payment_evidence_handshakes (
  role TEXT NOT NULL,
  message_id TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  logical_address TEXT NOT NULL,
  store_version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  record_hash TEXT NOT NULL,
  record_json TEXT NOT NULL,
  buyer_state TEXT,
  buyer_generation INTEGER,
  buyer_attempts INTEGER,
  buyer_lease_expires_at INTEGER,
  buyer_retry_at INTEGER,
  request_outbox_state TEXT,
  request_outbox_generation INTEGER,
  request_outbox_attempts INTEGER,
  request_outbox_lease_expires_at INTEGER,
  request_outbox_retry_at INTEGER,
  completion_hash TEXT,
  completion_outbox_state TEXT,
  completion_outbox_generation INTEGER,
  completion_outbox_attempts INTEGER,
  completion_outbox_lease_expires_at INTEGER,
  completion_outbox_retry_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (role, message_id),
  CHECK (role IN ('buyer', 'seller')),
  CHECK (length(scope_hash) = 64 AND scope_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(record_hash) = 64 AND record_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (store_version > 0),
  CHECK (revision > 0),
  CHECK (created_at >= 0),
  CHECK (updated_at >= created_at),
  CHECK (buyer_state IS NULL OR buyer_state IN (
    'pending', 'reconciliation-required', 'operator-action', 'complete'
  )),
  CHECK (request_outbox_state IS NULL OR request_outbox_state IN (
    'pending', 'sending', 'acknowledged', 'operator-action'
  )),
  CHECK (completion_outbox_state IS NULL OR completion_outbox_state IN (
    'pending', 'sending', 'acknowledged', 'operator-action'
  )),
  CHECK ((buyer_generation IS NULL) = (buyer_state IS NULL)),
  CHECK ((buyer_attempts IS NULL) = (buyer_state IS NULL)),
  CHECK (buyer_generation IS NULL OR
    (buyer_generation >= 0 AND buyer_attempts = buyer_generation)),
  CHECK (buyer_lease_expires_at IS NULL OR buyer_lease_expires_at >= 0),
  CHECK (buyer_retry_at IS NULL OR buyer_retry_at >= 0),
  CHECK ((request_outbox_generation IS NULL) = (request_outbox_state IS NULL)),
  CHECK ((request_outbox_attempts IS NULL) = (request_outbox_state IS NULL)),
  CHECK (request_outbox_generation IS NULL OR
    (request_outbox_generation >= 0 AND
      request_outbox_attempts = request_outbox_generation)),
  CHECK (request_outbox_lease_expires_at IS NULL OR
    request_outbox_lease_expires_at >= 0),
  CHECK (request_outbox_retry_at IS NULL OR request_outbox_retry_at >= 0),
  CHECK ((completion_outbox_generation IS NULL) =
    (completion_outbox_state IS NULL)),
  CHECK ((completion_outbox_attempts IS NULL) =
    (completion_outbox_state IS NULL)),
  CHECK (completion_outbox_generation IS NULL OR
    (completion_outbox_generation >= 0 AND
      completion_outbox_attempts = completion_outbox_generation)),
  CHECK (completion_outbox_lease_expires_at IS NULL OR
    completion_outbox_lease_expires_at >= 0),
  CHECK (completion_outbox_retry_at IS NULL OR completion_outbox_retry_at >= 0),
  CHECK (
    (role = 'buyer' AND buyer_state IS NOT NULL AND
      request_outbox_state IS NULL) OR
    (role = 'seller' AND buyer_state IS NULL AND
      request_outbox_state IS NOT NULL AND completion_outbox_state IS NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE dacs_payment_evidence_reservations (
  role TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  reservation_kind TEXT NOT NULL,
  identity TEXT NOT NULL,
  message_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (role, scope_hash, reservation_kind, identity),
  FOREIGN KEY (role, message_id)
    REFERENCES dacs_payment_evidence_handshakes (role, message_id)
    ON DELETE RESTRICT,
  CHECK (role IN ('buyer', 'seller')),
  CHECK (reservation_kind IN ('message', 'effect', 'logical-address')),
  CHECK (length(scope_hash) = 64 AND scope_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (created_at >= 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE dacs_payment_evidence_history (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  message_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  occurred_at INTEGER NOT NULL,
  record_hash TEXT NOT NULL,
  record_json TEXT NOT NULL,
  previous_entry_hash TEXT,
  entry_hash TEXT NOT NULL,
  UNIQUE (role, message_id, revision),
  FOREIGN KEY (role, message_id)
    REFERENCES dacs_payment_evidence_handshakes (role, message_id)
    ON DELETE RESTRICT,
  CHECK (role IN ('buyer', 'seller')),
  CHECK (revision > 0),
  CHECK (occurred_at >= 0),
  CHECK (length(record_hash) = 64 AND record_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (previous_entry_hash IS NULL OR
    (length(previous_entry_hash) = 64 AND
      previous_entry_hash NOT GLOB '*[^0-9a-f]*')),
  CHECK (length(entry_hash) = 64 AND entry_hash NOT GLOB '*[^0-9a-f]*')
) STRICT;

CREATE INDEX dacs_payment_evidence_buyer_runnable_idx
  ON dacs_payment_evidence_handshakes (
    role, scope_hash, buyer_state, buyer_retry_at,
    buyer_lease_expires_at, message_id
  );
CREATE INDEX dacs_payment_evidence_request_outbox_idx
  ON dacs_payment_evidence_handshakes (
    role, scope_hash, request_outbox_state, request_outbox_retry_at,
    request_outbox_lease_expires_at, message_id
  );
CREATE INDEX dacs_payment_evidence_completion_outbox_idx
  ON dacs_payment_evidence_handshakes (
    role, scope_hash, completion_outbox_state, completion_outbox_retry_at,
    completion_outbox_lease_expires_at, message_id
  );
CREATE INDEX dacs_payment_evidence_history_record_idx
  ON dacs_payment_evidence_history (role, message_id, revision);
`;

/**
 * DACS One-Click Install Specification §§12.4–12.6: authenticated HTTP replay
 * reservations, exact-envelope outboxes, acknowledgement evidence and fenced
 * retry history. These are operational host records, never DACS artifacts.
 */
const MIGRATION_6 = `
CREATE TABLE dacs_http_clock (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_time INTEGER NOT NULL CHECK (last_time >= 0)
) STRICT;

INSERT INTO dacs_http_clock (singleton, last_time) VALUES (1, 0);

CREATE TABLE dacs_http_inbox (
  sender TEXT NOT NULL,
  audience TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  state TEXT NOT NULL,
  authentication_hash TEXT NOT NULL,
  identity_evidence_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  disposition TEXT,
  reason_code TEXT,
  received_at INTEGER NOT NULL,
  retain_until INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  record_hash TEXT NOT NULL,
  record_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (sender, audience, envelope_id),
  CHECK (state IN ('pending', 'disposed')),
  CHECK (length(authentication_hash) = 64 AND
    authentication_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(identity_evidence_hash) = 64 AND
    identity_evidence_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(envelope_id) = 64 AND envelope_id NOT GLOB '*[^0-9a-f]*'),
  CHECK (disposition IS NULL OR disposition IN ('accepted', 'existing', 'rejected')),
  CHECK ((state = 'disposed') = (disposition IS NOT NULL)),
  CHECK ((disposition = 'rejected') = (reason_code IS NOT NULL)),
  CHECK (revision > 0),
  CHECK (received_at >= 0),
  CHECK (retain_until >= received_at),
  CHECK (updated_at >= received_at)
) STRICT, WITHOUT ROWID;

CREATE TABLE dacs_http_inbox_history (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT NOT NULL,
  audience TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  occurred_at INTEGER NOT NULL,
  record_hash TEXT NOT NULL,
  record_json TEXT NOT NULL,
  previous_entry_hash TEXT,
  entry_hash TEXT NOT NULL,
  UNIQUE (sender, audience, envelope_id, revision),
  FOREIGN KEY (sender, audience, envelope_id)
    REFERENCES dacs_http_inbox (sender, audience, envelope_id)
    ON DELETE RESTRICT,
  CHECK (revision > 0),
  CHECK (occurred_at >= 0),
  CHECK (length(record_hash) = 64 AND record_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (previous_entry_hash IS NULL OR
    (length(previous_entry_hash) = 64 AND
      previous_entry_hash NOT GLOB '*[^0-9a-f]*')),
  CHECK (length(entry_hash) = 64 AND entry_hash NOT GLOB '*[^0-9a-f]*')
) STRICT;

CREATE TABLE dacs_http_outbox (
  envelope_id TEXT PRIMARY KEY,
  envelope_hash TEXT NOT NULL,
  job_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  audience TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  generation INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  owner TEXT,
  lease_expires_at INTEGER,
  next_attempt_at INTEGER NOT NULL,
  acknowledgement_hash TEXT,
  reason_code TEXT,
  retain_until INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  record_hash TEXT NOT NULL,
  record_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (length(envelope_id) = 64 AND envelope_id NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(envelope_hash) = 64 AND envelope_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (state IN ('pending', 'sending', 'acknowledged', 'operator-action')),
  CHECK (generation >= 0),
  CHECK (attempts >= 0),
  CHECK (attempts = generation),
  CHECK ((state = 'sending') = (owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (lease_expires_at IS NULL OR lease_expires_at >= 0),
  CHECK (next_attempt_at >= 0),
  CHECK (acknowledgement_hash IS NULL OR
    (length(acknowledgement_hash) = 64 AND
      acknowledgement_hash NOT GLOB '*[^0-9a-f]*')),
  CHECK ((state = 'acknowledged') = (acknowledgement_hash IS NOT NULL)),
  CHECK (revision > 0),
  CHECK (created_at >= 0),
  CHECK (retain_until >= created_at),
  CHECK (updated_at >= created_at)
) STRICT, WITHOUT ROWID;

CREATE TABLE dacs_http_outbox_history (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  envelope_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  occurred_at INTEGER NOT NULL,
  record_hash TEXT NOT NULL,
  record_json TEXT NOT NULL,
  previous_entry_hash TEXT,
  entry_hash TEXT NOT NULL,
  UNIQUE (envelope_id, revision),
  FOREIGN KEY (envelope_id)
    REFERENCES dacs_http_outbox (envelope_id)
    ON DELETE RESTRICT,
  CHECK (revision > 0),
  CHECK (occurred_at >= 0),
  CHECK (length(record_hash) = 64 AND record_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (previous_entry_hash IS NULL OR
    (length(previous_entry_hash) = 64 AND
      previous_entry_hash NOT GLOB '*[^0-9a-f]*')),
  CHECK (length(entry_hash) = 64 AND entry_hash NOT GLOB '*[^0-9a-f]*')
) STRICT;

CREATE INDEX dacs_http_inbox_page_idx
  ON dacs_http_inbox (state, envelope_id, sender, audience);
CREATE INDEX dacs_http_inbox_job_idx
  ON dacs_http_inbox (job_id, envelope_id, sender, audience);
CREATE INDEX dacs_http_inbox_history_record_idx
  ON dacs_http_inbox_history (sender, audience, envelope_id, revision);
CREATE INDEX dacs_http_outbox_page_idx
  ON dacs_http_outbox (state, envelope_id);
CREATE INDEX dacs_http_outbox_runnable_idx
  ON dacs_http_outbox (state, next_attempt_at, lease_expires_at, envelope_id);
CREATE INDEX dacs_http_outbox_job_idx
  ON dacs_http_outbox (job_id, envelope_id);
CREATE INDEX dacs_http_outbox_history_record_idx
  ON dacs_http_outbox_history (envelope_id, revision);
`;

/**
 * Add a separate native-DEM coordinator namespace. Historical x402 rows retain
 * their exact profile and bytes; the migration only broadens the constrained
 * operational profile discriminator used by new records.
 */
const MIGRATION_7_PREPARE = MIGRATION_4_PREPARE
  .replaceAll("_v3", "_v6")
  .replaceAll(
    "CHECK (profile IN ('live-x402', 'offline'))",
    "CHECK (profile IN ('live-x402', 'live-pay-dem', 'offline'))",
  )
  .replace(
    "(profile = 'live-x402' AND",
    "(profile IN ('live-x402', 'live-pay-dem') AND",
  );

const MIGRATION_7_COPY = `
INSERT INTO dacs_coordinator_orders (
  profile, role, job_id, binding_hash, local_binding_hash, record_hash,
  record_json, revision, created_at, updated_at
)
SELECT profile, role, job_id, binding_hash, local_binding_hash, record_hash,
  record_json, revision, created_at, updated_at
FROM dacs_coordinator_orders_v6;

INSERT INTO dacs_coordinator_tracks (
  profile, role, job_id, local_binding_hash, track, eligible, state, outcome,
  error_class, faulted_party, withdrawn_by, generation, attempts,
  lease_expires_at, next_attempt_at, updated_at
)
SELECT profile, role, job_id, local_binding_hash, track, eligible, state,
  outcome, error_class, faulted_party, withdrawn_by, generation, attempts,
  lease_expires_at, next_attempt_at, updated_at
FROM dacs_coordinator_tracks_v6;
`;

const MIGRATION_7_FINALIZE = `
DROP TABLE dacs_coordinator_tracks_v6;
DROP TABLE dacs_coordinator_orders_v6;
`;

function applyMigration7(database: BetterSqlite3.Database): void {
  database.exec(MIGRATION_7_PREPARE);
  database.exec(MIGRATION_7_COPY);
  database.exec(MIGRATION_7_FINALIZE);
}

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

function liveCoordinatorProfile(profile: CoordinatorProfile): boolean {
  return profile === "live-x402" || profile === "live-pay-dem";
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
    : profile === "live-pay-dem"
      ? fixedPricePayDemOrderViolation(value)
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
    : profile === "live-pay-dem"
      ? fixedPricePayDemOrderBindingHash(
          value as Parameters<typeof fixedPricePayDemOrderBindingHash>[0],
        )
      : fixedPriceOfflineOrderBindingHash(
          value as Parameters<typeof fixedPriceOfflineOrderBindingHash>[0],
        );
}

function coordinatorLocalBindingHash(
  profile: CoordinatorProfile,
  value: Readonly<{
    jobId: string;
    buyer: string;
    seller: string;
    protocol: CoordinatorRecord["protocol"];
    sdkJobs: CoordinatorRecord["sdkJobs"];
  }>,
): string {
  return profile === "live-x402"
    ? fixedPriceX402OrderLocalBindingHash(
        value as Parameters<typeof fixedPriceX402OrderLocalBindingHash>[0],
      )
    : profile === "live-pay-dem"
      ? fixedPricePayDemOrderLocalBindingHash(
          value as Parameters<typeof fixedPricePayDemOrderLocalBindingHash>[0],
        )
      : fixedPriceOfflineOrderLocalBindingHash(
          value as Parameters<typeof fixedPriceOfflineOrderLocalBindingHash>[0],
        );
}

function coordinatorSuccessOutcome(profile: CoordinatorProfile): CoordinatorOutcome {
  return profile === "offline" ? "simulated-success" : "success";
}

function coordinatorFailureOutcome(profile: CoordinatorProfile): CoordinatorOutcome {
  return profile === "offline" ? "simulated-failure" : "failure";
}

function coordinatorAbortedOutcome(profile: CoordinatorProfile): CoordinatorOutcome {
  return profile === "offline" ? "simulated-aborted" : "aborted";
}

function coordinatorErrorClassAllowed(
  profile: CoordinatorProfile,
  value: unknown,
): value is CoordinatorErrorClass {
  return profile === "offline"
    ? OFFLINE_COORDINATOR_ERROR_CLASSES.has(value as FixedPriceOfflineSimulationErrorClass)
    : COORDINATOR_ERROR_CLASSES.has(value as FixedPriceX402ErrorClass);
}

function coordinatorAuthorityMatches(
  record: Readonly<Pick<CoordinatorRecord, "role" | "buyer" | "seller">>,
  authority: string,
): boolean {
  return (record.role === "buyer" ? record.buyer : record.seller) === authority;
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
  let expectedLocalBindingHash: string | undefined;
  try {
    expectedLocalBindingHash = coordinatorLocalBindingHash(profile, {
      jobId: record.jobId,
      buyer: record.buyer,
      seller: record.seller,
      protocol: record.protocol,
      sdkJobs: record.sdkJobs,
    });
  } catch {
    // The profile validator below supplies the stable corruption reason.
  }
  if (violation || recordJson !== row.record_json || sha256Hex(recordJson) !== row.record_hash ||
      row.profile !== profile || row.role !== record.role || row.job_id !== record.jobId ||
      row.binding_hash !== record.bindingHash ||
      row.local_binding_hash !== record.localBindingHash ||
      expectedLocalBindingHash !== record.localBindingHash ||
      row.revision !== record.revision ||
      row.created_at !== record.createdAt || row.updated_at !== record.updatedAt) {
    return {
      status: "corrupt",
      reason: violation ?? "coordinator record integrity binding differs",
    };
  }
  return { status: "ok", record: clone(record) };
}

type LegacyCoordinatorDecode = Readonly<
  | {
      status: "ok";
      record: Readonly<CoordinatorRecord>;
      legacyRecord: Readonly<Record<string, unknown>>;
    }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string }
>;

const LEGACY_OFFLINE_OUTCOMES = Object.freeze({
  success: "simulated-success",
  failure: "simulated-failure",
  aborted: "simulated-aborted",
} as const);

const LEGACY_OFFLINE_ERROR_CLASSES = Object.freeze({
  permanent: "simulated-permanent",
  transient: "simulated-transient",
  counterparty: "simulated-counterparty",
  substrate: "simulated-substrate",
  "settlement-atomicity": "simulated-settlement-atomicity",
} as const);

function legacyCoordinatorFromRow(
  row: Readonly<LegacyCoordinatorRow>,
  profile: CoordinatorProfile,
): LegacyCoordinatorDecode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.record_json) as unknown;
  } catch {
    return { status: "corrupt", reason: "legacy coordinator record JSON is malformed" };
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
    return { status: "corrupt", reason: "legacy coordinator record is not canonical data" };
  }
  if (!exactDataKeys(parsed, [
    "storeVersion",
    "revision",
    "role",
    "jobId",
    "buyer",
    "seller",
    "protocol",
    "bindingHash",
    "sdkJobs",
    "tracks",
    "createdAt",
    "updatedAt",
  ]) || (parsed.role !== "buyer" && parsed.role !== "seller") ||
      recordJson !== row.record_json || sha256Hex(recordJson) !== row.record_hash ||
      row.profile !== profile || row.role !== parsed.role || row.job_id !== parsed.jobId ||
      row.binding_hash !== parsed.bindingHash || row.revision !== parsed.revision ||
      row.created_at !== parsed.createdAt || row.updated_at !== parsed.updatedAt ||
      !exactDataKeys(parsed.tracks, coordinatorTracks(parsed.role as FixedPriceX402CoordinatorRole))) {
    return { status: "corrupt", reason: "legacy coordinator record integrity binding differs" };
  }

  const legacyRecord = clone(parsed) as Record<string, unknown>;
  const tracks = clone(parsed.tracks) as Record<string, Record<string, unknown>>;
  for (const track of coordinatorTracks(parsed.role as FixedPriceX402CoordinatorRole)) {
    const retained = tracks[track];
    if (!retained) {
      return { status: "corrupt", reason: "legacy coordinator track map is incomplete" };
    }
    if (liveCoordinatorProfile(profile) && retained.state === "final" &&
        (retained.outcome === "failure" || retained.outcome === "aborted")) {
      return {
        status: "corrupt",
        reason: "legacy live terminal record lacks mandatory DACS-5 attribution",
      };
    }
    if (profile === "offline") {
      if (retained.outcome !== undefined) {
        const mapped = LEGACY_OFFLINE_OUTCOMES[
          retained.outcome as keyof typeof LEGACY_OFFLINE_OUTCOMES
        ];
        if (!mapped) {
          return { status: "corrupt", reason: "legacy offline outcome is unsupported" };
        }
        retained.outcome = mapped;
      }
      if (retained.errorClass !== undefined) {
        const mapped = LEGACY_OFFLINE_ERROR_CLASSES[
          retained.errorClass as keyof typeof LEGACY_OFFLINE_ERROR_CLASSES
        ];
        if (!mapped) {
          return { status: "corrupt", reason: "legacy offline error class is unsupported" };
        }
        retained.errorClass = mapped;
      }
    }
  }

  try {
    const upgraded = {
      ...clone(parsed),
      localBindingHash: coordinatorLocalBindingHash(profile, {
        jobId: parsed.jobId as string,
        buyer: parsed.buyer as string,
        seller: parsed.seller as string,
        protocol: parsed.protocol as CoordinatorRecord["protocol"],
        sdkJobs: parsed.sdkJobs as CoordinatorRecord["sdkJobs"],
      }),
      tracks,
    } as CoordinatorRecord;
    const violation = coordinatorViolation(profile, upgraded);
    return violation
      ? { status: "corrupt", reason: violation }
      : { status: "ok", record: clone(upgraded), legacyRecord };
  } catch (error) {
    return {
      status: "corrupt",
      reason: error instanceof Error
        ? error.message
        : "legacy coordinator local binding cannot be authenticated",
    };
  }
}

function coordinatorTrack(
  record: Readonly<CoordinatorRecord>,
  track: FixedPriceX402Track,
): Readonly<CoordinatorTrackRecord> | undefined {
  return record.tracks[track] as Readonly<CoordinatorTrackRecord> | undefined;
}

function coordinatorTrackFinal(
  record: Readonly<CoordinatorRecord>,
  track: FixedPriceX402Track,
): boolean {
  return coordinatorTrack(record, track)?.state === "final";
}

function coordinatorTrackSuccessful(
  profile: CoordinatorProfile,
  record: Readonly<CoordinatorRecord>,
  track: FixedPriceX402Track,
): boolean {
  const retained = coordinatorTrack(record, track);
  return retained?.state === "final" &&
    retained.outcome === coordinatorSuccessOutcome(profile);
}

function coordinatorTerminalResult(
  profile: CoordinatorProfile,
  record: Readonly<CoordinatorRecord>,
): Readonly<{
  outcome: CoordinatorOutcome;
  errorClass?: CoordinatorErrorClass;
  faultedParty?: FixedPriceX402FaultedParty;
  withdrawnBy?: FixedPriceX402CoordinatorRole;
}> | null {
  const tracks: readonly FixedPriceX402Track[] = record.role === "buyer"
    ? ["agreement", "payment", "buyer-received"]
    : ["agreement", "payment", "delivery"];
  for (const track of tracks) {
    const retained = coordinatorTrack(record, track);
    if (retained?.state === "final" &&
        retained.outcome !== coordinatorSuccessOutcome(profile)) {
      return retained.outcome === coordinatorFailureOutcome(profile)
        ? {
            outcome: coordinatorFailureOutcome(profile),
            errorClass: retained.errorClass!,
            ...(retained.faultedParty === undefined
              ? {}
              : { faultedParty: retained.faultedParty }),
          }
        : {
            outcome: coordinatorAbortedOutcome(profile),
            ...(retained.withdrawnBy === undefined
              ? {}
              : { withdrawnBy: retained.withdrawnBy }),
          };
    }
  }
  return null;
}

function coordinatorTrackEligible(
  profile: CoordinatorProfile,
  record: Readonly<CoordinatorRecord>,
  track: FixedPriceX402Track,
): boolean {
  if (!coordinatorTracks(record.role).includes(track)) return false;
  switch (track) {
    case "agreement": return true;
    case "payment": return coordinatorTrackSuccessful(profile, record, "agreement");
    case "payment-evidence": return coordinatorTrackFinal(record, "payment");
    case "delivery":
      return record.role === "seller" &&
        coordinatorTrackSuccessful(profile, record, "payment");
    case "buyer-received":
      return record.role === "buyer" &&
        coordinatorTrackSuccessful(profile, record, "payment");
    case "delivery-evidence":
      return record.role === "seller" && coordinatorTrackFinal(record, "delivery");
    case "audit": {
      const agreement = coordinatorTrack(record, "agreement");
      if (agreement?.state === "final" &&
          agreement.outcome !== coordinatorSuccessOutcome(profile)) return true;
      const payment = coordinatorTrack(record, "payment");
      if (payment?.state === "final" &&
          payment.outcome !== coordinatorSuccessOutcome(profile)) {
        return coordinatorTrackSuccessful(profile, record, "payment-evidence");
      }
      return record.role === "buyer"
        ? coordinatorTrackSuccessful(profile, record, "payment-evidence") &&
            coordinatorTrackFinal(record, "buyer-received")
        : coordinatorTrackSuccessful(profile, record, "payment-evidence") &&
            coordinatorTrackSuccessful(profile, record, "delivery-evidence");
    }
  }
}

function coordinatorResultAllowed(
  profile: CoordinatorProfile,
  record: Readonly<CoordinatorRecord>,
  track: FixedPriceX402Track,
  result: Readonly<{
    outcome: CoordinatorOutcome;
    errorClass?: CoordinatorErrorClass;
    faultedParty?: FixedPriceX402FaultedParty;
    withdrawnBy?: FixedPriceX402CoordinatorRole;
  }>,
): boolean {
  if (liveCoordinatorProfile(profile) && result.outcome === "failure" &&
      (result.faultedParty === "orchestrator" ||
        (result.errorClass === "substrate") !== (result.faultedParty === "none"))) {
    return false;
  }
  if (track === "payment-evidence" || track === "delivery-evidence") {
    return result.outcome === coordinatorSuccessOutcome(profile);
  }
  if (track === "audit") {
    const expected = coordinatorTerminalResult(profile, record) ?? {
      outcome: coordinatorSuccessOutcome(profile),
    };
    return result.outcome === expected.outcome &&
      (expected.outcome !== coordinatorFailureOutcome(profile) ||
        (result.errorClass === expected.errorClass &&
          (!liveCoordinatorProfile(profile) ||
            result.faultedParty === expected.faultedParty))) &&
      (expected.outcome !== coordinatorAbortedOutcome(profile) ||
        !liveCoordinatorProfile(profile) ||
        result.withdrawnBy === expected.withdrawnBy);
  }
  if (result.outcome === coordinatorAbortedOutcome(profile) &&
      (coordinatorTrackSuccessful(profile, record, "payment") ||
        coordinatorTrackSuccessful(profile, record, "delivery"))) return false;
  return true;
}

function coordinatorTrackRunnable(
  profile: CoordinatorProfile,
  record: Readonly<CoordinatorRecord>,
  track: FixedPriceX402Track,
  now: number,
): boolean {
  const retained = coordinatorTrack(record, track);
  if (!retained || !coordinatorTrackEligible(profile, record, track) ||
      retained.state === "final" || retained.state === "operator-action") return false;
  if (retained.nextAttemptAt !== undefined && retained.nextAttemptAt > now) return false;
  return retained.lease === undefined || retained.lease.expiresAt <= now;
}

function coordinatorTrackProjection(
  profile: CoordinatorProfile,
  record: Readonly<CoordinatorRecord>,
): readonly CoordinatorTrackRow[] {
  return coordinatorTracks(record.role).map((track) => {
    const retained = record.tracks[track]!;
    return {
      profile,
      role: record.role,
      job_id: record.jobId,
      local_binding_hash: record.localBindingHash,
      track,
      eligible: coordinatorTrackEligible(profile, record, track) ? 1 : 0,
      state: retained.state,
      outcome: retained.outcome ?? null,
      error_class: retained.errorClass ?? null,
      faulted_party: retained.faultedParty ?? null,
      withdrawn_by: retained.withdrawnBy ?? null,
      generation: retained.generation,
      attempts: retained.attempts,
      lease_expires_at: retained.lease?.expiresAt ?? null,
      next_attempt_at: retained.nextAttemptAt ?? null,
      updated_at: retained.updatedAt,
    };
  });
}

function replaceCoordinatorTrackProjection(
  database: BetterSqlite3.Database,
  profile: CoordinatorProfile,
  record: Readonly<CoordinatorRecord>,
): void {
  database.prepare(`
    DELETE FROM dacs_coordinator_tracks
    WHERE profile = ? AND role = ? AND job_id = ?
  `).run(profile, record.role, record.jobId);
  const insert = database.prepare(`
    INSERT INTO dacs_coordinator_tracks (
      profile, role, job_id, local_binding_hash, track, eligible, state,
      outcome, error_class, faulted_party, withdrawn_by, generation, attempts,
      lease_expires_at, next_attempt_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of coordinatorTrackProjection(profile, record)) {
    insert.run(
      row.profile,
      row.role,
      row.job_id,
      row.local_binding_hash,
      row.track,
      row.eligible,
      row.state,
      row.outcome,
      row.error_class,
      row.faulted_party,
      row.withdrawn_by,
      row.generation,
      row.attempts,
      row.lease_expires_at,
      row.next_attempt_at,
      row.updated_at,
    );
  }
}

function coordinatorTrackProjectionMatches(
  database: BetterSqlite3.Database,
  profile: CoordinatorProfile,
  record: Readonly<CoordinatorRecord>,
): boolean {
  const expected = coordinatorTrackProjection(profile, record)
    .slice()
    .sort((left, right) => left.track.localeCompare(right.track));
  const retained = database.prepare(`
    SELECT profile, role, job_id, local_binding_hash, track, eligible, state,
      outcome, error_class, faulted_party, withdrawn_by, generation, attempts,
      lease_expires_at, next_attempt_at, updated_at
    FROM dacs_coordinator_tracks
    WHERE profile = ? AND role = ? AND job_id = ?
    ORDER BY track
    LIMIT ?
  `).all(
    profile,
    record.role,
    record.jobId,
    expected.length + 1,
  ) as CoordinatorTrackRow[];
  return canonicalize(retained) === canonicalize(expected);
}

function coordinatorTrackProjectionSetMatches(
  database: BetterSqlite3.Database,
  profile: CoordinatorProfile,
  records: readonly Readonly<CoordinatorRecord>[],
): boolean {
  if (records.length === 0) return true;
  const expected = records.flatMap((record) =>
    coordinatorTrackProjection(profile, record)
  ).sort((left, right) =>
    left.job_id.localeCompare(right.job_id) || left.track.localeCompare(right.track)
  );
  const retained = database.prepare(`
    SELECT profile, role, job_id, local_binding_hash, track, eligible, state,
      outcome, error_class, faulted_party, withdrawn_by, generation, attempts,
      lease_expires_at, next_attempt_at, updated_at
    FROM dacs_coordinator_tracks
    WHERE profile = ?
      AND job_id IN (SELECT value FROM json_each(?))
    ORDER BY job_id, track
    LIMIT ?
  `).all(
    profile,
    canonicalize(records.map((record) => record.jobId)),
    expected.length + 1,
  ) as CoordinatorTrackRow[];
  return canonicalize(retained) === canonicalize(expected);
}

type LegacyCoordinatorTrackRow = Omit<
  CoordinatorTrackRow,
  "local_binding_hash" | "faulted_party" | "withdrawn_by"
>;

type LegacyCoordinatorTrackRecord = Readonly<{
  state: string;
  generation: number;
  attempts: number;
  updatedAt: number;
  outcome?: "success" | "failure" | "aborted";
  errorClass?: FixedPriceX402ErrorClass;
  nextAttemptAt?: number;
  lease?: Readonly<{ expiresAt: number }>;
}>;

function legacyTrack(
  record: Readonly<Record<string, unknown>>,
  track: FixedPriceX402Track,
): LegacyCoordinatorTrackRecord | undefined {
  return (record.tracks as Readonly<Record<string, LegacyCoordinatorTrackRecord>>)[track];
}

function legacyTrackFinal(
  record: Readonly<Record<string, unknown>>,
  track: FixedPriceX402Track,
): boolean {
  return legacyTrack(record, track)?.state === "final";
}

function legacyTrackSuccessful(
  record: Readonly<Record<string, unknown>>,
  track: FixedPriceX402Track,
): boolean {
  const retained = legacyTrack(record, track);
  return retained?.state === "final" && retained.outcome === "success";
}

function legacyTrackEligible(
  record: Readonly<Record<string, unknown>>,
  track: FixedPriceX402Track,
): boolean {
  const role = record.role as FixedPriceX402CoordinatorRole;
  if (!coordinatorTracks(role).includes(track)) return false;
  switch (track) {
    case "agreement": return true;
    case "payment": return legacyTrackSuccessful(record, "agreement");
    case "payment-evidence": return legacyTrackFinal(record, "payment");
    case "delivery": return role === "seller" && legacyTrackSuccessful(record, "payment");
    case "buyer-received":
      return role === "buyer" && legacyTrackSuccessful(record, "payment");
    case "delivery-evidence":
      return role === "seller" && legacyTrackFinal(record, "delivery");
    case "audit": {
      const agreement = legacyTrack(record, "agreement");
      if (agreement?.state === "final" && agreement.outcome !== "success") return true;
      const payment = legacyTrack(record, "payment");
      if (payment?.state === "final" && payment.outcome !== "success") {
        return legacyTrackSuccessful(record, "payment-evidence");
      }
      return role === "buyer"
        ? legacyTrackSuccessful(record, "payment-evidence") &&
            legacyTrackFinal(record, "buyer-received")
        : legacyTrackSuccessful(record, "payment-evidence") &&
            legacyTrackSuccessful(record, "delivery-evidence");
    }
  }
}

function legacyCoordinatorTrackProjection(
  profile: CoordinatorProfile,
  record: Readonly<Record<string, unknown>>,
): readonly LegacyCoordinatorTrackRow[] {
  const role = record.role as FixedPriceX402CoordinatorRole;
  return coordinatorTracks(role).map((track) => {
    const retained = legacyTrack(record, track)!;
    return {
      profile,
      role,
      job_id: record.jobId as string,
      track,
      eligible: legacyTrackEligible(record, track) ? 1 : 0,
      state: retained.state,
      outcome: retained.outcome ?? null,
      error_class: retained.errorClass ?? null,
      generation: retained.generation,
      attempts: retained.attempts,
      lease_expires_at: retained.lease?.expiresAt ?? null,
      next_attempt_at: retained.nextAttemptAt ?? null,
      updated_at: retained.updatedAt,
    };
  });
}

function legacyCoordinatorTrackProjectionMatches(
  database: BetterSqlite3.Database,
  profile: CoordinatorProfile,
  record: Readonly<Record<string, unknown>>,
): boolean {
  const expected = legacyCoordinatorTrackProjection(profile, record)
    .slice()
    .sort((left, right) => left.track.localeCompare(right.track));
  const retained = database.prepare(`
    SELECT profile, role, job_id, track, eligible, state, outcome, error_class,
      generation, attempts, lease_expires_at, next_attempt_at, updated_at
    FROM dacs_coordinator_tracks
    WHERE profile = ? AND role = ? AND job_id = ?
    ORDER BY track
    LIMIT ?
  `).all(
    profile,
    record.role,
    record.jobId,
    expected.length + 1,
  ) as LegacyCoordinatorTrackRow[];
  return canonicalize(retained) === canonicalize(expected);
}

function migrateCoordinatorV4Rows(
  database: BetterSqlite3.Database,
  options: ReturnType<typeof validateOptions>,
): void {
  const profile: CoordinatorProfile = options.mode === "offline"
    ? "offline"
    : "live-x402";
  const rows = database.prepare(`
    SELECT * FROM dacs_coordinator_orders_v3 ORDER BY profile, role, job_id
  `).all() as LegacyCoordinatorRow[];
  const insert = database.prepare(`
    INSERT INTO dacs_coordinator_orders (
      profile, role, job_id, binding_hash, local_binding_hash, record_hash,
      record_json, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    if (row.profile !== profile || row.role !== options.role ||
        (row.role !== "buyer" && row.role !== "seller")) {
      throw new DacsNodeSqliteError(
        "database-logical-corruption",
        "Legacy SQLite coordinator row is outside the bound actor profile",
      );
    }
    const decoded = legacyCoordinatorFromRow(row, profile);
    if (decoded.status !== "ok" ||
        !coordinatorAuthorityMatches(decoded.record, options.authority)) {
      throw new DacsNodeSqliteError(
        "database-logical-corruption",
        decoded.status === "corrupt"
          ? decoded.reason
          : "Legacy SQLite coordinator record cannot be integrity-validated for migration",
      );
    }
    const recordJson = canonicalize(decoded.record);
    insert.run(
      profile,
      decoded.record.role,
      decoded.record.jobId,
      decoded.record.bindingHash,
      decoded.record.localBindingHash,
      sha256Hex(recordJson),
      recordJson,
      decoded.record.revision,
      decoded.record.createdAt,
      decoded.record.updatedAt,
    );
    replaceCoordinatorTrackProjection(database, profile, decoded.record);
  }
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

function captureExactData(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> | null {
  if (!exactDataKeys(value, required, optional)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.freeze(Object.fromEntries(
    Reflect.ownKeys(value).map((key) => [key, descriptors[key as string]!.value]),
  ));
}

function captureCanonicalData(
  value: unknown,
  seen = new WeakSet<object>(),
  allowUndefined = false,
): unknown {
  if (value === undefined && allowUndefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
      typeof value === "number") return value;
  if (typeof value !== "object" || nodeTypes.isProxy(value) || seen.has(value)) {
    throw new DacsNodeSqliteError(
      "canonical-data-malformed",
      "SQLite canonical data must be an acyclic own-data JSON value",
    );
  }
  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) throw new Error();
    if (Array.isArray(value)) {
      if (keys.length !== value.length + 1 || keys.at(-1) !== "length") throw new Error();
      const retained: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
          throw new Error();
        }
        retained.push(captureCanonicalData(descriptor.value, seen, allowUndefined));
      }
      return Object.freeze(retained);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const retained: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor) ||
          (descriptor.value === undefined && !allowUndefined)) throw new Error();
      retained[key] = captureCanonicalData(descriptor.value, seen, allowUndefined);
    }
    return Object.freeze(retained);
  } catch (error) {
    if (error instanceof DacsNodeSqliteError) throw error;
    throw new DacsNodeSqliteError(
      "canonical-data-malformed",
      "SQLite canonical data must contain only enumerable own data properties",
    );
  } finally {
    seen.delete(value);
  }
}

function captureEffectLease(value: unknown): Readonly<DacsNodeSqliteEffectLease> | null {
  const captured = captureExactData(
    value,
    ["owner", "generation", "expiresAt", "mode"],
  );
  if (!captured || !nonEmpty(captured.owner) || !safeUint(captured.generation) ||
      !safeUint(captured.expiresAt) ||
      (captured.mode !== "perform" && captured.mode !== "reconcile")) return null;
  return Object.freeze({
    owner: captured.owner,
    generation: captured.generation,
    expiresAt: captured.expiresAt,
    mode: captured.mode,
  });
}

function captureCoordinatorResult(
  profile: CoordinatorProfile,
  value: unknown,
): CoordinatorOperationResult | null {
  if (exactDataKeys(value, ["status", "outcome", "reference"], ["authenticationHash"]) &&
      value.status === "final" && value.outcome === coordinatorSuccessOutcome(profile) &&
      nonEmpty(value.reference) &&
      (value.authenticationHash === undefined || hash(value.authenticationHash))) {
    return clone(value) as unknown as CoordinatorOperationResult;
  }
  const abortedKeys = liveCoordinatorProfile(profile)
    ? ["status", "outcome", "withdrawnBy", "reference"]
    : ["status", "outcome", "reference"];
  if (exactDataKeys(value, abortedKeys, ["authenticationHash"]) &&
      value.status === "final" && value.outcome === coordinatorAbortedOutcome(profile) &&
      (!liveCoordinatorProfile(profile) || value.withdrawnBy === "buyer" ||
        value.withdrawnBy === "seller") &&
      nonEmpty(value.reference) &&
      (value.authenticationHash === undefined || hash(value.authenticationHash))) {
    return clone(value) as unknown as CoordinatorOperationResult;
  }
  const failureKeys = liveCoordinatorProfile(profile)
    ? ["status", "outcome", "errorClass", "faultedParty", "reference"]
    : ["status", "outcome", "errorClass", "reference"];
  if (exactDataKeys(
    value,
    failureKeys,
    ["authenticationHash"],
  ) && value.status === "final" && value.outcome === coordinatorFailureOutcome(profile) &&
      coordinatorErrorClassAllowed(profile, value.errorClass) &&
      (!liveCoordinatorProfile(profile) ||
        FAULTED_PARTIES.has(value.faultedParty as FixedPriceX402FaultedParty)) &&
      nonEmpty(value.reference) &&
      (value.authenticationHash === undefined || hash(value.authenticationHash))) {
    return clone(value) as unknown as CoordinatorOperationResult;
  }
  if (exactDataKeys(value, ["status", "reasonCode", "retryAt"]) &&
      (value.status === "pending-retry" || value.status === "indeterminate") &&
      reasonCode(value.reasonCode) && safeUint(value.retryAt)) {
    return clone(value) as unknown as CoordinatorOperationResult;
  }
  if (exactDataKeys(value, ["status", "reasonCode"]) &&
      value.status === "operator-action" && reasonCode(value.reasonCode)) {
    return clone(value) as unknown as CoordinatorOperationResult;
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

function unsafeLocalPathReason(
  path: string,
  kind: "database" | "directory",
): DacsNodeSqliteLocationBlockReason | undefined {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    return undefined;
  }
  const retained = lstatSync(path);
  if (retained.uid !== process.getuid()) {
    return kind === "database"
      ? "database-path-owner-mismatch"
      : "database-directory-owner-mismatch";
  }
  if ((retained.mode & 0o022) !== 0) {
    return kind === "database"
      ? "database-path-permissions-unsafe"
      : "database-directory-permissions-unsafe";
  }
  return undefined;
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
      databasePath.startsWith("\\\\") || databasePath.startsWith("//")) {
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
    if (existsSync(absolutePath)) {
      const databaseStat = lstatSync(absolutePath);
      if (databaseStat.isSymbolicLink()) {
        return {
          status: "blocked",
          databasePath: absolutePath,
          reasonCode: "database-path-symlink",
        };
      }
      const reasonCode = unsafeLocalPathReason(absolutePath, "database");
      if (reasonCode !== undefined) {
        return { status: "blocked", databasePath: absolutePath, reasonCode };
      }
    }
    const existing = nearestExistingPath(dirname(absolutePath));
    const directoryReason = unsafeLocalPathReason(existing, "directory");
    if (directoryReason !== undefined) {
      return {
        status: "blocked",
        databasePath: absolutePath,
        reasonCode: directoryReason,
      };
    }
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
  const captured = captureExactData(
    options,
    ["databasePath", "mode", "profile", "role", "authority"],
    ["sdkVersion", "standardRevision", "busyTimeoutMs"],
  );
  if (!captured) {
    throw new DacsNodeSqliteError("configuration-malformed", "SQLite options are malformed");
  }
  const expectedProfile = captured.mode === "offline"
    ? DACS_NODE_OFFLINE_PROFILE
    : captured.mode === "live-demos"
      ? DACS_NODE_LIVE_PROFILE
      : undefined;
  const expectedStandardRevision = captured.mode === "offline"
    ? FIXED_PRICE_OFFLINE_STANDARD_REVISION
    : captured.mode === "live-demos"
      ? FIXED_PRICE_X402_STANDARD_REVISION
      : undefined;
  const busyTimeoutMs = captured.busyTimeoutMs ??
    DACS_NODE_SQLITE_DEFAULT_BUSY_TIMEOUT_MS;
  if (expectedProfile === undefined || captured.profile !== expectedProfile ||
      !["buyer", "seller", "verifier"].includes(captured.role as string) ||
      !nonEmpty(captured.authority) || !nonEmpty(captured.databasePath) ||
      expectedStandardRevision === undefined ||
      (captured.sdkVersion !== undefined && captured.sdkVersion !== VERSION) ||
      (captured.standardRevision !== undefined &&
        captured.standardRevision !== expectedStandardRevision) ||
      !safeUint(busyTimeoutMs) || busyTimeoutMs === 0 || busyTimeoutMs > 60_000) {
    throw new DacsNodeSqliteError(
      "configuration-malformed",
      "SQLite options are malformed or profile-incompatible",
    );
  }
  return Object.freeze({
    databasePath: captured.databasePath,
    mode: captured.mode,
    profile: captured.profile,
    role: captured.role,
    authority: captured.authority,
    sdkVersion: VERSION,
    standardRevision: expectedStandardRevision,
    busyTimeoutMs,
  }) as Required<Omit<DacsNodeSqliteDatabaseOptions, "busyTimeoutMs">> & {
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

function readSnapshot<T>(database: BetterSqlite3.Database, operation: () => T): T {
  if (database.inTransaction) return operation();
  database.exec("BEGIN");
  try {
    database.prepare("SELECT rootpage FROM sqlite_schema LIMIT 1").get();
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

const EFFECT_IDENTITY_VERSION = 1 as const;

function effectIdentityDetails(input: Readonly<{
  kind: DacsNodeSqliteEffectKind;
  effectId: string;
  jobId?: string;
  bindingHash: string;
  inputHash: string;
  idempotencyKey: string;
}>): Readonly<{
  version: typeof EFFECT_IDENTITY_VERSION;
  effectKind: DacsNodeSqliteEffectKind;
  effectId: string;
  jobId: string | null;
  bindingHash: string;
  inputHash: string;
  idempotencyKey: string;
}> {
  return {
    version: EFFECT_IDENTITY_VERSION,
    effectKind: input.kind,
    effectId: input.effectId,
    jobId: input.jobId ?? null,
    bindingHash: input.bindingHash,
    inputHash: input.inputHash,
    idempotencyKey: input.idempotencyKey,
  };
}

function effectIdentityHash(input: Parameters<typeof effectIdentityDetails>[0]): string {
  return sha256Hex(canonicalize(effectIdentityDetails(input)));
}

function effectFromRow(row: EffectRow): DacsNodeSqliteEffectRecord {
  if (!EFFECT_KINDS.has(row.effect_kind as DacsNodeSqliteEffectKind) ||
      !nonEmpty(row.effect_id) || (row.job_id !== null && !nonEmpty(row.job_id)) ||
      !hash(row.binding_hash) || !hash(row.input_hash) ||
      !nonEmpty(row.idempotency_key) || !hash(row.identity_hash) ||
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
  const identity = {
    kind: row.effect_kind as DacsNodeSqliteEffectKind,
    effectId: row.effect_id,
    ...(row.job_id === null ? {} : { jobId: row.job_id }),
    bindingHash: row.binding_hash,
    inputHash: row.input_hash,
    idempotencyKey: row.idempotency_key,
  };
  if (row.identity_hash !== effectIdentityHash(identity)) {
    throw new DacsNodeSqliteError(
      "database-logical-corruption",
      "SQLite effect identity differs from its integrity binding",
    );
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
    ...identity,
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
    case "session": return "session";
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

type PaymentEvidenceDecode = Readonly<
  | { status: "ok"; record: Readonly<PaymentEvidenceHandshakeRecord> }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string }
>;

function paymentEvidenceScopeHash(
  request: Readonly<PaymentEvidenceAnchorRequest>,
): string {
  return paymentEvidenceHandshakeScopeHash({
    seller: request.seller,
    buyer: request.buyer,
    protocolHash: request.protocolHash,
  });
}

function paymentEvidenceAuthorityMatches(
  record: Readonly<PaymentEvidenceHandshakeRecord>,
  authority: string,
): boolean {
  const owner = record.role === "buyer" ? record.request.buyer : record.request.seller;
  try {
    return sameCanonicalClaimIdentity(owner, authority);
  } catch {
    return false;
  }
}

function paymentEvidenceProjection(
  record: Readonly<PaymentEvidenceHandshakeRecord>,
): PaymentEvidenceHandshakeRow {
  const recordJson = canonicalize(record);
  return {
    role: record.role,
    message_id: record.messageId,
    scope_hash: paymentEvidenceScopeHash(record.request),
    request_hash: record.request.requestHash,
    effect_id: record.request.effectId,
    logical_address: record.request.logicalAddress,
    store_version: record.storeVersion,
    revision: record.revision,
    record_hash: sha256Hex(recordJson),
    record_json: recordJson,
    buyer_state: record.buyerWork?.state ?? null,
    buyer_generation: record.buyerWork?.generation ?? null,
    buyer_attempts: record.buyerWork?.attempts ?? null,
    buyer_lease_expires_at: record.buyerWork?.lease?.expiresAt ?? null,
    buyer_retry_at: record.buyerWork?.retryAt ?? null,
    request_outbox_state: record.requestOutbox?.state ?? null,
    request_outbox_generation: record.requestOutbox?.generation ?? null,
    request_outbox_attempts: record.requestOutbox?.attempts ?? null,
    request_outbox_lease_expires_at: record.requestOutbox?.lease?.expiresAt ?? null,
    request_outbox_retry_at: record.requestOutbox?.retryAt ?? null,
    completion_hash: record.completion?.completionHash ?? null,
    completion_outbox_state: record.completionOutbox?.state ?? null,
    completion_outbox_generation: record.completionOutbox?.generation ?? null,
    completion_outbox_attempts: record.completionOutbox?.attempts ?? null,
    completion_outbox_lease_expires_at: record.completionOutbox?.lease?.expiresAt ?? null,
    completion_outbox_retry_at: record.completionOutbox?.retryAt ?? null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function paymentEvidenceFromRow(
  row: Readonly<PaymentEvidenceHandshakeRow>,
): PaymentEvidenceDecode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.record_json) as unknown;
  } catch {
    return { status: "corrupt", reason: "payment-evidence record JSON is malformed" };
  }
  if (parsed !== null && typeof parsed === "object" &&
      Number.isSafeInteger((parsed as { storeVersion?: unknown }).storeVersion) &&
      (parsed as { storeVersion: number }).storeVersion !==
        PAYMENT_EVIDENCE_HANDSHAKE_STORE_VERSION) {
    return {
      status: "unsupported",
      version: (parsed as { storeVersion: number }).storeVersion,
    };
  }
  const violation = paymentEvidenceHandshakeViolation(parsed);
  if (violation) return { status: "corrupt", reason: violation };
  const record = parsed as PaymentEvidenceHandshakeRecord;
  let expected: PaymentEvidenceHandshakeRow;
  try {
    expected = paymentEvidenceProjection(record);
  } catch {
    return { status: "corrupt", reason: "payment-evidence record binding is malformed" };
  }
  if (canonicalize(expected) !== canonicalize(row)) {
    return {
      status: "corrupt",
      reason: "payment-evidence record integrity projection differs",
    };
  }
  return { status: "ok", record: clone(record) };
}

function paymentEvidenceReservationProjection(
  record: Readonly<PaymentEvidenceHandshakeRecord>,
): readonly PaymentEvidenceReservationRow[] {
  const scopeHash = paymentEvidenceScopeHash(record.request);
  const identities: readonly (readonly [string, string])[] = [
    ["message", record.messageId],
    ["effect", record.request.effectId],
    ["logical-address", record.request.logicalAddress],
  ];
  return identities.map(([reservationKind, identity]) => ({
    role: record.role,
    scope_hash: scopeHash,
    reservation_kind: reservationKind,
    identity,
    message_id: record.messageId,
    request_hash: record.request.requestHash,
    created_at: record.createdAt,
  }));
}

function paymentEvidenceReservationsMatch(
  database: BetterSqlite3.Database,
  record: Readonly<PaymentEvidenceHandshakeRecord>,
): boolean {
  const expected = paymentEvidenceReservationProjection(record)
    .slice()
    .sort((left, right) => left.reservation_kind.localeCompare(right.reservation_kind));
  const retained = database.prepare(`
    SELECT role, scope_hash, reservation_kind, identity, message_id,
      request_hash, created_at
    FROM dacs_payment_evidence_reservations
    WHERE role = ? AND message_id = ?
    ORDER BY scope_hash, reservation_kind
    LIMIT 4
  `).all(record.role, record.messageId) as
    PaymentEvidenceReservationRow[];
  return canonicalize(retained) === canonicalize(expected);
}

function paymentEvidenceHistoryEntryHash(input: Readonly<{
  role: string;
  messageId: string;
  revision: number;
  occurredAt: number;
  recordHash: string;
  previousEntryHash: string | null;
}>): string {
  return sha256Hex(canonicalize({ historyVersion: "1", ...input }));
}

function appendPaymentEvidenceHistory(
  database: BetterSqlite3.Database,
  record: Readonly<PaymentEvidenceHandshakeRecord>,
): void {
  const previous = database.prepare(`
    SELECT revision, entry_hash FROM dacs_payment_evidence_history
    WHERE role = ? AND message_id = ?
    ORDER BY revision DESC
    LIMIT 1
  `).get(record.role, record.messageId) as
    { revision: number; entry_hash: string } | undefined;
  if ((previous === undefined && record.revision !== 1) ||
      (previous !== undefined && previous.revision + 1 !== record.revision)) {
    throw new DacsNodeSqliteError(
      "payment-evidence-history-invalid",
      "Payment-evidence history revision is not contiguous",
    );
  }
  const recordJson = canonicalize(record);
  const recordHash = sha256Hex(recordJson);
  const previousEntryHash = previous?.entry_hash ?? null;
  database.prepare(`
    INSERT INTO dacs_payment_evidence_history (
      role, message_id, revision, occurred_at, record_hash, record_json,
      previous_entry_hash, entry_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.role,
    record.messageId,
    record.revision,
    record.updatedAt,
    recordHash,
    recordJson,
    previousEntryHash,
    paymentEvidenceHistoryEntryHash({
      role: record.role,
      messageId: record.messageId,
      revision: record.revision,
      occurredAt: record.updatedAt,
      recordHash,
      previousEntryHash,
    }),
  );
}

function samePaymentEvidenceRecord(
  left: Readonly<PaymentEvidenceHandshakeRecord>,
  right: Readonly<PaymentEvidenceHandshakeRecord>,
): boolean {
  return canonicalize(left) === canonicalize(right);
}

function paymentEvidenceOriginMatches(
  record: Readonly<PaymentEvidenceHandshakeRecord>,
): boolean {
  if (record.revision !== 1 || record.createdAt !== record.updatedAt || record.completion) {
    return false;
  }
  const expected: PaymentEvidenceHandshakeRecord = {
    storeVersion: PAYMENT_EVIDENCE_HANDSHAKE_STORE_VERSION,
    revision: 1,
    role: record.role,
    messageId: record.messageId,
    request: clone(record.request),
    ...(record.role === "buyer"
      ? {
          requestAuthentication: clone(record.requestAuthentication!),
          buyerWork: {
            state: "pending" as const,
            generation: 0,
            attempts: 0,
            updatedAt: record.createdAt,
          },
        }
      : {
          requestOutbox: {
            state: "pending" as const,
            generation: 0,
            attempts: 0,
            updatedAt: record.createdAt,
          },
        }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  return samePaymentEvidenceRecord(record, expected);
}

function paymentEvidenceRecordBase(
  previous: Readonly<PaymentEvidenceHandshakeRecord>,
  next: Readonly<PaymentEvidenceHandshakeRecord>,
): PaymentEvidenceHandshakeRecord {
  return {
    ...clone(previous),
    revision: next.revision,
    updatedAt: next.updatedAt,
  };
}

function paymentEvidenceOutboxTransitionMatches(
  previous: Readonly<PaymentEvidenceHandshakeRecord>,
  next: Readonly<PaymentEvidenceHandshakeRecord>,
  field: "requestOutbox" | "completionOutbox",
): boolean {
  const before = previous[field];
  const after = next[field];
  if (!before || !after) return false;
  const base = paymentEvidenceRecordBase(previous, next);
  if (after.state === "sending" && after.lease &&
      after.generation === before.generation + 1 &&
      after.attempts === before.attempts + 1 &&
      after.updatedAt === next.updatedAt &&
      after.lease.generation === after.generation &&
      after.lease.expiresAt > next.updatedAt &&
      (((before.state === "pending") &&
        (before.retryAt === undefined || before.retryAt <= next.updatedAt)) ||
       (before.state === "sending" && before.lease !== undefined &&
        before.lease.expiresAt <= next.updatedAt))) {
    const expected = {
      ...base,
      [field]: {
        state: "sending",
        generation: before.generation + 1,
        attempts: before.attempts + 1,
        updatedAt: next.updatedAt,
        lease: clone(after.lease),
      },
    } as PaymentEvidenceHandshakeRecord;
    if (samePaymentEvidenceRecord(next, expected)) return true;
  }
  if (before.state !== "sending" || !before.lease ||
      after.generation !== before.generation || after.attempts !== before.attempts ||
      after.updatedAt !== next.updatedAt) return false;
  if (after.state === "acknowledged") {
    const expected = {
      ...base,
      [field]: {
        state: "acknowledged",
        generation: before.generation,
        attempts: before.attempts,
        updatedAt: next.updatedAt,
      },
    } as PaymentEvidenceHandshakeRecord;
    return samePaymentEvidenceRecord(next, expected);
  }
  if (after.state === "pending" && after.reasonCode !== undefined) {
    const expected = {
      ...base,
      [field]: {
        state: "pending",
        generation: before.generation,
        attempts: before.attempts,
        updatedAt: next.updatedAt,
        reasonCode: after.reasonCode,
        ...(after.retryAt === undefined ? {} : { retryAt: after.retryAt }),
      },
    } as PaymentEvidenceHandshakeRecord;
    return samePaymentEvidenceRecord(next, expected);
  }
  return false;
}

function paymentEvidenceBuyerTransitionMatches(
  previous: Readonly<PaymentEvidenceHandshakeRecord>,
  next: Readonly<PaymentEvidenceHandshakeRecord>,
): boolean {
  const before = previous.buyerWork!;
  const after = next.buyerWork!;
  const base = paymentEvidenceRecordBase(previous, next);
  if (!previous.completion && after.state === "reconciliation-required" && after.lease &&
      after.generation === before.generation + 1 &&
      after.attempts === before.attempts + 1 && after.updatedAt === next.updatedAt &&
      after.lease.generation === after.generation &&
      after.lease.expiresAt > next.updatedAt && before.state !== "operator-action" &&
      before.state !== "complete" &&
      (before.retryAt === undefined || before.retryAt <= next.updatedAt) &&
      (before.lease === undefined || before.lease.expiresAt <= next.updatedAt)) {
    const expected = {
      ...base,
      buyerWork: {
        state: "reconciliation-required",
        generation: before.generation + 1,
        attempts: before.attempts + 1,
        updatedAt: next.updatedAt,
        reasonCode: before.state === "reconciliation-required"
          ? before.reasonCode!
          : "anchor-attempt-in-flight",
        ...(before.absenceProofHash === undefined
          ? {}
          : { absenceProofHash: before.absenceProofHash }),
        lease: clone(after.lease),
      },
    } as PaymentEvidenceHandshakeRecord;
    if (samePaymentEvidenceRecord(next, expected)) return true;
  }
  if (!previous.completion && before.lease && before.lease.expiresAt > next.updatedAt &&
      after.generation === before.generation && after.attempts === before.attempts &&
      after.updatedAt === next.updatedAt) {
    if ((after.state === "reconciliation-required" || after.state === "operator-action") &&
        after.reasonCode !== undefined &&
        (after.state !== "operator-action" || after.retryAt === undefined)) {
      const expected = {
        ...base,
        buyerWork: {
          state: after.state,
          generation: before.generation,
          attempts: before.attempts,
          updatedAt: next.updatedAt,
          reasonCode: after.reasonCode,
          ...(after.retryAt === undefined ? {} : { retryAt: after.retryAt }),
          ...(before.absenceProofHash === undefined
            ? {}
            : { absenceProofHash: before.absenceProofHash }),
        },
      } as PaymentEvidenceHandshakeRecord;
      if (samePaymentEvidenceRecord(next, expected)) return true;
    }
    if (before.state === "reconciliation-required" && after.state === "pending" &&
        after.absenceProofHash !== undefined) {
      const expected = {
        ...base,
        buyerWork: {
          state: "pending",
          generation: before.generation,
          attempts: before.attempts,
          updatedAt: next.updatedAt,
          absenceProofHash: after.absenceProofHash,
        },
      } as PaymentEvidenceHandshakeRecord;
      if (samePaymentEvidenceRecord(next, expected)) return true;
    }
    if (after.state === "complete" && next.completion && next.completionOutbox) {
      const expected = {
        ...base,
        buyerWork: {
          state: "complete",
          generation: before.generation,
          attempts: before.attempts,
          updatedAt: next.updatedAt,
          ...(before.absenceProofHash === undefined
            ? {}
            : { absenceProofHash: before.absenceProofHash }),
        },
        completion: clone(next.completion),
        completionOutbox: {
          state: "pending",
          generation: 0,
          attempts: 0,
          updatedAt: next.updatedAt,
        },
      } as PaymentEvidenceHandshakeRecord;
      if (samePaymentEvidenceRecord(next, expected)) return true;
    }
  }
  if (!previous.completion && before.lease === undefined &&
      after.state === "reconciliation-required" && after.lease === undefined &&
      after.reasonCode !== undefined && after.generation === before.generation &&
      after.attempts === before.attempts && after.updatedAt === next.updatedAt) {
    const expected = {
      ...base,
      buyerWork: {
        state: "reconciliation-required",
        generation: before.generation,
        attempts: before.attempts,
        updatedAt: next.updatedAt,
        reasonCode: after.reasonCode,
        ...(before.absenceProofHash === undefined
          ? {}
          : { absenceProofHash: before.absenceProofHash }),
      },
    } as PaymentEvidenceHandshakeRecord;
    if (samePaymentEvidenceRecord(next, expected)) return true;
  }
  return paymentEvidenceOutboxTransitionMatches(
    previous,
    next,
    "completionOutbox",
  );
}

function paymentEvidenceSellerTransitionMatches(
  previous: Readonly<PaymentEvidenceHandshakeRecord>,
  next: Readonly<PaymentEvidenceHandshakeRecord>,
): boolean {
  if (!previous.completion && next.completion && next.completionAuthentication) {
    const before = previous.requestOutbox!;
    const expected = {
      ...paymentEvidenceRecordBase(previous, next),
      requestOutbox: {
        state: "acknowledged",
        generation: before.generation,
        attempts: before.attempts,
        updatedAt: next.updatedAt,
      },
      completion: clone(next.completion),
      completionAuthentication: clone(next.completionAuthentication),
    } as PaymentEvidenceHandshakeRecord;
    if (samePaymentEvidenceRecord(next, expected)) return true;
  }
  return paymentEvidenceOutboxTransitionMatches(previous, next, "requestOutbox");
}

function paymentEvidenceTransitionMatches(
  previous: Readonly<PaymentEvidenceHandshakeRecord>,
  next: Readonly<PaymentEvidenceHandshakeRecord>,
): boolean {
  if (previous.role !== next.role || previous.messageId !== next.messageId ||
      next.revision !== previous.revision + 1 || next.createdAt !== previous.createdAt ||
      next.updatedAt < previous.updatedAt ||
      canonicalize(next.request) !== canonicalize(previous.request) ||
      canonicalize(next.requestAuthentication ?? null) !==
        canonicalize(previous.requestAuthentication ?? null)) return false;
  return next.role === "buyer"
    ? paymentEvidenceBuyerTransitionMatches(previous, next)
    : paymentEvidenceSellerTransitionMatches(previous, next);
}

function paymentEvidenceHistoryMatches(
  database: BetterSqlite3.Database,
  current: Readonly<PaymentEvidenceHandshakeRecord>,
): boolean {
  let previous: PaymentEvidenceHistoryRow | undefined;
  let origin: PaymentEvidenceHandshakeRecord | undefined;
  let final: PaymentEvidenceHandshakeRecord | undefined;
  let previousRecord: PaymentEvidenceHandshakeRecord | undefined;
  let count = 0;
  for (const row of database.prepare(`
    SELECT sequence, role, message_id, revision, occurred_at, record_hash,
      record_json, previous_entry_hash, entry_hash
    FROM dacs_payment_evidence_history
    WHERE role = ? AND message_id = ?
    ORDER BY revision
  `).iterate(current.role, current.messageId) as IterableIterator<PaymentEvidenceHistoryRow>) {
    count += 1;
    if (!safeUint(row.sequence) || row.sequence === 0 || row.role !== current.role ||
        row.message_id !== current.messageId || row.revision !== count ||
        !safeUint(row.occurred_at) || !hash(row.record_hash) ||
        !nonEmpty(row.record_json) ||
        (row.previous_entry_hash !== null && !hash(row.previous_entry_hash)) ||
        !hash(row.entry_hash) || row.previous_entry_hash !== (previous?.entry_hash ?? null) ||
        (previous !== undefined && row.occurred_at < previous.occurred_at) ||
        row.entry_hash !== paymentEvidenceHistoryEntryHash({
          role: row.role,
          messageId: row.message_id,
          revision: row.revision,
          occurredAt: row.occurred_at,
          recordHash: row.record_hash,
          previousEntryHash: row.previous_entry_hash,
        })) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.record_json) as unknown;
      if (canonicalize(parsed) !== row.record_json ||
          sha256Hex(row.record_json) !== row.record_hash ||
          paymentEvidenceHandshakeViolation(parsed)) return false;
    } catch {
      return false;
    }
    const record = parsed as PaymentEvidenceHandshakeRecord;
    if (record.role !== current.role || record.messageId !== current.messageId ||
        record.revision !== row.revision || record.updatedAt !== row.occurred_at ||
        record.createdAt !== current.createdAt ||
        canonicalize(record.request) !== canonicalize(current.request) ||
        canonicalize(record.requestAuthentication ?? null) !==
          canonicalize(current.requestAuthentication ?? null)) return false;
    if (previousRecord === undefined
      ? !paymentEvidenceOriginMatches(record)
      : !paymentEvidenceTransitionMatches(previousRecord, record)) return false;
    origin ??= record;
    final = record;
    previousRecord = record;
    previous = row;
  }
  return count === current.revision && origin?.revision === 1 &&
    origin.createdAt === origin.updatedAt && final !== undefined &&
    canonicalize(final) === canonicalize(current);
}

function insertPaymentEvidenceRecord(
  database: BetterSqlite3.Database,
  record: Readonly<PaymentEvidenceHandshakeRecord>,
): void {
  const row = paymentEvidenceProjection(record);
  database.prepare(`
    INSERT INTO dacs_payment_evidence_handshakes (
      role, message_id, scope_hash, request_hash, effect_id, logical_address,
      store_version, revision, record_hash, record_json,
      buyer_state, buyer_generation, buyer_attempts, buyer_lease_expires_at,
      buyer_retry_at, request_outbox_state, request_outbox_generation,
      request_outbox_attempts, request_outbox_lease_expires_at,
      request_outbox_retry_at, completion_hash, completion_outbox_state,
      completion_outbox_generation, completion_outbox_attempts,
      completion_outbox_lease_expires_at, completion_outbox_retry_at,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?
    )
  `).run(
    row.role,
    row.message_id,
    row.scope_hash,
    row.request_hash,
    row.effect_id,
    row.logical_address,
    row.store_version,
    row.revision,
    row.record_hash,
    row.record_json,
    row.buyer_state,
    row.buyer_generation,
    row.buyer_attempts,
    row.buyer_lease_expires_at,
    row.buyer_retry_at,
    row.request_outbox_state,
    row.request_outbox_generation,
    row.request_outbox_attempts,
    row.request_outbox_lease_expires_at,
    row.request_outbox_retry_at,
    row.completion_hash,
    row.completion_outbox_state,
    row.completion_outbox_generation,
    row.completion_outbox_attempts,
    row.completion_outbox_lease_expires_at,
    row.completion_outbox_retry_at,
    row.created_at,
    row.updated_at,
  );
  const insert = database.prepare(`
    INSERT INTO dacs_payment_evidence_reservations (
      role, scope_hash, reservation_kind, identity, message_id,
      request_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const reservation of paymentEvidenceReservationProjection(record)) {
    insert.run(
      reservation.role,
      reservation.scope_hash,
      reservation.reservation_kind,
      reservation.identity,
      reservation.message_id,
      reservation.request_hash,
      reservation.created_at,
    );
  }
  appendPaymentEvidenceHistory(database, record);
}

function updatePaymentEvidenceRecord(
  database: BetterSqlite3.Database,
  current: Readonly<PaymentEvidenceHandshakeRecord>,
  next: Readonly<PaymentEvidenceHandshakeRecord>,
): boolean {
  const row = paymentEvidenceProjection(next);
  const result = database.prepare(`
    UPDATE dacs_payment_evidence_handshakes SET
      scope_hash = ?, request_hash = ?, effect_id = ?, logical_address = ?,
      store_version = ?, revision = ?, record_hash = ?, record_json = ?,
      buyer_state = ?, buyer_generation = ?, buyer_attempts = ?,
      buyer_lease_expires_at = ?, buyer_retry_at = ?, request_outbox_state = ?,
      request_outbox_generation = ?, request_outbox_attempts = ?,
      request_outbox_lease_expires_at = ?, request_outbox_retry_at = ?,
      completion_hash = ?, completion_outbox_state = ?,
      completion_outbox_generation = ?, completion_outbox_attempts = ?,
      completion_outbox_lease_expires_at = ?, completion_outbox_retry_at = ?,
      created_at = ?, updated_at = ?
    WHERE role = ? AND message_id = ? AND revision = ?
  `).run(
    row.scope_hash,
    row.request_hash,
    row.effect_id,
    row.logical_address,
    row.store_version,
    row.revision,
    row.record_hash,
    row.record_json,
    row.buyer_state,
    row.buyer_generation,
    row.buyer_attempts,
    row.buyer_lease_expires_at,
    row.buyer_retry_at,
    row.request_outbox_state,
    row.request_outbox_generation,
    row.request_outbox_attempts,
    row.request_outbox_lease_expires_at,
    row.request_outbox_retry_at,
    row.completion_hash,
    row.completion_outbox_state,
    row.completion_outbox_generation,
    row.completion_outbox_attempts,
    row.completion_outbox_lease_expires_at,
    row.completion_outbox_retry_at,
    row.created_at,
    row.updated_at,
    current.role,
    current.messageId,
    current.revision,
  );
  if (result.changes !== 1) return false;
  appendPaymentEvidenceHistory(database, next);
  return true;
}

function createSqlitePaymentEvidenceHandshakeStore(
  database: BetterSqlite3.Database,
  role: PaymentEvidenceHandshakeRole,
  authority: string,
): PaymentEvidenceHandshakeStore {
  const readRow = (messageId: string): PaymentEvidenceHandshakeRow | undefined =>
    database.prepare(`
      SELECT * FROM dacs_payment_evidence_handshakes
      WHERE role = ? AND message_id = ?
    `).get(role, messageId) as PaymentEvidenceHandshakeRow | undefined;

  const decodeRow = (row: Readonly<PaymentEvidenceHandshakeRow>): PaymentEvidenceDecode => {
    const decoded = paymentEvidenceFromRow(row);
    if (decoded.status === "ok" &&
        (!paymentEvidenceAuthorityMatches(decoded.record, authority) ||
          !paymentEvidenceReservationsMatch(database, decoded.record) ||
          !paymentEvidenceHistoryMatches(database, decoded.record))) {
      return {
        status: "corrupt",
        reason: "payment-evidence record is outside its actor authority or reservations",
      };
    }
    return decoded;
  };

  const loadRecord = (
    messageId: string,
    scopeHash: string,
  ): PaymentEvidenceHandshakeLoad => {
    const row = readRow(messageId);
    if (!row || row.scope_hash !== scopeHash) return { status: "missing" };
    return decodeRow(row);
  };

  const save = (
    current: Readonly<PaymentEvidenceHandshakeRecord>,
    value: Readonly<PaymentEvidenceHandshakeRecord>,
  ): Readonly<PaymentEvidenceHandshakeRecord> | null => {
    const next = { ...clone(value), revision: current.revision + 1 };
    const violation = paymentEvidenceHandshakeViolation(next);
    if (violation || !paymentEvidenceAuthorityMatches(next, authority) ||
        canonicalize(next.request) !== canonicalize(current.request) ||
        canonicalize(next.requestAuthentication ?? null) !==
          canonicalize(current.requestAuthentication ?? null) ||
        next.role !== current.role || next.messageId !== current.messageId ||
        next.createdAt !== current.createdAt || next.updatedAt < current.updatedAt) {
      throw new DacsNodeSqliteError(
        "payment-evidence-record-invalid",
        violation ?? "Payment-evidence immutable binding or time changed",
      );
    }
    return updatePaymentEvidenceRecord(database, current, next) ? clone(next) : null;
  };

  const stamp = (record: Readonly<PaymentEvidenceHandshakeRecord>, now?: number): number =>
    Math.max(record.updatedAt, now ?? databaseTime(database));

  const leaseMatches = (
    retained: Readonly<PaymentEvidenceHandshakeLease> | undefined,
    supplied: Readonly<PaymentEvidenceHandshakeLease>,
  ): boolean => retained !== undefined && retained.owner === supplied.owner &&
    retained.generation === supplied.generation && retained.expiresAt === supplied.expiresAt;

  const captureLease = (value: unknown): PaymentEvidenceHandshakeLease | null => {
    const captured = captureExactData(value, ["owner", "generation", "expiresAt"]);
    if (!captured || !nonEmpty(captured.owner) || !safeUint(captured.generation) ||
        captured.generation === 0 || !safeUint(captured.expiresAt)) return null;
    return {
      owner: captured.owner,
      generation: captured.generation,
      expiresAt: captured.expiresAt,
    };
  };

  const validateQuery = (input: Readonly<{
    scopeHash: string;
    cursor?: string;
    limit: number;
  }>, label: string): void => {
    if (!hash(input.scopeHash) ||
        (input.cursor !== undefined && !nonEmpty(input.cursor)) ||
        !safeUint(input.limit) || input.limit === 0 ||
        input.limit > DACS_NODE_SQLITE_MAX_PAGE_SIZE) {
      throw new DacsNodeSqliteError(
        "payment-evidence-query-malformed",
        `${label} is malformed or exceeds the bounded page size`,
      );
    }
  };

  const claimOutbox = (
    field: "requestOutbox" | "completionOutbox",
    input: Readonly<{
      scopeHash: string;
      owner: string;
      cursor?: string;
      limit: number;
      leaseDurationMs: number;
    }>,
  ): PaymentEvidencePage<
    PaymentEvidenceOutboundRequestClaim | PaymentEvidenceOutboundCompletionClaim
  > => {
    try {
      input = captureCanonicalData(input, new WeakSet(), true) as typeof input;
    } catch {
      throw new DacsNodeSqliteError(
        "payment-evidence-claim-malformed",
        "Payment-evidence outbox claim must contain only own canonical data",
      );
    }
    validateQuery(input, "Payment-evidence outbox claim");
    if (!nonEmpty(input.owner) || !safeUint(input.leaseDurationMs) ||
        input.leaseDurationMs === 0) {
      throw new DacsNodeSqliteError(
        "payment-evidence-claim-malformed",
        "Payment-evidence outbox claim is malformed",
      );
    }
    return beginImmediate(database, () => {
      const now = databaseTime(database);
      const stateColumn = field === "requestOutbox"
        ? "request_outbox_state"
        : "completion_outbox_state";
      const retryColumn = field === "requestOutbox"
        ? "request_outbox_retry_at"
        : "completion_outbox_retry_at";
      const leaseColumn = field === "requestOutbox"
        ? "request_outbox_lease_expires_at"
        : "completion_outbox_lease_expires_at";
      const completionGuard = field === "requestOutbox" ? "AND completion_hash IS NULL" : "";
      const rows = database.prepare(`
        SELECT * FROM dacs_payment_evidence_handshakes
        WHERE role = ? AND scope_hash = ? AND message_id > ?
          ${completionGuard}
          AND (
            (${stateColumn} = 'pending' AND
              (${retryColumn} IS NULL OR ${retryColumn} <= ?)) OR
            (${stateColumn} = 'sending' AND ${leaseColumn} <= ?)
          )
        ORDER BY message_id
        LIMIT ?
      `).all(role, input.scopeHash, input.cursor ?? "", now, now, input.limit + 1) as
        PaymentEvidenceHandshakeRow[];
      const eligible = rows.map((row) => {
        const decoded = decodeRow(row);
        if (decoded.status !== "ok") {
          throw new DacsNodeSqliteError(
            decoded.status === "unsupported"
              ? "payment-evidence-version-unsupported"
              : "payment-evidence-record-corrupt",
            decoded.status === "unsupported"
              ? `Payment-evidence store version ${decoded.version} is unsupported`
              : decoded.reason,
          );
        }
        const outbox = decoded.record[field];
        const runnable = outbox !== undefined &&
          ((outbox.state === "pending" &&
            (outbox.retryAt === undefined || outbox.retryAt <= now)) ||
           (outbox.state === "sending" && outbox.lease!.expiresAt <= now));
        if (!runnable || (field === "requestOutbox" && decoded.record.completion)) {
          throw new DacsNodeSqliteError(
            "payment-evidence-record-corrupt",
            "Payment-evidence outbox projection differs from its record",
          );
        }
        return decoded.record;
      });
      const selected = eligible.slice(0, input.limit);
      const items = selected.map((current) => {
        const outbox = current[field]!;
        const updatedAt = stamp(current, now);
        const expiresAt = updatedAt + input.leaseDurationMs;
        const generation = outbox.generation + 1;
        if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(generation)) {
          throw new DacsNodeSqliteError(
            "payment-evidence-claim-overflow",
            "Payment-evidence outbox lease or generation overflows",
          );
        }
        const lease: PaymentEvidenceHandshakeLease = {
          owner: input.owner,
          generation,
          expiresAt,
        };
        const nextOutbox: PaymentEvidenceOutbox = {
          state: "sending",
          generation,
          attempts: outbox.attempts + 1,
          updatedAt,
          lease,
        };
        const next = {
          ...clone(current),
          [field]: nextOutbox,
          updatedAt,
        } as PaymentEvidenceHandshakeRecord;
        if (!save(current, next)) {
          throw new DacsNodeSqliteError(
            "payment-evidence-write-raced",
            "Payment-evidence outbox changed during its claim",
          );
        }
        return field === "requestOutbox"
          ? { request: clone(current.request), lease: clone(lease) }
          : { completion: clone(current.completion!), lease: clone(lease) };
      });
      return {
        items,
        ...(eligible.length > selected.length && selected.length > 0
          ? { nextCursor: selected.at(-1)!.messageId }
          : {}),
      };
    });
  };

  const writeOutbox = (
    field: "requestOutbox" | "completionOutbox",
    input: Readonly<{
      scopeHash: string;
      messageId: string;
      messageHash: string;
      lease: Readonly<PaymentEvidenceHandshakeLease>;
      reasonCode?: string;
      retryAt?: number;
    }>,
    acknowledge: boolean,
  ): PaymentEvidenceHandshakeWrite => beginImmediate(database, () => {
    const loaded = loadRecord(input.messageId, input.scopeHash);
    if (loaded.status !== "ok") return loaded;
    const current = loaded.record;
    const expectedHash = field === "requestOutbox"
      ? current.request.requestHash
      : current.completion?.completionHash;
    if (expectedHash !== input.messageHash) return { status: "stale" };
    const lease = captureLease(input.lease);
    if (!lease || (!acknowledge && (!reasonCode(input.reasonCode) ||
        (input.retryAt !== undefined && !safeUint(input.retryAt))))) {
      return { status: "corrupt", reason: "payment-evidence outbox write is malformed" };
    }
    const outbox = current[field];
    if (!outbox) return { status: "conflict" };
    if (acknowledge && outbox.state === "acknowledged") {
      return { status: "existing", record: clone(current) };
    }
    const now = databaseTime(database);
    if (outbox.state !== "sending" || !leaseMatches(outbox.lease, lease)) {
      return { status: "stale" };
    }
    const updatedAt = stamp(current, now);
    const nextOutbox: PaymentEvidenceOutbox = acknowledge
      ? {
          state: "acknowledged",
          generation: outbox.generation,
          attempts: outbox.attempts,
          updatedAt,
        }
      : {
          state: "pending",
          generation: outbox.generation,
          attempts: outbox.attempts,
          updatedAt,
          reasonCode: input.reasonCode!,
          ...(input.retryAt === undefined ? {} : { retryAt: input.retryAt }),
        };
    const saved = save(current, {
      ...clone(current),
      [field]: nextOutbox,
      updatedAt,
    } as PaymentEvidenceHandshakeRecord);
    return saved
      ? { status: "recorded", record: saved }
      : { status: "stale" };
  });

  return {
    async readTime() {
      return databaseTime(database);
    },

    async putRequest(rawInput) {
      let input: typeof rawInput;
      try {
        input = captureCanonicalData(rawInput, new WeakSet(), true) as typeof rawInput;
      } catch {
        return { status: "corrupt", reason: "payment-evidence request put is malformed" };
      }
      if (input.role !== role || !hash(input.scopeHash) ||
          !isPaymentEvidenceAnchorRequest(input.request) ||
          paymentEvidenceScopeHash(input.request) !== input.scopeHash ||
          (role === "buyer" && input.requestAuthentication === undefined) ||
          (role === "seller" && input.requestAuthentication !== undefined)) {
        return { status: "corrupt", reason: "payment-evidence request put is malformed" };
      }
      return beginImmediate(database, () => {
        const existingRow = readRow(input.request.messageId);
        if (existingRow) {
          const decoded = decodeRow(existingRow);
          if (decoded.status !== "ok") return decoded;
          const same = canonicalize(decoded.record.request) === canonicalize(input.request) &&
            canonicalize(decoded.record.requestAuthentication ?? null) ===
              canonicalize(input.requestAuthentication ?? null);
          return same
            ? { status: "existing" as const, record: clone(decoded.record) }
            : { status: "conflict" as const };
        }
        const reservations = [
          ["message", input.request.messageId],
          ["effect", input.request.effectId],
          ["logical-address", input.request.logicalAddress],
        ] as const;
        const lookup = database.prepare(`
          SELECT 1 FROM dacs_payment_evidence_reservations
          WHERE role = ? AND scope_hash = ? AND reservation_kind = ? AND identity = ?
        `);
        if (reservations.some(([kind, identity]) =>
          lookup.get(role, input.scopeHash, kind, identity) !== undefined)) {
          return { status: "conflict" as const };
        }
        const now = databaseTime(database);
        const record: PaymentEvidenceHandshakeRecord = {
          storeVersion: PAYMENT_EVIDENCE_HANDSHAKE_STORE_VERSION,
          revision: 1,
          role,
          messageId: input.request.messageId,
          request: clone(input.request),
          ...(role === "buyer"
            ? {
                requestAuthentication: clone(input.requestAuthentication!),
                buyerWork: {
                  state: "pending" as const,
                  generation: 0,
                  attempts: 0,
                  updatedAt: now,
                },
              }
            : {
                requestOutbox: {
                  state: "pending" as const,
                  generation: 0,
                  attempts: 0,
                  updatedAt: now,
                },
              }),
          createdAt: now,
          updatedAt: now,
        };
        const violation = paymentEvidenceHandshakeViolation(record);
        if (violation || !paymentEvidenceAuthorityMatches(record, authority)) {
          return {
            status: "corrupt" as const,
            reason: violation ?? "payment-evidence request is not owned by this actor database",
          };
        }
        insertPaymentEvidenceRecord(database, record);
        return { status: "created" as const, record: clone(record) };
      });
    },

    async load(inputRole, messageId, scopeHash) {
      if (inputRole !== role) {
        return { status: "corrupt", reason: "payment-evidence role differs from bound store" };
      }
      if (!nonEmpty(messageId) || !hash(scopeHash)) {
        return { status: "corrupt", reason: "payment-evidence lookup is malformed" };
      }
      return readSnapshot(database, () => loadRecord(messageId, scopeHash));
    },

    async listBuyerRunnable(input) {
      try {
        input = captureCanonicalData(input, new WeakSet(), true) as typeof input;
      } catch {
        throw new DacsNodeSqliteError(
          "payment-evidence-query-malformed",
          "Payment-evidence runnable query must contain only own canonical data",
        );
      }
      validateQuery(input, "Payment-evidence runnable query");
      if (role !== "buyer") {
        throw new DacsNodeSqliteError(
          "payment-evidence-role-mismatch",
          "Only a buyer actor database can list buyer work",
        );
      }
      return readSnapshot(database, () => {
        const now = databaseTime(database);
        const rows = database.prepare(`
          SELECT * FROM dacs_payment_evidence_handshakes
          WHERE role = 'buyer' AND scope_hash = ? AND message_id > ?
            AND completion_hash IS NULL
            AND buyer_state IN ('pending', 'reconciliation-required')
            AND (buyer_retry_at IS NULL OR buyer_retry_at <= ?)
            AND (buyer_lease_expires_at IS NULL OR buyer_lease_expires_at <= ?)
          ORDER BY message_id
          LIMIT ?
        `).all(input.scopeHash, input.cursor ?? "", now, now, input.limit + 1) as
          PaymentEvidenceHandshakeRow[];
        const records = rows.map((row) => {
          const decoded = decodeRow(row);
          if (decoded.status !== "ok") {
            throw new DacsNodeSqliteError(
              decoded.status === "unsupported"
                ? "payment-evidence-version-unsupported"
                : "payment-evidence-record-corrupt",
              decoded.status === "unsupported"
                ? `Payment-evidence store version ${decoded.version} is unsupported`
                : decoded.reason,
            );
          }
          const work = decoded.record.buyerWork!;
          if (decoded.record.completion ||
              !["pending", "reconciliation-required"].includes(work.state) ||
              (work.retryAt !== undefined && work.retryAt > now) ||
              (work.lease !== undefined && work.lease.expiresAt > now)) {
            throw new DacsNodeSqliteError(
              "payment-evidence-record-corrupt",
              "Payment-evidence runnable projection differs from its record",
            );
          }
          return decoded.record;
        });
        const selected = records.slice(0, input.limit);
        return {
          items: selected.map(clone),
          ...(records.length > selected.length && selected.length > 0
            ? { nextCursor: selected.at(-1)!.messageId }
            : {}),
        };
      });
    },

    async claimBuyer(rawInput) {
      let input: typeof rawInput;
      try {
        input = captureCanonicalData(rawInput, new WeakSet(), true) as typeof rawInput;
      } catch {
        return { status: "corrupt", reason: "buyer handshake claim is malformed" };
      }
      if (role !== "buyer") return { status: "stale" };
      return beginImmediate(database, () => {
        const loaded = loadRecord(input.messageId, input.scopeHash);
        if (loaded.status !== "ok") return loaded;
        const current = loaded.record;
        if (current.request.requestHash !== input.requestHash) return { status: "stale" };
        if (current.completion) return { status: "complete", record: clone(current) };
        if (!nonEmpty(input.owner) || !safeUint(input.leaseDurationMs) ||
            input.leaseDurationMs === 0) {
          return { status: "corrupt", reason: "buyer handshake claim is malformed" };
        }
        const work = current.buyerWork!;
        if (work.state === "operator-action") {
          return { status: "not-runnable", record: clone(current) };
        }
        const now = databaseTime(database);
        if (work.retryAt !== undefined && work.retryAt > now) {
          return { status: "not-runnable", record: clone(current) };
        }
        if (work.lease && work.lease.expiresAt > now) {
          return { status: "waiting", record: clone(current), lease: clone(work.lease) };
        }
        const updatedAt = stamp(current, now);
        const expiresAt = updatedAt + input.leaseDurationMs;
        const generation = work.generation + 1;
        if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(generation)) {
          return { status: "corrupt", reason: "buyer handshake lease overflows" };
        }
        const lease: PaymentEvidenceHandshakeLease = {
          owner: input.owner,
          generation,
          expiresAt,
        };
        const next: PaymentEvidenceHandshakeRecord = {
          ...clone(current),
          buyerWork: {
            state: "reconciliation-required",
            generation,
            attempts: work.attempts + 1,
            updatedAt,
            reasonCode: work.state === "reconciliation-required"
              ? work.reasonCode!
              : "anchor-attempt-in-flight",
            ...(work.absenceProofHash === undefined
              ? {}
              : { absenceProofHash: work.absenceProofHash }),
            lease,
          },
          updatedAt,
        };
        const saved = save(current, next);
        return saved
          ? {
              status: "acquired" as const,
              mode: work.state === "reconciliation-required" ? "reconcile" as const : "anchor" as const,
              record: saved,
              lease: clone(lease),
            }
          : { status: "stale" as const };
      });
    },

    async isCurrentBuyer(rawInput) {
      if (role !== "buyer") return false;
      let input: typeof rawInput;
      try {
        input = captureCanonicalData(rawInput, new WeakSet(), true) as typeof rawInput;
      } catch {
        return false;
      }
      const lease = captureLease(input.lease);
      if (!lease) return false;
      return readSnapshot(database, () => {
        const loaded = loadRecord(input.messageId, input.scopeHash);
        if (loaded.status !== "ok" || loaded.record.request.requestHash !== input.requestHash ||
            loaded.record.completion || !loaded.record.buyerWork?.lease) return false;
        return leaseMatches(loaded.record.buyerWork.lease, lease) &&
          lease.expiresAt > databaseTime(database);
      });
    },

    async recordBuyerAttempt(rawInput) {
      if (role !== "buyer") return { status: "stale" };
      let input: typeof rawInput;
      try {
        input = captureCanonicalData(rawInput, new WeakSet(), true) as typeof rawInput;
      } catch {
        return { status: "conflict" };
      }
      return beginImmediate(database, () => {
        const loaded = loadRecord(input.messageId, input.scopeHash);
        if (loaded.status !== "ok") return loaded;
        const current = loaded.record;
        const lease = captureLease(input.lease);
        if (!lease || current.request.requestHash !== input.requestHash || current.completion ||
            !reasonCode(input.reasonCode) ||
            (input.state !== "reconciliation-required" && input.state !== "operator-action") ||
            (input.retryAt !== undefined && !safeUint(input.retryAt)) ||
            (input.state === "operator-action" && input.retryAt !== undefined)) {
          return { status: "conflict" };
        }
        const now = databaseTime(database);
        const work = current.buyerWork!;
        if (!leaseMatches(work.lease, lease) || lease.expiresAt <= now) {
          return { status: "stale" };
        }
        const updatedAt = stamp(current, now);
        const nextWork: PaymentEvidenceBuyerWork = {
          state: input.state,
          generation: work.generation,
          attempts: work.attempts,
          updatedAt,
          reasonCode: input.reasonCode,
          ...(input.retryAt === undefined ? {} : { retryAt: input.retryAt }),
          ...(work.absenceProofHash === undefined
            ? {}
            : { absenceProofHash: work.absenceProofHash }),
        };
        const saved = save(current, {
          ...clone(current),
          buyerWork: nextWork,
          updatedAt,
        });
        return saved
          ? { status: "recorded", record: saved }
          : { status: "stale" };
      });
    },

    async recordBuyerAbsence(rawInput) {
      if (role !== "buyer") return { status: "stale" };
      let input: typeof rawInput;
      try {
        input = captureCanonicalData(rawInput, new WeakSet(), true) as typeof rawInput;
      } catch {
        return { status: "stale" };
      }
      return beginImmediate(database, () => {
        const loaded = loadRecord(input.messageId, input.scopeHash);
        if (loaded.status !== "ok") return loaded;
        const current = loaded.record;
        const work = current.buyerWork!;
        const lease = captureLease(input.lease);
        const now = databaseTime(database);
        if (!lease || current.request.requestHash !== input.requestHash || current.completion ||
            !hash(input.absenceProofHash) || work.state !== "reconciliation-required" ||
            !leaseMatches(work.lease, lease) || lease.expiresAt <= now) {
          return { status: "stale" };
        }
        const updatedAt = stamp(current, now);
        const saved = save(current, {
          ...clone(current),
          buyerWork: {
            state: "pending",
            generation: work.generation,
            attempts: work.attempts,
            updatedAt,
            absenceProofHash: input.absenceProofHash,
          },
          updatedAt,
        });
        return saved
          ? { status: "recorded", record: saved }
          : { status: "stale" };
      });
    },

    async recordBuyerCompletion(rawInput) {
      if (role !== "buyer") return { status: "stale" };
      let input: typeof rawInput;
      try {
        input = captureCanonicalData(rawInput, new WeakSet(), true) as typeof rawInput;
      } catch {
        return { status: "stale" };
      }
      return beginImmediate(database, () => {
        const loaded = loadRecord(input.messageId, input.scopeHash);
        if (loaded.status !== "ok") return loaded;
        const current = loaded.record;
        if (current.request.requestHash !== input.requestHash) return { status: "stale" };
        if (current.completion) {
          return canonicalize(current.completion) === canonicalize(input.completion)
            ? { status: "existing", record: clone(current) }
            : { status: "conflict" };
        }
        const lease = captureLease(input.lease);
        const now = databaseTime(database);
        const work = current.buyerWork!;
        if (!lease || !leaseMatches(work.lease, lease) || lease.expiresAt <= now ||
            !isPaymentEvidenceAnchorCompletion(input.completion)) return { status: "stale" };
        const updatedAt = stamp(current, now);
        const candidate: PaymentEvidenceHandshakeRecord = {
          ...clone(current),
          buyerWork: {
            state: "complete",
            generation: work.generation,
            attempts: work.attempts,
            updatedAt,
            ...(work.absenceProofHash === undefined
              ? {}
              : { absenceProofHash: work.absenceProofHash }),
          },
          completion: clone(input.completion),
          completionOutbox: {
            state: "pending",
            generation: 0,
            attempts: 0,
            updatedAt,
          },
          updatedAt,
        };
        if (paymentEvidenceHandshakeViolation(candidate)) return { status: "stale" };
        const saved = save(current, candidate);
        return saved
          ? { status: "recorded", record: saved }
          : { status: "stale" };
      });
    },

    async requeueBuyer(rawInput) {
      if (role !== "buyer") return { status: "stale" };
      let input: typeof rawInput;
      try {
        input = captureCanonicalData(rawInput, new WeakSet(), true) as typeof rawInput;
      } catch {
        return { status: "conflict" };
      }
      return beginImmediate(database, () => {
        const loaded = loadRecord(input.messageId, input.scopeHash);
        if (loaded.status !== "ok") return loaded;
        const current = loaded.record;
        const work = current.buyerWork!;
        if (current.request.requestHash !== input.requestHash || current.completion ||
            !reasonCode(input.operatorReasonCode)) return { status: "conflict" };
        if (work.lease) return { status: "stale" };
        const updatedAt = stamp(current);
        const saved = save(current, {
          ...clone(current),
          buyerWork: {
            state: "reconciliation-required",
            generation: work.generation,
            attempts: work.attempts,
            updatedAt,
            reasonCode: input.operatorReasonCode,
            ...(work.absenceProofHash === undefined
              ? {}
              : { absenceProofHash: work.absenceProofHash }),
          },
          updatedAt,
        });
        return saved
          ? { status: "recorded", record: saved }
          : { status: "stale" };
      });
    },

    async recordSellerCompletion(rawInput) {
      if (role !== "seller") return { status: "stale" };
      let input: typeof rawInput;
      try {
        input = captureCanonicalData(rawInput, new WeakSet(), true) as typeof rawInput;
      } catch {
        return { status: "conflict" };
      }
      return beginImmediate(database, () => {
        const loaded = loadRecord(input.messageId, input.scopeHash);
        if (loaded.status !== "ok") return loaded;
        const current = loaded.record;
        if (current.request.requestHash !== input.requestHash ||
            !isPaymentEvidenceAnchorCompletion(input.completion)) {
          return { status: "conflict" };
        }
        if (current.completion) {
          const same = canonicalize(current.completion) === canonicalize(input.completion) &&
            canonicalize(current.completionAuthentication) ===
              canonicalize(input.completionAuthentication);
          return same
            ? { status: "existing", record: clone(current) }
            : { status: "conflict" };
        }
        const updatedAt = stamp(current);
        const candidate: PaymentEvidenceHandshakeRecord = {
          ...clone(current),
          requestOutbox: {
            state: "acknowledged",
            generation: current.requestOutbox!.generation,
            attempts: current.requestOutbox!.attempts,
            updatedAt,
          },
          completion: clone(input.completion),
          completionAuthentication: clone(input.completionAuthentication),
          updatedAt,
        };
        if (paymentEvidenceHandshakeViolation(candidate)) return { status: "conflict" };
        const saved = save(current, candidate);
        return saved
          ? { status: "recorded", record: saved }
          : { status: "stale" };
      });
    },

    async claimSellerRequests(input) {
      if (role !== "seller") {
        throw new DacsNodeSqliteError(
          "payment-evidence-role-mismatch",
          "Only a seller actor database can claim request outbox messages",
        );
      }
      return claimOutbox("requestOutbox", input) as
        PaymentEvidencePage<PaymentEvidenceOutboundRequestClaim>;
    },

    async acknowledgeSellerRequest(input) {
      if (role !== "seller") return { status: "stale" };
      try {
        input = captureCanonicalData(input, new WeakSet(), true) as typeof input;
      } catch {
        return { status: "corrupt", reason: "payment-evidence outbox write is malformed" };
      }
      return writeOutbox("requestOutbox", {
        scopeHash: input.scopeHash,
        messageId: input.messageId,
        messageHash: input.requestHash,
        lease: input.lease,
      }, true);
    },

    async releaseSellerRequest(input) {
      if (role !== "seller") return { status: "stale" };
      try {
        input = captureCanonicalData(input, new WeakSet(), true) as typeof input;
      } catch {
        return { status: "corrupt", reason: "payment-evidence outbox write is malformed" };
      }
      return writeOutbox("requestOutbox", {
        scopeHash: input.scopeHash,
        messageId: input.messageId,
        messageHash: input.requestHash,
        lease: input.lease,
        reasonCode: input.reasonCode,
        ...(input.retryAt === undefined ? {} : { retryAt: input.retryAt }),
      }, false);
    },

    async claimBuyerCompletions(input) {
      if (role !== "buyer") {
        throw new DacsNodeSqliteError(
          "payment-evidence-role-mismatch",
          "Only a buyer actor database can claim completion outbox messages",
        );
      }
      return claimOutbox("completionOutbox", input) as
        PaymentEvidencePage<PaymentEvidenceOutboundCompletionClaim>;
    },

    async acknowledgeBuyerCompletion(input) {
      if (role !== "buyer") return { status: "stale" };
      try {
        input = captureCanonicalData(input, new WeakSet(), true) as typeof input;
      } catch {
        return { status: "corrupt", reason: "payment-evidence outbox write is malformed" };
      }
      return writeOutbox("completionOutbox", {
        scopeHash: input.scopeHash,
        messageId: input.messageId,
        messageHash: input.completionHash,
        lease: input.lease,
      }, true);
    },

    async releaseBuyerCompletion(input) {
      if (role !== "buyer") return { status: "stale" };
      try {
        input = captureCanonicalData(input, new WeakSet(), true) as typeof input;
      } catch {
        return { status: "corrupt", reason: "payment-evidence outbox write is malformed" };
      }
      return writeOutbox("completionOutbox", {
        scopeHash: input.scopeHash,
        messageId: input.messageId,
        messageHash: input.completionHash,
        lease: input.lease,
        reasonCode: input.reasonCode,
        ...(input.retryAt === undefined ? {} : { retryAt: input.retryAt }),
      }, false);
    },
  };
}

function readUpgradeSafety(
  database: BetterSqlite3.Database,
): Readonly<DacsNodeSqliteUpgradeSafetyV1> {
  return readSnapshot(database, () => {
    const effectCounts = database.prepare(`
      SELECT
        SUM(CASE WHEN state = 'intent' THEN 1 ELSE 0 END) AS intent_effects,
        SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END) AS active_effects,
        SUM(CASE WHEN state = 'reconciliation-required' THEN 1 ELSE 0 END)
          AS reconciliation_effects,
        SUM(CASE WHEN state = 'operator-action' THEN 1 ELSE 0 END)
          AS operator_action_effects
      FROM dacs_effects
    `).get() as Readonly<{
      intent_effects: number | null;
      active_effects: number | null;
      reconciliation_effects: number | null;
      operator_action_effects: number | null;
    }>;
    const orderCounts = database.prepare(`
      SELECT COUNT(*) AS incomplete_orders
      FROM dacs_coordinator_orders
      WHERE json_extract(record_json, '$.tracks.audit.state') IS NULL
         OR json_extract(record_json, '$.tracks.audit.state') <> 'final'
    `).get() as Readonly<{ incomplete_orders: number }>;
    const intentEffects = effectCounts.intent_effects ?? 0;
    const activeEffects = effectCounts.active_effects ?? 0;
    const reconciliationEffects = effectCounts.reconciliation_effects ?? 0;
    const operatorActionEffects = effectCounts.operator_action_effects ?? 0;
    const incompleteOrders = orderCounts.incomplete_orders;
    if ([intentEffects, activeEffects, reconciliationEffects,
      operatorActionEffects, incompleteOrders]
      .some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new DacsNodeSqliteError(
        "database-upgrade-safety-invalid",
        "SQLite upgrade-safety projection is invalid",
      );
    }
    return Object.freeze({
      safe: intentEffects === 0 && activeEffects === 0 && reconciliationEffects === 0 &&
        operatorActionEffects === 0 && incompleteOrders === 0,
      intentEffects,
      activeEffects,
      reconciliationEffects,
      operatorActionEffects,
      incompleteOrders,
    });
  });
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

  upgradeSafety(): Readonly<DacsNodeSqliteUpgradeSafetyV1> {
    this.assertOpen();
    return readUpgradeSafety(this.database);
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

  createPayDemCoordinatorStore(
    role: FixedPriceX402CoordinatorRole,
  ): FixedPricePayDemCoordinatorStore {
    if (this.metadata.mode !== "live-demos") {
      throw new DacsNodeSqliteError(
        "coordinator-profile-mismatch",
        "A pay-dem coordinator store requires a live Demos actor database",
      );
    }
    return this.createCoordinatorStore("live-pay-dem", role) as unknown as
      FixedPricePayDemCoordinatorStore;
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

  createPaymentEvidenceHandshakeStore(): PaymentEvidenceHandshakeStore {
    this.assertOpen();
    if (this.metadata.mode !== "live-demos" ||
        (this.metadata.role !== "buyer" && this.metadata.role !== "seller")) {
      throw new DacsNodeSqliteError(
        "payment-evidence-profile-mismatch",
        "A payment-evidence handshake store requires one live buyer or seller actor database",
      );
    }
    return createSqlitePaymentEvidenceHandshakeStore(
      this.database,
      this.metadata.role,
      this.metadata.authority,
    );
  }

  createHttpInboxStore(
    options?: Readonly<DacsHttpTransportStoreOptionsV1>,
  ): DacsHttpInboxStoreV1 {
    this.assertOpen();
    if (this.metadata.mode !== "live-demos" ||
        (this.metadata.role !== "buyer" && this.metadata.role !== "seller")) {
      throw new DacsNodeSqliteError(
        "http-transport-profile-mismatch",
        "An HTTP inbox store requires one live buyer or seller actor database",
      );
    }
    return createDacsHttpInboxSqliteStore(
      dacsHttpSqliteContext(
        this.database,
        this.metadata.authority,
        this.metadata.role,
      ),
      options,
    );
  }

  createHttpOutboxStore(
    options?: Readonly<DacsHttpTransportStoreOptionsV1>,
  ): DacsHttpOutboxStoreV1 {
    this.assertOpen();
    if (this.metadata.mode !== "live-demos" ||
        (this.metadata.role !== "buyer" && this.metadata.role !== "seller")) {
      throw new DacsNodeSqliteError(
        "http-transport-profile-mismatch",
        "An HTTP outbox store requires one live buyer or seller actor database",
      );
    }
    return createDacsHttpOutboxSqliteStore(
      dacsHttpSqliteContext(
        this.database,
        this.metadata.authority,
        this.metadata.role,
      ),
      options,
    );
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
    const authority = this.metadata.authority;
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
      if (!row) return { status: "missing" };
      const decoded = coordinatorFromRow(row, profile);
      if (decoded.status === "ok") {
        if (!coordinatorAuthorityMatches(decoded.record, authority)) {
          return {
            status: "corrupt",
            reason: "coordinator record is not owned by the database actor authority",
          };
        }
        if (!coordinatorTrackProjectionMatches(database, profile, decoded.record)) {
          return {
            status: "corrupt",
            reason: "coordinator track projection differs from its integrity-checked record",
          };
        }
      }
      return decoded;
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
          binding_hash = ?, local_binding_hash = ?, record_hash = ?,
          record_json = ?, revision = ?, created_at = ?, updated_at = ?
        WHERE profile = ? AND role = ? AND job_id = ? AND revision = ?
      `).run(
        next.bindingHash,
        next.localBindingHash,
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
      if (result.changes !== 1) return null;
      replaceCoordinatorTrackProjection(database, profile, next);
      return clone(next);
    };
    const toLive = (record: Readonly<CoordinatorRecord>): FixedPriceX402OrderRecord =>
      clone(record) as FixedPriceX402OrderRecord;

    const store: FixedPriceX402CoordinatorStore = {
      async readTime() {
        return databaseTime(database);
      },

      async create(input) {
        try {
          input = captureCanonicalData(input, new WeakSet(), true) as typeof input;
        } catch {
          return { status: "corrupt", reason: "coordinator order is malformed" };
        }
        if (input.role !== role) {
          return { status: "corrupt", reason: "coordinator role differs from bound store" };
        }
        if ((role === "buyer" ? input.order.buyer : input.order.seller) !==
            authority) {
          return {
            status: "corrupt",
            reason: "coordinator order is not owned by the database actor authority",
          };
        }
        let expectedBindingHash: string;
        let expectedLocalBindingHash: string;
        try {
          expectedBindingHash = coordinatorBindingHash(profile, input.order);
          expectedLocalBindingHash = coordinatorLocalBindingHash(profile, input.order);
        } catch (error) {
          return {
            status: "corrupt",
            reason: error instanceof Error ? error.message : "coordinator order is malformed",
          };
        }
        if (input.bindingHash !== expectedBindingHash) return { status: "conflict" };
        if (input.localBindingHash !== expectedLocalBindingHash) {
          return { status: "conflict" };
        }
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
              localBindingHash: expectedLocalBindingHash,
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
          // One actor-local job may bind to exactly one live rail. This check
          // runs inside BEGIN IMMEDIATE, so competing x402/pay-DEM creators on
          // this process or another connection cannot both observe absence and
          // insert different profile rows. Offline databases never mix live
          // profiles, but retaining the same identity rule there is harmless.
          const otherProfile = database.prepare(`
            SELECT profile FROM dacs_coordinator_orders
            WHERE role = ? AND job_id = ? AND profile <> ?
            LIMIT 1
          `).get(role, input.order.jobId, profile) as
            { profile: string } | undefined;
          if (otherProfile !== undefined) return { status: "conflict" as const };
          const existing = loadRecord(input.order.jobId);
          if (existing.status !== "missing") {
            if (existing.status !== "ok") return existing;
            return existing.record.bindingHash === expectedBindingHash &&
                existing.record.localBindingHash === expectedLocalBindingHash &&
                canonicalize(existing.record.sdkJobs) === canonicalize(record.sdkJobs)
              ? { status: "existing" as const, record: toLive(existing.record) }
              : { status: "conflict" as const };
          }
          const recordJson = canonicalize(record);
          database.prepare(`
            INSERT INTO dacs_coordinator_orders (
              profile, role, job_id, binding_hash, local_binding_hash,
              record_hash, record_json, revision, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            profile,
            role,
            record.jobId,
            record.bindingHash,
            record.localBindingHash,
            sha256Hex(recordJson),
            recordJson,
            record.revision,
            record.createdAt,
            record.updatedAt,
          );
          replaceCoordinatorTrackProjection(database, profile, record);
          return { status: "created" as const, record: toLive(record) };
        });
      },

      async load(inputRole, jobId) {
        if (inputRole !== role) {
          return { status: "corrupt", reason: "coordinator role differs from bound store" };
        }
        return readSnapshot(database, () => {
          const loaded = loadRecord(jobId);
          return loaded.status === "ok"
            ? { status: "ok", record: toLive(loaded.record) }
            : loaded;
        });
      },

      async listRunnable(input) {
        try {
          input = captureCanonicalData(input, new WeakSet(), true) as typeof input;
        } catch {
          throw new DacsNodeSqliteError(
            "coordinator-query-malformed",
            "Coordinator runnable query is malformed",
          );
        }
        if (input.role !== role || !Array.isArray(input.tracks) ||
            input.tracks.some((track) => !coordinatorTracks(role).includes(track)) ||
            (input.cursor !== undefined && !nonEmpty(input.cursor)) ||
            !safeUint(input.limit) || input.limit === 0 ||
            input.limit > DACS_NODE_SQLITE_MAX_PAGE_SIZE) {
          throw new DacsNodeSqliteError(
            "coordinator-query-malformed",
            "Coordinator runnable query is malformed",
          );
        }
        if (input.tracks.length === 0) return { items: [] };
        return readSnapshot(database, () => {
          const now = databaseTime(database);
          const trackPlaceholders = input.tracks.map(() => "?").join(", ");
          const rows = database.prepare(`
            SELECT orders.* FROM dacs_coordinator_orders AS orders
            WHERE orders.profile = ? AND orders.role = ? AND orders.job_id > ?
              AND EXISTS (
                SELECT 1 FROM dacs_coordinator_tracks AS tracks
                WHERE tracks.profile = orders.profile
                  AND tracks.role = orders.role
                  AND tracks.job_id = orders.job_id
                  AND tracks.track IN (${trackPlaceholders})
                  AND tracks.eligible = 1
                  AND tracks.state NOT IN ('final', 'operator-action')
                  AND (tracks.next_attempt_at IS NULL OR tracks.next_attempt_at <= ?)
                  AND (tracks.lease_expires_at IS NULL OR tracks.lease_expires_at <= ?)
              )
            ORDER BY orders.job_id
            LIMIT ?
          `).all(
            profile,
            role,
            input.cursor ?? "",
            ...input.tracks,
            now,
            now,
            input.limit + 1,
          ) as CoordinatorRow[];
          const eligible = rows.map((row) => {
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
            if (!coordinatorAuthorityMatches(decoded.record, authority) ||
                !input.tracks.some((track) =>
                  coordinatorTrackRunnable(profile, decoded.record, track, now))) {
              throw new DacsNodeSqliteError(
                "coordinator-record-corrupt",
                "Coordinator runnable projection differs from its integrity-checked record",
              );
            }
            return decoded.record;
          });
          if (!coordinatorTrackProjectionSetMatches(database, profile, eligible)) {
            throw new DacsNodeSqliteError(
              "coordinator-record-corrupt",
              "Coordinator runnable projection differs from its integrity-checked record",
            );
          }
          const selected = eligible.slice(0, input.limit);
          return {
            items: selected.map(toLive),
            ...(eligible.length > selected.length && selected.length > 0
              ? { nextCursor: selected.at(-1)!.jobId }
              : {}),
          };
        });
      },

      async claim(input) {
        try {
          input = captureCanonicalData(input, new WeakSet(), true) as typeof input;
        } catch {
          return { status: "corrupt", reason: "coordinator claim is malformed" };
        }
        if (input.role !== role) return { status: "stale" };
        return beginImmediate(database, () => {
          const loaded = loadRecord(input.jobId);
          if (loaded.status !== "ok") return loaded;
          const current = loaded.record;
          if (current.bindingHash !== input.bindingHash ||
              current.localBindingHash !== input.localBindingHash) {
            return { status: "stale" as const };
          }
          if (!coordinatorTracks(role).includes(input.track) || !nonEmpty(input.owner) ||
              !safeUint(input.leaseDurationMs) || input.leaseDurationMs === 0) {
            return { status: "corrupt" as const, reason: "coordinator claim is malformed" };
          }
          const now = databaseTime(database);
          const retained = current.tracks[input.track]!;
          if (!coordinatorTrackEligible(profile, current, input.track) ||
              retained.state === "final" ||
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
            Record<FixedPriceX402Track, CoordinatorTrackRecord>
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
          } as CoordinatorRecord);
          return next
            ? { status: "acquired" as const, record: toLive(next), lease: clone(lease) }
            : { status: "stale" as const };
        });
      },

      async isCurrent(input) {
        try {
          input = captureCanonicalData(input, new WeakSet(), true) as typeof input;
        } catch {
          return false;
        }
        if (input.role !== role) return false;
        return readSnapshot(database, () => {
          const loaded = loadRecord(input.jobId);
          if (loaded.status !== "ok" || loaded.record.bindingHash !== input.bindingHash ||
              loaded.record.localBindingHash !== input.localBindingHash) {
            return false;
          }
          const retained = loaded.record.tracks[input.track];
          const now = databaseTime(database);
          return retained?.state === "running" && retained.lease !== undefined &&
            retained.lease.owner === input.lease.owner &&
            retained.lease.generation === input.lease.generation &&
            retained.lease.expiresAt === input.lease.expiresAt &&
            retained.lease.expiresAt > now;
        });
      },

      async record(input) {
        try {
          input = captureCanonicalData(input, new WeakSet(), true) as typeof input;
        } catch {
          return { status: "conflict" };
        }
        if (input.role !== role) return { status: "stale" };
        return beginImmediate(database, () => {
          const loaded = loadRecord(input.jobId);
          if (loaded.status !== "ok") return loaded;
          const current = loaded.record;
          if (current.bindingHash !== input.bindingHash ||
              current.localBindingHash !== input.localBindingHash ||
              !coordinatorTracks(role).includes(input.track)) return { status: "stale" as const };
          const retained = current.tracks[input.track]!;
          const now = databaseTime(database);
          if (retained.state !== "running" || !retained.lease ||
              retained.lease.owner !== input.lease.owner ||
              retained.lease.generation !== input.lease.generation ||
              retained.lease.expiresAt !== input.lease.expiresAt ||
              retained.lease.expiresAt <= now) return { status: "stale" as const };
          const result = captureCoordinatorResult(profile, input.result);
          if (!result || (result.status === "final" &&
              !coordinatorResultAllowed(profile, current, input.track, result))) {
            return { status: "conflict" as const };
          }
          const updatedAt = Math.max(current.updatedAt, now);
          const nextTrack = (result.status === "final"
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
                ...(result.outcome === coordinatorFailureOutcome(profile)
                  ? {
                      errorClass: (result as Readonly<{
                        errorClass: CoordinatorErrorClass;
                      }>).errorClass,
                    }
                  : {}),
                ...(liveCoordinatorProfile(profile) && result.outcome === "failure"
                  ? {
                      faultedParty: (result as Readonly<{
                        faultedParty: FixedPriceX402FaultedParty;
                      }>).faultedParty,
                    }
                  : {}),
                ...(liveCoordinatorProfile(profile) && result.outcome === "aborted"
                  ? {
                      withdrawnBy: (result as Readonly<{
                        withdrawnBy: FixedPriceX402CoordinatorRole;
                      }>).withdrawnBy,
                    }
                  : {}),
              }
            : {
                state: result.status,
                generation: retained.generation,
                attempts: retained.attempts,
                updatedAt,
                reasonCode: result.reasonCode,
                ...(result.retryAt === undefined ? {} : { nextAttemptAt: result.retryAt }),
              }) as CoordinatorTrackRecord;
          const tracks = clone(current.tracks) as Partial<
            Record<FixedPriceX402Track, CoordinatorTrackRecord>
          >;
          tracks[input.track] = nextTrack;
          const next = saveRecord(current, {
            ...clone(current),
            tracks,
            updatedAt,
          } as CoordinatorRecord);
          return next
            ? { status: "recorded" as const, record: toLive(next) }
            : { status: "stale" as const };
        });
      },

      async requeue(input) {
        try {
          input = captureCanonicalData(input, new WeakSet(), true) as typeof input;
        } catch {
          return { status: "conflict" };
        }
        if (input.role !== role) return { status: "stale" };
        return beginImmediate(database, () => {
          const loaded = loadRecord(input.jobId);
          if (loaded.status !== "ok") return loaded;
          const current = loaded.record;
          if (current.bindingHash !== input.bindingHash ||
              current.localBindingHash !== input.localBindingHash ||
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
            Record<FixedPriceX402Track, CoordinatorTrackRecord>
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
          } as CoordinatorRecord);
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
    const captured = captureExactData(
      input,
      ["kind", "identity", "bindingHash"],
      ["payloadHash", "jobId"],
    );
    if (!captured ||
        !RESERVATION_KINDS.has(captured.kind as DacsNodeSqliteReservationKind) ||
        !nonEmpty(captured.identity) || !hash(captured.bindingHash) ||
        (captured.payloadHash !== undefined && !hash(captured.payloadHash)) ||
        (captured.jobId !== undefined && !isCanonicalJobId(captured.jobId))) {
      throw new DacsNodeSqliteError(
        "reservation-input-malformed",
        "SQLite reservation input is malformed",
      );
    }
    const retained = Object.freeze({
      kind: captured.kind as DacsNodeSqliteReservationKind,
      identity: captured.identity,
      bindingHash: captured.bindingHash,
      ...(captured.payloadHash === undefined ? {} : { payloadHash: captured.payloadHash }),
      ...(captured.jobId === undefined ? {} : { jobId: captured.jobId }),
    });
    return beginImmediate(this.database, () => {
      const found = this.database.prepare(`
        SELECT * FROM dacs_reservations WHERE kind = ? AND identity = ?
      `).get(retained.kind, retained.identity) as ReservationRow | undefined;
      if (found) {
        const reservation = reservationFromRow(found);
        const same = reservation.bindingHash === retained.bindingHash &&
          reservation.payloadHash === retained.payloadHash &&
          reservation.jobId === retained.jobId;
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
        retained.kind,
        retained.identity,
        retained.bindingHash,
        retained.payloadHash ?? null,
        retained.jobId ?? null,
        createdAt,
      );
      return {
        status: "created" as const,
        reservation: {
          ...retained,
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
    const captured = captureExactData(
      input,
      ["kind", "effectId", "bindingHash", "input", "idempotencyKey"],
      ["jobId"],
    );
    if (!captured) {
      throw new DacsNodeSqliteError("effect-input-malformed", "SQLite effect input is malformed");
    }
    const retained = Object.freeze({
      kind: captured.kind as DacsNodeSqliteEffectKind,
      effectId: captured.effectId as string,
      bindingHash: captured.bindingHash as string,
      idempotencyKey: captured.idempotencyKey as string,
      ...(captured.jobId === undefined ? {} : { jobId: captured.jobId as string }),
    });
    validateEffectIdentity(retained);
    if (!nonEmpty(retained.idempotencyKey) ||
        (retained.jobId !== undefined && !isCanonicalJobId(retained.jobId))) {
      throw new DacsNodeSqliteError("effect-input-malformed", "SQLite effect input is malformed");
    }
    let inputJson: string;
    try {
      inputJson = canonicalize(captureCanonicalData(captured.input));
    } catch {
      throw new DacsNodeSqliteError(
        "effect-input-malformed",
        "SQLite effect input must be canonical JSON data",
      );
    }
    const inputHash = sha256Hex(inputJson);
    return beginImmediate(this.database, () => {
      const existing = this.effectRow(retained.kind, retained.effectId);
      if (existing) {
        const record = this.validatedEffectRecord(existing);
        const same = record.bindingHash === retained.bindingHash &&
          record.inputHash === inputHash &&
          record.idempotencyKey === retained.idempotencyKey &&
          record.jobId === retained.jobId;
        return same
          ? { status: "existing" as const, record: clone(record) }
          : { status: "conflict" as const };
      }
      const duplicateKey = this.database.prepare(`
        SELECT effect_id FROM dacs_effects
        WHERE effect_kind = ? AND idempotency_key = ?
      `).get(retained.kind, retained.idempotencyKey) as { effect_id: string } | undefined;
      if (duplicateKey) return { status: "conflict" as const };

      const reservationKind = reservationKindForEffect(retained.kind);
      const reservation = this.database.prepare(`
        SELECT * FROM dacs_reservations WHERE kind = ? AND identity = ?
      `).get(reservationKind, retained.effectId) as ReservationRow | undefined;
      if (reservation) {
        const existingReservation = reservationFromRow(reservation);
        if (existingReservation.bindingHash !== retained.bindingHash ||
            existingReservation.payloadHash !== inputHash ||
            existingReservation.jobId !== retained.jobId) {
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
          retained.effectId,
          retained.bindingHash,
          inputHash,
          retained.jobId ?? null,
          now,
        );
      }
      this.database.prepare(`
        INSERT INTO dacs_effects (
          effect_kind, effect_id, job_id, binding_hash, input_hash, input_json,
          idempotency_key, identity_hash, state, active_mode, generation, attempts, owner,
          lease_expires_at, retry_at, reason_code, absence_proof_hash,
          result_hash, result_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'intent', NULL, 0, 0, NULL, NULL, NULL,
          NULL, NULL, NULL, NULL, ?, ?)
      `).run(
        retained.kind,
        retained.effectId,
        retained.jobId ?? null,
        retained.bindingHash,
        inputHash,
        inputJson,
        retained.idempotencyKey,
        effectIdentityHash({
          kind: retained.kind,
          effectId: retained.effectId,
          ...(retained.jobId === undefined ? {} : { jobId: retained.jobId }),
          bindingHash: retained.bindingHash,
          inputHash,
          idempotencyKey: retained.idempotencyKey,
        }),
        now,
        now,
      );
      this.appendEffectHistory(retained.kind, retained.effectId, "intent-created", 0, now, {
        ...effectIdentityDetails({
          kind: retained.kind,
          effectId: retained.effectId,
          ...(retained.jobId === undefined ? {} : { jobId: retained.jobId }),
          bindingHash: retained.bindingHash,
          inputHash,
          idempotencyKey: retained.idempotencyKey,
        }),
      });
      return {
        status: "created" as const,
        record: clone(this.validatedEffectRecord(
          this.effectRow(retained.kind, retained.effectId)!,
        )),
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
    return readSnapshot(this.database, () => {
      const row = this.effectRow(kind, effectId);
      return row ? clone(this.validatedEffectRecord(row)) : undefined;
    });
  }

  loadEffectInput(
    kind: DacsNodeSqliteEffectKind,
    effectId: string,
  ): unknown | undefined {
    this.assertOpen();
    if (!EFFECT_KINDS.has(kind) || !nonEmpty(effectId)) {
      throw new DacsNodeSqliteError("effect-input-malformed", "SQLite effect lookup is malformed");
    }
    return readSnapshot(this.database, () => {
      const row = this.effectRow(kind, effectId);
      if (!row) return undefined;
      this.validatedEffectRecord(row);
      return clone(JSON.parse(row.input_json) as unknown);
    });
  }

  claimEffect(input: Readonly<{
    kind: DacsNodeSqliteEffectKind;
    effectId: string;
    bindingHash: string;
    owner: string;
    leaseDurationMs: number;
  }>): DacsNodeSqliteEffectClaim {
    this.assertOpen();
    const captured = captureExactData(
      input,
      ["kind", "effectId", "bindingHash", "owner", "leaseDurationMs"],
    );
    if (!captured) {
      throw new DacsNodeSqliteError("effect-claim-malformed", "SQLite effect claim is malformed");
    }
    const retained = Object.freeze({
      kind: captured.kind as DacsNodeSqliteEffectKind,
      effectId: captured.effectId as string,
      bindingHash: captured.bindingHash as string,
      owner: captured.owner as string,
      leaseDurationMs: captured.leaseDurationMs as number,
    });
    validateEffectIdentity(retained);
    if (!nonEmpty(retained.owner) || !safeUint(retained.leaseDurationMs) ||
        retained.leaseDurationMs === 0) {
      throw new DacsNodeSqliteError("effect-claim-malformed", "SQLite effect claim is malformed");
    }
    return beginImmediate(this.database, () => {
      const row = this.effectRow(retained.kind, retained.effectId);
      if (!row) return { status: "missing" as const };
      const current = this.validatedEffectRecord(row);
      if (current.bindingHash !== retained.bindingHash) return { status: "stale" as const };
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
      const expiresAt = now + retained.leaseDurationMs;
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
        retained.owner,
        expiresAt,
        Math.max(current.updatedAt, now),
        retained.kind,
        retained.effectId,
        current.generation,
      );
      this.appendEffectHistory(
        retained.kind,
        retained.effectId,
        `${mode}-claimed`,
        generation,
        now,
        {
        owner: retained.owner,
        expiresAt,
      });
      const record = this.validatedEffectRecord(
        this.effectRow(retained.kind, retained.effectId)!,
      );
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
    const captured = captureExactData(
      input,
      ["kind", "effectId", "bindingHash", "lease"],
    );
    const lease = captured ? captureEffectLease(captured.lease) : null;
    if (!captured || !lease) {
      throw new DacsNodeSqliteError("effect-input-malformed", "SQLite effect input is malformed");
    }
    const retained = Object.freeze({
      kind: captured.kind as DacsNodeSqliteEffectKind,
      effectId: captured.effectId as string,
      bindingHash: captured.bindingHash as string,
      lease,
    });
    validateEffectIdentity(retained);
    return readSnapshot(this.database, () => {
      const row = this.effectRow(retained.kind, retained.effectId);
      if (!row) return false;
      const record = this.validatedEffectRecord(row);
      return record.bindingHash === retained.bindingHash &&
        exactLease(record, retained.lease, databaseTime(this.database));
    });
  }

  recordEffectCheckpoint(input: Readonly<{
    kind: DacsNodeSqliteEffectKind;
    effectId: string;
    bindingHash: string;
    lease: Readonly<DacsNodeSqliteEffectLease>;
    name: string;
    value: unknown;
  }>): DacsNodeSqliteEffectCheckpointWrite {
    this.assertOpen();
    const captured = captureExactData(
      input,
      ["kind", "effectId", "bindingHash", "lease", "name", "value"],
    );
    const lease = captured ? captureEffectLease(captured.lease) : null;
    if (!captured || !lease || lease.mode !== "perform" ||
        !reasonCode(captured.name)) {
      throw new DacsNodeSqliteError(
        "effect-checkpoint-malformed",
        "SQLite effect checkpoint is malformed",
      );
    }
    const retained = Object.freeze({
      kind: captured.kind as DacsNodeSqliteEffectKind,
      effectId: captured.effectId as string,
      bindingHash: captured.bindingHash as string,
      lease,
      name: captured.name,
    });
    validateEffectIdentity(retained);
    let value: unknown;
    let valueJson: string;
    try {
      value = captureCanonicalData(captured.value);
      valueJson = canonicalize(value);
    } catch {
      throw new DacsNodeSqliteError(
        "effect-checkpoint-malformed",
        "SQLite effect checkpoint must contain canonical JSON data",
      );
    }
    const valueHash = sha256Hex(valueJson);
    return beginImmediate(this.database, () => {
      const row = this.effectRow(retained.kind, retained.effectId);
      if (!row) return { status: "missing" as const };
      const current = this.validatedEffectRecord(row);
      if (current.bindingHash !== retained.bindingHash) {
        return { status: "stale" as const };
      }
      const now = databaseTime(this.database);
      if (!exactLease(current, retained.lease, now)) {
        return { status: "stale" as const };
      }
      const existing = this.effectCheckpoint(
        retained.kind,
        retained.effectId,
        retained.name,
        retained.lease.generation,
      );
      if (existing) {
        return existing.valueHash === valueHash &&
            canonicalize(existing.value) === valueJson
          ? { status: "existing" as const, checkpoint: clone(existing) }
          : { status: "conflict" as const };
      }
      this.database.prepare(`
        UPDATE dacs_effects SET updated_at = ?
        WHERE effect_kind = ? AND effect_id = ? AND generation = ?
      `).run(
        Math.max(current.updatedAt, now),
        retained.kind,
        retained.effectId,
        retained.lease.generation,
      );
      this.appendEffectHistory(
        retained.kind,
        retained.effectId,
        "effect-checkpoint",
        retained.lease.generation,
        now,
        { name: retained.name, valueHash, value },
      );
      const checkpoint = this.effectCheckpoint(
        retained.kind,
        retained.effectId,
        retained.name,
        retained.lease.generation,
      );
      if (!checkpoint) {
        throw new DacsNodeSqliteError(
          "database-logical-corruption",
          "SQLite effect checkpoint was not retained",
        );
      }
      this.validatedEffectRecord(this.effectRow(retained.kind, retained.effectId)!);
      return { status: "recorded" as const, checkpoint: clone(checkpoint) };
    });
  }

  loadEffectCheckpoint(
    kind: DacsNodeSqliteEffectKind,
    effectId: string,
    name: string,
  ): Readonly<DacsNodeSqliteEffectCheckpoint> | undefined {
    this.assertOpen();
    if (!EFFECT_KINDS.has(kind) || !nonEmpty(effectId) || !reasonCode(name)) {
      throw new DacsNodeSqliteError(
        "effect-checkpoint-malformed",
        "SQLite effect checkpoint lookup is malformed",
      );
    }
    return readSnapshot(this.database, () => {
      const row = this.effectRow(kind, effectId);
      if (!row) return undefined;
      this.validatedEffectRecord(row);
      const checkpoint = this.effectCheckpoint(kind, effectId, name);
      return checkpoint ? clone(checkpoint) : undefined;
    });
  }

  recordEffectCompleted(input: Readonly<{
    kind: DacsNodeSqliteEffectKind;
    effectId: string;
    bindingHash: string;
    lease: Readonly<DacsNodeSqliteEffectLease>;
    result: unknown;
  }>): DacsNodeSqliteEffectWrite {
    this.assertOpen();
    const captured = captureExactData(
      input,
      ["kind", "effectId", "bindingHash", "lease", "result"],
    );
    const lease = captured ? captureEffectLease(captured.lease) : null;
    if (!captured || !lease) {
      throw new DacsNodeSqliteError(
        "effect-result-malformed",
        "SQLite effect completion is malformed",
      );
    }
    const retained = Object.freeze({
      kind: captured.kind as DacsNodeSqliteEffectKind,
      effectId: captured.effectId as string,
      bindingHash: captured.bindingHash as string,
      lease,
    });
    validateEffectIdentity(retained);
    let resultJson: string;
    try {
      resultJson = canonicalize(captureCanonicalData(captured.result));
    } catch {
      throw new DacsNodeSqliteError(
        "effect-result-malformed",
        "SQLite effect result must be canonical JSON data",
      );
    }
    return this.completeEffect(
      retained,
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
    const captured = captureExactData(
      input,
      ["kind", "effectId", "bindingHash", "lease", "reasonCode"],
      ["retryAt"],
    );
    const lease = captured ? captureEffectLease(captured.lease) : null;
    if (!captured || !lease || !reasonCode(captured.reasonCode) ||
        (captured.retryAt !== undefined && !safeUint(captured.retryAt))) {
      throw new DacsNodeSqliteError(
        "effect-result-malformed",
        "SQLite ambiguous effect result is malformed",
      );
    }
    const retained = Object.freeze({
      kind: captured.kind as DacsNodeSqliteEffectKind,
      effectId: captured.effectId as string,
      bindingHash: captured.bindingHash as string,
      lease,
      reasonCode: captured.reasonCode,
      ...(captured.retryAt === undefined ? {} : { retryAt: captured.retryAt }),
    });
    validateEffectIdentity(retained);
    return this.transitionCurrentEffect(retained, ({ current, now }) => {
      this.database.prepare(`
        UPDATE dacs_effects SET
          state = 'reconciliation-required', active_mode = NULL, owner = NULL,
          lease_expires_at = NULL, retry_at = ?, reason_code = ?, updated_at = ?
        WHERE effect_kind = ? AND effect_id = ? AND generation = ?
      `).run(
        retained.retryAt ?? null,
        retained.reasonCode,
        Math.max(current.updatedAt, now),
        retained.kind,
        retained.effectId,
        current.generation,
      );
      this.appendEffectHistory(
        retained.kind,
        retained.effectId,
        "reconciliation-required",
        current.generation,
        now,
        { reasonCode: retained.reasonCode, retryAt: retained.retryAt ?? null },
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
    const captured = captureExactData(
      input,
      ["kind", "effectId", "bindingHash", "lease", "result"],
    );
    const lease = captured ? captureEffectLease(captured.lease) : null;
    if (!captured || !lease) {
      throw new DacsNodeSqliteError(
        "effect-result-malformed",
        "SQLite reconciliation result is malformed",
      );
    }
    const retained = Object.freeze({
      kind: captured.kind as DacsNodeSqliteEffectKind,
      effectId: captured.effectId as string,
      bindingHash: captured.bindingHash as string,
      lease,
    });
    validateEffectIdentity(retained);
    if (lease.mode !== "reconcile") return { status: "conflict" };

    const performed = captureExactData(captured.result, ["disposition", "result"]);
    if (performed?.disposition === "performed") {
      let resultJson: string;
      try {
        resultJson = canonicalize(captureCanonicalData(performed.result));
      } catch {
        throw new DacsNodeSqliteError(
          "effect-result-malformed",
          "SQLite reconciliation result must be canonical JSON data",
        );
      }
      return this.completeEffect(
        retained,
        resultJson,
        sha256Hex(resultJson),
        "reconciliation-performed",
      );
    }
    const absent = captureExactData(captured.result, ["disposition", "absenceProofHash"]);
    if (absent?.disposition === "absent") {
      const absenceProofHash = absent.absenceProofHash;
      if (!hash(absenceProofHash)) {
        throw new DacsNodeSqliteError(
          "effect-result-malformed",
          "SQLite absence proof is malformed",
        );
      }
      return this.transitionCurrentEffect(retained, ({ current, now }) => {
        this.database.prepare(`
          UPDATE dacs_effects SET
            state = 'intent', active_mode = NULL, owner = NULL,
            lease_expires_at = NULL, retry_at = NULL, reason_code = NULL,
            absence_proof_hash = ?, updated_at = ?
          WHERE effect_kind = ? AND effect_id = ? AND generation = ?
        `).run(
          absenceProofHash,
          Math.max(current.updatedAt, now),
          retained.kind,
          retained.effectId,
          current.generation,
        );
        this.appendEffectHistory(
          retained.kind,
          retained.effectId,
          "reconciliation-absent",
          current.generation,
          now,
          { absenceProofHash },
        );
      });
    }
    const indeterminate = captureExactData(
      captured.result,
      ["disposition", "reasonCode"],
      ["retryAt"],
    );
    if (indeterminate?.disposition !== "indeterminate") {
      throw new DacsNodeSqliteError(
        "effect-result-malformed",
        "SQLite reconciliation result is malformed",
      );
    }
    if (!reasonCode(indeterminate.reasonCode) ||
        (indeterminate.retryAt !== undefined && !safeUint(indeterminate.retryAt))) {
      throw new DacsNodeSqliteError(
        "effect-result-malformed",
        "SQLite reconciliation result is malformed",
      );
    }
    return this.transitionCurrentEffect(retained, ({ current, now }) => {
      this.database.prepare(`
        UPDATE dacs_effects SET
          state = 'reconciliation-required', active_mode = NULL, owner = NULL,
          lease_expires_at = NULL, retry_at = ?, reason_code = ?, updated_at = ?
        WHERE effect_kind = ? AND effect_id = ? AND generation = ?
      `).run(
        indeterminate.retryAt ?? null,
        indeterminate.reasonCode,
        Math.max(current.updatedAt, now),
        retained.kind,
        retained.effectId,
        current.generation,
      );
      this.appendEffectHistory(
        retained.kind,
        retained.effectId,
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
    const captured = captureExactData(
      input,
      ["kind", "effectId", "bindingHash", "lease", "reasonCode"],
    );
    const lease = captured ? captureEffectLease(captured.lease) : null;
    if (!captured || !lease || !reasonCode(captured.reasonCode)) {
      throw new DacsNodeSqliteError(
        "effect-result-malformed",
        "SQLite operator-action result is malformed",
      );
    }
    const retained = Object.freeze({
      kind: captured.kind as DacsNodeSqliteEffectKind,
      effectId: captured.effectId as string,
      bindingHash: captured.bindingHash as string,
      lease,
      reasonCode: captured.reasonCode,
    });
    validateEffectIdentity(retained);
    return this.transitionCurrentEffect(retained, ({ current, now }) => {
      this.database.prepare(`
        UPDATE dacs_effects SET
          state = 'operator-action', active_mode = NULL, owner = NULL,
          lease_expires_at = NULL, retry_at = NULL, reason_code = ?, updated_at = ?
        WHERE effect_kind = ? AND effect_id = ? AND generation = ?
      `).run(
        retained.reasonCode,
        Math.max(current.updatedAt, now),
        retained.kind,
        retained.effectId,
        current.generation,
      );
      this.appendEffectHistory(
        retained.kind,
        retained.effectId,
        "operator-action-required",
        current.generation,
        now,
        { reasonCode: retained.reasonCode },
      );
    });
  }

  checkpoint(): void {
    this.assertOpen();
    const rows = this.database.pragma("wal_checkpoint(FULL)") as Array<{
      busy?: unknown;
      log?: unknown;
      checkpointed?: unknown;
    }>;
    const result = rows[0];
    if (!result || result.busy !== 0 || !safeUint(result.log) ||
        !safeUint(result.checkpointed) || result.checkpointed !== result.log) {
      throw new DacsNodeSqliteError(
        "database-checkpoint-busy",
        "SQLite WAL checkpoint could not complete while another connection retained it",
      );
    }
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

  private effectCheckpoint(
    kind: DacsNodeSqliteEffectKind,
    effectId: string,
    name: string,
    generation?: number,
  ): Readonly<DacsNodeSqliteEffectCheckpoint> | undefined {
    const rows = this.database.prepare(`
      SELECT generation, occurred_at, detail_json
      FROM dacs_effect_history
      WHERE effect_kind = ? AND effect_id = ? AND event = 'effect-checkpoint'
        ${generation === undefined ? "" : "AND generation = ?"}
      ORDER BY sequence DESC
    `).all(
      kind,
      effectId,
      ...(generation === undefined ? [] : [generation]),
    ) as Array<{
      generation: number;
      occurred_at: number;
      detail_json: string;
    }>;
    for (const row of rows) {
      const details = JSON.parse(row.detail_json) as Record<string, unknown>;
      if (details.name === name) {
        return {
          name,
          generation: row.generation,
          valueHash: details.valueHash as string,
          value: clone(details.value),
          recordedAt: row.occurred_at,
        };
      }
    }
    return undefined;
  }

  private validatedEffectRecord(row: EffectRow): DacsNodeSqliteEffectRecord {
    const record = effectFromRow(row);
    if (record.jobId !== undefined && !isCanonicalJobId(record.jobId)) {
      effectLogicalCorruption("SQLite effect has a non-canonical job identity");
    }
    verifyEffectReservation(this.database, record);
    verifyEffectHistory(this.database, record);
    return record;
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
      const current = this.validatedEffectRecord(row);
      if (current.bindingHash !== input.bindingHash) return { status: "stale" as const };
      const now = databaseTime(this.database);
      if (!exactLease(current, input.lease, now)) return { status: "stale" as const };
      transition({ current, now });
      return {
        status: "recorded" as const,
        record: clone(this.validatedEffectRecord(this.effectRow(input.kind, input.effectId)!)),
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
      const current = this.validatedEffectRecord(row);
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
        record: clone(this.validatedEffectRecord(this.effectRow(input.kind, input.effectId)!)),
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
    const detailJson = canonicalize(details);
    const detailHash = sha256Hex(detailJson);
    const previous = this.database.prepare(`
      SELECT entry_hash FROM dacs_effect_history
      WHERE effect_kind = ? AND effect_id = ?
      ORDER BY sequence DESC
      LIMIT 1
    `).get(kind, effectId) as { entry_hash: string } | undefined;
    const previousEntryHash = previous?.entry_hash ?? null;
    const entryHash = effectHistoryEntryHash({
      effectKind: kind,
      effectId,
      event,
      generation,
      occurredAt,
      detailHash,
      previousEntryHash,
    });
    this.database.prepare(`
      INSERT INTO dacs_effect_history
        (effect_kind, effect_id, event, generation, occurred_at, detail_hash,
          detail_json, previous_entry_hash, entry_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      kind,
      effectId,
      event,
      generation,
      occurredAt,
      detailHash,
      detailJson,
      previousEntryHash,
      entryHash,
    );
  }
}

interface SchemaObjectRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

interface MigrationRow {
  version: number;
  applied_at: number;
}

interface EffectHistoryValidationRow {
  sequence: number;
  effect_kind: string;
  effect_id: string;
  event: string;
  generation: number;
  occurred_at: number;
  detail_hash: string;
  detail_json: string;
  previous_entry_hash: string | null;
  entry_hash: string;
}

type SchemaFingerprint = Readonly<{
  objects: readonly SchemaObjectRow[];
  tables: Readonly<Record<string, unknown>>;
  indexes: Readonly<Record<string, unknown>>;
}>;

type DacsNodeSqliteSchemaVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7;

const expectedSchemaFingerprints = new Map<number, SchemaFingerprint>();

function schemaObjects(
  database: BetterSqlite3.Database,
  limit: number,
): SchemaObjectRow[] {
  const rows = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
    LIMIT ?
  `).all(limit) as SchemaObjectRow[];
  return rows.map((row) => ({
    ...row,
    sql: row.sql?.replace(/\s+/gu, " ").trim() ?? null,
  }));
}

function schemaDetails(
  database: BetterSqlite3.Database,
  objects: readonly SchemaObjectRow[],
): Omit<SchemaFingerprint, "objects"> {
  const tables: Record<string, unknown> = {};
  const indexes: Record<string, unknown> = {};
  for (const object of objects) {
    if (object.type === "table") {
      tables[object.name] = {
        definition: database.prepare(`
          SELECT name, type, ncol, wr, strict
          FROM pragma_table_list
          WHERE schema = 'main' AND name = ?
        `).all(object.name),
        columns: database.prepare(`
          SELECT cid, name, type, "notnull" AS not_null, dflt_value, pk, hidden
          FROM pragma_table_xinfo(?)
          ORDER BY cid
        `).all(object.name),
        foreignKeys: database.prepare(`
          SELECT id, seq, "table", "from", "to", on_update, on_delete, match
          FROM pragma_foreign_key_list(?)
          ORDER BY id, seq
        `).all(object.name),
        indexes: database.prepare(`
          SELECT name, "unique" AS is_unique, origin, partial
          FROM pragma_index_list(?)
          ORDER BY name
        `).all(object.name),
      };
    } else if (object.type === "index") {
      indexes[object.name] = database.prepare(`
        SELECT seqno, cid, name, desc, coll, key
        FROM pragma_index_xinfo(?)
        ORDER BY seqno
      `).all(object.name);
    }
  }
  return { tables, indexes };
}

function expectedSchemaFingerprint(version: DacsNodeSqliteSchemaVersion): SchemaFingerprint {
  const retained = expectedSchemaFingerprints.get(version);
  if (retained) return retained;
  const reference = new BetterSqlite3(":memory:");
  try {
    reference.exec(MIGRATION_1);
    if (version >= 2) reference.exec(MIGRATION_2);
    if (version >= 3) reference.exec(MIGRATION_3);
    if (version >= 4) {
      reference.exec(MIGRATION_4_PREPARE);
      reference.exec(MIGRATION_4_FINALIZE);
    }
    if (version >= 5) reference.exec(MIGRATION_5);
    if (version >= 6) reference.exec(MIGRATION_6);
    if (version >= 7) {
      reference.exec(MIGRATION_7_PREPARE);
      reference.exec(MIGRATION_7_COPY);
      reference.exec(MIGRATION_7_FINALIZE);
    }
    const objects = schemaObjects(reference, 64);
    const fingerprint = Object.freeze({
      objects,
      ...schemaDetails(reference, objects),
    });
    expectedSchemaFingerprints.set(version, fingerprint);
    return fingerprint;
  } finally {
    reference.close();
  }
}

function verifySchema(
  database: BetterSqlite3.Database,
  version: DacsNodeSqliteSchemaVersion,
): void {
  try {
    const expected = expectedSchemaFingerprint(version);
    const objects = schemaObjects(database, expected.objects.length + 1);
    if (canonicalize(objects) !== canonicalize(expected.objects) ||
        canonicalize(schemaDetails(database, objects)) !==
          canonicalize({ tables: expected.tables, indexes: expected.indexes })) {
      throw new DacsNodeSqliteError(
        "database-schema-invalid",
        "SQLite DACS schema does not exactly match the supported migration",
      );
    }
  } catch (error) {
    if (error instanceof DacsNodeSqliteError) throw error;
    throw new DacsNodeSqliteError(
      "database-schema-invalid",
      "SQLite DACS schema could not be validated",
    );
  }
}

function readDatabaseVersion(database: BetterSqlite3.Database): 0 | DacsNodeSqliteSchemaVersion {
  const applicationId = Number(database.pragma("application_id", { simple: true }));
  const version = Number(database.pragma("user_version", { simple: true }));
  if (!safeUint(version) || version > DACS_NODE_SQLITE_SCHEMA_VERSION) {
    throw new DacsNodeSqliteError(
      "database-schema-newer",
      "SQLite schema is newer than this runtime supports",
    );
  }
  if (version === 0) {
    const object = schemaObjects(database, 1);
    if (applicationId !== 0 || object.length !== 0) {
      throw new DacsNodeSqliteError(
        "database-unrecognized",
        "Only a genuinely empty version-zero file can omit the DACS application ID",
      );
    }
    return 0;
  }
  if (applicationId !== DACS_NODE_SQLITE_APPLICATION_ID) {
    throw new DacsNodeSqliteError(
      "database-application-mismatch",
      "Versioned SQLite file does not have the DACS application ID",
    );
  }
  return version as DacsNodeSqliteSchemaVersion;
}

function verifyMetadata(
  database: BetterSqlite3.Database,
  options: ReturnType<typeof validateOptions>,
  version: DacsNodeSqliteSchemaVersion,
): void {
  let rows: MetadataRow[];
  try {
    rows = database.prepare(`
      SELECT schema_version, mode, profile, role, authority, sdk_version,
        standard_revision, created_at
      FROM dacs_store_metadata
      WHERE singleton = 1
      LIMIT 2
    `).all() as MetadataRow[];
  } catch {
    throw new DacsNodeSqliteError(
      "database-metadata-corrupt",
      "SQLite DACS metadata could not be read",
    );
  }
  const row = rows[0];
  if (rows.length !== 1 || !row || row.schema_version !== version ||
      !safeUint(row.created_at) || !nonEmpty(row.sdk_version) ||
      !nonEmpty(row.standard_revision)) {
    throw new DacsNodeSqliteError(
      "database-metadata-corrupt",
      "SQLite DACS metadata is missing or corrupt",
    );
  }
  if (row.mode !== options.mode || row.profile !== options.profile ||
      row.role !== options.role || row.authority !== options.authority) {
    throw new DacsNodeSqliteError(
      "database-binding-mismatch",
      "SQLite database is bound to a different profile, actor, or supported revision",
    );
  }
  if (row.sdk_version !== options.sdkVersion ||
      row.standard_revision !== options.standardRevision) {
    if (version < DACS_NODE_SQLITE_SCHEMA_VERSION) {
      throw new DacsNodeSqliteError(
        "database-legacy-metadata-unsupported",
        "Legacy SQLite metadata does not prove the exact SDK and Standard revision required for migration",
      );
    }
    throw new DacsNodeSqliteError(
      "database-binding-mismatch",
      "SQLite database is bound to a different profile, actor, or supported revision",
    );
  }
}

function verifyMigrationHistory(
  database: BetterSqlite3.Database,
  version: DacsNodeSqliteSchemaVersion,
): void {
  let rows: MigrationRow[];
  try {
    rows = database.prepare(`
      SELECT version, applied_at
      FROM dacs_migrations
      ORDER BY version
      LIMIT 8
    `).all() as MigrationRow[];
  } catch {
    throw new DacsNodeSqliteError(
      "database-migration-history-invalid",
      "SQLite migration history could not be read",
    );
  }
  if (rows.length !== version || rows.some((row, index) =>
    row.version !== index + 1 || !safeUint(row.applied_at) ||
    (index > 0 && row.applied_at < rows[index - 1]!.applied_at))) {
    throw new DacsNodeSqliteError(
      "database-migration-history-invalid",
      "SQLite migration history is incomplete or inconsistent",
    );
  }
}

type EffectLifecyclePhase =
  | "intent"
  | "active-perform"
  | "active-reconcile"
  | "reconciliation-required"
  | "operator-action"
  | "completed";

function effectHistoryDetailHash(details: unknown): string {
  return sha256Hex(canonicalize(details));
}

function effectHistoryEntryHash(input: Readonly<{
  effectKind: string;
  effectId: string;
  event: string;
  generation: number;
  occurredAt: number;
  detailHash: string;
  previousEntryHash: string | null;
}>): string {
  return sha256Hex(canonicalize(input));
}

function effectLogicalCorruption(message: string): never {
  throw new DacsNodeSqliteError("database-logical-corruption", message);
}

function verifyEffectReservation(
  database: BetterSqlite3.Database,
  effect: Readonly<DacsNodeSqliteEffectRecord>,
): void {
  const expectedKind = reservationKindForEffect(effect.kind);
  const row = database.prepare(`
    SELECT * FROM dacs_reservations WHERE kind = ? AND identity = ?
  `).get(expectedKind, effect.effectId) as ReservationRow | undefined;
  if (!row) {
    effectLogicalCorruption("SQLite effect is missing its exact identity reservation");
  }
  const reservation = reservationFromRow(row);
  if (reservation.kind !== expectedKind || reservation.identity !== effect.effectId ||
      reservation.bindingHash !== effect.bindingHash ||
      reservation.payloadHash !== effect.inputHash || reservation.jobId !== effect.jobId) {
    effectLogicalCorruption("SQLite effect reservation differs from its effect binding");
  }
}

function verifyEffectHistory(
  database: BetterSqlite3.Database,
  effect: Readonly<DacsNodeSqliteEffectRecord>,
): void {
  let phase: EffectLifecyclePhase = "intent";
  let generation = 0;
  let last: EffectHistoryValidationRow | undefined;
  let latestAbsence: EffectHistoryValidationRow | undefined;
  let count = 0;
  let lastWasCheckpoint = false;
  const checkpoints = new Set<string>();

  for (const row of database.prepare(`
    SELECT sequence, effect_kind, effect_id, event, generation, occurred_at,
      detail_hash, detail_json, previous_entry_hash, entry_hash
    FROM dacs_effect_history
    WHERE effect_kind = ? AND effect_id = ?
    ORDER BY sequence
  `).iterate(effect.kind, effect.effectId) as IterableIterator<EffectHistoryValidationRow>) {
    count += 1;
    if (!safeUint(row.sequence) || row.sequence === 0 ||
        row.effect_kind !== effect.kind || row.effect_id !== effect.effectId ||
        !nonEmpty(row.event) || !safeUint(row.generation) ||
        !safeUint(row.occurred_at) || row.occurred_at > effect.updatedAt ||
        !hash(row.detail_hash) || !nonEmpty(row.detail_json) ||
        (row.previous_entry_hash !== null && !hash(row.previous_entry_hash)) ||
        !hash(row.entry_hash) || (last !== undefined &&
          (row.sequence <= last.sequence || row.occurred_at < last.occurred_at))) {
      effectLogicalCorruption("SQLite effect history contains a malformed event");
    }
    let details: unknown;
    try {
      details = JSON.parse(row.detail_json) as unknown;
      if (canonicalize(details) !== row.detail_json ||
          sha256Hex(row.detail_json) !== row.detail_hash) throw new Error();
    } catch {
      effectLogicalCorruption(
        "SQLite effect history detail is not canonical integrity-checked data",
      );
    }
    const expectedPrevious = last?.entry_hash ?? null;
    if (row.previous_entry_hash !== expectedPrevious ||
        row.entry_hash !== effectHistoryEntryHash({
          effectKind: row.effect_kind,
          effectId: row.effect_id,
          event: row.event,
          generation: row.generation,
          occurredAt: row.occurred_at,
          detailHash: row.detail_hash,
          previousEntryHash: row.previous_entry_hash,
        })) {
      effectLogicalCorruption("SQLite effect history chain is invalid");
    }

    if (count === 1) {
      if (row.event !== "intent-created" || row.generation !== 0 ||
          row.occurred_at !== effect.createdAt ||
          canonicalize(details) !== canonicalize(effectIdentityDetails(effect))) {
        effectLogicalCorruption("SQLite effect history has no integrity-bound origin event");
      }
      last = row;
      lastWasCheckpoint = false;
      continue;
    }

    lastWasCheckpoint = false;
    switch (row.event) {
      case "perform-claimed":
        if (phase !== "intent" || row.generation !== generation + 1 ||
            !exactDataKeys(details, ["owner", "expiresAt"]) ||
            !nonEmpty(details.owner) || !safeUint(details.expiresAt) ||
            details.expiresAt <= row.occurred_at) {
          effectLogicalCorruption("SQLite effect history has an invalid perform claim");
        }
        generation = row.generation;
        phase = "active-perform";
        break;
      case "effect-checkpoint": {
        if (phase !== "active-perform" || row.generation !== generation ||
            !exactDataKeys(details, ["name", "valueHash", "value"]) ||
            !reasonCode(details.name) || !hash(details.valueHash) ||
            details.valueHash !== effectHistoryDetailHash(details.value)) {
          effectLogicalCorruption("SQLite effect history has an invalid checkpoint");
        }
        const checkpointKey = `${generation}:${details.name}`;
        if (checkpoints.has(checkpointKey)) {
          effectLogicalCorruption("SQLite effect history repeats a checkpoint identity");
        }
        checkpoints.add(checkpointKey);
        lastWasCheckpoint = true;
        break;
      }
      case "reconcile-claimed":
        if ((phase !== "active-perform" && phase !== "active-reconcile" &&
            phase !== "reconciliation-required") || row.generation !== generation + 1 ||
            !exactDataKeys(details, ["owner", "expiresAt"]) ||
            !nonEmpty(details.owner) || !safeUint(details.expiresAt) ||
            details.expiresAt <= row.occurred_at) {
          effectLogicalCorruption("SQLite effect history has an invalid reconciliation claim");
        }
        generation = row.generation;
        phase = "active-reconcile";
        break;
      case "effect-completed":
        if ((phase !== "active-perform" && phase !== "active-reconcile") ||
            row.generation !== generation ||
            !exactDataKeys(details, ["resultHash"]) || !hash(details.resultHash)) {
          effectLogicalCorruption("SQLite effect history has an invalid completion");
        }
        phase = "completed";
        break;
      case "reconciliation-required":
        if ((phase !== "active-perform" && phase !== "active-reconcile") ||
            row.generation !== generation ||
            !exactDataKeys(details, ["reasonCode", "retryAt"]) ||
            !reasonCode(details.reasonCode) ||
            (details.retryAt !== null && !safeUint(details.retryAt))) {
          effectLogicalCorruption("SQLite effect history has an invalid ambiguous result");
        }
        phase = "reconciliation-required";
        break;
      case "reconciliation-performed":
        if (phase !== "active-reconcile" || row.generation !== generation ||
            !exactDataKeys(details, ["resultHash"]) || !hash(details.resultHash)) {
          effectLogicalCorruption("SQLite effect history has an invalid reconciled completion");
        }
        phase = "completed";
        break;
      case "reconciliation-absent":
        if (phase !== "active-reconcile" || row.generation !== generation ||
            !exactDataKeys(details, ["absenceProofHash"]) ||
            !hash(details.absenceProofHash)) {
          effectLogicalCorruption("SQLite effect history has an invalid absence result");
        }
        latestAbsence = row;
        phase = "intent";
        break;
      case "reconciliation-indeterminate":
        if (phase !== "active-reconcile" || row.generation !== generation ||
            !exactDataKeys(details, ["reasonCode", "retryAt"]) ||
            !reasonCode(details.reasonCode) ||
            (details.retryAt !== null && !safeUint(details.retryAt))) {
          effectLogicalCorruption("SQLite effect history has an invalid indeterminate result");
        }
        phase = "reconciliation-required";
        break;
      case "operator-action-required":
        if ((phase !== "active-perform" && phase !== "active-reconcile") ||
            row.generation !== generation ||
            !exactDataKeys(details, ["reasonCode"]) || !reasonCode(details.reasonCode)) {
          effectLogicalCorruption("SQLite effect history has an invalid operator transition");
        }
        phase = "operator-action";
        break;
      default:
        effectLogicalCorruption("SQLite effect history contains an unsupported event");
    }
    last = row;
  }

  if (!last || effect.generation !== generation) {
    effectLogicalCorruption("SQLite effect history is missing or has a generation gap");
  }
  const currentMatches =
    (phase === "intent" && effect.state === "intent") ||
    (phase === "active-perform" && effect.state === "active" &&
      effect.lease?.mode === "perform") ||
    (phase === "active-reconcile" && effect.state === "active" &&
      effect.lease?.mode === "reconcile") ||
    (phase === "reconciliation-required" && effect.state === "reconciliation-required") ||
    (phase === "operator-action" && effect.state === "operator-action") ||
    (phase === "completed" && effect.state === "completed");
  if (!currentMatches) {
    effectLogicalCorruption("SQLite effect state contradicts its complete history");
  }

  if (latestAbsence === undefined) {
    if (effect.absenceProofHash !== undefined) {
      effectLogicalCorruption("SQLite effect has an unrecorded absence proof");
    }
  } else if (effect.absenceProofHash === undefined ||
      latestAbsence.detail_hash !== effectHistoryDetailHash({
        absenceProofHash: effect.absenceProofHash,
      })) {
    effectLogicalCorruption("SQLite effect absence proof differs from its history");
  }

  let expectedFinalDetailHash: string;
  switch (phase) {
    case "intent":
      expectedFinalDetailHash = latestAbsence === undefined
        ? effectHistoryDetailHash(effectIdentityDetails(effect))
        : effectHistoryDetailHash({ absenceProofHash: effect.absenceProofHash });
      break;
    case "active-perform":
    case "active-reconcile":
      expectedFinalDetailHash = effectHistoryDetailHash({
        owner: effect.lease!.owner,
        expiresAt: effect.lease!.expiresAt,
      });
      break;
    case "reconciliation-required":
      expectedFinalDetailHash = effectHistoryDetailHash({
        reasonCode: effect.reasonCode,
        retryAt: effect.retryAt ?? null,
      });
      break;
    case "operator-action":
      expectedFinalDetailHash = effectHistoryDetailHash({ reasonCode: effect.reasonCode });
      break;
    case "completed":
      expectedFinalDetailHash = effectHistoryDetailHash({ resultHash: effect.resultHash });
      break;
  }
  if (!lastWasCheckpoint && last.detail_hash !== expectedFinalDetailHash) {
    effectLogicalCorruption("SQLite effect state differs from its final history event");
  }
}

function dacsHttpSqliteContext(
  database: BetterSqlite3.Database,
  authority: string,
  role: DacsNodeSqliteActorRole,
): DacsHttpSqliteContext {
  return {
    database,
    authority,
    role,
    systemTime: () => databaseTime(database),
    beginImmediate: <T>(operation: () => T) => beginImmediate(database, operation),
    readSnapshot: <T>(operation: () => T) => readSnapshot(database, operation),
    error: (reasonCode, message) => new DacsNodeSqliteError(reasonCode, message),
  };
}

function verifyLogicalRows(
  database: BetterSqlite3.Database,
  options: ReturnType<typeof validateOptions>,
  version: DacsNodeSqliteSchemaVersion,
): void {
  try {
    for (const row of database.prepare("SELECT * FROM dacs_reservations").iterate()) {
      const reservation = reservationFromRow(row as ReservationRow);
      if (reservation.jobId !== undefined && !isCanonicalJobId(reservation.jobId)) {
        throw new DacsNodeSqliteError(
          "database-logical-corruption",
          "SQLite reservation has a non-canonical job identity",
        );
      }
    }
    for (const row of database.prepare("SELECT * FROM dacs_effects").iterate()) {
      const effect = effectFromRow(row as EffectRow);
      if (effect.jobId !== undefined && !isCanonicalJobId(effect.jobId)) {
        throw new DacsNodeSqliteError(
          "database-logical-corruption",
          "SQLite effect has a non-canonical job identity",
        );
      }
      verifyEffectReservation(database, effect);
      verifyEffectHistory(database, effect);
    }
    if (version >= 2) {
      const allowedProfiles = options.mode === "offline"
        ? new Set<CoordinatorProfile>(["offline"])
        : new Set<CoordinatorProfile>(["live-x402", "live-pay-dem"]);
      for (const row of database.prepare(
        "SELECT * FROM dacs_coordinator_orders ORDER BY profile, role, job_id",
      ).iterate() as IterableIterator<CoordinatorRow | LegacyCoordinatorRow>) {
        if (!allowedProfiles.has(row.profile as CoordinatorProfile) ||
            row.role !== options.role ||
            (row.role !== "buyer" && row.role !== "seller")) {
          throw new DacsNodeSqliteError(
            "database-logical-corruption",
            "SQLite coordinator row is outside the bound actor profile",
          );
        }
        let authenticatedRecord: Readonly<CoordinatorRecord> | undefined;
        let projectionMatches = false;
        const rowProfile = row.profile as CoordinatorProfile;
        if (version >= 4) {
          const decoded = coordinatorFromRow(row as CoordinatorRow, rowProfile);
          if (decoded.status === "ok") {
            authenticatedRecord = decoded.record;
            projectionMatches = coordinatorTrackProjectionMatches(
              database,
              rowProfile,
              decoded.record,
            );
          }
        } else {
          const decoded = legacyCoordinatorFromRow(
            row as LegacyCoordinatorRow,
            rowProfile,
          );
          if (decoded.status === "ok") {
            authenticatedRecord = decoded.record;
            projectionMatches = version < 3 || legacyCoordinatorTrackProjectionMatches(
              database,
              rowProfile,
              decoded.legacyRecord,
            );
          }
        }
        if (!authenticatedRecord ||
            !coordinatorAuthorityMatches(authenticatedRecord, options.authority) ||
            !projectionMatches) {
          throw new DacsNodeSqliteError(
            "database-logical-corruption",
            "SQLite coordinator record or track projection is corrupt",
          );
        }
      }
      if (version >= 3) {
        const orphan = database.prepare(`
          SELECT 1 FROM dacs_coordinator_tracks AS tracks
          LEFT JOIN dacs_coordinator_orders AS orders
            ON orders.profile = tracks.profile AND orders.role = tracks.role
            AND orders.job_id = tracks.job_id
          WHERE orders.job_id IS NULL
          LIMIT 1
        `).get();
        if (orphan !== undefined) {
          throw new DacsNodeSqliteError(
            "database-logical-corruption",
            "SQLite coordinator track projection has no integrity-checked record",
          );
        }
      }
    }
    if (version >= 5) {
      for (const row of database.prepare(`
        SELECT * FROM dacs_payment_evidence_handshakes
        ORDER BY role, message_id
      `).iterate() as IterableIterator<PaymentEvidenceHandshakeRow>) {
        const decoded = paymentEvidenceFromRow(row);
        if (options.mode !== "live-demos" || row.role !== options.role ||
            (row.role !== "buyer" && row.role !== "seller") ||
            decoded.status !== "ok" ||
            !paymentEvidenceAuthorityMatches(decoded.record, options.authority) ||
            !paymentEvidenceReservationsMatch(database, decoded.record) ||
            !paymentEvidenceHistoryMatches(database, decoded.record)) {
          throw new DacsNodeSqliteError(
            decoded.status === "unsupported"
              ? "payment-evidence-version-unsupported"
              : "database-logical-corruption",
            decoded.status === "unsupported"
              ? `Payment-evidence store version ${decoded.version} is unsupported`
              : "SQLite payment-evidence record is corrupt or outside its actor authority",
          );
        }
      }
      const orphan = database.prepare(`
        SELECT 1 FROM dacs_payment_evidence_reservations AS reservations
        LEFT JOIN dacs_payment_evidence_handshakes AS records
          ON records.role = reservations.role
          AND records.message_id = reservations.message_id
        WHERE records.message_id IS NULL
        LIMIT 1
      `).get();
      if (orphan !== undefined) {
        throw new DacsNodeSqliteError(
          "database-logical-corruption",
          "SQLite payment-evidence reservation has no integrity-checked record",
        );
      }
      const orphanHistory = database.prepare(`
        SELECT 1 FROM dacs_payment_evidence_history AS history
        LEFT JOIN dacs_payment_evidence_handshakes AS records
          ON records.role = history.role AND records.message_id = history.message_id
        WHERE records.message_id IS NULL
        LIMIT 1
      `).get();
      if (orphanHistory !== undefined) {
        throw new DacsNodeSqliteError(
          "database-logical-corruption",
          "SQLite payment-evidence history has no integrity-checked record",
        );
      }
    }
    if (version >= 6) {
      verifyDacsHttpSqliteRows(dacsHttpSqliteContext(
        database,
        options.authority,
        options.role,
      ));
    }
  } catch (error) {
    if (error instanceof DacsNodeSqliteError) throw error;
    throw new DacsNodeSqliteError(
      "database-logical-corruption",
      "SQLite logical records could not be validated",
    );
  }
}

function verifyVersionedDatabase(
  database: BetterSqlite3.Database,
  options: ReturnType<typeof validateOptions>,
  version: DacsNodeSqliteSchemaVersion,
): void {
  readSnapshot(database, () => {
    if (readDatabaseVersion(database) !== version) {
      throw new DacsNodeSqliteError(
        "database-version-raced",
        "SQLite database version changed during admission",
      );
    }
    const quick = database.pragma("quick_check(1)", { simple: true });
    if (quick !== "ok") {
      throw new DacsNodeSqliteError(
        "database-integrity-failed",
        "SQLite integrity check failed",
      );
    }
    verifySchema(database, version);
    verifyMetadata(database, options, version);
    verifyMigrationHistory(database, version);
    const foreignKeyViolation = database.prepare(`
      SELECT 1 FROM pragma_foreign_key_check LIMIT 1
    `).get();
    if (foreignKeyViolation !== undefined) {
      throw new DacsNodeSqliteError(
        "database-foreign-key-invalid",
        "SQLite foreign-key validation failed",
      );
    }
    verifyLogicalRows(database, options, version);
  });
}

function configureAdmissionConnection(
  database: BetterSqlite3.Database,
  options: ReturnType<typeof validateOptions>,
): void {
  database.pragma(`busy_timeout = ${options.busyTimeoutMs}`);
  database.pragma("foreign_keys = ON");
  database.pragma("trusted_schema = OFF");
  database.pragma("temp_store = MEMORY");
}

function validateExistingReadOnly(
  databasePath: string,
  options: ReturnType<typeof validateOptions>,
): 0 | DacsNodeSqliteSchemaVersion {
  let database: BetterSqlite3.Database | undefined;
  try {
    database = new BetterSqlite3(databasePath, {
      readonly: true,
      fileMustExist: true,
      timeout: options.busyTimeoutMs,
    });
    configureAdmissionConnection(database, options);
    const version = readDatabaseVersion(database);
    if (version !== 0) verifyVersionedDatabase(database, options, version);
    return version;
  } catch (error) {
    if (error instanceof DacsNodeSqliteError) throw error;
    throw new DacsNodeSqliteError(
      "database-admission-failed",
      "Existing SQLite database could not be safely admitted",
    );
  } finally {
    database?.close();
  }
}

function initializeEmptyDatabase(
  database: BetterSqlite3.Database,
  options: ReturnType<typeof validateOptions>,
): void {
  beginImmediate(database, () => {
    if (readDatabaseVersion(database) !== 0) {
      throw new DacsNodeSqliteError(
        "database-version-raced",
        "SQLite database changed before initialization",
      );
    }
    const now = databaseTime(database);
    database.exec(MIGRATION_1);
    database.exec(MIGRATION_2);
    database.exec(MIGRATION_3);
    database.exec(MIGRATION_4_PREPARE);
    migrateCoordinatorV4Rows(database, options);
    database.exec(MIGRATION_4_FINALIZE);
    database.exec(MIGRATION_5);
    database.exec(MIGRATION_6);
    applyMigration7(database);
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
      INSERT INTO dacs_migrations (version, applied_at)
      VALUES (1, ?), (2, ?), (3, ?), (4, ?), (5, ?), (6, ?), (7, ?)
    `).run(now, now, now, now, now, now, now);
    database.pragma(`application_id = ${DACS_NODE_SQLITE_APPLICATION_ID}`);
    database.pragma(`user_version = ${DACS_NODE_SQLITE_SCHEMA_VERSION}`);
    verifyVersionedDatabase(database, options, 7);
  });
}

function removeGeneratedBackup(backupPath: string): void {
  for (const path of [backupPath, `${backupPath}-wal`, `${backupPath}-shm`]) {
    if (existsSync(path)) unlinkSync(path);
  }
}

async function createValidatedBackup(
  database: BetterSqlite3.Database,
  options: ReturnType<typeof validateOptions>,
  version: 1 | 2 | 3 | 4 | 5 | 6,
): Promise<Readonly<{ backupPath: string; sourceDataVersion: number }>> {
  const backupPath = `${options.databasePath}.backup-v${version}-${randomUUID()}.sqlite`;
  try {
    const sourceDataVersion = Number(database.pragma("data_version", { simple: true }));
    if (!safeUint(sourceDataVersion)) {
      throw new DacsNodeSqliteError(
        "database-backup-failed",
        "SQLite source data version is invalid",
      );
    }
    await database.backup(backupPath);
    const backup = new BetterSqlite3(backupPath, { fileMustExist: true });
    try {
      configureAdmissionConnection(backup, options);
      verifyVersionedDatabase(backup, options, version);
      if (backup.pragma("journal_mode = DELETE", { simple: true }) !== "delete") {
        throw new DacsNodeSqliteError(
          "database-backup-failed",
          `SQLite v${version} backup could not be made self-contained`,
        );
      }
    } finally {
      backup.close();
    }
    chmodSync(backupPath, 0o600);
    return { backupPath, sourceDataVersion };
  } catch (error) {
    removeGeneratedBackup(backupPath);
    if (error instanceof DacsNodeSqliteError) throw error;
    throw new DacsNodeSqliteError(
      "database-backup-failed",
      `SQLite v${version} backup could not be created and validated`,
    );
  }
}

function migrateV1Database(
  database: BetterSqlite3.Database,
  options: ReturnType<typeof validateOptions>,
  sourceDataVersion: number,
): void {
  beginImmediate(database, () => {
    if (Number(database.pragma("data_version", { simple: true })) !== sourceDataVersion) {
      throw new DacsNodeSqliteError(
        "database-version-raced",
        "SQLite v1 data changed while its migration backup was created",
      );
    }
    verifyVersionedDatabase(database, options, 1);
    const previous = database.prepare(`
      SELECT applied_at FROM dacs_migrations WHERE version = 1
    `).get() as { applied_at: number };
    const now = Math.max(databaseTime(database), previous.applied_at);
    database.exec(MIGRATION_2);
    database.exec(MIGRATION_3);
    database.exec(MIGRATION_4_PREPARE);
    migrateCoordinatorV4Rows(database, options);
    database.exec(MIGRATION_4_FINALIZE);
    database.exec(MIGRATION_5);
    database.exec(MIGRATION_6);
    applyMigration7(database);
    database.prepare(`
      UPDATE dacs_store_metadata SET schema_version = ? WHERE singleton = 1
    `).run(DACS_NODE_SQLITE_SCHEMA_VERSION);
    database.prepare(`
      INSERT INTO dacs_migrations (version, applied_at)
      VALUES (2, ?), (3, ?), (4, ?), (5, ?), (6, ?), (7, ?)
    `).run(now, now, now, now, now, now);
    database.pragma(`user_version = ${DACS_NODE_SQLITE_SCHEMA_VERSION}`);
    verifyVersionedDatabase(database, options, 7);
  });
}

function migrateV2Database(
  database: BetterSqlite3.Database,
  options: ReturnType<typeof validateOptions>,
  sourceDataVersion: number,
): void {
  beginImmediate(database, () => {
    if (Number(database.pragma("data_version", { simple: true })) !== sourceDataVersion) {
      throw new DacsNodeSqliteError(
        "database-version-raced",
        "SQLite v2 data changed while its migration backup was created",
      );
    }
    verifyVersionedDatabase(database, options, 2);
    const previous = database.prepare(`
      SELECT applied_at FROM dacs_migrations WHERE version = 2
    `).get() as { applied_at: number };
    const now = Math.max(databaseTime(database), previous.applied_at);
    database.exec(MIGRATION_3);
    database.exec(MIGRATION_4_PREPARE);
    migrateCoordinatorV4Rows(database, options);
    database.exec(MIGRATION_4_FINALIZE);
    database.exec(MIGRATION_5);
    database.exec(MIGRATION_6);
    applyMigration7(database);
    database.prepare(`
      UPDATE dacs_store_metadata SET schema_version = ? WHERE singleton = 1
    `).run(DACS_NODE_SQLITE_SCHEMA_VERSION);
    database.prepare(`
      INSERT INTO dacs_migrations (version, applied_at)
      VALUES (3, ?), (4, ?), (5, ?), (6, ?), (7, ?)
    `).run(now, now, now, now, now);
    database.pragma(`user_version = ${DACS_NODE_SQLITE_SCHEMA_VERSION}`);
    verifyVersionedDatabase(database, options, 7);
  });
}

function migrateV3Database(
  database: BetterSqlite3.Database,
  options: ReturnType<typeof validateOptions>,
  sourceDataVersion: number,
): void {
  beginImmediate(database, () => {
    if (Number(database.pragma("data_version", { simple: true })) !== sourceDataVersion) {
      throw new DacsNodeSqliteError(
        "database-version-raced",
        "SQLite v3 data changed while its migration backup was created",
      );
    }
    verifyVersionedDatabase(database, options, 3);
    const previous = database.prepare(`
      SELECT applied_at FROM dacs_migrations WHERE version = 3
    `).get() as { applied_at: number };
    const now = Math.max(databaseTime(database), previous.applied_at);
    database.exec(MIGRATION_4_PREPARE);
    migrateCoordinatorV4Rows(database, options);
    database.exec(MIGRATION_4_FINALIZE);
    database.exec(MIGRATION_5);
    database.exec(MIGRATION_6);
    applyMigration7(database);
    database.prepare(`
      UPDATE dacs_store_metadata SET schema_version = ? WHERE singleton = 1
    `).run(DACS_NODE_SQLITE_SCHEMA_VERSION);
    database.prepare(`
      INSERT INTO dacs_migrations (version, applied_at)
      VALUES (4, ?), (5, ?), (6, ?), (7, ?)
    `).run(now, now, now, now);
    database.pragma(`user_version = ${DACS_NODE_SQLITE_SCHEMA_VERSION}`);
    verifyVersionedDatabase(database, options, 7);
  });
}

function migrateV4Database(
  database: BetterSqlite3.Database,
  options: ReturnType<typeof validateOptions>,
  sourceDataVersion: number,
): void {
  beginImmediate(database, () => {
    if (Number(database.pragma("data_version", { simple: true })) !== sourceDataVersion) {
      throw new DacsNodeSqliteError(
        "database-version-raced",
        "SQLite v4 data changed while its migration backup was created",
      );
    }
    verifyVersionedDatabase(database, options, 4);
    const previous = database.prepare(`
      SELECT applied_at FROM dacs_migrations WHERE version = 4
    `).get() as { applied_at: number };
    const now = Math.max(databaseTime(database), previous.applied_at);
    database.exec(MIGRATION_5);
    database.exec(MIGRATION_6);
    applyMigration7(database);
    database.prepare(`
      UPDATE dacs_store_metadata SET schema_version = ? WHERE singleton = 1
    `).run(DACS_NODE_SQLITE_SCHEMA_VERSION);
    database.prepare(`
      INSERT INTO dacs_migrations (version, applied_at)
      VALUES (5, ?), (6, ?), (7, ?)
    `).run(now, now, now);
    database.pragma(`user_version = ${DACS_NODE_SQLITE_SCHEMA_VERSION}`);
    verifyVersionedDatabase(database, options, 7);
  });
}

function migrateV5Database(
  database: BetterSqlite3.Database,
  options: ReturnType<typeof validateOptions>,
  sourceDataVersion: number,
): void {
  beginImmediate(database, () => {
    if (Number(database.pragma("data_version", { simple: true })) !== sourceDataVersion) {
      throw new DacsNodeSqliteError(
        "database-version-raced",
        "SQLite v5 data changed while its migration backup was created",
      );
    }
    verifyVersionedDatabase(database, options, 5);
    const previous = database.prepare(`
      SELECT applied_at FROM dacs_migrations WHERE version = 5
    `).get() as { applied_at: number };
    const now = Math.max(databaseTime(database), previous.applied_at);
    database.exec(MIGRATION_6);
    applyMigration7(database);
    database.prepare(`
      UPDATE dacs_store_metadata SET schema_version = ? WHERE singleton = 1
    `).run(DACS_NODE_SQLITE_SCHEMA_VERSION);
    database.prepare(`
      INSERT INTO dacs_migrations (version, applied_at) VALUES (6, ?), (7, ?)
    `).run(now, now);
    database.pragma(`user_version = ${DACS_NODE_SQLITE_SCHEMA_VERSION}`);
    verifyVersionedDatabase(database, options, 7);
  });
}

function migrateV6Database(
  database: BetterSqlite3.Database,
  options: ReturnType<typeof validateOptions>,
  sourceDataVersion: number,
): void {
  beginImmediate(database, () => {
    if (Number(database.pragma("data_version", { simple: true })) !== sourceDataVersion) {
      throw new DacsNodeSqliteError(
        "database-version-raced",
        "SQLite v6 data changed while its migration backup was created",
      );
    }
    verifyVersionedDatabase(database, options, 6);
    const previous = database.prepare(`
      SELECT applied_at FROM dacs_migrations WHERE version = 6
    `).get() as { applied_at: number };
    const now = Math.max(databaseTime(database), previous.applied_at);
    applyMigration7(database);
    database.prepare(`
      UPDATE dacs_store_metadata SET schema_version = ? WHERE singleton = 1
    `).run(DACS_NODE_SQLITE_SCHEMA_VERSION);
    database.prepare(`
      INSERT INTO dacs_migrations (version, applied_at) VALUES (7, ?)
    `).run(now);
    database.pragma(`user_version = ${DACS_NODE_SQLITE_SCHEMA_VERSION}`);
    verifyVersionedDatabase(database, options, 7);
  });
}

/**
 * Validate an existing actor database without creating, migrating or writing
 * it. This is the pre-start doctor seam; initialization and migration remain
 * explicit lifecycle actions owned by the generated supervisor.
 */
export function inspectExistingDacsNodeSqliteDatabaseV1(
  rawOptions: Readonly<DacsNodeSqliteDatabaseOptions>,
): Readonly<DacsNodeSqliteReadOnlyInspection> {
  const options = validateOptions(rawOptions);
  const location = inspectDacsNodeSqliteLocation(options.databasePath);
  if (location.status === "blocked") {
    return Object.freeze({
      status: "blocked" as const,
      reasonCode: location.reasonCode,
      databasePath: location.databasePath,
    });
  }
  if (!existsSync(location.databasePath)) {
    return Object.freeze({
      status: "blocked" as const,
      reasonCode: "database-missing",
      databasePath: location.databasePath,
    });
  }
  try {
    const version = validateExistingReadOnly(location.databasePath, options);
    if (version === 0) {
      return Object.freeze({
        status: "fail" as const,
        reasonCode: "database-uninitialized",
        databasePath: location.databasePath,
      });
    }
    if (version < DACS_NODE_SQLITE_SCHEMA_VERSION) {
      return Object.freeze({
        status: "blocked" as const,
        reasonCode: "database-migration-required",
        databasePath: location.databasePath,
      });
    }
    const database = new BetterSqlite3(location.databasePath, {
      readonly: true,
      fileMustExist: true,
      timeout: options.busyTimeoutMs,
    });
    try {
      configureAdmissionConnection(database, options);
      const journal = database.pragma("journal_mode", { simple: true });
      if (journal !== "wal") {
        return Object.freeze({
          status: "fail" as const,
          reasonCode: "database-durability-mismatch",
          databasePath: location.databasePath,
        });
      }
    } finally {
      database.close();
    }
    return Object.freeze({
      status: "pass" as const,
      diagnostics: Object.freeze({
        databasePath: location.databasePath,
        schemaVersion: version,
        applicationId: DACS_NODE_SQLITE_APPLICATION_ID,
        mode: options.mode,
        profile: options.profile,
        role: options.role,
        authority: options.authority,
        sdkVersion: options.sdkVersion,
        standardRevision: options.standardRevision,
        journalMode: "wal" as const,
        synchronous: "full" as const,
        quickCheck: "ok" as const,
        ...(location.filesystemType === undefined
          ? {} : { filesystemType: location.filesystemType }),
        filesystemMagic: location.filesystemMagic,
      }),
    });
  } catch (error) {
    return Object.freeze({
      status: "fail" as const,
      reasonCode: error instanceof DacsNodeSqliteError
        ? error.reasonCode : "database-admission-failed",
      databasePath: location.databasePath,
    });
  }
}

/**
 * Authenticate the current store and project upgrade blockers through a
 * read-only SQLite handle. It never initializes, migrates, checkpoints or
 * backs up the database; those remain explicit upgrade-time operations.
 */
export function inspectDacsNodeSqliteUpgradeSafetyV1(
  rawOptions: Readonly<DacsNodeSqliteDatabaseOptions>,
): Readonly<DacsNodeSqliteUpgradeInspectionV1> {
  const options = validateOptions(rawOptions);
  const admitted = inspectExistingDacsNodeSqliteDatabaseV1(options);
  if (admitted.status !== "pass") return admitted;
  let database: BetterSqlite3.Database | undefined;
  try {
    database = new BetterSqlite3(admitted.diagnostics.databasePath, {
      readonly: true,
      fileMustExist: true,
      timeout: options.busyTimeoutMs,
    });
    configureAdmissionConnection(database, options);
    verifyVersionedDatabase(database, options, DACS_NODE_SQLITE_SCHEMA_VERSION);
    return Object.freeze({
      status: "pass" as const,
      diagnostics: admitted.diagnostics,
      safety: readUpgradeSafety(database),
    });
  } catch (error) {
    return Object.freeze({
      status: "fail" as const,
      reasonCode: error instanceof DacsNodeSqliteError
        ? error.reasonCode : "database-upgrade-safety-unavailable",
      databasePath: admitted.diagnostics.databasePath,
    });
  } finally {
    database?.close();
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
  const existedBeforeOpen = existsSync(location.databasePath);
  if (existsSync(location.databasePath) && lstatSync(location.databasePath).isSymbolicLink()) {
    throw new DacsNodeSqliteError(
      "database-path-symlink",
      "SQLite database path must not be a symbolic link",
    );
  }
  const admittedVersion = existedBeforeOpen
    ? validateExistingReadOnly(location.databasePath, options)
    : 0;
  mkdirSync(dirname(location.databasePath), { recursive: true, mode: 0o700 });
  let database: BetterSqlite3.Database;
  try {
    database = new BetterSqlite3(location.databasePath, {
      timeout: options.busyTimeoutMs,
    });
  } catch {
    throw new DacsNodeSqliteError(
      "database-open-failed",
      "SQLite database could not be opened",
    );
  }
  try {
    configureAdmissionConnection(database, options);
    database.pragma("synchronous = FULL");
    if (!existedBeforeOpen && readDatabaseVersion(database) === 0) {
      chmodSync(location.databasePath, 0o600);
    }
    if (admittedVersion === 0) {
      initializeEmptyDatabase(database, options);
    } else if (admittedVersion === 1) {
      verifyVersionedDatabase(database, options, 1);
      const backup = await createValidatedBackup(database, options, 1);
      try {
        migrateV1Database(database, options, backup.sourceDataVersion);
      } catch (error) {
        if (error instanceof DacsNodeSqliteError &&
            error.reasonCode === "database-version-raced") {
          removeGeneratedBackup(backup.backupPath);
        }
        throw error;
      }
    } else if (admittedVersion === 2) {
      verifyVersionedDatabase(database, options, 2);
      const backup = await createValidatedBackup(database, options, 2);
      try {
        migrateV2Database(database, options, backup.sourceDataVersion);
      } catch (error) {
        if (error instanceof DacsNodeSqliteError &&
            error.reasonCode === "database-version-raced") {
          removeGeneratedBackup(backup.backupPath);
        }
        throw error;
      }
    } else if (admittedVersion === 3) {
      verifyVersionedDatabase(database, options, 3);
      const backup = await createValidatedBackup(database, options, 3);
      try {
        migrateV3Database(database, options, backup.sourceDataVersion);
      } catch (error) {
        if (error instanceof DacsNodeSqliteError &&
            error.reasonCode === "database-version-raced") {
          removeGeneratedBackup(backup.backupPath);
        }
        throw error;
      }
    } else if (admittedVersion === 4) {
      verifyVersionedDatabase(database, options, 4);
      const backup = await createValidatedBackup(database, options, 4);
      try {
        migrateV4Database(database, options, backup.sourceDataVersion);
      } catch (error) {
        if (error instanceof DacsNodeSqliteError &&
            error.reasonCode === "database-version-raced") {
          removeGeneratedBackup(backup.backupPath);
        }
        throw error;
      }
    } else if (admittedVersion === 5) {
      verifyVersionedDatabase(database, options, 5);
      const backup = await createValidatedBackup(database, options, 5);
      try {
        migrateV5Database(database, options, backup.sourceDataVersion);
      } catch (error) {
        if (error instanceof DacsNodeSqliteError &&
            error.reasonCode === "database-version-raced") {
          removeGeneratedBackup(backup.backupPath);
        }
        throw error;
      }
    } else if (admittedVersion === 6) {
      verifyVersionedDatabase(database, options, 6);
      const backup = await createValidatedBackup(database, options, 6);
      try {
        migrateV6Database(database, options, backup.sourceDataVersion);
      } catch (error) {
        if (error instanceof DacsNodeSqliteError &&
            error.reasonCode === "database-version-raced") {
          removeGeneratedBackup(backup.backupPath);
        }
        throw error;
      }
    } else {
      beginImmediate(database, () => verifyVersionedDatabase(database, options, 7));
    }
    chmodSync(location.databasePath, 0o600);
    const journalMode = database.pragma("journal_mode = WAL", { simple: true });
    database.pragma("synchronous = FULL");
    if (journalMode !== "wal") {
      throw new DacsNodeSqliteError(
        "database-wal-unavailable",
        "SQLite WAL journal mode is unavailable",
      );
    }
    verifyVersionedDatabase(database, options, 7);
    return new DacsNodeSqliteDatabaseImpl(database, options, location);
  } catch (error) {
    database.close();
    if (error instanceof DacsNodeSqliteError) throw error;
    throw new DacsNodeSqliteError(
      "database-admission-failed",
      "SQLite database admission or migration failed",
    );
  }
}
