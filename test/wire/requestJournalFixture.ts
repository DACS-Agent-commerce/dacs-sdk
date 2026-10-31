// Request journals for the wire tests: the shipped durable journal
// (openWireRequestJournal), each in its own fresh temporary directory. There
// is no in-memory journal and no hook: a test observes what was reserved by
// reading the journal's own files. Like fixtureBinder, journalFixture takes
// the wire module under test, so a file that loads the wire after mocking its
// approval list (or loads the built package) opens journals in that module.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as WireModule from "../../src/wire/index.js";
import type { WireRequestJournal, WireRequestJournalOptions } from "../../src/wire/index.js";

let root: string | undefined;
/** A fresh directory for one journal, under one per-process root removed when the process exits. */
export function journalDirectory(): string {
  if (root === undefined) {
    const made = mkdtempSync(join(tmpdir(), "dacs-wire-journal-"));
    root = made;
    process.once("exit", () => rmSync(made, { recursive: true, force: true }));
  }
  return mkdtempSync(join(root, "j-"));
}

/** What one request reserved: its nonce key file's contents. */
export interface KeptReservation { key: string; operationId: string; binding: string; requestHash: string }

/** Every reservation in a journal directory, in no particular order. */
export function reservationsIn(directory: string): KeptReservation[] {
  return readdirSync(directory).filter((name) => name.startsWith("k-"))
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as KeptReservation);
}

export function journalFixture(wire: Pick<typeof WireModule, "openWireRequestJournal">) {
  return {
    /**
     * Journals for one test, each in a fresh directory, and every reservation
     * made in any of them: what a test counts where it once counted calls.
     */
    testJournals() {
      const directories: string[] = [];
      return {
        open(options?: WireRequestJournalOptions): WireRequestJournal {
          const directory = journalDirectory();
          directories.push(directory);
          return wire.openWireRequestJournal(directory, options);
        },
        reservations: (): KeptReservation[] => directories.flatMap(reservationsIn),
      };
    },
    /** One journal in a fresh directory. */
    testJournal: (options?: WireRequestJournalOptions): WireRequestJournal => wire.openWireRequestJournal(journalDirectory(), options),
    /** The journal in `directory`, opened as each seller worker opens it at startup. */
    openJournal: (directory: string, options?: WireRequestJournalOptions): WireRequestJournal => wire.openWireRequestJournal(directory, options),
  };
}
