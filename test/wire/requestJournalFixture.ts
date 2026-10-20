// Test-only request journals for checkWireRequest. Nothing here ships: the
// composed seller host brings its own durable journal (a TP-1 composition
// qualification entry), and qualifies it with qualifyWireRequestJournal.
// Like fixtureBinder, journalFixture takes the wire module under test, so a
// file that loads the wire after mocking its approval list (or loads the
// built package) qualifies journals in that same module.
import { closeSync, constants, fsyncSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type * as WireModule from "../../src/wire/index.js";
import type { QualifiedWireRequestJournal, WireRequestJournal, WireRequestReservation } from "../../src/wire/index.js";

/**
 * One process's store shared by every handle `open` returns: it holds both
 * the key and the operationId, so it passes qualifyWireRequestJournal's probe.
 * It is not durable across a restart; tests that need that use directoryJournal.
 */
export function memoryJournalOpener(): () => WireRequestJournal {
  const held = new Set<string>();
  return () => ({ durable: true, reserve({ key, operationId }) {
    if (held.has(`key:${key}`) || held.has(`operation:${operationId}`)) return false;
    held.add(`key:${key}`);
    held.add(`operation:${operationId}`);
    return true;
  } });
}

/** Create `name` in `dir` with O_CREAT|O_EXCL, its contents and then the directory synced; false if it exists. */
function createOnce(dir: string, name: string, contents: string): boolean {
  let file: number;
  try { file = openSync(join(dir, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
  try { writeSync(file, contents); fsyncSync(file); } finally { closeSync(file); }
  const directory = openSync(dir, constants.O_RDONLY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
  return true;
}

/**
 * A durable journal over a local directory: one file per key and one per
 * operationId, each created with O_CREAT|O_EXCL and synced before `reserve`
 * returns true. Of processes racing on either, exactly one creates it; a file
 * created before a crash or restart is still there after it. A key whose
 * operation is already held stays reserved: the journal only ever refuses more.
 */
export function directoryJournal(dir: string): WireRequestJournal {
  return { durable: true, reserve(reservation) {
    const contents = JSON.stringify(reservation);
    return createOnce(dir, `key-${reservation.key}`, contents) && createOnce(dir, `operation-${reservation.operationId}`, contents);
  } };
}

export function journalFixture(wire: Pick<typeof WireModule, "qualifyWireRequestJournal">) {
  return {
    /**
     * An explicit opt-in for a test that checks one process's calls: a
     * qualified journal over memoryJournalOpener. With `reserve`, the probe
     * still runs against the shared store and every later reservation goes to
     * `reserve` instead, so a test can count or refuse them.
     */
    inMemoryJournalForTest(reserve?: (reservation: WireRequestReservation) => boolean): QualifiedWireRequestJournal {
      const open = memoryJournalOpener();
      let probing = true;
      const journal = wire.qualifyWireRequestJournal(() => {
        const store = open();
        return { durable: true, reserve: (reservation) => (probing || !reserve ? store.reserve(reservation) : reserve(reservation)) };
      }, Date.now());
      probing = false;
      return journal;
    },
    /** directoryJournal, qualified as a host would at startup. */
    qualifiedDirectoryJournal: (dir: string, now: number): QualifiedWireRequestJournal =>
      wire.qualifyWireRequestJournal(() => directoryJournal(dir), now),
  };
}
