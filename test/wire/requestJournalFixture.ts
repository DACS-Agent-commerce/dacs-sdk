// Test-only request journals for checkWireRequest. Nothing here ships: the
// composed seller host brings its own durable journal (a TP-1 composition
// qualification entry).
import { closeSync, constants, fsyncSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { WireRequestJournal, WireRequestReservation } from "../../src/wire/index.js";

/**
 * An explicit opt-in: an in-memory reservation stub declared durable, for a
 * test that checks one process's calls. Without this declaration the wire
 * refuses the same stub on every effect route (test/wire/requestJournal.test.ts).
 */
export const inMemoryJournalForTest = (reserve: (reservation: WireRequestReservation) => boolean = () => true): WireRequestJournal =>
  ({ durable: true, reserve });

/**
 * A durable journal over a local directory: one file per key, created with
 * O_CREAT|O_EXCL, its contents and then the directory synced before `reserve`
 * returns true. Of processes racing on a key, exactly one creates it; a key
 * created before a crash or restart is still there after it. A write that fails
 * after the create leaves the key reserved.
 */
export function directoryJournal(dir: string): WireRequestJournal {
  return { durable: true, reserve(reservation) {
    let file: number;
    try { file = openSync(join(dir, reservation.key), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
    try { writeSync(file, JSON.stringify(reservation)); fsyncSync(file); } finally { closeSync(file); }
    const directory = openSync(dir, constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    return true;
  } };
}
