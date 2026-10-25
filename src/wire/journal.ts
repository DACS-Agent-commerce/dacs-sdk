// The seller's request journal: the only store seller admission reserves effects in.
//
// A journal a host supplies cannot be shown to survive a restart from inside one process, so the wire takes none. It ships this one: a local directory, shared by
// every worker on the host, in which each file is written under a temporary name, synced, and published with link() (atomic, and exclusive: of workers racing on
// one name exactly one publishes it), and the directory synced before the call returns. No other user can rename or replace the directory or any directory above
// it, so the path cannot be swapped under a publish. Each effect is a durable state machine keyed by its operation (one per seller, job and route, derived here
// from those three, never from a request body). The first attempt records the operation's binding (profile, buyer and Agreement hash); every later request must
// carry the same one, or gets peer_operation_mismatch (409), never a second effect.
//   no attempt         -> attempt 0 is published: "new" (run the effect)
//   attempt n live     -> "pending" (seller_effect_pending, 503: retry later)
//   attempt n ended    -> attempt n+1 is published: "recover" (an earlier attempt may have acted: reconcile first)
//   outcome published  -> "completed" (re-sign the stored outcome; no effect)
// Attempt n ends exactly once, by publishing its end entry: completeWireEffect publishes it with the attempt's outcome (or null), and a request that finds the
// lease run out publishes it as superseded. Whichever is published first stands. Attempt n+1 is published only after an end with no outcome, and the outcome
// only after the attempt's own end, so a superseded attempt never records one and no attempt starts after it. An attempt is issued only if its lease still runs
// when its publication is done. Every request's nonce key is published too: the same signed request again is peer_request_replayed (409).
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, realpathSync, statfsSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { qualifyJournalRestart } from "./journalRestart.js";

import { sha256Hex } from "../canonical/hash.js";
import { canonicalize } from "../canonical/jcs.js";
import { isCanonicalJobId } from "../negotiate/jobId.js";
import { DACS_SELLER_HTTP_LIMITS, DACS_SELLER_HTTP_ROUTES } from "./routes.js";
import { admitWireJson, deepFreeze, fail, hasKeys, isClaim, isHash, isRecord, isUint, ownedFields, uncurry, type JsonRecord } from "./validate.js";

/** The outcome an effect handler answered with: what a repeat of its operation is answered with again. */
export interface WireEffectOutcome {
  /** The HTTP status signWireResponse signed, 200-599. */
  readonly status: number;
  /** The exact response body text it signed. */
  readonly text: string;
}

/**
 * What seller admission returns for an effect route. `new`: no attempt of this operation has run; run the effect, then completeWireEffect. `recover`: an
 * earlier attempt's lease ended with no outcome, and this one now holds the operation alone until `leaseUntil`; that attempt may have acted, so check the
 * effect's own source of truth (the chain, the delivery store) before acting, then completeWireEffect. `completed`: the operation already has its outcome;
 * answer with it (signed again for this request) and run nothing. The outcome is the answer this seller gave, not a new reading: where it states chain or
 * delivery state, check that again at its source first.
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
  /** The seller's claim, the Agreement's job and the effect route: the operation is derived from these, never from the request body. */
  seller: string;
  jobId: string;
  path: string;
  /** SHA-256 of {profile, buyer, agreementHash}: recorded with attempt 0 and compared on every later request. */
  binding: string;
  requestHash: string;
}

/** An operation stops after this many superseded attempts and needs an operator. Clean null ends do not count. */
export const MAX_EFFECT_ATTEMPTS = 16;
const SMALL_FILE_BYTES = 4096;
const VOLATILE_FILESYSTEM_TYPES = new Set([0x01021994n, 0x858458f6n]); // tmpfs, ramfs: empty after a reboot, whatever is synced
const OUTCOME_FILE_BYTES = DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes * 2 + SMALL_FILE_BYTES;

type Store = { directory: string; identity: { dev: bigint; ino: bigint }; leaseMs: number; clock: () => number };
type IssuedEffect = { store: Store; operationId: string; attempt: number };
// Methods taken at module load (see profile.ts).
const stores = new WeakMap<object, Store>();
const storeGet = uncurry(WeakMap.prototype.get) as (map: typeof stores, key: object) => Store | undefined;
const storeSet = uncurry(WeakMap.prototype.set) as (map: typeof stores, key: object, value: Store) => unknown;
const issued = new WeakMap<object, IssuedEffect>();
const issuedGet = uncurry(WeakMap.prototype.get) as (map: typeof issued, key: object) => IssuedEffect | undefined;
const issuedSet = uncurry(WeakMap.prototype.set) as (map: typeof issued, key: object, value: IssuedEffect) => unknown;

