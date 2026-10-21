import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

// A real-filesystem fault model. File fsync commits inode data; directory
// fsync commits names. Power loss discards everything else. No journal code
// or records are mutated by this harness.
const fault = vi.hoisted(() => ({ fds: new Map<number, string>(), data: new Map<number, Buffer>(), durable: new Map<string, Buffer>(),
  directory: "", syncDirectoryOnly: false, syncError: null as Error | null, linkError: null as Error | null, nonexclusive: false, foreignUid: false,
  shortRead: false, eof: false, reads: [] as number[], onLink: null as null | ((name: string) => void) }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs,
    openSync(...args: any[]) { const fd = (fs.openSync as any)(...args); fault.fds.set(fd, String(args[0])); return fd; },
    closeSync(fd: number) { fault.fds.delete(fd); fs.closeSync(fd); },
    fsyncSync(fd: number) {
      if (fault.syncError && (!fault.syncDirectoryOnly || fs.fstatSync(fd).isDirectory())) throw fault.syncError;
      fs.fsyncSync(fd);
      const path = fault.fds.get(fd)!;
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
      const stat = fs.lstatSync(path, options);
      if (fault.foreignUid && stat?.isDirectory()) return new Proxy(stat, { get(target, key) { return key === "uid" ? target.uid + 1 : Reflect.get(target, key); } });
      return stat;
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
import { journalDirectory } from "./requestJournalFixture.js";

let counter = 1;
const hash = (n: number) => n.toString(16).padStart(64, "0");
const reservation = (patch: Partial<EffectReservation> = {}): EffectReservation => ({ key: hash(counter++), operationId: "a".repeat(64), binding: "b".repeat(64), requestHash: "c".repeat(64), ...patch });
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
  fault.fds.clear(); fault.data.clear(); fault.durable.clear(); fault.syncError = fault.linkError = null; fault.syncDirectoryOnly = false;
  fault.nonexclusive = fault.foreignUid = fault.shortRead = fault.eof = false; fault.onLink = null; fault.reads = [];
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
    const other = "d".repeat(64), next = reserve(reopened, { operationId: other });
    completeWireEffect(reopened, next, null);
    crash(directory); at++;
    reopened = openWireRequestJournal(directory, { clock: () => at, leaseMs: 1000 });
    expect(reserve(reopened, { operationId: other })).toMatchObject({ state: "recover", attempt: 1, leaseUntil: at + 1000 });
  });
  it("every file and directory fsync failure prevents a successful reservation or completion", () => {
    for (const directoryOnly of [false, true]) for (const phase of ["open", "reserve", "complete"]) {
      const { journal } = setup();
      const effect = phase === "complete" ? reserve(journal) : null;
      const error = new Error(`fsync ${phase}`);
      fault.syncDirectoryOnly = directoryOnly; fault.syncError = error;
      const invoke = () => phase === "open" ? openWireRequestJournal(journal.directory) : phase === "reserve" ? reserve(journal) : completeWireEffect(journal, effect!, { status: 200, text: "{}" });
      expect(invoke).toThrow(error);
      fault.syncError = null;
    }
  });
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
  });
  it("nonexclusive publication and foreign directory ownership refuse journal handles", () => {
    const { directory } = setup();
    fault.nonexclusive = true;
    expect(() => openWireRequestJournal(directory)).toThrowError(refused("PUBLISH-NOT-EXCLUSIVE"));
    fault.nonexclusive = false; fault.foreignUid = true;
    expect(() => openWireRequestJournal(directory)).toThrowError(refused("DIRECTORY-UNSAFE"));
    expect(names(directory)).toEqual([]);
  });
  it.each([NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("invalid clock %s issues no attempt", (at) => {
    const { journal, directory } = setup(() => at);
    expect(() => reserve(journal)).toThrowError(expect.objectContaining({ code: "seller_configuration_invalid", status: 500, detail: "JOURNAL-CLOCK" }));
    expect(names(directory).filter((n) => n.startsWith("o-"))).toEqual([]);
  });
  it.each([200.5, "200"])("noninteger status %s is refused before publication, also in stored form", (status) => {
    const { journal, directory } = setup(), effect = reserve(journal);
    const before = names(directory);
    expect(() => completeWireEffect(journal, effect, { status, text: "{}" } as any)).toThrowError(expect.objectContaining({ code: "wire_input_invalid", detail: "OUTCOME-INVALID" }));
    expect(names(directory)).toEqual(before);
    plant(directory, `o-${effect.operationId}.done`, { operationId: effect.operationId, attempt: 0, outcome: stored(status as number) });
    expect(() => reserve(openWireRequestJournal(directory))).toThrowError(refused("STORE-OUTCOME-INVALID"));
  });
  it("exact 512KiB and status 599 survive reopen; one extra byte fails before completion", () => {
    const { journal, directory } = setup(), effect = reserve(journal);
    const text = '{"x":"' + "x".repeat(512 * 1024 - 8) + '"}';
    expect(Buffer.byteLength(text)).toBe(512 * 1024);
    expect(() => completeWireEffect(journal, effect, { status: 200, text: text + " " })).toThrowError(expect.objectContaining({ code: "wire_input_invalid", detail: "OUTCOME-INVALID" }));
    completeWireEffect(journal, effect, { status: 599, text });
    expect(reserve(openWireRequestJournal(directory))).toMatchObject({ state: "completed", outcome: { status: 599, text } });
  });
  it("stored operation identity, exact outcome members and encoded bytes are independently checked", () => {
    for (const patch of [{ operationId: "d".repeat(64) }, { outcome: { ...stored(), extra: true } }, { outcome: { status: 200, textBytes: null } }]) {
      const { journal, directory } = setup(), effect = reserve(journal);
      plant(directory, `o-${effect.operationId}.done`, { operationId: effect.operationId, attempt: 0, outcome: stored(), ...patch });
      expect(() => reserve(openWireRequestJournal(directory))).toThrowError(refused("STORE-OUTCOME-INVALID"));
    }
  });
  it("conflicting completed index and durable end cannot report successful completion", () => {
    const { journal, directory } = setup(), effect = reserve(journal);
    completeWireEffect(journal, effect, { status: 200, text: "{}" });
    plant(directory, `o-${effect.operationId}.done`, { operationId: effect.operationId, attempt: 0, outcome: stored(200, '{"other":true}') });
    expect(() => completeWireEffect(journal, effect, { status: 200, text: "{}" })).toThrowError(expect.objectContaining({ code: "seller_effect_conflict", status: 500 }));
  });
  it("end operation, superseded type, and superseded encoded outcomes refuse independently", () => {
    for (const patch of [{ operationId: "d".repeat(64) }, { superseded: "yes", outcome: null }, { superseded: true, outcome: stored() }]) {
      const { journal, directory } = setup(), effect = reserve(journal);
      plant(directory, `o-${effect.operationId}-0.end`, { operationId: effect.operationId, attempt: 0, superseded: false, outcome: stored(), ...patch });
      expect(() => reserve(openWireRequestJournal(directory))).toThrowError(refused("STORE-END-INVALID"));
    }
  });
  it("crash after durable end and before completed index reconstructs the exact outcome", () => {
    const { journal, directory } = setup(), effect = reserve(journal);
    const outcome = { status: 599, text: '{"kept":"é"}\n' };
    completeWireEffect(journal, effect, outcome);
    fs.unlinkSync(join(directory, `o-${effect.operationId}.done`));
    expect(reserve(openWireRequestJournal(directory))).toMatchObject({ state: "completed", outcome });
    expect(read(directory, `o-${effect.operationId}.done`).outcome).toEqual(stored(outcome.status, outcome.text));
  });
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
  });
  it("a first-publication race preserves the winning binding and precise pending diagnostic", () => {
    for (const foreign of [true, false]) {
      const { journal } = setup();
      const original = reservation();
      fault.onLink = () => { fault.onLink = (to) => {
        expect(to).toContain(`o-${original.operationId}-0`);
        expect(reserve(journal, { binding: foreign ? "d".repeat(64) : original.binding })).toMatchObject({ state: "new" });
      }; };
      expect(() => reserveEffect(journalStore(journal), original)).toThrowError(expect.objectContaining(foreign
        ? { code: "peer_operation_mismatch", status: 409 } : { code: "seller_effect_pending", status: 503 }));
    }
  });
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
  });
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
