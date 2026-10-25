import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dirname, join } from "node:path";

// A real-filesystem fault model. File fsync commits inode data; directory
// fsync commits names. Power loss discards everything else. No journal code
// or records are mutated by this harness.
const fault = vi.hoisted(() => ({ fds: new Map<number, string>(), data: new Map<number, Buffer>(), durable: new Map<string, Buffer>(),
  directory: "", synced: [] as string[], syncDirectoryOnly: false, syncError: null as Error | null, linkError: null as Error | null, nonexclusive: false, foreignUid: false, rootOwned: "", filesystemType: null as bigint | null,
  shortWrite: false, zeroWrite: false, attemptStats: 0, trackDurability: true, shortRead: false, eof: false, reads: [] as number[], onLink: null as null | ((name: string) => void), onTemporaryOpen: null as null | (() => void) }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs,
    openSync(...args: any[]) {
      if (fault.onTemporaryOpen && /\/tmp-[0-9a-f]+$/.test(String(args[0]))) { const callback = fault.onTemporaryOpen; fault.onTemporaryOpen = null; callback(); }
      const fd = (fs.openSync as any)(...args); fault.fds.set(fd, String(args[0])); return fd; },
    closeSync(fd: number) { fault.fds.delete(fd); fs.closeSync(fd); },
    fsyncSync(fd: number) {
      if (fault.syncError && (!fault.syncDirectoryOnly || fs.fstatSync(fd).isDirectory())) throw fault.syncError;
      fs.fsyncSync(fd);
      if (!fault.trackDurability) return;
      const path = fault.fds.get(fd)!;
      if (fs.fstatSync(fd).isDirectory()) fault.synced.push(path);
      const stat = fs.fstatSync(fd);
      if (stat.isDirectory()) {
        fault.durable.clear();
        for (const name of fs.readdirSync(path)) {
          const file = join(path, name), inode = fs.statSync(file).ino;
          if (fault.data.has(inode)) fault.durable.set(name, Buffer.from(fault.data.get(inode)!));
        }
      } else fault.data.set(stat.ino, fs.readFileSync(path));
    },
    linkSync(from: string, to: string) {
      const callback = fault.onLink; if (callback) { fault.onLink = null; callback(to); }
      if (fault.linkError && !to.includes("probe-")) throw fault.linkError;
      if (fault.nonexclusive && fs.existsSync(to)) fs.unlinkSync(to);
      fs.linkSync(from, to);
    },
    lstatSync(path: string, options: any) {
      if (/o-[0-9a-f]{64}-[0-9]+$/.test(path)) fault.attemptStats++;
      const stat = fs.lstatSync(path, options);
      if (fault.rootOwned === path && stat) return new Proxy(stat, { get(target, key) { return key === "uid" ? 0 : Reflect.get(target, key); } });
      if (fault.foreignUid && stat?.isDirectory()) return new Proxy(stat, { get(target, key) { return key === "uid" ? target.uid + 1 : Reflect.get(target, key); } });
      return stat;
    },
    statfsSync(path: string, options: any) {
      const stat = (fs.statfsSync as any)(path, options);
      return fault.filesystemType === null ? stat : { ...stat, type: fault.filesystemType };
    },
    writeSync(fd: number, buffer: Buffer | string, offset?: number, length?: number) {
      if (fault.zeroWrite) return 0;
      if (typeof buffer === "string") return fs.writeSync(fd, fault.shortWrite ? buffer.slice(0, 10) : buffer);
      return fs.writeSync(fd, buffer, offset, fault.shortWrite ? Math.min(10, length ?? buffer.length) : length);
    },
    readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number) {
      fault.reads.push(length);
      if (fault.eof && fault.reads.length > 1) { if (fault.reads.length > 4) throw new Error("unbounded EOF loop"); return 0; }
      return fs.readSync(fd, buffer, offset, fault.shortRead ? Math.min(13, length) : length, position);
    },
  };
});
const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
import { completeWireEffect, journalStore, openWireRequestJournal, reserveEffect } from "../../src/wire/journal.js";
import type { EffectReservation, WireEffect, WireRequestJournal } from "../../src/wire/journal.js";
import { DACS_SELLER_HTTP_PATHS } from "../../src/wire/routes.js";
import { journalDirectory } from "./requestJournalFixture.js";

