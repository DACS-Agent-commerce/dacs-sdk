import { types as nodeTypes } from "node:util";

import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  parseCanonicalClaimReference,
  sameCanonicalClaimIdentity,
} from "@kynesyslabs/dacs/identity";
import { isCanonicalJobId } from "@kynesyslabs/dacs/negotiate";
import type BetterSqlite3 from "better-sqlite3";

import {
  DACS_HTTP_DEFAULT_EXPIRY_BATCH_SIZE,
  DACS_HTTP_DEFAULT_GLOBAL_MAX_BYTES,
  DACS_HTTP_DEFAULT_GLOBAL_MAX_ROWS,
  DACS_HTTP_DEFAULT_JOB_MAX_BYTES,
  DACS_HTTP_DEFAULT_JOB_MAX_ROWS,
  DACS_HTTP_DEFAULT_MAX_REVISIONS_PER_MESSAGE,
  DACS_HTTP_DEFAULT_MESSAGE_TYPE_MAX_BYTES,
  DACS_HTTP_DEFAULT_MESSAGE_TYPE_MAX_ROWS,
  DACS_HTTP_DEFAULT_PEER_MAX_BYTES,
  DACS_HTTP_DEFAULT_PEER_MAX_ROWS,
  DACS_HTTP_DEFAULT_PURGE_BATCH_SIZE,
  DACS_HTTP_INITIAL_RETRY_DELAY_MS,
  DACS_HTTP_MAXIMUM_RETRY_DELAY_MS,
  DACS_HTTP_MINIMUM_RETENTION_MS,
  type DacsHttpInboxItemV1,
  type DacsHttpInboxReservationV1,
  type DacsHttpInboxStoreV1,
  type DacsHttpOutboxItemV1,
  type DacsHttpOutboxLeaseV1,
  type DacsHttpOutboxRetryJitterV1,
  type DacsHttpOutboxStoreV1,
  type DacsHttpStoreDiagnosticsV1,
  type DacsHttpStoreLimitsV1,
  type DacsHttpStorePurgeResultV1,
  type DacsHttpStoreQuotaV1,
  type DacsHttpTransportStoreOptionsV1,
} from "./transport/contracts.js";
import {
  DACS_HTTP_MAX_FUTURE_SKEW_MS,
  verifyDacsHttpAcknowledgementBindingV1,
  verifyDacsHttpEnvelopeSelfSignatureV1,
  type DacsHttpAuthenticatedEnvelopeV1,
  type DacsHttpEnvelopeV1,
} from "./transport/envelope.js";

const HASH_RE = /^[0-9a-f]{64}$/;
const REASON_CODE_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const DEMOS_AGENT_IDENTIFIER_RE = /^demos:agent:[0-9a-f]{64}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const MAX_PAGE_SIZE = 1_000;
const MAX_LEASE_OWNER_BYTES = 256;

export interface DacsHttpSqliteContext {
  database: BetterSqlite3.Database;
  authority: string;
  role: "buyer" | "seller" | "verifier";
  systemTime(): number;
  beginImmediate<T>(operation: () => T): T;
  readSnapshot<T>(operation: () => T): T;
  error(reasonCode: string, message: string): Error;
}

function requiredSenderRole(
  envelope: Readonly<DacsHttpEnvelopeV1>,
): "buyer" | "seller" | undefined {
  switch (envelope.type) {
    case "agreement-proposal":
    case "payment-evidence-completion":
    case "bundle-signature-response":
      return "buyer";
    case "agreement-response":
    case "payment-evidence-request":
    case "bundle-signature-request":
      return "seller";
    case "acknowledgement":
      return undefined;
  }
}

interface InboxRow {
  sender: string;
  audience: string;
  envelope_id: string;
  job_id: string;
  state: string;
  authentication_hash: string;
  identity_evidence_hash: string;
  payload_hash: string;
  nonce: string;
  disposition: string | null;
  reason_code: string | null;
  received_at: number;
  retain_until: number;
  revision: number;
  record_hash: string;
  record_json: string;
  updated_at: number;
  semantic_key: string | null;
}

interface OutboxRow {
  envelope_id: string;
  envelope_hash: string;
  job_id: string;
  sender: string;
  audience: string;
  payload_hash: string;
  state: string;
  generation: number;
  attempts: number;
  owner: string | null;
  lease_expires_at: number | null;
  next_attempt_at: number;
  acknowledgement_hash: string | null;
  reason_code: string | null;
  retain_until: number;
  revision: number;
  record_hash: string;
  record_json: string;
  created_at: number;
  updated_at: number;
  semantic_key: string | null;
}

interface HistoryRow {
  sequence: number;
  revision: number;
  occurred_at: number;
  record_hash: string;
  record_json: string;
  previous_entry_hash: string | null;
  entry_hash: string;
}

type StoredInbox = Omit<DacsHttpInboxItemV1, "recordHash">;
type StoredOutbox = Omit<DacsHttpOutboxItemV1, "recordHash">;

type UsageDimension = "global" | "peer" | "job" | "message-type";

interface PolicyRow {
  singleton: number;
  policy_hash: string | null;
  policy_json: string | null;
  bound_at: number | null;
}

interface UsageRow {
  dimension: UsageDimension;
  dimension_key: string;
  retained_rows: number;
  retained_bytes: number;
  reserved_rows: number;
  reserved_bytes: number;
}

interface LifecycleRow {
  singleton: number;
  rejected_admissions: number;
  last_rejection_reason: string | null;
  last_rejection_dimension: string | null;
  last_rejection_key: string | null;
  last_rejection_at: number | null;
  purged_records: number;
  purged_rows: number;
  purged_bytes: number;
  last_purge_at: number | null;
  inbox_purge_cursor: string;
  outbox_purge_cursor: string;
  outbox_expiry_cursor: string;
}

const DEFAULT_LIMITS: Readonly<DacsHttpStoreLimitsV1> = Object.freeze({
  global: Object.freeze({
    maxRows: DACS_HTTP_DEFAULT_GLOBAL_MAX_ROWS,
    maxBytes: DACS_HTTP_DEFAULT_GLOBAL_MAX_BYTES,
  }),
  perPeer: Object.freeze({
    maxRows: DACS_HTTP_DEFAULT_PEER_MAX_ROWS,
    maxBytes: DACS_HTTP_DEFAULT_PEER_MAX_BYTES,
  }),
  perJob: Object.freeze({
    maxRows: DACS_HTTP_DEFAULT_JOB_MAX_ROWS,
    maxBytes: DACS_HTTP_DEFAULT_JOB_MAX_BYTES,
  }),
  perMessageType: Object.freeze({
    maxRows: DACS_HTTP_DEFAULT_MESSAGE_TYPE_MAX_ROWS,
    maxBytes: DACS_HTTP_DEFAULT_MESSAGE_TYPE_MAX_BYTES,
  }),
  maxRevisionsPerMessage: DACS_HTTP_DEFAULT_MAX_REVISIONS_PER_MESSAGE,
  expiryBatchSize: DACS_HTTP_DEFAULT_EXPIRY_BATCH_SIZE,
  purgeBatchSize: DACS_HTTP_DEFAULT_PURGE_BATCH_SIZE,
});

type BoundOptions = Readonly<{
  retentionMs: number;
  jitter: DacsHttpOutboxRetryJitterV1;
  limits: Readonly<DacsHttpStoreLimitsV1>;
}>;

class HttpQuotaFailure extends Error {
  constructor(
    readonly dimension: UsageDimension | "revision" | "disk",
    readonly dimensionKey: string,
    readonly reasonCode: string,
  ) {
    super(reasonCode);
  }
}

function safeUint(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hash(value: unknown): value is string {
  return typeof value === "string" && HASH_RE.test(value);
}

function reasonCode(value: unknown): value is string {
  return typeof value === "string" && REASON_CODE_RE.test(value);
}

function demosAgentClaimReference(value: unknown): value is string {
  const parsed = parseCanonicalClaimReference(value);
  return parsed !== null && parsed.identity.scheme === "did" &&
    DEMOS_AGENT_IDENTIFIER_RE.test(parsed.identity.identifier);
}

function sameDemosAgentIdentity(left: unknown, right: unknown): boolean {
  return demosAgentClaimReference(left) && demosAgentClaimReference(right) &&
    sameCanonicalClaimIdentity(left, right);
}

function principalQuotaKey(value: string): string {
  const parsed = parseCanonicalClaimReference(value);
  if (parsed === null) return value;
  return `${parsed.identity.scheme}:${parsed.identity.identifier}`;
}

function semanticKey(envelope: Readonly<DacsHttpEnvelopeV1>): string {
  return sha256Hex(canonicalize({
    domain: "dacs-http-semantic-idempotency:v1",
    type: envelope.type,
    jobId: envelope.jobId,
    sender: envelope.sender,
    audience: envelope.audience,
    payloadHash: envelope.payloadHash,
  }));
}

function usageDimensions(
  direction: "inbox" | "outbox",
  envelope: Readonly<DacsHttpEnvelopeV1>,
): readonly Readonly<{ dimension: UsageDimension; key: string }>[] {
  return Object.freeze([
    Object.freeze({ dimension: "global" as const, key: "all" }),
    Object.freeze({
      dimension: "peer" as const,
      key: principalQuotaKey(direction === "inbox" ? envelope.sender : envelope.audience),
    }),
    Object.freeze({ dimension: "job" as const, key: envelope.jobId }),
    Object.freeze({ dimension: "message-type" as const, key: envelope.type }),
  ]);
}

function quotaFor(
  limits: Readonly<DacsHttpStoreLimitsV1>,
  dimension: UsageDimension,
): Readonly<DacsHttpStoreQuotaV1> {
  switch (dimension) {
    case "global": return limits.global;
    case "peer": return limits.perPeer;
    case "job": return limits.perJob;
    case "message-type": return limits.perMessageType;
  }
}

function canonicalBytes(json: string): number {
  return Buffer.byteLength(json, "utf8");
}

function adjustUsage(
  context: DacsHttpSqliteContext,
  limits: Readonly<DacsHttpStoreLimitsV1> | undefined,
  direction: "inbox" | "outbox",
  envelope: Readonly<DacsHttpEnvelopeV1>,
  rowsDelta: number,
  bytesDelta: number,
  reservedRowsDelta = 0,
  reservedBytesDelta = 0,
): void {
  if (!Number.isSafeInteger(rowsDelta) || !Number.isSafeInteger(bytesDelta) ||
      !Number.isSafeInteger(reservedRowsDelta) ||
      !Number.isSafeInteger(reservedBytesDelta)) {
    throw context.error("http-store-accounting-overflow", "HTTP usage delta is invalid");
  }
  for (const { dimension, key } of usageDimensions(direction, envelope)) {
    const retained = context.database.prepare(`
      SELECT dimension, dimension_key, retained_rows, retained_bytes,
        reserved_rows, reserved_bytes
      FROM dacs_http_usage WHERE dimension = ? AND dimension_key = ?
    `).get(dimension, key) as UsageRow | undefined;
    const currentRows = retained?.retained_rows ?? 0;
    const currentBytes = retained?.retained_bytes ?? 0;
    const currentReservedRows = retained?.reserved_rows ?? 0;
    const currentReservedBytes = retained?.reserved_bytes ?? 0;
    if (!safeUint(currentRows) || !safeUint(currentBytes) ||
        !safeUint(currentReservedRows) || !safeUint(currentReservedBytes)) {
      throw context.error("http-store-usage-corrupt", "HTTP usage counter is corrupt");
    }
    const nextRows = currentRows + rowsDelta;
    const nextBytes = currentBytes + bytesDelta;
    const nextReservedRows = currentReservedRows + reservedRowsDelta;
    const nextReservedBytes = currentReservedBytes + reservedBytesDelta;
    const chargedRows = nextRows + nextReservedRows;
    const chargedBytes = nextBytes + nextReservedBytes;
    if (!safeUint(nextRows) || !safeUint(nextBytes) ||
        !safeUint(nextReservedRows) || !safeUint(nextReservedBytes) ||
        !safeUint(chargedRows) || !safeUint(chargedBytes)) {
      throw context.error("http-store-accounting-overflow", "HTTP usage counter overflows");
    }
    if (limits !== undefined) {
      const maximum = quotaFor(limits, dimension);
      if (chargedRows > maximum.maxRows || chargedBytes > maximum.maxBytes) {
        throw new HttpQuotaFailure(dimension, key, "http-store-quota-exceeded");
      }
    }
    if (nextRows === 0 && nextBytes === 0 &&
        nextReservedRows === 0 && nextReservedBytes === 0) {
      context.database.prepare(`
        DELETE FROM dacs_http_usage WHERE dimension = ? AND dimension_key = ?
      `).run(dimension, key);
      continue;
    }
    context.database.prepare(`
      INSERT INTO dacs_http_usage (
        dimension, dimension_key, retained_rows, retained_bytes,
        reserved_rows, reserved_bytes
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (dimension, dimension_key) DO UPDATE SET
        retained_rows = excluded.retained_rows,
        retained_bytes = excluded.retained_bytes,
        reserved_rows = excluded.reserved_rows,
        reserved_bytes = excluded.reserved_bytes
    `).run(
      dimension,
      key,
      nextRows,
      nextBytes,
      nextReservedRows,
      nextReservedBytes,
    );
  }
}

function recordRejection(context: DacsHttpSqliteContext, failure: HttpQuotaFailure): void {
  context.beginImmediate(() => {
    const now = transportTime(context);
    const result = context.database.prepare(`
      UPDATE dacs_http_lifecycle SET
        rejected_admissions = rejected_admissions + 1,
        last_rejection_reason = ?, last_rejection_dimension = ?,
        last_rejection_key = ?, last_rejection_at = ?
      WHERE singleton = 1
    `).run(failure.reasonCode, failure.dimension, failure.dimensionKey, now);
    if (result.changes !== 1) {
      throw context.error("http-store-lifecycle-corrupt", "HTTP lifecycle singleton is missing");
    }
  });
}

function writeTransaction<T>(
  context: DacsHttpSqliteContext,
  operation: () => T,
): T {
  try {
    return context.beginImmediate(operation);
  } catch (error) {
    if (error instanceof HttpQuotaFailure) {
      recordRejection(context, error);
      throw context.error(error.reasonCode, "HTTP transport store admission quota was exceeded");
    }
    if (error !== null && typeof error === "object" &&
        "code" in error && (error as { code?: unknown }).code === "SQLITE_FULL") {
      const failure = new HttpQuotaFailure("disk", "database", "http-store-disk-full");
      try {
        recordRejection(context, failure);
      } catch {
        // A full filesystem may also prevent the diagnostic write. Fail closed.
      }
      throw context.error(failure.reasonCode, "HTTP transport database is full");
    }
    throw error;
  }
}

function assertRevisionCapacity(
  limits: Readonly<DacsHttpStoreLimitsV1>,
  revision: number,
  identity: string,
  reservedRevisions: number,
): void {
  const maximum = limits.maxRevisionsPerMessage - reservedRevisions;
  if (revision > maximum) {
    throw new HttpQuotaFailure("revision", identity, "http-store-revision-limit");
  }
}

function deterministicRetryJitter(input: Readonly<{
  envelopeId: string;
  attempt: number;
  baseDelayMs: number;
}>): number {
  const half = Math.floor(input.baseDelayMs / 2);
  const span = BigInt((half * 2) + 1);
  const digest = sha256Hex(canonicalize({
    domain: "dacs-http-retry-jitter:v1",
    ...input,
  }));
  return Number(BigInt(`0x${digest.slice(0, 16)}`) % span) - half;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    !value.includes("\0");
}

function leaseOwner(value: unknown): value is string {
  return nonEmpty(value) && Buffer.byteLength(value, "utf8") <= MAX_LEASE_OWNER_BYTES;
}

function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key));
}

function ownJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
      typeof value === "number") return value;
  if (typeof value !== "object" || nodeTypes.isProxy(value) || seen.has(value)) {
    throw new Error("non-canonical-data");
  }
  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) throw new Error();
    if (Array.isArray(value)) {
      if (keys.length !== value.length + 1 || keys.at(-1) !== "length") throw new Error();
      return Object.freeze(Array.from({ length: value.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor) ||
            descriptor.value === undefined) throw new Error();
        return ownJson(descriptor.value, seen);
      }));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const retained = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor) ||
          descriptor.value === undefined) throw new Error();
      retained[key] = ownJson(descriptor.value, seen);
    }
    return Object.freeze(retained);
  } finally {
    seen.delete(value);
  }
}

function snapshot<T>(value: T): T {
  return JSON.parse(canonicalize(ownJson(value))) as T;
}

function snapshotRecord(
  context: DacsHttpSqliteContext,
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  let captured: unknown;
  try {
    captured = snapshot(value);
  } catch {
    throw context.error("http-store-input-malformed", "HTTP store input is malformed");
  }
  if (!exactKeys(captured, required, optional)) {
    throw context.error("http-store-input-malformed", "HTTP store input is malformed");
  }
  return captured;
}

function recordJson(value: StoredInbox | StoredOutbox): string {
  return canonicalize(value);
}

function inboxActive(value: Readonly<StoredInbox>): boolean {
  return value.state === "pending";
}

function inboxReservedRevisions(value: Readonly<StoredInbox>): number {
  return inboxActive(value) ? 1 : 0;
}

function outboxReservedRevisions(value: Readonly<StoredOutbox>): number {
  // Operator action is itself the terminal fail-closed disposition. Before
  // that point pending work reserves a claim plus one terminal alternative;
  // sending work reserves one terminal alternative. A later ACK may still be
  // admitted when ordinary capacity remains, but terminal operator records
  // must not hold quota forever for an optional transition which may never
  // arrive.
  if (value.state === "acknowledged" || value.state === "operator-action") return 0;
  return value.state === "pending" ? 2 : 1;
}

function maximumInboxTerminalRecord(value: Readonly<StoredInbox>): StoredInbox {
  return {
    ...snapshot(value),
    state: "disposed",
    disposition: "rejected",
    reasonCode: "z".repeat(80),
    retainUntil: Number.MAX_SAFE_INTEGER,
    revision: Number.MAX_SAFE_INTEGER,
    updatedAt: Number.MAX_SAFE_INTEGER,
  };
}

function maximumOutboxAcknowledgedRecord(value: Readonly<StoredOutbox>): StoredOutbox {
  const original = value.envelope;
  const maximumHash = "f".repeat(64);
  const acknowledgement = {
    status: "authenticated",
    envelope: {
      version: "1",
      type: "acknowledgement",
      envelopeId: maximumHash,
      jobId: original.jobId,
      sender: original.audience,
      audience: original.sender,
      keyId: original.audience,
      algorithm: "ed25519",
      issuedAt: Number.MAX_SAFE_INTEGER - 1,
      expiresAt: Number.MAX_SAFE_INTEGER,
      nonce: "A".repeat(43),
      payloadHash: maximumHash,
      payload: {
        acknowledgedEnvelopeId: original.envelopeId,
        acknowledgedPayloadHash: original.payloadHash,
        disposition: "rejected",
        reasonCode: "z".repeat(80),
      },
      signature: "A".repeat(86),
    },
    authenticationHash: maximumHash,
    identityEvidenceHash: maximumHash,
    identityRole: "seller",
    receivedAt: Number.MAX_SAFE_INTEGER - 1,
  } as unknown as DacsHttpAuthenticatedEnvelopeV1;
  const terminal: StoredOutbox = {
    ...snapshot(value),
    state: "acknowledged",
    acknowledgement,
    acknowledgementRetentionMs: Number.MAX_SAFE_INTEGER,
    retainUntil: Number.MAX_SAFE_INTEGER,
    revision: Number.MAX_SAFE_INTEGER,
    updatedAt: Number.MAX_SAFE_INTEGER,
  };
  delete terminal.lease;
  delete terminal.reasonCode;
  return terminal;
}

function maximumOutboxOperatorRecord(value: Readonly<StoredOutbox>): StoredOutbox {
  const terminal: StoredOutbox = {
    ...snapshot(value),
    state: "operator-action",
    reasonCode: "z".repeat(80),
    retainUntil: Number.MAX_SAFE_INTEGER,
    revision: Number.MAX_SAFE_INTEGER,
    updatedAt: Number.MAX_SAFE_INTEGER,
  };
  delete terminal.lease;
  return terminal;
}

function maximumOutboxSendingRecord(value: Readonly<StoredOutbox>): StoredOutbox {
  const terminal: StoredOutbox = {
    ...snapshot(value),
    state: "sending",
    generation: Number.MAX_SAFE_INTEGER,
    attempts: Number.MAX_SAFE_INTEGER,
    nextAttemptAt: Number.MAX_SAFE_INTEGER,
    lease: {
      owner: "z".repeat(MAX_LEASE_OWNER_BYTES),
      generation: Number.MAX_SAFE_INTEGER,
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
    retainUntil: Number.MAX_SAFE_INTEGER,
    revision: Number.MAX_SAFE_INTEGER,
    updatedAt: Number.MAX_SAFE_INTEGER,
  };
  delete terminal.acknowledgement;
  delete terminal.acknowledgementRetentionMs;
  delete terminal.reasonCode;
  return terminal;
}

function terminalReserve(
  direction: "inbox" | "outbox",
  value: Readonly<StoredInbox | StoredOutbox>,
): Readonly<{ rows: number; bytes: number }> {
  const currentBytes = canonicalBytes(recordJson(value as StoredInbox | StoredOutbox));
  let reservedRows: number;
  let updateBytes: number;
  if (direction === "inbox") {
    const inbox = value as StoredInbox;
    reservedRows = inboxReservedRevisions(inbox);
    if (reservedRows === 0) return Object.freeze({ rows: 0, bytes: 0 });
    const terminalBytes = canonicalBytes(recordJson(maximumInboxTerminalRecord(inbox)));
    updateBytes = Math.max(0, (terminalBytes - currentBytes) + terminalBytes);
  } else {
    const outbox = value as StoredOutbox;
    reservedRows = outboxReservedRevisions(outbox);
    if (reservedRows === 0) return Object.freeze({ rows: 0, bytes: 0 });
    const acknowledgedBytes = canonicalBytes(
      recordJson(maximumOutboxAcknowledgedRecord(outbox)),
    );
    const operatorBytes = canonicalBytes(recordJson(maximumOutboxOperatorRecord(outbox)));
    if (outbox.state === "sending") {
      updateBytes = Math.max(
        0,
        (operatorBytes * 2) - currentBytes,
        (acknowledgedBytes * 2) - currentBytes,
      );
    } else {
      // Pending work may first add a maximally sized leased sending revision
      // and then one of the two terminal alternatives.
      const sendingBytes = canonicalBytes(
        recordJson(maximumOutboxSendingRecord(outbox)),
      );
      updateBytes = Math.max(
        0,
        sendingBytes + (Math.max(operatorBytes, acknowledgedBytes) * 2) -
          currentBytes,
      );
    }
  }
  if (!safeUint(updateBytes)) {
    throw new Error("HTTP terminal transition reserve overflows");
  }
  return Object.freeze({ rows: reservedRows, bytes: updateBytes });
}

function observedTransportTime(context: DacsHttpSqliteContext): Readonly<{
  persisted: number;
  now: number;
}> {
  const row = context.database.prepare(`
    SELECT last_time FROM dacs_http_clock WHERE singleton = 1
  `).get() as { last_time?: unknown } | undefined;
  const system = context.systemTime();
  if (!row || !safeUint(row.last_time) || !safeUint(system)) {
    throw context.error("http-store-clock-invalid", "HTTP transport store clock is invalid");
  }
  return Object.freeze({ persisted: row.last_time, now: Math.max(row.last_time, system) });
}

function transportTime(context: DacsHttpSqliteContext): number {
  const observed = observedTransportTime(context);
  if (observed.now !== observed.persisted) {
    const result = context.database.prepare(`
      UPDATE dacs_http_clock SET last_time = ?
      WHERE singleton = 1 AND last_time = ?
    `).run(observed.now, observed.persisted);
    if (result.changes !== 1) {
      throw context.error("http-store-clock-raced", "HTTP transport store clock raced");
    }
  }
  return observed.now;
}

function quota(
  context: DacsHttpSqliteContext,
  raw: unknown,
  fallback: Readonly<DacsHttpStoreQuotaV1>,
): Readonly<DacsHttpStoreQuotaV1> {
  if (raw === undefined) return fallback;
  let value: unknown;
  try {
    value = snapshot(raw);
  } catch {
    throw context.error("http-store-options-malformed", "HTTP quota is malformed");
  }
  if (!exactKeys(value, ["maxRows", "maxBytes"]) ||
      !safeUint(value.maxRows) || value.maxRows === 0 ||
      !safeUint(value.maxBytes) || value.maxBytes === 0) {
    throw context.error("http-store-options-malformed", "HTTP quota is malformed");
  }
  return Object.freeze({ maxRows: value.maxRows, maxBytes: value.maxBytes });
}

function normalizeLimits(
  context: DacsHttpSqliteContext,
  raw: unknown,
): Readonly<DacsHttpStoreLimitsV1> {
  if (raw === undefined) return DEFAULT_LIMITS;
  let value: unknown;
  try {
    value = snapshot(raw);
  } catch {
    throw context.error("http-store-options-malformed", "HTTP store limits are malformed");
  }
  if (!exactKeys(value, [], [
    "global", "perPeer", "perJob", "perMessageType",
    "maxRevisionsPerMessage", "expiryBatchSize", "purgeBatchSize",
  ])) {
    throw context.error("http-store-options-malformed", "HTTP store limits are malformed");
  }
  const maxRevisionsPerMessage = value.maxRevisionsPerMessage ??
    DEFAULT_LIMITS.maxRevisionsPerMessage;
  const expiryBatchSize = value.expiryBatchSize ?? DEFAULT_LIMITS.expiryBatchSize;
  const purgeBatchSize = value.purgeBatchSize ?? DEFAULT_LIMITS.purgeBatchSize;
  if (!safeUint(maxRevisionsPerMessage) || maxRevisionsPerMessage < 2 ||
      maxRevisionsPerMessage > 10_000 || !safeUint(expiryBatchSize) ||
      expiryBatchSize === 0 || expiryBatchSize > MAX_PAGE_SIZE ||
      !safeUint(purgeBatchSize) || purgeBatchSize === 0 ||
      purgeBatchSize > MAX_PAGE_SIZE) {
    throw context.error("http-store-options-malformed", "HTTP store limits are malformed");
  }
  return Object.freeze({
    global: quota(context, value.global, DEFAULT_LIMITS.global),
    perPeer: quota(context, value.perPeer, DEFAULT_LIMITS.perPeer),
    perJob: quota(context, value.perJob, DEFAULT_LIMITS.perJob),
    perMessageType: quota(
      context,
      value.perMessageType,
      DEFAULT_LIMITS.perMessageType,
    ),
    maxRevisionsPerMessage,
    expiryBatchSize,
    purgeBatchSize,
  });
}

function policyFromRow(
  context: DacsHttpSqliteContext,
  row: Readonly<PolicyRow>,
): Readonly<DacsHttpStoreLimitsV1> | undefined {
  if (row.singleton !== 1) {
    throw context.error("http-store-policy-corrupt", "HTTP policy singleton is corrupt");
  }
  if (row.policy_hash === null || row.policy_json === null || row.bound_at === null) {
    if (row.policy_hash !== null || row.policy_json !== null || row.bound_at !== null) {
      throw context.error("http-store-policy-corrupt", "HTTP policy is partially bound");
    }
    return undefined;
  }
  if (!hash(row.policy_hash) || !safeUint(row.bound_at)) {
    throw context.error("http-store-policy-corrupt", "HTTP policy metadata is corrupt");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.policy_json) as unknown;
    if (canonicalize(parsed) !== row.policy_json || sha256Hex(row.policy_json) !== row.policy_hash) {
      throw new Error();
    }
  } catch {
    throw context.error("http-store-policy-corrupt", "HTTP policy is not canonical");
  }
  const normalized = normalizeLimits(context, parsed);
  if (canonicalize(normalized) !== row.policy_json) {
    throw context.error("http-store-policy-corrupt", "HTTP policy differs from its projection");
  }
  return normalized;
}

function bindPolicy(
  context: DacsHttpSqliteContext,
  requested: Readonly<DacsHttpStoreLimitsV1>,
  explicitlyConfigured: boolean,
): Readonly<DacsHttpStoreLimitsV1> {
  return context.beginImmediate(() => {
    const row = context.database.prepare(`
      SELECT singleton, policy_hash, policy_json, bound_at
      FROM dacs_http_policy WHERE singleton = 1
    `).get() as PolicyRow | undefined;
    if (!row) {
      throw context.error("http-store-policy-corrupt", "HTTP policy singleton is missing");
    }
    const retained = policyFromRow(context, row);
    if (retained !== undefined) {
      if (explicitlyConfigured && canonicalize(retained) !== canonicalize(requested)) {
        throw context.error(
          "http-store-policy-mismatch",
          "HTTP store limits differ from the database-bound policy",
        );
      }
      return retained;
    }
    const json = canonicalize(requested);
    const now = transportTime(context);
    const retainedUsage = context.database.prepare(`
      SELECT dimension, dimension_key, retained_rows, retained_bytes,
        reserved_rows, reserved_bytes
      FROM dacs_http_usage
    `).all() as UsageRow[];
    for (const usage of retainedUsage) {
      if (!safeUint(usage.retained_rows) || !safeUint(usage.retained_bytes) ||
          !safeUint(usage.reserved_rows) || !safeUint(usage.reserved_bytes) ||
          !["global", "peer", "job", "message-type"].includes(usage.dimension)) {
        throw context.error("http-store-usage-corrupt", "HTTP usage row is corrupt");
      }
      const maximum = quotaFor(requested, usage.dimension);
      if (usage.retained_rows + usage.reserved_rows > maximum.maxRows ||
          usage.retained_bytes + usage.reserved_bytes > maximum.maxBytes) {
        throw context.error(
          "http-store-policy-too-small",
          "HTTP store limits cannot be bound below retained usage",
        );
      }
    }
    const revision = context.database.prepare(`
      SELECT MAX(revision) AS maximum FROM (
        SELECT revision FROM dacs_http_inbox
        UNION ALL SELECT revision FROM dacs_http_outbox
      )
    `).get() as { maximum: number | null };
    if (revision.maximum !== null &&
        (!safeUint(revision.maximum) ||
          revision.maximum > requested.maxRevisionsPerMessage)) {
      throw context.error(
        "http-store-policy-too-small",
        "HTTP revision limit cannot be bound below retained history",
      );
    }
    const exhaustedActive = context.database.prepare(`
      SELECT 1 FROM dacs_http_inbox
      WHERE state = 'pending' AND revision >= ?
      UNION ALL
      SELECT 1 FROM dacs_http_outbox
      WHERE state IN ('pending', 'sending') AND revision >= ?
      LIMIT 1
    `).get(requested.maxRevisionsPerMessage, requested.maxRevisionsPerMessage);
    if (exhaustedActive !== undefined) {
      throw context.error(
        "http-store-policy-too-small",
        "HTTP revision limit must preserve a terminal transition for active work",
      );
    }
    const result = context.database.prepare(`
      UPDATE dacs_http_policy SET policy_hash = ?, policy_json = ?, bound_at = ?
      WHERE singleton = 1 AND policy_hash IS NULL AND policy_json IS NULL AND bound_at IS NULL
    `).run(sha256Hex(json), json, now);
    if (result.changes !== 1) {
      throw context.error("http-store-policy-raced", "HTTP policy binding raced");
    }
    return requested;
  });
}

