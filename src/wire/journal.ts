// The seller's request journal (new): the only store checkWireRequest
// reserves effects in.
//
// A journal a host supplies cannot be shown to survive a restart from inside
// one process, so the wire takes none. It ships this one: a local directory,
// shared by every worker on the host, in which each file is written under a
// temporary name, synced, and published with link() (atomic, and exclusive:
// of workers racing on one name exactly one publishes it), and the directory
// synced before the call returns. A file published before a crash is there
// after it.
//
// Each effect is a durable state machine keyed by its operation (one per
// seller, job and route; checkWireRequest computes it). The first attempt also
// records the operation's binding (the tuple, buyer and Agreement hash it was
// first reserved under), and every later request for the operation must carry
// the same one: a job whose retained Agreement, buyer or tuple changed gets
// peer_operation_mismatch (409), never a second effect.
//   no attempt         -> attempt 0 is published: "new" (run the effect)
//   attempt n live     -> "pending" (seller_effect_pending, 503: retry later)
//   attempt n ended    -> attempt n+1 is published: "recover" (an earlier
//                         attempt may have acted: reconcile first)
//   outcome published  -> "completed" (re-sign the stored outcome; no effect)
// An attempt ends when its lease runs out or completeWireEffect ends it with
// no outcome. Only the latest attempt may publish the outcome, and only once.
// Every request's nonce key is published too: the same signed request again
// is peer_request_replayed (409).
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { canonicalize } from "../canonical/jcs.js";
import { DACS_SELLER_HTTP_LIMITS } from "./routes.js";
import { deepFreeze, fail, hasKeys, isHash, isRecord, isUint, ownedFields, uncurry, type JsonRecord } from "./validate.js";

/** The outcome an effect handler answered with: what a repeat of its operation is answered with again. */
export interface WireEffectOutcome {
  /** The HTTP status signWireResponse signed, 200-599. */
  readonly status: number;
  /** The exact response body text it signed. */
  readonly text: string;
}

/**
 * What checkWireRequest returns for an effect route. `new`: no attempt of this
 * operation has run; run the effect, then completeWireEffect. `recover`: an
 * earlier attempt's lease ended with no outcome, and this one now holds the
 * operation alone until `leaseUntil`; that attempt may have acted, so check
 * the effect's own source of truth (the chain, the delivery store) before
 * acting, then completeWireEffect. `completed`: the operation already has its
 * outcome; answer with it (signed again for this request) and run nothing.
 * The outcome is the answer this seller gave, not a new reading: where it
 * states chain or delivery state, check that again at its source first.
 */
export type WireEffect =
  | { readonly state: "new" | "recover"; readonly operationId: string; readonly attempt: number; readonly leaseUntil: number }
  | { readonly state: "completed"; readonly operationId: string; readonly outcome: WireEffectOutcome };

/** A journal openWireRequestJournal returned; only that function makes one. */
export interface WireRequestJournal {
  readonly directory: string;
}

export interface WireRequestJournalOptions {
  /** How long an attempt holds its operation, in ms (1 s to 10 min; default 60 s). The handler completes within it. */
  leaseMs?: number;
  /** The journal's clock in ms; default Date.now. Every worker on one journal must use the same clock. */
  clock?: () => number;
}

/** What envelope.ts reserves for one effect request. */
export interface EffectReservation {
  /** SHA-256 of {buyer, seller, profile, nonce}. */
  key: string;
  /** SHA-256 of {seller, jobId, path}: fixed for the job and route. */
  operationId: string;
  /** SHA-256 of {profile, buyer, agreementHash}: recorded with attempt 0 and compared on every later request. */
  binding: string;
  requestHash: string;
}

/** An operation that crashes on every attempt stops here and needs an operator. */
export const MAX_EFFECT_ATTEMPTS = 16;
const SMALL_FILE_BYTES = 4096;
const OUTCOME_FILE_BYTES = DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes * 2 + SMALL_FILE_BYTES;

type Store = { directory: string; leaseMs: number; clock: () => number };
type IssuedEffect = { store: Store; operationId: string; attempt: number };
// Methods taken at module load (see profile.ts).
const stores = new WeakMap<object, Store>();
const storeGet = uncurry(WeakMap.prototype.get) as (map: typeof stores, key: object) => Store | undefined;
const storeSet = uncurry(WeakMap.prototype.set) as (map: typeof stores, key: object, value: Store) => unknown;
const issued = new WeakMap<object, IssuedEffect>();
const issuedGet = uncurry(WeakMap.prototype.get) as (map: typeof issued, key: object) => IssuedEffect | undefined;
const issuedSet = uncurry(WeakMap.prototype.set) as (map: typeof issued, key: object, value: IssuedEffect) => unknown;

const corrupt = (detail: string): never => fail("seller_replay_guard_invalid", 500, detail);