let counter = 1;
const JOB = "01ARZ3NDEKTSV4RRFFQ69G5FAV", OTHER_JOB = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const hash = (n: number) => n.toString(16).padStart(64, "0");
const reservation = (patch: Partial<EffectReservation> = {}): EffectReservation => ({ key: hash(counter++), seller: `did:demos:agent:${"a".repeat(64)}`, jobId: JOB, path: DACS_SELLER_HTTP_PATHS.payments, binding: "b".repeat(64), requestHash: "c".repeat(64), ...patch });
const reserve = (journal: WireRequestJournal, patch: Partial<EffectReservation> = {}) => reserveEffect(journalStore(journal), reservation(patch));
const stored = (status = 200, text = "{}") => ({ status, textBytes: Buffer.from(text).toString("base64url") });
const read = (directory: string, name: string) => JSON.parse(fs.readFileSync(join(directory, name), "utf8"));
const plant = (directory: string, name: string, value: unknown) => fs.writeFileSync(join(directory, name), JSON.stringify(value));
const names = (directory: string) => fs.readdirSync(directory).sort();
const refused = (detail: string) => expect.objectContaining({ code: "seller_replay_guard_invalid", status: 500, detail });
function setup(clock: () => number = () => 1000) {
  const directory = journalDirectory(); fault.directory = directory;
  const journal = openWireRequestJournal(directory, { clock, leaseMs: 1000 });
  return { directory, journal };
}
function crash(directory: string) {
  const kept = new Map(fault.durable);
  for (const name of names(directory)) fs.unlinkSync(join(directory, name));
  for (const [name, bytes] of kept) {
    const file = join(directory, name);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    fault.data.set(fs.statSync(file).ino, Buffer.from(bytes));
  }
}
beforeEach(() => {
  fault.fds.clear(); fault.synced = []; fault.data.clear(); fault.durable.clear(); fault.syncError = fault.linkError = null; fault.syncDirectoryOnly = false;
  fault.shortWrite = fault.zeroWrite = false; fault.trackDurability = true; fault.attemptStats = 0;
  fault.rootOwned = ""; fault.nonexclusive = fault.foreignUid = fault.shortRead = fault.eof = false; fault.filesystemType = null; fault.onLink = null; fault.onTemporaryOpen = null; fault.reads = [];
});
afterEach(() => { expect(fault.fds.size).toBe(0); });