function validateOptions(
  context: DacsHttpSqliteContext,
  raw: Readonly<DacsHttpTransportStoreOptionsV1> | undefined,
): BoundOptions {
  const value = raw ?? {};
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      nodeTypes.isProxy(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw context.error("http-store-options-malformed", "HTTP store options are malformed");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string") || keys.some((key) => {
    const descriptor = descriptors[key as string];
    return !descriptor || descriptor.enumerable !== true || !("value" in descriptor);
  })) {
    throw context.error("http-store-options-malformed", "HTTP store options are malformed");
  }
  if (keys.some((key) => key !== "retentionMs" && key !== "retryJitter" && key !== "limits")) {
    throw context.error("http-store-options-malformed", "HTTP store options are malformed");
  }
  const retentionMs = descriptors.retentionMs?.value ?? DACS_HTTP_MINIMUM_RETENTION_MS;
  const retryJitter = descriptors.retryJitter?.value;
  const explicitlyConfigured = descriptors.limits?.value !== undefined;
  const requestedLimits = normalizeLimits(context, descriptors.limits?.value);
  if (!safeUint(retentionMs) || retentionMs < DACS_HTTP_MINIMUM_RETENTION_MS) {
    throw context.error(
      "http-retention-too-short",
      "HTTP transport retention cannot be shorter than seven days",
    );
  }
  if (retryJitter !== undefined && typeof retryJitter !== "function") {
    throw context.error("http-store-options-malformed", "HTTP retry jitter must be callable");
  }
  const limits = bindPolicy(context, requestedLimits, explicitlyConfigured);
  return Object.freeze({
    retentionMs,
    jitter: retryJitter ?? deterministicRetryJitter,
    limits,
  });
}

function authenticatedEnvelope(
  context: DacsHttpSqliteContext,
  raw: unknown,
  expectedAudience?: string,
): Readonly<DacsHttpAuthenticatedEnvelopeV1> {
  let value: DacsHttpAuthenticatedEnvelopeV1;
  try {
    value = snapshot(raw) as DacsHttpAuthenticatedEnvelopeV1;
  } catch {
    throw context.error("http-authentication-record-invalid", "HTTP authentication record is malformed");
  }
  if (!exactKeys(value, [
    "status",
    "envelope",
    "authenticationHash",
    "identityEvidenceHash",
    "identityRole",
    "receivedAt",
  ])) {
    throw context.error("http-authentication-record-invalid", "HTTP authentication record is invalid");
  }
  const verified = verifyDacsHttpEnvelopeSelfSignatureV1(value.envelope);
  if (value.status !== "authenticated" || verified.status !== "valid" ||
      value.authenticationHash !== verified.authenticationHash ||
      !hash(value.identityEvidenceHash) ||
      (value.identityRole !== "buyer" && value.identityRole !== "seller") ||
      !safeUint(value.receivedAt) ||
      verified.envelope.expiresAt <= value.receivedAt ||
      verified.envelope.issuedAt > value.receivedAt + DACS_HTTP_MAX_FUTURE_SKEW_MS ||
      (expectedAudience !== undefined &&
        !sameDemosAgentIdentity(verified.envelope.audience, expectedAudience))) {
    throw context.error("http-authentication-record-invalid", "HTTP authentication record is invalid");
  }
  return Object.freeze(value);
}

function inboxStored(
  context: DacsHttpSqliteContext,
  row: Readonly<InboxRow>,
): StoredInbox {
  let value: StoredInbox;
  try {
    value = JSON.parse(row.record_json) as StoredInbox;
    if (canonicalize(value) !== row.record_json || sha256Hex(row.record_json) !== row.record_hash) {
      throw new Error();
    }
  } catch {
    throw context.error(
      "http-inbox-record-corrupt",
      "HTTP inbox record is not canonical integrity-checked data",
    );
  }
  const authenticated = authenticatedEnvelope(context, value.authenticated, context.authority);
  const envelope = authenticated.envelope;
  const senderRole = requiredSenderRole(envelope);
  if ((value.state !== "pending" && value.state !== "disposed") ||
      senderRole === undefined || authenticated.identityRole !== senderRole ||
      context.role === senderRole ||
      !safeUint(value.retainUntil) ||
      value.retainUntil < authenticated.receivedAt + DACS_HTTP_MINIMUM_RETENTION_MS ||
      !safeUint(value.revision) || value.revision === 0 || !safeUint(value.updatedAt) ||
      value.updatedAt < authenticated.receivedAt ||
      (value.state === "pending" && (value.disposition !== undefined || value.reasonCode !== undefined)) ||
      (value.state === "disposed" && value.disposition !== "accepted" &&
        value.disposition !== "existing" && value.disposition !== "rejected") ||
      (value.disposition === "rejected" ? !reasonCode(value.reasonCode) :
        value.reasonCode !== undefined) ||
      row.sender !== envelope.sender || row.audience !== envelope.audience ||
      row.envelope_id !== envelope.envelopeId || row.job_id !== envelope.jobId ||
      row.state !== value.state || row.authentication_hash !== authenticated.authenticationHash ||
      row.identity_evidence_hash !== authenticated.identityEvidenceHash ||
      row.payload_hash !== envelope.payloadHash || row.nonce !== envelope.nonce ||
      row.disposition !== (value.disposition ?? null) || row.reason_code !== (value.reasonCode ?? null) ||
      row.received_at !== authenticated.receivedAt || row.retain_until !== value.retainUntil ||
      row.revision !== value.revision || row.updated_at !== value.updatedAt ||
      (row.semantic_key !== undefined && row.semantic_key !== null &&
        row.semantic_key !== semanticKey(envelope))) {
    throw context.error("http-inbox-record-corrupt", "HTTP inbox projection differs from its record");
  }
  return value;
}

function outboxStored(
  context: DacsHttpSqliteContext,
  row: Readonly<OutboxRow>,
): StoredOutbox {
  let value: StoredOutbox;
  try {
    value = JSON.parse(row.record_json) as StoredOutbox;
    if (canonicalize(value) !== row.record_json || sha256Hex(row.record_json) !== row.record_hash) {
      throw new Error();
    }
  } catch {
    throw context.error(
      "http-outbox-record-corrupt",
      "HTTP outbox record is not canonical integrity-checked data",
    );
  }
  const verified = verifyDacsHttpEnvelopeSelfSignatureV1(value.envelope);
  const senderRole = requiredSenderRole(value.envelope);
  if (verified.status !== "valid" || value.envelopeHash !== verified.authenticationHash ||
      !sameDemosAgentIdentity(value.envelope.sender, context.authority) ||
      value.envelope.type === "acknowledgement" ||
      senderRole !== context.role ||
      !["pending", "sending", "acknowledged", "operator-action"].includes(value.state) ||
      !safeUint(value.generation) || value.attempts !== value.generation ||
      !safeUint(value.attempts) || !safeUint(value.nextAttemptAt) ||
      !safeUint(value.retainUntil) || value.retainUntil < value.createdAt + DACS_HTTP_MINIMUM_RETENTION_MS ||
      !safeUint(value.revision) || value.revision === 0 || !safeUint(value.createdAt) ||
      !safeUint(value.updatedAt) || value.updatedAt < value.createdAt ||
      ((value.state === "sending") !== (value.lease !== undefined)) ||
      (value.lease !== undefined && (!nonEmpty(value.lease.owner) ||
        value.lease.generation !== value.generation || !safeUint(value.lease.expiresAt))) ||
      ((value.state === "acknowledged") !== (value.acknowledgement !== undefined)) ||
      ((value.acknowledgement !== undefined) !==
        (value.acknowledgementRetentionMs !== undefined)) ||
      (value.acknowledgementRetentionMs !== undefined &&
        (!safeUint(value.acknowledgementRetentionMs) ||
          value.acknowledgementRetentionMs < DACS_HTTP_MINIMUM_RETENTION_MS)) ||
      (value.reasonCode !== undefined && !reasonCode(value.reasonCode))) {
    throw context.error("http-outbox-record-corrupt", "HTTP outbox record is invalid");
  }
  let acknowledgementHash: string | null = null;
  if (value.acknowledgement !== undefined) {
    const acknowledgement = authenticatedEnvelope(context, value.acknowledgement);
    const binding = verifyDacsHttpAcknowledgementBindingV1(acknowledgement, value.envelope);
    const requiredRetainUntil = retentionDeadline(
      acknowledgement.receivedAt,
      value.acknowledgementRetentionMs!,
    );
    if (binding.status !== "valid" ||
        !sameDemosAgentIdentity(acknowledgement.envelope.audience, context.authority) ||
        acknowledgement.identityRole === context.role ||
        acknowledgement.receivedAt > value.updatedAt ||
        requiredRetainUntil === undefined || value.retainUntil < requiredRetainUntil) {
      throw context.error("http-outbox-record-corrupt", "HTTP outbox acknowledgement is not bound");
    }
    acknowledgementHash = acknowledgement.authenticationHash;
  }
  if (row.envelope_id !== value.envelope.envelopeId || row.envelope_hash !== value.envelopeHash ||
      row.job_id !== value.envelope.jobId || row.sender !== value.envelope.sender ||
      row.audience !== value.envelope.audience || row.payload_hash !== value.envelope.payloadHash ||
      row.state !== value.state || row.generation !== value.generation ||
      row.attempts !== value.attempts || row.owner !== (value.lease?.owner ?? null) ||
      row.lease_expires_at !== (value.lease?.expiresAt ?? null) ||
      row.next_attempt_at !== value.nextAttemptAt || row.acknowledgement_hash !== acknowledgementHash ||
      row.reason_code !== (value.reasonCode ?? null) || row.retain_until !== value.retainUntil ||
      row.revision !== value.revision || row.created_at !== value.createdAt ||
      row.updated_at !== value.updatedAt ||
      (row.semantic_key !== undefined && row.semantic_key !== null &&
        row.semantic_key !== semanticKey(value.envelope))) {
    throw context.error("http-outbox-record-corrupt", "HTTP outbox projection differs from its record");
  }
  return value;
}

function publicInbox(row: Readonly<InboxRow>, value: StoredInbox): Readonly<DacsHttpInboxItemV1> {
  return Object.freeze({ ...snapshot(value), recordHash: row.record_hash });
}

function publicOutbox(row: Readonly<OutboxRow>, value: StoredOutbox): Readonly<DacsHttpOutboxItemV1> {
  return Object.freeze({ ...snapshot(value), recordHash: row.record_hash });
}

function historyEntryHash(input: Readonly<{
  direction: "inbox" | "outbox";
  identity: string;
  revision: number;
  occurredAt: number;
  recordHash: string;
  previousEntryHash: string | null;
}>): string {
  return sha256Hex(canonicalize(input));
}

function verifyHistory(
  context: DacsHttpSqliteContext,
  direction: "inbox" | "outbox",
  identity: string,
  revision: number,
  recordHashValue: string,
  recordJsonValue: string,
  query: string,
  parameters: readonly unknown[],
  validateRecords: (records: readonly unknown[], rows: readonly HistoryRow[]) => void,
): void {
  const rows = context.database.prepare(query).all(...parameters) as HistoryRow[];
  let previous: HistoryRow | undefined;
  const records: unknown[] = [];
  for (const [index, row] of rows.entries()) {
    let canonicalHistoryRecord = false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.record_json) as unknown;
      canonicalHistoryRecord = canonicalize(parsed) === row.record_json;
    } catch {
      canonicalHistoryRecord = false;
    }
    if (row.revision !== index + 1 || !safeUint(row.occurred_at) ||
        !hash(row.record_hash) || !canonicalHistoryRecord ||
        sha256Hex(row.record_json) !== row.record_hash ||
        row.previous_entry_hash !== (previous?.entry_hash ?? null) ||
        row.entry_hash !== historyEntryHash({
          direction,
          identity,
          revision: row.revision,
          occurredAt: row.occurred_at,
          recordHash: row.record_hash,
          previousEntryHash: row.previous_entry_hash,
        }) || (previous !== undefined && row.occurred_at < previous.occurred_at)) {
      throw context.error("http-store-history-corrupt", "HTTP transport history chain is invalid");
    }
    records.push(parsed);
    previous = row;
  }
  if (!previous || rows.length !== revision || previous.record_hash !== recordHashValue ||
      previous.record_json !== recordJsonValue) {
    throw context.error("http-store-history-corrupt", "HTTP transport history does not end at its projection");
  }
  validateRecords(records, rows);
}

function withoutKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  const omitted = new Set(keys);
  return Object.freeze(Object.fromEntries(
    Object.entries(value).filter(([key]) => !omitted.has(key)),
  ));
}

function verifyInboxTransitions(
  context: DacsHttpSqliteContext,
  records: readonly unknown[],
  rows: readonly HistoryRow[],
): void {
  let previous: StoredInbox | undefined;
  for (const [index, unknownRecord] of records.entries()) {
    if (!exactKeys(unknownRecord, [
      "authenticated", "state", "retainUntil", "revision", "updatedAt",
    ], ["disposition", "reasonCode"])) {
      throw context.error("http-store-history-corrupt", "HTTP inbox history record is malformed");
    }
    const record = unknownRecord as unknown as StoredInbox;
    if (record.revision !== index + 1 || record.updatedAt !== rows[index]!.occurred_at ||
        !safeUint(record.retainUntil) ||
        (record.state !== "pending" && record.state !== "disposed") ||
        (record.state === "pending" &&
          (record.disposition !== undefined || record.reasonCode !== undefined)) ||
        (record.state === "disposed" && record.disposition !== "accepted" &&
          record.disposition !== "existing" && record.disposition !== "rejected") ||
        (record.disposition === "rejected" ? !reasonCode(record.reasonCode) :
          record.reasonCode !== undefined)) {
      throw context.error("http-store-history-corrupt", "HTTP inbox history state is invalid");
    }
    if (previous === undefined) {
      if (record.state !== "pending" || record.revision !== 1) {
        throw context.error("http-store-history-corrupt", "HTTP inbox history origin is invalid");
      }
    } else {
      if (canonicalize(record.authenticated) !== canonicalize(previous.authenticated) ||
          record.retainUntil < previous.retainUntil ||
          (previous.state === "disposed" &&
            (record.state !== "disposed" || record.disposition !== previous.disposition ||
              record.reasonCode !== previous.reasonCode)) ||
          (previous.state === "pending" && record.state === "pending" &&
            record.retainUntil === previous.retainUntil)) {
        throw context.error("http-store-history-corrupt", "HTTP inbox history transition is invalid");
      }
    }
    previous = record;
  }
}

