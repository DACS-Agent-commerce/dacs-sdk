import { types as nodeTypes } from "node:util";

import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  parseCanonicalClaimReference,
  sameCanonicalClaimIdentity,
} from "@kynesyslabs/dacs/identity";
import { isCanonicalJobId } from "@kynesyslabs/dacs/negotiate";
import type BetterSqlite3 from "better-sqlite3";

import {
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
    const retained: Record<string, unknown> = {};
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

function recordJson(value: StoredInbox | StoredOutbox): string {
  return canonicalize(value);
}

function transportTime(context: DacsHttpSqliteContext): number {
  const row = context.database.prepare(`
    SELECT last_time FROM dacs_http_clock WHERE singleton = 1
  `).get() as { last_time?: unknown } | undefined;
  const system = context.systemTime();
  if (!row || !safeUint(row.last_time) || !safeUint(system)) {
    throw context.error("http-store-clock-invalid", "HTTP transport store clock is invalid");
  }
  const now = Math.max(row.last_time, system);
  if (now !== row.last_time) {
    const result = context.database.prepare(`
      UPDATE dacs_http_clock SET last_time = ?
      WHERE singleton = 1 AND last_time = ?
    `).run(now, row.last_time);
    if (result.changes !== 1) {
      throw context.error("http-store-clock-raced", "HTTP transport store clock raced");
    }
  }
  return now;
}

function validateOptions(
  context: DacsHttpSqliteContext,
  raw: Readonly<DacsHttpTransportStoreOptionsV1> | undefined,
): Readonly<{ retentionMs: number; jitter: DacsHttpOutboxRetryJitterV1 }> {
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
  if (keys.some((key) => key !== "retentionMs" && key !== "retryJitter")) {
    throw context.error("http-store-options-malformed", "HTTP store options are malformed");
  }
  const retentionMs = descriptors.retentionMs?.value ?? DACS_HTTP_MINIMUM_RETENTION_MS;
  const retryJitter = descriptors.retryJitter?.value;
  if (!safeUint(retentionMs) || retentionMs < DACS_HTTP_MINIMUM_RETENTION_MS) {
    throw context.error(
      "http-retention-too-short",
      "HTTP transport retention cannot be shorter than seven days",
    );
  }
  if (retryJitter !== undefined && typeof retryJitter !== "function") {
    throw context.error("http-store-options-malformed", "HTTP retry jitter must be callable");
  }
  return Object.freeze({
    retentionMs,
    jitter: retryJitter ?? deterministicRetryJitter,
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
    throw context.error("http-inbox-record-corrupt", "HTTP inbox record is not canonical authenticated data");
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
      row.revision !== value.revision || row.updated_at !== value.updatedAt) {
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
    throw context.error("http-outbox-record-corrupt", "HTTP outbox record is not canonical authenticated data");
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
      row.updated_at !== value.updatedAt) {
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

function insertInbox(context: DacsHttpSqliteContext, record: StoredInbox): InboxRow {
  const envelope = record.authenticated.envelope;
  const json = recordJson(record);
  const recordHashValue = sha256Hex(json);
  context.database.prepare(`
    INSERT INTO dacs_http_inbox (
      sender, audience, envelope_id, job_id, state, authentication_hash,
      identity_evidence_hash, payload_hash, nonce, disposition, reason_code,
      received_at, retain_until, revision, record_hash, record_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    envelope.sender, envelope.audience, envelope.envelopeId, envelope.jobId,
    record.state, record.authenticated.authenticationHash,
    record.authenticated.identityEvidenceHash, envelope.payloadHash, envelope.nonce,
    record.disposition ?? null, record.reasonCode ?? null,
    record.authenticated.receivedAt, record.retainUntil, record.revision,
    recordHashValue, json, record.updatedAt,
  );
  appendInboxHistory(context, record, json, recordHashValue);
  return context.database.prepare(`
    SELECT * FROM dacs_http_inbox
    WHERE sender = ? AND audience = ? AND envelope_id = ?
  `).get(envelope.sender, envelope.audience, envelope.envelopeId) as InboxRow;
}

function updateInbox(
  context: DacsHttpSqliteContext,
  current: Readonly<InboxRow>,
  record: StoredInbox,
): InboxRow | undefined {
  const json = recordJson(record);
  const recordHashValue = sha256Hex(json);
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

function insertOutbox(context: DacsHttpSqliteContext, record: StoredOutbox): OutboxRow {
  const json = recordJson(record);
  const recordHashValue = sha256Hex(json);
  context.database.prepare(`
    INSERT INTO dacs_http_outbox (
      envelope_id, envelope_hash, job_id, sender, audience, payload_hash, state,
      generation, attempts, owner, lease_expires_at, next_attempt_at,
      acknowledgement_hash, reason_code, retain_until, revision, record_hash,
      record_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.envelope.envelopeId, record.envelopeHash, record.envelope.jobId,
    record.envelope.sender, record.envelope.audience, record.envelope.payloadHash,
    record.state, record.generation, record.attempts, record.lease?.owner ?? null,
    record.lease?.expiresAt ?? null, record.nextAttemptAt,
    record.acknowledgement?.authenticationHash ?? null, record.reasonCode ?? null,
    record.retainUntil, record.revision, recordHashValue, json,
    record.createdAt, record.updatedAt,
  );
  appendOutboxHistory(context, record, json, recordHashValue);
  return context.database.prepare(`SELECT * FROM dacs_http_outbox WHERE envelope_id = ?`)
    .get(record.envelope.envelopeId) as OutboxRow;
}

function updateOutbox(
  context: DacsHttpSqliteContext,
  current: Readonly<OutboxRow>,
  record: StoredOutbox,
): OutboxRow | undefined {
  const json = recordJson(record);
  const recordHashValue = sha256Hex(json);
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
        parsed.some((entry) => typeof entry !== "string")) throw new Error();
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
  return nonEmpty(captured.owner) && safeUint(captured.generation) && captured.generation > 0 &&
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
        reservation = snapshot(rawReservation) as DacsHttpInboxReservationV1;
      } catch {
        throw context.error("http-inbox-reservation-malformed", "HTTP inbox reservation is malformed");
      }
      return context.beginImmediate(() => {
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
            return { status: "pending", record: existing.record };
          }
          return {
            status: "existing",
            record: existing.record,
            disposition: existing.stored.disposition!,
            ...(existing.stored.reasonCode === undefined
              ? {}
              : { reasonCode: existing.stored.reasonCode }),
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
        const row = insertInbox(context, stored);
        return { status: "reserved", record: publicInbox(row, stored) };
      });
    },

    async load(input) {
      if (!demosAgentClaimReference(input.sender) ||
          !demosAgentClaimReference(input.audience) ||
          !hash(input.envelopeId)) {
        throw context.error("http-inbox-query-malformed", "HTTP inbox lookup is malformed");
      }
      return context.readSnapshot(() =>
        readInbox(context, input.sender, input.audience, input.envelopeId)?.record);
    },

    async list(input) {
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

    async recordDisposition(input) {
      if (!demosAgentClaimReference(input.sender) ||
          !sameDemosAgentIdentity(input.audience, context.authority) ||
          !hash(input.envelopeId) || !hash(input.authenticationHash) ||
          (input.disposition !== "accepted" && input.disposition !== "existing" &&
            input.disposition !== "rejected") ||
          (input.disposition === "rejected" ? !reasonCode(input.reasonCode) :
            input.reasonCode !== undefined)) {
        return { status: "conflict" };
      }
      return context.beginImmediate(() => {
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
        const row = updateInbox(context, loaded.row, stored);
        return row
          ? { status: "recorded", record: publicInbox(row, stored) }
          : { status: "conflict" };
      });
    },

    async extendRetention(input) {
      if (!isCanonicalJobId(input.jobId)) {
        throw context.error("http-retention-input-malformed", "HTTP retention job is malformed");
      }
      return context.beginImmediate(() => {
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
          if (!updateInbox(context, row, next)) {
            throw context.error("http-store-write-raced", "HTTP inbox retention update raced");
          }
          count += 1;
        }
        return { status: count === 0 ? "existing" : "extended", count };
      });
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
    const row = updateOutbox(context, loaded.row, stored);
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
      try {
        envelope = snapshot(rawInput.envelope) as DacsHttpEnvelopeV1;
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
      return context.beginImmediate(() => {
        const now = transportTime(context);
        const existing = readOutbox(context, envelope.envelopeId);
        if (existing) {
          const same = canonicalize(existing.stored.envelope) === canonicalize(envelope) &&
            existing.stored.envelopeHash === verified.authenticationHash;
          return same
            ? { status: "existing", record: existing.record }
            : { status: "conflict" };
        }
        if (envelope.expiresAt <= now) {
          throw context.error("http-outbox-envelope-expired", "Expired HTTP envelope cannot enter the outbox");
        }
        assertRetention(context, now, rawInput.retainUntil, options.retentionMs);
        const stored: StoredOutbox = {
          envelope: verified.envelope,
          envelopeHash: verified.authenticationHash,
          state: "pending",
          generation: 0,
          attempts: 0,
          nextAttemptAt: now,
          retainUntil: rawInput.retainUntil,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        const row = insertOutbox(context, stored);
        return { status: "created", record: publicOutbox(row, stored) };
      });
    },

    async load(envelopeId) {
      if (!hash(envelopeId)) {
        throw context.error("http-outbox-query-malformed", "HTTP outbox lookup is malformed");
      }
      return context.readSnapshot(() => readOutbox(context, envelopeId)?.record);
    },

    async list(input) {
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

    async listRunnable(input) {
      pageLimit(context, input.limit);
      const cursor = validateOutboxCursor(context, input.cursor);
      return context.beginImmediate(() => {
        const now = transportTime(context);
        const expiredRows = context.database.prepare(`
          SELECT * FROM dacs_http_outbox
          WHERE state IN ('pending', 'sending') AND json_extract(record_json, '$.envelope.expiresAt') <= ?
          ORDER BY envelope_id
        `).all(now) as OutboxRow[];
        for (const row of expiredRows) {
          const stored = outboxStored(context, row);
          verifyOutboxHistory(context, row);
          expire({ row, stored, record: publicOutbox(row, stored) }, now);
        }
        const rows = context.database.prepare(`
          SELECT * FROM dacs_http_outbox
          WHERE envelope_id > ?
            AND json_extract(record_json, '$.envelope.expiresAt') > ?
            AND ((state = 'pending' AND next_attempt_at <= ?) OR
              (state = 'sending' AND lease_expires_at <= ?))
          ORDER BY envelope_id LIMIT ?
        `).all(cursor, now, now, now, input.limit + 1) as OutboxRow[];
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

    async claim(input) {
      if (!validateIdentity(input.envelopeId, input.envelopeHash) ||
          !nonEmpty(input.owner) || !safeUint(input.leaseDurationMs) ||
          input.leaseDurationMs === 0) return { status: "stale" };
      return context.beginImmediate(() => {
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
        const row = updateOutbox(context, loaded.row, stored);
        return row
          ? { status: "acquired", record: publicOutbox(row, stored), lease }
          : { status: "stale" };
      });
    },

    async isCurrent(input) {
      const lease = captureLease(input.lease);
      if (!lease || !validateIdentity(input.envelopeId, input.envelopeHash)) return false;
      return context.beginImmediate(() => {
        const loaded = readOutbox(context, input.envelopeId);
        if (!loaded || loaded.stored.envelopeHash !== input.envelopeHash ||
            loaded.stored.state !== "sending" ||
            !leaseMatches(loaded.stored.lease, lease)) return false;
        return lease.expiresAt > transportTime(context) &&
          loaded.stored.envelope.expiresAt > transportTime(context);
      });
    },

    async recordSendFailure(input) {
      const lease = captureLease(input.lease);
      if (!lease || !validateIdentity(input.envelopeId, input.envelopeHash) ||
          !reasonCode(input.reasonCode)) return { status: "conflict" };
      return context.beginImmediate(() => {
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
        const row = updateOutbox(context, loaded.row, stored);
        return row
          ? { status: "recorded", record: publicOutbox(row, stored) }
          : { status: "stale" };
      });
    },

    async requireOperatorAction(input) {
      const lease = captureLease(input.lease);
      if (!lease || !validateIdentity(input.envelopeId, input.envelopeHash) ||
          !reasonCode(input.reasonCode)) return { status: "conflict" };
      return context.beginImmediate(() => {
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
        const row = updateOutbox(context, loaded.row, stored);
        return row
          ? { status: "recorded", record: publicOutbox(row, stored) }
          : { status: "stale" };
      });
    },

    async acknowledge(input) {
      if (!validateIdentity(input.envelopeId, input.envelopeHash)) {
        return { status: "conflict" };
      }
      return context.beginImmediate(() => {
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
              retainedBinding.disposition !== binding.disposition) {
            return { status: "conflict" };
          }
          const acknowledgementRetentionMs = Math.max(
            loaded.stored.acknowledgementRetentionMs!,
            options.retentionMs,
          );
          const requiredRetainUntil = retentionDeadline(
            Math.max(retained.receivedAt, acknowledgement.receivedAt),
            acknowledgementRetentionMs,
          );
          if (requiredRetainUntil === undefined) {
            throw context.error(
              "http-retention-overflow",
              "HTTP acknowledgement retention deadline overflows",
            );
          }
          if (loaded.stored.retainUntil >= requiredRetainUntil &&
              loaded.stored.acknowledgementRetentionMs === acknowledgementRetentionMs) {
            return { status: "existing", record: loaded.record };
          }
          const stored: StoredOutbox = {
            ...snapshot(loaded.stored),
            acknowledgementRetentionMs,
            retainUntil: Math.max(loaded.stored.retainUntil, requiredRetainUntil),
            revision: loaded.stored.revision + 1,
            updatedAt: Math.max(now, loaded.stored.updatedAt),
          };
          const row = updateOutbox(context, loaded.row, stored);
          return row
            ? { status: "recorded", record: publicOutbox(row, stored) }
            : { status: "conflict" };
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
        const row = updateOutbox(context, loaded.row, stored);
        return row
          ? { status: "recorded", record: publicOutbox(row, stored) }
          : { status: "conflict" };
      });
    },

    async extendRetention(input) {
      if (!isCanonicalJobId(input.jobId)) {
        throw context.error("http-retention-input-malformed", "HTTP retention job is malformed");
      }
      return context.beginImmediate(() => {
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
          if (!updateOutbox(context, row, next)) {
            throw context.error("http-store-write-raced", "HTTP outbox retention update raced");
          }
          count += 1;
        }
        return { status: count === 0 ? "existing" : "extended", count };
      });
    },
  };
}

export function verifyDacsHttpSqliteRows(context: DacsHttpSqliteContext): void {
  const clock = context.database.prepare(`
    SELECT singleton, last_time FROM dacs_http_clock LIMIT 2
  `).all() as { singleton: number; last_time: number }[];
  if (clock.length !== 1 || clock[0]!.singleton !== 1 || !safeUint(clock[0]!.last_time)) {
    throw context.error("http-store-clock-invalid", "HTTP transport clock row is corrupt");
  }
  for (const row of context.database.prepare(`
    SELECT * FROM dacs_http_inbox ORDER BY envelope_id, sender, audience
  `).iterate() as IterableIterator<InboxRow>) {
    inboxStored(context, row);
    verifyInboxHistory(context, row);
  }
  for (const row of context.database.prepare(`
    SELECT * FROM dacs_http_outbox ORDER BY envelope_id
  `).iterate() as IterableIterator<OutboxRow>) {
    outboxStored(context, row);
    verifyOutboxHistory(context, row);
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
}