describe("journal publication and recovery regression cases", () => {
  it("reservations, attempt ends and outcome bytes survive losing unsynced data and names", () => {
    let at = 1000;
    const { directory, journal } = setup(() => at);
    expect(names(directory)).toEqual([]); // no probe/temp debris
    const r = reservation(), effect = reserveEffect(journalStore(journal), r);
    expect(effect.state).toBe("new");
    crash(directory);
    let reopened = openWireRequestJournal(directory, { clock: () => at, leaseMs: 1000 });
    expect(() => reserveEffect(journalStore(reopened), r)).toThrowError(expect.objectContaining({ code: "peer_request_replayed" }));
    expect(() => reserve(reopened)).toThrowError(expect.objectContaining({ code: "seller_effect_pending" }));
    const outcome = { status: 599, text: '{"report":"retained é"}\n' };
    completeWireEffect(journal, effect, outcome);
    crash(directory);
    reopened = openWireRequestJournal(directory, { clock: () => at, leaseMs: 1000 });
    expect(reserve(reopened)).toMatchObject({ state: "completed", outcome });
    expect(names(directory).some((n) => /^(tmp|probe)-/.test(n))).toBe(false);
    // Null end is also durable; the successor is immediately recoverable.
    const next = reserve(reopened, { jobId: OTHER_JOB });
    completeWireEffect(reopened, next, null);
    crash(directory); at++;
    reopened = openWireRequestJournal(directory, { clock: () => at, leaseMs: 1000 });
    expect(reserve(reopened, { jobId: OTHER_JOB })).toMatchObject({ state: "recover", attempt: 1, leaseUntil: at + 1000 });
  }, 30000);
  it.each([false, true].flatMap((directoryOnly) => ["open", "reserve", "complete"].map((phase) => ({ directoryOnly, phase }))))("fsync failure prevents success: $phase (directory=$directoryOnly)", ({ directoryOnly, phase }) => {
      const { journal } = setup();
      const effect = phase === "complete" ? reserve(journal) : null;
      const error = new Error(`fsync ${phase}`);
      fault.syncDirectoryOnly = directoryOnly; fault.syncError = error;
      const invoke = () => phase === "open" ? openWireRequestJournal(journal.directory) : phase === "reserve" ? reserve(journal) : completeWireEffect(journal, effect!, { status: 200, text: "{}" });
      expect(invoke).toThrow(error);
      fault.syncError = null;
  }, 30000);
  it("syncs the journal directory's own entry and the entries above it this user created before issuing a handle", () => {
    const directory = journalDirectory(); fault.directory = directory;
    openWireRequestJournal(directory);
    expect(fault.synced).toContain(dirname(directory));
    expect(fault.synced).toContain(dirname(dirname(directory)));
  });
  it("syncs the journal directory's entry in a root-owned parent, which this user did not create", () => {
    const directory = journalDirectory(); fault.directory = directory;
    fault.rootOwned = dirname(directory);
    openWireRequestJournal(directory);
    expect(fault.synced).toContain(dirname(directory));
  });
  it("derives the operation from seller, job and route, so a changed request body is the same operation and runs no second effect", () => {
    const { journal } = setup();
    const first = reserve(journal);
    expect(first).toMatchObject({ state: "new" });
    expect(() => reserve(journal, { requestHash: "d".repeat(64) })).toThrowError(expect.objectContaining({ code: "seller_effect_pending" }));
    expect(reserve(setup().journal, { jobId: OTHER_JOB }).operationId).not.toBe(first.operationId);
    expect(reserve(setup().journal, { path: DACS_SELLER_HTTP_PATHS.commitments }).operationId).not.toBe(first.operationId);
    expect(reserve(setup().journal, { seller: `did:demos:agent:${"e".repeat(64)}` }).operationId).not.toBe(first.operationId);
  }, 30000);
  it.each([{ jobId: "not-a-job" }, { seller: "a".repeat(64) }, { path: DACS_SELLER_HTTP_PATHS.state }, { path: "/dacs/v1/other" }])("refuses a reservation that names no seller, job or effect route (%#)", (patch) => {
    const { journal, directory } = setup();
    expect(() => reserve(journal, patch)).toThrowError(expect.objectContaining({ code: "wire_input_invalid" }));
    expect(names(directory)).toEqual([]);
  }, 30000);
  it.each(["new", "recover"])("issues no %s attempt whose lease ran out while it was being published", (state) => {
    let at = 1000;
    const { journal, directory } = setup(() => at);
    if (state === "recover") { completeWireEffect(journal, reserve(journal), null); at = 1500; }
    const arm = (): void => { fault.onLink = (to) => { if (new RegExp(`/o-[0-9a-f]{64}-${state === "new" ? 0 : 1}$`).test(to)) at += 1500; else arm(); }; };
    arm();
    expect(() => reserve(journal)).toThrowError(expect.objectContaining({ code: "seller_effect_pending" }));
    at += 1000; // the lapsed attempt is ended as superseded by the next request, which then recovers
    expect(reserve(openWireRequestJournal(directory, { clock: () => at, leaseMs: 1000 }))).toMatchObject({ state: "recover" });
  }, 30000);

  it("EIO during nonce or attempt link propagates unchanged, cleans temporary files and issues no effect", () => {
    for (const target of ["nonce", "attempt"]) {
      const { journal, directory } = setup();
      const error = Object.assign(new Error("link EIO"), { code: "EIO" });
      if (target === "nonce") fault.linkError = error;
      else fault.onLink = (to) => { expect(to).toContain("/k-"); fault.onLink = () => { fault.linkError = error; }; };
      let issued: WireEffect | undefined;
      let caught: unknown;
      try { issued = reserve(journal); } catch (error) { caught = error; }
      expect(caught).toBe(error);
      expect(issued).toBeUndefined();
      fault.linkError = null;
      expect(names(directory).some((n) => n.startsWith("tmp-"))).toBe(false);
      expect(reserve(openWireRequestJournal(directory))).toMatchObject({ state: "new", attempt: 0 });
    }
  }, 30000);
  it("nonexclusive publication and foreign directory ownership refuse journal handles", () => {
    const { directory } = setup();
    fault.nonexclusive = true;
    expect(() => openWireRequestJournal(directory)).toThrowError(refused("PUBLISH-NOT-EXCLUSIVE"));
    fault.nonexclusive = false; fault.foreignUid = true;
    expect(() => openWireRequestJournal(directory)).toThrowError(refused("DIRECTORY-UNSAFE"));
    expect(names(directory)).toEqual([]);
  }, 30000);
  it.each([["tmpfs", 0x01021994n], ["ramfs", 0x858458f6n]])("refuses a directory on %s, which loses a completed effect at reboot", (_name, type) => {
    const directory = journalDirectory();
    fault.filesystemType = type;
    expect(() => openWireRequestJournal(directory)).toThrowError(refused("DIRECTORY-VOLATILE"));
    expect(names(directory)).toEqual([]);
    fault.filesystemType = 0xef53n; // ext4
    expect(openWireRequestJournal(directory)).toEqual({ directory });
  }, 30000);
  it("refuses a directory reached through a symbolic link, so a retargeted link cannot hide retained state", () => {
    const first = journalDirectory(), second = journalDirectory(), parent = journalDirectory();
    const link = join(parent, "current"), ancestor = join(parent, "ancestor");
    fs.symlinkSync(first, link);
    fs.symlinkSync(parent, ancestor);
    fs.mkdirSync(join(parent, "real"), { mode: 0o700 });
    expect(() => openWireRequestJournal(link)).toThrowError(expect.objectContaining({ code: "seller_replay_guard_invalid" }));
    for (const alias of [`${link}/`, join(ancestor, "real"), `${first}/../${second.split("/").pop()}`]) {
      expect(() => openWireRequestJournal(alias)).toThrowError(refused("DIRECTORY-ALIAS"));
    }
    expect(names(first)).toEqual([]);
    expect(openWireRequestJournal(first).directory).toBe(first);
  }, 30000);
  it.each([0o770, 0o707, 0o777])("refuses a journal under an ancestor other users can write (mode %o), where they could swap the path mid-publish", (mode) => {
    const parent = journalDirectory(), directory = join(parent, "journal");
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.chmodSync(parent, mode);
    expect(() => openWireRequestJournal(directory)).toThrowError(refused("DIRECTORY-UNSAFE"));
    expect(names(directory)).toEqual([]);
    fs.chmodSync(parent, 0o700);
    expect(openWireRequestJournal(directory).directory).toBe(directory);
  }, 30000);
  it("refuses every call once the journal path names a replacement directory, so a completed operation is not issued again", () => {
    const { journal, directory } = setup();
    const effect = reserve(journal);
    completeWireEffect(journal, effect, { status: 200, text: "{}" });
    const moved = `${directory}-moved`;
    fs.renameSync(directory, moved);
    fs.mkdirSync(directory, { mode: 0o700 });
    expect(() => reserve(journal)).toThrowError(refused("DIRECTORY-REPLACED"));
    expect(() => completeWireEffect(journal, effect, null)).toThrowError(refused("DIRECTORY-REPLACED"));
    expect(names(directory)).toEqual([]);
    fs.rmdirSync(directory);
    expect(() => reserve(journal)).toThrowError(refused("DIRECTORY-REPLACED"));
    fs.renameSync(moved, directory);
    expect(reserve(journal)).toMatchObject({ state: "completed" });
  }, 30000);
  it("refuses a directory replaced while an attempt is being published, so no attempt is issued from the replacement", () => {
    const { journal, directory } = setup();
    const moved = `${directory}-moved`;
    // The first temporary file carries the request nonce; the second is the attempt.
    fault.onTemporaryOpen = () => { fault.onTemporaryOpen = () => { fs.renameSync(directory, moved); fs.mkdirSync(directory, { mode: 0o700 }); }; };
    expect(() => reserve(journal)).toThrowError(refused("DIRECTORY-REPLACED"));
    expect(fault.onTemporaryOpen).toBeNull();
    fs.rmSync(directory, { recursive: true });
    fs.renameSync(moved, directory);
  }, 30000);
  it.each([NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("invalid clock %s issues no attempt", (at) => {
    const { journal, directory } = setup(() => at);
    expect(() => reserve(journal)).toThrowError(expect.objectContaining({ code: "seller_configuration_invalid", status: 500, detail: "JOURNAL-CLOCK" }));
    expect(names(directory).filter((n) => n.startsWith("o-"))).toEqual([]);
  }, 30000);
  it.each([200.5, "200"])("noninteger status %s is refused before publication, also in stored form", (status) => {
    const { journal, directory } = setup(), effect = reserve(journal);
    const before = names(directory);
    expect(() => completeWireEffect(journal, effect, { status, text: "{}" } as any)).toThrowError(expect.objectContaining({ code: "wire_input_invalid", detail: "OUTCOME-INVALID" }));
    expect(names(directory)).toEqual(before);
    plant(directory, `o-${effect.operationId}.done`, { operationId: effect.operationId, attempt: 0, outcome: stored(status as number) });
    expect(() => reserve(openWireRequestJournal(directory))).toThrowError(refused("STORE-OUTCOME-INVALID"));
  }, 30000);
  it("exact 512KiB and status 599 survive reopen; one extra byte fails before completion", () => {
    const { journal, directory } = setup(), effect = reserve(journal);
    const text = '{"x":"' + "x".repeat(512 * 1024 - 8) + '"}';
    expect(Buffer.byteLength(text)).toBe(512 * 1024);
    expect(() => completeWireEffect(journal, effect, { status: 200, text: text + " " })).toThrowError(expect.objectContaining({ code: "wire_input_invalid", detail: "OUTCOME-INVALID" }));
    completeWireEffect(journal, effect, { status: 599, text });
    expect(reserve(openWireRequestJournal(directory))).toMatchObject({ state: "completed", outcome: { status: 599, text } });
  }, 30000);
  it.each([{ operationId: "d".repeat(64) }, { outcome: { ...stored(), extra: true } }, { outcome: { status: 200, textBytes: null } }])("stored outcome corruption is refused (%#)", (patch) => {
      const { journal, directory } = setup(), effect = reserve(journal);
      plant(directory, `o-${effect.operationId}.done`, { operationId: effect.operationId, attempt: 0, outcome: stored(), ...patch });
      expect(() => reserve(openWireRequestJournal(directory))).toThrowError(refused("STORE-OUTCOME-INVALID"));
  }, 30000);
  it("conflicting completed index and durable end cannot report successful completion", () => {
    const { journal, directory } = setup(), effect = reserve(journal);
    completeWireEffect(journal, effect, { status: 200, text: "{}" });
    plant(directory, `o-${effect.operationId}.done`, { operationId: effect.operationId, attempt: 0, outcome: stored(200, '{"other":true}') });
    expect(() => completeWireEffect(journal, effect, { status: 200, text: "{}" })).toThrowError(expect.objectContaining({ code: "seller_effect_conflict", status: 500 }));
  }, 30000);
  it("end operation, superseded type, and superseded encoded outcomes refuse independently", () => {
    for (const patch of [{ operationId: "d".repeat(64) }, { superseded: "yes", outcome: null }, { superseded: true, outcome: stored() }]) {
      const { journal, directory } = setup(), effect = reserve(journal);
      plant(directory, `o-${effect.operationId}-0.end`, { operationId: effect.operationId, attempt: 0, superseded: false, outcome: stored(), ...patch });
      expect(() => reserve(openWireRequestJournal(directory))).toThrowError(refused("STORE-END-INVALID"));
    }
  }, 30000);
  it("crash after durable end and before completed index reconstructs the exact outcome", () => {
    const { journal, directory } = setup(), effect = reserve(journal);
    const outcome = { status: 599, text: '{"kept":"é"}\n' };
    completeWireEffect(journal, effect, outcome);
    fs.unlinkSync(join(directory, `o-${effect.operationId}.done`));
    expect(reserve(openWireRequestJournal(directory))).toMatchObject({ state: "completed", outcome });
    expect(read(directory, `o-${effect.operationId}.done`).outcome).toEqual(stored(outcome.status, outcome.text));
  }, 30000);
  it("null completion remains idempotent across reopen; recovery lease matches durable attempt", () => {
    let at = 1000;
    const { journal, directory } = setup(() => at), effect = reserve(journal);
    completeWireEffect(journal, effect, null);
    openWireRequestJournal(directory);
    expect(() => completeWireEffect(journal, effect, null)).not.toThrow();
    at = 2468;
    const recovered = reserve(journal);
    expect(recovered).toMatchObject({ state: "recover", attempt: 1, leaseUntil: at + 1000 });
    expect(read(directory, `o-${effect.operationId}-1`).leaseUntil).toBe(at + 1000);
  }, 30000);
  it("a first-publication race preserves the winning binding and precise pending diagnostic", () => {
    for (const foreign of [true, false]) {
      const { journal } = setup();
      const original = reservation();
      fault.onLink = () => { fault.onLink = (to) => {
        expect(to).toMatch(/\/o-[0-9a-f]{64}-0$/);
        expect(reserve(journal, { binding: foreign ? "d".repeat(64) : original.binding })).toMatchObject({ state: "new" });
      }; };
      expect(() => reserveEffect(journalStore(journal), original)).toThrowError(expect.objectContaining(foreign
        ? { code: "peer_operation_mismatch", status: 409 } : { code: "seller_effect_pending", status: 503 }));
    }
  }, 30000);
  it("multiple short reads respect the remaining buffer, and truncated EOF terminates with bounded reads", () => {
    const { journal, directory } = setup(), effect = reserve(journal);
    completeWireEffect(journal, effect, { status: 200, text: '{"short":"reads"}' });
    fault.shortRead = true; fault.reads = [];
    expect(reserve(journal)).toMatchObject({ state: "completed", outcome: { status: 200, text: '{"short":"reads"}' } });
    expect(fault.reads[1]).toBe(fault.reads[0]! - 13);
    fault.eof = true; fault.reads = [];
    expect(() => reserve(journal)).toThrowError(refused("STORE-OUTCOME-INVALID"));
    expect(fault.reads).toHaveLength(2);
    expect(names(directory).some((n) => /^(tmp|probe)-/.test(n))).toBe(false);
  }, 30000);
});
it("oversized outcome text is refused before allocating/admitting its UTF-8 bytes", () => {
  const { journal } = setup(), effect = reserve(journal);
  const text = '{"x":"' + "x".repeat(512 * 1024) + '"}';
  const spy = vi.spyOn(Buffer, "from");
  try {
    expect(() => completeWireEffect(journal, effect, { status: 200, text })).toThrowError(expect.objectContaining({ code: "wire_input_invalid", detail: "OUTCOME-INVALID" }));
    expect(spy.mock.calls.some(([arg]) => arg === text)).toBe(false);
  } finally { spy.mockRestore(); }
});
it("losing a recovery publication retains seller_effect_pending/503", () => {
  const { journal } = setup(), effect = reserve(journal);
  completeWireEffect(journal, effect, null);
  fault.onLink = () => { fault.onLink = () => { expect(reserve(journal)).toMatchObject({ state: "recover", attempt: 1 }); }; };
  expect(() => reserve(journal)).toThrowError(expect.objectContaining({ code: "seller_effect_pending", status: 503 }));
});
it("repeated read/publication failures and successes balance a bounded descriptor budget", () => {
  const { journal } = setup(), effect = reserve(journal);
  completeWireEffect(journal, effect, { status: 200, text: "{}" });
  for (let i = 0; i < 20; i++) {
    expect(reserve(journal)).toMatchObject({ state: "completed" });
    expect(fault.fds.size).toBe(0);
    fault.syncError = new Error("sync failed");
    expect(() => reserve(journal)).toThrow(fault.syncError);
    fault.syncError = null;
    expect(fault.fds.size).toBe(0);
  }
});


it("publishes all UTF-8 bytes after short writes before issuing an effect", () => {
  const { journal, directory } = setup();
  fault.shortWrite = true;
  const effect = reserve(journal);
  expect(effect.state).toBe("new");
  completeWireEffect(journal, effect, { status: 200, text: '{"message":"é"}' });
  expect(reserve(openWireRequestJournal(directory))).toMatchObject({ state: "completed", outcome: { status: 200, text: '{"message":"é"}' } });
});

it.each(["zero-write", "file-sync"])("cleans temporary files and preserves the %s failure", (failure) => {
  const { journal, directory } = setup();
  const cause = Object.assign(new Error("file sync failed"), { code: "EIO" });
  fault.zeroWrite = failure === "zero-write";
  if (failure === "file-sync") fault.syncError = cause;
  expect(() => reserve(journal)).toThrowError(failure === "file-sync" ? cause : expect.objectContaining({ code: "seller_replay_guard_invalid" }));
  expect(names(directory).some((name) => name.startsWith("tmp-"))).toBe(false);
});

it("expires unfinished leases, fences stale completions and persists the crash retry budget", () => {
  let at = 1000;
  const { journal, directory } = setup(() => at);
  let effect = reserve(journal);
  at = 1999;
  expect(() => reserve(journal)).toThrowError(expect.objectContaining({ code: "seller_effect_pending" }));
  for (let superseded = 1; superseded < 16; superseded++) {
    at = 1000 + superseded * 1000;
    const previous = effect;
    effect = reserve(journal);
    expect(effect).toMatchObject({ state: "recover", attempt: superseded });
    expect(() => completeWireEffect(journal, previous, { status: 200, text: "{}" }))
      .toThrowError(expect.objectContaining({ code: "seller_effect_superseded" }));
  }
  at = 17000;
  const reopened = openWireRequestJournal(directory, { clock: () => at, leaseMs: 1000 });
  expect(() => reserve(reopened)).toThrowError(expect.objectContaining({ code: "seller_effect_unresolved" }));
}, 30000);

it("bounds attempt lookup after many clean retries without spending the crash budget", () => {
  const { journal, directory } = setup();
  fault.trackDurability = false;
  let effect = reserve(journal);
  for (let attempt = 0; attempt < 128; attempt++) {
    completeWireEffect(journal, effect, null);
    effect = reserve(journal);
  }
  const reopened = openWireRequestJournal(directory, { clock: () => 1000, leaseMs: 1000 });
  completeWireEffect(journal, effect, null);
  fault.attemptStats = 0;
  expect(reserve(reopened)).toMatchObject({ state: "recover", attempt: 129 });
  expect(fault.attemptStats).toBeLessThan(32);
}, 30000);