function verifyOutboxTransitions(
  context: DacsHttpSqliteContext,
  records: readonly unknown[],
  rows: readonly HistoryRow[],
): void {
  let previous: StoredOutbox | undefined;
  for (const [index, unknownRecord] of records.entries()) {
    if (!exactKeys(unknownRecord, [
      "envelope", "envelopeHash", "state", "generation", "attempts",
      "nextAttemptAt", "retainUntil", "revision", "createdAt", "updatedAt",
    ], ["lease", "acknowledgement", "acknowledgementRetentionMs", "reasonCode"])) {
      throw context.error("http-store-history-corrupt", "HTTP outbox history record is malformed");
    }
    const record = unknownRecord as unknown as StoredOutbox;
    if (record.revision !== index + 1 || record.updatedAt !== rows[index]!.occurred_at ||
        !safeUint(record.generation) || record.attempts !== record.generation ||
        !safeUint(record.nextAttemptAt) || !safeUint(record.retainUntil) ||
        !safeUint(record.createdAt) || !safeUint(record.updatedAt) ||
        !["pending", "sending", "acknowledged", "operator-action"].includes(record.state) ||
        ((record.state === "sending") !== (record.lease !== undefined)) ||
        ((record.state === "acknowledged") !== (record.acknowledgement !== undefined)) ||
        ((record.acknowledgement !== undefined) !==
          (record.acknowledgementRetentionMs !== undefined)) ||
        (record.acknowledgementRetentionMs !== undefined &&
          (!safeUint(record.acknowledgementRetentionMs) ||
            record.acknowledgementRetentionMs < DACS_HTTP_MINIMUM_RETENTION_MS))) {
      throw context.error("http-store-history-corrupt", "HTTP outbox history state is invalid");
    }
    if (record.acknowledgement !== undefined) {
      try {
        const acknowledgement = authenticatedEnvelope(context, record.acknowledgement);
        const binding = verifyDacsHttpAcknowledgementBindingV1(acknowledgement, record.envelope);
        const requiredRetainUntil = retentionDeadline(
          acknowledgement.receivedAt,
          record.acknowledgementRetentionMs!,
        );
        if (binding.status !== "valid" ||
            !sameDemosAgentIdentity(acknowledgement.envelope.audience, context.authority) ||
            acknowledgement.identityRole === context.role ||
            acknowledgement.receivedAt > record.updatedAt ||
            requiredRetainUntil === undefined || record.retainUntil < requiredRetainUntil) {
          throw new Error();
        }
      } catch {
        throw context.error(
          "http-store-history-corrupt",
          "HTTP outbox acknowledgement history is invalid",
        );
      }
    }
    if (previous === undefined) {
      if (record.state !== "pending" || record.generation !== 0 || record.attempts !== 0 ||
          record.revision !== 1) {
        throw context.error("http-store-history-corrupt", "HTTP outbox history origin is invalid");
      }
    } else {
      if (canonicalize(record.envelope) !== canonicalize(previous.envelope) ||
          record.envelopeHash !== previous.envelopeHash ||
          record.createdAt !== previous.createdAt ||
          record.retainUntil < previous.retainUntil ||
          record.generation < previous.generation ||
          (previous.acknowledgement !== undefined &&
            canonicalize(record.acknowledgement) !== canonicalize(previous.acknowledgement)) ||
          (previous.acknowledgementRetentionMs !== undefined &&
            (record.acknowledgementRetentionMs === undefined ||
              record.acknowledgementRetentionMs < previous.acknowledgementRetentionMs))) {
        throw context.error("http-store-history-corrupt", "HTTP outbox immutable history changed");
      }
      const retentionStateUnchanged = canonicalize(withoutKeys(
        record as unknown as Readonly<Record<string, unknown>>,
        ["retainUntil", "acknowledgementRetentionMs", "revision", "updatedAt"],
      )) === canonicalize(withoutKeys(
        previous as unknown as Readonly<Record<string, unknown>>,
        ["retainUntil", "acknowledgementRetentionMs", "revision", "updatedAt"],
      ));
      const retentionOnly = retentionStateUnchanged &&
        (record.retainUntil > previous.retainUntil ||
          (record.acknowledgementRetentionMs ?? 0) >
            (previous.acknowledgementRetentionMs ?? 0));
      const claimed = (previous.state === "pending" || previous.state === "sending") &&
        record.state === "sending" && record.generation === previous.generation + 1 &&
        record.attempts === previous.attempts + 1;
      const released = previous.state === "sending" && record.state === "pending" &&
        record.generation === previous.generation && record.lease === undefined &&
        reasonCode(record.reasonCode);
      const operator = (previous.state === "pending" || previous.state === "sending") &&
        record.state === "operator-action" && record.generation === previous.generation &&
        record.lease === undefined && reasonCode(record.reasonCode);
      const acknowledged = previous.state !== "acknowledged" &&
        record.state === "acknowledged" && record.generation === previous.generation &&
        record.lease === undefined && record.acknowledgement !== undefined;
      if (!retentionOnly && !claimed && !released && !operator && !acknowledged) {
        throw context.error("http-store-history-corrupt", "HTTP outbox history transition is invalid");
      }
    }
    previous = record;
  }
}

function verifyInboxHistory(context: DacsHttpSqliteContext, row: Readonly<InboxRow>): void {
  verifyHistory(
    context,
    "inbox",
    canonicalize([row.sender, row.audience, row.envelope_id]),
    row.revision,
    row.record_hash,
    row.record_json,
    `SELECT sequence, revision, occurred_at, record_hash, record_json,
       previous_entry_hash, entry_hash
     FROM dacs_http_inbox_history
     WHERE sender = ? AND audience = ? AND envelope_id = ? ORDER BY revision`,
    [row.sender, row.audience, row.envelope_id],
    (records, rows) => verifyInboxTransitions(context, records, rows),
  );
}

function verifyOutboxHistory(context: DacsHttpSqliteContext, row: Readonly<OutboxRow>): void {
  verifyHistory(
    context,
    "outbox",
    row.envelope_id,
    row.revision,
    row.record_hash,
    row.record_json,
    `SELECT sequence, revision, occurred_at, record_hash, record_json,
       previous_entry_hash, entry_hash
     FROM dacs_http_outbox_history WHERE envelope_id = ? ORDER BY revision`,
    [row.envelope_id],
    (records, rows) => verifyOutboxTransitions(context, records, rows),
  );
}