function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Publish `name` with exactly `contents`, durably; false if it already exists. */
function publish(store: Store, name: string, contents: string): boolean {
  const temporary = join(store.directory, `tmp-${randomBytes(16).toString("hex")}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  let published = true;
  try { linkSync(temporary, join(store.directory, name)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") { unlinkSync(temporary); throw error; }
    published = false;
  }
  unlinkSync(temporary);
  syncDirectory(store.directory);
  return published;
}

/** Whether `name` exists; anything but a regular file there is a corrupt store. */
function exists(store: Store, name: string): boolean {
  const stat = lstatSync(join(store.directory, name), { throwIfNoEntry: false });
  if (stat === undefined) return false;
  if (!stat.isFile()) corrupt("STORE-ENTRY-NOT-FILE");
  return true;
}

/** Read a published file, bounded before anything is read; undefined when it does not parse as one JSON object. */
function readRecord(store: Store, name: string, maxBytes: number): JsonRecord | undefined {
  const fd = openSync(join(store.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) corrupt("STORE-ENTRY-TOO-LARGE");
    const bytes = Buffer.alloc(stat.size);
    let read = 0;
    while (read < bytes.length) {
      const n = readSync(fd, bytes, read, bytes.length - read, read);
      if (n === 0) break;
      read += n;
    }
    try {
      const value: unknown = JSON.parse(bytes.subarray(0, read).toString("utf8"));
      return isRecord(value) ? value : undefined;
    } catch { return undefined; }
  } finally { closeSync(fd); }
}

const attemptName = (operationId: string, attempt: number) => `o-${operationId}-${attempt}`;
const endedName = (operationId: string, attempt: number) => `o-${operationId}-${attempt}.end`;
const ATTEMPT = ["operationId", "attempt", "requestHash", "leaseUntil", "binding"];

/** An attempt record this journal published; anything else there is a corrupt store, never a lapsed lease. */
function readAttempt(store: Store, operationId: string, attempt: number): JsonRecord {
  const record = readRecord(store, attemptName(operationId, attempt), SMALL_FILE_BYTES);
  if (!hasKeys(record, ATTEMPT) || record.operationId !== operationId || record.attempt !== attempt || !isHash(record.requestHash) ||
      !isUint(record.leaseUntil) || !isHash(record.binding)) corrupt("STORE-ATTEMPT-INVALID");
  return record!;
}

/** The operation was first reserved under `binding`; a request under another one runs nothing. */
function assertBinding(store: Store, operationId: string, binding: string): void {
  if (!exists(store, attemptName(operationId, 0))) corrupt("STORE-ATTEMPT-MISSING");
  if (readAttempt(store, operationId, 0).binding !== binding) fail("peer_operation_mismatch", 409);
}
const outcomeName = (operationId: string) => `o-${operationId}.done`;

function isOutcome(value: unknown): value is WireEffectOutcome {
  return hasKeys(value, ["status", "text"]) && isUint(value.status) && value.status >= 200 && value.status <= 599 &&
    typeof value.text === "string" && Buffer.byteLength(value.text) <= DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes;
}

function readOutcome(store: Store, operationId: string): WireEffectOutcome {
  const record = readRecord(store, outcomeName(operationId), OUTCOME_FILE_BYTES);
  // An outcome is published whole (link), so a malformed one was not written by this journal.
  if (!hasKeys(record, ["operationId", "attempt", "outcome"]) || record.operationId !== operationId || !isOutcome(record.outcome)) corrupt("STORE-OUTCOME-INVALID");
  return { status: (record!.outcome as JsonRecord).status as number, text: (record!.outcome as JsonRecord).text as string };
}

function now(store: Store): number {
  const at = store.clock();
  if (!isUint(at)) fail("seller_configuration_invalid", 500, "JOURNAL-CLOCK");
  return at;
}

/**
 * Open the journal in `directory`: an existing absolute directory, not a
 * symbolic link, owned by this process's user and writable by no one else.
 * Before it is returned, an exclusive publish is tried twice on it: the second
 * must be refused. Anything else, or Windows (no directory sync), is
 * `seller_replay_guard_invalid` (500). Every worker on the host opens the same
 * directory.
 */
export function openWireRequestJournal(directory: string, options: WireRequestJournalOptions = {}): WireRequestJournal {
  // Windows cannot open a directory to sync it, so a publish there is not durable.
  if (process.platform === "win32") fail("seller_replay_guard_invalid", 500, "PLATFORM-UNSUPPORTED");
  if (typeof directory !== "string" || !isAbsolute(directory) || directory.includes("\0")) fail("seller_replay_guard_invalid", 500, "DIRECTORY-NOT-ABSOLUTE");
  const fields = ownedFields(options, ["leaseMs", "clock"]);
  const leaseMs = fields.leaseMs ?? 60_000, clock = fields.clock ?? Date.now;
  if (!isUint(leaseMs) || leaseMs < 1000 || leaseMs > 600_000 || typeof clock !== "function") fail("seller_configuration_invalid", 500, "JOURNAL-OPTIONS");
  const stat = lstatSync(directory, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory()) fail("seller_replay_guard_invalid", 500, "DIRECTORY-MISSING");
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if ((uid !== undefined && stat!.uid !== uid) || (stat!.mode & 0o022) !== 0) fail("seller_replay_guard_invalid", 500, "DIRECTORY-UNSAFE");
  const store: Store = { directory, leaseMs: leaseMs as number, clock: clock as () => number };
  const probe = `probe-${randomBytes(16).toString("hex")}`;
  const first = publish(store, probe, "{}"), second = publish(store, probe, "{}");
  unlinkSync(join(directory, probe));
  syncDirectory(directory);
  if (!first || second) fail("seller_replay_guard_invalid", 500, "PUBLISH-NOT-EXCLUSIVE");
  const handle = Object.freeze({ directory });
  storeSet(stores, handle, store);
  return handle;
}

/** The store behind a handle openWireRequestJournal returned; anything else is refused before it is used. */
export function journalStore(journal: unknown): object {
  // WeakMap.get answers undefined for anything that is not an object.
  const store = storeGet(stores, journal as object);
  if (!store) fail("seller_replay_guard_required", 500);
  return store as object;
}

function issue(store: Store, effect: WireEffect & { attempt: number }): WireEffect {
  const frozen = deepFreeze(effect);
  issuedSet(issued, frozen, { store, operationId: effect.operationId, attempt: effect.attempt });
  return frozen;
}

/** Reserve one effect request (envelope.ts): its nonce key, then its operation's next state. */
export function reserveEffect(storeHandle: object, reservation: EffectReservation): WireEffect {
  const store = storeHandle as Store;
  const { key, operationId, binding, requestHash } = reservation;
  if (!isHash(key) || !isHash(operationId) || !isHash(binding) || !isHash(requestHash)) fail("wire_input_invalid", 500);
  if (!publish(store, `k-${key}`, canonicalize({ key, operationId, binding, requestHash }))) fail("peer_request_replayed", 409);
  const at = now(store);
  const lease = (attempt: number) => canonicalize({ operationId, attempt, requestHash, leaseUntil: at + store.leaseMs, binding });
  const completed = (): WireEffect => {
    const outcome = readOutcome(store, operationId);
    assertBinding(store, operationId, binding);
    return deepFreeze({ state: "completed" as const, operationId, outcome });
  };
  if (exists(store, outcomeName(operationId))) return completed();
  let next = 0;
  while (next < MAX_EFFECT_ATTEMPTS && exists(store, attemptName(operationId, next))) next++;
  if (next === 0) {
    if (publish(store, attemptName(operationId, 0), lease(0))) return issue(store, { state: "new", operationId, attempt: 0, leaseUntil: at + store.leaseMs });
    // Another worker published attempt 0 first: its binding decides.
    assertBinding(store, operationId, binding);
    return fail("seller_effect_pending", 503);
  }
  assertBinding(store, operationId, binding);
  // The outcome may have been published while the attempts were counted.
  if (exists(store, outcomeName(operationId))) return completed();
  const latest = next - 1;
  const { leaseUntil } = readAttempt(store, operationId, latest);
  if (!exists(store, endedName(operationId, latest)) && at < (leaseUntil as number)) fail("seller_effect_pending", 503);
  if (next >= MAX_EFFECT_ATTEMPTS) fail("seller_effect_unresolved", 500);
  if (!publish(store, attemptName(operationId, next), lease(next))) fail("seller_effect_pending", 503);
  return issue(store, { state: "recover", operationId, attempt: next, leaseUntil: at + store.leaseMs });
}

/**
 * Record the end of an effect attempt checkWireRequest issued (`new` or
 * `recover`), on the journal it was issued from. `outcome` is the answer the
 * handler signed: a later request for the same operation is answered with it
 * and runs no effect. It is published once: the same outcome again is
 * accepted, another is `seller_effect_conflict` (500). `null` ends an attempt
 * that caused no effect and will cause none (for example, a payment not yet
 * visible), so the next request recovers at once instead of after the lease.
 * An attempt a later one superseded is `seller_effect_superseded` (500): its
 * successor reconciles. Call it only after the effect's own write is durable.
 */
export function completeWireEffect(journal: WireRequestJournal, effect: WireEffect, outcome: WireEffectOutcome | null): void {
  const store = journalStore(journal) as Store;
  const kept = issuedGet(issued, effect as object);
  if (!kept || kept.store !== store) fail("wire_input_invalid", 500, "EFFECT-NOT-ISSUED");
  const { operationId, attempt } = kept!;
  // Read once through own data properties; the text is kept byte for byte (no normalization).
  const owned = outcome === null ? null : ownedFields(outcome, ["status", "text"]) as unknown as WireEffectOutcome;
  if (owned !== null && !isOutcome(owned)) fail("wire_input_invalid", 500, "OUTCOME-INVALID");
  if (exists(store, attemptName(operationId, attempt + 1))) fail("seller_effect_superseded", 500);
  if (owned === null) {
    if (exists(store, outcomeName(operationId))) fail("seller_effect_conflict", 500);
    publish(store, endedName(operationId, attempt), "{}");
    return;
  }
  if (publish(store, outcomeName(operationId), canonicalize({ operationId, attempt, outcome: owned }))) return;
  const stored = readOutcome(store, operationId);
  if (stored.status !== owned.status || stored.text !== owned.text) fail("seller_effect_conflict", 500);
}