const corrupt = (detail: string): never => fail("seller_replay_guard_invalid", 500, detail);

/** The journal path still names the directory that passed the open checks; a renamed or replaced one is refused. */
function assertSameDirectory({ directory, identity }: Store): void {
  const stat = lstatSync(directory, { bigint: true, throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory() || stat.dev !== identity.dev || stat.ino !== identity.ino) corrupt("DIRECTORY-REPLACED");
}
function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Publish `name` with exactly `contents`, durably; false if it already exists. */
function publish(store: Store, name: string, contents: string): boolean {
  assertSameDirectory(store);
  const temporary = join(store.directory, `tmp-${randomBytes(16).toString("hex")}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let published = true, primary: unknown;
  try {
    try {
      const bytes = Buffer.from(contents, "utf8");
      for (let offset = 0; offset < bytes.length;) {
        const count = writeSync(fd, bytes, offset, bytes.length - offset);
        if (count === 0) corrupt("STORE-WRITE-NO-PROGRESS");
        offset += count;
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    try { linkSync(temporary, join(store.directory, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; published = false; }
  } catch (error) { primary = error; throw error; } finally {
    try { unlinkSync(temporary); }
    catch (cleanup) {
      if (primary instanceof Error) Object.defineProperty(primary, "cleanupError", { value: cleanup });
      else throw cleanup;
    }
  }
  syncDirectory(store.directory);
  assertSameDirectory(store); // the path was not swapped while this was written: a record in a replacement directory is no record
  return published;
}

/** Whether `name` exists; anything but a regular file there is a corrupt store. */
function exists(store: Store, name: string): boolean {
  assertSameDirectory(store);
  const stat = lstatSync(join(store.directory, name), { throwIfNoEntry: false });
  if (stat !== undefined && !stat.isFile()) corrupt("STORE-ENTRY-NOT-FILE");
  return stat !== undefined;
}

/** Read a published file, bounded before anything is read; undefined when it does not parse as one JSON object. */
function readRecord(store: Store, name: string, maxBytes: number): JsonRecord | undefined {
  assertSameDirectory(store);
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
const ATTEMPT = ["operationId", "attempt", "requestHash", "leaseUntil", "binding", "superseded"];

/** An attempt record this journal published; anything else there is a corrupt store, never a lapsed lease. */
function readAttempt(store: Store, operationId: string, attempt: number): JsonRecord {
  const record = readRecord(store, attemptName(operationId, attempt), SMALL_FILE_BYTES);
  if (!hasKeys(record, ATTEMPT) || record.operationId !== operationId || record.attempt !== attempt || !isHash(record.requestHash) ||
      !isUint(record.leaseUntil) || !isHash(record.binding) || !isUint(record.superseded) || record.superseded > attempt || record.superseded >= MAX_EFFECT_ATTEMPTS) corrupt("STORE-ATTEMPT-INVALID");
  return record!;
}

/** The operation was first reserved under `binding`; a request under another one runs nothing. */
function assertBinding(store: Store, operationId: string, binding: string): void {
  if (!exists(store, attemptName(operationId, 0))) corrupt("STORE-ATTEMPT-MISSING");
  if (readAttempt(store, operationId, 0).binding !== binding) fail("peer_operation_mismatch", 409);
}
const outcomeName = (operationId: string) => `o-${operationId}.done`;

/**
 * Text the wire can sign as a response body: well-formed UTF-8 (one that survives its own encoding, so the bytes
 * stored are the text given) that CF-5 admission, the profile `signWireResponse` applies to every body it signs
 * (admitOutgoingBody), admits as a JSON object. A text it would refuse could be stored but never answered.
 */
function isSignableText(text: string): boolean {
  if (Buffer.from(text, "utf8").toString("utf8") !== text) return false;
  try {
    const body = admitWireJson(Buffer.from(text, "utf8"), DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes, "outcome_text_rejected", 500);
    return body !== null && typeof body === "object" && !Array.isArray(body);
  } catch { return false; }
}

function isOutcome(value: unknown): value is WireEffectOutcome {
  return hasKeys(value, ["status", "text"]) && isUint(value.status) && value.status >= 200 && value.status <= 599 &&
    typeof value.text === "string" && Buffer.byteLength(value.text) <= DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes && isSignableText(value.text);
}

/**
 * An outcome as stored. The records are canonical JSON, which normalizes the
 * Unicode of every string, so the answer's text is stored as the base64url of
 * its UTF-8 bytes: what a repeat returns is exactly what the handler signed.
 * A reader accepts only bytes that are well-formed UTF-8 (decoding and encoding
 * them again gives the same bytes), never a lossy decoding of damaged ones.
 */
type StoredOutcome = { status: number; textBytes: string };
const toStored = (outcome: WireEffectOutcome): StoredOutcome => ({ status: outcome.status, textBytes: Buffer.from(outcome.text, "utf8").toString("base64url") });

/** The outcome a stored one holds, or null when it is not one this journal wrote. */
function fromStored(value: unknown): WireEffectOutcome | null {
  if (!hasKeys(value, ["status", "textBytes"]) || typeof value.textBytes !== "string" || !/^[A-Za-z0-9_-]*$/.test(value.textBytes)) return null;
  const bytes = Buffer.from(value.textBytes, "base64url");
  if (bytes.toString("base64url") !== value.textBytes) return null;
  const outcome = { status: value.status, text: bytes.toString("utf8") };
  return Buffer.from(outcome.text, "utf8").equals(bytes) && isOutcome(outcome) ? outcome : null;
}

function readOutcome(store: Store, operationId: string): WireEffectOutcome {
  const record = readRecord(store, outcomeName(operationId), OUTCOME_FILE_BYTES);
  const outcome = hasKeys(record, ["operationId", "attempt", "outcome"]) && record.operationId === operationId ? fromStored(record.outcome) : null;
  return outcome ?? corrupt("STORE-OUTCOME-INVALID");
}

const sameOutcome = (a: WireEffectOutcome | null, b: WireEffectOutcome | null) => a === null || b === null ? a === b : a.status === b.status && a.text === b.text;

/** Publish the operation's outcome from its attempt's end; one already there must be the same. */
function publishOutcome(store: Store, operationId: string, attempt: number, outcome: WireEffectOutcome): void {
  if (publish(store, outcomeName(operationId), canonicalize({ operationId, attempt, outcome: toStored(outcome) }))) return;
  if (!sameOutcome(readOutcome(store, operationId), outcome)) fail("seller_effect_conflict", 500);
}

type AttemptEnd = { superseded: boolean; outcome: WireEffectOutcome | null };
const END = ["operationId", "attempt", "superseded", "outcome"];
const endRecord = (operationId: string, attempt: number, end: AttemptEnd) =>
  canonicalize({ operationId, attempt, superseded: end.superseded, outcome: end.outcome === null ? null : toStored(end.outcome) });

/** The end entry this journal published for an attempt; anything else there is a corrupt store. */
function readEnd(store: Store, operationId: string, attempt: number): AttemptEnd {
  const record = readRecord(store, endedName(operationId, attempt), OUTCOME_FILE_BYTES);
  if (!hasKeys(record, END) || record.operationId !== operationId || record.attempt !== attempt || typeof record.superseded !== "boolean" ||
      (record.superseded && record.outcome !== null)) corrupt("STORE-END-INVALID");
  const outcome = record!.outcome === null ? null : fromStored(record!.outcome);
  if (record!.outcome !== null && outcome === null) corrupt("STORE-END-INVALID");
  return { superseded: record!.superseded as boolean, outcome };
}

/** No other user can rename or replace a directory on the path: each is owned by this user (root above the journal) and not group/other-writable, bar a root-owned sticky one such as /tmp. */
function assertPathNotReplaceable(directory: string): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  for (let path = directory; ; path = dirname(path)) {
    const stat = lstatSync(path), root = path !== directory && stat.uid === 0;
    const sticky = root && (stat.mode & 0o1000) !== 0;
    if ((uid !== undefined && stat.uid !== uid && !root) || ((stat.mode & 0o022) !== 0 && !sticky)) fail("seller_replay_guard_invalid", 500, "DIRECTORY-UNSAFE");
    if (dirname(path) === path) return;
  }
}

/** Make durable the entry of the journal directory and of every ancestor this user created: each directory it owns is named in its parent, whoever owns that. */
function syncPathEntries(directory: string): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  for (let path = directory; dirname(path) !== path; path = dirname(path)) {
    if (uid === undefined || lstatSync(path).uid === uid) syncDirectory(dirname(path));
  }
}

function now(store: Store): number {
  const at = store.clock();
  if (!isUint(at)) fail("seller_configuration_invalid", 500, "JOURNAL-CLOCK");
  return at;
}

/**
 * Open the journal in `directory`: an existing absolute directory, not a symbolic link and reached through none (the path is its own real path), owned by this
 * process's user and writable by no one else, on storage that keeps data across a reboot (not tmpfs or ramfs), under ancestors no other user can change
 * (root-owned, or a root-owned sticky one), whose own entries are then synced; a call after the path names another directory fails. Before it is returned, an
 * exclusive publish is tried twice on it: the second must be refused. A publisher then exits before a fresh process checks retained bytes and exclusive retry.
 * Failure, or Windows (no directory sync), is `seller_replay_guard_invalid` (500). Every worker on the host opens the same directory.
 */
export function openWireRequestJournal(directory: string, options: WireRequestJournalOptions = {}): WireRequestJournal {
  if (process.platform === "win32") fail("seller_replay_guard_invalid", 500, "PLATFORM-UNSUPPORTED");
  if (typeof directory !== "string" || !isAbsolute(directory) || directory.includes("\0")) fail("seller_replay_guard_invalid", 500, "DIRECTORY-NOT-ABSOLUTE");
  const fields = ownedFields(options, ["leaseMs", "clock"]);
  const leaseMs = fields.leaseMs ?? 60_000, clock = fields.clock ?? Date.now;
  if (!isUint(leaseMs) || leaseMs < 1000 || leaseMs > 600_000 || typeof clock !== "function") fail("seller_configuration_invalid", 500, "JOURNAL-OPTIONS");
  const stat = lstatSync(directory, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory()) fail("seller_replay_guard_invalid", 500, "DIRECTORY-MISSING");
  // Every later call resolves the path again, so a link anywhere in it (or a trailing slash, `..`) could be retargeted to an empty directory.
  if (realpathSync(directory) !== directory) fail("seller_replay_guard_invalid", 500, "DIRECTORY-ALIAS");
  assertPathNotReplaceable(directory);
  if (VOLATILE_FILESYSTEM_TYPES.has(BigInt.asUintN(32, statfsSync(directory, { bigint: true }).type))) fail("seller_replay_guard_invalid", 500, "DIRECTORY-VOLATILE");
  syncPathEntries(directory);
  const store: Store = { directory, identity: lstatSync(directory, { bigint: true }), leaseMs: leaseMs as number, clock: clock as () => number };
  const probe = `probe-${randomBytes(16).toString("hex")}`;
  const first = publish(store, probe, "{}"), second = publish(store, probe, "{}");
  unlinkSync(join(directory, probe));
  syncDirectory(directory);
  if (!first || second) fail("seller_replay_guard_invalid", 500, "PUBLISH-NOT-EXCLUSIVE");
  qualifyJournalRestart(directory);
  const handle = Object.freeze({ directory });
  storeSet(stores, handle, store);
  return handle;
}

/** The store behind a handle openWireRequestJournal returned; anything else is refused before it is used. */
export function journalStore(journal: unknown): object { // WeakMap.get answers undefined for anything that is not an object.
  const store = storeGet(stores, journal as object);
  if (!store) fail("seller_replay_guard_required", 500);
  return store as object;
}

/** Issue an attempt only while its lease still runs: publishing takes syncs, and a lapsed attempt may already be superseded. */
function issue(store: Store, effect: Exclude<WireEffect, { state: "completed" }>): WireEffect {
  if (now(store) >= effect.leaseUntil) fail("seller_effect_pending", 503);
  const frozen = deepFreeze(effect);
  issuedSet(issued, frozen, { store, operationId: effect.operationId, attempt: effect.attempt });
  return frozen;
}

/** The operation of an effect: one per seller, job and route, so no request body names another. */
function operationOf({ seller, jobId, path }: EffectReservation): string {
  if (!isClaim(seller) || !isCanonicalJobId(jobId) || !DACS_SELLER_HTTP_ROUTES.some((r) => r.path === path && r.auth === "signed" && r.effect === "effect")) fail("wire_input_invalid", 500);
  return sha256Hex(canonicalize({ seller, jobId, path }));
}

/** Reserve one effect request (envelope.ts): its nonce key, then its operation's next state. */
export function reserveEffect(storeHandle: object, reservation: EffectReservation): WireEffect {
  const store = storeHandle as Store;
  const { key, binding, requestHash } = reservation;
  if (!isHash(key) || !isHash(binding) || !isHash(requestHash)) fail("wire_input_invalid", 500);
  const operationId = operationOf(reservation);
  if (!publish(store, `k-${key}`, canonicalize({ key, operationId, binding, requestHash }))) fail("peer_request_replayed", 409);
  const at = now(store);
  const lease = (attempt: number, superseded = 0) => canonicalize({ operationId, attempt, requestHash, leaseUntil: at + store.leaseMs, binding, superseded });
  const completed = (): WireEffect => {
    const outcome = readOutcome(store, operationId);
    assertBinding(store, operationId, binding);
    return deepFreeze({ state: "completed" as const, operationId, outcome });
  };
  if (exists(store, outcomeName(operationId))) return completed();
  // Immutable attempts form a contiguous index. Search it in at most 106 safe-integer probes.
  let next = 0, upper = 1;
  if (exists(store, attemptName(operationId, 0))) {
    while (exists(store, attemptName(operationId, upper))) {
      if (upper === Number.MAX_SAFE_INTEGER) corrupt("STORE-ATTEMPT-LIMIT");
      next = upper; upper = Math.min(Number.MAX_SAFE_INTEGER, upper * 2);
    }
    while (next + 1 < upper) {
      const middle = next + Math.floor((upper - next) / 2);
      if (exists(store, attemptName(operationId, middle))) next = middle;
      else upper = middle;
    }
    next = upper;
  }
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
  const { leaseUntil, superseded } = readAttempt(store, operationId, latest);
  if (!exists(store, endedName(operationId, latest))) {
    if (at < (leaseUntil as number)) fail("seller_effect_pending", 503);
    // Its lease ran out: end it as superseded, unless it ended itself first (the end read next decides).
    publish(store, endedName(operationId, latest), endRecord(operationId, latest, { superseded: true, outcome: null }));
  }
  const { outcome, superseded: latestSuperseded } = readEnd(store, operationId, latest);
  if (outcome !== null) { publishOutcome(store, operationId, latest, outcome); return completed(); }
  if (Number(superseded) + Number(latestSuperseded) >= MAX_EFFECT_ATTEMPTS) fail("seller_effect_unresolved", 500);
  if (!publish(store, attemptName(operationId, next), lease(next, Number(superseded) + Number(latestSuperseded)))) fail("seller_effect_pending", 503);
  return issue(store, { state: "recover", operationId, attempt: next, leaseUntil: at + store.leaseMs });
}

/**
 * Record the end of an effect attempt that reserveEffect issued (`new` or `recover`), on the journal it was issued from. `outcome` is the answer the handler
 * signed: a later request for the same operation is answered with it and runs no effect, so its text must be a body the wire can sign: a JSON object CF-5
 * admission admits, in well-formed UTF-8 (`wire_input_invalid`, detail `OUTCOME-INVALID`, before anything is published). It is published once: the same outcome
 * again is accepted, another is `seller_effect_conflict` (500). `null` ends an attempt that caused no effect and will cause none (for example, a payment not yet
 * visible), so the next request recovers at once instead of after the lease. Clean null ends do not spend MAX_EFFECT_ATTEMPTS; only superseded attempts do. An
 * attempt whose lease ran out and that a later request ended first is `seller_effect_superseded` (500), and records nothing: its successor reconciles. Call it
 * only after the effect's own write is durable.
 */
export function completeWireEffect(journal: WireRequestJournal, effect: WireEffect, outcome: WireEffectOutcome | null): void {
  const store = journalStore(journal) as Store;
  const kept = issuedGet(issued, effect as object);
  if (!kept || kept.store !== store) fail("wire_input_invalid", 500, "EFFECT-NOT-ISSUED");
  const { operationId, attempt } = kept!;
  // Read once through own data properties; the text is kept byte for byte (stored as its UTF-8 bytes, so canonical JSON does not normalize it).
  const owned = outcome === null ? null : ownedFields(outcome, ["status", "text"]) as unknown as WireEffectOutcome;
  if (owned !== null && !isOutcome(owned)) fail("wire_input_invalid", 500, "OUTCOME-INVALID");
  // One exclusive step: this attempt's end, or the one a recovering request published first.
  if (!publish(store, endedName(operationId, attempt), endRecord(operationId, attempt, { superseded: false, outcome: owned }))) {
    const end = readEnd(store, operationId, attempt);
    if (end.superseded) fail("seller_effect_superseded", 500);
    if (!sameOutcome(end.outcome, owned)) fail("seller_effect_conflict", 500);
  }
  if (owned !== null) publishOutcome(store, operationId, attempt, owned);
}