function appendInboxHistory(
  context: DacsHttpSqliteContext,
  record: StoredInbox,
  json: string,
  recordHashValue: string,
): void {
  const envelope = record.authenticated.envelope;
  const previous = context.database.prepare(`
    SELECT entry_hash FROM dacs_http_inbox_history
    WHERE sender = ? AND audience = ? AND envelope_id = ?
    ORDER BY revision DESC LIMIT 1
  `).get(envelope.sender, envelope.audience, envelope.envelopeId) as
    { entry_hash: string } | undefined;
  const identity = canonicalize([envelope.sender, envelope.audience, envelope.envelopeId]);
  const previousHash = previous?.entry_hash ?? null;
  context.database.prepare(`
    INSERT INTO dacs_http_inbox_history (
      sender, audience, envelope_id, revision, occurred_at, record_hash,
      record_json, previous_entry_hash, entry_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    envelope.sender,
    envelope.audience,
    envelope.envelopeId,
    record.revision,
    record.updatedAt,
    recordHashValue,
    json,
    previousHash,
    historyEntryHash({
      direction: "inbox",
      identity,
      revision: record.revision,
      occurredAt: record.updatedAt,
      recordHash: recordHashValue,
      previousEntryHash: previousHash,
    }),
  );
}

function appendOutboxHistory(
  context: DacsHttpSqliteContext,
  record: StoredOutbox,
  json: string,
  recordHashValue: string,
): void {
  const previous = context.database.prepare(`
    SELECT entry_hash FROM dacs_http_outbox_history
    WHERE envelope_id = ? ORDER BY revision DESC LIMIT 1
  `).get(record.envelope.envelopeId) as { entry_hash: string } | undefined;
  const previousHash = previous?.entry_hash ?? null;
  context.database.prepare(`
    INSERT INTO dacs_http_outbox_history (
      envelope_id, revision, occurred_at, record_hash, record_json,
      previous_entry_hash, entry_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.envelope.envelopeId,
    record.revision,
    record.updatedAt,
    recordHashValue,
    json,
    previousHash,
    historyEntryHash({
      direction: "outbox",
      identity: record.envelope.envelopeId,
      revision: record.revision,
      occurredAt: record.updatedAt,
      recordHash: recordHashValue,
      previousEntryHash: previousHash,
    }),
  );
}

function insertInbox(
  context: DacsHttpSqliteContext,
  limits: Readonly<DacsHttpStoreLimitsV1>,
  record: StoredInbox,
): InboxRow {
  const envelope = record.authenticated.envelope;
  const json = recordJson(record);
  const recordHashValue = sha256Hex(json);
  const reserve = terminalReserve("inbox", record);
  assertRevisionCapacity(
    limits,
    record.revision,
    envelope.envelopeId,
    inboxReservedRevisions(record),
  );
  adjustUsage(
    context,
    limits,
    "inbox",
    envelope,
    2,
    canonicalBytes(json) * 2,
    reserve.rows,
    reserve.bytes,
  );
  context.database.prepare(`
    INSERT INTO dacs_http_inbox (
      sender, audience, envelope_id, job_id, state, authentication_hash,
      identity_evidence_hash, payload_hash, nonce, disposition, reason_code,
      received_at, retain_until, revision, record_hash, record_json, updated_at,
      semantic_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    envelope.sender, envelope.audience, envelope.envelopeId, envelope.jobId,
    record.state, record.authenticated.authenticationHash,
    record.authenticated.identityEvidenceHash, envelope.payloadHash, envelope.nonce,
    record.disposition ?? null, record.reasonCode ?? null,
    record.authenticated.receivedAt, record.retainUntil, record.revision,
    recordHashValue, json, record.updatedAt, semanticKey(envelope),
  );
  appendInboxHistory(context, record, json, recordHashValue);
  return context.database.prepare(`
    SELECT * FROM dacs_http_inbox
    WHERE sender = ? AND audience = ? AND envelope_id = ?
  `).get(envelope.sender, envelope.audience, envelope.envelopeId) as InboxRow;
}

function updateInbox(
  context: DacsHttpSqliteContext,
  limits: Readonly<DacsHttpStoreLimitsV1>,
  current: Readonly<InboxRow>,
  currentRecord: Readonly<StoredInbox>,
  record: StoredInbox,
): InboxRow | undefined {
  const json = recordJson(record);
  const recordHashValue = sha256Hex(json);
  assertRevisionCapacity(
    limits,
    record.revision,
    current.envelope_id,
    inboxReservedRevisions(record),
  );
  const previousReserve = terminalReserve("inbox", currentRecord);
  const nextReserve = terminalReserve("inbox", record);
  adjustUsage(
    context,
    limits,
    "inbox",
    record.authenticated.envelope,
    1,
    (canonicalBytes(json) - canonicalBytes(current.record_json)) + canonicalBytes(json),
    nextReserve.rows - previousReserve.rows,
    nextReserve.bytes - previousReserve.bytes,
  );
  const result = context.database.prepare(`
    UPDATE dacs_http_inbox SET state = ?, disposition = ?, reason_code = ?,
      retain_until = ?, revision = ?, record_hash = ?, record_json = ?, updated_at = ?
    WHERE sender = ? AND audience = ? AND envelope_id = ? AND revision = ?
  `).run(
    record.state, record.disposition ?? null, record.reasonCode ?? null,
    record.retainUntil, record.revision, recordHashValue, json, record.updatedAt,
    current.sender, current.audience, current.envelope_id, current.revision,
  );
  if (result.changes !== 1) return undefined;
  appendInboxHistory(context, record, json, recordHashValue);
  return context.database.prepare(`
    SELECT * FROM dacs_http_inbox
    WHERE sender = ? AND audience = ? AND envelope_id = ?
  `).get(current.sender, current.audience, current.envelope_id) as InboxRow;
}

function insertOutbox(
  context: DacsHttpSqliteContext,
  limits: Readonly<DacsHttpStoreLimitsV1>,
  record: StoredOutbox,
): OutboxRow {
  const json = recordJson(record);
  const recordHashValue = sha256Hex(json);
  const reserve = terminalReserve("outbox", record);
  assertRevisionCapacity(
    limits,
    record.revision,
    record.envelope.envelopeId,
    outboxReservedRevisions(record),
  );
  adjustUsage(
    context,
    limits,
    "outbox",
    record.envelope,
    2,
    canonicalBytes(json) * 2,
    reserve.rows,
    reserve.bytes,
  );
  context.database.prepare(`
    INSERT INTO dacs_http_outbox (
      envelope_id, envelope_hash, job_id, sender, audience, payload_hash, state,
      generation, attempts, owner, lease_expires_at, next_attempt_at,
      acknowledgement_hash, reason_code, retain_until, revision, record_hash,
      record_json, created_at, updated_at, semantic_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.envelope.envelopeId, record.envelopeHash, record.envelope.jobId,
    record.envelope.sender, record.envelope.audience, record.envelope.payloadHash,
    record.state, record.generation, record.attempts, record.lease?.owner ?? null,
    record.lease?.expiresAt ?? null, record.nextAttemptAt,
    record.acknowledgement?.authenticationHash ?? null, record.reasonCode ?? null,
    record.retainUntil, record.revision, recordHashValue, json,
    record.createdAt, record.updatedAt, semanticKey(record.envelope),
  );
  appendOutboxHistory(context, record, json, recordHashValue);
  return context.database.prepare(`SELECT * FROM dacs_http_outbox WHERE envelope_id = ?`)
    .get(record.envelope.envelopeId) as OutboxRow;
}

function updateOutbox(
  context: DacsHttpSqliteContext,
  limits: Readonly<DacsHttpStoreLimitsV1>,
  current: Readonly<OutboxRow>,
  currentRecord: Readonly<StoredOutbox>,
  record: StoredOutbox,
): OutboxRow | undefined {
  const json = recordJson(record);
  const recordHashValue = sha256Hex(json);
  assertRevisionCapacity(
    limits,
    record.revision,
    current.envelope_id,
    outboxReservedRevisions(record),
  );
  const previousReserve = terminalReserve("outbox", currentRecord);
  const nextReserve = terminalReserve("outbox", record);
  adjustUsage(
    context,
    limits,
    "outbox",
    record.envelope,
    1,
    (canonicalBytes(json) - canonicalBytes(current.record_json)) + canonicalBytes(json),
    nextReserve.rows - previousReserve.rows,
    nextReserve.bytes - previousReserve.bytes,
  );
  const result = context.database.prepare(`
    UPDATE dacs_http_outbox SET state = ?, generation = ?, attempts = ?, owner = ?,
      lease_expires_at = ?, next_attempt_at = ?, acknowledgement_hash = ?,
      reason_code = ?, retain_until = ?, revision = ?, record_hash = ?,
      record_json = ?, updated_at = ?
    WHERE envelope_id = ? AND revision = ?
  `).run(
    record.state, record.generation, record.attempts, record.lease?.owner ?? null,
    record.lease?.expiresAt ?? null, record.nextAttemptAt,
    record.acknowledgement?.authenticationHash ?? null, record.reasonCode ?? null,
    record.retainUntil, record.revision, recordHashValue, json, record.updatedAt,
    current.envelope_id, current.revision,
  );
  if (result.changes !== 1) return undefined;
  appendOutboxHistory(context, record, json, recordHashValue);
  return context.database.prepare(`SELECT * FROM dacs_http_outbox WHERE envelope_id = ?`)
    .get(current.envelope_id) as OutboxRow;
}

function readInbox(
  context: DacsHttpSqliteContext,
  sender: string,
  audience: string,
  envelopeId: string,
): Readonly<{ row: InboxRow; stored: StoredInbox; record: DacsHttpInboxItemV1 }> | undefined {
  const row = context.database.prepare(`
    SELECT * FROM dacs_http_inbox
    WHERE sender = ? AND audience = ? AND envelope_id = ?
  `).get(sender, audience, envelopeId) as InboxRow | undefined;
  if (!row) return undefined;
  const stored = inboxStored(context, row);
  verifyInboxHistory(context, row);
  return { row, stored, record: publicInbox(row, stored) };
}

function readOutbox(
  context: DacsHttpSqliteContext,
  envelopeId: string,
): Readonly<{ row: OutboxRow; stored: StoredOutbox; record: DacsHttpOutboxItemV1 }> | undefined {
  const row = context.database.prepare(`SELECT * FROM dacs_http_outbox WHERE envelope_id = ?`)
    .get(envelopeId) as OutboxRow | undefined;
  if (!row) return undefined;
  const stored = outboxStored(context, row);
  verifyOutboxHistory(context, row);
  return { row, stored, record: publicOutbox(row, stored) };
}

function readInboxSemantic(
  context: DacsHttpSqliteContext,
  sender: string,
  audience: string,
  key: string,
): ReturnType<typeof readInbox> {
  const row = context.database.prepare(`
    SELECT * FROM dacs_http_inbox
    WHERE sender = ? AND audience = ? AND semantic_key = ?
  `).get(sender, audience, key) as InboxRow | undefined;
  if (!row) return undefined;
  const stored = inboxStored(context, row);
  verifyInboxHistory(context, row);
  return { row, stored, record: publicInbox(row, stored) };
}

function readOutboxSemantic(
  context: DacsHttpSqliteContext,
  sender: string,
  audience: string,
  key: string,
): ReturnType<typeof readOutbox> {
  const row = context.database.prepare(`
    SELECT * FROM dacs_http_outbox
    WHERE sender = ? AND audience = ? AND semantic_key = ?
  `).get(sender, audience, key) as OutboxRow | undefined;
  if (!row) return undefined;
  const stored = outboxStored(context, row);
  verifyOutboxHistory(context, row);
  return { row, stored, record: publicOutbox(row, stored) };
}

function pageLimit(context: DacsHttpSqliteContext, limit: number): void {
  if (!safeUint(limit) || limit === 0 || limit > MAX_PAGE_SIZE) {
    throw context.error("http-store-query-malformed", "HTTP store page limit is invalid");
  }
}

function encodeInboxCursor(row: Readonly<InboxRow>): string {
  return Buffer.from(canonicalize([
    row.envelope_id,
    row.sender,
    row.audience,
  ])).toString("base64url");
}

function decodeInboxCursor(
  context: DacsHttpSqliteContext,
  cursor: string | undefined,
): readonly [string, string, string] {
  if (cursor === undefined) return ["", "", ""];
  try {
    if (!BASE64URL_RE.test(cursor) || cursor.includes("=")) throw new Error();
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw new Error();
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3 ||
        !hash(parsed[0]) || !demosAgentClaimReference(parsed[1]) ||
        !demosAgentClaimReference(parsed[2])) throw new Error();
    return parsed as unknown as readonly [string, string, string];
  } catch {
    throw context.error("http-store-cursor-malformed", "HTTP inbox cursor is malformed");
  }
}

function validateOutboxCursor(context: DacsHttpSqliteContext, cursor: string | undefined): string {
  if (cursor === undefined) return "";
  if (!hash(cursor)) {
    throw context.error("http-store-cursor-malformed", "HTTP outbox cursor is malformed");
  }
  return cursor;
}

function exactInboxReplay(
  existing: Readonly<StoredInbox>,
  authenticated: Readonly<DacsHttpAuthenticatedEnvelopeV1>,
): boolean {
  const retained = existing.authenticated;
  // Host specification section 12.4 keys replay by the signed envelope facts.
  // A fresh, valid identity resolution can have a different evidence hash; the
  // first evidence remains immutable in the retained reservation and history.
  return canonicalize(retained.envelope) === canonicalize(authenticated.envelope) &&
    retained.authenticationHash === authenticated.authenticationHash &&
    retained.identityRole === authenticated.identityRole;
}

function leaseMatches(
  retained: Readonly<DacsHttpOutboxLeaseV1> | undefined,
  supplied: Readonly<DacsHttpOutboxLeaseV1>,
): boolean {
  return retained !== undefined && retained.owner === supplied.owner &&
    retained.generation === supplied.generation && retained.expiresAt === supplied.expiresAt;
}

function captureLease(value: unknown): DacsHttpOutboxLeaseV1 | undefined {
  let captured: DacsHttpOutboxLeaseV1;
  try {
    captured = snapshot(value) as DacsHttpOutboxLeaseV1;
  } catch {
    return undefined;
  }
  return exactKeys(captured, ["owner", "generation", "expiresAt"]) &&
      leaseOwner(captured.owner) && safeUint(captured.generation) && captured.generation > 0 &&
      safeUint(captured.expiresAt)
    ? captured
    : undefined;
}

function retentionDeadline(receivedAt: number, configuredRetentionMs: number): number | undefined {
  if (!safeUint(receivedAt) || !safeUint(configuredRetentionMs)) return undefined;
  const deadline = receivedAt + configuredRetentionMs;
  return Number.isSafeInteger(deadline) ? deadline : undefined;
}

function assertRetention(
  context: DacsHttpSqliteContext,
  receivedAt: number,
  retainUntil: number,
  configuredRetentionMs: number,
): void {
  const deadline = retentionDeadline(receivedAt, configuredRetentionMs);
  if (!safeUint(retainUntil) || deadline === undefined || retainUntil < deadline) {
    throw context.error(
      "http-retention-too-short",
      "HTTP transport evidence is not retained for the configured minimum",
    );
  }
}

function readLifecycle(context: DacsHttpSqliteContext): Readonly<LifecycleRow> {
  const row = context.database.prepare(`
    SELECT * FROM dacs_http_lifecycle WHERE singleton = 1
  `).get() as LifecycleRow | undefined;
  if (!row || row.singleton !== 1 || !safeUint(row.rejected_admissions) ||
      !safeUint(row.purged_records) || !safeUint(row.purged_rows) ||
      !safeUint(row.purged_bytes) ||
      (row.last_rejection_at !== null && !safeUint(row.last_rejection_at)) ||
      (row.last_purge_at !== null && !safeUint(row.last_purge_at)) ||
      typeof row.inbox_purge_cursor !== "string" ||
      typeof row.outbox_purge_cursor !== "string" ||
      typeof row.outbox_expiry_cursor !== "string" ||
      ((row.last_rejection_reason === null) !== (row.last_rejection_dimension === null)) ||
      ((row.last_rejection_reason === null) !== (row.last_rejection_key === null)) ||
      ((row.last_rejection_reason === null) !== (row.last_rejection_at === null)) ||
      (row.last_rejection_reason !== null && !reasonCode(row.last_rejection_reason)) ||
      (row.last_rejection_key !== null && !nonEmpty(row.last_rejection_key)) ||
      (row.last_rejection_dimension !== null && ![
        "global", "peer", "job", "message-type", "revision", "disk",
      ].includes(row.last_rejection_dimension))) {
    throw context.error("http-store-lifecycle-corrupt", "HTTP lifecycle state is corrupt");
  }
  return row;
}

function globalUsage(context: DacsHttpSqliteContext): Readonly<{
  retainedRows: number;
  retainedBytes: number;
  reservedRows: number;
  reservedBytes: number;
}> {
  const row = context.database.prepare(`
    SELECT retained_rows, retained_bytes, reserved_rows, reserved_bytes
    FROM dacs_http_usage
    WHERE dimension = 'global' AND dimension_key = 'all'
  `).get() as Pick<
    UsageRow,
    "retained_rows" | "retained_bytes" | "reserved_rows" | "reserved_bytes"
  > | undefined;
  if (!row) {
    return { retainedRows: 0, retainedBytes: 0, reservedRows: 0, reservedBytes: 0 };
  }
  if (!safeUint(row.retained_rows) || !safeUint(row.retained_bytes) ||
      !safeUint(row.reserved_rows) || !safeUint(row.reserved_bytes)) {
    throw context.error("http-store-usage-corrupt", "HTTP global usage is corrupt");
  }
  return {
    retainedRows: row.retained_rows,
    retainedBytes: row.retained_bytes,
    reservedRows: row.reserved_rows,
    reservedBytes: row.reserved_bytes,
  };
}

function diagnostics(
  context: DacsHttpSqliteContext,
  limits: Readonly<DacsHttpStoreLimitsV1>,
): Readonly<DacsHttpStoreDiagnosticsV1> {
  const lifecycle = readLifecycle(context);
  const policyRow = context.database.prepare(`
    SELECT singleton, policy_hash, policy_json, bound_at
    FROM dacs_http_policy WHERE singleton = 1
  `).get() as PolicyRow | undefined;
  if (!policyRow || policyFromRow(context, policyRow) === undefined ||
      policyRow.policy_hash === null) {
    throw context.error("http-store-policy-corrupt", "HTTP policy is not durably bound");
  }
  const usage = globalUsage(context);
  let highest = 0;
  for (const retained of context.database.prepare(`
    SELECT dimension, dimension_key, retained_rows, retained_bytes,
      reserved_rows, reserved_bytes
    FROM dacs_http_usage
  `).all() as UsageRow[]) {
    if (!safeUint(retained.retained_rows) || !safeUint(retained.retained_bytes) ||
        !safeUint(retained.reserved_rows) || !safeUint(retained.reserved_bytes) ||
        !["global", "peer", "job", "message-type"].includes(retained.dimension)) {
      throw context.error("http-store-usage-corrupt", "HTTP usage row is corrupt");
    }
    const maximum = quotaFor(limits, retained.dimension);
    highest = Math.max(
      highest,
      (retained.retained_rows + retained.reserved_rows) / maximum.maxRows,
      (retained.retained_bytes + retained.reserved_bytes) / maximum.maxBytes,
    );
  }
  const now = observedTransportTime(context).now;
  const counts = context.database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM dacs_http_inbox WHERE state = 'pending') +
        (SELECT COUNT(*) FROM dacs_http_outbox WHERE state IN ('pending', 'sending'))
        AS active_records,
      (SELECT COUNT(*) FROM dacs_http_outbox WHERE state = 'operator-action')
        AS operator_records,
      (SELECT COUNT(*) FROM dacs_http_inbox
         WHERE state = 'disposed' AND retain_until <= ?) +
        (SELECT COUNT(*) FROM dacs_http_outbox
         WHERE state = 'acknowledged' AND retain_until <= ?) AS purgeable_records,
      MIN(oldest) AS oldest
    FROM (
      SELECT MIN(received_at) AS oldest FROM dacs_http_inbox
      UNION ALL SELECT MIN(created_at) AS oldest FROM dacs_http_outbox
    )
  `).get(now, now) as {
    active_records: number;
    operator_records: number;
    purgeable_records: number;
    oldest: number | null;
  };
  if (!safeUint(counts.active_records) || !safeUint(counts.operator_records) ||
      !safeUint(counts.purgeable_records) ||
      (counts.oldest !== null && !safeUint(counts.oldest))) {
    throw context.error("http-store-lifecycle-corrupt", "HTTP diagnostics are corrupt");
  }
  return Object.freeze({
    policyHash: policyRow.policy_hash,
    limits: snapshot(limits),
    global: Object.freeze({
      retainedRows: usage.retainedRows,
      retainedBytes: usage.retainedBytes,
      reservedRows: usage.reservedRows,
      reservedBytes: usage.reservedBytes,
      maxRows: limits.global.maxRows,
      maxBytes: limits.global.maxBytes,
    }),
    pressure: highest >= 1 ? "full" : highest >= 0.8 ? "warning" : "normal",
    activeRecords: counts.active_records,
    operatorActionRecords: counts.operator_records,
    purgeableRecords: counts.purgeable_records,
    rejectedAdmissions: lifecycle.rejected_admissions,
    ...(lifecycle.last_rejection_reason === null ? {} : {
      lastRejection: Object.freeze({
        reasonCode: lifecycle.last_rejection_reason,
        dimension: lifecycle.last_rejection_dimension as
          DacsHttpStoreDiagnosticsV1["lastRejection"] extends Readonly<infer R> ?
            R extends { dimension: infer D } ? D : never : never,
        dimensionKey: lifecycle.last_rejection_key!,
        occurredAt: lifecycle.last_rejection_at!,
      }),
    }),
    ...(counts.oldest === null ? {} : { oldestRetainedAt: counts.oldest }),
    ...(lifecycle.last_purge_at === null ? {} : { lastPurgeAt: lifecycle.last_purge_at }),
    purgedRecords: lifecycle.purged_records,
    purgedRows: lifecycle.purged_rows,
    purgedBytes: lifecycle.purged_bytes,
    expiryCursor: lifecycle.outbox_expiry_cursor,
    purgeCursor: `${lifecycle.inbox_purge_cursor}|${lifecycle.outbox_purge_cursor}`,
  });
}

function purgeLimit(
  context: DacsHttpSqliteContext,
  input: unknown,
  maximum: number,
): number {
  if (input === undefined) return maximum;
  let captured: unknown;
  try {
    captured = snapshot(input);
  } catch {
    throw context.error("http-store-query-malformed", "HTTP purge input is malformed");
  }
  if (!exactKeys(captured, [], ["limit"])) {
    throw context.error("http-store-query-malformed", "HTTP purge input is malformed");
  }
  const limit = captured.limit ?? maximum;
  if (!safeUint(limit) || limit === 0 || limit > maximum) {
    throw context.error("http-store-query-malformed", "HTTP purge limit is invalid");
  }
  return limit;
}

function retainedFootprint(
  context: DacsHttpSqliteContext,
  direction: "inbox" | "outbox",
  row: Readonly<InboxRow | OutboxRow>,
): Readonly<{ rows: number; bytes: number }> {
  const identity = direction === "inbox"
    ? [
        (row as InboxRow).sender,
        (row as InboxRow).audience,
        (row as InboxRow).envelope_id,
      ]
    : [(row as OutboxRow).envelope_id];
  const history = context.database.prepare(direction === "inbox" ? `
    SELECT COUNT(*) AS count,
      COALESCE(SUM(length(CAST(record_json AS BLOB))), 0) AS bytes
    FROM dacs_http_inbox_history
    WHERE sender = ? AND audience = ? AND envelope_id = ?
  ` : `
    SELECT COUNT(*) AS count,
      COALESCE(SUM(length(CAST(record_json AS BLOB))), 0) AS bytes
    FROM dacs_http_outbox_history WHERE envelope_id = ?
  `).get(...identity) as { count: number; bytes: number };
  if (!safeUint(history.count) || !safeUint(history.bytes)) {
    throw context.error("http-store-usage-corrupt", "HTTP history footprint is corrupt");
  }
  return {
    rows: history.count + 1,
    bytes: history.bytes + canonicalBytes(row.record_json),
  };
}

function purgeTerminal(
  context: DacsHttpSqliteContext,
  limits: Readonly<DacsHttpStoreLimitsV1>,
  direction: "inbox" | "outbox",
  input: unknown,
): Readonly<DacsHttpStorePurgeResultV1> {
  const limit = purgeLimit(context, input, limits.purgeBatchSize);
  return writeTransaction(context, () => {
    const now = transportTime(context);
    const lifecycle = readLifecycle(context);
    let candidates: (InboxRow | OutboxRow)[];
    if (direction === "inbox") {
      const cursor = decodeInboxCursor(
        context,
        lifecycle.inbox_purge_cursor || undefined,
      );
      const selected = context.database.prepare(`
          SELECT * FROM dacs_http_inbox
          WHERE (envelope_id, sender, audience) > (?, ?, ?)
            AND state = 'disposed'
          ORDER BY envelope_id, sender, audience LIMIT ?
        `).all(...cursor, limit) as InboxRow[];
      if (lifecycle.inbox_purge_cursor !== "" && selected.length < limit) {
        selected.push(...context.database.prepare(`
          SELECT * FROM dacs_http_inbox
          WHERE (envelope_id, sender, audience) <= (?, ?, ?)
            AND state = 'disposed'
          ORDER BY envelope_id, sender, audience LIMIT ?
        `).all(...cursor, limit - selected.length) as InboxRow[]);
      }
      candidates = selected;
    } else {
      const cursor = lifecycle.outbox_purge_cursor;
      const selected = context.database.prepare(`
          SELECT * FROM dacs_http_outbox
          WHERE envelope_id > ? AND state = 'acknowledged'
          ORDER BY envelope_id LIMIT ?
        `).all(cursor, limit) as OutboxRow[];
      if (cursor !== "" && selected.length < limit) {
        selected.push(...context.database.prepare(`
          SELECT * FROM dacs_http_outbox
          WHERE envelope_id <= ? AND state = 'acknowledged'
          ORDER BY envelope_id LIMIT ?
        `).all(cursor, limit - selected.length) as OutboxRow[]);
      }
      candidates = selected;
    }
    let purgedRows = 0;
    let purgedBytes = 0;
    let purgedRecords = 0;
    for (const row of candidates) {
      const stored = direction === "inbox"
        ? inboxStored(context, row as InboxRow)
        : outboxStored(context, row as OutboxRow);
      if (direction === "inbox") verifyInboxHistory(context, row as InboxRow);
      else verifyOutboxHistory(context, row as OutboxRow);
      if (row.retain_until > now) continue;
      const footprint = retainedFootprint(context, direction, row);
      const envelope = direction === "inbox"
        ? (stored as StoredInbox).authenticated.envelope
        : (stored as StoredOutbox).envelope;
      adjustUsage(context, undefined, direction, envelope, -footprint.rows, -footprint.bytes);
      if (direction === "inbox") {
        const inbox = row as InboxRow;
        context.database.prepare(`
          DELETE FROM dacs_http_inbox_history
          WHERE sender = ? AND audience = ? AND envelope_id = ?
        `).run(inbox.sender, inbox.audience, inbox.envelope_id);
        context.database.prepare(`
          DELETE FROM dacs_http_inbox
          WHERE sender = ? AND audience = ? AND envelope_id = ?
        `).run(inbox.sender, inbox.audience, inbox.envelope_id);
      } else {
        const outbox = row as OutboxRow;
        context.database.prepare(`
          DELETE FROM dacs_http_outbox_history WHERE envelope_id = ?
        `).run(outbox.envelope_id);
        context.database.prepare(`
          DELETE FROM dacs_http_outbox WHERE envelope_id = ?
        `).run(outbox.envelope_id);
      }
      purgedRecords += 1;
      purgedRows += footprint.rows;
      purgedBytes += footprint.bytes;
    }
    const nextCursor = candidates.length < limit
      ? ""
      : direction === "inbox"
        ? encodeInboxCursor(candidates.at(-1) as InboxRow)
        : (candidates.at(-1) as OutboxRow).envelope_id;
    const cursorColumn = direction === "inbox"
      ? "inbox_purge_cursor"
      : "outbox_purge_cursor";
    context.database.prepare(`
      UPDATE dacs_http_lifecycle SET
        ${cursorColumn} = ?, purged_records = purged_records + ?,
        purged_rows = purged_rows + ?, purged_bytes = purged_bytes + ?,
        last_purge_at = ? WHERE singleton = 1
    `).run(nextCursor, purgedRecords, purgedRows, purgedBytes, now);
    return Object.freeze({
      direction,
      examined: candidates.length,
      purgedRecords,
      purgedRows,
      purgedBytes,
      ...(nextCursor === "" ? {} : { nextCursor }),
    });
  });
}

export function createDacsHttpInboxSqliteStore(
  context: DacsHttpSqliteContext,
  rawOptions?: Readonly<DacsHttpTransportStoreOptionsV1>,
): DacsHttpInboxStoreV1 {
  const options = validateOptions(context, rawOptions);
  return {
    async readTime() {
      return context.beginImmediate(() => transportTime(context));
    },

    async reserve(rawReservation: Readonly<DacsHttpInboxReservationV1>) {
      let reservation: DacsHttpInboxReservationV1;
      try {
        reservation = snapshotRecord(
          context,
          rawReservation,
          ["authenticated", "retainUntil"],
        ) as unknown as DacsHttpInboxReservationV1;
      } catch {
        throw context.error("http-inbox-reservation-malformed", "HTTP inbox reservation is malformed");
      }
      return writeTransaction(context, () => {
        const authenticated = authenticatedEnvelope(
          context,
          reservation.authenticated,
          context.authority,
        );
        if (authenticated.envelope.type === "acknowledgement") {
          throw context.error(
            "http-inbox-acknowledgement-forbidden",
            "Acknowledgements are recorded against the outbox, not admitted to the action inbox",
          );
        }
        const senderRole = requiredSenderRole(authenticated.envelope);
        if (senderRole === undefined || authenticated.identityRole !== senderRole ||
            senderRole === context.role) {
          throw context.error(
            "http-inbox-role-incompatible",
            "HTTP inbox message direction is incompatible with the actor database",
          );
        }
        const envelope = authenticated.envelope;
        const existing = readInbox(
          context,
          envelope.sender,
          envelope.audience,
          envelope.envelopeId,
        );
        if (existing) {
          if (!exactInboxReplay(existing.stored, authenticated)) return { status: "conflict" };
          if (existing.stored.state === "pending") {
            return {
              status: "pending",
              record: existing.record,
              replay: "exact",
              receivedEnvelopeId: envelope.envelopeId,
            };
          }
          return {
            status: "existing",
            record: existing.record,
            replay: "exact",
            receivedEnvelopeId: envelope.envelopeId,
            disposition: existing.stored.disposition!,
            ...(existing.stored.reasonCode === undefined
              ? {}
              : { reasonCode: existing.stored.reasonCode }),
          };
        }
        const semantic = readInboxSemantic(
          context,
          envelope.sender,
          envelope.audience,
          semanticKey(envelope),
        );
        if (semantic) {
          if (semantic.stored.state === "pending") {
            return {
              status: "pending",
              record: semantic.record,
              replay: "semantic",
              receivedEnvelopeId: envelope.envelopeId,
            };
          }
          return {
            status: "existing",
            record: semantic.record,
            replay: "semantic",
            receivedEnvelopeId: envelope.envelopeId,
            disposition: semantic.stored.disposition!,
            ...(semantic.stored.reasonCode === undefined
              ? {}
              : { reasonCode: semantic.stored.reasonCode }),
          };
        }
        assertRetention(
          context,
          authenticated.receivedAt,
          reservation.retainUntil,
          options.retentionMs,
        );
        const now = transportTime(context);
        if (authenticated.receivedAt > now) {
          throw context.error("http-inbox-received-time-invalid", "HTTP inbox receipt time exceeds store time");
        }
        const stored: StoredInbox = {
          authenticated,
          state: "pending",
          retainUntil: reservation.retainUntil,
          revision: 1,
          updatedAt: Math.max(now, authenticated.receivedAt),
        };
        const row = insertInbox(context, options.limits, stored);
        return { status: "reserved", record: publicInbox(row, stored) };
      });
    },

    async load(rawInput) {
      const input = snapshotRecord(
        context,
        rawInput,
        ["sender", "audience", "envelopeId"],
      ) as unknown as typeof rawInput;
      if (!demosAgentClaimReference(input.sender) ||
          !demosAgentClaimReference(input.audience) ||
          !hash(input.envelopeId)) {
        throw context.error("http-inbox-query-malformed", "HTTP inbox lookup is malformed");
      }
      return context.readSnapshot(() =>
        readInbox(context, input.sender, input.audience, input.envelopeId)?.record);
    },

    async list(rawInput) {
      const input = snapshotRecord(
        context,
        rawInput,
        ["limit"],
        ["cursor", "state"],
      ) as unknown as typeof rawInput;
      pageLimit(context, input.limit);
      if (input.state !== undefined && input.state !== "pending" && input.state !== "disposed") {
        throw context.error("http-store-query-malformed", "HTTP inbox state filter is invalid");
      }
      const [envelopeId, sender, audience] = decodeInboxCursor(context, input.cursor);
      return context.readSnapshot(() => {
        const rows = context.database.prepare(`
          SELECT * FROM dacs_http_inbox
          WHERE (envelope_id, sender, audience) > (?, ?, ?)
            AND (? IS NULL OR state = ?)
          ORDER BY envelope_id, sender, audience LIMIT ?
        `).all(
          envelopeId, sender, audience, input.state ?? null, input.state ?? null,
          input.limit + 1,
        ) as InboxRow[];
        const decoded = rows.map((row) => {
          const stored = inboxStored(context, row);
          verifyInboxHistory(context, row);
          return publicInbox(row, stored);
        });
        const selected = decoded.slice(0, input.limit);
        return {
          items: selected,
          ...(decoded.length > selected.length && selected.length > 0
            ? { nextCursor: encodeInboxCursor(rows[selected.length - 1]!) }
            : {}),
        };
      });
    },

    async recordDisposition(rawInput) {
      let input: typeof rawInput;
      try {
        input = snapshotRecord(
          context,
          rawInput,
          ["sender", "audience", "envelopeId", "authenticationHash", "disposition"],
          ["reasonCode"],
        ) as unknown as typeof rawInput;
      } catch {
        return { status: "conflict" };
      }
      if (!demosAgentClaimReference(input.sender) ||
          !sameDemosAgentIdentity(input.audience, context.authority) ||
          !hash(input.envelopeId) || !hash(input.authenticationHash) ||
          (input.disposition !== "accepted" && input.disposition !== "existing" &&
            input.disposition !== "rejected") ||
          (input.disposition === "rejected" ? !reasonCode(input.reasonCode) :
            input.reasonCode !== undefined)) {
        return { status: "conflict" };
      }
      return writeTransaction(context, () => {
        const loaded = readInbox(context, input.sender, input.audience, input.envelopeId);
        if (!loaded) return { status: "missing" };
        if (loaded.stored.authenticated.authenticationHash !== input.authenticationHash) {
          return { status: "conflict" };
        }
        if (loaded.stored.state === "disposed") {
          const same = loaded.stored.disposition === input.disposition &&
            loaded.stored.reasonCode === input.reasonCode;
          return same
            ? { status: "existing", record: loaded.record }
            : { status: "conflict" };
        }
        const now = transportTime(context);
        const stored: StoredInbox = {
          ...snapshot(loaded.stored),
          state: "disposed",
          disposition: input.disposition,
          ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
          revision: loaded.stored.revision + 1,
          updatedAt: Math.max(now, loaded.stored.updatedAt),
        };
        const row = updateInbox(
          context,
          options.limits,
          loaded.row,
          loaded.stored,
          stored,
        );
        return row
          ? { status: "recorded", record: publicInbox(row, stored) }
          : { status: "conflict" };
      });
    },

    async extendRetention(rawInput) {
      const input = snapshotRecord(
        context,
        rawInput,
        ["jobId", "retainUntil"],
      ) as unknown as typeof rawInput;
      if (!isCanonicalJobId(input.jobId)) {
        throw context.error("http-retention-input-malformed", "HTTP retention job is malformed");
      }
      return writeTransaction(context, () => {
        const now = transportTime(context);
        assertRetention(context, now, input.retainUntil, options.retentionMs);
        const rows = context.database.prepare(`
          SELECT * FROM dacs_http_inbox WHERE job_id = ? ORDER BY envelope_id, sender, audience
        `).all(input.jobId) as InboxRow[];
        let count = 0;
        for (const row of rows) {
          const stored = inboxStored(context, row);
          verifyInboxHistory(context, row);
          if (stored.retainUntil >= input.retainUntil) continue;
          const next: StoredInbox = {
            ...snapshot(stored),
            retainUntil: input.retainUntil,
            revision: stored.revision + 1,
            updatedAt: Math.max(now, stored.updatedAt),
          };
          if (!updateInbox(context, options.limits, row, stored, next)) {
            throw context.error("http-store-write-raced", "HTTP inbox retention update raced");
          }
          count += 1;
        }
        return { status: count === 0 ? "existing" : "extended", count };
      });
    },

    async diagnostics() {
      return context.readSnapshot(() => diagnostics(context, options.limits));
    },

    async purge(input) {
      return purgeTerminal(context, options.limits, "inbox", input);
    },
  };
}

export function createDacsHttpOutboxSqliteStore(
  context: DacsHttpSqliteContext,
  rawOptions?: Readonly<DacsHttpTransportStoreOptionsV1>,
): DacsHttpOutboxStoreV1 {
  const options = validateOptions(context, rawOptions);

  const expire = (
    loaded: NonNullable<ReturnType<typeof readOutbox>>,
    now: number,
  ): NonNullable<ReturnType<typeof readOutbox>> => {
    if (loaded.stored.state === "acknowledged" ||
        loaded.stored.state === "operator-action" ||
        loaded.stored.envelope.expiresAt > now) return loaded;
    const stored: StoredOutbox = {
      ...snapshot(loaded.stored),
      state: "operator-action",
      reasonCode: "envelope-expired",
      revision: loaded.stored.revision + 1,
      updatedAt: Math.max(now, loaded.stored.updatedAt),
    };
    delete stored.lease;
    const row = updateOutbox(
      context,
      options.limits,
      loaded.row,
      loaded.stored,
      stored,
    );
    if (!row) throw context.error("http-store-write-raced", "HTTP outbox expiry update raced");
    return { row, stored, record: publicOutbox(row, stored) };
  };

  const validateIdentity = (envelopeId: string, envelopeHash: string): boolean =>
    hash(envelopeId) && hash(envelopeHash);

  return {
    async readTime() {
      return context.beginImmediate(() => transportTime(context));
    },

    async put(rawInput) {
      let envelope: DacsHttpEnvelopeV1;
      let input: typeof rawInput;
      try {
        input = snapshotRecord(
          context,
          rawInput,
          ["envelope", "retainUntil"],
        ) as unknown as typeof rawInput;
        envelope = input.envelope as DacsHttpEnvelopeV1;
      } catch {
        throw context.error("http-outbox-envelope-malformed", "HTTP outbox envelope is malformed");
      }
      const verified = verifyDacsHttpEnvelopeSelfSignatureV1(envelope);
      if (verified.status !== "valid" ||
          !sameDemosAgentIdentity(verified.envelope.sender, context.authority) ||
          verified.envelope.type === "acknowledgement" ||
          requiredSenderRole(verified.envelope) !== context.role) {
        throw context.error("http-outbox-envelope-invalid", "HTTP outbox envelope is invalid");
      }
      return writeTransaction(context, () => {
        const now = transportTime(context);
        const existing = readOutbox(context, envelope.envelopeId);
        if (existing) {
          const same = canonicalize(existing.stored.envelope) === canonicalize(envelope) &&
            existing.stored.envelopeHash === verified.authenticationHash;
          return same
            ? { status: "existing", record: existing.record }
            : { status: "conflict" };
        }
        const semantic = readOutboxSemantic(
          context,
          envelope.sender,
          envelope.audience,
          semanticKey(envelope),
        );
        if (semantic) return { status: "existing", record: semantic.record };
        if (envelope.expiresAt <= now) {
          throw context.error("http-outbox-envelope-expired", "Expired HTTP envelope cannot enter the outbox");
        }
        assertRetention(context, now, input.retainUntil, options.retentionMs);
        const stored: StoredOutbox = {
          envelope: verified.envelope,
          envelopeHash: verified.authenticationHash,
          state: "pending",
          generation: 0,
          attempts: 0,
          nextAttemptAt: now,
          retainUntil: input.retainUntil,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        const row = insertOutbox(context, options.limits, stored);
        return { status: "created", record: publicOutbox(row, stored) };
      });
    },

    async load(envelopeId) {
      if (!hash(envelopeId)) {
        throw context.error("http-outbox-query-malformed", "HTTP outbox lookup is malformed");
      }
      return context.readSnapshot(() => readOutbox(context, envelopeId)?.record);
    },

    async list(rawInput) {
      const input = snapshotRecord(
        context,
        rawInput,
        ["limit"],
        ["cursor", "state"],
      ) as unknown as typeof rawInput;
      pageLimit(context, input.limit);
      if (input.state !== undefined && ![
        "pending", "sending", "acknowledged", "operator-action",
      ].includes(input.state)) {
        throw context.error("http-store-query-malformed", "HTTP outbox state filter is invalid");
      }
      const cursor = validateOutboxCursor(context, input.cursor);
      return context.readSnapshot(() => {
        const rows = context.database.prepare(`
          SELECT * FROM dacs_http_outbox
          WHERE envelope_id > ? AND (? IS NULL OR state = ?)
          ORDER BY envelope_id LIMIT ?
        `).all(cursor, input.state ?? null, input.state ?? null, input.limit + 1) as OutboxRow[];
        const decoded = rows.map((row) => {
          const stored = outboxStored(context, row);
          verifyOutboxHistory(context, row);
          return publicOutbox(row, stored);
        });
        const selected = decoded.slice(0, input.limit);
        return {
          items: selected,
          ...(decoded.length > selected.length && selected.length > 0
            ? { nextCursor: selected.at(-1)!.envelope.envelopeId }
            : {}),
        };
      });
    },

    async listRunnable(rawInput) {
      const input = snapshotRecord(
        context,
        rawInput,
        ["limit"],
        ["cursor"],
      ) as unknown as typeof rawInput;
      pageLimit(context, input.limit);
      const cursor = validateOutboxCursor(context, input.cursor);
      return writeTransaction(context, () => {
        const now = transportTime(context);
        const lifecycle = readLifecycle(context);
        const scannedRows = context.database.prepare(`
          SELECT * FROM dacs_http_outbox INDEXED BY dacs_http_outbox_active_scan_idx
          WHERE envelope_id > ? AND state IN ('pending', 'sending')
          ORDER BY envelope_id LIMIT ?
        `).all(
          lifecycle.outbox_expiry_cursor,
          options.limits.expiryBatchSize,
        ) as OutboxRow[];
        for (const row of scannedRows) {
          const stored = outboxStored(context, row);
          verifyOutboxHistory(context, row);
          if (stored.envelope.expiresAt <= now) {
            expire({ row, stored, record: publicOutbox(row, stored) }, now);
          }
        }
        context.database.prepare(`
          UPDATE dacs_http_lifecycle SET outbox_expiry_cursor = ? WHERE singleton = 1
        `).run(
          scannedRows.length < options.limits.expiryBatchSize
            ? ""
            : scannedRows.at(-1)!.envelope_id,
        );
        const rows = context.database.prepare(`
          SELECT * FROM dacs_http_outbox INDEXED BY dacs_http_outbox_active_scan_idx
          WHERE envelope_id > ? AND state IN ('pending', 'sending')
          ORDER BY envelope_id LIMIT ?
        `).all(cursor, input.limit) as OutboxRow[];
        const decoded = rows.map((row) => {
          const stored = outboxStored(context, row);
          verifyOutboxHistory(context, row);
          return publicOutbox(row, stored);
        }).filter((record) =>
          record.envelope.expiresAt > now &&
          ((record.state === "pending" && record.nextAttemptAt <= now) ||
            (record.state === "sending" && record.lease!.expiresAt <= now))
        );
        return {
          items: decoded,
          ...(rows.length === input.limit
            ? { nextCursor: rows.at(-1)!.envelope_id }
            : {}),
        };
      });
    },

    async claim(rawInput) {
      let input: typeof rawInput;
      try {
        input = snapshotRecord(
          context,
          rawInput,
          ["envelopeId", "envelopeHash", "owner", "leaseDurationMs"],
        ) as unknown as typeof rawInput;
      } catch {
        return { status: "stale" };
      }
      if (!validateIdentity(input.envelopeId, input.envelopeHash) ||
          !leaseOwner(input.owner) || !safeUint(input.leaseDurationMs) ||
          input.leaseDurationMs === 0) return { status: "stale" };
      return writeTransaction(context, () => {
        let loaded = readOutbox(context, input.envelopeId);
        if (!loaded) return { status: "missing" };
        if (loaded.stored.envelopeHash !== input.envelopeHash) return { status: "stale" };
        const now = transportTime(context);
        loaded = expire(loaded, now);
        if (loaded.stored.state === "acknowledged") {
          return { status: "acknowledged", record: loaded.record };
        }
        if (loaded.stored.state === "operator-action") {
          return { status: "operator-action", record: loaded.record };
        }
        if (loaded.stored.state === "pending" && loaded.stored.nextAttemptAt > now) {
          return { status: "not-runnable", record: loaded.record };
        }
        if (loaded.stored.state === "sending" && loaded.stored.lease!.expiresAt > now) {
          return { status: "waiting", record: loaded.record, lease: loaded.stored.lease! };
        }
        const generation = loaded.stored.generation + 1;
        const expiresAt = now + input.leaseDurationMs;
        if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(expiresAt)) {
          throw context.error("http-outbox-lease-overflow", "HTTP outbox lease overflows");
        }
        const lease: DacsHttpOutboxLeaseV1 = {
          owner: input.owner,
          generation,
          expiresAt,
        };
        const stored: StoredOutbox = {
          ...snapshot(loaded.stored),
          state: "sending",
          generation,
          attempts: loaded.stored.attempts + 1,
          lease,
          revision: loaded.stored.revision + 1,
          updatedAt: Math.max(now, loaded.stored.updatedAt),
        };
        delete stored.reasonCode;
        const row = updateOutbox(
          context,
          options.limits,
          loaded.row,
          loaded.stored,
          stored,
        );
        return row
          ? { status: "acquired", record: publicOutbox(row, stored), lease }
          : { status: "stale" };
      });
    },

    async isCurrent(rawInput) {
      let input: typeof rawInput;
      try {
        input = snapshotRecord(
          context,
          rawInput,
          ["envelopeId", "envelopeHash", "lease"],
        ) as unknown as typeof rawInput;
      } catch {
        return false;
      }
      const lease = captureLease(input.lease);
      if (!lease || !validateIdentity(input.envelopeId, input.envelopeHash)) return false;
      return writeTransaction(context, () => {
        const loaded = readOutbox(context, input.envelopeId);
        if (!loaded || loaded.stored.envelopeHash !== input.envelopeHash ||
            loaded.stored.state !== "sending" ||
            !leaseMatches(loaded.stored.lease, lease)) return false;
        return lease.expiresAt > transportTime(context) &&
          loaded.stored.envelope.expiresAt > transportTime(context);
      });
    },

    async recordSendFailure(rawInput) {
      let input: typeof rawInput;
      try {
        input = snapshotRecord(
          context,
          rawInput,
          ["envelopeId", "envelopeHash", "lease", "reasonCode"],
        ) as unknown as typeof rawInput;
      } catch {
        return { status: "conflict" };
      }
      const lease = captureLease(input.lease);
      if (!lease || !validateIdentity(input.envelopeId, input.envelopeHash) ||
          !reasonCode(input.reasonCode)) return { status: "conflict" };
      return writeTransaction(context, () => {
        const loaded = readOutbox(context, input.envelopeId);
        if (!loaded) return { status: "missing" };
        if (loaded.stored.envelopeHash !== input.envelopeHash) return { status: "conflict" };
        if (loaded.stored.state === "acknowledged") {
          return { status: "existing", record: loaded.record };
        }
        const now = transportTime(context);
        if (loaded.stored.state !== "sending" || !leaseMatches(loaded.stored.lease, lease) ||
            lease.expiresAt <= now) return { status: "stale" };
        const exponent = Math.min(30, Math.max(0, loaded.stored.attempts - 1));
        const baseDelayMs = Math.min(
          DACS_HTTP_MAXIMUM_RETRY_DELAY_MS,
          DACS_HTTP_INITIAL_RETRY_DELAY_MS * (2 ** exponent),
        );
        let jitter: number;
        try {
          jitter = options.jitter({
            envelopeId: input.envelopeId,
            attempt: loaded.stored.attempts,
            baseDelayMs,
          });
        } catch {
          throw context.error("http-outbox-jitter-invalid", "HTTP retry jitter failed");
        }
        if (!Number.isInteger(jitter) || Math.abs(jitter) > Math.floor(baseDelayMs / 2)) {
          throw context.error("http-outbox-jitter-invalid", "HTTP retry jitter is out of bounds");
        }
        const delay = Math.max(0, Math.min(
          DACS_HTTP_MAXIMUM_RETRY_DELAY_MS,
          baseDelayMs + jitter,
        ));
        const computed = now + delay;
        if (!Number.isSafeInteger(computed)) {
          throw context.error("http-outbox-retry-overflow", "HTTP outbox retry time overflows");
        }
        const stored: StoredOutbox = {
          ...snapshot(loaded.stored),
          state: "pending",
          nextAttemptAt: Math.min(computed, loaded.stored.envelope.expiresAt),
          reasonCode: input.reasonCode,
          revision: loaded.stored.revision + 1,
          updatedAt: Math.max(now, loaded.stored.updatedAt),
        };
        delete stored.lease;
        const row = updateOutbox(
          context,
          options.limits,
          loaded.row,
          loaded.stored,
          stored,
        );
        return row
          ? { status: "recorded", record: publicOutbox(row, stored) }
          : { status: "stale" };
      });
    },

    async requireOperatorAction(rawInput) {
      let input: typeof rawInput;
      try {
        input = snapshotRecord(
          context,
          rawInput,
          ["envelopeId", "envelopeHash", "lease", "reasonCode"],
        ) as unknown as typeof rawInput;
      } catch {
        return { status: "conflict" };
      }
      const lease = captureLease(input.lease);
      if (!lease || !validateIdentity(input.envelopeId, input.envelopeHash) ||
          !reasonCode(input.reasonCode)) return { status: "conflict" };
      return writeTransaction(context, () => {
        const loaded = readOutbox(context, input.envelopeId);
        if (!loaded) return { status: "missing" };
        if (loaded.stored.envelopeHash !== input.envelopeHash) return { status: "conflict" };
        if (loaded.stored.state === "acknowledged" ||
            (loaded.stored.state === "operator-action" &&
              loaded.stored.reasonCode === input.reasonCode)) {
          return { status: "existing", record: loaded.record };
        }
        const now = transportTime(context);
        if (loaded.stored.state !== "sending" || !leaseMatches(loaded.stored.lease, lease) ||
            lease.expiresAt <= now) return { status: "stale" };
        const stored: StoredOutbox = {
          ...snapshot(loaded.stored),
          state: "operator-action",
          reasonCode: input.reasonCode,
          revision: loaded.stored.revision + 1,
          updatedAt: Math.max(now, loaded.stored.updatedAt),
        };
        delete stored.lease;
        const row = updateOutbox(
          context,
          options.limits,
          loaded.row,
          loaded.stored,
          stored,
        );
        return row
          ? { status: "recorded", record: publicOutbox(row, stored) }
          : { status: "stale" };
      });
    },

    async acknowledge(rawInput) {
      let input: typeof rawInput;
      try {
        input = snapshotRecord(
          context,
          rawInput,
          ["envelopeId", "envelopeHash", "acknowledgement"],
        ) as unknown as typeof rawInput;
      } catch {
        return { status: "conflict" };
      }
      if (!validateIdentity(input.envelopeId, input.envelopeHash)) {
        return { status: "conflict" };
      }
      return writeTransaction(context, () => {
        const now = transportTime(context);
        const loaded = readOutbox(context, input.envelopeId);
        if (!loaded) return { status: "missing" };
        if (loaded.stored.envelopeHash !== input.envelopeHash) return { status: "conflict" };
        let acknowledgement: DacsHttpAuthenticatedEnvelopeV1;
        try {
          acknowledgement = authenticatedEnvelope(context, input.acknowledgement);
        } catch {
          return { status: "conflict" };
        }
        if (acknowledgement.receivedAt > now) return { status: "conflict" };
        const binding = verifyDacsHttpAcknowledgementBindingV1(
          acknowledgement,
          loaded.stored.envelope,
        );
        if (binding.status !== "valid" ||
            !sameDemosAgentIdentity(acknowledgement.envelope.audience, context.authority) ||
            acknowledgement.identityRole === context.role) {
          return { status: "conflict" };
        }
        if (loaded.stored.state === "acknowledged") {
          const retained = loaded.stored.acknowledgement!;
          const retainedBinding = verifyDacsHttpAcknowledgementBindingV1(
            retained,
            loaded.stored.envelope,
          );
          if (retainedBinding.status !== "valid" ||
              retainedBinding.disposition !== binding.disposition ||
              canonicalize(retained.envelope.payload) !==
                canonicalize(acknowledgement.envelope.payload)) {
            return { status: "conflict" };
          }
          // Equivalent ACKs are deliberately O(1): a fresh nonce, later local
          // receipt time, or longer process option cannot mutate evidence or
          // extend its replay window. Retention changes require the explicit
          // job-scoped extendRetention transition.
          return { status: "existing", record: loaded.record };
        }
        const requiredRetainUntil = retentionDeadline(
          acknowledgement.receivedAt,
          options.retentionMs,
        );
        if (requiredRetainUntil === undefined) {
          throw context.error(
            "http-retention-overflow",
            "HTTP acknowledgement retention deadline overflows",
          );
        }
        const stored: StoredOutbox = {
          ...snapshot(loaded.stored),
          state: "acknowledged",
          acknowledgement,
          acknowledgementRetentionMs: options.retentionMs,
          retainUntil: Math.max(loaded.stored.retainUntil, requiredRetainUntil),
          revision: loaded.stored.revision + 1,
          updatedAt: Math.max(now, loaded.stored.updatedAt),
        };
        delete stored.lease;
        delete stored.reasonCode;
        const row = updateOutbox(
          context,
          options.limits,
          loaded.row,
          loaded.stored,
          stored,
        );
        return row
          ? { status: "recorded", record: publicOutbox(row, stored) }
          : { status: "conflict" };
      });
    },

    async extendRetention(rawInput) {
      const input = snapshotRecord(
        context,
        rawInput,
        ["jobId", "retainUntil"],
      ) as unknown as typeof rawInput;
      if (!isCanonicalJobId(input.jobId)) {
        throw context.error("http-retention-input-malformed", "HTTP retention job is malformed");
      }
      return writeTransaction(context, () => {
        const now = transportTime(context);
        assertRetention(context, now, input.retainUntil, options.retentionMs);
        const rows = context.database.prepare(`
          SELECT * FROM dacs_http_outbox WHERE job_id = ? ORDER BY envelope_id
        `).all(input.jobId) as OutboxRow[];
        let count = 0;
        for (const row of rows) {
          const stored = outboxStored(context, row);
          verifyOutboxHistory(context, row);
          if (stored.retainUntil >= input.retainUntil) continue;
          const next: StoredOutbox = {
            ...snapshot(stored),
            retainUntil: input.retainUntil,
            revision: stored.revision + 1,
            updatedAt: Math.max(now, stored.updatedAt),
          };
          if (!updateOutbox(context, options.limits, row, stored, next)) {
            throw context.error("http-store-write-raced", "HTTP outbox retention update raced");
          }
          count += 1;
        }
        return { status: count === 0 ? "existing" : "extended", count };
      });
    },

    async diagnostics() {
      return context.readSnapshot(() => diagnostics(context, options.limits));
    },

    async purge(input) {
      return purgeTerminal(context, options.limits, "outbox", input);
    },
  };
}

function usageMapKey(dimension: UsageDimension, key: string): string {
  return canonicalize([dimension, key]);
}

function accumulateExpectedUsage(
  expected: Map<string, UsageRow>,
  direction: "inbox" | "outbox",
  envelope: Readonly<DacsHttpEnvelopeV1>,
  footprint: Readonly<{ rows: number; bytes: number }>,
  reserve: Readonly<{ rows: number; bytes: number }>,
): void {
  for (const entry of usageDimensions(direction, envelope)) {
    const mapKey = usageMapKey(entry.dimension, entry.key);
    const current = expected.get(mapKey);
    expected.set(mapKey, {
      dimension: entry.dimension,
      dimension_key: entry.key,
      retained_rows: (current?.retained_rows ?? 0) + footprint.rows,
      retained_bytes: (current?.retained_bytes ?? 0) + footprint.bytes,
      reserved_rows: (current?.reserved_rows ?? 0) + reserve.rows,
      reserved_bytes: (current?.reserved_bytes ?? 0) + reserve.bytes,
    });
  }
}

/** Backfills only already-authenticated v6 rows while the v7 migration is atomic. */
export function migrateDacsHttpSqliteV7Rows(context: DacsHttpSqliteContext): void {
  const existingUsage = context.database.prepare(`
    SELECT 1 FROM dacs_http_usage LIMIT 1
  `).get();
  if (existingUsage !== undefined) {
    throw context.error("http-store-migration-invalid", "HTTP v7 usage is not empty");
  }
  const semanticIdentities = new Set<string>();
  for (const row of context.database.prepare(`
    SELECT * FROM dacs_http_inbox ORDER BY envelope_id, sender, audience
  `).all() as InboxRow[]) {
    const stored = inboxStored(context, row);
    verifyInboxHistory(context, row);
    if (stored.revision + inboxReservedRevisions(stored) >
        DEFAULT_LIMITS.maxRevisionsPerMessage) {
      throw context.error(
        "http-store-migration-revision-limit",
        "Legacy HTTP inbox history exceeds the supported revision bound",
      );
    }
    const key = semanticKey(stored.authenticated.envelope);
    const identity = canonicalize(["inbox", row.sender, row.audience, key]);
    if (semanticIdentities.has(identity)) {
      throw context.error(
        "http-store-semantic-conflict",
        "Legacy HTTP inbox has duplicate semantic messages",
      );
    }
    semanticIdentities.add(identity);
    const updated = context.database.prepare(`
      UPDATE dacs_http_inbox SET semantic_key = ?
      WHERE sender = ? AND audience = ? AND envelope_id = ? AND semantic_key IS NULL
    `).run(key, row.sender, row.audience, row.envelope_id);
    if (updated.changes !== 1) {
      throw context.error("http-store-migration-raced", "HTTP inbox migration raced");
    }
    const footprint = retainedFootprint(context, "inbox", row);
    const reserve = terminalReserve("inbox", stored);
    adjustUsage(
      context,
      undefined,
      "inbox",
      stored.authenticated.envelope,
      footprint.rows,
      footprint.bytes,
      reserve.rows,
      reserve.bytes,
    );
  }
  for (const row of context.database.prepare(`
    SELECT * FROM dacs_http_outbox ORDER BY envelope_id
  `).all() as OutboxRow[]) {
    const stored = outboxStored(context, row);
    verifyOutboxHistory(context, row);
    if (stored.revision + outboxReservedRevisions(stored) >
        DEFAULT_LIMITS.maxRevisionsPerMessage) {
      throw context.error(
        "http-store-migration-revision-limit",
        "Legacy HTTP outbox history exceeds the supported revision bound",
      );
    }
    const key = semanticKey(stored.envelope);
    const identity = canonicalize(["outbox", row.sender, row.audience, key]);
    if (semanticIdentities.has(identity)) {
      throw context.error(
        "http-store-semantic-conflict",
        "Legacy HTTP outbox has duplicate semantic messages",
      );
    }
    semanticIdentities.add(identity);
    const updated = context.database.prepare(`
      UPDATE dacs_http_outbox SET semantic_key = ?
      WHERE envelope_id = ? AND semantic_key IS NULL
    `).run(key, row.envelope_id);
    if (updated.changes !== 1) {
      throw context.error("http-store-migration-raced", "HTTP outbox migration raced");
    }
    const footprint = retainedFootprint(context, "outbox", row);
    const reserve = terminalReserve("outbox", stored);
    adjustUsage(
      context,
      undefined,
      "outbox",
      stored.envelope,
      footprint.rows,
      footprint.bytes,
      reserve.rows,
      reserve.bytes,
    );
  }
  for (const usage of context.database.prepare(`
    SELECT dimension, dimension_key, retained_rows, retained_bytes,
      reserved_rows, reserved_bytes
    FROM dacs_http_usage
  `).all() as UsageRow[]) {
    const maximum = quotaFor(DEFAULT_LIMITS, usage.dimension);
    if (!safeUint(usage.retained_rows) || !safeUint(usage.retained_bytes) ||
        !safeUint(usage.reserved_rows) || !safeUint(usage.reserved_bytes) ||
        usage.retained_rows + usage.reserved_rows > maximum.maxRows ||
        usage.retained_bytes + usage.reserved_bytes > maximum.maxBytes) {
      throw context.error(
        "http-store-migration-quota-exceeded",
        "Legacy HTTP state exceeds the finite v7 admission policy",
      );
    }
  }
}

export function verifyDacsHttpSqliteRows(
  context: DacsHttpSqliteContext,
  lifecycleSchema = false,
): void {
  const clock = context.database.prepare(`
    SELECT singleton, last_time FROM dacs_http_clock LIMIT 2
  `).all() as { singleton: number; last_time: number }[];
  if (clock.length !== 1 || clock[0]!.singleton !== 1 || !safeUint(clock[0]!.last_time)) {
    throw context.error("http-store-clock-invalid", "HTTP transport clock row is corrupt");
  }
  for (const row of context.database.prepare(`
    SELECT * FROM dacs_http_inbox ORDER BY envelope_id, sender, audience
  `).iterate() as IterableIterator<InboxRow>) {
    const stored = inboxStored(context, row);
    verifyInboxHistory(context, row);
    if (lifecycleSchema && (!hash(row.semantic_key) ||
        row.semantic_key !== semanticKey(stored.authenticated.envelope))) {
      throw context.error("http-store-semantic-corrupt", "HTTP inbox semantic key is corrupt");
    }
  }
  for (const row of context.database.prepare(`
    SELECT * FROM dacs_http_outbox ORDER BY envelope_id
  `).iterate() as IterableIterator<OutboxRow>) {
    const stored = outboxStored(context, row);
    verifyOutboxHistory(context, row);
    if (lifecycleSchema && (!hash(row.semantic_key) ||
        row.semantic_key !== semanticKey(stored.envelope))) {
      throw context.error("http-store-semantic-corrupt", "HTTP outbox semantic key is corrupt");
    }
  }
  const inboxOrphan = context.database.prepare(`
    SELECT 1 FROM dacs_http_inbox_history AS history
    LEFT JOIN dacs_http_inbox AS records
      ON records.sender = history.sender AND records.audience = history.audience
      AND records.envelope_id = history.envelope_id
    WHERE records.envelope_id IS NULL LIMIT 1
  `).get();
  const outboxOrphan = context.database.prepare(`
    SELECT 1 FROM dacs_http_outbox_history AS history
    LEFT JOIN dacs_http_outbox AS records ON records.envelope_id = history.envelope_id
    WHERE records.envelope_id IS NULL LIMIT 1
  `).get();
  if (inboxOrphan !== undefined || outboxOrphan !== undefined) {
    throw context.error("http-store-history-corrupt", "HTTP transport history has no record");
  }
  if (!lifecycleSchema) return;

  const policyRows = context.database.prepare(`
    SELECT singleton, policy_hash, policy_json, bound_at FROM dacs_http_policy LIMIT 2
  `).all() as PolicyRow[];
  if (policyRows.length !== 1) {
    throw context.error("http-store-policy-corrupt", "HTTP policy singleton is missing");
  }
  const retainedPolicy = policyFromRow(context, policyRows[0]!);
  const lifecycle = readLifecycle(context);
  if ((lifecycle.outbox_expiry_cursor !== "" && !hash(lifecycle.outbox_expiry_cursor)) ||
      (lifecycle.outbox_purge_cursor !== "" && !hash(lifecycle.outbox_purge_cursor))) {
    throw context.error("http-store-lifecycle-corrupt", "HTTP lifecycle cursor is corrupt");
  }
  if (lifecycle.inbox_purge_cursor !== "") {
    decodeInboxCursor(context, lifecycle.inbox_purge_cursor);
  }

  const expected = new Map<string, UsageRow>();
  for (const row of context.database.prepare(`
    SELECT * FROM dacs_http_inbox ORDER BY envelope_id, sender, audience
  `).iterate() as IterableIterator<InboxRow>) {
    const stored = inboxStored(context, row);
    if (retainedPolicy !== undefined &&
        stored.revision + inboxReservedRevisions(stored) >
          retainedPolicy.maxRevisionsPerMessage) {
      throw context.error(
        "http-store-usage-corrupt",
        "HTTP inbox has no capacity for its reserved terminal transition",
      );
    }
    accumulateExpectedUsage(
      expected,
      "inbox",
      stored.authenticated.envelope,
      retainedFootprint(context, "inbox", row),
      terminalReserve("inbox", stored),
    );
  }
  for (const row of context.database.prepare(`
    SELECT * FROM dacs_http_outbox ORDER BY envelope_id
  `).iterate() as IterableIterator<OutboxRow>) {
    const stored = outboxStored(context, row);
    if (retainedPolicy !== undefined &&
        stored.revision + outboxReservedRevisions(stored) >
          retainedPolicy.maxRevisionsPerMessage) {
      throw context.error(
        "http-store-usage-corrupt",
        "HTTP outbox has no capacity for its reserved terminal transitions",
      );
    }
    accumulateExpectedUsage(
      expected,
      "outbox",
      stored.envelope,
      retainedFootprint(context, "outbox", row),
      terminalReserve("outbox", stored),
    );
  }
  const retainedUsage = context.database.prepare(`
    SELECT dimension, dimension_key, retained_rows, retained_bytes,
      reserved_rows, reserved_bytes
    FROM dacs_http_usage ORDER BY dimension, dimension_key
  `).all() as UsageRow[];
  const actual = new Map<string, UsageRow>();
  for (const row of retainedUsage) {
    if (!safeUint(row.retained_rows) || row.retained_rows === 0 ||
        !safeUint(row.retained_bytes) || row.retained_bytes === 0 ||
        !safeUint(row.reserved_rows) || !safeUint(row.reserved_bytes) ||
        !["global", "peer", "job", "message-type"].includes(row.dimension) ||
        !nonEmpty(row.dimension_key)) {
      throw context.error("http-store-usage-corrupt", "HTTP usage row is malformed");
    }
    if (retainedPolicy !== undefined) {
      const maximum = quotaFor(retainedPolicy, row.dimension);
      if (row.retained_rows + row.reserved_rows > maximum.maxRows ||
          row.retained_bytes + row.reserved_bytes > maximum.maxBytes) {
        throw context.error(
          "http-store-usage-corrupt",
          "HTTP usage exceeds the database-bound policy",
        );
      }
    }
    actual.set(usageMapKey(row.dimension, row.dimension_key), row);
  }
  if (canonicalize([...actual.entries()].sort()) !==
      canonicalize([...expected.entries()].sort())) {
    throw context.error("http-store-usage-corrupt", "HTTP usage differs from retained rows");
  }
  if (retainedPolicy !== undefined) {
    const revision = context.database.prepare(`
      SELECT MAX(revision) AS maximum FROM (
        SELECT revision FROM dacs_http_inbox
        UNION ALL SELECT revision FROM dacs_http_outbox
      )
    `).get() as { maximum: number | null };
    if (revision.maximum !== null &&
        (!safeUint(revision.maximum) ||
          revision.maximum > retainedPolicy.maxRevisionsPerMessage)) {
      throw context.error(
        "http-store-usage-corrupt",
        "HTTP revisions exceed the database-bound policy",
      );
    }
    const exhaustedActive = context.database.prepare(`
      SELECT 1 FROM dacs_http_inbox
      WHERE state = 'pending' AND revision >= ?
      UNION ALL
      SELECT 1 FROM dacs_http_outbox
      WHERE state IN ('pending', 'sending') AND revision >= ?
      LIMIT 1
    `).get(
      retainedPolicy.maxRevisionsPerMessage,
      retainedPolicy.maxRevisionsPerMessage,
    );
    if (exhaustedActive !== undefined) {
      throw context.error(
        "http-store-usage-corrupt",
        "HTTP active work has no reserved terminal revision",
      );
    }
  }
}
